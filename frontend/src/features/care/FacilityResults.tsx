"use client";

import { SearchX } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { useFacilities } from "@/api/hooks/directory";
import { toApiError } from "@/api/errors";
import { FacilityCard } from "./FacilityCard";
import styles from "./care.module.css";

const RADII = [5, 10, 25, 50];

export interface FacilityResultsProps {
  service: string;
  areaId: string;
  radius: number;
  limit: number;
  onShowMore: () => void;
  onWidenRadius: (radius: number) => void;
  onChangeArea: () => void;
}

function nextRadius(radius: number) {
  return RADII.find((candidate) => candidate > radius) ?? radius;
}

export function FacilityResults({
  service,
  areaId,
  radius,
  limit,
  onShowMore,
  onWidenRadius,
  onChangeArea,
}: FacilityResultsProps) {
  const facilitiesQuery = useFacilities({ service, areaId, radius, limit });

  if (facilitiesQuery.isPending) {
    return (
      <div className={styles.skeletonList}>
        {[0, 1, 2].map((index) => (
          <div className={styles.skeletonCard} key={index}>
            <Skeleton label={`Loading facility result ${index + 1}`} lines={3} />
          </div>
        ))}
      </div>
    );
  }

  if (facilitiesQuery.isError) {
    const error = toApiError(facilitiesQuery.error);

    if (error.denied) {
      return (
        <Alert tone="warning" title="Directory access denied">
          You do not have access to this directory. Contact support if this keeps happening.
        </Alert>
      );
    }

    return (
      <div className={styles.state}>
        <Alert tone="danger" title="Could not load facilities">
          {error.message}
        </Alert>
        <div className={styles.errorActions}>
          <Button variant="secondary" onClick={() => void facilitiesQuery.refetch()}>
            Try again
          </Button>
          {error.requestId ? <p className={styles.requestId}>Request ID: {error.requestId}</p> : null}
        </div>
      </div>
    );
  }

  const facilities = facilitiesQuery.data;
  const widerRadius = nextRadius(radius);

  if (facilities.length === 0) {
    return (
      <EmptyState
        icon={<SearchX size={24} aria-hidden="true" />}
        title="No facilities found"
        description={`No listed facility offers this service within ${radius} km. Try a wider radius or another area.`}
        label="Facility search results"
        action={
          widerRadius > radius ? (
            <Button variant="secondary" onClick={() => onWidenRadius(widerRadius)}>
              Search within {widerRadius} km
            </Button>
          ) : (
            <Button variant="secondary" onClick={onChangeArea}>
              Change area
            </Button>
          )
        }
      />
    );
  }

  return (
    <div className={styles.resultsBody}>
      <p className={styles.resultCount} role="status">
        {facilitiesQuery.isFetching
          ? "Updating results…"
          : `${facilities.length} ${facilities.length === 1 ? "facility" : "facilities"} found within ${radius} km.`}
      </p>
      <ul className={styles.resultList}>
        {facilities.map((facility) => (
          <li key={facility.id}>
            <FacilityCard facility={facility} />
          </li>
        ))}
      </ul>
      {facilities.length >= limit && limit < 10 ? (
        <div className={styles.moreRow}>
          <Button variant="secondary" onClick={onShowMore}>
            Show more
          </Button>
          <p className={styles.moreHint}>Showing {facilities.length} of up to 10.</p>
        </div>
      ) : null}
    </div>
  );
}
