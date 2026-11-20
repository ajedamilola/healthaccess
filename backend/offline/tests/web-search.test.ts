import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSearch } from '../src/services/web-search.js';
import type { FetchResponse, WebSearchConfig } from '../src/services/web-search.js';

type FetchCall = { url: string; init: RequestInit };

function responseJson(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function mockFetch(
  handler: (url: string, init: RequestInit, call: number) => FetchResponse | Promise<FetchResponse>,
): ((url: string, init: RequestInit) => Promise<FetchResponse>) & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<FetchResponse> => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return Object.assign(fetchImpl, { calls });
}

function baseConfig(overrides: Partial<WebSearchConfig> = {}): WebSearchConfig {
  return {
    serperApiKey: 'test-serper-key',
    serperTimeoutMs: 80,
    healthSourceDomains: ['who.int'],
    ...overrides,
  };
}

function requestBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function requestHeader(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string>;
  return headers[name];
}

test('searchHealth posts bounded JSON to the fixed search endpoint', async () => {
  const fetchImpl = mockFetch(() =>
    responseJson({
      organic: [
        {
          title: 'WHO fact sheet',
          link: 'https://www.who.int/news/fact',
          snippet: 'Fever advice.',
        },
        { title: 'Exact', link: 'https://who.int/page', snippet: 'Exact host.' },
        { title: 'Subdomain', link: 'https://apps.who.int/report', snippet: 'Subdomain.' },
      ],
    }),
  );
  const search = createWebSearch(baseConfig(), { fetchImpl });
  const sources = await search.searchHealth('fever advice');

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://google.serper.dev/search');
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(fetchImpl.calls[0].init.redirect, 'error');
  assert.equal(requestHeader(fetchImpl.calls[0].init, 'X-API-KEY'), 'test-serper-key');
  assert.equal(requestHeader(fetchImpl.calls[0].init, 'Content-Type'), 'application/json');
  assert.ok(fetchImpl.calls[0].init.signal);
  assert.deepEqual(requestBody(fetchImpl.calls[0].init), {
    q: 'fever advice',
    gl: 'ng',
    hl: 'en',
    num: 8,
  });
  assert.deepEqual(sources, [
    { title: 'WHO fact sheet', url: 'https://www.who.int/news/fact', snippet: 'Fever advice.' },
    { title: 'Exact', url: 'https://who.int/page', snippet: 'Exact host.' },
    { title: 'Subdomain', url: 'https://apps.who.int/report', snippet: 'Subdomain.' },
  ]);
});

test('searchHealth rejects spoofed, insecure, credentialed and local source URLs', async () => {
  const candidates = [
    'https://evilwho.int/x',
    'https://who.int.evil.com/x',
    'https://notwho.int/x',
    'http://who.int/x',
    'https://user:pass@who.int/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://169.254.169.254/latest',
    'https://localhost/x',
    'https://who.int:8443/x',
    'javascript:alert(1)',
  ];
  const fetchImpl = mockFetch(() =>
    responseJson({
      organic: [
        ...candidates.map((link, index) => ({ title: `bad-${index}`, link, snippet: 'bad' })),
        { title: 'allowed', link: 'https://www.who.int/ok', snippet: 'ok' },
      ],
    }),
  );
  const search = createWebSearch(baseConfig(), { fetchImpl });
  const sources = await search.searchHealth('safe query');

  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, 'https://www.who.int/ok');
});

test('searchHealth deduplicates URLs and caps source strings', async () => {
  const longTitle = 'T'.repeat(500);
  const longSnippet = 'S'.repeat(2000);
  const fetchImpl = mockFetch(() =>
    responseJson({
      organic: [
        { title: longTitle, link: 'https://who.int/a', snippet: longSnippet },
        { title: 'duplicate', link: 'https://who.int/a', snippet: 'duplicate' },
      ],
    }),
  );
  const search = createWebSearch(baseConfig(), { fetchImpl });
  const sources = await search.searchHealth('query');

  assert.equal(sources.length, 1);
  assert.equal(sources[0].title.length, 300);
  assert.equal(sources[0].snippet.length, 800);
});

test('searchHealth redacts long digit runs and formatted phone numbers before search', async () => {
  const fetchImpl = mockFetch(() => responseJson({ organic: [] }));
  const search = createWebSearch(baseConfig(), { fetchImpl });
  await search.searchHealth('Patient 123456789 phone 0803 123 4567 has fever 987654321012345');

  const body = requestBody(fetchImpl.calls[0].init);
  const q = String(body.q ?? '');
  assert.ok(!q.includes('123456789'));
  assert.ok(!q.includes('987654321012345'));
  assert.ok(!q.includes('0803 123 4567'));
  assert.ok(q.includes('fever'));
  assert.ok(q.includes('[number removed]'));
  assert.ok(q.length <= 180);
});

test('searchHealth caps oversized queries', async () => {
  const fetchImpl = mockFetch(() => responseJson({ organic: [] }));
  const search = createWebSearch(baseConfig(), { fetchImpl });
  await search.searchHealth('a'.repeat(500));
  const body = requestBody(fetchImpl.calls[0].init);
  assert.ok(String(body.q ?? '').length <= 180);
});

test('searchHealth performs no request for digit-only or empty queries', async () => {
  const fetchImpl = mockFetch(() => responseJson({ organic: [] }));
  const search = createWebSearch(baseConfig(), { fetchImpl });
  assert.deepEqual(await search.searchHealth('123456789'), []);
  assert.deepEqual(await search.searchHealth('   '), []);
  assert.deepEqual(await search.searchHealth(undefined as unknown as string), []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('searchHealth performs no request when the health allowlist is empty', async () => {
  const fetchImpl = mockFetch(() => responseJson({ organic: [] }));
  const search = createWebSearch(baseConfig({ healthSourceDomains: [] }), { fetchImpl });
  assert.deepEqual(await search.searchHealth('fever'), []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('searchHealth accepts minimal fetch mocks and fails closed on ok:false', async () => {
  const minimal = createWebSearch(baseConfig(), {
    fetchImpl: mockFetch(() => ({
      ok: true,
      json: async () => ({ organic: [{ title: 'WHO', link: 'https://who.int/x', snippet: 'ok' }] }),
    })),
  });
  assert.deepEqual(await minimal.searchHealth('fever'), [
    { title: 'WHO', url: 'https://who.int/x', snippet: 'ok' },
  ]);

  const failed = createWebSearch(baseConfig(), {
    fetchImpl: mockFetch(() => ({ ok: false, json: async () => ({ organic: [] }) })),
  });
  assert.deepEqual(await failed.searchHealth('fever'), []);
});

test('searchHealth fails closed on provider errors, invalid JSON and timeouts', async () => {
  const serverError = createWebSearch(baseConfig(), {
    fetchImpl: mockFetch(() => responseJson({ error: 'bad' }, { status: 500 })),
  });
  assert.deepEqual(await serverError.searchHealth('fever'), []);

  const invalidJson = createWebSearch(baseConfig(), {
    fetchImpl: mockFetch(() => new Response('not-json', { status: 200 })),
  });
  assert.deepEqual(await invalidJson.searchHealth('fever'), []);

  const rejected = createWebSearch(baseConfig(), {
    fetchImpl: mockFetch(() => {
      throw new Error('network down');
    }),
  });
  assert.deepEqual(await rejected.searchHealth('fever'), []);

  let aborted = false;
  const hanging = createWebSearch(baseConfig({ serperTimeoutMs: 30 }), {
    fetchImpl: (_url, init) =>
      new Promise<FetchResponse>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
  });
  const started = Date.now();
  assert.deepEqual(await hanging.searchHealth('fever'), []);
  assert.ok(Date.now() - started < 1000);
  assert.equal(aborted, true);
});

test('searchHealth bounds response size', async () => {
  const tooLargeByHeader = createWebSearch(baseConfig(), {
    fetchImpl: mockFetch(() =>
      responseJson({ organic: [] }, { headers: { 'content-length': String(600 * 1024) } }),
    ),
  });
  assert.deepEqual(await tooLargeByHeader.searchHealth('fever'), []);

  const tooLargeByBody = createWebSearch(baseConfig(), {
    fetchImpl: mockFetch(() => new Response('x'.repeat(600 * 1024), { status: 200 })),
  });
  assert.deepEqual(await tooLargeByBody.searchHealth('fever'), []);
});

test('discoverFacilities maps Serper places into unverified leads', async () => {
  const fetchImpl = mockFetch(() =>
    responseJson({
      places: [
        {
          title: 'Lagos Community Clinic',
          address: '1 Broad Street, Lagos',
          latitude: 6.45,
          longitude: 3.39,
          phoneNumber: '+234 800 000 0000',
          placeId: 'place-1',
          cid: 'cid-1',
          website: 'http://untrusted.example',
        },
        {
          title: 'No Phone Hospital',
          address: '2 Marina Road',
          latitude: '6.5',
          longitude: 500,
          placeId: 'place-2',
        },
        {
          title: 'Website Clinic',
          address: '3 Island Way',
          placeId: 'place-3',
          website: 'https://clinic.example.org/location',
        },
        { title: '', address: 'missing name' },
      ],
    }),
  );
  const search = createWebSearch(baseConfig({ healthSourceDomains: [] }), { fetchImpl });
  const leads = await search.discoverFacilities({ serviceLabel: 'hospital', area: 'Lagos' });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://google.serper.dev/maps');
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.deepEqual(requestBody(fetchImpl.calls[0].init), {
    q: 'hospital in Lagos',
    gl: 'ng',
    hl: 'en',
  });
  assert.equal(leads.length, 3);

  assert.equal(leads[0].name, 'Lagos Community Clinic');
  assert.equal(leads[0].address, '1 Broad Street, Lagos');
  assert.equal(leads[0].phone, '+234 800 000 0000');
  assert.equal(leads[0].latitude, 6.45);
  assert.equal(leads[0].longitude, 3.39);
  assert.equal(leads[0].source_reference, 'place-1');
  assert.equal(leads[0].source_url, 'https://www.google.com/maps/place/?q=place_id:place-1');
  assert.equal(leads[0].verification_status, 'unverified');
  assert.equal(leads[0].service_label, 'hospital');

  assert.equal(leads[1].phone, null);
  assert.equal(leads[1].latitude, null);
  assert.equal(leads[1].longitude, null);
  assert.equal(leads[1].verification_status, 'unverified');

  assert.equal(leads[2].source_url, 'https://clinic.example.org/location');
  assert.equal(leads[2].source_reference, 'place-3');
  assert.equal(leads[2].verification_status, 'unverified');
});

test('discoverFacilities builds fixed-host maps URLs when identifiers are absent and dedupes', async () => {
  const fetchImpl = mockFetch(() =>
    responseJson({
      places: [
        { title: 'Clinic A', address: '1 A Road', cid: '99' },
        { title: 'Clinic A', address: '1 A Road', cid: '99' },
        { title: 'Clinic B', address: '2 B Road' },
      ],
    }),
  );
  const search = createWebSearch(baseConfig({ healthSourceDomains: [] }), { fetchImpl });
  const leads = await search.discoverFacilities({ serviceLabel: 'clinic', area: 'Ikeja' });

  assert.equal(leads.length, 2);
  assert.equal(leads[0].source_url, 'https://maps.google.com/?cid=99');
  assert.equal(leads[0].source_reference, '99');
  assert.match(leads[1].source_url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.equal(leads[1].source_reference, 'Clinic B, 2 B Road');
  assert.equal(leads[1].verification_status, 'unverified');
});

test('discoverFacilities fails closed on bad input, errors and timeouts', async () => {
  const fetchImpl = mockFetch(() => responseJson({ places: [] }));
  const search = createWebSearch(baseConfig({ healthSourceDomains: [] }), { fetchImpl });

  assert.deepEqual(await search.discoverFacilities({ serviceLabel: '', area: 'Lagos' }), []);
  assert.deepEqual(await search.discoverFacilities({ serviceLabel: 'clinic', area: '123456' }), []);
  assert.equal(fetchImpl.calls.length, 0);

  const failing = createWebSearch(baseConfig({ healthSourceDomains: [] }), {
    fetchImpl: mockFetch(() => responseJson({}, { status: 401 })),
  });
  assert.deepEqual(await failing.discoverFacilities({ serviceLabel: 'clinic', area: 'Lagos' }), []);

  const hanging = createWebSearch(baseConfig({ healthSourceDomains: [], serperTimeoutMs: 30 }), {
    fetchImpl: () => new Promise<FetchResponse>(() => {}),
  });
  assert.deepEqual(await hanging.discoverFacilities({ serviceLabel: 'clinic', area: 'Lagos' }), []);
});

test('createWebSearch validates configuration without exposing secrets', () => {
  assert.throws(
    () => createWebSearch({ healthSourceDomains: [] } as unknown as WebSearchConfig),
    /serperApiKey/,
  );
  assert.throws(() => createWebSearch(baseConfig({ serperApiKey: '  ' })), /serperApiKey/);
  assert.throws(() => createWebSearch(baseConfig({ serperTimeoutMs: 0 })), /serperTimeoutMs/);
  assert.throws(() => createWebSearch(baseConfig({ serperCountry: 'nigeria' })), /serperCountry/);
  assert.throws(() => createWebSearch(baseConfig({ serperLocale: 'english' })), /serperLocale/);
  assert.throws(
    () => createWebSearch(baseConfig({ healthSourceDomains: 'who.int' as unknown as string[] })),
    /healthSourceDomains/,
  );
  assert.throws(
    () => createWebSearch(baseConfig({ healthSourceDomains: ['127.0.0.1'] })),
    /public hostnames/,
  );
  assert.throws(
    () => createWebSearch(baseConfig({ healthSourceDomains: ['localhost'] })),
    /public hostnames/,
  );
  assert.throws(
    () => createWebSearch(baseConfig({ healthSourceDomains: ['https://who.int'] })),
    /public hostnames/,
  );
  assert.throws(
    () => createWebSearch(baseConfig({ healthSourceDomains: ['*.who.int'] })),
    /public hostnames/,
  );
});

test('discoverEmergency runs hospital and ambulance Maps queries in parallel and merges deterministically', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = mockFetch(async (url, init) => {
    assert.equal(url, 'https://google.serper.dev/maps');
    const body = requestBody(init);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    if (body.q === 'Road accident emergency hospital in Ikeja') {
      return responseJson({
        places: [
          { title: 'Ikeja Emergency Hospital', address: '1 Allen Road', placeId: 'h1' },
          { title: 'Shared Clinic', address: '2 Allen Road', placeId: 'shared' },
        ],
      });
    }
    return responseJson({
      places: [
        { title: 'Shared Clinic', address: '2 Allen Road', placeId: 'shared' },
        { title: 'Lagos Ambulance Service', address: '3 Allen Road', placeId: 'a1' },
      ],
    });
  });
  const search = createWebSearch(baseConfig({ healthSourceDomains: [] }), { fetchImpl });
  const leads = await search.discoverEmergency({ area: 'Ikeja', description: 'Road accident' });

  assert.equal(peak, 2);
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(
    fetchImpl.calls.map((call) => requestBody(call.init).q),
    ['Road accident emergency hospital in Ikeja', 'Road accident ambulance service in Ikeja'],
  );
  assert.deepEqual(
    leads.map((item) => item.source_reference),
    ['h1', 'shared', 'a1'],
  );
  assert.equal(leads[0].service_label, 'Emergency hospital');
  assert.equal(leads[2].service_label, 'Ambulance service');
  assert.ok(leads.every((item) => item.verification_status === 'unverified'));
});

test('discoverEmergency caps results and tolerates one query failing', async () => {
  const hospitalPlaces = Array.from({ length: 12 }, (_, index) => ({
    title: `Hospital ${index}`,
    address: `${index} Main Road`,
    placeId: `p${index}`,
  }));
  const fetchImpl = mockFetch((_url, init) => {
    const body = requestBody(init);
    if (body.q === 'emergency hospital in Lagos') return responseJson({ places: hospitalPlaces });
    return responseJson({ error: 'provider down' }, { status: 503 });
  });
  const search = createWebSearch(baseConfig({ healthSourceDomains: [] }), { fetchImpl });
  const leads = await search.discoverEmergency({ area: 'Lagos' });
  assert.equal(leads.length, 8);
  assert.equal(leads[0].name, 'Hospital 0');
  assert.equal(leads[7].name, 'Hospital 7');
});

test('discoverEmergency fails closed on bad input and provider errors', async () => {
  const fetchImpl = mockFetch(() => responseJson({ places: [] }));
  const search = createWebSearch(baseConfig({ healthSourceDomains: [] }), { fetchImpl });
  assert.deepEqual(await search.discoverEmergency({ area: '' }), []);
  assert.deepEqual(await search.discoverEmergency({ area: '123456' }), []);
  assert.equal(fetchImpl.calls.length, 0);

  const failing = createWebSearch(baseConfig({ healthSourceDomains: [] }), {
    fetchImpl: mockFetch(() => responseJson({}, { status: 401 })),
  });
  assert.deepEqual(await failing.discoverEmergency({ area: 'Ikeja' }), []);
});
