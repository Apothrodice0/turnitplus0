import type { Client } from "@libsql/client";
import { deriveRoomStatus, isWithinActiveCycle, roomCycleEndsAt } from "./report-rooms";
import { resolvePersistedSimilarityDisplay } from "./report-primary-similarity";
import type { ReportSummary } from "./reports-remote";

// device_key added in Phase E8C, additively — every existing caller that
// only read payload_json is unaffected; lib/report-historical-match.ts is
// the first caller that needs it, to key a report's historical-match
// snapshot on saved_reports' own composite primary key (device_key, id)
// rather than id alone (see db/schema.ts's own comment on
// report_historical_match_snapshots for why id alone is not safe to key on).
//
type ReportRow = { payload_json: string; device_key: string };

/**
 * Adds the three flattened AI-lifecycle columns to ReportRow (production
 * bug fix): a direct visit to a report's own URL
 * (app/reports/[id]/page.tsx) while its AI check is still "processing" had
 * no way to know that — the saved payload_json itself has no top-level
 * AI-lifecycle status field (only the lightweight room-summary shape
 * does), so the page could only infer "pending" from an absent
 * aiAnalysis, indistinguishable from a report that will simply never be
 * analyzed. These three columns let the page derive the same real status
 * (lib/report-rooms.ts's deriveRoomStatus) the room page already uses,
 * instead of guessing. Scoped to findReportRowForUser only (the
 * authenticated, room-owning path this fix is about) rather than widening
 * ReportRow itself — findReportRowForDeviceKey's anonymous callers don't
 * need it and its own query doesn't select these columns.
 */
type ReportRowWithAiStatus = ReportRow & { ai_score: number | null; ai_tone: string | null; ai_status: string | null };

// id is only unique per device_key at the schema level (composite PK), not
// globally, so an account with two devices could in theory produce the same
// client-generated (timestamp-based) id twice. ORDER BY updated_at DESC
// resolves that deterministically instead of returning an arbitrary row.
export async function findReportRowForUser(client: Client, id: string, userId: string): Promise<ReportRowWithAiStatus | undefined> {
  const result = await client.execute({
    sql: "SELECT payload_json, device_key, ai_score, ai_tone, ai_status FROM saved_reports WHERE id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1",
    args: [id, userId],
  });
  const row = result.rows[0] as unknown as
    | { payload_json: string; device_key: string; ai_score: number | bigint | null; ai_tone: string | null; ai_status: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    payload_json: row.payload_json,
    device_key: row.device_key,
    ai_score: row.ai_score === null ? null : Number(row.ai_score),
    ai_tone: row.ai_tone,
    ai_status: row.ai_status,
  };
}

// A report already claimed by an account (user_id set) is permanently
// invisible to device-key lookups, by design — see claimAnonymousReports.
export async function findReportRowForDeviceKey(client: Client, id: string, deviceKey: string): Promise<ReportRow | undefined> {
  const result = await client.execute({
    sql: "SELECT payload_json, device_key FROM saved_reports WHERE device_key = ? AND id = ? AND user_id IS NULL",
    args: [deviceKey, id],
  });
  return result.rows[0] as unknown as ReportRow | undefined;
}

export type RoomOccupantResult =
  | { status: "empty"; report: null; cycleEndsAt: null }
  | { status: "processing" | "ready" | "failed"; report: ReportSummary; cycleEndsAt: string };

/**
 * The single source of truth for "what does room N currently hold," shared
 * by app/api/reports/route.ts's GET ?room=N handler and
 * app/reports/rooms/[room]/page.tsx's Server Component — both need the
 * exact same empty/processing/ready/failed derivation (see
 * lib/report-rooms.ts's own header comment for what each status means), so
 * it lives here once rather than as two hand-kept-in-sync copies of the
 * same SQL.
 */
/**
 * Release-hardening audit finding SIM-03, corrected by SIM-04: a cheap
 * read — never calls getOrComputeHistoricalMatchSnapshot, never risks
 * running the expensive matcher. json_extract pulls the persisted result's
 * three scalars straight out of payload_json without the application ever
 * parsing (or transferring) the rest of that blob — the genuinely cheap
 * read this function's own callers require: app/api/reports/route.ts's GET
 * ?room=N handler is polled every few seconds while a room is "processing",
 * and app/reports/rooms/[room]/page.tsx calls this for the same reason
 * app/reports/[id]/page.tsx's own comment gives for staying fast/unenriched.
 *
 * SIM-04 correction: the FIRST version of this read trusted
 * payload_json.unifiedSimilarity verbatim — a real gap, caught before
 * commit, not a shipped regression: a stale corpus_match_generation (a
 * later promotion/deactivation) or a CORPUS_SOURCE_MATCHING_ENABLED
 * rollback since this report's own write-time finalization would never be
 * reflected here, permanently, since nothing about a json_extract read
 * could ever notice. resolvePersistedSimilarityDisplay (lib/report-primary-
 * similarity.ts) is "equivalent live filtering" to
 * lib/report-historical-match.ts's own applyCorpusSourceMatchingFlag,
 * reproduced at the display-decision level from only what a cheap read can
 * cheaply obtain — isHistoricalMatchSnapshotCurrent's own two SELECTs, no
 * different in kind from the ones this function's SQL already runs, and
 * still no matcher call of any kind.
 *
 * LIFECYCLE-03 correction: this display resolution now runs for every
 * non-empty occupant, not only "ready"/"failed" — see the inline comment at
 * its own call site for why "processing" (AI-wise) is not a reason to skip
 * it. Similarity and AI-writing detection are independent pipelines; a room
 * still mid-AI-analysis can have a fully finalized, immediately displayable
 * similarity result.
 */
export async function findRoomOccupant(client: Client, userId: string, room: number): Promise<RoomOccupantResult> {
  const result = await client.execute({
    sql: `SELECT id, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, ai_status, device_key,
                 json_extract(payload_json, '$.unifiedSimilarity.unifiedScore') AS unified_score,
                 json_extract(payload_json, '$.unifiedSimilarity') IS NOT NULL AS has_unified,
                 json_extract(payload_json, '$.corpusSourceMatchingEnabledAtComputation') AS corpus_flag_at_computation,
                 json_extract(payload_json, '$.unifiedSimilarityFailed') AS unified_failed
          FROM saved_reports WHERE user_id = ? AND room_number = ?
          ORDER BY report_created_at DESC LIMIT 1`,
    args: [userId, room],
  });
  const occupant = result.rows[0] as unknown as
    | {
      id: string | number; submission_id: string; title: string; report_created_at: string; word_count: number; archive_score: number;
      score_band: string; ai_score: number | null; ai_tone: string | null; ai_status: string | null; device_key: string;
      unified_score: number | bigint | null; has_unified: number | bigint; corpus_flag_at_computation: number | bigint | null;
      unified_failed: number | bigint | null;
    }
    | undefined;
  if (!occupant || !isWithinActiveCycle(occupant.report_created_at)) {
    return { status: "empty", report: null, cycleEndsAt: null };
  }

  const status = deriveRoomStatus(occupant.ai_score === null ? null : Number(occupant.ai_score), occupant.ai_status === null ? null : String(occupant.ai_status));
  const archiveScore = Number(occupant.archive_score);
  const hasUnifiedSimilarity = Number(occupant.has_unified) === 1;
  let primaryScore = archiveScore;
  let isUnified = false;
  let similarityStatus: "resolved" | "stale" | "pending" | "failed" = "pending";

  // Release-hardening audit finding LIFECYCLE-03: previously scoped to only
  // "ready"/"failed" — the reasoning was "a processing occupant shows no
  // numeric similarity at all," which was true under the OLD room-page-
  // shell.tsx design (the entire processing tile set, AI and Similarity
  // alike, was gated on ai_status). That coupling was itself the bug: write-
  // time finalization (app/api/reports/route.ts) can persist a fully
  // resolved unifiedSimilarity well before AI analysis finishes — AI and
  // similarity are genuinely independent pipelines — so a "processing"
  // occupant (AI-wise) can very much have a real, immediate similarity
  // result to show. resolvePersistedSimilarityDisplay is still the same
  // cheap json_extract-plus-two-SELECTs read no matter which status calls
  // it — there is no "processing-only" cost to avoid, only a
  // "empty" (no report at all) case, already returned above.
  {
    const display = await resolvePersistedSimilarityDisplay(client, {
      reportDeviceKey: occupant.device_key,
      reportId: String(occupant.id),
      archiveScore,
      unifiedScore: occupant.unified_score === null ? null : Number(occupant.unified_score),
      hasUnifiedSimilarity,
      corpusSourceMatchingEnabledAtComputation: occupant.corpus_flag_at_computation === null ? null : Number(occupant.corpus_flag_at_computation) === 1,
      unifiedSimilarityFailed: Number(occupant.unified_failed) === 1,
    });
    similarityStatus = display.status;
    // display.primaryScore/isUnified do not exist outside this branch — the
    // discriminated union itself is what prevents this call site from ever
    // reading a fallback number out of "stale"/"pending" and rendering it as
    // final; primaryScore/isUnified above simply keep their archive-only/
    // false defaults in that case, chosen explicitly right here, not
    // smuggled out of the resolver.
    if (display.status === "resolved") {
      primaryScore = display.primaryScore;
      isUnified = display.isUnified;
    }
  }

  return {
    status,
    cycleEndsAt: roomCycleEndsAt(occupant.report_created_at),
    report: {
      id: String(occupant.id),
      submissionId: String(occupant.submission_id),
      title: String(occupant.title),
      createdAt: String(occupant.report_created_at),
      wordCount: Number(occupant.word_count),
      archiveScore,
      primaryScore,
      isUnified,
      similarityStatus,
      scoreBand: String(occupant.score_band),
      aiScore: occupant.ai_score === null ? null : Number(occupant.ai_score),
      aiTone: occupant.ai_tone === null ? null : String(occupant.ai_tone),
    },
  };
}
