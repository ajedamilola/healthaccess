"use client";

import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { PasswordField } from "@/components/arc/password-field/password-field";
import { bff } from "@/api/client";
import { forgotPasswordBodySchema, resetPasswordBodySchema } from "@/api/schemas";
import { toApiError } from "@/api/errors";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import styles from "./auth-form.module.css";

function subscribeToHashChange(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function currentHash(): string | null {
  return window.location.hash;
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const parsed = forgotPasswordBodySchema.safeParse({ email });
    if (!parsed.success) {
      setError("Enter a valid email address.");
      return;
    }

    setPending(true);
    try {
      await bff.post("/api/auth/forgot-password", parsed.data);
      setSubmitted(true);
    } catch (reason) {
      setError(toApiError(reason).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="forgot-password-title">
      <div className={styles.intro}>
        <h1 id="forgot-password-title" className={styles.title}>
          Reset your password
        </h1>
        <p className={styles.subtitle}>
          Enter your account email and we’ll send a reset link if it matches an active account.
        </p>
      </div>

      {error ? (
        <Alert tone="danger" title="Could not request a reset">
          {error}
        </Alert>
      ) : null}
      {submitted ? (
        <Alert tone="success" title="Check your email">
          If an active account uses that email, a password reset link is on its way.
        </Alert>
      ) : (
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <Input
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <Button type="submit" size="lg" loading={pending} className={styles.submit}>
            Send reset link
          </Button>
        </form>
      )}

      <p className={styles.switch}>
        Remembered your password? <Link href="/login">Sign in</Link>
      </p>
    </section>
  );
}

export function ResetPasswordForm() {
  const hash = useSyncExternalStore(subscribeToHashChange, currentHash, () => null);
  const token = new URLSearchParams((hash ?? "").slice(1)).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }, [hash]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const parsed = resetPasswordBodySchema.safeParse({
      token,
      password,
      password_confirmation: confirmation,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check your password and try again.");
      return;
    }

    setPending(true);
    try {
      await bff.post("/api/auth/reset-password", parsed.data);
      setUpdated(true);
    } catch (reason) {
      const apiError = toApiError(reason);
      setError(
        apiError.code === "invalid_reset_link"
          ? "This reset link is invalid or has expired. Request a new one."
          : apiError.message,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="reset-password-title">
      <div className={styles.intro}>
        <h1 id="reset-password-title" className={styles.title}>
          Choose a new password
        </h1>
        <p className={styles.subtitle}>Reset links expire after 30 minutes.</p>
      </div>

      {error ? (
        <Alert tone="danger" title="Could not reset your password">
          {error}
        </Alert>
      ) : null}
      {updated ? (
        <Alert tone="success" title="Password updated">
          You can now sign in with your new password.
        </Alert>
      ) : token ? (
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <PasswordField
            label="New password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <PasswordField
            label="Confirm new password"
            name="password_confirmation"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
          />
          <Button type="submit" size="lg" loading={pending} className={styles.submit}>
            Update password
          </Button>
        </form>
      ) : hash !== null ? (
        <Alert tone="danger" title="Reset link is missing">
          Request a new reset link to continue.
        </Alert>
      ) : null}

      <p className={styles.switch}>
        <Link href="/login">Return to sign in</Link>
      </p>
    </section>
  );
}
