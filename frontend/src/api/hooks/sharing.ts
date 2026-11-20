"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../client";
import { toApiError } from "../errors";
import { qk } from "../keys";
import {
  accessEventsResponseSchema,
  emergencyLookupBodySchema,
  emergencyLookupResponseSchema,
  fieldsResponseSchema,
  grantCreateBodySchema,
  grantCreateResponseSchema,
  grantListSchema,
  grantRevokeResponseSchema,
  patientCodeSchema,
  type AccessEvent,
  type EmergencyLookupBody,
  type EmergencyLookupResponse,
  type FieldDefinition,
  type Grant,
  type GrantCreateBody,
} from "../schemas";

function isShareable(field: FieldDefinition): boolean {
  if (field.value === null || field.value === undefined) return false;
  if (Array.isArray(field.value)) return field.value.length > 0;
  if (typeof field.value === "string") return field.value.trim().length > 0;
  return true;
}

/**
 * The fields the patient can share. Kept in this feature because sharing needs labels and
 * values together; the record lane owns the editing flow.
 */
export function useShareableFields() {
  return useQuery({
    queryKey: qk.fields,
    queryFn: () => request({ url: "/me/fields", method: "GET" }, fieldsResponseSchema),
    select: (data) => ({ ...data, fields: data.fields.filter(isShareable) }),
  });
}

/** Patient codes never outlive the screen: gcTime 0 removes the query as soon as it unmounts. */
export function usePatientCode() {
  return useQuery({
    queryKey: qk.patientCode,
    queryFn: () => request({ url: "/me/patient-code", method: "GET" }, patientCodeSchema),
    gcTime: 0,
    staleTime: 0,
  });
}

export function useRotatePatientCode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => request({ url: "/me/patient-code/rotate", method: "POST" }, patientCodeSchema),
    gcTime: 0,
    onSuccess: (code) => {
      queryClient.setQueryData(qk.patientCode, code);
      queryClient.invalidateQueries({ queryKey: qk.grants });
      queryClient.invalidateQueries({ queryKey: qk.accessEvents });
    },
  });
}

export function useGrants() {
  return useQuery({
    queryKey: qk.grants,
    queryFn: () => request({ url: "/me/grants", method: "GET", params: { limit: 100 } }, grantListSchema),
  });
}

export function useCreateGrant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GrantCreateBody) =>
      request({ url: "/me/grants", method: "POST", data: grantCreateBodySchema.parse(body) }, grantCreateResponseSchema),
    // The response carries the one-time code. It stays in the caller's state, never in a query.
    gcTime: 0,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.grants });
      queryClient.invalidateQueries({ queryKey: qk.accessEvents });
    },
    onError: (error) => {
      // A timeout may still have created the grant, so refresh the list before another attempt.
      if (toApiError(error).code === "upstream_timeout") {
        queryClient.invalidateQueries({ queryKey: qk.grants });
      }
    },
  });
}

/** One tap: a temporary code for the emergency information, valid on the web and USSD. */
export function useQuickShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (minutes: number) =>
      request(
        { url: "/me/grants/quick", method: "POST", data: { expires_in_minutes: minutes } },
        grantCreateResponseSchema,
      ),
    gcTime: 0,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.grants });
      queryClient.invalidateQueries({ queryKey: qk.accessEvents });
    },
  });
}

export function useRevokeGrant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request({ url: `/me/grants/${encodeURIComponent(id)}`, method: "DELETE" }, grantRevokeResponseSchema),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<Grant[]>(qk.grants, (current) =>
        current?.map((grant) =>
          grant.id === id ? { ...grant, status: "revoked", revoked_at: new Date().toISOString() } : grant,
        ),
      );
      queryClient.invalidateQueries({ queryKey: qk.grants });
      queryClient.invalidateQueries({ queryKey: qk.accessEvents });
    },
  });
}

export function useAccessEvents(limit = 50) {
  return useQuery({
    queryKey: [...qk.accessEvents, limit],
    queryFn: () =>
      request({ url: "/me/access-events", method: "GET", params: { limit } }, accessEventsResponseSchema),
    placeholderData: keepPreviousData,
  });
}

/** Emergency reads are read-only and leave the mutation cache as soon as the screen unmounts. */
export function useEmergencyLookup() {
  return useMutation({
    mutationFn: (body: EmergencyLookupBody) =>
      request(
        { url: "/records/emergency", method: "POST", data: emergencyLookupBodySchema.parse(body) },
        emergencyLookupResponseSchema,
      ),
    gcTime: 0,
  });
}

export type { AccessEvent, EmergencyLookupResponse, Grant };
