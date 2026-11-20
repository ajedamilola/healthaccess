"use client";

import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { PasswordField } from "@/components/arc/password-field/password-field";
import { PasswordStrength } from "@/components/arc/password-strength/password-strength";
import { useRegister } from "@/api/hooks/session";
import { fieldErrors, toApiError } from "@/api/errors";
import { registerBodySchema } from "@/api/schemas";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import styles from "./auth-form.module.css";

const emptyForm = {
  firstName: "",
  lastName: "",
  email: "",
  password: "",
  passwordConfirmation: "",
  dob: "",
  phone: "",
};

export function RegisterForm({ nextPath }: { nextPath: string }) {
  const register = useRegister();
  const router = useRouter();
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function update(key: keyof typeof emptyForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (form.phone && !/^\+[1-9]\d{7,14}$/.test(form.phone.trim())) {
      setErrors({ phone: "Use a full number with country code, like +2348012345678." });
      return;
    }

    const payload = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim().toLowerCase(),
      password: form.password,
      password_confirmation: form.passwordConfirmation,
      ...(form.dob ? { dob: form.dob } : {}),
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
    };

    const parsed = registerBodySchema.safeParse(payload);
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (!nextErrors[key]) nextErrors[key] = issue.message;
      }
      setErrors(nextErrors);
      return;
    }

    setErrors({});
    try {
      await register.mutateAsync(parsed.data);
      // Offer the optional setup wizard first; it can be skipped and then continues to nextPath.
      router.replace(`/app/welcome?next=${encodeURIComponent(nextPath)}`);
      router.refresh();
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.code === "email_taken") {
        setErrors({ email: "This email is already registered." });
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
    <section className={styles.panel} aria-labelledby="register-title">
      <div className={styles.intro}>
        <h1 id="register-title" className={styles.title}>
          Create an account
        </h1>
        <p className={styles.subtitle}>Keep your health details in one place and choose what to share.</p>
      </div>

      {formError ? (
        <Alert tone="danger" title="Could not create the account">
          {formError}
        </Alert>
      ) : null}

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <div className={styles.row}>
          <Input
            label="First name"
            name="firstName"
            autoComplete="given-name"
            value={form.firstName}
            onChange={(event) => update("firstName", event.target.value)}
            error={errors.firstName || undefined}
            required
          />
          <Input
            label="Last name"
            name="lastName"
            autoComplete="family-name"
            value={form.lastName}
            onChange={(event) => update("lastName", event.target.value)}
            error={errors.lastName || undefined}
            required
          />
        </div>

        <Input
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={form.email}
          onChange={(event) => update("email", event.target.value)}
          error={errors.email || undefined}
          required
        />

        <PasswordStrength
          label="Password"
          name="password"
          autoComplete="new-password"
          value={form.password}
          onValueChange={(value) => update("password", value)}
          error={errors.password || undefined}
        />

        <PasswordField
          label="Confirm password"
          name="password_confirmation"
          autoComplete="new-password"
          value={form.passwordConfirmation}
          onChange={(event) => update("passwordConfirmation", event.target.value)}
          required
        />
        {errors.password_confirmation ? (
          <p className={styles.fieldError} role="alert">
            {errors.password_confirmation}
          </p>
        ) : null}

        <div className={styles.row}>
          <Input
            label="Date of birth (optional)"
            name="dob"
            type="date"
            autoComplete="bday"
            value={form.dob}
            onChange={(event) => update("dob", event.target.value)}
            error={errors.dob || undefined}
          />
          <Input
            label="Phone (optional)"
            name="phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="+2348012345678"
            value={form.phone}
            onChange={(event) => update("phone", event.target.value)}
            error={errors.phone || undefined}
          />
        </div>

        <Button type="submit" size="lg" loading={register.isPending} className={styles.submit}>
          Create account
        </Button>
      </form>

      <p className={styles.switch}>
        Already have an account? <Link href={`/login?next=${encodeURIComponent(nextPath)}`}>Sign in</Link>
      </p>
    </section>
  );
}
