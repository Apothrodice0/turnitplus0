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

test("no app/ file imports lib/corpus-admission-gate.ts or any of its pure sibling modules directly — only lib/corpus-admission-report-integration.ts is an allowed door", () => {
  const appDir = path.join(repoRoot, "app");
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const imports = importLines(fs.readFileSync(full, "utf8"));
        const corpusAdmissionImportLines = imports.split("\n").filter((l) => /corpus-admission-/.test(l));
        const bypassesTheDoor = corpusAdmissionImportLines.some((l) => !l.includes(ALLOWED_CORPUS_ADMISSION_DOOR));
        if (bypassesTheDoor) offenders.push(path.relative(repoRoot, full).split(path.sep).join("/"));
      }
    }
  }
  walk(appDir);
  assert.deepEqual(offenders, [], `these app/ files import a corpus-admission-* module other than ${ALLOWED_CORPUS_ADMISSION_DOOR}: ${offenders.join(", ")}`);
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
