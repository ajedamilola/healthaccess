# Operations and runbook

Last updated: 17 November 2026

## Environment files

Each service reads its own `.env` and both files are git-ignored:

- `backend/online/.env` - Express API, Prisma, JWT, S3, FCM, AI and outbox.
- `backend/offline/.env` - Africa's Talking callbacks, SMS/USSD crypto and the
  worker.

Never commit `.env` files, print their contents, or paste credentials into
documentation, tickets or AI prompts. `.env.example` files list the variable
names without values.

### Online variables

| Variable                   | Required    | Purpose                                                                 |
| -------------------------- | ----------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`             | yes         | PostgreSQL connection. Prisma owns the `public` schema.                 |
| `JWT_SECRET`               | yes         | Signs access JWTs. Use a long random value, not a password.             |
| `CODE_DIGEST_KEY`          | yes         | Base64 32-byte HMAC key for patient/grant digests. Shared with offline. |
| `DATA_ENCRYPTION_KEY`      | yes         | Base64 32-byte AES-GCM key for envelopes. Shared with offline.          |
| `PHONE_DIGEST_KEY`         | no          | Defaults to `CODE_DIGEST_KEY`. Set for key separation.                  |
| `INPUT_FINGERPRINT_KEY`    | no          | Defaults to `DATA_ENCRYPTION_KEY`. Set for key separation.              |
| `ENCRYPTION_KEY_VERSION`   | no          | Envelope key version; default `1`.                                      |
| `JWT_ACCESS_TTL_SECONDS`   | no          | Access token lifetime; default `900`.                                   |
| `REFRESH_TTL_DAYS`         | no          | Refresh session lifetime; default `30`.                                 |
| `GOOGLE_CLIENT_ID`         | no          | Enables Google OAuth when set with the secret.                          |
| `GOOGLE_CLIENT_SECRET`     | no          | Google OAuth client secret.                                             |
| `BASE_URL`                 | no          | Public API origin for OAuth callbacks; default `http://localhost:3000`. |
| `FRONTEND_URL`             | no          | Allowed CORS origin; default `http://localhost:5173`.                   |
| `AWS_REGION`               | for uploads | S3 region.                                                              |
| `AWS_ACCESS_KEY_ID`        | for uploads | S3 access key.                                                          |
| `AWS_SECRET_ACCESS_KEY`    | for uploads | S3 secret key.                                                          |
| `AWS_BUCKET_NAME`          | for uploads | Bucket for avatars and symptom attachments.                             |
| `S3_ENDPOINT`              | for MinIO   | Custom S3 endpoint, for example `http://localhost:9000`.                |
| `S3_FORCE_PATH_STYLE`      | for MinIO   | `true` for path-style access.                                           |
| `REDIS_URL`                | no          | Redis connection; cache/session-adjacent work.                          |
| `DEEPSEEK_API_KEY`         | no          | DeepSeek provider. Unset disables that provider.                        |
| `GOOGLE_API_KEY`           | no          | Google Gemini provider.                                                 |
| `ANTHROPIC_API_KEY`        | no          | Anthropic provider.                                                     |
| `GROQ_API_KEY`             | no          | Groq provider.                                                          |
| `OPENROUTER_API_KEY`       | no          | OpenRouter provider (preferred when set).                               |
| `OPENROUTER_MODEL`         | no          | OpenRouter model slug; default `deepseek/deepseek-chat`.                |
| `SERPER_API_KEY`           | no          | Live directory and emergency search (Serper Maps/web).                  |
| `CHAT_MODEL`               | no          | Symptom chat model key; default `geminiFlash`.                          |
| `MEDICATION_SCHEDULER_MODEL` | no        | Medication agent model key; default `haiku`.                            |
| `FCM_ENABLED`              | no          | `true` enables Firebase push.                                           |
| `FIREBASE_SERVICE_ACCOUNT` | for FCM     | Absolute path to the service-account JSON, or the JSON string.          |
| `REMINDER_INTERVAL_SECONDS` | no         | Reminder job interval; default `60`.                                    |
| `AT_USERNAME`              | for SMS     | Africa's Talking username; `sandbox` locally.                           |
| `AT_API_KEY`               | for SMS     | Africa's Talking API key. The online process only writes the outbox.    |
| `AT_SMS_FROM`              | for SMS     | Provisioned two-way sender/shortcode.                                   |
| `NODE_ENV`                 | no          | `development`, `test` or `production`; default `development`.           |
| `PORT`                     | no          | HTTP port; default `3000`.                                              |
| `LOG_LEVEL`                | no          | pino level; default `info`.                                             |

`src/config.ts` fails fast at startup if a required variable is missing or empty.

### Offline variables

| Variable               | Required        | Purpose                                                                                              |
| ---------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | yes             | PostgreSQL connection. Offline uses a runtime login with public table/sequence grants.             |
| `CODE_DIGEST_KEY`      | yes             | Base64 32-byte HMAC key for patient/grant/phone digests; must match online.                          |
| `DATA_ENCRYPTION_KEY`  | yes             | Base64 32-byte AES-GCM key for SMS/USSD envelopes and fingerprints; independent from the digest key. |
| `CALLBACK_TOKEN`       | yes             | 32-128 URL-safe secret in the callback path.                                                         |
| `AT_USERNAME`          | yes             | `sandbox` or the live Africa's Talking username.                                                     |
| `AT_API_KEY`           | no              | Blank enables mock SMS; a real value enables sending.                                                |
| `AT_SMS_FROM`          | yes for inbound | Provisioned two-way shortcode/number; inbound `to` is matched by digits.                             |
| `AT_USSD_SERVICE_CODE` | yes             | Exact provisioned USSD code, including `*` and `#`.                                                  |
| `OPENROUTER_API_KEY`   | no              | Enables the offline SMS AI when paired with a model.                                                 |
| `OPENROUTER_MODEL`     | no              | Explicit OpenRouter model id; set with the key.                                                      |
| `SERPER_API_KEY`       | no              | Enables live emergency/care search and unverified facility leads.                                   |
| `NODE_ENV`             | yes             | `development`, `test` or `production`.                                                               |
| `PORT`                 | no              | HTTP port; default `3001`.                                                                           |
| `LOG_HTTP_BODIES`      | no              | Request body logging: `off`, `redacted` or `full`. Development default `full`; production default `redacted`. |
| `CALLBACK_ALLOWED_IPS` | production      | Comma-separated provider egress CIDRs.                                                               |
| `HOST`                 | no              | Listen address; loopback by default in development, `0.0.0.0` in production.                         |

Operational defaults (session TTLs, retention, rate limits, menu bounds) live in
`backend/offline/src/config.ts`; they are not separate `.env` knobs.
`npm run keys:generate` creates the digest/encryption keys and callback token.

## Local setup

Prerequisites: Node 24+, npm 11+. The repository compose file includes
PostgreSQL 16 and Redis 7; for non-Docker development, point the env files at
your own instances.

1. For non-Docker development, point the env files at your own PostgreSQL, Redis
   and S3/MinIO instances. For Docker, the included Postgres and Redis are used
   and the compose overrides `DATABASE_URL` and `REDIS_URL`.

2. Install workspace dependencies from the root:

```sh
npm install
```

Do not run `npm install` inside a single workspace; the root lockfile is the
source of truth.

3. Create environment files:

```sh
cp backend/online/.env.example backend/online/.env
cp backend/offline/.env.example backend/offline/.env
cd backend/offline
npm run keys:generate
```

Copy the generated keys/token into both `.env` files as appropriate. Set
`DATABASE_URL` to your PostgreSQL instance, for example
`postgresql://healthaccess:password@localhost:5432/healthaccess`. Fill
`JWT_SECRET` with a long random value. The online and offline services must share
`CODE_DIGEST_KEY` and `DATA_ENCRYPTION_KEY`.

4. Migrate and seed:

```sh
npm run db:migrate
npm run db:seed
```

If you use dedicated `healthaccess_online` / `healthaccess_offline` logins rather
than the migration owner, apply the optional grants as an administrator:

```sh
psql 'postgresql://<admin>@localhost:5432/healthaccess' \
  -f backend/online/scripts/grant-runtime.sql
```

The script only grants public table/sequence DML to roles that already exist; it
never creates roles or passwords. The offline demo seed is optional and writes
the same Prisma fixtures for sandbox testing:

```sh
npm run db:seed-demo --workspace @healthaccess/offline
```

5. Run the online API:

```sh
npm run dev:online
curl -s http://localhost:3000/health/live
curl -s http://localhost:3000/health/ready
```

6. Run the offline service in separate terminals:

```sh
npm run dev:offline
npm run dev:worker
```

The offline service uses the same Prisma migrations and `DATABASE_URL`. Its unit
suite (71 tests) and Prisma integration suite (20 tests) pass; `test:db` needs a
disposable database because it creates and cleans up fixtures.

Production-style start after building:

```sh
npm run build
npm run start --workspace @healthaccess/online
npm run start --workspace @healthaccess/offline
npm run worker --workspace @healthaccess/offline
```

## Compose deployment

`docker-compose.yml` builds one backend image and runs the application services
with PostgreSQL 16 and Redis 7 included. S3/MinIO is not included.

| Service | Default port | Purpose |
| --- | --- | --- |
| `postgres` | internal 5432 | PostgreSQL 16, `healthaccess_pgdata` volume |
| `redis` | internal 6379 | Redis 7, AOF persistence |
| `migrate` | - | `prisma migrate deploy`, one shot, runs first |
| `online` | 3000 | `node backend/online/dist/server.js` |
| `offline` | 3001 | `node backend/offline/dist/server.js` |
| `offline-worker` | - | `node backend/offline/dist/worker.js` |
| `docs` | 8080 | nginx serving `docs/api` with a `/v1` proxy to `online` |

```sh
docker compose up -d --build
docker compose run --rm online npm run db:seed   # optional seed and sandbox patient
docker compose ps
docker compose logs -f online
```

The compose provides `DATABASE_URL` and `REDIS_URL` to the containers, so the
DB/Redis values in the backend env files are only for direct npm runs. Both env
files must agree on `CODE_DIGEST_KEY`, `DATA_ENCRYPTION_KEY` and
`ENCRYPTION_KEY_VERSION`; online also needs `JWT_SECRET`. `env_file` entries are
optional so a deployment platform can inject the other variables directly.

The default Postgres password is `healthaccess`. For anything beyond local
testing, copy the root `.env.example` to `.env` and set `POSTGRES_PASSWORD`
before the first start. Changing it after the volume exists requires resetting
that volume. The included Postgres uses its owner account for simplicity; a
production deployment should use a least-privilege role or an external managed
database. Each service reads `NODE_ENV` from its env file; the examples ship
with `development` (sandbox/mock SMS). A live deployment sets
`NODE_ENV=production` in both files, which requires live Africa's Talking
credentials, `AT_SMS_FROM`, `AT_USSD_SERVICE_CODE` and `CALLBACK_ALLOWED_IPS`.

The `docs` container proxies `/v1` to `online`, so its Try It panel is
same-origin. Override published ports with `ONLINE_PORT`, `OFFLINE_PORT`,
`DOCS_PORT` and the timezone with `TZ` (default `Africa/Lagos`). A rebuild that
includes a new migration recreates `migrate` and applies it before the services
start. `docker compose down` stops the stack; `down -v` also deletes the
Postgres and Redis volumes.

## Object storage

Your MinIO or S3 instance is external to the compose file. Create the bucket once
through the MinIO console or with `mc`:

```sh
mc alias set local http://localhost:9000 <access-key> <secret-key>
mc mb --ignore-existing local/healthaccess
```

Set `AWS_BUCKET_NAME=healthaccess`, `S3_ENDPOINT=http://localhost:9000` and
`S3_FORCE_PATH_STYLE=true` in `backend/online/.env`. A missing or incomplete S3
configuration makes upload endpoints return `503 storage_unavailable`; it does
not crash the API. Production should use an encrypted bucket with private access
and short-lived presigned URLs.

## AI setup

Set the provider key(s) and the model selector in `backend/online/.env`. A
missing key for the selected provider must make the AI endpoint return `503`;
it must never silently use a different provider or invent a result. The online
AI layer lives in `backend/online/src/ai/`, with `src/modules/medications/ai.ts`
as the medication adapter. See [architecture.md](architecture.md) for the
contract, including the fact that de-identified clinical context is sent to a
third-party model provider.

LangGraph's checkpointer creates and owns the `ai_agent_state` schema on first
use (`checkpointer.setup()`), which is not part of Prisma. In the current
environment it is pre-created and granted to the runtime role;
`ensureCheckpointerReady()` skips setup when the checkpoint tables exist. A fresh
deployment must either grant `CREATE` on the database once or pre-create
`ai_agent_state` with schema/table/sequence privileges for the runtime role.

The offline service has a separate, smaller OpenRouter + Serper path for SMS
classification/answers. Set both `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` to
enable it; without them deterministic SMS commands still work.

## Firebase Cloud Messaging

1. Create a Firebase project and a service account with Cloud Messaging access.
2. Store the JSON outside the repository and set
   `FIREBASE_SERVICE_ACCOUNT=/absolute/path/service-account.json`, or pass the
   JSON inline for a platform secret manager.
3. Set `FCM_ENABLED=true`.
4. Register device tokens through `POST /v1/devices`; tokens live in
   `notification_tokens`.

`src/services/fcm.ts` and `src/jobs/reminders.ts` implement the push path, but
there is no end-to-end FCM test yet. Until delivery is verified, do not claim
that a reminder was delivered.

SMS reminders are queued in `outbox` by the online process and sent by the
offline worker. Run `npm run dev:worker` (or the production worker process) or
SMS reminders remain queued.

## Africa's Talking sandbox

These steps apply to the current offline service. It uses the same Prisma
database and migrations as online; do not apply the retired SQL bootstrap.

1. Start `npm run dev` and `npm run dev:worker` in `backend/offline`.
2. Expose port 3001 over HTTPS:

```sh
ngrok http 3001
# or
cloudflared tunnel --url http://localhost:3001
```

3. Read `CALLBACK_TOKEN` from `.env` and configure the sandbox dashboard:

| Callback         | URL                                                                       |
| ---------------- | ------------------------------------------------------------------------- |
| Incoming SMS     | `https://<tunnel>/callbacks/africastalking/<CALLBACK_TOKEN>/sms/inbound`  |
| Delivery reports | `https://<tunnel>/callbacks/africastalking/<CALLBACK_TOKEN>/sms/delivery` |
| USSD session     | `https://<tunnel>/callbacks/africastalking/<CALLBACK_TOKEN>/ussd`         |
| USSD events      | `https://<tunnel>/callbacks/africastalking/<CALLBACK_TOKEN>/ussd/events`  |

4. Use the current `AT_SMS_FROM` and `AT_USSD_SERVICE_CODE` values. They must
   exactly match the sandbox channel/provisioned code. A mismatch returns 403.
5. Open the Africa's Talking simulator:
   <https://simulator.africastalking.com:1517/>. Sandbox interactions happen in
   the simulator, not on a handset.
6. Register a test number, text the configured shortcode, or dial the configured
   USSD code.

Suggested USSD path: dial, choose `1` (Find nearby care), choose `2` (Child
health), enter `Ikeja`. Emergency summary: dial, choose `2`, enter the demo
patient code `123456789012`. Emergency help: dial, choose `4`, enter `Ikeja` to
search live emergency hospitals and ambulance services (requires `SERPER_API_KEY`).

Suggested SMS: `HELP`, `FIND child health near Ikeja`, `LOOKUP 123456789012`,
`EMERGENCY near Ikeja`, `MORE`, `CANCEL`, `STOP`.

The Prisma seed creates reference fields/services, a real `Ikeja, Lagos` area
(`is_demo = false`) and an optional demo patient for sandbox auth
(`demo.patient@example.test` / `DemoPass123!`, patient code `123456789012`). It
does not create demo facilities. Directory and care-search results come from
approved non-demo facilities plus live Serper Maps leads. Live leads are
unverified contact information, never approved directory rows, and must not be
presented as verified facilities. Without `SERPER_API_KEY`, live search is
unavailable and only approved non-demo facilities can be returned.
`backend/offline/scripts/seed-demo.ts` writes the same reference area and demo
patient for offline sandbox testing; the online seed is the canonical setup step.

## Tests and CI

Unit tests that do not need a database:

```sh
npm run typecheck
npm run build
npm run test --workspace @healthaccess/shared
npm run test --workspace @healthaccess/offline
```

Current results: workspace typecheck is clean, shared tests pass 4/4 and the
offline unit suite passes 85/85.

Online feature tests are DB integration tests. They use PostgreSQL and the
Prisma client, so CI excludes them:

```sh
cd backend/online
node --env-file-if-exists=.env --test --import tsx tests/*.test.ts
```

The online suite covers schema, auth, users, portal, directory, emergency,
symptom, medications and reminders and currently passes 108 tests in the local
database.

The offline DB suite uses the Prisma schema and needs a disposable database:

```sh
createdb -h localhost -U <admin> healthaccess_test
cd backend/offline
TEST_DATABASE_URL='postgresql://<admin>:<password>@localhost:5432/healthaccess_test' npm run test:db
dropdb -h localhost -U <admin> healthaccess_test
```

Never point DB tests at the live database. The suite creates isolated fixtures
and must run with `--test-concurrency=1` (already set in `test:db`). It currently
passes 20/20 against the public Prisma schema.

CI is `.github/workflows/ci.yml`: Node 24, `npm ci`, Prisma generate, shared
build, typecheck, unit tests, and a docs/YAML sanity check. Dummy environment
values exist only to let build/typecheck/tests start without secrets. CI does not
provision PostgreSQL and does not run the DB integration suites.

## Troubleshooting

| Symptom                                                     | Check                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Online exits with `Missing required environment variable`   | `backend/online/.env` is missing or not loaded; fill every required variable              |
| `/health/ready` returns 503                                 | `DATABASE_URL`, database container, or Prisma migration state                             |
| Prisma `P1001` / connection refused                         | If using the included Postgres, check `docker compose ps postgres` and `docker compose logs migrate`; if using an external DB, its host must be reachable from the container and allow the Docker network. |
| `prisma migrate dev` says schema drift                      | You edited a migration or applied SQL outside Prisma; use a disposable DB and regenerate   |
| Offline readiness fails                                     | `DATABASE_URL`, migrations, or missing table grants; run `backend/online/scripts/grant-runtime.sql` |
| USSD callback 403                                           | Exact `AT_USSD_SERVICE_CODE` match; production IP allowlist                               |
| SMS callback 403                                            | `AT_SMS_FROM` vs inbound `to`; production IP allowlist                                    |
| Inbound SMS accepted but no reply                           | Worker is not running, outbox job failed, or the AT send failed                           |
| No callbacks after tunnel restart                           | The public URL changed; update every AT callback URL                                      |
| AI endpoint 503                                             | No configured provider key/model for the selected provider                                |
| Upload endpoint 503 `storage_unavailable`                   | S3/MinIO credentials, bucket, endpoint or path-style setting                              |
| Demo data does not appear                                   | `npm run db:seed` needs `CODE_DIGEST_KEY` and `DATA_ENCRYPTION_KEY`; check the seed output            |
| A legacy SQL script fails or creates unusable data          | `backend/database_structure.sql` and old schema scripts are retired; use Prisma migrations             |

## Production checklist

- Replace demo data with an approved, licensed directory and clinically reviewed
  content; keep provenance and review state.
- Provision real two-way SMS and USSD channels; confirm operator timeouts, menu
  limits, delivery reports and pricing.
- Configure `CALLBACK_ALLOWED_IPS` with confirmed provider egress ranges and keep
  `NODE_ENV=production` for offline.
- Use HTTPS for callbacks and verified TLS for the database. Never use the
  administrator URL at runtime.
- Use a least-privilege database login. The architecture does not rely on
  database roles for channel selection, but the login still must not be a
  superuser. The included compose uses the `healthaccess` owner account for
  simplicity; replace it with a dedicated login for production.
- Run Prisma migrations with `prisma migrate deploy` in a controlled job; back up
  before applying.
- Back up the database and both cryptographic keys securely. Changing keys is a
  migration.
- Approve third-party AI provider terms, retention/training settings, consent
  language and cross-border processing before enabling patient-context AI.
- Configure FCM service-account secrets through a secret manager, never in the
  repository.
- Add monitoring for callback errors, queue age, unknown sends, delivery
  failures, AI failures and FCM failures.
- Confirm retention, consent, data-protection and clinical-safety requirements
  for the pilot country.
- Test with real SIMs on supported networks with mobile data disabled.
- Voice is out of scope for this release.

## Known limitations

- Live FCM delivery is disabled (`FCM_ENABLED=false`); the reminder path is
  tested with fakes and push is a logged no-op until a service account is set.
- Symptom tests inject a fake AI agent. Real provider calls are not part of the
  automated suite, and model/provider behavior can change independently.
- The offline service and its Prisma integration suite pass, but real Africa's
  Talking sandbox/live delivery still needs operator provisioning and testing.
- Online tests are DB integration tests; there is no online unit suite yet.
- No frontend application is present.
- There is no approved production directory or clinically reviewed content.
- No admin UI for facility/service/content approval.
- Dockerfiles and a compose deployment (with PostgreSQL and Redis) exist, but
  there is no metrics, alerting or secret-manager integration yet.
- Africa's Talking behavior is covered by mocks/unit tests in this pass, not a
  live sandbox shortcode or handset. Provision and verify before a pilot.
- The callback secret path is defense in depth, not a provider HMAC. Production
  relies on confirmed provider IP ranges and HTTPS.
- The offline package pins overrides for vulnerable transitive dependencies in
  the Africa's Talking SDK; re-audit on dependency updates.
