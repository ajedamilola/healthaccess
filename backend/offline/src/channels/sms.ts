import type { Config } from '../config.js';
import {
  LANGUAGE_NAMES,
  USSD_LANGUAGE_ORDER,
  detectLocale,
  languageChoice,
  t,
  toLocale,
  type Locale,
} from './i18n.js';
import type { Crypto } from '../security/crypto.js';
import type {
  Area,
  Facility,
  OwnCodes,
  PersonalHints,
  QuickGrantResult,
  Projection,
  SavedArea,
  Service,
  SmsContext,
  SmsConversation,
  SmsReply,
  WebLead,
} from '../types.js';

export interface SmsRepository {
  listServices(): Promise<Service[]>;
  findAreas(query: string): Promise<Area[]>;
  findFacilities(service: string, areaId: string, radius: number): Promise<Facility[]>;
  readEmergency(digest: string): Promise<Projection>;
  findProfileConsent(): Promise<{ id: string } | null>;
  readMatchingContext(consentId: string): Promise<{ available: boolean }>;
  setOptOut(optOut: boolean): Promise<void>;
  /** The sender's language: their SMS choice, else their profile language, else English. */
  getLocale?(): Promise<Locale>;
  setLocale?(locale: Locale): Promise<void>;
  /** Linked patient's home area (live consent only). */
  findSavedArea?(): Promise<SavedArea | null>;
  /** Consent-scoped, de-identified hints for tailoring answers (live consent only). */
  readPersonalHints?(): Promise<PersonalHints | null>;
  /** The sender's own emergency code, when the phone is verified to a patient. */
  readOwnCodes?(): Promise<OwnCodes>;
  /** One-tap temporary code for the sender's emergency information. */
  createQuickGrant?(minutes?: number): Promise<QuickGrantResult>;
  storeWebLeads(leads: WebLead[]): Promise<string[]>;
  recordEmergencyRequest?(request: {
    channel: 'SMS' | 'USSD';
    area_id: string | null;
    location_text: string;
    results: WebLead[];
  }): Promise<void>;
  recordReferral?(referral: {
    serviceCode: string;
    areaId: string;
    facilities: Facility[];
    consentId: string | null;
  }): Promise<void>;
}

interface SmsDependencies {
  repository: SmsRepository;
  assistant: {
    classify(
      message: string,
      context: { services: Service[] },
    ): Promise<{
      intent: string;
      service_code: string | null;
      location_query: string | null;
      question: string | null;
    }>;
    answer(
      question: string,
      options?: {
        personal?: PersonalHints | null;
        language?: string;
        labels?: { source: string; note: string };
      },
    ): Promise<{ text: string; kind?: string }>;
    /** False when no AI model is configured (deterministic menus only). */
    available?(): boolean;
    converse?(
      message: string,
      options: {
        services: Service[];
        history: Array<{ role: 'user' | 'assistant'; text: string }>;
        savedAreaLabel: string | null;
        language?: string;
      },
    ): Promise<{
      intent: string;
      service_code: string | null;
      location_query: string | null;
      question: string | null;
      reply: string | null;
      language?: string | null;
    } | null>;
  };
  search?: {
    discoverFacilities(request: { serviceLabel: string; area: string }): Promise<WebLead[]>;
    discoverEmergency?(request: { area: string }): Promise<WebLead[]>;
  };
  crypto: Pick<Crypto, 'digestCode'>;
  config: Pick<Config, 'profileUseEnabled' | 'searchRadiusKm' | 'allowLiveWeb'>;
}

export interface SmsResult extends SmsConversation {
  replies: SmsReply[];
}

export const HELP = t('en', 'help');
export const GREETING = t('en', 'greeting');
export const NOT_LINKED = t('en', 'notLinked');
export const UNAVAILABLE = 'No shared summary is available for that code. Check the code.';
export const URGENT = t('en', 'urgent');
export const EMERGENCY_FALLBACK =
  'No live emergency listing found. Call 112 now or go to the nearest emergency department. HealthAccess does not dispatch ambulances.';

const aliases: Record<string, string[]> = {
  general: ['general', 'general care', 'general medicine', 'doctor'],
  pediatrics: ['pediatrics', 'paediatrics', 'child', 'child health', 'children', 'baby'],
  maternity: ['maternity', 'maternity care', 'pregnancy', 'antenatal'],
};

export function resolveService(text: string, services: Service[]) {
  const normalized = text.toLowerCase().trim();
  const matches = services.filter((service) =>
    [service.service_code, service.label, ...(aliases[service.service_code] || [])].some((alias) =>
      new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(normalized),
    ),
  );
  return matches.length === 1 ? matches[0].service_code : null;
}

export function isPotentiallyUrgent(text: string) {
  // Conservative routing only, not clinical triage or a claim of reviewed advice.
  return [
    /\b(?:can['\u2019]?t|cannot|can not|unable to|struggling to|hard to|difficult to) breathe?\b/i,
    /\b(?:difficulty|trouble|problems?|issues?|struggling|hard|pain) (?:with |when |while )?breathing\b/i,
    /\bbreathing (?:problems?|issues?|difficult(?:y|ies)|trouble|hard|fast|badly)\b/i,
    /\bshort(?:ness)? of breath\b|\bgasping\b|\bchoking\b/i,
    /\bchest (?:pain|tightness|is tight|hurts)\b/i,
    /\b(?:unconscious|not waking|passed out|fainted|collapsed|unresponsive)\b/i,
    /\b(?:seizure|convulsion|convulsing|fitting)s?\b/i,
    /\b(?:stroke|face drooping|slurred speech)\b/i,
    /\b(?:severe|heavy|a lot of|won['\u2019]?t stop) bleeding\b|\bbleeding (?:a lot|heavily|won['\u2019]?t stop)\b/i,
    /\b(?:overdose|poison(?:ed|ing)?|snake ?bite)\b/i,
    /\b(?:kill myself|end my life|suicid(?:e|al))\b/i,
    /\bnot breathing\b|\b(?:baby|child)(?: is)? (?:not moving|blue|turning blue)\b/i,
  ].some((pattern) => pattern.test(text));
}

export function createSmsEngine({
  repository,
  assistant,
  search,
  crypto,
  config,
}: SmsDependencies) {
  type AreaContext = SmsContext & { areaLabel?: string; areaLabels?: string[] };
  const areaContext = (context: SmsContext) => context as AreaContext;
  const areaText = (area: Area) => {
    const suffix = area.city || area.region;
    return suffix && suffix !== area.name ? `${area.name}, ${suffix}` : area.name;
  };
  const textReply = (text: string): SmsReply => ({ kind: 'text', text });
  const result = (state: string, context: SmsContext, replies: SmsReply[]): SmsResult => ({
    state,
    context,
    replies,
  });
  const idle = (text: string) => result('idle', {}, [textReply(text)]);
  // Set at the start of each message from the conversation, the phone's choice or profile.
  let locale: Locale = 'en';
  const say = (key: string, params: Record<string, string | number> = {}) => t(locale, key, params);

  async function savedArea(): Promise<SavedArea | null> {
    try {
      return (await repository.findSavedArea?.()) ?? null;
    } catch {
      return null;
    }
  }

  async function personalHints(): Promise<PersonalHints | null> {
    try {
      return (await repository.readPersonalHints?.()) ?? null;
    } catch {
      // Personalisation is best-effort; a general answer is still safe.
      return null;
    }
  }

  async function answerQuestion(question: string): Promise<SmsResult> {
    const answer = await assistant.answer(question, {
      personal: await personalHints(),
      language: LANGUAGE_NAMES[locale],
      labels: { source: say('source'), note: say('sourceNote') },
    });
    // Stay in the chat so a follow-up ("what if it gets worse?") keeps the thread.
    return result(assistant.converse ? 'chat' : 'idle', {}, [textReply(answer.text)]);
  }

  async function showResult(
    context: SmsContext,
    index = 0,
    stateName = 'showing_results',
  ): Promise<SmsResult> {
    if (index >= (context.resultIds || []).length) {
      if (stateName === 'showing_emergency') {
        return idle(say('lastEmergency'));
      }
      return result('awaiting_area', { serviceCode: context.serviceCode }, [
        textReply(say('lastCare')),
      ]);
    }
    return result(stateName, { ...context, resultIndex: index }, [
      {
        kind: context.resultKind === 'web' ? 'web_lead' : 'facility',
        id: context.resultIds![index],
        serviceCode: context.serviceCode,
        areaId: context.areaId || null,
        index,
        total: context.resultIds!.length,
        locale,
        emergency: stateName === 'showing_emergency',
      },
    ]);
  }

  async function findCare(
    serviceCode: string | null | undefined,
    query: string | null | undefined,
    context: SmsContext = {},
    confirmProfile = false,
  ): Promise<SmsResult> {
    const services = await repository.listServices();
    if (!serviceCode) {
      return result('awaiting_service', {}, [
        textReply(
          say('whichCare', { options: services.map((s, i) => `${i + 1}. ${s.label}`).join(' ') }),
        ),
      ]);
    }
    if (!query && !context.areaId) {
      const saved = await savedArea();
      if (saved)
        return result(
          'awaiting_area',
          { serviceCode, suggestedAreaId: saved.id, suggestedAreaLabel: saved.label },
          [
            textReply(say('savedAreaCare', { area: saved.label })),
          ],
        );
      return result('awaiting_area', { serviceCode }, [
        textReply(say('askArea')),
      ]);
    }
    const areas = context.areaId
      ? [{ id: context.areaId, name: '' }]
      : await repository.findAreas(query!);
    if (areas.length > 1) {
      const choices = areas.slice(0, 3);
      return result(
        'awaiting_area_choice',
        {
          serviceCode,
          areaIds: choices.map((a) => a.id),
          areaLabels: choices.map(areaText),
        } as SmsContext,
        [
          textReply(
            `Choose an area: ${choices.map((a, i) => `${i + 1}. ${a.name}, ${a.region || a.city || ''}`).join('; ')}. Reply with a number.`,
          ),
        ],
      );
    }
    if (!areas.length) return webFallback(serviceCode, query);
    const areaId = areas[0].id;
    const areaLabel = (context.areaId ? areaContext(context).areaLabel : null) || areaText(areas[0]);
    let consentId = context.consentId || null;
    if (config.profileUseEnabled && !confirmProfile && !context.skipProfile) {
      const consent = await repository.findProfileConsent();
      if (consent)
        return result(
          'awaiting_profile_confirmation',
          { serviceCode, areaId, consentId: consent.id, areaLabel } as SmsContext,
          [
            textReply(
              'Use the profile scope you previously permitted for this search? Reply YES or NO. No profile details will be sent by SMS.',
            ),
          ],
        );
    }
    if (confirmProfile && consentId) {
      // Do not retain clinical values in channel state or send them to models/search.
      const permitted = await repository.readMatchingContext(consentId);
      if (!permitted?.available) consentId = null;
    } else consentId = null;
    const facilities = await repository.findFacilities(serviceCode, areaId, config.searchRadiusKm);
    if (!facilities.length) {
      if (query || areaLabel) return webFallback(serviceCode, areaLabel || query);
      return result('awaiting_area', { serviceCode }, [
        textReply(
          'No suitable facility is listed for that area. Try another area. A nearby facility is not necessarily suitable.',
        ),
      ]);
    }
    // Referral telemetry must not hide an otherwise valid directory result.
    try {
      await repository.recordReferral?.({ serviceCode, areaId, facilities, consentId });
    } catch {
      // The user-facing result still comes from the approved directory response.
    }
    return showResult({
      serviceCode,
      areaId,
      resultIds: facilities.map((f) => f.id),
      resultKind: 'directory',
    });
  }

  async function webFallback(
    serviceCode: string,
    area: string | null | undefined,
  ): Promise<SmsResult> {
    if (config.allowLiveWeb && search && area) {
      try {
        const services = await repository.listServices();
        const serviceLabel = services.find((s) => s.service_code === serviceCode)?.label;
        if (serviceLabel) {
          const leads = await search.discoverFacilities({ serviceLabel, area });
          const ids = await repository.storeWebLeads(leads);
          if (ids.length) return showResult({ serviceCode, resultIds: ids, resultKind: 'web' });
        }
      } catch {
        /* A failed web search never becomes a fabricated directory result. */
      }
    }
    return result('awaiting_area', { serviceCode }, [
      textReply(
        'No suitable facility is listed for that area. Try another area or landmark. Service availability cannot be confirmed.',
      ),
    ]);
  }

  function validEmergencyArea(value: string): boolean {
    const area = value.trim();
    return area.length > 0 && area.length <= 64 && /[\p{L}]/u.test(area) && !/^\d+$/.test(area);
  }

  async function emergencySearch(area: string, note?: string): Promise<SmsResult> {
    let leads: WebLead[] = [];
    if (config.allowLiveWeb && search?.discoverEmergency) {
      try {
        leads = (await search.discoverEmergency({ area })).slice(0, 8);
      } catch {
        leads = [];
      }
    }
    try {
      await repository.recordEmergencyRequest?.({
        channel: 'SMS',
        area_id: null,
        location_text: area,
        results: leads,
      });
    } catch {
      // Telemetry is best-effort and must not hide emergency guidance.
    }
    if (!leads.length) return idle(EMERGENCY_FALLBACK);
    let ids: string[];
    try {
      ids = await repository.storeWebLeads(leads);
    } catch {
      return idle(EMERGENCY_FALLBACK);
    }
    if (!ids.length) return idle(EMERGENCY_FALLBACK);
    const shown = await showResult({ resultIds: ids, resultKind: 'web' }, 0, 'showing_emergency');
    return note ? { ...shown, replies: [textReply(note), ...shown.replies] } : shown;
  }

  type Turn = { role: 'user' | 'assistant'; text: string };
  const HISTORY_TURNS = 10;
  const historyText = (value: string) =>
    value
      .replace(/\d[\d\s-]{4,}\d/g, '[number]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 320);

  function replyText(reply: SmsReply): string {
    if (reply.kind === 'text') return reply.text;
    if (reply.kind === 'emergency') return '[sent the emergency summary]';
    return '[sent a care listing]';
  }

  const grouped = (code: string) => code.replace(/(\d{4})(?=\d)/g, '$1 ');

  async function myCode(): Promise<SmsResult> {
    let codes: OwnCodes = { linked: false };
    try {
      codes = (await repository.readOwnCodes?.()) ?? { linked: false };
    } catch {
      return idle('Your code is unavailable right now. Please try again shortly.');
    }
    if (!codes.linked) return idle(say('notLinked'));
    return result('idle', {}, [
      textReply(
        say(codes.summaryFields === 0 ? 'myCodeEmpty' : 'myCode', { code: grouped(codes.patientCode) }),
      ),
    ]);
  }

  async function newCode(): Promise<SmsResult> {
    let created: QuickGrantResult = { status: 'not_linked' };
    try {
      created = (await repository.createQuickGrant?.(60)) ?? { status: 'not_linked' };
    } catch {
      return idle('A new code could not be created right now. Please try again shortly.');
    }
    if (created.status === 'not_linked') return idle(say('notLinked'));
    if (created.status === 'nothing_to_share') return idle(say('nothingToShare'));
    return idle(say('newCode', { code: grouped(created.code) }));
  }

  async function urgent(note = say('urgent')): Promise<SmsResult> {
    const saved = await savedArea();
    if (saved)
      return emergencySearch(
        saved.label,
        say('savedAreaUrgent', { area: saved.label }),
      );
    return result('awaiting_emergency_area', {}, [textReply(note)]);
  }

  async function startEmergency(): Promise<SmsResult> {
    const saved = await savedArea();
    if (saved)
      return emergencySearch(
        saved.label,
        say('savedAreaEmergency', { area: saved.label }),
      );
    return result('awaiting_emergency_area', {}, [
      textReply(say('askEmergencyArea')),
    ]);
  }

  const MENU_PATTERN =
    /^(?:help|menu|options?|start|\?+|what\??|huh\??|i don['’]?t understand|i do not understand|don['’]?t understand|confused|what can you do\??)$/i;
  const GREETING_PATTERN =
    /^(?:hi+|hello+|hey+|hallo|good (?:morning|afternoon|evening|day)|howdy|how far|how you dey|bawo|bawo ni|e kaa?ro|e kaasan|e kaale|e nle o?|sannu|ina kwana|ina wuni|barka da (?:safiya|rana|yamma)|ndewo|kedu|ututu oma)[!. ]*$/i;
  const THANKS_PATTERN = /^(?:thanks?|thank you|ok(?:ay)?|alright|cool|great|e se|ese|o se|na gode|nagode|daalu|dalu|tank you|tenk you)[!. ]*$/i;

  async function rememberLocale(next: Locale) {
    try {
      await repository.setLocale?.(next);
    } catch {
      // The conversation still carries the choice for this thread.
    }
  }

  async function resolveLocale(context: SmsContext): Promise<Locale> {
    const fromThread = toLocale(context.locale);
    if (fromThread) return fromThread;
    try {
      return (await repository.getLocale?.()) ?? 'en';
    } catch {
      return 'en';
    }
  }

  /** LANG / a language name / a menu number while choosing: set and confirm the language. */
  async function languageCommand(text: string, state: string): Promise<SmsResult | null> {
    if (/^(?:lang(?:uage)?|ede|harshe|asusu)$/i.test(text.trim()))
      return result('choosing_language', {}, [textReply(say('languageMenu'))]);
    const picked =
      state === 'choosing_language' && /^[1-5]$/.test(text.trim())
        ? USSD_LANGUAGE_ORDER[Number(text.trim()) - 1]!
        : languageChoice(text);
    if (!picked) return null;
    locale = picked;
    await rememberLocale(picked);
    return result('idle', {}, [textReply(say('languageSet'))]);
  }

  async function process(
    message: string,
    conversation: SmsConversation = { state: 'idle', context: {} },
  ): Promise<SmsResult> {
    const history: Turn[] = Array.isArray(conversation.context?.history)
      ? (conversation.context.history as Turn[]).slice(-HISTORY_TURNS)
      : [];
    locale = await resolveLocale(conversation.context ?? {});
    // Greeting someone in Yoruba, Hausa, Igbo or Pidgin switches to that language.
    const greeted = detectLocale(message);
    if (greeted && greeted !== locale) {
      locale = greeted;
      await rememberLocale(greeted);
    }
    const out =
      (await languageCommand(message, conversation.state)) ??
      (await route(message, conversation, history));
    if (out.state === 'closed') return out;
    const turns: Turn[] = [
      ...history,
      { role: 'user' as const, text: historyText(message) },
      { role: 'assistant' as const, text: historyText(out.replies.map(replyText).join(' ')) },
    ].filter((turn) => turn.text);
    return { ...out, context: { ...out.context, locale, history: turns.slice(-HISTORY_TURNS) } };
  }

  async function route(
    message: string,
    conversation: SmsConversation,
    history: Turn[],
  ): Promise<SmsResult> {
    const text = message.trim();
    const { state } = conversation;
    const { history: _history, historyEnvelope: _envelope, ...context } = conversation.context ?? {};
    if (/^(CANCEL|STOP)$/i.test(text)) {
      if (/^STOP$/i.test(text)) await repository.setOptOut(true);
      return result('closed', {}, [
        {
          kind: 'text',
          allowAfterStop: true,
          text: 'Current interaction ended. A future message from you starts a new request. No unsolicited health messages will be sent.',
        },
      ]);
    }
    await repository.setOptOut(false);
    // In a live chat ("chat" state) short replies such as "2", "ok" or "what?" answer the
    // assistant's last question, so they go to the conversation, not to menu shortcuts.
    const inChat = state === 'chat' && assistant.converse !== undefined;
    if (MENU_PATTERN.test(text) && !(inChat && !/^(help|menu)$/i.test(text)))
      return result('menu', {}, [textReply(say('help'))]);
    if (isPotentiallyUrgent(text)) return urgent();
    if (/^LOOKUP(?:\s|$)/i.test(text)) {
      const code = text.replace(/^LOOKUP\s*/i, '').replace(/[\s-]/g, '');
      if (/^\d{8}$/.test(code))
        return idle(
          'That is a 1-hour access code. Dial the HealthAccess USSD code and choose 2 (Open shared health info), or enter it on the HealthAccess website.',
        );
      if (!/^\d{12}$/.test(code))
        return idle('Send LOOKUP followed by the 12-digit emergency code, for example LOOKUP 1234 5678 9012.');
      const codeDigest = crypto.digestCode(code);
      if (!codeDigest) return idle(UNAVAILABLE);
      const projection = await repository.readEmergency(codeDigest);
      if (!projection?.available || !projection.fields?.length) return idle(UNAVAILABLE);
      // Re-resolve in the sending worker; a queued record is not an authorization snapshot.
      return result('idle', {}, [{ kind: 'emergency', codeDigest }]);
    }
    if (/^(?:MY\s+)?(?:ACCESS\s+|PATIENT\s+|EMERGENCY\s+)?CODE$/i.test(text)) return myCode();
    if (/^NEW\s+CODE$/i.test(text)) return newCode();
    if (/\d{6,}/.test(text.replace(/[\s-]/g, '')) && /\d{3,}[\s-]?\d{3,}/.test(text))
      return idle(
        'Please do not send codes or phone numbers in a question. To view someone\'s emergency information, send LOOKUP <12-digit code>.',
      );
    if (/^MORE$/i.test(text)) {
      return state === 'showing_results' || state === 'showing_emergency'
        ? showResult(context, (context.resultIndex || 0) + 1, state)
        : idle(say('noList'));
    }
    const emergency = /^EMERGENCY\b\s*(.*)$/i.exec(text);
    if (emergency) {
      const area = emergency[1].replace(/^near\b\s*/i, '').trim();
      if (!area) return startEmergency();
      if (!validEmergencyArea(area))
        return result('awaiting_emergency_area', {}, [
          textReply('Reply with your area or a nearby landmark. Call 112 now if life-threatening.'),
        ]);
      return emergencySearch(area);
    }
    if (state === 'awaiting_emergency_area') {
      if (/^(YES|Y)$/i.test(text)) return startEmergency();
      if (!validEmergencyArea(text))
        return result(state, {}, [
          textReply('Reply with your area or a nearby landmark. Call 112 now if life-threatening.'),
        ]);
      return emergencySearch(text);
    }
    const services = await repository.listServices();
    const find = /^FIND(?:\s+(.+?))?(?:\s+(?:near|in|at)\s+(.+))?$/i.exec(text);
    if (find) return findCare(resolveService(find[1] || '', services), find[2] || null);
    if (/^ASK(?:\s|$)/i.test(text)) {
      const question = text.replace(/^ASK\s*/i, '');
      if (!question)
        return result('awaiting_question', {}, [
          textReply(say('askQuestion')),
        ]);
      return answerQuestion(question);
    }
    if (state === 'menu' && /^[1-4]$/.test(text)) {
      if (text === '1') return findCare(null, null);
      if (text === '2') return startEmergency();
      if (text === '3')
        return result('awaiting_question', {}, [
          textReply(say('askQuestion')),
        ]);
      return myCode();
    }
    if (state === 'awaiting_question') return answerQuestion(text);
    if (state === 'awaiting_profile_confirmation') {
      if (!/^(YES|NO|Y|N)$/i.test(text))
        return result(state, context, [textReply('Reply YES or NO, or CANCEL.')]);
      return findCare(
        context.serviceCode,
        null,
        { ...context, skipProfile: /^NO?$/i.test(text) },
        /^Y(ES)?$/i.test(text),
      );
    }
    if (state === 'awaiting_service') {
      const selected = /^\d+$/.test(text)
        ? services[Number(text) - 1]?.service_code
        : resolveService(text, services);
      if (selected || /^\d+$/.test(text)) return findCare(selected, null);
    }
    if (state === 'awaiting_area' && text.length <= 64 && !/\?$/.test(text)) {
      if (/^(YES|Y)$/i.test(text) && context.suggestedAreaId)
        return findCare(context.serviceCode, null, {
          areaId: context.suggestedAreaId,
          areaLabel: context.suggestedAreaLabel,
        } as SmsContext);
      return findCare(context.serviceCode, text);
    }
    if (state === 'awaiting_area_choice') {
      const index = Number(text) - 1;
      const selected = /^\d+$/.test(text) ? context.areaIds?.[index] : undefined;
      if (!selected)
        return result(state, context, [
          textReply('Reply with one of the offered area numbers, or CANCEL.'),
        ]);
      return findCare(context.serviceCode, null, {
        areaId: selected,
        areaLabel: areaContext(context).areaLabels?.[index],
      } as SmsContext);
    }
    if (!inChat && GREETING_PATTERN.test(text)) return result('menu', {}, [textReply(say('greeting'))]);
    if (!inChat && THANKS_PATTERN.test(text))
      return idle(say('thanks'));

    if (assistant.converse) {
      const saved = await savedArea();
      const reply = await assistant.converse(text, {
        services,
        history,
        savedAreaLabel: saved?.label ?? null,
        language: LANGUAGE_NAMES[locale],
      });
      if (reply) {
        // The person wrote in another supported language: answer in it from now on.
        const detected = toLocale(reply.language);
        if (detected && detected !== locale && text.split(/\s+/).length >= 3) {
          locale = detected;
          await rememberLocale(detected);
        }
        if (reply.intent === 'emergency') {
          if (reply.location_query && validEmergencyArea(reply.location_query))
            return emergencySearch(reply.location_query, reply.reply ?? undefined);
          return urgent(reply.reply ?? say('urgent'));
        }
        if (reply.intent === 'find_care') {
          // Most people just want "a clinic": default to general care instead of asking.
          const service =
            reply.service_code ??
            (services.some((item) => item.service_code === 'general') ? 'general' : null);
          if (!service || reply.location_query) return findCare(service, reply.location_query);
          if (reply.reply) return result('awaiting_area', { serviceCode: service }, [textReply(reply.reply)]);
          return findCare(service, null);
        }
        if (reply.intent === 'health_question') {
          const answer = await assistant.answer(reply.question ?? text, {
            personal: await personalHints(),
            language: LANGUAGE_NAMES[locale],
            labels: { source: say('source'), note: say('sourceNote') },
          });
          if ((answer as { kind?: string }).kind === 'fallback')
            return result('chat', {}, [
              textReply(reply.reply ? `${reply.reply} ${say('generalInfo')}` : say('fallback')),
            ]);
          return result('chat', {}, [textReply(answer.text)]);
        }
        if (reply.intent === 'my_code') return myCode();
        if (reply.reply) return result('chat', {}, [textReply(reply.reply)]);
        // A reply we could not use mid-conversation: keep chatting, never the menu.
        if (inChat) return result('chat', {}, [textReply(say('tryAgain'))]);
      } else if (assistant.available?.() !== false && (inChat || text.split(/\s+/).length >= 2)) {
        // The AI is configured but slow or failing. Do not show the numbered menu here:
        // the person's next reply ("4", "2 days") would be read as a menu choice.
        return result('chat', {}, [textReply(say('tryAgain'))]);
      }
      return result('menu', {}, [textReply(say('help'))]);
    }

    const interpreted = await assistant.classify(text, { services });
    if (interpreted.intent === 'find_care') {
      const service = services.some((s) => s.service_code === interpreted.service_code)
        ? interpreted.service_code
        : null;
      return findCare(service, interpreted.location_query);
    }
    if (interpreted.intent === 'health_question') return answerQuestion(text);
    return interpreted.question ? idle(interpreted.question) : result('menu', {}, [textReply(say('help'))]);
  }
  return { process };
}
