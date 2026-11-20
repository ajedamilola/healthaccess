"use client";

import { useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Checkbox } from "@/components/arc/checkbox/checkbox";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { ReorderableList } from "@/components/arc/reorderable-list/reorderable-list";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { ShieldAlert } from "lucide-react";
import { toApiError } from "@/api/errors";
import { useEmergencySummary, useFields, useUpdateEmergencyFields } from "@/api/hooks/record";
import type { FieldDefinition } from "@/api/schemas";
import { isUpstreamTimeout, readableServerValue } from "./helpers";
import { ConfirmDialog } from "./ConfirmDialog";
import { OfflineBanner } from "./OfflineBanner";
import { FormError, LoadError, PageIntro, StatusLine } from "./States";
import styles from "./record.module.css";

type Conflict = { version: number; serverKeys: string[] };

function isEligible(field: FieldDefinition): boolean {
  return field.emergency_eligible && field.value !== null && field.value !== undefined;
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function labelList(keys: string[], fields: FieldDefinition[]): string {
  if (!keys.length) return "No fields shared";
  const labels = new Map(fields.map((field) => [field.key, field.label]));
  return keys.map((key) => labels.get(key) ?? key).join(", ");
}

export function EmergencySummaryScreen() {
  const fieldsQuery = useFields();
  const summaryQuery = useEmergencySummary();
  const updateEmergency = useUpdateEmergencyFields();
  const [selectedState, setSelectedState] = useState<string[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const fields = fieldsQuery.data?.fields ?? [];
  const eligible = fields.filter(isEligible);
  const eligibleKeys = new Set(eligible.map((field) => field.key));
  const serverKeys = (summaryQuery.data?.field_keys ?? []).filter((key) => eligibleKeys.has(key));
  const selected = selectedState ?? serverKeys;
  const dirty = !sameKeys(selected, serverKeys);
  const selectedFields = selected
    .map((key) => eligible.find((field) => field.key === key))
    .filter((field): field is FieldDefinition => Boolean(field));
  const selectedItems = selectedFields.map((field) => ({
    id: field.key,
    title: field.label,
    detail: readableServerValue(field.value),
  }));

  const loading = fieldsQuery.isPending || summaryQuery.isPending;
  const loadError =
    (fieldsQuery.isError && !fieldsQuery.data) || (summaryQuery.isError && !summaryQuery.data)
      ? (fieldsQuery.error ?? summaryQuery.error)
      : null;
  const confirmed = !dirty && summaryQuery.data?.available === true;
  const serverPreview = summaryQuery.data?.fields ?? [];
  const localPreview = selectedFields.map((field) => ({
    key: field.key,
    label: field.label,
    value: field.value,
  }));
  const preview = confirmed ? serverPreview : localPreview;

  function retry() {
    void fieldsQuery.refetch();
    void summaryQuery.refetch();
  }

  function changeSelection(next: string[]) {
    setSaved(null);
    setClientError(null);
    setFormError(null);
    setSelectedState(next);
  }

  function toggle(key: string, checked: boolean) {
    const current = selectedState ?? serverKeys;
    changeSelection(checked ? [...current.filter((item) => item !== key), key] : current.filter((item) => item !== key));
  }

  async function save(keys: string[], version: number) {
    setSaved(null);
    setClientError(null);
    setFormError(null);
    try {
      await updateEmergency.mutateAsync({ field_keys: keys, expected_version: version });
      setConflict(null);
      setSaved(
        keys.length
          ? `Emergency summary updated. A code lookup reveals ${keys.length} ${keys.length === 1 ? "field" : "fields"}.`
          : "Emergency sharing is off. A code lookup reveals nothing.",
      );
    } catch (error) {
      const apiError = toApiError(error);
      if (isUpstreamTimeout(error)) {
        // The write may have landed. Refresh the selection and the preview before offering a retry.
        await Promise.all([fieldsQuery.refetch(), summaryQuery.refetch()]);
        setFormError(error);
        return;
      }
      if (apiError.code === "version_conflict") {
        const [fieldsResult, summaryResult] = await Promise.all([fieldsQuery.refetch(), summaryQuery.refetch()]);
        if (fieldsResult.data && summaryResult.data) {
          setConflict({
            version: fieldsResult.data.version,
            serverKeys: (summaryResult.data.field_keys ?? []).filter((key) =>
              fieldsResult.data!.fields.some((field) => field.key === key && isEligible(field)),
            ),
          });
        } else {
          setFormError(error);
        }
        return;
      }
      if (apiError.code === "validation_error") {
        const issue = apiError.issues?.[0]?.message ?? "Check the selected fields.";
        setClientError(issue);
        return;
      }
      setFormError(error);
    }
  }

  function requestSave() {
    if (!fieldsQuery.data) return;
    if (!dirty) {
      setClientError("Make a change before saving.");
      return;
    }
    if (selected.length === 0 && serverKeys.length > 0) {
      setConfirmOpen(true);
      return;
    }
    void save(selected, fieldsQuery.data.version);
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <PageIntro
          title="Emergency summary"
          subtitle="Choose what a code lookup reveals in an emergency, and in which order."
        />
        <OfflineBanner />
        <section className={styles.section} aria-label="Loading your emergency summary">
          <Skeleton lines={6} label="Loading your emergency summary" />
        </section>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={styles.page}>
        <PageIntro
          title="Emergency summary"
          subtitle="Choose what a code lookup reveals in an emergency, and in which order."
        />
        <OfflineBanner />
        <LoadError title="Could not load your emergency summary" error={loadError} onRetry={retry} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageIntro
        title="Emergency summary"
        subtitle="Choose what a code lookup reveals in an emergency, and in which order. Only these fields are shown."
      />
      <OfflineBanner />

      {conflict ? (
        <Alert tone="warning" title="This record changed since you opened it">
          Your selection is still here. Compare the saved selection with yours, then choose what to keep.
        </Alert>
      ) : null}

      {formError ? <FormError error={formError} onRetry={requestSave} /> : null}

      <section className={styles.section} aria-labelledby="emergency-fields-title">
        <div className={styles.sectionCopy}>
          <h2 id="emergency-fields-title" className={styles.sectionTitle}>
            Fields in your emergency summary
          </h2>
          <p className={styles.sectionNote}>
            A code lookup shows the fields you choose, in the order shown. Drag a handle or use the up and down arrow
            keys on a handle to reorder.
          </p>
        </div>

        {eligible.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert size={24} strokeWidth={1.5} />}
            title="No fields can be shared yet"
            description="Add a value to an emergency-eligible field on My record, then come back to choose it."
            action={
              <Link className={styles.link} href="/app/record">
                Open My record
              </Link>
            }
          />
        ) : selectedItems.length === 0 ? (
          <EmptyState
            title="Nothing is shared in an emergency"
            description="Choose at least one field below. Until then, a code lookup reveals no information."
          />
        ) : (
          <ReorderableList
            items={selectedItems}
            onReorder={(items) => {
              changeSelection(items.map((item) => item.id));
              setClientError(null);
            }}
            label="Emergency field order"
          />
        )}

        {eligible.length > 0 ? (
          <div className={styles.subSection}>
            <h3 className={styles.subTitle}>Available fields</h3>
            <ul className={styles.checklist}>
              {eligible.map((field) => {
                const position = selected.indexOf(field.key);
                return (
                  <li key={field.key} className={styles.checkRow}>
                    <div className={styles.checkMain}>
                      <Checkbox
                        label={field.label}
                        description={readableServerValue(field.value)}
                        checked={position !== -1}
                        onCheckedChange={(checked) => toggle(field.key, checked === true)}
                      />
                    </div>
                    {position !== -1 ? (
                      <Badge tone="neutral" size="sm">
                        {`Position ${position + 1}`}
                      </Badge>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {fields.some((field) => !isEligible(field)) ? (
          <div className={styles.subSection}>
            <h3 className={styles.subTitle}>Not available</h3>
            <p className={styles.note}>
              These fields cannot be shared in an emergency. Fields without a value need one first.
            </p>
            <ul className={styles.checklist}>
              {fields
                .filter((field) => !isEligible(field))
                .map((field) => {
                  const missingValue = field.value === null || field.value === undefined;
                  return (
                    <li key={field.key} className={styles.checkRow}>
                      <div className={styles.checkMain}>
                        <Checkbox
                          label={field.label}
                          description={
                            missingValue && field.emergency_eligible
                              ? "Add a value first"
                              : "Not shareable in an emergency"
                          }
                          checked={false}
                          disabled
                          onCheckedChange={() => undefined}
                        />
                        {missingValue && field.emergency_eligible ? (
                          <Link className={styles.checkReasonLink} href="/app/record">
                            Add a value on My record
                          </Link>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
            </ul>
          </div>
        ) : null}

        {conflict ? (
          <div className={styles.conflict}>
            <div className={styles.conflictGrid}>
              <div className={styles.conflictColumn}>
                <p className={styles.conflictHeading}>Saved by the server</p>
                <p className={styles.conflictValue}>{labelList(conflict.serverKeys, fields)}</p>
              </div>
              <div className={styles.conflictColumn}>
                <p className={styles.conflictHeading}>Your selection</p>
                <p className={styles.conflictValue}>{labelList(selected, fields)}</p>
              </div>
            </div>
            <div className={styles.actions}>
              <Button
                type="button"
                loading={updateEmergency.isPending}
                disabled={updateEmergency.isPending}
                onClick={() => void save(selected, conflict.version)}
              >
                Use my changes
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setSelectedState(null);
                  setConflict(null);
                  setSaved("Your selection was discarded. The latest saved order is shown.");
                }}
              >
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
              loading={updateEmergency.isPending}
              disabled={updateEmergency.isPending}
              onClick={requestSave}
            >
              Save emergency summary
            </Button>
            <StatusLine>{saved}</StatusLine>
          </div>
        ) : (
          <StatusLine>{saved}</StatusLine>
        )}
      </section>

      <section className={styles.section} aria-labelledby="emergency-preview-title">
        <div className={styles.previewHead}>
          <div className={styles.sectionCopy}>
            <h2 id="emergency-preview-title" className={styles.sectionTitle}>
              What a code lookup reveals
            </h2>
            <p className={styles.sectionNote}>
              {confirmed
                ? "Confirmed by the server with your saved selection."
                : dirty
                  ? "Preview of your unsaved selection. Save to confirm it."
                  : "A code lookup reveals nothing until you save a selection."}
            </p>
          </div>
          <Badge tone={confirmed ? "success" : dirty ? "warning" : "neutral"} size="sm">
            {confirmed ? "Confirmed by the server" : dirty ? "Unsaved selection" : "Sharing is off"}
          </Badge>
        </div>

        {preview.length ? (
          <ol className={styles.previewList} aria-label="Emergency preview fields">
            {preview.map((field) => (
              <li key={field.key} className={styles.previewItem}>
                <span className={styles.previewLabel}>{field.label}</span>
                <span className={styles.previewValue}>{readableServerValue(field.value)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.note}>
            No information is shared in an emergency. A code lookup returns nothing for your account.
          </p>
        )}
      </section>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Turn off emergency sharing?"
        description="A code lookup will not reveal any information until you choose fields again. This takes effect when you confirm."
        confirmLabel="Turn off sharing"
        pending={updateEmergency.isPending}
        onConfirm={() => {
          setConfirmOpen(false);
          if (fieldsQuery.data) void save([], fieldsQuery.data.version);
        }}
      />
    </div>
  );
}
