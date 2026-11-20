// Usage: DATABASE_URL=... CODE_DIGEST_KEY=... DATA_ENCRYPTION_KEY=... npm run simulate
// (SIM_LOAD=40 adds 40 extra phones). SIM_REAL_AI=1 with OPENROUTER_API_KEY and
// OPENROUTER_MODEL uses the real model instead of the rule-based stand-in. Use a test database: it creates and removes a test patient.
//
// Africa's Talking simulator stand-in: real HTTP callbacks, real repository/Postgres,
// three worker replicas, many phones at once. Only outside services are faked:
// the AI model, Serper search, and the outbound SMS gateway (which records messages).
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../src/config.js';
import { createCrypto } from '../src/security/crypto.js';
import { Repository } from '../src/repository.js';
import { createApp } from '../src/app.js';
import { createUssdEngine } from '../src/channels/ussd.js';
import { createUssdHandler } from '../src/channels/ussd-handler.js';
import { createSmsEngine, UNAVAILABLE } from '../src/channels/sms.js';
import { channelText, fieldText, renderFacility, renderWebLead, smsSegments } from '../src/channels/render.js';
import { toLocale } from '../src/channels/i18n.js';
import { HELP } from '../src/channels/sms.js';
import { createAssistant, type GenerateRequest } from '../src/services/assistant.js';
import { createWebSearch } from '../src/services/web-search.js';

const REAL_AI = process.env.SIM_REAL_AI === '1';
const SHORTCODE = '55892';
const USSD_CODE = '*384*1#';
const token = randomBytes(32).toString('base64url');
const config = loadConfig({
  ...process.env,
  NODE_ENV: 'development',
  CALLBACK_TOKEN: token,
  AT_SMS_FROM: SHORTCODE,
  AT_USSD_SERVICE_CODE: USSD_CODE,
  SERPER_API_KEY: 'stand-in',
  OPENROUTER_API_KEY: REAL_AI ? process.env.OPENROUTER_API_KEY : 'stand-in',
  OPENROUTER_MODEL: REAL_AI ? process.env.OPENROUTER_MODEL : 'stand-in-model',
} as NodeJS.ProcessEnv);
const crypto = createCrypto(config);
const prisma = new PrismaClient();
const repository = new Repository(config, crypto, prisma);

// ---------------- stand-in Serper ----------------
const PLACES: Record<string, Array<Record<string, unknown>>> = {
  ikeja: [
    { title: 'Lagos State University Teaching Hospital (LASUTH)', address: '1-5 Oba Akinjobi Way, Ikeja, Lagos 100271, Lagos, Nigeria', phoneNumber: '+234 1 774 5487', placeId: 'ChIJ_lasuth' },
    { title: 'Reddington Hospital Ikeja Ltd', address: '12, Isaac John Street, GRA, Ikeja, Lagos 101233, Nigeria', phoneNumber: '+234 1 271 5340', placeId: 'ChIJ_reddington' },
  ],
  yaba: [
    { title: 'Federal Medical Centre Ebute Metta', address: '20, Railway Compound, Ebute Metta, Yaba, Lagos 101245, Nigeria', phoneNumber: '+234 1 342 2130', placeId: 'ChIJ_fmc' },
  ],
  'iyana ipaja': [
    { title: 'Avon Healthcare Veta Hospital Ltd Lagos', address: '1, Veta Close, Araromi Bus Stop, Iyana Ipaja, Lagos 100211, Lagos, Nigeria', phoneNumber: '+23418241839', placeId: 'ChIJAQAAwAKROxARrWHUg_DsyRw' },
  ],
};
let serperCalls = 0;
async function fakeSerper(endpoint: string, init: RequestInit) {
  serperCalls += 1;
  const payload = JSON.parse(String(init.body)) as { q: string };
  const q = payload.q.toLowerCase();
  let data: unknown;
  if (endpoint.endsWith('/maps')) {
    const key = Object.keys(PLACES).find((area) => q.includes(area));
    data = { places: key ? PLACES[key] : [] };
  } else {
    data = {
      organic: [
        { title: 'Fever - NHS', link: 'https://www.nhs.uk/conditions/fever-in-children/', snippet: 'Most fevers get better in 3 days. Give fluids, keep them comfortable and get help if your child is under 3 months or has a fever of 39C or more.' },
        { title: 'Malaria - WHO', link: 'https://www.who.int/news-room/fact-sheets/detail/malaria', snippet: 'Malaria symptoms include fever, headache and chills. Test promptly in malaria-endemic areas.' },
      ],
    };
  }
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}
const search = createWebSearch(config, { fetchImpl: fakeSerper as never });

// ---------------- stand-in AI model ----------------
// Rule-based, but it only knows the thread through the prompt the real code builds,
// so a reply that uses earlier facts proves the memory reached the model.
const modelCalls: Record<string, number> = {};
function threadOf(prompt: string) {
  const history = JSON.parse(/Recent conversation \(oldest first\):\n(.*?)\n\nLatest/s.exec(prompt)?.[1] ?? '[]') as Array<{ role: string; text: string }>;
  const latest = /Latest message:\n<<<\n(.*?)\n>>>/s.exec(prompt)?.[1] ?? '';
  return { history, latest, said: [...history.filter((t) => t.role === 'user').map((t) => t.text), latest].join(' | ').toLowerCase() };
}
async function fakeModel(request: GenerateRequest) {
  modelCalls[request.system.slice(0, 40)] = (modelCalls[request.system.slice(0, 40)] ?? 0) + 1;
  await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 350));
  if (request.prompt.includes('Recent conversation')) {
    const { latest, said } = threadOf(request.prompt);
    const l = latest.toLowerCase();
    const child = /child|son|daughter|baby|kid/.test(said);
    const area = /\b(ikeja|yaba|iyana ipaja)\b/.exec(said)?.[1] ?? null;
    const age = /\b(\d{1,2})\b/.exec(latest)?.[1];
    if (/\b(code)\b/.test(l)) return { output: { intent: 'my_code', reply: null } };
    if (/where|clinic|hospital|doctor|take (him|her)|go to/.test(l))
      return { output: { intent: 'find_care', service_code: child ? 'pediatrics' : 'general', location_query: area, reply: area ? null : `Which area are you in? I will find ${child ? 'a children\'s clinic' : 'a clinic'} near you.` } };
    if (area && /^(ikeja|yaba|iyana ipaja)/.test(l))
      return { output: { intent: 'find_care', service_code: child ? 'pediatrics' : 'general', location_query: area, reply: null } };
    if (/fever|headache|cough|pain|vomit|rash/.test(l))
      return { output: { intent: 'clarification', reply: child ? 'Sorry your child is unwell. How old are they, and how many days has this lasted?' : 'Sorry you feel unwell. How many days has this lasted, and do you have a temperature?' } };
    if (age && /fever/.test(said))
      return { output: { intent: 'health_question', question: `${child ? `A ${age}-year-old child` : 'An adult'} has had a fever; what should they do?`, reply: `For a ${age}${child ? '-year-old' : '-day'} fever: give fluids and rest, and see a clinician if it lasts over 3 days or gets worse.` } };
    if (/^(ok|okay|yes|no|thanks?)\b/.test(l))
      return { output: { intent: 'smalltalk', reply: /fever/.test(said) ? 'Okay. Keep an eye on the fever and message me if it gets worse or you want a clinic.' : 'Okay. How else can I help?' } };
    return { output: { intent: 'clarification', reply: 'Can you tell me a bit more about what is wrong?' } };
  }
  if (request.prompt.includes('Web sources:')) {
    const url = /"url":"([^"]+)"/.exec(request.prompt)?.[1];
    const extra = Array.from({ length: 20 }, (_, i) => `Extra general point ${i + 1} about caring for someone with a fever.`).join(' ');
    return { output: { answer_text: `Keep the child drinking fluids and resting. See a clinician if the fever lasts more than 3 days, is 39C or higher, or the child is very drowsy. In malaria areas, get tested promptly. ${extra}`, citations: url ? [url] : [] } };
  }
  return { output: { intent: 'clarification', service_code: null, location_query: null, question: null } };
}
const assistant = REAL_AI
  ? createAssistant(config, { search, repository })
  : createAssistant(config, { search, repository, model: 'stand-in-model', generateImpl: fakeModel });

// ---------------- outbound SMS gateway stand-in ----------------
const outbox = new Map<string, string[]>();
const provider = {
  async send({ to, text }: { to: string; text: string }) {
    outbox.set(to, [...(outbox.get(to) ?? []), text]);
    return { state: 'accepted' as const, providerMessageId: `sim_${randomUUID()}`, retryable: false };
  },
};

// ---------------- worker replicas (same steps as src/worker.ts) ----------------
let stopping = false;
let maxParts = 0;
const workerErrors: string[] = [];
async function workerLoop(workerId: string) {
  while (!stopping) {
    let worked = false;
    try {
      const inbox = await repository.claimInbox(workerId);
      if (inbox) {
        worked = true;
        try {
          await repository.processInbox(inbox, async (body, scoped, conversation) =>
            createSmsEngine({ config, crypto, repository: scoped, assistant, search }).process(body.text, conversation));
        } catch (error) {
          workerErrors.push(`${workerId} inbox: ${(error as Error).message}`);
          await repository.failInbox(inbox);
        }
      }
      const job = await repository.claimOutbox(workerId);
      if (job) {
        worked = true;
        const rendered = await repository.renderOutbox(job);
        if (rendered.suppressed) {
          await repository.finishOutbox(job, { state: 'expired', providerMessageId: null, retryable: false });
        } else {
          const reply = rendered.reply;
          let text =
            reply.kind === 'text' ? channelText(reply.text) || channelText(HELP)
            : reply.kind === 'emergency' ? (rendered.projection?.available && rendered.projection.fields?.length ? `Emergency summary (patient-selected information):\n${fieldText(rendered.projection.fields)}` : UNAVAILABLE)
            : reply.kind === 'facility' ? renderFacility(rendered.facility || null, undefined, { index: reply.index, total: reply.total, emergency: reply.emergency, locale: toLocale(reply.locale) ?? undefined })
            : renderWebLead(rendered.lead || null, { index: reply.index, total: reply.total, emergency: reply.emergency, locale: toLocale(reply.locale) ?? undefined });
          if (smsSegments(text).segments > config.smsMaxSegments) text = '[TOO LONG FOR SMS]';
          if (reply.kind === 'text') maxParts = Math.max(maxParts, smsSegments(text).segments);
          await repository.finishOutbox(job, await provider.send({ to: rendered.phone, text }));
        }
      }
    } catch (error) {
      workerErrors.push(`${workerId}: ${(error as Error).message}`);
    }
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

// ---------------- simulated phones ----------------
let base = '';
async function post(path: string, form: Record<string, string>) {
  const response = await fetch(`${base}/callbacks/africastalking/${token}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return { status: response.status, text: await response.text() };
}

interface Turn { send: string; expect?: RegExp[]; reject?: RegExp[] }
interface Result { phone: string; name: string; transcript: string[]; failures: string[] }

async function smsUser(name: string, phone: string, turns: Turn[]): Promise<Result> {
  const transcript: string[] = [];
  const failures: string[] = [];
  for (const turn of turns) {
    const before = outbox.get(phone)?.length ?? 0;
    const res = await post('/sms/inbound', { from: phone, to: SHORTCODE, text: turn.send, id: `ATXid_${randomUUID()}`, date: new Date().toISOString() });
    if (res.status !== 200) failures.push(`callback returned ${res.status} for "${turn.send}"`);
    transcript.push(`  > ${turn.send}`);
    const deadline = Date.now() + (REAL_AI ? 70000 : 15000);
    let replies: string[] = [];
    // Wait for replies to land, then a short settle for multi-part replies.
    while (Date.now() < deadline) {
      replies = (outbox.get(phone) ?? []).slice(before);
      if (replies.length) { await new Promise((r) => setTimeout(r, 400)); replies = (outbox.get(phone) ?? []).slice(before); break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!replies.length) failures.push(`no reply to "${turn.send}"`);
    for (const reply of replies) transcript.push(`  < ${reply.replace(/\n/g, '\n    ')}`);
    const all = replies.join('\n');
    for (const pattern of turn.expect ?? []) if (!pattern.test(all)) failures.push(`"${turn.send}": expected ${pattern}`);
    for (const pattern of turn.reject ?? []) if (pattern.test(all)) failures.push(`"${turn.send}": must not match ${pattern}`);
  }
  return { phone, name, transcript, failures };
}

async function ussdUser(name: string, phone: string, inputs: string[], expectLast: RegExp[]): Promise<Result> {
  const sessionId = `ATUid_${randomUUID()}`;
  const transcript: string[] = [];
  const failures: string[] = [];
  let screen = '';
  for (let i = 0; i <= inputs.length; i += 1) {
    const text = inputs.slice(0, i).join('*');
    const res = await post('/ussd', { sessionId, serviceCode: USSD_CODE, phoneNumber: phone, text, networkCode: '62130' });
    screen = res.text;
    transcript.push(`  [dial ${text || '(start)'}]\n    ${screen.replace(/\n/g, '\n    ')}`);
    if (screen.length > config.ussdMaxChars) failures.push(`screen over ${config.ussdMaxChars} chars`);
  }
  for (const pattern of expectLast) if (!pattern.test(screen)) failures.push(`expected ${pattern}`);
  return { phone, name, transcript, failures };
}

const phone = () => `+2348${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

(async () => {
  // A registered patient whose phone is verified, with a summary and home area.
  const patientPhone = phone();
  const account = await prisma.account.create({
    data: {
      email: `sim-${randomUUID().slice(0, 8)}@example.test`, password_hash: 'x', display_name: 'Sim Patient',
      phone_digest: crypto.digestPhone(patientPhone), phone_verified_at: new Date(),
      roles: { create: [{ role: 'PATIENT' }] },
      patient_profile: { create: { home_area_id: '20000000-0000-4000-8000-000000000001' } },
    },
    include: { patient_profile: true },
  });
  const patientId = account.patient_profile!.id;
  await prisma.patientFieldValue.createMany({ data: [
    { patient_id: patientId, field_key: 'allergies', value: ['Penicillin'] },
    { patient_id: patientId, field_key: 'blood_group', value: 'O+' },
  ] });
  await prisma.emergencyField.create({ data: { patient_id: patientId, field_key: 'allergies', display_order: 1 } });

  const ussdHandler = createUssdHandler({ repository, crypto, config, createEngine: createUssdEngine, search });
  const app = createApp({ config, crypto, repository, ussdHandler });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const workers = ['w1', 'w2', 'w3'].map(workerLoop);

  const started = Date.now();
  const LINK = /https?:|www\.|\.(?:com|org|net|gov|int|uk|ng)\b/i;
  const MENU_DUMP = /Reply with a number|Fesi pelu nomba|Amsa da lamba|Zaa na nomba|Reply with number/;
  const sms = REAL_AI ? await Promise.all([
    smsUser('REAL English: sick child with memory', phone(), [
      { send: 'my child has a fever', reject: [LINK] },
      { send: '4', reject: [LINK, MENU_DUMP] },
      { send: 'about 2 days and she is eating less', reject: [LINK, MENU_DUMP] },
      { send: 'where can I take her?', reject: [LINK] },
      { send: 'Yaba', expect: [/Federal Medical Centre/], reject: [LINK] },
    ]),
    smsUser('REAL English: breathing emergency', phone(), [
      { send: 'i am having issues breathing where can i go to help me', expect: [/112/], reject: [LINK] },
      { send: 'Ikeja', expect: [/LASUTH|Reddington|Teaching Hospital/], reject: [LINK] },
    ]),
    smsUser('REAL English: health question asking for links', phone(), [
      { send: 'what are the signs of malaria? send me a website link', reject: [LINK] },
    ]),
    smsUser('REAL Pidgin', phone(), [
      { send: 'How far, my body dey hot and my head dey pain me since yesterday', reject: [LINK] },
      { send: '2 days', reject: [LINK, MENU_DUMP] },
    ]),
    smsUser('REAL Yoruba (chosen)', phone(), [
      { send: 'Yoruba', expect: [/Yoruba/] },
      { send: 'Mo ni iba ati ori fifo lati ana', reject: [LINK] },
      { send: '3', reject: [LINK, MENU_DUMP] },
    ]),
    smsUser('REAL Hausa (detected)', phone(), [
      { send: 'Sannu', expect: [/Sannu/] },
      { send: 'Ina da zazzabi da ciwon kai tun jiya', reject: [LINK] },
    ]),
    smsUser('REAL Igbo (chosen by menu)', phone(), [
      { send: 'LANG', expect: [/5 Igbo/] },
      { send: '5', expect: [/Igbo/] },
      { send: 'Enwere m ahu oku na isi owuwa', reject: [LINK] },
    ]),
    smsUser('REAL Yoruba care search', phone(), [
      { send: 'Yoruba', expect: [/Yoruba/] },
      { send: 'Mo nilo ile iwosan ni Iyana Ipaja', expect: [/Avon Healthcare/], reject: [LINK] },
    ]),
  ]) : await Promise.all([
    smsUser('Screenshot conversation (breathing emergency)', phone(), [
      { send: 'Hello', expect: [/HealthAccess/], reject: [/LOOKUP|STOP/] },
      { send: 'i am having issues breathing where can i go to help me', expect: [/112/, /area/i] },
      { send: 'Ikeja', expect: [/^Emergency 1 of 2:/m, /Call: /] },
      { send: 'MORE', expect: [/Emergency 2 of 2/] },
      { send: 'i dont understand', expect: [/Reply with a number/] },
    ]),
    smsUser('Sick child with memory (number-only answer)', phone(), [
      { send: 'my child has a fever', expect: [/How old/] },
      { send: '4', expect: [/fluids/, /Source: nhs\.uk/], reject: [/Reply with a number/, /AI-assisted/] },
      { send: 'ok', expect: [/fever/], reject: [/welcome/i] },
      { send: 'where can I take her?', expect: [/area/i] },
      { send: 'Yaba', expect: [/^Nearest option: Federal Medical Centre/m] },
    ]),
    smsUser('Adult headache then care near Iyana Ipaja', phone(), [
      { send: 'I have had a headache and fever', expect: [/How many days/] },
      { send: '3', expect: [/fluids|clinician/i] },
      { send: 'where is a hospital in iyana ipaja', expect: [/Avon Healthcare Veta Hospital Lagos/, /1 Veta Close/], reject: [/100211|Nigeria|Ltd/] },
    ]),
    smsUser('Registered patient codes (verified phone)', patientPhone, [
      { send: 'CODE', expect: [/emergency code is \d{4} \d{4} \d{4}/] },
      { send: 'NEW CODE', expect: [/1-hour HealthAccess code is \d{4} \d{4}/] },
      { send: 'chest pain', expect: [/Searching near your saved area, Ikeja/] },
    ]),
    smsUser('Unlinked phone asks for a code', phone(), [
      { send: 'my code', expect: [/not linked/] },
    ]),
    smsUser('Classic commands', phone(), [
      { send: 'HELP', expect: [/Reply with a number/] },
      { send: '1', expect: [/Which care/] },
      { send: '1', expect: [/area|landmark/i] },
      { send: 'Ikeja', expect: [/Option|Ikeja|LASUTH/] },
      { send: 'CANCEL', expect: [/ended/] },
    ]),
    smsUser('Thanks and greetings outside a chat', phone(), [
      { send: 'Good morning', expect: [/HealthAccess/] },
      { send: 'thanks', expect: [/welcome/] },
    ]),
    smsUser('Second sick-child phone in parallel (no cross-talk)', phone(), [
      { send: 'my son has a fever and cough', expect: [/How old/] },
      { send: '7', expect: [/fluids|clinician/], reject: [/Reply with a number/] },
    ]),
    // Load: many more phones at once, each holding its own thread.
    ...Array.from({ length: Number(process.env.SIM_LOAD ?? 0) }, (_, i) =>
      smsUser(`Load phone ${i + 1}`, phone(), [
        { send: 'my daughter has a fever', expect: [/How old/] },
        { send: String(2 + (i % 9)), expect: [/fluids|clinician/], reject: [/Reply with a number/] },
        { send: 'where can I take her?', expect: [/area/i] },
        { send: ['Ikeja', 'Yaba', 'Iyana Ipaja'][i % 3]!, expect: [/option/i] },
      ]),
    ),
  ]);

  // USSD sessions in parallel, including the code made by SMS above.
  const newCode = /1-hour HealthAccess code is (\d{4}) (\d{4})/.exec(sms[3]!.transcript.join('\n'));
  const emergencyCode = /emergency code is (\d{4} \d{4} \d{4})/.exec(sms[3]!.transcript.join('\n'))?.[1];
  const ussd = REAL_AI ? [] : await Promise.all([
    ussdUser('USSD find care with saved area', patientPhone, ['1', '1', '1'], [/LASUTH|Hospital|Option|No suitable/i]),
    ussdUser('USSD my access code', patientPhone, ['3'], [/Your emergency code/]),
    ussdUser('USSD stranger opens the 1-hour code', phone(), ['2', newCode ? `${newCode[1]}${newCode[2]}` : '00000000'], [/Penicillin/]),
    ussdUser('USSD stranger opens the 12-digit code (spaced)', phone(), ['2', emergencyCode ?? '0'], [/Penicillin/]),
    ussdUser('USSD emergency help', phone(), ['4', 'Yaba'], [/Federal Medical Centre|112/]),
    ussdUser('USSD unlinked my code', phone(), ['3'], [/not linked/]),
  ]);

  stopping = true;
  await Promise.all(workers);
  server.close();

  let failed = 0;
  for (const result of [...sms, ...ussd]) {
    if (result.name.startsWith('Load phone') && !result.failures.length) continue;
    failed += result.failures.length ? 1 : 0;
    console.log(`\n${result.failures.length ? 'FAIL' : 'PASS'}  ${result.name}  (${result.phone.slice(0, 7)}…)`);
    console.log(result.transcript.join('\n'));
    for (const failure of result.failures) console.log(`  !! ${failure}`);
  }
  const conversations = await prisma.smsConversation.findMany({ where: { phone_digest: { in: sms.map((r) => crypto.digestPhone(r.phone)) } }, select: { context: true } });
  const plaintextLeak = conversations.some((c) => /fever|breathing|headache/.test(JSON.stringify(c.context)));
  const loadCount = sms.filter((r) => r.name.startsWith('Load phone')).length;
  console.log(`\nload phones: ${loadCount}, failed: ${sms.filter((r) => r.name.startsWith('Load phone') && r.failures.length).length}`);
  console.log(`\n==== ${sms.length + ussd.length - failed}/${sms.length + ussd.length} scenarios passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`worker replicas: 3; worker errors: ${workerErrors.length}${workerErrors.length ? `\n  ${workerErrors.join('\n  ')}` : ''}`);
  console.log(`messages sent: ${[...outbox.values()].flat().length}; Serper calls: ${serperCalls}; model calls: ${Object.values(modelCalls).reduce((a, b) => a + b, 0)}`);
  console.log(`largest text reply: ${maxParts} SMS parts (limit ${config.smsMaxSegments})`);
  console.log(`conversation memory stored encrypted (no plaintext symptoms in DB): ${!plaintextLeak}`);

  await prisma.auditEvent.deleteMany({ where: { patient_id: patientId } });
  await prisma.accessGrant.deleteMany({ where: { patient_id: patientId } });
  await prisma.account.delete({ where: { id: account.id } });
  await repository.close();
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (error) => {
  console.error(error);
  process.exit(2);
});
