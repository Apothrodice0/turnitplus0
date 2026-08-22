import { NextResponse } from "next/server";

/**
 * Every app/api/admin/* route builds its responses through this — a
 * consistent Cache-Control: no-store on every single response (success AND
 * error), so nothing from an admin-only surface (least of all a retained-
 * text preview) can ever be cached by a shared proxy, the browser's HTTP
 * cache, or a CDN layer in front of this app. Explicit rather than relying
 * solely on Next.js Route Handlers' own default dynamic behavior, which
 * governs re-execution, not necessarily the Cache-Control header a
 * downstream cache would actually see.
 */
export function adminJsonResponse(body: unknown, status: number, extraHeaders?: Record<string, string>): NextResponse {
  const headers: Record<string, string> = { "Cache-Control": "no-store", ...extraHeaders };
  if (body !== null) headers["Content-Type"] = "application/json";
  return new NextResponse(body === null ? null : JSON.stringify(body), { status, headers });
}
