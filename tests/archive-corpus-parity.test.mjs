import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";
import { baselineB, normalizeArchiveResult } from "./helpers/archive-baseline-b.mjs";

/**
 * 100k-scale architecture, slice 2B — parity gate between:
 *   (a) BASELINE B (the correctness oracle): exhaustive discovery + postings
 *       reconstructed from canonical_text + the SAME archive-global stop-hash
 *       DF the matcher derives from archive_hash_df_bands → the UNMODIFIED
 *       scoreAgainstArchive.
 *   (b) matchAgainstArchiveCorpus: compact winnowed-fingerprint discovery +
 *       bounded FTS phrase fallback + the same DF pruning → the SAME
 *       scoreAgainstArchive.
 *
 * Both call the identical scoring function, so this is not "one
 * reimplementation vs another" — it is a test that compact discovery + the
 * bounded phrase fallback reproduce the exhaustive candidate set's scored
 * output. Synthetic fixtures (not corpus/, which is gitignored) so this runs
 * anywhere including CI. The unit proofs (fingerprint determinism, cap,
 * short-span stress, secondary-miss recovery, budget/fan-out bounds) live in
 * tests/archive-scalable-index.test.mjs; the real 321-document parity in
 * tests/archive-corpus-real.local.test.mjs.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_archive_corpus_parity.db");
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);
test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const candidate = `${dbFile}${suffix}`;
    try { if (fs.existsSync(candidate)) fs.unlinkSync(candidate); } catch { /* windows handle lag */ }
  }
});

const DISTINCTIVE_PASSAGE_A =
  "The migratory corridor connecting Batna's wetland reserves to the Chott El Hodna basin " +
  "showed measurable degradation after the irrigation canal expansion, with wading bird counts " +
  "falling by roughly forty percent across three consecutive breeding seasons according to the " +
  "monitoring stations operated by the regional conservation authority and its partner agencies " +
  "throughout the entire multi-year observation window described in the original technical report.";

const DISTINCTIVE_PASSAGE_B =
  "Cooperative credit unions in the Kabylie highlands adopted a tiered collateral model in " +
  "response to repeated harvest failures, allowing smallholder farmers to pledge future olive " +
  "press output rather than land titles, a shift that reduced default rates within two seasons " +
  "and was later documented in board minutes archived separately by three participating branches.";

const BOILERPLATE_PASSAGE =
  "This paper presents a general discussion of the findings and results of the present study. " +
  "The following section outlines the broader research approach used throughout this work. " +
  "Additional analysis is presented in the discussion section above, consistent with prior research.";

// Own filler so each doc's total shingle count comfortably exceeds what a
// short excerpt query shares with it — keeps whole-document containment for a
// standalone-passage query below scoreAgainstArchive's 0.75 self-exclusion
// threshold except where a test specifically wants that.
const FILLER_A = "Independent monitoring reports filed with the regional water authority described the pilot's early operating parameters in detail across the first full year of continuous data collection at every station.";
const FILLER_B = "Subsequent correspondence between the cooperative's board and its financing partners outlined contingency terms for a second harvest failure including staggered repayment windows and an expanded insurance rider.";

const ARCHIVE_DOCS = [
  { id: "archive-a", title: "Wetland Corridor Degradation Near Batna", body: `${DISTINCTIVE_PASSAGE_A} ${FILLER_A} ${BOILERPLATE_PASSAGE}` },
  { id: "archive-b", title: "Tiered Collateral Models in Kabylie Credit Unions", body: `${DISTINCTIVE_PASSAGE_B} ${FILLER_B} ${BOILERPLATE_PASSAGE}` },
  {
    id: "archive-f",
    title: "Report With Reference Section",
    body: `${DISTINCTIVE_PASSAGE_A} A separate methodology was used here.\nReferences\nSmith 2019. Unrelated citation text that must never be treated as matchable content once stripped.`,
  },
];
// 13 more boilerplate carriers → BOILERPLATE_PASSAGE's interior 5-grams have
// archive-wide DF 15 (a, b + these 13), comfortably above MIN_PERSISTED_DF so
// they land in archive_hash_df_bands and are pruned as stop evidence in BOTH
// paths — the real-corpus analog (its PLoS licence boilerplate sits at DF 12–18).
for (let i = 0; i < 13; i += 1) {
  ARCHIVE_DOCS.push({
    id: `archive-boiler-${i}`,
    title: `Generic Methods Overview ${i}`,
    body: `${BOILERPLATE_PASSAGE} Further discussion follows in section ${["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen"][i]} of this particular paper.`,
  });
}

const ARCHIVE_VERSION = "test-archive-2b";
const FIRST_SEEN_AT = "2020-01-01 00:00:00";
const MAXIMUM_DOCUMENT_FREQUENCY = 4; // small on purpose: BOILERPLATE (DF 15) sits well above it

for (const [archiveOrder, doc] of ARCHIVE_DOCS.entries()) {
  const result = await seedArchiveDocument(client, { archiveArticleId: doc.id, title: doc.title, originalSimilarity: null, text: doc.body, archiveOrder }, {
    corpusVersion: ARCHIVE_VERSION,
    firstSeenAt: FIRST_SEEN_AT,
  });
  assert.equal(result.status, "SEEDED", `expected a fresh seed for ${doc.id}`);
}
await rebuildArchiveScalableIndex(client);

async function runBothPaths(submittedText, matchingParameters = { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY }) {
  const b = await baselineB(client, submittedText, { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY, matchingParameters });
  const m = await matchAgainstArchiveCorpus(client, submittedText, {
    maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY,
    matchingParameters,
    asOf: new Date("2026-09-05T00:00:00Z"),
  });
  return { referenceResult: b, dbResult: m };
}

function assertScoredEqual(dbResult, referenceResult, label) {
  assert.deepEqual(
    normalizeArchiveResult(dbResult),
    normalizeArchiveResult(referenceResult),
    `${label}: matchAgainstArchiveCorpus must reproduce Baseline B exactly (score / positions / excluded / highFreq / sources)`,
  );
}

// ── critical parity gates ───────────────────────────────────────────────────

test("exact-copy case: a full verbatim re-upload of an archive document is handled identically in both paths", async () => {
  const submission = ARCHIVE_DOCS[0].body;
  const { referenceResult, dbResult } = await runBothPaths(submission);
  assertScoredEqual(dbResult, referenceResult, "exact-copy");
});

test("large verbatim block embedded in a longer, otherwise-distinct submission is preserved as evidence", async () => {
  const submission = `An unrelated introduction on a different subject precedes this excerpt entirely. ${DISTINCTIVE_PASSAGE_A} A separate, unrelated conclusion about a different research question follows this excerpt today.`;
  const { referenceResult, dbResult } = await runBothPaths(submission);
  assertScoredEqual(dbResult, referenceResult, "verbatim-block");
  assert.ok(referenceResult.sources.some((s) => s.name === "Wetland Corridor Degradation Near Batna"), "sanity: Baseline B found the embedded verbatim source");
});

test("partial-copy case: a distinctive passage embedded in new surrounding text is preserved", async () => {
  const submission = `An unrelated introduction precedes the following observation. ${DISTINCTIVE_PASSAGE_B} A separate, unrelated conclusion follows this excerpt about an entirely different topic in agricultural economics research methodology today.`;
  const { referenceResult, dbResult } = await runBothPaths(submission);
  assertScoredEqual(dbResult, referenceResult, "partial-copy");
  assert.ok(referenceResult.matchedWordCount > 0, "sanity: the partial copy was actually detected");
});

test("boilerplate-only submission does not falsely attribute a match once frequency exceeds the cap", async () => {
  const submission = BOILERPLATE_PASSAGE;
  const { referenceResult, dbResult } = await runBothPaths(submission);
  assert.equal(referenceResult.matchedWordCount, 0, "sanity: B correctly excludes over-common boilerplate");
  assertScoredEqual(dbResult, referenceResult, "boilerplate-only");
});

test("reference-section exclusion: text after a References heading is never matchable", async () => {
  const submission = `${DISTINCTIVE_PASSAGE_A}\nReferences\nSome unrelated citation list that must be excluded before shingling.`;
  const { referenceResult, dbResult } = await runBothPaths(submission);
  assertScoredEqual(dbResult, referenceResult, "reference-section");
  const names = referenceResult.sources.map((s) => s.name);
  assert.ok(!names.includes("Report With Reference Section") || referenceResult.sources.every((s) => s.matchedWords > 0));
});

test("independent archive evidence is structurally unreachable by any SELF/account concept", async () => {
  const submission = `An unrelated introduction on a different subject precedes this excerpt entirely. ${DISTINCTIVE_PASSAGE_A} A separate, unrelated conclusion about a different research question follows this excerpt today.`;
  const dbResult = await matchAgainstArchiveCorpus(client, submission, {
    maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY,
    matchingParameters: { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY },
    asOf: new Date("2026-09-05T00:00:00Z"),
  });
  assert.ok(dbResult.sources.length > 0, "archive evidence must survive with no account/SELF context available to suppress it");
});

test("a freshly seeded archive document (recent first_seen_at) is immediately eligible — ARCHIVE discovery ignores the 7-day gate", async () => {
  const freshDistinctive =
    "A newly commissioned desalination pilot near Oran began testing a reduced-brine discharge protocol " +
    "in partnership with three coastal municipalities, aiming to cut membrane replacement costs while " +
    "maintaining potable output within the original five-year infrastructure budget agreed at the outset.";
  const seedResult = await seedArchiveDocument(client, {
    archiveArticleId: "archive-fresh",
    title: "Freshly Seeded Document",
    originalSimilarity: null,
    text: `${freshDistinctive} ${FILLER_A}`,
    archiveOrder: 99,
  }, {
    corpusVersion: ARCHIVE_VERSION,
    firstSeenAt: "2026-09-04 00:00:00", // deliberately immature by ordinary MATCHING standards
  });
  assert.equal(seedResult.status, "SEEDED");
  await rebuildArchiveScalableIndex(client);

  const submission = `An unrelated introduction on a different subject precedes this excerpt. ${freshDistinctive} A separate, unrelated conclusion follows this excerpt today.`;
  const dbResult = await matchAgainstArchiveCorpus(client, submission, {
    maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY,
    matchingParameters: { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY },
  });
  assert.ok(dbResult.sources.some((s) => s.name === "Freshly Seeded Document"), "ARCHIVE discovery must find a freshly-seeded archive document immediately, regardless of first_seen_at");
  const { referenceResult, dbResult: db2 } = await runBothPaths(submission);
  assertScoredEqual(db2, referenceResult, "fresh-eligibility-parity");
});

test("reused canonical representation: the archive path sees it immediately even though the same row is an immature user submission, and never damages the historical corpus", async () => {
  const rawText =
    "A localized aquaculture cooperative near Annaba restructured its shellfish export contracts after " +
    "a prolonged coastal algae bloom disrupted three consecutive harvest cycles, shifting distribution " +
    "toward inland processing partners under a renegotiated five-year supply agreement signed that autumn. " + FILLER_B;

  const reuseFixtureAccountId = "account-reused-representation-fixture";
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [reuseFixtureAccountId, `${reuseFixtureAccountId}@example.test`, reuseFixtureAccountId, "not-a-real-hash"],
  });

  const identity = await createDocumentIdentity(client, { accountId: reuseFixtureAccountId, title: "Reused Representation Fixture", author: null, rawText });
  const submissionResult = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  assert.equal(submissionResult.status, "INDEXED");
  const historicalShinglesBefore = Number((await client.execute({
    sql: "SELECT COUNT(*) c FROM corpus_document_shingles WHERE representation_id = ?",
    args: [submissionResult.representationId],
  })).rows[0].c);
  assert.ok(historicalShinglesBefore > 0);

  const seedResult = await seedArchiveDocument(client, {
    archiveArticleId: "archive-reused-representation",
    title: "Reused Representation Archive Doc",
    originalSimilarity: null,
    text: rawText,
    archiveOrder: 100,
  }, { corpusVersion: ARCHIVE_VERSION, firstSeenAt: "2020-01-01 00:00:00" });
  assert.equal(seedResult.status, "SEEDED");
  assert.equal(seedResult.representationId, submissionResult.representationId, "seedArchiveDocument must reuse the exact representation row created by the ordinary submission");
  await rebuildArchiveScalableIndex(client);

  const historicalShinglesAfter = Number((await client.execute({
    sql: "SELECT COUNT(*) c FROM corpus_document_shingles WHERE representation_id = ?",
    args: [submissionResult.representationId],
  })).rows[0].c);
  assert.equal(historicalShinglesAfter, historicalShinglesBefore, "seeding as an archive source must not touch the historical corpus_document_shingles");

  const querySubmission = `An unrelated introduction on a different subject precedes this excerpt entirely. A localized aquaculture cooperative near Annaba restructured its shellfish export contracts after a prolonged coastal algae bloom disrupted three consecutive harvest cycles. A separate, unrelated conclusion follows this excerpt today.`;
  const archiveResult = await matchAgainstArchiveCorpus(client, querySubmission, {
    maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY,
    matchingParameters: { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY },
  });
  assert.ok(archiveResult.sources.some((s) => s.name === "Reused Representation Archive Doc"), "archive matching must find the reused representation immediately, with no maturity wait");

  const historicalResult = await matchAgainstUserSubmissionCorpus(client, { accountId: null, canonicalText: canonicalizeText(querySubmission) });
  if (historicalResult.status === "MATCHED") {
    assert.ok(!historicalResult.matches.some((match) => match.matchedRepresentationId === submissionResult.representationId), "ordinary historical matching must not surface the still-immature representation");
  } else {
    assert.equal(historicalResult.status, "NO_HISTORICAL_MATCH");
  }
});
