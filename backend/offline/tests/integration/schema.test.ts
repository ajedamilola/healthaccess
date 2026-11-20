import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHarness, hasDatabase, uniqueSuffix } from './support.js';
import type { Projection } from '../../src/types.js';

test(
  'public schema access policy and projections through Prisma',
  { skip: !hasDatabase() },
  async (t) => {
    const harness = await createHarness();
    const { prisma, crypto, repository, prefix, phone, phoneDigest } = harness;
    const suffix = uniqueSuffix(prefix);
    const otherPhone = '+2348000000001';
    const otherPhoneDigest = crypto.digestPhone(otherPhone);
    const fields = {
      name: `name_${suffix}`,
      allergies: `allergies_${suffix}`,
      medications: `medications_${suffix}`,
      conditions: `conditions_${suffix}`,
    };
    const serviceGeneral = `gen_${suffix}`;
    const servicePediatrics = `ped_${suffix}`;
    const areaId = randomUUID();
    const closeFacility = randomUUID();
    const farFacility = randomUUID();
    const unverifiedFacility = randomUUID();
    const demoFacility = randomUUID();
    const patientAccount = randomUUID();
    const doctorAccount = randomUUID();
    const patientId = randomUUID();
    const linkId = randomUUID();
    const consentId = randomUUID();
    const grantBoth = randomUUID();
    const grantWeb = randomUUID();
    const publishedContent = randomUUID();
    const draftContent = randomUUID();
    let nearbyArea: string | null = null;
    let nearbyFacility: string | null = null;

    const patientCode = '999999999999';
    const patientDigest = crypto.digestCode(patientCode);
    const grantBothDigest = crypto.digestCode('11111111', 'grant');
    const grantWebDigest = crypto.digestCode('22222222', 'grant');
    assert.ok(patientDigest && grantBothDigest && grantWebDigest);

    const ussdBody = {
      sessionId: `${prefix}-schema`,
      phoneNumber: phone,
      serviceCode: '*test#',
      text: '',
    };
    type Scoped = Parameters<Parameters<typeof repository.withUssdSession>[2]>[1];
    const withScoped = async <T>(work: (scoped: Scoped) => Promise<T>): Promise<T> => {
      let result!: T;
      await repository.withUssdSession(ussdBody, randomUUID(), async (_session, scoped) => {
        result = await work(scoped);
        return 'CON ok';
      });
      return result;
    };
    const withOtherScoped = async <T>(work: (scoped: Scoped) => Promise<T>): Promise<T> => {
      let result!: T;
      await repository.withUssdSession(
        { ...ussdBody, sessionId: `${prefix}-schema-other`, phoneNumber: otherPhone },
        randomUUID(),
        async (_session, scoped) => {
          result = await work(scoped);
          return 'CON ok';
        },
      );
      return result;
    };

    t.after(async () => {
      try {
        const digestFilter = { in: [phoneDigest, otherPhoneDigest] };
        await prisma.outbox.deleteMany({
          where: { OR: [{ recipient_phone_digest: digestFilter }, { logical_key: { startsWith: prefix } }] },
        });
        await prisma.deliveryEvent.deleteMany({
          where: { provider_message_id: { startsWith: prefix } },
        });
        await prisma.smsInbox.deleteMany({ where: { phone_digest: digestFilter } });
        await prisma.smsConversation.deleteMany({ where: { phone_digest: digestFilter } });
        await prisma.channelPreference.deleteMany({ where: { phone_digest: digestFilter } });
        await prisma.rateLimit.deleteMany({
          where: {
            OR: [
              { scope: { contains: phoneDigest } },
              { scope: { contains: otherPhoneDigest } },
              { scope: { startsWith: prefix } },
            ],
          },
        });
        await prisma.recordReadSession.deleteMany({ where: { patient_id: patientId } });
        await prisma.ussdSession.deleteMany({
          where: {
            OR: [{ provider_session_id: { startsWith: prefix } }, { phone_digest: digestFilter }],
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
        await prisma.accountRole.deleteMany({
          where: { account_id: { in: [patientAccount, doctorAccount] } },
        });
        await prisma.reviewedHealthContent.deleteMany({
          where: { id: { in: [publishedContent, draftContent] } },
        });
        await prisma.account.deleteMany({ where: { id: { in: [patientAccount, doctorAccount] } } });
        if (nearbyFacility) {
          await prisma.facilityService.deleteMany({ where: { facility_id: nearbyFacility } });
          await prisma.facility.deleteMany({ where: { id: nearbyFacility } });
        }
        await prisma.facilityService.deleteMany({
          where: {
            facility_id: { in: [closeFacility, farFacility, unverifiedFacility, demoFacility] },
          },
        });
        await prisma.facility.deleteMany({
          where: { id: { in: [closeFacility, farFacility, unverifiedFacility, demoFacility] } },
        });
        await prisma.area.deleteMany({
          where: { id: { in: [areaId, ...(nearbyArea ? [nearbyArea] : [])] } },
        });
        await prisma.fieldDefinition.deleteMany({ where: { field_key: { in: Object.values(fields) } } });
        await prisma.service.deleteMany({
          where: { service_code: { in: [serviceGeneral, servicePediatrics] } },
        });
        await prisma.auditEvent.deleteMany({
          where: {
            OR: [
              { actor_ref: { in: [phoneDigest, otherPhoneDigest] } },
              { request_id: { startsWith: prefix } },
            ],
          },
        });
        await prisma.accessAttempt.deleteMany({
          where: { phone_digest: { in: [phoneDigest, otherPhoneDigest] } },
        });
      } finally {
        await harness.close();
      }
    });

    await prisma.fieldDefinition.createMany({
      data: [
        {
          field_key: fields.name,
          label: 'Name',
          value_schema: { type: 'string' },
          value_type: 'STRING',
          sort_order: 10,
        },
        {
          field_key: fields.allergies,
          label: 'Allergies',
          value_schema: { type: 'array' },
          value_type: 'STRING_ARRAY',
          emergency_eligible: true,
          sort_order: 20,
        },
        {
          field_key: fields.medications,
          label: 'Medications',
          value_schema: { type: 'array' },
          value_type: 'STRING_ARRAY',
          sort_order: 30,
        },
        {
          field_key: fields.conditions,
          label: 'Conditions',
          value_schema: { type: 'array' },
          value_type: 'STRING_ARRAY',
          sort_order: 40,
        },
      ],
    });
    await prisma.service.createMany({
      data: [
        { service_code: serviceGeneral, label: 'General care', description: 'Test', sort_order: 10 },
        {
          service_code: servicePediatrics,
          label: 'Child health',
          description: 'Test',
          sort_order: 20,
        },
      ],
    });
    await prisma.area.create({
      data: {
        id: areaId,
        country_code: 'NG',
        region: 'Lagos',
        city: 'Ikeja',
        name: `${suffix} Schema Area`,
        center_latitude: 6.6018,
        center_longitude: 3.3515,
        is_demo: true,
        active: true,
      },
    });
    await prisma.account.createMany({
      data: [
        {
          id: patientAccount,
          email: `${prefix}-patient@example.test`,
          password_hash: 'x',
          display_name: 'Patient One',
          status: 'ACTIVE',
        },
        {
          id: doctorAccount,
          email: `${prefix}-doctor@example.test`,
          password_hash: 'x',
          display_name: 'Dr Ada Example',
          status: 'ACTIVE',
        },
      ],
    });
    await prisma.accountRole.createMany({
      data: [
        { account_id: patientAccount, role: 'PATIENT' },
        { account_id: doctorAccount, role: 'PRACTITIONER' },
      ],
    });
    await prisma.patientProfile.create({
      data: { id: patientId, account_id: patientAccount, preferred_language: 'en' },
    });
    await prisma.patientCode.create({
      data: {
        patient_id: patientId,
        code_digest: patientDigest,
        code_ciphertext: 'sealed',
        key_version: 1,
      },
    });
    await prisma.patientFieldValue.createMany({
      data: [
        { patient_id: patientId, field_key: fields.name, value: 'Patient One' },
        { patient_id: patientId, field_key: fields.allergies, value: ['Penicillin'] },
        { patient_id: patientId, field_key: fields.medications, value: ['Amlodipine'] },
        { patient_id: patientId, field_key: fields.conditions, value: ['Hypertension'] },
      ],
    });
    await prisma.emergencyField.create({
      data: { patient_id: patientId, field_key: fields.allergies, display_order: 1 },
    });
    await prisma.channelLink.create({
      data: {
        id: linkId,
        patient_id: patientId,
        phone_envelope: 'sealed-phone',
        phone_digest: phoneDigest,
      },
    });
    await prisma.accessGrant.createMany({
      data: [
        {
          id: grantBoth,
          patient_id: patientId,
          code_digest: grantBothDigest,
          expires_at: new Date(Date.now() + 60 * 60 * 1000),
          created_by_account_id: patientAccount,
        },
        {
          id: grantWeb,
          patient_id: patientId,
          code_digest: grantWebDigest,
          expires_at: new Date(Date.now() + 60 * 60 * 1000),
          created_by_account_id: patientAccount,
        },
      ],
    });
    await prisma.accessGrantField.createMany({
      data: [
        { grant_id: grantBoth, field_key: fields.allergies },
        { grant_id: grantBoth, field_key: fields.medications },
        { grant_id: grantWeb, field_key: fields.allergies },
      ],
    });
    await prisma.accessGrantChannel.createMany({
      data: [
        { grant_id: grantBoth, channel: 'USSD' },
        { grant_id: grantBoth, channel: 'WEB_PRACTITIONER' },
        { grant_id: grantWeb, channel: 'WEB_PRACTITIONER' },
      ],
    });
    await prisma.profileUseConsent.create({
      data: {
        id: consentId,
        patient_id: patientId,
        channel: 'SMS',
        phone_link_id: linkId,
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await prisma.consentField.create({
      data: { consent_id: consentId, field_key: fields.allergies },
    });
    await prisma.facility.createMany({
      data: [
        {
          id: closeFacility,
          name: 'Close General Clinic',
          address: '1 Close Road, Ikeja',
          area_id: areaId,
          latitude: 6.602,
          longitude: 3.352,
          status: 'APPROVED',
          is_demo: false,
        },
        {
          id: farFacility,
          name: 'Far Child Hospital',
          address: '2 Far Road, Ikeja',
          area_id: areaId,
          latitude: 6.7,
          longitude: 3.5,
          status: 'APPROVED',
          is_demo: false,
        },
        {
          id: unverifiedFacility,
          name: 'Unverified Child Clinic',
          address: '3 Hidden Road, Ikeja',
          area_id: areaId,
          latitude: 6.6019,
          longitude: 3.3519,
          status: 'APPROVED',
          is_demo: false,
        },
        {
          id: demoFacility,
          name: 'Demo General Hospital',
          address: '4 Demo Road, Ikeja',
          area_id: areaId,
          latitude: 6.602,
          longitude: 3.352,
          status: 'APPROVED',
          is_demo: true,
        },
      ],
    });
    await prisma.facilityService.createMany({
      data: [
        {
          facility_id: closeFacility,
          service_code: serviceGeneral,
          verification_status: 'APPROVED',
          verified_at: new Date(),
        },
        {
          facility_id: farFacility,
          service_code: servicePediatrics,
          verification_status: 'APPROVED',
          verified_at: new Date(),
        },
        {
          facility_id: unverifiedFacility,
          service_code: servicePediatrics,
          verification_status: 'UNVERIFIED',
        },
        {
          facility_id: demoFacility,
          service_code: serviceGeneral,
          verification_status: 'APPROVED',
          verified_at: new Date(),
        },
      ],
    });
    await prisma.reviewedHealthContent.createMany({
      data: [
        {
          id: publishedContent,
          topic_code: `zzfever${suffix}`,
          language: 'en',
          version: 1,
          title: `Fever ${suffix}`,
          body: 'Fever information reviewed for the demonstration.',
          status: 'PUBLISHED',
          reviewer_account_id: doctorAccount,
          reviewed_at: new Date(),
          published_at: new Date(),
        },
        {
          id: draftContent,
          topic_code: `zzfever${suffix}`,
          language: 'en',
          version: 2,
          title: `Fever draft ${suffix}`,
          body: 'Fever draft that must never be returned.',
          status: 'DRAFT',
        },
      ],
    });

    await t.test(
      'public schema accepts queue writes and enforces read-session and phone-link invariants',
      async () => {
        await prisma.smsInbox.create({
          data: {
            provider_message_id: `${prefix}-schema-inbox`,
            phone_digest: phoneDigest,
            body_envelope: 'sealed',
            status: 'PROCESSED',
            expires_at: new Date(Date.now() + 60 * 60 * 1000),
          },
        });
        await prisma.outbox.create({
          data: {
            logical_key: `${prefix}-schema-outbox`,
            kind: 'WEB_LEAD',
            recipient_phone_envelope: 'sealed-phone',
            recipient_phone_digest: phoneDigest,
            render_ref: {},
            status: 'DELIVERED',
            expires_at: new Date(Date.now() + 60 * 60 * 1000),
          },
        });
        await prisma.rateLimit.create({
          data: { scope: `${prefix}-schema`, window_start: new Date(), hits: 1 },
        });
        await prisma.channelPreference.upsert({
          where: { phone_digest: phoneDigest },
          create: { phone_digest: phoneDigest, opted_out: true },
          update: { opted_out: true },
        });
        await assert.rejects(
          prisma.recordReadSession.create({
            data: {
              patient_id: patientId,
              purpose: 'EMERGENCY',
              channel: 'USSD',
              phone_digest: phoneDigest,
              code_version: 1,
              expires_at: new Date(Date.now() + 60 * 1000),
            },
          }),
          /constraint|violat/i,
        );
        await assert.rejects(
          prisma.channelLink.create({
            data: {
              patient_id: patientId,
              phone_envelope: 'sealed-phone-2',
              phone_digest: phoneDigest,
            },
          }),
          /unique|constraint|violat/i,
        );
      },
    );

    await t.test(
      'USSD grant reads are field scoped, session and phone bound, and rechecked',
      async () => {
        const open = await withScoped((scoped) => scoped.openGrant(patientDigest, grantBothDigest));
        assert.equal(open.available, true);
        assert.deepEqual(
          open.fields?.map((field) => field.key),
          [fields.allergies, fields.medications],
        );
        assert.ok(open.read_session_id);

        const replay = await withScoped((scoped) => scoped.readGrant(open.read_session_id!));
        assert.equal(replay.available, true);
        assert.deepEqual(
          replay.fields?.map((field) => field.key),
          [fields.allergies, fields.medications],
        );

        const crossPhone = await withOtherScoped((scoped) => scoped.readGrant(open.read_session_id!));
        assert.equal(crossPhone.available, false);

        const wrongChannel = await withScoped((scoped) =>
          scoped.openGrant(patientDigest, grantWebDigest),
        );
        assert.equal(wrongChannel.available, false);

        const session = await prisma.ussdSession.findUnique({
          where: {
            provider_provider_session_id: {
              provider: 'africastalking',
              provider_session_id: ussdBody.sessionId,
            },
          },
        });
        assert.ok(session);
        await prisma.ussdSession.update({
          where: { id: session.id },
          data: { expires_at: new Date(Date.now() - 1000) },
        });
        const expired = await withScoped((scoped) => scoped.readGrant(open.read_session_id!));
        assert.equal(expired.available, false);
        await prisma.ussdSession.update({
          where: { id: session.id },
          data: { expires_at: new Date(Date.now() + 30 * 60 * 1000) },
        });

        await prisma.accessGrant.update({
          where: { id: grantBoth },
          data: { revoked_at: new Date() },
        });
        const revoked = await withScoped((scoped) => scoped.readGrant(open.read_session_id!));
        assert.equal(revoked.available, false);
        await prisma.accessGrant.update({ where: { id: grantBoth }, data: { revoked_at: null } });
      },
    );

    await t.test('USSD grant open rejects a web-only grant', async () => {
      const wrongChannel = await withScoped((scoped) =>
        scoped.openGrant(patientDigest, grantWebDigest),
      );
      assert.equal(wrongChannel.available, false);
      const reads = await prisma.recordReadSession.count({ where: { grant_id: grantWeb } });
      assert.equal(reads, 0);
    });

    await t.test('profile consent lookup and context are phone bound and field scoped', async () => {
      const found = await withScoped((scoped) => scoped.findProfileConsent());
      assert.equal(found?.id, consentId);
      const context = (await withScoped((scoped) =>
        scoped.readMatchingContext(consentId),
      )) as Projection | null;
      assert.equal(context?.available, true);
      assert.deepEqual(
        context?.fields?.map((field) => field.key),
        [fields.allergies],
      );

      const other = await withOtherScoped(async (scoped) => ({
        consent: await scoped.findProfileConsent(),
        context: await scoped.readMatchingContext(consentId),
      }));
      assert.equal(other.consent, null);
      assert.equal(other.context?.available, false);

      await prisma.profileUseConsent.update({
        where: { id: consentId },
        data: { revoked_at: new Date() },
      });
      const revoked = await withScoped((scoped) => scoped.readMatchingContext(consentId));
      assert.equal(revoked?.available, false);
    });

    await t.test(
      'directory filters by approved service and demo flag before distance and reviewed content is published-only',
      async () => {
        const services = await withScoped((scoped) => scoped.listServices());
        assert.ok(services.some((service) => service.service_code === serviceGeneral));
        assert.ok(services.some((service) => service.service_code === servicePediatrics));

        const areas = await withScoped((scoped) => scoped.findAreas(suffix));
        assert.ok(areas.some((area) => area.id === areaId));

        const pediatric = await withScoped((scoped) =>
          scoped.findFacilities(servicePediatrics, areaId, 50),
        );
        assert.deepEqual(
          pediatric.map((facility) => facility.id),
          [farFacility],
        );
        assert.equal(pediatric[0]?.distance_km !== null, true);

        const general = await withScoped((scoped) =>
          scoped.findFacilities(serviceGeneral, areaId, 50),
        );
        assert.deepEqual(
          general.map((facility) => facility.id),
          [closeFacility],
        );
        assert.ok(!general.some((facility) => facility.id === demoFacility));

        const found = await withScoped((scoped) =>
          scoped.getFacility(closeFacility, serviceGeneral, areaId, 50),
        );
        assert.equal(found?.id, closeFacility);
        const wrongService = await withScoped((scoped) =>
          scoped.getFacility(closeFacility, servicePediatrics, areaId, 50),
        );
        assert.equal(wrongService, null);

        const reviewed = await repository.findReviewedContent(`zzfever${suffix}`);
        assert.equal(reviewed.length, 1);
        const content = reviewed[0] as { id: string; reviewer: string };
        assert.equal(content.id, publishedContent);
        assert.equal(content.reviewer, 'Dr Ada Example');
      },
    );

    await t.test('referral recording is idempotent for a repeated request id', async () => {
      const requestId = `${prefix}-referral`;
      const record = () =>
        repository.withUssdSession(ussdBody, requestId, async (_session, scoped) => {
          await scoped.recordReferral!({
            serviceCode: serviceGeneral,
            areaId,
            facilities: [
              {
                id: closeFacility,
                name: 'Close General Clinic',
                address: '1 Close Road, Ikeja',
                phone: null,
                distance_km: null,
              },
            ],
            consentId: null,
          });
          return 'CON recorded';
        });
      await record();
      const first = await prisma.referralRequest.findMany({
        where: { request_id: requestId },
        include: { results: true },
      });
      assert.equal(first.length, 1);
      assert.equal(first[0].results.length, 1);
      await record();
      const second = await prisma.referralRequest.findMany({
        where: { request_id: requestId },
      });
      assert.equal(second.length, 1);
      assert.equal(second[0].id, first[0].id);
    });

    await t.test(
      'radius search crosses area boundaries',
      async () => {
        nearbyArea = randomUUID();
        nearbyFacility = randomUUID();
        try {
          await prisma.area.create({
            data: {
              id: nearbyArea,
              country_code: 'NG',
              region: 'Lagos',
              city: 'Neighbouring area',
              name: `${suffix} Nearby Area`,
              center_latitude: 6.602,
              center_longitude: 3.352,
              is_demo: true,
              active: true,
            },
          });
          await prisma.facility.create({
            data: {
              id: nearbyFacility,
              name: 'Cross-area test hospital',
              address: 'Fictional address',
              area_id: nearbyArea,
              latitude: 6.602,
              longitude: 3.352,
              status: 'APPROVED',
              is_demo: false,
            },
          });
          await prisma.facilityService.create({
            data: {
              facility_id: nearbyFacility,
              service_code: servicePediatrics,
              verification_status: 'APPROVED',
              verified_at: new Date(),
            },
          });
          const result = await withScoped((scoped) =>
            scoped.findFacilities(servicePediatrics, areaId, 25),
          );
          const nearby = result.find((facility) => facility.id === nearbyFacility);
          assert.ok(nearby);
          assert.equal(nearby?.is_demo, false);
          assert.ok(Number(nearby?.distance_km) < 1);
          assert.ok(result.some((facility) => facility.id === farFacility));
        } finally {
          await prisma.facilityService.deleteMany({ where: { facility_id: nearbyFacility } });
          await prisma.facility.deleteMany({ where: { id: nearbyFacility } });
          await prisma.area.deleteMany({ where: { id: nearbyArea } });
          nearbyArea = null;
          nearbyFacility = null;
        }
      },
    );
  },
);
