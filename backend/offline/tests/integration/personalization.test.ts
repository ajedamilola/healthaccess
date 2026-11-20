import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, hasDatabase, uniqueSuffix } from './support.js';

const IKEJA_AREA_ID = '20000000-0000-4000-8000-000000000001';

test(
  'saved area and personal hints require a live consent and are scoped to consented fields',
  { skip: !hasDatabase() },
  async () => {
    const h = await createHarness();
    const suffix = uniqueSuffix(h.prefix);
    const account = await h.prisma.account.create({
      data: { email: `personal-${suffix}@example.test`, password_hash: 'x', display_name: 'Private Name' },
    });
    try {
      const patient = await h.prisma.patientProfile.create({
        data: { account_id: account.id, home_area_id: IKEJA_AREA_ID, preferred_language: 'yo' },
      });
      const values: Array<[string, unknown]> = [
        ['date_of_birth', '1995-02-01'],
        ['gender', 'Female'],
        ['pregnancy_status', 'Pregnant'],
        ['conditions', ['Asthma']],
        ['allergies', ['Penicillin']],
        ['emergency_contact_phone', '+2348000000002'],
      ];
      for (const [field_key, value] of values) {
        await h.prisma.patientFieldValue.create({
          data: { patient_id: patient.id, field_key, value: value as never },
        });
      }
      const actor = { phone_digest: h.phoneDigest, request_id: `req-${suffix}` };
      assert.equal(await h.repository.findSavedArea(actor), null);
      assert.equal(await h.repository.readPersonalHints(actor), null);

      const link = await h.prisma.channelLink.create({
        data: { patient_id: patient.id, phone_envelope: 'sealed', phone_digest: h.phoneDigest },
      });
      await h.prisma.profileUseConsent.create({
        data: {
          patient_id: patient.id,
          channel: 'SMS',
          phone_link_id: link.id,
          expires_at: new Date(Date.now() + 60 * 60 * 1000),
          fields: {
            create: [
              { field_key: 'date_of_birth' },
              { field_key: 'gender' },
              { field_key: 'pregnancy_status' },
              { field_key: 'conditions' },
            ],
          },
        },
      });

      const area = await h.repository.findSavedArea(actor);
      assert.deepEqual(area, { id: IKEJA_AREA_ID, label: 'Ikeja, Lagos' });

      const hints = await h.repository.readPersonalHints(actor);
      assert.equal(hints?.sex, 'Female');
      assert.equal(hints?.pregnancy, 'Pregnant');
      assert.equal(hints?.ageBand, 'adult under 40');
      assert.deepEqual(hints?.conditions, ['Asthma']);
      // Allergies were not consented, so they are not used.
      assert.deepEqual(hints?.allergies, []);
      assert.equal(hints?.language, 'yo');
      assert.doesNotMatch(JSON.stringify(hints), /2348000000002|Private Name/);

      const audits = await h.prisma.auditEvent.findMany({
        where: { request_id: actor.request_id },
        select: { action: true, outcome: true },
      });
      assert.ok(audits.some((row) => row.action === 'profile_area_read' && row.outcome === 'ALLOWED'));
      assert.ok(audits.some((row) => row.action === 'assistant_context_read' && row.outcome === 'ALLOWED'));
    } finally {
      await h.prisma.auditEvent.deleteMany({ where: { request_id: `req-${suffix}` } });
      await h.prisma.account.delete({ where: { id: account.id } });
      await h.close();
    }
  },
);
