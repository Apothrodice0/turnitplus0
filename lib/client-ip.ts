/**
 * The trustworthy client IP for rate-limiting (lib/rate-limit.ts), extracted
 * from a request's own headers. Production audit fix: every call site used
 * to take the FIRST entry of X-Forwarded-For, which is exactly the value an
 * attacker's own request supplies — a reverse proxy (Vercel's edge
 * included) APPENDS the IP address it directly observed the connection
 * from to the END of the chain before forwarding upstream, so the first
 * entry is always attacker-controlled while the last one is not (it's the
 * proxy's own observation, which the client has no way to influence). A
 * spoofed, ever-changing first entry let a caller get a fresh rate-limit
 * bucket on every single request, fully defeating checkAuthRate's 5/min
 * brute-force protection on login and checkRate everywhere else.
 *
 * x-real-ip (when present) is a single, non-chained value set the same
 * way by the proxy, so it's checked first as the simpler, equally
 * trustworthy signal.
 *
 * Was previously duplicated verbatim across 18 API route files plus two
 * inline copies in the SSR room/report pages — centralized here so the fix
 * (and any future one) can never drift out of sync between call sites
 * again.
 */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return 'unknown';
  const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : 'unknown';
}

export function clientIpFrom(request: Request): string {
  return clientIpFromHeaders(request.headers);
}
