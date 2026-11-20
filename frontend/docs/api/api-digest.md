# HealthAccess API digest

Generated from the live docs page (`window.__API_DOCS__`), snapshot generatedAt 2026-11-17T18:00:33.068Z, 48 endpoints.

- Docs: http://healthaccess.billzpay.com.ng/docs
- Base URL: https://healthaccess.billzpay.com.ng/v1. Browser code never calls it directly: it goes through our Next BFF at `/api/v1` (scope.md §2). The API's CORS only allows https://healthaccess.vercel.app.
- Full request/response examples: `healthaccess-api.json` in this folder. This digest truncates long example bodies.
- Errors are `{error, message, request_id}`; validation errors add `issues: [{path, message}]`. There is no `{data, meta}` envelope.


## Authentication and profile

Account registration, session tokens, the authenticated profile, phone verification and medical-record editing. All /me endpoints require a Bearer access token.

### `POST /auth/register`

Auth: none · Content-Type: application/json

Creates an ACTIVE account, assigns the PATIENT role, creates a patient profile and optionally stores date_of_birth as a field value. Email is trimmed and lower-cased. A duplicate email returns 409 email_taken.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `firstName` | string | yes | 1-100 characters after trimming. |
| body | `lastName` | string | yes | 1-100 characters after trimming. |
| body | `email` | string | yes | Valid email, max 320 characters. Stored lower-case. |
| body | `password` | string | yes | 8-128 characters. |
| body | `password_confirmation` | string | yes | Must match password. |
| body | `dob` | string |  | ISO date; stored as a date_of_birth field value when the definition exists. |
| body | `phone` | string |  | E.164 phone, for example +2348012345678. Only the phone digest is stored. |

Body example:

```json
{
 "firstName": "Ada",
 "lastName": "Okafor",
 "email": "ada.okafor@example.test",
 "password": "DemoPass123!",
 "password_confirmation": "DemoPass123!",
 "dob": "1990-05-12",
 "phone": "+2348012345678"
}
```

Responses:

- **201 Created**: Account, assigned roles and a fresh token pair.  
  `{"account":{"id":"d2e6b647-3603-4b55-80e7-cf6c67f5816b","email":"ada.okafor@example.test","display_name":"Ada Okafor","status":"ACTIVE","idp_subject":null,"avatar_key":null,"email_verified_at":null,"phone_verified_at":null,"created_at":"2026-11-17T16:19:13.699Z","updated_at":"2026-11-17T16:19:13.699Z"},"roles":["PATIENT"],"tokens":{"access_token":"<access-jwt>","refresh_token":"<refresh-token>","token_type":"Bearer","expires_in":900,"refresh_expires_in":2591999}}`
- **400 Bad Request**: Zod validation issues, one entry per invalid field.  
  `{"error":"validation_error","request_id":"52ad4de1-917b-4f0c-a43a-a463d201524e","issues":[{"path":"firstName","message":"String must contain at least 1 character(s)"},{"path":"lastName","message":"String must contain at least 1 character(s)"},{"path":"email","message":"Invalid email"},{"path":"password","message":"String must contain at least 8 character(s)"},{"path":"password_confirmation","message":"Passwords do not match"}]}`
- **409 Conflict**: The email is already registered.  
  `{"error":"email_taken","message":"This email is already registered","request_id":"5018c51d-fe57-4354-b054-52f7d4207c7b"}`
- Note: Access tokens expire in 900 seconds; refresh tokens expire in about 30 days.
- Note: The access token is a JWT whose roles are read from the database on every request.

### `POST /auth/login`

Auth: none · Content-Type: application/json

Looks up the account by lower-cased email, verifies the bcrypt password hash and issues a new session. Returns 401 invalid_credentials for an unknown email or bad password and 403 account_inactive for a non-ACTIVE account.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `email` | string | yes | Registered email; trimmed and lower-cased. |
| body | `password` | string | yes | 1-128 characters. |

Body example:

```json
{
 "email": "demo.patient@example.test",
 "password": "DemoPass123!"
}
```

Responses:

- **200 OK**: Account summary for the seeded demo patient, current roles and a new token pair. Tokens are placeholders.  
  `{"account":{"id":"20000000-0000-4000-8000-000000000004","email":"demo.patient@example.test","display_name":"Demo Patient","status":"ACTIVE","idp_subject":null,"avatar_key":null,"email_verified_at":null,"phone_verified_at":null,"created_at":"2026-11-17T15:43:52.132Z","updated_at":"2026-11-17T16:02:02.106Z"},"roles":["PATIENT"],"tokens":{"access_token":"<access-jwt>","refresh_token":"<refresh-token>","token_type":"Bearer","expires_in":900,"refresh_expires_in":2591999}}`
- **401 Unauthorized**: Unknown email or wrong password; the message is intentionally identical for both.  
  `{"error":"invalid_credentials","message":"Invalid email or password","request_id":"e3582fea-334b-4688-a9ca-a6e6f7553b87"}`
- Note: Uses the seeded demo patient (demo.patient@example.test). Run npm run db:seed if the account is missing.
- Note: Roles in the access token are the roles returned by this call.
- Note: The 200 example shows the demo account; captured access and refresh tokens are replaced with placeholders.

### `POST /auth/refresh`

Auth: none · Content-Type: application/json

Refresh tokens are single-use: a successful call replaces the stored hash, so the submitted refresh token can no longer be used. Returns 401 invalid_refresh_token when the token is unknown, revoked, expired or the account is not ACTIVE.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `refresh_token` | string | yes | Opaque refresh token from register/login/refresh. |

Body example:

```json
{
 "refresh_token": "<refresh-token>"
}
```

Responses:

- **200 OK**: A new token pair; the previous refresh token is invalidated.  
  `{"tokens":{"access_token":"<access-jwt>","refresh_token":"<refresh-token>","token_type":"Bearer","expires_in":900,"refresh_expires_in":2591999}}`
- Note: Persist the returned refresh_token immediately; the submitted one stops working.

### `POST /auth/logout`

Auth: none · Content-Type: application/json

Marks the session matching the refresh token as revoked. The call returns 204 whether or not a matching active session existed. Access tokens for the revoked session stop passing requireAuth immediately because the session is checked on every request.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `refresh_token` | string | yes | Refresh token to revoke. |

Body example:

```json
{
 "refresh_token": "<refresh-token>"
}
```

Responses:

- **204 No Content**: Session revoked; the response has no body.  
  `null`
- Note: Drop both tokens client-side after this call.

### `GET /me`

Auth: bearer · Content-Type: application/json

Loads the account summary, roles, patient profile metadata, flattened field_values, the field list with labels and value types, allergy records, medical events and a presigned avatar_url when storage is configured.

Responses:

- **200 OK**: Current account, profile and medical data.  
  `{"account":{"id":"d2e6b647-3603-4b55-80e7-cf6c67f5816b","email":"ada.okafor@example.test","display_name":"Ada Okafor","status":"ACTIVE","idp_subject":null,"avatar_key":null,"email_verified_at":null,"phone_verified_at":null,"created_at":"2026-11-17T16:19:13.699Z","updated_at":"2026-11-17T16:19:13.699Z"},"roles":["PATIENT"],"profile":{"id":"6b7acfa2-c66d-4c22-a0e9-11e496d12080","preferred_language":"en","home_area_id":null,"version":1,"created_at":"2026-11-17T16:19:13.701Z","updated_at":"2026-11-17T16:19:13.701Z"},"fields":[{"key":"date_of_birth","label":"Date of birth","value_type":"STRING","va …`
- Note: field_values is a convenience map of field key to stored JSON value; fields carries labels and types.
- Note: avatar_url is null when no avatar is stored or S3 is not configured.

### `PATCH /me`

Auth: bearer · Content-Type: application/json

Updates the account display name from firstName/lastName, email, phone digest, password and any provided patient fields. Only field keys present in field_definitions are written, so city/state/country are silently skipped when no definition exists. Returns the full profile payload.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `firstName` | string |  | Updates display_name and full_name. |
| body | `lastName` | string |  | Updates display_name and full_name. |
| body | `email` | string |  | New unique email; clears email_verified_at when changed. |
| body | `phone` | string |  | E.164 phone; clears phone_verified_at when the digest changes. |
| body | `dob` | string |  | ISO date stored as date_of_birth. |
| body | `city` | string |  | Stored only when a matching field definition exists. |
| body | `state` | string |  | Stored only when a matching field definition exists. |
| body | `country` | string |  | Stored only when a matching field definition exists. |
| body | `password` | string |  | 8-128 characters; rehashed with bcrypt. |

Body example:

```json
{
 "firstName": "Ada",
 "lastName": "Okafor",
 "city": "Ikeja",
 "state": "Lagos",
 "country": "Nigeria"
}
```

Responses:

- **200 OK**: The full profile payload after the patch.  
  `{"account":{"id":"d2e6b647-3603-4b55-80e7-cf6c67f5816b","email":"ada.okafor@example.test","display_name":"Ada Okafor","status":"ACTIVE","idp_subject":null,"avatar_key":null,"email_verified_at":null,"phone_verified_at":null,"created_at":"2026-11-17T16:19:13.699Z","updated_at":"2026-11-17T16:19:13.699Z"},"roles":["PATIENT"],"profile":{"id":"6b7acfa2-c66d-4c22-a0e9-11e496d12080","preferred_language":"en","home_area_id":null,"version":1,"created_at":"2026-11-17T16:19:13.701Z","updated_at":"2026-11-17T16:19:13.701Z"},"fields":[{"key":"date_of_birth","label":"Date of birth","value_type":"STRING","va …`
- Note: Returns 409 email_taken when the new email belongs to another account.

### `PUT /me/medical`

Auth: bearer · Content-Type: application/json

Writes height, weight, gender, blood type, genotype, blood pressure, conditions, medications and emergency contacts as field values. When allergies or medicalEvents are arrays they replace all existing rows for the patient. Severity is normalised to MILD, MODERATE or SEVERE. Returns the full profile payload.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `height` | string | number |  | Stored as the height field value. |
| body | `weight` | string | number |  | Stored as the weight field value. |
| body | `gender` | string |  | Max 200 characters. |
| body | `bloodType` | string |  | Stored under the blood_group field key. |
| body | `genoType` | string |  | Stored under the genotype field key. |
| body | `bloodPressure` | string |  | Stored under blood_pressure. |
| body | `existingMedicalConditions` | string | string[] |  | Stored under conditions. |
| body | `existingMedications` | string | string[] |  | Stored under current_medications. |
| body | `emergencyContactName` | string |  | Max 200 characters. |
| body | `emergencyContactPhone` | string |  | Max 200 characters. |
| body | `allergies` | object[] |  | Array of {name, severity?, diagnosisDate?}; replaces all allergy rows. |
| body | `medicalEvents` | object[] |  | Array of {name, recoveryTime?, occurredOn?/date?, description?}; replaces all event rows. |

Body example:

```json
{
 "height": 170,
 "weight": 68,
 "gender": "Female",
 "bloodType": "O+",
 "genoType": "AA",
 "bloodPressure": "118/76",
 "existingMedicalConditions": [
  "Hypertension"
 ],
 "existingMedications": [
  "Amlodipine 5mg daily"
 ],
 "emergencyContactName": "Ngozi Okafor",
 "emergencyContactPhone": "+2348012345679",
 "allergies": [
  {
   "name": "Penicillin",
   "severity": "severe",
   "diagnosisDate": "2015-06-01"
  },
  {
   "name": "Peanuts",
   "severity": "MILD"
  }
 ],
 "medicalEvents": [
  {
   "name": "Appendectomy",
   "recoveryTime": "2 weeks",
   "occurredOn": "2019-03-14",
   "description": "Laparoscopic appendectomy, no complications."
  },
  {
   "name": "Malaria",
   "recoveryTime": "5 days",
   "occurredOn": "2022-08-02",
   "description": "Treated with artemether-lumefantrine."
  }
 ]
}
```

Responses:

- **200 OK**: The full profile payload with the new allergies and medical events.  
  `{"account":{"id":"d2e6b647-3603-4b55-80e7-cf6c67f5816b","email":"ada.okafor@example.test","display_name":"Ada Okafor","status":"ACTIVE","idp_subject":null,"avatar_key":null,"email_verified_at":null,"phone_verified_at":null,"created_at":"2026-11-17T16:19:13.699Z","updated_at":"2026-11-17T16:19:13.699Z"},"roles":["PATIENT"],"profile":{"id":"6b7acfa2-c66d-4c22-a0e9-11e496d12080","preferred_language":"en","home_area_id":null,"version":1,"created_at":"2026-11-17T16:19:13.701Z","updated_at":"2026-11-17T16:19:13.701Z"},"fields":[{"key":"blood_group","label":"Blood group","value_type":"STRING","value" …`
- Note: Omitted arrays leave existing allergy/event rows untouched; empty arrays delete them.

### `POST /me/avatar`

Auth: bearer · Content-Type: multipart/form-data

Accepts one image field, resizes it to 500px wide WebP and stores it in S3. This environment has no S3 credentials configured, so the endpoint returns 503 storage_unavailable before reading the file. A missing file returns 400 image_required when storage is configured.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `image` | file | yes | Image file up to 5 MB. |

Responses:

- **503 Service Unavailable**: Object storage is not configured in this environment.  
  `{"error":"storage_unavailable","message":"File storage is not configured","request_id":"234280c0-1b4e-42b1-9802-c978d7f7d132"}`
- Note: Success response when storage is configured: { "avatar_key": "avatars/<account-id>.webp", "avatar_url": "<presigned-url>" }.
- Note: Multer errors are reported as 400 invalid_upload.

### `DELETE /me/allergies/{id}`

Auth: bearer · Content-Type: application/json

Deletes the allergy only when it belongs to the current patient. Returns 404 not_found otherwise.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Allergy id from GET /me or PUT /me/medical. |

Responses:

- **204 No Content**: Allergy removed; no body.  
  `null`
- Note: Use the allergy id captured from the preceding GET /me response.

### `DELETE /me/medical-events/{id}`

Auth: bearer · Content-Type: application/json

Deletes the event only when it belongs to the current patient. Returns 404 not_found otherwise.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Medical event id from GET /me or PUT /me/medical. |

Responses:

- **204 No Content**: Medical event removed; no body.  
  `null`
- Note: Use the event id captured from the preceding GET /me response.

### `PATCH /me/medical-events/{id}`

Auth: bearer · Content-Type: application/json

Updates name, recoveryTime, occurredOn/date and description on an event owned by the current patient. An empty patch returns 400 no_changes. Returns { event } with the updated row.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Medical event id. |
| body | `name` | string |  | 1-100 characters. |
| body | `recoveryTime` | string |  | Max 200 characters; null clears it. |
| body | `occurredOn` | string |  | ISO date; alias date is also accepted. |
| body | `description` | string |  | Max 4000 characters; null clears it. |

Body example:

```json
{
 "name": "Appendectomy (updated)",
 "recoveryTime": "3 weeks",
 "description": "Laparoscopic appendectomy; extended recovery recorded during capture."
}
```

Responses:

- **200 OK**: The updated medical event.  
  `{"event":{"id":"f65c5648-6f40-4307-bd06-21e4a8174137","patient_id":"6b7acfa2-c66d-4c22-a0e9-11e496d12080","name":"Appendectomy (updated)","recovery_time":"3 weeks","occurred_on":"2019-03-14T00:00:00.000Z","description":"Laparoscopic appendectomy; extended recovery recorded during capture.","created_at":"2026-11-17T16:19:14.308Z","updated_at":"2026-11-17T16:19:14.341Z"}}`
- Note: An empty object returns 400 no_changes.

### `POST /auth/phone/begin`

Auth: bearer · Content-Type: application/json

Consumes any previous unconsumed PHONE_VERIFICATION challenge for the account, creates a new challenge with a 10-minute expiry and queues the SMS through the outbox. The code is never returned by the API.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `phone` | string | yes | E.164 phone, 8-15 digits after the plus. |

Body example:

```json
{
 "phone": "+2348012345678"
}
```

Responses:

- **200 OK**: Code queued; expires_in is 600 seconds.  
  `{"status":"sent","expires_in":600}`
- Note: Returns 503 sms_unavailable if the outbox write fails.

### `POST /auth/phone/confirm`

Auth: bearer · Content-Type: application/json

Checks the latest unconsumed challenge for the phone digest. A correct code marks the account phone as verified and creates or reactivates a ChannelLink for the patient. A wrong code increments attempts and returns 400 invalid_code; after five attempts the challenge is unusable.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `phone` | string | yes | Same E.164 phone used in /auth/phone/begin. |
| body | `code` | string | yes | Six digits from the queued SMS. |

Body example:

```json
{
 "phone": "+2348012345678",
 "code": "<otp-code>"
}
```

Responses:

- **200 OK**: Phone verified and channel link created.  
  `{"verified":true,"phone_verified_at":"2026-11-17T16:19:14.390Z"}`
- **400 Bad Request**: Wrong, expired or exhausted verification code.  
  `{"error":"invalid_code","message":"Invalid or expired verification code","request_id":"22d9449b-5ca4-4e4e-802b-cd61d64aaf0a"}`
- Note: OTP values are only available in the SMS outbox and must never be returned to clients.
- Note: A verified phone is required before SMS/USSD consent endpoints can create a consent.

## Patient portal and protected records

Patient-controlled field sharing, emergency profile, patient codes, access grants, consent channels, audit history and practitioner record access.

### `GET /me/fields`

Auth: bearer · Content-Type: application/json

Lists active field definitions ordered by sort_order and field_key. value and field_version are null when the patient has not stored that field. version is the patient profile version used for optimistic concurrency.

Responses:

- **200 OK**: Profile version plus all active fields.  
  `{"version":2,"fields":[{"key":"full_name","label":"Name","value_type":"STRING","emergency_eligible":true,"sort_order":10,"value":"Bola Adeyemi","field_version":1},{"key":"date_of_birth","label":"Date of birth","value_type":"STRING","emergency_eligible":true,"sort_order":20,"value":"1994-11-03","field_version":2},{"key":"allergies","label":"Allergies","value_type":"STRING_ARRAY","emergency_eligible":true,"sort_order":30,"value":["Penicillin"],"field_version":1},{"key":"current_medications","label":"Medications","value_type":"STRING_ARRAY","emergency_eligible":true,"sort_order":40,"value":["Para …`
- Note: Send the returned version as expected_version on the next write.

### `PUT /me/fields`

Auth: bearer · Content-Type: application/json

Every key must be an active field definition and no value may be null. The patient profile version is incremented only when expected_version matches, otherwise 409 version_conflict is returned. Returns the full field state after the write.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `fields` | object | yes | Map of field_key to non-null JSON value. |
| body | `expected_version` | integer | yes | Current patient profile version; non-negative. |

Body example:

```json
{
 "fields": {
  "full_name": "Bola Adeyemi",
  "date_of_birth": "1994-11-03",
  "allergies": [
   "Penicillin"
  ],
  "current_medications": [
   "Paracetamol as needed"
  ],
  "conditions": [
   "Asthma"
  ],
  "blood_group": "O+",
  "emergency_contact_name": "Tunde Adeyemi",
  "emergency_contact_phone": "+2348098765433",
  "weight": "64",
  "height": "168",
  "gender": "Female"
 },
 "expected_version": 1
}
```

Responses:

- **200 OK**: The full field state with the incremented version.  
  `{"version":2,"fields":[{"key":"full_name","label":"Name","value_type":"STRING","emergency_eligible":true,"sort_order":10,"value":"Bola Adeyemi","field_version":1},{"key":"date_of_birth","label":"Date of birth","value_type":"STRING","emergency_eligible":true,"sort_order":20,"value":"1994-11-03","field_version":2},{"key":"allergies","label":"Allergies","value_type":"STRING_ARRAY","emergency_eligible":true,"sort_order":30,"value":["Penicillin"],"field_version":1},{"key":"current_medications","label":"Medications","value_type":"STRING_ARRAY","emergency_eligible":true,"sort_order":40,"value":["Para …`
- Note: 400 invalid_fields when fields is empty, 400 invalid_value for null values, 400 invalid_field for unknown or inactive keys.
- Note: 409 version_conflict when expected_version is stale.

### `PUT /me/emergency-fields`

Auth: bearer · Content-Type: application/json

Each key must be unique, active, emergency_eligible and already have a stored value. The write replaces the whole emergency field list and increments the patient profile version when expected_version matches.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `field_keys` | string[] | yes | Up to 50 unique emergency-eligible field keys with stored values. |
| body | `expected_version` | integer | yes | Current patient profile version. |

Body example:

```json
{
 "field_keys": [
  "full_name",
  "allergies",
  "current_medications",
  "blood_group",
  "emergency_contact_name"
 ],
 "expected_version": 2
}
```

Responses:

- **200 OK**: The new profile version and ordered field keys.  
  `{"version":3,"field_keys":["full_name","allergies","current_medications","blood_group","emergency_contact_name"]}`
- Note: 400 invalid_field when a key is duplicated, inactive, not emergency-eligible or has no stored value.

### `GET /me/emergency-summary`

Auth: bearer · Content-Type: application/json

Returns the current profile version, the ordered emergency field keys and the projected key, label and value for each field. available is false when no emergency fields are configured.

Responses:

- **200 OK**: Emergency projection preview.  
  `{"available":true,"version":3,"field_keys":["full_name","allergies","current_medications","blood_group","emergency_contact_name"],"fields":[{"key":"full_name","label":"Name","value":"Bola Adeyemi"},{"key":"allergies","label":"Allergies","value":["Penicillin"]},{"key":"current_medications","label":"Medications","value":["Paracetamol as needed"]},{"key":"blood_group","label":"Blood group","value":"O+"},{"key":"emergency_contact_name","label":"Contact name","value":"Tunde Adeyemi"}]}`

### `GET /me/patient-code`

Auth: bearer · Content-Type: application/json

Creates a patient code on first use. The code is stored encrypted and only its digest is indexed. code_version increments on every rotation.

Responses:

- **200 OK**: The current code, version and last rotation time.  
  `{"available":true,"code":"<patient-code>","code_version":1,"rotated_at":"2026-11-17T16:19:14.675Z"}`
- Note: The example replaces the live code with <patient-code>; the real value is 12 numeric digits.

### `POST /me/patient-code/rotate`

Auth: bearer · Content-Type: application/json

Increments code_version, replaces the digest and ciphertext, and revokes every active access grant and read session for the patient. Returns the new code, which must be shared again with practitioners.

Responses:

- **200 OK**: New code and incremented code_version.  
  `{"available":true,"code":"<patient-code>","code_version":2,"rotated_at":"2026-11-17T16:19:14.682Z"}`
- Note: All outstanding grant codes and read sessions stop working immediately.

### `GET /me/grants`

Auth: bearer · Content-Type: application/json

Returns grant id/grant_id, derived status (active, expired or revoked), expiry, revocation time, creation time, sorted field keys and channels. limit is clamped to 1-100 and defaults to 50.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| query | `limit` | integer |  | 1-100; values outside the range are clamped. |

Responses:

- **200 OK**: Active and revoked grants.  
  `[{"id":"e8688af7-ccef-4b28-9776-df8ed14a812f","grant_id":"e8688af7-ccef-4b28-9776-df8ed14a812f","status":"revoked","expires_at":"2026-11-17T16:34:15.179Z","revoked_at":"2026-11-17T16:19:15.189Z","created_at":"2026-11-17T16:19:15.180Z","field_keys":["full_name"],"channels":["USSD","WEB_PRACTITIONER"]},{"id":"a9234d39-2af2-4d99-a964-9a6565fae4f7","grant_id":"a9234d39-2af2-4d99-a964-9a6565fae4f7","status":"active","expires_at":"2026-11-17T16:49:14.735Z","revoked_at":null,"created_at":"2026-11-17T16:19:14.736Z","field_keys":["allergies","blood_group","current_medications","full_name"],"channels":[ …`
- Note: status is computed at read time from revoked_at and expires_at.

### `POST /me/grants`

Auth: bearer · Content-Type: application/json

Validates that every field key is active, de-duplicates keys and channels, and creates an access grant with an 8-digit numeric code. The code is returned once in this response and is only stored as a digest. expires_in_minutes defaults to 30 and is capped at 1440.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `field_keys` | string[] | yes | 1-50 active field keys. |
| body | `channels` | string[] |  | Subset of WEB_PRACTITIONER and USSD; defaults to ["WEB_PRACTITIONER"]. |
| body | `expires_in_minutes` | integer |  | 1-1440; defaults to 30. |

Body example:

```json
{
 "field_keys": [
  "full_name",
  "allergies",
  "current_medications",
  "blood_group"
 ],
 "channels": [
  "WEB_PRACTITIONER"
 ],
 "expires_in_minutes": 30
}
```

Responses:

- **201 Created**: Grant metadata and the one-time grant code.  
  `{"available":true,"id":"a9234d39-2af2-4d99-a964-9a6565fae4f7","grant_id":"a9234d39-2af2-4d99-a964-9a6565fae4f7","code":"<grant-code>","expires_at":"2026-11-17T16:49:14.735Z","created_at":"2026-11-17T16:19:14.736Z","field_keys":["full_name","allergies","current_medications","blood_group"],"channels":["WEB_PRACTITIONER"]}`
- Note: The example replaces the live grant code with <grant-code>; the real value is 8 numeric digits.
- Note: 400 invalid_field when any key is unknown or inactive.

### `DELETE /me/grants/{id}`

Auth: bearer · Content-Type: application/json

Marks the grant revoked, increments its version and revokes every read session created from it. Returns 404 not_found when the grant does not belong to the patient.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Grant id from POST or GET /me/grants. |

Responses:

- **200 OK**: The grant is revoked.  
  `{"available":true,"revoked":true,"id":"e8688af7-ccef-4b28-9776-df8ed14a812f"}`
- Note: Revocation is idempotent from the client point of view; the endpoint reports revoked true.

### `GET /me/access-events`

Auth: bearer · Content-Type: application/json

Lists audit events whose patient_id is the current patient. Each entry exposes the channel, action, outcome, optional reason_code, resource type/id and affected field keys. limit is clamped to 1-100 and defaults to 50.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| query | `limit` | integer |  | 1-100; values outside the range are clamped. |

Responses:

- **200 OK**: Audit events for the current patient.  
  `[{"id":"417","occurred_at":"2026-11-17T16:19:15.193Z","channel":"WEB","action":"grant_revoke","outcome":"ALLOWED","reason_code":null,"resource_type":"access_grant","resource_id":"e8688af7-ccef-4b28-9776-df8ed14a812f","field_keys":[]},{"id":"416","occurred_at":"2026-11-17T16:19:15.184Z","channel":"WEB","action":"grant_create","outcome":"ALLOWED","reason_code":null,"resource_type":"access_grant","resource_id":"e8688af7-ccef-4b28-9776-df8ed14a812f","field_keys":["full_name"]},{"id":"415","occurred_at":"2026-11-17T16:19:15.161Z","channel":"WEB","action":"grant_read","outcome":"ALLOWED","reason_cod …`
- Note: id is a decimal string because audit ids are big integers.

### `PUT /me/consents/{channel}`

Auth: bearer · Content-Type: application/json

Requires an active ChannelLink for the patient. phone_link_id may select a specific link, otherwise the newest active link is used. Replaces the consent field list, reactivates a revoked consent and increments its version. expires_in_minutes defaults to 30 days.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `channel` | string | yes | SMS or USSD, case-insensitive. |
| body | `phone_link_id` | uuid |  | Specific active ChannelLink; defaults to the newest active link. |
| body | `field_keys` | string[] | yes | 1-50 active field keys. |
| body | `expires_in_minutes` | integer |  | 1-525600; defaults to 43200 (30 days). |

Body example:

```json
{
 "phone_link_id": "d78eee1c-b9ec-4867-896e-d69cfcd1a1d1",
 "field_keys": [
  "full_name",
  "allergies"
 ],
 "expires_in_minutes": 1440
}
```

Responses:

- **200 OK**: Consent metadata and version.  
  `{"available":true,"consent_id":"19d688bc-8a55-4104-808c-e6a624254512","channel":"SMS","phone_link_id":"d78eee1c-b9ec-4867-896e-d69cfcd1a1d1","expires_at":"2026-11-18T16:19:14.710Z","version":1,"field_keys":["full_name","allergies"]}`
- **400 Bad Request**: No active ChannelLink exists for the patient.  
  `{"error":"channel_link_required","message":"An active channel link is required for this consent","request_id":"063d12a5-d0c2-43e2-b3db-85ae23f8cff1"}`
- Note: 400 invalid_channel for anything other than SMS/USSD.
- Note: Complete /auth/phone/begin and /auth/phone/confirm first to create a ChannelLink.

### `DELETE /me/consents/{channel}`

Auth: bearer · Content-Type: application/json

Marks the active consent for the channel as revoked and increments its version. Returns available true and revoked true even when no active consent existed.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `channel` | string | yes | SMS or USSD, case-insensitive. |

Responses:

- **200 OK**: Consent revoked.  
  `{"available":true,"revoked":true}`
- Note: 400 invalid_channel for unsupported channels.

### `POST /records/emergency`

Auth: bearer · Content-Type: application/json

Any authenticated account can attempt an emergency read. A valid 12-digit code returns the ordered emergency projection. Invalid, unknown or unconfigured codes return 200 with available false. Five denied attempts in ten minutes throttle the account and also return available false.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `patient_code` | string | yes | 1-32 characters; must be 12 digits to match. |

Body example:

```json
{
 "patient_code": "123456789012"
}
```

Responses:

- **200 OK**: Emergency projection for the demo patient.  
  `{"available":true,"fields":[{"key":"allergies","label":"Allergies","value":["Penicillin (demo)"]},{"key":"emergency_contact_name","label":"Contact name","value":"Chika (demo contact)"}]}`
- Note: Denied and throttled reads are audited and return { "available": false } with status 200.
- Note: The demo patient code 123456789012 is public demo data.

### `POST /records/grant/open`

Auth: bearer · roles: PRACTITIONER · Content-Type: application/json

Requires the PRACTITIONER role and an APPROVED practitioner_profiles row; otherwise 403 forbidden. Validates the patient code and an active, unrevoked, unexpired grant that includes the WEB_PRACTITIONER channel. Creates or refreshes a read session capped at 15 minutes and at the grant expiry, then returns the field projection with grant_id, read_session_id and expires_at.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `patient_code` | string | yes | 12-digit patient code shared by the patient. |
| body | `grant_code` | string | yes | 8-digit grant code returned by POST /me/grants. |

Body example:

```json
{
 "patient_code": "<patient-code>",
 "grant_code": "<grant-code>"
}
```

Responses:

- **200 OK**: Projection plus grant and read-session identifiers.  
  `{"available":true,"fields":[{"key":"full_name","label":"Name","value":"Bola Adeyemi"},{"key":"allergies","label":"Allergies","value":["Penicillin"]},{"key":"current_medications","label":"Medications","value":["Paracetamol as needed"]},{"key":"blood_group","label":"Blood group","value":"O+"}],"grant_id":"a9234d39-2af2-4d99-a964-9a6565fae4f7","read_session_id":"d457acda-c7c8-46da-916e-1413e237af9a","expires_at":"2026-11-17T16:34:15.142Z"}`
- **403 Forbidden**: The caller is not an approved practitioner.  
  `{"error":"forbidden","message":"Practitioner access required","request_id":"55325b3b-9545-4113-96ae-7593920039b3"}`
- **400 Bad Request**: Required body fields are missing.  
  `{"error":"validation_error","request_id":"a75ea4a4-7094-47c7-b53f-1fbedecf242c","issues":[{"path":"patient_code","message":"Required"},{"path":"grant_code","message":"Required"}]}`
- Note: Invalid codes, unknown patients, unavailable grants or the wrong channel return 200 with { "available": false }.
- Note: Five denied attempts in ten minutes throttle the practitioner and return available false.

### `GET /records/grant/{id}`

Auth: bearer · roles: PRACTITIONER · Content-Type: application/json

The read session must belong to the current account and auth session, be unrevoked and unexpired, and its grant must still be live. Returns the projection with grant_id, read_session_id and the earlier of the session and grant expiry. Returns available false when the session is no longer usable.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | read_session_id returned by /records/grant/open. |

Responses:

- **200 OK**: The same projection as the open call.  
  `{"available":true,"fields":[{"key":"full_name","label":"Name","value":"Bola Adeyemi"},{"key":"allergies","label":"Allergies","value":["Penicillin"]},{"key":"current_medications","label":"Medications","value":["Paracetamol as needed"]},{"key":"blood_group","label":"Blood group","value":"O+"}],"grant_id":"a9234d39-2af2-4d99-a964-9a6565fae4f7","read_session_id":"d457acda-c7c8-46da-916e-1413e237af9a","expires_at":"2026-11-17T16:34:15.142Z"}`
- Note: The auth session id is part of the lookup, so logging out invalidates the read session.

### `POST /records/grant/{id}/close`

Auth: bearer · roles: PRACTITIONER · Content-Type: application/json

Finds the read session for the current account and auth session and marks it revoked. Repeated calls return the original revoked_at. Returns 404 not_found when the session does not belong to the caller.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | read_session_id returned by /records/grant/open. |

Responses:

- **200 OK**: The read session is closed.  
  `{"closed":true,"read_session_id":"d457acda-c7c8-46da-916e-1413e237af9a","revoked_at":"2026-11-17T16:19:15.167Z"}`

## Directory

Public directory of active services, Nigerian areas and approved facilities. No authentication required.

### `GET /directory/services`

Auth: none · Content-Type: application/json

Returns active services ordered by sort_order and service_code.

Responses:

- **200 OK**: Active services.  
  `[{"service_code":"general","label":"General care","description":"General outpatient and primary care"},{"service_code":"pediatrics","label":"Child health","description":"Child and paediatric care"},{"service_code":"maternity","label":"Maternity care","description":"Pregnancy and maternity care"}]`

### `GET /directory/areas`

Auth: none · Content-Type: application/json

Exact matches are returned before prefix matches, de-duplicated by id. Only active NG areas are considered. limit is clamped to 1-10 and defaults to 5.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| query | `q` | string |  | Search term, max 120 characters. Omit to list the first areas alphabetically. |
| query | `limit` | integer |  | 1-10; values outside the range are clamped. |

Responses:

- **200 OK**: Matching areas.  
  `[{"id":"20000000-0000-4000-8000-000000000001","name":"Ikeja demo area","region":"Lagos","city":"Ikeja","is_demo":true}]`

### `GET /directory/facilities`

Auth: none · Content-Type: application/json

Requires service and area_id. Approved facilities with an approved service entry are measured from the area centre and filtered by radius_km. Results are sorted by distance then name. limit is clamped to 1-10 and defaults to 3; radius_km is clamped to 1-200 and defaults to 25.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| query | `service` | string | yes | Service code such as general, pediatrics or maternity. |
| query | `area_id` | uuid | yes | Area id from /directory/areas. |
| query | `radius_km` | number |  | Positive radius, clamped to 1-200 km. |
| query | `limit` | integer |  | 1-10; values outside the range are clamped. |

Responses:

- **200 OK**: Matching facilities with distance_km.  
  `[{"id":"20000000-0000-4000-8000-000000000002","name":"Demo Community Hospital","address":"12 Example Road, Ikeja","phone":null,"distance_km":0.385,"is_demo":true,"service_code":"general"},{"id":"20000000-0000-4000-8000-000000000003","name":"Demo Child Health Clinic","address":"8 Sample Street, Ikeja","phone":null,"distance_km":0.547,"is_demo":true,"service_code":"general"}]`
- **400 Bad Request**: Both required query parameters are missing.  
  `{"error":"validation_error","request_id":"6749034b-4ba4-46cb-a457-512fe48cc55c","issues":[{"path":"service","message":"Required"},{"path":"area_id","message":"Required"}]}`
- **400 Bad Request**: area_id is missing.  
  `{"error":"validation_error","request_id":"ab05a6b6-60e4-472c-aa0b-ffe7a8440e32","issues":[{"path":"area_id","message":"Required"}]}`
- Note: Unknown area ids return an empty array, not 404.

### `GET /directory/facilities/{id}`

Auth: none · Content-Type: application/json

Returns the facility address, area, coordinates, verification timestamps, source trust tier and the sorted list of approved active services. Returns 404 not_found when the facility is missing or not APPROVED.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Facility id from /directory/facilities. |

Responses:

- **200 OK**: Facility detail with approved services.  
  `{"id":"20000000-0000-4000-8000-000000000002","name":"Demo Community Hospital","address":"12 Example Road, Ikeja","area_id":"20000000-0000-4000-8000-000000000001","area":{"id":"20000000-0000-4000-8000-000000000001","name":"Ikeja demo area","region":"Lagos","city":"Ikeja"},"latitude":6.6041,"longitude":3.3489,"phone":null,"last_verified_at":"2026-11-17T15:43:56.515Z","verified_at":"2026-11-17T15:43:56.515Z","is_demo":true,"source_trust":"unknown","services":[{"service_code":"general","label":"General care","availability_note":null},{"service_code":"pediatrics","label":"Child health","availabilit …`
- Note: latitude and longitude are numbers or null.

## Symptom analysis

AI-assisted symptom intake. Each create or follow-up request makes a real model call, then returns the stored symptom record and conversation. Records are scoped to the authenticated account; ids that do not belong to the caller return 404 so ownership is not disclosed.

### `POST /symptom`

Auth: bearer · Content-Type: multipart/form-data

multipart/form-data. Creates a symptom record for the authenticated account's patient profile, stores up to five attachments, runs the symptom agent with the patient's context, and returns the full conversation. The agent may set the record's name, severity and summary. Attachments must be image/* or application/pdf, max 10 MB each and max 5 files. Accounts without a patient profile get 404 not_found. When the AI provider is unconfigured the endpoint returns 503 ai_unavailable and removes the half-created record.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `message` | string | yes | Symptom description, trimmed length 1-8000 characters. |
| body | `includeRecords` | boolean |  | Include the patient's stored records and reviewed facility content in the AI context. Accepts true/false/1/0/yes/no/on/off. Default true. |
| body | `modifyHistory` | boolean |  | Allow the agent to update the stored name, severity and summary. Default true. |
| body | `images` | file[] |  | 0-5 repeated parts, each an image/* or application/pdf file up to 10 MB. No file is embedded in this fixture. |

Responses:

- **201 Created**: Stored symptom record plus the full AI thread (Human message and AI reply).  
  `{"symptom":{"id":"ab143840-0058-4486-aa0d-2faf0c88121a","patient_id":"20000000-0000-4000-8000-000000000005","account_id":"20000000-0000-4000-8000-000000000004","name":"Mild headache and runny nose","severity":"MILD","summary":"Mild headache and runny nose for two days.","include_records":true,"modify_history":true,"language":"en","files":[],"thread_id":"symptom_ab143840-0058-4486-aa0d-2faf0c88121a","model_version":"openrouter","created_at":"2026-11-17T16:13:58.179Z","updated_at":"2026-11-17T16:14:08.281Z"},"messages":[{"type":"Human","content":"I have had a mild headache and a runny nose for two days."},{"typ …`
- Note: Captured live: 201 in 15.8 s with model_version "openrouter" (server model openai/gpt-6-luna).
- Note: messages is the whole thread on create: the Human message followed by the AI reply, which uses Markdown.
- Note: files lists object-storage keys for attachments and is [] when none were sent.
- Note: The request is synchronous; allow at least 180 s in client code.

### `GET /symptom`

Auth: bearer · Content-Type: application/json

Returns records scoped to the authenticated account, ordered by created_at descending.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| query | `page` | integer |  | 1-based page. Non-numeric or < 1 falls back to 1; capped at 100000. |
| query | `limit` | integer |  | Page size 1-100. Values above 100 are clamped to 100. |

Responses:

- **200 OK**: Current page of symptom records.  
  `{"symptoms":[{"id":"ab143840-0058-4486-aa0d-2faf0c88121a","patient_id":"20000000-0000-4000-8000-000000000005","account_id":"20000000-0000-4000-8000-000000000004","name":"Mild headache and runny nose","severity":"MILD","summary":"Mild headache and runny nose for two days.","include_records":true,"modify_history":true,"language":"en","files":[],"thread_id":"symptom_ab143840-0058-4486-aa0d-2faf0c88121a","model_version":"openrouter","created_at":"2026-11-17T16:13:58.179Z","updated_at":"2026-11-17T16:14:08.281Z"}],"page":1,"limit":10,"total":1,"totalPages":1}`
- **401 Unauthorized**: Captured with the Authorization header omitted.  
  `{"error":"unauthorized","message":"Authentication required","request_id":"275475e4-fa16-445b-b83c-a51a20db51b4"}`
- Note: totalPages is 0 when total is 0.
- Note: Pagination fields (page, limit, total, totalPages) sit beside the symptoms array at the top level.

### `GET /symptom/{id}`

Auth: bearer · Content-Type: application/json

Loads the record and its LangGraph thread history. A malformed uuid, an unknown id, or a record owned by another account all return 404 not_found.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Symptom analysis id returned by POST /symptom. |

Responses:

- **200 OK**: Record plus the stored conversation history.  
  `{"symptom":{"id":"ab143840-0058-4486-aa0d-2faf0c88121a","patient_id":"20000000-0000-4000-8000-000000000005","account_id":"20000000-0000-4000-8000-000000000004","name":"Mild headache and runny nose","severity":"MILD","summary":"Mild headache and runny nose for two days.","include_records":true,"modify_history":true,"language":"en","files":[],"thread_id":"symptom_ab143840-0058-4486-aa0d-2faf0c88121a","model_version":"openrouter","created_at":"2026-11-17T16:13:58.179Z","updated_at":"2026-11-17T16:14:08.281Z"},"messages":[{"type":"Human","content":"I have had a mild headache and a runny nose for two days."},{"typ …`
- **404 Not found**: Captured with a valid-format uuid that belongs to no record visible to this account.  
  `{"error":"not_found","message":"Symptom analysis record not found","request_id":"971444ac-d52b-423a-908d-23da8b683b5e"}`
- Note: Non-uuid ids return the same 404 body as unknown ids rather than a 400.
- Note: messages is the stored thread for the record and grows with each follow-up.

### `POST /symptom/{id}/follow-up`

Auth: bearer · Content-Type: multipart/form-data

Uses the record's stored includeRecords/modifyHistory settings and the same multipart rules as create. Attachments are appended to the record's files. Unlike create, the response contains only the last two messages: the new Human message and the AI reply.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Symptom analysis id. |
| body | `message` | string | yes | Follow-up text, trimmed length 1-8000 characters. |
| body | `images` | file[] |  | 0-5 image/* or application/pdf parts, max 10 MB each. No file is embedded here. |

Responses:

- **200 OK**: Updated record plus the last two thread messages.  
  `{"symptom":{"id":"ab143840-0058-4486-aa0d-2faf0c88121a","patient_id":"20000000-0000-4000-8000-000000000005","account_id":"20000000-0000-4000-8000-000000000004","name":"Mild headache and runny nose","severity":"MILD","summary":"Mild headache and runny nose for two days; headache gets a little worse in the evening.","include_records":true,"modify_history":true,"language":"en","files":[],"thread_id":"symptom_ab143840-0058-4486-aa0d-2faf0c88121a","model_version":"openrouter","created_at":"2026-11-17T16:13:58.179Z","updated_at":"2026-11-17T16:14:37.432Z"},"messages":[{"type":"Human","content":"Should I be worried  …`
- Note: The agent may rewrite name, severity and summary; check symptom.updated_at.
- Note: Unknown or foreign ids return 404 before any model call is made.
- Note: Requires a configured AI provider; otherwise 503 ai_unavailable.

### `PATCH /symptom/{id}`

Auth: bearer · Content-Type: application/json

Accepts name and/or severity only. Unknown keys are rejected with 400 validation_error, and an empty object returns 400 invalid_update.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Symptom analysis id. |
| body | `name` | string |  | New title, 1-200 characters. Omit to leave unchanged. |
| body | `severity` | string |  | MILD, MODERATE or SEVERE (case-insensitive). Omit to leave unchanged. |

Body example:

```json
{
 "name": "Headache and runny nose (day 2)",
 "severity": "MODERATE"
}
```

Responses:

- **200 OK**: The updated symptom record.  
  `{"symptom":{"id":"ab143840-0058-4486-aa0d-2faf0c88121a","patient_id":"20000000-0000-4000-8000-000000000005","account_id":"20000000-0000-4000-8000-000000000004","name":"Headache and runny nose (day 2)","severity":"MODERATE","summary":"Mild headache and runny nose for two days; headache gets a little worse in the evening.","include_records":true,"modify_history":true,"language":"en","files":[],"thread_id":"symptom_ab143840-0058-4486-aa0d-2faf0c88121a","model_version":"openrouter","created_at":"2026-11-17T16:13:58.179Z","updated_at":"2026-11-17T16:14:44.689Z"}}`
- Note: The literal legacy value "SEVERITY" is normalized to "SEVERE".
- Note: Severity is stored uppercase as MILD, MODERATE or SEVERE.

### `DELETE /symptom/{id}`

Auth: bearer · Content-Type: application/json

Removes the row, deletes stored attachments, clears the AI thread history and returns {deleted:true}. Unknown or foreign ids return 404 not_found.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Symptom analysis id. |

Responses:

- **200 OK**: Deletion confirmed.  
  `{"deleted":true}`
- Note: The captured record was deleted after this call, so its id now returns 404.

## Medications and reminders

Medication schedules, per-dose moments and device registration. All schedule and moment routes resolve the patient from the bearer token; a body patient id is never accepted. Numeric progress/score fields are Decimal strings, not JSON numbers.

### `POST /medications`

Auth: bearer · Content-Type: application/json

Deterministic path: a non-empty medications array of structured entries skips the model. The API creates the schedule and one moment per dose per day between startDate and endDate. The response contains the schedule but no moments; read them with GET /medications/:id. Date-only inputs are interpreted as the same calendar date in UTC: startDate 2026-11-17 is returned as start_date 2026-11-17T00:00:00.000Z and endDate 2026-11-19 as end_date 2026-11-19T00:00:00.000Z. Dose moments are absolute instants; render them in the user's local timezone.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `title` | string |  | Schedule title. Stored as null when omitted. |
| body | `description` | string |  | Free-text description. Stored as null when omitted. |
| body | `summary` | string |  | Short summary. When omitted it is generated as "<drug> <dose>, ...". |
| body | `startDate` | string | yes | ISO date; day precision. Must not be after endDate. |
| body | `endDate` | string | yes | ISO date; day precision, inclusive for moment generation. |
| body | `medications` | object[] | yes | At least one entry: {drug (required), dose, frequency, times: [{hour 0-23, minute 0-59}] (at least one)}. A malformed structured array returns 400 instead of falling back to the AI path. |

Body example:

```json
{
 "title": "Headache relief plan",
 "description": "Short course for tension headache",
 "summary": "Paracetamol 500 mg up to three times daily for two days",
 "startDate": "2026-11-17",
 "endDate": "2026-11-19",
 "medications": [
  {
   "drug": "Paracetamol",
   "dose": "500 mg",
   "frequency": "Three times daily",
   "times": [
    {
     "hour": 8,
     "minute": 0
    },
    {
     "hour": 14,
     "minute": 0
    },
    {
     "hour": 20,
     "minute": 0
    }
   ]
  }
 ]
}
```

Responses:

- **201 Created**: Schedule row; moments are created but not included.  
  `{"schedule":{"id":"ff5c2b3f-81ea-4038-9b93-adce5efcdf46","patient_id":"20000000-0000-4000-8000-000000000005","title":"Headache relief plan","description":"Short course for tension headache","medications":[{"dose":"500 mg","drug":"Paracetamol","times":[{"hour":8,"minute":0},{"hour":14,"minute":0},{"hour":20,"minute":0}],"frequency":"Three times daily"}],"start_date":"2026-11-17T00:00:00.000Z","end_date":"2026-11-19T00:00:00.000Z","summary":"Paracetamol 500 mg up to three times daily for two days","progress":"0","score":"100","created_at":"2026-11-17T16:22:06.462Z","updated_at":"2026-11-17T16:22 …`
- **400 Invalid schedule**: endDate precedes startDate.  
  `{"error":"invalid_schedule","message":"End date must not precede start date","request_id":"192ba9e6-93cb-4f2b-885f-ec4ad2e4a58a"}`
- **400 Invalid schedule**: Empty medications array.  
  `{"error":"invalid_schedule","message":"Medications or a document is required","request_id":"448273ed-bd7b-4e3d-aee2-5a39cb35a6bf"}`
- Note: Captured live: 201 in 29 ms; no model call on this path.
- Note: progress and score are strings: the capture is progress "0", score "100".
- Note: progress only counts decided moments (TAKEN or MISSED), so it stays 0 while every moment is PENDING.
- Note: The captured start_date/end_date round-trip the input calendar dates: 2026-11-17T00:00:00.000Z and 2026-11-19T00:00:00.000Z.

### `POST /medications`

Auth: bearer · Content-Type: application/json

Used when medications is free text (or absent and a document is uploaded). The API calls the medication scheduler agent and persists its JSON draft. Explicit title/description/summary override the model's values. The same route accepts multipart/form-data with a single document file (max 10 MB) instead of JSON.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `startDate` | string | yes | ISO date; day precision. |
| body | `endDate` | string | yes | ISO date; must not precede startDate. |
| body | `medications` | string |  | Free-text medication instructions. Required unless a document part is uploaded; a structured array takes the deterministic path instead. |
| body | `document` | file |  | multipart/form-data only: one file up to 10 MB. Not embedded in this fixture. |
| body | `title` | string |  | Optional override of the model-generated title. |
| body | `description` | string |  | Optional override of the model-generated description. |
| body | `summary` | string |  | Optional override of the model-generated summary. |

Body example:

```json
{
 "startDate": "2026-11-17",
 "endDate": "2026-11-20",
 "medications": "Amoxicillin 500 mg three times daily for four days"
}
```

Responses:

- **201 Created (AI-assisted)**: Schedule built from the model draft; the model filled title and summary.  
  `{"schedule":{"id":"6a1b5704-af72-4cce-aa11-21807dd95d0b","patient_id":"20000000-0000-4000-8000-000000000005","title":null,"description":null,"medications":[{"dose":"500 mg","drug":"Amoxicillin","times":[{"hour":8,"minute":0},{"hour":14,"minute":0},{"hour":20,"minute":0}],"frequency":"Three times daily"}],"start_date":"2026-11-17T00:00:00.000Z","end_date":"2026-11-20T00:00:00.000Z","summary":"Take amoxicillin 500 mg three times daily for four days, from November 17 through November 20, 2026.","progress":"0","score":"100","created_at":"2026-11-17T16:22:27.700Z","updated_at":"2026-11-17T16:22:27. …`
- Note: Captured live: 201 in 5.5 s against OpenRouter (openai/gpt-6-luna).
- Note: The draft returned title null, description null and summary "Take amoxicillin 500 mg three times daily for four days, from November 17 through November 20, 2026."; the schedule dates round-tripped as 2026-11-17T00:00:00.000Z and 2026-11-20T00:00:00.000Z.
- Note: Model output is not clinically validated; review drug, dose and times before use.
- Note: Missing provider config returns 503 ai_unavailable; invalid model JSON returns 502 ai_invalid_response.
- Note: The schedule response does not include model_version; the AI write is recorded in the audit log as actorRef ai:<model>.

### `GET /medications`

Auth: bearer · Content-Type: application/json

Returns schedule rows without moments, ordered by created_at descending.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| query | `page` | integer |  | 1-based page; invalid values fall back to 1. |
| query | `limit` | integer |  | Page size; values above 50 are clamped to 50. |

Responses:

- **200 OK**: Current page of schedules.  
  `{"schedules":[{"id":"ff5c2b3f-81ea-4038-9b93-adce5efcdf46","patient_id":"20000000-0000-4000-8000-000000000005","title":"Headache relief plan","description":"Short course for tension headache","medications":[{"dose":"500 mg","drug":"Paracetamol","times":[{"hour":8,"minute":0},{"hour":14,"minute":0},{"hour":20,"minute":0}],"frequency":"Three times daily"}],"start_date":"2026-11-17T00:00:00.000Z","end_date":"2026-11-19T00:00:00.000Z","summary":"Paracetamol 500 mg up to three times daily for two days","progress":"0","score":"100","created_at":"2026-11-17T16:22:06.462Z","updated_at":"2026-11-17T16: …`
- Note: totalPages is Math.ceil(total / limit), so it is 0 when there are no schedules.
- Note: Schedules require a patient profile; accounts without one get 403 patient_profile_required.

### `GET /medications/{id}`

Auth: bearer · Content-Type: application/json

Returns the schedule plus moments (time, drug, dose, frequency, status, notification flags). Unknown ids, non-uuid ids and other patients' schedules return 404 not_found.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Medication schedule id returned by POST /medications. |

Responses:

- **200 OK**: Schedule with nine PENDING moments for three days at three times daily.  
  `{"schedule":{"id":"ff5c2b3f-81ea-4038-9b93-adce5efcdf46","patient_id":"20000000-0000-4000-8000-000000000005","title":"Headache relief plan","description":"Short course for tension headache","medications":[{"dose":"500 mg","drug":"Paracetamol","times":[{"hour":8,"minute":0},{"hour":14,"minute":0},{"hour":20,"minute":0}],"frequency":"Three times daily"}],"start_date":"2026-11-17T00:00:00.000Z","end_date":"2026-11-19T00:00:00.000Z","summary":"Paracetamol 500 mg up to three times daily for two days","progress":"0","score":"100","created_at":"2026-11-17T16:22:06.462Z","updated_at":"2026-11-17T16:22 …`
- Note: moments are sorted by time ascending, not by drug.
- Note: moment.time is an absolute instant. The 8:00 dose is stored as 07:00:00.000Z, so render moments in the user's local timezone instead of slicing the UTC string.
- Note: In the capture notified_user is false and notified_at is null because no reminder cycle had processed these future moments.

### `PATCH /medications/moments/{id}`

Auth: bearer · Content-Type: application/json

Updates the moment by id, then recomputes the parent schedule's progress and score. The response includes the updated moment plus both recomputed values.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Moment id (medication_moments.id), not the schedule id. |
| body | `status` | string | yes | TAKEN, MISSED or PENDING (uppercase enum). |

Body example:

```json
{
 "status": "TAKEN"
}
```

Responses:

- **200 OK**: Updated moment plus the parent schedule's progress and score.  
  `{"moment":{"id":"04f6d070-d980-4326-a9b0-5ce7e0b79585","medication_schedule_id":"ff5c2b3f-81ea-4038-9b93-adce5efcdf46","drug":"Paracetamol","dose":"500 mg","frequency":"Three times daily","status":"TAKEN","time":"2026-11-17T07:00:00.000Z","notified_user":false,"notified_at":null,"created_at":"2026-11-17T16:22:06.464Z"},"progress":"100","score":"100"}`
- Note: progress is taken / (taken + missed) as a percentage with up to two decimals; one TAKEN and no MISSED yields 100 while remaining moments are still PENDING.
- Note: Both progress and score are Decimal strings in JSON, for example "100".
- Note: A moment owned by another patient returns 404 not_found.

### `PATCH /medications/{id}/add`

Auth: bearer · Content-Type: application/json

Appends to the schedule's medications JSON and creates new PENDING moments for the supplied window. The schedule's own start_date, end_date, title, summary and existing moments are unchanged. Free text or a multipart document switches to the AI addition path. Responds 201 with the schedule but no moments.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Medication schedule id. |
| body | `startDate` | string | yes | First day for the new moments. |
| body | `endDate` | string | yes | Last day for the new moments; must not precede startDate. |
| body | `medications` | object[] | yes | One or more {drug, dose, frequency, times[]} entries; same schema as create. |
| body | `document` | file |  | multipart/form-data alternative for the AI path; not embedded here. |

Body example:

```json
{
 "startDate": "2026-11-17",
 "endDate": "2026-11-18",
 "medications": [
  {
   "drug": "Ibuprofen",
   "dose": "200 mg",
   "frequency": "Twice daily",
   "times": [
    {
     "hour": 9,
     "minute": 30
    },
    {
     "hour": 21,
     "minute": 30
    }
   ]
  }
 ]
}
```

Responses:

- **201 Created**: Schedule with both medications; new moments are not included.  
  `{"schedule":{"id":"ff5c2b3f-81ea-4038-9b93-adce5efcdf46","patient_id":"20000000-0000-4000-8000-000000000005","title":"Headache relief plan","description":"Short course for tension headache","medications":[{"dose":"500 mg","drug":"Paracetamol","times":[{"hour":8,"minute":0},{"hour":14,"minute":0},{"hour":20,"minute":0}],"frequency":"Three times daily"},{"dose":"200 mg","drug":"Ibuprofen","times":[{"hour":9,"minute":30},{"hour":21,"minute":30}],"frequency":"Twice daily"}],"start_date":"2026-11-17T00:00:00.000Z","end_date":"2026-11-19T00:00:00.000Z","summary":"Paracetamol 500 mg up to three times …`
- Note: Returns 201, not 200, because new moments are created.
- Note: The captured response still shows the schedule's original dates (2026-11-17T00:00:00.000Z and 2026-11-19T00:00:00.000Z); only medications and moments were extended.
- Note: Re-adding an existing drug appends a second entry; it does not merge times.

### `PATCH /medications/{id}/remove`

Auth: bearer · Content-Type: application/json

Matches drug case-insensitively after trimming, removes it from the schedule's medications array and deletes its PENDING moments, optionally only those at or after from. TAKEN and MISSED moments are retained. Returns the schedule without moments.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Medication schedule id. |
| body | `drug` | string | yes | Drug name to remove; case-insensitive, whitespace-trimmed. |
| body | `from` | string |  | Optional ISO date; only PENDING moments at or after it are deleted. |

Body example:

```json
{
 "drug": "Ibuprofen"
}
```

Responses:

- **200 OK**: Schedule with only Paracetamol remaining.  
  `{"schedule":{"id":"ff5c2b3f-81ea-4038-9b93-adce5efcdf46","patient_id":"20000000-0000-4000-8000-000000000005","title":"Headache relief plan","description":"Short course for tension headache","medications":[{"dose":"500 mg","drug":"Paracetamol","times":[{"hour":8,"minute":0},{"hour":14,"minute":0},{"hour":20,"minute":0}],"frequency":"Three times daily"}],"start_date":"2026-11-17T00:00:00.000Z","end_date":"2026-11-19T00:00:00.000Z","summary":"Paracetamol 500 mg up to three times daily for two days","progress":"100","score":"100","created_at":"2026-11-17T16:22:06.462Z","updated_at":"2026-11-17T16: …`
- Note: Removing a drug that is not present leaves the medication list unchanged and still returns 200.
- Note: The response omits moments; re-fetch GET /medications/:id to confirm deletions.

### `POST /devices`

Auth: bearer · Content-Type: application/json

Upserts by token: repeat calls update account owner, platform and last_used_at. FCM is disabled in this environment (FCM_ENABLED=false), so registration stores the token but no push is delivered.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| body | `token` | string | yes | FCM registration token, 1-4096 characters. |
| body | `platform` | string | yes | IOS, ANDROID or WEB (uppercase enum). |

Body example:

```json
{
 "token": "demo-web-token-7f3c9a2e",
 "platform": "WEB"
}
```

Responses:

- **201 Created**: Device id and platform; the token is not echoed.  
  `{"device":{"id":"85d0c92f-7e2b-4e27-8efd-289f5f6de2ea","platform":"WEB"}}`
- Note: Requires authentication but no patient profile.
- Note: Response is {device:{id,platform}}; keep the token client-side, it is not returned.

### `DELETE /medications/{id}`

Auth: bearer · Content-Type: application/json

Deletes the schedule row for the authenticated patient; moments cascade via the database relation. Returns {message} or 404 not_found when no row matches.

| In | Name | Type | Required | Notes |
|---|---|---|---|---|
| path | `id` | uuid | yes | Medication schedule id. |

Responses:

- **200 OK**: Deletion confirmed.  
  `{"message":"Medication schedule deleted"}`
- Note: The captured schedules (structured and AI-assisted) were deleted after capture; GET /medications returned total 0.
