import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { sha256Hex } from '@healthaccess/shared';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { AppError } from '../../middleware/error.js';
import { emailConfigured, sendEmail } from '../../services/email.js';
import { logger } from '../../logger.js';

const RESET_TTL_MS = 30 * 60_000;
const RESET_COOLDOWN_MS = 60_000;

function invalidReset() {
  return new AppError(400, 'Invalid or expired reset link', 'invalid_reset_link');
}

export async function requestPasswordReset(email: string) {
  if (!emailConfigured) {
    throw new AppError(503, 'Email delivery is not configured', 'email_unavailable');
  }
  const account = await prisma.account.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, email: true, status: true },
  });

  if (!account || account.status !== 'ACTIVE') return { status: 'accepted' as const };

  const now = new Date();
  const recent = await prisma.authChallenge.findFirst({
    where: {
      account_id: account.id,
      purpose: 'PASSWORD_RESET',
      created_at: { gt: new Date(now.getTime() - RESET_COOLDOWN_MS) },
    },
    select: { id: true },
  });
  if (recent) return { status: 'accepted' as const };

  const token = randomBytes(32).toString('base64url');
  const tokenDigest = sha256Hex(token);
  const expiresAt = new Date(now.getTime() + RESET_TTL_MS);
  await prisma.$transaction(async (tx) => {
    await tx.authChallenge.updateMany({
      where: { account_id: account.id, purpose: 'PASSWORD_RESET', consumed_at: null },
      data: { consumed_at: now },
    });
    await tx.authChallenge.create({
      data: {
        account_id: account.id,
        purpose: 'PASSWORD_RESET',
        token_digest: tokenDigest,
        expires_at: expiresAt,
      },
    });
  });

  const resetUrl = new URL('/reset-password', config.frontendUrl);
  resetUrl.hash = new URLSearchParams({ token }).toString();
  try {
    await sendEmail({
      to: account.email,
      subject: 'Reset your HealthAccess password',
      text: [
        'We received a request to reset your HealthAccess password.',
        '',
        `Use this link within 30 minutes: ${resetUrl.href}`,
        '',
        'If you did not request this, you can ignore this email.',
      ].join('\n'),
    });
  } catch (error) {
    logger.error(
      { error_name: error instanceof Error ? error.name : 'UnknownError' },
      'password reset email delivery failed',
    );
    await prisma.authChallenge.updateMany({
      where: { account_id: account.id, token_digest: tokenDigest, consumed_at: null },
      data: { consumed_at: new Date() },
    });
    throw new AppError(503, 'Could not send password reset email', 'email_delivery_failed');
  }

  return { status: 'accepted' as const };
}

export async function resetPassword(token: string, password: string) {
  const challenge = await prisma.authChallenge.findFirst({
    where: {
      purpose: 'PASSWORD_RESET',
      token_digest: sha256Hex(token),
      consumed_at: null,
      expires_at: { gt: new Date() },
    },
    select: { id: true, account_id: true },
  });
  const accountId = challenge?.account_id;
  if (!challenge || !accountId) throw invalidReset();

  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const consumed = await tx.authChallenge.updateMany({
      where: {
        id: challenge.id,
        purpose: 'PASSWORD_RESET',
        consumed_at: null,
        expires_at: { gt: now },
      },
      data: { consumed_at: now },
    });
    if (consumed.count !== 1) throw invalidReset();

    await tx.account.update({
      where: { id: accountId },
      data: { password_hash: passwordHash },
    });
    await tx.authChallenge.updateMany({
      where: {
        account_id: accountId,
        purpose: 'PASSWORD_RESET',
        consumed_at: null,
      },
      data: { consumed_at: now },
    });
    await tx.authSession.updateMany({
      where: { account_id: accountId, revoked_at: null },
      data: { revoked_at: now },
    });
  });

  return { status: 'updated' as const };
}
