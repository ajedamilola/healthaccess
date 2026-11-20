import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const createdAccountIds: string[] = [];
const createdAreaIds: string[] = [];

const requiredTables = [
  'accounts',
  'account_roles',
  'auth_sessions',
  'auth_challenges',
  'field_definitions',
  'patient_profiles',
  'patient_field_values',
  'emergency_fields',
  'patient_codes',
  'access_grants',
  'access_grant_fields',
  'access_grant_channels',
  'profile_use_consents',
  'consent_fields',
  'channel_links',
  'record_read_sessions',
  'ussd_sessions',
  'sms_inbox',
  'sms_conversations',
  'outbox',
  'delivery_events',
  'audit_events',
  'access_attempts',
  'idempotency_records',
  'conversations',
  'conversation_messages',
  'areas',
  'area_aliases',
  'services',
  'sources',
  'facilities',
  'facility_services',
  'web_leads',
  'referral_requests',
  'referral_results',
  'emergency_requests',
  'reviewed_health_content',
  'reviewed_content_citations',
  'web_observations',
  'symptom_analyses',
  'allergies',
  'medical_events',
  'medication_schedules',
  'medication_moments',
  'notification_tokens',
];

const requiredInvariantIndexes = [
  'channel_links_active_phone_key',
  'channel_links_active_phone_digest_idx',
  'areas_lookup_idx',
  'facility_services_approved_idx',
  'record_read_sessions_telecom_active_idx',
  'record_read_sessions_web_active_idx',
];

async function createTestAccount(label: string) {
  const account = await prisma.account.create({
    data: {
      email: `schema-test-${label}-${randomBytes(6).toString('hex')}@example.test`,
      password_hash: `schema-test-${randomBytes(16).toString('hex')}`,
      display_name: `Schema Test ${label}`,
    },
  });
  createdAccountIds.push(account.id);
  return account;
}

test.after(async () => {
  try {
    if (createdAccountIds.length > 0) {
      await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
    }
    if (createdAreaIds.length > 0) {
      await prisma.area.deleteMany({ where: { id: { in: createdAreaIds } } });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test('required tables exist in the public schema', async () => {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `;
  const present = new Set(rows.map((row) => row.table_name));
  const missing = requiredTables.filter((table) => !present.has(table));
  assert.deepEqual(missing, [], `missing tables: ${missing.join(', ')}`);
});

test('invariant constraints exist in the public schema', async () => {
  const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
    SELECT conname
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
  `;
  const present = new Set(rows.map((row) => row.conname));
  const expected = [
    'patient_profiles_version_positive',
    'patient_field_values_value_valid',
    'access_grants_expiry_after_creation',
    'facility_services_approved_verified',
    'reviewed_health_content_review_required',
    'ussd_sessions_bounds',
    'sms_inbox_attempts_nonnegative',
    'outbox_attempts_nonnegative',
    'delivery_events_status_length',
    'record_read_sessions_channel_shape',
    'record_read_sessions_purpose_shape',
  ];
  const missing = expected.filter((name) => !present.has(name));
  assert.deepEqual(missing, [], `missing constraints: ${missing.join(', ')}`);
});

test('invariant indexes exist in the public schema', async () => {
  const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = ANY(${requiredInvariantIndexes})
  `;
  const present = new Set(rows.map((row) => row.indexname));
  const missing = requiredInvariantIndexes.filter((name) => !present.has(name));
  assert.deepEqual(missing, [], `missing indexes: ${missing.join(', ')}`);
});

test('field definitions and services are seeded', async () => {
  const fields = await prisma.fieldDefinition.findMany({ select: { field_key: true } });
  const fieldKeys = new Set(fields.map((field) => field.field_key));
  for (const fieldKey of [
    'full_name',
    'allergies',
    'current_medications',
    'emergency_contact_name',
    'emergency_contact_phone',
  ]) {
    assert.ok(fieldKeys.has(fieldKey), `missing field definition: ${fieldKey}`);
  }

  const services = await prisma.service.findMany({ select: { service_code: true } });
  const serviceCodes = new Set(services.map((service) => service.service_code));
  for (const serviceCode of ['general', 'pediatrics']) {
    assert.ok(serviceCodes.has(serviceCode), `missing service: ${serviceCode}`);
  }
});

test('CHECK constraints reject invalid rows', async () => {
  const account = await createTestAccount('constraints');

  await assert.rejects(
    prisma.patientProfile.create({ data: { account_id: account.id, version: 0 } }),
    (error) =>
      /patient_profiles_version_positive|violates check constraint/i.test(String(error)) ||
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientUnknownRequestError,
  );
  assert.equal(await prisma.patientProfile.count({ where: { account_id: account.id } }), 0);

  const profile = await prisma.patientProfile.create({ data: { account_id: account.id } });

  await assert.rejects(
    prisma.accessGrant.create({
      data: {
        patient_id: profile.id,
        code_digest: randomBytes(32).toString('hex'),
        created_by_account_id: account.id,
        expires_at: new Date(Date.now() - 60_000),
      },
    }),
    (error) =>
      /access_grants_expiry_after_creation|violates check constraint/i.test(String(error)) ||
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientUnknownRequestError,
  );
  assert.equal(await prisma.accessGrant.count({ where: { patient_id: profile.id } }), 0);
});

test('emergency projection joins accounts, emergency fields and field values', async () => {
  const area = await prisma.area.create({
    data: {
      name: 'Schema Test Area',
      city: 'Schema Test City',
      region: 'Schema Test Region',
      is_demo: true,
    },
  });
  createdAreaIds.push(area.id);

  const account = await createTestAccount('projection');
  const profile = await prisma.patientProfile.create({
    data: { account_id: account.id, home_area_id: area.id },
  });

  const emergencyValues: Array<[string, Prisma.InputJsonValue, number]> = [
    ['full_name', 'Schema Test Patient', 10],
    ['allergies', ['None known'], 30],
    ['current_medications', ['None'], 40],
    ['emergency_contact_name', 'Schema Contact', 70],
    ['emergency_contact_phone', '+2348000000001', 80],
  ];

  for (const [field_key, value, display_order] of emergencyValues) {
    await prisma.patientFieldValue.create({
      data: { patient_id: profile.id, field_key, value },
    });
    await prisma.emergencyField.create({
      data: { patient_id: profile.id, field_key, display_order },
    });
  }

  await prisma.patientFieldValue.create({
    data: { patient_id: profile.id, field_key: 'weight', value: '70 kg' },
  });

  const rows = await prisma.$queryRaw<
    Array<{
      patient_id: string;
      display_name: string;
      field_key: string;
      display_order: number;
      value: Prisma.JsonValue;
    }>
  >`
    SELECT
      p.id AS patient_id,
      a.display_name,
      ef.field_key,
      ef.display_order,
      pfv.value
    FROM patient_profiles p
    JOIN accounts a ON a.id = p.account_id
    JOIN emergency_fields ef ON ef.patient_id = p.id
    JOIN patient_field_values pfv
      ON pfv.patient_id = ef.patient_id AND pfv.field_key = ef.field_key
    WHERE p.id = CAST(${profile.id} AS uuid)
    ORDER BY ef.display_order
  `;

  assert.equal(rows.length, emergencyValues.length);
  assert.deepEqual(
    rows.map((row) => row.field_key),
    ['full_name', 'allergies', 'current_medications', 'emergency_contact_name', 'emergency_contact_phone'],
  );
  assert.ok(rows.every((row) => row.patient_id === profile.id));
  assert.ok(rows.every((row) => row.display_name === account.display_name));
  assert.equal(String(rows[0].value), 'Schema Test Patient');
  assert.match(JSON.stringify(rows[1].value), /None known/);
  assert.ok(!rows.some((row) => row.field_key === 'weight'));
});
