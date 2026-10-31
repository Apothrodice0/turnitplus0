/**
 * The message the sign-in / sign-up form shows for a failed request. The server's own `error` text is kept, except where
 * it gives the customer no next step:
 *   - 429: the routes answer "Too many requests" with a Retry-After header (seconds) — say how long to wait;
 *   - a signup identity rejection says "review the highlighted fields" and lists the failing `fields`, but the form has
 *     no server-error highlighting — name the fields instead.
 * Never adds account or credential detail beyond what the server already returned.
 */
const FIELD_LABELS: Record<string, string> = {
  fullName: "Full name",
  accountType: "Account type",
  countryCode: "Country",
  city: "City",
  phone: "Phone number",
  institution: "Institution",
};

export function authErrorMessage(status: number, data: { error?: unknown; fields?: unknown } | null, retryAfterHeader: string | null): string {
  if (status === 429) {
    const seconds = Number(retryAfterHeader);
    const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : null;
    return minutes === null
      ? "Too many attempts. Please wait a few minutes, then try again."
      : `Too many attempts. Please wait about ${minutes} minute${minutes === 1 ? "" : "s"}, then try again.`;
  }
  if (Array.isArray(data?.fields) && data.fields.length > 0) {
    const labels = [...new Set(data.fields.map((f) => FIELD_LABELS[String((f as { field?: unknown })?.field)]).filter(Boolean))];
    if (labels.length > 0) return `Some of your details could not be verified: ${labels.join(", ")}. Please check them and try again.`;
  }
  return (typeof data?.error === "string" && data.error) || "Something went wrong. Please try again.";
}
