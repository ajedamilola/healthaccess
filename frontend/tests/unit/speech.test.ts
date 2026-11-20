import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { speak, stopSpeech, useSpeech } from "@/features/assistant/useSpeech";

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

class FakeUrl extends URL {
  static createObjectURL = vi.fn(() => "blob:reply");
  static revokeObjectURL = vi.fn();
}

beforeEach(() => {
  FakeUrl.createObjectURL.mockClear();
  FakeUrl.revokeObjectURL.mockClear();
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", FakeUrl);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Blob(["audio"]), { status: 200, headers: { "content-type": "audio/mpeg" } })),
  );
});

afterEach(() => {
  stopSpeech();
  FakeAudio.instances = [];
  vi.unstubAllGlobals();
});

describe("useSpeech", () => {
  it("stops immediately while play() is pending and handles its rejection", async () => {
    const spoken = speak("reply-1", "Hello", "en");
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    const player = FakeAudio.instances[0]!;
    expect(player.play).toHaveBeenCalledTimes(1);

    stopSpeech();
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.removeAttribute).toHaveBeenCalledWith("src");
    expect(player.load).not.toHaveBeenCalled();
    expect(FakeUrl.revokeObjectURL).toHaveBeenCalledTimes(1);

    await expect(spoken).resolves.toBeUndefined();
  });

  it("replaces pending playback without stopping the next reply", async () => {
    const firstSpoken = speak("reply-1", "Hello", "en");
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    const firstPlayer = FakeAudio.instances[0]!;

    const nextSpoken = speak("reply-2", "Next reply", "en");
    expect(firstPlayer.pause).toHaveBeenCalledTimes(1);
    await expect(firstSpoken).resolves.toBeUndefined();
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    const nextPlayer = FakeAudio.instances[1]!;
    expect(nextPlayer.pause).not.toHaveBeenCalled();
    expect(FakeUrl.revokeObjectURL).toHaveBeenCalledTimes(1);

    nextPlayer.resolvePlay();
    await nextSpoken;
    const { result } = renderHook(() => useSpeech());
    expect(result.current).toMatchObject({ status: "playing", id: "reply-2", error: null });
  });

  it("handles play() rejecting with AbortError before playback starts", async () => {
    class InterruptedAudio extends FakeAudio {
      play = vi.fn(() =>
        Promise.reject(new DOMException("The play() request was interrupted by a call to pause().", "AbortError")),
      );
    }
    vi.stubGlobal("Audio", InterruptedAudio);

    await expect(speak("reply-1", "Hello", "en")).resolves.toBeUndefined();
    const player = InterruptedAudio.instances[0]!;
    await vi.waitFor(() => expect(player.pause).toHaveBeenCalledTimes(1));
    expect(FakeUrl.revokeObjectURL).toHaveBeenCalledTimes(1);
    const { result } = renderHook(() => useSpeech());
    expect(result.current).toMatchObject({ status: "idle", id: null, error: null });
  });

  it("still reports playback failures that are not cancellations", async () => {
    class UnavailableAudio extends FakeAudio {
      play = vi.fn(() => Promise.reject(new DOMException("Playback is not allowed.", "NotAllowedError")));
    }
    vi.stubGlobal("Audio", UnavailableAudio);

    await expect(speak("reply-1", "Hello", "en")).resolves.toBeUndefined();
    expect(FakeUrl.revokeObjectURL).toHaveBeenCalledTimes(1);
    const { result } = renderHook(() => useSpeech());
    expect(result.current).toMatchObject({ status: "idle", id: "reply-1", error: "Could not read this reply aloud." });
  });

  it("swallows teardown errors from a detached element", async () => {
    const spoken = speak("reply-1", "Hello", "en");
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    const player = FakeAudio.instances[0]!;
    player.pause.mockImplementation(() => {
      throw new DOMException("The play() request was interrupted by a call to pause().", "AbortError");
    });

    stopSpeech();
    player.resolvePlay();
    await expect(spoken).resolves.toBeUndefined();
    await vi.waitFor(() => expect(FakeUrl.revokeObjectURL).toHaveBeenCalledTimes(1));
  });
});
