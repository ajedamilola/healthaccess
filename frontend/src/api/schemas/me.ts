import { z } from "zod";
import { accountSchema, rolesSchema } from "./auth";
import { idSchema, timestampSchema } from "./common";

export const valueTypeSchema = z.enum(["STRING", "STRING_ARRAY"]);

export const meFieldSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    value_type: valueTypeSchema,
    value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean(), z.null()]).optional(),
    updated_at: timestampSchema.optional(),
  })
  .loose();

export type MeField = z.infer<typeof meFieldSchema>;

export const allergySchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    severity: z.string().nullable().optional(),
    diagnosis_date: timestampSchema.nullable().optional(),
    created_at: timestampSchema.optional(),
    updated_at: timestampSchema.optional(),
  })
  .loose();

export type Allergy = z.infer<typeof allergySchema>;

export const medicalEventSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    recovery_time: z.string().nullable().optional(),
    occurred_on: timestampSchema.nullable().optional(),
    description: z.string().nullable().optional(),
    created_at: timestampSchema.optional(),
    updated_at: timestampSchema.optional(),
  })
  .loose();

export type MedicalEvent = z.infer<typeof medicalEventSchema>;

export const patientProfileSchema = z
  .object({
    id: idSchema,
    preferred_language: z.string().min(1),
    home_area_id: idSchema.nullable(),
    home_area: z
      .object({
        id: idSchema,
        name: z.string(),
        city: z.string(),
        region: z.string(),
        country_code: z.string(),
      })
      .loose()
      .nullable()
      .optional(),
    version: z.number().int().nonnegative(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .loose();

export type PatientProfile = z.infer<typeof patientProfileSchema>;

export const meResponseSchema = z
  .object({
    account: accountSchema,
    roles: rolesSchema,
    profile: patientProfileSchema,
    fields: z.array(meFieldSchema),
    field_values: z.record(z.string(), z.unknown()),
    allergies: z.array(allergySchema),
    medical_events: z.array(medicalEventSchema),
    avatar_url: z.string().nullable().optional(),
  })
  .loose();

export type MeResponse = z.infer<typeof meResponseSchema>;

export const patchMeBodySchema = z
  .object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    email: z.string().min(1).max(320).optional(),
    phone: z.string().optional(),
    dob: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    gender: z.string().max(200).optional(),
    pregnancyStatus: z.string().max(200).optional(),
    smokingStatus: z.string().max(200).optional(),
    alcoholUse: z.string().max(200).optional(),
    activityLevel: z.string().max(200).optional(),
    preferredLanguage: z.string().max(16).optional(),
    password: z.string().min(8).max(128).optional(),
  })
  .loose();

export type PatchMeBody = z.infer<typeof patchMeBodySchema>;

export const allergyInputSchema = z.object({
  name: z.string().min(1).max(200),
  severity: z.string().optional(),
  diagnosisDate: z.string().optional(),
});

export const medicalEventInputSchema = z.object({
  name: z.string().min(1).max(100),
  recoveryTime: z.string().max(200).optional(),
  occurredOn: z.string().optional(),
  date: z.string().optional(),
  description: z.string().max(4000).optional(),
});

export const putMedicalBodySchema = z
  .object({
    height: z.union([z.string(), z.number()]).optional(),
    weight: z.union([z.string(), z.number()]).optional(),
    gender: z.string().max(200).optional(),
    bloodType: z.string().optional(),
    genoType: z.string().optional(),
    bloodPressure: z.string().optional(),
    existingMedicalConditions: z.union([z.string(), z.array(z.string())]).optional(),
    existingMedications: z.union([z.string(), z.array(z.string())]).optional(),
    emergencyContactName: z.string().max(200).optional(),
    emergencyContactPhone: z.string().max(200).optional(),
    allergies: z.array(allergyInputSchema).optional(),
    medicalEvents: z.array(medicalEventInputSchema).optional(),
  })
  .loose();

export type PutMedicalBody = z.infer<typeof putMedicalBodySchema>;

export const patchMedicalEventBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    recoveryTime: z.string().max(200).nullable().optional(),
    occurredOn: z.string().optional(),
    date: z.string().optional(),
    description: z.string().max(4000).nullable().optional(),
  })
  .loose();

export const medicalEventResponseSchema = z
  .object({
    event: medicalEventSchema,
  })
  .loose();

export const assistantContextSchema = z
  .object({
    snapshot: z
      .object({
        ageYears: z.number().nullable(),
        ageBand: z.string().nullable(),
        sex: z.string().nullable(),
        pregnancyStatus: z.string().nullable(),
        location: z
          .object({
            city: z.string().nullable(),
            state: z.string().nullable(),
            country: z.string().nullable(),
            homeArea: z.string().nullable(),
          })
          .loose(),
        emergencyNumber: z.string(),
        preferredLanguage: z.string(),
        conditions: z.array(z.string()),
        medications: z.array(z.string()),
        allergies: z.array(z.object({ name: z.string(), severity: z.string() }).loose()),
      })
      .loose()
      .nullable(),
    language: z.string(),
    completeness: z
      .object({
        score: z.number().min(0).max(100),
        missing: z.array(z.object({ key: z.string(), label: z.string(), reason: z.string() }).loose()),
      })
      .loose(),
  })
  .loose();

export type AssistantContext = z.infer<typeof assistantContextSchema>;
