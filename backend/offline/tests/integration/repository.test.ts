import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHarness, hasDatabase, uniqueSuffix } from './support.js';
import { createSmsEngine } from '../../src/channels/sms.js';
import { createUssdEngine } from '../../src/channels/ussd.js';
import { createUssdHandler } from '../../src/channels/ussd-handler.js';

test(
  'PostgreSQL inbox/outbox durability and delivery reconciliation through Prisma',
  { skip: !hasDatabase() },
  async (t) => {
    const harness = await createHarness();
    const { prisma, config, crypto, repository, prefix, phone, phoneDigest } = harness;
    const suffix = uniqueSuffix(prefix);
    const workerId = randomUUID();
    const serviceCode = `svc_${suffix}`;
    const allergyKey = `allergy_${suffix}`;
    const medicationKey = `medication_${suffix}`;
    const areaId = randomUUID();
    const patientAccount = randomUUID();
    const patientId = randomUUID();
    const patientCode = '121212121212';
    const providerMessageId = `AT-test-${prefix}`;
    let facilityId: string | null = null;

    t.after(async () => {
      try {
        await prisma.outbox.deleteMany({
          where: {
            OR: [
              { recipient_phone_digest: phoneDigest },
              ...(facilityId
                ? [{ logical_key: { contains: `:facility:${facilityId}` } }]
                : []),
            ],
          },
        });
        await prisma.deliveryEvent.deleteMany({
          where: { provider_message_id: { startsWith: `AT-test-${suffix}` } },
        });
        await prisma.smsInbox.deleteMany({ where: { phone_digest: phoneDigest } });
        await prisma.smsConversation.deleteMany({ where: { phone_digest: phoneDigest } });
        await prisma.channelPreference.deleteMany({ where: { phone_digest: phoneDigest } });
        await prisma.rateLimit.deleteMany({
          where: { scope: { contains: phoneDigest } },
        });
        await prisma.recordReadSession.deleteMany({ where: { patient_id: patientId } });
        await prisma.ussdSession.deleteMany({
          where: {
            OR: [{ provider_session_id: { startsWith: prefix } }, { phone_digest: phoneDigest }],
          },
        });
        await prisma.referralRequest.deleteMany({
          where: { OR: [{ patient_id: patientId }, { request_id: { startsWith: prefix } }] },
        });
        await prisma.channelLink.deleteMany({ where: { patient_id: patientId } });
        await prisma.accessGrant.deleteMany({ where: { patient_id: patientId } });
        await prisma.emergencyField.deleteMany({ where: { patient_id: patientId } });
        await prisma.patientFieldValue.deleteMany({ where: { patient_id: patientId } });
        await prisma.patientCode.deleteMany({ where: { patient_id: patientId } });
        await prisma.patientProfile.deleteMany({ where: { id: patientId } });
        await prisma.accountRole.deleteMany({ where: { account_id: patientAccount } });
        await prisma.account.deleteMany({ where: { id: patientAccount } });
        if (facilityId) {
          await prisma.facilityService.deleteMany({ where: { facility_id: facilityId } });
          await prisma.facility.deleteMany({ where: { id: facilityId } });
        }
        await prisma.facilityService.deleteMany({ where: { service_code: serviceCode } });
        await prisma.area.deleteMany({ where: { id: areaId } });
        await prisma.fieldDefinition.deleteMany({
          where: { field_key: { in: [allergyKey, medicationKey] } },
        });
        await prisma.service.deleteMany({ where: { service_code: serviceCode } });
        await prisma.auditEvent.deleteMany({ where: { actor_ref: phoneDigest } });
        await prisma.accessAttempt.deleteMany({ where: { phone_digest: phoneDigest } });
      } finally {
        await harness.close();
      }
    });

    await prisma.fieldDefinition.createMany({
      data: [
        {
          field_key: allergyKey,
          label: 'Allergies',
          value_schema: { type: 'array' },
          value_type: 'STRING_ARRAY',
          emergency_eligible: true,
          sort_order: 10,
        },
        {
          field_key: medicationKey,
          label: 'Medications',
          value_schema: { type: 'array' },
          value_type: 'STRING_ARRAY',
          emergency_eligible: false,
          sort_order: 20,
        },
      ],
    });
    await prisma.service.create({
      data: {
        service_code: serviceCode,
        label: 'Test general care',
        description: 'Test service',
        sort_order: 1,
        active: true,
      },
    });
    await prisma.area.create({
      data: {
        id: areaId,
        country_code: 'NG',
        region: 'Test region',
        city: 'Test city',
        name: `Queue Test Area ${suffix}`,
        center_latitude: 10,
        center_longitude: 7,
        is_demo: true,
        active: true,
      },
    });
    await prisma.account.create({
      data: {
        id: patientAccount,
        email: `${prefix}@example.test`,
        password_hash: 'disabled-test-password',
        display_name: 'Test patient',
        status: 'ACTIVE',
      },
    });
    await prisma.accountRole.create({
      data: { account_id: patientAccount, role: 'PATIENT' },
    });
    await prisma.patientProfile.create({
      data: { id: patientId, account_id: patientAccount, preferred_language: 'en' },
    });
    const patientDigest = crypto.digestCode(patientCode);
    assert.ok(patientDigest);
    await prisma.patientCode.create({
      data: {
        patient_id: patientId,
        code_digest: patientDigest,
        code_ciphertext: 'test-only-ciphertext',
        key_version: 1,
      },
    });
    await prisma.patientFieldValue.createMany({
      data: [
        { patient_id: patientId, field_key: allergyKey, value: ['Test allergy'] },
        { patient_id: patientId, field_key: medicationKey, value: ['Private test medicine'] },
      ],
    });
    await prisma.emergencyField.create({
      data: { patient_id: patientId, field_key: allergyKey, display_order: 1 },
    });

    async function processMessage(text: string) {
      const body = { id: `in-${prefix}-${randomUUID()}`, from: phone, to: 'test-number', text };
      await repository.acceptSms(body, randomUUID());
      const job = await repository.claimInbox(workerId);
      assert.ok(job);
      await repository.processInbox(job, async (message, scoped, conversation) => {
        const engine = createSmsEngine({
          repository: scoped,
          crypto,
          config,
          assistant: {
            classify: async () => ({
              intent: 'unsupported',
              service_code: null,
              location_query: null,
              question: null,
            }),
            answer: async () => ({ text: 'Not used.' }),
          },
        });
        return engine.process(message.text, conversation);
      });
    }

    await t.test('Prisma reaches the public schema with the runtime login', async () => {
      await repository.ready();
      const tables = await prisma.$queryRaw<Array<{ name: string }>>`
        SELECT tablename AS name FROM pg_tables
        WHERE schemaname = 'public' AND tablename IN ('outbox', 'sms_inbox', 'ussd_sessions')
        ORDER BY tablename`;
      assert.deepEqual(
        tables.map((table) => table.name),
        ['outbox', 'sms_inbox', 'ussd_sessions'],
      );
    });

    await t.test('duplicate callback creates one encrypted inbox job', async () => {
      const body = { id: `in-${prefix}`, from: phone, to: 'test-number', text: 'HELP' };
      await repository.acceptSms(body, randomUUID());
      await repository.acceptSms(body, randomUUID());
      const saved = await prisma.smsInbox.findMany({
        where: { provider_message_id: body.id },
        select: { id: true, body_envelope: true, status: true },
      });
      assert.equal(saved.length, 1);
      assert.equal(saved[0].status, 'QUEUED');
      assert.ok(!saved[0].body_envelope.includes(phone));
    });

    await t.test('only one worker claims the inbox; one atomic response is queued', async () => {
      const job = await repository.claimInbox(workerId);
      assert.ok(job);
      assert.equal(await repository.claimInbox(randomUUID()), null);
      await repository.processInbox(job, async (body, scoped, conversation) => {
        const engine = createSmsEngine({
          repository: scoped,
          crypto,
          config,
          assistant: {
            classify: async () => ({
              intent: 'unsupported',
              service_code: null,
              location_query: null,
              question: null,
            }),
            answer: async () => ({ text: 'Not used.' }),
          },
        });
        return engine.process(body.text, conversation);
      });
      const saved = await prisma.smsInbox.findUnique({ where: { id: job.id } });
      assert.equal(saved?.status, 'PROCESSED');
      const outgoing = await prisma.outbox.findMany({
        where: { logical_key: `sms:${job.id}:0` },
      });
      assert.equal(outgoing.length, 1);
      assert.ok(!JSON.stringify(outgoing[0]).includes(phone));
    });

    await t.test('a delivery report arriving before send persistence is reconciled', async () => {
      const job = await repository.claimOutbox(workerId);
      assert.ok(job);
      assert.equal(await repository.claimOutbox(randomUUID()), null);
      const rendered = await repository.renderOutbox(job);
      assert.equal(rendered.phone, phone);
      assert.equal(rendered.reply.kind, 'text');
      await repository.acceptDelivery({ id: providerMessageId, status: 'Success' });
      await repository.acceptDelivery({ id: providerMessageId, status: 'Success' });
      await repository.finishOutbox(job, {
        state: 'accepted',
        providerMessageId,
        retryable: false,
      });
      const saved = await prisma.outbox.findUnique({ where: { id: job.id } });
      assert.equal(saved?.status, 'DELIVERED');
      const events = await prisma.deliveryEvent.findMany({
        where: { provider_message_id: providerMessageId },
      });
      assert.equal(events.length, 1);
      await repository.acceptDelivery({ id: providerMessageId, status: 'Failed' });
      const monotonic = await prisma.outbox.findUnique({ where: { id: job.id } });
      assert.equal(monotonic?.status, 'DELIVERED');
    });

    await t.test('an expired sending lease becomes unknown, never a resend', async () => {
      const key = `sms:${(await prisma.smsInbox.findFirst({
        where: { provider_message_id: `in-${prefix}`, status: 'PROCESSED' },
      }))!.id}:0`;
      await prisma.outbox.update({
        where: { logical_key: key },
        data: { status: 'SENDING', provider_message_id: null, lease_until: new Date(Date.now() - 1000) },
      });
      await repository.maintain();
      const result = await prisma.outbox.findUnique({ where: { logical_key: key } });
      assert.equal(result?.status, 'UNKNOWN');
      assert.equal(await repository.claimOutbox(workerId), null);
    });

    await t.test(
      'queued summaries reauthorize at dispatch and never cache private fields',
      async () => {
        await processMessage(`LOOKUP ${patientCode}`);
        const job = await repository.claimOutbox(workerId);
        assert.ok(job);
        assert.equal(job.kind, 'emergency');
        assert.ok(!JSON.stringify(job).includes('Test allergy'));
        const before = await repository.renderOutbox(job);
        assert.deepEqual(
          before.projection?.fields?.map((field) => field.key),
          [allergyKey],
        );
        assert.ok(!JSON.stringify(before.projection).includes('Private test medicine'));
        await prisma.emergencyField.deleteMany({ where: { patient_id: patientId } });
        const after = await repository.renderOutbox(job);
        assert.equal(after.projection?.available, false);
        await repository.finishOutbox(job, {
          state: 'failed',
          providerMessageId: null,
          retryable: false,
        });
        await prisma.emergencyField.create({
          data: { patient_id: patientId, field_key: allergyKey, display_order: 1 },
        });
      },
    );

    await t.test('STOP expires pending replies and permits only its confirmation', async () => {
      await processMessage('HELP');
      const pending = await prisma.outbox.findMany({
        where: { status: 'QUEUED', recipient_phone_digest: phoneDigest },
      });
      assert.equal(pending.length, 1);
      await processMessage('STOP');
      const previous = await prisma.outbox.findUnique({ where: { id: pending[0].id } });
      assert.equal(previous?.status, 'EXPIRED');
      const confirmation = await repository.claimOutbox(workerId);
      assert.ok(confirmation);
      const rendered = await repository.renderOutbox(confirmation);
      assert.equal(rendered.suppressed, undefined);
      assert.equal(rendered.reply.kind === 'text' && rendered.reply.allowAfterStop, true);
      const old = await repository.renderOutbox({
        ...pending[0],
        kind: 'text',
        render_ref: pending[0].render_ref as { envelope: string; allowAfterStop?: boolean },
        attempts: pending[0].attempts,
        claimed_by: pending[0].claimed_by ?? '',
      });
      assert.equal(old.suppressed, true);
      await repository.finishOutbox(confirmation, {
        state: 'accepted',
        providerMessageId: `mock_${randomUUID()}`,
        retryable: false,
      });
    });

    await t.test(
      'real USSD persistence enforces cumulative paths, replay authorization and phone binding',
      async () => {
        const handler = createUssdHandler({
          repository,
          crypto,
          config,
          createEngine: createUssdEngine,
        });
        const body = {
          sessionId: `${prefix}-record`,
          phoneNumber: phone,
          serviceCode: '*test#',
          text: '',
        };
        assert.match(await handler(body, randomUUID()), /^CON HealthAccess/);
        const careBody = { ...body, sessionId: `${prefix}-record-care` };
        assert.match(await handler(careBody, randomUUID()), /^CON HealthAccess/);
        assert.match(await handler({ ...careBody, text: '1' }, randomUUID()), /^CON Choose service/);
        assert.match(await handler({ ...careBody, text: '1*1' }, randomUUID()), /^CON Enter area/);
        assert.match(await handler({ ...body, text: '2' }, randomUUID()), /Enter the access code/);
        const request = { ...body, text: `2*${patientCode}` };
        assert.match(await handler(request, randomUUID()), /Test allergy/);
        assert.match(
          await handler({ ...request, phoneNumber: '+2348000000001' }, randomUUID()),
          /^END Session/,
        );
        await prisma.emergencyField.deleteMany({ where: { patient_id: patientId } });
        const revoked = await handler(request, randomUUID());
        assert.match(revoked, /^END/);
        assert.ok(!revoked.includes('Test allergy'));
        await repository.endUssdSession({ sessionId: body.sessionId });
        assert.match(await handler(request, randomUUID()), /^END Session/);
        const saved = await prisma.ussdSession.findUnique({
          where: {
            provider_provider_session_id: {
              provider: 'africastalking',
              provider_session_id: body.sessionId,
            },
          },
        });
        assert.ok(!JSON.stringify(saved?.context).includes(patientCode));
        await prisma.emergencyField.create({
          data: { patient_id: patientId, field_key: allergyKey, display_order: 1 },
        });
      },
    );

    await t.test('USSD no-match state is persistable and can widen its radius', async () => {
      const handler = createUssdHandler({
        repository,
        crypto,
        config,
        createEngine: createUssdEngine,
      });
      const body = {
        sessionId: `${prefix}-care`,
        phoneNumber: phone,
        serviceCode: '*test#',
        text: '',
      };
      await handler(body, randomUUID());
      await handler({ ...body, text: '1' }, randomUUID());
      await handler({ ...body, text: '1*1' }, randomUUID());
      const request = { ...body, text: `1*1*Queue Test Area ${suffix}` };
      const noMatch = await handler(request, randomUUID());
      assert.match(noMatch, /^CON No suitable hospital/);
      const saved = await prisma.ussdSession.findUnique({
        where: {
          provider_provider_session_id: {
            provider: 'africastalking',
            provider_session_id: body.sessionId,
          },
        },
      });
      assert.equal(saved?.state, 'CARE_NO_MATCH');
      assert.match(await handler({ ...body, text: `${request.text}*1` }, randomUUID()), /^CON/);
    });

    await t.test(
      'USSD facility SMS retry can create a new job after a terminal failure',
      async () => {
        facilityId = randomUUID();
        await prisma.facility.create({
          data: {
            id: facilityId,
            name: 'Retry test clinic',
            address: 'Fictional address',
            area_id: areaId,
            latitude: 10,
            longitude: 7,
            status: 'APPROVED',
            is_demo: false,
          },
        });
        await prisma.facilityService.create({
          data: {
            facility_id: facilityId,
            service_code: serviceCode,
            verification_status: 'APPROVED',
            verified_at: new Date(),
          },
        });
        const handler = createUssdHandler({
          repository,
          crypto,
          config,
          createEngine: createUssdEngine,
        });
        const body = {
          sessionId: `${prefix}-retry`,
          phoneNumber: phone,
          serviceCode: '*test#',
          text: '',
        };
        await handler(body, randomUUID());
        await handler({ ...body, text: '1' }, randomUUID());
        await handler({ ...body, text: '1*1' }, randomUUID());
        const result = await handler(
          { ...body, text: `1*1*Queue Test Area ${suffix}` },
          randomUUID(),
        );
        assert.match(result, /^CON Retry test clinic/);

        const queue = () =>
          repository.withUssdSession(body, randomUUID(), async (_session, scoped) => {
            assert.equal(await scoped.queueFacilitySms(facilityId!), true);
            return 'CON queued';
          });
        await queue();
        await prisma.outbox.updateMany({
          where: { logical_key: { contains: `:facility:${facilityId}` } },
          data: { status: 'FAILED' },
        });
        await queue();
        const jobs = await prisma.outbox.findMany({
          where: { logical_key: { contains: `:facility:${facilityId}` } },
          orderBy: { created_at: 'asc' },
        });
        assert.equal(jobs.length, 2);
        assert.ok(jobs.some((row) => row.logical_key.endsWith(':retry:1')));
      },
    );

    await t.test('SMS conversation memory is encrypted at rest and restored next turn', async () => {
      await processMessage('Hello');
      await processMessage('my head hurts a lot today');
      const stored = await prisma.smsConversation.findUniqueOrThrow({
        where: { phone_digest: crypto.digestPhone(phone) },
      });
      const raw = JSON.stringify(stored.context);
      assert.doesNotMatch(raw, /head hurts/);
      assert.doesNotMatch(raw, /"history"/);
      assert.match(raw, /historyEnvelope/);
      const history = crypto.decrypt<Array<{ role: string; text: string }>>(
        (stored.context as { historyEnvelope: string }).historyEnvelope,
        'sms-history',
      );
      assert.deepEqual(
        history.filter((turn) => turn.role === 'user').map((turn) => turn.text),
        ['Hello', 'my head hurts a lot today'],
      );
      await processMessage('CANCEL');
    });

    await t.test(
      'USSD Exit revokes the protected read session and cannot replay clinical data',
      async () => {
        await prisma.patientFieldValue.update({
          where: { patient_id_field_key: { patient_id: patientId, field_key: allergyKey } },
          data: {
            value: Array.from({ length: 20 }, (_, index) => `Test-only allergy item ${index}`),
          },
        });
        const handler = createUssdHandler({
          repository,
          crypto,
          config,
          createEngine: createUssdEngine,
        });
        const body = {
          sessionId: `${prefix}-back`,
          phoneNumber: phone,
          serviceCode: '*test#',
          text: '',
        };
        await handler(body, randomUUID());
        await handler({ ...body, text: '2' }, randomUUID());
        const codePath = `2*${patientCode}`;
        assert.match(await handler({ ...body, text: codePath }, randomUUID()), /^CON/);
        const exit = { ...body, text: `${codePath}*0` };
        assert.equal(await handler(exit, randomUUID()), 'END Closed.');
        assert.equal(await handler(exit, randomUUID()), 'END Closed.');
        const next = await handler({ ...body, text: `${codePath}*0*1` }, randomUUID());
        assert.match(next, /^END Session/);
        const saved = await prisma.ussdSession.findUnique({
          where: {
            provider_provider_session_id: {
              provider: 'africastalking',
              provider_session_id: body.sessionId,
            },
          },
        });
        assert.equal(saved?.ended_at, null);
        assert.equal(saved?.read_session_id, null);
      },
    );
  },
);
