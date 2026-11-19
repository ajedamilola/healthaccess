import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatMessages } from "@/features/assistant/ChatParts";
import { stopSpeech } from "@/features/assistant/useSpeech";

class FakeAudio {
  static instances: FakeAudio[] = [];

  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn(() => {
    this.rejectPlay?.(new DOMException("The play() request was interrupted by a call to pause().", "AbortError"));
  });
  load = vi.fn();
  removeAttribute = vi.fn();
  play = vi.fn(() => new Promise<void>((resolve, reject) => {
    this.resolvePlay = resolve;
    this.rejectPlay = reject;
  }));
  resolvePlay!: () => void;
  rejectPlay!: (reason: unknown) => void;

  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }
}

afterEach(() => {
  stopSpeech();
  FakeAudio.instances = [];
  vi.unstubAllGlobals();
});

describe("ListenButton inside ChatMessages", () => {
  it("can stop and replay while play() is still pending", async () => {
    vi.stubGlobal("Audio", FakeAudio);
    class FakeUrl extends URL {
      static createObjectURL = vi.fn(() => "blob:reply");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", FakeUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["audio"]), { status: 200, headers: { "content-type": "audio/mpeg" } })),
    );

    const user = userEvent.setup();
    render(
      <ChatMessages
        messages={[{ type: "AI", content: "Hello there" }]}
        pending={null}
        reply=""
        activity={null}
        phase="idle"
        language="en"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Read this reply aloud" }));
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    const player = FakeAudio.instances[0]!;
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.pause).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Stop reading this reply" }));
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Read this reply aloud" })).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("button", { name: "Read this reply aloud" }));
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    expect(FakeAudio.instances[1]!.pause).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop reading this reply" })).toHaveAttribute("aria-pressed", "true");
  });
});
