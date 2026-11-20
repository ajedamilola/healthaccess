import { type NextRequest } from "next/server";
import { resetPasswordBodySchema } from "@/api/schemas";
import {
  UPSTREAM_V1,
  checkCsrf,
  errorNoStore,
  jsonNoStore,
  readJson,
} from "@/lib/auth-bff";
import { logRequest } from "@/lib/log";

export async function POST(request: NextRequest) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;

  const parsed = resetPasswordBodySchema.safeParse(await readJson(request));
  if (!parsed.success) return errorNoStore("validation_error", 400);

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM_V1}/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(parsed.data),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    logRequest("POST", "/auth/reset-password", 504);
    return errorNoStore("upstream_timeout", 504);
  }

  const body: unknown = await upstream.json().catch(() => null);
  logRequest("POST", "/auth/reset-password", upstream.status);
  return jsonNoStore(body ?? { error: "upstream_unavailable" }, upstream.status);
}
