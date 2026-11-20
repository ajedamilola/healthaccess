"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { MapPin } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Select } from "@/components/arc/select/select";
import { useUpdateMe } from "@/api/hooks/record";
import type { MeResponse, PatchMeBody } from "@/api/schemas";
import { issueMessages } from "./helpers";
import { FormError, StatusLine } from "./States";
import styles from "./record.module.css";

/** Radix Select cannot hold an empty value, so "not set" uses a sentinel. */
export const UNSET = "__unset";

export const COUNTRY_OPTIONS = [
  { value: UNSET, label: "Not set" },
  { value: "Nigeria", label: "Nigeria" },
  { value: "Ghana", label: "Ghana" },
  { value: "Kenya", label: "Kenya" },
  { value: "South Africa", label: "South Africa" },
  { value: "Uganda", label: "Uganda" },
  { value: "Tanzania", label: "Tanzania" },
  { value: "Rwanda", label: "Rwanda" },
  { value: "Cameroon", label: "Cameroon" },
  { value: "Senegal", label: "Senegal" },
  { value: "Egypt", label: "Egypt" },
  { value: "United Kingdom", label: "United Kingdom" },
  { value: "United States", label: "United States" },
  { value: "Canada", label: "Canada" },
  { value: "Other", label: "Other" },
];

export const SEX_OPTIONS = [
  { value: UNSET, label: "Not set" },
  { value: "Female", label: "Female" },
  { value: "Male", label: "Male" },
  { value: "Intersex", label: "Intersex" },
  { value: "Prefer not to say", label: "Prefer not to say" },
];

export const PREGNANCY_OPTIONS = [
  { value: UNSET, label: "Not set" },
  { value: "Not pregnant", label: "Not pregnant" },
  { value: "Pregnant", label: "Pregnant" },
  { value: "Trying to conceive", label: "Trying to conceive" },
  { value: "Breastfeeding", label: "Breastfeeding" },
];

export const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "pcm", label: "Nigerian Pidgin" },
  { value: "yo", label: "Yoruba" },
  { value: "ha", label: "Hausa" },
  { value: "ig", label: "Igbo" },
  { value: "fr", label: "French" },
  { value: "sw", label: "Swahili" },
];

const SMOKING_OPTIONS = [
  { value: UNSET, label: "Not set" },
  { value: "Never smoked", label: "Never smoked" },
  { value: "Former smoker", label: "Former smoker" },
  { value: "Smokes occasionally", label: "Occasionally" },
  { value: "Smokes daily", label: "Daily" },
];

const ALCOHOL_OPTIONS = [
  { value: UNSET, label: "Not set" },
  { value: "None", label: "None" },
  { value: "Occasional", label: "Occasional" },
  { value: "Weekly", label: "Weekly" },
  { value: "Daily", label: "Daily" },
];

const ACTIVITY_OPTIONS = [
  { value: UNSET, label: "Not set" },
  { value: "Mostly inactive", label: "Mostly inactive" },
  { value: "Light activity", label: "Light (walks, light chores)" },
  { value: "Moderate activity", label: "Moderate (2-3 workouts a week)" },
  { value: "Very active", label: "Very active" },
];

type PersonalForm = {
  city: string;
  state: string;
  country: string;
  gender: string;
  pregnancyStatus: string;
  smokingStatus: string;
  alcoholUse: string;
  activityLevel: string;
  preferredLanguage: string;
};

const FIELD_KEYS: Record<Exclude<keyof PersonalForm, "preferredLanguage">, string> = {
  city: "city",
  state: "state",
  country: "country",
  gender: "gender",
  pregnancyStatus: "pregnancy_status",
  smokingStatus: "smoking_status",
  alcoholUse: "alcohol_use",
  activityLevel: "activity_level",
};

function stored(me: MeResponse, key: string): string {
  const value = me.field_values?.[key];
  return typeof value === "string" ? value : "";
}

export function initialPersonal(me: MeResponse): PersonalForm {
  const form = Object.fromEntries(
    Object.entries(FIELD_KEYS).map(([inputKey, fieldKey]) => [inputKey, stored(me, fieldKey)]),
  ) as Omit<PersonalForm, "preferredLanguage">;
  if (!form.city && me.profile.home_area) form.city = me.profile.home_area.city || me.profile.home_area.name;
  if (!form.state && me.profile.home_area) form.state = me.profile.home_area.region;
  return { ...form, preferredLanguage: me.profile.preferred_language || "en" };
}

/** Only changed fields are sent; clearing a value sends an empty string so the server removes it. */
export function personalChanges(initial: PersonalForm, form: PersonalForm): PatchMeBody {
  const body: PatchMeBody = {};
  for (const key of Object.keys(FIELD_KEYS) as Array<keyof typeof FIELD_KEYS>) {
    const next = form[key].trim();
    if (next !== initial[key].trim()) body[key] = next;
  }
  if (form.preferredLanguage !== initial.preferredLanguage) body.preferredLanguage = form.preferredLanguage;
  return body;
}

function selectValue(value: string, options: { value: string }[]) {
  if (!value) return UNSET;
  return options.some((option) => option.value === value) ? value : UNSET;
}

function withCurrent(options: { value: string; label: string }[], current: string) {
  return current && !options.some((option) => option.value === current)
    ? [...options, { value: current, label: current }]
    : options;
}

export function PersonalSection({ me }: { me: MeResponse }) {
  const updateMe = useUpdateMe();
  const initial = initialPersonal(me);
  const [form, setForm] = useState<PersonalForm>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);
  const homeArea = me.profile.home_area;
  const showPregnancy = form.gender !== "Male";
  const changes = personalChanges(initial, form);
  const dirty = Object.keys(changes).length > 0;

  function update(key: keyof PersonalForm, value: string) {
    setStatus(null);
    setFormError(null);
    setErrors((current) => (current[key] ? { ...current, [key]: "" } : current));
    setForm((current) => ({ ...current, [key]: value === UNSET ? "" : value }));
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setStatus(null);
    setFormError(null);
    setErrors({});
    if (form.city.trim().length > 200 || form.state.trim().length > 200) {
      setErrors({ city: "Use 200 characters or fewer." });
      return;
    }
    if (!dirty) {
      setStatus("Nothing to save yet.");
      return;
    }
    const body = { ...changes };
    // Pregnancy does not apply when sex is set to male, so clear any stale value.
    if (form.gender === "Male" && initial.pregnancyStatus) body.pregnancyStatus = "";
    try {
      const data = await updateMe.mutateAsync(body);
      setForm(initialPersonal(data));
      const matched = data.profile.home_area;
      setStatus(
        body.city !== undefined || body.state !== undefined
          ? matched
            ? `Saved. Your area is set to ${matched.name}, ${matched.region}.`
            : "Saved. We could not match this to a care area yet, but the assistant will still use it."
          : "Saved. The assistant will use these details next time.",
      );
    } catch (error) {
      const messages = issueMessages(error, Object.keys(form));
      if (Object.keys(messages).length) setErrors(messages);
      else setFormError(error);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="about-you-title" id="about-you">
      <div className={styles.sectionHead}>
        <div className={styles.sectionCopy}>
          <h2 id="about-you-title" className={styles.sectionTitle}>
            About you and location
          </h2>
          <p className={styles.sectionNote}>
            These details personalise the health assistant, care search, SMS and USSD. Where you live changes which illnesses
            are likely, which care is nearby and which emergency number to call. Nothing here is shared in an emergency
            unless you choose it on Emergency summary.{" "}
            <Link href="/app/welcome?next=%2Fapp%2Fprofile">Use guided setup</Link>
          </p>
        </div>
        {homeArea ? (
          <Badge tone="success" dot>
            <MapPin aria-hidden="true" size={14} /> {homeArea.name}, {homeArea.region}
          </Badge>
        ) : null}
      </div>

      {formError ? <FormError error={formError} onRetry={() => void submit()} /> : null}

      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.subSection}>
          <h3 className={styles.subTitle}>Where you are</h3>
          <div className={styles.row}>
            <Input
              id="about-city"
              label="City or town"
              autoComplete="address-level2"
              placeholder="For example, Ikeja"
              value={form.city}
              onChange={(event) => update("city", event.target.value)}
              error={errors.city || undefined}
              maxLength={200}
            />
            <Input
              id="about-state"
              label="State or region"
              autoComplete="address-level1"
              placeholder="For example, Lagos"
              value={form.state}
              onChange={(event) => update("state", event.target.value)}
              error={errors.state || undefined}
              maxLength={200}
            />
          </div>
          <div className={styles.row}>
            <Select
              id="about-country"
              label="Country"
              options={withCurrent(COUNTRY_OPTIONS, form.country)}
              value={selectValue(form.country, withCurrent(COUNTRY_OPTIONS, form.country))}
              onValueChange={(value) => update("country", value)}
            />
            <Select
              id="about-language"
              label="Preferred language"
              description="The assistant replies in this language."
              options={withCurrent(LANGUAGE_OPTIONS, form.preferredLanguage)}
              value={form.preferredLanguage || "en"}
              onValueChange={(value) => update("preferredLanguage", value)}
            />
          </div>
          {!homeArea && form.city ? (
            <Alert tone="info" title="Area not matched yet">
              We could not match this town to a care area. The assistant still uses it, and on SMS or USSD you can type your
              area when asked.
            </Alert>
          ) : null}
        </div>

        <div className={styles.subSection}>
          <h3 className={styles.subTitle}>About you</h3>
          <div className={styles.row}>
            <Select
              id="about-gender"
              label="Sex"
              options={withCurrent(SEX_OPTIONS, form.gender)}
              value={selectValue(form.gender, withCurrent(SEX_OPTIONS, form.gender))}
              onValueChange={(value) => update("gender", value)}
            />
            {showPregnancy ? (
              <Select
                id="about-pregnancy"
                label="Pregnancy"
                description="Changes which medicines and advice are safe."
                options={withCurrent(PREGNANCY_OPTIONS, form.pregnancyStatus)}
                value={selectValue(form.pregnancyStatus, withCurrent(PREGNANCY_OPTIONS, form.pregnancyStatus))}
                onValueChange={(value) => update("pregnancyStatus", value)}
              />
            ) : null}
          </div>
        </div>

        <div className={styles.subSection}>
          <h3 className={styles.subTitle}>Lifestyle</h3>
          <div className={styles.row}>
            <Select
              id="about-smoking"
              label="Smoking"
              options={withCurrent(SMOKING_OPTIONS, form.smokingStatus)}
              value={selectValue(form.smokingStatus, withCurrent(SMOKING_OPTIONS, form.smokingStatus))}
              onValueChange={(value) => update("smokingStatus", value)}
            />
            <Select
              id="about-alcohol"
              label="Alcohol"
              options={withCurrent(ALCOHOL_OPTIONS, form.alcoholUse)}
              value={selectValue(form.alcoholUse, withCurrent(ALCOHOL_OPTIONS, form.alcoholUse))}
              onValueChange={(value) => update("alcoholUse", value)}
            />
          </div>
          <Select
            id="about-activity"
            label="Physical activity"
            options={withCurrent(ACTIVITY_OPTIONS, form.activityLevel)}
            value={selectValue(form.activityLevel, withCurrent(ACTIVITY_OPTIONS, form.activityLevel))}
            onValueChange={(value) => update("activityLevel", value)}
          />
        </div>

        <div className={styles.actions}>
          <Button type="submit" loading={updateMe.isPending} disabled={updateMe.isPending || !dirty}>
            Save details
          </Button>
          <StatusLine>{status}</StatusLine>
        </div>
      </form>
    </section>
  );
}
