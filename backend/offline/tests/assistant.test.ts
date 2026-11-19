import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistant } from '../src/services/assistant.js';
import type {
  AssistantConfig,
  AssistantRepository,
  AssistantSearch,
  GenerateLike,
  GenerateRequest,
  GenerateResult,
} from '../src/services/assistant.js';
import type { Service } from '../src/types.js';
import type { Source } from '../src/services/web-search.js';

const MODEL = 'mock-model';

type MockGenerate = GenerateLike & { calls: GenerateRequest[] };

function mockGenerate(
  handler: (request: GenerateRequest) => GenerateResult | Promise<GenerateResult>,
): MockGenerate {
  const calls: GenerateRequest[] = [];
  const generateImpl = async (request: GenerateRequest): Promise<GenerateResult> => {
    calls.push(request);
    return handler(request);
  };
  return Object.assign(generateImpl, { calls });
}

function assistantConfig(overrides: Partial<AssistantConfig> = {}): AssistantConfig {
  return {
    aiEnabled: true,
    aiTimeoutMs: 80,
    aiMaxOutputTokens: 256,
    allowLiveWeb: false,
    ...overrides,
  };
}

function repository(
  rows: unknown[] | ((query: string) => unknown[] | Promise<unknown[]>),
): AssistantRepository & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async findReviewedContent(query: string): Promise<unknown[]> {
      calls.push(query);
      return typeof rows === 'function' ? await rows(query) : rows;
    },
  };
}

function reviewedRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'content-1',
    topic: 'Fever',
    language: 'en',
    version: 1,
    body: 'Fever is a raised body temperature. Rest and fluids are commonly advised.',
    reviewer: 'Dr Ada Example',
    reviewed_at: '2025-01-02T10:00:00.000Z',
    ...overrides,
  };
}

function reviewedOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    answer_text: 'Fever is a raised body temperature. Rest and fluids are commonly advised.',
    citations: ['content-1'],
    ...overrides,
  };
}

function webSources(): Source[] {
  return [
    {
      title: 'WHO fever advice',
      url: 'https://www.who.int/news-room/fact-sheets/detail/fever',
      snippet: 'Fever is a temporary increase in body temperature.',
    },
    {
      title: 'NCDC guidance',
      url: 'https://ncdc.gov.ng/guidance',
      snippet: 'Seek care when fever is severe or persistent.',
    },
  ];
}

test('classify returns a validated intent and only accepts supplied service codes', async () => {
  const generateImpl = mockGenerate(() => ({
    output: {
      intent: 'find_care',
      service_code: 'pediatrics',
      location_query: 'Ikeja',
      question: null,
    },
  }));
  const assistant = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl,
    repository: repository([]),
  });

  const result = await assistant.classify('I need child care near Ikeja', {
    services: [{ service_code: 'pediatrics', label: 'Child care' }] satisfies Service[],
  });

  assert.deepEqual(result, {
    intent: 'find_care',
    service_code: 'pediatrics',
    location_query: 'Ikeja',
    question: null,
  });
  assert.equal(generateImpl.calls.length, 1);
  assert.equal(generateImpl.calls[0].model, MODEL);
  assert.ok(generateImpl.calls[0].schema);
  assert.equal(generateImpl.calls[0].maxOutputTokens, 256);
  assert.ok(generateImpl.calls[0].abortSignal);
  assert.match(generateImpl.calls[0].system, /classify/i);
  assert.match(generateImpl.calls[0].prompt, /I need child care near Ikeja/);
  assert.match(generateImpl.calls[0].prompt, /pediatrics/);

  const unknownCode = mockGenerate(() => ({
    output: {
      intent: 'find_care',
      service_code: 'invented-code',
      location_query: 'Ikeja',
      question: null,
    },
  }));
  const second = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl: unknownCode,
    repository: repository([]),
  });
  const secondResult = await second.classify('find care in Ikeja', {
    services: [{ service_code: 'pediatrics', label: 'Child care' }],
  });
  assert.equal(secondResult.intent, 'find_care');
  assert.equal(secondResult.service_code, null);
  assert.equal(secondResult.location_query, 'Ikeja');
});

test('classify requires a question for health questions and clears fields for unsupported', async () => {
  const health = mockGenerate(() => ({
    output: {
      intent: 'health_question',
      service_code: 'ignored',
      location_query: 'ignored',
      question: 'What causes fever?',
    },
  }));
  const first = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl: health,
    repository: repository([]),
  });
  assert.deepEqual(await first.classify('what causes fever?'), {
    intent: 'health_question',
    service_code: null,
    location_query: null,
    question: 'What causes fever?',
  });

  const missingQuestion = mockGenerate(() => ({
    output: { intent: 'health_question', service_code: null, location_query: null, question: null },
  }));
  const second = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl: missingQuestion,
    repository: repository([]),
  });
  assert.deepEqual(await second.classify('tell me about fever'), {
    intent: 'clarification',
    service_code: null,
    location_query: null,
    question: null,
  });

  const unsupported = mockGenerate(() => ({
    output: {
      intent: 'unsupported',
      service_code: 'x',
      location_query: 'y',
      question: 'z',
    },
  }));
  const third = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl: unsupported,
    repository: repository([]),
  });
  assert.deepEqual(await third.classify('read my patient record'), {
    intent: 'unsupported',
    service_code: null,
    location_query: null,
    question: null,
  });
});

test('classify fails closed on invalid output, provider errors and timeouts', async () => {
  const invalidIntent = mockGenerate(() => ({
    output: { intent: 'diagnose', service_code: null, location_query: null, question: null },
  }));
  const first = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl: invalidIntent,
    repository: repository([]),
  });
  assert.deepEqual(await first.classify('fever'), {
    intent: 'clarification',
    service_code: null,
    location_query: null,
    question: null,
  });

  const extraField = mockGenerate(() => ({
    output: {
      intent: 'find_care',
      service_code: null,
      location_query: 'Ikeja',
      question: null,
      extra: 'not allowed',
    },
  }));
  const second = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl: extraField,
    repository: repository([]),
  });
  assert.equal((await second.classify('care in Ikeja')).intent, 'clarification');

  const throwing = mockGenerate(() => {
    throw new Error('provider unavailable');
  });
  const third = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl: throwing,
    repository: repository([]),
  });
  assert.equal((await third.classify('fever')).intent, 'clarification');

  const hanging = createAssistant(assistantConfig({ aiTimeoutMs: 20 }), {
    model: MODEL,
    generateImpl: () => new Promise<GenerateResult>(() => {}),
    repository: repository([]),
  });
  const started = Date.now();
  assert.equal((await hanging.classify('fever')).intent, 'clarification');
  assert.ok(Date.now() - started < 1000);
});

test('classify makes no AI call for empty or digit-only messages and redacts long numbers', async () => {
  const generateImpl = mockGenerate(() => ({
    output: {
      intent: 'find_care',
      service_code: null,
      location_query: 'Ikeja',
      question: null,
    },
  }));
  const assistant = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl,
    repository: repository([]),
  });

  assert.equal((await assistant.classify('')).intent, 'clarification');
  assert.equal((await assistant.classify('123456789')).intent, 'clarification');
  assert.equal(generateImpl.calls.length, 0);

  await assistant.classify('My code is 123456789 and phone 0803 123 4567, find care in Ikeja');
  assert.equal(generateImpl.calls.length, 1);
  assert.ok(!generateImpl.calls[0].prompt.includes('123456789'));
  assert.ok(!generateImpl.calls[0].prompt.includes('0803 123 4567'));
  assert.ok(generateImpl.calls[0].prompt.includes('[number removed]'));
});

test('classify does not call a model when AI is disabled or no model is available', async () => {
  const generateImpl = mockGenerate(() => ({
    output: { intent: 'find_care', service_code: null, location_query: 'Ikeja', question: null },
  }));
  const disabled = createAssistant(assistantConfig({ aiEnabled: false }), {
    model: MODEL,
    generateImpl,
    repository: repository([]),
  });
  assert.equal((await disabled.classify('care in Ikeja')).intent, 'clarification');
  assert.equal(generateImpl.calls.length, 0);

  const noModel = createAssistant(assistantConfig(), { repository: repository([]) });
  assert.equal((await noModel.classify('care in Ikeja')).intent, 'clarification');
});

test('answer grounds reviewed answers in supplied content and requires a returned citation', async () => {
  const repo = repository([reviewedRow()]);
  const generateImpl = mockGenerate(() => ({ output: reviewedOutput() }));
  const assistant = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl,
    repository: repo,
  });

  const result = await assistant.answer('what should I do for fever?');

  assert.equal(result.kind, 'reviewed');
  assert.deepEqual(result.reviewedContentIds, ['content-1']);
  assert.deepEqual(result.sources, []);
  assert.match(result.text, /raised body temperature/);
  assert.equal(repo.calls.length, 1);
  assert.equal(generateImpl.calls.length, 1);
  assert.match(generateImpl.calls[0].system, /reviewed excerpts/i);
  assert.match(generateImpl.calls[0].prompt, /raised body temperature/);
  assert.match(generateImpl.calls[0].prompt, /what should I do for fever/);
});

test('answer ignores content without a reviewer or review time', async () => {
  const invalidRows = [
    reviewedRow({ id: 'no-reviewer', reviewer: '' }),
    reviewedRow({ id: 'no-review-time', reviewed_at: null }),
    reviewedRow({ id: 'no-body', body: '   ' }),
  ];
  const generateImpl = mockGenerate(() => ({
    output: reviewedOutput({ citations: ['no-reviewer'] }),
  }));
  const assistant = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl,
    repository: repository(invalidRows),
  });

  const result = await assistant.answer('fever');
  assert.equal(result.kind, 'fallback');
  assert.equal(generateImpl.calls.length, 0);
});

test('answer fails closed for unreturned citations, missing citations and unsafe clinical text', async () => {
  const cases: Record<string, unknown>[] = [
    reviewedOutput({ citations: ['content-other'] }),
    reviewedOutput({ citations: [] }),
    reviewedOutput({ answer_text: 'You likely have malaria.' }),
    reviewedOutput({ answer_text: 'Take 500 mg paracetamol twice daily.' }),
    reviewedOutput({ answer_text: 'I prescribe amoxicillin for this.' }),
    reviewedOutput({ answer_text: 42 }),
    { answer_text: reviewedOutput().answer_text },
  ];

  for (const output of cases) {
    const assistant = createAssistant(assistantConfig(), {
      model: MODEL,
      generateImpl: mockGenerate(() => ({ output })),
      repository: repository([reviewedRow()]),
    });
    const result = await assistant.answer('fever');
    assert.equal(result.kind, 'fallback');
    assert.deepEqual(result.reviewedContentIds, []);
    assert.deepEqual(result.sources, []);
  }
});

test('answer falls back on repository, provider errors and timeouts', async () => {
  const throwingRepo = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl: mockGenerate(() => ({ output: reviewedOutput() })),
    repository: {
      async findReviewedContent(): Promise<unknown[]> {
        throw new Error('database down');
      },
    },
  });
  assert.equal((await throwingRepo.answer('fever')).kind, 'fallback');

  const throwingProvider = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl: mockGenerate(() => {
      throw new Error('provider down');
    }),
    repository: repository([reviewedRow()]),
  });
  assert.equal((await throwingProvider.answer('fever')).kind, 'fallback');

  const hanging = createAssistant(assistantConfig({ aiTimeoutMs: 20 }), {
    model: MODEL,
    generateImpl: () => new Promise<GenerateResult>(() => {}),
    repository: repository([reviewedRow()]),
  });
  assert.equal((await hanging.answer('fever')).kind, 'fallback');
});

test('answer returns a clearly labelled web-only result when reviewed evidence is absent', async () => {
  const sourceCalls: string[] = [];
  const search: AssistantSearch = {
    async searchHealth(query: string): Promise<Source[]> {
      sourceCalls.push(query);
      return webSources();
    },
  };
  const generateImpl = mockGenerate(() => ({
    output: {
      answer_text: 'Fever is a temporary increase in body temperature. Seek care if it is severe.',
      citations: ['https://www.who.int/news-room/fact-sheets/detail/fever'],
    },
  }));
  const assistant = createAssistant(assistantConfig({ allowLiveWeb: true }), {
    model: MODEL,
    generateImpl,
    repository: repository([]),
    search,
  });

  const result = await assistant.answer('what is fever?');

  assert.equal(result.kind, 'web_unreviewed');
  assert.deepEqual(result.reviewedContentIds, []);
  assert.equal(result.sources.length, 2);
  assert.match(result.text, /General information from the web, not a diagnosis/);
  assert.match(result.text, /Source: World Health Organization\./);
  // SMS answers never carry links.
  assert.doesNotMatch(result.text, /https?:|www\.|who\.int/);
  assert.doesNotMatch(result.text, /verified/i);
  assert.equal(sourceCalls.length, 1);
  assert.equal(sourceCalls[0], 'what is fever?');
  assert.match(generateImpl.calls[0].system, /web-search excerpts/i);
  assert.match(generateImpl.calls[0].prompt, /temporary increase in body temperature/);
  assert.equal('verification_status' in result, false);
  assert.equal('phone' in result, false);
  assert.equal('latitude' in result, false);
});

test('web answers fail closed on invented citations, review claims, verification claims and unsafe text', async () => {
  const outputs: Record<string, unknown>[] = [
    { answer_text: 'Fever advice.', citations: ['https://evil.example/made-up'] },
    { answer_text: 'Fever advice.', citations: [] },
    {
      answer_text: 'This information has been clinically reviewed.',
      citations: ['https://www.who.int/news-room/fact-sheets/detail/fever'],
    },
    {
      answer_text: 'This hospital is verified.',
      citations: ['https://www.who.int/news-room/fact-sheets/detail/fever'],
    },
    {
      answer_text: 'You likely have malaria.',
      citations: ['https://www.who.int/news-room/fact-sheets/detail/fever'],
    },
    {
      answer_text: 'Take 500 mg paracetamol.',
      citations: ['https://www.who.int/news-room/fact-sheets/detail/fever'],
    },
    { answer_text: 'Fever advice.', citations: [42] },
  ];

  for (const output of outputs) {
    const assistant = createAssistant(assistantConfig({ allowLiveWeb: true }), {
      model: MODEL,
      generateImpl: mockGenerate(() => ({ output })),
      repository: repository([]),
      search: {
        async searchHealth(): Promise<Source[]> {
          return webSources();
        },
      },
    });
    const result = await assistant.answer('fever');
    assert.equal(result.kind, 'fallback');
    assert.deepEqual(result.sources, []);
  }
});

test('web answers are unavailable unless allowed and fail closed on search failures or bad sources', async () => {
  let called = false;
  const search: AssistantSearch = {
    async searchHealth(): Promise<Source[]> {
      called = true;
      return webSources();
    },
  };
  const disabled = createAssistant(assistantConfig({ allowLiveWeb: false }), {
    model: MODEL,
    generateImpl: mockGenerate(() => ({
      output: { answer_text: 'Fever advice.', citations: ['https://www.who.int/x'] },
    })),
    repository: repository([]),
    search,
  });
  assert.equal((await disabled.answer('fever')).kind, 'fallback');
  assert.equal(called, false);

  const throwing = createAssistant(assistantConfig({ allowLiveWeb: true }), {
    model: MODEL,
    generateImpl: mockGenerate(() => ({ output: reviewedOutput() })),
    repository: repository([]),
    search: {
      async searchHealth(): Promise<Source[]> {
        throw new Error('serper down');
      },
    },
  });
  assert.equal((await throwing.answer('fever')).kind, 'fallback');

  const unsafeSources = createAssistant(assistantConfig({ allowLiveWeb: true }), {
    model: MODEL,
    generateImpl: mockGenerate(() => ({ output: reviewedOutput() })),
    repository: repository([]),
    search: {
      async searchHealth(): Promise<Source[]> {
        return [
          { title: 'local', url: 'https://127.0.0.1/x', snippet: 'bad' },
          { title: 'http', url: 'http://www.who.int/x', snippet: 'bad' },
        ];
      },
    },
  });
  assert.equal((await unsafeSources.answer('fever')).kind, 'fallback');

  const noSearch = createAssistant(assistantConfig({ allowLiveWeb: true }), {
    model: MODEL,
    generateImpl: mockGenerate(() => ({ output: reviewedOutput() })),
    repository: repository([]),
  });
  assert.equal((await noSearch.answer('fever')).kind, 'fallback');
});

test('answer redacts long numbers before repository lookup and model prompts', async () => {
  const repo = repository([reviewedRow()]);
  const generateImpl = mockGenerate(() => ({ output: reviewedOutput() }));
  const assistant = createAssistant(assistantConfig(), {
    model: MODEL,
    generateImpl,
    repository: repo,
  });

  await assistant.answer('my code is 123456789, what is fever?');

  assert.ok(!repo.calls[0].includes('123456789'));
  assert.ok(repo.calls[0].includes('[number removed]'));
  assert.ok(!generateImpl.calls[0].prompt.includes('123456789'));
});

test('answer and classify fail closed without AI configuration and no secrets are logged', async () => {
  const originalError = console.error;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    const assistant = createAssistant(
      { aiEnabled: true },
      { repository: repository([reviewedRow()]) },
    );
    assert.equal((await assistant.classify('fever')).intent, 'clarification');
    const answer = await assistant.answer('fever');
    assert.equal(answer.kind, 'fallback');
    assert.equal(logs.length, 0);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    console.warn = originalWarn;
  }
});

test('createAssistant validates configuration bounds', () => {
  assert.throws(() => createAssistant(null as unknown as AssistantConfig), /config is required/);
  assert.throws(() => createAssistant(assistantConfig({ aiTimeoutMs: 0 })), /aiTimeoutMs/);
  assert.throws(() => createAssistant(assistantConfig({ aiTimeoutMs: 60001 })), /aiTimeoutMs/);
  assert.throws(
    () => createAssistant(assistantConfig({ aiMaxOutputTokens: 1 })),
    /aiMaxOutputTokens/,
  );
  assert.throws(
    () => createAssistant(assistantConfig({ aiMaxOutputTokens: 5000 })),
    /aiMaxOutputTokens/,
  );
});

test('answer sends cleaned personal hints to the model but never to web search', async () => {
  const searchQueries: string[] = [];
  const search: AssistantSearch = {
    async searchHealth(query: string): Promise<Source[]> {
      searchQueries.push(query);
      return [];
    },
  };
  const generate = mockGenerate(() => ({
    output: { answer_text: 'Rest and fluids are commonly advised.', citations: ['content-1'] },
  }));
  const assistant = createAssistant(assistantConfig({ openrouterModel: MODEL }), {
    repository: repository([reviewedRow()]),
    search,
    model: MODEL,
    generateImpl: generate,
  });
  const result = await assistant.answer('what helps a fever', {
    personal: {
      ageBand: 'adult under 40',
      sex: 'Female',
      pregnancy: 'Pregnant',
      conditions: ['Asthma', 'call 08012345678'],
      allergies: ['Penicillin'],
      medications: [],
      language: 'en',
    },
  });
  assert.equal(result.kind, 'reviewed');
  const prompt = generate.calls[0]!.prompt;
  assert.match(prompt, /Person context/);
  assert.match(prompt, /Pregnant/);
  assert.match(prompt, /Asthma/);
  assert.doesNotMatch(prompt, /08012345678/);
  assert.deepEqual(searchQueries, []);
});

test('answer omits the person context block when no hints are supplied', async () => {
  const generate = mockGenerate(() => ({
    output: { answer_text: 'Rest and fluids are commonly advised.', citations: ['content-1'] },
  }));
  const assistant = createAssistant(assistantConfig({ openrouterModel: MODEL }), {
    repository: repository([reviewedRow()]),
    model: MODEL,
    generateImpl: generate,
  });
  await assistant.answer('what helps a fever', { personal: null });
  assert.doesNotMatch(generate.calls[0]!.prompt, /Person context/);
});

test('converse sends short number-only replies and prior turns to the model', async () => {
  const generate = mockGenerate(() => ({
    output: { intent: 'clarification', service_code: null, location_query: null, question: null, reply: 'Has it lasted more than 2 days?' },
  }));
  const assistant = createAssistant(assistantConfig({ openrouterModel: MODEL }), { model: MODEL, generateImpl: generate });
  const result = await assistant.converse!('2', {
    history: [
      { role: 'user', text: 'my child has a fever' },
      { role: 'assistant', text: 'How old is your child?' },
    ],
  });
  assert.equal(result?.reply, 'Has it lasted more than 2 days?');
  assert.equal(generate.calls.length, 1);
  assert.match(generate.calls[0]!.prompt, /my child has a fever/);
  assert.match(generate.calls[0]!.prompt, /How old is your child\?/);
  assert.match(generate.calls[0]!.prompt, /<<<\n2\n>>>/);
  // Long numbers are still kept away from the model.
  await assistant.converse!('call me on 08031234567', {});
  assert.doesNotMatch(generate.calls[1]!.prompt, /08031234567/);
});

test('converse tolerates a model that omits optional fields', async () => {
  const generate = mockGenerate(() => ({ output: { intent: 'smalltalk', reply: 'Hello! How can I help?' } }));
  const assistant = createAssistant(assistantConfig({ openrouterModel: MODEL }), { model: MODEL, generateImpl: generate });
  const result = await assistant.converse!('hi there', {});
  assert.equal(result?.reply, 'Hello! How can I help?');
  assert.equal(result?.location_query, null);
});

test('long answers are trimmed at a sentence so they fit in an SMS', async () => {
  const { fitForSms } = await import('../src/services/assistant.js');
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} gives general advice.`).join(' ');
  const fitted = fitForSms(long);
  assert.ok(fitted.length <= 420);
  assert.match(fitted, /advice\.$/);
  assert.equal(fitForSms('Short answer.'), 'Short answer.');
});

test('web answers use the translated source label and note', async () => {
  const generate = mockGenerate((request) =>
    request.prompt.includes('Web sources:')
      ? { output: { answer_text: 'Sha ruwa sosai kuma ka huta.', citations: ['https://www.who.int/news-room/fact-sheets/detail/malaria'] } }
      : { output: null },
  );
  const assistant = createAssistant(assistantConfig({ openrouterModel: MODEL, allowLiveWeb: true }), {
    repository: repository([]),
    search: {
      async searchHealth() {
        return [{ title: 'Malaria', url: 'https://www.who.int/news-room/fact-sheets/detail/malaria', snippet: 'Malaria causes fever.' }];
      },
    },
    model: MODEL,
    generateImpl: generate,
  });
  const result = await assistant.answer('zazzabi', {
    language: 'Hausa',
    labels: { source: 'Tushe', note: 'Bayani na gaba daya ne.' },
  });
  assert.match(result.text, /Tushe: World Health Organization\. Bayani na gaba daya ne\.$/);
  assert.match(generate.calls[0]!.prompt, /Answer language: Hausa/);
});
