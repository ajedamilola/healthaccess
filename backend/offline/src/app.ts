import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler, Request } from 'express';
import type { Config } from './config.js';
import type { Crypto } from './security/crypto.js';
import { z } from 'zod';
import { providerOrigin } from './security/origin.js';

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/);
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:+\-]+$/);
const smsSchema = z.object({
  id: identifier,
  from: e164,
  to: z.string().min(1).max(40),
  text: z.string().min(1).max(3000),
  date: z.string().max(100).optional(),
  linkId: z.string().max(160).optional(),
});
const deliverySchema = z.object({ id: identifier, status: z.string().min(1).max(50) });
const ussdSchema = z.object({
  sessionId: identifier,
  serviceCode: z.string().min(1).max(40),
  phoneNumber: e164,
  text: z.string().max(5000),
  networkCode: z.string().max(40).optional(),
});
const eventSchema = z.object({
  sessionId: identifier,
  phoneNumber: e164.optional(),
  serviceCode: z.string().max(40).optional(),
});

function sameNumber(left: string, right: string): boolean {
  const digits = (value: string) => value.replace(/\D/g, '');
  return digits(left).length > 0 && digits(left) === digits(right);
}

export type InboundSms = z.infer<typeof smsSchema>;
export type UssdCallback = z.infer<typeof ussdSchema>;
export type UssdEvent = z.infer<typeof eventSchema>;
export interface CallbackRepository {
  ready(): Promise<void>;
  takeRateLimit(scope: string, limit: number, seconds: number): Promise<boolean>;
  acceptSms(body: InboundSms, requestId: string): Promise<void>;
  acceptDelivery(body: { id: string; status: string }): Promise<void>;
  endUssdSession(body: UssdEvent): Promise<void>;
}

type AppConfig = Pick<
  Config,
  | 'allowedCidrs'
  | 'callbackAuthMode'
  | 'callbackPathKey'
  | 'callbackRatePerMinute'
  | 'callbackPhoneRatePerMinute'
  | 'callbackBodyLimitBytes'
  | 'atSmsInboundNumbers'
  | 'atUssdServiceCode'
  | 'httpLogBodies'
>;

const CALLBACK_PREFIX = '/callbacks/africastalking/';
const PHONE_BODY_KEYS = new Set(['from', 'to', 'phoneNumber']);
const TEXT_BODY_KEYS = new Set(['text']);

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  const last = digits.slice(-4);
  return last ? `***${last}` : '[redacted]';
}

function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (PHONE_BODY_KEYS.has(key) && typeof value === 'string') {
      output[key] = maskPhone(value);
      continue;
    }
    if (TEXT_BODY_KEYS.has(key) && typeof value === 'string') {
      output[key] = `[redacted ${value.length} chars]`;
      continue;
    }
    if (key === 'sessionId' && typeof value === 'string') {
      output[key] = `${value.slice(0, 6)}...(${value.length})`;
      continue;
    }
    output[key] = value;
  }
  return output;
}

function logUrl(req: Request): string {
  let url = req.originalUrl;
  if (url.startsWith(CALLBACK_PREFIX)) {
    const rest = url.slice(CALLBACK_PREFIX.length);
    const slash = rest.indexOf('/');
    url = `${CALLBACK_PREFIX}[token]${slash >= 0 ? rest.slice(slash) : ''}`;
  }
  return url.replace(/([?&](?:token|key|secret|code)=)[^&]*/gi, '$1[redacted]');
}

export function createApp({
  config,
  repository,
  crypto,
  ussdHandler,
  logger = console,
}: {
  config: AppConfig;
  repository: CallbackRepository;
  crypto: Pick<Crypto, 'fingerprint'>;
  ussdHandler(body: UssdCallback, requestId: string): Promise<string>;
  logger?: Pick<Console, 'error' | 'info'>;
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-ID': res.locals.requestId,
    });
    const startedAt = Date.now();
    res.on('finish', () => {
      const entry: Record<string, unknown> = {
        event: 'http_request',
        requestId: res.locals.requestId,
        method: req.method,
        url: logUrl(req),
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      };
      if (config.httpLogBodies !== 'off') {
        const body = req.body;
        entry.body =
          config.httpLogBodies === 'full' ? (body ?? null) : (redactBody(body) ?? null);
      }
      logger.info(JSON.stringify(entry));
    });
    next();
  });
  app.get('/health/live', (req, res) => res.json({ status: 'live' }));
  app.get('/health/ready', async (req, res) => {
    try {
      await repository.ready();
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  const callbacks = express.Router();
  callbacks.use(providerOrigin(config));
  callbacks.use(async (req, res, next) => {
    try {
      const scope = crypto.fingerprint(`callback-ip:${req.ip}`);
      if (!(await repository.takeRateLimit(scope, config.callbackRatePerMinute, 60))) {
        return res.status(429).set('Retry-After', '60').type('text').send('Retry later');
      }
      next();
    } catch (error) {
      next(error);
    }
  });
  callbacks.use(
    express.urlencoded({
      extended: false,
      limit: config.callbackBodyLimitBytes,
      parameterLimit: 20,
      inflate: false,
    }),
  );
  callbacks.use(
    express.json({ limit: config.callbackBodyLimitBytes, strict: true, inflate: false }),
  );
  // One noisy phone must not use up everyone else's share of the provider IPs.
  callbacks.use(async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sender = typeof body.from === 'string' ? body.from : body.phoneNumber;
      if (typeof sender === 'string' && sender) {
        const scope = crypto.fingerprint(`callback-phone:${sender.replace(/\D/g, '')}`);
        if (!(await repository.takeRateLimit(scope, config.callbackPhoneRatePerMinute, 60))) {
          return res.status(429).set('Retry-After', '60').type('text').send('Retry later');
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  });
  callbacks.post('/sms/inbound', async (req, res) => {
    const body = smsSchema.parse(req.body);
    if (!config.atSmsInboundNumbers.some((number) => sameNumber(number, body.to)))
      return res.status(403).type('text').send('Unprovisioned number');
    await repository.acceptSms(body, String(res.locals.requestId));
    res.status(200).type('text').send('OK');
  });
  callbacks.post('/sms/delivery', async (req, res) => {
    const body = deliverySchema.parse(req.body);
    await repository.acceptDelivery(body);
    res.status(200).type('text').send('OK');
  });
  callbacks.post('/ussd', async (req, res) => {
    const body = ussdSchema.parse(req.body);
    if (body.serviceCode !== config.atUssdServiceCode || !config.atUssdServiceCode)
      return res.status(403).type('text').send('Forbidden');
    const response = await ussdHandler(body, String(res.locals.requestId));
    res.status(200).type('text/plain').send(response);
  });
  callbacks.post('/ussd/events', async (req, res) => {
    const body = eventSchema.parse(req.body);
    if (body.serviceCode && body.serviceCode !== config.atUssdServiceCode)
      return res.status(403).type('text').send('Forbidden');
    await repository.endUssdSession(body);
    res.status(200).type('text').send('OK');
  });
  // Temporary AT compatibility: some sandbox USSD session events are posted to
  // "/" instead of the configured events path. Remove once AT fixes the routing.
  app.post(
    '/',
    providerOrigin(config),
    express.urlencoded({
      extended: false,
      limit: config.callbackBodyLimitBytes,
      parameterLimit: 20,
      inflate: false,
    }),
    express.json({ limit: config.callbackBodyLimitBytes, strict: true, inflate: false }),
    async (req, res) => {
      const body = eventSchema.parse(req.body);
      if (body.serviceCode && body.serviceCode !== config.atUssdServiceCode)
        return res.status(403).type('text').send('Forbidden');
      await repository.endUssdSession(body);
      res.status(200).type('text').send('OK');
    },
  );

  app.use(`/callbacks/africastalking/${config.callbackPathKey}`, callbacks);
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  const handleError: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof z.ZodError || error.type === 'entity.parse.failed')
      return res.status(400).type('text').send('Invalid callback');
    if (error.type === 'entity.too.large')
      return res.status(413).type('text').send('Callback too large');
    if (error.status === 415)
      return res.status(415).type('text').send('Unsupported content encoding');
    // Error messages, request URLs and SQL parameters can contain secrets or PHI.
    logger.error({ event: 'callback_failure', requestId: res.locals.requestId });
    if (req.path.endsWith('/ussd'))
      return res
        .status(200)
        .type('text/plain')
        .send('END HealthAccess is temporarily unavailable. Please try again.');
    res.status(503).type('text').send('Temporarily unavailable');
  };
  app.use(handleError);
  return app;
}
