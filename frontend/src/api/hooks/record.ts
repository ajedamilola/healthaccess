"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { request } from "../client";
import { qk } from "../keys";
import {
  assistantContextSchema,
  emergencyFieldsResponseSchema,
  emergencySummarySchema,
  fieldsResponseSchema,
  meResponseSchema,
  medicalEventResponseSchema,
  patchMedicalEventBodySchema,
  putEmergencyFieldsBodySchema,
  putFieldsBodySchema,
  type AssistantContext,
  type EmergencyFieldsResponse,
  type EmergencySummary,
  type FieldsResponse,
  type MeResponse,
  type MedicalEvent,
  type PatchMeBody,
  type PutMedicalBody,
  type Session,
} from "../schemas";

const noContentSchema = z.unknown();

/** The snapshot documents the success body but has no schema for it yet; this stays a local trust boundary. */
const avatarResponseSchema = z
  .object({
    avatar_key: z.string().min(1),
    avatar_url: z.string().min(1),
  })
  .loose();

export type AvatarResponse = z.infer<typeof avatarResponseSchema>;
export type MedicalEventPatch = { id: string; body: z.infer<typeof patchMedicalEventBodySchema> };

function fetchFields(): Promise<FieldsResponse> {
  return request<FieldsResponse>({ method: "GET", url: "/me/fields" }, fieldsResponseSchema);
}

export function useFields() {
  return useQuery({
    queryKey: qk.fields,
    queryFn: fetchFields,
  });
}

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: () => request<MeResponse>({ method: "GET", url: "/me" }, meResponseSchema),
  });
}

/** What the symptom assistant knows about the patient and what is missing. */
export function useAssistantContext(enabled = true) {
  return useQuery({
    queryKey: qk.assistantContext,
    queryFn: () =>
      request<AssistantContext>({ method: "GET", url: "/me/assistant-context" }, assistantContextSchema),
    enabled,
  });
}

export function useEmergencySummary() {
  return useQuery({
    queryKey: qk.emergency,
    queryFn: () => request<EmergencySummary>({ method: "GET", url: "/me/emergency-summary" }, emergencySummarySchema),
  });
}

export function useUpdateMe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchMeBody) =>
      request<MeResponse>({ method: "PATCH", url: "/me", data: body }, meResponseSchema),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.me, data);
      queryClient.setQueryData<Session | undefined>(qk.session, (current) =>
        current ? { ...current, account: data.account, roles: data.roles } : current,
      );
      void queryClient.invalidateQueries({ queryKey: qk.fields });
      void queryClient.invalidateQueries({ queryKey: qk.emergency });
      void queryClient.invalidateQueries({ queryKey: qk.assistantContext });
    },
  });
}

export function usePutMedical() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PutMedicalBody) =>
      request<MeResponse>({ method: "PUT", url: "/me/medical", data: body }, meResponseSchema),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.me, data);
      void queryClient.invalidateQueries({ queryKey: qk.assistantContext });
      void queryClient.invalidateQueries({ queryKey: qk.fields });
      void queryClient.invalidateQueries({ queryKey: qk.emergency });
    },
  });
}

export function usePatchMedicalEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: MedicalEventPatch) =>
      request<{ event: MedicalEvent }>(
        { method: "PATCH", url: `/me/medical-events/${id}`, data: body },
        medicalEventResponseSchema,
      ),
    onSuccess: ({ event }) => {
      queryClient.setQueryData<MeResponse | undefined>(qk.me, (current) =>
        current
          ? { ...current, medical_events: current.medical_events.map((item) => (item.id === event.id ? event : item)) }
          : current,
      );
    },
  });
}

export function useDeleteMedicalEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request({ method: "DELETE", url: `/me/medical-events/${id}` }, noContentSchema),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<MeResponse | undefined>(qk.me, (current) =>
        current ? { ...current, medical_events: current.medical_events.filter((item) => item.id !== id) } : current,
      );
    },
  });
}

export function useDeleteAllergy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request({ method: "DELETE", url: `/me/allergies/${id}` }, noContentSchema),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<MeResponse | undefined>(qk.me, (current) =>
        current ? { ...current, allergies: current.allergies.filter((item) => item.id !== id) } : current,
      );
    },
  });
}

export function useUploadAvatar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append("image", file);
      return request<AvatarResponse>({ method: "POST", url: "/me/avatar", data: body }, avatarResponseSchema);
    },
    onSuccess: (data) => {
      queryClient.setQueryData<MeResponse | undefined>(qk.me, (current) =>
        current ? { ...current, avatar_url: data.avatar_url } : current,
      );
    },
  });
}

export function useUpdateFields() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: z.infer<typeof putFieldsBodySchema>) =>
      request<FieldsResponse>({ method: "PUT", url: "/me/fields", data: body }, fieldsResponseSchema),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.fields, data);
      void queryClient.invalidateQueries({ queryKey: qk.me });
      void queryClient.invalidateQueries({ queryKey: qk.emergency });
    },
  });
}

export function useUpdateEmergencyFields() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: z.infer<typeof putEmergencyFieldsBodySchema>) =>
      request<EmergencyFieldsResponse>(
        { method: "PUT", url: "/me/emergency-fields", data: body },
        emergencyFieldsResponseSchema,
      ),
    onSuccess: (data) => {
      // Keep the next expected_version fresh without waiting for the fields refetch.
      queryClient.setQueryData<FieldsResponse | undefined>(qk.fields, (current) =>
        current ? { ...current, version: data.version } : current,
      );
      void queryClient.invalidateQueries({ queryKey: qk.emergency });
    },
  });
}
