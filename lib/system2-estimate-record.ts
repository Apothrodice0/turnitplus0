/**
 * A report's System 2 estimate as the server keeps it (no imports, so lib/report-types.ts and lib/system2-unified.ts
 * can both use it without an import cycle).
 *
 * The ONE stored copy lives in the report's own payload at `$.system2Estimate`:
 *   - written only by app/api/reports/[id]/system2, after an accepted estimate (estimate shown, integer 0–20) of the
 *     report's own document, for an eligible account (lib/system2-access.ts) — never from a browser: app/api/reports
 *     strips any client-sent copy; at most once per report;
 *   - written in place with json_set, and carried across every resave by SAVE_REPORT_SQL, so the AI-result save and the
 *     estimate can land in either order without one overwriting the other;
 *   - read by every view of the report (room tile, report page, receipt), so the one similarity percentage is the same
 *     on any device or session. A report without it (an ineligible account or file, any failure) keeps System 1's result.
 */

export const SYSTEM2_ESTIMATE_PAYLOAD_KEY = "system2Estimate";

export type System2EstimateRecord = {
  state: string;
  estimate_shown: boolean;
  final_text: string;
  conservative_estimate_percent?: number;
  warnings?: string[];
};

/** The stored form: only what the unified percentage needs, plus when it was accepted. */
export type StoredSystem2Estimate = {
  state: string;
  estimate_shown: true;
  final_text: "";
  conservative_estimate_percent: number;
  recordedAt: string;
};

export function usableSystem2Percent(estimate: System2EstimateRecord | null | undefined): number | null {
  if (!estimate || typeof estimate !== "object" || estimate.estimate_shown !== true) return null;
  const p = estimate.conservative_estimate_percent;
  return typeof p === "number" && Number.isInteger(p) && p >= 0 && p <= 20 ? p : null;
}

/** The record to store for an inference result, or null when the result is not an accepted estimate. */
export function acceptedSystem2Estimate(result: System2EstimateRecord | null | undefined, recordedAt: string): StoredSystem2Estimate | null {
  const percent = usableSystem2Percent(result);
  if (percent === null || !result) return null;
  return { state: String(result.state), estimate_shown: true, final_text: "", conservative_estimate_percent: percent, recordedAt };
}

/** The report's stored estimate when it is a usable one, else null. */
export function storedSystem2Estimate(report: unknown): System2EstimateRecord | null {
  if (!report || typeof report !== "object") return null;
  const value = (report as Record<string, unknown>)[SYSTEM2_ESTIMATE_PAYLOAD_KEY] as System2EstimateRecord | undefined;
  return usableSystem2Percent(value) === null ? null : (value as System2EstimateRecord);
}

/** A client payload with any `system2Estimate` removed (the server is the only writer). Returns the same object. */
export function withoutClientSystem2Estimate<T>(payload: T): T {
  if (payload && typeof payload === "object" && SYSTEM2_ESTIMATE_PAYLOAD_KEY in (payload as object)) {
    delete (payload as Record<string, unknown>)[SYSTEM2_ESTIMATE_PAYLOAD_KEY];
  }
  return payload;
}

/** The summary field for a stored estimate (from a row's json_extract text or a parsed report value); {} when none. */
export function system2EstimateField(raw: unknown): { system2EstimatePercent?: number } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  const percent = usableSystem2Percent(value as System2EstimateRecord | null);
  return percent === null ? {} : { system2EstimatePercent: percent };
}

/**
 * The ONE write of a stored estimate (app/api/reports/[id]/system2): in place on the owner's own row, args
 * [JSON.stringify(stored), deviceKey, id, userId], and only while the report has none — one estimate per report, so two
 * concurrent requests can never both store, and an accepted estimate is never replaced. Exported so tests run this exact text.
 */
export const PERSIST_SYSTEM2_ESTIMATE_SQL = `UPDATE saved_reports SET payload_json = json_set(payload_json, '$.${SYSTEM2_ESTIMATE_PAYLOAD_KEY}', json(?))
            WHERE device_key = ? AND id = ? AND user_id = ? AND json_valid(payload_json)
              AND json_type(payload_json, '$.${SYSTEM2_ESTIMATE_PAYLOAD_KEY}') IS NULL`;
