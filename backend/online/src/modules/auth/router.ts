import { Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import { Router } from 'express';
import { z } from 'zod';
import { crypto } from '../../config.js';
import { prisma } from '../../db.js';
import { requireAuth } from '../../middleware/auth.js';
import { AppError } from '../../middleware/error.js';
import { completeGoogleSignIn, googleAuthorizationUrl } from './google.js';
import { beginPhoneVerification, confirmPhoneVerification } from './phone.js';
import { requestPasswordReset, resetPassword } from './password-reset.js';
import { hashIp, issueSession, revokeRefreshToken, rotateRefreshToken } from './tokens.js';

export const authRouter = Router();

const emailSchema = z.string().trim().email().max(320);
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format');
const dateSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Invalid date');

const registerSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: emailSchema,
    password: z.string().min(8).max(128),
    password_confirmation: z.string(),
    dob: dateSchema.nullish(),
    phone: phoneSchema.nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.password !== value.password_confirmation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password_confirmation'],
        message: 'Passwords do not match',
      });
    }
  });

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

const refreshSchema = z.object({ refresh_token: z.string().min(1).max(512) });
const logoutSchema = z.object({ refresh_token: z.string().min(1).max(512) });
const phoneBodySchema = z.object({ phone: phoneSchema });
const phoneConfirmSchema = z.object({
  phone: phoneSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'Code must be 6 digits'),
});
const forgotPasswordSchema = z.object({ email: emailSchema });
const resetPasswordSchema = z
  .object({
    token: z.string().min(40).max(128),
    password: z.string().min(8).max(128),
    password_confirmation: z.string().min(8).max(128),
  })
  .refine((value) => value.password === value.password_confirmation, {
    path: ['password_confirmation'],
    message: 'Passwords do not match',
  });

function sessionContext(req: {
  headers: Record<string, unknown>;
  ip?: string;
}) {
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
  return { userAgent, ipHash: hashIp(req.ip) };
}

function accountSummary(account: {
  id: string;
  email: string;
  display_name: string;
  status: string;
  idp_subject: string | null;
  avatar_key: string | null;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}) {
  return {
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
  };
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

authRouter.post('/register', async (req, res) => {
  const input = registerSchema.parse(req.body);
  const email = input.email.toLowerCase();
  const displayName = `${input.firstName} ${input.lastName}`.trim();
  const passwordHash = await bcrypt.hash(input.password, 12);

  let account;
  try {
    account = await prisma.$transaction(async (tx) => {
      const created = await tx.account.create({
        data: {
          email,
          password_hash: passwordHash,
          display_name: displayName,
          phone_digest: input.phone ? crypto.digestPhone(input.phone) : null,
        },
      });
      await tx.accountRole.create({ data: { account_id: created.id, role: 'PATIENT' } });
      const profile = await tx.patientProfile.create({ data: { account_id: created.id } });

      if (input.dob) {
        const definition = await tx.fieldDefinition.findUnique({
          where: { field_key: 'date_of_birth' },
        });
        if (definition) {
          await tx.patientFieldValue.create({
            data: {
              patient_id: profile.id,
              field_key: 'date_of_birth',
              value: new Date(input.dob).toISOString().slice(0, 10),
              source: 'PATIENT',
              updated_by_account_id: created.id,
            },
          });
        }
      }

      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, 'This email is already registered', 'email_taken');
    }
    throw error;
  }

  const roles = await prisma.accountRole.findMany({ where: { account_id: account.id } });
  const tokens = await issueSession(
    account.id,
    roles.map((role) => role.role),
    sessionContext(req),
  );

  res.status(201).json({
    account: accountSummary(account),
    roles: roles.map((role) => role.role),
    tokens,
  });
});

authRouter.post('/login', async (req, res) => {
  const input = loginSchema.parse(req.body);
  const email = input.email.toLowerCase();
  const account = await prisma.account.findUnique({
    where: { email },
    include: { roles: true },
  });

  if (!account || !account.password_hash) {
    throw new AppError(401, 'Invalid email or password', 'invalid_credentials');
  }

  const matches = await bcrypt.compare(input.password, account.password_hash);
  if (!matches) {
    throw new AppError(401, 'Invalid email or password', 'invalid_credentials');
  }
  if (account.status !== 'ACTIVE') {
    throw new AppError(403, 'Account is not active', 'account_inactive');
  }

  const tokens = await issueSession(
    account.id,
    account.roles.map((role) => role.role),
    sessionContext(req),
  );

  res.json({
    account: accountSummary(account),
    roles: account.roles.map((role) => role.role),
    tokens,
  });
});

authRouter.post('/forgot-password', async (req, res) => {
  const input = forgotPasswordSchema.parse(req.body);
  const result = await requestPasswordReset(input.email);
  res.status(202).json(result);
});

authRouter.post('/reset-password', async (req, res) => {
  const input = resetPasswordSchema.parse(req.body);
  const result = await resetPassword(input.token, input.password);
  res.json(result);
});

authRouter.post('/refresh', async (req, res) => {
  const input = refreshSchema.parse(req.body);
  const tokens = await rotateRefreshToken(input.refresh_token);
  res.json({ tokens });
});

authRouter.post('/logout', async (req, res) => {
  const input = logoutSchema.parse(req.body);
  await revokeRefreshToken(input.refresh_token);
  res.status(204).end();
});

authRouter.get('/google', (_req, res) => {
  res.redirect(googleAuthorizationUrl());
});

authRouter.get('/google/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  if (!code) {
    throw new AppError(400, 'Missing Google authorization code', 'google_code_missing');
  }
  const redirectUrl = await completeGoogleSignIn(code, sessionContext(req));
  res.redirect(redirectUrl);
});

authRouter.post('/phone/begin', requireAuth, async (req, res) => {
  const input = phoneBodySchema.parse(req.body);
  const result = await beginPhoneVerification(req.auth!.accountId, input.phone);
  res.json(result);
});

authRouter.post('/phone/confirm', requireAuth, async (req, res) => {
  const input = phoneConfirmSchema.parse(req.body);
  const result = await confirmPhoneVerification(
    req.auth!.accountId,
    input.phone,
    input.code,
  );
  res.json(result);
});
