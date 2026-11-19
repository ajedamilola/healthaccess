import { http, HttpResponse } from "msw";
import {
  symptomCreate,
  symptomDelete,
  symptomDetail,
  symptomFollowUp,
  symptomUpdate,
} from "../fixtures/symptom";
import type { SymptomMessage, SymptomRecord } from "@/api/schemas/symptom";

type StoreEntry = { record: SymptomRecord; messages: SymptomMessage[] };

const initialRecord = symptomDetail.symptom as SymptomRecord;
const initialMessages = symptomDetail.messages as SymptomMessage[];

let entries: StoreEntry[] = [];
let nextId = 0;

export function resetSymptomHandlers() {
  entries = [{ record: { ...initialRecord }, messages: initialMessages.map((message) => ({ ...message })) }];
  nextId = 0;
}

resetSymptomHandlers();

function listRecord(record: SymptomRecord): SymptomRecord {
  return record;
}

function parsePage(value: string | null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, 100_000) : 1;
}

function parseLimit(value: string | null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, 100) : 10;
}

/** Build a text/event-stream response that emits each frame separately, like the real API. */
export function sseResponse(frames: Array<[string, unknown]>, gapMs = 0) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(": ping\n\n"));
      for (const [event, data] of frames) {
        if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      controller.close();
    },
  });
  return new HttpResponse(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Split a reply into word-sized token frames. */
export function tokenFrames(text: string): Array<[string, unknown]> {
  return (text.match(/\S+\s*/g) ?? [text]).map((content) => ["token", { content }]);
}

export const symptomHandlers = [
    http.get("/api/v1/me/assistant-context", () =>
      HttpResponse.json({
        snapshot: {
          ageYears: 34,
          ageBand: "adult (18-39)",
          sex: "Female",
          pregnancyStatus: null,
          location: { city: "Ikeja", state: "Lagos", country: "Nigeria", homeArea: "Ikeja" },
          emergencyNumber: "112",
          preferredLanguage: "en",
          conditions: [],
          medications: ["Paracetamol as needed"],
          allergies: [{ name: "Penicillin", severity: "MODERATE" }],
        },
        language: "English",
        completeness: {
          score: 70,
          missing: [{ key: "conditions", label: "Long-term conditions", reason: "Conditions change what is urgent." }],
        },
      }),
    ),
  http.post("/api/v1/symptom/stream", async ({ request }) => {
    const form = await request.formData();
    const message = String(form.get("message") ?? "").trim();
    if (!message || message.length > 8000) {
      return HttpResponse.json({ error: "validation_error" }, { status: 400 });
    }
    const id = nextId === 0 ? symptomCreate.symptom.id : `ab143840-0058-4486-aa0d-2faf0c8812${String(nextId).padStart(2, "0")}`;
    nextId += 1;
    const files = form.getAll("images").filter((value): value is File => value instanceof File);
    const record: SymptomRecord = {
      ...(symptomCreate.symptom as SymptomRecord),
      id,
      name: message.slice(0, 80),
      summary: message.slice(0, 160),
      include_records: String(form.get("includeRecords")) === "true",
      modify_history: String(form.get("modifyHistory")) !== "false",
      language: String(form.get("language") ?? "en"),
      files: files.map((file) => `symptom/${id}/${file.name}`),
      thread_id: `symptom_${id}`,
    };
    const reply = symptomCreate.messages[1]!.content;
    const messages: SymptomMessage[] = [
      { type: "Human", content: message },
      { type: "AI", content: reply },
    ];
    entries = [{ record, messages }, ...entries];
    return sseResponse([
      ["record", { symptom: record }],
      ["step", { id: "s1", name: "lookupPatientDetails", status: "started" }],
      ["step", { id: "s1", name: "lookupPatientDetails", status: "completed" }],
      ...tokenFrames(reply),
      ["done", { symptom: record, messages }],
    ]);
  }),

  http.post("/api/v1/symptom/:id/follow-up/stream", async ({ params, request }) => {
    const id = String(params.id);
    const entry = entries.find((candidate) => candidate.record.id === id);
    if (!entry) {
      return HttpResponse.json({ error: "not_found", message: "Symptom analysis record not found" }, { status: 404 });
    }
    const form = await request.formData();
    const message = String(form.get("message") ?? "").trim();
    const updated: SymptomRecord = {
      ...entry.record,
      summary: symptomFollowUp.symptom.summary,
      updated_at: symptomFollowUp.symptom.updated_at,
    };
    const reply = symptomFollowUp.messages[1]!.content;
    entry.record = updated;
    entry.messages = [...entry.messages, { type: "Human", content: message }, { type: "AI", content: reply }];
    return sseResponse([
      ["record", { symptom: updated }],
      ...tokenFrames(reply),
      ["done", { symptom: updated, messages: entry.messages }],
    ]);
  }),

  http.get("/api/v1/symptom", ({ request }) => {
    const url = new URL(request.url);
    const page = parsePage(url.searchParams.get("page"));
    const limit = parseLimit(url.searchParams.get("limit"));
    const total = entries.length;
    const start = (page - 1) * limit;
    const symptoms = entries.slice(start, start + limit).map((entry) => listRecord(entry.record));
    return HttpResponse.json({
      symptoms,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  }),

  http.post("/api/v1/symptom", async ({ request }) => {
    const form = await request.formData();
    const message = String(form.get("message") ?? "").trim();
    if (!message || message.length > 8000) {
      return HttpResponse.json(
        { error: "validation_error", issues: [{ path: "message", message: "Message must be 1-8000 characters" }] },
        { status: 400 },
      );
    }

    const files = form.getAll("images").filter((value): value is File => value instanceof File);
    if (files.length > 5) {
      return HttpResponse.json(
        { error: "validation_error", issues: [{ path: "images", message: "At most five files" }] },
        { status: 400 },
      );
    }

    const id = nextId === 0 ? symptomCreate.symptom.id : `ab143840-0058-4486-aa0d-2faf0c8812${String(nextId).padStart(2, "0")}`;
    nextId += 1;
    const record: SymptomRecord = {
      ...(symptomCreate.symptom as SymptomRecord),
      id,
      name: message.slice(0, 80),
      summary: message.slice(0, 160),
      include_records: String(form.get("includeRecords")) === "true",
      modify_history: String(form.get("modifyHistory")) !== "false",
      language: String(form.get("language") ?? "en"),
      files: files.map((file) => `symptom/${id}/${file.name}`),
      thread_id: `symptom_${id}`,
    };
    const messages: SymptomMessage[] = [
      { type: "Human", content: message },
      { type: "AI", content: symptomCreate.messages[1]!.content },
    ];
    entries = [{ record, messages }, ...entries];
    return HttpResponse.json({ symptom: record, messages }, { status: 201 });
  }),

  http.get("/api/v1/symptom/:id", ({ params }) => {
    const id = String(params.id);
    const entry = entries.find((candidate) => candidate.record.id === id);
    if (!entry) {
      return HttpResponse.json({ error: "not_found", message: "Symptom analysis record not found" }, { status: 404 });
    }
    return HttpResponse.json({ symptom: entry.record, messages: entry.messages });
  }),

  http.post("/api/v1/symptom/:id/follow-up", async ({ params, request }) => {
    const id = String(params.id);
    const entry = entries.find((candidate) => candidate.record.id === id);
    if (!entry) {
      return HttpResponse.json({ error: "not_found", message: "Symptom analysis record not found" }, { status: 404 });
    }

    const form = await request.formData();
    const message = String(form.get("message") ?? "").trim();
    if (!message || message.length > 8000) {
      return HttpResponse.json(
        { error: "validation_error", issues: [{ path: "message", message: "Message must be 1-8000 characters" }] },
        { status: 400 },
      );
    }

    const updated: SymptomRecord = {
      ...entry.record,
      summary: symptomFollowUp.symptom.summary,
      updated_at: symptomFollowUp.symptom.updated_at,
    };
    const messages: SymptomMessage[] = [
      { type: "Human", content: message },
      { type: "AI", content: symptomFollowUp.messages[1]!.content },
    ];
    entry.record = updated;
    entry.messages = [...entry.messages, ...messages];
    return HttpResponse.json({ symptom: updated, messages });
  }),

  http.patch("/api/v1/symptom/:id", async ({ params, request }) => {
    const id = String(params.id);
    const entry = entries.find((candidate) => candidate.record.id === id);
    if (!entry) {
      return HttpResponse.json({ error: "not_found", message: "Symptom analysis record not found" }, { status: 404 });
    }

    const body = (await request.json()) as { name?: string; severity?: string };
    if (body.name === undefined && body.severity === undefined) {
      return HttpResponse.json({ error: "invalid_update", message: "Provide name or severity" }, { status: 400 });
    }

    const severity = body.severity?.toUpperCase() === "SEVERITY" ? "SEVERE" : body.severity?.toUpperCase();
    const updated: SymptomRecord = {
      ...entry.record,
      name: body.name ?? entry.record.name,
      severity: severity ?? entry.record.severity,
      updated_at: symptomUpdate.symptom.updated_at,
    };
    entry.record = updated;
    return HttpResponse.json({ symptom: updated });
  }),

  http.delete("/api/v1/symptom/:id", ({ params }) => {
    const id = String(params.id);
    const exists = entries.some((candidate) => candidate.record.id === id);
    if (!exists) {
      return HttpResponse.json({ error: "not_found", message: "Symptom analysis record not found" }, { status: 404 });
    }
    entries = entries.filter((candidate) => candidate.record.id !== id);
    return HttpResponse.json(symptomDelete);
  }),
];
