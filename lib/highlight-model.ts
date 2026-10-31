import { forgetServiceIdentityToken, serviceIdentityFromEnv, serviceIdentityToken, type ServiceIdentity } from "./highlight-model-auth";
import type { PredictedHighlightRange } from "./report-types";
import { comparisonText } from "./similarity-core";

/**
 * TURNITIN HIGHLIGHT MODEL — the client of the private inference service. A word-level model predicts which passages
 * Turnitin would highlight; lib/highlight-predictions.ts runs it once for a saved report and keeps the result. Those
 * passages are drawn in the report body, in the gaps System 1's verified matches leave.
 *
 * What it never does: add a source, change a percentage or matched-word count, or change the report's own payload.
 *
 * Off unless HIGHLIGHT_MODEL_ENABLED=1 with a URL, a key of at least 32 characters and a model version; on a production
 * deployment it also needs HIGHLIGHT_MODEL_PRODUCTION_ENABLED=1. A private Cloud Run service also needs its Google
 * identity (lib/highlight-model-auth.ts); an identity that is set but unusable keeps the model off. Who a prediction is
 * made for is decided per report (lib/highlight-predictions.ts). Any failure leaves the report exactly as it was.
 */
export type HighlightModelConfig = {
  enabled: boolean;
  url: string;
  key: string;
  /** The one model this deployment serves; a stored result answers only for this version. */
  modelVersion: string;
  subscribersEnabled: boolean;
  ownerEmails: string[];
  timeoutMs: number;
  maxWords: number;
  /** Words sent to the service per UTC day, across all reports and retries (lib/highlight-predictions.ts). */
  dailyWordLimit: number;
  /** The Google identity a private Cloud Run service requires; null for a service that needs none. */
  identity: ServiceIdentity | null;
};

const MIN_KEY_LENGTH = 32;
const MAX_RANGES = 20_000;
// Inside the 300 s the routes that run the job are given (maxDuration): a 60,000-word document takes about 130 s on
// 4 vCPU, plus a cold start. Longer documents keep their verified report and get no predictions.
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_WORDS = 60_000;
// About 2,000 s of 4 vCPU a day at the measured ~500 words/s: well under $1 a day, whatever happens.
const DEFAULT_DAILY_WORD_LIMIT = 1_000_000;

export function highlightModelConfig(env: NodeJS.ProcessEnv = process.env): HighlightModelConfig {
  const url = (env.HIGHLIGHT_MODEL_URL ?? "").trim();
  const key = env.HIGHLIGHT_MODEL_KEY ?? "";
  const modelVersion = (env.HIGHLIGHT_MODEL_VERSION ?? "").trim();
  const timeoutMs = Number(env.HIGHLIGHT_MODEL_TIMEOUT_MS);
  const maxWords = Number(env.HIGHLIGHT_MODEL_MAX_WORDS);
  const dailyWordLimit = Number(env.HIGHLIGHT_MODEL_DAILY_WORD_LIMIT);
  const productionAllowed = env.VERCEL_ENV !== "production" || env.HIGHLIGHT_MODEL_PRODUCTION_ENABLED === "1";
  const identity = serviceIdentityFromEnv(env);
  return {
    enabled: env.HIGHLIGHT_MODEL_ENABLED === "1" && productionAllowed && url.length > 0 && key.length >= MIN_KEY_LENGTH && modelVersion.length > 0 && identity !== "INVALID",
    url,
    key,
    modelVersion,
    subscribersEnabled: env.HIGHLIGHT_MODEL_SUBSCRIBERS_ENABLED === "1",
    ownerEmails: (env.HIGHLIGHT_MODEL_OWNER_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    maxWords: Number.isFinite(maxWords) && maxWords > 0 ? maxWords : DEFAULT_MAX_WORDS,
    dailyWordLimit: Number.isFinite(dailyWordLimit) && dailyWordLimit >= 0 && env.HIGHLIGHT_MODEL_DAILY_WORD_LIMIT?.trim() ? dailyWordLimit : DEFAULT_DAILY_WORD_LIMIT,
    identity: identity === "INVALID" ? null : identity,
  };
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

/** A failure of the service. Not retryable when asking again cannot help: wrong key or path, over the limit, another model. */
export class HighlightModelError extends Error {
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = "HighlightModelError";
    this.retryable = retryable;
  }
}

export async function requestPredictedHighlights(text: string, config: HighlightModelConfig, fetchImpl: typeof fetch = fetch): Promise<PredictedHighlightRange[]> {
  // comparisonText is a prefix of the report text (the product's reference cut), so the offsets stay valid; the model
  // was trained without the reference section.
  const compared = comparisonText(text);
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` };
  if (config.identity) {
    const token = await serviceIdentityToken(config.identity, fetchImpl).catch((error: { message?: string; retryable?: boolean }) => {
      throw new HighlightModelError(error?.message ?? "ID_TOKEN_FAILED", error?.retryable !== false);
    });
    headers["X-Serverless-Authorization"] = `Bearer ${token}`;
  }
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: compared }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  // Google refused the token: drop it so the next attempt mints a fresh one.
  if (response.status === 401 && config.identity) forgetServiceIdentityToken();
  if (!response.ok) throw new HighlightModelError(`HTTP_${response.status}`, response.status === 429 || response.status >= 500);
  const body = (await response.json()) as { ranges?: unknown; modelVersion?: unknown };
  // A local development sidecar names no version; a service that names one must be the model this deployment expects.
  if (body.modelVersion !== undefined && body.modelVersion !== config.modelVersion) throw new HighlightModelError("MODEL_VERSION_MISMATCH", false);
  if (!Array.isArray(body.ranges)) throw new HighlightModelError("BAD_RESPONSE", true);
  return sanitizePredictedRanges(body.ranges, compared.length);
}
