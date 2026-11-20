import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

export interface ProjectionField {
  key: string;
  label: string;
  value: Prisma.JsonValue;
}

export interface RecordProjection {
  available: boolean;
  fields: ProjectionField[];
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export async function emergencyProjection(patientId: string): Promise<RecordProjection> {
  const rows = await prisma.emergencyField.findMany({
    where: { patient_id: patientId, field: { active: true } },
    include: { field: true, value: true },
  });

  rows.sort(
    (left, right) =>
      left.display_order - right.display_order ||
      left.field.sort_order - right.field.sort_order ||
      left.field_key.localeCompare(right.field_key),
  );

  const fields = rows.map((row) => ({
    key: row.field_key,
    label: row.field.label,
    value: row.value.value,
  }));

  return { available: fields.length > 0, fields };
}

export async function grantProjection(
  grantId: string,
  patientId: string,
): Promise<RecordProjection> {
  const rows = await prisma.accessGrantField.findMany({
    where: {
      grant_id: grantId,
      grant: { patient_id: patientId },
      field: { active: true },
    },
    include: { field: true },
  });

  const values = rows.length
    ? await prisma.patientFieldValue.findMany({
        where: {
          patient_id: patientId,
          field_key: { in: rows.map((row) => row.field_key) },
        },
        select: { field_key: true, value: true },
      })
    : [];
  const valueByKey = new Map(values.map((row) => [row.field_key, row.value]));

  const fields = rows
    .filter((row) => valueByKey.has(row.field_key))
    .sort(
      (left, right) =>
        left.field.sort_order - right.field.sort_order ||
        left.field_key.localeCompare(right.field_key),
    )
    .map((row) => ({
      key: row.field_key,
      label: row.field.label,
      value: valueByKey.get(row.field_key) as Prisma.JsonValue,
    }));

  return { available: fields.length > 0, fields };
}

export async function consentProjection(
  consentId: string,
  patientId: string,
): Promise<RecordProjection> {
  const rows = await prisma.consentField.findMany({
    where: {
      consent_id: consentId,
      consent: { id: consentId, patient_id: patientId },
      field: { active: true },
    },
    include: { field: true },
  });

  const values = rows.length
    ? await prisma.patientFieldValue.findMany({
        where: {
          patient_id: patientId,
          field_key: { in: rows.map((row) => row.field_key) },
        },
        select: { field_key: true, value: true },
      })
    : [];
  const valueByKey = new Map(values.map((row) => [row.field_key, row.value]));

  const fields = rows
    .filter((row) => valueByKey.has(row.field_key))
    .sort(
      (left, right) =>
        left.field.sort_order - right.field.sort_order ||
        left.field_key.localeCompare(right.field_key),
    )
    .map((row) => ({
      key: row.field_key,
      label: row.field.label,
      value: valueByKey.get(row.field_key) as Prisma.JsonValue,
    }));

  return { available: fields.length > 0, fields };
}

export interface AreaSummary {
  id: string;
  name: string;
  region: string;
  city: string;
  is_demo: boolean;
}

export async function findAreas(query: string | undefined, limit?: number): Promise<AreaSummary[]> {
  const boundedLimit = clampInteger(limit, 5, 1, 10);
  const term = (query ?? '').trim();

  if (!term) {
    const rows = await prisma.area.findMany({
      where: { active: true, country_code: 'NG' },
      orderBy: { name: 'asc' },
      take: boundedLimit,
      select: { id: true, name: true, region: true, city: true, is_demo: true },
    });
    return rows;
  }

  const lower = term.toLowerCase();

  const [exact, prefixed] = await Promise.all([
    prisma.area.findMany({
      where: {
        active: true,
        country_code: 'NG',
        OR: [
          { name: { equals: lower, mode: 'insensitive' } },
          { city: { equals: lower, mode: 'insensitive' } },
          { region: { equals: lower, mode: 'insensitive' } },
          { aliases: { some: { alias_normalized: { equals: lower, mode: 'insensitive' } } } },
        ],
      },
      orderBy: { name: 'asc' },
      take: boundedLimit,
      select: { id: true, name: true, region: true, city: true, is_demo: true },
    }),
    prisma.area.findMany({
      where: {
        active: true,
        country_code: 'NG',
        OR: [
          { name: { startsWith: lower, mode: 'insensitive' } },
          { city: { startsWith: lower, mode: 'insensitive' } },
          { region: { startsWith: lower, mode: 'insensitive' } },
          {
            aliases: {
              some: { alias_normalized: { startsWith: lower, mode: 'insensitive' } },
            },
          },
        ],
      },
      orderBy: { name: 'asc' },
      take: Math.max(boundedLimit * 10, 50),
      select: { id: true, name: true, region: true, city: true, is_demo: true },
    }),
  ]);

  const seen = new Set<string>();
  const matches: AreaSummary[] = [];
  for (const area of [...exact, ...prefixed]) {
    if (seen.has(area.id)) continue;
    seen.add(area.id);
    matches.push(area);
    if (matches.length === boundedLimit) break;
  }
  return matches;
}

export interface FacilityMatch {
  id: string;
  name: string;
  address: string;
  phone: string | null;
  distance_km: number | null;
  is_demo: boolean;
  service_code: string;
}

export function haversineKm(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLatitude = toRadians(latitude2 - latitude1);
  const deltaLongitude = toRadians(longitude2 - longitude1);
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(latitude1)) *
      Math.cos(toRadians(latitude2)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.min(1, Math.sqrt(haversine))) * 1000) / 1000;
}

function coordinate(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

export async function findFacilities(
  serviceCode: string,
  areaId: string,
  radiusKm?: number,
  limit?: number,
): Promise<FacilityMatch[]> {
  const boundedLimit = clampInteger(limit, 3, 1, 10);
  const boundedRadius = clampNumber(radiusKm, 25, 1, 200);

  const area = await prisma.area.findFirst({
    where: { id: areaId, active: true },
    select: {
      id: true,
      country_code: true,
      center_latitude: true,
      center_longitude: true,
    },
  });
  if (!area) return [];

  const facilities = await prisma.facility.findMany({
    where: {
      status: 'APPROVED',
      is_demo: false,
      area: { active: true, country_code: area.country_code },
      facility_services: {
        some: {
          service_code: serviceCode,
          verification_status: 'APPROVED',
          service: { active: true },
        },
      },
    },
    select: {
      id: true,
      name: true,
      address: true,
      phone: true,
      area_id: true,
      latitude: true,
      longitude: true,
      is_demo: true,
    },
  });

  const centerLatitude = coordinate(area.center_latitude);
  const centerLongitude = coordinate(area.center_longitude);

  const matches: FacilityMatch[] = [];
  for (const facility of facilities) {
    const latitude = coordinate(facility.latitude);
    const longitude = coordinate(facility.longitude);
    const distance =
      centerLatitude !== null &&
      centerLongitude !== null &&
      latitude !== null &&
      longitude !== null
        ? haversineKm(centerLatitude, centerLongitude, latitude, longitude)
        : null;

    const eligible =
      distance === null
        ? facility.area_id === area.id
        : distance <= boundedRadius;
    if (!eligible) continue;

    matches.push({
      id: facility.id,
      name: facility.name,
      address: facility.address,
      phone: facility.phone,
      distance_km: distance,
      is_demo: facility.is_demo,
      service_code: serviceCode,
    });
  }

  matches.sort((left, right) => {
    const leftDistance = left.distance_km ?? Number.POSITIVE_INFINITY;
    const rightDistance = right.distance_km ?? Number.POSITIVE_INFINITY;
    return leftDistance - rightDistance || left.name.localeCompare(right.name);
  });

  return matches.slice(0, boundedLimit);
}

export interface ReviewedContentMatch {
  id: string;
  topic: string;
  language: string;
  version: number;
  title: string;
  body: string;
  reviewer: string | null;
  reviewed_at: Date | null;
}

export async function findReviewedContent(
  query: string | undefined,
  limit?: number,
): Promise<ReviewedContentMatch[]> {
  const boundedLimit = clampInteger(limit, 3, 1, 5);
  const term = (query ?? '').trim();
  if (!term) return [];

  const rows = await prisma.reviewedHealthContent.findMany({
    where: {
      status: 'PUBLISHED',
      reviewer_account_id: { not: null },
      reviewed_at: { not: null },
      OR: [
        { topic_code: { contains: term, mode: 'insensitive' } },
        { title: { contains: term, mode: 'insensitive' } },
        { body: { contains: term, mode: 'insensitive' } },
      ],
    },
    orderBy: [{ topic_code: 'asc' }, { version: 'desc' }],
    include: { reviewer: { select: { display_name: true } } },
  });

  const seenTopics = new Set<string>();
  const matches: ReviewedContentMatch[] = [];
  for (const row of rows) {
    if (seenTopics.has(row.topic_code)) continue;
    seenTopics.add(row.topic_code);
    matches.push({
      id: row.id,
      topic: row.topic_code,
      language: row.language,
      version: row.version,
      title: row.title,
      body: row.body,
      reviewer: row.reviewer?.display_name ?? null,
      reviewed_at: row.reviewed_at,
    });
    if (matches.length === boundedLimit) break;
  }
  return matches;
}
