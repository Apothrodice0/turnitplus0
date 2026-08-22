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

test("no app/ file imports any new corpus-admission-* module", () => {
  const appDir = path.join(repoRoot, "app");
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const imports = importLines(fs.readFileSync(full, "utf8"));
        if (/corpus-admission-/.test(imports)) offenders.push(path.relative(repoRoot, full).split(path.sep).join("/"));
      }
    }
  }
  walk(appDir);
  assert.deepEqual(offenders, [], `no app/ file may import a corpus-admission-* module yet (live wiring is future work): ${offenders.join(", ")}`);
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
