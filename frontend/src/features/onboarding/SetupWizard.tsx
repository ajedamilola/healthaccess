"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, HeartPulse, MapPin, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Select } from "@/components/arc/select/select";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { TagInput } from "@/components/arc/tag-input/tag-input";
import { toApiError } from "@/api/errors";
import { useMe, usePutMedical, useUpdateMe } from "@/api/hooks/record";
import type { MeResponse, PatchMeBody, PutMedicalBody } from "@/api/schemas";
import { safeNextPath } from "@/lib/safe-redirect";
import {
  COUNTRY_OPTIONS,
  LANGUAGE_OPTIONS,
  PREGNANCY_OPTIONS,
  SEX_OPTIONS,
  UNSET,
} from "@/features/record/PersonalSection";
import styles from "./wizard.module.css";

export const ONBOARDING_KEY = "ha.onboarding.status";

const STEPS = [
  { id: "about", label: "About you", icon: UserRound },
  { id: "location", label: "Location", icon: MapPin },
  { id: "health", label: "Health", icon: HeartPulse },
  { id: "contact", label: "Emergency contact", icon: ShieldCheck },
] as const;

type StepId = (typeof STEPS)[number]["id"] | "intro" | "done";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((value) => ({ value, label: value }));
const GENOTYPES = ["AA", "AS", "AC", "SS", "SC"].map((value) => ({ value, label: value }));

function remember(status: "done" | "skipped") {
  try {
    window.localStorage.setItem(ONBOARDING_KEY, status);
  } catch {
    // Only a convenience.
  }
}

function text(me: MeResponse | undefined, key: string): string {
  const value = me?.field_values?.[key];
  return typeof value === "string" ? value : "";
}

function list(me: MeResponse | undefined, key: string): string[] {
  const value = me?.field_values?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function options(base: { value: string; label: string }[], withUnset = true) {
  return withUnset ? [{ value: UNSET, label: "Not set" }, ...base.filter((option) => option.value !== UNSET)] : base;
}

function pick(value: string, all: { value: string }[]) {
  return value && all.some((option) => option.value === value) ? value : UNSET;
}

interface Draft {
  dob: string;
  gender: string;
  pregnancyStatus: string;
  city: string;
  state: string;
  country: string;
  preferredLanguage: string;
  allergies: string[];
  medications: string[];
  conditions: string[];
  bloodType: string;
  genoType: string;
  contactName: string;
  contactPhone: string;
}

function draftFrom(me: MeResponse | undefined): Draft {
  return {
    dob: text(me, "date_of_birth").slice(0, 10),
    gender: text(me, "gender"),
    pregnancyStatus: text(me, "pregnancy_status"),
    city: text(me, "city") || me?.profile.home_area?.city || "",
    state: text(me, "state") || me?.profile.home_area?.region || "",
    country: text(me, "country"),
    preferredLanguage: me?.profile.preferred_language || "en",
    allergies: me?.allergies.map((allergy) => allergy.name) ?? [],
    medications: list(me, "current_medications"),
    conditions: list(me, "conditions"),
    bloodType: text(me, "blood_group"),
    genoType: text(me, "genotype"),
    contactName: text(me, "emergency_contact_name"),
    contactPhone: text(me, "emergency_contact_phone"),
  };
}

export function SetupWizard({ nextPath }: { nextPath?: string }) {
  const router = useRouter();
  const me = useMe();
  const updateMe = useUpdateMe();
  const putMedical = usePutMedical();
  const [step, setStep] = useState<StepId>("intro");
  const [draftState, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const draft = draftState ?? draftFrom(me.data);
  const destination = safeNextPath(nextPath);
  const saving = updateMe.isPending || putMedical.isPending;
  const index = STEPS.findIndex((item) => item.id === step);

  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    setError(null);
    setFieldError((current) => (current[key] ? { ...current, [key]: "" } : current));
    setDraft((current) => ({ ...(current ?? draftFrom(me.data)), [key]: value === UNSET ? "" : value }));
  }

  function skipAll() {
    remember("skipped");
    router.replace(destination);
  }

  function go(next: StepId) {
    setError(null);
    setFieldError({});
    if (next === "done") remember("done");
    setStep(next);
    if (typeof window !== "undefined") window.scrollTo?.({ top: 0 });
  }

  function nextOf(current: StepId): StepId {
    const position = STEPS.findIndex((item) => item.id === current);
    return position >= 0 && position < STEPS.length - 1 ? STEPS[position + 1]!.id : "done";
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const initial = draftFrom(me.data);
    try {
      if (step === "about") {
        const body: PatchMeBody = {};
        if (draft.dob && draft.dob !== initial.dob) body.dob = draft.dob;
        if (draft.gender !== initial.gender) body.gender = draft.gender;
        if (draft.pregnancyStatus !== initial.pregnancyStatus) body.pregnancyStatus = draft.pregnancyStatus;
        if (Object.keys(body).length) await updateMe.mutateAsync(body);
      } else if (step === "location") {
        const body: PatchMeBody = {};
        if (draft.city !== initial.city) body.city = draft.city.trim();
        if (draft.state !== initial.state) body.state = draft.state.trim();
        if (draft.country !== initial.country) body.country = draft.country;
        if (draft.preferredLanguage !== initial.preferredLanguage) body.preferredLanguage = draft.preferredLanguage;
        if (Object.keys(body).length) await updateMe.mutateAsync(body);
      } else if (step === "health") {
        const body: PutMedicalBody = {};
        const same = (a: string[], b: string[]) => a.join("\u0000") === b.join("\u0000");
        if (!same(draft.allergies, initial.allergies)) {
          const existing = new Map((me.data?.allergies ?? []).map((allergy) => [allergy.name, allergy]));
          body.allergies = draft.allergies.map((name) => {
            // The list is replaced as a whole, so keep each existing allergy's details.
            const kept = existing.get(name);
            return {
              name,
              ...(kept?.severity ? { severity: kept.severity } : {}),
              ...(kept?.diagnosis_date ? { diagnosisDate: kept.diagnosis_date.slice(0, 10) } : {}),
            };
          });
        }
        if (!same(draft.medications, initial.medications)) body.existingMedications = draft.medications;
        if (!same(draft.conditions, initial.conditions)) body.existingMedicalConditions = draft.conditions;
        if (draft.bloodType && draft.bloodType !== initial.bloodType) body.bloodType = draft.bloodType;
        if (draft.genoType && draft.genoType !== initial.genoType) body.genoType = draft.genoType;
        if (Object.keys(body).length) await putMedical.mutateAsync(body);
      } else if (step === "contact") {
        const phone = draft.contactPhone.trim();
        if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) {
          setFieldError({ contactPhone: "Use the full number with country code, for example +2348012345678." });
          return;
        }
        const body: PutMedicalBody = {};
        if (draft.contactName.trim() && draft.contactName !== initial.contactName)
          body.emergencyContactName = draft.contactName.trim();
        if (phone && phone !== initial.contactPhone) body.emergencyContactPhone = phone;
        if (Object.keys(body).length) await putMedical.mutateAsync(body);
      }
      setDraft(null);
      go(nextOf(step));
    } catch (caught) {
      setError(toApiError(caught).message);
    }
  }

  if (me.isPending) {
    return (
      <div className={styles.page}>
        <Skeleton lines={6} label="Loading your setup" />
      </div>
    );
  }

  if (step === "intro") {
    const name = (me.data?.account.display_name ?? "").split(/\s+/)[0];
    return (
      <div className={styles.page}>
        <section className={styles.card} aria-labelledby="setup-title">
          <span className={styles.badge} aria-hidden="true">
            <Sparkles size={22} />
          </span>
          <h1 id="setup-title" className={styles.title}>
            {name ? `Welcome, ${name}!` : "Welcome to HealthAccess"}
          </h1>
          <p className={styles.lead}>
            A few quick questions help the assistant, care search and SMS give advice that fits you: where you live, your age,
            allergies and medicines. It takes about two minutes. Everything is optional and you can change it any time.
          </p>
          <ul className={styles.benefits}>
            <li>Advice that accounts for your age, allergies and medicines</li>
            <li>Nearby care and the right emergency number for where you are</li>
            <li>Nothing is shared with anyone unless you choose to</li>
          </ul>
          <div className={styles.actions}>
            <Button onClick={() => go("about")}>Get started</Button>
            <Button variant="ghost" onClick={skipAll}>
              Skip for now
            </Button>
          </div>
        </section>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className={styles.page}>
        <section className={styles.card} aria-labelledby="setup-done">
          <span className={styles.badge} aria-hidden="true">
            <CheckCircle2 size={22} />
          </span>
          <h1 id="setup-done" className={styles.title}>
            You&apos;re all set
          </h1>
          <p className={styles.lead}>
            Your answers will now personalise the assistant and care search. You can update them any time from your profile.
          </p>
          <div className={styles.actions}>
            <Button onClick={() => router.replace("/app/assistant")}>Talk to the assistant</Button>
            <Button variant="secondary" onClick={() => router.replace(destination)}>
              Go to my dashboard
            </Button>
          </div>
        </section>
      </div>
    );
  }

  const current = STEPS[index]!;
  const Icon = current.icon;
  const sexOptions = options(SEX_OPTIONS);
  const pregnancyOptions = options(PREGNANCY_OPTIONS);
  const countryOptions = options(COUNTRY_OPTIONS);

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <span className={styles.stepCount}>
          Step {index + 1} of {STEPS.length}
        </span>
        <button type="button" className={styles.skipAll} onClick={skipAll}>
          Skip setup
        </button>
      </div>
      <div className={styles.progress} role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={index + 1}>
        {STEPS.map((item, position) => (
          <span key={item.id} data-active={position <= index || undefined} />
        ))}
      </div>

      <form className={styles.card} onSubmit={save} noValidate aria-labelledby="step-title">
        <span className={styles.badge} aria-hidden="true">
          <Icon size={22} />
        </span>
        <h1 id="step-title" className={styles.title}>
          {current.id === "about"
            ? "Tell us a little about you"
            : current.id === "location"
              ? "Where are you based?"
              : current.id === "health"
                ? "Any allergies, medicines or conditions?"
                : "Who should we contact in an emergency?"}
        </h1>
        <p className={styles.lead}>
          {current.id === "about"
            ? "Age and sex change which causes are likely and which medicines are safe."
            : current.id === "location"
              ? "Illnesses like malaria, nearby care and the emergency number depend on where you are."
              : current.id === "health"
                ? "So the assistant never suggests something you react to and can check for interactions."
                : "Only shown if you choose to share it on your Emergency summary."}
        </p>

        {error ? (
          <Alert tone="danger" title="Could not save">
            {error}
          </Alert>
        ) : null}

        <div className={styles.fields}>
          {current.id === "about" ? (
            <>
              <Input
                label="Date of birth"
                type="date"
                value={draft.dob}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(event) => change("dob", event.target.value)}
              />
              <Select
                label="Sex"
                options={sexOptions}
                value={pick(draft.gender, sexOptions)}
                onValueChange={(value) => change("gender", value)}
              />
              {draft.gender !== "Male" ? (
                <Select
                  label="Pregnancy"
                  options={pregnancyOptions}
                  value={pick(draft.pregnancyStatus, pregnancyOptions)}
                  onValueChange={(value) => change("pregnancyStatus", value)}
                />
              ) : null}
            </>
          ) : null}

          {current.id === "location" ? (
            <>
              <div className={styles.row}>
                <Input
                  label="City or town"
                  placeholder="For example, Ikeja"
                  autoComplete="address-level2"
                  value={draft.city}
                  maxLength={200}
                  onChange={(event) => change("city", event.target.value)}
                />
                <Input
                  label="State or region"
                  placeholder="For example, Lagos"
                  autoComplete="address-level1"
                  value={draft.state}
                  maxLength={200}
                  onChange={(event) => change("state", event.target.value)}
                />
              </div>
              <Select
                label="Country"
                options={countryOptions}
                value={pick(draft.country, countryOptions)}
                onValueChange={(value) => change("country", value)}
              />
              <Select
                label="Preferred language"
                description="The assistant replies in this language."
                options={LANGUAGE_OPTIONS}
                value={draft.preferredLanguage || "en"}
                onValueChange={(value) => change("preferredLanguage", value)}
              />
            </>
          ) : null}

          {current.id === "health" ? (
            <>
              <TagInput
                label="Allergies"
                value={draft.allergies}
                onValueChange={(value) => change("allergies", value)}
                placeholder="For example, Penicillin"
                description="Press Enter after each one."
              />
              <TagInput
                label="Medicines you take regularly"
                value={draft.medications}
                onValueChange={(value) => change("medications", value)}
                placeholder="For example, Amlodipine 5mg"
              />
              <TagInput
                label="Long-term conditions"
                value={draft.conditions}
                onValueChange={(value) => change("conditions", value)}
                placeholder="For example, Asthma"
              />
              <div className={styles.row}>
                <Select
                  label="Blood group"
                  options={options(BLOOD_GROUPS)}
                  value={pick(draft.bloodType, BLOOD_GROUPS)}
                  onValueChange={(value) => change("bloodType", value)}
                />
                <Select
                  label="Genotype"
                  options={options(GENOTYPES)}
                  value={pick(draft.genoType, GENOTYPES)}
                  onValueChange={(value) => change("genoType", value)}
                />
              </div>
            </>
          ) : null}

          {current.id === "contact" ? (
            <>
              <Input
                label="Contact name"
                value={draft.contactName}
                maxLength={200}
                onChange={(event) => change("contactName", event.target.value)}
              />
              <Input
                label="Contact phone"
                type="tel"
                inputMode="tel"
                placeholder="+2348012345678"
                value={draft.contactPhone}
                maxLength={16}
                error={fieldError.contactPhone || undefined}
                onChange={(event) => change("contactPhone", event.target.value)}
              />
            </>
          ) : null}
        </div>

        <div className={styles.actions}>
          <Button type="submit" loading={saving} disabled={saving}>
            {index === STEPS.length - 1 ? "Save and finish" : "Save and continue"}
          </Button>
          <Button type="button" variant="ghost" disabled={saving} onClick={() => go(nextOf(step))}>
            Skip this step
          </Button>
          {index > 0 ? (
            <Button type="button" variant="ghost" disabled={saving} onClick={() => go(STEPS[index - 1]!.id)}>
              Back
            </Button>
          ) : null}
        </div>
      </form>

      <p className={styles.footnote}>
        You can change any of this later in <Link href="/app/profile">your profile</Link>.
      </p>
    </div>
  );
}
