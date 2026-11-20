# Online API

`@healthaccess/online` is the Express 5 + Prisma service for the HealthAccess
patient portal. It owns the PostgreSQL schema and serves the versioned HTTP API
used by the web client and the symptom/medication features.

Status: auth/users, portal/grants, directory, live Serper directory and emergency
search, symptom chat (including SSE streaming), medications/reminders, the AI
layer, reminder job and FCM service are implemented. Workspace typecheck is clean
and the online DB suite passes 108 tests. Live FCM delivery and production
provider credentials are not configured. See `../../docs/README.md` for the phase
table.

## Requirements

- Node 24+ and npm 11+
- PostgreSQL 16 (the repository `docker-compose.yml` provides one)
- Optional: Redis 7 (included in compose), S3-compatible storage (MinIO), Firebase project, AI provider
  keys, Africa's Talking credentials
- Editor: the Prisma VS Code extension defaults to its Prisma 7 language server.
  This project pins Prisma 6.19.3, so `.vscode/settings.json` sets
  `prisma.pinToPrisma6` and the schema path. Reload the window after pulling.

## Setup

Run from the repository root so npm workspaces and the lockfile are used:

```sh
npm install
cp backend/online/.env.example backend/online/.env
```

The repository compose file starts PostgreSQL and Redis and overrides
`DATABASE_URL` and `REDIS_URL` for the containers. The values in this file are
used when you run the service directly with npm.

Fill at least `DATABASE_URL`, `JWT_SECRET`, `CODE_DIGEST_KEY` and
`DATA_ENCRYPTION_KEY`. The two crypto keys must match `backend/offline`, and
`CODE_DIGEST_KEY` must differ from `DATA_ENCRYPTION_KEY`. Keys are base64
32-byte values; `backend/offline` has `npm run keys:generate` if you need a
generator.

Then create/apply the schema and reference seed:

```sh
npm run db:migrate      # prisma migrate dev; creates a migration and applies it
npm run db:seed         # field definitions, services and the sandbox patient
```

The seed is idempotent. It creates 15 field definitions, 3 services, the real
`Ikeja, Lagos` area (`is_demo = false`) and the sandbox patient
`demo.patient@example.test` / `DemoPass123!` with patient code `123456789012`.
It creates no demo facilities and removes legacy demo facility rows. Care
results come from approved non-demo facilities and live Serper Maps leads.
It requires `CODE_DIGEST_KEY` and `DATA_ENCRYPTION_KEY` for the code digest and
envelope. The sandbox credentials are fixtures only; never use them outside a
demo database.

`db:migrate` is for development. Use `npm run db:deploy` or
`npx prisma migrate deploy` for a shared/production database. Never edit an
applied migration.

## Commands

```sh
npm run dev             # tsx watch, port 3000, loads .env when present
npm run build           # builds shared first, generates Prisma, tsc
npm start               # runs dist/server.js
npm run typecheck
npm test                # node:test unit tests in tests/*.test.ts
npm run db:generate     # prisma generate
npm run db:migrate
npm run db:deploy
npm run db:seed
npm run db:studio
```

`predev`, `prebuild`, `pretypecheck` and `pretest` all build
`@healthaccess/shared` and run `prisma generate` first. Do not run these scripts
inside another workspace without the root workspace context.

## Environment

`src/config.ts` is the authoritative reader. Required values fail fast.

| Variable                     | Required    | Notes                                                             |
| ---------------------------- | ----------- | ----------------------------------------------------------------- |
| `DATABASE_URL`               | yes         | Prisma PostgreSQL connection.                                     |
| `JWT_SECRET`                 | yes         | Access-token signing secret.                                      |
| `CODE_DIGEST_KEY`            | yes         | Base64 32-byte HMAC key for patient/grant digests.                |
| `DATA_ENCRYPTION_KEY`        | yes         | Base64 32-byte AES-256-GCM key.                                   |
| `PHONE_DIGEST_KEY`           | no          | Defaults to `CODE_DIGEST_KEY`.                                    |
| `INPUT_FINGERPRINT_KEY`      | no          | Defaults to `DATA_ENCRYPTION_KEY`.                                |
| `ENCRYPTION_KEY_VERSION`     | no          | Default `1`.                                                      |
| `JWT_ACCESS_TTL_SECONDS`     | no          | Default `900`.                                                    |
| `REFRESH_TTL_DAYS`           | no          | Default `30`.                                                     |
| `GOOGLE_CLIENT_ID`           | no          | Google OAuth.                                                     |
| `GOOGLE_CLIENT_SECRET`       | no          | Google OAuth.                                                     |
| `BASE_URL`                   | no          | Public API origin, default `http://localhost:3000`.               |
| `FRONTEND_URL`               | no          | CORS origin, default `http://localhost:5173`.                     |
| `SMTP_HOST`                  | for email   | SMTP server hostname; enables password-reset email.               |
| `SMTP_PORT`                  | no          | SMTP port, default `587`; port `465` uses TLS.                     |
| `SMTP_USER`                  | no          | SMTP username; set together with `SMTP_PASSWORD`.                 |
| `SMTP_PASSWORD`              | no          | SMTP password; set together with `SMTP_USER`.                     |
| `EMAIL_FROM`                 | for email   | Sender address configured for the SMTP account.                   |
| `AWS_REGION`                 | for uploads | S3 region.                                                        |
| `AWS_ACCESS_KEY_ID`          | for uploads | S3 access key.                                                    |
| `AWS_SECRET_ACCESS_KEY`      | for uploads | S3 secret.                                                        |
| `AWS_BUCKET_NAME`            | for uploads | Bucket name.                                                      |
| `S3_ENDPOINT`                | for MinIO   | For example `http://localhost:9000`.                              |
| `S3_FORCE_PATH_STYLE`        | for MinIO   | `true` for MinIO.                                                 |
| `REDIS_URL`                  | no          | Redis connection.                                                 |
| `DEEPSEEK_API_KEY`           | no          | AI provider.                                                      |
| `GOOGLE_API_KEY`             | no          | AI provider.                                                      |
| `ANTHROPIC_API_KEY`          | no          | AI provider.                                                      |
| `GROQ_API_KEY`               | no          | AI provider.                                                      |
| `OPENROUTER_API_KEY`         | no          | OpenRouter provider.                                              |
| `OPENROUTER_MODEL`           | no          | Default `deepseek/deepseek-chat`.                                 |
| `SERPER_API_KEY`             | no          | Web search.                                                       |
| `CHAT_MODEL`                 | no          | Default `geminiFlash`.                                            |
| `MEDICATION_SCHEDULER_MODEL` | no          | Default `haiku`.                                                  |
| `FCM_ENABLED`                | no          | Default false.                                                    |
| `FIREBASE_SERVICE_ACCOUNT`   | for FCM     | Absolute JSON path or inline JSON.                                |
| `REMINDER_INTERVAL_SECONDS`  | no          | Reminder job interval; default `60`.                              |
| `AT_USERNAME`                | no          | Default `sandbox`; online only writes the outbox.                 |
| `AT_API_KEY`                 | no          | Africa's Talking key.                                             |
| `AT_SMS_FROM`                | no          | Provisioned two-way sender.                                       |
| `NODE_ENV`                   | no          | Default `development`.                                            |
| `PORT`                       | no          | Default `3000`.                                                   |
| `LOG_LEVEL`                  | no          | Default `info`.                                                   |

Never commit `.env`. Do not log request bodies, clinical values, codes, phone
numbers or tokens; the app logs method, path, status, duration and request id.

Password recovery uses `POST /v1/auth/forgot-password` and
`POST /v1/auth/reset-password`. Configure SMTP to enable delivery. Reset links
expire after 30 minutes, are single-use, and revoke the account's existing
sessions when used. Unknown account emails receive the same accepted response.

## Endpoint groups

All routes mount under `/v1`. `src/routes.ts` is the wiring point; modules export
a named router and must not import each other.

| Group          | Path            | Surface                                                                 |
| -------------- | --------------- | ----------------------------------------------------------------------- |
| Auth           | `/v1/auth`      | register, login, refresh, logout, Google OAuth, phone begin/confirm     |
| Me / users     | `/v1/me`        | profile, medical profile, avatar, allergies, medical events             |
| Portal         | `/v1/me`        | fields, emergency fields/summary, patient code, grants, consents, events |
| Directory      | `/v1/directory` | services, areas, live+approved facilities, facility/web-lead detail     |
| Emergency      | `/v1/emergency` | request live emergency search/history, account-scoped                   |
| Records        | `/v1/records`   | emergency read, grant open/read/close                                   |
| Symptom        | `/v1/symptom`   | create/list/get, SSE stream, follow-up (+stream), update, delete         |
| Medications    | `/v1/medications` | create/list/get, delete, add/remove medications, moment status        |
| Devices        | `/v1/devices`   | register notification token                                             |

The frontend-facing reference with captured request/response examples is
[`../../docs/api/index.html`](../../docs/api/index.html). Rebuild it from the repo
root with `npm run docs:api`. When the API is running it is also served at
`http://localhost:3000/docs`, which makes the Try It panel same-origin.

The intended full surface is listed in `../../docs/integration-plan.md`. All
groups above have handlers; `/v1/symptom` includes multipart attachment upload,
follow-ups and server-sent event streams (`POST /symptom/stream` and
`POST /symptom/:id/follow-up/stream`). Stream events are `record`, `step`,
`token`, `done` and `error`. `/v1/directory` merges approved non-demo facilities
with live Serper leads unless `include_live=false`. Test the route and its
ownership/authorization behavior before treating a change as complete.

Health endpoints are outside `/v1`:

- `GET /health/live` returns `{ "status": "ok" }`.
- `GET /health/ready` runs `select 1` through Prisma and returns 503 when the
  database is unavailable.

## Authentication

- Access JWTs are bearer tokens with claims `{ sub, sid, roles, typ: "access" }`.
- `requireAuth` verifies the token, then requires a non-revoked, non-expired
  `auth_sessions` row and an `ACTIVE` account. It attaches
  `req.auth = { accountId, sessionId, roles }`.
- `requireRole(...roles)` guards practitioner/admin routes.
- Refresh tokens are opaque, stored only as a SHA-256 hash, and rotated on use.
- Google OAuth uses `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and
  `accounts.idp_subject`.
- Phone verification queues an SMS through `outbox`; the offline worker sends it.

## AI setup

`src/ai/` contains the model registry, prompts, schemas, tools, agents and the
medication schedule/addition adapter. `src/modules/symptom/` uses the symptom
chat agent with an isolated adapter for tests. The LangGraph checkpointer needs a
pre-created/granted `ai_agent_state` schema, or a one-time database `CREATE`
privilege.

The intended behavior is:

- AI agents read the patient's profile, allergies, medical events, symptom names
  and coarse location, and may write symptom analysis or medication schedules.
- Every AI read/write appends an `audit_events` row with `channel = SYSTEM` and
  `actor_ref = "ai:<model>"`.
- Patient code, grant code, phone number and `phone_digest` are never placed in
  prompts.
- With no provider key, the AI endpoint returns 503.
- Streaming uses LangGraph `streamEvents` v2 and emits tool steps plus model
  tokens; a client disconnect aborts the model call.

Provider selection uses `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`,
`ANTHROPIC_API_KEY` or `GROQ_API_KEY`; `SERPER_API_KEY` enables live directory,
emergency and web search. Live directory/emergency results are unverified and
must be labelled as such. De-identified clinical context is still sent to a third-party model
provider, whose retention/training terms apply. Do not enable this for real
patients before the provider and data-protection review is approved. See
`../../docs/architecture.md`.

## S3 setup

Avatars and symptom attachments use `@aws-sdk/client-s3` with presigned URLs and
`sharp` for image normalization. Configure `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_BUCKET_NAME`. For MinIO also set
`S3_ENDPOINT=http://localhost:9000` and `S3_FORCE_PATH_STYLE=true`, then create
the bucket:

```sh
mc alias set local http://localhost:9000 <access-key> <secret-key>
mc mb --ignore-existing local/healthaccess
```

If storage is not configured, upload endpoints return `503
storage_unavailable`; the API still starts.

## Firebase Cloud Messaging

Set `FCM_ENABLED=true` and `FIREBASE_SERVICE_ACCOUNT` to an absolute path or the
service-account JSON. Tokens are stored in `notification_tokens` by the device
registration route. `src/services/fcm.ts` and `src/jobs/reminders.ts` implement
the push path and are tested with fakes; `FCM_ENABLED=false` makes push a logged
no-op, and live delivery is not configured in this environment.

## Tests

```sh
npm run typecheck
npm run build

# DB integration tests (require DATABASE_URL and a migrated database)
node --env-file-if-exists=.env --test --import tsx tests/*.test.ts
```

`npm test` in this workspace runs every `tests/*.test.ts`, which currently means
the PostgreSQL integration suites (`schema`, auth, users, portal, directory,
emergency, symptom, medications, reminders). The suite currently passes 108
tests. CI excludes it and provisions no database. There is no separate online
unit suite.
Never point tests at a shared or production database.
