"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, HeartPulse } from "lucide-react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Input } from "@/components/arc/input/input";
import { Select } from "@/components/arc/select/select";
import { Textarea } from "@/components/arc/textarea/textarea";
import {
  useDeleteAllergy,
  useDeleteMedicalEvent,
  usePatchMedicalEvent,
  usePutMedical,
} from "@/api/hooks/record";
import { qk } from "@/api/keys";
import type { Allergy, MedicalEvent, MeResponse, PutMedicalBody } from "@/api/schemas";
import { formatIsoDate, isUpstreamTimeout, issueMessages, readableServerValue } from "./helpers";
import { ConfirmDialog } from "./ConfirmDialog";
import { FormError, StatusLine } from "./States";
import styles from "./record.module.css";

const severityOptions = [
  { value: "MILD", label: "Mild" },
  { value: "MODERATE", label: "Moderate" },
  { value: "SEVERE", label: "Severe" },
];

type AllergyForm = { name: string; severity: string; diagnosisDate: string };
type EventForm = { name: string; occurredOn: string; recoveryTime: string; description: string };

const emptyAllergy: AllergyForm = { name: "", severity: "MILD", diagnosisDate: "" };
const emptyEvent: EventForm = { name: "", occurredOn: "", recoveryTime: "", description: "" };

type DialogState =
  | { kind: "allergy"; id: string; name: string }
  | { kind: "event"; id: string; name: string }
  | { kind: "all-allergies" }
  | { kind: "all-events" }
  | null;

function allergyInput(allergy: Allergy) {
  return {
    name: allergy.name,
    ...(allergy.severity ? { severity: allergy.severity } : {}),
    ...(allergy.diagnosis_date ? { diagnosisDate: allergy.diagnosis_date.slice(0, 10) } : {}),
  };
}

function eventInput(event: MedicalEvent) {
  return {
    name: event.name,
    ...(event.recovery_time ? { recoveryTime: event.recovery_time } : {}),
    ...(event.occurred_on ? { occurredOn: event.occurred_on.slice(0, 10) } : {}),
    ...(event.description ? { description: event.description } : {}),
  };
}

function severityLabel(severity: string): string {
  return severity.charAt(0) + severity.slice(1).toLowerCase();
}

function severityTone(severity: string | null | undefined) {
  if (severity === "SEVERE") return "danger" as const;
  if (severity === "MODERATE") return "warning" as const;
  return "info" as const;
}

export function MedicalSection({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const putMedical = usePutMedical();
  const deleteAllergy = useDeleteAllergy();
  const patchEvent = usePatchMedicalEvent();
  const deleteEvent = useDeleteMedicalEvent();
  const [allergyOpen, setAllergyOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [allergyForm, setAllergyForm] = useState<AllergyForm>(emptyAllergy);
  const [eventForm, setEventForm] = useState<EventForm>(emptyEvent);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EventForm>(emptyEvent);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  // A failed confirm closes the dialog so the error is visible, and keeps the action for "Try again".
  const [failedAction, setFailedAction] = useState<DialogState>(null);

  const pending = putMedical.isPending || deleteAllergy.isPending || patchEvent.isPending || deleteEvent.isPending;
  const healthFields = me.fields.filter((field) => {
    const value = field.value;
    return value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0);
  });
  const allergies = me.allergies;
  const events = me.medical_events;

  function clearFeedback() {
    setStatus(null);
    setFormError(null);
    setErrors({});
  }

  /** A timed-out write may have landed, so read the current medical details before showing a retry. */
  async function refreshAfterTimeout(error: unknown) {
    if (!isUpstreamTimeout(error)) return;
    await queryClient.refetchQueries({ queryKey: qk.me });
  }

  function openDialog(next: Exclude<DialogState, null>) {
    clearFeedback();
    setFailedAction(null);
    setDialog(next);
  }

  function changeAllergy(key: keyof AllergyForm, value: string) {
    clearFeedback();
    setAllergyForm((current) => ({ ...current, [key]: value }));
  }

  function changeEvent(key: keyof EventForm, value: string) {
    clearFeedback();
    setEventForm((current) => ({ ...current, [key]: value }));
  }

  function changeEdit(key: keyof EventForm, value: string) {
    clearFeedback();
    setEditForm((current) => ({ ...current, [key]: value }));
  }

  async function saveMedical(body: PutMedicalBody, message: string) {
    setFormError(null);
    setStatus(null);
    try {
      await putMedical.mutateAsync(body);
      setStatus(message);
      return true;
    } catch (error) {
      await refreshAfterTimeout(error);
      setFormError(error);
      const messages = issueMessages(error, ["name", "severity", "diagnosisDate", "recoveryTime", "occurredOn", "description"]);
      if (Object.keys(messages).length) setErrors(messages);
      return false;
    }
  }

  async function addAllergy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();
    if (!allergyForm.name.trim()) {
      setErrors({ name: "Enter the allergy name." });
      return;
    }
    const body = {
      allergies: [
        ...allergies.map(allergyInput),
        {
          name: allergyForm.name.trim(),
          severity: allergyForm.severity,
          ...(allergyForm.diagnosisDate ? { diagnosisDate: allergyForm.diagnosisDate } : {}),
        },
      ],
    };
    const ok = await saveMedical(body, "Allergy history saved.");
    if (ok) {
      setAllergyOpen(false);
      setAllergyForm(emptyAllergy);
    }
  }

  async function addEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();
    if (!eventForm.name.trim()) {
      setErrors({ name: "Enter the event name." });
      return;
    }
    const body = {
      medicalEvents: [
        ...events.map(eventInput),
        {
          name: eventForm.name.trim(),
          ...(eventForm.recoveryTime.trim() ? { recoveryTime: eventForm.recoveryTime.trim() } : {}),
          ...(eventForm.occurredOn ? { occurredOn: eventForm.occurredOn } : {}),
          ...(eventForm.description.trim() ? { description: eventForm.description.trim() } : {}),
        },
      ],
    };
    const ok = await saveMedical(body, "Medical event added.");
    if (ok) {
      setEventOpen(false);
      setEventForm(emptyEvent);
    }
  }

  function startEdit(item: MedicalEvent) {
    clearFeedback();
    setEditingId(item.id);
    setEditForm({
      name: item.name,
      occurredOn: item.occurred_on?.slice(0, 10) ?? "",
      recoveryTime: item.recovery_time ?? "",
      description: item.description ?? "",
    });
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>, item: MedicalEvent) {
    event.preventDefault();
    clearFeedback();
    const name = editForm.name.trim();
    if (!name) {
      setErrors({ name: "Enter the event name." });
      return;
    }
    if (item.occurred_on && !editForm.occurredOn) {
      setErrors({ occurredOn: "Enter a date. It cannot be cleared here." });
      return;
    }

    const body: Record<string, string | null> = {};
    if (name !== item.name) body.name = name;
    if ((item.occurred_on?.slice(0, 10) ?? "") !== editForm.occurredOn) body.occurredOn = editForm.occurredOn;
    if ((item.recovery_time ?? "") !== editForm.recoveryTime) body.recoveryTime = editForm.recoveryTime.trim() || null;
    if ((item.description ?? "") !== editForm.description) body.description = editForm.description.trim() || null;

    if (!Object.keys(body).length) {
      setErrors({ name: "Make a change before saving." });
      return;
    }

    try {
      await patchEvent.mutateAsync({ id: item.id, body });
      setEditingId(null);
      setStatus("Medical event updated.");
    } catch (error) {
      await refreshAfterTimeout(error);
      setFormError(error);
      const messages = issueMessages(error, ["name", "occurredOn", "recoveryTime", "description"]);
      if (Object.keys(messages).length) setErrors(messages);
    }
  }

  async function confirmDialog(action: DialogState = dialog) {
    if (!action) return;
    clearFeedback();
    setFailedAction(null);
    try {
      if (action.kind === "allergy") {
        await deleteAllergy.mutateAsync(action.id);
        setStatus("Allergy removed from your private history.");
      } else if (action.kind === "event") {
        await deleteEvent.mutateAsync(action.id);
        setStatus("Medical event removed.");
      } else if (action.kind === "all-allergies") {
        await putMedical.mutateAsync({ allergies: [] });
        setStatus("Allergy history cleared.");
      } else {
        await putMedical.mutateAsync({ medicalEvents: [] });
        setStatus("Medical events cleared.");
      }
      setDialog(null);
    } catch (error) {
      await refreshAfterTimeout(error);
      setDialog(null);
      setFailedAction(action);
      setFormError(error);
    }
  }

  const dialogCopy = (() => {
    if (!dialog) return { title: "", description: "", label: "" };
    if (dialog.kind === "allergy") {
      return {
        title: "Remove this allergy?",
        description: `${dialog.name} will be removed from your private allergy history. This cannot be undone.`,
        label: "Remove allergy",
      };
    }
    if (dialog.kind === "event") {
      return {
        title: "Remove this medical event?",
        description: `${dialog.name} will be removed from your history. This cannot be undone.`,
        label: "Remove event",
      };
    }
    if (dialog.kind === "all-allergies") {
      return {
        title: "Remove all allergy history?",
        description: "This sends an empty list and removes every allergy record. This cannot be undone.",
        label: "Remove all allergies",
      };
    }
    return {
      title: "Remove all medical events?",
      description: "This sends an empty list and removes every medical event. This cannot be undone.",
      label: "Remove all events",
    };
  })();

  return (
    <section className={styles.section} aria-labelledby="medical-title">
      <div className={styles.sectionHead}>
        <div className={styles.sectionCopy}>
          <h2 id="medical-title" className={styles.sectionTitle}>
            Medical details
          </h2>
          <p className={styles.sectionNote}>
            Allergy history and medical events are saved here. Health fields such as blood group and weight are edited
            on My record so one version check covers the whole record.
          </p>
        </div>
        <Link className={styles.link} href="/app/record">
          Edit health fields on My record
        </Link>
      </div>

      {formError ? <FormError error={formError} onRetry={failedAction ? () => void confirmDialog(failedAction) : undefined} /> : null}

      {healthFields.length ? (
        <div className={styles.subSection}>
          <h3 className={styles.subTitle}>From your record</h3>
          <dl className={styles.readonlyGrid}>
            {healthFields.map((field) => (
              <div key={field.key} className={styles.readonlyItem}>
                <dt className={styles.readonlyLabel}>{field.label}</dt>
                <dd className={styles.readonlyValue}>{readableServerValue(field.value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <div className={styles.subSection}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionCopy}>
            <h3 className={styles.subTitle}>Allergy history (private)</h3>
            <p className={styles.note}>
              These records stay private. To share allergies in an emergency, add them to the allergies field on{" "}
              <Link className={styles.link} href="/app/record">
                My record
              </Link>
              .
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setAllergyOpen((open) => !open)}>
            {allergyOpen ? "Close allergy form" : "Add an allergy"}
          </Button>
        </div>

        {allergies.length === 0 ? (
          <div className={styles.emptyBlock}>
            <EmptyState
              icon={<HeartPulse size={24} strokeWidth={1.5} />}
              title="No allergy history yet"
              description="Add an allergy record with its severity so it is ready if a clinician asks."
              action={
                <Button variant="secondary" size="sm" onClick={() => setAllergyOpen(true)}>
                  Add an allergy
                </Button>
              }
            />
          </div>
        ) : (
          <ul className={styles.list} aria-label="Allergy history">
            {allergies.map((allergy) => (
              <li key={allergy.id} className={styles.listItem}>
                <div className={styles.itemHead}>
                  <h4 className={styles.itemTitle}>{allergy.name}</h4>
                  {allergy.severity ? (
                    <Badge tone={severityTone(allergy.severity)} size="sm">
                      {severityLabel(allergy.severity)}
                    </Badge>
                  ) : null}
                </div>
                {allergy.diagnosis_date ? (
                  <p className={styles.itemMeta}>Noted {formatIsoDate(allergy.diagnosis_date)}</p>
                ) : null}
                <div className={styles.itemActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openDialog({ kind: "allergy", id: allergy.id, name: allergy.name })}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {allergies.length > 0 ? (
          <div className={styles.actions}>
            <Button variant="ghost" size="sm" onClick={() => openDialog({ kind: "all-allergies" })}>
              Remove all allergy history
            </Button>
          </div>
        ) : null}

        {allergyOpen ? (
          <form className={styles.inlineForm} onSubmit={addAllergy} noValidate>
            <h4 className={styles.subTitle}>New allergy record</h4>
            <div className={styles.row}>
              <Input
                label="Allergy name"
                value={allergyForm.name}
                onChange={(event) => changeAllergy("name", event.target.value)}
                error={errors.name || undefined}
                maxLength={200}
                required
              />
              <Select
                label="Severity"
                options={severityOptions}
                value={allergyForm.severity}
                onValueChange={(value) => changeAllergy("severity", value)}
              />
            </div>
            <Input
              label="Date noted (optional)"
              type="date"
              value={allergyForm.diagnosisDate}
              onChange={(event) => changeAllergy("diagnosisDate", event.target.value)}
            />
            <div className={styles.actions}>
              <Button type="submit" variant="secondary" loading={putMedical.isPending} disabled={pending}>
                Add allergy record
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAllergyOpen(false)} disabled={pending}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </div>

      <div className={styles.subSection}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionCopy}>
            <h3 className={styles.subTitle}>Medical events</h3>
            <p className={styles.note}>Surgeries, illnesses and other events you want to remember.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setEventOpen((open) => !open)}>
            {eventOpen ? "Close event form" : "Add a medical event"}
          </Button>
        </div>

        {events.length === 0 ? (
          <div className={styles.emptyBlock}>
            <EmptyState
              icon={<Activity size={24} strokeWidth={1.5} />}
              title="No medical events yet"
              description="Add an event such as a surgery or hospital stay. You can edit or remove it later."
              action={
                <Button variant="secondary" size="sm" onClick={() => setEventOpen(true)}>
                  Add a medical event
                </Button>
              }
            />
          </div>
        ) : (
          <ul className={styles.list} aria-label="Medical events">
            {events.map((item) => (
              <li key={item.id} className={styles.listItem}>
                {editingId === item.id ? (
                  <form className={styles.inlineForm} onSubmit={(event) => void saveEdit(event, item)} noValidate>
                    <h4 className={styles.subTitle}>Edit medical event</h4>
                    <Input
                      label="Event name"
                      value={editForm.name}
                      onChange={(event) => changeEdit("name", event.target.value)}
                      error={errors.name || undefined}
                      required
                    />
                    <div className={styles.row}>
                      <Input
                        label="Date (optional)"
                        type="date"
                        value={editForm.occurredOn}
                        onChange={(event) => changeEdit("occurredOn", event.target.value)}
                        error={errors.occurredOn || undefined}
                      />
                      <Input
                        label="Recovery time (optional)"
                        value={editForm.recoveryTime}
                        onChange={(event) => changeEdit("recoveryTime", event.target.value)}
                        maxLength={200}
                      />
                    </div>
                    <Textarea
                      label="Description (optional)"
                      rows={3}
                      maxLength={4000}
                      value={editForm.description}
                      onChange={(event) => changeEdit("description", event.target.value)}
                    />
                    <div className={styles.actions}>
                      <Button type="submit" variant="secondary" loading={patchEvent.isPending} disabled={pending}>
                        Save event
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setEditingId(null)} disabled={pending}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className={styles.itemHead}>
                      <h4 className={styles.itemTitle}>{item.name}</h4>
                      {item.occurred_on ? (
                        <Badge tone="neutral" size="sm">
                          {formatIsoDate(item.occurred_on) ?? "Date recorded"}
                        </Badge>
                      ) : null}
                    </div>
                    {item.recovery_time ? (
                      <p className={styles.itemMeta}>Recovery: {item.recovery_time}</p>
                    ) : null}
                    {item.description ? <p className={styles.itemCopy}>{item.description}</p> : null}
                    <div className={styles.itemActions}>
                      <Button variant="ghost" size="sm" onClick={() => startEdit(item)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDialog({ kind: "event", id: item.id, name: item.name })}
                      >
                        Remove
                      </Button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {events.length > 0 ? (
          <div className={styles.actions}>
            <Button variant="ghost" size="sm" onClick={() => openDialog({ kind: "all-events" })}>
              Remove all medical events
            </Button>
          </div>
        ) : null}

        {eventOpen ? (
          <form className={styles.inlineForm} onSubmit={addEvent} noValidate>
            <h4 className={styles.subTitle}>New medical event</h4>
            <Input
              label="Event name"
              value={eventForm.name}
              onChange={(event) => changeEvent("name", event.target.value)}
              error={errors.name || undefined}
              maxLength={100}
              required
            />
            <div className={styles.row}>
              <Input
                label="Date (optional)"
                type="date"
                value={eventForm.occurredOn}
                onChange={(event) => changeEvent("occurredOn", event.target.value)}
              />
              <Input
                label="Recovery time (optional)"
                value={eventForm.recoveryTime}
                onChange={(event) => changeEvent("recoveryTime", event.target.value)}
                maxLength={200}
                placeholder="For example 2 weeks"
              />
            </div>
            <Textarea
              label="Description (optional)"
              rows={3}
              maxLength={4000}
              value={eventForm.description}
              onChange={(event) => changeEvent("description", event.target.value)}
            />
            <div className={styles.actions}>
              <Button type="submit" variant="secondary" loading={putMedical.isPending} disabled={pending}>
                Add medical event
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEventOpen(false)} disabled={pending}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </div>

      <StatusLine>{status}</StatusLine>

      <ConfirmDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDialog(null);
        }}
        title={dialogCopy.title}
        description={dialogCopy.description}
        confirmLabel={dialogCopy.label}
        onConfirm={() => void confirmDialog()}
        pending={pending}
      />
    </section>
  );
}
