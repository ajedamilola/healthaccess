"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../client";
import { qk } from "../keys";
import {
  openCodeResponseSchema,
  type OpenCodeResponse,
  grantCloseResponseSchema,
  grantOpenBodySchema,
  grantProjectionSchema,
  type GrantOpenBody,
  type GrantProjection,
} from "../schemas";

/** The projection is stored under qk.readSession(id) so the record page opens without a flash. */
export function useOpenGrant() {
  return useMutation({
    mutationFn: (body: GrantOpenBody) =>
      request(
        { url: "/records/grant/open", method: "POST", data: grantOpenBodySchema.parse(body) },
        grantProjectionSchema,
      ),
    gcTime: 0,
  });
}

/** Open any shared-information code (12-digit emergency or 8-digit temporary). */
export function useOpenCode() {
  return useMutation({
    mutationFn: (code: string) =>
      request<OpenCodeResponse>({ url: "/records/open", method: "POST", data: { code } }, openCodeResponseSchema),
    gcTime: 0,
  });
}

export function useReadSession(id: string) {
  return useQuery({
    queryKey: qk.readSession(id),
    queryFn: () => request({ url: `/records/grant/${encodeURIComponent(id)}`, method: "GET" }, grantProjectionSchema),
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useCloseReadSession(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request({ url: `/records/grant/${encodeURIComponent(id)}/close`, method: "POST" }, grantCloseResponseSchema),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: qk.readSession(id) });
    },
  });
}

export type { GrantProjection };
