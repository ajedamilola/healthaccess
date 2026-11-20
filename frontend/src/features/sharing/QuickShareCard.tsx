"use client";

import { useState } from "react";
import Link from "next/link";
import { Zap } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { toApiError } from "@/api/errors";
import { useQuickShare } from "@/api/hooks/sharing";
import { CodeDisplay } from "./CodeDisplay";
import { ErrorNotice } from "./states";
import styles from "./sharing.module.css";

const DURATIONS = [
  { value: "15", label: "15 min" },
  { value: "60", label: "1 hour" },
  { value: "1440", label: "24 hours" },
];

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The fastest way to share: one tap makes one short-lived code for the emergency information.
 * The person who receives it types that single code into "Open shared health information" or USSD.
 */
export function QuickShareCard() {
  const share = useQuickShare();
  const [minutes, setMinutes] = useState("60");
  const receipt = share.data;
  const error = share.error ? toApiError(share.error) : null;

  return (
    <section className={styles.panel} aria-labelledby="quick-share-title">
      <div className={styles.panelHead}>
        <div className={styles.panelIntro}>
          <h2
            id="quick-share-title"
            className={styles.panelTitle}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <Zap size={18} aria-hidden="true" /> Quick share
          </h2>
          <p className={styles.panelCopy}>
            One tap makes one code for your emergency information. Give it to a doctor or nurse; they enter just that code
            on HealthAccess or by USSD. It stops working when time runs out, or when you revoke it below.
          </p>
        </div>
      </div>

      {receipt ? (
        <div className={styles.receipt} role="group" aria-labelledby="quick-share-receipt">
          <h3 id="quick-share-receipt" className={styles.receiptTitle}>
            Your code is ready
          </h3>
          <CodeDisplay code={receipt.code} label="Access code" defaultRevealed />
          <p className={styles.panelCopy}>
            Works until {timeFormat.format(new Date(receipt.expires_at))}. They open it at{" "}
            <Link href="/lookup">Open shared health information</Link>, or dial USSD and choose 2.
          </p>
          <div className={styles.actions}>
            <Button type="button" variant="secondary" onClick={() => share.reset()}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.form}>
          <SegmentedControl label="How long" value={minutes} onValueChange={setMinutes} options={DURATIONS} />
          {error?.code === "nothing_to_share" ? (
            <Alert tone="info" title="Nothing to share yet">
              Add allergies, medications or other details to <Link href="/app/record">your record</Link> first.
            </Alert>
          ) : error ? (
            <ErrorNotice
              title="Could not create a code"
              error={share.error}
              onRetry={() => share.mutate(Number(minutes))}
              retrying={share.isPending}
            />
          ) : null}
          <div className={styles.actions}>
            <Button type="button" loading={share.isPending} onClick={() => share.mutate(Number(minutes))}>
              Create a code
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
