/**
 * A report's creation time is the SERVER's clock at its first save (app/api/reports/route.ts): a save request cannot
 * set it. A test that needs a report of a particular age therefore gets one in one of the two ways a report can really
 * come to have that age — never by sending a `createdAt` through the save route.
 *
 *   atServerTime(when, fn)       the server clock itself: `fn` runs with Date.now() fixed at `when`, so a report first
 *                                saved inside it is created at that moment, row and payload alike. Only Date.now() is
 *                                replaced (the route reads it); timers and SQLite's own clock are untouched.
 *   setReportCreatedAt(...)      time passing for a report that already exists: sets the stored creation time, and the
 *                                copy of it in the stored report, directly in the database.
 */

/** Runs `fn` with the server clock (Date.now) fixed at `when` (a Date, an ISO string or epoch ms); restores it afterwards. */
export async function atServerTime(when, fn) {
  const fixed = when instanceof Date ? when.getTime() : typeof when === 'string' ? Date.parse(when) : Number(when);
  if (!Number.isFinite(fixed)) throw new Error(`atServerTime: not a time: ${String(when)}`);
  const realNow = Date.now;
  Date.now = () => fixed;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/**
 * Sets when an existing report was created — the row's lifecycle clock and the copy inside its stored payload — as if
 * that much time had passed. `client` is a libsql client (or transaction) on the reports database.
 */
export async function setReportCreatedAt(client, { deviceKey, id }, createdAtIso) {
  const result = await client.execute({
    sql: `UPDATE saved_reports
          SET report_created_at = ?,
              payload_json = CASE WHEN json_valid(payload_json) THEN json_set(payload_json, '$.created', ?) ELSE payload_json END
          WHERE device_key = ? AND id = ?`,
    args: [createdAtIso, createdAtIso, deviceKey, String(id)],
  });
  if (Number(result.rowsAffected) !== 1) throw new Error(`setReportCreatedAt: no report ${String(id)} for that device key`);
}
