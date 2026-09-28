/**
 * A minimal COMPLETE AI analysis, for fixtures that save a report through POST /api/reports with ai_status 'ready'.
 *
 * ai_status 'ready' means the AI analysis is COMPLETE (lib/report-rooms.ts deriveRoomStatus settles the room on it, with or
 * without a score), so POST /api/reports refuses an explicit 'ready' whose payload carries no complete `aiAnalysis` — exactly
 * as the AI-result route always has. Every product writer sends one; a fixture whose subject is something else (similarity,
 * corpus, references, …) and only needs a ready report attaches this. No passages and no score: nothing about similarity
 * reads it, and it never calibrates to a display number (no scoringVersion / medianLogOdds), so the flat ai_score columns
 * stay the only AI number, exactly as before. A fresh object on every call.
 */
export function completeAiAnalysis() {
  return { status: "complete", score: null, model: "fixture-model", engine: null, threshold: 0.7, eligibleWordCount: 0, analyzedWordCount: 0, passages: [] };
}
