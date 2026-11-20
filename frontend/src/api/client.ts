import axios, { AxiosError, type AxiosRequestConfig } from "axios";
import { z } from "zod";
import { queryClient } from "@/lib/query-client";
import { ApiError, toApiError } from "./errors";

export const aiTimeout = 190_000;

type RetriableConfig = AxiosRequestConfig & { __haRetried?: boolean };

let refreshPromise: Promise<void> | null = null;

export function redirectToLogin() {
  if (typeof window === "undefined") return;
  const next = window.location.pathname;
  window.location.replace(`/login?next=${encodeURIComponent(next)}`);
}

/**
 * Refresh tokens are single-use, so concurrent 401s must share one refresh call.
 * Uses the bare axios instance so a failing refresh cannot loop through the interceptor.
 */
export function refreshSession(): Promise<void> {
  refreshPromise ??= axios
    .post("/api/auth/refresh", null, {
      headers: { "X-HA-Client": "web" },
      withCredentials: true,
      timeout: 20_000,
    })
    .then(() => undefined)
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

export const api = axios.create({
  baseURL: "/api/v1",
  timeout: 20_000,
  withCredentials: true,
  headers: { "X-HA-Client": "web" },
});

/** BFF auth endpoints live outside /api/v1. */
export const bff = axios.create({
  timeout: 20_000,
  withCredentials: true,
  headers: { "X-HA-Client": "web" },
});

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetriableConfig | undefined;
    const isExpired = error.response?.status === 401 && (error.response.data as { error?: string } | null)?.error === "token_expired";

    if (isExpired && config && !config.__haRetried) {
      config.__haRetried = true;
      try {
        await refreshSession();
        return api.request(config);
      } catch {
        queryClient.clear();
        redirectToLogin();
        throw toApiError(error);
      }
    }

    throw toApiError(error);
  },
);

/** Fetch and parse. A schema failure is an ApiError with code invalid_response. */
export async function request<T>(config: AxiosRequestConfig, schema: z.ZodType<T>): Promise<T> {
  try {
    const response = await api.request<unknown>(config);
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) {
      throw new ApiError({
        status: response.status,
        code: "invalid_response",
        requestId: readRequestId(response.data),
      });
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw toApiError(error);
  }
}

function readRequestId(body: unknown): string | undefined {
  if (body && typeof body === "object" && "request_id" in body) {
    const value = (body as { request_id?: unknown }).request_id;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}
