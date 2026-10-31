/**
 * The origin a password-reset link may point to — never an arbitrary request value.
 *
 * 1. PASSWORD_RESET_BASE_URL (operator setting, recommended for Production, e.g. the public customer URL): when set, the
 *    link ALWAYS uses exactly this origin, whatever host the request arrived on. It must be an https URL (http only
 *    outside Vercel, for local development); an invalid value fails closed (null), it is never "fixed up".
 * 2. Otherwise the request's own host (from request.url) is accepted only when it EXACTLY equals one of this deployment's
 *    Vercel system hostnames (VERCEL_URL, VERCEL_BRANCH_URL, VERCEL_PROJECT_PRODUCTION_URL — set by Vercel, not by the
 *    request) or, outside Vercel, a localhost development host.
 * Anything else (another *.vercel.app, a spoofed or look-alike host) returns null and the caller refuses to mint a link.
 * The Origin and Referer headers are never used.
 */
export function resolveTrustedAppBaseUrl(request: Request, env: Record<string, string | undefined> = process.env): string | null {
  const configured = (env.PASSWORD_RESET_BASE_URL ?? "").trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || (!env.VERCEL && url.protocol === "http:")) return url.origin;
    } catch {
      // fall through: an invalid setting is refused, not guessed
    }
    return null;
  }
  let host: string;
  try {
    host = new URL(request.url).host.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  const trusted = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
    .map((value) => (value ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (trusted.includes(host)) return `https://${host}`;
  if (!env.VERCEL && /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host)) return `http://${host}`;
  return null;
}
