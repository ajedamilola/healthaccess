import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { ConsentChannel, GrantChannel, Prisma } from '@prisma/client';
import { crypto as cryptoService } from '../../config.js';
import { prisma } from '../../db.js';
import { emergencyProjection, grantProjection } from '../../domain/access.js';
import { requireAuth } from '../../middleware/auth.js';
import { AppError } from '../../middleware/error.js';
import { recordAudit } from '../../services/audit.js';
import {
  CONSENT_DEFAULT_MINUTES,
  GRANT_DEFAULT_MINUTES,
  GRANT_MAX_MINUTES,
  READ_SESSION_MINUTES,
  assertActiveFields,
  createGrant,
  findLiveGrantPatient,
  quickShareFieldKeys,
  ensurePatientCode,
  findActiveChannelLink,
  isApprovedPractitioner,
  isAttemptThrottled,
  listGrants,
  loadFieldState,
  parseConsentChannel,
  patientCodeResponse,
  putEmergencyFields,
  recordAttempt,
  resolvePatient,
  revokeConsent,
  revokeGrant,
  rotatePatientCode,
  updateProfileFields,
  upsertConsent,
} from './service.js';

export const mePortalRouter = Router();
export const recordsRouter = Router();

const grantChannels = ['WEB_PRACTITIONER', 'USSD'] as const;

function authOf(req: Request) {
  if (!req.auth) throw new AppError(401, 'Authentication required', 'unauthorized');
  return req.auth;
}

const fieldsBody = z.object({
  fields: z.record(z.unknown()),
  expected_version: z.number().int().nonnegative(),
});

const emergencyFieldsBody = z.object({
  field_keys: z.array(z.string().min(1)).max(50),
  expected_version: z.number().int().nonnegative(),
});

const grantBody = z.object({
  field_keys: z.array(z.string().min(1)).min(1).max(50),
  channels: z.array(z.enum(grantChannels)).min(1).max(2).optional(),
  expires_in_minutes: z.number().int().min(1).max(GRANT_MAX_MINUTES).optional(),
});

const consentBody = z.object({
  phone_link_id: z.string().uuid().optional(),
  field_keys: z.array(z.string().min(1)).min(1).max(50),
  expires_in_minutes: z.number().int().min(1).max(365 * 24 * 60).optional(),
});

const emergencyReadBody = z.object({
  patient_code: z.string().min(1).max(32),
});

const grantOpenBody = z.object({
  patient_code: z.string().min(1).max(32).optional(),
  grant_code: z.string().min(1).max(32),
});

const openBody = z.object({
  code: z.string().min(1).max(40),
});

const quickShareBody = z.object({
  expires_in_minutes: z.number().int().min(5).max(GRANT_MAX_MINUTES).optional(),
});

const limitQuery = z.coerce.number().int().min(1).max(100).default(50);

function uniqueKeys(keys: string[]) {
  return [...new Set(keys)];
}

mePortalRouter.get('/fields', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const patient = await resolvePatient(auth.accountId);
  res.json(await loadFieldState(patient.id));
});

mePortalRouter.put('/fields', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const body = fieldsBody.parse(req.body);
  const keys = Object.keys(body.fields);

  if (keys.length === 0) {
    throw new AppError(400, 'At least one field is required', 'invalid_fields');
  }
  for (const value of Object.values(body.fields)) {
    if (value === null || value === undefined) {
      throw new AppError(400, 'Field values cannot be null', 'invalid_value');
    }
  }
  if (!(await assertActiveFields(keys))) {
    throw new AppError(400, 'Unknown or inactive field keys', 'invalid_field');
  }

  const patient = await resolvePatient(auth.accountId);
  await updateProfileFields(
    patient.id,
    auth.accountId,
    body.fields as Record<string, Prisma.InputJsonValue>,
    body.expected_version,
  );

  await recordAudit({
    requestId: req.requestId,
    actorAccountId: auth.accountId,
    patientId: patient.id,
    channel: 'WEB',
    action: 'profile_update',
    resourceType: 'patient_profile',
    resourceId: patient.id,
    outcome: 'ALLOWED',
    fieldKeys: keys,
  });

  res.json(await loadFieldState(patient.id));
});

mePortalRouter.put('/emergency-fields', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const body = emergencyFieldsBody.parse(req.body);
  if (new Set(body.field_keys).size !== body.field_keys.length) {
    throw new AppError(400, 'Duplicate field keys', 'invalid_field');
  }

  const patient = await resolvePatient(auth.accountId);
  if (body.field_keys.length > 0) {
    const eligible = await prisma.patientFieldValue.findMany({
      where: {
        patient_id: patient.id,
        field_key: { in: body.field_keys },
        field: { active: true, emergency_eligible: true },
      },
      select: { field_key: true },
    });
    if (eligible.length !== body.field_keys.length) {
      throw new AppError(
        400,
        'Emergency fields must be active, emergency-eligible fields with a stored value',
        'invalid_field',
      );
    }
  }

  const version = await putEmergencyFields(patient.id, body.field_keys, body.expected_version);

  await recordAudit({
    requestId: req.requestId,
    actorAccountId: auth.accountId,
    patientId: patient.id,
    channel: 'WEB',
    action: 'emergency_fields_update',
    resourceType: 'patient_profile',
    resourceId: patient.id,
    outcome: 'ALLOWED',
    fieldKeys: body.field_keys,
  });

  res.json({ version, field_keys: body.field_keys });
});

mePortalRouter.get('/emergency-summary', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const patient = await resolvePatient(auth.accountId);
  const projection = await emergencyProjection(patient.id);
  res.json({
    available: projection.available,
    version: patient.version,
    field_keys: projection.fields.map((field) => field.key),
    fields: projection.fields,
  });
});

mePortalRouter.get('/patient-code', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const patient = await resolvePatient(auth.accountId);
  res.json(patientCodeResponse(await ensurePatientCode(patient.id)));
});

mePortalRouter.post('/patient-code/rotate', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const patient = await resolvePatient(auth.accountId);
  const record = await rotatePatientCode(patient.id);

  await recordAudit({
    requestId: req.requestId,
    actorAccountId: auth.accountId,
    patientId: patient.id,
    channel: 'WEB',
    action: 'patient_code_rotate',
    resourceType: 'patient_code',
    resourceId: patient.id,
    outcome: 'ALLOWED',
    fieldKeys: [],
  });

  res.json(patientCodeResponse(record));
});

mePortalRouter.get('/grants', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const limit = limitQuery.parse(req.query.limit);
  const patient = await resolvePatient(auth.accountId);
  res.json(await listGrants(patient.id, limit));
});

mePortalRouter.post('/grants', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const body = grantBody.parse(req.body);
  const fieldKeys = uniqueKeys(body.field_keys);
  const channels = uniqueKeys(body.channels ?? ['WEB_PRACTITIONER']) as GrantChannel[];

  if (!(await assertActiveFields(fieldKeys))) {
    throw new AppError(400, 'Unknown or inactive field keys', 'invalid_field');
  }

  const patient = await resolvePatient(auth.accountId);
  const minutes = body.expires_in_minutes ?? GRANT_DEFAULT_MINUTES;
  const { grant, code } = await createGrant({
    patientId: patient.id,
    accountId: auth.accountId,
    fieldKeys,
    channels,
    expiresAt: new Date(Date.now() + minutes * 60 * 1000),
  });

  await recordAudit({
    requestId: req.requestId,
    actorAccountId: auth.accountId,
    patientId: patient.id,
    channel: 'WEB',
    action: 'grant_create',
    resourceType: 'access_grant',
    resourceId: grant.id,
    outcome: 'ALLOWED',
    fieldKeys,
  });

  res.status(201).json({
    available: true,
    id: grant.id,
    grant_id: grant.id,
    code,
    expires_at: grant.expires_at,
    created_at: grant.created_at,
    field_keys: fieldKeys,
    channels,
  });
});

/**
 * One tap: share the emergency summary (or every filled emergency-eligible field)
 * as a single temporary code that works on the web and USSD.
 */
mePortalRouter.post('/grants/quick', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const body = quickShareBody.parse(req.body ?? {});
  const patient = await resolvePatient(auth.accountId);
  const fieldKeys = await quickShareFieldKeys(patient.id);
  if (!fieldKeys.length) {
    throw new AppError(
      400,
      'Add some health information to your record before sharing it',
      'nothing_to_share',
    );
  }
  const channels: GrantChannel[] = ['WEB_PRACTITIONER', 'USSD'];
  const minutes = body.expires_in_minutes ?? 60;
  const { grant, code } = await createGrant({
    patientId: patient.id,
    accountId: auth.accountId,
    fieldKeys,
    channels,
    expiresAt: new Date(Date.now() + minutes * 60 * 1000),
  });
  await recordAudit({
    requestId: req.requestId,
    actorAccountId: auth.accountId,
    patientId: patient.id,
    channel: 'WEB',
    action: 'grant_create',
    resourceType: 'access_grant',
    resourceId: grant.id,
    outcome: 'ALLOWED',
    fieldKeys,
  });
  res.status(201).json({
    available: true,
    id: grant.id,
    grant_id: grant.id,
    code,
    expires_at: grant.expires_at,
    created_at: grant.created_at,
    field_keys: fieldKeys,
    channels,
  });
});

mePortalRouter.delete('/grants/:id', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const grantId = z.string().uuid().parse(req.params.id);
  const patient = await resolvePatient(auth.accountId);
  const revoked = await revokeGrant(patient.id, grantId);
  if (!revoked) throw new AppError(404, 'Grant not found', 'not_found');

  await recordAudit({
    requestId: req.requestId,
    actorAccountId: auth.accountId,
    patientId: patient.id,
    channel: 'WEB',
    action: 'grant_revoke',
    resourceType: 'access_grant',
    resourceId: grantId,
    outcome: 'ALLOWED',
    fieldKeys: [],
  });

  res.json({ available: true, revoked: true, id: grantId });
});

mePortalRouter.get('/access-events', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const limit = limitQuery.parse(req.query.limit);
  const patient = await resolvePatient(auth.accountId);
  const events = await prisma.auditEvent.findMany({
    where: { patient_id: patient.id },
    orderBy: { occurred_at: 'desc' },
    take: limit,
  });

  res.json(
    events.map((event) => ({
      id: event.id.toString(),
      occurred_at: event.occurred_at,
      channel: event.channel,
      action: event.action,
      outcome: event.outcome,
      reason_code: event.reason_code,
      resource_type: event.resource_type,
      resource_id: event.resource_id,
      field_keys: event.field_keys,
    })),
  );
});

mePortalRouter.put('/consents/:channel', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const channel: ConsentChannel = parseConsentChannel(z.string().parse(req.params.channel));
  const body = consentBody.parse(req.body);
  const fieldKeys = uniqueKeys(body.field_keys);

  const patient = await resolvePatient(auth.accountId);
  if (!(await assertActiveFields(fieldKeys))) {
    throw new AppError(400, 'Unknown or inactive field keys', 'invalid_field');
  }

  const link = await findActiveChannelLink(patient.id, body.phone_link_id);
  if (!link) {
    throw new AppError(
      400,
      'An active channel link is required for this consent',
      'channel_link_required',
    );
  }

  const minutes = body.expires_in_minutes ?? CONSENT_DEFAULT_MINUTES;
  const consent = await upsertConsent({
    patientId: patient.id,
    channel,
    phoneLinkId: link.id,
    fieldKeys,
    expiresAt: new Date(Date.now() + minutes * 60 * 1000),
  });

  await recordAudit({
    requestId: req.requestId,
    actorAccountId: auth.accountId,
    patientId: patient.id,
    channel: 'WEB',
    action: 'channel_consent_put',
    resourceType: 'profile_consent',
    resourceId: consent.id,
    outcome: 'ALLOWED',
    fieldKeys,
  });

  res.json({
    available: true,
    consent_id: consent.id,
    channel: consent.channel,
    phone_link_id: consent.phone_link_id,
    expires_at: consent.expires_at,
    version: consent.version,
    field_keys: fieldKeys,
  });
});

mePortalRouter.delete('/consents/:channel', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const channel: ConsentChannel = parseConsentChannel(z.string().parse(req.params.channel));
  const patient = await resolvePatient(auth.accountId);
  await revokeConsent(patient.id, channel);

  await recordAudit({
    requestId: req.requestId,
    actorAccountId: auth.accountId,
    patientId: patient.id,
    channel: 'WEB',
    action: 'channel_consent_revoke',
    resourceType: 'profile_consent',
    resourceId: null,
    outcome: 'ALLOWED',
    fieldKeys: [],
  });

  res.json({ available: true, revoked: true });
});

async function denyWebRead(input: {
  req: Request;
  accountId: string;
  action: 'emergency_read' | 'grant_open';
  reason: string;
  patientId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  fieldKeys?: string[];
}) {
  await recordAttempt(input.action, input.accountId, 'DENIED', input.req.requestId);
  await recordAudit({
    requestId: input.req.requestId,
    actorAccountId: input.accountId,
    patientId: input.patientId ?? null,
    channel: 'WEB',
    action: input.action,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    outcome: 'DENIED',
    reasonCode: input.reason,
    fieldKeys: input.fieldKeys ?? [],
  });
}

async function emergencyRead(req: Request, patientCodeInput: string): Promise<Record<string, unknown>> {
  const auth = authOf(req);

  if (await isAttemptThrottled('emergency_read', auth.accountId)) {
    await recordAttempt('emergency_read', auth.accountId, 'THROTTLED', req.requestId);
    await recordAudit({
      requestId: req.requestId,
      actorAccountId: auth.accountId,
      patientId: null,
      channel: 'WEB',
      action: 'emergency_read',
      resourceType: null,
      resourceId: null,
      outcome: 'DENIED',
      reasonCode: 'throttled',
      fieldKeys: [],
    });
    return { available: false };
  }

  const digest = cryptoService.digestCode(patientCodeInput, 'patient');
  if (!digest) {
    await denyWebRead({
      req,
      accountId: auth.accountId,
      action: 'emergency_read',
      reason: 'invalid_patient_code',
      resourceType: 'patient_code',
    });
    return { available: false };
  }

  const patientCode = await prisma.patientCode.findUnique({
    where: { code_digest: digest },
    select: { patient_id: true },
  });
  if (!patientCode) {
    await denyWebRead({
      req,
      accountId: auth.accountId,
      action: 'emergency_read',
      reason: 'unknown_patient_code',
      resourceType: 'patient_code',
    });
    return { available: false };
  }

  const projection = await emergencyProjection(patientCode.patient_id);
  if (!projection.available) {
    await denyWebRead({
      req,
      accountId: auth.accountId,
      action: 'emergency_read',
      reason: 'no_shared_fields',
      patientId: patientCode.patient_id,
      resourceType: 'patient_profile',
      resourceId: patientCode.patient_id,
    });
    return { available: false };
  }

  await recordAttempt('emergency_read', auth.accountId, 'ALLOWED', req.requestId);
  await recordAudit({
    requestId: req.requestId,
    actorAccountId: auth.accountId,
    patientId: patientCode.patient_id,
    channel: 'WEB',
    action: 'emergency_read',
    resourceType: 'patient_profile',
    resourceId: patientCode.patient_id,
    outcome: 'ALLOWED',
    fieldKeys: projection.fields.map((field) => field.key),
  });

  return { ...projection };
}

async function grantOpen(
  req: Request,
  patientCodeInput: string | null,
  grantCodeInput: string,
): Promise<Record<string, unknown>> {
  const auth = authOf(req);

  if (!(await isApprovedPractitioner(auth.accountId, auth.roles))) {
    await recordAudit({
      requestId: req.requestId,
      actorAccountId: auth.accountId,
      patientId: null,
      channel: 'WEB',
      action: 'grant_open',
      resourceType: null,
      resourceId: null,
      outcome: 'DENIED',
      reasonCode: 'not_approved_practitioner',
      fieldKeys: [],
    });
    throw new AppError(403, 'Practitioner access required', 'forbidden');
  }

  if (await isAttemptThrottled('grant_open', auth.accountId)) {
    await recordAttempt('grant_open', auth.accountId, 'THROTTLED', req.requestId);
    await recordAudit({
      requestId: req.requestId,
      actorAccountId: auth.accountId,
      patientId: null,
      channel: 'WEB',
      action: 'grant_open',
      resourceType: null,
      resourceId: null,
      outcome: 'DENIED',
      reasonCode: 'throttled',
      fieldKeys: [],
    });
    return { available: false };
  }

  const patientDigest =
    patientCodeInput === null ? null : cryptoService.digestCode(patientCodeInput, 'patient');
  const grantDigest = cryptoService.digestCode(grantCodeInput, 'grant');
  if ((patientCodeInput !== null && !patientDigest) || !grantDigest) {
    await denyWebRead({
      req,
      accountId: auth.accountId,
      action: 'grant_open',
      reason: 'invalid_code_format',
      resourceType: 'access_grant',
    });
    return { available: false };
  }

  // One-code access: a temporary access code alone identifies its patient.
  const patientCode = patientDigest
    ? await prisma.patientCode.findUnique({
        where: { code_digest: patientDigest },
        select: { patient_id: true },
      })
    : await findLiveGrantPatient(grantDigest);
  if (!patientCode) {
    await denyWebRead({
      req,
      accountId: auth.accountId,
      action: 'grant_open',
      reason: patientDigest ? 'unknown_patient_code' : 'grant_unavailable',
      resourceType: patientDigest ? 'patient_code' : 'access_grant',
    });
    return { available: false };
  }

  const grant = await prisma.accessGrant.findFirst({
    where: {
      patient_id: patientCode.patient_id,
      code_digest: grantDigest,
      revoked_at: null,
      expires_at: { gt: new Date() },
    },
    include: {
      channels: { select: { channel: true } },
      fields: { select: { field_key: true } },
    },
  });
  if (!grant) {
    await denyWebRead({
      req,
      accountId: auth.accountId,
      action: 'grant_open',
      reason: 'grant_unavailable',
      patientId: patientCode.patient_id,
      resourceType: 'access_grant',
    });
    return { available: false };
  }

  if (!grant.channels.some((channel) => channel.channel === 'WEB_PRACTITIONER')) {
    await denyWebRead({
      req,
      accountId: auth.accountId,
      action: 'grant_open',
      reason: 'wrong_channel',
      patientId: patientCode.patient_id,
      resourceType: 'access_grant',
      resourceId: grant.id,
      fieldKeys: grant.fields.map((field) => field.field_key),
    });
    return { available: false };
  }

  const projection = await grantProjection(grant.id, patientCode.patient_id);
  if (!projection.available) {
    await denyWebRead({
      req,
      accountId: auth.accountId,
      action: 'grant_open',
      reason: 'no_fields',
      patientId: patientCode.patient_id,
      resourceType: 'access_grant',
      resourceId: grant.id,
    });
    return { available: false };
  }

  const now = new Date();
  const sessionExpiry = new Date(
    Math.min(now.getTime() + READ_SESSION_MINUTES * 60 * 1000, grant.expires_at.getTime()),
  );
  let readSession = await prisma.recordReadSession.findFirst({
    where: {
      account_id: auth.accountId,
      auth_session_id: auth.sessionId,
      grant_id: grant.id,
      purpose: 'GRANT',
      channel: 'WEB_PRACTITIONER',
      revoked_at: null,
      expires_at: { gt: now },
    },
    orderBy: { created_at: 'desc' },
  });

  readSession = readSession
    ? await prisma.recordReadSession.update({
        where: { id: readSession.id },
        data: { last_read_at: now },
      })
    : await prisma.recordReadSession.create({
        data: {
          patient_id: patientCode.patient_id,
          grant_id: grant.id,
          purpose: 'GRANT',
          channel: 'WEB_PRACTITIONER',
          account_id: auth.accountId,
          auth_session_id: auth.sessionId,
          expires_at: sessionExpiry,
        },
      });

  await recordAttempt('grant_open', auth.accountId, 'ALLOWED', req.requestId);
  await recordAudit({
    requestId: req.requestId,
    actorAccountId: auth.accountId,
    patientId: patientCode.patient_id,
    channel: 'WEB',
    action: 'grant_open',
    resourceType: 'access_grant',
    resourceId: grant.id,
    outcome: 'ALLOWED',
    fieldKeys: projection.fields.map((field) => field.key),
  });

  return {
    ...projection,
    grant_id: grant.id,
    read_session_id: readSession.id,
    expires_at: readSession.expires_at,
  };
}

recordsRouter.post('/emergency', requireAuth, async (req, res) => {
  const body = emergencyReadBody.parse(req.body);
  res.json(await emergencyRead(req, body.patient_code));
});

recordsRouter.post('/grant/open', requireAuth, async (req, res) => {
  const body = grantOpenBody.parse(req.body);
  res.json(await grantOpen(req, body.patient_code ?? null, body.grant_code));
});

/**
 * One box for every code. 12 digits is a patient's emergency code (any signed-in
 * user); 8 digits is a temporary access code (verified practitioners only).
 */
recordsRouter.post('/open', requireAuth, async (req, res) => {
  const body = openBody.parse(req.body);
  const code = body.code.replace(/[\s-]/g, '');
  if (/^\d{12}$/.test(code)) {
    const result = await emergencyRead(req, code);
    res.json(result.available ? { kind: 'emergency', ...result } : result);
    return;
  }
  if (/^\d{8}$/.test(code)) {
    const auth = authOf(req);
    if (!(await isApprovedPractitioner(auth.accountId, auth.roles))) {
      throw new AppError(
        403,
        'Temporary access codes open only for verified practitioners. Ask the patient for their 12-digit emergency code.',
        'practitioner_required',
      );
    }
    const result = await grantOpen(req, null, code);
    res.json(result.available ? { kind: 'grant', ...result } : result);
    return;
  }
  throw new AppError(400, 'Enter the 12-digit emergency code or the 8-digit access code', 'invalid_code');
});

recordsRouter.get('/grant/:id', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const sessionId = z.string().uuid().parse(req.params.id);
  const now = new Date();

  const readSession = await prisma.recordReadSession.findFirst({
    where: {
      id: sessionId,
      account_id: auth.accountId,
      auth_session_id: auth.sessionId,
      purpose: 'GRANT',
      channel: 'WEB_PRACTITIONER',
      revoked_at: null,
      expires_at: { gt: now },
    },
    include: { grant: { include: { channels: { select: { channel: true } } } } },
  });

  if (!readSession) {
    await recordAudit({
      requestId: req.requestId,
      actorAccountId: auth.accountId,
      patientId: null,
      channel: 'WEB',
      action: 'grant_read',
      resourceType: 'record_read_session',
      resourceId: null,
      outcome: 'DENIED',
      reasonCode: 'read_session_unavailable',
      fieldKeys: [],
    });
    res.json({ available: false });
    return;
  }

  const grant = readSession.grant;
  const grantLive =
    grant !== null &&
    grant.revoked_at === null &&
    grant.expires_at.getTime() > now.getTime() &&
    grant.channels.some((channel) => channel.channel === 'WEB_PRACTITIONER');

  if (!grantLive) {
    await prisma.recordReadSession.updateMany({
      where: { id: readSession.id, revoked_at: null },
      data: { revoked_at: now },
    });
    await recordAudit({
      requestId: req.requestId,
      actorAccountId: auth.accountId,
      patientId: readSession.patient_id,
      channel: 'WEB',
      action: 'grant_read',
      resourceType: 'access_grant',
      resourceId: readSession.grant_id,
      outcome: 'DENIED',
      reasonCode: 'grant_unavailable',
      fieldKeys: [],
    });
    res.json({ available: false });
    return;
  }

  const projection = await grantProjection(grant.id, readSession.patient_id);
  if (!projection.available) {
    await recordAudit({
      requestId: req.requestId,
      actorAccountId: auth.accountId,
      patientId: readSession.patient_id,
      channel: 'WEB',
      action: 'grant_read',
      resourceType: 'access_grant',
      resourceId: grant.id,
      outcome: 'DENIED',
      reasonCode: 'no_fields',
      fieldKeys: [],
    });
    res.json({ available: false });
    return;
  }

  await prisma.recordReadSession.update({
    where: { id: readSession.id },
    data: { last_read_at: now },
  });
  await recordAudit({
    requestId: req.requestId,
    actorAccountId: auth.accountId,
    patientId: readSession.patient_id,
    channel: 'WEB',
    action: 'grant_read',
    resourceType: 'access_grant',
    resourceId: grant.id,
    outcome: 'ALLOWED',
    fieldKeys: projection.fields.map((field) => field.key),
  });

  res.json({
    ...projection,
    grant_id: grant.id,
    read_session_id: readSession.id,
    expires_at: new Date(
      Math.min(readSession.expires_at.getTime(), grant.expires_at.getTime()),
    ),
  });
});

recordsRouter.post('/grant/:id/close', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const sessionId = z.string().uuid().parse(req.params.id);

  const readSession = await prisma.recordReadSession.findFirst({
    where: {
      id: sessionId,
      account_id: auth.accountId,
      auth_session_id: auth.sessionId,
      purpose: 'GRANT',
      channel: 'WEB_PRACTITIONER',
    },
  });
  if (!readSession) throw new AppError(404, 'Read session not found', 'not_found');

  const revokedAt = readSession.revoked_at ?? new Date();
  if (!readSession.revoked_at) {
    await prisma.recordReadSession.update({
      where: { id: readSession.id },
      data: { revoked_at: revokedAt },
    });
  }

  res.json({ closed: true, read_session_id: readSession.id, revoked_at: revokedAt });
});
