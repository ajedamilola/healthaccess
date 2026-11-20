import test from 'node:test';
import assert from 'node:assert/strict';
import { createUssdEngine } from '../src/channels/ussd.js';
import type {
  UssdCrypto,
  UssdEngine,
  UssdRepository,
  UssdResult,
  UssdSearch,
  UssdSession,
} from '../src/channels/ussd.js';
import type { Area, Facility, Projection, Service, WebLead } from '../src/types.js';

const services: Service[] = [
  { service_code: 'general', label: 'General care' },
  { service_code: 'pediatrics', label: 'Child health' },
  { service_code: 'maternity', label: 'Maternity care' },
];

const areas: Area[] = [{ id: 'ikeja', name: 'Ikeja', region: 'Lagos' }];

function facility(
  id: string,
  name = 'Demo Hospital',
  phone: string | null = '+2348000000000',
): Facility {
  return { id, name, address: `${id} Example Road, Ikeja`, phone, distance_km: 2.4 };
}

function lead(id: string): WebLead {
  return {
    name: id === 'lead1' ? 'Live Care Clinic' : `Live Lead ${id}`,
    address: `${id} Broad Street, Lagos`,
    phone: '+2349091481560',
    latitude: null,
    longitude: null,
    source_url: `https://maps.google.com/?cid=${id}`,
    source_reference: id,
    verification_status: 'unverified',
    service_label: 'Emergency hospital',
  };
}

function projection(fields: Projection['fields']): Projection {
  return { available: true, fields };
}

function session(overrides: Partial<UssdSession> = {}): UssdSession {
  return {
    id: 'session1',
    providerSessionId: 'provider1',
    phoneDigest: 'phone-digest',
    serviceCode: '*123#',
    state: 'MAIN',
    context: {},
    expiresAt: new Date(Date.now() + 60_000),
    readSessionId: null,
    ...overrides,
  };
}

function config(profileUseEnabled = false) {
  return {
    ussdMaxChars: 182,
    ussdMaxInvalidAttempts: 3,
    searchRadiusKm: 25,
    searchMaxRadiusKm: 100,
    profileUseEnabled,
    allowLiveWeb: true,
  };
}

function setup(
  overrides: Partial<UssdRepository> = {},
  profileUseEnabled = false,
  cryptoOverrides: Partial<UssdCrypto> = {},
  search?: UssdSearch,
) {
  const calls: string[] = [];
  const repository: UssdRepository = {
    listServices: async () => services,
    findAreas: async () => areas,
    findFacilities: async () => [facility('f1'), facility('f2')],
    getFacility: async (id) => facility(id),
    readEmergency: async () =>
      projection([{ key: 'allergies', label: 'Allergies', value: 'Penicillin' }]),
    openGrant: async () => ({
      ...projection([{ key: 'current_medications', label: 'Medications', value: 'Amlodipine' }]),
      read_session_id: 'read1',
    }),
    readGrant: async () =>
      projection([{ key: 'current_medications', label: 'Medications', value: 'Amlodipine' }]),
    closeReadSession: async (id) => {
      calls.push(`close:${id}`);
    },
    findProfileConsent: async () => null,
    readMatchingContext: async () => ({ available: false }),
    queueFacilitySms: async (id) => {
      calls.push(`sms:${id}`);
      return true;
    },
    storeWebLeads: async () => ['lead1'],
    getWebLead: async (id) => lead(id),
    recordEmergencyRequest: async (request) => {
      calls.push(`emergency:${request.channel}:${request.location_text}:${request.results.length}`);
    },
    ...overrides,
  };
  const engine = createUssdEngine({
    repository,
    config: config(profileUseEnabled),
    crypto: {
      digestCode: (value, kind) => (value === 'bad' ? null : `${kind}-digest`),
      fingerprint: (value) => `view-${value.length}`,
      ...cryptoOverrides,
    },
    search,
  });
  return { engine, repository, calls };
}

function apply(current: UssdSession, result: UssdResult): UssdSession {
  return {
    ...current,
    state: result.state,
    context: result.context,
    readSessionId: result.readSessionId,
  };
}

async function send(engine: UssdEngine, current: UssdSession, token: string | null) {
  const result = await engine.transition(current, token);
  return { result, session: apply(current, result) };
}

function assertResponse(result: UssdResult) {
  assert.match(result.response, /^(CON|END) /);
  assert.ok(result.response.length <= 182, `response too long: ${result.response.length}`);
  assert.match(result.response, /^[\x20-\x7e\n]+$/);
}

async function walk(engine: UssdEngine, tokens: string[]) {
  const initial = await engine.transition(session(), null);
  let current = apply(session(), initial);
  let result = initial;
  for (const token of tokens) {
    const step = await send(engine, current, token);
    result = step.result;
    current = step.session;
    assertResponse(result);
  }
  return { result, session: current };
}

test('root menu and care flow reach a facility; SMS request is terminal and replay is idempotent', async () => {
  const { engine, calls } = setup();
  const initial = await engine.transition(session(), null);
  assert.equal(initial.state, 'MAIN');
  assert.match(initial.response, /^CON HealthAccess/);
  assertResponse(initial);

  const care = await walk(engine, ['1', '2', 'Ikeja']);
  assert.equal(care.result.state, 'CARE_RESULTS');
  assert.match(care.result.response, /Demo Hospital/);
  assert.equal(care.result.sensitive, false);

  const next = await send(engine, care.session, '1');
  assert.equal(next.result.state, 'CARE_RESULTS');
  assert.match(next.result.response, /f2 Example Road/);
  assertResponse(next.result);

  const sms = await send(engine, next.session, '2');
  assert.equal(sms.result.state, 'END');
  assert.equal(sms.result.terminal, true);
  assert.match(sms.result.response, /^END SMS requested\./);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('sms:')),
    ['sms:f2'],
  );

  const replay = await engine.replay(sms.session);
  assert.equal(replay.state, 'END');
  assert.match(replay.response, /SMS requested/);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('sms:')),
    ['sms:f2'],
  );
});

test('clinical values preserve Unicode names and medicine units without transliteration', async () => {
  const { engine } = setup({
    readEmergency: async () =>
      projection([
        { key: 'current_medications', label: 'Medications', value: ['Example 50 \u00b5g'] },
        { key: 'full_name', label: 'Name', value: 'Ad\u00e9' },
      ]),
  });
  const request = await engine.transition(session(), '2');
  const result = await engine.transition(apply(session(), request), '123456789012');
  assert.match(result.response, /50 \u00b5g/);
  assert.match(result.response, /Ad\u00e9/);
  assert.ok(result.response.length <= 182);
});

test('invalid input is bounded and back/exit return to the parent state', async () => {
  const { engine } = setup();
  let current = session();

  let step = await send(engine, current, '9');
  assert.equal(step.result.state, 'MAIN');
  assert.equal(step.result.context.meta?.invalidAttempts, 1);
  assert.match(step.result.response, /Invalid choice/);
  current = step.session;

  step = await send(engine, current, '1');
  assert.equal(step.result.state, 'CARE_SERVICE');
  current = step.session;

  step = await send(engine, current, '9');
  assert.equal(step.result.context.meta?.invalidAttempts, 1);
  current = step.session;

  step = await send(engine, current, '0');
  assert.equal(step.result.state, 'MAIN');
  current = step.session;

  step = await send(engine, current, '0');
  assert.equal(step.result.state, 'END');
  assert.match(step.result.response, /Thank you/);

  let repeat = session();
  for (let count = 1; count <= 3; count += 1) {
    const attempt = await send(engine, repeat, '9');
    repeat = attempt.session;
    if (count < 3) assert.equal(attempt.result.state, 'MAIN');
    else {
      assert.equal(attempt.result.state, 'END');
      assert.match(attempt.result.response, /Too many invalid attempts/);
    }
  }
});

test('record view digest comes from the injected keyed fingerprint', async () => {
  let input = '';
  const { engine } = setup(
    {
      readEmergency: async () =>
        projection([{ key: 'allergies', label: 'Allergies', value: 'Penicillin' }]),
    },
    false,
    {
      fingerprint: (value) => {
        input = value;
        return 'fp-view';
      },
    },
  );
  const summary = await walk(engine, ['2', '123456789012']);
  assert.match(input, /^record-view:/);
  assert.equal(summary.result.context.viewDigest, 'fp-view');
  assert.equal(JSON.stringify(summary.result.context).includes('Penicillin'), false);
});

test('replaying an invalid prompt does not reset the attempt budget', async () => {
  const { engine } = setup();
  const first = await send(engine, session(), '9');
  assert.equal(first.result.context.meta?.invalidAttempts, 1);
  const replay = await engine.replay(first.session);
  assert.equal(replay.context.meta?.invalidAttempts, 1);
  const second = await send(engine, first.session, '9');
  assert.equal(second.result.context.meta?.invalidAttempts, 2);
});

test('ambiguous areas are bounded and require one offered choice', async () => {
  const six: Area[] = Array.from({ length: 6 }, (_, index) => ({
    id: `a${index}`,
    name: `Area ${index}`,
  }));
  const { engine } = setup({ findAreas: async () => six });
  const reached = await walk(engine, ['1', '1', 'Lagos']);
  assert.equal(reached.result.state, 'CARE_AREA_CHOICE');
  assert.ok((reached.result.context.choices?.length ?? 0) <= 4);
  assert.equal(reached.result.context.truncated, true);
  assert.match(reached.result.response, /More matches exist/);

  const invalid = await send(engine, reached.session, '9');
  assert.equal(invalid.result.state, 'CARE_AREA_CHOICE');
  assert.match(invalid.result.response, /Invalid choice/);

  const choice = await send(engine, invalid.session, '1');
  assert.equal(choice.result.state, 'CARE_RESULTS');
});

test('no match widens the radius and never invents a facility', async () => {
  const radii: number[] = [];
  let calls = 0;
  const { engine } = setup({
    findFacilities: async (_service, _area, radius) => {
      radii.push(radius);
      calls += 1;
      return calls === 1 ? [] : [facility('wide')];
    },
  });
  const none = await walk(engine, ['1', '1', 'Ikeja']);
  assert.equal(none.result.state, 'CARE_NO_MATCH');
  assert.match(none.result.response, /No suitable hospital/);

  const wider = await send(engine, none.session, '1');
  assert.equal(wider.result.state, 'CARE_RESULTS');
  assert.match(wider.result.response, /wide Example Road/);
  assert.deepEqual(radii, [25, 50]);
});

test('emergency summary uses a digest only and reauthorizes on replay', async () => {
  let revoked = false;
  const digests: string[] = [];
  const { engine } = setup({
    readEmergency: async (digest) => {
      digests.push(digest);
      return revoked
        ? { available: false }
        : projection([{ key: 'allergies', label: 'Allergies', value: 'Penicillin' }]);
    },
  });
  const summary = await walk(engine, ['2', '123456789012']);
  assert.equal(summary.result.state, 'END');
  assert.equal(summary.result.sensitive, true);
  assert.match(summary.result.response, /Allergies: Penicillin/);
  assert.deepEqual(digests, ['patient-digest']);
  assert.equal(JSON.stringify(summary.result.context).includes('123456789012'), false);
  assert.equal(JSON.stringify(summary.result.context).includes('Penicillin'), false);

  revoked = true;
  const replay = await engine.replay(summary.session);
  assert.equal(replay.state, 'END');
  assert.match(replay.response, /That code did not work/);
  assert.equal(JSON.stringify(replay.context).includes('Penicillin'), false);
});

test('one temporary code opens shared details, rechecks every page and closes on exit', async () => {
  const opened: string[] = [];
  let reads = 0;
  const medications = Array.from(
    { length: 30 },
    (_, index) => `medication item ${index} for daily use`,
  );
  const { engine, calls } = setup({
    openGrant: async (patient, grant) => {
      opened.push(`${patient}:${grant}`);
      return {
        ...projection([{ key: 'current_medications', label: 'Medications', value: medications }]),
        read_session_id: 'read1',
      };
    },
    readGrant: async () => {
      reads += 1;
      return projection([{ key: 'current_medications', label: 'Medications', value: medications }]);
    },
  });

  const reached = await walk(engine, ['2', '1234 5678']);
  assert.deepEqual(opened, ['null:grant-digest']);
  assert.equal(reached.result.sensitive, true);
  assert.equal(reached.result.readSessionId, 'read1');
  assert.equal(reached.result.state, 'RECORD_PAGE');
  assert.equal(JSON.stringify(reached.result.context).includes('123456789012'), false);
  assert.equal(JSON.stringify(reached.result.context).includes('12345678'), false);
  assert.equal(JSON.stringify(reached.result.context).includes('medication item 0'), false);

  const pageNo = reached.result.context.pageNo;
  const replay = await engine.replay(reached.session);
  assert.equal(replay.state, 'RECORD_PAGE');
  assert.equal(replay.context.pageNo, pageNo);
  assert.ok(reads >= 2);
  assert.equal(JSON.stringify(replay.context).includes('medication item 0'), false);

  const closed = await send(engine, reached.session, '0');
  assert.equal(closed.result.state, 'END');
  assert.equal(closed.result.readSessionId, null);
  assert.match(closed.result.response, /Closed/);
  assert.ok(calls.includes('close:read1'));
});

test('long scalar and array fields paginate without omission', async () => {
  const scalarWords = Array.from(
    { length: 50 },
    (_, index) => `word${String(index).padStart(2, '0')}`,
  );
  const scalarEngine = setup({
    readEmergency: async () =>
      projection([{ key: 'allergies', label: 'Allergies', value: scalarWords.join(' ') }]),
  }).engine;
  const scalar = await walk(scalarEngine, ['2', '123456789012']);
  let current = scalar.session;
  const scalarPages = [scalar.result.response];
  for (let page = 0; page < 20 && current.state !== 'END'; page += 1) {
    const next = await send(scalarEngine, current, '1');
    scalarPages.push(next.result.response);
    current = next.session;
  }
  const scalarText = scalarPages.join('\n');
  for (const word of scalarWords) assert.match(scalarText, new RegExp(word));
  assert.ok(scalarPages.length > 1);
  assert.equal(JSON.stringify(scalar.result.context).includes('word00'), false);

  const items = Array.from(
    { length: 30 },
    (_, index) => `medicine-${index} take with food and water`,
  );
  const arrayEngine = setup({
    openGrant: async () => ({
      ...projection([{ key: 'current_medications', label: 'Medications', value: items }]),
      read_session_id: 'read1',
    }),
    readGrant: async () =>
      projection([{ key: 'current_medications', label: 'Medications', value: items }]),
  }).engine;
  const array = await walk(arrayEngine, ['2', '12345678']);
  current = array.session;
  const arrayPages = [array.result.response];
  for (let page = 0; page < 20 && current.state !== 'END'; page += 1) {
    const next = await send(arrayEngine, current, '1');
    arrayPages.push(next.result.response);
    current = next.session;
  }
  const arrayText = arrayPages.join('\n');
  for (const item of items)
    assert.match(arrayText, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(arrayPages.length > 1);
  assert.equal(JSON.stringify(array.result.context).includes('medicine-0'), false);
});

test('queue failure keeps results retryable and disabled personalization never checks consent', async () => {
  let consentCalls = 0;
  const { engine, calls } = setup({
    queueFacilitySms: async () => false,
    findProfileConsent: async () => {
      consentCalls += 1;
      return { id: 'consent1' };
    },
  });
  const reached = await walk(engine, ['1', '1', 'Ikeja']);
  const failed = await send(engine, reached.session, '2');
  assert.equal(failed.result.state, 'CARE_RESULTS');
  assert.match(failed.result.response, /SMS could not be requested/);
  assert.match(failed.result.response, /2\. Try again/);
  assert.equal(calls.filter((call) => call.startsWith('sms:')).length, 0);
  assert.equal(consentCalls, 0);
});

test('enabled personalization asks for confirmation without exposing fields', async () => {
  let consentCalls = 0;
  let contextCalls = 0;
  const { engine } = setup(
    {
      findProfileConsent: async () => {
        consentCalls += 1;
        return { id: 'consent1' };
      },
      readMatchingContext: async () => {
        contextCalls += 1;
        return { available: true };
      },
    },
    true,
  );

  const prompt = await walk(engine, ['1', '1', 'Ikeja']);
  assert.equal(prompt.result.state, 'CARE_PROFILE_CONFIRM');
  assert.match(prompt.result.response, /Use your saved profile/);
  assert.doesNotMatch(prompt.result.response, /allerg|medication/i);

  const yes = await send(engine, prompt.session, '1');
  assert.equal(yes.result.state, 'CARE_RESULTS');
  assert.equal(consentCalls, 1);
  assert.equal(contextCalls, 1);
  assert.equal(JSON.stringify(yes.result.context).includes('medication'), false);
});

test('expired session closes any read reference and ends', async () => {
  const { engine, calls } = setup();
  const result = await engine.transition(
    session({
      readSessionId: 'read1',
      expiresAt: new Date(Date.now() - 1_000),
    }),
    '0',
  );
  assert.equal(result.state, 'END');
  assert.match(result.response, /Session expired/);
  assert.equal(result.readSessionId, null);
  assert.ok(calls.includes('close:read1'));
});

test('replay of a terminal protected page reauthorizes and does not reuse cached values', async () => {
  let reads = 0;
  let revoked = false;
  const { engine, calls } = setup({
    openGrant: async () => ({
      ...projection([{ key: 'allergies', label: 'Allergies', value: 'Penicillin' }]),
      read_session_id: 'read1',
    }),
    readGrant: async () => {
      reads += 1;
      return revoked
        ? { available: false }
        : projection([{ key: 'allergies', label: 'Allergies', value: 'Penicillin' }]);
    },
  });

  const reached = await walk(engine, ['2', '12345678']);
  assert.equal(reached.result.state, 'END');
  assert.equal(reached.result.sensitive, true);
  const firstReads = reads;

  const replay = await engine.replay(reached.session);
  assert.equal(replay.state, 'END');
  assert.match(replay.response, /Allergies: Penicillin/);
  assert.ok(reads > firstReads);

  revoked = true;
  const denied = await engine.replay(reached.session);
  assert.equal(denied.state, 'END');
  assert.match(denied.response, /That code did not work/);
  assert.equal(denied.sensitive, false);
  assert.ok(calls.includes('close:read1'));
});

test('main menu offers emergency help, pages live leads, records USSD request and never fabricates', async () => {
  const leads = [lead('lead1'), lead('lead2')];
  const areasQueried: string[] = [];
  const descriptions: string[] = [];
  const { engine, calls } = setup(
    {
      storeWebLeads: async () => ['lead1', 'lead2'],
      getWebLead: async (id) => leads.find((item) => item.source_reference === id) ?? null,
    },
    false,
    {},
    {
      discoverFacilities: async () => [],
      discoverEmergency: async ({ area, description }) => {
        areasQueried.push(area);
        descriptions.push(description ?? '');
        return leads;
      },
    },
  );

  const initial = await engine.transition(session(), null);
  assert.match(initial.response, /4\. Emergency help/);
  const locationPrompt = await send(engine, apply(session(), initial), '4');
  assert.equal(locationPrompt.result.state, 'CARE_LOCATION');
  assert.equal(locationPrompt.result.context.kind, 'emergency_area');
  assert.match(locationPrompt.result.response, /Call 112 now if life-threatening/);
  assert.match(locationPrompt.result.response, /Enter your area or landmark/);
  assertResponse(locationPrompt.result);

  const first = await send(engine, locationPrompt.session, 'Ikeja');
  assert.equal(first.result.state, 'CARE_RESULTS');
  assert.equal(first.result.context.kind, 'emergency_results');
  assert.match(first.result.response, /Call 112 now if life-threatening/);
  assert.match(first.result.response, /Unverified live lead 1\/2/);
  assert.match(first.result.response, /Live Care Clinic/);
  assert.match(first.result.response, /lead1 Broad Street, Lagos/);
  assert.match(first.result.response, /\+2349091481560/);
  assert.match(first.result.response, /1\. Next/);
  assert.match(first.result.response, /0\. Exit/);
  assertResponse(first.result);
  assert.deepEqual(areasQueried, ['Ikeja']);
  assert.deepEqual(descriptions, ['']);
  assert.ok(calls.includes('emergency:USSD:Ikeja:2'));

  const second = await send(engine, first.session, '1');
  assert.equal(second.result.state, 'CARE_RESULTS');
  assert.match(second.result.response, /Unverified live lead 2\/2/);
  assert.match(second.result.response, /Live Lead lead2/);
  assert.match(second.result.response, /1\. Another area/);
  assertResponse(second.result);

  const again = await send(engine, second.session, '1');
  assert.equal(again.result.state, 'CARE_LOCATION');
  assert.equal(again.result.context.kind, 'emergency_area');

});

test('emergency with no live results gives 112 guidance and records an empty request', async () => {
  const { engine, calls } = setup(
    { storeWebLeads: async () => [], getWebLead: async () => null },
    false,
    {},
    { discoverFacilities: async () => [], discoverEmergency: async () => [] },
  );
  const result = await walk(engine, ['4', 'Ikeja']);
  assert.equal(result.result.state, 'END');
  assert.equal(result.result.terminal, true);
  assert.match(result.result.response, /Call 112 now/);
  assert.match(result.result.response, /nearest emergency department/);
  assert.doesNotMatch(result.result.response, /CON /);
  assert.ok(calls.includes('emergency:USSD:Ikeja:0'));
});

test('emergency help asks only for the area, supports back and rejects empty input', async () => {
  const { engine } = setup();
  const initial = await engine.transition(session(), null);
  const prompt = await send(engine, apply(session(), initial), '4');
  const invalid = await send(engine, prompt.session, '');
  assert.equal(invalid.result.state, 'CARE_LOCATION');
  assert.equal(invalid.result.context.kind, 'emergency_area');
  assert.match(invalid.result.response, /Enter your area or landmark/);

  const back = await send(engine, prompt.session, '0');
  assert.equal(back.result.state, 'MAIN');

  const replay = await engine.render(prompt.session);
  assert.equal(replay.state, 'CARE_LOCATION');
  assert.match(replay.response, /Enter your area or landmark/);
});

test('care search falls back to unverified live leads when the directory is empty', async () => {
  const areasQueried: string[] = [];
  const { engine } = setup(
    {
      findFacilities: async () => [],
      storeWebLeads: async () => ['lead1'],
      getWebLead: async () => lead('lead1'),
    },
    false,
    {},
    {
      discoverFacilities: async ({ serviceLabel, area }) => {
        areasQueried.push(`${serviceLabel}:${area}`);
        return [lead('lead1')];
      },
    },
  );
  const result = await walk(engine, ['1', '1', 'Ikeja']);
  assert.equal(result.result.state, 'CARE_RESULTS');
  assert.equal(result.result.context.resultKind, 'web');
  assert.match(result.result.response, /Unverified live lead: Live Care Clinic/);
  assert.match(result.result.response, /1\. Another area/);
  assert.doesNotMatch(result.result.response, /Send details by SMS/);
  assert.deepEqual(areasQueried, ['General care:Ikeja, Lagos']);
});

test('care search uses live leads when no directory area matches', async () => {
  const { engine } = setup(
    {
      findAreas: async () => [],
      findFacilities: async () => [],
      storeWebLeads: async () => ['lead1'],
      getWebLead: async () => lead('lead1'),
    },
    false,
    {},
    { discoverFacilities: async () => [lead('lead1')] },
  );
  const result = await walk(engine, ['1', '1', 'Agege']);
  assert.equal(result.result.state, 'CARE_RESULTS');
  assert.equal(result.result.context.resultKind, 'web');
  assert.match(result.result.response, /Unverified live lead/);
});

test('care location offers the saved home area as option 1', async () => {
  const searched: string[] = [];
  const { engine } = setup({
    findSavedArea: async () => ({ id: 'home', label: 'Ikeja, Lagos' }),
    findFacilities: async (_service, areaId) => {
      searched.push(areaId);
      return [facility('f1')];
    },
  });
  const prompt = await walk(engine, ['1', '2']);
  assert.equal(prompt.result.state, 'CARE_LOCATION');
  assert.match(prompt.result.response, /1\. My area: Ikeja, Lagos\n0\. Back$/);
  const found = await send(engine, prompt.session, '1');
  assertResponse(found.result);
  assert.equal(found.result.state, 'CARE_RESULTS');
  assert.deepEqual(searched, ['home']);
});

test('care location without a saved area keeps the plain prompt', async () => {
  const { engine } = setup();
  const prompt = await walk(engine, ['1', '2']);
  assert.equal(prompt.result.response, 'CON Enter area or landmark\n0. Back');
});

test('emergency help can use the saved area for live search', async () => {
  const areasSearched: string[] = [];
  const { engine } = setup(
    { findSavedArea: async () => ({ id: 'home', label: 'Ikeja, Lagos' }) },
    false,
    {},
    {
      discoverFacilities: async () => [],
      discoverEmergency: async ({ area }) => {
        areasSearched.push(area);
        return [lead('lead1')];
      },
    },
  );
  const prompt = await walk(engine, ['4']);
  assert.match(prompt.result.response, /1\. My area: Ikeja, Lagos/);
  const found = await send(engine, prompt.session, '1');
  assertResponse(found.result);
  assert.deepEqual(areasSearched, ['Ikeja, Lagos']);
});

test('my access code shows the emergency code to a linked phone and issues a 1-hour code', async () => {
  let created = 0;
  const { engine } = setup({
    readOwnCodes: async () => ({ linked: true, patientCode: '123456789012' }),
    createQuickGrant: async () => {
      created += 1;
      return { status: 'created', code: '87654321', expiresAt: new Date(Date.now() + 3600_000) };
    },
  });
  const menu = await walk(engine, ['3']);
  assert.equal(menu.result.state, 'MY_CODE');
  assert.equal(menu.result.sensitive, true);
  assert.match(menu.result.response, /1234 5678 9012/);
  assert.equal(JSON.stringify(menu.result.context).includes('123456789012'), false);

  const code = await send(engine, menu.session, '1');
  assertResponse(code.result);
  assert.equal(code.result.state, 'END');
  assert.equal(code.result.sensitive, true);
  assert.match(code.result.response, /8765 4321/);
  assert.equal(JSON.stringify(code.result.context).includes('87654321'), false);
  assert.equal(created, 1);
});

test('my access code explains how to link an unlinked phone', async () => {
  const { engine } = setup({ readOwnCodes: async () => ({ linked: false }) });
  const result = await walk(engine, ['3']);
  assert.equal(result.result.state, 'END');
  assert.match(result.result.response, /not linked/);
});

test('invalid service choice repeats readable labels, not internal codes', async () => {
  const { engine } = setup();
  const result = await walk(engine, ['1', '9']);
  assert.match(result.result.response, /1\. General care/);
  assert.doesNotMatch(result.result.response, /1\. general\b/);
});

test('USSD menus in every language are plain ASCII and fit the screen', async () => {
  const { u, USSD_LANGUAGE_ORDER } = await import('../src/channels/i18n.js');
  for (const locale of USSD_LANGUAGE_ORDER) {
    for (const key of ['main', 'location', 'emergencyLocation', 'code', 'back', 'myArea', 'invalid', 'language', 'chooseService']) {
      const text = `CON ${u(locale, key)}`;
      assert.ok(text.length <= 182, `${locale}.${key} is ${text.length} chars`);
      assert.match(text, /^[\x20-\x7e\n]+$/, `${locale}.${key} must be ASCII`);
    }
  }
});

test('USSD language option switches menus and remembers the choice', async () => {
  const saved: string[] = [];
  const { engine } = setup({ setLocale: async (locale) => void saved.push(locale) });
  const menu = await walk(engine, ['5']);
  assert.match(menu.result.response, /3\. Yoruba/);
  const chosen = await send(engine, menu.session, '3');
  assertResponse(chosen.result);
  assert.match(chosen.result.response, /Wa ile iwosan nitosi/);
  assert.deepEqual(saved, ['yo']);
  const location = await send(engine, chosen.session, '1');
  assert.match(location.result.response, /Yan itoju/);
});

test('USSD opens in the phone or profile language', async () => {
  const { engine } = setup({ getLocale: async () => 'ha' });
  const start = await engine.transition(session(), null);
  assert.match(start.response, /Nemi asibiti kusa/);
  assert.equal(start.context.locale, 'ha');
});
