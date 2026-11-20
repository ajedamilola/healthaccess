import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  buildProjection,
  deniedProjection,
  isConsentLive,
  isGrantLive,
  type ConsentScope,
  type GrantScope,
  type RecordField,
} from '@healthaccess/shared';
import type { Config } from './config.js';
import { EXPLICIT_ENGLISH, toLocale, type Locale } from './channels/i18n.js';
import type { Crypto } from './security/crypto.js';
import { prisma as sharedPrisma, prismaFor } from './db.js';
import type { InboundSms, UssdCallback, UssdEvent } from './app.js';
import type {
  Area,
  Facility,
  OwnCodes,
  PersonalHints,
  Projection,
  SavedArea,
  Service,
  SmsContext,
  SmsReply,
  WebLead,
} from './types.js';
import type { SmsRepository } from './channels/sms.js';
import type { UssdContext, UssdRepository, UssdSession, UssdResult } from './channels/ussd.js';

type Db = Prisma.TransactionClient;

interface Actor {
  phone_digest: string;
  request_id: string;
  session_id?: string;
}

export interface InboxJob {
  id: string;
  phone_digest: string;
  body_envelope: string;
  attempts: number;
  claimed_by: string;
}

export interface OutboxJob {
  id: string;
  kind: SmsReply['kind'];
  recipient_phone_envelope: string;
  render_ref: SmsReply | { envelope: string; allowAfterStop?: boolean };
  attempts: number;
  claimed_by: string;
}

export type StoredUssdSession = UssdSession & {
  inputDepth: number;
  inputFingerprint: string | null;
};

export type SessionRepository = UssdRepository &
  SmsRepository & {
    saveSession(result: UssdResult & { inputDepth: number; inputFingerprint: string }): Promise<void>;
  };

interface UssdSessionRow {
  id: string;
  phone_digest: string;
  service_code: string | null;
  state: string;
  context: UssdContext;
  expires_at: Date;
  read_session_id: string | null;
  path_depth: number;
  path_digest: string | null;
  ended_at: Date | null;
}

interface FacilityRow {
  id: string;
  name: string;
  address: string;
  phone: string | null;
  distance_km: number | null;
  is_demo: boolean;
  service_code: string;
}

interface ProjectionRow {
  key: string;
  label: string;
  value: unknown;
}

interface AreaRow {
  id: string;
  name: string;
  region: string;
  city: string;
}

const OUTBOX_KIND = {
  text: 'TEXT',
  emergency: 'EMERGENCY',
  facility: 'FACILITY',
  web_lead: 'WEB_LEAD',
} as const;

const OUTBOX_STATUS = {
  queued: 'QUEUED',
  sending: 'SENDING',
  accepted: 'ACCEPTED',
  delivered: 'DELIVERED',
  failed: 'FAILED',
  unknown: 'UNKNOWN',
  expired: 'EXPIRED',
} as const;

type OutboxStatusValue = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

function deliveryStatus(raw: string): string {
  const status = raw.toLowerCase();
  if (status === 'success' || status === 'delivered') return 'delivered';
  if (['rejected', 'failed', 'undelivered'].includes(status)) return 'failed';
  if (['sent', 'submitted', 'buffered'].includes(status)) return 'accepted';
  if (status === 'expired') return 'expired';
  return 'unknown';
}

function validDigest(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function distanceKm(
  lat1: number | null,
  lon1: number | null,
  lat2: number | null,
  lon2: number | null,
): number | null {
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) return null;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const value =
    6371 *
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin(radians(lat2 - lat1) / 2) ** 2 +
          Math.cos(radians(lat1)) *
            Math.cos(radians(lat2)) *
            Math.sin(radians(lon2 - lon1) / 2) ** 2,
      ),
    );
  return Math.round(value * 1000) / 1000;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// Live search providers format Nigerian numbers with spaces, dots or parentheses.
// Normalize before validation so emergency leads keep their contact number.
export function normalizePhoneNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[\s().-]+/g, '');
  if (!compact) return null;
  return /^\+[1-9][0-9]{7,14}$/.test(compact) ? compact : null;
}

const HINT_TEXT = /^[\p{L}\p{N} ,.'()/-]{1,80}$/u;

function hintText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || /\d{6,}/.test(text) || !HINT_TEXT.test(text)) return null;
  return text;
}

function hintList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return items
    .map(hintText)
    .filter((item): item is string => Boolean(item))
    .slice(0, 8);
}

export function ageBandFrom(value: unknown, now = new Date()): string | null {
  if (typeof value !== 'string') return null;
  const born = new Date(value);
  if (Number.isNaN(born.getTime()) || born > now) return null;
  const age = (now.getTime() - born.getTime()) / (365.25 * 864e5);
  if (age < 1) return 'infant';
  if (age < 5) return 'young child';
  if (age < 13) return 'child';
  if (age < 18) return 'teenager';
  if (age < 40) return 'adult under 40';
  if (age < 65) return 'adult 40-64';
  return 'older adult 65+';
}

export function personalHintsFrom(fields: RecordField[], language: string): PersonalHints {
  const value = (key: string) => fields.find((field) => field.key === key)?.value;
  const merge = (...keys: string[]) => [...new Set(keys.flatMap((key) => hintList(value(key))))];
  return {
    ageBand: ageBandFrom(value('date_of_birth')),
    sex: hintText(value('gender')),
    pregnancy: hintText(value('pregnancy_status')),
    conditions: merge('conditions', 'existing_conditions'),
    allergies: merge('allergies'),
    medications: merge('current_medications', 'existing_medications'),
    language: /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(language) ? language.toLowerCase() : 'en',
  };
}

export class Repository {
  readonly prisma: PrismaClient;
  private readonly ownsPrisma: boolean;

  constructor(
    private config: Config,
    private crypto: Crypto,
    client?: PrismaClient,
  ) {
    this.prisma = client ?? prismaFor(config.databaseUrl);
    this.ownsPrisma = !client && this.prisma !== sharedPrisma;
  }

  async ready(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async close(): Promise<void> {
    if (this.ownsPrisma) await this.prisma.$disconnect();
  }

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async takeRateLimit(
    scope: string,
    limit: number,
    seconds: number,
    database: Db = this.prisma,
  ): Promise<boolean> {
    const rows = await database.$queryRaw<Array<{ hits: number }>>(
      Prisma.sql`INSERT INTO "rate_limits" ("scope", "window_start", "hits")
      VALUES (${scope}, to_timestamp(floor(extract(epoch FROM clock_timestamp()) / ${seconds}::int) * ${seconds}::int), 1)
      ON CONFLICT ("scope", "window_start") DO UPDATE SET "hits" = "rate_limits"."hits" + 1
      RETURNING "hits"`,
    );
    return (rows[0]?.hits ?? 0) <= limit;
  }

  async acceptSms(body: InboundSms, requestId: string): Promise<void> {
    await this.prisma.smsInbox.createMany({
      data: [
        {
          provider: 'africastalking',
          provider_message_id: body.id,
          phone_digest: this.crypto.digestPhone(body.from),
          body_envelope: this.crypto.encrypt({ ...body, requestId }, 'sms-inbox'),
          status: 'QUEUED',
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      ],
      skipDuplicates: true,
    });
  }

  async acceptDelivery(body: { id: string; status: string }): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.deliveryEvent.createMany({
        data: [
          {
            provider: 'africastalking',
            provider_message_id: body.id,
            status: deliveryStatus(body.status),
            event_fingerprint: this.crypto.fingerprint(JSON.stringify([body.id, body.status])),
          },
        ],
        skipDuplicates: true,
      });
      await this.reconcileDelivery(tx);
    });
  }

  private async reconcileDelivery(database: Db): Promise<void> {
    await database.$executeRaw`UPDATE "outbox" AS job SET status = 'DELIVERED'
      WHERE job.status <> 'DELIVERED' AND EXISTS (SELECT 1 FROM "delivery_events" AS event
        WHERE event.provider_message_id = job.provider_message_id AND event.status = 'delivered')`;
    await database.$executeRaw`UPDATE "outbox" AS job SET status = 'FAILED'
      WHERE job.status IN ('ACCEPTED', 'UNKNOWN', 'SENDING') AND EXISTS (
        SELECT 1 FROM "delivery_events" AS event WHERE event.provider_message_id = job.provider_message_id
        AND event.status = 'failed')`;
    await database.$executeRaw`UPDATE "outbox" AS job SET status = 'UNKNOWN'
      WHERE job.status = 'ACCEPTED' AND EXISTS (SELECT 1 FROM "delivery_events" AS event
        WHERE event.provider_message_id = job.provider_message_id AND event.status IN ('unknown','expired'))`;
  }

  private actorRepository(
    actor: Actor,
    database: Db,
    currentPhone?: string,
    careContext?: { serviceCode?: string; areaId?: string; radiusKm?: number },
  ): SmsRepository & UssdRepository {
    const readEmergency = async (digest: string): Promise<Projection> => {
      const limit = actor.session_id ? 60 : this.config.lookupRatePerMinute;
      const allowed = await this.takeRateLimit(
        `lookup-phone:${actor.phone_digest}`,
        limit,
        60,
        database,
      );
      const targetAllowed = await this.takeRateLimit(
        `lookup-target:${digest}`,
        60,
        60,
        database,
      );
      if (!allowed || !targetAllowed) return { available: false, fields: [] };
      return this.readEmergencySummary(
        digest,
        actor,
        actor.session_id ? 'ussd' : 'sms',
        database,
      );
    };
    return {
      listServices: () => this.listServices(database),
      findAreas: (query) => this.findAreas(query, 5, database),
      findFacilities: (service, areaId, radius) =>
        this.findFacilities(service, areaId, radius, 3, database),
      getFacility: async (id, serviceCode, areaId, radiusKm) => {
        const current = await this.findFacilities(serviceCode, areaId, radiusKm, 10, database);
        return current.find((facility) => facility.id === id) || null;
      },
      readEmergency,
      openGrant: async (patientDigest, grantDigest) => {
        if (
          !(await this.takeRateLimit(
            `grant:${actor.phone_digest}`,
            this.config.lookupRatePerMinute,
            60,
            database,
          ))
        )
          return { available: false, fields: [] };
        return this.openGrantedRecord(patientDigest, grantDigest, actor, database);
      },
      readGrant: (id) => this.readGrantedRecord(id, actor, database),
      closeReadSession: (id) => this.closeGrantedRecord(id, actor, database),
      findProfileConsent: () => this.findProfileConsent(actor, database),
      findSavedArea: () => this.findSavedArea(actor, database),
      readPersonalHints: () => this.readPersonalHints(actor, database),
      readOwnCodes: () => this.readOwnCodes(actor, database),
      getLocale: () => this.getLocale(actor, database),
      setLocale: (locale) => this.setLocale(actor, locale, database),
      createQuickGrant: (minutes) => this.createQuickGrant(actor, minutes, database),
      readMatchingContext: (id) => this.readProfileContext(id, actor, database),
      setOptOut: (optedOut) => this.setOptOut(database, actor.phone_digest, optedOut),
      storeWebLeads: (leads) => this.storeWebLeads(leads, database),
      getWebLead: (id) => this.getWebLead(id, database),
      recordEmergencyRequest: (request) =>
        this.recordEmergencyRequest({ ...request, request_id: actor.request_id }, database),
      recordReferral: (referral) => this.recordReferral(referral, actor, database),
      queueFacilitySms: async (facilityId) => {
        if (!actor.session_id || !currentPhone) return false;
        if (!careContext?.serviceCode || !careContext.areaId) return false;
        const baseKey = `ussd:${actor.session_id}:facility:${facilityId}`;
        const previous = await database.outbox.findMany({
          where: {
            OR: [
              { logical_key: baseKey },
              { logical_key: { startsWith: `${baseKey}:retry:` } },
            ],
          },
          select: { status: true, logical_key: true },
          orderBy: { created_at: 'asc' },
        });
        const statuses = previous.map((row) => row.status.toLowerCase());
        if (
          statuses.some((status) => ['queued', 'sending', 'accepted', 'delivered'].includes(status))
        )
          return true;
        // An unknown send may already have reached the phone. Do not resend it automatically.
        if (statuses.includes('unknown')) return false;
        const retries = previous.filter((row) =>
          row.logical_key.startsWith(`${baseKey}:retry:`),
        ).length;
        if (retries >= 3) return false;
        const logicalKey = previous.length ? `${baseKey}:retry:${retries + 1}` : baseKey;
        return this.queueReply(database, logicalKey, currentPhone, {
          kind: 'facility',
          id: facilityId,
          serviceCode: careContext.serviceCode,
          areaId: careContext.areaId,
          radiusKm: careContext.radiusKm || this.config.searchRadiusKm,
        });
      },
    };
  }

  async withUssdSession(
    body: UssdCallback,
    requestId: string,
    work: (session: StoredUssdSession | null, scoped: SessionRepository) => Promise<string>,
  ): Promise<string> {
    return this.transaction(async (tx) => {
      await tx.ussdSession.createMany({
        data: [
          {
            provider: 'africastalking',
            provider_session_id: body.sessionId,
            phone_digest: this.crypto.digestPhone(body.phoneNumber),
            service_code: body.serviceCode,
            state: 'MAIN',
            context: {},
            path_depth: -1,
            expires_at: new Date(Date.now() + this.config.ussdSessionTtlSeconds * 1000),
          },
        ],
        skipDuplicates: true,
      });
      const rows = await tx.$queryRaw<UssdSessionRow[]>(
        Prisma.sql`SELECT * FROM "ussd_sessions" WHERE provider = 'africastalking'
        AND provider_session_id = ${body.sessionId} FOR UPDATE`,
      );
      const row = rows[0];
      if (!row || row.ended_at) return 'END Session ended. Please redial.';
      const session: StoredUssdSession = {
        id: row.id,
        providerSessionId: body.sessionId,
        phoneDigest: row.phone_digest,
        serviceCode: row.service_code ?? '',
        state: row.state as UssdSession['state'],
        context: row.context ?? {},
        expiresAt: row.expires_at,
        readSessionId: row.read_session_id,
        inputDepth: row.path_depth,
        inputFingerprint: row.path_digest,
      };
      const actor = { session_id: row.id, phone_digest: row.phone_digest, request_id: requestId };
      const scoped: SessionRepository = {
        ...this.actorRepository(actor, tx, body.phoneNumber, row.context),
        saveSession: async (next) => {
          await tx.ussdSession.update({
            where: { id: row.id },
            data: {
              state: next.state,
              context: next.context as Prisma.InputJsonValue,
              path_depth: next.inputDepth,
              path_digest: next.inputFingerprint,
              read_session_id: next.readSessionId || null,
              version: { increment: 1 },
            },
          });
        },
      };
      return work(session, scoped);
    });
  }

  async endUssdSession(body: UssdEvent): Promise<void> {
    await this.prisma.ussdSession.updateMany({
      where: {
        provider: 'africastalking',
        provider_session_id: body.sessionId,
        ...(body.phoneNumber ? { phone_digest: this.crypto.digestPhone(body.phoneNumber) } : {}),
      },
      data: { ended_at: new Date(), state: 'END', context: {}, read_session_id: null },
    });
  }

  async claimInbox(workerId: string): Promise<InboxJob | null> {
    const rows = await this.prisma.$queryRaw<InboxJob[]>(
      Prisma.sql`UPDATE "sms_inbox" SET status = 'PROCESSING',
      claimed_by = ${workerId}, lease_until = now() + ${this.config.workerLeaseSeconds}::int * interval '1 second',
      attempts = attempts + 1
      WHERE id = (SELECT id FROM "sms_inbox" AS candidate WHERE expires_at > now() AND attempts < ${this.config.workerMaxAttempts}::int
        AND ((status = 'QUEUED' AND next_attempt_at <= now()) OR (status = 'PROCESSING' AND lease_until < now()))
        AND NOT EXISTS (SELECT 1 FROM "sms_inbox" AS earlier WHERE earlier.phone_digest = candidate.phone_digest
          AND earlier.status IN ('QUEUED','PROCESSING') AND (earlier.created_at, earlier.id) < (candidate.created_at, candidate.id))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    );
    return rows[0] || null;
  }

  async processInbox(
    job: InboxJob,
    handle: (
      body: InboundSms,
      repository: SmsRepository,
      conversation: { state: string; context: SmsContext },
    ) => Promise<{ state: string; context: SmsContext; replies: SmsReply[] }>,
  ): Promise<void> {
    const ownership = await this.prisma.smsInbox.findFirst({
      where: {
        id: job.id,
        claimed_by: job.claimed_by,
        status: 'PROCESSING',
        lease_until: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!ownership) return;
    const body = this.crypto.decrypt<InboundSms & { requestId: string }>(
      job.body_envelope,
      'sms-inbox',
    );
    const found = await this.prisma.smsConversation.findUnique({
      where: { phone_digest: job.phone_digest },
      select: { state: true, context: true, expires_at: true, version: true },
    });
    const existing = found ?? null;
    const conversation =
      existing && existing.expires_at > new Date()
        ? { state: existing.state, context: this.openHistory(existing.context as SmsContext) }
        : { state: 'idle', context: {} };
    const scoped = this.actorRepository(
      { phone_digest: job.phone_digest, request_id: body.requestId },
      this.prisma,
    );
    let optOut: boolean | undefined;
    scoped.setOptOut = async (value) => {
      optOut = value;
    };
    const allowed =
      /^STOP$/i.test(body.text.trim()) ||
      (await this.takeRateLimit(
        `sms-phone:${job.phone_digest}`,
        this.config.phoneRatePerMinute,
        60,
      ));
    // External AI/search calls run without an open DB transaction or pool lease.
    const result = allowed
      ? await handle(body, scoped, conversation)
      : {
          // Keep the thread (and its memory) so the next message continues it.
          state: conversation.state,
          context: conversation.context,
          replies: [
            {
              kind: 'text' as const,
              text: 'Too many messages. Please wait a minute and try again.',
            },
          ],
        };

    const storedContext = this.sealHistory(result.context);
    await this.transaction(async (tx) => {
      const currentJob = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM "sms_inbox" WHERE id = ${job.id}::uuid AND claimed_by = ${job.claimed_by}
        AND status = 'PROCESSING' AND lease_until > now() FOR UPDATE`,
      );
      if (!currentJob.length) return;
      const current = await tx.$queryRaw<Array<{ version: number }>>(
        Prisma.sql`SELECT version FROM "sms_conversations" WHERE phone_digest = ${job.phone_digest} FOR UPDATE`,
      );
      if (current[0]?.version !== existing?.version) {
        throw new Error('Conversation changed while processing');
      }
      if (optOut !== undefined) await this.setOptOut(tx, job.phone_digest, optOut);
      await tx.smsConversation.upsert({
        where: { phone_digest: job.phone_digest },
        create: {
          phone_digest: job.phone_digest,
          state: result.state,
          context: storedContext as Prisma.InputJsonValue,
          expires_at: new Date(Date.now() + this.config.smsConversationTtlSeconds * 1000),
        },
        update: {
          state: result.state,
          context: storedContext as Prisma.InputJsonValue,
          expires_at: new Date(Date.now() + this.config.smsConversationTtlSeconds * 1000),
          version: { increment: 1 },
        },
      });
      for (const [index, reply] of result.replies.entries()) {
        await this.queueReply(tx, `sms:${job.id}:${index}`, body.from, reply);
      }
      await tx.smsInbox.updateMany({
        where: { id: job.id, claimed_by: job.claimed_by, status: 'PROCESSING' },
        data: { status: 'PROCESSED', lease_until: null },
      });
    });
  }

  private async setOptOut(database: Db, phoneDigest: string, optedOut: boolean): Promise<void> {
    await database.channelPreference.upsert({
      where: { phone_digest: phoneDigest },
      create: { phone_digest: phoneDigest, opted_out: optedOut },
      update: { opted_out: optedOut },
    });
    if (optedOut) {
      await database.outbox.updateMany({
        where: { status: 'QUEUED', recipient_phone_digest: phoneDigest },
        data: { status: 'EXPIRED' },
      });
    }
  }

  private async queueReply(
    client: Db,
    logicalKey: string,
    phone: string,
    reply: SmsReply,
  ): Promise<boolean> {
    const reference =
      reply.kind === 'text'
        ? {
            envelope: this.crypto.encrypt(reply.text, 'sms-text'),
            allowAfterStop: !!reply.allowAfterStop,
          }
        : reply;
    try {
      await client.outbox.create({
        data: {
          logical_key: logicalKey,
          kind: OUTBOX_KIND[reply.kind],
          recipient_phone_envelope: this.crypto.encrypt(phone, 'sms-recipient'),
          render_ref: reference as Prisma.InputJsonValue,
          status: 'QUEUED',
          expires_at: new Date(Date.now() + this.config.smsReplyTtlSeconds * 1000),
          recipient_phone_digest: this.crypto.digestPhone(phone),
        },
      });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const existing = await client.outbox.findUnique({
      where: { logical_key: logicalKey },
      select: { status: true },
    });
    return ['queued', 'sending', 'accepted', 'delivered'].includes(
      existing?.status?.toLowerCase() || '',
    );
  }

  async failInbox(job: InboxJob): Promise<void> {
    await this.prisma.$executeRaw`UPDATE "sms_inbox"
      SET status = CASE WHEN attempts >= ${this.config.workerMaxAttempts}::int THEN 'FAILED' ELSE 'QUEUED' END,
      next_attempt_at = now() + least(300, power(2, attempts)) * interval '1 second',
      lease_until = NULL
      WHERE id = ${job.id}::uuid AND claimed_by = ${job.claimed_by} AND status = 'PROCESSING'`;
  }

  async claimOutbox(workerId: string): Promise<OutboxJob | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        kind: string;
        recipient_phone_envelope: string;
        render_ref: OutboxJob['render_ref'];
        attempts: number;
        claimed_by: string;
      }>
    >(
      Prisma.sql`UPDATE "outbox" SET status = 'SENDING', claimed_by = ${workerId},
      lease_until = now() + ${this.config.workerLeaseSeconds}::int * interval '1 second',
      attempts = attempts + 1 WHERE id = (SELECT id FROM "outbox"
      WHERE status = 'QUEUED' AND next_attempt_at <= now() AND expires_at > now() AND attempts < ${this.config.workerMaxAttempts}::int
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      kind: row.kind.toLowerCase() as SmsReply['kind'],
    };
  }

  async renderOutbox(job: OutboxJob): Promise<{
    phone: string;
    reply: SmsReply;
    suppressed?: boolean;
    projection?: Projection;
    facility?: Facility | null;
    lead?: WebLead | null;
  }> {
    const phone = this.crypto.decrypt<string>(job.recipient_phone_envelope, 'sms-recipient');
    const reply =
      job.kind === 'text' && 'envelope' in job.render_ref
        ? {
            kind: 'text' as const,
            text: this.crypto.decrypt<string>(job.render_ref.envelope, 'sms-text'),
            allowAfterStop: job.render_ref.allowAfterStop,
          }
        : (job.render_ref as SmsReply);
    const actor = { phone_digest: this.crypto.digestPhone(phone), request_id: job.id };
    const preference = await this.prisma.channelPreference.findUnique({
      where: { phone_digest: actor.phone_digest },
      select: { opted_out: true },
    });
    if (preference?.opted_out && !(reply.kind === 'text' && reply.allowAfterStop)) {
      return { phone, reply, suppressed: true };
    }
    if (reply.kind === 'emergency') {
      return {
        phone,
        reply,
        projection: await this.readEmergencySummary(reply.codeDigest, actor, 'sms'),
      };
    }
    if (reply.kind === 'facility') {
      const current =
        reply.serviceCode && reply.areaId
          ? await this.findFacilities(
              reply.serviceCode,
              reply.areaId,
              reply.radiusKm || this.config.searchRadiusKm,
              10,
            )
          : [];
      return {
        phone,
        reply,
        facility: current.find((facility) => facility.id === reply.id) || null,
      };
    }
    if (reply.kind === 'web_lead') {
      return { phone, reply, lead: await this.getWebLead(reply.id) };
    }
    return { phone, reply };
  }

  async finishOutbox(
    job: OutboxJob,
    result: { state: string; providerMessageId: string | null; retryable: boolean },
  ): Promise<void> {
    const status: OutboxStatusValue =
      result.retryable && job.attempts < this.config.workerMaxAttempts
        ? OUTBOX_STATUS.queued
        : OUTBOX_STATUS[result.state as keyof typeof OUTBOX_STATUS] || OUTBOX_STATUS.failed;
    await this.transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "outbox" SET status = ${status}::"OutboxStatus",
        provider_message_id = COALESCE(${result.providerMessageId}::text, provider_message_id),
        lease_until = NULL,
        next_attempt_at = now() + least(300, power(2, attempts)) * interval '1 second'
        WHERE id = ${job.id}::uuid AND claimed_by = ${job.claimed_by} AND status = 'SENDING'`;
      await this.reconcileDelivery(tx);
    });
  }

  async findReviewedContent(query: string): Promise<unknown[]> {
    const value = (query || '').trim().toLowerCase();
    if (!value) return [];
    const rows = await this.prisma.reviewedHealthContent.findMany({
      where: {
        status: 'PUBLISHED',
        reviewed_at: { not: null },
        OR: [
          { topic_code: { contains: value, mode: 'insensitive' } },
          { title: { contains: value, mode: 'insensitive' } },
          { body: { contains: value, mode: 'insensitive' } },
        ],
      },
      include: { reviewer: { select: { display_name: true } } },
      orderBy: [{ topic_code: 'asc' }, { version: 'desc' }],
      take: 3,
    });
    return rows.map((row) => ({
      id: row.id,
      topic: row.topic_code,
      language: row.language,
      version: row.version,
      body: row.body,
      reviewer: row.reviewer?.display_name ?? '',
      reviewed_at: row.reviewed_at,
    }));
  }

  private async listServices(database: Db = this.prisma): Promise<Service[]> {
    return database.service.findMany({
      where: { active: true },
      orderBy: [{ sort_order: 'asc' }, { service_code: 'asc' }],
      select: { service_code: true, label: true, description: true },
    });
  }

  private async findAreas(
    query: string,
    limit: number,
    database: Db = this.prisma,
  ): Promise<Area[]> {
    const value = (query || '').trim().toLowerCase();
    const rows = await database.area.findMany({
      where: {
        active: true,
        country_code: 'NG',
        ...(value
          ? {
              OR: [
                { name: { startsWith: value, mode: 'insensitive' as const } },
                { city: { startsWith: value, mode: 'insensitive' as const } },
                { region: { startsWith: value, mode: 'insensitive' as const } },
                {
                  aliases: {
                    some: { alias_normalized: { startsWith: value } },
                  },
                },
              ],
            }
          : {}),
      },
      include: { aliases: { select: { alias_normalized: true } } },
    });
    const ranked = rows
      .map((row) => ({
        row,
        rank:
          value &&
          (row.name.toLowerCase() === value ||
            row.city.toLowerCase() === value ||
            row.region.toLowerCase() === value ||
            row.aliases.some((alias) => alias.alias_normalized === value))
            ? 0
            : 1,
      }))
      .sort((left, right) => left.rank - right.rank || left.row.name.localeCompare(right.row.name))
      .slice(0, Math.max(1, Math.min(limit || 5, 10)));
    return ranked.map(({ row }) => ({
      id: row.id,
      name: row.name,
      region: row.region,
      city: row.city,
    }));
  }

  private async findFacilities(
    serviceCode: string,
    areaId: string,
    radiusKm: number,
    limit: number,
    database: Db = this.prisma,
  ): Promise<Facility[]> {
    return database.$queryRaw<FacilityRow[]>(
      Prisma.sql`WITH area AS (
        SELECT a.id, a.country_code, a.center_latitude, a.center_longitude
        FROM "areas" a
        WHERE a.id = ${areaId}::uuid AND a.active
      ), eligible AS (
        SELECT f.id, f.name, f.address, f.phone, f.is_demo, f.area_id, a.id AS requested_area_id, fs.service_code,
          CASE
            WHEN a.center_latitude IS NULL OR a.center_longitude IS NULL OR f.latitude IS NULL OR f.longitude IS NULL THEN NULL
            ELSE round((6371.0 * 2.0 * asin(sqrt(
              power(sin(radians(f.latitude::float8 - a.center_latitude::float8) / 2.0), 2)
              + cos(radians(a.center_latitude::float8))
              * cos(radians(f.latitude::float8))
              * power(sin(radians(f.longitude::float8 - a.center_longitude::float8) / 2.0), 2)
            )))::numeric, 3)::float8
          END AS distance_km
        FROM area a
        JOIN "facilities" f ON f.status = 'APPROVED' AND f.is_demo = false
        JOIN "areas" facility_area ON facility_area.id = f.area_id
          AND facility_area.active AND facility_area.country_code = a.country_code
        JOIN "facility_services" fs ON fs.facility_id = f.id
          AND fs.service_code = ${serviceCode}::text
          AND fs.verification_status = 'APPROVED'
        JOIN "services" s ON s.service_code = fs.service_code AND s.active
      ), bounded AS (
        SELECT e.*
        FROM eligible e
        WHERE (e.distance_km IS NULL AND e.area_id = e.requested_area_id)
          OR e.distance_km <= least(greatest(coalesce(${radiusKm}::numeric, 25), 1), 200)
        ORDER BY e.distance_km NULLS LAST, e.name
        LIMIT greatest(1, least(coalesce(${limit}::int, 3), 10))
      )
      SELECT b.id, b.name, b.address, b.phone, b.distance_km, b.is_demo, b.service_code
      FROM bounded b ORDER BY b.distance_km NULLS LAST, b.name`,
    );
  }

  async getWebLead(id: string, database: Db = this.prisma): Promise<WebLead | null> {
    const lead = await database.webLead.findFirst({
      where: { id, status: { in: ['UNVERIFIED', 'REVIEW_CANDIDATE'] } },
      include: { source: { select: { trust_tier: true } } },
    });
    if (!lead) return null;
    return {
      name: lead.name,
      address: lead.address,
      phone: lead.phone,
      latitude: null,
      longitude: null,
      source_url: lead.source_url,
      source_reference: lead.source_url,
      verification_status: 'unverified',
      service_label: '',
    };
  }

  private cleanLead(lead: WebLead) {
    const clean = (value: unknown, limit: number) => {
      const text = typeof value === 'string' ? value.trim() : '';
      return text ? text.slice(0, limit) : null;
    };
    const name = clean(lead.name, 200);
    const address = clean(lead.address, 500);
    const url = clean(lead.source_url, 2048);
    const snippet = clean((lead as unknown as { snippet?: unknown }).snippet, 1000);
    const title = clean((lead as unknown as { title?: unknown }).title, 300);
    const phone = normalizePhoneNumber(clean(lead.phone, 40));
    if (!name || !address || !url || !/^https?:\/\//.test(url)) return null;
    const provided = clean(
      (lead as unknown as { content_fingerprint?: unknown }).content_fingerprint,
      64,
    );
    const fingerprint =
      provided && /^[0-9a-f]{32,64}$/.test(provided)
        ? provided
        : createHash('md5')
            .update(`${name.toLowerCase()}|${address.toLowerCase()}|${url}`)
            .digest('hex');
    return { name, address, url, phone, snippet, title, fingerprint };
  }

  private async storeWebLeads(leads: WebLead[], database: Db = this.prisma): Promise<string[]> {
    if (!Array.isArray(leads)) return [];
    const ids: string[] = [];
    for (const raw of leads.slice(0, 5)) {
      const lead = this.cleanLead(raw);
      if (!lead) continue;
      const source = await database.source.upsert({
        where: { canonical_url: lead.url },
        create: {
          source_kind: 'SERPER_WEB',
          publisher: null,
          canonical_url: lead.url,
          retrieved_at: new Date(),
          query_text: null,
          trust_tier: 'UNVERIFIED_WEB',
          metadata: lead.title ? { title: lead.title } : {},
        },
        update: { retrieved_at: new Date() },
      });
      const saved = await database.webLead.upsert({
        where: {
          source_url_content_fingerprint: {
            source_url: lead.url,
            content_fingerprint: lead.fingerprint,
          },
        },
        create: {
          source_id: source.id,
          name: lead.name,
          address: lead.address,
          phone: lead.phone,
          source_url: lead.url,
          snippet: lead.snippet,
          observed_at: new Date(),
          status: 'UNVERIFIED',
          content_fingerprint: lead.fingerprint,
        },
        update: {
          name: lead.name,
          address: lead.address,
          phone: lead.phone,
          snippet: lead.snippet,
          observed_at: new Date(),
        },
      });
      ids.push(saved.id);
    }
    return ids;
  }

  async recordEmergencyRequest(
    request: {
      channel: 'SMS' | 'USSD';
      area_id: string | null;
      location_text: string;
      results: WebLead[];
      request_id?: string;
    },
    database: Db = this.prisma,
  ): Promise<void> {
    const results = (Array.isArray(request.results) ? request.results : [])
      .slice(0, 8)
      .map((lead) => ({
        name: typeof lead.name === 'string' ? lead.name.slice(0, 200) : '',
        address: typeof lead.address === 'string' ? lead.address.slice(0, 500) : '',
        phone: normalizePhoneNumber(lead.phone),
        source_url: typeof lead.source_url === 'string' ? lead.source_url.slice(0, 2048) : '',
        source_reference:
          typeof lead.source_reference === 'string' ? lead.source_reference.slice(0, 300) : '',
        verification_status: 'unverified' as const,
        service_label:
          typeof lead.service_label === 'string' ? lead.service_label.slice(0, 80) : '',
      }))
      .filter((lead) => lead.name && lead.source_url);
    let areaId: string | null = null;
    if (request.area_id) {
      const area = await database.area.findFirst({
        where: { id: request.area_id, active: true },
        select: { id: true },
      });
      areaId = area?.id ?? null;
    }
    const location = typeof request.location_text === 'string' ? request.location_text.trim() : '';
    await database.emergencyRequest.create({
      data: {
        channel: request.channel,
        kind: 'emergency',
        area_id: areaId,
        location_text: location ? location.slice(0, 300) : null,
        status: results.length ? 'MATCHED' : 'NO_MATCH',
        results: results as unknown as Prisma.InputJsonValue,
        request_id: request.request_id ?? '',
      },
    });
  }

  private async recordReferral(
    referral: {
      serviceCode: string;
      areaId: string;
      facilities: Facility[];
      consentId: string | null;
    },
    actor: Actor,
    database: Db = this.prisma,
  ): Promise<void> {
    const channel = actor.session_id ? 'ussd' : 'sms';
    const facilityIds: string[] = [];
    for (const facility of referral.facilities) {
      if (!facilityIds.includes(facility.id)) facilityIds.push(facility.id);
    }
    if (!facilityIds.length) return;
    const work = async (tx: Prisma.TransactionClient) => {
      const requestId = actor.request_id || '';
      if (requestId) {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${channel}:${requestId}`}, 0))`,
        );
        const duplicate = await tx.referralRequest.findFirst({
          where: { request_id: requestId, channel },
          select: { id: true },
        });
        if (duplicate) return;
      }
      const service = await tx.service.findFirst({
        where: { service_code: referral.serviceCode, active: true },
        select: { service_code: true },
      });
      if (!service) return;
      const area = await tx.area.findFirst({
        where: { id: referral.areaId, active: true },
        select: { id: true, center_latitude: true, center_longitude: true },
      });
      if (!area) return;
      let patientId: string | null = null;
      if (referral.consentId) {
        const consent = await this.liveConsent(tx, referral.consentId, actor.phone_digest);
        patientId = consent?.patient_id ?? null;
      }
      const created = await tx.referralRequest.create({
        data: {
          patient_id: patientId,
          channel,
          service_code: referral.serviceCode,
          area_id: referral.areaId,
          requested_latitude: null,
          requested_longitude: null,
          radius_km: 25,
          status: 'matched',
          applied_consent_id: referral.consentId,
          applied_field_keys: [],
          request_id: requestId,
        },
        select: { id: true },
      });
      const facilities = await tx.facility.findMany({
        where: {
          id: { in: facilityIds },
          status: 'APPROVED',
          facility_services: {
            some: {
              service_code: referral.serviceCode,
              verification_status: 'APPROVED',
            },
          },
        },
        select: {
          id: true,
          name: true,
          address: true,
          phone: true,
          last_verified_at: true,
          latitude: true,
          longitude: true,
        },
      });
      const ordered = facilityIds
        .map((id) => facilities.find((facility) => facility.id === id))
        .filter((facility): facility is (typeof facilities)[number] => !!facility);
      if (!ordered.length) {
        await tx.referralRequest.delete({ where: { id: created.id } });
        return;
      }
      const centerLatitude = area.center_latitude === null ? null : Number(area.center_latitude);
      const centerLongitude = area.center_longitude === null ? null : Number(area.center_longitude);
      await tx.referralResult.createMany({
        data: ordered.map((facility, index) => {
          const distance = distanceKm(
            centerLatitude,
            centerLongitude,
            facility.latitude === null ? null : Number(facility.latitude),
            facility.longitude === null ? null : Number(facility.longitude),
          );
          return {
            referral_id: created.id,
            facility_id: facility.id,
            rank: index + 1,
            distance_km: distance,
            distance_basis: distance === null ? 'none' : 'area_centroid_straight_line',
            reason: 'Directory service match',
            facility_snapshot: {
              name: facility.name,
              address: facility.address,
              phone: facility.phone,
              last_verified_at: facility.last_verified_at
                ? facility.last_verified_at.toISOString()
                : null,
            },
          };
        }),
      });
      await this.audit(tx, {
        requestId,
        patientId,
        channel: channel === 'ussd' ? 'USSD' : 'SMS',
        action: 'referral_create',
        resourceType: 'directory',
        resourceId: created.id,
        outcome: 'ALLOWED',
        fieldKeys: [],
        actorRef: actor.phone_digest,
      });
    };
    if (database === this.prisma) {
      await this.transaction(work);
    } else {
      await work(database);
    }
  }

  private async liveConsent(
    database: Db,
    consentId: string,
    phoneDigest: string,
  ): Promise<
    | (Prisma.ProfileUseConsentGetPayload<{ include: { fields: true } }> & {
        channelName: 'sms' | 'ussd';
      })
    | null
  > {
    const now = new Date();
    const consent = await database.profileUseConsent.findFirst({
      where: {
        id: consentId,
        revoked_at: null,
        expires_at: { gt: now },
        phone_link: {
          phone_digest: phoneDigest,
          revoked_at: null,
          OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        },
      },
      include: { fields: true },
    });
    if (!consent) return null;
    const channelName = consent.channel === 'USSD' ? 'ussd' : 'sms';
    const scope: ConsentScope = {
      expires_at: consent.expires_at,
      revoked_at: consent.revoked_at,
      channel: channelName,
      fields: consent.fields.map((field) => field.field_key),
    };
    if (!isConsentLive(scope, channelName, now)) return null;
    return { ...consent, channelName };
  }

  private async findProfileConsent(
    actor: Actor,
    database: Db = this.prisma,
  ): Promise<{
    id: string;
    consent_id: string;
    channel: 'sms' | 'ussd';
    expires_at: Date;
  } | null> {
    if (!validDigest(actor.phone_digest)) return null;
    const now = new Date();
    const consent = await database.profileUseConsent.findFirst({
      where: {
        revoked_at: null,
        expires_at: { gt: now },
        phone_link: {
          phone_digest: actor.phone_digest,
          revoked_at: null,
          OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        },
      },
      include: { fields: { select: { field_key: true } } },
      orderBy: { expires_at: 'desc' },
    });
    if (!consent) return null;
    await this.audit(database, {
      requestId: actor.request_id,
      patientId: consent.patient_id,
      channel: consent.channel,
      action: 'profile_consent_lookup',
      resourceType: 'profile_consent',
      resourceId: consent.id,
      outcome: 'ALLOWED',
      fieldKeys: [],
      actorRef: actor.phone_digest,
    });
    return {
      id: consent.id,
      consent_id: consent.id,
      channel: consent.channel === 'USSD' ? 'ussd' : 'sms',
      expires_at: consent.expires_at,
    };
  }

  /** Conversation memory is message text, so it is stored encrypted, never as plain JSON. */
  private openHistory(context: SmsContext): SmsContext {
    const { historyEnvelope, history: _plain, ...rest } = context ?? {};
    if (!historyEnvelope) return rest;
    try {
      const history = this.crypto.decrypt<SmsContext['history']>(historyEnvelope, 'sms-history');
      return Array.isArray(history) ? { ...rest, history } : rest;
    } catch {
      return rest;
    }
  }

  private sealHistory(context: SmsContext): SmsContext {
    const { history, historyEnvelope: _old, ...rest } = context ?? {};
    if (!history?.length) return rest;
    return { ...rest, historyEnvelope: this.crypto.encrypt(history, 'sms-history') };
  }

  private async livePatientForGrant(database: Db, grantDigest: string) {
    const grants = await database.accessGrant.findMany({
      where: { code_digest: grantDigest, revoked_at: null, expires_at: { gt: new Date() } },
      select: { patient_id: true },
      take: 2,
    });
    return grants.length === 1 ? grants[0]! : null;
  }

  /** The patient whose verified phone is sending: a live channel link, or a verified account phone. */
  private async linkedPatient(
    actor: Actor,
    database: Db,
  ): Promise<{ patientId: string; accountId: string } | null> {
    if (!validDigest(actor.phone_digest)) return null;
    const now = new Date();
    const link = await database.channelLink.findFirst({
      where: {
        phone_digest: actor.phone_digest,
        revoked_at: null,
        OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        patient: { account: { status: 'ACTIVE' } },
      },
      orderBy: { verified_at: 'desc' },
      select: { patient_id: true, patient: { select: { account_id: true } } },
    });
    if (link) return { patientId: link.patient_id, accountId: link.patient.account_id };
    const accounts = await database.account.findMany({
      where: {
        phone_digest: actor.phone_digest,
        phone_verified_at: { not: null },
        status: 'ACTIVE',
        patient_profile: { isNot: null },
      },
      select: { id: true, patient_profile: { select: { id: true } } },
      take: 2,
    });
    // A number verified on two accounts is ambiguous, so it identifies nobody.
    if (accounts.length !== 1 || !accounts[0]!.patient_profile) return null;
    return { patientId: accounts[0]!.patient_profile.id, accountId: accounts[0]!.id };
  }

  /**
   * The phone's language: an explicit SMS/USSD choice, else the linked patient's
   * profile language, else English. "en" is the column default, so an explicit English
   * choice is stored as EXPLICIT_ENGLISH.
   */
  async getLocale(actor: Actor, database: Db = this.prisma): Promise<Locale> {
    if (!validDigest(actor.phone_digest)) return 'en';
    const preference = await database.channelPreference.findUnique({
      where: { phone_digest: actor.phone_digest },
      select: { locale: true },
    });
    if (preference?.locale && preference.locale !== 'en') return toLocale(preference.locale) ?? 'en';
    const owner = await this.linkedPatient(actor, database);
    if (!owner) return 'en';
    const profile = await database.patientProfile.findUnique({
      where: { id: owner.patientId },
      select: { preferred_language: true },
    });
    return toLocale(profile?.preferred_language) ?? 'en';
  }

  async setLocale(actor: Actor, locale: Locale, database: Db = this.prisma): Promise<void> {
    if (!validDigest(actor.phone_digest)) return;
    const stored = locale === 'en' ? EXPLICIT_ENGLISH : locale;
    await database.channelPreference.upsert({
      where: { phone_digest: actor.phone_digest },
      create: { phone_digest: actor.phone_digest, locale: stored },
      update: { locale: stored },
    });
  }

  /** The caller's own emergency code (created if missing). Only for a verified, linked phone. */
  async readOwnCodes(
    actor: Actor,
    database: Db = this.prisma,
  ): Promise<OwnCodes> {
    const owner = await this.linkedPatient(actor, database);
    const channel = actor.session_id ? 'USSD' : 'SMS';
    if (!owner) {
      await this.audit(database, {
        requestId: actor.request_id,
        patientId: null,
        channel,
        action: 'own_code_read',
        resourceType: 'patient_code',
        resourceId: null,
        outcome: 'DENIED',
        reason: 'phone_not_linked',
        fieldKeys: [],
        actorRef: actor.phone_digest,
      });
      return { linked: false };
    }
    let record = await database.patientCode.findUnique({ where: { patient_id: owner.patientId } });
    for (let attempt = 0; !record && attempt < 5; attempt += 1) {
      const code = randomInt(0, 10 ** 12).toString().padStart(12, '0');
      const digest = this.crypto.digestCode(code, 'patient');
      if (!digest) continue;
      try {
        record = await database.patientCode.create({
          data: {
            patient_id: owner.patientId,
            code_digest: digest,
            code_ciphertext: this.crypto.encrypt(code, 'patient-code'),
            key_version: this.config.encryptionKeyVersion,
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        record = await database.patientCode.findUnique({ where: { patient_id: owner.patientId } });
      }
    }
    if (!record) throw new Error('Could not allocate a patient code');
    await this.audit(database, {
      requestId: actor.request_id,
      patientId: owner.patientId,
      channel,
      action: 'own_code_read',
      resourceType: 'patient_code',
      resourceId: owner.patientId,
      outcome: 'ALLOWED',
      fieldKeys: [],
      actorRef: actor.phone_digest,
    });
    const summaryFields = await database.emergencyField.count({
      where: { patient_id: owner.patientId, field: { active: true } },
    });
    return {
      linked: true,
      patientCode: this.crypto.decrypt<string>(record.code_ciphertext, 'patient-code'),
      summaryFields,
    };
  }

  /**
   * One-tap share from a linked phone: a temporary code for the emergency summary
   * (or every filled emergency-eligible field) that works on USSD and the web.
   */
  async createQuickGrant(
    actor: Actor,
    minutes = 60,
    database: Db = this.prisma,
  ): Promise<
    | { status: 'not_linked' }
    | { status: 'nothing_to_share' }
    | { status: 'created'; code: string; expiresAt: Date }
  > {
    const owner = await this.linkedPatient(actor, database);
    if (!owner) return { status: 'not_linked' };
    const selected = await database.emergencyField.findMany({
      where: { patient_id: owner.patientId, field: { active: true } },
      orderBy: { display_order: 'asc' },
      select: { field_key: true },
    });
    const fieldKeys = selected.length
      ? selected.map((row) => row.field_key)
      : (
          await database.patientFieldValue.findMany({
            where: { patient_id: owner.patientId, field: { active: true, emergency_eligible: true } },
            select: { field_key: true },
          })
        ).map((row) => row.field_key);
    if (!fieldKeys.length) return { status: 'nothing_to_share' };
    const expiresAt = new Date(Date.now() + Math.min(Math.max(minutes, 5), 24 * 60) * 60_000);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomInt(0, 10 ** 8).toString().padStart(8, '0');
      const digest = this.crypto.digestCode(code, 'grant');
      if (!digest || (await this.livePatientForGrant(database, digest))) continue;
      try {
        const grant = await database.accessGrant.create({
          data: {
            patient_id: owner.patientId,
            code_digest: digest,
            expires_at: expiresAt,
            created_by_account_id: owner.accountId,
            fields: { create: fieldKeys.map((field_key) => ({ field_key })) },
            channels: { create: [{ channel: 'WEB_PRACTITIONER' }, { channel: 'USSD' }] },
          },
        });
        await this.audit(database, {
          requestId: actor.request_id,
          patientId: owner.patientId,
          channel: actor.session_id ? 'USSD' : 'SMS',
          action: 'grant_create',
          resourceType: 'access_grant',
          resourceId: grant.id,
          outcome: 'ALLOWED',
          fieldKeys,
          actorRef: actor.phone_digest,
        });
        return { status: 'created', code, expiresAt };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error('Could not allocate an access code');
  }

  private async liveConsentForPhone(actor: Actor, database: Db) {
    if (!validDigest(actor.phone_digest)) return null;
    const now = new Date();
    return database.profileUseConsent.findFirst({
      where: {
        revoked_at: null,
        expires_at: { gt: now },
        phone_link: {
          phone_digest: actor.phone_digest,
          revoked_at: null,
          OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        },
      },
      select: { id: true, patient_id: true, channel: true },
      orderBy: { expires_at: 'desc' },
    });
  }

  /** The linked patient's home area, offered as a default in care and emergency search. */
  async findSavedArea(actor: Actor, database: Db = this.prisma): Promise<SavedArea | null> {
    // The patient's own verified phone may see their own home area; a consent also allows it.
    const consent = await this.liveConsentForPhone(actor, database);
    const owner = consent
      ? { patientId: consent.patient_id, channel: consent.channel }
      : await this.linkedPatient(actor, database).then((linked) =>
          linked
            ? { patientId: linked.patientId, channel: (actor.session_id ? 'USSD' : 'SMS') as 'USSD' | 'SMS' }
            : null,
        );
    if (!owner) return null;
    const profile = await database.patientProfile.findUnique({
      where: { id: owner.patientId },
      select: {
        home_area: {
          select: { id: true, name: true, city: true, region: true, active: true, is_demo: true },
        },
      },
    });
    const area = profile?.home_area;
    if (!area || !area.active || area.is_demo) return null;
    const suffix = area.city && area.city !== area.name ? area.city : area.region;
    await this.audit(database, {
      requestId: actor.request_id,
      patientId: owner.patientId,
      channel: owner.channel,
      action: 'profile_area_read',
      resourceType: 'area',
      resourceId: area.id,
      outcome: 'ALLOWED',
      fieldKeys: [],
      actorRef: actor.phone_digest,
    });
    return { id: area.id, label: suffix ? `${area.name}, ${suffix}` : area.name };
  }

  /** Consent-scoped, de-identified hints that tailor general health answers. */
  async readPersonalHints(actor: Actor, database: Db = this.prisma): Promise<PersonalHints | null> {
    const consent = await this.liveConsentForPhone(actor, database);
    if (!consent) return null;
    const [fields, profile] = await Promise.all([
      this.consentProjection(database, consent.id, consent.patient_id),
      database.patientProfile.findUnique({
        where: { id: consent.patient_id },
        select: { preferred_language: true },
      }),
    ]);
    const hints = personalHintsFrom(fields, profile?.preferred_language ?? 'en');
    await this.auditRead(database, {
      channel: consent.channel,
      action: 'assistant_context_read',
      patientId: consent.patient_id,
      outcome: 'ALLOWED',
      reason: null,
      fields,
      requestId: actor.request_id,
      actorRef: actor.phone_digest,
    });
    return hints;
  }

  private async readProfileContext(
    consentId: string,
    actor: Actor,
    database: Db = this.prisma,
  ): Promise<Projection & { consent_id?: string }> {
    const consent = await this.liveConsent(database, consentId, actor.phone_digest);
    const channel = consent?.channelName === 'ussd' ? 'USSD' : 'SMS';
    if (!consent) {
      await this.auditRead(database, {
        channel,
        action: 'profile_context_read',
        patientId: null,
        outcome: 'DENIED',
        reason: 'consent_unavailable',
        fields: [],
        requestId: actor.request_id,
        actorRef: actor.phone_digest,
      });
      return deniedProjection();
    }
    const fields = await this.consentProjection(database, consent.id, consent.patient_id);
    if (!fields.length) {
      await this.auditRead(database, {
        channel,
        action: 'profile_context_read',
        patientId: consent.patient_id,
        outcome: 'DENIED',
        reason: 'no_fields',
        fields,
        requestId: actor.request_id,
        actorRef: actor.phone_digest,
      });
      return deniedProjection();
    }
    await this.auditRead(database, {
      channel,
      action: 'profile_context_read',
      patientId: consent.patient_id,
      outcome: 'ALLOWED',
      reason: null,
      fields,
      requestId: actor.request_id,
      actorRef: actor.phone_digest,
    });
    return { ...buildProjection(fields), consent_id: consent.id };
  }

  private async emergencyProjection(database: Db, patientId: string): Promise<RecordField[]> {
    const rows = await database.$queryRaw<ProjectionRow[]>(
      Prisma.sql`SELECT fd.field_key AS key, fd.label, pfv.value
      FROM "emergency_fields" ef
      JOIN "patient_field_values" pfv
        ON pfv.patient_id = ef.patient_id AND pfv.field_key = ef.field_key
      JOIN "field_definitions" fd ON fd.field_key = ef.field_key
      WHERE ef.patient_id = ${patientId}::uuid AND fd.active
      ORDER BY ef.display_order, fd.sort_order, fd.field_key`,
    );
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: row.value as RecordField['value'],
    }));
  }

  private async grantProjection(
    database: Db,
    grantId: string,
    patientId: string,
  ): Promise<RecordField[]> {
    const rows = await database.$queryRaw<ProjectionRow[]>(
      Prisma.sql`SELECT fd.field_key AS key, fd.label, pfv.value
      FROM "access_grant_fields" agf
      JOIN "access_grants" g ON g.id = agf.grant_id AND g.patient_id = ${patientId}::uuid
      JOIN "patient_field_values" pfv
        ON pfv.patient_id = g.patient_id AND pfv.field_key = agf.field_key
      JOIN "field_definitions" fd ON fd.field_key = agf.field_key
      WHERE agf.grant_id = ${grantId}::uuid AND fd.active
      ORDER BY fd.sort_order, fd.field_key`,
    );
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: row.value as RecordField['value'],
    }));
  }

  private async consentProjection(
    database: Db,
    consentId: string,
    patientId: string,
  ): Promise<RecordField[]> {
    const rows = await database.$queryRaw<ProjectionRow[]>(
      Prisma.sql`SELECT fd.field_key AS key, fd.label, pfv.value
      FROM "consent_fields" cf
      JOIN "patient_field_values" pfv
        ON pfv.patient_id = ${patientId}::uuid AND pfv.field_key = cf.field_key
      JOIN "field_definitions" fd ON fd.field_key = cf.field_key
      WHERE cf.consent_id = ${consentId}::uuid AND fd.active
      ORDER BY fd.sort_order, fd.field_key`,
    );
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: row.value as RecordField['value'],
    }));
  }

  private async liveUssdSession(database: Db, sessionId: string, phoneDigest: string) {
    return database.ussdSession.findFirst({
      where: {
        id: sessionId,
        phone_digest: phoneDigest,
        ended_at: null,
        expires_at: { gt: new Date() },
      },
      select: { id: true, expires_at: true, read_session_id: true },
    });
  }

  private async attempt(
    database: Db,
    values: {
      channel: 'SMS' | 'USSD';
      action: string;
      outcome: 'ALLOWED' | 'DENIED' | 'THROTTLED';
      targetDigest: string | null;
      phoneDigest: string | null;
      requestId: string;
    },
  ): Promise<void> {
    await database.accessAttempt.create({
      data: {
        channel: values.channel,
        action: values.action,
        outcome: values.outcome,
        target_digest: values.targetDigest,
        phone_digest: values.phoneDigest,
        ip_hash: null,
        request_id: values.requestId || '',
      },
    });
  }

  private async audit(
    database: Db,
    values: {
      requestId: string;
      patientId: string | null;
      channel: 'WEB' | 'SMS' | 'USSD' | 'SYSTEM';
      action: string;
      resourceType: string;
      resourceId: string | null;
      outcome: 'ALLOWED' | 'DENIED' | 'ERROR';
      reason?: string | null;
      fieldKeys?: string[];
      actorRef: string | null;
    },
  ): Promise<void> {
    await database.auditEvent.create({
      data: {
        request_id: values.requestId || '',
        actor_account_id: null,
        patient_id: values.patientId,
        channel: values.channel,
        action: values.action,
        resource_type: values.resourceType,
        resource_id: values.resourceId,
        outcome: values.outcome,
        reason_code: values.reason ?? null,
        field_keys: values.fieldKeys ?? [],
        actor_ref: values.actorRef,
        metadata: {},
      },
    });
  }

  private async auditRead(
    database: Db,
    values: {
      channel: 'WEB' | 'SMS' | 'USSD' | 'SYSTEM';
      action: string;
      patientId: string | null;
      outcome: 'ALLOWED' | 'DENIED' | 'ERROR';
      reason: string | null;
      fields: RecordField[];
      requestId: string;
      actorRef: string | null;
    },
  ): Promise<void> {
    await this.audit(database, {
      requestId: values.requestId,
      patientId: values.patientId,
      channel: values.channel,
      action: values.action,
      resourceType: 'patient_record',
      resourceId: values.patientId,
      outcome: values.outcome,
      reason: values.reason,
      fieldKeys: values.fields.map((field) => field.key),
      actorRef: values.actorRef,
    });
  }

  private async tooManyAttempts(
    database: Db,
    values: {
      channel: 'SMS' | 'USSD';
      action: string;
      targetDigest: string | null;
      phoneDigest: string;
      limit: number;
      windowSeconds: number;
    },
  ): Promise<boolean> {
    if (!values.limit || values.limit <= 0) return false;
    const rows = await database.$queryRaw<Array<{ count: number }>>(
      Prisma.sql`SELECT count(*)::int AS count FROM "access_attempts"
      WHERE channel = ${values.channel}::"AttemptChannel" AND action = ${values.action}
        AND occurred_at > now() - make_interval(secs => ${values.windowSeconds}::int)
        AND outcome IN ('DENIED', 'THROTTLED')
        AND (${values.targetDigest}::text IS NULL OR target_digest = ${values.targetDigest})
        AND (${values.phoneDigest}::text IS NULL OR phone_digest = ${values.phoneDigest})`,
    );
    return (rows[0]?.count ?? 0) >= values.limit;
  }

  private async readEmergencySummary(
    digest: string,
    actor: Actor,
    mode: 'sms' | 'ussd',
    database: Db = this.prisma,
  ): Promise<Projection> {
    const channel = mode === 'sms' ? 'SMS' : 'USSD';
    const requestId = actor.request_id;
    const phone = actor.phone_digest;
    let session: { id: string; expires_at: Date; read_session_id: string | null } | null = null;
    if (mode === 'ussd') {
      if (!actor.session_id || !validDigest(phone)) {
        await this.auditRead(database, {
          channel,
          action: 'emergency_lookup',
          patientId: null,
          outcome: 'DENIED',
          reason: 'invalid_session',
          fields: [],
          requestId,
          actorRef: phone,
        });
        return deniedProjection();
      }
      session = await this.liveUssdSession(database, actor.session_id, phone);
      if (!session) {
        await this.auditRead(database, {
          channel,
          action: 'emergency_lookup',
          patientId: null,
          outcome: 'DENIED',
          reason: 'invalid_session',
          fields: [],
          requestId,
          actorRef: phone,
        });
        return deniedProjection();
      }
    }
    if (!validDigest(digest)) {
      await this.attempt(database, {
        channel,
        action: 'emergency_lookup',
        outcome: 'DENIED',
        targetDigest: digest,
        phoneDigest: phone,
        requestId,
      });
      await this.auditRead(database, {
        channel,
        action: 'emergency_lookup',
        patientId: null,
        outcome: 'DENIED',
        reason: 'invalid_digest',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    if (
      await this.tooManyAttempts(database, {
        channel,
        action: 'emergency_lookup',
        targetDigest: digest,
        phoneDigest: phone,
        limit: 20,
        windowSeconds: 60,
      })
    ) {
      await this.attempt(database, {
        channel,
        action: 'emergency_lookup',
        outcome: 'THROTTLED',
        targetDigest: digest,
        phoneDigest: phone,
        requestId,
      });
      await this.auditRead(database, {
        channel,
        action: 'emergency_lookup',
        patientId: null,
        outcome: 'DENIED',
        reason: 'throttled',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    const code = await database.patientCode.findUnique({
      where: { code_digest: digest },
      select: { patient_id: true, code_version: true },
    });
    if (!code) {
      await this.attempt(database, {
        channel,
        action: 'emergency_lookup',
        outcome: 'DENIED',
        targetDigest: digest,
        phoneDigest: phone,
        requestId,
      });
      await this.auditRead(database, {
        channel,
        action: 'emergency_lookup',
        patientId: null,
        outcome: 'DENIED',
        reason: 'unknown_code',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    const fields = await this.emergencyProjection(database, code.patient_id);
    if (!fields.length) {
      await this.attempt(database, {
        channel,
        action: 'emergency_lookup',
        outcome: 'DENIED',
        targetDigest: digest,
        phoneDigest: phone,
        requestId,
      });
      await this.auditRead(database, {
        channel,
        action: 'emergency_lookup',
        patientId: code.patient_id,
        outcome: 'DENIED',
        reason: 'no_shared_fields',
        fields,
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    let readSessionId: string | undefined;
    if (mode === 'ussd' && session && actor.session_id) {
      const read = await database.recordReadSession.findFirst({
        where: {
          telecom_session_id: actor.session_id,
          phone_digest: phone,
          purpose: 'EMERGENCY',
          patient_id: code.patient_id,
          code_version: code.code_version,
          revoked_at: null,
          expires_at: { gt: new Date() },
        },
        orderBy: { created_at: 'desc' },
        select: { id: true },
      });
      if (read) {
        await database.recordReadSession.update({
          where: { id: read.id },
          data: { last_read_at: new Date() },
        });
        readSessionId = read.id;
      } else {
        const expiresAt = new Date(
          Math.min(Date.now() + 5 * 60 * 1000, session.expires_at.getTime()),
        );
        const created = await database.recordReadSession.create({
          data: {
            patient_id: code.patient_id,
            purpose: 'EMERGENCY',
            channel: 'USSD',
            telecom_session_id: actor.session_id,
            phone_digest: phone,
            code_version: code.code_version,
            expires_at: expiresAt,
          },
          select: { id: true },
        });
        readSessionId = created.id;
      }
      await database.ussdSession.update({
        where: { id: actor.session_id },
        data: { read_session_id: readSessionId, version: { increment: 1 } },
      });
    }
    await this.attempt(database, {
      channel,
      action: 'emergency_lookup',
      outcome: 'ALLOWED',
      targetDigest: digest,
      phoneDigest: phone,
      requestId,
    });
    await this.auditRead(database, {
      channel,
      action: 'emergency_lookup',
      patientId: code.patient_id,
      outcome: 'ALLOWED',
      reason: null,
      fields,
      requestId,
      actorRef: phone,
    });
    return buildProjection(fields, readSessionId);
  }

  private async openGrantedRecord(
    patientDigest: string | null,
    grantDigest: string,
    actor: Actor,
    database: Db = this.prisma,
  ): Promise<Projection> {
    const phone = actor.phone_digest;
    const requestId = actor.request_id;
    if (!actor.session_id || !validDigest(phone)) {
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_open',
        patientId: null,
        outcome: 'DENIED',
        reason: 'invalid_session',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    const session = await this.liveUssdSession(database, actor.session_id, phone);
    if (!session) {
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_open',
        patientId: null,
        outcome: 'DENIED',
        reason: 'invalid_session',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    if ((patientDigest !== null && !validDigest(patientDigest)) || !validDigest(grantDigest)) {
      await this.attempt(database, {
        channel: 'USSD',
        action: 'grant_open',
        outcome: 'DENIED',
        targetDigest: grantDigest,
        phoneDigest: phone,
        requestId,
      });
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_open',
        patientId: null,
        outcome: 'DENIED',
        reason: 'invalid_digest',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    if (
      (await this.tooManyAttempts(database, {
        channel: 'USSD',
        action: 'grant_open',
        targetDigest: grantDigest,
        phoneDigest: phone,
        limit: 5,
        windowSeconds: 900,
      })) ||
      // A temporary code now opens a record on its own, so also cap failures per
      // phone across every code; otherwise guessing a new code each time is unlimited.
      (await this.tooManyAttempts(database, {
        channel: 'USSD',
        action: 'grant_open',
        targetDigest: null,
        phoneDigest: phone,
        limit: 8,
        windowSeconds: 900,
      }))
    ) {
      await this.attempt(database, {
        channel: 'USSD',
        action: 'grant_open',
        outcome: 'THROTTLED',
        targetDigest: grantDigest,
        phoneDigest: phone,
        requestId,
      });
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_open',
        patientId: null,
        outcome: 'DENIED',
        reason: 'throttled',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    // One-code access: a temporary access code alone identifies its patient.
    const code = patientDigest
      ? await database.patientCode.findUnique({
          where: { code_digest: patientDigest },
          select: { patient_id: true },
        })
      : await this.livePatientForGrant(database, grantDigest);
    if (!code) {
      await this.attempt(database, {
        channel: 'USSD',
        action: 'grant_open',
        outcome: 'DENIED',
        targetDigest: grantDigest,
        phoneDigest: phone,
        requestId,
      });
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_open',
        patientId: null,
        outcome: 'DENIED',
        reason: 'unknown_patient_code',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    const grant = await database.accessGrant.findFirst({
      where: { patient_id: code.patient_id, code_digest: grantDigest },
      include: { channels: true, fields: true },
    });
    const scope: GrantScope | null = grant
      ? {
          expires_at: grant.expires_at,
          revoked_at: grant.revoked_at,
          channels: grant.channels.map((channel) => channel.channel.toLowerCase()),
          fields: grant.fields.map((field) => field.field_key),
        }
      : null;
    if (!grant || !scope || !isGrantLive(scope, 'ussd')) {
      await this.attempt(database, {
        channel: 'USSD',
        action: 'grant_open',
        outcome: 'DENIED',
        targetDigest: grantDigest,
        phoneDigest: phone,
        requestId,
      });
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_open',
        patientId: code.patient_id,
        outcome: 'DENIED',
        reason: 'grant_unavailable',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    if (!scope.channels.includes('ussd')) {
      await this.attempt(database, {
        channel: 'USSD',
        action: 'grant_open',
        outcome: 'DENIED',
        targetDigest: grantDigest,
        phoneDigest: phone,
        requestId,
      });
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_open',
        patientId: code.patient_id,
        outcome: 'DENIED',
        reason: 'wrong_channel',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    const fields = await this.grantProjection(database, grant.id, code.patient_id);
    if (!fields.length) {
      await this.attempt(database, {
        channel: 'USSD',
        action: 'grant_open',
        outcome: 'DENIED',
        targetDigest: grantDigest,
        phoneDigest: phone,
        requestId,
      });
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_open',
        patientId: code.patient_id,
        outcome: 'DENIED',
        reason: 'no_fields',
        fields,
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    const existing = await database.recordReadSession.findFirst({
      where: {
        telecom_session_id: actor.session_id,
        phone_digest: phone,
        grant_id: grant.id,
        purpose: 'GRANT',
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });
    let readSessionId: string;
    if (existing) {
      await database.recordReadSession.update({
        where: { id: existing.id },
        data: { last_read_at: new Date() },
      });
      readSessionId = existing.id;
    } else {
      const expiresAt = new Date(
        Math.min(
          Date.now() + 5 * 60 * 1000,
          grant.expires_at.getTime(),
          session.expires_at.getTime(),
        ),
      );
      const created = await database.recordReadSession.create({
        data: {
          patient_id: code.patient_id,
          grant_id: grant.id,
          purpose: 'GRANT',
          channel: 'USSD',
          telecom_session_id: actor.session_id,
          phone_digest: phone,
          expires_at: expiresAt,
        },
        select: { id: true },
      });
      readSessionId = created.id;
    }
    await database.ussdSession.update({
      where: { id: actor.session_id },
      data: { read_session_id: readSessionId, version: { increment: 1 } },
    });
    await this.attempt(database, {
      channel: 'USSD',
      action: 'grant_open',
      outcome: 'ALLOWED',
      targetDigest: grantDigest,
      phoneDigest: phone,
      requestId,
    });
    await this.auditRead(database, {
      channel: 'USSD',
      action: 'grant_open',
      patientId: code.patient_id,
      outcome: 'ALLOWED',
      reason: null,
      fields,
      requestId,
      actorRef: phone,
    });
    return buildProjection(fields, readSessionId);
  }

  private async readGrantedRecord(
    readSessionId: string,
    actor: Actor,
    database: Db = this.prisma,
  ): Promise<Projection> {
    const phone = actor.phone_digest;
    const requestId = actor.request_id;
    if (!actor.session_id || !validDigest(phone)) {
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_read',
        patientId: null,
        outcome: 'DENIED',
        reason: 'invalid_session',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    if (!(await this.liveUssdSession(database, actor.session_id, phone))) {
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_read',
        patientId: null,
        outcome: 'DENIED',
        reason: 'invalid_session',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    const read = await database.recordReadSession.findFirst({
      where: {
        id: readSessionId,
        telecom_session_id: actor.session_id,
        phone_digest: phone,
        channel: 'USSD',
        purpose: 'GRANT',
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
    });
    if (!read || !read.grant_id) {
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_read',
        patientId: null,
        outcome: 'DENIED',
        reason: 'read_session_unavailable',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    const grant = await database.accessGrant.findFirst({
      where: { id: read.grant_id, patient_id: read.patient_id },
      include: { channels: true, fields: true },
    });
    const scope: GrantScope | null = grant
      ? {
          expires_at: grant.expires_at,
          revoked_at: grant.revoked_at,
          channels: grant.channels.map((channel) => channel.channel.toLowerCase()),
          fields: grant.fields.map((field) => field.field_key),
        }
      : null;
    if (!grant || !scope || !isGrantLive(scope, 'ussd')) {
      await database.recordReadSession.update({
        where: { id: read.id },
        data: { revoked_at: new Date() },
      });
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_read',
        patientId: read.patient_id,
        outcome: 'DENIED',
        reason: 'grant_unavailable',
        fields: [],
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    const fields = await this.grantProjection(database, read.grant_id, read.patient_id);
    if (!fields.length) {
      await this.auditRead(database, {
        channel: 'USSD',
        action: 'grant_read',
        patientId: read.patient_id,
        outcome: 'DENIED',
        reason: 'no_fields',
        fields,
        requestId,
        actorRef: phone,
      });
      return deniedProjection();
    }
    await database.recordReadSession.update({
      where: { id: read.id },
      data: { last_read_at: new Date() },
    });
    await this.auditRead(database, {
      channel: 'USSD',
      action: 'grant_read',
      patientId: read.patient_id,
      outcome: 'ALLOWED',
      reason: null,
      fields,
      requestId,
      actorRef: phone,
    });
    return buildProjection(fields, read.id);
  }

  private async closeGrantedRecord(
    readSessionId: string,
    actor: Actor,
    database: Db = this.prisma,
  ): Promise<void> {
    const phone = actor.phone_digest;
    if (!actor.session_id || !validDigest(phone)) return;
    const read = await database.recordReadSession.findFirst({
      where: {
        id: readSessionId,
        telecom_session_id: actor.session_id,
        phone_digest: phone,
        channel: 'USSD',
        purpose: 'GRANT',
      },
      select: { id: true, patient_id: true, revoked_at: true },
    });
    if (!read) return;
    await database.recordReadSession.update({
      where: { id: read.id },
      data: { revoked_at: read.revoked_at ?? new Date() },
    });
    await database.ussdSession.updateMany({
      where: { id: actor.session_id, phone_digest: phone },
      data: { read_session_id: null, version: { increment: 1 } },
    });
    await this.auditRead(database, {
      channel: 'USSD',
      action: 'grant_close',
      patientId: read.patient_id,
      outcome: 'ALLOWED',
      reason: null,
      fields: [],
      requestId: actor.request_id,
      actorRef: phone,
    });
  }

  async maintain(): Promise<void> {
    await this.transaction(async (tx) => {
      // A sender crash might have happened after provider acceptance. Never blindly resend.
      await tx.$executeRaw`UPDATE "outbox" SET status = 'UNKNOWN', lease_until = NULL
        WHERE status = 'SENDING' AND lease_until < now()`;
      await tx.$executeRaw`UPDATE "outbox" SET status = 'EXPIRED'
        WHERE status = 'QUEUED' AND expires_at <= now()`;
      await tx.$executeRaw`UPDATE "sms_inbox" SET status = 'EXPIRED'
        WHERE status = 'QUEUED' AND expires_at <= now()`;
      await tx.$executeRaw`UPDATE "sms_inbox" SET status = 'FAILED', lease_until = NULL
        WHERE status = 'PROCESSING' AND lease_until < now() AND attempts >= ${this.config.workerMaxAttempts}::int`;
      await tx.$executeRaw`UPDATE "ussd_sessions"
        SET state = 'END', context = '{}', read_session_id = NULL, ended_at = COALESCE(ended_at, now())
        WHERE expires_at <= now()`;
      await tx.$executeRaw`DELETE FROM "ussd_sessions"
        WHERE expires_at < now() - ${this.config.ussdRetentionSeconds}::int * interval '1 second'`;
      await tx.$executeRaw`DELETE FROM "sms_inbox"
        WHERE created_at < now() - ${this.config.smsBodyRetentionDays}::int * interval '1 day'
        AND status <> 'PROCESSING'`;
      await tx.$executeRaw`DELETE FROM "outbox"
        WHERE created_at < now() - ${this.config.smsBodyRetentionDays}::int * interval '1 day'
        AND status <> 'SENDING'`;
      await tx.$executeRaw`DELETE FROM "delivery_events"
        WHERE created_at < now() - ${this.config.deliveryRetentionDays}::int * interval '1 day'`;
      await tx.$executeRaw`DELETE FROM "rate_limits" WHERE window_start < now() - interval '1 hour'`;
      await tx.$executeRaw`DELETE FROM "sms_conversations" WHERE expires_at < now()`;
      await this.reconcileDelivery(tx);
    });
  }
}
