"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { useFacility } from "@/api/hooks/directory";
import { toApiError } from "@/api/errors";
import type { FacilityDetail } from "@/api/schemas";
import { ConnectionNotice } from "./ConnectionNotice";
import { areaLabel, lastVerifiedLabel, sourceTrustLabel, sourceTrustTone } from "./format";
import styles from "./care.module.css";

function BackLink() {
  return (
    <Link className={styles.backLink} href="/find-care">
      <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      Back to find care
    </Link>
  );
}

export function FacilityDetailSkeleton() {
  return (
    <div className={styles.detailSkeleton}>
      <Skeleton label="Loading facility details" lines={4} />
      <div className={styles.detailGrid}>
        <Skeleton label="Loading contact details" lines={2} />
        <Skeleton label="Loading services" lines={3} />
        <Skeleton label="Loading directory details" lines={2} />
      </div>
    </div>
  );
}

function FacilityContent({ facility }: { facility: FacilityDetail }) {
  return (
    <>
      <header className={styles.detailHeader}>
        <div className={styles.badgeRow}>
          {facility.is_demo ? (
            <Badge tone="info" outline>
              Demo data
            </Badge>
          ) : null}
          <Badge tone={sourceTrustTone(facility.source_trust)} outline>
            {sourceTrustLabel(facility.source_trust)}
          </Badge>
        </div>
        <h1 className={styles.title}>{facility.name}</h1>
        <address className={styles.address}>{facility.address}</address>
        <p className={styles.area}>{areaLabel(facility.area)}</p>
      </header>

      <div className={styles.detailGrid}>
        <section className={styles.panel} aria-labelledby="facility-contact-title">
          <h2 id="facility-contact-title" className={styles.sectionTitle}>
            Contact
          </h2>
          {facility.phone ? (
            <a className={styles.phone} href={`tel:${facility.phone}`} aria-label={`Call ${facility.phone}`}>
              {facility.phone}
            </a>
          ) : (
            <p className={styles.muted}>No phone number is listed.</p>
          )}
        </section>

        <section className={styles.panel} aria-labelledby="facility-services-title">
          <h2 id="facility-services-title" className={styles.sectionTitle}>
            Services
          </h2>
          {facility.services.length ? (
            <ul className={styles.serviceList}>
              {facility.services.map((service) => (
                <li key={service.service_code}>
                  <span>{service.label}</span>
                  {service.availability_note ? (
                    <span className={styles.serviceNote}>{service.availability_note}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>No services are listed.</p>
          )}
        </section>

        <section className={styles.panel} aria-labelledby="facility-directory-title">
          <h2 id="facility-directory-title" className={styles.sectionTitle}>
            Directory details
          </h2>
          <p className={styles.verified}>{lastVerifiedLabel(facility.last_verified_at)}</p>
          <p className={styles.note}>A recommendation does not book a visit or confirm availability.</p>
        </section>
      </div>
    </>
  );
}

function FacilityDetailError({
  error,
  onRetry,
}: {
  error: ReturnType<typeof toApiError>;
  onRetry: () => void;
}) {
  if (error.code === "not_found" || error.status === 404) {
    return (
      <div className={styles.state}>
        <Alert tone="info" title="Facility not available">
          This item is not available.
        </Alert>
      </div>
    );
  }

  if (error.denied) {
    return (
      <Alert tone="warning" title="Directory access denied">
        You do not have access to this facility. Contact support if this keeps happening.
      </Alert>
    );
  }

  return (
    <div className={styles.state}>
      <Alert tone="danger" title="Could not load this facility">
        {error.message}
      </Alert>
      <div className={styles.errorActions}>
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
        {error.requestId ? <p className={styles.requestId}>Request ID: {error.requestId}</p> : null}
      </div>
    </div>
  );
}

export function FacilityDetailView({ id }: { id: string }) {
  const facilityQuery = useFacility(id);

  return (
    <div className={styles.page}>
      <BackLink />
      <ConnectionNotice />

      {facilityQuery.isPending ? (
        <>
          <h1 className={styles.title}>Facility details</h1>
          <FacilityDetailSkeleton />
        </>
      ) : null}

      {facilityQuery.isError ? (
        <>
          <h1 className={styles.title}>Facility details</h1>
          <FacilityDetailError
            error={toApiError(facilityQuery.error)}
            onRetry={() => void facilityQuery.refetch()}
          />
        </>
      ) : null}

      {facilityQuery.isSuccess ? <FacilityContent facility={facilityQuery.data} /> : null}
    </div>
  );
}
