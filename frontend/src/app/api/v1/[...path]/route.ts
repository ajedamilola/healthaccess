import { type NextRequest } from "next/server";
import { ACCESS_COOKIE, UPSTREAM_V1, checkCsrf, isBlockedPath, jsonNoStore } from "@/lib/auth-bff";
import { logRequest } from "@/lib/log";


type RouteParams = { params: Promise<{ path: string[] }> };

function aiPath(method: string, path: string) {
  if (method === "POST" && /^symptom(\/stream|\/[^/]+\/follow-up(\/stream)?)?$/.test(path)) return true;
  return (method === "POST" || method === "PATCH") && (path === "medications" || path.startsWith("medications/"));
}

async function handle(request: NextRequest, { params }: RouteParams) {
  const { path: segments } = await params;
  if (isBlockedPath(segments)) {
    return jsonNoStore({ error: "not_found" }, 404);
  }

  const csrf = checkCsrf(request);
  if (csrf) return csrf;

  const path = segments.join("/");
  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join("/");
  const url = `${UPSTREAM_V1}/${encodedPath}${request.nextUrl.search}`;
  const method = request.method.toUpperCase();
  const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;

  const headers: Record<string, string> = { accept: request.headers.get("accept") ?? "application/json" };
  const contentType = request.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const hasBody = method !== "GET" && method !== "HEAD";
  const timeout = aiPath(method, path) ? 190_000 : 20_000;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers,
      body: hasBody && request.body ? request.body : undefined,
      cache: "no-store",
      // Abort upstream work when the browser disconnects (for example a cancelled stream).
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]),
      // Required by Node's fetch when streaming a request body through.
      ...({ duplex: "half" } as Record<string, unknown>),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    logRequest(method, `/${path}`, timedOut ? 504 : 502);
    return jsonNoStore({ error: timedOut ? "upstream_timeout" : "upstream_unavailable" }, timedOut ? 504 : 502);
  }

  logRequest(method, `/${path}`, upstream.status);

  if (upstream.status === 401) {
    return jsonNoStore({ error: "token_expired" }, 401);
  }

  const upstreamType = upstream.headers.get("content-type");
  if (upstream.ok && upstreamType?.includes("text/event-stream") && upstream.body) {
    // Pass server-sent events through as they arrive instead of buffering the full reply.
    const streamHeaders: Record<string, string> = {
      "content-type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    };
    const streamRequestId = upstream.headers.get("x-request-id");
    if (streamRequestId) streamHeaders["x-request-id"] = streamRequestId;
    return new Response(upstream.body, { status: upstream.status, headers: streamHeaders });
  }

  const body = upstream.status === 204 ? null : await upstream.text();
  const responseHeaders: Record<string, string> = { "Cache-Control": "no-store" };
  if (upstreamType) responseHeaders["content-type"] = upstreamType;
  const requestId = upstream.headers.get("x-request-id");
  if (requestId) responseHeaders["x-request-id"] = requestId;

  return new Response(body, { status: upstream.status, headers: responseHeaders });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
