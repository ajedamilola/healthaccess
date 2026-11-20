import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../middleware/error.js';

const SEARCH_ENDPOINT = 'https://google.serper.dev/search';
const MAPS_ENDPOINT = 'https://google.serper.dev/maps';
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_QUERY_LENGTH = 180;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 300;
const MAX_PHONE_LENGTH = 40;
const MAX_TITLE_LENGTH = 300;
const MAX_SNIPPET_LENGTH = 800;
const MAX_REFERENCE_LENGTH = 300;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 10;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const PHONE_LIKE = /(?:\+?\d[\d\s().-]{5,}\d)/g;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SerperConfig {
  apiKey?: string;
  timeoutMs?: number;
  country?: string;
  locale?: string;
}

export interface SerperSource {
  title: string;
  url: string;
  snippet: string;
}

export interface LivePlace {
  name: string;
  address: string;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  website: string | null;
  source_url: string;
  source_reference: string;
  service_label: string;
  verification_status: 'unverified';
  kind: 'facility' | 'emergency';
}

export interface FacilitySearchInput {
  serviceCode?: string;
  serviceLabel: string;
  area: string;
  limit?: number;
}

export interface EmergencySearchInput {
  area: string;
  kind?: 'hospital' | 'ambulance' | 'both';
  limit?: number;
}

export interface SerperClient {
  configured: boolean;
  searchWeb(query: string): Promise<SerperSource[]>;
  discoverFacilities(input: FacilitySearchInput): Promise<LivePlace[]>;
  discoverEmergency(input: EmergencySearchInput): Promise<LivePlace[]>;
}

interface Settings {
  apiKey: string;
  timeoutMs: number;
  country: string;
  locale: string;
}

interface MapsUrlInput {
  cid: string | null;
  placeId: string | null;
  name: string;
  address: string;
}

const SERVICE_QUERIES: Record<string, string> = {
  general: 'general hospital',
  pediatrics: 'children hospital',
  maternity: 'maternity hospital',
  emergency: 'emergency hospital',
  ambulance: 'ambulance service',
};

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
  return /\p{L}/u.test(value);
}

function minimizeQuery(value: unknown, maxLength = MAX_QUERY_LENGTH): string {
  if (typeof value !== 'string') return '';
  let query = cleanText(value, maxLength * 2);
  if (!query || !hasLetter(query)) return '';
  query = query.replace(/\d{6,}/g, '[number removed]');
  query = query.replace(PHONE_LIKE, (match) =>
    match.replace(/\D/g, '').length >= 7 ? '[number removed]' : match,
  );
  return query.replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function placeKey(place: LivePlace): string {
  return `${normalizeKey(place.name)}|${normalizeKey(place.address || place.name)}`;
}

function ipv4IsNonPublic(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
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
  return a >= 224;
}

function ipv6IsNonPublic(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  return false;
}

function isNonPublicHost(host: string): boolean {
  const normalized = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!normalized || normalized.includes('%')) return true;
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    ['.local', '.internal', '.lan', '.home', '.test', '.invalid', '.example'].some((suffix) =>
      normalized.endsWith(suffix),
    )
  ) {
    return true;
  }
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

function toCoordinate(value: unknown, min: number, max: number): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) && numeric >= min && numeric <= max ? numeric : null;
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

function mapsUrl({ cid, placeId, name, address }: MapsUrlInput): string {
  if (placeId) return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
  if (cid) return `https://maps.google.com/?cid=${encodeURIComponent(cid)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    cleanText(`${name} ${address}`, MAX_NAME_LENGTH + MAX_ADDRESS_LENGTH),
  )}`;
}

function mapPlace(
  value: unknown,
  serviceLabel: string,
  kind: LivePlace['kind'],
): LivePlace | null {
  if (!isRecord(value)) return null;
  const name = cleanText(value.title ?? value.name, MAX_NAME_LENGTH);
  if (!name) return null;
  const address = cleanText(value.address, MAX_ADDRESS_LENGTH);
  const phone = cleanText(value.phoneNumber ?? value.phone, MAX_PHONE_LENGTH) || null;
  const cid = toReference(value.cid);
  const placeId = toReference(value.placeId);
  const website = safeHttpsUrl(value.website);
  const sourceUrl = safeHttpsUrl(
    website ? website.href : mapsUrl({ cid, placeId, name, address }),
  );
  if (!sourceUrl) return null;
  return {
    name,
    address,
    phone,
    latitude: toCoordinate(value.latitude, -90, 90),
    longitude: toCoordinate(value.longitude, -180, 180),
    website: website ? website.href : null,
    source_url: sourceUrl.href,
    source_reference:
      placeId ?? cid ?? cleanText(address ? `${name}, ${address}` : name, MAX_REFERENCE_LENGTH),
    service_label: serviceLabel,
    verification_status: 'unverified',
    kind,
  };
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response || typeof response !== 'object') throw new Error('invalid serper response');
  if (!response.ok) throw new Error('serper request failed');
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('serper response too large');
  }

  let text: string;
  const body = response.body;
  if (body && typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('serper response too large');
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('serper response too large');
    }
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('invalid serper response');
  }
}

export function createSerperSearch(
  settings: SerperConfig,
  options: { fetchImpl?: FetchLike } = {},
): SerperClient {
  const apiKey = settings.apiKey?.trim() ?? '';
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = Math.min(Math.max(settings.timeoutMs ?? 8000, 500), 20000);
  const country = /^[a-z]{2}$/i.test(settings.country ?? '') ? settings.country! : 'ng';
  const locale = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(settings.locale ?? '')
    ? settings.locale!
    : 'en';

  async function request(endpoint: string, payload: Record<string, unknown>) {
    if (!apiKey) throw new Error('serper not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apiKey,
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: controller.signal,
      });
      return await readBoundedJson(response);
    } finally {
      clearTimeout(timer);
    }
  }

  async function maps(query: string, limit: number, serviceLabel: string, kind: LivePlace['kind']) {
    if (!query) return [];
    const data = await request(MAPS_ENDPOINT, {
      q: query,
      gl: country,
      hl: locale,
    });
    if (!isRecord(data)) return [];
    const places = Array.isArray(data.places)
      ? data.places
      : Array.isArray(data.localResults)
        ? data.localResults
        : [];
    const results: LivePlace[] = [];
    const seenReferences = new Set<string>();
    const seenPlaces = new Set<string>();
    for (const place of places) {
      if (results.length >= limit) break;
      const mapped = mapPlace(place, serviceLabel, kind);
      if (!mapped) continue;
      const key = placeKey(mapped);
      if (seenReferences.has(mapped.source_reference) || seenPlaces.has(key)) continue;
      seenReferences.add(mapped.source_reference);
      seenPlaces.add(key);
      results.push(mapped);
    }
    return results;
  }

  async function searchWeb(query: string): Promise<SerperSource[]> {
    if (!apiKey) return [];
    const q = minimizeQuery(query);
    if (!q) return [];
    const data = await request(SEARCH_ENDPOINT, {
      q,
      gl: country,
      hl: locale,
      num: DEFAULT_LIMIT,
    });
    if (!isRecord(data) || !Array.isArray(data.organic)) return [];
    const results: SerperSource[] = [];
    const seen = new Set<string>();
    for (const item of data.organic) {
      if (results.length >= DEFAULT_LIMIT) break;
      if (!isRecord(item)) continue;
      const url = safeHttpsUrl(item.link ?? item.url);
      if (!url || seen.has(url.href)) continue;
      seen.add(url.href);
      results.push({
        title: cleanText(item.title, MAX_TITLE_LENGTH),
        url: url.href,
        snippet: cleanText(item.snippet ?? item.description, MAX_SNIPPET_LENGTH),
      });
    }
    return results;
  }

  async function discoverFacilities(input: FacilitySearchInput): Promise<LivePlace[]> {
    if (!apiKey) return [];
    const label = cleanText(input.serviceLabel, 80);
    const area = cleanText(input.area, 120);
    if (!area || !hasLetter(area)) return [];
    const base = SERVICE_QUERIES[input.serviceCode ?? ''] ?? label;
    if (!base) return [];
    const query = minimizeQuery(`${base} in ${area}, Nigeria`);
    return maps(query, boundedLimit(input.limit), label || base, 'facility');
  }

  async function discoverEmergency(input: EmergencySearchInput): Promise<LivePlace[]> {
    if (!apiKey) return [];
    const area = cleanText(input.area, 120);
    if (!area || !hasLetter(area)) return [];
    const limit = boundedLimit(input.limit);
    const kind = input.kind ?? 'both';
    const labels: Array<{ query: string; label: string }> = [];
    if (kind === 'hospital' || kind === 'both') {
      labels.push({ query: 'emergency hospital', label: 'Emergency hospital' });
    }
    if (kind === 'ambulance' || kind === 'both') {
      labels.push({ query: 'ambulance service', label: 'Ambulance service' });
    }
    const results: LivePlace[] = [];
    const seenReferences = new Set<string>();
    const seenPlaces = new Set<string>();
    // Run both Maps queries concurrently so an emergency request does not pay
    // two timeout windows in series. Fulfilled queries still contribute when the
    // other one fails; only a total failure is reported as a failed search.
    const responses = await Promise.allSettled(
      labels.map((entry) => {
        const query = minimizeQuery(`${entry.query} in ${area}, Nigeria`);
        return maps(query, limit, entry.label, 'emergency');
      }),
    );
    if (responses.length > 0 && responses.every((response) => response.status === 'rejected')) {
      throw new Error('serper emergency search failed');
    }
    for (const response of responses) {
      if (response.status !== 'fulfilled') continue;
      for (const place of response.value) {
        if (results.length >= limit) break;
        const key = placeKey(place);
        if (seenReferences.has(place.source_reference) || seenPlaces.has(key)) continue;
        seenReferences.add(place.source_reference);
        seenPlaces.add(key);
        results.push(place);
      }
      if (results.length >= limit) break;
    }
    return results;
  }

  return {
    configured: Boolean(apiKey),
    searchWeb,
    discoverFacilities,
    discoverEmergency,
  };
}

export const serperSearch = createSerperSearch({
  apiKey: config.ai.serper,
  country: 'ng',
  locale: 'en',
});

export function requireSerper(client: SerperClient): SerperClient {
  if (!client.configured) {
    throw new AppError(503, 'Live facility search is not configured', 'search_unavailable');
  }
  return client;
}

export function placeFingerprint(place: LivePlace): string {
  return createHash('sha256')
    .update(`${place.name.toLowerCase()}|${place.address.toLowerCase()}|${place.source_url}`)
    .digest('hex');
}

export function placeSnapshot(place: LivePlace) {
  return {
    name: place.name,
    address: place.address,
    phone: place.phone,
    latitude: place.latitude,
    longitude: place.longitude,
    source_url: place.source_url,
    source_reference: place.source_reference,
    service_label: place.service_label,
    verification_status: place.verification_status,
    kind: place.kind,
  };
}
