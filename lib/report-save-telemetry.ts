/**
 * POST /api/reports rejection telemetry — server-side, structured,
 * privacy-allowlisted, mirroring the same pattern already established and
 * Production-proven by lib/selective-corpus/shadow-telemetry.ts.
 *
 * PURPOSE: every intentional POST /api/reports rejection (rate limit,
 * transport-size guard, ownership conflict, quota, room conflict, or an
 * unexpected internal error) currently returns a response with no
 * server-side signal of WHY. This module builds and logs ONE small,
 * machine-queryable JSON event per rejection, so passive operational
 * monitoring (which rejection categories are firing, how often) is possible
 * from server logs alone — without ever inspecting or logging request,
 * report, or customer content.
 *
 * SCOPE: OBSERVATION ONLY. This module never computes a rejection reason
 * itself, never influences the response returned to the client, and never
 * reads request/report data — the caller (app/api/reports/route.ts) passes
 * in only the already-known, already-decided reason/status/authMode.
 *
 * PRIVACY: the event type is a closed, explicit allowlist — event, reason,
 * status, and an optional authMode enum. There is no arbitrary metadata bag,
 * no object spread from request/response/result data, and the type itself
 * structurally prevents passing manuscript/extracted text, matched passages,
 * report title, filename, URL, source ids, device key/passport, IP address,
 * account/user id, room number, report id, request body, payload fragments,
 * hashes/fingerprints, or any raw error message/stack/name/code.
 */

export type ReportSaveRejectionReason =
  | "IP_RATE_LIMIT"
  | "RAW_CONTENT_LENGTH"
  | "MALFORMED_REQUEST"
  | "CLIENT_PAYLOAD_TOO_LARGE"
  | "OWNERSHIP_CONFLICT"
  | "DAILY_UPLOAD_QUOTA"
  | "REFERENCE_TRANSPORT_BUDGET"
  | "PERSISTED_PAYLOAD_TOO_LARGE"
  | "ROOM_OCCUPIED"
  | "INTERNAL_ERROR";

export type ReportSaveAuthMode = "anonymous" | "authenticated";

/**
 * The COMPLETE, closed shape of a report_save_rejected event — nothing may
 * be added here beyond these four fields. `authMode` is optional: omitted
 * whenever the caller has not naturally resolved session state by the time
 * the rejection fires (see this module's own call sites' comments), never
 * fabricated or defaulted.
 */
export type ReportSaveRejectedTelemetryEvent = {
  event: "report_save_rejected";
  reason: ReportSaveRejectionReason;
  status: number;
  authMode?: ReportSaveAuthMode;
};

export type BuildReportSaveRejectedTelemetryEventParams = {
  reason: ReportSaveRejectionReason;
  status: number;
  authMode?: ReportSaveAuthMode;
};

/**
 * Pure formatter: given the already-decided reason/status/(optional)
 * authMode, returns the exact closed event shape. Never invents a value,
 * never reads any external state, never spreads an arbitrary object.
 */
export function buildReportSaveRejectedTelemetryEvent(
  params: BuildReportSaveRejectedTelemetryEventParams,
): ReportSaveRejectedTelemetryEvent {
  const event: ReportSaveRejectedTelemetryEvent = {
    event: "report_save_rejected",
    reason: params.reason,
    status: params.status,
  };
  if (params.authMode !== undefined) event.authMode = params.authMode;
  return event;
}

/**
 * Emits exactly one structured log line per call. INTERNAL_ERROR (the only
 * category that represents genuine server malfunction rather than an
 * expected client/business rejection) logs at `error`; every other,
 * intentional rejection reason logs at `warn` — matching this codebase's own
 * established shadow-telemetry log-level convention
 * (lib/selective-corpus/shadow-telemetry.ts).
 *
 * BEST-EFFORT: this function never throws. Formatting a plain, small,
 * allowlisted object and calling console.warn/error is not expected to
 * fail, but the whole body is wrapped in a try/catch anyway so a
 * telemetry-layer failure can never be mistaken for — or interrupt — the
 * real request/response flow in app/api/reports/route.ts. A failure here is
 * silently ignored, never re-logged, never surfaced to the caller.
 */
export function logReportSaveRejectedTelemetry(params: BuildReportSaveRejectedTelemetryEventParams): void {
  try {
    const line = JSON.stringify(buildReportSaveRejectedTelemetryEvent(params));
    if (params.reason === "INTERNAL_ERROR") {
      console.error(line);
    } else {
      console.warn(line);
    }
  } catch {
    // Best-effort only — see the doc comment above. Never rethrow.
  }
}
