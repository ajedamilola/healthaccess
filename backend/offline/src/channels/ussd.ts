import type { Config } from '../config.js';
import type { Crypto } from '../security/crypto.js';
import type {
  Area,
  Facility,
  OwnCodes,
  Projection,
  QuickGrantResult,
  RecordField,
  Service,
  WebLead,
} from '../types.js';
import { fieldText } from './render.js';
import { USSD_LANGUAGE_ORDER, toLocale, u, type Locale } from './i18n.js';

export type UssdState =
  | 'MAIN'
  | 'CARE_SERVICE'
  | 'CARE_LOCATION'
  | 'CARE_AREA_CHOICE'
  | 'CARE_PROFILE_CONFIRM'
  | 'CARE_RESULTS'
  | 'CARE_NO_MATCH'
  | 'EMERGENCY_CODE'
  | 'GRANT_PATIENT_CODE'
  | 'GRANT_ACCESS_CODE'
  | 'RECORD_PAGE'
  | 'MY_CODE'
  | 'END';

export interface UssdCursor {
  fieldKey: string;
  itemIndex?: number;
  partIndex?: number;
}

export interface UssdContext {
  kind?: string;
  serviceCode?: string;
  serviceCodes?: string[];
  serviceLabels?: string[];
  areaId?: string;
  areaLabel?: string;
  resultKind?: 'directory' | 'web';
  choices?: Area[];
  truncated?: boolean;
  consentId?: string;
  patientCodeDigest?: string;
  recordKind?: 'emergency' | 'grant';
  codeDigest?: string;
  cursor?: UssdCursor | null;
  pageNo?: number;
  viewDigest?: string;
  radiusKm?: number;
  resultIds?: string[];
  resultIndex?: number;
  seenIds?: string[];
  widenSteps?: number;
  reason?: 'none' | 'exhausted';
  emergencyDescription?: string;
  savedAreaId?: string;
  savedAreaLabel?: string;
  /** Session language (en, pcm, yo, ha, ig), cached after the first lookup. */
  locale?: string;
  terminalKind?:
    | 'goodbye'
    | 'sms_requested'
    | 'unavailable'
    | 'expired'
    | 'invalid_limit'
    | 'protected';
  safeText?: string;
  meta?: { invalidAttempts?: number };
}

export interface UssdSession {
  id: string;
  providerSessionId: string;
  phoneDigest: string;
  serviceCode: string;
  state: UssdState;
  context: UssdContext;
  expiresAt: string | Date;
  readSessionId?: string | null;
}

export interface UssdResult {
  state: UssdState;
  context: UssdContext;
  response: string;
  terminal: boolean;
  sensitive: boolean;
  readSessionId: string | null;
}

export interface UssdRepository {
  listServices(): Promise<Service[]>;
  findAreas(query: string): Promise<Area[]>;
  findFacilities(serviceCode: string, areaId: string, radiusKm: number): Promise<Facility[]>;
  getFacility(
    id: string,
    serviceCode: string,
    areaId: string,
    radiusKm: number,
  ): Promise<Facility | null>;
  readEmergency(codeDigest: string): Promise<Projection>;
  /** patientDigest is null when the temporary code alone identifies the patient. */
  openGrant(patientDigest: string | null, grantDigest: string): Promise<Projection>;
  readGrant(readSessionId: string): Promise<Projection>;
  closeReadSession(readSessionId: string): Promise<void>;
  findProfileConsent(): Promise<{ id: string } | null>;
  readMatchingContext(consentId: string): Promise<{ available: boolean } | null>;
  /** Linked patient's home area, available only through a live profile-use consent. */
  findSavedArea?(): Promise<{ id: string; label: string } | null>;
  getLocale?(): Promise<Locale>;
  setLocale?(locale: Locale): Promise<void>;
  readOwnCodes?(): Promise<OwnCodes>;
  createQuickGrant?(minutes?: number): Promise<QuickGrantResult>;
  queueFacilitySms(facilityId: string): Promise<boolean>;
  storeWebLeads(leads: WebLead[]): Promise<string[]>;
  getWebLead(id: string): Promise<WebLead | null>;
  recordEmergencyRequest(request: {
    channel: 'SMS' | 'USSD';
    area_id: string | null;
    location_text: string;
    results: WebLead[];
  }): Promise<void>;
}

export interface UssdSearch {
  discoverFacilities(input: { serviceLabel: string; area: string }): Promise<WebLead[]>;
  discoverEmergency?(input: { area: string; description?: string }): Promise<WebLead[]>;
}

export type UssdConfig = Pick<
  Config,
  | 'ussdMaxChars'
  | 'ussdMaxInvalidAttempts'
  | 'searchRadiusKm'
  | 'searchMaxRadiusKm'
  | 'profileUseEnabled'
  | 'allowLiveWeb'
>;

export type UssdCrypto = Pick<Crypto, 'digestCode' | 'fingerprint'>;

export interface UssdEngine {
  transition(session: UssdSession, input: string | null): Promise<UssdResult>;
  render(session: UssdSession): Promise<UssdResult>;
  replay(session: UssdSession): Promise<UssdResult>;
}

interface Atom {
  key: string;
  item: number;
  part: number;
  text: string;
}

interface Page {
  text: string;
  start: UssdCursor;
  next: UssdCursor | null;
}

interface Prepared {
  atoms: Atom[];
  digest: string;
  cursor: UssdCursor | null;
  pageNo: number;
  notice: string | null;
  readSessionId: string | null;
}

const MAX_AREA_CHOICES = 4;
const MAX_RESULTS = 3;
const MAX_RECORD_PAGES = 10;
const FOOTER_RESERVE = 28;

const EMERGENCY_DETAILS =
  'CON Emergency help\nWhat is happening? Briefly describe.\nNo names/codes; sent for live search.\nCall 112 if life-threatening.\n0. Back';
const NOT_LINKED =
  'This phone is not linked to HealthAccess. On the website open Channels and verify this number.';
const GRANT_PATIENT = 'CON View shared details\nEnter patient code\n0. Back';
const GRANT_ACCESS = 'CON Enter temporary access code\n0. Back';
const PROFILE = 'CON Use your saved profile for this search?\n1. Yes\n2. No\n0. Back';
const UNAVAILABLE = 'HealthAccess is temporarily unavailable. Please try again.';

function inline(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7e\n]/g, '?')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '; ')
    .trim();
}

function shorten(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  const cut = value.slice(0, max - 3);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

function meta(context: UssdContext): NonNullable<UssdContext['meta']> {
  return context.meta ?? {};
}

function withMeta(context: UssdContext, patch: NonNullable<UssdContext['meta']>): UssdContext {
  return { ...context, meta: { ...meta(context), ...patch } };
}

function acceptedContext(context: UssdContext): UssdContext {
  return withMeta(context, { invalidAttempts: 0 });
}

function attempts(session: UssdSession): number {
  const value = meta(session.context).invalidAttempts;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sessionReadId(session: UssdSession): string | null {
  return session.readSessionId || null;
}

function isExpired(session: UssdSession): boolean {
  const value = new Date(session.expiresAt).getTime();
  return Number.isFinite(value) && value <= Date.now();
}

function digit(token: string): boolean {
  return /^\d$/.test(token);
}

function validArea(token: string): boolean {
  const value = token.trim();
  return (
    value.length > 0 && value.length <= 64 && /^[\x20-\x7e]+$/.test(value) && !/[*#]/.test(value)
  );
}

function validCode(token: string): boolean {
  const value = token.trim();
  return value.length > 0 && value.length <= 32 && /^[A-Za-z0-9]+$/.test(value);
}

function savedAreaLine(label: string | undefined, myArea = 'My area'): string {
  if (!label) return '';
  const text = inline(label);
  return `\n1. ${myArea}: ${text.length > 28 ? `${text.slice(0, 25)}...` : text}`;
}

function withSavedArea(prompt: string, label: string | undefined, myArea = 'My area'): string {
  if (!label) return prompt;
  // The back option is the last "0." line in every language.
  const index = prompt.lastIndexOf('\n0.');
  return index < 0
    ? `${prompt}${savedAreaLine(label, myArea)}`
    : `${prompt.slice(0, index)}${savedAreaLine(label, myArea)}${prompt.slice(index)}`;
}

function areaLabel(area: Area): string {
  const suffix = area.city || area.region;
  return inline(suffix ? `${area.name}, ${suffix}` : area.name);
}

function digestFields(fields: RecordField[], fingerprint: (value: string) => string): string {
  const canonical = fields.map((field) => [
    field.key,
    field.label,
    Array.isArray(field.value) ? field.value : [String(field.value)],
  ]);
  return fingerprint(`record-view:${JSON.stringify(canonical)}`);
}

function atomCursor(atom: Atom): UssdCursor {
  return { fieldKey: atom.key, itemIndex: atom.item, partIndex: atom.part };
}

function atomIndex(atoms: Atom[], cursor: UssdCursor | null | undefined): number {
  if (!cursor) return 0;
  return atoms.findIndex(
    (atom) =>
      atom.key === cursor.fieldKey &&
      atom.item === (cursor.itemIndex ?? -1) &&
      atom.part === (cursor.partIndex ?? 0),
  );
}

function breakAt(text: string, max: number): number {
  const slice = text.slice(0, max);
  for (const separator of ['\n', '. ', '; ', ', ', ' ']) {
    const index = slice.lastIndexOf(separator);
    if (index >= Math.floor(max * 0.5)) return index + separator.length;
  }
  return max;
}

function split(text: string, budget: number, indent: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  let first = true;
  while (remaining.length > (first ? budget : budget - indent.length)) {
    const available = first ? budget : budget - indent.length;
    const cut = Math.max(1, breakAt(remaining, available));
    const chunk = remaining.slice(0, cut).trimEnd();
    if (chunk) chunks.push(first ? chunk : `${indent}${chunk}`);
    remaining = remaining.slice(cut).trimStart();
    first = false;
  }
  if (remaining) chunks.push(first ? remaining : `${indent}${remaining}`);
  return chunks;
}

function buildAtoms(fields: RecordField[], budget: number): Atom[] {
  // Preserve names, medicine units and symbols; never transliterate clinical values.
  const recordText = (value: string) =>
    value
      .normalize('NFC')
      .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const atoms: Atom[] = [];
  for (const field of fields) {
    const label = inline(field.label || field.key) || 'Details';
    if (Array.isArray(field.value)) {
      atoms.push({ key: field.key, item: -1, part: 0, text: `${label}:` });
      const items = field.value.length ? field.value : ['not provided'];
      items.forEach((item, index) => {
        split(`- ${recordText(item)}`, budget, '  ').forEach((text, part) => {
          atoms.push({ key: field.key, item: index, part, text });
        });
      });
      continue;
    }
    let formatted = '';
    try {
      formatted = fieldText([field]);
    } catch {
      formatted = `${label}: ${recordText(String(field.value))}`;
    }
    if (!recordText(formatted)) formatted = `${label}: not provided`;
    split(recordText(formatted), budget, '  ').forEach((text, part) => {
      atoms.push({ key: field.key, item: -1, part, text });
    });
  }
  return atoms;
}

function makePage(
  atoms: Atom[],
  cursor: UssdCursor | null,
  budget: number,
  notice: string | null,
): Page | null {
  const start = atomIndex(atoms, cursor);
  if (start < 0 || start >= atoms.length) return null;
  let shown = notice;
  if (shown && atoms[start].text.length > budget - shown.length - 1) shown = null;
  const effective = budget - (shown ? shown.length + 1 : 0);
  const parts: string[] = [];
  let length = 0;
  let index = start;
  while (index < atoms.length) {
    const addition = (parts.length ? 1 : 0) + atoms[index].text.length;
    if (parts.length && length + addition > effective) break;
    parts.push(atoms[index].text);
    length += addition;
    index += 1;
  }
  return {
    text: `${shown ? `${shown}\n` : ''}${parts.join('\n')}`,
    start: atomCursor(atoms[start]),
    next: index < atoms.length ? atomCursor(atoms[index]) : null,
  };
}

function pageStart(atoms: Atom[], target: number, budget: number): UssdCursor | null {
  if (target <= 1) return null;
  let cursor: UssdCursor | null = null;
  for (let page = 1; page < target; page += 1) {
    const result = makePage(atoms, cursor, budget, null);
    if (!result?.next) return cursor;
    cursor = result.next;
  }
  return cursor;
}

function queueState(value: boolean): 'queued' | 'failed' {
  return value ? 'queued' : 'failed';
}

export function createUssdEngine({
  repository,
  config,
  crypto,
  search: webSearch,
}: {
  repository: UssdRepository;
  config: UssdConfig;
  crypto: UssdCrypto;
  search?: UssdSearch;
}): UssdEngine {
  // Language for this request; the engine is created per callback, so this is not shared.
  let L: Locale = 'en';
  const MAIN_TEXT = () => u(L, 'main');
  const LOCATION_TEXT = () => `CON ${u(L, 'location')}\n${u(L, 'back')}`;
  const EMERGENCY_LOCATION_TEXT = () => `CON ${u(L, 'emergencyLocation')}\n${u(L, 'back')}`;
  const CODE_TEXT = () => `CON ${u(L, 'code')}\n${u(L, 'back')}`;
  const LANGUAGE_TEXT = () => u(L, 'language');
  const maxChars = config.ussdMaxChars;
  const maxInvalid = Math.max(1, config.ussdMaxInvalidAttempts);
  const budget = Math.max(40, maxChars - 4 - FOOTER_RESERVE - 1);

  function bounded(prefix: 'CON' | 'END', body: string): string {
    const text = `${prefix} ${body}`;
    if (text.length <= maxChars) return text;
    const fallback = `${prefix} Service temporarily unavailable.`;
    return fallback.length <= maxChars ? fallback : `${prefix} Unavailable.`;
  }

  function menu(header: string, options: string[]): string | null {
    for (const limit of [60, 40, 28, 20, 14, 10]) {
      const text = `CON ${[header, ...options.map((option) => shorten(option, limit))].join('\n')}`;
      if (text.length <= maxChars) return text;
    }
    return null;
  }

  function makeResult(
    session: UssdSession,
    state: UssdState,
    context: UssdContext,
    response: string,
    options: {
      terminal?: boolean;
      sensitive?: boolean;
      readSessionId?: string | null;
    } = {},
  ): UssdResult {
    let nextState = state;
    // Cache the language in the session so later keypresses skip the lookup.
    let nextContext = repository.getLocale || L !== 'en' ? { ...context, locale: L } : context;
    let nextResponse = response;
    let nextTerminal = options.terminal ?? response.startsWith('END ');
    let nextSensitive = options.sensitive ?? false;
    let nextRead =
      options.readSessionId !== undefined
        ? options.readSessionId
        : state === 'RECORD_PAGE' || context.terminalKind === 'protected'
          ? sessionReadId(session)
          : null;
    if (nextResponse.length > maxChars) {
      nextState = 'END';
      nextContext = { kind: 'end', terminalKind: 'unavailable', safeText: UNAVAILABLE };
      nextResponse = bounded('END', UNAVAILABLE);
      nextTerminal = true;
      nextSensitive = false;
      nextRead = null;
    }
    return {
      state: nextState,
      context: nextContext,
      response: nextResponse,
      terminal: nextTerminal,
      sensitive: nextSensitive,
      readSessionId: nextRead,
    };
  }

  function terminal(
    session: UssdSession,
    text: string,
    kind: NonNullable<UssdContext['terminalKind']>,
    options: {
      sensitive?: boolean;
      readSessionId?: string | null;
      record?: Partial<UssdContext>;
    } = {},
  ): UssdResult {
    const context: UssdContext = {
      kind: 'end',
      terminalKind: kind,
      safeText: options.sensitive ? undefined : text,
      ...options.record,
    };
    return makeResult(session, 'END', context, `END ${text}`, {
      terminal: true,
      sensitive: options.sensitive,
      readSessionId: options.readSessionId ?? null,
    });
  }

  async function closeRead(session: UssdSession): Promise<void> {
    const id = sessionReadId(session);
    if (!id) return;
    try {
      await repository.closeReadSession(id);
    } catch {
      // A cleanup failure must not reveal anything or keep the session reference alive.
    }
  }

  async function unavailable(session: UssdSession): Promise<UssdResult> {
    return terminal(session, UNAVAILABLE, 'unavailable');
  }

  async function expired(session: UssdSession): Promise<UssdResult> {
    await closeRead(session);
    return terminal(session, 'Session expired. Please dial again.', 'expired');
  }

  async function accessError(
    session: UssdSession,
    kind: 'emergency' | 'grant',
  ): Promise<UssdResult> {
    await closeRead(session);
    const text =
      kind === 'grant'
        ? 'That code did not work. It may have expired. Ask for a new code and dial again.'
        : 'That code did not work. Check the digits and dial again.';
    return terminal(session, text, 'unavailable');
  }

  function invalidPrompt(session: UssdSession): string {
    const context = session.context ?? {};
    switch (session.state) {
      case 'MAIN':
        return context.kind === 'language' ? LANGUAGE_TEXT() : MAIN_TEXT();
      case 'CARE_SERVICE':
        return (
          menu('Choose service', [
            ...(context.serviceCodes ?? []).map(
              (code, index) => `${index + 1}. ${context.serviceLabels?.[index] ?? code}`,
            ),
            '0. Back',
          ]) ?? UNAVAILABLE
        );
      case 'CARE_LOCATION':
        return context.kind === 'emergency_area'
          ? EMERGENCY_LOCATION_TEXT().slice(4)
          : context.kind === 'emergency_details'
            ? EMERGENCY_DETAILS.slice(4)
            : LOCATION_TEXT().slice(4);
      case 'CARE_AREA_CHOICE':
        return (
          menu('Choose area', [
            ...(context.choices ?? []).map((area, index) => `${index + 1}. ${areaLabel(area)}`),
            '0. Back',
          ]) ?? UNAVAILABLE
        );
      case 'CARE_PROFILE_CONFIRM':
        return PROFILE.slice(4);
      case 'CARE_RESULTS':
        return context.kind === 'emergency_results'
          ? emergencyOptions(context).join('\n')
          : resultOptions(context, context.resultKind !== 'web').join('\n');
      case 'CARE_NO_MATCH':
        return noMatchOptions(context).join('\n');
      case 'EMERGENCY_CODE':
        return CODE_TEXT().slice(4);
      case 'MY_CODE':
        return '1. Get a 1-hour code\n0. Back';
      case 'GRANT_PATIENT_CODE':
        return GRANT_PATIENT.slice(4);
      case 'GRANT_ACCESS_CODE':
        return GRANT_ACCESS.slice(4);
      case 'RECORD_PAGE':
        return recordFooter((context.pageNo ?? 1) > 1).join('\n');
      default:
        return UNAVAILABLE;
    }
  }

  async function invalid(
    session: UssdSession,
    prompt = invalidPrompt(session),
  ): Promise<UssdResult> {
    const count = attempts(session) + 1;
    if (count >= maxInvalid) {
      await closeRead(session);
      return terminal(session, 'Too many invalid attempts. Please dial again.', 'invalid_limit');
    }
    const context = withMeta(session.context ?? {}, { invalidAttempts: count });
    return makeResult(
      session,
      session.state,
      context,
      bounded('CON', `${u(L, 'invalid')}\n${prompt}`),
      {
        terminal: false,
        readSessionId: sessionReadId(session),
      },
    );
  }

  function canWiden(context: UssdContext): boolean {
    return (
      (context.widenSteps ?? 0) < 2 &&
      (context.radiusKm ?? config.searchRadiusKm) < config.searchMaxRadiusKm
    );
  }

  function resultOptions(context: UssdContext, facility: boolean): string[] {
    const next = (context.resultIndex ?? 0) + 1 < (context.resultIds?.length ?? 0);
    const first = next
      ? context.resultKind === 'web'
        ? '1. Next result'
        : '1. Next hospital'
      : context.resultKind === 'web'
        ? '1. Another area'
        : canWiden(context)
          ? '1. Wider search'
          : '1. Another area';
    return facility ? [first, '2. Send details by SMS', '0. Exit'] : [first, '0. Exit'];
  }

  function emergencyOptions(context: UssdContext): string[] {
    const next = (context.resultIndex ?? 0) + 1 < (context.resultIds?.length ?? 0);
    return next ? ['1. Next', '0. Exit'] : ['1. Another area', '0. Exit'];
  }

  function noMatchOptions(context: UssdContext): string[] {
    return [...(canWiden(context) ? ['1. Wider search'] : []), '2. Another area', '0. Exit'];
  }

  function recordFooter(back: boolean): string[] {
    return ['1. Next', ...(back ? ['2. Back'] : []), '0. Exit'];
  }

  function recordContext(
    context: UssdContext,
    cursor: UssdCursor,
    pageNo: number,
    digest: string,
  ): UssdContext {
    return acceptedContext({
      kind: 'record_page',
      recordKind: context.recordKind,
      codeDigest: context.recordKind === 'emergency' ? context.codeDigest : undefined,
      cursor,
      pageNo,
      viewDigest: digest,
    });
  }

  function composeRecord(
    session: UssdSession,
    base: UssdContext,
    prepared: Prepared,
    page: Page,
    pageNo: number,
  ): UssdResult {
    const active =
      base.recordKind === 'grant'
        ? sessionReadId(session)
        : prepared.readSessionId || sessionReadId(session);
    if (base.recordKind === 'grant' && !active) {
      return terminal(session, 'Shared details are no longer available.', 'unavailable');
    }
    if (page.next) {
      return makeResult(
        session,
        'RECORD_PAGE',
        recordContext(base, page.start, pageNo, prepared.digest),
        bounded('CON', `${page.text}\n${recordFooter(pageNo > 1).join('\n')}`),
        {
          terminal: false,
          sensitive: true,
          readSessionId: active,
        },
      );
    }
    const end = 'End of details.';
    const body =
      page.text.length + end.length + 1 <= maxChars - 4 ? `${page.text}\n${end}` : page.text;
    return makeResult(
      session,
      'END',
      {
        kind: 'end',
        terminalKind: 'protected',
        recordKind: base.recordKind,
        codeDigest: base.recordKind === 'emergency' ? base.codeDigest : undefined,
        cursor: page.start,
        pageNo,
        viewDigest: prepared.digest,
      },
      `END ${body}`,
      {
        terminal: true,
        sensitive: true,
        readSessionId: active,
      },
    );
  }

  function prepare(projection: Projection, context: UssdContext): Prepared | null {
    const fields = projection.fields ?? [];
    if (!fields.length) return null;
    const atoms = buildAtoms(fields, budget);
    if (!atoms.length) return null;
    const digest = digestFields(fields, crypto.fingerprint);
    let cursor = context.cursor ?? null;
    let pageNo = context.pageNo ?? 1;
    let notice: string | null = null;
    if (context.viewDigest && context.viewDigest !== digest && (cursor || pageNo > 1)) {
      cursor = null;
      pageNo = 1;
      notice = 'Details changed.';
    }
    if (cursor && atomIndex(atoms, cursor) < 0) {
      cursor = null;
      pageNo = 1;
      notice = 'Details changed.';
    }
    return {
      atoms,
      digest,
      cursor,
      pageNo,
      notice,
      readSessionId: projection.read_session_id ?? null,
    };
  }

  function projectionResult(
    session: UssdSession,
    context: UssdContext,
    projection: Projection,
  ): UssdResult {
    const prepared = prepare(projection, context);
    if (!prepared) {
      return terminal(
        session,
        context.recordKind === 'grant'
          ? 'Shared details are no longer available.'
          : 'Emergency summary unavailable.',
        'unavailable',
      );
    }
    if (prepared.pageNo > MAX_RECORD_PAGES) {
      return terminal(
        session,
        'Too much information to display here. Use the online portal.',
        'unavailable',
      );
    }
    const page = makePage(prepared.atoms, prepared.cursor, budget, prepared.notice);
    if (!page) {
      return terminal(
        session,
        context.recordKind === 'grant'
          ? 'Shared details are no longer available.'
          : 'Emergency summary unavailable.',
        'unavailable',
      );
    }
    return composeRecord(session, context, prepared, page, prepared.pageNo);
  }

  async function loadRecord(
    session: UssdSession,
    context: UssdContext,
  ): Promise<Projection | null> {
    try {
      if (context.recordKind === 'grant') {
        const id = sessionReadId(session);
        return id ? await repository.readGrant(id) : null;
      }
      if (context.recordKind === 'emergency' && context.codeDigest) {
        return await repository.readEmergency(context.codeDigest);
      }
      return null;
    } catch {
      return null;
    }
  }

  async function recordResult(session: UssdSession, context: UssdContext): Promise<UssdResult> {
    const projection = await loadRecord(session, context);
    if (!projection?.available || !projection.fields?.length) {
      return accessError(session, context.recordKind ?? 'grant');
    }
    return projectionResult(session, context, projection);
  }

  async function facility(context: UssdContext): Promise<Facility | null> {
    const id = (context.resultIds ?? [])[context.resultIndex ?? 0];
    if (!id) return null;
    try {
      if (!context.serviceCode || !context.areaId) return null;
      return await repository.getFacility(
        id,
        context.serviceCode,
        context.areaId,
        context.radiusKm ?? config.searchRadiusKm,
      );
    } catch {
      return null;
    }
  }

  async function webLead(context: UssdContext): Promise<WebLead | null> {
    const id = (context.resultIds ?? [])[context.resultIndex ?? 0];
    if (!id) return null;
    try {
      return await repository.getWebLead(id);
    } catch {
      return null;
    }
  }

  function webLeadMessage(item: WebLead, options: string[]): string {
    const name = `Unverified live lead: ${inline(item.name) || 'Listing'}`;
    const address = inline(item.address);
    const contact = item.phone ? `Phone: ${inline(item.phone)}` : 'Phone not listed.';
    const footer = options.join('\n');
    const build = (line: string) => `CON ${[name, line, contact, footer].join('\n')}`;
    let text = build(address);
    if (text.length > maxChars) {
      const fixed = ['CON', name, contact, footer].join('\n').length;
      text = build(shorten(address, Math.max(12, maxChars - fixed - 2)));
    }
    if (text.length > maxChars) {
      text = `CON ${[shorten(name, 36), contact, options[options.length - 1]].join('\n')}`;
    }
    return text.length <= maxChars ? text : bounded('END', UNAVAILABLE);
  }

  function emergencyLeadMessage(
    item: WebLead,
    options: string[],
    index: number,
    total: number,
  ): string {
    const position = `Unverified live lead ${index + 1}/${total || 1}`;
    const header = `Call 112 now if life-threatening. ${position}.`;
    const name = inline(item.name) || 'Emergency listing';
    const address = inline(item.address);
    const contact = item.phone ? `Phone: ${inline(item.phone)}` : 'Phone not listed.';
    const footer = options.join('\n');
    const build = (line: string) => `CON ${[header, name, line, contact, footer].join('\n')}`;
    let text = build(address);
    if (text.length > maxChars) {
      const fixed = ['CON', header, name, contact, footer].join('\n').length;
      text = build(shorten(address, Math.max(12, maxChars - fixed - 2)));
    }
    if (text.length > maxChars) {
      text = `CON ${[header, shorten(name, 32), contact, options[options.length - 1]].join('\n')}`;
    }
    return text.length <= maxChars
      ? text
      : bounded('END', 'Call 112 now or go to the nearest emergency department.');
  }

  function facilityMessage(item: Facility, options: string[]): string {
    const name = `${item.is_demo ? 'DEMO: ' : ''}${inline(item.name) || 'Hospital'}`;
    const address = inline(item.address);
    const contact = item.phone ? `Contact: ${inline(item.phone)}` : 'Contact not listed.';
    const distance =
      Number.isFinite(Number(item.distance_km)) && item.distance_km !== null
        ? `Approx. ${Number(item.distance_km).toFixed(1)} km from area centre.`
        : '';
    const footer = options.join('\n');
    const build = (line: string, showDistance: boolean) =>
      `CON ${[name, line, contact, showDistance ? distance : '', footer].filter(Boolean).join('\n')}`;
    let text = build(address, true);
    if (text.length > maxChars) text = build(address, false);
    if (text.length > maxChars) {
      const fixed = ['CON', name, contact, footer].filter(Boolean).join('\n').length;
      text = build(shorten(address, Math.max(12, maxChars - fixed - 2)), false);
    }
    if (text.length > maxChars) {
      text = `CON ${[shorten(name, 40), '2. Send details by SMS', '0. Exit'].join('\n')}`;
    }
    return text.length <= maxChars ? text : bounded('END', UNAVAILABLE);
  }

  async function results(
    session: UssdSession,
    context: UssdContext,
    preserve = false,
  ): Promise<UssdResult> {
    const nextContext = preserve ? context : acceptedContext(context);
    if (context.resultKind === 'web') {
      const lead = await webLead(context);
      if (!lead) {
        const response =
          menu('This web listing is no longer available.', resultOptions(context, false)) ??
          bounded('END', UNAVAILABLE);
        return makeResult(session, 'CARE_RESULTS', nextContext, response);
      }
      return makeResult(
        session,
        'CARE_RESULTS',
        nextContext,
        webLeadMessage(lead, resultOptions(context, false)),
      );
    }
    const item = await facility(context);
    if (!item) {
      const response =
        menu('This facility is no longer listed.', resultOptions(context, false)) ??
        bounded('END', UNAVAILABLE);
      return makeResult(session, 'CARE_RESULTS', nextContext, response);
    }
    return makeResult(
      session,
      'CARE_RESULTS',
      nextContext,
      facilityMessage(item, resultOptions(context, true)),
    );
  }

  async function emergencyResults(
    session: UssdSession,
    context: UssdContext,
    preserve = false,
  ): Promise<UssdResult> {
    const nextContext = preserve ? context : acceptedContext(context);
    const lead = await webLead(context);
    if (!lead) {
      return terminal(
        session,
        'Emergency listing unavailable. Call 112 now or go to the nearest emergency department.',
        'unavailable',
      );
    }
    return makeResult(
      session,
      'CARE_RESULTS',
      nextContext,
      emergencyLeadMessage(
        lead,
        emergencyOptions(context),
        context.resultIndex ?? 0,
        context.resultIds?.length ?? 0,
      ),
    );
  }

  function emergencyArea(
    session: UssdSession,
    emergencyDescription?: string,
    preserve = false,
    saved?: { id: string; label: string } | null,
  ): UssdResult {
    const savedAreaId = saved?.id ?? session.context.savedAreaId;
    const savedAreaLabel = saved?.label ?? session.context.savedAreaLabel;
    const context: UssdContext = {
      kind: 'emergency_area',
      emergencyDescription: emergencyDescription ?? session.context.emergencyDescription,
      ...(savedAreaId && savedAreaLabel ? { savedAreaId, savedAreaLabel } : {}),
    };
    return makeResult(
      session,
      'CARE_LOCATION',
      preserve ? { ...session.context, ...context } : acceptedContext(context),
      withSavedArea(EMERGENCY_LOCATION_TEXT(), context.savedAreaLabel, u(L, 'myArea')),
    );
  }

  async function savedArea(): Promise<{ id: string; label: string } | null> {
    try {
      return (await repository.findSavedArea?.()) ?? null;
    } catch {
      return null;
    }
  }

  async function emergencySearch(
    session: UssdSession,
    area: string,
    emergencyDescription?: string,
  ): Promise<UssdResult> {
    let leads: WebLead[] = [];
    if (config.allowLiveWeb && webSearch?.discoverEmergency) {
      try {
        leads = (await webSearch.discoverEmergency({ area, description: emergencyDescription }))
          .slice(0, 8);
      } catch {
        leads = [];
      }
    }
    try {
      await repository.recordEmergencyRequest({
        channel: 'USSD',
        area_id: null,
        location_text: area,
        results: leads,
      });
    } catch {
      // Telemetry is best-effort and must not hide emergency guidance.
    }
    if (!leads.length) {
      return terminal(
        session,
        'No live emergency listing found. Call 112 now or go to the nearest emergency department.',
        'unavailable',
      );
    }
    let ids: string[] = [];
    try {
      ids = await repository.storeWebLeads(leads);
    } catch {
      ids = [];
    }
    if (!ids.length) {
      return terminal(
        session,
        'Emergency listing unavailable. Call 112 now or go to the nearest emergency department.',
        'unavailable',
      );
    }
    return emergencyResults(session, {
      kind: 'emergency_results',
      areaLabel: area,
      emergencyDescription,
      resultIds: ids,
      resultIndex: 0,
    });
  }

  async function careWebFallback(
    session: UssdSession,
    serviceCode: string,
    area: string | null | undefined,
    radius: number,
    seen: string[],
    widenSteps: number,
  ): Promise<UssdResult | null> {
    if (!config.allowLiveWeb || !webSearch || !area) return null;
    let serviceLabel: string | undefined;
    try {
      serviceLabel = (await repository.listServices()).find(
        (service) => service.service_code === serviceCode,
      )?.label;
    } catch {
      return null;
    }
    if (!serviceLabel) return null;
    let leads: WebLead[];
    try {
      leads = await webSearch.discoverFacilities({ serviceLabel, area });
    } catch {
      return null;
    }
    if (!leads.length) return null;
    let ids: string[];
    try {
      ids = await repository.storeWebLeads(leads);
    } catch {
      return null;
    }
    if (!ids.length) return null;
    return results(session, {
      kind: 'care_results',
      resultKind: 'web',
      serviceCode,
      areaId: undefined,
      areaLabel: area,
      radiusKm: radius,
      resultIds: ids,
      resultIndex: 0,
      seenIds: [...new Set([...seen, ...ids])],
      widenSteps,
    });
  }

  async function noMatch(
    session: UssdSession,
    context: UssdContext,
    preserve = false,
  ): Promise<UssdResult> {
    const header =
      context.reason === 'exhausted' ? 'No more hospitals nearby.' : 'No suitable hospital found.';
    const response = menu(header, noMatchOptions(context)) ?? bounded('END', UNAVAILABLE);
    return makeResult(
      session,
      'CARE_NO_MATCH',
      preserve ? context : acceptedContext(context),
      response,
    );
  }

  async function search(
    session: UssdSession,
    serviceCode: string,
    areaId: string,
    radius = config.searchRadiusKm,
    seen: string[] = [],
    widenSteps = 0,
    areaLabel?: string,
  ): Promise<UssdResult> {
    let found: Facility[];
    try {
      found = await repository.findFacilities(serviceCode, areaId, radius);
    } catch {
      return unavailable(session);
    }
    const ids = found
      .slice(0, MAX_RESULTS)
      .map((item) => item.id)
      .filter(Boolean);
    if (!ids.length) {
      const web = await careWebFallback(
        session,
        serviceCode,
        areaLabel,
        radius,
        seen,
        widenSteps,
      );
      if (web) return web;
      return noMatch(session, {
        kind: 'care_no_match',
        serviceCode,
        areaId,
        radiusKm: radius,
        seenIds: [...new Set(seen)],
        widenSteps,
        reason: 'none',
      });
    }
    return results(session, {
      kind: 'care_results',
      resultKind: 'directory',
      serviceCode,
      areaId,
      areaLabel,
      radiusKm: radius,
      resultIds: ids,
      resultIndex: 0,
      seenIds: [...new Set([...seen, ...ids])],
      widenSteps,
    });
  }

  async function widen(session: UssdSession, context: UssdContext): Promise<UssdResult> {
    const { serviceCode, areaId } = context;
    if (!serviceCode || !areaId) return unavailable(session);
    let radius = context.radiusKm ?? config.searchRadiusKm;
    let widenSteps = context.widenSteps ?? 0;
    const seen = context.seenIds ?? [];
    while (widenSteps < 2 && radius < config.searchMaxRadiusKm) {
      radius = Math.min(radius * 2, config.searchMaxRadiusKm);
      widenSteps += 1;
      let found: Facility[];
      try {
        found = await repository.findFacilities(serviceCode, areaId, radius);
      } catch {
        return unavailable(session);
      }
      const ids = found
        .map((item) => item.id)
        .filter((id) => id && !seen.includes(id))
        .slice(0, MAX_RESULTS);
      if (ids.length) {
        return results(session, {
          kind: 'care_results',
          resultKind: 'directory',
          serviceCode,
          areaId,
          areaLabel: context.areaLabel,
          radiusKm: radius,
          resultIds: ids,
          resultIndex: 0,
          seenIds: [...new Set([...seen, ...ids])],
          widenSteps,
        });
      }
    }
    const web = await careWebFallback(
      session,
      serviceCode,
      context.areaLabel,
      radius,
      seen,
      widenSteps,
    );
    if (web) return web;
    return noMatch(session, {
      kind: 'care_no_match',
      serviceCode,
      areaId,
      radiusKm: radius,
      seenIds: seen,
      widenSteps,
      reason: 'exhausted',
    });
  }

  async function services(session: UssdSession, preserve = false): Promise<UssdResult> {
    let found: Service[];
    try {
      found = (await repository.listServices()).slice(0, 3);
    } catch {
      return unavailable(session);
    }
    if (!found.length) return unavailable(session);
    const options = [
      ...found.map((service, index) => `${index + 1}. ${inline(service.label)}`),
      '0. Back',
    ];
    const response = menu(u(L, 'chooseService'), options) ?? bounded('END', UNAVAILABLE);
    const context: UssdContext = {
      kind: 'care_service',
      serviceCodes: found.map((service) => service.service_code),
      serviceLabels: found.map((service) => inline(service.label)),
    };
    return makeResult(
      session,
      'CARE_SERVICE',
      preserve ? { ...session.context, ...context } : acceptedContext(context),
      response,
    );
  }

  function areas(session: UssdSession, serviceCode: string, found: Area[]): UssdResult {
    let visible = found.slice(0, MAX_AREA_CHOICES);
    let truncated = found.length > visible.length;
    let response: string | null = null;
    while (visible.length && !response) {
      response = menu(truncated ? 'Choose area\nMore matches exist' : 'Choose area', [
        ...visible.map((area, index) => `${index + 1}. ${areaLabel(area)}`),
        '0. Back',
      ]);
      if (!response) {
        visible = visible.slice(0, -1);
        truncated = true;
      }
    }
    if (!response) return terminal(session, UNAVAILABLE, 'unavailable');
    return makeResult(
      session,
      'CARE_AREA_CHOICE',
      acceptedContext({
        kind: 'care_area_choice',
        serviceCode,
        choices: visible,
        truncated,
      }),
      response,
    );
  }

  function grouped(code: string): string {
    return code.replace(/(\d{4})(?=\d)/g, '$1 ');
  }

  function myCodeMenu(code: string, empty = false): string {
    const note = empty
      ? 'It shows nothing yet: pick your emergency summary on the website.'
      : 'Anyone can view your emergency info with it.';
    return `Your emergency code:\n${grouped(code)}\n${note}\n1. Get a 1-hour code\n0. Back`;
  }

  async function myCode(session: UssdSession): Promise<UssdResult> {
    let codes: OwnCodes;
    try {
      codes = (await repository.readOwnCodes?.()) ?? { linked: false };
    } catch {
      return unavailable(session);
    }
    if (!codes.linked) return terminal(session, NOT_LINKED, 'goodbye');
    return makeResult(
      session,
      'MY_CODE',
      acceptedContext({ kind: 'my_code' }),
      bounded('CON', myCodeMenu(codes.patientCode, codes.summaryFields === 0)),
      { sensitive: true },
    );
  }

  async function openTemporaryCode(session: UssdSession, code: string): Promise<UssdResult> {
    const grantDigest = await crypto.digestCode(code, 'grant');
    if (!grantDigest) return invalid(session, CODE_TEXT().slice(4));
    let opened: Projection;
    try {
      opened = await repository.openGrant(null, grantDigest);
    } catch {
      return accessError(session, 'grant');
    }
    if (!opened.available || !opened.read_session_id) return accessError(session, 'grant');
    const withRead: UssdSession = { ...session, readSessionId: opened.read_session_id };
    let projection: Projection;
    try {
      projection = await repository.readGrant(opened.read_session_id);
    } catch {
      await closeRead(withRead);
      return accessError(withRead, 'grant');
    }
    if (!projection.available || !projection.fields?.length) {
      await closeRead(withRead);
      return accessError(withRead, 'grant');
    }
    return projectionResult(
      withRead,
      { kind: 'record_page', recordKind: 'grant', cursor: null, pageNo: 1 },
      projection,
    );
  }

  async function quickCode(session: UssdSession): Promise<UssdResult> {
    let created: QuickGrantResult;
    try {
      created = (await repository.createQuickGrant?.(60)) ?? { status: 'not_linked' };
    } catch {
      return unavailable(session);
    }
    if (created.status === 'not_linked') return terminal(session, NOT_LINKED, 'goodbye');
    if (created.status === 'nothing_to_share')
      return terminal(
        session,
        'Add your health information on the website first, then dial again.',
        'goodbye',
      );
    return terminal(
      session,
      `Your 1-hour code:\n${grouped(created.code)}\nGive it to your doctor. It opens your emergency info on USSD or the web.`,
      'protected',
      { sensitive: true },
    );
  }

  function location(
    session: UssdSession,
    serviceCode: string,
    preserve = false,
    saved?: { id: string; label: string } | null,
  ): UssdResult {
    const savedAreaId = saved?.id ?? session.context.savedAreaId;
    const savedAreaLabel = saved?.label ?? session.context.savedAreaLabel;
    const context: UssdContext = {
      kind: 'care_location',
      serviceCode,
      ...(savedAreaId && savedAreaLabel ? { savedAreaId, savedAreaLabel } : {}),
    };
    return makeResult(
      session,
      'CARE_LOCATION',
      preserve ? { ...session.context, ...context } : acceptedContext(context),
      withSavedArea(LOCATION_TEXT(), context.savedAreaLabel, u(L, 'myArea')),
    );
  }

  async function current(session: UssdSession): Promise<UssdResult> {
    if (isExpired(session)) return expired(session);
    const context = session.context ?? {};
    switch (session.state) {
      case 'MAIN':
        if (context.kind === 'language')
          return makeResult(session, 'MAIN', context, bounded('CON', LANGUAGE_TEXT()));
        return makeResult(session, 'MAIN', { ...context, kind: 'main' }, bounded('CON', MAIN_TEXT()));
      case 'CARE_SERVICE':
        return services(session, true);
      case 'CARE_LOCATION':
        if (context.kind === 'emergency_area') return emergencyArea(session, undefined, true);
        if (context.kind === 'emergency_details')
          return makeResult(session, 'CARE_LOCATION', context, EMERGENCY_DETAILS);
        return location(session, context.serviceCode ?? '', true);
      case 'CARE_AREA_CHOICE': {
        const response =
          menu(context.truncated ? 'Choose area\nMore matches exist' : 'Choose area', [
            ...(context.choices ?? []).map((area, index) => `${index + 1}. ${areaLabel(area)}`),
            '0. Back',
          ]) ?? bounded('END', UNAVAILABLE);
        return makeResult(session, 'CARE_AREA_CHOICE', context, response);
      }
      case 'CARE_PROFILE_CONFIRM':
        return makeResult(session, 'CARE_PROFILE_CONFIRM', context, PROFILE);
      case 'CARE_RESULTS':
        return context.kind === 'emergency_results'
          ? emergencyResults(session, context, true)
          : results(session, context, true);
      case 'CARE_NO_MATCH':
        return noMatch(session, context, true);
      case 'EMERGENCY_CODE':
        return makeResult(
          session,
          'EMERGENCY_CODE',
          { ...context, kind: 'emergency_code' },
          CODE_TEXT(),
        );
      case 'MY_CODE':
        return myCode(session);
      case 'GRANT_PATIENT_CODE':
        return makeResult(
          session,
          'GRANT_PATIENT_CODE',
          { ...context, kind: 'grant_patient_code' },
          GRANT_PATIENT,
        );
      case 'GRANT_ACCESS_CODE':
        return makeResult(session, 'GRANT_ACCESS_CODE', context, GRANT_ACCESS);
      case 'RECORD_PAGE':
        return recordResult(session, context);
      case 'END':
        return renderEnd(session);
      default:
        return terminal(session, UNAVAILABLE, 'unavailable');
    }
  }

  async function maybeSearch(
    session: UssdSession,
    serviceCode: string,
    areaId: string,
    areaLabel?: string,
  ): Promise<UssdResult> {
    if (config.profileUseEnabled) {
      try {
        const consent = await repository.findProfileConsent();
        if (consent) {
          return makeResult(
            session,
            'CARE_PROFILE_CONFIRM',
            acceptedContext({
              kind: 'care_profile_confirm',
              serviceCode,
              areaId,
              areaLabel,
              consentId: consent.id,
            }),
            PROFILE,
          );
        }
      } catch {
        // A consent lookup failure falls back to a guest directory search.
      }
    }
    return search(session, serviceCode, areaId, config.searchRadiusKm, [], 0, areaLabel);
  }

  async function renderEnd(session: UssdSession): Promise<UssdResult> {
    const context = session.context ?? {};
    if (context.terminalKind === 'protected' && context.recordKind) {
      return recordResult(session, context);
    }
    return terminal(
      session,
      context.safeText ?? 'Session ended. Please dial again.',
      context.terminalKind ?? 'goodbye',
    );
  }

  async function transition(session: UssdSession, input: string | null): Promise<UssdResult> {
    if (isExpired(session)) return expired(session);
    if (session.state === 'END') return replay(session);
    if (input === null) return current(session);
    const token = input;
    if (
      token === null ||
      token.length === 0 ||
      token.length > 64 ||
      /[\x00-\x1f\x7f]/.test(token)
    ) {
      return invalid(session);
    }
    const context = session.context ?? {};

    switch (session.state) {
      case 'MAIN':
        if (context.kind === 'language') {
          if (token === '0')
            return makeResult(session, 'MAIN', acceptedContext({ kind: 'main' }), bounded('CON', MAIN_TEXT()));
          const picked = digit(token) ? USSD_LANGUAGE_ORDER[Number(token) - 1] : undefined;
          if (!picked) return invalid(session, LANGUAGE_TEXT());
          L = picked;
          try {
            await repository.setLocale?.(picked);
          } catch {
            // The session still carries the choice.
          }
          return makeResult(session, 'MAIN', acceptedContext({ kind: 'main' }), bounded('CON', MAIN_TEXT()));
        }
        if (token === '5')
          return makeResult(
            session,
            'MAIN',
            acceptedContext({ kind: 'language' }),
            bounded('CON', LANGUAGE_TEXT()),
          );
        if (!digit(token)) return invalid(session, MAIN_TEXT());
        if (token === '0') return terminal(session, 'Thank you for using HealthAccess.', 'goodbye');
        if (token === '1') return services(session);
        if (token === '2') {
          return makeResult(
            session,
            'EMERGENCY_CODE',
            acceptedContext({ kind: 'emergency_code' }),
            CODE_TEXT(),
          );
        }
        if (token === '3') return myCode(session);
        // Emergency: ask only for the area so help is one step away.
        if (token === '4') return emergencyArea(session, undefined, false, await savedArea());
        return invalid(session, MAIN_TEXT());

      case 'CARE_SERVICE': {
        if (token === '0')
          return makeResult(
            session,
            'MAIN',
            acceptedContext({ kind: 'main' }),
            bounded('CON', MAIN_TEXT()),
          );
        if (!digit(token)) return invalid(session, invalidPrompt(session));
        const serviceCode = context.serviceCodes?.[Number(token) - 1];
        if (!serviceCode) return invalid(session, invalidPrompt(session));
        return location(session, serviceCode, false, await savedArea());
      }

      case 'CARE_LOCATION': {
        if (context.kind === 'emergency_details') {
          if (token === '0')
            return makeResult(
              session,
              'MAIN',
              acceptedContext({ kind: 'main' }),
              bounded('CON', MAIN_TEXT()),
            );
          if (!validArea(token)) return invalid(session, EMERGENCY_DETAILS.slice(4));
          return emergencyArea(session, token.trim(), false, await savedArea());
        }
        if (context.kind === 'emergency_area') {
          if (token === '0')
            return makeResult(
              session,
              'MAIN',
              acceptedContext({ kind: 'main' }),
              bounded('CON', MAIN_TEXT()),
            );
          if (token === '1' && context.savedAreaLabel)
            return emergencySearch(session, context.savedAreaLabel, context.emergencyDescription);
          if (!validArea(token)) return invalid(session, EMERGENCY_LOCATION_TEXT().slice(4));
          return emergencySearch(session, token.trim(), context.emergencyDescription);
        }
        if (token === '0') return services(session);
        if (token === '1' && context.savedAreaId)
          return maybeSearch(
            session,
            context.serviceCode ?? '',
            context.savedAreaId,
            context.savedAreaLabel,
          );
        if (!validArea(token)) return invalid(session, LOCATION_TEXT().slice(4));
        let found: Area[];
        try {
          found = await repository.findAreas(token.trim());
        } catch {
          return unavailable(session);
        }
        if (!found.length) {
          const web = await careWebFallback(
            session,
            context.serviceCode ?? '',
            token.trim(),
            config.searchRadiusKm,
            [],
            0,
          );
          if (web) return web;
          return makeResult(
            session,
            'CARE_LOCATION',
            acceptedContext({ ...context, kind: 'care_location' }),
            bounded('CON', 'No matching area. Enter another area or 0 Back.'),
          );
        }
        if (found.length === 1)
          return maybeSearch(
            session,
            context.serviceCode ?? '',
            found[0].id,
            areaLabel(found[0]),
          );
        return areas(session, context.serviceCode ?? '', found);
      }

      case 'CARE_AREA_CHOICE': {
        if (token === '0') return location(session, context.serviceCode ?? '');
        if (!digit(token)) return invalid(session, invalidPrompt(session));
        const area = context.choices?.[Number(token) - 1];
        if (!area) return invalid(session, invalidPrompt(session));
        return maybeSearch(session, context.serviceCode ?? '', area.id, areaLabel(area));
      }

      case 'CARE_PROFILE_CONFIRM': {
        if (token === '0') return location(session, context.serviceCode ?? '');
        if (token !== '1' && token !== '2') return invalid(session, PROFILE.slice(4));
        if (token === '1' && context.consentId) {
          try {
            await repository.readMatchingContext(context.consentId);
          } catch {
            // Consent disappearing is not an error; continue as a guest search.
          }
        }
        return search(
          session,
          context.serviceCode ?? '',
          context.areaId ?? '',
          config.searchRadiusKm,
          [],
          0,
          context.areaLabel,
        );
      }

      case 'CARE_RESULTS': {
        if (context.kind === 'emergency_results') {
          if (token === '0')
            return terminal(session, 'Thank you for using HealthAccess.', 'goodbye');
          if (token === '1') {
            const index = context.resultIndex ?? 0;
            if (index + 1 < (context.resultIds?.length ?? 0)) {
              return emergencyResults(session, { ...context, resultIndex: index + 1 });
            }
            return emergencyArea(session);
          }
          return invalid(session, emergencyOptions(context).join('\n'));
        }
        if (token === '0') return terminal(session, 'Thank you for using HealthAccess.', 'goodbye');
        if (token === '1') {
          const index = context.resultIndex ?? 0;
          if (index + 1 < (context.resultIds?.length ?? 0)) {
            return results(session, { ...context, resultIndex: index + 1 });
          }
          if (canWiden(context) && context.resultKind !== 'web') return widen(session, context);
          return location(session, context.serviceCode ?? '');
        }
        if (token === '2' && context.resultKind !== 'web') {
          const item = await facility(context);
          if (!item) return invalid(session, resultOptions(context, false).join('\n'));
          let queued: boolean;
          try {
            queued = await repository.queueFacilitySms(item.id);
          } catch {
            queued = false;
          }
          const state = queueState(queued);
          if (state === 'failed') {
            const options = resultOptions(context, true).map((option) =>
              option === '2. Send details by SMS' ? '2. Try again' : option,
            );
            return makeResult(
              session,
              'CARE_RESULTS',
              acceptedContext(context),
              bounded('CON', ['SMS could not be requested.', ...options].join('\n')),
              {},
            );
          }
          return terminal(session, 'SMS requested.', 'sms_requested');
        }
        return invalid(session, resultOptions(context, context.resultKind !== 'web').join('\n'));
      }

      case 'CARE_NO_MATCH': {
        if (token === '0') return terminal(session, 'Thank you for using HealthAccess.', 'goodbye');
        if (token === '1' && canWiden(context)) return widen(session, context);
        if (token === '2') return location(session, context.serviceCode ?? '');
        return invalid(session, noMatchOptions(context).join('\n'));
      }

      case 'MY_CODE': {
        if (token === '0')
          return makeResult(
            session,
            'MAIN',
            acceptedContext({ kind: 'main' }),
            bounded('CON', MAIN_TEXT()),
          );
        if (token === '1') return quickCode(session);
        return invalid(session);
      }

      case 'EMERGENCY_CODE': {
        if (token === '0')
          return makeResult(
            session,
            'MAIN',
            acceptedContext({ kind: 'main' }),
            bounded('CON', MAIN_TEXT()),
          );
        // One box for every code: 12 digits is an emergency code, 8 digits a temporary code.
        const code = token.replace(/[\s-]/g, '');
        if (/^\d{8}$/.test(code)) return openTemporaryCode(session, code);
        if (!validCode(code)) return invalid(session, CODE_TEXT().slice(4));
        const digest = await crypto.digestCode(code, 'patient');
        if (!digest) return invalid(session, CODE_TEXT().slice(4));
        let projection: Projection;
        try {
          projection = await repository.readEmergency(digest);
        } catch {
          return accessError(session, 'emergency');
        }
        if (!projection.available || !projection.fields?.length)
          return accessError(session, 'emergency');
        return projectionResult(
          session,
          {
            kind: 'record_page',
            recordKind: 'emergency',
            codeDigest: digest,
            cursor: null,
            pageNo: 1,
          },
          projection,
        );
      }

      case 'GRANT_PATIENT_CODE': {
        if (token === '0')
          return makeResult(
            session,
            'MAIN',
            acceptedContext({ kind: 'main' }),
            bounded('CON', MAIN_TEXT()),
          );
        if (!validCode(token)) return invalid(session, GRANT_PATIENT.slice(4));
        const digest = await crypto.digestCode(token.trim(), 'patient');
        if (!digest) return invalid(session, GRANT_PATIENT.slice(4));
        return makeResult(
          session,
          'GRANT_ACCESS_CODE',
          acceptedContext({
            kind: 'grant_access_code',
            patientCodeDigest: digest,
          }),
          GRANT_ACCESS,
        );
      }

      case 'GRANT_ACCESS_CODE': {
        if (token === '0')
          return makeResult(
            session,
            'MAIN',
            acceptedContext({ kind: 'main' }),
            bounded('CON', MAIN_TEXT()),
          );
        if (!validCode(token) || !context.patientCodeDigest)
          return invalid(session, GRANT_ACCESS.slice(4));
        const grantDigest = await crypto.digestCode(token.trim(), 'grant');
        if (!grantDigest) return invalid(session, GRANT_ACCESS.slice(4));
        let opened: Projection;
        try {
          opened = await repository.openGrant(context.patientCodeDigest, grantDigest);
        } catch {
          return accessError(session, 'grant');
        }
        if (!opened.available || !opened.read_session_id) return accessError(session, 'grant');
        const withRead: UssdSession = { ...session, readSessionId: opened.read_session_id };
        let projection: Projection;
        try {
          projection = await repository.readGrant(opened.read_session_id);
        } catch {
          await closeRead(withRead);
          return accessError(withRead, 'grant');
        }
        if (!projection.available || !projection.fields?.length) {
          await closeRead(withRead);
          return accessError(withRead, 'grant');
        }
        return projectionResult(
          withRead,
          {
            kind: 'record_page',
            recordKind: 'grant',
            cursor: null,
            pageNo: 1,
          },
          projection,
        );
      }

      case 'RECORD_PAGE': {
        if (token === '0') {
          await closeRead(session);
          return terminal(session, 'Closed.', 'goodbye', { readSessionId: null });
        }
        if (token !== '1' && token !== '2') return invalid(session, invalidPrompt(session));
        const projection = await loadRecord(session, context);
        if (!projection?.available || !projection.fields?.length)
          return accessError(session, context.recordKind ?? 'grant');
        const prepared = prepare(projection, context);
        if (!prepared) return accessError(session, context.recordKind ?? 'grant');
        const page = makePage(prepared.atoms, prepared.cursor, budget, prepared.notice);
        if (!page) return accessError(session, context.recordKind ?? 'grant');
        if (prepared.notice)
          return composeRecord(session, context, prepared, page, prepared.pageNo);
        if (token === '1') {
          if (!page.next) return composeRecord(session, context, prepared, page, prepared.pageNo);
          const next = makePage(prepared.atoms, page.next, budget, null);
          return next
            ? composeRecord(session, context, prepared, next, prepared.pageNo + 1)
            : composeRecord(session, context, prepared, page, prepared.pageNo);
        }
        if (prepared.pageNo <= 1) {
          const first = makePage(prepared.atoms, null, budget, 'Already at the first page.');
          return first
            ? composeRecord(session, context, prepared, first, 1)
            : composeRecord(session, context, prepared, page, prepared.pageNo);
        }
        const previous = makePage(
          prepared.atoms,
          pageStart(prepared.atoms, prepared.pageNo - 1, budget),
          budget,
          null,
        );
        return previous
          ? composeRecord(session, context, prepared, previous, prepared.pageNo - 1)
          : composeRecord(session, context, prepared, page, prepared.pageNo);
      }

      default:
        return terminal(session, UNAVAILABLE, 'unavailable');
    }
  }

  async function render(session: UssdSession): Promise<UssdResult> {
    return current(session);
  }

  async function replay(session: UssdSession): Promise<UssdResult> {
    return current(session);
  }

  async function loadLocale(session: UssdSession) {
    const cached = toLocale(session.context?.locale);
    if (cached) L = cached;
    else {
      try {
        L = (await repository.getLocale?.()) ?? 'en';
      } catch {
        L = 'en';
      }
    }
  }

  return {
    transition: async (session, input) => {
      await loadLocale(session);
      return transition(session, input);
    },
    render: async (session) => {
      await loadLocale(session);
      return render(session);
    },
    replay: async (session) => {
      await loadLocale(session);
      return replay(session);
    },
  };
}
