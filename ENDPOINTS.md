# HealthAccess FastAPI: implemented endpoints

Base path `/api/v1`. Every response carries `X-Request-ID` and `Cache-Control: no-store`.

**Envelope.** Success: `{"data": ..., "meta": {"request_id", "api_version"}}`.
Error: `{"error": {"code", "message", "fields": [{"path","message"}]}, "meta": {...}}`.

**Auth model.** `ha_session` (HttpOnly) cookie + readable `ha_csrf` cookie. Every state-changing
call on an authenticated route must send `X-CSRF-Token` equal to the `ha_csrf` cookie, or it gets 403.
"Recent sign-in" = session created within the last 15 minutes, otherwise 403 `RECENT_SIGNIN_REQUIRED`.

## Auth
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /auth/register | public | `{email, password (10-128), display_name}`. Always creates a patient (role never read from the request), a profile, a 12-digit patient code, and `full_name`. 201 → account summary. Duplicate email → 409 (generic message). Does NOT sign in. |
| POST | /auth/login | public | `{email, password}`. Sets both cookies. Wrong email and wrong password give the same 401, with a dummy hash verify to even out timing. |
| POST | /auth/logout | session + CSRF | Revokes the session, clears cookies. 204. |
| GET | /auth/session | session | `{account: {id, email, roles, patient_id}, expires_at}` |

## Profile (patient only)
| Method | Path | Notes |
|---|---|---|
| GET | /me/profile | `{fields, preferred_language, home_area_id, version}`; `ETag` header = version. |
| PATCH | /me/profile | `If-Match` required (the ETag, quoted or not). Body `{fields: {key: value\|null}, preferred_language?, home_area_id?}`. `null` deletes a field (and its emergency selection). Values are checked against `field_definitions.value_schema`; unknown keys → 422. Row is locked; stale version → 412. Returns new profile + new ETag. |
| GET | /me/patient-code | Own permanent code (decrypted). |
| POST | /me/patient-code/rotate | Needs recent sign-in. New code; live grants and their read sessions are revoked in the same transaction. Audited. |

## Emergency summary (patient only)
| Method | Path | Notes |
|---|---|---|
| GET | /me/emergency-summary | `{field_keys, projection}`: exactly what a lookup would reveal. |
| PUT | /me/emergency-summary | `{field_keys: []}` replaces the selection atomically; empty list turns sharing off. Each key must be active, `emergency_eligible`, and already filled in, else 422. Audited. |

## Added by the `fastapi_next` patch (not in your branch yet)
| Method | Path | Notes |
|---|---|---|
| POST | /me/access-grants | Recent sign-in + `Idempotency-Key` header. `{field_keys, allowed_channels: ["web_practitioner"\|"ussd"], expires_in_seconds}` (900-86400). 201 returns the 8-digit `access_code` once. Same key + same body replays the response; same key + different body → 409. |
| GET | /me/access-grants | Cursor-paginated (`limit`, `cursor`). Status active/expired/revoked, field names, channels, expiry. No codes. |
| DELETE | /me/access-grants/{id} | Revokes grant + its read sessions. Idempotent, 204. Not yours → 404. |
| GET | /me/access-events | Cursor-paginated audit trail for your record: channel, action, result, field names. |
| POST | /records/emergency-lookups | Public, throttled. `{patient_code}` (12 digits) → emergency projection. Unknown code → generic 404, and the failed attempt is audited in a separate transaction. |

## Error codes in use
`UNAUTHENTICATED` 401 · `FORBIDDEN` / `RECENT_SIGNIN_REQUIRED` 403 · `NOT_FOUND` 404 · `CONFLICT` 409 ·
`STALE_VERSION` 412 · `VALIDATION_ERROR` 422 · `RATE_LIMITED` 429 (+`Retry-After`) · `INTERNAL_ERROR` 500
