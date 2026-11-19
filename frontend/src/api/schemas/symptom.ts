import { z } from "zod";
import { idSchema, timestampSchema } from "./common";

export const severitySchema = z.enum(["MILD", "MODERATE", "SEVERE"]);

export const symptomRecordSchema = z
  .object({
    id: idSchema,
    patient_id: idSchema,
    account_id: idSchema,
    name: z.string().nullable().optional(),
    severity: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    include_records: z.boolean(),
    modify_history: z.boolean(),
    language: z.string().min(1),
    files: z.array(z.string()),
    thread_id: z.string().min(1),
    model_version: z.string().nullable().optional(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .loose();

export type SymptomRecord = z.infer<typeof symptomRecordSchema>;

export const symptomMessageSchema = z
  .object({
    type: z.enum(["Human", "AI"]),
    content: z.string(),
  })
  .loose();

export type SymptomMessage = z.infer<typeof symptomMessageSchema>;

export const symptomCreateResponseSchema = z
  .object({
    symptom: symptomRecordSchema,
    messages: z.array(symptomMessageSchema),
  })
  .loose();

export type SymptomCreateResponse = z.infer<typeof symptomCreateResponseSchema>;

export const symptomListResponseSchema = z
  .object({
    symptoms: z.array(symptomRecordSchema),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  })
  .loose();

export type SymptomListResponse = z.infer<typeof symptomListResponseSchema>;

export const symptomDetailResponseSchema = z
  .object({
    symptom: symptomRecordSchema,
    messages: z.array(symptomMessageSchema),
  })
  .loose();

export type SymptomDetailResponse = z.infer<typeof symptomDetailResponseSchema>;

export const symptomFollowUpResponseSchema = symptomDetailResponseSchema;

export const symptomUpdateBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    severity: z.union([severitySchema, z.literal("SEVERITY")]).optional(),
  })
  .loose();

export type SymptomUpdateBody = z.infer<typeof symptomUpdateBodySchema>;

export const symptomUpdateResponseSchema = z
  .object({
    symptom: symptomRecordSchema,
  })
  .loose();

export const symptomDeleteResponseSchema = z
  .object({
    deleted: z.boolean(),
  })
  .loose();

export const symptomCreateBodySchema = z.object({
  message: z.string().min(1).max(8000),
  includeRecords: z.boolean().default(false),
  modifyHistory: z.boolean().default(true),
  language: z.string().min(2).max(16).default("en"),
});

export type SymptomCreateBody = z.infer<typeof symptomCreateBodySchema>;

export const symptomFollowUpBodySchema = z.object({
  message: z.string().min(1).max(8000),
});

export type SymptomFollowUpBody = z.infer<typeof symptomFollowUpBodySchema>;
