import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

// Database safety net (Step 1, following the audit that found .env.local
// points TURSO_DATABASE_URL at the shared turnitplus-dev Turso database).
//
// Root cause: lib/reports-db.ts's getReportsDbClient() and app/api/ingest/
// route.ts each read process.env.TURSO_DATABASE_URL directly, and use it
// (connecting to a REMOTE database) whenever it is truthy — with no way to
// tell "a test set this on purpose" apart from "this leaked in from the
// real shell environment". `node --test` runs every test *file* in its own
// process (verified empirically — see the Phase [database-safety] session
// notes), so one file's `process.env.TURSO_DATABASE_URL = 'file:...'`
// cannot leak into another file's process. The actual risk is a test file
// that touches a TURSO_DATABASE_URL-sensitive route but never overrides the
// variable itself: it would silently inherit whatever the real host shell
// has set (concretely: tests/api-ingest.test.mjs did exactly this until
// fixed alongside this test).
//
// This file is the durable fix: rather than trusting every present and
// future test file to remember the override, it structurally scans every
// test file's source for the routes known to read TURSO_DATABASE_URL and
// asserts each one that imports such a route also neutralizes the variable
// itself. This is the same "read source, assert on it" pattern already used
// by tests/report-detail-route.test.mjs, applied to a safety property
// instead of a behavioral one.

const testsDir = path.resolve("tests");

// Every module (relative to app/) that reads process.env.TURSO_DATABASE_URL,
// directly or via lib/reports-db.ts's getReportsDbClient(). Sourced from a
// full repo audit (grep for getReportsDbClient() and TURSO_DATABASE_URL
// across app/ and lib/), not guessed — see the module-level comment above.
const TURSO_SENSITIVE_ROUTE_IMPORTS = [
  "app/api/reports/route",
  "app/api/reports/[id]/route",
  "app/api/auth/signup/route",
  "app/api/auth/login/route",
  "app/api/auth/logout/route",
  "app/api/auth/me/route",
];

// schema-drift.test.mjs deliberately does something different: it allows
// running against the real turnitplus-dev database, but only if
// TURSO_DATABASE_URL is already set AND the value is verified (by its own
// separate guard) to look like turnitplus-dev and not prod. That is a
// considered exception, not the bug this file guards against, so it is
// checked separately below rather than required to match the "always
// override" pattern every other file must follow.
const DELIBERATE_EXCEPTIONS = new Set(["schema-drift.test.mjs"]);

function importsAnySensitiveRoute(source) {
  return TURSO_SENSITIVE_ROUTE_IMPORTS.some((importPath) => {
    const escaped = importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`['"](?:\\.\\./)+${escaped}(?:\\.ts)?['"]`).test(source);
  });
}

function overridesTursoDatabaseUrl(source) {
  return /process\.env\.TURSO_DATABASE_URL\s*=/.test(source)
    || /delete\s+process\.env\.TURSO_DATABASE_URL/.test(source);
}

test("every test file that imports a TURSO_DATABASE_URL-sensitive route also overrides that variable itself", () => {
  const testFiles = fs.readdirSync(testsDir).filter((name) => name.endsWith(".test.mjs"));
  assert.ok(testFiles.length >= 40, `expected to find dozens of test files, only found ${testFiles.length} — the scan itself may be broken`);

  const offenders = [];
  for (const fileName of testFiles) {
    if (DELIBERATE_EXCEPTIONS.has(fileName)) continue;
    const source = fs.readFileSync(path.join(testsDir, fileName), "utf8");
    if (importsAnySensitiveRoute(source) && !overridesTursoDatabaseUrl(source)) {
      offenders.push(fileName);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these test files import a route that reads TURSO_DATABASE_URL but never override it, so they would silently use ` +
    `whatever real database is set in the ambient shell environment: ${offenders.join(", ")}`,
  );
});

test("at least one real test file is known to exercise this check (the check itself is not vacuously trivial)", () => {
  const testFiles = fs.readdirSync(testsDir).filter((name) => name.endsWith(".test.mjs"));
  const matched = testFiles.filter((fileName) => {
    const source = fs.readFileSync(path.join(testsDir, fileName), "utf8");
    return importsAnySensitiveRoute(source);
  });
  assert.ok(matched.length >= 5, `expected several test files to import a sensitive route (found ${matched.length}) — if this drops to 0, the regex patterns above have likely gone stale against a refactor and are silently matching nothing`);
});

test("schema-drift.test.mjs's separate, deliberate remote-access guard is still present", () => {
  const source = fs.readFileSync(path.join(testsDir, "schema-drift.test.mjs"), "utf8");
  assert.match(
    source,
    /looksLikeDev/,
    "schema-drift.test.mjs's guard against running unattended against a non-dev/prod-named database appears to have been removed or renamed",
  );
  assert.match(
    source,
    /it does not clearly identify turnitplus-dev/,
    "schema-drift.test.mjs must still refuse to run against a TURSO_DATABASE_URL that doesn't clearly identify turnitplus-dev",
  );
});

// Release-hardening audit finding INGEST-01: app/api/ingest/route.ts was
// closed (no legitimate runtime caller existed) and no longer imports
// anything DB-related at all, so it dropped out of TURSO_SENSITIVE_ROUTE_IMPORTS
// above — the override-before-first-call test that used to guard this file
// is replaced with a stronger, more durable property: the closed route must
// never reference TURSO_DATABASE_URL again, so there is nothing left to
// neutralize. tests/api-ingest.test.mjs's own structural test independently
// re-checks this same file for any DB-touching import at all, not just this
// one variable name.
test("the closed app/api/ingest/route.ts never references TURSO_DATABASE_URL", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "app/api/ingest/route.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /TURSO_DATABASE_URL/,
    "the closed ingest route must not reference TURSO_DATABASE_URL — it should be fully DB-agnostic, not merely isolation-safe",
  );
});

test("process.env.TURSO_DATABASE_URL is not left set in this test process by the time module-level setup finishes", () => {
  // A direct, cheap runtime check alongside the structural ones above: by
  // the time database-isolation.test.mjs itself runs, nothing earlier in
  // *this* process's execution should have left a real remote URL sitting in
  // process.env — this file never sets it to anything, so it should reflect
  // only what the ambient environment provided (which local development/CI
  // is expected to leave unset for a plain `node --test` invocation; see the
  // module comment for why this is a separate process per test file and
  // therefore doesn't reflect what other test files did to their own).
  const value = process.env.TURSO_DATABASE_URL;
  if (value) {
    assert.ok(
      value.startsWith("file:"),
      "if TURSO_DATABASE_URL is present in this process's environment at all, it must be a local file: URL — " +
      "a real libsql:// value here means this test run's shell environment is itself pointed at a remote database, " +
      "which every other DB-touching test file must (and structurally does, per the check above) override before use, " +
      "but should not be relied upon: consider running tests without that variable exported.",
    );
  }
});

// Follow-up audit: .env.local previously set a *live* TURSO_DATABASE_URL,
// pointing `next dev`/`next start` (which load it automatically — unlike
// the plain `node --test` runs the checks above are about) at the shared
// turnitplus-dev database by default. Fixed by renaming those two variables
// to DEV_TURSO_DATABASE_URL/DEV_TURSO_AUTH_TOKEN (the credentials are kept,
// just under names lib/reports-db.ts and app/api/ingest/route.ts don't read),
// mirroring the PROD_TURSO_DATABASE_URL/PROD_TURSO_TOKEN pattern
// .env.production.local already used. These files are gitignored/personal
// and may not exist at all on a given machine or in CI — their absence is
// not a failure, only a live TURSO_DATABASE_URL/TURSO_AUTH_TOKEN inside one
// is.
const LOCAL_ONLY_ENV_FILES = [".env.local", ".env.production.local", ".env.development.local"];

function findLiveTursoAssignment(source) {
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    if (/^TURSO_DATABASE_URL=\S/.test(trimmed)) return "TURSO_DATABASE_URL";
    if (/^TURSO_AUTH_TOKEN=\S/.test(trimmed)) return "TURSO_AUTH_TOKEN";
  }
  return null;
}

test("gitignored local env files never set a live TURSO_DATABASE_URL/TURSO_AUTH_TOKEN (next dev/next build load these automatically)", () => {
  const repoRoot = path.resolve(".");
  let checkedAtLeastOne = false;
  for (const fileName of LOCAL_ONLY_ENV_FILES) {
    const filePath = path.join(repoRoot, fileName);
    if (!fs.existsSync(filePath)) continue;
    checkedAtLeastOne = true;
    const source = fs.readFileSync(filePath, "utf8");
    const offendingKey = findLiveTursoAssignment(source);
    assert.equal(
      offendingKey,
      null,
      `${fileName} sets a live ${offendingKey} — Next.js loads this file automatically for next dev/next build/next start, ` +
      `so this would silently point local development at a real database. Rename it (see this repo's DEV_/PROD_ prefix ` +
      `convention in .env.local/.env.production.local) instead of using the real variable name here.`,
    );
  }
  // Not asserting checkedAtLeastOne >= 1: on a machine or CI runner with none
  // of these files present, there is nothing to check and that is correct,
  // not a gap — the app's own default (local SQLite file) already applies.
  void checkedAtLeastOne;
});
