import { type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE, checkCsrf, jsonNoStore } from "@/lib/auth-bff";
import { logRequest } from "@/lib/log";
import { markdownToSpeech, speechLanguage, type SpeechLanguage } from "@/lib/tts";

const YARN_BASE = "https://api.yarngpt.ai";
const PREPARE_TIMEOUT_MS = 20_000;
const AUDIO_TIMEOUT_MS = 60_000;
const VOICES_TIMEOUT_MS = 8_000;
const VOICES_TTL_MS = 10 * 60_000;

interface VoiceCatalogue {
  byLanguage: Map<string, string>;
  fallback?: string;
}

let catalogue: { at: number; value: VoiceCatalogue } | null = null;

const LANGUAGE_NAMES: Record<string, SpeechLanguage> = {
  english: "en",
  pidgin: "pcm",
  "nigerian pidgin": "pcm",
  yoruba: "yo",
  hausa: "ha",
  igbo: "ig",
  french: "fr",
  swahili: "sw",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(entry: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function codeFrom(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  return LANGUAGE_NAMES[lower] ?? lower.split(/[-_\s]/)[0];
}

function codesFrom(value: unknown): string[] {
  if (typeof value === "string") {
    const code = codeFrom(value);
    return code ? [code] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return codesFrom(item);
    const entry = asRecord(item);
    return entry ? codesFrom(firstString(entry, ["code", "language", "id", "name"])) : [];
  });
}

function parseCatalogue(payload: unknown): VoiceCatalogue {
  const root = asRecord(payload);
  const list = [payload, root?.voices, root?.data, root?.items].find(Array.isArray) as unknown[] | undefined;
  const byLanguage = new Map<string, string>();
  let fallback: string | undefined;

  for (const item of list ?? []) {
    const entry = asRecord(item);
    if (!entry) continue;
    const id = firstString(entry, ["id", "name", "voice", "voice_id", "slug"]);
    if (!id) continue;
    if (fallback === undefined && (entry.default === true || entry.is_default === true || entry.isDefault === true)) {
      fallback = id;
    }
    const codes = new Set([
      ...codesFrom(entry.languages),
      ...codesFrom(entry.target_languages),
      ...codesFrom(entry.supported_languages),
      ...codesFrom(entry.language),
      ...codesFrom(entry.lang),
    ]);
    for (const code of codes) if (!byLanguage.has(code)) byLanguage.set(code, id);
  }

  return { byLanguage, fallback };
}

async function loadVoices(token: string): Promise<VoiceCatalogue> {
  if (catalogue && Date.now() - catalogue.at < VOICES_TTL_MS) return catalogue.value;

  const empty: VoiceCatalogue = { byLanguage: new Map() };
  try {
    const response = await fetch(`${YARN_BASE}/api/v1/voices`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(VOICES_TIMEOUT_MS),
    });
    if (!response.ok) return empty;
    const value = parseCatalogue(await response.json());
    catalogue = { at: Date.now(), value };
    return value;
  } catch {
    return empty;
  }
}

function prepareBody(text: string, language: SpeechLanguage, voice: string | undefined, translate: boolean) {
  const body: Record<string, unknown> = { text, output_format: "mp3" };
  if (voice) body.voice = voice;
  if (translate && language !== "en") body.target_language = language;
  return body;
}

async function prepare(token: string, body: Record<string, unknown>) {
  return fetch(`${YARN_BASE}/api/v1/tts/prepare`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(PREPARE_TIMEOUT_MS),
  });
}

export async function POST(request: NextRequest) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;

  if (!request.cookies.get(ACCESS_COOKIE)?.value && !request.cookies.get(REFRESH_COOKIE)?.value) {
    return jsonNoStore({ error: "unauthorized" }, 401);
  }

  const token = process.env.YARN_GPT_TOKEN?.trim();
  if (!token) {
    logRequest("POST", "/api/tts", 503);
    return jsonNoStore({ error: "tts_not_configured" }, 503);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonNoStore({ error: "invalid_input" }, 400);
  }

  const input = asRecord(payload);
  const text = typeof input?.text === "string" ? markdownToSpeech(input.text) : "";
  if (!text) return jsonNoStore({ error: "invalid_input" }, 400);

  const language = speechLanguage(input?.language);
  const voices = await loadVoices(token);
  const voice = process.env.YARN_GPT_VOICE?.trim() || voices.byLanguage.get(language) || voices.fallback;

  let upstream: Response;
  try {
    upstream = await prepare(token, prepareBody(text, language, voice, true));
    if (upstream.status === 422 && language !== "en") {
      upstream = await prepare(token, prepareBody(text, language, voice, false));
    }
  } catch {
    logRequest("POST", "/api/tts", 504);
    return jsonNoStore({ error: "tts_timeout" }, 504);
  }

  if (!upstream.ok) {
    logRequest("POST", "/api/tts", upstream.status);
    const status = upstream.status === 429 ? 429 : upstream.status === 402 ? 402 : 502;
    return jsonNoStore({ error: status === 429 ? "tts_rate_limited" : status === 402 ? "tts_quota_exceeded" : "tts_failed" }, status);
  }

  let streamUrl: unknown;
  try {
    streamUrl = (asRecord(await upstream.json()))?.stream_url;
  } catch {
    streamUrl = undefined;
  }
  if (typeof streamUrl !== "string" || !streamUrl) {
    logRequest("POST", "/api/tts", 502);
    return jsonNoStore({ error: "tts_failed" }, 502);
  }

  let audio: Response;
  try {
    audio = await fetch(streamUrl.startsWith("http") ? streamUrl : `${YARN_BASE}${streamUrl}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(AUDIO_TIMEOUT_MS),
    });
  } catch {
    logRequest("POST", "/api/tts", 504);
    return jsonNoStore({ error: "tts_timeout" }, 504);
  }

  if (!audio.ok || !audio.body) {
    logRequest("POST", "/api/tts", audio.ok ? 502 : audio.status);
    return jsonNoStore({ error: "tts_failed" }, 502);
  }

  logRequest("POST", "/api/tts", 200);
  return new Response(audio.body, {
    status: 200,
    headers: {
      "Content-Type": audio.headers.get("content-type") ?? "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
