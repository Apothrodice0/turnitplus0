import type { Client } from "@libsql/client";
import { deriveRoomStatus, isWithinActiveCycle, roomCycleEndsAt } from "./report-rooms";
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
export async function findRoomOccupant(client: Client, userId: string, room: number): Promise<RoomOccupantResult> {
  const result = await client.execute({
    sql: `SELECT id, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, ai_status
          FROM saved_reports WHERE user_id = ? AND room_number = ?
          ORDER BY report_created_at DESC LIMIT 1`,
    args: [userId, room],
  });
  const occupant = result.rows[0] as unknown as
    | { id: string | number; submission_id: string; title: string; report_created_at: string; word_count: number; archive_score: number; score_band: string; ai_score: number | null; ai_tone: string | null; ai_status: string | null }
    | undefined;
  if (!occupant || !isWithinActiveCycle(occupant.report_created_at)) {
    return { status: "empty", report: null, cycleEndsAt: null };
  }
  return {
    status: deriveRoomStatus(occupant.ai_score === null ? null : Number(occupant.ai_score), occupant.ai_status === null ? null : String(occupant.ai_status)),
    cycleEndsAt: roomCycleEndsAt(occupant.report_created_at),
    report: {
      id: String(occupant.id),
      submissionId: String(occupant.submission_id),
      title: String(occupant.title),
      createdAt: String(occupant.report_created_at),
      wordCount: Number(occupant.word_count),
      archiveScore: Number(occupant.archive_score),
      scoreBand: String(occupant.score_band),
      aiScore: occupant.ai_score === null ? null : Number(occupant.ai_score),
      aiTone: occupant.ai_tone === null ? null : String(occupant.ai_tone),
    },
  };
}
