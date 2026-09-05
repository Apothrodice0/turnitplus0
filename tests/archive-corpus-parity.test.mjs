import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { scoreAgainstArchive } from "../lib/archive-similarity-scoring.ts";
import { seedArchiveDocument, archiveShingleHashes, ARCHIVE_FINGERPRINT_VERSION } from "../lib/archive-corpus-seed.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";

/**
 * 100k-scale architecture, slice 1 — parity gate between:
 *   (a) an in-memory reference implementation of "what the browser's packed
 *       static index would compute" for a small synthetic archive, and
 *   (b) the new DB-backed adapter (matchAgainstArchiveCorpus), seeded via the
 *       real production write primitives (seedArchiveDocument).
 *
 * Both (a) and (b) call the SAME scoreAgainstArchive function (extracted
 * verbatim from app/similarity-worker.ts's own analyze()), so this is not a
 * test of "does one reimplementation match another" — it is a test of
 * whether the DB-backed getPostings/candidate-discovery data source
 * reproduces the same effective posting sets a static index over the same
 * corpus would have. Synthetic fixtures (not corpus/, which is gitignored
 * and local-only) so this runs anywhere, including CI.
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
    try {
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    } catch {
      // Windows sometimes holds the file handle briefly after close() —
      // leftover test DB files are harmless and cleaned up on next run.
    }
  }
});

// ── Synthetic archive: distinctive, boilerplate, and a references section ──

const DISTINCTIVE_PASSAGE_A =
  "The migratory corridor connecting Batna's wetland reserves to the Chott El Hodna basin " +
  "showed measurable degradation after the irrigation canal expansion, with wading bird counts " +
  "falling by roughly forty percent across three consecutive breeding seasons according to the " +
  "monitoring stations operated by the regional conservation authority.";

const DISTINCTIVE_PASSAGE_B =
  "Cooperative credit unions in the Kabylie highlands adopted a tiered collateral model in " +
  "response to repeated harvest failures, allowing smallholder farmers to pledge future olive " +
  "press output rather than land titles, a shift that reduced default rates within two seasons.";

const BOILERPLATE_PASSAGE =
  "This paper presents a general discussion of the findings and results of the present study. " +
  "The following section outlines the broader research approach used throughout this work. " +
  "Additional analysis is presented in the discussion section above, consistent with prior research.";

const ARCHIVE_DOCS = [
  { id: "archive-a", title: "Wetland Corridor Degradation Near Batna", body: `${DISTINCTIVE_PASSAGE_A} ${BOILERPLATE_PASSAGE}` },
  { id: "archive-b", title: "Tiered Collateral Models in Kabylie Credit Unions", body: `${DISTINCTIVE_PASSAGE_B} ${BOILERPLATE_PASSAGE}` },
  { id: "archive-c", title: "Generic Methods Overview C", body: `${BOILERPLATE_PASSAGE} Further discussion follows in later sections of this paper.` },
  { id: "archive-d", title: "Generic Methods Overview D", body: `${BOILERPLATE_PASSAGE} Additional findings are presented below for review.` },
  { id: "archive-e", title: "Generic Methods Overview E", body: `${BOILERPLATE_PASSAGE} The present study also considers related work.` },
  {
    id: "archive-f",
    title: "Report With Reference Section",
    body: `${DISTINCTIVE_PASSAGE_A} A separate methodology was used here.\nReferences\nSmith 2019. Unrelated citation text that must never be treated as matchable content once stripped.`,
  },
];

const ARCHIVE_VERSION = "test-archive-v1-6";
const FIRST_SEEN_AT = "2020-01-01 00:00:00"; // far past any 7-day maturity cutoff a test could plausibly use
const MAXIMUM_DOCUMENT_FREQUENCY = 4; // small on purpose so the boilerplate passage (shared by archive-c/d/e, 3 docs) sits right at the edge, and a 4th occurrence would exceed it

// Unique vocabulary, deliberately never reused by any ARCHIVE_DOCS entry —
// each of the two maturity tests below needs its own document to be
// unambiguously the sole evidence source for its distinctive passage, with
// no possibility of a winner-take-all tie-break against archive-a/-f (both
// of which already carry DISTINCTIVE_PASSAGE_A) deciding the outcome instead
// of the maturity gate itself.
const DISTINCTIVE_PASSAGE_FRESH_ARCHIVE =
  "A newly commissioned desalination pilot near Oran began testing a reduced-brine " +
  "discharge protocol in partnership with three coastal municipalities, aiming to " +
  "cut membrane replacement costs while maintaining potable output within the " +
  "original five-year infrastructure budget.";

const DISTINCTIVE_PASSAGE_REUSED_REPRESENTATION =
  "A localized aquaculture cooperative near Annaba restructured its shellfish " +
  "export contracts after a prolonged coastal algae bloom disrupted three " +
  "consecutive harvest cycles, shifting distribution toward inland processing " +
  "partners under a renegotiated five-year supply agreement.";

// Own, unshared filler bulk for each of the two documents above — NOT
// BOILERPLATE_PASSAGE, deliberately, so seeding these two documents can
// never change BOILERPLATE_PASSAGE's own document frequency for the
// already-passing "boilerplate-only" test. Exists purely so each document's
// own total shingle count comfortably exceeds what a query embedding just
// the distinctive passage would share with it — without this, whole-
// document containment against a short, standalone passage can itself
// exceed scoreAgainstArchive's own step-1 self-exclusion threshold (>= 0.75,
// a real, pre-existing property of the algorithm — see the "exact-copy
// case" test's own comment for the same effect observed elsewhere).
const FILLER_FRESH_ARCHIVE =
  "Independent monitoring reports filed with the regional water authority described " +
  "the pilot's early operating parameters in detail, noting seasonal intake variability " +
  "and outlining a phased expansion timeline contingent on the first full year of data.";
const FILLER_REUSED_REPRESENTATION =
  "Subsequent correspondence between the cooperative's board and its financing partners " +
  "outlined contingency terms for a second bloom event, including staggered repayment " +
  "windows and an expanded insurance rider covering equipment idled during recovery.";

for (const [archiveOrder, doc] of ARCHIVE_DOCS.entries()) {
  // archiveOrder mirrors this synthetic array's own position, matching how
  // the real seeding path would derive it from document-index.meta.json's
  // articles[] order — see archive_document_representations.archive_order's
  // migration comment for why this must line up with the reference index's
  // own (also array-order-based) sourceIndex assignment below.
  const result = await seedArchiveDocument(client, { archiveArticleId: doc.id, title: doc.title, originalSimilarity: null, text: doc.body, archiveOrder }, {
    corpusVersion: ARCHIVE_VERSION,
    firstSeenAt: FIRST_SEEN_AT,
  });
  assert.equal(result.status, "SEEDED", `expected a fresh seed for ${doc.id}`);
}

// ── Reference in-memory index: same synthetic corpus, computed independently ──

function buildReferenceIndex(docs, maximumDocumentFrequency) {
  const canonicalTexts = docs.map((doc) => canonicalizeText(doc.body));
  const perDocHashes = canonicalTexts.map((text) => archiveShingleHashes(text));
  const globalPostings = new Map();
  perDocHashes.forEach((hashes, sourceIndex) => {
    hashes.forEach((hash) => {
      const list = globalPostings.get(hash);
      if (list) list.push(sourceIndex);
      else globalPostings.set(hash, [sourceIndex]);
    });
  });
  // Build-time exclusion, matching scripts/build-document-corpus.py's
  // build_index(): a hash whose DF exceeds the cap is dropped from the index
  // entirely, never truncated.
  for (const [hash, postings] of globalPostings) {
    if (postings.length > maximumDocumentFrequency) globalPostings.delete(hash);
  }
  const articles = docs.map((doc, sourceIndex) => ({
    title: doc.title,
    sourceType: "Publication",
    uniqueShingleCount: perDocHashes[sourceIndex].size,
  }));
  return {
    shingleSize: 5,
    documentCount: docs.length,
    maximumDocumentFrequency,
    articles,
    getPostings: (hash) => globalPostings.get(hash) ?? [],
  };
}

const referenceIndex = buildReferenceIndex(ARCHIVE_DOCS, MAXIMUM_DOCUMENT_FREQUENCY);

function normalizeSourcesForComparison(sources) {
  return sources
    .map((source) => ({ name: source.name, matches: source.matches, matchedWords: source.matchedWords, percent: source.percent }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function runBothPaths(submittedText) {
  const referenceResult = scoreAgainstArchive(submittedText, referenceIndex, { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY });
  const dbResult = await matchAgainstArchiveCorpus(client, submittedText, {
    maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY,
    matchingParameters: { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY },
    asOf: new Date("2026-09-05T00:00:00Z"),
  });
  return { referenceResult, dbResult };
}

// ── Critical parity gates ───────────────────────────────────────────────────

test("exact-copy case: a full verbatim re-upload of an archive document is handled identically in both paths", async () => {
  // Submitting an archive document's own full body verbatim pushes
  // whole-document containment to ~1.0 against its own source — high enough
  // to trigger scoreAgainstArchive's own step-1 self-exclusion (containment
  // >= 0.75), a real, pre-existing property of the algorithm being
  // preserved here, not a defect introduced by this slice. The parity gate
  // that matters is that BOTH paths reach the exact same outcome.
  const submission = `${DISTINCTIVE_PASSAGE_A} ${BOILERPLATE_PASSAGE}`;
  const { referenceResult, dbResult } = await runBothPaths(submission);
  assert.equal(dbResult.score, referenceResult.score, "final archive similarity percentage must be identical");
  assert.deepEqual(dbResult.archiveMatchedPositions, referenceResult.archiveMatchedPositions, "matched word-position set must be identical");
  assert.deepEqual(normalizeSourcesForComparison(dbResult.sources), normalizeSourcesForComparison(referenceResult.sources), "source attribution must be identical");
});

test("large verbatim block embedded in a longer, otherwise-distinct submission is preserved as evidence", async () => {
  const submission = `An unrelated introduction on a different subject precedes this excerpt entirely. ${DISTINCTIVE_PASSAGE_A} A separate, unrelated conclusion about a different research question follows this excerpt today.`;
  const { referenceResult, dbResult } = await runBothPaths(submission);
  assert.equal(dbResult.score, referenceResult.score, "final archive similarity percentage must be identical");
  assert.deepEqual(dbResult.archiveMatchedPositions, referenceResult.archiveMatchedPositions, "matched word-position set must be identical");
  assert.deepEqual(normalizeSourcesForComparison(dbResult.sources), normalizeSourcesForComparison(referenceResult.sources), "source attribution must be identical");
  assert.ok(referenceResult.sources.some((s) => s.name === "Wetland Corridor Degradation Near Batna"), "sanity: reference path actually found the embedded verbatim source");
});

test("partial-copy case: a distinctive passage embedded in new surrounding text is preserved", async () => {
  const submission = `An unrelated introduction precedes the following observation. ${DISTINCTIVE_PASSAGE_B} A separate, unrelated conclusion follows this excerpt about an entirely different topic in agricultural economics research methodology today.`;
  const { referenceResult, dbResult } = await runBothPaths(submission);
  assert.equal(dbResult.score, referenceResult.score);
  assert.deepEqual(dbResult.archiveMatchedPositions, referenceResult.archiveMatchedPositions);
  assert.deepEqual(normalizeSourcesForComparison(dbResult.sources), normalizeSourcesForComparison(referenceResult.sources));
  assert.ok(referenceResult.matchedWordCount > 0, "sanity: the partial copy was actually detected");
});

test("boilerplate-only submission does not falsely attribute a match once frequency exceeds the cap", async () => {
  // BOILERPLATE_PASSAGE appears in archive-a, archive-b, archive-c, archive-d,
  // archive-e (5 documents) — above MAXIMUM_DOCUMENT_FREQUENCY (4), so every
  // shingle drawn purely from it must be excluded from scoring in both paths.
  const submission = BOILERPLATE_PASSAGE;
  const { referenceResult, dbResult } = await runBothPaths(submission);
  assert.equal(referenceResult.matchedWordCount, 0, "sanity: reference path correctly excludes over-common boilerplate");
  assert.equal(dbResult.score, referenceResult.score);
  assert.equal(dbResult.matchedWordCount, referenceResult.matchedWordCount);
  assert.deepEqual(dbResult.archiveMatchedPositions, referenceResult.archiveMatchedPositions);
});

test("reference-section exclusion: text after a References heading is never matchable", async () => {
  const submission = `${DISTINCTIVE_PASSAGE_A}\nReferences\nSome unrelated citation list that must be excluded before shingling.`;
  const { referenceResult, dbResult } = await runBothPaths(submission);
  assert.equal(dbResult.score, referenceResult.score);
  assert.deepEqual(dbResult.archiveMatchedPositions, referenceResult.archiveMatchedPositions);
  // The submission's own reference-section text must never appear as a
  // separate "archive-f" match purely because archive-f also has a
  // References heading — both paths strip references before shingling
  // (lib/similarity-core.ts's comparisonText, applied inside tokens()),
  // so only the genuine DISTINCTIVE_PASSAGE_A overlap should ever surface.
  const names = referenceResult.sources.map((s) => s.name);
  assert.ok(!names.includes("Report With Reference Section") || referenceResult.sources.every((s) => s.matchedWords > 0));
});

test("independent archive evidence is structurally unreachable by any SELF/account concept", async () => {
  // matchAgainstArchiveCorpus's own signature has no accountId, no
  // excludeAccountId, and never imports lib/user-submission-matching.ts's
  // relationship classifier — it cannot be suppressed by same-Passport SELF
  // logic because that logic lives in an entirely disjoint code path this
  // function never calls. This test asserts the archive evidence still
  // surfaces exactly as computed, independent of any such context.
  const submission = `An unrelated introduction on a different subject precedes this excerpt entirely. ${DISTINCTIVE_PASSAGE_A} A separate, unrelated conclusion about a different research question follows this excerpt today.`;
  const dbResult = await matchAgainstArchiveCorpus(client, submission, {
    maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY,
    matchingParameters: { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY },
    asOf: new Date("2026-09-05T00:00:00Z"),
  });
  assert.ok(dbResult.sources.length > 0, "archive evidence must survive with no account/SELF context available to suppress it");
});

test("a freshly seeded archive document (recent first_seen_at) is immediately eligible — ARCHIVE mode ignores the 7-day gate", async () => {
  // Slice 1 correction: archive candidate discovery now runs under
  // CorpusEligibilityMode "ARCHIVE" (lib/user-submission-corpus.ts), not
  // "MATCHING" — eligibility is "has an archive_document_representations
  // row," full stop, with no maturity term at all. A first_seen_at of
  // "yesterday" (which would exclude an ordinary corpus backing under
  // MATCHING) must have zero effect here.
  const seedResult = await seedArchiveDocument(client, {
    archiveArticleId: "archive-fresh",
    title: "Freshly Seeded Document",
    originalSimilarity: null,
    text: `${DISTINCTIVE_PASSAGE_FRESH_ARCHIVE} ${FILLER_FRESH_ARCHIVE}`,
    archiveOrder: 99,
  }, {
    corpusVersion: ARCHIVE_VERSION,
    firstSeenAt: "2026-09-04 00:00:00", // deliberately immature by ordinary MATCHING standards
  });
  assert.equal(seedResult.status, "SEEDED");

  const submission = `An unrelated introduction on a different subject precedes this excerpt entirely. ${DISTINCTIVE_PASSAGE_FRESH_ARCHIVE} A separate, unrelated conclusion about a different research question follows this excerpt today.`;
  const dbResult = await matchAgainstArchiveCorpus(client, submission, {
    maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY,
    matchingParameters: { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY },
  });
  const names = dbResult.sources.map((s) => s.name);
  assert.ok(names.includes("Freshly Seeded Document"), "ARCHIVE mode must find a freshly-seeded archive document immediately, regardless of first_seen_at");
});

test("reused canonical representation: matchAgainstArchiveCorpus sees it immediately even though the same row is also an immature, ordinary user submission", async () => {
  // The exact edge case this slice's own eligibility-mode fix targets:
  // lib/archive-corpus-seed.ts's seedArchiveDocument dedupes by canonical
  // hash (findReusableRepresentationByCanonicalHash) — if an archive
  // document's text happens to byte-for-byte match a representation that
  // already exists for an unrelated reason, seeding REUSES that row rather
  // than creating a new one, and never touches its first_seen_at. Before the
  // "ARCHIVE" eligibility mode existed, that reused row's own (recent, real)
  // first_seen_at would have made it fail the ordinary MATCHING maturity
  // term — exactly as it still correctly does for ordinary historical
  // matching below — which would have wrongly delayed archive evidence for
  // content the archive itself has no reason to wait on.
  const rawText = `${DISTINCTIVE_PASSAGE_REUSED_REPRESENTATION} ${FILLER_REUSED_REPRESENTATION}`;

  // document_identities.account_id is a real foreign key (REFERENCES
  // users(id) ON DELETE SET NULL) — a real row must exist first, same
  // convention tests/user-submission-corpus.test.mjs's own ensureUser uses.
  const reuseFixtureAccountId = "account-reused-representation-fixture";
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [reuseFixtureAccountId, `${reuseFixtureAccountId}@example.test`, reuseFixtureAccountId, "not-a-real-hash"],
  });

  // Step 1 — an ordinary, real, RECENT user submission creates the
  // representation via the production indexing primitive. No firstSeenAt
  // override is possible through this path: first_seen_at = CURRENT_TIMESTAMP,
  // i.e. genuinely "now."
  const identity = await createDocumentIdentity(client, {
    accountId: reuseFixtureAccountId,
    title: "Reused Representation Fixture",
    author: null,
    rawText,
  });
  const submissionResult = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  assert.equal(submissionResult.status, "INDEXED");

  // Step 2 — seed an archive document whose text is byte-for-byte identical.
  // seedArchiveDocument's own canonical-hash dedup must find and reuse the
  // EXACT SAME representation row just created above.
  const seedResult = await seedArchiveDocument(client, {
    archiveArticleId: "archive-reused-representation",
    title: "Reused Representation Archive Doc",
    originalSimilarity: null,
    text: rawText,
    archiveOrder: 100,
  }, {
    corpusVersion: ARCHIVE_VERSION,
    firstSeenAt: "2020-01-01 00:00:00", // honest per the API contract; irrelevant here since the row is reused, not created
  });
  assert.equal(seedResult.status, "SEEDED");
  assert.equal(
    seedResult.representationId,
    submissionResult.representationId,
    "seedArchiveDocument must have reused the exact same representation row created by the ordinary submission, not created a new one",
  );

  const querySubmission = `An unrelated introduction on a different subject precedes this excerpt entirely. ${DISTINCTIVE_PASSAGE_REUSED_REPRESENTATION} A separate, unrelated conclusion about a different research question follows this excerpt today.`;

  // Step 3 — matchAgainstArchiveCorpus (ARCHIVE mode) must find it
  // immediately: no asOf/maturityCutoff is even supplied, demonstrating that
  // none is needed.
  const archiveResult = await matchAgainstArchiveCorpus(client, querySubmission, {
    maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY,
    matchingParameters: { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY },
  });
  assert.ok(
    archiveResult.sources.some((s) => s.name === "Reused Representation Archive Doc"),
    "archive matching must find the reused representation immediately, with no maturity wait",
  );

  // Step 4 — ordinary historical matching (MATCHING mode) must still treat
  // the SAME representation as immature, at real "now": the archive's own
  // eligibility must never leak into, or relax, the normal matching path.
  const historicalResult = await matchAgainstUserSubmissionCorpus(client, {
    accountId: null,
    canonicalText: canonicalizeText(querySubmission),
  });
  if (historicalResult.status === "MATCHED") {
    assert.ok(
      !historicalResult.matches.some((match) => match.matchedRepresentationId === submissionResult.representationId),
      "ordinary historical matching must not surface the still-immature representation",
    );
  } else {
    assert.equal(historicalResult.status, "NO_HISTORICAL_MATCH");
  }
});
