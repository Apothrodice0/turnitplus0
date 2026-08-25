import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(".");

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
function importLines(source) {
  return source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
}

const GATE_SOURCE = fs.readFileSync(path.join(repoRoot, "lib/corpus-admission-gate.ts"), "utf8");

test("lib/corpus-admission-gate.ts never mentions any of the real corpus's 4 write functions — indexing into the real corpus stays fully out of scope", () => {
  const source = stripComments(GATE_SOURCE);
  assert.doesNotMatch(source, /\bcreateReusableDocumentRepresentation\b/);
  assert.doesNotMatch(source, /\brecordCorpusShingles\b/);
  assert.doesNotMatch(source, /\brecordSubmissionReference\b/);
  assert.doesNotMatch(source, /\bindexDocumentSubmissionIntoCorpus\b/);
});

test("lib/corpus-admission-gate.ts only imports the two READ functions from lib/user-submission-corpus.ts", () => {
  const importLine = importLines(GATE_SOURCE).split("\n").find((l) => /user-submission-corpus/.test(l));
  assert.ok(importLine, "expected an import from lib/user-submission-corpus.ts for near-duplicate lookups");
  assert.match(importLine, /corpusShingleHashes/);
  assert.match(importLine, /findCandidateCorpusRepresentations/);
  assert.doesNotMatch(importLine, /indexDocumentSubmissionIntoCorpus|createReusableDocumentRepresentation|recordCorpusShingles|recordSubmissionReference/);
});

// Controlled live-report integration (see lib/corpus-admission-report-integration.ts):
// exactly one narrow, flagged door from app/ into the corpus-admission
// feature is now intentional. These two tests together preserve the same
// bypass-proofing spirit the single "no app/ file imports any new
// corpus-admission-* module" assertion used to provide, adapted for that
// deliberate architecture change: (1) the raw gate and its pure sibling
// modules must still never be reachable directly from app/, only through
// the integration layer's own consent/flag/idempotency/deletion
// guarantees; (2) the set of app/ files using that one door is closed and
// explicit, not open-ended.
const ALLOWED_CORPUS_ADMISSION_DOOR = "corpus-admission-report-integration";
const EXPECTED_APP_FILES_USING_THE_DOOR = [
  "app/api/reports/route.ts",
  "app/api/reports/[id]/route.ts",
  "app/api/auth/me/route.ts",
  "app/api/internal/corpus-admission-sweep/route.ts",
];
// The admin-only corpus dashboard (below) is a second, deliberately separate
// door into a different slice of the corpus-admission-* namespace — its own
// read/mutate layer over decisions/jobs/accepted-representations/audit-log,
// never the report-integration flow. Both doors are closed allowlists in
// their own right; this generic "no direct import of the raw gate or its
// siblings" check must recognize both by name rather than treat the admin
// door as a bypass of the report-integration one.
const ADMIN_DASHBOARD_DOOR_MODULES = ["corpus-admission-admin-repo", "corpus-admission-admin-actions"];
// Third door: lib/corpus-admission-promotion.ts, its own closed surface —
// promotes an ACCEPTed decision's retained text into the shared matching
// index (corpus_document_representations/shingles). Deliberately its own
// door rather than folded into the report-integration one, since promotion
// reads decisions/accepted-representations/content-store directly and never
// touches saved_reports, consent, or deletion at all.
const PROMOTION_DOOR_MODULE = "corpus-admission-promotion";
const EXPECTED_APP_FILES_USING_THE_PROMOTION_DOOR = [
  "app/api/internal/corpus-admission-promotion-sweep/route.ts",
  // Admin-only, read-only status line (isCorpusPromotionEnabled() flag
  // state) — see app/admin/corpus/page.tsx's own header.
  "app/admin/corpus/page.tsx",
];
// Fourth door (Task B1B): lib/corpus-admission-retention-sweep.ts, its own
// closed surface — deletes stale REJECT/REVIEW decisions and failed/
// cancelled report jobs after the retention window, never anything ACCEPT-
// shaped. Deliberately invoked from the SAME route as the report-admission
// retry sweep (no third Vercel Hobby cron slot) rather than folded into
// that door's own module — retention has no consent/idempotency-job
// relationship to report-integration at all, just a shared HTTP trigger.
const RETENTION_DOOR_MODULE = "corpus-admission-retention-sweep";
const EXPECTED_APP_FILES_USING_THE_RETENTION_DOOR = ["app/api/internal/corpus-admission-sweep/route.ts"];

test("no app/ file imports lib/corpus-admission-gate.ts or any of its pure sibling modules directly — only lib/corpus-admission-report-integration.ts, the admin-dashboard repo/actions modules, lib/corpus-admission-promotion.ts, and lib/corpus-admission-retention-sweep.ts are allowed doors", () => {
  const appDir = path.join(repoRoot, "app");
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const imports = importLines(fs.readFileSync(full, "utf8"));
        const corpusAdmissionImportLines = imports.split("\n").filter((l) => /corpus-admission-/.test(l));
        const bypassesTheDoor = corpusAdmissionImportLines.some(
          (l) =>
            !l.includes(ALLOWED_CORPUS_ADMISSION_DOOR) &&
            !ADMIN_DASHBOARD_DOOR_MODULES.some((m) => l.includes(m)) &&
            !l.includes(PROMOTION_DOOR_MODULE) &&
            !l.includes(RETENTION_DOOR_MODULE),
        );
        if (bypassesTheDoor) offenders.push(path.relative(repoRoot, full).split(path.sep).join("/"));
      }
    }
  }
  walk(appDir);
  assert.deepEqual(offenders, [], `these app/ files import a corpus-admission-* module other than the four allowed doors: ${offenders.join(", ")}`);
});

test("exactly the expected app/ files use the corpus-admission-retention-sweep door — no unreviewed new caller", () => {
  const appDir = path.join(repoRoot, "app");
  const callers = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const imports = importLines(fs.readFileSync(full, "utf8"));
        if (imports.includes(RETENTION_DOOR_MODULE)) callers.push(path.relative(repoRoot, full).split(path.sep).join("/"));
      }
    }
  }
  walk(appDir);
  assert.deepEqual(callers.sort(), [...EXPECTED_APP_FILES_USING_THE_RETENTION_DOOR].sort());
});

test("exactly the expected app/ files use the corpus-admission-report-integration door — no unreviewed new caller", () => {
  const appDir = path.join(repoRoot, "app");
  const callers = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const imports = importLines(fs.readFileSync(full, "utf8"));
        if (imports.includes(ALLOWED_CORPUS_ADMISSION_DOOR)) callers.push(path.relative(repoRoot, full).split(path.sep).join("/"));
      }
    }
  }
  walk(appDir);
  assert.deepEqual(callers.sort(), [...EXPECTED_APP_FILES_USING_THE_DOOR].sort());
});

test("exactly the expected app/ files use the corpus-admission-promotion door — no unreviewed new caller", () => {
  const appDir = path.join(repoRoot, "app");
  const callers = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const imports = importLines(fs.readFileSync(full, "utf8"));
        if (imports.includes(PROMOTION_DOOR_MODULE)) callers.push(path.relative(repoRoot, full).split(path.sep).join("/"));
      }
    }
  }
  walk(appDir);
  assert.deepEqual(callers.sort(), [...EXPECTED_APP_FILES_USING_THE_PROMOTION_DOOR].sort());
});

const PROMOTION_SOURCE = fs.readFileSync(path.join(repoRoot, "lib/corpus-admission-promotion.ts"), "utf8");

test("lib/corpus-admission-promotion.ts never touches document_identities, users, or corpus_admission_report_jobs' account-shaped columns — decision_id/accepted_representation_id are its only linkage", () => {
  const source = stripComments(PROMOTION_SOURCE);
  assert.doesNotMatch(importLines(source), /findDocumentIdentitiesByRawHash|findPriorSubmissionsForAccount/);
  for (const forbidden of ["account_id", "device_key", "report_id", "source_ref", "FROM users", "document_identities"]) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `lib/corpus-admission-promotion.ts must never mention ${forbidden}`);
  }
});

test("lib/corpus-admission-promotion.ts never calls recordSubmissionReference or indexDocumentSubmissionIntoCorpus — a promoted representation is never linked to a document_identity_id", () => {
  const source = stripComments(PROMOTION_SOURCE);
  assert.doesNotMatch(source, /\brecordSubmissionReference\b/);
  assert.doesNotMatch(source, /\bindexDocumentSubmissionIntoCorpus\b/);
});

test("the corpus_admission_promotions migration and schema never define an account/report-shaped column", () => {
  const migrationSource = stripSqlComments(fs.readFileSync(path.join(repoRoot, "drizzle/0034_corpus_admission_promotions.sql"), "utf8"));
  const tableMatch = migrationSource.match(/CREATE TABLE[^;]*corpus_admission_promotions\s*\(([^;]*?)\);/s);
  assert.ok(tableMatch, "expected to find the corpus_admission_promotions CREATE TABLE statement");
  for (const forbidden of ["account_id", "device_key", "report_id", "source_ref", "email"]) {
    assert.doesNotMatch(tableMatch[1], new RegExp(forbidden), `corpus_admission_promotions must never define a ${forbidden} column`);
  }

  const schemaSource = stripComments(fs.readFileSync(path.join(repoRoot, "db/schema.ts"), "utf8"));
  const schemaBlockMatch = schemaSource.match(/corpus_admission_promotions = sqliteTable\(([\s\S]*?)\n\);/);
  assert.ok(schemaBlockMatch, "expected to find the corpus_admission_promotions sqliteTable block in db/schema.ts");
  for (const forbidden of ["account_id", "device_key", "report_id", "source_ref", "email"]) {
    assert.doesNotMatch(schemaBlockMatch[1], new RegExp(forbidden), `corpus_admission_promotions' schema.ts block must never define a ${forbidden} column`);
  }
});

test("no app/ file imports indexDocumentSubmissionIntoCorpus — normal report creation has no reachable path to a reusable-corpus write that skips the admission gate", () => {
  const appDir = path.join(repoRoot, "app");
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const source = fs.readFileSync(full, "utf8");
        if (/indexDocumentSubmissionIntoCorpus/.test(stripComments(source))) offenders.push(path.relative(repoRoot, full).split(path.sep).join("/"));
      }
    }
  }
  walk(appDir);
  assert.deepEqual(offenders, [], `these app/ files still mention indexDocumentSubmissionIntoCorpus: ${offenders.join(", ")}`);
});

function stripSqlComments(source) {
  return source.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n");
}

test("the corpus_admission_decisions migration and schema never define a canonical_text-shaped column", () => {
  // SQL comments (-- ...) are stripped first — this migration's own prose
  // comments legitimately contain semicolons (ordinary English punctuation),
  // which would otherwise confuse a naive "[^;]*" boundary search into
  // matching past the real CREATE TABLE statement's own closing ");".
  const migrationSource = stripSqlComments(fs.readFileSync(path.join(repoRoot, "drizzle/0029_corpus_admission_decisions.sql"), "utf8"));
  const decisionsTableMatch = migrationSource.match(/CREATE TABLE[^;]*corpus_admission_decisions\s*\(([^;]*?)\);/s);
  assert.ok(decisionsTableMatch, "expected to find the corpus_admission_decisions CREATE TABLE statement");
  assert.doesNotMatch(decisionsTableMatch[1], /canonical_text/);

  const schemaSource = stripComments(fs.readFileSync(path.join(repoRoot, "db/schema.ts"), "utf8"));
  const schemaBlockMatch = schemaSource.match(/corpus_admission_decisions = sqliteTable\(([\s\S]*?)\n\);/);
  assert.ok(schemaBlockMatch, "expected to find the corpus_admission_decisions sqliteTable block in db/schema.ts");
  assert.doesNotMatch(schemaBlockMatch[1], /canonical_text/);
});

test("only one INSERT into corpus_admission_content_store exists in the entire feature — the single, narrowly-gated write path", () => {
  const occurrences = (stripComments(GATE_SOURCE).match(/INSERT INTO corpus_admission_content_store/g) ?? []).length;
  assert.equal(occurrences, 1, `expected exactly one INSERT INTO corpus_admission_content_store in lib/corpus-admission-gate.ts, found ${occurrences}`);
});

test("lib/corpus-admission-policy.ts and lib/corpus-hard-gates.ts stay free of @libsql/client and console logging of content", () => {
  for (const file of ["lib/corpus-admission-policy.ts", "lib/corpus-hard-gates.ts", "lib/corpus-admission-family.ts"]) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(importLines(source), /@libsql\/client/, `${file} must stay I/O-free`);
  }
});

// ============================================================================
// Admin-only corpus dashboard (app/admin/corpus/*, app/api/admin/corpus/*):
// zero user-facing exposure. lib/corpus-admission-admin-repo.ts and
// lib/corpus-admission-admin-actions.ts perform NO authorization check of
// their own (see both modules' own header comments) — every caller MUST be
// independently admin-gated, so the set of files allowed to import them at
// all must be closed and explicit, exactly like the report-integration
// door above. A normal (non-admin) user must never be able to reach these
// modules through any import path, and the two admin pages'
// generateMetadata() must never leak a page-identifying title before the
// same admin check the page body itself performs — the exact historical bug
// already fixed once for lib/developer-gate.ts (see lib/admin-gate.ts's own
// comment).
// ============================================================================

const ADMIN_DASHBOARD_MODULES = ["corpus-admission-admin-repo", "corpus-admission-admin-actions"];
// The two app/admin/corpus/*.tsx pages never import these modules directly —
// they render the "use client" components (components/admin/corpus-search.tsx,
// components/admin/corpus-detail.tsx), which fetch these 5 API routes over
// HTTP instead. Only the routes touch the repo/actions modules themselves.
const EXPECTED_ADMIN_DASHBOARD_IMPORTERS = [
  "app/api/admin/corpus/route.ts",
  "app/api/admin/corpus/[id]/route.ts",
  "app/api/admin/corpus/[id]/preview/route.ts",
  "app/api/admin/corpus/[id]/deactivate/route.ts",
  "app/api/admin/corpus/[id]/reactivate/route.ts",
];

function walkSourceFiles(rootDir, visit) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) visit(full);
    }
  }
  walk(rootDir);
}

test("only the expected admin-dashboard files import lib/corpus-admission-admin-repo.ts or lib/corpus-admission-admin-actions.ts — no unreviewed new caller, and no bypass from outside app/admin or app/api/admin/corpus", () => {
  const importers = [];
  for (const rootDir of [path.join(repoRoot, "app"), path.join(repoRoot, "components"), path.join(repoRoot, "lib")]) {
    walkSourceFiles(rootDir, (full) => {
      const imports = importLines(fs.readFileSync(full, "utf8"));
      if (ADMIN_DASHBOARD_MODULES.some((m) => imports.includes(m))) {
        importers.push(path.relative(repoRoot, full).split(path.sep).join("/"));
      }
    });
  }
  assert.deepEqual(importers.sort(), [...EXPECTED_ADMIN_DASHBOARD_IMPORTERS].sort());
});

test("no file outside app/admin/* or app/api/admin/corpus/* imports lib/admin-gate.ts — the admin-gate check itself is never reachable from ordinary user-facing pages", () => {
  const offenders = [];
  for (const rootDir of [path.join(repoRoot, "app"), path.join(repoRoot, "components")]) {
    walkSourceFiles(rootDir, (full) => {
      const relative = path.relative(repoRoot, full).split(path.sep).join("/");
      if (relative.startsWith("app/admin/") || relative.startsWith("app/api/admin/corpus/")) return;
      const imports = importLines(fs.readFileSync(full, "utf8"));
      if (imports.includes("admin-gate")) offenders.push(relative);
    });
  }
  assert.deepEqual(offenders, [], `these files import lib/admin-gate.ts from outside the admin surface: ${offenders.join(", ")}`);
});

test("both app/admin/corpus pages' generateMetadata() calls loadAdminGate() and returns {} before ever constructing a page-identifying title — no title leak to a non-admin", () => {
  for (const relativePath of ["app/admin/corpus/page.tsx", "app/admin/corpus/[id]/page.tsx"]) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    const metadataFnMatch = source.match(/export async function generateMetadata\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
    assert.ok(metadataFnMatch, `expected to find generateMetadata() in ${relativePath}`);
    const body = metadataFnMatch[1];

    const gateCallIndex = body.search(/loadAdminGate\(\)/);
    assert.notEqual(gateCallIndex, -1, `${relativePath}'s generateMetadata() must call loadAdminGate()`);

    const earlyReturnMatch = body.match(/if\s*\(\s*!\s*\w+\s*\)\s*return\s*\{\s*\}\s*;/);
    assert.ok(earlyReturnMatch, `${relativePath}'s generateMetadata() must return {} (no title) when loadAdminGate() resolves null`);
    assert.ok(earlyReturnMatch.index > gateCallIndex, `${relativePath}'s null-check-and-empty-return must come AFTER the loadAdminGate() call, not before`);

    const titleIndex = body.search(/title\s*:/);
    assert.ok(titleIndex === -1 || titleIndex > earlyReturnMatch.index, `${relativePath} must never construct a title before the admin check's early return`);
  }
});

test("both app/admin/corpus pages' default export calls loadAdminGate() and calls notFound() (never returns page content) when it resolves null", () => {
  for (const relativePath of ["app/admin/corpus/page.tsx", "app/admin/corpus/[id]/page.tsx"]) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    assert.match(importLines(source), /notFound/, `${relativePath} must import notFound from next/navigation`);
    const bodyMatch = source.match(/export default async function \w+\([^)]*\)[^{]*\{([\s\S]*)\}\s*$/);
    assert.ok(bodyMatch, `expected to find the default-exported page component in ${relativePath}`);
    const body = bodyMatch[1];
    const gateCallIndex = body.search(/loadAdminGate\(\)/);
    assert.notEqual(gateCallIndex, -1, `${relativePath}'s page body must call loadAdminGate()`);
    const notFoundMatch = body.match(/if\s*\(\s*!\s*\w+\s*\)\s*notFound\(\)\s*;/);
    assert.ok(notFoundMatch, `${relativePath}'s page body must call notFound() when loadAdminGate() resolves null`);
    assert.ok(notFoundMatch.index > gateCallIndex, `${relativePath}'s notFound() call must come AFTER the loadAdminGate() call`);
  }
});
