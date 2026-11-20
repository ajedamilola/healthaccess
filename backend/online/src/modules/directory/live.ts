import { prisma } from '../../db.js';
import {
  haversineKm,
  type FacilityMatch,
} from '../../domain/access.js';
import {
  placeFingerprint,
  type LivePlace,
  type SerperClient,
} from '../../services/serper.js';

export interface AreaContext {
  id: string;
  name: string;
  city: string;
  region: string;
  centerLatitude: number | null;
  centerLongitude: number | null;
}

export interface LiveFacilityMatch extends FacilityMatch {
  source: 'web';
  verification_status: 'unverified';
  source_url: string;
  source_reference: string;
  service_label: string;
  latitude: number | null;
  longitude: number | null;
}

export interface DirectoryFacilityMatch extends FacilityMatch {
  source: 'directory';
  verification_status: 'approved';
  source_url: null;
  source_reference: null;
  service_label: null;
  latitude: number | null;
  longitude: number | null;
}

export type DirectoryMatch = DirectoryFacilityMatch | LiveFacilityMatch;

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function facilityMatchKey(match: { name: string; address: string }): string {
  return `${normalizeKey(match.name)}|${normalizeKey(match.address)}`;
}

function distanceFrom(
  area: AreaContext,
  latitude: number | null,
  longitude: number | null,
): number | null {
  if (
    area.centerLatitude === null ||
    area.centerLongitude === null ||
    latitude === null ||
    longitude === null
  ) {
    return null;
  }
  return haversineKm(area.centerLatitude, area.centerLongitude, latitude, longitude);
}

export async function loadAreaContext(areaId: string): Promise<AreaContext | null> {
  const area = await prisma.area.findFirst({
    where: { id: areaId, active: true },
    select: {
      id: true,
      name: true,
      city: true,
      region: true,
      center_latitude: true,
      center_longitude: true,
    },
  });
  if (!area) return null;
  return {
    id: area.id,
    name: area.name,
    city: area.city,
    region: area.region,
    centerLatitude: area.center_latitude === null ? null : Number(area.center_latitude),
    centerLongitude: area.center_longitude === null ? null : Number(area.center_longitude),
  };
}

export function decorateDirectoryMatches(matches: FacilityMatch[]): DirectoryFacilityMatch[] {
  return matches.map((match) => ({
    ...match,
    source: 'directory' as const,
    verification_status: 'approved' as const,
    source_url: null,
    source_reference: null,
    service_label: null,
    latitude: null,
    longitude: null,
  }));
}

async function persistPlaces(places: LivePlace[], serviceCode: string): Promise<string[]> {
  const ids: string[] = [];
  for (const place of places) {
    const fingerprint = placeFingerprint(place);
    const source = await prisma.source.upsert({
      where: { canonical_url: place.source_url },
      create: {
        source_kind: 'SERPER_WEB',
        canonical_url: place.source_url,
        retrieved_at: new Date(),
        trust_tier: 'UNVERIFIED_WEB',
        metadata: {
          title: place.name,
          service_code: serviceCode,
          service_label: place.service_label,
          kind: place.kind,
        },
      },
      update: {
        retrieved_at: new Date(),
        metadata: {
          title: place.name,
          service_code: serviceCode,
          service_label: place.service_label,
          kind: place.kind,
        },
      },
      select: { id: true },
    });
    const lead = await prisma.webLead.upsert({
      where: {
        source_url_content_fingerprint: {
          source_url: place.source_url,
          content_fingerprint: fingerprint,
        },
      },
      create: {
        source_id: source.id,
        name: place.name,
        address: place.address || place.name,
        phone: place.phone,
        source_url: place.source_url,
        snippet: place.address || null,
        observed_at: new Date(),
        status: 'UNVERIFIED',
        content_fingerprint: fingerprint,
      },
      update: {
        name: place.name,
        address: place.address || place.name,
        phone: place.phone,
        snippet: place.address || null,
        observed_at: new Date(),
      },
      select: { id: true },
    });
    ids.push(lead.id);
  }
  return ids;
}

export async function discoverLiveFacilities(input: {
  client: SerperClient;
  area: AreaContext;
  serviceCode: string;
  serviceLabel: string;
  limit: number;
}): Promise<LiveFacilityMatch[]> {
  if (!input.client.configured || input.limit < 1) return [];
  const areaLabel = [input.area.name, input.area.city, input.area.region, 'Nigeria']
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(', ');
  let places: LivePlace[];
  try {
    places = await input.client.discoverFacilities({
      serviceCode: input.serviceCode,
      serviceLabel: input.serviceLabel,
      area: areaLabel,
      limit: input.limit,
    });
  } catch {
    return [];
  }
  if (!places.length) return [];
  const ids = await persistPlaces(places, input.serviceCode);
  const seenIds = new Set<string>();
  const seenPlaces = new Set<string>();
  const results: LiveFacilityMatch[] = [];
  for (const [index, place] of places.entries()) {
    const id = ids[index];
    if (!id || seenIds.has(id)) continue;
    const key = facilityMatchKey({ name: place.name, address: place.address || place.name });
    if (seenPlaces.has(key)) continue;
    seenIds.add(id);
    seenPlaces.add(key);
    results.push({
      id,
      name: place.name,
      address: place.address || place.name,
      phone: place.phone,
      distance_km: distanceFrom(input.area, place.latitude, place.longitude),
      is_demo: false,
      service_code: input.serviceCode,
      source: 'web',
      verification_status: 'unverified',
      source_url: place.source_url,
      source_reference: place.source_reference,
      service_label: place.service_label,
      latitude: place.latitude,
      longitude: place.longitude,
    });
    if (results.length >= input.limit) break;
  }
  return results;
}

export async function findLivePlaceDetail(id: string) {
  const lead = await prisma.webLead.findFirst({
    where: { id, status: { in: ['UNVERIFIED', 'REVIEW_CANDIDATE'] } },
    include: { source: { select: { trust_tier: true, metadata: true } } },
  });
  if (!lead) return null;
  const metadata =
    lead.source?.metadata && typeof lead.source.metadata === 'object'
      ? (lead.source.metadata as Record<string, unknown>)
      : {};
  return {
    id: lead.id,
    name: lead.name,
    address: lead.address,
    area_id: null,
    area: null,
    latitude: null,
    longitude: null,
    phone: lead.phone,
    last_verified_at: null,
    verified_at: null,
    is_demo: false,
    source_trust: lead.source?.trust_tier ?? 'UNVERIFIED_WEB',
    source_url: lead.source_url,
    source_reference: null,
    service_label:
      typeof metadata.service_label === 'string' ? metadata.service_label : null,
    verification_status: 'unverified' as const,
    kind: 'web_lead' as const,
    services: [] as Array<{
      service_code: string | null;
      label: string | null;
      availability_note: null;
    }>,
    metadata,
  };
}
