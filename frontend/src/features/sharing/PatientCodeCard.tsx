"use client";

import { useState } from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogClose, DialogContent } from "@/components/arc/dialog/dialog";
import { HoldToConfirm } from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { RefreshCw } from "lucide-react";
import { usePatientCode, useRotatePatientCode } from "@/api/hooks/sharing";
import { CodeDisplay } from "./CodeDisplay";
import { formatLocalDateTime } from "./labels";
import { DeniedNotice, ErrorNotice, isDenied } from "./states";
import { useLocalTimeZone } from "./time";
import styles from "./sharing.module.css";

export function PatientCodeCard() {
  const patientCode = usePatientCode();
  const rotate = useRotatePatientCode();
  const timeZone = useLocalTimeZone();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateError, setRotateError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);

  function openRotate() {
    rotate.reset();
    setRotateError(null);
    setRotateOpen(true);
  }

  async function confirmRotate() {
    if (rotate.isPending) return;
    setRotateError(null);
    try {
      await rotate.mutateAsync();
      setRotateOpen(false);
      setStatus("Patient code rotated. Every access code and read session was revoked.");
    } catch (error) {
      setRotateError(error);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="patient-code-title">
      <div className={styles.panelHead}>
        <div className={styles.panelIntro}>
          <h2 id="patient-code-title" className={styles.panelTitle}>
            Permanent emergency code
          </h2>
          <p className={styles.panelCopy}>
            This one code opens your emergency summary (the details you picked on Emergency summary) for anyone you give
            it to, on HealthAccess, SMS (LOOKUP) or USSD. Rotate it if you think someone has it who should not.
          </p>
        </div>
        {patientCode.data?.code_version ? (
          <Badge tone="neutral" size="sm">
            Version {patientCode.data.code_version}
          </Badge>
        ) : null}
      </div>

      {status ? (
        <p className={styles.status} role="status">
          {status}
        </p>
      ) : null}

      {patientCode.isLoading ? <Skeleton lines={2} label="Loading patient code" /> : null}

      {patientCode.error && !isDenied(patientCode.error) ? (
        <ErrorNotice
          title="Could not load your patient code"
          error={patientCode.error}
          onRetry={() => void patientCode.refetch()}
          retrying={patientCode.isFetching}
        />
      ) : null}

      {patientCode.error && isDenied(patientCode.error) ? (
        <DeniedNotice title="Patient code unavailable" error={patientCode.error} />
      ) : null}

      {patientCode.data && !patientCode.data.available ? (
        <div className={styles.errorBlock}>
          <Alert tone="info" title="No patient code yet">
            Your patient code is created the first time you open this page. Try again.
          </Alert>
          <Button variant="secondary" size="sm" onClick={() => void patientCode.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}

      {patientCode.data?.available && patientCode.data.code ? (
        <div className={styles.codeBlock}>
          <CodeDisplay key={patientCode.data.code} code={patientCode.data.code} label="Patient code" allowReveal />
          {patientCode.data.rotated_at ? (
            <p className={styles.meta}>Last rotated {formatLocalDateTime(patientCode.data.rotated_at, timeZone)}</p>
          ) : null}
          <div className={styles.actions}>
            <Button variant="secondary" onClick={openRotate}>
              <RefreshCw aria-hidden="true" size={16} strokeWidth={1.75} />
              Rotate code
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent
          title="Rotate patient code?"
          description="Your current patient code stops working immediately."
        >
          <div className={styles.dialogBody}>
            <p>
              Rotating creates a new 12-digit patient code. Every access code you created is revoked, and any
              practitioner viewing your record is signed out straight away.
            </p>
            <p>You will need to share the new code again. This cannot be undone.</p>
            {rotateError ? (
              <ErrorNotice title="Could not rotate the code" error={rotateError} />
            ) : null}
            <div className={styles.dialogActions}>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <HoldToConfirm
                label="Hold to rotate patient code"
                confirmedLabel="Rotating"
                icon={<RefreshCw aria-hidden="true" size={16} strokeWidth={1.75} />}
                tone="danger"
                duration={1500}
                confirmed={rotate.isSuccess}
                disabled={rotate.isPending}
                onConfirm={() => void confirmRotate()}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
