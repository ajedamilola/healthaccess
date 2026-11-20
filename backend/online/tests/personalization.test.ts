import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import request from 'supertest';
import { ageFrom, heightInCm, renderSnapshot, weightInKg } from '../src/ai/context.js';
import { symptomChatPrompt } from '../src/ai/prompts.js';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const app = createApp();
const runId = randomUUID().slice(0, 8);
const createdAccountIds: string[] = [];

async function register(name: string) {
  const response = await request(app)
    .post('/v1/auth/register')
    .send({
      firstName: 'Test',
      lastName: name,
      email: `personal-${runId}-${name}@example.test`,
      password: 'password123',
      password_confirmation: 'password123',
    })
    .expect(201);
  createdAccountIds.push(response.body.account.id);
  return { Authorization: `Bearer ${response.body.tokens.access_token as string}` };
}

after(async () => {
  await prisma.auditEvent.deleteMany({ where: { actor_account_id: { in: createdAccountIds } } });
  await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  await prisma.$disconnect();
});

test('PATCH /me stores location, lifestyle and language and matches the home area', async () => {
  const auth = await register('location');
  const updated = await request(app)
    .patch('/v1/me')
    .set(auth)
    .send({
      city: 'ikeja',
      state: 'Lagos',
      country: 'Nigeria',
      gender: 'Female',
      pregnancyStatus: 'Pregnant',
      smokingStatus: 'Never smoked',
      preferredLanguage: 'YO',
    })
    .expect(200);
  assert.equal(updated.body.field_values.city, 'ikeja');
  assert.equal(updated.body.field_values.country, 'Nigeria');
  assert.equal(updated.body.field_values.pregnancy_status, 'Pregnant');
  assert.equal(updated.body.field_values.smoking_status, 'Never smoked');
  assert.equal(updated.body.profile.preferred_language, 'yo');
  assert.equal(updated.body.profile.home_area?.name, 'Ikeja');

  const cleared = await request(app)
    .patch('/v1/me')
    .set(auth)
    .send({ city: 'Somewhere Unlisted', pregnancyStatus: '' })
    .expect(200);
  assert.equal(cleared.body.field_values.pregnancy_status, undefined);
  assert.equal(cleared.body.profile.home_area_id, null);
});

test('PATCH /me rejects an invalid language code', async () => {
  const auth = await register('language');
  await request(app).patch('/v1/me').set(auth).send({ preferredLanguage: 'not a code' }).expect(400);
});

test('GET /me/assistant-context returns a de-identified snapshot and missing items', async () => {
  const auth = await register('context');
  const empty = await request(app).get('/v1/me/assistant-context').set(auth).expect(200);
  assert.ok(empty.body.completeness.score < 20);
  assert.ok(empty.body.completeness.missing.some((item: { key: string }) => item.key === 'city'));

  await request(app)
    .put('/v1/me/medical')
    .set(auth)
    .send({
      dob: '1990-05-01',
      gender: 'Male',
      city: 'Ikeja',
      country: 'NG',
      height: '180',
      weight: '80',
      genoType: 'AS',
      existingMedicalConditions: ['Asthma'],
      existingMedications: ['Salbutamol inhaler'],
      emergencyContactPhone: '+2348000000001',
      allergies: [{ name: 'Penicillin', severity: 'SEVERE' }],
    })
    .expect(200);

  const filled = await request(app).get('/v1/me/assistant-context').set(auth).expect(200);
  const snapshot = filled.body.snapshot;
  assert.equal(snapshot.sex, 'Male');
  assert.equal(snapshot.location.city, 'Ikeja');
  assert.equal(snapshot.emergencyNumber, '112');
  assert.equal(snapshot.vitals.bmi, 24.7);
  assert.deepEqual(snapshot.conditions, ['Asthma']);
  assert.deepEqual(snapshot.allergies, [{ name: 'Penicillin', severity: 'SEVERE' }]);
  assert.ok(filled.body.completeness.score >= 90);
  assert.doesNotMatch(JSON.stringify(filled.body), /2348000000001|@example\.test|Test context/);
});

test('snapshot helpers interpret free-text vitals and render a compact prompt block', () => {
  assert.equal(heightInCm('1.75 m'), 175);
  assert.equal(heightInCm("5'10"), 178);
  assert.equal(weightInKg('154 lbs'), 70);
  assert.equal(ageFrom('2000-12-31', new Date('2026-11-18')), 25);
  const text = renderSnapshot({
    ageYears: 30,
    ageBand: 'adult (18-39)',
    sex: 'Female',
    pregnancyStatus: 'Pregnant',
    location: { city: 'Ikeja', state: 'Lagos', country: 'Nigeria', homeArea: null },
    emergencyNumber: '112',
    preferredLanguage: 'en',
    vitals: { heightCm: null, weightKg: null, bmi: null, bloodGroup: null, genotype: 'SS', bloodPressure: null },
    conditions: ['Sickle cell disease'],
    medications: [],
    allergies: [],
    lifestyle: { smoking: null, alcohol: null, activity: null },
    pastEvents: [],
    recentSymptoms: [],
  });
  assert.match(text, /Location: Ikeja, Lagos, Nigeria/);
  assert.match(text, /Pregnancy status: Pregnant/);
  assert.match(text, /Genotype: SS/);
  assert.doesNotMatch(text, /Height/);
});

test('symptom prompt embeds patient context only when records are allowed', () => {
  const withRecords = symptomChatPrompt({
    patientId: 'p',
    symptomId: 's',
    includeRecords: true,
    modifyHistory: true,
    hasImages: false,
    patientContext: '- Location: Ikeja',
    language: 'Yoruba',
    emergencyNumber: '112',
    today: '2026-11-18',
  });
  assert.match(withRecords, /Location: Ikeja/);
  assert.match(withRecords, /Reply in Yoruba/);
  assert.match(withRecords, /emergency number is 112/);
  assert.match(withRecords, /2026-11-18/);

  const without = symptomChatPrompt({
    patientId: 'p',
    symptomId: 's',
    includeRecords: false,
    modifyHistory: false,
    hasImages: false,
    patientContext: '- Location: Ikeja',
  });
  assert.doesNotMatch(without, /Location: Ikeja/);
  assert.match(without, /Do not look up or use the patient record/);
});

test('saving the allergy list keeps the shareable allergies field in sync', async () => {
  const auth = await register('allergy-sync');
  const saved = await request(app)
    .put('/v1/me/medical')
    .set(auth)
    .send({ allergies: [{ name: 'Penicillin' }, { name: 'Peanuts', severity: 'SEVERE' }] })
    .expect(200);
  assert.deepEqual(saved.body.field_values.allergies, ['Penicillin', 'Peanuts']);
  const shared = await request(app).post('/v1/me/grants/quick').set(auth).send({}).expect(201);
  assert.deepEqual(shared.body.field_keys, ['allergies']);
  await prisma.accessGrant.deleteMany({ where: { id: shared.body.grant_id } });

  const cleared = await request(app).put('/v1/me/medical').set(auth).send({ allergies: [] }).expect(200);
  assert.equal(cleared.body.field_values.allergies, undefined);
});

test('deleting one allergy also removes it from the shareable field', async () => {
  const auth = await register('allergy-delete');
  const saved = await request(app)
    .put('/v1/me/medical')
    .set(auth)
    .send({ allergies: [{ name: 'Penicillin' }, { name: 'Peanuts' }] })
    .expect(200);
  const penicillin = saved.body.allergies.find((item: { name: string }) => item.name === 'Penicillin');
  await request(app).delete(`/v1/me/allergies/${penicillin.id}`).set(auth).expect(204);
  const me = await request(app).get('/v1/me').set(auth).expect(200);
  assert.deepEqual(me.body.field_values.allergies, ['Peanuts']);

  const peanuts = me.body.allergies[0];
  await request(app).delete(`/v1/me/allergies/${peanuts.id}`).set(auth).expect(204);
  const empty = await request(app).get('/v1/me').set(auth).expect(200);
  assert.equal(empty.body.field_values.allergies, undefined);
});

test('an ambiguous city does not pick an arbitrary home area', async () => {
  const ids = [randomUUID(), randomUUID()];
  const town = `Testtown${runId}`;
  await prisma.area.createMany({
    data: [
      { id: ids[0]!, name: town, city: town, region: 'Lagos', country_code: 'NG' },
      { id: ids[1]!, name: town, city: town, region: 'Ogun', country_code: 'NG' },
    ],
  });
  try {
    const auth = await register('ambiguous-area');
    const ambiguous = await request(app).patch('/v1/me').set(auth).send({ city: town }).expect(200);
    assert.equal(ambiguous.body.profile.home_area_id, null);
    const chosen = await request(app).patch('/v1/me').set(auth).send({ state: 'Ogun' }).expect(200);
    assert.equal(chosen.body.profile.home_area_id, ids[1]);
  } finally {
    await prisma.patientProfile.updateMany({ where: { home_area_id: { in: ids } }, data: { home_area_id: null } });
    await prisma.area.deleteMany({ where: { id: { in: ids } } });
  }
});
