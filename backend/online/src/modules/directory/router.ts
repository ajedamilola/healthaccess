import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { findAreas, findFacilities } from '../../domain/access.js';
import { AppError } from '../../middleware/error.js';
import { serperSearch, type SerperClient } from '../../services/serper.js';
import {
  decorateDirectoryMatches,
  discoverLiveFacilities,
  facilityMatchKey,
  findLivePlaceDetail,
  loadAreaContext,
  type DirectoryMatch,
} from './live.js';

const queryParam = z.string().min(1).max(120).optional();

const areasQuery = z.object({
  q: queryParam,
  limit: z.coerce.number().int().optional(),
});

const facilitiesQuery = z.object({
  service: z.string().min(1).max(80),
  area_id: z.string().uuid(),
  radius_km: z.coerce.number().positive().optional(),
  limit: z.coerce.number().int().optional(),
  include_live: z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
    .optional()
    .transform((value) => value === undefined || ['true', '1', 'yes', 'on'].includes(value)),
});

const idParam = z.string().uuid();

function coordinate(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 3;
  return Math.min(Math.max(Math.trunc(value), 1), 10);
}

export interface DirectoryRouterDeps {
  search: SerperClient;
}

export function createDirectoryRouter(overrides: Partial<DirectoryRouterDeps> = {}): Router {
  const router = Router();
  const search = overrides.search ?? serperSearch;

  router.get('/services', async (_req, res) => {
    const services = await prisma.service.findMany({
      where: { active: true },
      orderBy: [{ sort_order: 'asc' }, { service_code: 'asc' }],
      select: { service_code: true, label: true, description: true },
    });
    res.json(services);
  });

  router.get('/areas', async (req, res) => {
    const query = areasQuery.parse(req.query);
    res.json(await findAreas(query.q, query.limit));
  });

  router.get('/facilities', async (req, res) => {
    const query = facilitiesQuery.parse(req.query);
    const limit = clampLimit(query.limit);
    const area = await loadAreaContext(query.area_id);
    if (!area) {
      res.json([]);
      return;
    }

    const approved = decorateDirectoryMatches(
      await findFacilities(query.service, query.area_id, query.radius_km, limit),
    );
    let matches: DirectoryMatch[] = approved;
    if (query.include_live && approved.length < limit) {
      const service = await prisma.service.findFirst({
        where: { service_code: query.service, active: true },
        select: { label: true },
      });
      if (service) {
        const live = await discoverLiveFacilities({
          client: search,
          area,
          serviceCode: query.service,
          serviceLabel: service.label,
          // Ask for a full page so duplicates already returned by the directory
          // cannot starve the page; the merge below dedupes and slices.
          limit,
        });
        const seenIds = new Set(approved.map((match) => match.id));
        const seenKeys = new Set(approved.map((match) => facilityMatchKey(match)));
        matches = [
          ...approved,
          ...live.filter((match) => {
            const key = facilityMatchKey(match);
            if (seenIds.has(match.id) || seenKeys.has(key)) return false;
            seenIds.add(match.id);
            seenKeys.add(key);
            return true;
          }),
        ];
      }
    }
    res.json(matches.slice(0, limit));
  });

  router.get('/facilities/:id', async (req, res) => {
    const facilityId = idParam.parse(req.params.id);
    const facility = await prisma.facility.findFirst({
      where: { id: facilityId, status: 'APPROVED', is_demo: false },
      include: {
        area: { select: { id: true, name: true, region: true, city: true } },
        source: { select: { trust_tier: true } },
        facility_services: {
          where: { verification_status: 'APPROVED', service: { active: true } },
          include: { service: { select: { label: true, sort_order: true } } },
        },
      },
    });
    if (!facility) {
      const lead = await findLivePlaceDetail(facilityId);
      if (!lead) throw new AppError(404, 'Facility not found', 'not_found');
      res.json(lead);
      return;
    }

    const services = facility.facility_services
      .slice()
      .sort(
        (left, right) =>
          left.service.sort_order - right.service.sort_order ||
          left.service_code.localeCompare(right.service_code),
      )
      .map((entry) => ({
        service_code: entry.service_code,
        label: entry.service.label,
        availability_note: entry.availability_note,
      }));

    res.json({
      id: facility.id,
      name: facility.name,
      address: facility.address,
      area_id: facility.area_id,
      area: facility.area,
      latitude: coordinate(facility.latitude),
      longitude: coordinate(facility.longitude),
      phone: facility.phone,
      last_verified_at: facility.last_verified_at,
      verified_at: facility.verified_at,
      is_demo: facility.is_demo,
      source_trust: facility.source?.trust_tier ?? 'unknown',
      source: 'directory',
      source_url: null,
      source_reference: null,
      service_label: null,
      verification_status: 'approved',
      kind: 'facility',
      services,
    });
  });

  return router;
}

export const directoryRouter = createDirectoryRouter();
