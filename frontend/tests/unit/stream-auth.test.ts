import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/api/mocks/server";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("@/api/client", async (original) => ({
  ...(await original<typeof import("@/api/client")>()),
  redirectToLogin: redirect,
  refreshSession: () => Promise.reject(new Error("refresh failed")),
}));

import { streamSymptom } from "@/api/stream";

describe("streamSymptom with an expired session", () => {
  beforeEach(() => redirect.mockClear());

  it("sends the person to sign in instead of reporting a network error", async () => {
    server.use(http.post("/api/v1/symptom/stream", () => HttpResponse.json({ error: "token_expired" }, { status: 401 })));
    const iterator = streamSymptom("/symptom/stream", () => new FormData(), new AbortController().signal);
    await expect(iterator.next()).rejects.toMatchObject({ code: "token_expired" });
    expect(redirect).toHaveBeenCalled();
  });
});
