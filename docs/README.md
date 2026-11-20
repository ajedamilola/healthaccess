# HealthAccess engineering notes

Last updated: 17 November 2026

This folder is the starting point for an engineer or AI agent working on
HealthAccess. It describes the product, the current implementation, the Prisma
database contract, how to run it, and what is still unfinished. It reflects the
code in the repository, not the retired planning documents.

## What the project is

HealthAccess gives a patient control over a small, patient-selected emergency
health summary and helps them find suitable care.

- **Online:** an Express 5 + Prisma API at `backend/online/` serving the patient
  portal, authentication, grants and consent, directory reads, symptom chat and
  medication tracking.
- **Offline:** an independent SMS/USSD service at `backend/offline/` for a basic
  phone. It needs cellular coverage, but not mobile data or a browser. It is
  Prisma-backed and must keep serving provider callbacks when the online process
  is stopped.
- **Shared:** `backend/shared/` contains the common crypto, projection, access
  policy and type contracts used by both services. It has no database client.

Africa's Talking is the SMS and USSD provider. PostgreSQL 16 is the shared
database. Both backends use the same `public` schema, the same generated Prisma
client, and the same `CODE_DIGEST_KEY` / `DATA_ENCRYPTION_KEY` contract. The
offline service does not call the online HTTP API.

Prescription analysis, medical-document analysis, the news feed and voice are
out of scope for this integration.

## Status

Phase labels are based on code present in the repository on 17 November 2026.

| Phase                         | State       | Evidence / gap                                                                                                          |
| ----------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Foundation                    | Implemented | npm workspaces, Prisma schema, migrations, Express app, `/health/live`, `/health/ready`, `/v1`, shared package             |
| Database                      | Implemented | 49 tables + migrations; idempotent seed with reference data and a sandbox patient; `tests/schema.test.ts` passes 6/6        |
| Auth + users                  | Implemented | register/login/refresh/logout, Google OAuth, phone verification, profile/medical CRUD; 21 DB tests pass                 |
| Portal + directory            | Implemented | portal service, grants/consents/record reads; approved non-demo facilities plus live Serper leads; directory/emergency suites pass |
| Symptom chat + AI             | Implemented | symptom routes, attachment upload, SSE token/step streaming, AI agents/tools, audited reads/writes; 18 symptom tests pass |
| Medications + reminders       | Implemented | HTTP routes, domain, reminder job, FCM service, 22 medication/reminder tests pass; live FCM delivery not configured      |
| Offline SMS/USSD              | Implemented | Prisma repository, live Serper care/emergency fallback, no `pg` or routines; 85 unit + 20 DB integration tests pass        |
| Docs / DevOps                 | Implemented | READMEs, Dockerfiles, `docker-compose.yml` with PostgreSQL and Redis, API reference, CI; secret management, monitoring and alerting are not included |
| Patient/frontend UI           | Not present | `frontend/` contains only a placeholder README                                                                           |
| Voice channel                 | Pending     | Not implemented                                                                                                          |

`backend/database_structure.sql`, its schemas, its routines and the FastAPI plan
are retired. Do not add tables or functions to the SQL bootstrap and do not build
a FastAPI service. `plans/01_*` and `plans/02_*` are historical HTML documents;
where they disagree with `docs/integration-plan.md`, the integration plan wins.

## Architecture

```text
Browser / portal                     Basic phone
      |                                  | SMS / USSD
      v                                  v
backend/online (Express 5)          Africa's Talking
  - /v1 auth, portal, directory          |
  - emergency search, medications        v
  - symptom chat + SSE streaming    backend/offline HTTP process
  - live Serper directory             - provider callback validation
  - JWT access/refresh                - deterministic USSD state machine
  - AI agents + audits                - live emergency/care fallback
  - S3 presigned uploads               - durable SMS/event acceptance
      |                                    |
      |                                backend/offline worker
      |                                  - SMS conversation jobs
      |                                  - outbound SMS outbox
      |                                  - AI / web search (SMS path)
      |                                    |
      +----------------+-------------------+
                       |
                       v
          PostgreSQL 16, public schema
          Prisma schema is the source of truth
                       ^
                       |
          Redis (optional cache) / S3-compatible storage
          Firebase Cloud Messaging / SMS outbox
```

The online and offline processes are separately deployable. They share the
database and the crypto contract, not an in-process API.

## Repository map

```text
backend/
  shared/                      @healthaccess/shared
    src/crypto.ts              HMAC digests, AES-256-GCM envelopes
    src/policy.ts              grant/consent liveness and field checks
    src/projection.ts          record projection helpers
    src/types.ts               shared record/directory types
  online/                      @healthaccess/online
    prisma/schema.prisma       single database source of truth
    prisma/migrations/         Prisma migrations
    prisma/seed.ts             reference data + sandbox patient (no demo facilities)
    src/app.ts                 middleware, health, /v1 mounting
    src/routes.ts              module router wiring
    src/db.ts                  PrismaClient singleton
    src/middleware/            auth, request id, errors
    src/modules/*              feature routers
    src/domain/                access and medication logic
    src/ai/                    agents, tools, models, prompts, schemas
    src/jobs/                  reminder job
    src/services/              audit, SMS outbox enqueue, S3, FCM
  offline/                     @healthaccess/offline
    src/app.ts                 Africa's Talking callbacks
    src/server.ts              HTTP entry point
    src/worker.ts              SMS and outbound worker
    src/repository.ts          Prisma queue/session/access adapter
    src/channels/              SMS, USSD, rendering
    src/security/              crypto and callback origin checks
    src/services/              assistant and web search
    scripts/                   key generation, demo seed
docs/                          this documentation set
frontend/                      placeholder only
plans/                         retired HTML planning documents
docker-compose.yml             deploys online, offline (server + worker), docs, PostgreSQL and Redis; S3/MinIO is external
.github/workflows/ci.yml       unit/typecheck/CI sanity workflow
```

## Non-negotiable invariants

1. `backend/online/prisma/schema.prisma` is the only schema definition. Schema
   changes go through `prisma/migrations`, never raw table DDL outside a migration.
2. Every query is scoped by the authenticated account or patient. A controller
   never accepts a patient id from the request body; it resolves it from
   `req.auth`.
3. Patient codes, grant codes and phone numbers are stored as HMAC digests or
   AES-256-GCM envelopes. Plaintext is not stored and is not logged.
4. AI agents may read a patient's records and write analysis or schedules, but
   every AI read/write appends an `audit_events` row. Patient code, grant code,
   phone number and `phone_digest` are excluded from model prompts.
5. The offline process must start and serve callbacks without the online process
   running.
6. Provider acceptance is not handset delivery. Outbox rows distinguish accepted,
   delivered, failed, unknown and expired.
7. Demo directory and demo patient data stay explicitly labeled. Never present
   demo data as an approved real directory.
8. No feature is complete without `npm run typecheck` and its tests.

## Quick start

The full runbook is in [operations.md](operations.md). The short version:

```sh
# from the repository root
npm install
cp backend/online/.env.example backend/online/.env
cp backend/offline/.env.example backend/offline/.env
# fill in at least DATABASE_URL, JWT_SECRET, CODE_DIGEST_KEY, DATA_ENCRYPTION_KEY,
# CALLBACK_TOKEN and point them at your PostgreSQL/Redis/S3 instances for direct
# npm runs; never commit .env
npm run db:migrate
npm run db:seed
npm run dev:online
```

The compose file includes PostgreSQL 16 and Redis 7 and sets the backend
`DATABASE_URL`/`REDIS_URL` to them. S3/MinIO is external. See the root
[README](../README.md#docker-deployment) for the service and port map.

In another terminal, run the offline HTTP process and worker:

```sh
npm run dev:offline
npm run dev:worker
```

`backend/offline` uses the same Prisma client and migrations, so no second schema
or `db:apply` step is needed. See the status table and
[operations.md](operations.md).

## Demo fixtures

`npm run db:seed` is idempotent and creates:

- 15 `field_definitions` rows, including emergency-eligible name, date of birth,
  allergies, current medications, conditions, blood group and emergency contact.
- 3 `services` rows: `general`, `pediatrics`, `maternity`.
- Demo area `Ikeja` (`is_demo`), facilities `Demo Community Hospital` and `Demo
  Child Health Clinic` (both `APPROVED` and `is_demo`) with approved `general`
  and `pediatrics` facility services.
- Demo patient `demo.patient@example.test` / `DemoPass123!`, patient code
  `123456789012`, profile values and emergency fields for allergies and emergency
  contact.

The password and patient code are demo fixtures. Never reuse them outside a
demo database, and keep the `DEMO` labels visible in any UI. There is no demo
symptom analysis, medication schedule or reviewed content yet.
`backend/offline/scripts/seed-demo.ts` now writes the same Prisma fixtures for
offline sandbox testing; the online seed remains the canonical setup step.

## Tests

Unit tests do not require a database. Database integration tests are separate and
must not run in CI.

```sh
npm run typecheck
npm run build
npm run test --workspace @healthaccess/shared
npm run test --workspace @healthaccess/offline
```

The online workspace tests (`schema`, `auth`, `users`, `portal`, `directory`,
`emergency`, `symptom`, `medications`, `reminders`) use PostgreSQL and currently
pass 108 tests. They are DB integration tests, so CI does not run them. Run the
ones you need against a disposable database:

```sh
cd backend/online
node --env-file-if-exists=.env --test --import tsx tests/*.test.ts
```

The offline DB suite uses the same Prisma schema and a disposable database. It
currently passes 20 tests alongside 85 unit tests:

```sh
cd backend/offline
npm run test:db
```

Never point integration tests at a live database.

## Documentation index

- [architecture.md](architecture.md) - components, auth, AI, reminders, offline
  flows and the security model.
- [database.md](database.md) - Prisma schema, table groups, queue semantics,
  crypto contract and schema change process.
- [operations.md](operations.md) - environment, local setup, sandbox testing,
  tests, troubleshooting and production checklist.
- [integration-plan.md](integration-plan.md) - parallel-work contract and
  ownership map. Do not edit it from a feature task.
- [api/index.html](api/index.html) - generated Postman-style API reference with
  captured request/response examples and a working request runner. Rebuild with
  `npm run docs:api`; see [api/README.md](api/README.md).

## Current work items

Priority order:

1. Build the patient/frontend UI and wire it to `/v1`; the API has no frontend.
2. Harden the Docker deployment (secret management, backups, TLS/reverse proxy,
   monitoring) and verify live FCM/S3/provider credentials.
3. Add online unit tests that do not require PostgreSQL; the current online suite
   is DB integration only.
4. Operate an approved directory and clinically reviewed content alongside the
   live Serper fallback, and provision real two-way SMS/USSD channels.
5. Add an admin workflow for facility/service/content approval. Tables exist, but
   there is no admin UI or route.
6. Decide whether to implement voice; it remains out of scope for this release.
