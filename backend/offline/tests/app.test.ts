import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import type { CallbackRepository, InboundSms, UssdEvent } from '../src/app.js';
import { createIpMatcher } from '../src/security/origin.js';
import { parseUssdPath } from '../src/channels/ussd-handler.js';

async function serve(
  t: TestContext,
  overrides: Partial<CallbackRepository> = {},
  configOverrides: Partial<Parameters<typeof createApp>[0]['config']> = {},
) {
  const calls: InboundSms[] = [];
  const events: UssdEvent[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const config = {
    allowedCidrs: [],
    callbackAuthMode: 'development_open' as const,
    callbackPathKey: 'test-path',
    callbackRatePerMinute: 120,
    callbackPhoneRatePerMinute: 60,
    callbackBodyLimitBytes: 8192,
    atSmsInboundNumbers: ['1234'],
    atUssdServiceCode: '*test#',
    httpLogBodies: 'full' as const,
    ...configOverrides,
  };
  const app = createApp({
    config,
    crypto: { fingerprint: (v) => v },
    ussdHandler: async () => 'CON HealthAccess',
    repository: {
      ready: async () => {},
      takeRateLimit: async () => true,
      acceptSms: async (body) => {
        calls.push(body);
      },
      acceptDelivery: async () => {},
      endUssdSession: async (event) => {
        events.push(event);
      },
      ...overrides,
    },
    logger: {
      error() {},
      info(entry: unknown) {
        if (typeof entry === 'string') {
          logs.push(JSON.parse(entry) as Record<string, unknown>);
        } else if (entry && typeof entry === 'object') {
          logs.push(entry as Record<string, unknown>);
        }
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${url}/callbacks/africastalking/test-path${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Callback-Token': 'local-test-token',
        ...headers,
      },
      body: new URLSearchParams(body),
    });
  return { post, url, calls, events, logs };
}

test('development callbacks accept provider posts and reject malformed form fields', async (t) => {
  const { post, calls } = await serve(t);
  const body = { id: 'AT1', from: '+2348000000000', to: '1234', text: 'HELP' };
  assert.equal((await post('/sms/inbound', body, { 'X-Callback-Token': '' })).status, 200);
  assert.equal(
    (await post('/sms/inbound', { ...body, id: 'AT2' }, { 'X-Forwarded-For': '8.8.8.8' })).status,
    200,
  );
  assert.equal((await post('/sms/inbound', { ...body, id: 'AT3', to: '+1234' })).status, 200);
  assert.equal(calls.length, 3);
  assert.equal((await post('/sms/inbound', { ...body, to: 'not-ours' })).status, 403);
  const malformed = await post('/sms/inbound', { ...body, from: 'not-a-phone' });
  assert.equal(malformed.status, 400);
  assert.equal(await malformed.text(), 'Invalid callback');
});

test('temporary root handler accepts AT USSD session events', async (t) => {
  const { url, events } = await serve(t);
  const response = await fetch(`${url}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      sessionId: 'AT-EVENT-1',
      phoneNumber: '+2348000000000',
      serviceCode: '*test#',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'OK');
  assert.deepEqual(events, [
    { sessionId: 'AT-EVENT-1', phoneNumber: '+2348000000000', serviceCode: '*test#' },
  ]);
});

test('SMS durable acceptance failure is not acknowledged; USSD safely terminates', async (t) => {
  const { post, url } = await serve(t, {
    acceptSms: async () => {
      throw new Error('secret');
    },
  });
  assert.equal(
    (await post('/sms/inbound', { id: 'AT1', from: '+2348000000000', to: '1234', text: 'HELP' }))
      .status,
    503,
  );
  const ussd = await post('/ussd', {
    sessionId: 's1',
    phoneNumber: '+2348000000000',
    serviceCode: '*test#',
    text: '',
  });
  assert.equal(await ussd.text(), 'CON HealthAccess');
  assert.match(ussd.headers.get('content-type') || '', /text\/plain/);
  assert.equal((await fetch(`${url}/health/live`)).status, 200);
});

test('logs every HTTP request with method, safe URL and configured body mode', async (t) => {
  const full = await serve(t);
  await full.post('/sms/inbound', {
    id: 'AT-LOG-1',
    from: '+2348000000000',
    to: '1234',
    text: 'HELP',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const fullEntry = full.logs.find((entry) => entry.event === 'http_request');
  assert.ok(fullEntry);
  assert.equal(fullEntry.method, 'POST');
  assert.match(
    String(fullEntry.url),
    /^\/callbacks\/africastalking\/\[token\]\/sms\/inbound$/,
  );
  assert.equal(String(fullEntry.url).includes('test-path'), false);
  assert.equal(fullEntry.status, 200);
  const fullBody = fullEntry.body as Record<string, string>;
  assert.equal(fullBody.from, '+2348000000000');
  assert.equal(fullBody.text, 'HELP');

  const redacted = await serve(t, {}, { httpLogBodies: 'redacted' });
  await redacted.post('/sms/inbound', {
    id: 'AT-LOG-2',
    from: '+2348000000000',
    to: '1234',
    text: 'I have a fever',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const entry = redacted.logs.find((item) => item.event === 'http_request');
  assert.ok(entry);
  const body = entry.body as Record<string, string>;
  assert.equal(body.from, '***0000');
  assert.equal(body.to, '***1234');
  assert.equal(body.text, '[redacted 14 chars]');

  const off = await serve(t, {}, { httpLogBodies: 'off' });
  await off.post('/sms/inbound', {
    id: 'AT-LOG-3',
    from: '+2348000000000',
    to: '1234',
    text: 'HELP',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const offEntry = off.logs.find((item) => item.event === 'http_request');
  assert.ok(offEntry);
  assert.equal('body' in offEntry, false);
});

test('CIDR matching handles IPv4-mapped addresses and strict ranges', () => {
  const match = createIpMatcher(['10.2.0.0/16', '2001:db8::/32']);
  assert.equal(match('::ffff:10.2.1.2'), true);
  assert.equal(match('10.3.1.2'), false);
  assert.equal(match('2001:db8::1'), true);
  assert.equal(match('garbage'), false);
  assert.throws(() => createIpMatcher(['0.0.0.0/0']), /unrestricted/);
  assert.throws(() => createIpMatcher(['::/0']), /unrestricted/);
});

test('production IP controls use the socket address and ignore spoofed headers', async (t) => {
  const body = { id: 'AT1', from: '+2348000000000', to: '1234', text: 'HELP' };
  const remoteOnly = await serve(
    t,
    {},
    { callbackAuthMode: 'ip_allowlist', allowedCidrs: ['203.0.113.42'] },
  );
  assert.equal(
    (await remoteOnly.post('/sms/inbound', body, { 'X-Forwarded-For': '203.0.113.42' })).status,
    403,
  );
  const loopback = await serve(
    t,
    {},
    { callbackAuthMode: 'ip_allowlist', allowedCidrs: ['127.0.0.1/32'] },
  );
  assert.equal((await loopback.post('/sms/inbound', body)).status, 200);
});

test('cumulative USSD path parser bounds tokens without retaining raw transcripts', () => {
  assert.deepEqual(parseUssdPath(''), []);
  assert.deepEqual(parseUssdPath('1*2*Ikeja'), ['1', '2', 'Ikeja']);
  assert.throws(() => parseUssdPath('1**3'));
  assert.throws(() => parseUssdPath('1*\n'));
  assert.throws(() => parseUssdPath(Array(52).fill('1').join('*')));
});

test('callbacks are rate limited per sender phone, not only per provider IP', async (t) => {
  const scopes: string[] = [];
  const { post } = await serve(t, {
    takeRateLimit: async (scope: string) => {
      scopes.push(scope);
      return !scope.startsWith('callback-phone:2348011111111');
    },
  });
  const sms = (from: string) => post('/sms/inbound', { id: `m-${from}`, from, to: '1234', text: 'hi' });
  assert.equal((await sms('+2348011111111')).status, 429);
  assert.equal((await sms('+2348022222222')).status, 200);
  assert.ok(scopes.some((scope) => scope.startsWith('callback-ip:')));
  assert.ok(scopes.includes('callback-phone:2348022222222'));
});
