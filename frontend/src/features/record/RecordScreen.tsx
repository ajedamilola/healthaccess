"use client";

import { useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { FileText } from "lucide-react";
import { Input } from "@/components/arc/input/input";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { TagInput } from "@/components/arc/tag-input/tag-input";
import { toApiError } from "@/api/errors";
import { useFields, useUpdateFields } from "@/api/hooks/record";
import type { FieldDefinition } from "@/api/schemas";
import {
  changedFieldValues,
  changedKeys,
  conflictChanges,
  draftFor,
  isUpstreamTimeout,
  isVersionConflict,
  issueMessages,
  valueForDraft,
  type FieldDraft,
} from "./helpers";
import { OfflineBanner } from "./OfflineBanner";
import { FormError, LoadError, PageIntro, StatusLine } from "./States";
import styles from "./record.module.css";

const fieldDomId = (key: string) => `record-field-${key}`;

type Conflict = {
  version: number;
};

export function RecordScreen() {
  const fieldsQuery = useFields();
  const updateFields = useUpdateFields();
  const [draftState, setDraftState] = useState<FieldDraft | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const fields = fieldsQuery.data?.fields ?? [];
  const draft = draftState ?? draftFor(fields);
  const dirtyKeys = changedKeys(draft, fields);

  function changeValue(key: string, value: string | string[]) {
    setSaved(null);
    setClientError(null);
    setFormError(null);
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setDraftState((current) => ({ ...(current ?? draftFor(fields)), [key]: value }));
  }

  async function submit(expectedVersion?: number, onlyKeys?: string[]) {
    if (!fieldsQuery.data) return;
    setSaved(null);
    setClientError(null);
    setFormError(null);
    setFieldErrors({});

    const keys = onlyKeys ?? changedKeys(draft, fieldsQuery.data.fields);
    if (!keys.length) {
      setClientError("Make a change before saving.");
      return;
    }

    try {
      await updateFields.mutateAsync({
        fields: changedFieldValues(draft, fieldsQuery.data.fields, keys),
        expected_version: expectedVersion ?? fieldsQuery.data.version,
      });
      setSaved("Record saved.");
      setConflict(null);
    } catch (error) {
      const apiError = toApiError(error);
      if (isUpstreamTimeout(error)) {
        // The write may have landed. Read the current values before showing a retry.
        await fieldsQuery.refetch();
        setFormError(error);
        return;
      }
      if (isVersionConflict(error)) {
        const refreshed = await fieldsQuery.refetch();
        if (refreshed.data) {
          const changes = conflictChanges(draft, refreshed.data.fields);
          if (changes.length) {
            setConflict({ version: refreshed.data.version });
          } else {
            setDraftState(draftFor(refreshed.data.fields));
            setSaved("The latest saved values already match your draft.");
          }
        } else {
          setFormError(error);
        }
        return;
      }
      if (apiError.code === "validation_error") {
        const messages = issueMessages(error, fields.map((field) => field.key));
        setFieldErrors(messages);
        const first = Object.keys(messages)[0];
        if (first) window.setTimeout(() => document.getElementById(fieldDomId(first))?.focus(), 0);
        return;
      }
      setFormError(error);
    }
  }

  function discardConflicts() {
    if (!fieldsQuery.data) return;
    setDraftState(draftFor(fieldsQuery.data.fields));
    setConflict(null);
    setSaved("Your draft was discarded. The latest saved values are shown.");
    setFieldErrors({});
  }

  const conflictRows = conflict ? conflictChanges(draft, fields) : [];

  if (fieldsQuery.isPending) {
    return (
      <div className={styles.page}>
        <PageIntro
          title="My record"
          subtitle="Keep the details you may need to share up to date. New fields are private until you choose to share them."
        />
        <OfflineBanner />
        <section className={styles.section} aria-label="Loading your record">
          <Skeleton lines={6} label="Loading your record" />
        </section>
      </div>
    );
  }

  if (fieldsQuery.isError && !fieldsQuery.data) {
    return (
      <div className={styles.page}>
        <PageIntro
          title="My record"
          subtitle="Keep the details you may need to share up to date. New fields are private until you choose to share them."
        />
        <OfflineBanner />
        <LoadError
          title="Could not load your record"
          error={fieldsQuery.error}
          onRetry={() => void fieldsQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageIntro
        title="My record"
        subtitle="Keep the details you may need to share up to date. New fields are private until you choose to share them."
      />
      <OfflineBanner />

      {conflict ? (
        <Alert tone="warning" title="This record changed since you opened it">
          Your draft is still here. Compare the saved values with your changes, then choose what to keep.
        </Alert>
      ) : null}

      {formError ? (
        <FormError error={formError} onRetry={() => void submit()} />
      ) : null}

      <section className={styles.section} aria-labelledby="record-fields-title">
        <div className={styles.sectionHead}>
          <div className={styles.sectionCopy}>
            <h2 id="record-fields-title" className={styles.sectionTitle}>
              Record fields
            </h2>
            <p className={styles.sectionNote}>
              New fields are private until you choose to share them. Only the fields you change are sent when you
              save.
            </p>
          </div>
          {dirtyKeys.length ? (
            <Badge tone="warning" size="sm">
              {`${dirtyKeys.length} unsaved ${dirtyKeys.length === 1 ? "change" : "changes"}`}
            </Badge>
          ) : null}
        </div>

        {fields.length === 0 ? (
          <EmptyState
            icon={<FileText size={24} strokeWidth={1.5} />}
            title="No fields to edit yet"
            description="Your record fields will appear here after they are set up. Contact support if this looks wrong."
            action={
              <Link className={styles.link} href="/app">
                Back to overview
              </Link>
            }
          />
        ) : (
          <>
            <div className={styles.fieldList}>
              {groupFields(fields).map((group) => (
                <fieldset key={group.title} className={styles.fieldGroup}>
                  <legend className={styles.groupTitle}>{group.title}</legend>
                  <div className={group.wide ? `${styles.fieldGrid} ${styles.fieldGridWide}` : styles.fieldGrid}>
                    {group.fields.map((field) => (
                      <FieldRow
                        key={field.key}
                        field={field}
                        value={draft[field.key] ?? valueForDraft(field.value)}
                        error={fieldErrors[field.key]}
                        onChange={(value) => changeValue(field.key, value)}
                      />
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>

            {conflict ? (
              <div className={styles.conflict}>
                <div className={styles.conflictGrid}>
                  {conflictRows.map((change) => (
                    <div key={change.key} className={styles.conflictColumn}>
                      <p className={styles.conflictHeading}>{change.label}</p>
                      <p className={styles.conflictValue}>
                        Saved value: <strong>{change.server}</strong>
                      </p>
                      <p className={styles.conflictValue}>
                        Your change: <strong>{change.mine}</strong>
                      </p>
                    </div>
                  ))}
                </div>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    loading={updateFields.isPending}
                    disabled={updateFields.isPending}
                    onClick={() => void submit(conflict.version, conflictRows.map((change) => change.key))}
                  >
                    Use my changes
                  </Button>
                  <Button type="button" variant="secondary" onClick={discardConflicts}>
                    Discard my changes
                  </Button>
                </div>
              </div>
            ) : null}

            {!conflict && clientError ? (
              <p className={styles.fieldError} role="alert">
                {clientError}
              </p>
            ) : null}

            {!conflict ? (
              <div className={styles.actions}>
                <Button
                  type="button"
                  loading={updateFields.isPending}
                  disabled={updateFields.isPending}
                  onClick={() => void submit()}
                >
                  Save changes
                </Button>
                <StatusLine>{saved}</StatusLine>
              </div>
            ) : (
              <StatusLine>{saved}</StatusLine>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// Known keys get a home; anything new from the API lands in "Other details" (lists are split out so they get wider cells).
const FIELD_GROUPS = [
  { title: "Personal details", keys: ["full_name", "date_of_birth", "gender"] },
  { title: "Emergency contact", keys: ["emergency_contact_name", "emergency_contact_phone"] },
  { title: "Vitals", keys: ["blood_group", "genotype", "blood_pressure", "weight", "height", "pregnancy_status"] },
  { title: "Location", keys: ["city", "state", "country"] },
  { title: "Lifestyle", keys: ["smoking_status", "alcohol_use", "activity_level"] },
];

function groupFields(fields: FieldDefinition[]) {
  const placed = new Set(FIELD_GROUPS.flatMap((group) => group.keys));
  const groups = FIELD_GROUPS.map((group) => ({
    title: group.title,
    wide: false,
    fields: group.keys.map((key) => fields.find((field) => field.key === key)).filter((field): field is FieldDefinition => Boolean(field)),
  }));
  const rest = fields.filter((field) => !placed.has(field.key));
  groups.push(
    { title: "Medical history", wide: true, fields: rest.filter((field) => field.value_type === "STRING_ARRAY") },
    { title: "Other details", wide: false, fields: rest.filter((field) => field.value_type !== "STRING_ARRAY") },
  );
  return groups.filter((group) => group.fields.length > 0);
}

function FieldRow({
  field,
  value,
  error,
  onChange,
}: {
  field: FieldDefinition;
  value: string | string[];
  error?: string;
  onChange: (value: string | string[]) => void;
}) {
  const id = fieldDomId(field.key);
  return (
    <div className={styles.fieldRow} data-field={field.key}>
      <div className={styles.fieldMeta}>
        {field.emergency_eligible ? (
          <Badge tone="info" size="sm">
            Emergency eligible
          </Badge>
        ) : null}
      </div>
      {field.value_type === "STRING_ARRAY" ? (
        <>
          <TagInput
            id={id}
            label={field.label}
            value={Array.isArray(value) ? value : []}
            onValueChange={onChange}
            placeholder="Add a value"
            description="Press Enter or comma to add each value."
          />
          {error ? (
            <p className={styles.fieldError} role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <Input
          id={id}
          label={field.label}
          value={Array.isArray(value) ? value.join(", ") : value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Add a value"
          error={error}
        />
      )}
      {field.value_type === "STRING_ARRAY" && Array.isArray(value) && value.length === 0 ? (
        <p className={styles.fieldHint}>An empty list clears this field when you save.</p>
      ) : null}
    </div>
  );
}
