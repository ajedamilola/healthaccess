# Architecture

Last updated: 17 November 2026

## Components

### Shared package - `backend/shared/`

`@healthaccess/shared` is a dependency-free TypeScript package. It contains:

- `crypto.ts` - `createCrypto()` with HMAC-SHA256 digests for patient codes,
  grant codes, phone numbers and input fingerprints, plus AES-256-GCM envelopes.
- `policy.ts` - grant/consent liveness and field-scope checks.
- `projection.ts` - record projection construction, sorting and pagination.
- `types.ts` - shared record, directory, SMS and projection types.

Both backends import the same code. The package has no Prisma client and no
database connection.

### Online service - `backend/online/`

An Express 5 API on Node 24, compiled from TypeScript and run with `tsx` in
development or `node dist/server.js` in production.

Owned by `src/app.ts` and `src/routes.ts`:

- security headers (`helmet`), CORS for `FRONTEND_URL`, JSON/urlencoded body
  limits, request ids and pino request logs
- `GET /health/live` and `GET /health/ready` (the ready check runs `select 1`
  through Prisma and returns 503 on failure)
- all feature routes under `/v1`
- central error handling and a JSON 404

`src/routes.ts` mounts these module groups:

```text
/v1/auth          authRouter
/v1/me            meRouter (users) and mePortalRouter (portal)
/v1/directory     directoryRouter
/v1/emergency     emergencyRouter
/v1/records       recordsRouter
/v1/symptom       symptomRouter
/v1/medications   medicationsRouter
/v1/devices       devicesRouter
```

Each module is expected to export a named Express `Router` from
`src/modules/<name>/router.ts`. Modules must not import each other; shared needs
go through `src/services/**`, `src/domain/**` or `backend/shared`.

Directory reads merge approved, non-demo facilities from the database with live
Serper Maps results. Live results are stored as `sources` + `web_leads`, labelled
`verification_status: "unverified"`, and are never presented as verified
facilities. `include_live=false` disables the live supplement for a request.

`POST /v1/emergency` searches live emergency hospitals and ambulance services
through Serper, stores an `emergency_requests` row scoped to the authenticated
account, and returns ranked contact results plus immediate-call guidance. It does
not dispatch an ambulance. `GET /v1/emergency` and `GET /v1/emergency/:id` are
account-scoped history reads.

Implementation status: auth, users, portal, directory, symptom and medication
routers have handlers. The AI layer (`src/ai/`), medication reminder job and FCM
service are implemented and covered by DB integration tests. Live FCM delivery is
not verified; OpenRouter was smoke-tested, while production credentials for the
other providers are not configured. See the phase table in [README.md](README.md).

`src/db.ts` exports a single `PrismaClient` (cached on `globalThis` outside
production) for the online process. The offline service has its own `src/db.ts`
using the same generated Prisma client. `src/middleware/auth.ts` verifies JWTs and loads a live
`auth_sessions` row. `src/services/audit.ts` writes `audit_events`, including the
`recordAiAudit()` helper used for AI actions.

### Offline service - `backend/offline/`

An independent SMS/USSD service with two processes:

- `src/server.ts` / `src/app.ts` - provider callbacks and the deterministic USSD
  state machine; never sends SMS and never calls a model.
- `src/worker.ts` - SMS conversation jobs, outbound SMS, retention maintenance,
  and the existing OpenRouter/Serper integration; never handles provider
  callbacks.

The HTTP process and worker share PostgreSQL and the same `.env`. Both must run.
The HTTP process logs one structured `http_request` line per request with method,
URL, status, duration and (subject to `LOG_HTTP_BODIES`) the callback body. The
callback token path segment is always redacted; production defaults to redacted
bodies because SMS/USSD bodies contain phone numbers and health text.

Current implementation status: `src/repository.ts` uses the generated Prisma
client and `src/db.ts`, applies the shared policy helpers, and uses
`prisma.$queryRaw` for queue claims, rate limits, projections and distance
queries. It does not have a separate `src/access.ts`; access checks live in the
repository and the shared policy module. `ready()` is a Prisma connectivity
probe. The Prisma integration suite passes 20 tests alongside 71 offline unit
tests.

### PostgreSQL - Prisma `public` schema

`backend/online/prisma/schema.prisma` is the single source of truth. Prisma owns
the `public` schema; there are no application namespaces, no security-definer
routines and no database-role-derived channel. See [database.md](database.md).

The old `backend/database_structure.sql`, the `healthaccess` / `directory` /
`content` / `telecom` schemas and the `healthaccess_api.*` routines are retired.
They remain in the tree only as legacy artifacts and must not be applied to a
Prisma-managed database.

### Supporting services

- Redis 7 - included in the compose stack; optional for direct runs (`REDIS_URL`).
- S3-compatible storage - avatars and symptom attachments, presigned URLs;
  MinIO is the local option.
- Firebase Cloud Messaging - medication push reminders.
- Africa's Talking - inbound/outbound SMS and USSD.
- LLM/search providers - OpenRouter, DeepSeek, Google Gemini, Anthropic, Groq and
  Serper.

## Authentication and identity

Implemented in `src/modules/auth/` and `src/middleware/auth.ts`; auth and users
have DB-backed tests under `backend/online/tests/`.

- `POST /v1/auth/register` and `POST /v1/auth/login` issue a short-lived access
  JWT (15 minutes by default) and an opaque refresh token (30 days).
- Access claims are `{ sub, sid, roles, typ: "access" }`. `Authorization: Bearer`
  carries the JWT.
- Refresh tokens are random 32-byte values. Only a SHA-256 hash is stored in
  `auth_sessions.refresh_token_hash`; the token is rotated on every refresh.
- `requireAuth` verifies the JWT, loads a non-revoked, non-expired
  `auth_sessions` row, checks `accounts.status = ACTIVE`, and sets:

  ```ts
  req.auth = { accountId, sessionId, roles }
  req.requestId
  ```

- `requireRole(...roles)` guards practitioner and admin routes.
- Google OAuth is supported through `GET /v1/auth/google` and its callback, tied
  to `accounts.idp_subject`. Google client id/secret are optional in config; the
  routes return an error when they are unset.
- Phone verification uses `auth_challenges` with
  `purpose = PHONE_VERIFICATION`, a hashed token, an encrypted delivery target
  and a `phone_digest`. The SMS is queued through the shared outbox, so the
  offline worker performs delivery.

Sessions are revocable by setting `auth_sessions.revoked_at`. Logout revokes the
current session. No JWT is accepted merely because it is signed; the session row
must still be live.

## Portal, grants and protected reads

Implemented in `src/modules/portal/`, `src/domain/access.ts` and
`src/modules/directory/`; the portal/directory DB tests pass 20/20.

- Profile values live in `patient_field_values`. `emergency_fields` is the
  patient-selected subset allowed in an emergency summary.
- `patient_codes` stores a unique `code_digest` and an encrypted code; plaintext
  codes are never stored or logged. The 12-digit patient code can be rotated.
- `access_grants` is field-scoped and channel-scoped through
  `access_grant_fields` and `access_grant_channels`. A grant has an expiry and an
  optional revocation timestamp.
- `profile_use_consents` binds a consent to a verified `channel_links` phone for
  SMS/USSD profile use. Consent fields are field-scoped.
- Every non-emergency read creates a `record_read_sessions` row. The row records
  purpose, channel, account/session or telecom session, expiry and last read
  time. Re-authorization happens on every page, not just at open.
- `audit_events` records allowed/denied access and AI actions without clinical
  values. `access_attempts` records throttled/denied lookup attempts.

Controllers resolve the patient from `req.auth`; they never accept a patient id
from the request body. Directory reads are service-first and only approved,
non-demo facilities with approved facility-service links are eligible for a
verified care match. A live Serper supplement fills the remaining result slots
with unverified web leads; web leads remain clearly labelled as unverified.

## AI behavior

Status: `src/ai/` contains models, prompts, schemas, tools, agents and the
medication adapter, and `src/modules/symptom/` exposes the chat, follow-up and
attachment routes. The symptom tests inject a fake agent and pass 18/18. The
LangGraph checkpointer schema `ai_agent_state` is pre-created and granted to the
runtime role; `checkpointer.setup()` is skipped when it is already initialized.
The offline service has a separate, smaller OpenRouter pipeline for SMS
classification and reviewed/web answers.

Symptom analysis also supports server-sent events at
`POST /v1/symptom/stream` and `POST /v1/symptom/:id/follow-up/stream`. The routes
emit `record`, `step` (agent tool start/completed/failed), `token` and `done`
events, with `error` replacing `done` on failure. The stream is built from
LangGraph `streamEvents` (`version: "v2"`) and uses the same checkpointer thread
as the non-streaming route. Client disconnects abort the model call; attachments
are cleaned up and a newly created record is deleted only if no token was sent.
The web app consumes these streams token by token; the Next.js BFF passes
`text/event-stream` responses through unbuffered and aborts upstream work when the
browser disconnects.

### One-code sharing

- Viewers need exactly one code. `POST /v1/records/open { code }` accepts a
  12-digit emergency (patient) code, which shows the emergency summary to any
  signed-in user, or an 8-digit temporary code, which opens the granted fields
  for verified practitioners. Spaces and dashes are ignored. `grant/open` no
  longer needs the patient code; live temporary codes are unique across all
  patients so the code alone identifies the patient.
- `POST /v1/me/grants/quick` makes a one-tap temporary code (emergency summary,
  or every filled emergency-eligible field) for web and USSD.
- USSD menu: 1 Find care, 2 Open shared health info (either code in one box),
  3 My access code (verified phones: shows the emergency code and can issue a
  1-hour code), 4 Emergency help (area only, saved area offered).
- SMS keeps the last 10 turns of conversation, encrypted at rest
  (`historyEnvelope`, purpose `sms-history`) within the conversation TTL. Free
  text goes through a conversation-aware AI router (`assistant-converse.txt`)
  that can trigger emergency search, care search, a safe answer, or the
  sender's code. Without AI it falls back to a plain-language numbered menu.
  `CODE` and `NEW CODE` return the sender's own codes on a verified phone.

### Personalisation

- Patient-entered personal context lives in field definitions added by the
  `personal_context_fields` migration: `city`, `state`, `country`,
  `pregnancy_status`, `smoking_status`, `alcohol_use`, `activity_level`
  (plus existing `gender`, `date_of_birth`, vitals, conditions, medications).
  `PATCH /v1/me` accepts them (empty string clears a value) and
  `preferredLanguage`; city/state are matched to a directory `Area` and stored
  as the profile's `home_area_id`.
- `src/ai/context.ts` builds a de-identified snapshot (age band, sex, pregnancy,
  location, local emergency number, BMI, genotype, conditions, medications incl.
  active schedules, allergies, lifestyle, recent symptom chats). When a chat has
  `includeRecords`, the snapshot is embedded in the system prompt, which also
  carries a triage/format guide, today's date and the preferred reply language.
  No names, emails, phone numbers or codes are included.
- `GET /v1/me/assistant-context` returns the snapshot and a completeness score
  with the most useful missing items; the web assistant shows it and links to the
  profile. New accounts are offered an optional, skippable setup wizard at
  `/app/welcome`.
- Offline: with a live profile-use consent for the sending phone, SMS `FIND` and
  `EMERGENCY` (and USSD option `1. My area`) offer the patient's saved home area,
  and `ASK` answers receive consent-scoped hints (age band, sex, pregnancy,
  conditions, allergies, medications). Hints go to the model only, never to web
  search or channel state, and each read is audited (`profile_area_read`,
  `assistant_context_read`).

- Agents: symptom chat (ReAct loop with conversation memory) and medication
  scheduling/addition.
- Providers: DeepSeek, Google Gemini, Anthropic, Groq and OpenRouter through
  LangChain / LangGraph. Provider keys come from environment variables. If the
  required key is absent, the endpoint returns `503` rather than silently
  degrading.
- LangGraph's checkpointer owns a separate `ai_agent_state` schema. It is not
  modelled in Prisma. In the current environment it is pre-created and granted to
  the runtime role; `ensureCheckpointerReady()` skips `setup()` when the
  checkpoint tables already exist. A fresh deployment either grants `CREATE` on
  the database once or pre-creates and grants the schema.
- `lookupPatientDetails` may return the patient's profile fields, allergies,
  medical events, symptom names and coarse location. It must never return
  patient codes, grant codes, phone numbers, `phone_digest`, channel-link data or
  auth material.
- `editSymptomAnalysis` and `createMedicationSchedule` write through the owning
  module's service, inside the normal authorization and validation path, and
  append an `audit_events` row with `channel = SYSTEM` and
  `actor_ref = "ai:<model>"`. Read tools also append audit rows.
- Model output is schema-validated before any write. A failed validation,
  provider error or timeout fails closed.

### Third-party provider exposure

The online AI feature sends **de-identified clinical context** to a third-party
LLM provider: the patient's profile values, allergies, medical events, symptom
descriptions and coarse location may be included in prompts so the agent can
reason about the case. Patient code, grant code, phone number, `phone_digest` and
auth data are excluded by construction.

This is still a disclosure of health information to the model provider, and the
provider's retention, training and cross-border processing terms apply. Free-text
messages can also contain information a patient volunteers (for example a name or
phone number); the exclusion rules do not guarantee automatic de-identification
of free text. Do not enable the online AI feature for real patients until the
provider terms, consent language and data-protection review for the pilot country
are approved. The same caution applies to the offline OpenRouter and Serper path.

## Medication tracking and reminders

Status: `src/domain/medications.ts` implements schedule creation, medication
addition/removal, moment expansion and progress recomputation. HTTP routes,
`src/jobs/reminders.ts`, `src/services/fcm.ts` and the medications/reminders test
files exist and pass 21 tests. Live FCM delivery is disabled in the current
environment (`FCM_ENABLED=false`), so push remains a logged no-op until a
service account is configured.

Flow:

1. A schedule is created from user input or an AI-generated draft. The domain
   service writes `medication_schedules` plus one `medication_moments` row per
   drug per dose time, in a transaction.
2. A reminder job claims due `PENDING` moments (`time <= now`, not notified)
   using a lease so multiple workers do not double-send.
3. Push reminders go to `notification_tokens` through FCM. Tokens are
   per-account and platform-tagged; invalid tokens are removed.
4. SMS reminders are queued in `outbox` with a stable `logical_key`, encrypted
   recipient and `kind = TEXT`. The online process never calls Africa's Talking
   directly; the offline worker sends.
5. After a successful enqueue/send attempt, `notified_user` / `notified_at` are
   set. Provider acceptance is recorded in outbox state, not treated as handset
   delivery.
6. Patient status changes (`TAKEN`, `MISSED`) update the moment and recompute
   schedule progress/score.

Reminder sends are idempotent by moment id and logical key. An ambiguous send is
recorded as `UNKNOWN`, not retried blindly.

## Offline SMS flow

This flow is implemented on the Prisma-backed offline repository; the rewrite
keeps the same external behavior.

1. Africa's Talking posts an inbound message form to
   `/callbacks/africastalking/<CALLBACK_TOKEN>/sms/inbound`.
2. The HTTP process validates origin, body shape/size, inbound number and rate
   limits, then inserts an encrypted `sms_inbox` row. It returns 200 only after
   acceptance succeeds.
3. The worker claims one inbox job at a time per phone, decrypts the body, loads
   `sms_conversations` and processes the command.
4. Deterministic commands (`HELP`, `FIND`, `EMERGENCY`, `LOOKUP`, `MORE`,
   `CANCEL`, `STOP`) do not require AI. Natural-language classification and `ASK`
   may call OpenRouter and Serper. Care and emergency searches fall back to live
   Serper Maps leads when the approved non-demo directory has no result.
5. The final transaction rechecks ownership and conversation version, stores
   state and queues one or more `outbox` rows.
6. The worker claims each outbox job, re-resolves the current authorized
   projection or directory record, renders the SMS and sends it through Africa's
   Talking.
7. Delivery reports update `delivery_events` and outbox state separately.

Key behavior:

- Duplicate provider message ids are deduplicated by the unique key.
- Duplicate replies use stable logical keys.
- A crash after provider handoff leaves an outbox row `UNKNOWN`; it is not
  retried automatically.
- `STOP` expires pending replies and permits only its own confirmation.
- A queued emergency summary is re-authorized immediately before dispatch; a
  changed or removed field is not sent.
- Over-budget SMS content is replaced with a safe referral to USSD/portal rather
  than truncated.

SMS commands:

| Input                         | Behavior                                              |
| ----------------------------- | ----------------------------------------------------- |
| `HELP`                        | Brief commands and channel notice                     |
| `FIND <care> near <area>`     | Service/location resolution then directory/live search |
| `EMERGENCY [near] <area>`     | Live emergency hospital/ambulance search, 112 guidance |
| Natural-language care request | AI classification into the same care flow             |
| `ASK <question>`              | Reviewed content first, else labeled web information  |
| `LOOKUP <12-digit code>`      | Emergency summary only; no AI                         |
| `MORE`                        | Next stored result if the conversation is live        |
| `CANCEL`                      | Clear transient conversation                           |
| `STOP`                        | End interaction, opt out, suppress pending replies     |

The SMS conversation TTL is 15 minutes by default. Expired conversations start a
new request rather than interpreting a reply against stale health context.

## Offline USSD flow

USSD is deterministic and never calls a model. It uses approved non-demo
directory data, the shared access policy, and a bounded Serper Maps fallback
inside the callback process when the directory has no result. The fallback and
emergency search are labelled unverified and never fabricated.

Root menu:

```text
HealthAccess
1. Find nearby care
2. Emergency summary
3. View shared details
4. Emergency help
0. Exit
```

Emergency help prompts for an area, searches `emergency hospital` and
`ambulance service` in parallel, shows the nearest live name/address/phone with
112 guidance, pages through up to eight leads, and records the request in
`emergency_requests` on a best-effort basis. State is stored as `CARE_LOCATION`
or `CARE_RESULTS` with `context.kind = emergency_area|emergency_results`; the
Prisma `UssdState` enum stays unchanged.

States persisted in `ussd_sessions.state`:

```text
MAIN
CARE_SERVICE
CARE_LOCATION
CARE_AREA_CHOICE
CARE_PROFILE_CONFIRM
CARE_RESULTS
CARE_NO_MATCH
EMERGENCY_CODE
GRANT_PATIENT_CODE
GRANT_ACCESS_CODE
RECORD_PAGE
END
```

### Cumulative path protection

Africa's Talking sends `text` as a cumulative path, for example `1*2*Ikeja`.
`channels/ussd-handler.ts` parses and bounds tokens, requires the path to advance
exactly one token from the stored depth, stores only a keyed fingerprint of the
path prefix (not the raw path), treats an exact repeat as a replay that reruns
authorization, and rejects skipped steps and edited prefixes.

### Protected records

- Emergency summary: patient code only, returning only fields the patient
  selected for emergency display.
- Additional details: patient code plus a live temporary grant code. The grant
  must include the `USSD` channel, be unexpired and unrevoked, and the fields are
  field-scoped.
- The grant read session is bound to the USSD session and phone digest. Every
  page and every replay reauthorizes.
- A grant read session is closed on exit, expiry, denial or session end.
- Additional grant fields are never forwarded by SMS.
- Long fields are paginated without silently dropping data; if content cannot
  fit, the renderer ends with a safe "use the portal" message.

### Source-change behavior

- Directory results are re-resolved when a page is replayed; a removed facility is
  not rendered from a cached snapshot.
- Record pages compute a keyed view digest. If the selected fields changed,
  pagination restarts or safely ends.
- The temporary USSD SMS-details path queues only public facility details.

## Persistence and queue semantics

All tables are in the Prisma `public` schema.

- `sms_inbox` - encrypted inbound message, provider dedupe key, attempts, lease
- `sms_conversations` - phone-scoped state, version, expiry
- `ussd_sessions` - provider session, phone digest, state, path digest, expiry
- `outbox` - kind, encrypted recipient, render reference, attempts, lease
- `delivery_events` - idempotent provider status events
- `channel_preferences` - opt-out state and locale
- `rate_limits` - shared fixed-window counters
- `channel_links` - verified patient/phone links

Claims use `FOR UPDATE SKIP LOCKED` and leases (raw SQL through Prisma where
needed). Expired `SENDING` rows become `UNKNOWN`, never automatically retried.
Inbox processing is serialized per phone. Retention defaults come from the
schema defaults/application config: 7 days for SMS bodies, 30 days for access
attempts, 1 day for outbox/render payloads, short-lived USSD sessions.

## Security and privacy model

- Callback path secret is required in all environments. Development/test accepts
  any source; production requires `CALLBACK_ALLOWED_IPS` and ignores forwarded IP
  headers. No Africa's Talking HMAC header is assumed.
- Request bodies are bounded, schema-validated and rate-limited.
- Logs contain event names, ids and hashes, not message bodies, clinical values,
  access codes, phone numbers, tokens or credentials.
- SMS/USSD payloads are AES-256-GCM envelopes with purpose-bound associated data.
- Patient, grant and phone lookups use HMAC digests, not plaintext.
- JWT access tokens are short-lived and bound to a revocable `auth_sessions` row.
  Roles are loaded from `account_roles`, not trusted from the token alone.
- AI tools are the only path by which an agent can touch records; they resolve
  the patient from the authenticated context and audit every read/write.
- Demo data is marked (`is_demo`) and labeled `DEMO` by renderers.
