import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { AccountRoleType } from '@prisma/client';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { accountAttemptDigest } from '../src/modules/portal/service.js';

const suffix = randomUUID().slice(0, 8);
const app = createApp();
const accountIds: string[] = [];
let patientToken = '';
let otherToken = '';
let practitionerToken = '';
let patientId = '';

async function account(name: string, roles: AccountRoleType[], practitioner = false) {
  const created = await prisma.account.create({
    data: {
      email: `${name}-${suffix}@sharing.test`,
      password_hash: 'x',
      display_name: name,
      roles: { create: roles.map((role) => ({ role })) },
      ...(roles.includes('PATIENT') ? { patient_profile: { create: {} } } : {}),
      ...(practitioner ? { practitioner_profile: { create: { verification_status: 'APPROVED' } } } : {}),
    },
    include: { patient_profile: true },
  });
  accountIds.push(created.id);
  const session = await prisma.authSession.create({
    data: {
      account_id: created.id,
      refresh_token_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      expires_at: new Date(Date.now() + 3600_000),
    },
  });
  const token = jwt.sign({ sub: created.id, sid: session.id, typ: 'access', roles }, config.jwtSecret, {
    expiresIn: 600,
  });
  return { token, patientId: created.patient_profile?.id ?? '' };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

before(async () => {
  const patient = await account('patient', ['PATIENT']);
  patientToken = patient.token;
  patientId = patient.patientId;
  otherToken = (await account('other', ['PATIENT'])).token;
  practitionerToken = (await account('doctor', ['PRACTITIONER'], true)).token;
});

after(async () => {
  await prisma.auditEvent.deleteMany({ where: { actor_account_id: { in: accountIds } } });
  await prisma.accessAttempt.deleteMany({
    where: { target_digest: { in: accountIds.map(accountAttemptDigest) } },
  });
  await prisma.accessGrant.deleteMany({ where: { created_by_account_id: { in: accountIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('one-code sharing', () => {
  it('refuses a quick share when there is nothing to share', async () => {
    const response = await request(app).post('/v1/me/grants/quick').set(auth(patientToken)).send({}).expect(400);
    assert.equal(response.body.error, 'nothing_to_share');
  });

  it('quick share creates one code that opens with no patient code', async () => {
    await prisma.patientFieldValue.createMany({
      data: [
        { patient_id: patientId, field_key: 'allergies', value: ['Penicillin'] },
        { patient_id: patientId, field_key: 'blood_group', value: 'O+' },
        { patient_id: patientId, field_key: 'weight', value: '70' },
      ],
    });
    const shared = await request(app).post('/v1/me/grants/quick').set(auth(patientToken)).send({}).expect(201);
    assert.match(shared.body.code, /^\d{8}$/);
    assert.deepEqual(shared.body.channels, ['WEB_PRACTITIONER', 'USSD']);
    // Weight is not emergency eligible, so it is not part of a quick share.
    assert.deepEqual([...shared.body.field_keys].sort(), ['allergies', 'blood_group']);

    const spaced = `${shared.body.code.slice(0, 4)} ${shared.body.code.slice(4)}`;
    const opened = await request(app)
      .post('/v1/records/open')
      .set(auth(practitionerToken))
      .send({ code: spaced })
      .expect(200);
    assert.equal(opened.body.kind, 'grant');
    assert.equal(opened.body.available, true);
    assert.ok(opened.body.read_session_id);

    const legacy = await request(app)
      .post('/v1/records/grant/open')
      .set(auth(practitionerToken))
      .send({ grant_code: shared.body.code })
      .expect(200);
    assert.equal(legacy.body.available, true);

    const denied = await request(app)
      .post('/v1/records/open')
      .set(auth(otherToken))
      .send({ code: shared.body.code })
      .expect(403);
    assert.equal(denied.body.error, 'practitioner_required');
  });

  it('the 12-digit emergency code opens the emergency summary for anyone signed in', async () => {
    const code = await request(app).get('/v1/me/patient-code').set(auth(patientToken)).expect(200);
    await prisma.emergencyField.create({
      data: { patient_id: patientId, field_key: 'allergies', display_order: 1 },
    });
    const opened = await request(app)
      .post('/v1/records/open')
      .set(auth(otherToken))
      .send({ code: code.body.code })
      .expect(200);
    assert.equal(opened.body.kind, 'emergency');
    assert.deepEqual(
      opened.body.fields.map((field: { key: string }) => field.key),
      ['allergies'],
    );

    const quick = await request(app).post('/v1/me/grants/quick').set(auth(patientToken)).send({}).expect(201);
    assert.deepEqual(quick.body.field_keys, ['allergies']);
  });

  it('rejects malformed codes and returns unavailable for unknown codes', async () => {
    const bad = await request(app).post('/v1/records/open').set(auth(otherToken)).send({ code: '123' }).expect(400);
    assert.equal(bad.body.error, 'invalid_code');
    const unknown = await request(app)
      .post('/v1/records/open')
      .set(auth(practitionerToken))
      .send({ code: '00000001' })
      .expect(200);
    assert.deepEqual(unknown.body, { available: false });
  });
});
