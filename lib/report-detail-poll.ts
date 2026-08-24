/**
 * Release-hardening audit finding LIFECYCLE-06 (corrected, then extended):
 * the reveal decision and the bounded-poll engine
 * app/reports/[id]/report-detail-shell.tsx uses, pulled out into plain,
 * React-free functions so they can be proven behaviorally (real async
 * ordering, real — or node:test's mocked — timers) rather than only by
 * asserting on the component's source text. report-detail-shell.tsx
 * imports and calls these directly; it does not reimplement the same logic
 * inline, so tests against this file are tests of the component's actual
 * behavior, not a parallel description of it.
 *
 * CORRECTION (this file's original reason for existing): an earlier
 * version of this reveal gate let exhausting the poll budget on its own
 * promote a still-pending similarity result to "Unavailable" and unblock
 * the reveal. That was wrong: the ~30-second client poll budget is a
 * client-side politeness limit on how long THIS TAB automatically
 * re-checks — it is not, and must never be treated as, information about
 * whether the underlying AI-writing or similarity pipeline itself has
 * reached a real terminal state. A pipeline that is still genuinely
 * processing when the client stops polling is still genuinely processing;
 * giving up on asking does not change what actually happened server-side.
 * pollExhausted therefore can only ever route a not-yet-bothReady state to
 * "still-processing" instead of "loading" (Still processing + Retry
 * analysis) — it can never itself produce "revealed", and it never touches
 * aiUnavailable/similarityUnavailable below. Retry analysis starts a
 * genuinely fresh bounded cycle (a new startBoundedPoll call, with its own
 * fresh attempts counter) — it never resumes a stale count.
 *
 * EXTENSION (this file's second reason for existing): the first version of
 * this correction investigated whether the similarity lifecycle has ANY
 * genuine terminal-failure representation and found none reachable from
 * PersistedSimilarityDisplay at the time — isSimilarityTerminal had
 * exactly one true branch ("resolved"). Re-inspected properly: the ONE
 * real, persisted, poll-independent terminal-failure signal that DOES
 * exist is lib/report-primary-similarity.ts's resolvePrimarySimilaritySummary
 * itself failing — specifically its OWN inner try/catch around
 * computeUnifiedSimilarity, which is a genuine, reproducible
 * overall-computation failure for a report's own data (see that function's
 * own `failed` field). This is DISTINCT from a fail-soft individual-source
 * issue: ReportHistoricalSubmissionMatch reaching its own real, persisted
 * "FAILED"/"UNAVAILABLE" status (lib/report-historical-match.ts's
 * getOrComputeHistoricalMatchSnapshot, itself never throwing) does NOT set
 * `failed` — lib/unified-similarity.ts's computeUnifiedSimilarity only
 * ever special-cases historicalSubmissionMatch.status === "MATCHED" (see
 * its own sole status check); any other status, "UNAVAILABLE" included,
 * simply contributes zero historical words to an otherwise still-
 * successful computation from whatever archive/academic evidence IS
 * available. So a historical-match failure alone can never make the
 * OVERALL similarity terminally failed — only a genuine
 * computeUnifiedSimilarity throw can, and when it does,
 * resolvePrimarySimilaritySummary's callers now persist it explicitly
 * (unifiedSimilarityFailed: true) rather than silently leaving the report
 * indistinguishable from "never attempted." DetailSimilarityStatus's
 * "failed" value carries that real, persisted signal through to this
 * gate — isSimilarityTerminal treats it as terminal, and
 * computeDetailRevealState's similarityUnavailable mirrors aiUnavailable
 * exactly, both reflecting genuine pipeline state, never poll timing.
 *
 * The contract:
 *   - bothReady (both genuinely, independently terminal — "resolved" or
 *     "failed" for similarity; "ready" or "failed" for AI) is the ONLY way
 *     to reveal the report. Exhausting the poll budget can never
 *     substitute for it.
 *   - Exhausting the budget while not bothReady stops automatic polling and
 *     shows "still-processing" — never a reveal, never a synthesized
 *     Unavailable for whichever side never answered.
 */

export type DetailAiStatus = "processing" | "ready" | "failed" | null;
export type DetailSimilarityStatus = "resolved" | "stale" | "pending" | "failed";

/** Matches room-page-shell.tsx's own POLL_INTERVAL_MS/MAX_POLL_ATTEMPTS — "the existing ~30-second budget" this feature was asked to reuse. */
export const DETAIL_POLL_INTERVAL_MS = 3000;
export const DETAIL_MAX_POLL_ATTEMPTS = 10;

/** null (the anonymous/device-key path, which has no server-computed ai_status) counts as terminal — see report-detail-shell.tsx's own comment on why that path never has a genuine "still processing" window. "failed" is a real, persisted, poll-independent terminal state. */
export function isAiTerminal(aiStatus: DetailAiStatus): boolean {
  return aiStatus === null || aiStatus === "ready" || aiStatus === "failed";
}

/**
 * "resolved" and "failed" are the two terminal similarity states — see
 * this file's own header comment (EXTENSION) for exactly what makes
 * "failed" genuine (a real, persisted computeUnifiedSimilarity throw, not
 * a fail-soft individual-source issue) and why "stale"/"pending" are
 * never treated as terminal no matter how long they persist: both remain
 * eligible to resolve on the very next real check (a fresh generation, a
 * fresh flag read, or write-time finalization simply finishing/succeeding
 * this time), and nothing in the actual similarity pipeline ever marks
 * them as permanently unable to.
 */
export function isSimilarityTerminal(similarityStatus: DetailSimilarityStatus): boolean {
  return similarityStatus === "resolved" || similarityStatus === "failed";
}

export type DetailRevealState =
  | { screen: "loading" }
  | { screen: "still-processing" }
  | { screen: "revealed"; aiUnavailable: boolean; similarityUnavailable: boolean };

/**
 * The one combined reveal decision report-detail-shell.tsx renders from.
 * pollExhausted can only ever route a not-yet-bothReady state to
 * "still-processing" instead of "loading" — it can never itself produce
 * "revealed", and it never touches aiUnavailable/similarityUnavailable
 * (both reflect real, independently-persisted terminal-failure signals —
 * ai_status "failed", or unifiedSimilarityFailed — never the poll timing).
 */
export function computeDetailRevealState(params: {
  aiStatus: DetailAiStatus;
  similarityStatus: DetailSimilarityStatus;
  pollExhausted: boolean;
}): DetailRevealState {
  const bothReady = isAiTerminal(params.aiStatus) && isSimilarityTerminal(params.similarityStatus);
  if (bothReady) {
    return { screen: "revealed", aiUnavailable: params.aiStatus === "failed", similarityUnavailable: params.similarityStatus === "failed" };
  }
  if (params.pollExhausted) {
    return { screen: "still-processing" };
  }
  return { screen: "loading" };
}

export type BoundedPollHandle = { cancel: () => void };

/**
 * The bounded polling engine, decoupled from React state so it can be
 * driven by real (or node:test mock.timers-faked) setTimeout/clearTimeout
 * in tests without mounting a component. `attempt` resolves true once the
 * caller's own terminal condition (bothReady) is reached, false while
 * still inconclusive; onExhausted fires exactly once, only when the
 * attempt budget runs out without ever resolving true, and no further
 * attempt is scheduled after either outcome. cancel() (called from the
 * owning effect's cleanup) stops any in-flight continuation from
 * scheduling another attempt and clears any pending timer — the combination
 * required so neither an in-flight fetch's own .then nor an already-queued
 * setTimeout can act after the caller has moved on (unmount, or bothReady/
 * pollExhausted flipping and the effect re-running).
 */
export function startBoundedPoll(params: {
  attempt: () => Promise<boolean>;
  onExhausted: () => void;
  intervalMs?: number;
  maxAttempts?: number;
}): BoundedPollHandle {
  const intervalMs = params.intervalMs ?? DETAIL_POLL_INTERVAL_MS;
  const maxAttempts = params.maxAttempts ?? DETAIL_MAX_POLL_ATTEMPTS;
  let cancelled = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function loop() {
    attempts += 1;
    const terminal = await params.attempt();
    if (cancelled || terminal) return;
    if (attempts >= maxAttempts) {
      params.onExhausted();
      return;
    }
    timer = setTimeout(loop, intervalMs);
  }
  void loop();

  return {
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}
