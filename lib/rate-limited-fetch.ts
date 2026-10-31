/**
 * RATE-LIMIT RETRY (client, Rule A reliability check 2026-10-25). A legitimate pipeline request — check authorization,
 * academic evidence, archive match, report save, AI-result save, AI retry, document layout — that meets the per-IP request
 * limiter's 429 now waits the server's Retry-After and sends the SAME request again, instead of reporting the step as failed
 * (academic evidence "FAILED", a report stuck "Still processing", a source shown as unavailable).
 *
 * Only the limiter's own 429 is retried (`{ error: "Too many requests" }` with Retry-After) — never the daily upload quota (its
 * body carries `resetsAt`), never any other status. The server still enforces every limit; this only spaces the same request
 * out, so nothing is charged twice: a rate-limited request was refused before the route did anything (no room, no quota, no
 * authorization consumed), and the retry carries the same report id, room and authorization. Bounded: at most
 * RATE_LIMIT_RETRIES retries and RATE_LIMIT_MAX_TOTAL_WAIT_MS of waiting; an abort signal stops the wait.
 */
export const RATE_LIMIT_RETRIES = 4;
export const RATE_LIMIT_MAX_WAIT_MS = 65_000;
export const RATE_LIMIT_MAX_TOTAL_WAIT_MS = 180_000;

/** The per-IP limiter's refusal (retryable), as opposed to the daily upload quota's 429 (carries resetsAt; never retried). */
export async function isRequestRateLimited(response: Response): Promise<boolean> {
  if (response?.status !== 429) return false;
  const body = (typeof response.clone === "function" ? await response.clone().json().catch(() => null) : null) as { resetsAt?: unknown } | null;
  return !(body && typeof body === "object" && typeof body.resetsAt === "string");
}

/** The wait the server asked for (Retry-After seconds; 5 s when absent), plus a little jitter, capped. */
export function rateLimitWaitMs(response: Response, jitter: () => number = Math.random): number {
  const v = Number(response.headers?.get?.("Retry-After"));
  const seconds = Number.isFinite(v) && v > 0 ? v : 5;
  return Math.min(RATE_LIMIT_MAX_WAIT_MS, Math.round(seconds * 1000 + jitter() * 750));
}

const abortableSleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export type RateLimitRetryOptions = {
  retries?: number;
  maxTotalWaitMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  onWait?: (ms: number, retry: number) => void;
};

/** fetch(), retried only on the per-IP limiter's 429. The body must be re-sendable (string / FormData / Blob), as every caller's is. */
export async function fetchWithRateLimitRetry(input: RequestInfo | URL, init: RequestInit = {}, options: RateLimitRetryOptions = {}): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch, sleep = options.sleep ?? abortableSleep;
  const retries = options.retries ?? RATE_LIMIT_RETRIES, maxTotal = options.maxTotalWaitMs ?? RATE_LIMIT_MAX_TOTAL_WAIT_MS;
  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    const response = await doFetch(input, init);
    if (attempt >= retries || !(await isRequestRateLimited(response))) return response;
    const ms = rateLimitWaitMs(response);
    if (waited + ms > maxTotal) return response;
    waited += ms;
    options.onWait?.(ms, attempt + 1);
    console.debug("Request rate-limited; retrying after the server's Retry-After.", { waitMs: ms, retry: attempt + 1 });
    await sleep(ms, init.signal);
  }
}
