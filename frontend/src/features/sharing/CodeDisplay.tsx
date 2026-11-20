"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/arc/button/button";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { REVEAL_DURATION_MS, groupCode, maskCode } from "./code";
import styles from "./sharing.module.css";

export interface CodeDisplayProps {
  code: string;
  label: string;
  /** Patient codes mask by default and can be revealed for a short time. Receipt codes are shown once. */
  allowReveal?: boolean;
  defaultRevealed?: boolean;
  /** Test hook only; production uses the 30 second rule. */
  revealDurationMs?: number;
}

export function CodeDisplay({
  code,
  label,
  allowReveal = false,
  defaultRevealed = false,
  revealDurationMs = REVEAL_DURATION_MS,
}: CodeDisplayProps) {
  const codeId = useId();
  const [revealed, setRevealed] = useState(defaultRevealed);
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(revealDurationMs / 1000));
  const shown = allowReveal && !revealed ? maskCode(code) : groupCode(code);

  useEffect(() => {
    if (!allowReveal || !revealed) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, revealDurationMs - (Date.now() - startedAt));
      setSecondsLeft(Math.ceil(remaining / 1000));
      if (remaining === 0) {
        setRevealed(false);
        window.clearInterval(timer);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [allowReveal, revealed, revealDurationMs]);

  const status = useMemo(() => {
    if (!allowReveal) return `${label} is visible. It will not be shown again.`;
    if (!revealed) return `${label} is hidden.`;
    return `${label} is visible. It hides automatically after ${Math.ceil(revealDurationMs / 1000)} seconds.`;
  }, [allowReveal, label, revealed, revealDurationMs]);

  return (
    <div className={styles.codeDisplay}>
      <p id={codeId} className={styles.code}>
        {shown}
      </p>
      <div className={styles.codeActions}>
        <CopyButton value={code} label={`Copy ${label.toLowerCase()}`} />
        {allowReveal ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-pressed={revealed}
            aria-controls={codeId}
            onClick={() => {
              if (revealed) {
                setRevealed(false);
              } else {
                setSecondsLeft(Math.ceil(revealDurationMs / 1000));
                setRevealed(true);
              }
            }}
          >
            {revealed ? "Hide" : "Reveal"}
          </Button>
        ) : null}
      </div>
      <span className={styles.srOnly} role="status">
        {status}
      </span>
      {allowReveal && revealed ? (
        <p className={styles.revealNote} aria-hidden="true">
          Hides in {secondsLeft} {secondsLeft === 1 ? "second" : "seconds"}
        </p>
      ) : null}
    </div>
  );
}
