import { AI_SCORING_VERSION, calibratedAiDisplaySignal } from "./ai-core";

/**
 * The ONE authoritative interpreter of a report's AI-writing result for
 * display. Every surface — the room card, the My Reports list row, the
 * report detail page, and the downloadable report — must resolve the AI
 * state through this function so they can never disagree the way the
 * production bug this fixes made them: a room card showing "0% AI" next to
 * a detail page showing "AI report pending" for the same report
 * (report id 1787833395119 on Preview).
 *
 * Why that happened: two independent signals are persisted for one report.
 *
 *  1. The flat saved_reports.ai_status / ai_score / ai_tone columns —
 *     written atomically by app/reports/rooms/[room]/room-page-shell.tsx's
 *     saveEnrichedAiResult at the moment analysis finishes. ai_status is set
 *     to 'ready' ONLY when AiAnalysis.status came back "complete", and
 *     ai_score is the calibrated display value (aiSignalDisplay's own value)
 *     frozen at that instant — NOT the raw human-reference percentile that
 *     SimilarityReport.aiScore carries.
 *
 *  2. saved_reports.payload_json.aiAnalysis — the full passage-level detail.
 *     This can legitimately LAG the columns above: app/api/reports/route.ts's
 *     SAVE_REPORT_SQL guards payload_json against a stale-generation
 *     overwrite, so if the AI-enrichment resave's write-time similarity
 *     finalization hits its transient-failure path, the incoming payload
 *     (carrying the fresh aiAnalysis) is rejected while the ai_* columns —
 *     which are separate args, not subject to that guard — still update.
 *     The row is then left with ai_status='ready' + ai_score=0 and a
 *     payload_json that has no aiAnalysis at all.
 *
 * The room/list only ever had signal (1), so they showed "0%" correctly.
 * The detail page rendered its AI headline purely from aiSignalDisplay(
 * payload.aiAnalysis) — signal (2) — which, with aiAnalysis absent, returns
 * "AI report pending". This resolver makes the flat columns the
 * authoritative source of the AI lifecycle state and headline score, and
 * treats payload.aiAnalysis as supplementary detail that refines but never
 * contradicts them.
 *
 * PRODUCT RULE (see the task brief): a missing / null / undefined AI result
 * must NEVER render as 0%. 0% is valid ONLY when analysis is known to have
 * completed (ai_status 'ready', or a legacy row's own ai_score-only rule, or
 * a current-version in-payload "complete" analysis) AND the authoritative
 * number is genuinely zero. Completion is never inferred from score === 0.
 */

export type AiDisplayState = "pending" | "complete" | "failed" | "not_eligible";

export type AiDisplayTone = "low" | "review" | "high" | "unavailable";

export type AiDisplayResolution = {
  state: AiDisplayState;
  /** Non-null ONLY when state === "complete" and a genuine authoritative number exists. Never a fabricated 0. */
  score: number | null;
  tone: AiDisplayTone;
};

/** The subset of lib/report-types.ts's AiAnalysis this resolver reads — kept structural so this file never imports report-types (which imports ai-core, which this file also imports). */
export type AiAnalysisForDisplay = {
  status: "complete" | "unsupported" | "error";
  scoringVersion?: number;
  medianLogOdds?: number | null;
  error?: string;
};

export type AiDisplayInput = {
  /** persisted saved_reports.ai_status — the authoritative AI-lifecycle column. null for a legacy row predating it, or an anonymous/device-key report. */
  aiStatus?: "processing" | "ready" | "failed" | null;
  /** persisted saved_reports.ai_score — the calibrated display value frozen when analysis completed. NOT SimilarityReport.aiScore (the raw percentile). */
  aiScore?: number | null;
  /** persisted saved_reports.ai_tone. */
  aiTone?: string | null;
  /** the in-payload analysis detail, when the caller has the full report. May be absent or stale-versioned relative to the columns above. */
  aiAnalysis?: AiAnalysisForDisplay | null;
};

/** Mirrors aiSignalDisplay's own value -> tone thresholds exactly. */
export function aiToneFromScore(score: number): AiDisplayTone {
  if (score < 20) return "low";
  if (score <= 50) return "review";
  return "high";
}

function normalizeTone(tone: string | null | undefined, score: number | null): AiDisplayTone {
  if (tone === "low" || tone === "review" || tone === "high" || tone === "unavailable") return tone;
  return score === null ? "unavailable" : aiToneFromScore(score);
}

export function resolveAiDisplayState(input: AiDisplayInput): AiDisplayResolution {
  const { aiStatus = null, aiScore = null, aiTone = null, aiAnalysis = null } = input;

  // 1. Not eligible — analysis ran but the document did not qualify (too few
  //    eligible English words). Only ever distinguishable from the in-payload
  //    analysis: the flat ai_status column collapses it into 'failed' (see
  //    room-page-shell.tsx's saveEnrichedAiResult), so without aiAnalysis a
  //    caller can only surface it as the more generic "failed".
  if (aiAnalysis?.status === "unsupported") {
    return { state: "not_eligible", score: null, tone: "unavailable" };
  }

  // 2. Failed — a genuine, persisted terminal failure. ai_status is the
  //    durable signal (survives a reload / different device); aiAnalysis
  //    "error" is the in-payload equivalent.
  if (aiStatus === "failed" || aiAnalysis?.status === "error") {
    return { state: "failed", score: null, tone: "unavailable" };
  }

  // 3. Rich path — a current-version, calibratable in-payload analysis is the
  //    most precise source when it is actually present. A stale scoringVersion
  //    or a missing medianLogOdds falls through to the flat columns rather
  //    than being treated as "pending" while the room shows a number.
  const richSignal =
    aiAnalysis?.status === "complete" &&
    aiAnalysis.scoringVersion === AI_SCORING_VERSION &&
    typeof aiAnalysis.medianLogOdds === "number"
      ? calibratedAiDisplaySignal(aiAnalysis.medianLogOdds)
      : null;
  if (richSignal) {
    return { state: "complete", score: richSignal.score, tone: normalizeTone(aiTone, richSignal.score) };
  }

  // 4. Authoritative completion from the flat columns — aiAnalysis is absent
  //    or stale, but ai_status === 'ready' is written ONLY on a genuine
  //    "complete" analysis, and ai_score is the calibrated value it froze.
  //    Completion is read here from ai_status, never inferred from the score.
  if (aiStatus === "ready") {
    if (typeof aiScore === "number" && Number.isFinite(aiScore)) {
      return { state: "complete", score: aiScore, tone: normalizeTone(aiTone, aiScore) };
    }
    // Completed, but no authoritative number was ever produced (the document
    // median could not be calibrated). Not 0%, not a hard failure — surfaced
    // as pending so a re-run is offered.
    return { state: "pending", score: null, tone: "unavailable" };
  }

  // 5. Legacy rows predate the ai_status column (null). Fall back to the
  //    original ai_score-only rule — the exact same one deriveRoomStatus
  //    still applies for this case: a persisted numeric score means the
  //    analysis finished.
  if (aiStatus == null && typeof aiScore === "number" && Number.isFinite(aiScore)) {
    return { state: "complete", score: aiScore, tone: normalizeTone(aiTone, aiScore) };
  }

  // 6. Everything else — still processing, or nothing persisted yet. Never 0%.
  return { state: "pending", score: null, tone: "unavailable" };
}
