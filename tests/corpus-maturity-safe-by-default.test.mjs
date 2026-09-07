import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import {
  indexDocumentSubmissionIntoCorpus,
  findCandidateCorpusRepresentations,
  isRepresentationEligibleForMatching,
  corpusShingleHashes,
} from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";
import { evaluateCorpusAdmissionCandidate } from "../lib/corpus-admission-gate.ts";

/**
 * Phase A hardening — 7-day corpus maturity must be SAFE BY DEFAULT.
 *
 * PLAGIARISM MATCHING    -> maturity enforced by default / always. An ordinary
 *                           matching caller that omits every maturity argument
 *                           still gets the 7-day gate (derived from
 *                           `asOf ?? new Date()`). There is no argument you can
 *                           forget that silently disables the policy.
 * ADMISSION CANONICAL DEDUP -> `eligibilityMode: "ADMISSION_DEDUP"` — the ONE
 *                           sanctioned maturity bypass, so the admission gate
 *                           does not re-admit content already in the corpus.
 *
 * This suite proves both, plus a source audit that the bypass appears at
 * exactly one production call site.
 */

const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_corpus_maturity_safe_by_default.db");
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));

test.after(() => {
  client.close();
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

test.beforeEach(async () => {
  for (const t of [
    "corpus_document_shingles",
    "corpus_submission_references",
    "corpus_admission_promotions",
    "corpus_admission_accepted_representations",
    "corpus_admission_content_store",
    "corpus_admission_decisions",
    "corpus_document_representations",
    "document_identities",
    "report_historical_match_snapshots",
  ]) {
    await client.execute(`DELETE FROM ${t}`);
  }
});

let seq = 0;
function distinctBody() {
  seq += 1;
  const filler = Array.from({ length: 160 }, (_, i) => `token${seq}x${(i * 7) % 53}`).join(" ");
  return `Safe-by-default fixture ${seq}. ${filler}. The distinctive closing clause of fixture ${seq} states a specific and unusual proposition about corpus maturity number ${seq}.`;
}

// Real-word English article well past the corpus-admission hard-gate's
// 3000-word / confident-English floor — needed only by the end-to-end
// admission-gate test.
const WORD_BANK = [
  "research", "analysis", "population", "sample", "variable", "hypothesis", "method", "outcome", "region",
  "temperature", "pressure", "reaction", "material", "structure", "process", "signal", "pattern", "network",
  "sediment", "species", "habitat", "climate", "growth", "measurement", "instrument", "observation", "protocol",
];
function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0xffffffff; };
}
function plausibleArticleText(seed, targetWords = 3400) {
  const rng = seededRandom(seed);
  const paragraphs = [];
  let wordCount = 0;
  while (wordCount < targetWords) {
    const sentence = `The ${Array.from({ length: 10 + Math.floor(rng() * 18) }, () => WORD_BANK[Math.floor(rng() * WORD_BANK.length)]).join(" ")}.`;
    const paragraph = Array.from({ length: 5 + Math.floor(rng() * 4) }, () => sentence).join(" ");
    paragraphs.push(paragraph);
    wordCount += paragraph.split(/\s+/).length;
  }
  return paragraphs.join("\n\n");
}

async function ensureUser(accountId) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "x"],
  });
}

/** Index `rawText` under `accountId` right now — its corpus_submission_references.created_at is the current instant, i.e. ~0 days old (immature). Returns the representation id. */
async function seedFreshSubmission(accountId, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title: "seed", author: null, rawText });
  const result = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  assert.equal(result.status, "INDEXED", "test setup: submission must index");
  return result.representationId;
}

const RESOLVED_PROVENANCE = (sourceUrl) => ({
  kind: "BULK_IMPORT_PROVENANCE",
  provenance: { sourceUrl, acquisitionMethod: "BULK_IMPORT_DOWNLOAD", licenseOrPermission: "CC-BY-4.0", retentionBasis: "LICENSED_REUSE", retentionRightsResolved: true, notes: null },
});

// ===========================================================================
// MATCHING — maturity enforced by default, no argument can disable it
// ===========================================================================

test("matchAgainstUserSubmissionCorpus with NO maturity argument still hides a 1-day-old source", async () => {
  const text = distinctBody();
  await seedFreshSubmission("safe-owner-1", text);

  // A different account queries the identical text. No maturityCutoff, no asOf
  // — the pre-hardening code would have matched; safe-by-default must not.
  const result = await matchAgainstUserSubmissionCorpus(client, {
    accountId: "safe-reader-1",
    canonicalText: canonicalizeText(text),
  });
  assert.equal(result.status, "NO_HISTORICAL_MATCH", "an immature source must not surface as plagiarism evidence for a caller that omitted every maturity argument");
});

test("matchAgainstUserSubmissionCorpus derives the gate from an injected future asOf (tests can still move the clock forward)", async () => {
  const text = distinctBody();
  await seedFreshSubmission("safe-owner-2", text);

  const now = await matchAgainstUserSubmissionCorpus(client, { accountId: "safe-reader-2", canonicalText: canonicalizeText(text) });
  assert.equal(now.status, "NO_HISTORICAL_MATCH");

  const future = await matchAgainstUserSubmissionCorpus(client, {
    accountId: "safe-reader-2",
    canonicalText: canonicalizeText(text),
    asOf: new Date(Date.now() + 30 * 86_400_000),
  });
  assert.equal(future.status, "MATCHED", "30 days on, the same source is mature and matchable");
  assert.equal(future.matches[0].relationshipType, "PRIOR_SUBMISSION");
});

test("findCandidateCorpusRepresentations with default options does not return a 1-day-old representation", async () => {
  const text = distinctBody();
  const repId = await seedFreshSubmission("safe-owner-3", text);

  const candidates = await findCandidateCorpusRepresentations(client, corpusShingleHashes(canonicalizeText(text), 5));
  assert.ok(!candidates.some((c) => c.representationId === repId), "default (MATCHING) discovery must exclude the immature representation");
});

test("isRepresentationEligibleForMatching with default options returns false for a 1-day-old representation", async () => {
  const text = distinctBody();
  const repId = await seedFreshSubmission("safe-owner-4", text);
  assert.equal(await isRepresentationEligibleForMatching(client, repId), false, "default (MATCHING) eligibility must be false for an immature backing");
});

// ===========================================================================
// ADMISSION_DEDUP — the deliberate bypass still sees immature content
// ===========================================================================

test("findCandidateCorpusRepresentations with eligibilityMode ADMISSION_DEDUP DOES discover the 1-day-old representation", async () => {
  const text = distinctBody();
  const repId = await seedFreshSubmission("safe-owner-5", text);

  const candidates = await findCandidateCorpusRepresentations(client, corpusShingleHashes(canonicalizeText(text), 5), {
    eligibilityMode: "ADMISSION_DEDUP",
  });
  assert.ok(candidates.some((c) => c.representationId === repId), "admission dedup must see immature corpus content so it does not create a duplicate");
});

test("isRepresentationEligibleForMatching with eligibilityMode ADMISSION_DEDUP returns true for a 1-day-old representation", async () => {
  const text = distinctBody();
  const repId = await seedFreshSubmission("safe-owner-6", text);
  assert.equal(await isRepresentationEligibleForMatching(client, repId, { eligibilityMode: "ADMISSION_DEDUP" }), true);
});

test("end-to-end: the admission gate resolves EXACT_DUPLICATE against a source seeded moments earlier (immature), so it is not re-admitted", async () => {
  const text = plausibleArticleText(7);
  await seedFreshSubmission("safe-owner-7", text);

  // Exact same canonical content, submitted to the admission gate right away —
  // if admission dedup respected the 7-day gate this would resolve NONE and we
  // would admit a redundant copy.
  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "safe-by-default-dup-candidate",
    filename: "dup.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/safe-by-default-dup"),
    dryRun: true,
  });
  assert.equal(decision.familyRelation, "EXACT_DUPLICATE", "the just-seeded (immature) representation must still be visible to family/redundancy resolution");
});

// ===========================================================================
// SOURCE AUDIT — the bypass exists at exactly one production call site
// ===========================================================================

test("SOURCE AUDIT: eligibilityMode ADMISSION_DEDUP appears at exactly one production call site (the corpus-admission gate)", () => {
  const roots = ["lib", "app"];
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, "utf8");
      // strip line + block comments so a doc-comment mention never counts.
      // Match a CALL SITE — a caller passing `eligibilityMode: "ADMISSION_DEDUP"` —
      // not the type/enum definition or the resolver's own `mode === ...` checks.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      if (/eligibilityMode:\s*["']ADMISSION_DEDUP["']/.test(code)) hits.push(path.relative(repoRoot, full).replace(/\\/g, "/"));
    }
  };
  for (const r of roots) walk(path.join(repoRoot, r));

  assert.deepEqual(
    hits.sort(),
    ["lib/corpus-admission-gate.ts"],
    `the maturity bypass must be used at exactly one production call site — found: ${JSON.stringify(hits)}`,
  );
});

test("SOURCE AUDIT: the vague withMaturity boolean toggle is gone from lib/", () => {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      assert.ok(!/\bwithMaturity\b/.test(code), `withMaturity must no longer exist (found in ${full})`);
    }
  };
  walk(path.join(repoRoot, "lib"));
});

test("SOURCE AUDIT: every production consumer of the shared eligibility predicate defaults to MATCHING", () => {
  // findCandidateCorpusRepresentations / isRepresentationEligibleForMatching /
  // applyHighFrequencyShinglePruning each read `options.eligibilityMode ?? "MATCHING"`.
  const src = fs.readFileSync(path.join(repoRoot, "lib", "user-submission-corpus.ts"), "utf8");
  const defaults = src.match(/options\.eligibilityMode \?\? "MATCHING"/g) ?? [];
  assert.equal(defaults.length, 3, "all three consumers must fall back to MATCHING when no mode is supplied");
  // matchAgainstUserSubmissionCorpus resolves a cutoff unconditionally (never null).
  const matchSrc = fs.readFileSync(path.join(repoRoot, "lib", "user-submission-matching.ts"), "utf8");
  assert.ok(
    /params\.maturityCutoff \?\? corpusMaturityCutoff\(params\.asOf \?\? new Date\(\)\)/.test(matchSrc),
    "matchAgainstUserSubmissionCorpus must always resolve a maturity cutoff",
  );
});
