"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { toApiError } from "@/api/errors";
import { useOpenCode } from "@/api/hooks/practitioner";
import { qk } from "@/api/keys";
import type { OpenCodeResponse } from "@/api/schemas";
import { GRANT_CODE_LENGTH, PATIENT_CODE_LENGTH, formatFieldValue, groupCode } from "./code";
import { ErrorNotice } from "./states";
import styles from "./sharing.module.css";

/** Keep digits only and show them in groups of four while typing. */
export function normaliseCode(value: string) {
  return value.replace(/\D/g, "").slice(0, PATIENT_CODE_LENGTH);
}

/**
 * One box for every code. A 12-digit emergency code shows the emergency summary here;
 * an 8-digit temporary code opens the shared record for verified practitioners.
 */
export function OpenCodeScreen() {
  const open = useOpenCode();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [result, setResult] = useState<OpenCodeResponse | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { reset } = open;
  const apiError = open.error ? toApiError(open.error) : null;

  useEffect(() => () => reset(), [reset]);

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (open.isPending) return;
    setResult(null);
    if (code.length !== GRANT_CODE_LENGTH && code.length !== PATIENT_CODE_LENGTH) {
      setFieldError("Enter the full code: 8 digits for a temporary code, or 12 for an emergency code.");
      input.current?.focus();
      return;
    }
    setFieldError(null);
    reset();
    try {
      const data = await open.mutateAsync(code);
      if (data.available && data.kind === "grant" && data.read_session_id) {
        queryClient.setQueryData(qk.readSession(data.read_session_id), data);
        setCode("");
        router.push(`/practitioner/records/${data.read_session_id}`);
        return;
      }
      setResult(data);
    } catch {
      // The error notice below keeps the code so the person can retry.
    }
  }

  const unavailable = result && (!result.available || !result.fields?.length);
  const practitionerOnly = apiError?.code === "practitioner_required";

  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Open shared health information</h1>
        <p className={styles.subtitle}>
          Enter the code the patient gave you. One code is all you need: it works whether it is their 12-digit emergency
          code or an 8-digit code that lasts a short time.
        </p>
      </header>

      <section className={styles.panel} aria-labelledby="open-code-title">
        <div className={styles.panelHead}>
          <div className={styles.panelIntro}>
            <h2 id="open-code-title" className={styles.panelTitle}>
              Enter the code
            </h2>
            <p className={styles.panelCopy}>Digits only. Spaces are fine.</p>
          </div>
        </div>

        <form className={styles.form} onSubmit={submit} noValidate>
          <Input
            ref={input}
            label="Access code"
            name="access-code"
            placeholder="1234 5678"
            value={groupCode(code)}
            onChange={(event) => {
              setCode(normaliseCode(event.target.value));
              setFieldError(null);
              setResult(null);
              reset();
            }}
            inputMode="numeric"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={PATIENT_CODE_LENGTH + 2}
            error={fieldError ?? undefined}
            required
          />

          {open.isPending ? <Skeleton lines={3} label="Opening shared information" /> : null}

          {practitionerOnly ? (
            <Alert tone="warning" title="This code is for verified practitioners">
              Temporary codes open only for verified practitioners. If you are helping in an emergency, ask the patient for
              their 12-digit emergency code instead.
            </Alert>
          ) : apiError ? (
            <ErrorNotice
              title="Could not open this code"
              error={open.error}
              onRetry={() => void submit()}
              retrying={open.isPending}
            />
          ) : null}

          <div className={styles.actions}>
            <Button type="submit" loading={open.isPending}>
              Open
            </Button>
            {code ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setCode("");
                  setResult(null);
                  reset();
                  input.current?.focus();
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </form>
      </section>

      {unavailable ? (
        <Alert tone="info" title="That code did not work">
          Check the digits. Temporary codes expire, so the patient may need to give you a new one.
        </Alert>
      ) : null}

      {result && !unavailable ? (
        <section className={styles.panel} aria-labelledby="open-result-title">
          <div className={styles.panelHead}>
            <div className={styles.panelIntro}>
              <h2 id="open-result-title" className={styles.panelTitle}>
                Emergency information
              </h2>
              <p className={styles.panelCopy}>Read-only, in the order the patient chose.</p>
            </div>
          </div>
          <span className={styles.srOnly} role="status">
            Shared emergency information loaded.
          </span>
          <dl className={styles.resultList}>
            {result.fields?.map((field) => (
              <div key={field.key}>
                <dt>{field.label}</dt>
                <dd>{formatFieldValue(field.value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}
