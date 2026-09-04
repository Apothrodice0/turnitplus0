/**
 * Resolve the browser-facing base URL ("https://host") of THIS deployment for a
 * link we are about to email (an email-verification URL) — or null when the
 * request's host cannot be trusted.
 *
 * SECURITY: the token in a verification URL is a bearer credential. We must
 * never mint a link pointing at a host an attacker chose via a spoofed `Host`,
 * `X-Forwarded-Host`, or `Origin` header — a victim who clicks it hands their
 * token to that host. So the resolved host MUST pass an explicit allowlist:
 *
 *   - LOCAL DEVELOPMENT (only when NOT running on Vercel): localhost /
 *     127.0.0.1 / [::1], any port.
 *   - VERCEL (Preview + Production): an EXACT match against one of Vercel's own
 *     system-injected deployment hosts — VERCEL_PROJECT_PRODUCTION_URL (the
 *     stable production domain), VERCEL_URL (this exact deployment), or
 *     VERCEL_BRANCH_URL (the branch alias a Preview is actually reached at).
 *     These are set automatically by the Vercel runtime; they are NOT
 *     operator-configured application secrets, and this phase adds none.
 *
 * Every other host — an arbitrary domain, or even an arbitrary `*.vercel.app` —
 * is REJECTED (returns null). The caller must then decline to send the
 * verification email rather than generate a link to an unverified host.
 *
 * The `Origin` header is never consulted for URL construction.
 */

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

function hostOnly(value: string | null | undefined): string {
  return (value ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '');
}

/** Vercel's own system-injected deployment hosts (never operator env). Exact-host only. */
function vercelSystemHosts(): Set<string> {
  const out = new Set<string>();
  for (const raw of [
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
  ]) {
    const h = hostOnly(raw);
    if (h) out.add(h);
  }
  return out;
}

/** Candidate hosts from the request, in decreasing order of "what the browser saw". */
function candidateHosts(request: Request): string[] {
  const list: string[] = [];
  const push = (h: string) => {
    if (h && !list.includes(h)) list.push(h);
  };
  push(hostOnly(request.headers.get('x-forwarded-host')));
  push(hostOnly(request.headers.get('host')));
  try {
    push(new URL(request.url).host.toLowerCase());
  } catch {
    /* ignore */
  }
  return list;
}

export function resolveTrustedVerificationBaseUrl(request: Request): string | null {
  const onVercel = !!process.env.VERCEL;
  const trusted = vercelSystemHosts();

  for (const host of candidateHosts(request)) {
    if (!onVercel && LOCAL_HOST_RE.test(host)) return `http://${host}`;
    if (trusted.has(host)) return `https://${host}`;
  }
  return null;
}

/** The path a verification link points at. The raw token rides as `?token=`. */
export function emailVerificationUrl(baseUrl: string, rawToken: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/verify-email?token=${encodeURIComponent(rawToken)}`;
}
