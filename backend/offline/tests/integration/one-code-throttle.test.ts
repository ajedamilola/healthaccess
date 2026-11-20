import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { createHarness, hasDatabase, uniqueSuffix } from './support.js';
import { createUssdEngine } from '../../src/channels/ussd.js';
import { createUssdHandler } from '../../src/channels/ussd-handler.js';

test(
  'guessing different temporary codes from one phone is throttled across all codes',
  { skip: !hasDatabase() },
  async () => {
    const h = await createHarness();
    const suffix = uniqueSuffix(h.prefix);
    const account = await h.prisma.account.create({
      data: { email: `throttle-${suffix}@example.test`, password_hash: 'x', display_name: 'T' },
    });
    try {
      const patient = await h.prisma.patientProfile.create({ data: { account_id: account.id } });
      await h.prisma.patientFieldValue.create({
        data: { patient_id: patient.id, field_key: 'allergies', value: ['Penicillin'] },
      });
      const realCode = String(randomInt(0, 1e8)).padStart(8, '0');
      await h.prisma.accessGrant.create({
        data: {
          patient_id: patient.id,
          code_digest: h.crypto.digestCode(realCode, 'grant')!,
          expires_at: new Date(Date.now() + 3600_000),
          created_by_account_id: account.id,
          fields: { create: [{ field_key: 'allergies' }] },
          channels: { create: [{ channel: 'USSD' }] },
        },
      });
      const handler = createUssdHandler({
        repository: h.repository,
        crypto: h.crypto,
        config: h.config,
        createEngine: createUssdEngine,
      });
      async function tryCode(code: string) {
        const body = { sessionId: `${suffix}-${randomUUID()}`, phoneNumber: h.phone, serviceCode: '*test#', text: '' };
        await handler(body, randomUUID());
        await handler({ ...body, text: '2' }, randomUUID());
        return handler({ ...body, text: `2*${code}` }, randomUUID());
      }

      // The right code works first time.
      assert.match(await tryCode(realCode), /Penicillin/);
      // Eight wrong, all different, guesses...
      for (let i = 0; i < 8; i += 1) {
        let guess = String(randomInt(0, 1e8)).padStart(8, '0');
        if (guess === realCode) guess = String((Number(guess) + 1) % 1e8).padStart(8, '0');
        assert.match(await tryCode(guess), /did not work/);
      }
      // ...and now even the right code is refused from this phone for a while.
      assert.doesNotMatch(await tryCode(realCode), /Penicillin/);
    } finally {
      await h.prisma.accessAttempt.deleteMany({ where: { phone_digest: h.phoneDigest } });
      await h.prisma.auditEvent.deleteMany({ where: { patient_id: { not: null }, actor_ref: h.phoneDigest } }).catch(() => undefined);
      await h.prisma.accessGrant.deleteMany({ where: { created_by_account_id: account.id } });
      await h.prisma.account.delete({ where: { id: account.id } });
      await h.close();
    }
  },
);
