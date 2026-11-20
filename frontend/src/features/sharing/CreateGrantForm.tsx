"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useIsFetching } from "@tanstack/react-query";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Checkbox } from "@/components/arc/checkbox/checkbox";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { useCreateGrant } from "@/api/hooks/sharing";
import { toApiError } from "@/api/errors";
import { qk } from "@/api/keys";
import type { FieldsResponse, GrantCreateResponse } from "@/api/schemas";
import { CodeDisplay } from "./CodeDisplay";
import { formatFieldValue } from "./code";
import { channelLabel, formatLocalDateTime, humaniseKey } from "./labels";
import { ErrorNotice, isDenied } from "./states";
import { useLocalTimeZone } from "./time";
import styles from "./sharing.module.css";

const durations = [
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "60", label: "1 h" },
  { value: "240", label: "4 h" },
  { value: "1440", label: "24 h" },
];

type Channel = "WEB_PRACTITIONER" | "USSD";

export interface CreateGrantFormProps {
  fields?: FieldsResponse;
  fieldsLoading: boolean;
  fieldsError: unknown;
  onRetryFields: () => void;
}

export function CreateGrantForm({ fields, fieldsLoading, fieldsError, onRetryFields }: CreateGrantFormProps) {
  const create = useCreateGrant();
  const timeZone = useLocalTimeZone();
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [channels, setChannels] = useState<Channel[]>(["WEB_PRACTITIONER"]);
  const [duration, setDuration] = useState("30");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<GrantCreateResponse | null>(null);
  const fieldsGroup = useRef<HTMLFieldSetElement>(null);
  const channelsGroup = useRef<HTMLFieldSetElement>(null);
  const receiptBox = useRef<HTMLDivElement>(null);
  const grantsFetching = useIsFetching({ queryKey: qk.grants }) > 0;
  const createError = create.error ? toApiError(create.error) : null;
  const timedOut = createError?.code === "upstream_timeout";

  useEffect(() => {
    if (!receipt) return;
    receiptBox.current?.focus();
  }, [receipt]);

  useEffect(() => {
    function clearOnHide() {
      setReceipt(null);
    }
    function clearWhenHidden() {
      if (document.visibilityState === "hidden") setReceipt(null);
    }
    window.addEventListener("pagehide", clearOnHide);
    document.addEventListener("visibilitychange", clearWhenHidden);
    return () => {
      window.removeEventListener("pagehide", clearOnHide);
      document.removeEventListener("visibilitychange", clearWhenHidden);
    };
  }, []);

  function toggleField(key: string, next: boolean | "indeterminate") {
    if (next !== true) {
      setSelectedFields((current) => current.filter((item) => item !== key));
      return;
    }
    setSelectedFields((current) => (current.includes(key) ? current : [...current, key]));
  }

  function toggleChannel(channel: Channel, next: boolean | "indeterminate") {
    if (next !== true) {
      setChannels((current) => current.filter((item) => item !== channel));
      return;
    }
    setChannels((current) => (current.includes(channel) ? current : [...current, channel]));
  }

  async function submitGrant() {
    if (create.isPending) return;
    setFieldError(null);
    setChannelError(null);

    if (selectedFields.length === 0) {
      setFieldError("Choose at least one field to share.");
      fieldsGroup.current?.focus();
      return;
    }
    if (channels.length === 0) {
      setChannelError("Choose at least one channel.");
      channelsGroup.current?.focus();
      return;
    }

    create.reset();
    try {
      const result = await create.mutateAsync({
        field_keys: selectedFields,
        channels,
        expires_in_minutes: Number(duration),
      });
      setReceipt(result);
      // The code now lives only in this component's state; drop it from the mutation cache too.
      create.reset();
      setSelectedFields([]);
      setChannels(["WEB_PRACTITIONER"]);
      setDuration("30");
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.code === "validation_error" || apiError.code === "invalid_field" || apiError.code === "invalid_fields") {
        const issue = apiError.issues?.find((item) => item.path === "field_keys");
        const channelIssue = apiError.issues?.find((item) => item.path === "channels");
        if (issue) {
          setFieldError("Choose at least one field that can be shared.");
          fieldsGroup.current?.focus();
        } else if (channelIssue) {
          setChannelError("Choose at least one channel.");
          channelsGroup.current?.focus();
        }
      }
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitGrant();
  }

  function fieldLabel(key: string) {
    return fields?.fields.find((field) => field.key === key)?.label ?? humaniseKey(key);
  }

  return (
    <section id="create-grant" className={styles.panel} aria-labelledby="create-grant-title" tabIndex={-1}>
      <div className={styles.panelHead}>
        <div className={styles.panelIntro}>
          <h2 id="create-grant-title" className={styles.panelTitle}>
            Choose exactly what to share
          </h2>
          <p className={styles.panelCopy}>
            Choose exactly what another person can read, how they reach it, and how long it lasts.
          </p>
        </div>
      </div>

      {receipt ? (
        <div className={styles.receipt} ref={receiptBox} tabIndex={-1} role="group" aria-labelledby="grant-receipt-title">
          <div className={styles.receiptHead}>
            <h3 id="grant-receipt-title" className={styles.receiptTitle}>
              Access code ready
            </h3>
            <Badge tone="warning" size="sm">
              Shown once
            </Badge>
          </div>
          <span className={styles.srOnly} role="status">
            Access code created. It will not be shown again.
          </span>
          <CodeDisplay code={receipt.code} label="Access code" defaultRevealed />
          <p className={styles.receiptWarning}>This code will not be shown again.</p>
          <dl className={styles.receiptMeta}>
            <div>
              <dt>Expires</dt>
              <dd>{formatLocalDateTime(receipt.expires_at, timeZone)}</dd>
            </div>
            <div>
              <dt>Fields</dt>
              <dd>{receipt.field_keys.map(fieldLabel).join(", ")}</dd>
            </div>
            <div>
              <dt>Channels</dt>
              <dd>{receipt.channels.map(channelLabel).join(", ")}</dd>
            </div>
          </dl>
          <div className={styles.actions}>
            <Button type="button" variant="secondary" onClick={() => setReceipt(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      {fieldsLoading ? <Skeleton lines={3} label="Loading your fields" /> : null}

      {fieldsError && !isDenied(fieldsError) ? (
        <ErrorNotice
          title="Could not load the fields you can share"
          error={fieldsError}
          onRetry={onRetryFields}
        />
      ) : null}

      {fieldsError && isDenied(fieldsError) ? (
        <Alert tone="warning" title="Fields are not available">
          You do not have access to your shareable fields. Contact support if you think this is wrong.
        </Alert>
      ) : null}

      {fields && fields.fields.length === 0 ? (
        <EmptyState
          title="No fields can be shared yet"
          description="Add a value to at least one field on your record, then create an access code."
          action={
            <Link className={styles.textLink} href="/app/record">
              Add record details
            </Link>
          }
        />
      ) : null}

      {fields && fields.fields.length > 0 ? (
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <fieldset
            className={styles.fieldset}
            ref={fieldsGroup}
            tabIndex={-1}
            aria-describedby={fieldError ? "grant-fields-error" : "grant-fields-hint"}
          >
            <legend className={styles.legend}>Fields to share</legend>
            <p id="grant-fields-hint" className={styles.hint}>
              Only fields with a saved value appear here.
            </p>
            <div className={styles.choiceList}>
              {fields.fields.map((field) => (
                <Checkbox
                  key={field.key}
                  label={field.label}
                  description={formatFieldValue(field.value)}
                  checked={selectedFields.includes(field.key)}
                  onCheckedChange={(next) => toggleField(field.key, next)}
                />
              ))}
            </div>
            {fieldError ? (
              <p id="grant-fields-error" className={styles.fieldError} role="alert">
                {fieldError}
              </p>
            ) : null}
          </fieldset>

          <fieldset
            className={styles.fieldset}
            ref={channelsGroup}
            tabIndex={-1}
            aria-describedby={channelError ? "grant-channels-error" : undefined}
          >
            <legend className={styles.legend}>Channels</legend>
            <div className={styles.choiceList}>
              <Checkbox
                label="Verified practitioner portal"
                description="A signed-in practitioner enters both codes."
                checked={channels.includes("WEB_PRACTITIONER")}
                onCheckedChange={(next) => toggleChannel("WEB_PRACTITIONER", next)}
              />
              <Checkbox
                label="USSD"
                description="The practitioner enters both codes from any phone."
                checked={channels.includes("USSD")}
                onCheckedChange={(next) => toggleChannel("USSD", next)}
              />
            </div>
            {channelError ? (
              <p id="grant-channels-error" className={styles.fieldError} role="alert">
                {channelError}
              </p>
            ) : null}
          </fieldset>

          <div className={styles.fieldset}>
            <p className={styles.legend} id="grant-duration-label">
              Access length
            </p>
            <SegmentedControl
              label="Access length"
              options={durations}
              value={duration}
              onValueChange={setDuration}
              fullWidth
            />
          </div>

          <p className={styles.consent}>
            The recipient can read the current values of these fields until the code expires or you revoke it.
            Revoking cannot undo what they have already seen.
          </p>

          {createError && !timedOut ? (
            <ErrorNotice
              title="Could not create the access code"
              error={createError}
              onRetry={() => void submitGrant()}
            />
          ) : null}

          {timedOut ? (
            <div className={styles.errorBlock}>
              <Alert tone="warning" title="This took too long">
                The code may have been created. Check the access code list below before you try again.
              </Alert>
              <p className={styles.meta} role="status">
                {grantsFetching ? "Checking the access code list." : "The access code list is up to date."}
              </p>
            </div>
          ) : null}

          <Button
            type="submit"
            className={styles.primaryAction}
            loading={create.isPending}
            disabled={timedOut && grantsFetching}
          >
            Create access code
          </Button>
        </form>
      ) : null}
    </section>
  );
}
