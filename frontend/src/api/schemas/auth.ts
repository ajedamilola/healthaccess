import { z } from "zod";
import { idSchema, roleSchema, timestampSchema } from "./common";

export const accountSchema = z
  .object({
    id: idSchema,
    email: z.string().min(1),
    display_name: z.string().nullable().optional(),
    status: z.string().min(1),
    idp_subject: z.string().nullable().optional(),
    avatar_key: z.string().nullable().optional(),
    email_verified_at: timestampSchema.nullable().optional(),
    phone_verified_at: timestampSchema.nullable().optional(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .loose();

export type Account = z.infer<typeof accountSchema>;

export const rolesSchema = z.array(roleSchema);

export const tokenPairSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    token_type: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_expires_in: z.number().int().positive().optional(),
  })
  .loose();

export type TokenPair = z.infer<typeof tokenPairSchema>;

export const sessionResponseSchema = z
  .object({
    account: accountSchema,
    roles: rolesSchema,
  })
  .loose();

export type Session = z.infer<typeof sessionResponseSchema>;

/** Upstream only: the BFF strips `tokens` before anything reaches the browser. */
export const authSuccessSchema = z
  .object({
    account: accountSchema,
    roles: rolesSchema,
    tokens: tokenPairSchema,
  })
  .loose();

export type AuthSuccess = z.infer<typeof authSuccessSchema>;

export const refreshResponseSchema = z
  .object({
    tokens: tokenPairSchema,
  })
  .loose();

export const loginBodySchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1).max(128),
});

export type LoginBody = z.infer<typeof loginBodySchema>;

export const forgotPasswordBodySchema = z.object({
  email: z.string().trim().email().max(320),
});

export const resetPasswordBodySchema = z
  .object({
    token: z.string().min(40).max(128),
    password: z.string().min(8).max(128),
    password_confirmation: z.string().min(8).max(128),
  })
  .refine((value) => value.password === value.password_confirmation, {
    path: ["password_confirmation"],
    message: "Passwords do not match",
  });

export const registerBodySchema = z
  .object({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    email: z.string().min(1).max(320),
    password: z.string().min(8).max(128),
    password_confirmation: z.string().min(8).max(128),
    dob: z.string().optional(),
    phone: z.string().optional(),
  })
  .refine((v) => v.password === v.password_confirmation, {
    path: ["password_confirmation"],
    message: "Passwords do not match",
  });

export type RegisterBody = z.infer<typeof registerBodySchema>;

export const phoneBeginBodySchema = z.object({
  phone: z.string().min(9).max(16),
});

export const phoneBeginResponseSchema = z
  .object({
    status: z.string().min(1),
    expires_in: z.number().int().positive(),
  })
  .loose();

export const phoneConfirmBodySchema = z.object({
  phone: z.string().min(9).max(16),
  code: z.string().regex(/^\d{6}$/, "Enter the six digit code"),
});

export const phoneConfirmResponseSchema = z
  .object({
    verified: z.boolean(),
    phone_verified_at: timestampSchema,
  })
  .loose();
