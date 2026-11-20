"use client";

import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { useMe } from "@/api/hooks/record";
import { AccountSection } from "./AccountSection";
import { AvatarSection } from "./AvatarSection";
import { MedicalSection } from "./MedicalSection";
import { OfflineBanner } from "./OfflineBanner";
import { PersonalSection } from "./PersonalSection";
import { LoadError, PageIntro } from "./States";
import styles from "./record.module.css";

export function ProfileScreen() {
  const me = useMe();

  if (me.isPending) {
    return (
      <div className={styles.page}>
        <PageIntro
          title="Profile"
          subtitle="Your account details, private allergy history and medical events."
        />
        <OfflineBanner />
        <section className={styles.section} aria-label="Loading your profile">
          <Skeleton lines={5} label="Loading your profile" />
        </section>
        <section className={styles.section} aria-label="Loading medical details">
          <Skeleton lines={4} label="Loading medical details" />
        </section>
      </div>
    );
  }

  if (me.isError && !me.data) {
    return (
      <div className={styles.page}>
        <PageIntro
          title="Profile"
          subtitle="Your account details, private allergy history and medical events."
        />
        <OfflineBanner />
        <LoadError title="Could not load your profile" error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageIntro
        title="Profile"
        subtitle="Your account details, private allergy history and medical events. Sharing choices are on Emergency summary and Sharing and access."
      />
      <OfflineBanner />
      <AccountSection me={me.data} />
      <PersonalSection me={me.data} />
      <MedicalSection me={me.data} />
      <AvatarSection me={me.data} />
    </div>
  );
}
