type Environment = Record<string, string | undefined>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secret(env: Environment, name: string): string {
  const value = required(env, name);
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
    Buffer.from(value, 'base64').toString('base64') !== value
  ) {
    throw new Error(`${name} must be a base64 32-byte secret`);
  }
  return value;
}

function optionalSecret(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
    Buffer.from(value, 'base64').toString('base64') !== value
  ) {
    throw new Error(`${name} must be a base64 32-byte secret`);
  }
  return value;
}

function commaSeparated(value = ''): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function httpLogBodies(env: Environment, mode: string): 'off' | 'redacted' | 'full' {
  const value = (env.LOG_HTTP_BODIES || '').trim().toLowerCase();
  if (!value) return mode === 'production' ? 'redacted' : 'full';
  if (value !== 'off' && value !== 'redacted' && value !== 'full') {
    throw new Error('LOG_HTTP_BODIES must be off, redacted or full');
  }
  if (mode === 'production' && value === 'full') {
    throw new Error('LOG_HTTP_BODIES=full is not allowed in production');
  }
  return value;
}

// The pilot has a small environment surface. Operational defaults live here.
const WORKER_LEASE_SECONDS = 90;
/** 2 AI calls + ~15 s for search and database work must finish inside the lease. */
const MAX_AI_TIMEOUT_MS = Math.floor((WORKER_LEASE_SECONDS * 1000 - 15000) / 2);

function boundedInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function loadConfig(env: Environment = process.env) {
  const mode = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(mode)) throw new Error('Invalid NODE_ENV');
  const codeDigestKey = secret(env, 'CODE_DIGEST_KEY');
  const dataEncryptionKey = secret(env, 'DATA_ENCRYPTION_KEY');
  if (codeDigestKey === dataEncryptionKey)
    throw new Error('Digest and encryption secrets must be independent');
  const phoneDigestKey = optionalSecret(env, 'PHONE_DIGEST_KEY') ?? codeDigestKey;
  const inputFingerprintKey = optionalSecret(env, 'INPUT_FINGERPRINT_KEY') ?? dataEncryptionKey;
  const encryptionKeyVersion = Number(env.ENCRYPTION_KEY_VERSION || 1);
  if (!Number.isInteger(encryptionKeyVersion) || encryptionKeyVersion < 1)
    throw new Error('Invalid ENCRYPTION_KEY_VERSION');
  const callbackToken = required(env, 'CALLBACK_TOKEN');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(callbackToken))
    throw new Error('CALLBACK_TOKEN needs 32-128 URL-safe characters');
  const allowedCidrs = commaSeparated(env.CALLBACK_ALLOWED_IPS);
  const atApiKey = env.AT_API_KEY || '';
  const atUsername = env.AT_USERNAME || 'sandbox';
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  if (mode === 'production' && (!allowedCidrs.length || !atApiKey || atUsername === 'sandbox')) {
    throw new Error(
      "Production requires provider IP controls and live Africa's Talking credentials",
    );
  }
  if (mode === 'production' && (!env.AT_SMS_FROM || !env.AT_USSD_SERVICE_CODE)) {
    throw new Error('Production requires the provisioned two-way number and USSD service code');
  }
  if (!!env.OPENROUTER_API_KEY !== !!env.OPENROUTER_MODEL)
    throw new Error('Set both OPENROUTER_API_KEY and OPENROUTER_MODEL');
  return {
    mode,
    host: env.HOST || (mode === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port,
    pilotCountry: 'NG',
    locale: 'en',
    databaseUrl: required(env, 'DATABASE_URL'),
    databasePoolSize: 10,
    databaseTimeoutMs: 750,
    codeDigestKey,
    // HMAC purpose labels separate code, phone and request fingerprints.
    phoneDigestKey,
    dataEncryptionKey,
    inputFingerprintKey,
    encryptionKeyVersion,
    callbackPathKey: callbackToken,
    callbackAuthMode:
      mode === 'production' ? ('ip_allowlist' as const) : ('development_open' as const),
    allowedCidrs,
    callbackBodyLimitBytes: 8192,
    // Every Africa's Talking callback (each SMS and every USSD keypress) comes from a
    // few provider IPs, so the per-IP ceiling is a flood guard for the whole service;
    // fairness between people is enforced per phone (callbackPhoneRatePerMinute).
    callbackRatePerMinute: boundedInt(env.CALLBACK_RATE_PER_MINUTE, 6000, 60, 100000),
    callbackPhoneRatePerMinute: 60,
    // Full callback bodies include phone numbers and health text. Production
    // defaults to redacted; set LOG_HTTP_BODIES=full only for local debugging.
    httpLogBodies: httpLogBodies(env, mode),
    phoneRatePerMinute: 20,
    lookupRatePerMinute: 10,
    smsTransport: atApiKey ? ('africastalking' as const) : ('mock' as const),
    atUsername,
    atApiKey,
    atSmsFrom: env.AT_SMS_FROM || '',
    atSmsInboundNumbers: commaSeparated(env.AT_SMS_FROM),
    atUssdServiceCode: env.AT_USSD_SERVICE_CODE || '',
    atSendTimeoutMs: 10000,
    ussdSessionTtlSeconds: 120,
    ussdMaxChars: 182,
    ussdMaxInvalidAttempts: 3,
    // How long an SMS thread (and its encrypted memory) lives after the last message.
    smsConversationTtlSeconds: boundedInt(env.SMS_CONVERSATION_TTL_SECONDS, 1800, 300, 86400),
    smsReplyTtlSeconds: 900,
    smsMaxSegments: 6,
    searchRadiusKm: 25,
    searchMaxRadiusKm: 100,
    profileUseEnabled: false,
    aiEnabled: !!env.OPENROUTER_API_KEY,
    openrouterApiKey: env.OPENROUTER_API_KEY || '',
    openrouterModel: env.OPENROUTER_MODEL || '',
    // Structured answers from hosted models often take 10-20 s; a short limit made
    // the SMS assistant silently fall back to the menu.
    // A chat health question makes two AI calls plus a web search inside one worker
    // lease (WORKER_LEASE_SECONDS below), so each call must leave room for the other.
    aiTimeoutMs: boundedInt(env.AI_TIMEOUT_MS, 25000, 1000, MAX_AI_TIMEOUT_MS),
    aiMaxOutputTokens: 600,
    serperApiKey: env.SERPER_API_KEY || '',
    serperTimeoutMs: 5000,
    serperCountry: 'ng',
    serperLocale: 'en',
    healthSourceDomains: ['who.int', 'nhs.uk', 'cdc.gov', 'medlineplus.gov', 'ncdc.gov.ng'],
    allowLiveWeb: true,
    workerPollMs: 1000,
    workerLeaseSeconds: WORKER_LEASE_SECONDS,
    workerMaxAttempts: 5,
    smsBodyRetentionDays: 7,
    deliveryRetentionDays: 30,
    ussdRetentionSeconds: 300,
  };
}

export type Config = ReturnType<typeof loadConfig>;
