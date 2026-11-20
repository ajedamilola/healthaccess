"use client";

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { PasswordField } from "@/components/arc/password-field/password-field";
import { toApiError } from "@/api/errors";
import { useUpdateMe } from "@/api/hooks/record";
import { qk } from "@/api/keys";
import type { MeResponse, PatchMeBody } from "@/api/schemas";
import { isUpstreamTimeout, issueMessages, todayIso } from "./helpers";
import { FormError, StatusLine } from "./States";
import styles from "./record.module.css";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+[1-9]\d{7,14}$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const formSchema = z
  .object({
    firstName: z.string().trim().min(1, "Enter your first name.").max(100, "Use 100 characters or fewer."),
    lastName: z.string().trim().min(1, "Enter your last name.").max(100, "Use 100 characters or fewer."),
    email: z
      .string()
      .trim()
      .min(1, "Enter your email.")
      .max(320, "Use 320 characters or fewer.")
      .refine((value) => emailPattern.test(value), "Enter a valid email address."),
    phone: z
      .string()
      .trim()
      .refine(
        (value) => !value || phonePattern.test(value),
        "Use the full number with country code, for example +2348012345678.",
      ),
    dob: z
      .string()
      .trim()
      .refine((value) => !value || isoDatePattern.test(value), "Enter a valid date."),
    password: z.string(),
    confirmPassword: z.string(),
  })
  .superRefine((value, context) => {
    if (value.password && value.password.length < 8) {
      context.addIssue({
        code: "custom",
        path: ["password"],
        message: "Use at least 8 characters.",
      });
    }
    if (value.password && value.password !== value.confirmPassword) {
      context.addIssue({
        code: "custom",
        path: ["confirmPassword"],
        message: "Passwords do not match.",
      });
    }
    if (!value.password && value.confirmPassword) {
      context.addIssue({
        code: "custom",
        path: ["password"],
        message: "Enter a new password or clear the confirmation.",
      });
    }
  });

type FormState = z.infer<typeof formSchema>;

type Initial = Pick<FormState, "firstName" | "lastName" | "email" | "phone" | "dob">;

function splitName(displayName: string | null | undefined): [string, string] {
  const parts = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  return [parts[0] ?? "", parts.slice(1).join(" ")];
}

function dateOfBirth(me: MeResponse): string {
  const value = me.field_values?.date_of_birth ?? me.fields.find((field) => field.key === "date_of_birth")?.value;
  return typeof value === "string" ? value.slice(0, 10) : "";
}

function initialFor(me: MeResponse, knownPhone: string): Initial {
  const [firstName, lastName] = splitName(me.account.display_name);
  return {
    firstName,
    lastName,
    email: me.account.email,
    phone: knownPhone,
    dob: dateOfBirth(me),
  };
}

export function AccountSection({ me }: { me: MeResponse }) {
  const updateMe = useUpdateMe();
  const queryClient = useQueryClient();
  const [knownPhone, setKnownPhone] = useState("");
  const initial = initialFor(me, knownPhone);
  const [form, setForm] = useState<FormState>({
    ...initial,
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const emailChanged = form.email.trim() !== initial.email;
  const phoneChanged = form.phone.trim() !== initial.phone;
  const verificationNotice = emailChanged || phoneChanged;

  function update(key: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(null);
    setClientError(null);
    setFormError(null);
    setErrors((current) => (current[key] ? { ...current, [key]: "" } : current));
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setSaved(null);
    setClientError(null);
    setFormError(null);
    setErrors({});

    const parsed = formSchema.safeParse(form);
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !nextErrors[key]) nextErrors[key] = issue.message;
      }
      setErrors(nextErrors);
      const first = Object.keys(nextErrors)[0];
      if (first) window.setTimeout(() => document.getElementById(`profile-${first}`)?.focus(), 0);
      return;
    }

    if (initial.dob && !parsed.data.dob) {
      setErrors({ dob: "Enter your date of birth. It cannot be cleared here." });
      return;
    }
    if (initial.phone && !parsed.data.phone) {
      setErrors({ phone: "Enter a phone number. A saved number cannot be cleared here." });
      return;
    }

    const body: PatchMeBody = {};
    if (parsed.data.firstName !== initial.firstName) body.firstName = parsed.data.firstName;
    if (parsed.data.lastName !== initial.lastName) body.lastName = parsed.data.lastName;
    if (parsed.data.email !== initial.email) body.email = parsed.data.email;
    if (parsed.data.phone !== initial.phone) body.phone = parsed.data.phone;
    if (parsed.data.dob !== initial.dob) body.dob = parsed.data.dob;
    if (parsed.data.password) body.password = parsed.data.password;

    if (!Object.keys(body).length) {
      setClientError("Make a change before saving.");
      return;
    }

    try {
      await updateMe.mutateAsync(body);
      if (body.phone) setKnownPhone(body.phone);
      setForm((current) => ({ ...current, password: "", confirmPassword: "" }));
      setSaved(
        emailChanged || phoneChanged
          ? "Account details saved. Verify your updated contact details."
          : "Account details saved.",
      );
    } catch (error) {
      const apiError = toApiError(error);
      if (isUpstreamTimeout(error)) {
        // The write may have landed. Read the current account before showing a retry.
        await queryClient.refetchQueries({ queryKey: qk.me });
        setFormError(error);
        return;
      }
      if (apiError.code === "email_taken") {
        setErrors({ email: "This email is already registered." });
        document.getElementById("profile-email")?.focus();
        return;
      }
      if (apiError.code === "validation_error") {
        const known = ["firstName", "lastName", "email", "phone", "dob", "password"];
        const messages = issueMessages(error, known);
        setErrors(messages);
        const first = Object.keys(messages)[0];
        if (first) window.setTimeout(() => document.getElementById(`profile-${first}`)?.focus(), 0);
        return;
      }
      setFormError(error);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="account-title">
      <div className={styles.sectionHead}>
        <div className={styles.sectionCopy}>
          <h2 id="account-title" className={styles.sectionTitle}>
            Account
          </h2>
          <p className={styles.sectionNote}>
            Your name, sign-in email and contact number. Password changes apply to this account only.
          </p>
        </div>
      </div>

      {verificationNotice ? (
        <Alert tone="info" title="Verification resets">
          Changing your email or phone clears its verification. You will need to verify it again after saving.
        </Alert>
      ) : null}

      {formError ? <FormError error={formError} onRetry={() => void submit()} /> : null}

      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.row}>
          <Input
            id="profile-firstName"
            label="First name"
            name="firstName"
            autoComplete="given-name"
            value={form.firstName}
            onChange={(event) => update("firstName", event.target.value)}
            error={errors.firstName || undefined}
            maxLength={100}
            required
          />
          <Input
            id="profile-lastName"
            label="Last name"
            name="lastName"
            autoComplete="family-name"
            value={form.lastName}
            onChange={(event) => update("lastName", event.target.value)}
            error={errors.lastName || undefined}
            maxLength={100}
            required
          />
        </div>

        <Input
          id="profile-email"
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={form.email}
          onChange={(event) => update("email", event.target.value)}
          description="Changing your email resets email verification."
          error={errors.email || undefined}
          maxLength={320}
          required
        />

        <div className={styles.row}>
          <Input
            id="profile-phone"
            label="Phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="+2348012345678"
            value={form.phone}
            onChange={(event) => update("phone", event.target.value)}
            description="Leave blank to keep the saved number. Changing it resets phone verification."
            error={errors.phone || undefined}
            maxLength={16}
          />
          <Input
            id="profile-dob"
            label="Date of birth"
            name="dob"
            type="date"
            autoComplete="bday"
            max={todayIso()}
            value={form.dob}
            onChange={(event) => update("dob", event.target.value)}
            error={errors.dob || undefined}
          />
        </div>

        <div className={styles.subSection}>
          <h3 className={styles.subTitle}>Change password</h3>
          <p className={styles.note}>Leave both password fields blank to keep the current password.</p>
          <PasswordField
            id="profile-password"
            label="New password"
            name="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(event) => update("password", event.target.value)}
            description="At least 8 characters."
            maxLength={128}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? "profile-password-error" : undefined}
          />
          {errors.password ? (
            <p id="profile-password-error" className={styles.fieldError} role="alert">
              {errors.password}
            </p>
          ) : null}
          <PasswordField
            id="profile-confirmPassword"
            label="Confirm new password"
            name="confirmPassword"
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={(event) => update("confirmPassword", event.target.value)}
            maxLength={128}
            aria-invalid={errors.confirmPassword ? true : undefined}
            aria-describedby={errors.confirmPassword ? "profile-confirm-password-error" : undefined}
          />
          {errors.confirmPassword ? (
            <p id="profile-confirm-password-error" className={styles.fieldError} role="alert">
              {errors.confirmPassword}
            </p>
          ) : null}
        </div>

        {clientError ? (
          <p className={styles.fieldError} role="alert">
            {clientError}
          </p>
        ) : null}

        <div className={styles.actions}>
          <Button type="submit" loading={updateMe.isPending} disabled={updateMe.isPending}>
            Save account details
          </Button>
          <StatusLine>{saved}</StatusLine>
        </div>
      </form>
    </section>
  );
}
