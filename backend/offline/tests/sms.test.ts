import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmsEngine, GREETING, HELP, isPotentiallyUrgent } from '../src/channels/sms.js';
import type { SmsRepository, SmsResult } from '../src/channels/sms.js';
import { smsSegments, renderFacility, renderWebLead } from '../src/channels/render.js';
import type { WebLead } from '../src/types.js';

const services = [
  { service_code: 'general', label: 'General care' },
  { service_code: 'pediatrics', label: 'Child health' },
];
function textOf(result: SmsResult) {
  const reply = result.replies[0];
  return reply.kind === 'text' ? reply.text : '';
}

function lead(id: string, name = 'Live Emergency Hospital'): WebLead {
  return {
    name,
    address: `${id} Marina Road, Lagos`,
    phone: '+2349091481560',
    latitude: null,
    longitude: null,
    source_url: `https://maps.google.com/?cid=${id}`,
    source_reference: id,
    verification_status: 'unverified',
    service_label: 'Emergency hospital',
  };
}

function setup(
  overrides: Partial<SmsRepository> = {},
  search?: {
    discoverFacilities(request: { serviceLabel: string; area: string }): Promise<WebLead[]>;
    discoverEmergency?(request: { area: string }): Promise<WebLead[]>;
  },
) {
  const calls: string[] = [];
  const repository: SmsRepository = {
    listServices: async () => services,
    setOptOut: async () => {},
    findAreas: async () => [{ id: 'area1', name: 'Ikeja' }],
    findFacilities: async () => [
      { id: 'facility1', name: 'Example', address: 'Test', phone: null, distance_km: null },
    ],
    readEmergency: async () => ({
      available: true,
      fields: [{ key: 'allergies', label: 'Allergies', value: ['Test'] }],
    }),
    findProfileConsent: async () => null,
    readMatchingContext: async () => ({ available: false }),
    storeWebLeads: async () => ['lead1'],
    ...overrides,
  };
  return {
    calls,
    engine: createSmsEngine({
      repository,
      config: { searchRadiusKm: 25, allowLiveWeb: true, profileUseEnabled: false },
      crypto: { digestCode: () => 'digest' },
      assistant: {
        classify: async () => {
          calls.push('AI');
          return {
            intent: 'unsupported',
            service_code: null,
            location_query: null,
            question: null,
          };
        },
        answer: async () => ({ text: 'Safe fallback.' }),
      },
      search,
    }),
  };
}

test('deterministic FIND works without AI and prompts for missing area', async () => {
  const { engine, calls } = setup();
  const first = await engine.process('FIND child health');
  assert.equal(first.state, 'awaiting_area');
  const next = await engine.process('Ikeja', first);
  assert.equal(next.state, 'showing_results');
  assert.equal(next.replies[0].kind, 'facility');
  assert.equal(next.replies[0].kind === 'facility' && next.replies[0].id, 'facility1');
  assert.deepEqual(calls, []);
  assert.equal((await engine.process('FIND child health near Ikeja')).state, 'showing_results');
});

test('LOOKUP queues a digest render reference, never medical snapshots', async () => {
  const { engine, calls } = setup();
  const reply = await engine.process('LOOKUP 123456789012');
  assert.deepEqual(reply.replies, [{ kind: 'emergency', codeDigest: 'digest' }]);
  assert.equal(JSON.stringify(reply).includes('Test'), false);
  assert.deepEqual(calls, []);
  assert.match(textOf(await engine.process('LOOKUP 123')), /12-digit/);
});

test('code-like inputs never reach a model and urgency bypasses clarification', async () => {
  const { engine, calls } = setup();
  await engine.process('Please explain 12345678');
  const urgent = await engine.process('I cannot breathe', {
    state: 'awaiting_area',
    context: { serviceCode: 'general' },
  });
  assert.match(textOf(urgent), /immediate in-person/);
  assert.match(textOf(urgent), /call 112/);
  assert.match(textOf(urgent), /EMERGENCY <area>/);
  assert.deepEqual(calls, []);
  assert.equal(isPotentiallyUrgent('I am suicidal'), true);
  const withPhone = await engine.process('I cannot breathe, call 08030000000');
  assert.match(textOf(withPhone), /immediate in-person/);
  assert.equal(isPotentiallyUrgent('I can\u2019t breathe'), true);
  assert.match(
    textOf(await engine.process('LOOKUP 123456789012 I cannot breathe')),
    /immediate in-person/,
  );
  assert.deepEqual(calls, []);
});

test('MORE needs a live result list; CANCEL clears transient context', async () => {
  const { engine } = setup();
  assert.match(textOf(await engine.process('MORE')), /no active result/);
  const cancelled = await engine.process('CANCEL', {
    state: 'awaiting_area',
    context: { serviceCode: 'general' },
  });
  assert.equal(cancelled.state, 'closed');
  assert.deepEqual(cancelled.context, {});
});

test('ambiguous locations require one offered choice; unlisted facilities are never invented', async () => {
  const { engine } = setup({
    findAreas: async () => [
      { id: 'a', name: 'Ikeja' },
      { id: 'b', name: 'Ikeja' },
    ],
  });
  const ambiguous = await engine.process('FIND general near Ikeja');
  assert.equal(ambiguous.state, 'awaiting_area_choice');
  assert.equal((await engine.process('9', ambiguous)).state, 'awaiting_area_choice');
  assert.equal((await engine.process('1', ambiguous)).state, 'showing_results');
});

test('rendering distinguishes verified directory from unverified leads and encoding budgets', () => {
  assert.match(
    renderFacility({ id: 'f', name: 'Example', address: 'Test', phone: null, distance_km: null }),
    /From the HealthAccess directory/,
  );
  assert.match(
    renderWebLead({
      name: 'Example',
      address: 'Test',
      phone: null,
      source_url: 'https://example.org',
    }),
    /Found online, not checked by us/,
  );
  assert.deepEqual(smsSegments('a'.repeat(160)), { encoding: 'GSM-7', segments: 1 });
  assert.equal(smsSegments('a'.repeat(161)).segments, 2);
  assert.equal(smsSegments('^'.repeat(81)).segments, 2);
  assert.deepEqual(smsSegments('\u4e2d'.repeat(71)), { encoding: 'UCS-2', segments: 2 });
});

test('EMERGENCY prompts for an area, returns live leads, records the request and pages with MORE', async () => {
  const emergencyRequests: Array<{ area: string; count: number }> = [];
  const searched: string[] = [];
  const { engine } = setup(
    {
      storeWebLeads: async () => ['lead1', 'lead2'],
      recordEmergencyRequest: async (request) => {
        emergencyRequests.push({
          area: request.location_text,
          count: request.results.length,
        });
        assert.equal(request.channel, 'SMS');
        assert.equal(request.area_id, null);
      },
    },
    {
      discoverFacilities: async () => [],
      discoverEmergency: async ({ area }) => {
        searched.push(area);
        return [lead('lead1'), lead('lead2', 'Ambulance Response Unit')];
      },
    },
  );

  const prompt = await engine.process('EMERGENCY');
  assert.equal(prompt.state, 'awaiting_emergency_area');
  assert.match(textOf(prompt), /Which area/);
  assert.match(textOf(prompt), /Call 112 now/);

  const first = await engine.process('Ikeja', prompt);
  assert.equal(first.state, 'showing_emergency');
  assert.deepEqual(first.replies, [
    {
      kind: 'web_lead',
      id: 'lead1',
      serviceCode: undefined,
      areaId: null,
      index: 0,
      total: 2,
      emergency: true,
      locale: 'en',
    },
  ]);
  assert.deepEqual(searched, ['Ikeja']);
  assert.deepEqual(emergencyRequests, [{ area: 'Ikeja', count: 2 }]);

  const second = await engine.process('MORE', first);
  assert.equal(second.state, 'showing_emergency');
  assert.equal(second.context.resultIndex, 1);
  assert.equal(second.replies[0].kind, 'web_lead');
  assert.equal(second.replies[0].kind === 'web_lead' && second.replies[0].id, 'lead2');

  const exhausted = await engine.process('MORE', second);
  assert.equal(exhausted.state, 'idle');
  assert.match(textOf(exhausted), /last emergency option I found/);
  assert.match(textOf(exhausted), /Call 112 now/);
});

test('EMERGENCY <area> and EMERGENCY near <area> search directly; blank area prompts', async () => {
  const searched: string[] = [];
  const { engine } = setup(
    {
      storeWebLeads: async () => ['lead1'],
      recordEmergencyRequest: async () => {},
    },
    {
      discoverFacilities: async () => [],
      discoverEmergency: async ({ area }) => {
        searched.push(area);
        return [lead('lead1')];
      },
    },
  );
  assert.equal((await engine.process('EMERGENCY Ikeja')).state, 'showing_emergency');
  assert.equal((await engine.process('EMERGENCY near Agege')).state, 'showing_emergency');
  assert.deepEqual(searched, ['Ikeja', 'Agege']);
  assert.equal((await engine.process('EMERGENCY near')).state, 'awaiting_emergency_area');
});

test('EMERGENCY without live results gives safe 112 guidance and never fabricates a facility', async () => {
  const records: Array<{ count: number; area: string }> = [];
  const { engine } = setup(
    {
      storeWebLeads: async () => [],
      recordEmergencyRequest: async (request) => {
        records.push({ count: request.results.length, area: request.location_text });
      },
    },
    {
      discoverFacilities: async () => [],
      discoverEmergency: async () => [],
    },
  );
  const fallback = await engine.process('EMERGENCY Ikeja');
  assert.equal(fallback.state, 'idle');
  assert.equal(fallback.replies[0].kind, 'text');
  assert.match(textOf(fallback), /Call 112 now/);
  assert.match(textOf(fallback), /nearest emergency department/);
  assert.doesNotMatch(textOf(fallback), /Hospital|Clinic/);
  assert.deepEqual(records, [{ count: 0, area: 'Ikeja' }]);
});

test('care FIND falls back to unverified live leads when the directory is empty', async () => {
  const { engine } = setup(
    {
      findFacilities: async () => [],
      storeWebLeads: async () => ['lead1'],
    },
    {
      discoverFacilities: async ({ serviceLabel, area }) => {
        assert.equal(serviceLabel, 'General care');
        assert.equal(area, 'Ikeja');
        return [lead('lead1', 'Live Care Clinic')];
      },
    },
  );
  const result = await engine.process('FIND general near Ikeja');
  assert.equal(result.state, 'showing_results');
  assert.equal(result.context.resultKind, 'web');
  assert.equal(result.replies[0].kind, 'web_lead');
  assert.equal(result.replies[0].kind === 'web_lead' && result.replies[0].id, 'lead1');
});

test('care web fallback uses the chosen area label, not the area id', async () => {
  const searched: string[] = [];
  const { engine } = setup(
    {
      findAreas: async () => [
        { id: 'area-a', name: 'Ikeja', region: 'Lagos' },
        { id: 'area-b', name: 'Ikeja', region: 'Ogun' },
      ],
      findFacilities: async () => [],
      storeWebLeads: async () => ['lead1'],
    },
    {
      discoverFacilities: async ({ area }) => {
        searched.push(area);
        return [lead('lead1', 'Live Care Clinic')];
      },
    },
  );
  const choice = await engine.process('FIND general near Ikeja');
  assert.equal(choice.state, 'awaiting_area_choice');
  const result = await engine.process('1', choice);
  assert.equal(result.state, 'showing_results');
  assert.equal(result.context.resultKind, 'web');
  assert.deepEqual(searched, ['Ikeja, Lagos']);
});

test('FIND without an area offers the saved home area and YES searches it', async () => {
  const searched: string[] = [];
  const { engine } = setup({
    findSavedArea: async () => ({ id: 'home-area', label: 'Ikeja, Lagos' }),
    findFacilities: async (_service, areaId) => {
      searched.push(areaId);
      return [{ id: 'facility1', name: 'Example', address: 'Test', phone: null, distance_km: null }];
    },
  });
  const offer = await engine.process('FIND child health');
  assert.equal(offer.state, 'awaiting_area');
  assert.match(textOf(offer), /Ikeja, Lagos \(your saved area\)/);
  const found = await engine.process('YES', offer);
  assert.equal(found.state, 'showing_results');
  assert.deepEqual(searched, ['home-area']);
});

test('a different area overrides the saved area suggestion', async () => {
  const { engine } = setup({
    findSavedArea: async () => ({ id: 'home-area', label: 'Ikeja, Lagos' }),
    findAreas: async () => [{ id: 'other-area', name: 'Yaba' }],
  });
  const offer = await engine.process('FIND general');
  const found = await engine.process('Yaba', offer);
  assert.equal(found.state, 'showing_results');
  assert.equal(found.context.areaId, 'other-area');
});

test('EMERGENCY without an area searches the saved area immediately', async () => {
  const areas: string[] = [];
  const { engine } = setup(
    { findSavedArea: async () => ({ id: 'home-area', label: 'Ikeja, Lagos' }) },
    {
      discoverFacilities: async () => [],
      discoverEmergency: async ({ area }) => {
        areas.push(area);
        return [lead('one')];
      },
    },
  );
  const result = await engine.process('EMERGENCY');
  assert.equal(result.state, 'showing_emergency');
  assert.deepEqual(areas, ['Ikeja, Lagos']);
  assert.match(textOf(result), /saved area, Ikeja, Lagos.*112/);
});

test('ASK passes consented personal hints to the assistant and tolerates lookup failure', async () => {
  const seen: unknown[] = [];
  const hints = {
    ageBand: 'adult under 40',
    sex: 'Female',
    pregnancy: 'Pregnant',
    conditions: ['Asthma'],
    allergies: [],
    medications: [],
    language: 'en',
  };
  let fail = false;
  const repository: SmsRepository = {
    listServices: async () => services,
    setOptOut: async () => {},
    findAreas: async () => [],
    findFacilities: async () => [],
    readEmergency: async () => ({ available: false }),
    findProfileConsent: async () => null,
    readMatchingContext: async () => ({ available: false }),
    storeWebLeads: async () => [],
    readPersonalHints: async () => {
      if (fail) throw new Error('db down');
      return hints;
    },
  };
  const engine = createSmsEngine({
    repository,
    config: { searchRadiusKm: 25, allowLiveWeb: false, profileUseEnabled: false },
    crypto: { digestCode: () => 'digest' },
    assistant: {
      classify: async () => ({
        intent: 'unsupported',
        service_code: null,
        location_query: null,
        question: null,
      }),
      answer: async (_question, options) => {
        seen.push(options?.personal ?? null);
        return { text: 'Tailored answer.' };
      },
    },
  });
  assert.equal(textOf(await engine.process('ASK is paracetamol safe for headache')), 'Tailored answer.');
  fail = true;
  assert.equal(textOf(await engine.process('ASK what helps a cough')), 'Tailored answer.');
  assert.deepEqual(seen, [hints, null]);
});

function engineWith(
  overrides: Partial<SmsRepository> = {},
  converse?: (
    message: string,
    options: { history: Array<{ role: string; text: string }>; savedAreaLabel: string | null },
  ) => Promise<{
    intent: string;
    service_code: string | null;
    location_query: string | null;
    question: string | null;
    reply: string | null;
  } | null>,
  answerKind = 'fallback',
  aiAvailable = true,
) {
  const areas: string[] = [];
  const repository: SmsRepository = {
    listServices: async () => services,
    setOptOut: async () => {},
    findAreas: async () => [{ id: 'area1', name: 'Ikeja' }],
    findFacilities: async () => [
      { id: 'facility1', name: 'Example', address: 'Test', phone: null, distance_km: null },
    ],
    readEmergency: async () => ({ available: false }),
    findProfileConsent: async () => null,
    readMatchingContext: async () => ({ available: false }),
    storeWebLeads: async () => ['lead1'],
    ...overrides,
  };
  const engine = createSmsEngine({
    repository,
    config: { searchRadiusKm: 25, allowLiveWeb: true, profileUseEnabled: false },
    crypto: { digestCode: () => 'digest' },
    assistant: {
      classify: async () => ({ intent: 'unsupported', service_code: null, location_query: null, question: null }),
      answer: async () => ({ text: 'Reviewed answer.', kind: answerKind }),
      available: () => aiAvailable,
      ...(converse ? { converse } : {}),
    },
    search: {
      discoverFacilities: async () => [],
      discoverEmergency: async ({ area }) => {
        areas.push(area);
        return [lead('one')];
      },
    },
  });
  return { engine, areas };
}

async function chat(engine: ReturnType<typeof createSmsEngine>, messages: string[]) {
  let conversation: { state: string; context: SmsResult['context'] } = { state: 'idle', context: {} };
  const results: SmsResult[] = [];
  for (const message of messages) {
    const next = await engine.process(message, conversation);
    results.push(next);
    conversation = { state: next.state, context: next.context };
  }
  return results;
}

test('the reported conversation: greeting, breathing trouble, area, confusion', async () => {
  const { engine, areas } = engineWith();
  const [hello, breathing, area, confused, emergency] = await chat(engine, [
    'Hello',
    'i am having issues breathing where can i go to help me',
    'Ikeja',
    'i dont understand',
    '2',
  ]);
  assert.equal(textOf(hello), GREETING);
  assert.equal(breathing.state, 'awaiting_emergency_area');
  assert.match(textOf(breathing), /call 112 now/);
  assert.match(textOf(breathing), /Reply with your area/);
  assert.equal(area.state, 'showing_emergency');
  assert.deepEqual(areas, ['Ikeja']);
  assert.equal(textOf(confused), HELP);
  assert.equal(confused.state, 'menu');
  assert.equal(emergency.state, 'awaiting_emergency_area');
  assert.doesNotMatch(textOf(hello), /LOOKUP|STOP/);
});

test('urgent messages search the saved area immediately', async () => {
  const { engine, areas } = engineWith({
    findSavedArea: async () => ({ id: 'home', label: 'Yaba, Lagos' }),
  });
  const [result] = await chat(engine, ['my chest hurts and I feel faint']);
  assert.equal(result.state, 'showing_emergency');
  assert.deepEqual(areas, ['Yaba, Lagos']);
  assert.match(textOf(result), /call 112/);
});

test('urgency detection covers common phrasings', () => {
  for (const phrase of [
    'having issues breathing',
    'I have trouble breathing',
    'shortness of breath',
    'he fainted',
    'she is having a seizure',
    'heavy bleeding after birth',
    'my baby is not breathing',
    'snake bite on leg',
  ]) {
    assert.equal(isPotentiallyUrgent(phrase), true, phrase);
  }
  assert.equal(isPotentiallyUrgent('I have a mild headache'), false);
});

test('the conversation remembers earlier turns and redacts numbers from memory', async () => {
  const seen: Array<Array<{ role: string; text: string }>> = [];
  const { engine } = engineWith({}, async (_message, options) => {
    seen.push(options.history);
    return { intent: 'clarification', service_code: null, location_query: null, question: null, reply: 'Which area are you in?' };
  });
  const [, second] = await chat(engine, ['my son has had a fever for 2 days', 'he is 4']);
  assert.equal(seen[1]!.length, 2);
  assert.equal(seen[1]![0]!.text, 'my son has had a fever for 2 days');
  assert.equal(seen[1]![1]!.text, 'Which area are you in?');
  assert.equal(second.context.history?.length, 4);

  const coded = await engine.process('CODE', { state: 'idle', context: {} });
  assert.match(textOf(coded), /not linked/);
  const { engine: linked } = engineWith({
    readOwnCodes: async () => ({ linked: true, patientCode: '123456789012' }),
  });
  const reply = await linked.process('my code', { state: 'idle', context: {} });
  assert.match(textOf(reply), /1234 5678 9012/);
  assert.doesNotMatch(JSON.stringify(reply.context.history), /1234|5678|9012/);
});

test('converse routes care requests with a location from the conversation', async () => {
  const { engine } = engineWith({}, async () => ({
    intent: 'find_care',
    service_code: 'pediatrics',
    location_query: 'Ikeja',
    question: null,
    reply: null,
  }));
  const [result] = await chat(engine, ['where can I take my sick child near Ikeja']);
  assert.equal(result.state, 'showing_results');
});

test('converse gives safe general guidance when no reviewed answer exists', async () => {
  const { engine } = engineWith({}, async () => ({
    intent: 'health_question',
    service_code: null,
    location_query: null,
    question: 'What helps a mild fever?',
    reply: 'Rest, drink plenty of fluids and see a clinician if the fever lasts over 2 days.',
  }));
  const [result] = await chat(engine, ['what should I do for a mild fever']);
  assert.match(textOf(result), /Rest, drink plenty of fluids/);
  assert.match(textOf(result), /not a diagnosis/);

  const { engine: reviewed } = engineWith(
    {},
    async () => ({ intent: 'health_question', service_code: null, location_query: null, question: 'q', reply: 'model text' }),
    'reviewed',
  );
  assert.equal(textOf((await chat(reviewed, ['question about fever']))[0]!), 'Reviewed answer.');
});

test('without AI, unknown messages get the plain-language menu, not a command list', async () => {
  const { engine } = engineWith({}, async () => null, 'fallback', false);
  const [result] = await chat(engine, ['something odd']);
  assert.equal(textOf(result), HELP);
  assert.equal(result.state, 'menu');
});

test('NEW CODE creates a 1-hour code for a linked phone', async () => {
  const { engine } = engineWith({
    createQuickGrant: async () => ({ status: 'created', code: '87654321', expiresAt: new Date() }),
  });
  const [result] = await chat(engine, ['new code']);
  assert.match(textOf(result), /8765 4321/);
});

test('LOOKUP accepts spaced codes and explains 8-digit codes', async () => {
  const { engine } = engineWith({
    readEmergency: async () => ({ available: true, fields: [{ key: 'a', label: 'A', value: 'x' }] }),
  });
  const spaced = await engine.process('LOOKUP 1234 5678 9012');
  assert.deepEqual(spaced.replies, [{ kind: 'emergency', codeDigest: 'digest' }]);
  assert.match(textOf(await engine.process('LOOKUP 1234 5678')), /USSD/);
});

test('short answers to the assistant stay in the conversation instead of hitting menu shortcuts', async () => {
  const seen: string[] = [];
  const { engine } = engineWith({}, async (message, options) => {
    seen.push(`${message}|${options.history.length}`);
    if (message.includes('fever'))
      return { intent: 'clarification', service_code: null, location_query: null, question: null, reply: 'How old is your child?' };
    if (message === '2')
      return { intent: 'clarification', service_code: null, location_query: null, question: null, reply: 'How long has the fever lasted?' };
    return { intent: 'smalltalk', service_code: null, location_query: null, question: null, reply: 'Okay. Anything else?' };
  });
  const [first, age, ok, confused] = await chat(engine, [
    'my child has a fever',
    '2',
    'ok',
    'what?',
  ]);
  assert.equal(first.state, 'chat');
  assert.equal(textOf(age), 'How long has the fever lasted?');
  assert.equal(age.state, 'chat');
  assert.equal(textOf(ok), 'Okay. Anything else?');
  assert.notEqual(textOf(confused), HELP);
  // Each turn reached the assistant with the growing thread.
  assert.deepEqual(seen, ['my child has a fever|0', '2|2', 'ok|4', 'what?|6']);
});

test('HELP and urgent messages still work in the middle of a chat', async () => {
  const { engine } = engineWith({}, async () => ({
    intent: 'clarification', service_code: null, location_query: null, question: null, reply: 'Tell me more?',
  }));
  const [, help, urgent] = await chat(engine, ['I feel sick', 'help', 'now I cannot breathe']);
  assert.equal(textOf(help), HELP);
  assert.equal(urgent.state, 'awaiting_emergency_area');
});

test('listings are short, numbered and say what to do next', () => {
  const lead = {
    name: 'Avon Healthcare Veta Hospital Ltd Lagos',
    address: '1, Veta Close, Araromi Bus Stop, Iyana Ipaja, Lagos 100211, Lagos, Nigeria',
    phone: '+23418241839',
    source_url: 'https://www.google.com/maps/place/?q=place_id:ChIJAQAAwAKROxARrWHUg_DsyRw',
  };
  const first = renderWebLead(lead, { index: 0, total: 3 });
  assert.match(first, /^Option 1\/3: Avon Healthcare Veta Hospital Lagos\n/);
  assert.doesNotMatch(first, /https?:|www\.|Map:|google/);
  assert.match(first, /\n1 Veta Close, Araromi Bus Stop, Iyana Ipaja, Lagos\n/);
  assert.doesNotMatch(first, /100211|Nigeria|Ltd/);
  assert.match(first, /Call: \+23418241839/);
  assert.match(first, /Reply MORE for another option\.$/);
  assert.ok(smsSegments(first).segments <= 2);

  const last = renderWebLead(lead, { index: 2, total: 3 });
  assert.match(last, /Reply with another area to search again\.$/);

  const emergency = renderWebLead(lead, { index: 0, total: 2, emergency: true });
  assert.match(emergency, /^Emergency 1\/2:/);
  assert.match(emergency, /Call 112 now/);
  assert.ok(smsSegments(emergency).segments <= 2);
});

test('address tidying keeps plot numbers and legacy listings still offer MORE', () => {
  const lead = {
    name: 'Clinic',
    address: 'Plot 123456 Admiralty Way, Lekki, Lagos 100211, Lagos, Nigeria',
    phone: null,
    source_url: 'https://example.org/clinic',
  };
  const text = renderWebLead(lead);
  assert.match(text, /\nPlot 123456 Admiralty Way, Lekki, Lagos\n/);
  assert.match(text, /Reply MORE for another option\./);
  assert.match(renderWebLead(lead, { emergency: true }), /Reply MORE for another\./);
});

test('SMS language: choose by name or menu, remember it, and greet in the detected language', async () => {
  const saved: string[] = [];
  const { engine } = engineWith({ setLocale: async (locale) => void saved.push(locale) });
  const [picked, help] = await chat(engine, ['Yoruba', 'help']);
  assert.match(textOf(picked), /ede Yoruba/);
  assert.match(textOf(help), /Fesi pelu nomba/);
  assert.equal(help.context.locale, 'yo');

  const [menu, hausa] = await chat(engine, ['LANG', '4']);
  assert.match(textOf(menu), /1 English, 2 Pidgin, 3 Yoruba, 4 Hausa, 5 Igbo/);
  assert.match(textOf(hausa), /Hausa/);
  assert.equal(hausa.context.locale, 'ha');

  const [igbo] = await chat(engine, ['Ndewo']);
  assert.match(textOf(igbo), /^Ndewo!/);
  assert.deepEqual(saved, ['yo', 'ha', 'ig']);
});

test('SMS language comes from the phone choice or profile and reaches the AI and listings', async () => {
  const languages: string[] = [];
  const { engine } = engineWith(
    { getLocale: async () => 'pcm' },
    async (_message, options) => {
      languages.push((options as { language?: string }).language ?? '');
      return { intent: 'find_care', service_code: 'general', location_query: 'Ikeja', question: null, reply: null };
    },
  );
  const [result] = await chat(engine, ['abeg I need doctor for Ikeja']);
  assert.deepEqual(languages, ['Nigerian Pidgin']);
  const listing = result.replies.find((reply) => reply.kind === 'facility');
  assert.equal(listing && 'locale' in listing ? listing.locale : null, 'pcm');
  assert.match(textOf((await chat(engine, ['HELP']))[0]!), /wetin dey do you/);
});

test('SMS switches language when the AI detects the person writing in another one', async () => {
  const saved: string[] = [];
  const { engine } = engineWith({ setLocale: async (locale) => void saved.push(locale) }, async () => ({
    intent: 'clarification', service_code: null, location_query: null, question: null,
    reply: 'Ina jin tausayinka. Tun yaushe ka fara jin zazzabi?', language: 'ha',
  }));
  const [result] = await chat(engine, ['ina da zazzabi da ciwon kai sosai']);
  assert.equal(result.context.locale, 'ha');
  assert.ok(saved.includes('ha'));
});

test('listings and the final SMS filter never carry links', async () => {
  const { channelText } = await import('../src/channels/render.js');
  const lead = {
    name: 'Clinic',
    address: '2 Allen Avenue, Ikeja, Lagos',
    phone: '+2348000000001',
    source_url: 'https://www.google.com/maps/place/?q=place_id:abc',
  };
  const yoruba = renderWebLead(lead, { index: 0, total: 2, locale: 'yo' });
  assert.match(yoruba, /^Aayan 1\/2: Clinic/);
  assert.match(yoruba, /Pe: \+2348000000001/);
  assert.doesNotMatch(yoruba, /https?:|www\.|google/);
  const cleaned = channelText(
    '**Rest** and fluids. See [advice](https://www.nhs.uk/fever) or www.who.int, email a@b.ng. Ẹ kú àárọ̀ 😊',
  );
  assert.equal(cleaned, 'Rest and fluids. See advice or email. E ku aaro');
  assert.doesNotMatch(cleaned, /https?:|www\.|@/);
});

test('a slow or failing AI keeps the chat going instead of showing the numbered menu', async () => {
  const { engine } = engineWith({}, async () => null);
  const [first, age] = await chat(engine, ['my child has a fever', '4']);
  assert.match(textOf(first), /could not answer that just now/);
  assert.equal(first.state, 'chat');
  // "4" is not taken as menu option 4 (my access code).
  assert.doesNotMatch(textOf(age), /not linked|access code/);
});
