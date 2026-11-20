import { http, HttpResponse } from "msw";
import type {
  Allergy,
  EmergencyFieldsResponse,
  FieldDefinition,
  FieldsResponse,
  MedicalEvent,
  MeResponse,
  PatchMeBody,
  PutFieldsBody,
  PutMedicalBody,
} from "@/api/schemas";
import {
  avatarUnavailable,
  emergencyFieldsResponse,
  fieldsConflict,
  fieldsResponse,
  meMedicalResponse,
} from "../fixtures";

const now = "2026-11-17T16:19:14.306Z";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export type RecordHandlerSeed = {
  me?: MeResponse;
  fields?: FieldsResponse;
  emergencyKeys?: string[];
  avatarUnavailable?: boolean;
};

/**
 * A stateful mock for the record, profile and emergency screens.
 * Each test builds its own instance so writes never leak between cases.
 */
export function createRecordHandlers(seed: RecordHandlerSeed = {}) {
  const me = clone(seed.me ?? meMedicalResponse);
  let fields = clone(
    seed.fields ?? ({ version: 2, fields: fieldsResponse.fields } satisfies FieldsResponse),
  );
  let emergencyKeys = clone(seed.emergencyKeys ?? emergencyFieldsResponse.field_keys);
  const avatarFails = seed.avatarUnavailable ?? true;

  function syncFieldValue(key: string, value: string | string[] | number | boolean) {
    me.field_values[key] = value;
    const field = me.fields.find((item) => item.key === key);
    if (field) {
      field.value = value;
      return;
    }
    const definition = fields.fields.find((item) => item.key === key);
    if (definition) {
      me.fields.push({ key, label: definition.label, value_type: definition.value_type, value });
    }
  }

  function nextVersion() {
    fields = { ...fields, version: fields.version + 1 };
    me.profile.version = fields.version;
    return fields.version;
  }

  return [
    http.get("/api/v1/me", () => HttpResponse.json(me)),


    http.patch("/api/v1/me", async ({ request }) => {
      const body = (await request.json()) as PatchMeBody;
      if (body.firstName || body.lastName) {
        const [first, ...rest] = (me.account.display_name ?? "").split(" ");
        me.account.display_name = [body.firstName ?? first, body.lastName ?? rest.join(" ")]
          .filter(Boolean)
          .join(" ");
      }
      if (body.email) {
        me.account.email = body.email;
        me.account.email_verified_at = null;
      }
      if (body.phone) me.account.phone_verified_at = null;
      if (body.dob) {
        syncFieldValue("date_of_birth", body.dob);
        const field = me.fields.find((item) => item.key === "date_of_birth");
        if (field) field.label = "Date of birth";
      }
      me.account.updated_at = now;
      return HttpResponse.json(me);
    }),

    http.put("/api/v1/me/medical", async ({ request }) => {
      const body = (await request.json()) as PutMedicalBody;
      if (body.allergies) {
        me.allergies = body.allergies.map<Allergy>((allergy, index) => ({
          id: `20000000-0000-4000-8000-0000000002${String(index).padStart(2, "0")}`,
          name: allergy.name,
          severity: allergy.severity ? allergy.severity.toUpperCase() : null,
          diagnosis_date: allergy.diagnosisDate ? `${allergy.diagnosisDate}T00:00:00.000Z` : null,
          created_at: now,
          updated_at: now,
        }));
      }
      if (body.medicalEvents) {
        me.medical_events = body.medicalEvents.map<MedicalEvent>((event, index) => ({
          id: `30000000-0000-4000-8000-0000000003${String(index).padStart(2, "0")}`,
          name: event.name,
          recovery_time: event.recoveryTime ?? null,
          occurred_on: event.occurredOn ? `${event.occurredOn}T00:00:00.000Z` : null,
          description: event.description ?? null,
          created_at: now,
          updated_at: now,
        }));
      }
      return HttpResponse.json(me);
    }),

    http.delete("/api/v1/me/allergies/:id", ({ params }) => {
      me.allergies = me.allergies.filter((allergy) => allergy.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),

    http.patch("/api/v1/me/medical-events/:id", async ({ request, params }) => {
      const id = String(params.id);
      const existing = me.medical_events.find((event) => event.id === id);
      if (!existing) {
        return HttpResponse.json({ error: "not_found", message: "Medical event not found" }, { status: 404 });
      }
      const body = (await request.json()) as Record<string, unknown>;
      const updated: MedicalEvent = {
        ...existing,
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(body.recoveryTime === null || typeof body.recoveryTime === "string"
          ? { recovery_time: body.recoveryTime as string | null }
          : {}),
        ...(typeof body.occurredOn === "string" ? { occurred_on: `${body.occurredOn}T00:00:00.000Z` } : {}),
        ...(body.description === null || typeof body.description === "string"
          ? { description: body.description as string | null }
          : {}),
        updated_at: now,
      };
      me.medical_events = me.medical_events.map((event) => (event.id === id ? updated : event));
      return HttpResponse.json({ event: updated });
    }),

    http.delete("/api/v1/me/medical-events/:id", ({ params }) => {
      me.medical_events = me.medical_events.filter((event) => event.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),

    http.post("/api/v1/me/avatar", () => {
      if (avatarFails) {
        return HttpResponse.json(avatarUnavailable, { status: 503 });
      }
      me.avatar_url = "https://storage.example.test/avatars/profile.webp";
      return HttpResponse.json({
        avatar_key: "avatars/profile.webp",
        avatar_url: me.avatar_url,
      });
    }),

    http.get("/api/v1/me/fields", () => HttpResponse.json(fields)),

    http.put("/api/v1/me/fields", async ({ request }) => {
      const body = (await request.json()) as PutFieldsBody;
      if (body.expected_version !== fields.version) {
        return HttpResponse.json(fieldsConflict, { status: 409 });
      }
      fields = {
        version: fields.version + 1,
        fields: fields.fields.map<FieldDefinition>((field) =>
          Object.prototype.hasOwnProperty.call(body.fields, field.key)
            ? {
                ...field,
                value: body.fields[field.key] ?? null,
                field_version: (field.field_version ?? 0) + 1,
              }
            : field,
        ),
      };
      for (const [key, value] of Object.entries(body.fields)) syncFieldValue(key, value);
      me.profile.version = fields.version;
      return HttpResponse.json(fields);
    }),

    http.put("/api/v1/me/emergency-fields", async ({ request }) => {
      const body = (await request.json()) as { field_keys: string[]; expected_version: number };
      if (body.expected_version !== fields.version) {
        return HttpResponse.json(fieldsConflict, { status: 409 });
      }
      const valid = body.field_keys.every((key) => {
        const field = fields.fields.find((item) => item.key === key);
        return Boolean(field && field.emergency_eligible && field.value !== null && field.value !== undefined);
      });
      if (!valid) {
        return HttpResponse.json(
          { error: "invalid_field", message: "A field cannot be shared", request_id: "mock-invalid-field" },
          { status: 400 },
        );
      }
      emergencyKeys = [...body.field_keys];
      const version = nextVersion();
      const response: EmergencyFieldsResponse = { version, field_keys: emergencyKeys };
      return HttpResponse.json(response);
    }),

    http.get("/api/v1/me/emergency-summary", () => {
      const summaryFields = emergencyKeys
        .map((key) => fields.fields.find((field) => field.key === key))
        .filter((field): field is FieldDefinition => Boolean(field))
        .map((field) => ({ key: field.key, label: field.label, value: field.value }));
      return HttpResponse.json({
        available: summaryFields.length > 0,
        version: fields.version,
        field_keys: emergencyKeys,
        fields: summaryFields,
      });
    }),
  ];
}

export const recordHandlers = createRecordHandlers();
