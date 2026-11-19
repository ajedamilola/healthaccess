"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aiTimeout, request } from "../client";
import { qk } from "../keys";
import {
  symptomCreateBodySchema,
  symptomCreateResponseSchema,
  symptomDeleteResponseSchema,
  symptomDetailResponseSchema,
  symptomFollowUpBodySchema,
  symptomFollowUpResponseSchema,
  symptomListResponseSchema,
  symptomUpdateBodySchema,
  symptomUpdateResponseSchema,
  type SymptomCreateResponse,
  type SymptomDetailResponse,
  type SymptomListResponse,
  type SymptomUpdateBody,
} from "../schemas";

export const SYMPTOM_PAGE_SIZE = 10;

function symptomForm(
  message: string,
  includeRecords?: boolean,
  modifyHistory?: boolean,
  files: File[] = [],
  language?: string,
) {
  const body = new FormData();
  body.append("message", message);
  if (includeRecords !== undefined) body.append("includeRecords", String(includeRecords));
  if (modifyHistory !== undefined) body.append("modifyHistory", String(modifyHistory));
  if (language !== undefined) body.append("language", language);
  files.forEach((file) => body.append("images", file, file.name));
  return body;
}

export function useSymptoms(page: number) {
  return useQuery({
    queryKey: qk.symptoms(page),
    queryFn: () =>
      request<SymptomListResponse>(
        {
          method: "GET",
          url: "/symptom",
          params: { page, limit: SYMPTOM_PAGE_SIZE },
        },
        symptomListResponseSchema,
      ),
  });
}

export function useSymptom(id: string) {
  return useQuery({
    queryKey: qk.symptom(id),
    queryFn: () =>
      request<SymptomDetailResponse>(
        {
          method: "GET",
          url: `/symptom/${encodeURIComponent(id)}`,
        },
        symptomDetailResponseSchema,
      ),
    enabled: Boolean(id),
  });
}

export interface CreateSymptomInput {
  message: string;
  includeRecords: boolean;
  modifyHistory: boolean;
  language: string;
  files: File[];
  signal: AbortSignal;
}

export function useCreateSymptom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSymptomInput) => {
      const body = symptomCreateBodySchema.parse({
        message: input.message,
        includeRecords: input.includeRecords,
        modifyHistory: input.modifyHistory,
        language: input.language,
      });
      return request<SymptomCreateResponse>(
        {
          method: "POST",
          url: "/symptom",
          data: symptomForm(body.message, body.includeRecords, body.modifyHistory, input.files, body.language),
          timeout: aiTimeout,
          signal: input.signal,
        },
        symptomCreateResponseSchema,
      );
    },
    onSuccess: (data) => {
      queryClient.setQueryData(qk.symptom(data.symptom.id), {
        symptom: data.symptom,
        messages: data.messages,
      });
      queryClient.invalidateQueries({ queryKey: ["symptoms"] });
    },
  });
}

export interface FollowUpInput {
  message: string;
  files: File[];
  signal: AbortSignal;
}

export function useSymptomFollowUp(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FollowUpInput) => {
      const body = symptomFollowUpBodySchema.parse({ message: input.message });
      return request<SymptomCreateResponse>(
        {
          method: "POST",
          url: `/symptom/${encodeURIComponent(id)}/follow-up`,
          data: symptomForm(body.message, undefined, undefined, input.files),
          timeout: aiTimeout,
          signal: input.signal,
        },
        symptomFollowUpResponseSchema,
      );
    },
    onSuccess: (data) => {
      queryClient.setQueryData<SymptomDetailResponse>(qk.symptom(id), (current) => {
        if (!current) return { symptom: data.symptom, messages: data.messages };
        return {
          symptom: data.symptom,
          messages: [...current.messages, ...data.messages],
        };
      });
      queryClient.invalidateQueries({ queryKey: qk.symptom(id) });
      queryClient.invalidateQueries({ queryKey: ["symptoms"] });
    },
  });
}

export function useUpdateSymptom(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SymptomUpdateBody) => {
      const parsed = symptomUpdateBodySchema.parse(body);
      return request(
        {
          method: "PATCH",
          url: `/symptom/${encodeURIComponent(id)}`,
          data: parsed,
        },
        symptomUpdateResponseSchema,
      );
    },
    onSuccess: (data) => {
      queryClient.setQueryData<SymptomDetailResponse>(qk.symptom(id), (current) =>
        current ? { ...current, symptom: data.symptom } : current,
      );
      queryClient.invalidateQueries({ queryKey: ["symptoms"] });
    },
  });
}

export function useDeleteSymptom(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request(
        {
          method: "DELETE",
          url: `/symptom/${encodeURIComponent(id)}`,
        },
        symptomDeleteResponseSchema,
      ),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: qk.symptom(id) });
      queryClient.invalidateQueries({ queryKey: ["symptoms"] });
    },
  });
}
