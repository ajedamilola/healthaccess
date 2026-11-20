import { createCrypto } from '@healthaccess/shared';

function optional(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function required(name: string) {
  const value = optional(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function int(name: string, fallback: number) {
  const value = optional(name);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback = false) {
  const value = optional(name);
  if (!value) return fallback;
  return value === 'true' || value === '1';
}

function emailConfig() {
  const host = optional('SMTP_HOST');
  const portValue = optional('SMTP_PORT');
  const user = optional('SMTP_USER');
  const password = optional('SMTP_PASSWORD');
  const from = optional('EMAIL_FROM');
  if (!host) {
    if (portValue || user || password || from) {
      throw new Error('SMTP_HOST is required when email settings are provided');
    }
    return null;
  }
  if (!from) throw new Error('EMAIL_FROM is required when SMTP_HOST is configured');
  if (!!user !== !!password) throw new Error('Set both SMTP_USER and SMTP_PASSWORD');
  const port = portValue ? Number(portValue) : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535');
  }
  return {
    host,
    port,
    secure: port === 465,
    user,
    password,
    from,
  };
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: int('PORT', 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  accessTtlSeconds: int('JWT_ACCESS_TTL_SECONDS', 900),
  refreshTtlDays: int('REFRESH_TTL_DAYS', 30),
  codeDigestKey: required('CODE_DIGEST_KEY'),
  dataEncryptionKey: required('DATA_ENCRYPTION_KEY'),
  phoneDigestKey: optional('PHONE_DIGEST_KEY') ?? required('CODE_DIGEST_KEY'),
  inputFingerprintKey: optional('INPUT_FINGERPRINT_KEY') ?? required('DATA_ENCRYPTION_KEY'),
  encryptionKeyVersion: int('ENCRYPTION_KEY_VERSION', 1),
  googleClientId: optional('GOOGLE_CLIENT_ID'),
  googleClientSecret: optional('GOOGLE_CLIENT_SECRET'),
  baseUrl: optional('BASE_URL') ?? 'http://localhost:3000',
  frontendUrl: optional('FRONTEND_URL') ?? 'http://localhost:5173',
  email: emailConfig(),
  s3: {
    region: optional('AWS_REGION'),
    accessKeyId: optional('AWS_ACCESS_KEY_ID'),
    secretAccessKey: optional('AWS_SECRET_ACCESS_KEY'),
    bucket: optional('AWS_BUCKET_NAME'),
    endpoint: optional('S3_ENDPOINT'),
    forcePathStyle: bool('S3_FORCE_PATH_STYLE'),
  },
  redisUrl: optional('REDIS_URL'),
  ai: {
    openrouter: optional('OPENROUTER_API_KEY'),
    openrouterModel: optional('OPENROUTER_MODEL') ?? 'deepseek/deepseek-chat',
    deepseek: optional('DEEPSEEK_API_KEY'),
    google: optional('GOOGLE_API_KEY'),
    anthropic: optional('ANTHROPIC_API_KEY'),
    groq: optional('GROQ_API_KEY'),
    serper: optional('SERPER_API_KEY'),
    chatModel: optional('CHAT_MODEL') ?? 'geminiFlash',
    schedulerModel: optional('MEDICATION_SCHEDULER_MODEL') ?? 'haiku',
  },
  fcmEnabled: bool('FCM_ENABLED'),
  firebaseServiceAccount: optional('FIREBASE_SERVICE_ACCOUNT'),
  sms: {
    username: optional('AT_USERNAME') ?? 'sandbox',
    apiKey: optional('AT_API_KEY'),
    from: optional('AT_SMS_FROM'),
  },
  isProduction: (process.env.NODE_ENV ?? 'development') === 'production',
} as const;

export const crypto = createCrypto({
  dataEncryptionKey: config.dataEncryptionKey,
  codeDigestKey: config.codeDigestKey,
  phoneDigestKey: config.phoneDigestKey,
  inputFingerprintKey: config.inputFingerprintKey,
  encryptionKeyVersion: config.encryptionKeyVersion,
});
