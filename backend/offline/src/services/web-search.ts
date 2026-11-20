import { isIP } from 'node:net';
import type { WebLead } from '../types.js';

const SEARCH_ENDPOINT = 'https://google.serper.dev/search';
const MAPS_ENDPOINT = 'https://google.serper.dev/maps';
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_QUERY_LENGTH = 180;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 300;
const MAX_SNIPPET_LENGTH = 800;
const MAX_NAME_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 300;
const MAX_PHONE_LENGTH = 40;
const MAX_REFERENCE_LENGTH = 300;
const SEARCH_RESULT_LIMIT = 8;
const FACILITY_RESULT_LIMIT = 8;
const EMERGENCY_RESULT_LIMIT = 8;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface Source {
  title: string;
  url: string;
  snippet: string;
}

export type FacilityLead = WebLead;

export interface WebSearchConfig {
  serperApiKey: string;
  serperTimeoutMs?: number;
  serperCountry?: string;
  serperLocale?: string;
  healthSourceDomains: string[];
}

export interface FacilitySearch {
  serviceLabel: string;
  area: string;
}

export interface EmergencySearch {
  area: string;
  description?: string;
}

export interface WebSearch {
  searchHealth(query: string): Promise<Source[]>;
  discoverFacilities(input: FacilitySearch): Promise<FacilityLead[]>;
  discoverEmergency(input: EmergencySearch): Promise<FacilityLead[]>;
}

export interface FetchResponseBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
  };
}

export interface FetchResponse {
  status?: number;
  ok?: boolean;
  headers?: { get(name: string): string | null };
  body?: FetchResponseBody | null;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<FetchResponse>;

export interface WebSearchOptions {
  fetchImpl?: FetchLike;
}

interface NormalizedConfig {
  apiKey: string;
  timeoutMs: number;
  country: string;
  locale: string;
  domains: string[];
}

interface MapsUrlInput {
  cid: string | null;
  placeId: string | null;
  name: string;
  address: string;
}

type SerperPayload = Record<string, string | number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

function hasLetter(value: string): boolean {
  return /[\p{L}]/u.test(value);
}

function minimizeQuery(value: unknown, maxLength = MAX_QUERY_LENGTH): string {
  if (typeof value !== 'string') return '';
  let query = cleanText(value, maxLength * 2);
  if (!query || !hasLetter(query)) return '';
  query = query.replace(/\d{6,}/g, '[number removed]');
  query = query.replace(/(?:\+?\d{1,4}[\s().-]+){2,}\d{1,4}/g, '[number removed]');
  query = query.replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
  return query;
}

function ipv4IsNonPublic(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function ipv6IsNonPublic(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  return false;
}

function isLocalHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  return ['.local', '.internal', '.lan', '.home', '.test', '.invalid', '.example'].some((suffix) =>
    lower.endsWith(suffix),
  );
}

function isNonPublicHost(host: string): boolean {
  if (!host) return true;
  const normalized = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!normalized || normalized.includes('%')) return true;
  if (isLocalHostname(normalized)) return true;
  const family = isIP(normalized);
  if (family === 4) return ipv4IsNonPublic(normalized);
  if (family === 6) return ipv6IsNonPublic(normalized);
  return false;
}

function safeHttpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input || input.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  if (isNonPublicHost(url.hostname)) return null;
  return url;
}

function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('healthSourceDomains entries must be strings');
  }
  const domain = value.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!domain || domain.length > 253 || !domain.includes('.')) {
    throw new TypeError('healthSourceDomains entries must be public hostnames');
  }
  if (
    domain.includes('*') ||
    domain.includes('/') ||
    domain.includes(':') ||
    domain.includes('@')
  ) {
    throw new TypeError('healthSourceDomains entries must be public hostnames');
  }
  if (isIP(domain) || isNonPublicHost(domain)) {
    throw new TypeError('healthSourceDomains entries must be public hostnames');
  }
  const labels = domain.split('.');
  const validLabels = labels.every(
    (label) => label.length > 0 && label.length <= 63 && /^(?!-)[a-z0-9-]+(?<!-)$/.test(label),
  );
  if (!validLabels) {
    throw new TypeError('healthSourceDomains entries must be public hostnames');
  }
  return domain;
}

function normalizeConfig(config: WebSearchConfig): NormalizedConfig {
  if (!config || typeof config !== 'object') {
    throw new TypeError('web search config is required');
  }
  if (typeof config.serperApiKey !== 'string' || config.serperApiKey.trim() === '') {
    throw new TypeError('serperApiKey is required');
  }
  const timeout = config.serperTimeoutMs ?? 8000;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 60000) {
    throw new TypeError('serperTimeoutMs must be an integer between 10 and 60000');
  }
  const country = String(config.serperCountry ?? 'ng')
    .trim()
    .toLowerCase();
  if (!/^[a-z]{2}$/.test(country)) {
    throw new TypeError('serperCountry must be a two-letter country code');
  }
  const locale = String(config.serperLocale ?? 'en')
    .trim()
    .toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(locale)) {
    throw new TypeError(
      'serperLocale must be a two-letter language code, optionally with a region',
    );
  }
  if (!Array.isArray(config.healthSourceDomains)) {
    throw new TypeError('healthSourceDomains must be an array');
  }
  if (config.healthSourceDomains.length > 50) {
    throw new TypeError('healthSourceDomains is too large');
  }
  return {
    apiKey: config.serperApiKey.trim(),
    timeoutMs: timeout,
    country,
    locale,
    domains: [...new Set(config.healthSourceDomains.map(normalizeDomain))],
  };
}

function hostMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === domain || host.endsWith(`.${domain}`);
}

function isAllowedHost(hostname: string, domains: string[]): boolean {
  return domains.some((domain) => hostMatches(hostname, domain));
}

async function readBoundedJson(response: FetchResponse): Promise<unknown> {
  if (!response || typeof response !== 'object') {
    throw new Error('invalid serper response');
  }
  const status =
    typeof response.status === 'number' && Number.isInteger(response.status)
      ? response.status
      : response.ok === false
        ? 500
        : 200;
  if (status < 200 || status >= 300) {
    throw new Error('serper request failed');
  }
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('serper response too large');
  }
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('serper response too large');
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  if (response.text) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('serper response too large');
    }
    return JSON.parse(text) as unknown;
  }
  if (response.json) {
    return response.json();
  }
  throw new Error('invalid serper response');
}

function toCoordinate(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function toReference(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = cleanText(value, MAX_REFERENCE_LENGTH);
    return text || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).slice(0, MAX_REFERENCE_LENGTH);
  }
  return null;
}

function buildMapsUrl({ cid, placeId, name, address }: MapsUrlInput): string {
  if (placeId) {
    return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
  }
  if (cid) {
    return `https://maps.google.com/?cid=${encodeURIComponent(cid)}`;
  }
  const query = cleanText(`${name} ${address}`, MAX_NAME_LENGTH + MAX_ADDRESS_LENGTH);
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function mapFacility(value: unknown, serviceLabel: string): FacilityLead | null {
  if (!isRecord(value)) return null;
  const name = cleanText(value.title ?? value.name, MAX_NAME_LENGTH);
  if (!name) return null;
  const address = cleanText(value.address, MAX_ADDRESS_LENGTH);
  const phone = cleanText(value.phoneNumber ?? value.phone, MAX_PHONE_LENGTH) || null;
  const cid = toReference(value.cid);
  const placeId = toReference(value.placeId);
  const website = safeHttpsUrl(value.website);
  const sourceUrl = website ? website.href : buildMapsUrl({ cid, placeId, name, address });
  const url = safeHttpsUrl(sourceUrl);
  if (!url) return null;
  const reference =
    placeId ?? cid ?? cleanText(address ? `${name}, ${address}` : name, MAX_REFERENCE_LENGTH);
  return {
    name,
    address,
    phone,
    latitude: toCoordinate(value.latitude, -90, 90),
    longitude: toCoordinate(value.longitude, -180, 180),
    source_url: url.href,
    source_reference: reference,
    verification_status: 'unverified',
    service_label: serviceLabel,
  };
}

export function createWebSearch(
  config: WebSearchConfig,
  options: WebSearchOptions = {},
): WebSearch {
  const settings = normalizeConfig(config);
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(endpoint: string, payload: SerperPayload): Promise<unknown | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(async () => {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': settings.apiKey,
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: controller.signal,
      });
      return readBoundedJson(response);
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('serper request timed out'));
      }, settings.timeoutMs);
    });
    try {
      return await Promise.race([work, deadline]);
    } catch {
      work.catch(() => undefined);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function searchHealth(query: string): Promise<Source[]> {
    const q = minimizeQuery(query);
    if (!q || settings.domains.length === 0) return [];
    const data = await request(SEARCH_ENDPOINT, {
      q,
      gl: settings.country,
      hl: settings.locale,
      num: SEARCH_RESULT_LIMIT,
    });
    if (!isRecord(data) || !Array.isArray(data.organic)) return [];
    const results: Source[] = [];
    const seen = new Set<string>();
    for (const item of data.organic) {
      if (results.length >= SEARCH_RESULT_LIMIT) break;
      if (!isRecord(item)) continue;
      const url = safeHttpsUrl(typeof item.link === 'string' ? item.link : item.url);
      if (!url || !isAllowedHost(url.hostname, settings.domains)) continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      results.push({
        title: cleanText(item.title, MAX_TITLE_LENGTH),
        url: url.href,
        snippet: cleanText(item.snippet ?? item.description, MAX_SNIPPET_LENGTH),
      });
    }
    return results;
  }

  async function discoverFacilities({
    serviceLabel,
    area,
  }: FacilitySearch): Promise<FacilityLead[]> {
    const label = cleanText(serviceLabel, 80);
    const place = cleanText(area, 80);
    if (!label || !place || !hasLetter(label) || !hasLetter(place)) return [];
    const q = minimizeQuery(`${label} in ${place}`);
    if (!q) return [];
    const data = await request(MAPS_ENDPOINT, {
      q,
      gl: settings.country,
      hl: settings.locale,
    });
    if (!isRecord(data)) return [];
    const places = Array.isArray(data.places)
      ? data.places
      : Array.isArray(data.localResults)
        ? data.localResults
        : [];
    const leads: FacilityLead[] = [];
    const seen = new Set<string>();
    for (const placeResult of places) {
      if (leads.length >= FACILITY_RESULT_LIMIT) break;
      const lead = mapFacility(placeResult, label);
      if (!lead || seen.has(lead.source_reference)) continue;
      seen.add(lead.source_reference);
      leads.push(lead);
    }
    return leads;
  }

  async function discoverEmergency({
    area,
    description,
  }: EmergencySearch): Promise<FacilityLead[]> {
    const place = cleanText(area, 80);
    if (!place || !hasLetter(place)) return [];
    const emergency = cleanText(description, 80);
    const queries: Array<{ query: string; label: string }> = [
      {
        query: `${emergency ? `${emergency} ` : ''}emergency hospital`,
        label: 'Emergency hospital',
      },
      {
        query: `${emergency ? `${emergency} ` : ''}ambulance service`,
        label: 'Ambulance service',
      },
    ];
    const leads: FacilityLead[] = [];
    const seen = new Set<string>();
    // Run both Maps queries concurrently so a slow provider does not double the
    // USSD/SMS callback latency; merge in fixed query order for determinism.
    const responses = await Promise.all(
      queries.map((entry) => {
        const q = minimizeQuery(`${entry.query} in ${place}`);
        return q
          ? request(MAPS_ENDPOINT, {
              q,
              gl: settings.country,
              hl: settings.locale,
            })
          : Promise.resolve(null);
      }),
    );
    for (const [position, entry] of queries.entries()) {
      if (leads.length >= EMERGENCY_RESULT_LIMIT) break;
      const data = responses[position];
      if (!isRecord(data)) continue;
      const places = Array.isArray(data.places)
        ? data.places
        : Array.isArray(data.localResults)
          ? data.localResults
          : [];
      for (const placeResult of places) {
        if (leads.length >= EMERGENCY_RESULT_LIMIT) break;
        const lead = mapFacility(placeResult, entry.label);
        if (!lead || seen.has(lead.source_reference)) continue;
        seen.add(lead.source_reference);
        leads.push(lead);
      }
    }
    return leads;
  }

  return { searchHealth, discoverFacilities, discoverEmergency };
}
