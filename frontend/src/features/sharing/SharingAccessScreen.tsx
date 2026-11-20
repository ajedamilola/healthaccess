"use client";

import Link from "next/link";
import { useShareableFields } from "@/api/hooks/sharing";
import { PatientCodeCard } from "./PatientCodeCard";
import { QuickShareCard } from "./QuickShareCard";
import { CreateGrantForm } from "./CreateGrantForm";
import { GrantList } from "./GrantList";
import styles from "./sharing.module.css";

export function SharingAccessScreen() {
  const fields = useShareableFields();

  function focusCreateGrant() {
    const node = document.getElementById("create-grant");
    node?.scrollIntoView({ block: "start" });
    node?.focus({ preventScroll: true });
  }

  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Sharing and access</h1>
        <p className={styles.subtitle}>
          Share in one tap with a quick code, or give your permanent emergency code. Whoever receives a code only needs
          that one code. <Link href="/app/access-log">See who opened your record</Link>.
        </p>
      </header>

      <QuickShareCard />

      <PatientCodeCard />

      <CreateGrantForm
        fields={fields.data}
        fieldsLoading={fields.isLoading}
        fieldsError={fields.error}
        onRetryFields={() => void fields.refetch()}
      />

      <GrantList fields={fields.data} onCreateAction={focusCreateGrant} />
    </div>
  );
}
