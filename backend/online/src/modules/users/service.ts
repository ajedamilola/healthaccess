import type { Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import sharp from 'sharp';
import { z } from 'zod';
import { config, crypto } from '../../config.js';
import { prisma } from '../../db.js';
import { AppError } from '../../middleware/error.js';
import { recordAudit } from '../../services/audit.js';
import { presignedGetUrl, uploadObject } from '../../services/s3.js';

const textSchema = z.string().trim().max(200);
const nameSchema = z.string().trim().min(1).max(100);
const dateSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Invalid date');
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format');

const languageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/, 'Use a language code such as en, yo, ha, ig or fr');

/**
 * Personal context fields. An empty string clears the stored value so a patient
 * can remove location or lifestyle details they no longer want the assistant to use.
 */
export const PERSONAL_FIELD_KEYS = {
  city: 'city',
  state: 'state',
  country: 'country',
  gender: 'gender',
  pregnancyStatus: 'pregnancy_status',
  smokingStatus: 'smoking_status',
  alcoholUse: 'alcohol_use',
  activityLevel: 'activity_level',
} as const;

type PersonalInputKey = keyof typeof PERSONAL_FIELD_KEYS;

export const profilePatchSchema = z.object({
  firstName: nameSchema.nullish(),
  lastName: nameSchema.nullish(),
  email: z.string().trim().email().max(320).nullish(),
  phone: phoneSchema.nullish(),
  dob: dateSchema.nullish(),
  city: textSchema.nullish(),
  state: textSchema.nullish(),
  country: textSchema.nullish(),
  gender: textSchema.nullish(),
  pregnancyStatus: textSchema.nullish(),
  smokingStatus: textSchema.nullish(),
  alcoholUse: textSchema.nullish(),
  activityLevel: textSchema.nullish(),
  preferredLanguage: languageSchema.nullish(),
  password: z.string().min(8).max(128).nullish(),
});

const severitySchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
  z.enum(['MILD', 'MODERATE', 'SEVERE']),
);

const allergySchema = z.object({
  name: z.string().trim().min(1).max(200),
  severity: severitySchema.nullish(),
  diagnosisDate: dateSchema.nullish(),
});

const medicalEventSchema = z.object({
  name: z.string().trim().min(1).max(200),
  recoveryTime: z.string().trim().max(200).nullish(),
  occurredOn: dateSchema.nullish(),
  date: dateSchema.nullish(),
  description: z.string().trim().max(4000).nullish(),
});

export const medicalUpdateSchema = z.object({
  firstName: nameSchema.nullish(),
  lastName: nameSchema.nullish(),
  email: z.string().trim().email().max(320).nullish(),
  phone: phoneSchema.nullish(),
  dob: dateSchema.nullish(),
  city: textSchema.nullish(),
  state: textSchema.nullish(),
  country: textSchema.nullish(),
  height: z.union([z.string(), z.number()]).nullish(),
  weight: z.union([z.string(), z.number()]).nullish(),
  gender: textSchema.nullish(),
  pregnancyStatus: textSchema.nullish(),
  smokingStatus: textSchema.nullish(),
  alcoholUse: textSchema.nullish(),
  activityLevel: textSchema.nullish(),
  bloodType: textSchema.nullish(),
  genoType: textSchema.nullish(),
  bloodPressure: textSchema.nullish(),
  existingMedicalConditions: z.union([z.string(), z.array(z.string())]).nullish(),
  existingMedications: z.union([z.string(), z.array(z.string())]).nullish(),
  emergencyContactName: textSchema.nullish(),
  emergencyContactPhone: textSchema.nullish(),
  allergies: z.array(allergySchema).nullish(),
  medicalEvents: z.array(medicalEventSchema).nullish(),
});

export const medicalEventPatchSchema = z.object({
  name: nameSchema.nullish(),
  recoveryTime: z.string().trim().max(200).nullish(),
  occurredOn: dateSchema.nullish(),
  date: dateSchema.nullish(),
  description: z.string().trim().max(4000).nullish(),
});

export type ProfilePatch = z.infer<typeof profilePatchSchema>;
export type MedicalUpdate = z.infer<typeof medicalUpdateSchema>;
export type MedicalEventPatch = z.infer<typeof medicalEventPatchSchema>;

type FieldEntry = [string, Prisma.InputJsonValue];

interface AccountPatchInput {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  password?: string | null;
}

interface CurrentAccount {
  id: string;
  email: string;
  display_name: string;
  phone_digest: string | null;
}

function textOrUndefined(value: string | null | undefined) {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stringList(value: string | string[] | null | undefined) {
  if (value == null) return undefined;
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function dateOnly(value: string) {
  return new Date(value).toISOString().slice(0, 10);
}

function composeDisplayName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  current: string,
) {
  const parts = current.split(/\s+/).filter(Boolean);
  const currentFirst = parts[0] ?? '';
  const currentLast = parts.slice(1).join(' ');
  const nextFirst = firstName != null ? firstName : currentFirst;
  const nextLast = lastName != null ? lastName : currentLast;
  return `${nextFirst} ${nextLast}`.trim();
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

async function avatarUrl(key: string | null) {
  if (!key) return null;
  try {
    return await presignedGetUrl(key, 900);
  } catch {
    return null;
  }
}

async function ensurePatientProfile(tx: Prisma.TransactionClient, accountId: string) {
  return tx.patientProfile.upsert({
    where: { account_id: accountId },
    update: {},
    create: { account_id: accountId },
  });
}

async function writeFieldValues(
  tx: Prisma.TransactionClient,
  patientId: string,
  accountId: string,
  entries: FieldEntry[],
) {
  if (entries.length === 0) return [];
  const keys = [...new Set(entries.map(([key]) => key))];
  const definitions = await tx.fieldDefinition.findMany({
    where: { field_key: { in: keys } },
    select: { field_key: true },
  });
  const allowed = new Set(definitions.map((definition) => definition.field_key));
  const written: string[] = [];

  for (const [fieldKey, value] of entries) {
    if (!allowed.has(fieldKey)) continue;
    await tx.patientFieldValue.upsert({
      where: { patient_id_field_key: { patient_id: patientId, field_key: fieldKey } },
      update: {
        value,
        source: 'PATIENT',
        updated_by_account_id: accountId,
        version: { increment: 1 },
      },
      create: {
        patient_id: patientId,
        field_key: fieldKey,
        value,
        source: 'PATIENT',
        updated_by_account_id: accountId,
      },
    });
    written.push(fieldKey);
  }

  return written;
}

function personalEntries(input: Partial<Record<PersonalInputKey, string | null | undefined>>) {
  const write: FieldEntry[] = [];
  const clear: string[] = [];
  for (const [inputKey, fieldKey] of Object.entries(PERSONAL_FIELD_KEYS) as Array<
    [PersonalInputKey, string]
  >) {
    const value = input[inputKey];
    if (value == null) continue;
    const trimmed = value.trim();
    if (trimmed) write.push([fieldKey, trimmed]);
    else clear.push(fieldKey);
  }
  return { write, clear };
}

function normalizePlace(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Match a free-text city/state to a directory area so care search, SMS and USSD
 * can default to the patient's home area. Returns null when nothing matches.
 */
export async function resolveHomeArea(
  db: Prisma.TransactionClient | typeof prisma,
  city: string | null | undefined,
  state: string | null | undefined,
) {
  const cityText = city?.trim();
  if (!cityText) return null;
  const normalized = normalizePlace(cityText);
  const candidates = await db.area.findMany({
    where: {
      active: true,
      is_demo: false,
      OR: [
        { name: { equals: cityText, mode: 'insensitive' } },
        { city: { equals: cityText, mode: 'insensitive' } },
        { aliases: { some: { alias_normalized: normalized } } },
      ],
    },
    select: { id: true, region: true, name: true },
    orderBy: { id: 'asc' },
    take: 10,
  });
  if (!candidates.length) return null;
  if (state?.trim()) {
    const wanted = state.trim().toLowerCase();
    const inRegion = candidates.filter((area) => area.region.toLowerCase() === wanted);
    if (inRegion.length === 1) return inRegion[0]!.id;
    if (inRegion.length > 1) {
      const exact = inRegion.filter((area) => area.name.toLowerCase() === cityText.toLowerCase());
      return exact.length === 1 ? exact[0]!.id : null;
    }
  }
  // Without a matching state, only an unambiguous match is used; a wrong saved area
  // is worse than none.
  if (new Set(candidates.map((area) => area.region.toLowerCase())).size > 1) return null;
  const exact = candidates.filter((area) => area.name.toLowerCase() === cityText.toLowerCase());
  return (exact[0] ?? candidates[0])!.id;
}

async function applyPersonalFields(
  tx: Prisma.TransactionClient,
  patientId: string,
  accountId: string,
  input: Partial<Record<PersonalInputKey, string | null | undefined>>,
) {
  const { write, clear } = personalEntries(input);
  const written = await writeFieldValues(tx, patientId, accountId, write);
  if (clear.length) {
    await tx.patientFieldValue.deleteMany({
      where: { patient_id: patientId, field_key: { in: clear } },
    });
  }

  if (input.city != null || input.state != null) {
    const stored = await tx.patientFieldValue.findMany({
      where: { patient_id: patientId, field_key: { in: ['city', 'state'] } },
      select: { field_key: true, value: true },
    });
    const value = (key: string) => {
      const entry = stored.find((item) => item.field_key === key)?.value;
      return typeof entry === 'string' ? entry : null;
    };
    const areaId = await resolveHomeArea(tx, value('city'), value('state'));
    await tx.patientProfile.update({
      where: { id: patientId },
      data: { home_area_id: areaId },
    });
  }

  return [...written, ...clear];
}

async function currentAccount(accountId: string): Promise<CurrentAccount> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, email: true, display_name: true, phone_digest: true },
  });
  if (!account) throw new AppError(404, 'Account not found', 'not_found');
  return account;
}

async function prepareAccountUpdate(current: CurrentAccount, input: AccountPatchInput) {
  const data: Prisma.AccountUpdateInput = {};
  const fields: FieldEntry[] = [];

  if (input.firstName != null || input.lastName != null) {
    const displayName = composeDisplayName(input.firstName, input.lastName, current.display_name);
    if (displayName && displayName !== current.display_name) {
      data.display_name = displayName;
    }
    if (displayName) fields.push(['full_name', displayName]);
  }

  if (input.email != null) {
    const email = input.email.trim().toLowerCase();
    if (email !== current.email) {
      const existing = await prisma.account.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existing && existing.id !== current.id) {
        throw new AppError(409, 'This email is already registered', 'email_taken');
      }
      data.email = email;
      data.email_verified_at = null;
    }
  }

  if (input.phone != null) {
    const digest = crypto.digestPhone(input.phone);
    if (digest !== current.phone_digest) {
      data.phone_digest = digest;
      data.phone_verified_at = null;
    }
  }

  if (input.password != null) {
    data.password_hash = await bcrypt.hash(input.password, 12);
  }

  return { data, fields };
}

export async function loadMe(accountId: string) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      email: true,
      display_name: true,
      status: true,
      idp_subject: true,
      avatar_key: true,
      email_verified_at: true,
      phone_verified_at: true,
      created_at: true,
      updated_at: true,
      roles: { select: { role: true } },
      patient_profile: {
        select: {
          id: true,
          preferred_language: true,
          home_area_id: true,
          home_area: { select: { id: true, name: true, city: true, region: true, country_code: true } },
          version: true,
          created_at: true,
          updated_at: true,
          field_values: {
            orderBy: { field_key: 'asc' },
            select: {
              field_key: true,
              value: true,
              updated_at: true,
              field: { select: { label: true, value_type: true } },
            },
          },
          allergies: {
            orderBy: { created_at: 'asc' },
            select: {
              id: true,
              name: true,
              severity: true,
              diagnosis_date: true,
              created_at: true,
              updated_at: true,
            },
          },
          medical_events: {
            orderBy: { created_at: 'asc' },
            select: {
              id: true,
              name: true,
              recovery_time: true,
              occurred_on: true,
              description: true,
              created_at: true,
              updated_at: true,
            },
          },
        },
      },
    },
  });

  if (!account) throw new AppError(404, 'Account not found', 'not_found');

  const profile = account.patient_profile;
  const fieldValues = profile?.field_values ?? [];

  return {
    account: {
      id: account.id,
      email: account.email,
      display_name: account.display_name,
      status: account.status,
      idp_subject: account.idp_subject,
      avatar_key: account.avatar_key,
      email_verified_at: account.email_verified_at,
      phone_verified_at: account.phone_verified_at,
      created_at: account.created_at,
      updated_at: account.updated_at,
    },
    roles: account.roles.map((role) => role.role),
    profile: profile
      ? {
          id: profile.id,
          preferred_language: profile.preferred_language,
          home_area_id: profile.home_area_id,
          home_area: profile.home_area,
          version: profile.version,
          created_at: profile.created_at,
          updated_at: profile.updated_at,
        }
      : null,
    fields: fieldValues.map((entry) => ({
      key: entry.field_key,
      label: entry.field.label,
      value_type: entry.field.value_type,
      value: entry.value,
      updated_at: entry.updated_at,
    })),
    field_values: Object.fromEntries(
      fieldValues.map((entry) => [entry.field_key, entry.value]),
    ) as Record<string, unknown>,
    allergies: profile?.allergies ?? [],
    medical_events: profile?.medical_events ?? [],
    avatar_url: await avatarUrl(account.avatar_key),
  };
}

export async function updateProfile(accountId: string, input: ProfilePatch) {
  const current = await currentAccount(accountId);
  const { data, fields } = await prepareAccountUpdate(current, input);

  if (input.dob != null) {
    fields.push(['date_of_birth', dateOnly(input.dob)]);
  }

  try {
    await prisma.$transaction(async (tx) => {
      const profile = await ensurePatientProfile(tx, accountId);
      await writeFieldValues(tx, profile.id, accountId, fields);
      await applyPersonalFields(tx, profile.id, accountId, input);
      if (input.preferredLanguage) {
        await tx.patientProfile.update({
          where: { id: profile.id },
          data: { preferred_language: input.preferredLanguage },
        });
      }
      if (Object.keys(data).length > 0) {
        await tx.account.update({ where: { id: accountId }, data });
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, 'This email is already registered', 'email_taken');
    }
    throw error;
  }

  return loadMe(accountId);
}

export async function updateMedical(
  accountId: string,
  input: MedicalUpdate,
  requestId: string,
) {
  const current = await currentAccount(accountId);
  const { data, fields } = await prepareAccountUpdate(current, input);

  if (input.dob != null) {
    fields.push(['date_of_birth', dateOnly(input.dob)]);
  }

  const addText = (key: string, value: string | null | undefined) => {
    const text = textOrUndefined(value);
    if (text) fields.push([key, text]);
  };
  const addList = (key: string, value: string | string[] | null | undefined) => {
    const list = stringList(value);
    if (list) fields.push([key, list]);
  };

  if (input.height != null) addText('height', String(input.height));
  if (input.weight != null) addText('weight', String(input.weight));
  addText('blood_pressure', input.bloodPressure);
  addText('blood_group', input.bloodType);
  addText('genotype', input.genoType);
  addList('conditions', input.existingMedicalConditions);
  addList('current_medications', input.existingMedications);
  addText('emergency_contact_name', input.emergencyContactName);
  addText('emergency_contact_phone', input.emergencyContactPhone);

  let patientId = '';
  let writtenFields: string[] = [];

  try {
    const result = await prisma.$transaction(async (tx) => {
      const profile = await ensurePatientProfile(tx, accountId);
      const written = await writeFieldValues(tx, profile.id, accountId, fields);
      written.push(...(await applyPersonalFields(tx, profile.id, accountId, input)));

      if (Object.keys(data).length > 0) {
        await tx.account.update({ where: { id: accountId }, data });
      }

      if (Array.isArray(input.allergies)) {
        // Keep the shareable "Allergies" record field in step with the allergy history,
        // so emergency summaries and quick shares include what the patient entered.
        const names = [...new Set(input.allergies.map((allergy) => allergy.name.trim()).filter(Boolean))];
        if (names.length) {
          written.push(...(await writeFieldValues(tx, profile.id, accountId, [['allergies', names]])));
        } else {
          await tx.patientFieldValue.deleteMany({
            where: { patient_id: profile.id, field_key: 'allergies' },
          });
        }
        await tx.allergy.deleteMany({ where: { patient_id: profile.id } });
        if (input.allergies.length > 0) {
          await tx.allergy.createMany({
            data: input.allergies.map((allergy) => ({
              patient_id: profile.id,
              name: allergy.name,
              severity: allergy.severity ?? 'MILD',
              diagnosis_date: allergy.diagnosisDate ? new Date(allergy.diagnosisDate) : null,
            })),
          });
        }
      }

      if (Array.isArray(input.medicalEvents)) {
        await tx.medicalEvent.deleteMany({ where: { patient_id: profile.id } });
        if (input.medicalEvents.length > 0) {
          await tx.medicalEvent.createMany({
            data: input.medicalEvents.map((event) => {
              const occurredOn = event.occurredOn ?? event.date;
              return {
                patient_id: profile.id,
                name: event.name,
                recovery_time: textOrUndefined(event.recoveryTime) ?? null,
                occurred_on: occurredOn ? new Date(occurredOn) : null,
                description: textOrUndefined(event.description) ?? null,
              };
            }),
          });
        }
      }

      return { patientId: profile.id, written };
    });
    patientId = result.patientId;
    writtenFields = result.written;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, 'This email is already registered', 'email_taken');
    }
    throw error;
  }

  await recordAudit({
    requestId,
    actorAccountId: accountId,
    patientId,
    channel: 'WEB',
    action: 'profile.medical.update',
    resourceType: 'patient_profile',
    resourceId: patientId,
    outcome: 'ALLOWED',
    fieldKeys: writtenFields,
    metadata: {
      allergy_count: input.allergies?.length ?? 0,
      medical_event_count: input.medicalEvents?.length ?? 0,
    },
  });

  return loadMe(accountId);
}

export async function removeAllergy(accountId: string, allergyId: string) {
  const profile = await prisma.patientProfile.findUnique({
    where: { account_id: accountId },
    select: { id: true },
  });
  if (!profile) return false;
  return prisma.$transaction(async (tx) => {
    const deleted = await tx.allergy.deleteMany({
      where: { id: allergyId, patient_id: profile.id },
    });
    if (deleted.count === 0) return false;
    // The shareable "Allergies" field mirrors the allergy list, so a removed allergy
    // must not keep appearing in emergency summaries or quick shares.
    const remaining = await tx.allergy.findMany({
      where: { patient_id: profile.id },
      orderBy: { created_at: 'asc' },
      select: { name: true },
    });
    const names = [...new Set(remaining.map((allergy) => allergy.name.trim()).filter(Boolean))];
    if (names.length) {
      await writeFieldValues(tx, profile.id, accountId, [['allergies', names]]);
    } else {
      await tx.patientFieldValue.deleteMany({
        where: { patient_id: profile.id, field_key: 'allergies' },
      });
    }
    return true;
  });
}

export async function removeMedicalEvent(accountId: string, eventId: string) {
  const profile = await prisma.patientProfile.findUnique({
    where: { account_id: accountId },
    select: { id: true },
  });
  if (!profile) return false;
  const deleted = await prisma.medicalEvent.deleteMany({
    where: { id: eventId, patient_id: profile.id },
  });
  return deleted.count > 0;
}

export async function updateMedicalEvent(
  accountId: string,
  eventId: string,
  input: MedicalEventPatch,
) {
  const profile = await prisma.patientProfile.findUnique({
    where: { account_id: accountId },
    select: { id: true },
  });
  if (!profile) throw new AppError(404, 'Medical event not found', 'not_found');

  const data: Prisma.MedicalEventUpdateManyMutationInput = {};
  if (input.name != null) data.name = input.name;
  if (input.recoveryTime !== undefined) {
    data.recovery_time = textOrUndefined(input.recoveryTime) ?? null;
  }
  if (input.occurredOn !== undefined || input.date !== undefined) {
    const occurredOn = input.occurredOn ?? input.date ?? null;
    data.occurred_on = occurredOn ? new Date(occurredOn) : null;
  }
  if (input.description !== undefined) {
    data.description = textOrUndefined(input.description) ?? null;
  }

  if (Object.keys(data).length === 0) {
    throw new AppError(400, 'No fields to update', 'no_changes');
  }

  const updated = await prisma.medicalEvent.updateMany({
    where: { id: eventId, patient_id: profile.id },
    data,
  });
  if (updated.count === 0) {
    throw new AppError(404, 'Medical event not found', 'not_found');
  }

  return prisma.medicalEvent.findUniqueOrThrow({ where: { id: eventId } });
}

export function assertStorageConfigured() {
  const { region, accessKeyId, secretAccessKey, bucket } = config.s3;
  if (!region || !accessKeyId || !secretAccessKey || !bucket) {
    throw new AppError(503, 'File storage is not configured', 'storage_unavailable');
  }
}

export async function updateAvatar(accountId: string, image: Buffer) {
  assertStorageConfigured();

  let body: Buffer;
  try {
    body = await sharp(image).resize({ width: 500, fit: 'cover' }).webp().toBuffer();
  } catch {
    throw new AppError(400, 'Invalid image file', 'invalid_image');
  }

  const key = `avatars/${accountId}.webp`;
  await uploadObject({ key, body, contentType: 'image/webp' });
  await prisma.account.update({ where: { id: accountId }, data: { avatar_key: key } });

  return { avatar_key: key, avatar_url: await presignedGetUrl(key, 900) };
}
