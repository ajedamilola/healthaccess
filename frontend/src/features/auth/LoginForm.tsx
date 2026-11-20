"use client";

import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { PasswordField } from "@/components/arc/password-field/password-field";
import { useLogin } from "@/api/hooks/session";
import { fieldErrors, toApiError } from "@/api/errors";
import { loginBodySchema } from "@/api/schemas";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import styles from "./auth-form.module.css";

export function LoginForm({ nextPath }: { nextPath: string }) {
  const login = useLogin();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = loginBodySchema.safeParse({ email, password });
    if (!parsed.success) {
      setErrors({
        email: email.trim() ? "" : "Enter your email.",
        password: password ? "" : "Enter your password.",
      });
      return;
    }

    setErrors({});
    try {
      await login.mutateAsync({ email: email.trim().toLowerCase(), password });
      router.replace(nextPath);
      router.refresh();
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.code === "invalid_credentials") {
        setFormError("Email or password is incorrect");
        return;
      }
      if (apiError.code === "account_inactive") {
        setFormError("This account is not active. Contact support if you need help.");
        return;
      }
      const fields = fieldErrors(error);
      if (Object.keys(fields).length) {
        setErrors(fields);
        return;
      }
      setFormError(apiError.message);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="login-title">
      <div className={styles.intro}>
        <h1 id="login-title" className={styles.title}>
          Sign in
        </h1>
        <p className={styles.subtitle}>See your record, sharing choices and care items.</p>
      </div>

      {formError ? (
        <Alert tone="danger" title="Could not sign in">
          {formError}
        </Alert>
      ) : null}

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <Input
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={errors.email || undefined}
          required
        />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {errors.password ? (
          <p className={styles.fieldError} role="alert">
            {errors.password}
          </p>
        ) : null}
        <p className={styles.switch}>
          <Link href="/forgot-password">Forgot your password?</Link>
        </p>

        <Button type="submit" size="lg" loading={login.isPending} className={styles.submit}>
          Sign in
        </Button>
      </form>

      <p className={styles.switch}>
        New here? <Link href={`/register?next=${encodeURIComponent(nextPath)}`}>Create an account</Link>
      </p>
    </section>
  );
}
