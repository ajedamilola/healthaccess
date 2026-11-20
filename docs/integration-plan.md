# Mediwise → HealthAccess integration contract

Status: completed 17 Nov 2026. This file preserves the decisions, ownership map
and acceptance criteria used for the parallel build. For current runtime
documentation use [README.md](README.md), [architecture.md](architecture.md) and
[operations.md](operations.md).

## Decisions (confirmed 17 Nov 2026)

| Area | Decision |
| --- | --- |
| Scope | HealthAccess portal + symptom chat + Google sign-in + medication tracker. Prescription analyzer, medical-document analyzer, news feed are **out**. |
| Database | Prisma replaces the SQL schema. One PostgreSQL `public` schema. `backend/online/prisma/schema.prisma` is the source of truth. |
| Offline | Rewritten on Prisma. It uses the same generated client and the shared access service. No HTTP dependency on online. |
| Auth | Mediwise-style JWT: short-lived access token + rotating refresh token backed by `auth_sessions`. Google OAuth supported. |
| AI | Full mediwise behavior: agents read the patient's records and write analysis/schedules back. Every AI read/write is audited. OpenRouter is the preferred provider; direct providers remain fallbacks. Patient/grant codes, phone numbers and raw phone values are never placed in prompts. |
| Stack | TypeScript, Express 5, Node 24, `node:test` + `supertest`. |
| Reminders | SMS through the existing Africa's Talking outbox **and** Firebase Cloud Messaging push. |
| Storage | S3-compatible object storage with presigned URLs (`sharp` for image normalization). |
| Deployment | Docker Compose with PostgreSQL 16 and Redis 7. S3/MinIO stays external. The API reference is generated at `docs/api/index.html` and served at `/docs`. |

## Non-negotiable engineering rules

1. `backend/online/prisma/schema.prisma` is the only schema definition. Do not add raw table DDL outside `prisma/migrations`.
2. Every Prisma query is scoped by the authenticated account or patient. Controllers never accept a patient id from the request body; resolve it from `req.auth`.
3. Secrets stay in `.env`. Never log message bodies, codes, phone numbers, tokens or clinical values in production. The offline `LOG_HTTP_BODIES=full` mode is a local debugging exception; production defaults to `redacted` and must not enable `full`.
4. Patient/grant codes are HMAC digests. SMS/USSD payloads remain AES-256-GCM envelopes. Reuse `backend/shared`.
5. The offline process must start and serve callbacks without the online process running.
6. Timestamps are `timestamptz`. Money/measurements use `Decimal`. UUIDs are DB-generated.
7. No feature is "done" without `npm run typecheck` and its tests.

## Target tree

```text
backend/
  shared/                 @healthaccess/shared: crypto, projections, access policy, types
  online/                 @healthaccess/online: Express 5 API, Prisma schema + client
    prisma/schema.prisma  source of truth
    prisma/migrations/
    src/app.ts            route wiring (owned by coordinator)
    src/db.ts             PrismaClient singleton (offline has its own src/db.ts)
    src/modules/*         feature modules
  offline/                @healthaccess/offline: SMS/USSD, now Prisma-backed
```

## Ownership map (parallel work)

| Owner | Paths | Must not touch |
| --- | --- | --- |
| coordinator | `docs/integration-plan.md`, root `package.json`, `backend/online/{package.json,tsconfig*,prisma/schema.prisma,src/app.ts,src/server.ts,src/config.ts,src/db.ts,src/routes.ts,src/middleware/*,src/types/*}`, `backend/shared/**` | feature modules |
| db-agent | `backend/online/prisma/migrations/**`, `backend/online/prisma/seed.ts`, `backend/online/scripts/**`, `backend/online/tests/schema.test.ts` | `schema.prisma` unless a validation error requires a fix (report it) |
| auth-agent | `backend/online/src/modules/auth/**`, `backend/online/src/modules/users/**`, `backend/online/tests/auth.test.ts`, `backend/online/tests/users.test.ts` | other modules, core files |
| portal-agent | `backend/online/src/modules/portal/**`, `backend/online/src/modules/directory/**`, `backend/online/tests/portal.test.ts`, `backend/online/tests/directory.test.ts` | other modules, core files |
| ai-agent | `backend/online/src/modules/symptom/**`, `backend/online/src/ai/**`, `backend/online/src/services/{s3,redis}.ts`, `backend/online/tests/symptom.test.ts` | other modules, core files |
| meds-agent | `backend/online/src/modules/medications/**`, `backend/online/src/jobs/**`, `backend/online/tests/medications.test.ts`, `backend/online/tests/reminders.test.ts` | other modules, core files |
| offline-agent | `backend/offline/src/**`, `backend/offline/tests/**`, `backend/offline/scripts/**`, `backend/offline/package.json`, `backend/offline/tsconfig*.json` | online feature modules |
| docs-agent | `docs/**` except this file, root `README.md`, `docker-compose.yml`, `.github/workflows/**`, `backend/online/README.md` | source files |

Conflict rule: if you need a change outside your paths, post an `ASK` to `main` instead of editing.

## Core contracts

### Auth (`src/middleware/auth.ts`)

```ts
req.auth = { accountId: string; sessionId: string; roles: AccountRoleType[] }
req.requestId: string
```

- Access JWT: `Authorization: Bearer <jwt>`, 15 min, claims `{ sub, sid, roles, typ: "access" }`.
- Refresh token: opaque 32-byte random, stored as SHA-256 in `auth_sessions.refresh_token_hash`, 30 days, rotated on use.
- `requireAuth` verifies the JWT, loads a non-revoked, non-expired `auth_session`, and attaches `req.auth`.
- `requireRole(...roles)` guards practitioner/admin routes.

### Module router contract

Each module exports a named Router from `src/modules/<name>/router.ts`. The coordinator imports them in `src/routes.ts`. Modules must not import each other; cross-module needs go through `src/services/**` or `backend/shared`.

### API surface

```text
POST   /auth/register              POST /auth/login
POST   /auth/refresh               POST /auth/logout
GET    /auth/google                GET  /auth/google/callback
POST   /auth/phone/begin           POST /auth/phone/confirm
GET    /me                         PATCH /me
PUT    /me/medical                 POST /me/avatar
DELETE /me/allergies/:id           DELETE /me/medical-events/:id
PATCH  /me/medical-events/:id

GET    /me/fields                  PUT  /me/fields
PUT    /me/emergency-fields        GET  /me/emergency-summary
GET    /me/patient-code            POST /me/patient-code/rotate
GET    /me/grants                  POST /me/grants
DELETE /me/grants/:id              GET  /me/access-events
PUT    /me/consents/:channel       DELETE /me/consents/:channel

GET    /directory/services         GET  /directory/areas
GET    /directory/facilities       GET  /directory/facilities/:id
POST   /records/emergency          POST /records/grant/open
GET    /records/grant/:id          POST /records/grant/:id/close

POST   /symptom                    GET  /symptom
GET    /symptom/:id                POST /symptom/:id/follow-up
PATCH  /symptom/:id                DELETE /symptom/:id

POST   /medications                GET  /medications
GET    /medications/:id            DELETE /medications/:id
PATCH  /medications/:id/add        PATCH /medications/:id/remove
PATCH  /medications/moments/:id    POST /devices
```

### AI contract (`src/ai`)

- Agents: symptom chat (ReAct + memory), medication scheduler/adder.
- Providers: OpenRouter (preferred), DeepSeek, Google Gemini, Anthropic, Groq, Serper. Keys from env; no key = endpoint returns `503`.
- `lookupPatientDetails` returns the patient's profile, allergies, medical events, symptom names, location. Never patient codes, grant codes, phone numbers or `phone_digest`.
- `editSymptomAnalysis` and `createMedicationSchedule` write through the owning module's service and append an `audit_events` row with `channel = SYSTEM`, `actor_ref = "ai:<model>"`.
- LangGraph checkpointer owns schema `ai_agent_state`. It is not modelled in Prisma. Setup runs once as an administrator; `ensureCheckpointerReady()` skips setup when the checkpoint tables already exist.

### Offline rewrite

- Keep `src/channels/**`, `src/security/**`, `src/providers/**`, `src/config.ts`, `src/app.ts` intact except for wiring.
- Replace `src/repository.ts` internals: Prisma for sessions/consents/grants/directory/content; `prisma.$queryRaw` for `FOR UPDATE SKIP LOCKED` claims and the haversine query.
- Routine calls were replaced inside `src/repository.ts` with Prisma queries plus `@healthaccess/shared` policy/projection helpers; there is no separate `access.ts`.
- Channel is app-level now: offline serves only `/callbacks/africastalking/*`; online exposes no SMS/USSD routes.
- Keep the crypto contract: `CODE_DIGEST_KEY` purposes `patient|grant|phone|input`; AES-GCM envelopes unchanged.
- Integration tests move from `pg` + SQL schema to Prisma + migrations.

## Phases and acceptance

All phases completed on 17 Nov 2026. Final verification: typecheck/build clean,
shared 4/4, online 79/79, offline unit 71/71 and DB 20/20; the compose stack with
PostgreSQL and Redis is healthy; the API reference contains 48 endpoints.

1. **Foundation (coordinator):** workspace, Prisma schema, core files, module placeholders. `prisma validate` passes.
2. **Database (db-agent):** initial migration applies to a fresh DB, seed creates field definitions/services/demo data, schema test passes.
3. **Auth + users (auth-agent):** register/login/refresh/logout/Google/phone verification; profile and medical CRUD; avatar presign.
4. **Portal + directory (portal-agent):** fields, emergency summary, patient code rotation, grants, consents, access events, directory reads, record reads. Field/channel authorization tests.
5. **Symptom + AI (ai-agent):** chat CRUD, follow-ups, attachment upload, agents/tools, AI writes audited.
6. **Medications + reminders (meds-agent):** schedule CRUD, moment status, AI schedule creation, SMS outbox enqueue, FCM send, reminder job.
7. **Offline (offline-agent):** Prisma-backed repository, all 71 unit + 20 integration tests green or explicitly rewritten with equal coverage.
8. **Docs/DevOps (docs-agent):** READMEs, docker-compose (PostgreSQL + Redis; S3/MinIO external), API reference, CI.

## Coordination

The coordination rules below applied during the parallel build; the work is complete.

- Post `ASK` to `main` for contract ambiguity or cross-owner edits.
- Post `HOLD` if blocked by an unmerged dependency.
- Post `RESULT` with exact commands and outcomes when your phase is verified.
- Do not edit another owner's files. Do not reformat shared files.
