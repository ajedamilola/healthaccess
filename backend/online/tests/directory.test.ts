import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import { prisma } from '../src/db.js';
import { findReviewedContent } from '../src/domain/access.js';
import { errorHandler, notFound } from '../src/middleware/error.js';
import { requestContext } from '../src/middleware/request.js';
import { createDirectoryRouter } from '../src/modules/directory/router.js';
import {
  createSerperSearch,
  type FetchLike,
  type LivePlace,
  type SerperClient,
} from '../src/services/serper.js';

const suffix = randomUUID().slice(0, 8);
const liveBase = `https://live-${suffix}.example.test`;

type FacilityQuery = Parameters<SerperClient['discoverFacilities']>[0];
type FakeSerper = SerperClient & { facilityCalls: FacilityQuery[] };

function fakeSerper(
  discover?: (input: FacilityQuery) => Promise<LivePlace[]>,
): FakeSerper {
  const facilityCalls: FacilityQuery[] = [];
  return {
    configured: true,
    facilityCalls,
    searchWeb: async () => [],
    discoverFacilities: async (input) => {
      facilityCalls.push(input);
      return discover ? discover(input) : [];
    },
    discoverEmergency: async () => [],
  };
}

function buildApp(search: SerperClient) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/v1/directory', createDirectoryRouter({ search }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

const emptySearch = fakeSerper();
const app = buildApp(emptySearch);

function livePlace(name: string, overrides: Partial<LivePlace> = {}): LivePlace {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    name,
    address: `${name} address`,
    phone: '+2348012345678',
    latitude: 6.53,
    longitude: 3.38,
    website: `${liveBase}/${slug}`,
    source_url: `${liveBase}/${slug}`,
    source_reference: `ref-${suffix}-${slug}`,
    service_label: 'General care',
    verification_status: 'unverified',
    kind: 'facility',
    ...overrides,
  };
}

const serviceCodes = [`svc-active-${suffix}`, `svc-inactive-${suffix}`, `svc-unverified-${suffix}`];
const areaIds: string[] = [];
const topicCodes = [`topic-${suffix}-a`, `topic-${suffix}-b`];
let reviewerAccountId = '';
let liveLeadId = '';

let areaA = '';
let areaB = '';
let areaC = '';
let activeService = '';
let inactiveService = '';
let unverifiedService = '';
let nearFacility = '';
let demoFacility = '';
let pendingFacility = '';

before(async () => {
  activeService = serviceCodes[0];
  inactiveService = serviceCodes[1];
  unverifiedService = serviceCodes[2];

  await prisma.service.createMany({
    data: [
      { service_code: activeService, label: 'Test active service', sort_order: 900 },
      { service_code: inactiveService, label: 'Test inactive service', sort_order: 901, active: false },
      { service_code: unverifiedService, label: 'Test unverified service', sort_order: 902 },
    ],
  });

  const createArea = async (input: {
    name: string;
    city: string;
    region: string;
    latitude: number;
    longitude: number;
    active?: boolean;
    alias?: string;
  }) => {
    const area = await prisma.area.create({
      data: {
        country_code: 'NG',
        name: input.name,
        city: input.city,
        region: input.region,
        center_latitude: input.latitude,
        center_longitude: input.longitude,
        active: input.active ?? true,
        is_demo: false,
        ...(input.alias
          ? { aliases: { create: [{ alias_normalized: input.alias }] } }
          : {}),
      },
    });
    areaIds.push(area.id);
    return area.id;
  };

  areaA = await createArea({
    name: `Testville-${suffix}`,
    city: `Metro-${suffix}`,
    region: `Region-${suffix}`,
    latitude: 6.5244,
    longitude: 3.3792,
    alias: `alias-${suffix}`,
  });
  areaB = await createArea({
    name: `Nearby-${suffix}`,
    city: `NearCity-${suffix}`,
    region: `Region-${suffix}`,
    latitude: 6.6018,
    longitude: 3.3515,
  });
  areaC = await createArea({
    name: `Faraway-${suffix}`,
    city: `FarCity-${suffix}`,
    region: `Region-${suffix}`,
    latitude: 9.0765,
    longitude: 7.3986,
  });
  const areaInactive = await createArea({
    name: `Hidden-${suffix}`,
    city: `HiddenCity-${suffix}`,
    region: `Region-${suffix}`,
    latitude: 6.52,
    longitude: 3.37,
    active: false,
  });

  const createFacility = async (input: {
    name: string;
    areaId: string;
    latitude: number | null;
    longitude: number | null;
    status?: 'APPROVED' | 'PENDING';
    isDemo?: boolean;
    services: Array<{ code: string; verification: 'APPROVED' | 'UNVERIFIED' }>;
  }) => {
    const facility = await prisma.facility.create({
      data: {
        name: input.name,
        address: `${input.name} address`,
        area_id: input.areaId,
        latitude: input.latitude,
        longitude: input.longitude,
        phone: '+2348000000000',
        status: input.status ?? 'APPROVED',
        is_demo: input.isDemo ?? false,
        facility_services: {
          create: input.services.map((entry) => ({
            service: { connect: { service_code: entry.code } },
            verification_status: entry.verification,
            verified_at: entry.verification === 'APPROVED' ? new Date() : null,
          })),
        },
      },
    });
    return facility.id;
  };

  nearFacility = await createFacility({
    name: `Near-${suffix}`,
    areaId: areaA,
    latitude: 6.53,
    longitude: 3.38,
    services: [
      { code: activeService, verification: 'APPROVED' },
      { code: unverifiedService, verification: 'UNVERIFIED' },
      { code: inactiveService, verification: 'APPROVED' },
    ],
  });
  demoFacility = await createFacility({
    name: `Demo-${suffix}`,
    areaId: areaA,
    latitude: 6.53,
    longitude: 3.38,
    isDemo: true,
    services: [{ code: activeService, verification: 'APPROVED' }],
  });
  await createFacility({
    name: `UnknownSame-${suffix}`,
    areaId: areaA,
    latitude: null,
    longitude: null,
    services: [{ code: activeService, verification: 'APPROVED' }],
  });
  await createFacility({
    name: `Mid-${suffix}`,
    areaId: areaB,
    latitude: 6.6018,
    longitude: 3.3515,
    services: [{ code: activeService, verification: 'APPROVED' }],
  });
  await createFacility({
    name: `UnknownOther-${suffix}`,
    areaId: areaB,
    latitude: null,
    longitude: null,
    services: [{ code: activeService, verification: 'APPROVED' }],
  });
  await createFacility({
    name: `Far-${suffix}`,
    areaId: areaC,
    latitude: 9.0765,
    longitude: 7.3986,
    services: [{ code: activeService, verification: 'APPROVED' }],
  });
  await createFacility({
    name: `Unverified-${suffix}`,
    areaId: areaA,
    latitude: 6.53,
    longitude: 3.38,
    services: [{ code: activeService, verification: 'UNVERIFIED' }],
  });
  pendingFacility = await createFacility({
    name: `Pending-${suffix}`,
    areaId: areaA,
    latitude: 6.53,
    longitude: 3.38,
    status: 'PENDING',
    services: [{ code: activeService, verification: 'APPROVED' }],
  });
  await createFacility({
    name: `HiddenArea-${suffix}`,
    areaId: areaInactive,
    latitude: 6.52,
    longitude: 3.37,
    services: [{ code: activeService, verification: 'APPROVED' }],
  });

  const reviewer = await prisma.account.create({
    data: {
      email: `directory-reviewer-${suffix}@portal.test`,
      password_hash: 'test-password-hash',
      display_name: 'Content reviewer',
    },
  });
  reviewerAccountId = reviewer.id;

  const reviewedAt = new Date();
  await prisma.reviewedHealthContent.createMany({
    data: [
      {
        topic_code: topicCodes[0],
        version: 1,
        title: 'Old topic title',
        body: 'old body',
        status: 'PUBLISHED',
        reviewer_account_id: reviewerAccountId,
        reviewed_at: reviewedAt,
        published_at: reviewedAt,
      },
      {
        topic_code: topicCodes[0],
        version: 2,
        title: 'Current topic title',
        body: `needle-${suffix} is matched in the body`,
        status: 'PUBLISHED',
        reviewer_account_id: reviewerAccountId,
        reviewed_at: reviewedAt,
        published_at: reviewedAt,
      },
      {
        topic_code: topicCodes[0],
        version: 3,
        title: 'Draft topic',
        body: `needle-${suffix} draft`,
        status: 'DRAFT',
        reviewer_account_id: reviewerAccountId,
        reviewed_at: reviewedAt,
      },
      {
        topic_code: topicCodes[1],
        version: 2,
        title: `Second topic needle-${suffix}`,
        body: 'second body',
        status: 'PUBLISHED',
        reviewer_account_id: reviewerAccountId,
        reviewed_at: reviewedAt,
        published_at: reviewedAt,
      },
    ],
  });
});

after(async () => {
  await prisma.facility.deleteMany({ where: { area_id: { in: areaIds } } });
  await prisma.area.deleteMany({ where: { id: { in: areaIds } } });
  await prisma.service.deleteMany({ where: { service_code: { in: serviceCodes } } });
  await prisma.source.deleteMany({ where: { canonical_url: { startsWith: liveBase } } });
  await prisma.reviewedHealthContent.deleteMany({
    where: { topic_code: { in: topicCodes } },
  });
  if (reviewerAccountId) {
    await prisma.account.deleteMany({ where: { id: reviewerAccountId } });
  }
  await prisma.$disconnect();
});

describe('directory reads', () => {
  it('lists only active services without authentication', async () => {
    const response = await request(app).get('/v1/directory/services').expect(200);
    const codes = response.body.map((service: { service_code: string }) => service.service_code);
    assert.ok(codes.includes(activeService));
    assert.ok(codes.includes(unverifiedService));
    assert.equal(codes.includes(inactiveService), false);
  });

  it('matches areas by name, city and alias with exact matches first', async () => {
    const alias = await request(app)
      .get(`/v1/directory/areas?q=alias-${suffix}&limit=5`)
      .expect(200);
    assert.equal(alias.body[0].id, areaA);
    assert.equal(alias.body[0].is_demo, false);

    const city = await request(app)
      .get(`/v1/directory/areas?q=metro-${suffix}`)
      .expect(200);
    assert.equal(city.body[0].id, areaA);

    const name = await request(app)
      .get(`/v1/directory/areas?q=testville-${suffix}`)
      .expect(200);
    assert.equal(name.body[0].id, areaA);

    const none = await request(app)
      .get(`/v1/directory/areas?q=nothing-${suffix}`)
      .expect(200);
    assert.deepEqual(none.body, []);

    const hidden = await request(app)
      .get(`/v1/directory/areas?q=hidden-${suffix}`)
      .expect(200);
    assert.deepEqual(hidden.body, []);

    const bounded = await request(app).get('/v1/directory/areas?limit=50').expect(200);
    assert.ok(bounded.body.length <= 10);
  });

  it('finds approved non-demo facilities in radius and keeps unknown distances in-area', async () => {
    const response = await request(app)
      .get(
        `/v1/directory/facilities?service=${activeService}&area_id=${areaA}&radius_km=5&limit=10&include_live=false`,
      )
      .expect(200);

    const names = response.body.map((facility: { name: string }) => facility.name);
    assert.equal(names[0], `Near-${suffix}`);
    assert.ok(names.includes(`UnknownSame-${suffix}`));
    assert.equal(names.includes(`Demo-${suffix}`), false);
    assert.equal(names.includes(`Mid-${suffix}`), false);
    assert.equal(names.includes(`UnknownOther-${suffix}`), false);
    assert.equal(names.includes(`Far-${suffix}`), false);
    assert.equal(names.includes(`Unverified-${suffix}`), false);
    assert.equal(names.includes(`Pending-${suffix}`), false);
    assert.equal(names.includes(`HiddenArea-${suffix}`), false);

    assert.equal(typeof response.body[0].distance_km, 'number');
    assert.ok(response.body[0].distance_km < 2);
    assert.equal(response.body[0].service_code, activeService);
    assert.equal(response.body[0].is_demo, false);
    assert.equal(response.body[0].source, 'directory');
    assert.equal(response.body[0].verification_status, 'approved');
    assert.equal(response.body[0].source_url, null);
    assert.equal(response.body[1].distance_km, null);
  });

  it('applies the default radius, bounds limit and validates query input', async () => {
    const defaultRadius = await request(app)
      .get(`/v1/directory/facilities?service=${activeService}&area_id=${areaA}`)
      .expect(200);
    const names = defaultRadius.body.map((facility: { name: string }) => facility.name);
    assert.ok(names.includes(`Near-${suffix}`));
    assert.ok(names.includes(`Mid-${suffix}`));
    assert.ok(names.includes(`UnknownSame-${suffix}`));
    assert.equal(names.includes(`Far-${suffix}`), false);

    const bounded = await request(app)
      .get(
        `/v1/directory/facilities?service=${activeService}&area_id=${areaA}&limit=50`,
      )
      .expect(200);
    assert.ok(bounded.body.length <= 10);

    const single = await request(app)
      .get(
        `/v1/directory/facilities?service=${activeService}&area_id=${areaA}&limit=1`,
      )
      .expect(200);
    assert.equal(single.body.length, 1);

    await request(app)
      .get(`/v1/directory/facilities?service=${activeService}&area_id=${areaA}&radius_km=-2`)
      .expect(400);
    await request(app).get(`/v1/directory/facilities?area_id=${areaA}`).expect(400);
    await request(app).get('/v1/directory/facilities?service=general&area_id=nope').expect(400);
    await request(app)
      .get(
        `/v1/directory/facilities?service=${activeService}&area_id=${areaA}&include_live=maybe`,
      )
      .expect(400);

    const missingArea = await request(app)
      .get(
        `/v1/directory/facilities?service=${activeService}&area_id=${randomUUID()}`,
      )
      .expect(200);
    assert.deepEqual(missingArea.body, []);

    const noApprovedService = await request(app)
      .get(
        `/v1/directory/facilities?service=${unverifiedService}&area_id=${areaA}`,
      )
      .expect(200);
    assert.deepEqual(noApprovedService.body, []);
  });

  it('returns approved facility detail with verified active services only', async () => {
    const detail = await request(app)
      .get(`/v1/directory/facilities/${nearFacility}`)
      .expect(200);
    assert.equal(detail.body.id, nearFacility);
    assert.equal(detail.body.is_demo, false);
    assert.equal(detail.body.area.id, areaA);
    assert.equal(detail.body.source_trust, 'unknown');
    assert.equal(detail.body.source, 'directory');
    assert.equal(detail.body.verification_status, 'approved');
    assert.deepEqual(
      detail.body.services.map((service: { service_code: string }) => service.service_code),
      [activeService],
    );

    await request(app).get(`/v1/directory/facilities/${demoFacility}`).expect(404);
    await request(app).get(`/v1/directory/facilities/${pendingFacility}`).expect(404);
    await request(app).get(`/v1/directory/facilities/${randomUUID()}`).expect(404);
  });
});

describe('live directory search', () => {
  it('merges live facilities, dedupes against directory rows and respects the limit', async () => {
    const duplicate = livePlace(`Near-${suffix}`, {
      address: `Near-${suffix} address`,
      source_reference: `ref-${suffix}-duplicate`,
    });
    const liveA = livePlace(`Live-A-${suffix}`);
    const liveB = livePlace(`Live-B-${suffix}`);
    const liveC = livePlace(`Live-C-${suffix}`);
    const search = fakeSerper(async () => [duplicate, liveA, liveB, liveC]);
    const liveApp = buildApp(search);

    const response = await request(liveApp)
      .get(
        `/v1/directory/facilities?service=${activeService}&area_id=${areaA}&radius_km=5&limit=4`,
      )
      .expect(200);

    const names = response.body.map((facility: { name: string }) => facility.name);
    assert.equal(response.body.length, 4);
    assert.deepEqual(
      names.filter((name: string) => name === `Near-${suffix}`),
      [`Near-${suffix}`],
      'live duplicate of an approved facility is dropped',
    );
    assert.ok(names.includes(`UnknownSame-${suffix}`));
    assert.ok(names.includes(`Live-A-${suffix}`));
    assert.ok(names.includes(`Live-B-${suffix}`));
    assert.equal(names.includes(`Live-C-${suffix}`), false);
    assert.equal(search.facilityCalls.length, 1);

    const liveRow = response.body.find(
      (facility: { name: string }) => facility.name === `Live-A-${suffix}`,
    );
    assert.equal(liveRow.source, 'web');
    assert.equal(liveRow.verification_status, 'unverified');
    assert.equal(liveRow.is_demo, false);
    assert.equal(liveRow.source_url, liveA.source_url);
    assert.equal(liveRow.source_reference, liveA.source_reference);
    assert.equal(liveRow.service_label, liveA.service_label);
    assert.equal(liveRow.latitude, liveA.latitude);
    assert.equal(typeof liveRow.distance_km, 'number');
    liveLeadId = liveRow.id;

    const leads = await prisma.webLead.findMany({
      where: { source_url: { in: [duplicate.source_url, liveA.source_url, liveB.source_url, liveC.source_url] } },
      include: { source: { select: { trust_tier: true } } },
    });
    assert.equal(leads.length, 4, 'every discovered live place is persisted');
    assert.ok(leads.every((lead) => lead.source.trust_tier === 'UNVERIFIED_WEB'));
    assert.ok(leads.some((lead) => lead.id === liveLeadId));
  });

  it('defaults include_live to true and skips live search when disabled', async () => {
    const search = fakeSerper(async () => [livePlace(`Toggle-${suffix}`)]);
    const toggleApp = buildApp(search);

    const withLive = await request(toggleApp)
      .get(`/v1/directory/facilities?service=${activeService}&area_id=${areaA}&limit=10`)
      .expect(200);
    assert.ok(
      withLive.body.some(
        (facility: { name: string }) => facility.name === `Toggle-${suffix}`,
      ),
    );
    assert.equal(search.facilityCalls.length, 1);

    const withoutLive = await request(toggleApp)
      .get(
        `/v1/directory/facilities?service=${activeService}&area_id=${areaA}&limit=10&include_live=false`,
      )
      .expect(200);
    assert.equal(
      withoutLive.body.some(
        (facility: { name: string }) => facility.name === `Toggle-${suffix}`,
      ),
      false,
    );
    assert.equal(search.facilityCalls.length, 1, 'live search is not called when disabled');
  });

  it('does not call live search when approved results already fill the limit', async () => {
    const search = fakeSerper(async () => [livePlace(`Unused-${suffix}`)]);
    const fullApp = buildApp(search);

    const response = await request(fullApp)
      .get(`/v1/directory/facilities?service=${activeService}&area_id=${areaA}&limit=2`)
      .expect(200);
    assert.equal(response.body.length, 2);
    assert.ok(response.body.every((facility: { source: string }) => facility.source === 'directory'));
    assert.equal(search.facilityCalls.length, 0);
  });

  it('returns directory results when the live search fails', async () => {
    const search = fakeSerper(async () => {
      throw new Error('serper unavailable');
    });
    const failingApp = buildApp(search);

    const response = await request(failingApp)
      .get(`/v1/directory/facilities?service=${activeService}&area_id=${areaA}&limit=4`)
      .expect(200);
    assert.ok(response.body.length >= 2);
    assert.ok(
      response.body.every((facility: { source: string }) => facility.source === 'directory'),
    );
  });

  it('serves a stored web lead from the facility detail endpoint', async () => {
    assert.ok(liveLeadId, 'live merge test persisted a lead');

    const detail = await request(app)
      .get(`/v1/directory/facilities/${liveLeadId}`)
      .expect(200);
    assert.equal(detail.body.id, liveLeadId);
    assert.equal(detail.body.kind, 'web_lead');
    assert.equal(detail.body.verification_status, 'unverified');
    assert.equal(detail.body.is_demo, false);
    assert.equal(detail.body.source_trust, 'UNVERIFIED_WEB');
    assert.ok(detail.body.source_url.startsWith(liveBase));
    assert.equal(detail.body.service_label, 'General care');
    assert.deepEqual(detail.body.services, []);
  });
});

describe('reviewed content matching', () => {
  it('returns the highest published reviewed version per topic', async () => {
    const matches = await findReviewedContent(`needle-${suffix}`, 5);
    assert.equal(matches.length, 2);
    const topicA = matches.find((match) => match.topic === topicCodes[0]);
    assert.ok(topicA);
    assert.equal(topicA.version, 2);
    assert.equal(topicA.reviewer, 'Content reviewer');
    assert.ok(topicA.reviewed_at);
    assert.equal(matches.some((match) => match.version === 3), false);

    const limited = await findReviewedContent(`needle-${suffix}`, 1);
    assert.equal(limited.length, 1);

    const blank = await findReviewedContent('   ', 3);
    assert.deepEqual(blank, []);
  });
});

describe('serper client', () => {
  interface Call {
    url: string;
    body: Record<string, unknown>;
    signal: AbortSignal | null | undefined;
  }

  function capturedFetch(
    handler: (url: string, body: Record<string, unknown>) => Response | Promise<Response>,
  ) {
    const calls: Call[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url, body, signal: init.signal });
      return handler(url, body);
    };
    return { calls, fetchImpl };
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function place(overrides: Record<string, unknown> = {}) {
    return {
      title: 'Clinic',
      address: '1 Road, Ikeja',
      cid: '1001',
      website: 'https://clinic.lagos-health.ng',
      latitude: 6.6,
      longitude: 3.35,
      ...overrides,
    };
  }

  it('is inert when no api key is configured', async () => {
    let fetched = 0;
    const client = createSerperSearch(
      { apiKey: '   ' },
      {
        fetchImpl: async () => {
          fetched += 1;
          throw new Error('network should not be used');
        },
      },
    );

    assert.equal(client.configured, false);
    assert.deepEqual(await client.searchWeb('hospitals in Ikeja'), []);
    assert.deepEqual(
      await client.discoverFacilities({ serviceLabel: 'General care', area: 'Ikeja' }),
      [],
    );
    assert.deepEqual(await client.discoverEmergency({ area: 'Ikeja', kind: 'both' }), []);
    assert.equal(fetched, 0);
  });

  it('redacts long digit runs and phone-like sequences from queries', async () => {
    const { calls, fetchImpl } = capturedFetch(() => jsonResponse({ organic: [] }));
    const client = createSerperSearch({ apiKey: 'test-key' }, { fetchImpl });

    await client.searchWeb('Call +234 801 234 5678 about 123456789 now');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://google.serper.dev/search');
    const query = String(calls[0].body.q);
    assert.match(query, /\[number removed\]/);
    assert.equal(query.includes('+234'), false);
    assert.equal(query.includes('123456789'), false);
    assert.equal(calls[0].body.gl, 'ng');
    assert.equal(calls[0].body.hl, 'en');
  });

  it('skips queries without letters without calling the network', async () => {
    const { calls, fetchImpl } = capturedFetch(() => jsonResponse({ organic: [] }));
    const client = createSerperSearch({ apiKey: 'test-key' }, { fetchImpl });

    assert.deepEqual(await client.searchWeb('1234567890123'), []);
    assert.equal(calls.length, 0);
  });

  it('only accepts https public result links', async () => {
    const { fetchImpl } = capturedFetch(() =>
      jsonResponse({
        organic: [
          { title: 'Insecure', link: 'http://clinic.ng' },
          { title: 'Loopback', link: 'https://127.0.0.1/admin' },
          { title: 'Localhost', link: 'https://localhost/admin' },
          { title: 'Missing', link: 'not a url' },
          { title: 'Good', link: 'https://clinic.lagos-health.ng/emergency', snippet: 'Open 24h' },
          { title: 'Duplicate', link: 'https://clinic.lagos-health.ng/emergency' },
        ],
      }),
    );
    const client = createSerperSearch({ apiKey: 'test-key' }, { fetchImpl });

    const results = await client.searchWeb('emergency hospital in Ikeja');
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Good');
    assert.equal(results[0].url, 'https://clinic.lagos-health.ng/emergency');
    assert.equal(results[0].snippet, 'Open 24h');
  });

  it('rejects oversized, malformed and failed responses', async () => {
    const huge = createSerperSearch(
      { apiKey: 'test-key' },
      {
        fetchImpl: async () =>
          new Response('{}', {
            status: 200,
            headers: { 'content-length': String(600 * 1024) },
          }),
      },
    );
    await assert.rejects(huge.searchWeb('clinic in Ikeja'), /too large/);

    const malformed = createSerperSearch(
      { apiKey: 'test-key' },
      { fetchImpl: async () => new Response('not-json', { status: 200 }) },
    );
    await assert.rejects(malformed.searchWeb('clinic in Ikeja'), /invalid serper response/);

    const failed = createSerperSearch(
      { apiKey: 'test-key' },
      { fetchImpl: async () => jsonResponse({ error: 'nope' }, 500) },
    );
    await assert.rejects(failed.searchWeb('clinic in Ikeja'), /serper request failed/);
  });

  it('aborts the request on timeout', async () => {
    const client = createSerperSearch(
      { apiKey: 'test-key', timeoutMs: 500 },
      {
        fetchImpl: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal;
            signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
          }),
      },
    );

    await assert.rejects(client.searchWeb('clinic in Ikeja'), /aborted by timeout/);
  });

  it('maps, dedupes and sanitizes maps results', async () => {
    const { calls, fetchImpl } = capturedFetch(() =>
      jsonResponse({
        places: [
          place(),
          place(),
          place({ cid: '1002' }),
          place({ title: 'Clinic B', address: '2 Road', cid: undefined, placeId: 'pid-b', website: null, latitude: '6.61', longitude: '3.36' }),
          place({
            title: 'Clinic C',
            address: '3 Road',
            cid: undefined,
            website: 'http://insecure.ng',
          }),
        ],
      }),
    );
    const client = createSerperSearch({ apiKey: 'test-key' }, { fetchImpl });

    const results = await client.discoverFacilities({
      serviceCode: 'general',
      serviceLabel: 'General care',
      area: 'Ikeja, Lagos, Nigeria',
      limit: 8,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://google.serper.dev/maps');
    assert.match(String(calls[0].body.q), /general hospital in Ikeja/);
    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((result) => result.name),
      ['Clinic', 'Clinic B', 'Clinic C'],
    );
    assert.equal(results[0].verification_status, 'unverified');
    assert.equal(results[0].kind, 'facility');
    assert.equal(results[1].latitude, 6.61);
    assert.equal(results[1].source_url, 'https://www.google.com/maps/place/?q=place_id:pid-b');
    assert.equal(results[2].website, null);
    assert.match(results[2].source_url, /^https:\/\/www\.google\.com\/maps\/search/);
  });

  it('searches hospital and ambulance queries for emergency and dedupes across them', async () => {
    const shared = place({ title: 'Shared Hospital', cid: 'shared' });
    const { calls, fetchImpl } = capturedFetch((_url, body) => {
      const query = String(body.q);
      if (query.includes('ambulance')) {
        return jsonResponse({
          places: [shared, place({ title: 'Ambulance One', cid: 'amb-1', placeId: 'amb-1' })],
        });
      }
      return jsonResponse({ places: [shared, place({ title: 'Hospital One', cid: 'hos-1' })] });
    });
    const client = createSerperSearch({ apiKey: 'test-key' }, { fetchImpl });

    const both = await client.discoverEmergency({ area: 'Ikeja', kind: 'both', limit: 8 });
    assert.equal(calls.length, 2);
    assert.deepEqual(
      both.map((result) => result.name),
      ['Shared Hospital', 'Hospital One', 'Ambulance One'],
    );
    assert.ok(both.every((result) => result.kind === 'emergency'));
    assert.equal(both[0].service_label, 'Emergency hospital');
    assert.equal(both[2].service_label, 'Ambulance service');

    calls.length = 0;
    await client.discoverEmergency({ area: 'Ikeja', kind: 'hospital', limit: 8 });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].body.q), /emergency hospital in Ikeja/);
  });
});
