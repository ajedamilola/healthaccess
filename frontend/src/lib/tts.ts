export const SPEECH_LANGUAGES = ["en", "pcm", "yo", "ha", "ig", "fr", "sw"] as const;

export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number];

export const MAX_SPEECH_CHARS = 4000;

export function speechLanguage(value: unknown): SpeechLanguage {
  const code = typeof value === "string" ? value.toLowerCase().split(/[-_]/)[0] : "";
  return (SPEECH_LANGUAGES as readonly string[]).includes(code) ? (code as SpeechLanguage) : "en";
}

export function trimForSpeech(text: string, limit = MAX_SPEECH_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence > limit / 2) return cut.slice(0, sentence + 1).trim();
  const word = cut.lastIndexOf(" ");
  return (word > limit / 2 ? cut.slice(0, word) : cut).trim();
}

export function markdownToSpeech(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]{0,3}[-*+][ \t]+/gm, "")
    .replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, "")
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, " ")
    .replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, " ")
    .replace(/[*_~]{1,3}/g, "");

  return trimForSpeech(plain);
}
