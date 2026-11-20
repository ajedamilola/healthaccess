import { randomInt } from 'node:crypto';
import {
  Prisma,
  type AccountRoleType,
  type AccessGrant,
  type ConsentChannel,
  type FieldValueType,
  type GrantChannel,
  type PatientCode,
  type PatientProfile,
  type ProfileUseConsent,
} from '@prisma/client';
import { config, crypto as cryptoService } from '../../config.js';
import { prisma } from '../../db.js';
import { AppError } from '../../middleware/error.js';

export const GRANT_DEFAULT_MINUTES = 30;
export const GRANT_MAX_MINUTES = 24 * 60;
export const CONSENT_DEFAULT_MINUTES = 30 * 24 * 60;
export const READ_SESSION_MINUTES = 15;

export const DENIAL_LIMIT = 5;
const DENIAL_WINDOW_MS = 10 * 60 * 1000;

export type WebAttemptAction = 'emergency_read' | 'grant_open';

export interface FieldStateEntry {
  key: string;
  label: string;
  value_type: FieldValueType;
  emergency_eligible: boolean;
  sort_order: number;
  value: Prisma.JsonValue | null;
  field_version: number | null;
}

export interface FieldState {
  version: number;
  fields: FieldStateEntry[];
}

function numericCode(digits: number) {
  return randomInt(0, 10 ** digits)
    .toString()
    .padStart(digits, '0');
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function resolvePatient(accountId: string): Promise<PatientProfile> {
  const patient = await prisma.patientProfile.findUnique({ where: { account_id: accountId } });
  if (!patient) throw new AppError(404, 'Patient profile not found', 'not_found');
  return patient;
}

export async function loadFieldState(patientId: string): Promise<FieldState> {
  const [profile, definitions, values] = await Promise.all([
    prisma.patientProfile.findUnique({ where: { id: patientId } }),
    prisma.fieldDefinition.findMany({
      where: { active: true },
      orderBy: [{ sort_order: 'asc' }, { field_key: 'asc' }],
    }),
    prisma.patientFieldValue.findMany({
      where: { patient_id: patientId },
      select: { field_key: true, value: true, version: true },
    }),
  ]);
  if (!profile) throw new AppError(404, 'Patient profile not found', 'not_found');

  const valueByKey = new Map(values.map((row) => [row.field_key, row]));
  return {
    version: profile.version,
    fields: definitions.map((definition) => {
      const stored = valueByKey.get(definition.field_key);
      return {
        key: definition.field_key,
        label: definition.label,
        value_type: definition.value_type,
        emergency_eligible: definition.emergency_eligible,
        sort_order: definition.sort_order,
        value: stored?.value ?? null,
        field_version: stored?.version ?? null,
      };
    }),
  };
}

export async function assertActiveFields(fieldKeys: string[]) {
  const definitions = await prisma.fieldDefinition.findMany({
    where: { field_key: { in: fieldKeys }, active: true },
    select: { field_key: true },
  });
  const known = new Set(definitions.map((row) => row.field_key));
  return fieldKeys.every((key) => known.has(key));
}

export async function updateProfileFields(
  patientId: string,
  accountId: string,
  fields: Record<string, Prisma.InputJsonValue>,
  expectedVersion: number,
): Promise<number> {
  const keys = Object.keys(fields);
  if (keys.length === 0) {
    throw new AppError(400, 'At least one field is required', 'invalid_fields');
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.patientProfile.updateMany({
      where: { id: patientId, version: expectedVersion },
      data: { version: { increment: 1 } },
    });
    if (updated.count === 0) {
      throw new AppError(409, 'Profile version conflict', 'version_conflict');
    }

    for (const key of keys) {
      await tx.patientFieldValue.upsert({
        where: { patient_id_field_key: { patient_id: patientId, field_key: key } },
        create: {
          patient_id: patientId,
          field_key: key,
          value: fields[key],
          source: 'PATIENT',
          updated_by_account_id: accountId,
        },
        update: {
          value: fields[key],
          version: { increment: 1 },
          source: 'PATIENT',
          updated_by_account_id: accountId,
        },
      });
    }

    const profile = await tx.patientProfile.findUniqueOrThrow({ where: { id: patientId } });
    return profile.version;
  });
}

export async function putEmergencyFields(
  patientId: string,
  fieldKeys: string[],
  expectedVersion: number,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.patientProfile.updateMany({
      where: { id: patientId, version: expectedVersion },
      data: { version: { increment: 1 } },
    });
    if (updated.count === 0) {
      throw new AppError(409, 'Profile version conflict', 'version_conflict');
    }

    await tx.emergencyField.deleteMany({ where: { patient_id: patientId } });
    if (fieldKeys.length > 0) {
      await tx.emergencyField.createMany({
        data: fieldKeys.map((fieldKey, index) => ({
          patient_id: patientId,
          field_key: fieldKey,
          display_order: index,
        })),
      });
    }

    const profile = await tx.patientProfile.findUniqueOrThrow({ where: { id: patientId } });
    return profile.version;
  });
}

export async function ensurePatientCode(patientId: string): Promise<PatientCode> {
  const existing = await prisma.patientCode.findUnique({ where: { patient_id: patientId } });
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = numericCode(12);
    const digest = cryptoService.digestCode(code, 'patient');
    if (!digest) continue;

    try {
      return await prisma.patientCode.create({
        data: {
          patient_id: patientId,
          code_digest: digest,
          code_ciphertext: cryptoService.encrypt(code, 'patient-code'),
          key_version: config.encryptionKeyVersion,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await prisma.patientCode.findUnique({ where: { patient_id: patientId } });
      if (raced) return raced;
    }
  }

  throw new AppError(500, 'Could not allocate patient code', 'code_generation_failed');
}

export function patientCodeResponse(record: PatientCode) {
  return {
    available: true,
    code: cryptoService.decrypt<string>(record.code_ciphertext, 'patient-code'),
    code_version: record.code_version,
    rotated_at: record.rotated_at,
  };
}

export async function rotatePatientCode(patientId: string): Promise<PatientCode> {
  await ensurePatientCode(patientId);
  const now = new Date();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = numericCode(12);
    const digest = cryptoService.digestCode(code, 'patient');
    if (!digest) continue;

    try {
      return await prisma.$transaction(async (tx) => {
        const rotated = await tx.patientCode.update({
          where: { patient_id: patientId },
          data: {
            code_digest: digest,
            code_ciphertext: cryptoService.encrypt(code, 'patient-code'),
            key_version: config.encryptionKeyVersion,
            code_version: { increment: 1 },
            rotated_at: now,
          },
        });
        await tx.accessGrant.updateMany({
          where: { patient_id: patientId, revoked_at: null },
          data: { revoked_at: now },
        });
        await tx.recordReadSession.updateMany({
          where: { patient_id: patientId, revoked_at: null },
          data: { revoked_at: now },
        });
        return rotated;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  throw new AppError(500, 'Could not rotate patient code', 'code_generation_failed');
}

export interface CreateGrantInput {
  patientId: string;
  accountId: string;
  fieldKeys: string[];
  channels: GrantChannel[];
  expiresAt: Date;
}

export interface CreatedGrant {
  grant: AccessGrant;
  code: string;
}

export async function createGrant(input: CreateGrantInput): Promise<CreatedGrant> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = numericCode(8);
    const digest = cryptoService.digestCode(code, 'grant');
    if (!digest) continue;
    // Codes work on their own, so a live code must be unique across all patients.
    if (await findLiveGrantPatient(digest)) continue;

    try {
      const grant = await prisma.accessGrant.create({
        data: {
          patient_id: input.patientId,
          code_digest: digest,
          expires_at: input.expiresAt,
          created_by_account_id: input.accountId,
          fields: {
            create: input.fieldKeys.map((fieldKey) => ({
              field: { connect: { field_key: fieldKey } },
            })),
          },
          channels: {
            create: input.channels.map((channel) => ({ channel })),
          },
        },
      });
      return { grant, code };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  throw new AppError(500, 'Could not allocate grant code', 'code_generation_failed');
}

/** The patient behind a live temporary access code, or null when absent or ambiguous. */
export async function findLiveGrantPatient(digest: string) {
  const grants = await prisma.accessGrant.findMany({
    where: { code_digest: digest, revoked_at: null, expires_at: { gt: new Date() } },
    select: { patient_id: true },
    take: 2,
  });
  return grants.length === 1 ? grants[0]! : null;
}

/** Fields for a one-tap share: the emergency summary, or every filled emergency-eligible field. */
export async function quickShareFieldKeys(patientId: string): Promise<string[]> {
  const selected = await prisma.emergencyField.findMany({
    where: { patient_id: patientId, field: { active: true } },
    orderBy: { display_order: 'asc' },
    select: { field_key: true },
  });
  if (selected.length) return selected.map((row) => row.field_key);
  const filled = await prisma.patientFieldValue.findMany({
    where: { patient_id: patientId, field: { active: true, emergency_eligible: true } },
    orderBy: { field: { sort_order: 'asc' } },
    select: { field_key: true },
  });
  return filled.map((row) => row.field_key);
}

export interface GrantSummary {
  id: string;
  grant_id: string;
  status: 'active' | 'expired' | 'revoked';
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  field_keys: string[];
  channels: GrantChannel[];
}

export async function listGrants(patientId: string, limit = 50): Promise<GrantSummary[]> {
  const rows = await prisma.accessGrant.findMany({
    where: { patient_id: patientId },
    orderBy: { created_at: 'desc' },
    take: Math.min(Math.max(Math.trunc(limit), 1), 100),
    include: {
      fields: { select: { field_key: true } },
      channels: { select: { channel: true } },
    },
  });

  const now = Date.now();
  return rows.map((grant) => ({
    id: grant.id,
    grant_id: grant.id,
    status:
      grant.revoked_at !== null
        ? 'revoked'
        : grant.expires_at.getTime() <= now
          ? 'expired'
          : 'active',
    expires_at: grant.expires_at,
    revoked_at: grant.revoked_at,
    created_at: grant.created_at,
    field_keys: grant.fields.map((field) => field.field_key).sort(),
    channels: grant.channels.map((channel) => channel.channel).sort(),
  }));
}

export async function revokeGrant(patientId: string, grantId: string): Promise<boolean> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const grant = await tx.accessGrant.findFirst({
      where: { id: grantId, patient_id: patientId },
      select: { id: true },
    });
    if (!grant) return false;

    await tx.accessGrant.updateMany({
      where: { id: grantId, patient_id: patientId, revoked_at: null },
      data: { revoked_at: now, version: { increment: 1 } },
    });
    await tx.recordReadSession.updateMany({
      where: { grant_id: grantId, patient_id: patientId, revoked_at: null },
      data: { revoked_at: now },
    });
    return true;
  });
}

export interface UpsertConsentInput {
  patientId: string;
  channel: ConsentChannel;
  phoneLinkId: string;
  fieldKeys: string[];
  expiresAt: Date;
}

export async function upsertConsent(input: UpsertConsentInput): Promise<ProfileUseConsent> {
  return prisma.$transaction(async (tx) => {
    const consent = await tx.profileUseConsent.upsert({
      where: {
        patient_id_channel: { patient_id: input.patientId, channel: input.channel },
      },
      create: {
        patient_id: input.patientId,
        channel: input.channel,
        phone_link_id: input.phoneLinkId,
        expires_at: input.expiresAt,
      },
      update: {
        phone_link_id: input.phoneLinkId,
        expires_at: input.expiresAt,
        revoked_at: null,
        version: { increment: 1 },
      },
    });

    await tx.consentField.deleteMany({ where: { consent_id: consent.id } });
    if (input.fieldKeys.length > 0) {
      await tx.consentField.createMany({
        data: input.fieldKeys.map((fieldKey) => ({
          consent_id: consent.id,
          field_key: fieldKey,
        })),
      });
    }
    return consent;
  });
}

export async function findActiveChannelLink(patientId: string, phoneLinkId?: string) {
  const now = new Date();
  return prisma.channelLink.findFirst({
    where: {
      patient_id: patientId,
      ...(phoneLinkId ? { id: phoneLinkId } : {}),
      revoked_at: null,
      OR: [{ expires_at: null }, { expires_at: { gt: now } }],
    },
    orderBy: { created_at: 'desc' },
  });
}

export async function revokeConsent(patientId: string, channel: ConsentChannel): Promise<void> {
  await prisma.profileUseConsent.updateMany({
    where: { patient_id: patientId, channel, revoked_at: null },
    data: { revoked_at: new Date(), version: { increment: 1 } },
  });
}

export function parseConsentChannel(value: string): ConsentChannel {
  const normalized = value.toUpperCase();
  if (normalized !== 'SMS' && normalized !== 'USSD') {
    throw new AppError(400, 'Unsupported consent channel', 'invalid_channel');
  }
  return normalized;
}

export function accountAttemptDigest(accountId: string) {
  return cryptoService.fingerprint(accountId);
}

export async function isAttemptThrottled(
  action: WebAttemptAction,
  accountId: string,
): Promise<boolean> {
  const denied = await prisma.accessAttempt.count({
    where: {
      channel: 'WEB',
      action,
      target_digest: accountAttemptDigest(accountId),
      outcome: { in: ['DENIED', 'THROTTLED'] },
      occurred_at: { gt: new Date(Date.now() - DENIAL_WINDOW_MS) },
    },
  });
  return denied >= DENIAL_LIMIT;
}

export async function recordAttempt(
  action: WebAttemptAction,
  accountId: string,
  outcome: 'ALLOWED' | 'DENIED' | 'THROTTLED',
  requestId: string,
) {
  await prisma.accessAttempt.create({
    data: {
      channel: 'WEB',
      action,
      outcome,
      target_digest: accountAttemptDigest(accountId),
      request_id: requestId,
    },
  });
}

export async function isApprovedPractitioner(
  accountId: string,
  roles: AccountRoleType[],
): Promise<boolean> {
  if (!roles.includes('PRACTITIONER')) return false;
  const profile = await prisma.practitionerProfile.findFirst({
    where: { account_id: accountId, verification_status: 'APPROVED' },
    select: { account_id: true },
  });
  return profile !== null;
}
