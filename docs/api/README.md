# HealthAccess API reference

`index.html` is a self-contained, Postman-style reference for the online API. It
embeds the captured fixtures, the styles and the request runner, so it can be
opened directly or served by the API.

## Open it

- With the online API running: <http://localhost:3000/docs>
- With the compose stack: <http://localhost:8080> (the docs container proxies
  `/v1` to the online service)
- As a static file: open `docs/api/index.html`, or serve the folder with
  `python3 -m http.server 5173 -d docs/api` and open
  <http://localhost:5173>.

The Try It panel sends real requests. Serve the page from `localhost:3000/docs`
(same origin) or `localhost:5173` (allowed by the API CORS setting). A `file://`
page cannot send requests in most browsers.

## Rebuild

```sh
npm run docs:api
```

The build reads every `docs/api/fixtures/*.json` file, validates the contract in
[`FIXTURE-CONTRACT.md`](FIXTURE-CONTRACT.md), merges the groups by `order`, and
writes `docs/api/index.html`. If no fixtures exist it falls back to a small
built-in sample and prints a warning.

To add or update an endpoint, edit the owning fixture and rebuild. Do not edit
`index.html` by hand; it is generated.

## Demo data

The seeded demo patient works in the Try It panel:

```text
email:    demo.patient@example.test
password: DemoPass123!
code:     123456789012
```

Run `npm run db:seed` if the account is missing; in Docker use
`docker compose run --rm online npm run db:seed`. The login example uses these
credentials. Captured response examples use the demo account or cleared test
accounts, with `<access-jwt>` / `<refresh-token>` placeholders; they never contain
live tokens. When you run login yourself, the response viewer shows the real token
pair for that session. Treat it like a token from Postman and do not share
screenshots.

## What is included

| Group | Endpoints |
| --- | --- |
| Authentication and profile | register, login, forgot/reset password, refresh, logout, phone begin/confirm, me, medical, avatar, allergy/event edits |
| Patient portal and protected records | fields, emergency summary, patient code, grants, consents, access events, emergency/grant reads |
| Directory | services, areas, approved/non-demo facilities plus live Serper leads, facility/web-lead detail |
| Emergency | request live emergency search, list history, get one request |
| Symptom analysis | create, list, get, SSE stream, follow-up (+stream), update, delete |
| Medications and reminders | structured and AI creates, list, get, moments, add/remove, device registration, delete |

Error examples cover the validation, auth, role, ownership, conflict and
storage-unavailable paths captured from the running service.
