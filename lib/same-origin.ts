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

/**
 * The A2 signup / account-settings guard. It BLOCKS a cross-origin browser
 * submission (returns true) but ALLOWS a request with no Origin / Sec-Fetch-Site
 * signal at all (returns false).
 *
 * Deliberately weaker than isSameOriginRequest above: those admin / device-
 * passport endpoints fail closed on a missing Origin because a legitimate caller
 * there is always a same-origin browser fetch. POST /api/auth/signup and PATCH
 * /api/auth/me additionally serve non-browser callers (and the whole route-
 * handler test suite calls them with bare Request objects). A CSRF attack
 * requires a victim's browser, and a browser ALWAYS sends Origin on a
 * cross-origin POST/PATCH — so blocking exactly "Origin present and mismatched"
 * (or Sec-Fetch-Site: cross-site) stops the browser-CSRF vector without
 * rejecting every header-free programmatic client. The SameSite=Lax session
 * cookie (lib/auth-session.ts) is the other half of this defense.
 */
export function isCrossOriginBrowserRequest(request: Request): boolean {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite.toLowerCase() === "cross-site") return true;

  const origin = request.headers.get("origin");
  if (!origin || origin.toLowerCase() === "null") return false; // no browser cross-origin signal

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true; // malformed Origin — treat as hostile
  }

  const expectedHost = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (expectedHost && originHost === expectedHost) return false;

  try {
    if (originHost === new URL(request.url).host.toLowerCase()) return false;
  } catch {
    /* ignore */
  }
  return true;
}

/** Standard 403 body for a rejected cross-origin request. */
export const CROSS_ORIGIN_REJECTED = { error: "This request must come from the TurnitPlus site." } as const;
