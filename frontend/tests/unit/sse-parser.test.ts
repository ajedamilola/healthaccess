import { describe, expect, it } from "vitest";
import { createSseParser, toStreamEvent, type SseFrame } from "@/api/stream";

describe("SSE parser", () => {
  it("handles frames split across chunks, CRLF and heartbeat comments", () => {
    const frames: SseFrame[] = [];
    const parser = createSseParser((frame) => frames.push(frame));
    parser.push(": ping\r\n\r\nevent: tok");
    parser.push('en\ndata: {"content":"Hel');
    parser.push('lo"}\n\nevent: token\ndata: {"content":" there"}\n');
    expect(frames).toHaveLength(1);
    parser.push("\n");
    expect(frames.map((frame) => toStreamEvent(frame))).toEqual([
      { type: "token", content: "Hello" },
      { type: "token", content: " there" },
    ]);
  });

  it("maps error frames to a friendly error code and ignores unknown events", () => {
    const error = toStreamEvent({ event: "error", data: '{"error":"ai_unavailable","message":"stack trace"}' });
    expect(error?.type).toBe("error");
    expect(error && error.type === "error" ? error.error.message : "").toBe("The assistant is unavailable right now.");
    expect(toStreamEvent({ event: "mystery", data: "{}" })).toBeNull();
    expect(toStreamEvent({ event: "token", data: "not json" })).toBeNull();
  });
});
