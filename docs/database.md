# Database contract

Last updated: 17 November 2026

## Source of truth

`backend/online/prisma/schema.prisma` is the only schema definition. Prisma owns
the PostgreSQL 16 `public` schema. There is one database for both the online and
offline services; there are no `healthaccess`, `directory`, `content` or
`telecom` namespaces and no database routines.

`backend/database_structure.sql` and its `healthaccess_api.*` routines are retired
legacy artifacts. Do not apply that file to a Prisma-managed database and do not
add tables or functions to it.

`backend/online/scripts/grant-runtime.sql` is an optional operations helper, not
a schema definition. It grants table/sequence DML in `public` to the
`healthaccess_offline`, `healthaccess_online` and `healthaccess_web` logins if those roles exist, so
dedicated runtime logins can connect. It never creates roles or passwords.
Prisma remains the only object owner for schema changes.

## Runtime access

There is no database-role-derived channel and no security-definer routine layer.
The caller's channel is an application concern; controllers pass it explicitly
from the authenticated route. Use a least-privilege runtime login that owns no
schema objects.

`backend/online/scripts/grant-runtime.sql` grants `SELECT, INSERT, UPDATE,
DELETE` on `public` tables (and sequence usage) to `healthaccess_offline`,
`healthaccess_online` and `healthaccess_web` when those roles exist. Outside the compose stack, the
offline runtime can use a `healthaccess_offline` login with public CRUD; the
included compose uses the `healthaccess` owner account. `ready()` is a
connectivity probe, not a role-membership assertion. The LangGraph checkpointer schema
`ai_agent_state` is outside Prisma and needs its own grants as described in
[operations.md](operations.md).

The migration history currently contains:

```text
backend/online/prisma/migrations/
  20261117153100_init/migration.sql             48 tables and enum types
  20261117153757_invariants/migration.sql       CHECK constraints, partial indexes and retention defaults
  20261117230000_emergency_requests/migration.sql emergency request history and enums
  migration_lock.toml
```

## Commands

Run these from the repository root unless noted.

```sh
npm run db:generate                 # prisma generate
npm run db:migrate                  # prisma migrate dev (development)
npm run db:seed                     # reference data + sandbox patient

cd backend/online
npx prisma migrate deploy           # production-style migration
npx prisma studio                   # inspect data
```

`db:migrate` is `prisma migrate dev`; it creates a migration and applies it. Use
`npm run db:deploy --workspace @healthaccess/online` or `prisma migrate deploy`
in CI or production. Never edit an applied migration by hand. `DATABASE_URL` must
be set in `backend/online/.env` (or the process environment). `npm run db:seed`
runs `prisma/seed.ts` with `tsx`.

## Table groups

The migrations create 49 tables. All timestamps are `timestamptz(6)`.
Ids are database-generated UUIDs (`gen_random_uuid()`) unless noted. Monetary and
measurement values use `Decimal`.

### Identity and sessions

`accounts`, `account_roles`, `auth_sessions`, `auth_challenges`

- `accounts.email` is unique; `password_hash` is a bcrypt hash.
- `accounts.status` is `ACTIVE`, `SUSPENDED` or `PENDING`. `requireAuth` only
  accepts an active account.
- `accounts.idp_subject` is a unique external subject for Google OAuth.
- `accounts.phone_digest` and `phone_verified_at` hold the phone binding; the
  plaintext phone is not on the account row.
- `account_roles` is a composite-key join table (`account_id`, `role`).
- `auth_sessions` stores `refresh_token_hash` (SHA-256, unique), expiry,
  revocation, `recent_auth_at`, `last_seen_at` and optional user-agent/IP hash.
  Refresh tokens rotate on use.
- `auth_challenges` stores `purpose` (`PASSWORD_RESET`, `PHONE_VERIFICATION`,
  `PATIENT_CODE_ROTATE`), a token digest, an encrypted delivery target, an
  optional `phone_digest`, attempts, expiry and consumption time.

### Patient profiles and field projections

`field_definitions`, `patient_profiles`, `practitioner_profiles`,
`patient_field_values`, `emergency_fields`, `patient_codes`

- `field_definitions` is the field catalog: `field_key`, label, JSON
  `value_schema`, `value_type`, `emergency_eligible`, sort order and active flag.
- `patient_profiles` is one row per patient account, with preferred language,
  optional home area and a version counter.
- `patient_field_values` is the source of truth for profile values. Its primary
  key is (`patient_id`, `field_key`); `value` is JSON; `source` is `PATIENT`,
  `PRACTITIONER` or `IMPORT`; `updated_by_account_id` is nullable.
- `emergency_fields` is the patient-selected subset for emergency display, with
  a display order. It references an existing `patient_field_values` row.
- `patient_codes` stores one current code per patient: a unique HMAC
  `code_digest`, an AES-GCM `code_ciphertext`, key version and code version.
  Plaintext codes are never stored.
- `practitioner_profiles` stores registration reference envelope, verification
  status and optional facility; a practitioner's role lives in `account_roles`.

### Grants, consent and protected reads

`access_grants`, `access_grant_fields`, `access_grant_channels`,
`profile_use_consents`, `consent_fields`, `channel_links`,
`record_read_sessions`

- `access_grants` is field- and channel-scoped. It stores a `code_digest` unique
  per patient, expiry, revocation, creator and version. Channels are
  `WEB_PRACTITIONER` and `USSD`.
- `access_grant_fields` and `access_grant_channels` are composite-key scope rows.
- `profile_use_consents` binds a patient to a verified `channel_links` row and a
  channel (`SMS` or `USSD`), with a unique (`patient_id`, `channel`) constraint,
  expiry and revocation.
- `consent_fields` scopes a consent to field keys.
- `channel_links` stores an encrypted phone (`phone_envelope`), a phone digest,
  verification time, optional expiry and revocation. It is not a login.
- `record_read_sessions` records a protected read: patient, optional grant,
  purpose (`EMERGENCY` or `GRANT`), channel (`WEB_PRACTITIONER` or `USSD`),
  optional account/auth session, optional telecom session and phone digest,
  expiry, revocation and last read time. Reads are re-authorized on every page.

### Telecom queues and sessions

`channel_preferences`, `rate_limits`, `ussd_sessions`, `sms_inbox`,
`sms_conversations`, `outbox`, `delivery_events`

- `sms_inbox` stores the provider message id (unique per provider), phone digest,
  encrypted body, status (`QUEUED`, `PROCESSING`, `PROCESSED`, `FAILED`,
  `EXPIRED`), attempts, `next_attempt_at`, lease, claim owner and a 7-day default
  expiry.
- `sms_conversations` is one row per phone digest with state, JSON context, a
  version and expiry.
- `ussd_sessions` stores provider session id (unique per provider), phone digest,
  service code, state, JSON context, path digest/depth, invalid attempts, version,
  read session link, expiry and end time.
- `outbox` stores a unique `logical_key`, kind (`TEXT`, `EMERGENCY`, `FACILITY`,
  `WEB_LEAD`), encrypted recipient, optional recipient digest, render reference,
  optional payload envelope, optional read session, status, attempts, lease,
  provider message id, timestamps and a 1-day default expiry. Statuses are
  `QUEUED`, `SENDING`, `ACCEPTED`, `DELIVERED`, `FAILED`, `UNKNOWN`, `EXPIRED`
  and `DEAD`.
- `delivery_events` stores idempotent provider status events with a unique
  fingerprint and an optional outbox link.
- `channel_preferences` stores opt-out and locale per phone digest.
- `rate_limits` is a fixed-window counter keyed by (`scope`, `window_start`).

### Audit and idempotency

`audit_events`, `access_attempts`, `idempotency_records`

- `audit_events` records time, request id, optional actor account, optional
  patient, channel (`WEB`, `SMS`, `USSD`, `SYSTEM`), action, resource, outcome
  (`ALLOWED`, `DENIED`, `ERROR`), reason code, field keys, `actor_ref` and JSON
  metadata. It must not contain clinical values or secrets. AI actions use
  `channel = SYSTEM` and `actor_ref = "ai:<model>"`.
- `access_attempts` records lookup/access attempts (including throttled and
  denied) with target/phone digests and a 30-day default expiry.
- `idempotency_records` stores an actor scope + idempotency key, request digest,
  created resource and optional response envelope, expiring after one day.

### Online conversations and AI-derived records

`conversations`, `conversation_messages`, `symptom_analyses`, `allergies`,
`medical_events`, `medication_schedules`, `medication_moments`,
`notification_tokens`

- `conversations` belongs to an account or an anonymous session digest, with
  channel, language, status, version and expiry.
- `conversation_messages` stores role, encrypted content envelope, JSON UI
  payload, model version and reviewed content ids.
- `symptom_analyses` belongs to a patient and account, with name, severity,
  summary, include-records/modify-history flags, file keys, a unique thread id
  and model version.
- `allergies` and `medical_events` are patient-owned clinical rows used by the
  profile and AI read tools.
- `medication_schedules` stores title, description, JSON medications, start/end
  dates, summary, progress and score. `medication_moments` stores drug, dose,
  frequency, status (`PENDING`, `TAKEN`, `MISSED`), a timestamptz dose time,
  notification flags and a schedule link.
- `notification_tokens` stores a unique FCM token per account and platform
  (`IOS`, `ANDROID`, `WEB`).

### Directory and reviewed content

`areas`, `area_aliases`, `services`, `sources`, `facilities`,
`facility_services`, `web_leads`, `referral_requests`, `referral_results`,
`reviewed_health_content`, `reviewed_content_citations`, `web_observations`

- Directory matching is service-first: approved service, approved
  facility-service link, active area in the same country, distance from the area
  center, bounded results.
- `sources` records provenance and a trust tier (`OFFICIAL`, `APPROVED`, `MANUAL`,
  `UNVERIFIED_WEB`).
- `facilities` has a status (`PENDING`, `APPROVED`, `INACTIVE`, `REJECTED`), an
  area, optional coordinates/phone/source, verification metadata and `is_demo`.
- `facility_services` is the join of facility and service with an independent
  verification status and optional source. A nearby facility is not automatically
  suitable care.
- `web_leads` and `web_observations` stay unverified with source URLs and
  fingerprints.
- `reviewed_health_content` requires a version, reviewer and review timestamp
  before publication; citations link it to sources.
- `referral_requests` / `referral_results` record a search, applied consent and
  field scope, ranked results and a facility snapshot.

### Emergency requests

`emergency_requests`

- Created by the online `POST /v1/emergency` route and best-effort by the offline
  SMS/USSD emergency flows.
- Stores the requesting account/patient when available, channel (`WEB`, `SMS`,
  `USSD`), search kind, optional area/coordinates, a capped location label, the
  status (`SEARCHED`, `MATCHED`, `NO_MATCH`, `FAILED`) and a JSON snapshot of the
  live Serper results.
- The snapshot is contact information, not a verified facility record. It has no
  foreign key to `facilities`; live results never become approved directory rows.
- `request_id` supports idempotent/audit correlation; indexes cover account,
  patient and channel history reads.

## Queue and concurrency rules

- Queue claims use `FOR UPDATE SKIP LOCKED` with a lease (`lease_until`,
  `claimed_by`) so multiple workers are safe. These are `$queryRaw` calls; normal
  CRUD uses the generated client.
- Inbox processing is serialized per phone digest.
- Expired `SENDING` outbox rows transition to `UNKNOWN`; they are not retried
  blindly. A claim after lease expiry must decide explicitly.
- `logical_key` and provider message ids provide inbound/outbound idempotency.
- `delivery_events.event_fingerprint` deduplicates provider delivery reports.
- `version` columns on profiles, grants, consents, sessions and schedules support
  optimistic concurrency/version checks in the owning service.

## Cryptographic contract

`backend/shared/src/crypto.ts` is shared by both services:

- HMAC-SHA256 digests: `HMAC(base64_decode(key), purpose + "\0" + value)`.
- Purposes: `patient` and `grant` code digests, `phone` digests, `input` for
  request/path fingerprints.
- Patient codes are 12 digits; grant codes are 8 digits in the current contract.
- AES-256-GCM envelopes are stored as
  `version.iv.auth_tag.ciphertext`, with purpose-bound associated data.
- `ENCRYPTION_KEY_VERSION` must match the version stored in envelopes.

`CODE_DIGEST_KEY` must be identical in the online and offline services, or a
patient code created by one will not resolve in the other. `DATA_ENCRYPTION_KEY`
protects SMS/USSD envelopes and local payloads; it is not a password hash and
must not reach the browser. `PHONE_DIGEST_KEY` and `INPUT_FINGERPRINT_KEY` default
to the code/encryption keys when unset; set them independently if key separation
is required.

Changing either key is a data migration, not a normal configuration change. Back
up keys separately from the database.

## Seeding and demo fixtures

`backend/online/prisma/seed.ts` is idempotent and seeds reference data plus an
optional sandbox patient:

- 15 field definitions: `full_name`, `date_of_birth`, `allergies`,
  `current_medications`, `conditions`, `blood_group`,
  `emergency_contact_name`, `emergency_contact_phone`, `weight`, `height`,
  `gender`, `blood_pressure`, `genotype`, `existing_conditions`,
  `existing_medications`.
- 3 services: `general`, `pediatrics`, `maternity`.
- Real area `Ikeja, Lagos` with fixed UUID
  `20000000-0000-4000-8000-000000000001` and `is_demo = false`.
- No demo facilities are created. The seed removes legacy fixtures with the
  former demo UUIDs and any remaining `is_demo` facility in the Ikeja area.
  Care results come from approved non-demo facilities and live Serper leads.
- Demo account `demo.patient@example.test` (bcrypt cost 12, password
  `DemoPass123!`), patient profile `...0005`, patient code `123456789012`
  (HMAC digest plus AES-GCM ciphertext), five profile values and emergency
  fields for allergies and emergency contact.

The seed requires `CODE_DIGEST_KEY` and `DATA_ENCRYPTION_KEY` to write the demo
code. The credentials and code are fixtures only. Demo facilities are never
created; any legacy `is_demo = true` facility is excluded from directory and
care-search results.

`backend/offline/scripts/seed-demo.ts` now uses the same Prisma schema and writes
the same reference area and demo patient for offline sandbox testing. The online
seed is the canonical setup step; do not run both in different databases and
expect them to share data.

## Schema change process

1. Edit `backend/online/prisma/schema.prisma`.
2. Run `npm run db:migrate` against a disposable development database and review
   the generated SQL.
3. Run `npm run db:generate`, `npm run typecheck` and the relevant tests.
4. Apply with `prisma migrate deploy` in shared environments. Never edit an
   applied migration or add ad-hoc DDL outside `prisma/migrations`.
5. Update this document and any affected module contract.
6. Keep identifiers UUID, timestamps `timestamptz` and measurements `Decimal`.
7. Do not reintroduce routine-based authorization or derive the channel from a
   database role. Channel is an application concern attached by the authenticated
   route/service.

There is no separate database migration tool. Prisma is the whole migration
system.
