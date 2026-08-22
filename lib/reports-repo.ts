import type { Client } from "@libsql/client";
import { isWithinActiveCycle, roomCycleEndsAt } from "./report-rooms";
import type { ReportSummary } from "./reports-remote";

// device_key added in Phase E8C, additively — every existing caller that
// only read payload_json is unaffected; lib/report-historical-match.ts is
// the first caller that needs it, to key a report's historical-match
// snapshot on saved_reports' own composite primary key (device_key, id)
// rather than id alone (see db/schema.ts's own comment on
// report_historical_match_snapshots for why id alone is not safe to key on).
type ReportRow = { payload_json: string; device_key: string };

// id is only unique per device_key at the schema level (composite PK), not
// globally, so an account with two devices could in theory produce the same
// client-generated (timestamp-based) id twice. ORDER BY updated_at DESC
// resolves that deterministically instead of returning an arbitrary row.
export async function findReportRowForUser(client: Client, id: string, userId: string): Promise<ReportRow | undefined> {
  const result = await client.execute({
    sql: "SELECT payload_json, device_key FROM saved_reports WHERE id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1",
    args: [id, userId],
  });
  return result.rows[0] as unknown as ReportRow | undefined;
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
  | { status: "processing" | "ready"; report: ReportSummary; cycleEndsAt: string };

/**
 * The single source of truth for "what does room N currently hold," shared
 * by app/api/reports/route.ts's GET ?room=N handler and
 * app/reports/rooms/[room]/page.tsx's Server Component — both need the
 * exact same empty/processing/ready derivation (see lib/report-rooms.ts's
 * own header comment for what each status means), so it lives here once
 * rather than as two hand-kept-in-sync copies of the same SQL.
 */
export async function findRoomOccupant(client: Client, userId: string, room: number): Promise<RoomOccupantResult> {
  const result = await client.execute({
    sql: `SELECT id, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone
          FROM saved_reports WHERE user_id = ? AND room_number = ?
          ORDER BY report_created_at DESC LIMIT 1`,
    args: [userId, room],
  });
  const occupant = result.rows[0] as unknown as
    | { id: string | number; submission_id: string; title: string; report_created_at: string; word_count: number; archive_score: number; score_band: string; ai_score: number | null; ai_tone: string | null }
    | undefined;
  if (!occupant || !isWithinActiveCycle(occupant.report_created_at)) {
    return { status: "empty", report: null, cycleEndsAt: null };
  }
  return {
    status: occupant.ai_score === null ? "processing" : "ready",
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
