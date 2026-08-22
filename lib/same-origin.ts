/**
 * Same-origin enforcement for state-changing admin routes (CSRF defense in
 * depth). The session cookie already carries `sameSite: 'lax'` (see
 * lib/auth-session.ts's setSessionCookie), which already excludes the
 * cookie from cross-site POST/fetch requests in every modern browser — this
 * is an explicit second check, not the only one, because SameSite has known
 * browser-version/edge-case gaps and the admin surface this guards
 * (deactivating/reactivating corpus content, revealing retained text)
 * warrants defense in depth beyond relying on cookie behavior alone.
 *
 * Fails CLOSED: a request with no Origin header at all is rejected, not
 * assumed same-origin. Real browsers always send Origin on a cross-origin
 * fetch/XHR, and on a same-origin POST/fetch too (Origin is sent for any
 * "unsafe" method, not just cross-origin ones, per the Fetch spec) — so a
 * legitimate same-origin admin POST always carries one; its absence is
 * itself a signal of a non-browser or deliberately stripped-header caller,
 * not a benign edge case.
 *
 * x-forwarded-host is checked before the raw Host header, matching
 * lib/client-ip.ts's own convention: Vercel's edge sets x-forwarded-host to
 * the client-facing host, which is what a browser's Origin will actually
 * match — the raw Host header on requests reaching this app internally can
 * differ.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const expectedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!expectedHost) return false;

  try {
    return new URL(origin).host === expectedHost;
  } catch {
    return false;
  }
}
