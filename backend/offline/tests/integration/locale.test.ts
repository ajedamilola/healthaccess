import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, hasDatabase, uniqueSuffix } from './support.js';

test('phone language: explicit choice wins, else the verified patient profile, else English', { skip: !hasDatabase() }, async () => {
  const h = await createHarness();
  const suffix = uniqueSuffix(h.prefix);
  const actor = { phone_digest: h.phoneDigest, request_id: `req-${suffix}` };
  const account = await h.prisma.account.create({
    data: {
      email: `locale-${suffix}@example.test`,
      password_hash: 'x',
      display_name: 'L',
      phone_digest: h.phoneDigest,
      phone_verified_at: new Date(),
      patient_profile: { create: { preferred_language: 'yo' } },
    },
  });
  try {
    assert.equal(await h.repository.getLocale(actor), 'yo');
    await h.repository.setLocale(actor, 'en');
    const stored = await h.prisma.channelPreference.findUniqueOrThrow({ where: { phone_digest: h.phoneDigest } });
    assert.equal(stored.locale, 'en-NG');
    assert.equal(await h.repository.getLocale(actor), 'en');
    await h.repository.setLocale(actor, 'ig');
    assert.equal(await h.repository.getLocale(actor), 'ig');
    assert.equal(await h.repository.getLocale({ ...actor, phone_digest: h.crypto.digestPhone('+2348099999999') }), 'en');
  } finally {
    await h.prisma.channelPreference.deleteMany({ where: { phone_digest: h.phoneDigest } });
    await h.prisma.account.delete({ where: { id: account.id } });
    await h.close();
  }
});
