import { ApiError, toApiError } from "@/api/errors";
import type { FieldDefinition } from "@/api/schemas";

export type FieldDraft = Record<string, string | string[]>;

export type FieldChange = {
  key: string;
  label: string;
  mine: string;
  server: string;
};

/** The form value for a definition, so null arrays and null strings start from the same shape the form edits. */
export function draftValueFor(field: FieldDefinition): string | string[] {
  if (field.value_type === "STRING_ARRAY") {
    return Array.isArray(field.value) ? [...field.value] : [];
  }
  return typeof field.value === "string" || typeof field.value === "number" ? String(field.value) : "";
}

/** Values in the record form are strings or string arrays, matching the two editable value types. */
export function draftFor(fields: FieldDefinition[]): FieldDraft {
  const draft: FieldDraft = {};
  for (const field of fields) {
    draft[field.key] = draftValueFor(field);
  }
  return draft;
}

export function valueForDraft(value: FieldDefinition["value"]): string | string[] {
  if (Array.isArray(value)) return [...value];
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

export function sameValue(a: string | string[], b: string | string[]): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return a === b;
}

export function changedKeys(draft: FieldDraft, fields: FieldDefinition[]): string[] {
  return fields
    .filter((field) => {
      const current = draft[field.key];
      if (current === undefined) return false;
      return !sameValue(current, draftValueFor(field));
    })
    .map((field) => field.key);
}

export function changedFieldValues(draft: FieldDraft, fields: FieldDefinition[], keys: string[]): FieldDraft {
  const payload: FieldDraft = {};
  for (const key of keys) {
    const value = draft[key];
    if (value !== undefined) payload[key] = Array.isArray(value) ? [...value] : value;
  }
  return payload;
}

/**
 * The conflict panel shows what someone else saved next to the local draft.
 * Only fields whose draft differs from the refreshed server value need a decision.
 */
export function conflictChanges(draft: FieldDraft, fields: FieldDefinition[]): FieldChange[] {
  return fields.flatMap((field) => {
    const mine = draft[field.key];
    const serverValue = draftValueFor(field);
    if (mine === undefined || sameValue(mine, serverValue)) return [];
    return [
      {
        key: field.key,
        label: field.label,
        mine: readableValue(mine),
        server: readableServerValue(field.value),
      },
    ];
  });
}

export function readableValue(value: string | string[]): string {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "No values";
  return value.trim() ? value : "Empty";
}

export function readableServerValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "No values";
  if (value === null || value === undefined) return "No value";
  if (typeof value === "string") return value.trim() ? value : "Empty";
  return String(value);
}

export function isVersionConflict(error: unknown): boolean {
  return toApiError(error).code === "version_conflict";
}

/** A timed-out mutation may still have been applied, so callers refetch before offering a retry. */
export function isUpstreamTimeout(error: unknown): boolean {
  return toApiError(error).code === "upstream_timeout";
}

export function isDenied(error: unknown): boolean {
  const apiError = toApiError(error);
  return apiError instanceof ApiError && apiError.denied;
}

/** Maps API `issues[].path` onto the field key the form knows. */
export function issueMessages(error: unknown, knownKeys: string[]): Record<string, string> {
  const issues = toApiError(error).issues ?? [];
  const messages: Record<string, string> = {};
  for (const issue of issues) {
    const segments = issue.path.split(".");
    const known = [...segments].reverse().find((segment) => knownKeys.includes(segment));
    const key = known ?? segments[segments.length - 1] ?? issue.path;
    if (!messages[key]) messages[key] = issue.message;
  }
  return messages;
}

/** Date-only values are formatted from their calendar part so a UTC midnight never shifts the day. */
export function formatIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
