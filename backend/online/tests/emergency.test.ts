import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { errorHandler, notFound } from '../src/middleware/error.js';
import { requestContext } from '../src/middleware/request.js';
import { createEmergencyRouter } from '../src/modules/emergency/router.js';
import type { LivePlace, SerperClient } from '../src/services/serper.js';

const suffix = randomUUID().slice(0, 8);
const liveBase = `https://emergency-${suffix}.example.test`;

type EmergencyQuery = Parameters<SerperClient['discoverEmergency']>[0];
type FakeSerper = SerperClient & { emergencyCalls: EmergencyQuery[] };

function fakeSerper(
  discover?: (input: EmergencyQuery) => Promise<LivePlace[]>,
  configured = true,
): FakeSerper {
  const emergencyCalls: EmergencyQuery[] = [];
  return {
    configured,
    emergencyCalls,
    searchWeb: async () => [],
    discoverFacilities: async () => [],
    discoverEmergency: async (input) => {
      emergencyCalls.push(input);
      return discover ? discover(input) : [];
    },
  };
}

function buildApp(search: SerperClient) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/v1/emergency', createEmergencyRouter({ search }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function emergencyPlace(name: string, overrides: Partial<LivePlace> = {}): LivePlace {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    name,
    address: `${name} address, Lagos`,
    phone: '+2348098765432',
    latitude: 6.6018,
    longitude: 3.3515,
    website: `${liveBase}/${slug}`,
    source_url: `${liveBase}/${slug}`,
    source_reference: `em-${suffix}-${slug}`,
    service_label: 'Emergency hospital',
    verification_status: 'unverified',
    kind: 'emergency',
    ...overrides,
  };
}

let areaId = '';
const accountIds: string[] = [];
const requestIds: string[] = [];
let tokenA = '';
let tokenB = '';
let tokenNoProfile = '';
let patientAId = '';
let accountAIdValue = '';

async function createAccount(input: { label: string; patient: boolean }) {
  const account = await prisma.account.create({
    data: {
      email: `emergency-${input.label}-${suffix}@example.test`,
      password_hash: 'test-password-hash',
      display_name: `Emergency ${input.label}`,
      status: 'ACTIVE',
      roles: { create: { role: 'PATIENT' } },
    },
  });
  accountIds.push(account.id);

  const session = await prisma.authSession.create({
    data: {
      account_id: account.id,
      refresh_token_hash: createHash('sha256')
        .update(`${account.id}:${randomUUID()}`)
        .digest('hex'),
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const profile = input.patient
    ? await prisma.patientProfile.create({
        data: { account_id: account.id, home_area_id: areaId },
      })
    : null;

  return {
    accountId: account.id,
    patientId: profile?.id ?? null,
    token: jwt.sign(
      { sub: account.id, sid: session.id, typ: 'access', roles: ['PATIENT'] },
      config.jwtSecret,
      { expiresIn: '15m' },
    ),
  };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function baseLocation(label: string) {
  return {
    location: `Ikeja ${label} ${suffix}`,
    area_id: areaId,
    latitude: 6.6018,
    longitude: 3.3515,
  };
}

function guidanceMentions112(body: { guidance?: unknown }) {
  assert.ok(Array.isArray(body.guidance));
  assert.match((body.guidance as string[]).join(' '), /112/);
}

before(async () => {
  const area = await prisma.area.create({
    data: {
      country_code: 'NG',
      name: `Emergency-${suffix}`,
      city: 'Ikeja',
      region: 'Lagos',
      center_latitude: '6.601800',
      center_longitude: '3.351500',
      is_demo: false,
      active: true,
    },
  });
  areaId = area.id;

  const accountA = await createAccount({ label: 'a', patient: true });
  const accountB = await createAccount({ label: 'b', patient: true });
  const accountNoProfile = await createAccount({ label: 'no-profile', patient: false });
  tokenA = accountA.token;
  tokenB = accountB.token;
  tokenNoProfile = accountNoProfile.token;
  patientAId = accountA.patientId ?? '';
  accountAIdValue = accountA.accountId;
  assert.ok(patientAId);
});

after(async () => {
  await prisma.auditEvent.deleteMany({
    where: {
      OR: [
        { actor_account_id: { in: accountIds } },
        ...(requestIds.length ? [{ resource_id: { in: requestIds } }] : []),
      ],
    },
  });
  await prisma.emergencyRequest.deleteMany({ where: { account_id: { in: accountIds } } });
  if (accountIds.length) {
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  if (areaId) {
    await prisma.area.deleteMany({ where: { id: areaId } });
  }
  await prisma.$disconnect();
});

describe('emergency requests', () => {
  it('requires authentication for every endpoint', async () => {
    await request(buildApp(fakeSerper())).get('/v1/emergency').expect(401);
    await request(buildApp(fakeSerper()))
      .post('/v1/emergency')
      .send(baseLocation('auth'))
      .expect(401);
    await request(buildApp(fakeSerper()))
      .get(`/v1/emergency/${randomUUID()}`)
      .set(auth('not-a-jwt'))
      .expect(401);
  });

  it('validates the body and resolves the patient and area', async () => {
    const app = buildApp(fakeSerper(async () => []));

    const empty = await request(app).post('/v1/emergency').set(auth(tokenA)).send({});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'validation_error');

    const invalidKind = await request(app)
      .post('/v1/emergency')
      .set(auth(tokenA))
      .send({ ...baseLocation('kind'), kind: 'boat' });
    assert.equal(invalidKind.status, 400);

    const invalidArea = await request(app)
      .post('/v1/emergency')
      .set(auth(tokenA))
      .send({ location: `Ikeja ${suffix}`, area_id: 'not-a-uuid' });
    assert.equal(invalidArea.status, 400);

    const unknownArea = await request(app)
      .post('/v1/emergency')
      .set(auth(tokenA))
      .send({ location: `Ikeja unknown ${suffix}`, area_id: randomUUID() });
    assert.equal(unknownArea.status, 404);
    assert.equal(unknownArea.body.error, 'not_found');

    const missingProfile = await request(app)
      .post('/v1/emergency')
      .set(auth(tokenNoProfile))
      .send(baseLocation('profile'));
    assert.equal(missingProfile.status, 404);
    assert.equal(missingProfile.body.error, 'not_found');
  });

  it('returns 503 when live search is not configured', async () => {
    const search = fakeSerper(async () => {
      throw new Error('should not run');
    }, false);
    const app = buildApp(search);

    const response = await request(app)
      .post('/v1/emergency')
      .set(auth(tokenA))
      .send(baseLocation('unconfigured'));

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'search_unavailable');
    assert.equal(search.emergencyCalls.length, 0);
    assert.equal(
      await prisma.emergencyRequest.count({ where: { account_id: accountAIdValue } }),
      0,
    );
  });

  it('creates a MATCHED request, persists it and audits without location or PHI', async () => {
    const hospital = emergencyPlace(`Emergency Hospital ${suffix}`);
    const ambulance = emergencyPlace(`Ambulance Service ${suffix}`, {
      kind: 'emergency',
      service_label: 'Ambulance service',
      latitude: 6.61,
      longitude: 3.36,
    });
    const search = fakeSerper(async () => [hospital, ambulance]);
    const app = buildApp(search);
    const payload = {
      ...baseLocation('matched'),
      kind: 'both' as const,
      note: 'Patient collapsed at the market gate',
    };

    const response = await request(app)
      .post('/v1/emergency')
      .set(auth(tokenA))
      .send(payload);

    assert.equal(response.status, 201);
    assert.equal(response.body.request.status, 'MATCHED');
    assert.equal(response.body.request.kind, 'both');
    assert.equal(response.body.request.channel, 'WEB');
    assert.equal(response.body.request.area_id, areaId);
    assert.equal(response.body.request.location_text, payload.location);
    assert.equal(response.body.request.patient_id, patientAId);
    assert.equal(response.body.results.length, 2);
    guidanceMentions112(response.body);

    assert.equal(search.emergencyCalls.length, 1);
    assert.equal(search.emergencyCalls[0].kind, 'both');
    assert.match(search.emergencyCalls[0].area, new RegExp(suffix));

    const first = response.body.results[0];
    assert.equal(first.name, hospital.name);
    assert.equal(first.address, hospital.address);
    assert.equal(first.phone, hospital.phone);
    assert.equal(first.source_url, hospital.source_url);
    assert.equal(first.source_reference, hospital.source_reference);
    assert.equal(first.service_label, 'Emergency hospital');
    assert.equal(first.verification_status, 'unverified');
    assert.equal(first.kind, 'emergency');
    assert.equal(typeof first.distance_km, 'number');

    const stored = await prisma.emergencyRequest.findUnique({
      where: { id: response.body.request.id },
    });
    assert.ok(stored);
    requestIds.push(stored.id);
    assert.equal(stored.status, 'MATCHED');
    assert.equal(stored.channel, 'WEB');
    assert.equal(stored.account_id, accountAIdValue);
    assert.equal(stored.location_text, payload.location);
    assert.equal((stored.results as unknown as unknown[]).length, 2);

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'emergency.request', resource_id: stored.id },
    });
    assert.ok(audit);
    assert.equal(audit.channel, 'WEB');
    assert.equal(audit.actor_account_id, accountAIdValue);
    assert.equal(audit.patient_id, patientAId);
    const metadata = audit.metadata as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata).sort(), ['kind', 'result_count', 'status']);
    assert.equal(metadata.result_count, 2);
    const serialized = JSON.stringify(metadata);
    assert.equal(serialized.includes(payload.location), false);
    assert.equal(serialized.includes(payload.note), false);
    assert.equal(/\d{6,}/.test(serialized), false, 'no coordinates or long digits in audit');
  });

  it('returns 201 with empty results and 112 guidance when nothing matches', async () => {
    const search = fakeSerper(async () => []);
    const app = buildApp(search);

    const response = await request(app)
      .post('/v1/emergency')
      .set(auth(tokenA))
      .send({ ...baseLocation('no-match'), kind: 'hospital' });

    assert.equal(response.status, 201);
    assert.equal(response.body.request.status, 'NO_MATCH');
    assert.deepEqual(response.body.results, []);
    guidanceMentions112(response.body);
    requestIds.push(response.body.request.id);

    const stored = await prisma.emergencyRequest.findUnique({
      where: { id: response.body.request.id },
    });
    assert.equal(stored?.status, 'NO_MATCH');
  });

  it('persists a FAILED request when the configured search throws', async () => {
    const search = fakeSerper(async () => {
      throw new Error('serper timeout');
    });
    const app = buildApp(search);

    const response = await request(app)
      .post('/v1/emergency')
      .set(auth(tokenA))
      .send({ ...baseLocation('failed'), kind: 'ambulance' });

    assert.equal(response.status, 201);
    assert.equal(response.body.request.status, 'FAILED');
    assert.deepEqual(response.body.results, []);
    guidanceMentions112(response.body);
    requestIds.push(response.body.request.id);

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'emergency.request', resource_id: response.body.request.id },
    });
    assert.equal(
      (audit?.metadata as unknown as Record<string, unknown>).status,
      'FAILED',
    );
  });

  it('accepts coordinate-only and area-only requests', async () => {
    const app = buildApp(fakeSerper(async () => []));

    const coordinates = await request(app)
      .post('/v1/emergency')
      .set(auth(tokenA))
      .send({ latitude: 6.6018, longitude: 3.3515 });
    assert.equal(coordinates.status, 201);
    assert.equal(coordinates.body.request.area_id, areaId);
    assert.match(coordinates.body.request.location_text, new RegExp(suffix));
    assert.equal(coordinates.body.request.latitude, 6.6018);
    assert.equal(coordinates.body.request.longitude, 3.3515);
    requestIds.push(coordinates.body.request.id);

    const areaOnly = await request(app)
      .post('/v1/emergency')
      .set(auth(tokenA))
      .send({ area_id: areaId });
    assert.equal(areaOnly.status, 201);
    assert.equal(areaOnly.body.request.area_id, areaId);
    assert.match(areaOnly.body.request.location_text, new RegExp(suffix));
    requestIds.push(areaOnly.body.request.id);
  });

  it('scopes list and detail reads to the authenticated account with pagination', async () => {
    const app = buildApp(fakeSerper(async () => []));

    await new Promise((resolve) => setTimeout(resolve, 15));
    const newest = await request(app)
      .post('/v1/emergency')
      .set(auth(tokenA))
      .send(baseLocation('scope-newest'));
    assert.equal(newest.status, 201);
    requestIds.push(newest.body.request.id);

    const listB = await request(app).get('/v1/emergency').set(auth(tokenB)).expect(200);
    assert.equal(listB.body.requests.length, 0);
    assert.equal(listB.body.total, 0);
    assert.equal(listB.body.totalPages, 0);

    const detailB = await request(app)
      .get(`/v1/emergency/${newest.body.request.id}`)
      .set(auth(tokenB))
      .expect(404);
    assert.equal(detailB.body.error, 'not_found');

    const listA = await request(app)
      .get('/v1/emergency?limit=1')
      .set(auth(tokenA))
      .expect(200);
    assert.ok(listA.body.total >= 2);
    assert.equal(listA.body.page, 1);
    assert.equal(listA.body.limit, 1);
    assert.equal(listA.body.requests.length, 1);
    assert.equal(listA.body.totalPages, Math.ceil(listA.body.total / 1));
    assert.equal(listA.body.requests[0].id, newest.body.request.id);
    assert.equal(listA.body.requests[0].area_id, areaId);

    const page2 = await request(app)
      .get('/v1/emergency?page=2&limit=1')
      .set(auth(tokenA))
      .expect(200);
    assert.equal(page2.body.page, 2);
    assert.equal(page2.body.requests.length, 1);
    assert.notEqual(page2.body.requests[0].id, listA.body.requests[0].id);

    const detailA = await request(app)
      .get(`/v1/emergency/${newest.body.request.id}`)
      .set(auth(tokenA))
      .expect(200);
    assert.equal(detailA.body.request.id, newest.body.request.id);
    assert.deepEqual(detailA.body.results, []);
    guidanceMentions112(detailA.body);

    await request(app).get(`/v1/emergency/not-a-uuid`).set(auth(tokenA)).expect(404);
  });
});
