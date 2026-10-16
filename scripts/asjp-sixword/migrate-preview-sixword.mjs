// Preview-only migration asjp-sixword-0001 (developer six-word overlap table + delete trigger). PREPARED, NOT RUN
// REMOTELY: applying it changes the isolated ASJP Preview database and needs the owner's separate approval.
// Modes (cwd = the app checkout at the reviewed commit; node --import tsx <this> …):
//   (none)                         dry run: prints the plan and the SQL file's digest; opens no connection
//   --validate-local <file.db>     applies to a LOCAL file database (must already hold saved_reports) and validates the
//                                  exact schema; refuses any non-file URL
//   --apply --owner-approved       applies to PREVIEW_TURSO_DATABASE_URL, only if ALL hold: libsql/https URL; its host
//                                  contains ASJP_PREVIEW_DB_CONFIRM, which itself contains "preview"; the host does not
//                                  look like Production ("prod"); saved_reports exists (Stage A done); then validates
// Prints names, counts and PASS / FAIL only — never a URL credential or token.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
const store = await import(pathToFileURL(path.resolve("lib/asjp-sixword-report-store.ts")).href);
const sqlFile = path.resolve("migrations-preview/asjp-sixword-0001.sql");
const sqlText = readFileSync(sqlFile, "utf8");
const digest = createHash("sha256").update(sqlText.replace(/\r\n/g, "\n")).digest("hex");
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const plan = { migration: store.ASJP_SIXWORD_MIGRATION_ID, sqlSha256: digest, creates: [store.ASJP_SIXWORD_TABLE, store.ASJP_SIXWORD_TRIGGER], productionMigrationSetChanged: false };
async function run(client, label) {
  const hasReports = (await client.execute("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'saved_reports'")).rows[0].n;
  if (Number(hasReports) !== 1) { console.log(JSON.stringify({ ...plan, target: label, result: "REFUSED", reason: "NO_SAVED_REPORTS_TABLE (run the Phase 7 Stage A migration first)" })); process.exit(3); }
  const before = await store.sixwordSchemaProblem(client);
  await store.applySixwordMigration(client);
  const after = await store.sixwordSchemaProblem(client);
  const records = (await client.execute(`SELECT count(*) AS n FROM ${store.ASJP_SIXWORD_TABLE}`)).rows[0].n;
  console.log(JSON.stringify({ ...plan, target: label, before: before ?? "ALREADY_MIGRATED", after: after ?? "OK", records: Number(records), result: after ? "FAIL" : "PASS" }));
  process.exit(after ? 1 : 0);
}
const { createClient } = await import("@libsql/client");
if (process.argv.includes("--validate-local")) {
  const file = arg("--validate-local") ?? "";
  if (!file || /^[a-z]+:\/\//i.test(file)) { console.error("REFUSED: --validate-local takes a local file path"); process.exit(2); }
  await run(createClient({ url: `file:${path.resolve(file)}` }), "local-file");
} else if (process.argv.includes("--apply")) {
  if (!process.argv.includes("--owner-approved")) { console.error("REFUSED: --apply also needs --owner-approved (a remote database change)"); process.exit(2); }
  const url = process.env.PREVIEW_TURSO_DATABASE_URL ?? "", authToken = process.env.PREVIEW_TURSO_AUTH_TOKEN ?? "", confirm = process.env.ASJP_PREVIEW_DB_CONFIRM ?? "";
  let host = ""; try { host = new URL(url.replace(/^libsql:/, "https:")).host.toLowerCase(); } catch { /* invalid */ }
  if (!/^(libsql|https):\/\//.test(url) || !host || !confirm || !host.includes(confirm.toLowerCase()) || !/preview/i.test(confirm) || /prod/i.test(host)) { console.error("REFUSED: PREVIEW_TURSO_DATABASE_URL must be the isolated ASJP Preview database named in ASJP_PREVIEW_DB_CONFIRM (containing 'preview'), never Production"); process.exit(2); }
  await run(createClient({ url, authToken }), `remote:${host}`);
} else {
  console.log(JSON.stringify({ ...plan, mode: "DRY_RUN", statements: store.ASJP_SIXWORD_MIGRATION_SQL.length, note: "no connection opened; see the header for --validate-local / --apply" }, null, 1));
}
