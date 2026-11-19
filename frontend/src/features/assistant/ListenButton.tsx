"use client";

import { Loader2, Square, Volume2 } from "lucide-react";
import { assistantLocale } from "./i18n";
import { useSpeech } from "./useSpeech";
import styles from "./assistant.module.css";

export function ListenButton({ id, text, language }: { id: string; text: string; language?: string | null }) {
  const replyLanguage = assistantLocale(language);
  const speech = useSpeech();
  const loading = speech.status === "loading" && speech.id === id;
  const playing = speech.status === "playing" && speech.id === id;
  const error = speech.status === "idle" && speech.id === id ? speech.error : null;

  return (
    <div className={styles.listenRow}>
      <button
        type="button"
        className={styles.listenButton}
        aria-label={playing ? "Stop reading this reply" : "Read this reply aloud"}
        aria-pressed={playing}
        disabled={loading}
        onClick={() => void speech.speak(id, text, replyLanguage)}
      >
        {loading ? (
          <Loader2 className={styles.listenSpin} size={14} aria-hidden="true" />
        ) : playing ? (
          <Square size={14} aria-hidden="true" />
        ) : (
          <Volume2 size={14} aria-hidden="true" />
        )}
        <span>{loading ? "Preparing audio…" : playing ? "Stop" : "Listen"}</span>
      </button>
      {error ? (
        <span className={styles.listenError} role="status">
          {error}
        </span>
      ) : null}
    </div>
  );
}
