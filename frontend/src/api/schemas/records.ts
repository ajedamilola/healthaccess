import { z } from "zod";
import { idSchema, timestampSchema } from "./common";
import { sharedFieldSchema } from "./sharing";

export const emergencyLookupBodySchema = z.object({
  patient_code: z.string().min(1).max(32),
});

export type EmergencyLookupBody = z.infer<typeof emergencyLookupBodySchema>;

export const emergencyLookupResponseSchema = z
  .object({
    available: z.boolean(),
    fields: z.array(sharedFieldSchema).optional(),
  })
  .loose();

export type EmergencyLookupResponse = z.infer<typeof emergencyLookupResponseSchema>;

export const grantOpenBodySchema = z.object({
  patient_code: z.string().min(1).max(32),
  grant_code: z.string().min(1).max(32),
});

export type GrantOpenBody = z.infer<typeof grantOpenBodySchema>;

export const grantProjectionSchema = z
  .object({
    available: z.boolean(),
    fields: z.array(sharedFieldSchema).optional(),
    grant_id: idSchema.optional(),
    read_session_id: idSchema.optional(),
    expires_at: timestampSchema.optional(),
  })
  .loose();

export type GrantProjection = z.infer<typeof grantProjectionSchema>;

export const grantCloseResponseSchema = z
  .object({
    closed: z.boolean(),
    read_session_id: idSchema,
    revoked_at: timestampSchema,
  })
  .loose();

export type GrantCloseResponse = z.infer<typeof grantCloseResponseSchema>;

/** One box for every code: the API reports which kind of code it was. */
export const openCodeResponseSchema = grantProjectionSchema.extend({
  kind: z.enum(["emergency", "grant"]).optional(),
});

export type OpenCodeResponse = z.infer<typeof openCodeResponseSchema>;
