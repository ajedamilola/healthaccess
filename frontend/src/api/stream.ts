"use client";

import { ApiError } from "./errors";
import { queryClient } from "@/lib/query-client";
import { redirectToLogin, refreshSession } from "./client";
import { symptomDetailResponseSchema, symptomRecordSchema, type SymptomDetailResponse, type SymptomRecord } from "./schemas";

export type SymptomStreamEvent =
  | { type: "record"; symptom: SymptomRecord }
  | { type: "token"; content: string }
  | { type: "step"; id: string; name: string; status: "started" | "completed" | "failed" }
  | { type: "done"; data: SymptomDetailResponse }
  | { type: "error"; error: ApiError };

export interface SseFrame {
  event: string;
  data: string;
}

/** Incremental parser for text/event-stream. Comments (heartbeats) are ignored. */
export function createSseParser(onFrame: (frame: SseFrame) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n?/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        if (data.length) onFrame({ event, data: data.join("\n") });
        boundary = buffer.indexOf("\n\n");
      }
    },
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function toStreamEvent(frame: SseFrame): SymptomStreamEvent | null {
  const data = parseJson(frame.data) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return null;
  switch (frame.event) {
    case "record": {
      const parsed = symptomRecordSchema.safeParse(data.symptom);
      return parsed.success ? { type: "record", symptom: parsed.data } : null;
    }
    case "token":
      return typeof data.content === "string" ? { type: "token", content: data.content } : null;
    case "step":
      return typeof data.id === "string" && typeof data.name === "string"
        ? {
            type: "step",
            id: data.id,
            name: data.name,
            status: data.status === "completed" || data.status === "failed" ? data.status : "started",
          }
        : null;
    case "done": {
      const parsed = symptomDetailResponseSchema.safeParse(data);
      return parsed.success
        ? { type: "done", data: parsed.data }
        : { type: "error", error: new ApiError({ status: 200, code: "invalid_response" }) };
    }
    case "error":
      return {
        type: "error",
        error: new ApiError({
          status: 200,
          // Server messages can be technical; the client shows a friendly message for the code.
          code: typeof data.error === "string" ? data.error : "stream_error",
        }),
      };
    default:
      return null;
  }
}

async function errorFrom(response: Response): Promise<ApiError> {
  const body = parseJson(await response.text().catch(() => "")) as Record<string, unknown> | null;
  const code =
    (body && typeof body.error === "string" && body.error) ||
    (response.status === 504 ? "upstream_timeout" : response.status >= 500 ? "upstream_unavailable" : "invalid_response");
  const requestId =
    response.headers.get("x-request-id") ??
    (body && typeof body.request_id === "string" ? body.request_id : undefined);
  return new ApiError({
    status: response.status,
    code,
    requestId,
  });
}

/**
 * POST multipart form data to a streaming endpoint and yield parsed events as they arrive.
 * An expired access token is refreshed once and the request retried.
 */
export async function* streamSymptom(
  path: string,
  makeBody: () => FormData,
  signal: AbortSignal,
): AsyncGenerator<SymptomStreamEvent> {
  const send = () =>
    fetch(`/api/v1${path}`, {
      method: "POST",
      body: makeBody(),
      credentials: "include",
      headers: { "X-HA-Client": "web", accept: "text/event-stream" },
      signal,
    });

  let response: Response;
  try {
    response = await send();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError({ status: 0, code: "network" });
  }
  if (response.status === 401) {
    try {
      await refreshSession();
    } catch {
      // The session is gone: sign in again, like every other API call.
      queryClient.clear();
      redirectToLogin();
      throw new ApiError({ status: 401, code: "token_expired" });
    }
    try {
      response = await send();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ApiError({ status: 0, code: "network" });
    }
  }

  if (!response.ok || !response.body) throw await errorFrom(response);

  const queue: SymptomStreamEvent[] = [];
  const parser = createSseParser((frame) => {
    const event = toStreamEvent(frame);
    if (event) queue.push(event);
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) parser.push(decoder.decode(value, { stream: true }));
      while (queue.length) yield queue.shift()!;
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
