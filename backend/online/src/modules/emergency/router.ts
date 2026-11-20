import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { EmergencyRequest, Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { haversineKm } from '../../domain/access.js';
import { requireAuth } from '../../middleware/auth.js';
import { AppError } from '../../middleware/error.js';
import { recordAudit } from '../../services/audit.js';
import {
  placeSnapshot,
  requireSerper,
  serperSearch,
  type LivePlace,
  type SerperClient,
} from '../../services/serper.js';

const GUIDANCE = [
  'Call 112 now if the situation is life-threatening, someone is unconscious, bleeding heavily, or struggling to breathe.',
  'Call the nearest facility below and confirm they can accept the patient before travelling.',
  'HealthAccess does not dispatch ambulances; these are live search results and are not verified by HealthAccess.',
];

const emergencyBody = z
  .object({
    kind: z.enum(['hospital', 'ambulance', 'both']).optional(),
    location: z.string().trim().min(1).max(160).optional(),
    area_id: z.string().uuid().optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(value.location) ||
      Boolean(value.area_id) ||
      (value.latitude !== undefined && value.longitude !== undefined),
    {
      message: 'Provide a location, an area_id or both latitude and longitude',
      path: ['location'],
    },
  );

const listQuery = z.object({
  page: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().optional(),
});

function requireAccountId(req: Request): string {
  const accountId = req.auth?.accountId;
  if (!accountId) throw new AppError(401, 'Authentication required', 'unauthorized');
  return accountId;
}

function authPageOf(query: { page?: number; limit?: number }) {
  const page = query.page === undefined ? 1 : Math.max(1, Math.trunc(query.page));
  const limit = query.limit === undefined ? 10 : Math.min(Math.max(Math.trunc(query.limit), 1), 50);
  return { page, limit, skip: (page - 1) * limit };
}

interface AreaContext {
  id: string;
  label: string;
  latitude: number | null;
  longitude: number | null;
}

interface ResolvedTarget {
  area: AreaContext | null;
  label: string;
  latitude: number | null;
  longitude: number | null;
}

interface AreaRow {
  id: string;
  name: string;
  city: string;
  region: string;
  center_latitude: Prisma.Decimal | null;
  center_longitude: Prisma.Decimal | null;
}

function areaContext(row: AreaRow): AreaContext {
  return {
    id: row.id,
    label: [row.name, row.city, row.region]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(', '),
    latitude: row.center_latitude === null ? null : Number(row.center_latitude),
    longitude: row.center_longitude === null ? null : Number(row.center_longitude),
  };
}

async function resolveTarget(input: {
  location?: string;
  areaId?: string;
  latitude?: number;
  longitude?: number;
  homeArea: AreaRow | null;
}): Promise<ResolvedTarget> {
  let area: AreaContext | null = null;
  if (input.areaId) {
    const row = await prisma.area.findFirst({
      where: { id: input.areaId, active: true },
      select: {
        id: true,
        name: true,
        city: true,
        region: true,
        center_latitude: true,
        center_longitude: true,
      },
    });
    if (!row) throw new AppError(404, 'Area not found', 'not_found');
    area = areaContext(row);
  } else if (input.homeArea) {
    area = areaContext(input.homeArea);
  }

  const latitude = input.latitude ?? area?.latitude ?? null;
  const longitude = input.longitude ?? area?.longitude ?? null;
  const coordinateLabel =
    latitude !== null && longitude !== null ? `${latitude}, ${longitude}` : '';
  const label = input.location ?? area?.label ?? coordinateLabel;
  if (!label) {
    throw new AppError(400, 'A location is required to search for emergency services', 'invalid_location');
  }
  return { area, label, latitude, longitude };
}

function distanceFor(
  target: ResolvedTarget,
  place: LivePlace,
): number | null {
  if (
    target.latitude === null ||
    target.longitude === null ||
    place.latitude === null ||
    place.longitude === null
  ) {
    return null;
  }
  return haversineKm(target.latitude, target.longitude, place.latitude, place.longitude);
}

function serializeRequest(request: EmergencyRequest) {
  return {
    id: request.id,
    patient_id: request.patient_id,
    channel: request.channel,
    kind: request.kind,
    status: request.status,
    area_id: request.area_id,
    location_text: request.location_text,
    latitude: request.latitude === null ? null : Number(request.latitude),
    longitude: request.longitude === null ? null : Number(request.longitude),
    results: request.results,
    created_at: request.created_at,
  };
}

const guidances = [...GUIDANCE];

export interface EmergencyStore {
  create(input: {
    patient_id: string;
    account_id: string;
    kind: string;
    area_id: string | null;
    location_text: string;
    latitude: number | null;
    longitude: number | null;
    status: 'MATCHED' | 'NO_MATCH' | 'FAILED';
    results: Prisma.InputJsonValue;
    request_id: string;
  }): Promise<EmergencyRequest>;
  list(
    accountId: string,
    skip: number,
    take: number,
  ): Promise<{ items: EmergencyRequest[]; total: number }>;
  findOwned(id: string, accountId: string): Promise<EmergencyRequest | null>;
}

const prismaEmergencyStore: EmergencyStore = {
  async create(input) {
    return prisma.emergencyRequest.create({
      data: {
        patient_id: input.patient_id,
        account_id: input.account_id,
        channel: 'WEB',
        kind: input.kind,
        area_id: input.area_id,
        location_text: input.location_text,
        latitude: input.latitude,
        longitude: input.longitude,
        status: input.status,
        results: input.results,
        request_id: input.request_id,
      },
    });
  },
  async list(accountId, skip, take) {
    const where = { account_id: accountId };
    const [items, total] = await Promise.all([
      prisma.emergencyRequest.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take,
      }),
      prisma.emergencyRequest.count({ where }),
    ]);
    return { items, total };
  },
  async findOwned(id, accountId) {
    return prisma.emergencyRequest.findFirst({ where: { id, account_id: accountId } });
  },
};

export interface EmergencyRouterDeps {
  search: SerperClient;
  store: EmergencyStore;
  auth: RequestHandler;
}

export function createEmergencyRouter(overrides: Partial<EmergencyRouterDeps> = {}): Router {
  const router = Router();
  const search = overrides.search ?? serperSearch;
  const store = overrides.store ?? prismaEmergencyStore;
  const auth = overrides.auth ?? requireAuth;
  router.use(auth);

  router.post('/', async (req, res, next) => {
    try {
      const accountId = requireAccountId(req);
      const body = emergencyBody.parse(req.body ?? {});

      const patient = await prisma.patientProfile.findUnique({
        where: { account_id: accountId },
        select: {
          id: true,
          home_area: {
            select: {
              id: true,
              name: true,
              city: true,
              region: true,
              center_latitude: true,
              center_longitude: true,
            },
          },
        },
      });
      if (!patient) throw new AppError(404, 'Patient profile not found', 'not_found');

      const target = await resolveTarget({
        location: body.location,
        areaId: body.area_id,
        latitude: body.latitude,
        longitude: body.longitude,
        homeArea: patient.home_area,
      });
      const client = requireSerper(search);
      const kind = body.kind ?? 'both';
      let places: LivePlace[] = [];
      let status: 'MATCHED' | 'NO_MATCH' | 'FAILED' = 'NO_MATCH';
      try {
        places = await client.discoverEmergency({
          area: target.label,
          kind,
          limit: 8,
        });
        status = places.length ? 'MATCHED' : 'NO_MATCH';
      } catch {
        status = 'FAILED';
      }

      const results = places.map((place) => ({
        ...placeSnapshot(place),
        distance_km: distanceFor(target, place),
      }));

      const request = await store.create({
        patient_id: patient.id,
        account_id: accountId,
        kind,
        area_id: target.area?.id ?? null,
        location_text: target.label.slice(0, 300),
        latitude: target.latitude,
        longitude: target.longitude,
        status,
        results: results as unknown as Prisma.InputJsonValue,
        request_id: req.requestId ?? '',
      });

      await recordAudit({
        requestId: req.requestId,
        actorAccountId: accountId,
        patientId: patient.id,
        channel: 'WEB',
        action: 'emergency.request',
        resourceType: 'emergency_request',
        resourceId: request.id,
        outcome: 'ALLOWED',
        metadata: {
          kind,
          status,
          result_count: results.length,
        },
      });

      res.status(201).json({
        request: serializeRequest(request),
        results,
        guidance: guidances,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const accountId = requireAccountId(req);
      const query = listQuery.parse(req.query);
      const { page, limit, skip } = authPageOf(query);
      const { items, total } = await store.list(accountId, skip, limit);
      res.json({
        requests: items.map(serializeRequest),
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const accountId = requireAccountId(req);
      const parsedId = z.string().uuid().safeParse(req.params.id);
      if (!parsedId.success) {
        throw new AppError(404, 'Emergency request not found', 'not_found');
      }
      const request = await store.findOwned(parsedId.data, accountId);
      if (!request) throw new AppError(404, 'Emergency request not found', 'not_found');
      res.json({
        request: serializeRequest(request),
        results: request.results,
        guidance: guidances,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const emergencyRouter = createEmergencyRouter();
