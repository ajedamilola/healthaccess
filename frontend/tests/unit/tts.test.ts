import { describe, expect, it } from "vitest";
import { MAX_SPEECH_CHARS, markdownToSpeech, speechLanguage, trimForSpeech } from "@/lib/tts";

describe("tts", () => {
  it("maps reply languages to YarnGPT codes and falls back to English", () => {
    expect(speechLanguage("yo")).toBe("yo");
    expect(speechLanguage("IG-NG")).toBe("ig");
    expect(speechLanguage("pcm")).toBe("pcm");
    expect(speechLanguage("de")).toBe("en");
    expect(speechLanguage(undefined)).toBe("en");
  });

  it("cuts long text at a sentence boundary instead of mid-word", () => {
    const sentence = "Take the medicine after food. ";
    const trimmed = trimForSpeech(sentence.repeat(400));
    expect(trimmed.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    expect(trimmed.endsWith("food.")).toBe(true);
  });

  it("flattens Markdown so fences, links and table pipes are not read aloud", () => {
    const spoken = markdownToSpeech(
      [
        "## What to do",
        "",
        "- **Rest** and drink water.",
        "- See [a clinic](https://example.com) if it gets worse.",
        "",
        "```js",
        "console.log('not spoken')",
        "```",
        "",
        "| Day | Dose |",
        "| --- | --- |",
        "| Mon | 1 |",
      ].join("\n"),
    );

    expect(spoken).toContain("What to do");
    expect(spoken).toContain("Rest and drink water.");
    expect(spoken).toContain("See a clinic if it gets worse.");
    expect(spoken).not.toContain("console.log");
    expect(spoken).not.toContain("https://");
    expect(spoken).not.toContain("|");
  });
});
