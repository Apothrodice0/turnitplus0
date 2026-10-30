import type { SessionUser } from "./auth-session";
import type { PredictedHighlightRange, SimilarityReport } from "./report-types";
import { comparisonText } from "./similarity-core";

/**
 * TURNITIN HIGHLIGHT MODEL — protected prototype. A word-level model predicts which passages Turnitin would highlight;
 * those passages are drawn in the existing report body, in the gaps System 1's verified matches leave.
 *
 * What it never does: add a source, change a percentage or matched-word count, or get stored. Predicted ranges are
 * attached to one outgoing response for an allowed viewer and live nowhere else (encodeReportForPersistence drops them
 * if a client sends them back).
 *
 * Who sees it, decided on the server for every read: HIGHLIGHT_MODEL_ENABLED=1, a URL and a key of at least 32
 * characters, never on a production deployment, and only an administrator or an account on
 * HIGHLIGHT_MODEL_OWNER_EMAILS. Anything else, or any model failure, leaves the report exactly as it was.
 */
export type HighlightModelConfig = { enabled: boolean; url: string; key: string; ownerEmails: string[]; timeoutMs: number };

const MIN_KEY_LENGTH = 32;
const MAX_RANGES = 20_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export function highlightModelConfig(env: NodeJS.ProcessEnv = process.env): HighlightModelConfig {
  const url = (env.HIGHLIGHT_MODEL_URL ?? "").trim();
  const key = env.HIGHLIGHT_MODEL_KEY ?? "";
  const timeoutMs = Number(env.HIGHLIGHT_MODEL_TIMEOUT_MS);
  return {
    enabled: env.HIGHLIGHT_MODEL_ENABLED === "1" && env.VERCEL_ENV !== "production" && url.length > 0 && key.length >= MIN_KEY_LENGTH,
    url,
    key,
    ownerEmails: (env.HIGHLIGHT_MODEL_OWNER_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

export function canViewPredictedHighlights(user: Pick<SessionUser, "email" | "role"> | null | undefined, config: HighlightModelConfig): boolean {
  if (!config.enabled || !user) return false;
  return user.role === "admin" || (typeof user.email === "string" && config.ownerEmails.includes(user.email.trim().toLowerCase()));
}

/** Only whole, in-bounds, non-overlapping character ranges survive; the backend's response is never passed through. */
export function sanitizePredictedRanges(raw: unknown, textLength: number): PredictedHighlightRange[] {
  if (!Array.isArray(raw)) return [];
  const ranges = raw
    .filter((range): range is PredictedHighlightRange =>
      Boolean(range) && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end > range.start && range.end <= textLength)
    .map(({ start, end }) => ({ start, end }))
    .sort((left, right) => left.start - right.start);
  const merged: PredictedHighlightRange[] = [];
  for (const range of ranges.slice(0, MAX_RANGES)) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged;
}

export async function requestPredictedHighlights(text: string, config: HighlightModelConfig, fetchImpl: typeof fetch = fetch): Promise<PredictedHighlightRange[]> {
  // comparisonText is a prefix of the report text (the product's reference cut), so the offsets stay valid; the model
  // was trained without the reference section.
  const compared = comparisonText(text);
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
    body: JSON.stringify({ text: compared }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`highlight model responded ${response.status}`);
  const body = (await response.json()) as { ranges?: unknown };
  return sanitizePredictedRanges(body.ranges, compared.length);
}

/** Adds predictedHighlights to one outgoing report for an allowed viewer. Non-fatal: a failure logs a code, no document content. */
export async function attachPredictedHighlights(
  report: SimilarityReport,
  viewer: Pick<SessionUser, "email" | "role"> | null | undefined,
  config: HighlightModelConfig = highlightModelConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!canViewPredictedHighlights(viewer, config) || !report.text) return;
  try {
    report.predictedHighlights = await requestPredictedHighlights(report.text, config, fetchImpl);
  } catch (err) {
    console.error("highlight model unavailable (non-fatal):", err instanceof Error ? err.name : "unknown");
  }
}
