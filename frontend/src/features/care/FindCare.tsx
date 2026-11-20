"use client";

import { useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { Combobox } from "@/components/arc/combobox/combobox";
import { Select } from "@/components/arc/select/select";
import { useAreas, useServices } from "@/api/hooks/directory";
import { toApiError } from "@/api/errors";
import type { Area } from "@/api/schemas";
import { ConnectionNotice } from "./ConnectionNotice";
import { FacilityResults } from "./FacilityResults";
import { useDebouncedValue } from "./useDebouncedValue";
import { areaLabel } from "./format";
import styles from "./care.module.css";

const RADIUS_OPTIONS = [5, 10, 25, 50].map((radius) => ({ value: String(radius), label: `${radius} km` }));

interface FieldErrors {
  service?: string;
  area?: string;
}

interface CommittedSearch {
  service: string;
  serviceLabel: string;
  areaId: string;
  areaLabel: string;
  radius: number;
}

function RequestId({ error }: { error: unknown }) {
  const requestId = toApiError(error).requestId;
  return requestId ? <p className={styles.requestId}>Request ID: {requestId}</p> : null;
}

export function FindCare() {
  const servicesQuery = useServices();

  const [service, setService] = useState("");
  const [areaId, setAreaId] = useState("");
  const [selectedArea, setSelectedArea] = useState<Area | null>(null);
  const [radius, setRadius] = useState(25);
  const [areaQuery, setAreaQuery] = useState("");
  const [areaSearchActive, setAreaSearchActive] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [committed, setCommitted] = useState<CommittedSearch | null>(null);
  const [limit, setLimit] = useState(3);

  const serviceRef = useRef<HTMLButtonElement>(null);
  const areaRef = useRef<HTMLInputElement>(null);

  const debouncedAreaQuery = useDebouncedValue(areaQuery, 250);
  const areasQuery = useAreas(debouncedAreaQuery, areaSearchActive);

  const areaOptions = (areasQuery.data ?? []).map((area) => ({
    value: area.id,
    label: areaLabel(area),
    keywords: [area.region, area.city].filter((part): part is string => Boolean(part)),
  }));

  const areaEmptyMessage = areasQuery.isFetching
    ? "Searching areas…"
    : areasQuery.isError
      ? "Area search is unavailable."
      : debouncedAreaQuery.trim()
        ? "No matching areas."
        : "Type to search areas.";

  function chooseArea(value: string) {
    setAreaId(value);
    setAreaQuery("");
    setSelectedArea((areasQuery.data ?? []).find((area) => area.id === value) ?? null);
    if (value) setFieldErrors((current) => ({ ...current, area: undefined }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextErrors: FieldErrors = {};
    if (!service) nextErrors.service = "Choose a service.";
    if (!areaId || !selectedArea) nextErrors.area = "Choose an area.";
    setFieldErrors(nextErrors);

    if (nextErrors.service) {
      serviceRef.current?.focus();
      return;
    }
    if (nextErrors.area) {
      areaRef.current?.focus();
      return;
    }

    const serviceLabel =
      (servicesQuery.data ?? []).find((item) => item.service_code === service)?.label ?? service;

    setLimit(3);
    setCommitted({
      service,
      serviceLabel,
      areaId,
      areaLabel: selectedArea ? areaLabel(selectedArea) : "Chosen area",
      radius,
    });
  }

  function widenRadius(next: number) {
    setRadius(next);
    setLimit(3);
    setCommitted((current) => (current ? { ...current, radius: next } : current));
  }

  const servicesError = servicesQuery.isError ? toApiError(servicesQuery.error) : null;
  const areasError = areasQuery.isError ? toApiError(areasQuery.error) : null;
  const servicesEmpty = servicesQuery.isSuccess && servicesQuery.data.length === 0;

  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Find care</h1>
        <p className={styles.subtitle}>
          Search the public directory by service and area. No account is needed, and nothing you type is saved.
        </p>
      </header>

      <ConnectionNotice />

      <section className={styles.searchPanel} aria-labelledby="care-search-title">
        <h2 id="care-search-title" className={styles.sectionTitle}>
          Search the directory
        </h2>

        {servicesError ? (
          <div className={styles.state}>
            <Alert tone="danger" title="Could not load services">
              {servicesError.message}
            </Alert>
            <div className={styles.errorActions}>
              <Button variant="secondary" size="sm" onClick={() => void servicesQuery.refetch()}>
                Try again
              </Button>
              <RequestId error={servicesQuery.error} />
            </div>
          </div>
        ) : null}

        {servicesEmpty ? (
          <div className={styles.state}>
            <Alert tone="info" title="No services are listed">
              The directory has no active services right now. Try again in a moment.
            </Alert>
            <Button variant="secondary" size="sm" onClick={() => void servicesQuery.refetch()}>
              Check again
            </Button>
          </div>
        ) : null}

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <div className={styles.fieldGrid}>
            <div className={styles.field}>
              <Select
                ref={serviceRef}
                label="Service"
                value={service}
                onValueChange={(value) => {
                  setService(value);
                  setFieldErrors((current) => ({ ...current, service: undefined }));
                }}
                options={(servicesQuery.data ?? []).map((item) => ({
                  value: item.service_code,
                  label: item.label,
                }))}
                placeholder={servicesQuery.isPending ? "Loading services…" : "Choose a service"}
                disabled={servicesQuery.isPending || servicesQuery.isError || servicesEmpty}
                description="Only services listed in the directory are shown."
              />
              {fieldErrors.service ? (
                <p className={styles.fieldError} role="alert">
                  {fieldErrors.service}
                </p>
              ) : null}
            </div>

            <div className={styles.field}>
              <Combobox
                ref={areaRef}
                label="Area"
                options={areaOptions}
                value={areaId}
                onValueChange={chooseArea}
                onInput={(event) => setAreaQuery(event.currentTarget.value)}
                onFocus={() => setAreaSearchActive(true)}
                aria-invalid={fieldErrors.area ? true : undefined}
                placeholder="Search for an area"
                description="Type a city or area name, then choose a match."
                emptyMessage={areaEmptyMessage}
              />
              {fieldErrors.area ? (
                <p className={styles.fieldError} role="alert">
                  {fieldErrors.area}
                </p>
              ) : null}
              {areasError ? (
                <div className={styles.areaError}>
                  <Alert tone="danger" title="Could not search areas">
                    {areasError.message}
                  </Alert>
                  <Button variant="secondary" size="sm" onClick={() => void areasQuery.refetch()}>
                    Retry area search
                  </Button>
                  <RequestId error={areasQuery.error} />
                </div>
              ) : null}
            </div>

            <Select
              label="Search radius"
              value={String(radius)}
              onValueChange={(value) => setRadius(Number(value))}
              options={RADIUS_OPTIONS}
              description="Distances are measured from the centre of the chosen area."
            />

            <div className={styles.submitRow}>
              <Button type="submit" size="lg" disabled={servicesEmpty}>
                Search facilities
              </Button>
            </div>
          </div>
        </form>

        <p className={styles.hint}>
          Distances are straight-line estimates. A recommendation does not book a visit or confirm availability.
        </p>
      </section>

      <section className={styles.results} aria-labelledby="results-title">
        <div className={styles.resultsHeader}>
          <h2 id="results-title" className={styles.sectionTitle}>
            Results
          </h2>
          {committed ? (
            <p className={styles.criteria}>
              {committed.serviceLabel} · {committed.areaLabel} · within {committed.radius} km
            </p>
          ) : null}
        </div>

        {committed ? (
          <FacilityResults
            service={committed.service}
            areaId={committed.areaId}
            radius={committed.radius}
            limit={limit}
            onShowMore={() => setLimit(10)}
            onWidenRadius={widenRadius}
            onChangeArea={() => areaRef.current?.focus()}
          />
        ) : (
          <p className={styles.prompt}>Choose a service and an area to see listed facilities.</p>
        )}
      </section>
    </div>
  );
}
