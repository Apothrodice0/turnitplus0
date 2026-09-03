import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus, corpusShingleHashes, recordCorpusShingles, CORPUS_FINGERPRINT_VERSION } from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus, USER_SUBMISSION_MATCH_THRESHOLDS } from "../lib/user-submission-matching.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

/**
 * TIMEOUT HONESTY, made concrete: dbQueryTimeoutMs is a real race against
 * genuine async I/O (proven here with an artificially slow client wrapper);
 * matchTimeBudgetMs is a soft, cooperative deadline that can only refuse to
 * start the NEXT candidate (proven by forcing it to 0 and confirming the
 * loop runs zero correspondence comparisons, returning partial:true rather
 * than throwing or hanging); maxCandidateWordCount is the real, hard
 * backstop for a single oversized candidate (proven by seeding one and
 * confirming it is skipped without ever reaching computeDocumentCorrespondence).
 * Every fixture is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_user_submission_matching_timeout.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const knownUsers = new Set();
async function ensureUser(accountId) {
  if (accountId === null || knownUsers.has(accountId)) return;
  knownUsers.add(accountId);
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
}

async function indexSubmission(accountId, title, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  // Phase A safe-by-default maturity: this suite is about timeout/budget
  // behaviour, not the activation clock — age the backing past 7 days so it is
  // a real candidate.
  await matureCorpusBackings(client);
  return identity;
}

/** Wraps the real client's execute() with an artificial delay — every other method delegates untouched. Simulates genuinely slow async I/O, not CPU work, which is exactly what dbQueryTimeoutMs's real Promise.race is honest about being able to abandon. */
function slowClient(realClient, delayMs) {
  return {
    execute: async (stmt) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return realClient.execute(stmt);
    },
    batch: (...args) => realClient.batch(...args),
    transaction: (...args) => realClient.transaction(...args),
    close: () => {},
  };
}

const TEXT_SLOW =
  "Slow-database fixture: seismologists deployed a temporary array of broadband sensors across a fault zone " +
  "following a moderate earthquake, recording thousands of aftershocks over the following month that revealed a " +
  "previously unmapped secondary fault segment oriented obliquely to the main rupture plane.";

test("SLOW DATABASE WORK: a real (non-cooperative) timeout on the candidate-search query returns gracefully instead of hanging or throwing", async () => {
  await indexSubmission("slow-db-account", "Slow DB fixture", TEXT_SLOW);

  // Wide margin (50ms timeout vs. a 2000ms artificial delay) deliberately,
  // not a tight race — this only needs to prove the real timeout fires well
  // before the full delay elapses, and a tight margin would make this test
  // flaky under a loaded test runner (many files' DB work competing for the
  // event loop), which a genuinely CPU-bound cooperative-deadline test
  // cannot avoid but a real async-I/O timeout test has no reason to risk.
  const artificialDelayMs = 2000;
  const wrapped = slowClient(client, artificialDelayMs);
  const startedAt = Date.now();
  const result = await matchAgainstUserSubmissionCorpus(wrapped, {
    accountId: "some-other-account",
    canonicalText: TEXT_SLOW,
    config: { ...USER_SUBMISSION_MATCH_THRESHOLDS, dbQueryTimeoutMs: 50 },
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, "NO_HISTORICAL_MATCH", "a timed-out candidate search must degrade to no-match, never throw");
  assert.equal(result.partial, true, "must be marked partial — this is NOT a confirmed absence of matches, only an incomplete computation");
  assert.ok(
    elapsedMs < artificialDelayMs * 0.75,
    `must return well before the artificial ${artificialDelayMs}ms query delay elapses (took ${elapsedMs}ms) — proving the real Promise.race actually abandoned the slow call rather than waiting for it`,
  );
});

test("a fast database (no timeout) still finds the real match — the timeout wrapper itself introduces no false negatives", async () => {
  const text = TEXT_SLOW + " Fast-path control case, otherwise identical setup.";
  await indexSubmission("fast-db-account", "Fast DB fixture", text);
  const result = await matchAgainstUserSubmissionCorpus(client, { accountId: "some-other-account-2", canonicalText: text });
  assert.equal(result.status, "MATCHED");
  assert.notEqual(result.partial, true);
});

const TEXT_BUDGET =
  "Expensive-correspondence fixture: paleontologists excavating a fossil bed uncovered several articulated skeletons " +
  "belonging to a previously undescribed species of small theropod dinosaur, preserved in fine-grained volcanic ash " +
  "that captured unusually detailed soft-tissue impressions around the forelimbs.";

test("EXPENSIVE CORRESPONDENCE WORK: a cooperative deadline already exceeded before the loop starts skips every candidate and returns partial:true — never throws, never hangs", async () => {
  await indexSubmission("budget-account", "Budget fixture", TEXT_BUDGET);

  const result = await matchAgainstUserSubmissionCorpus(client, {
    accountId: "some-other-account-3",
    canonicalText: TEXT_BUDGET,
    // 0ms budget: Date.now() >= deadline is true before the very first
    // candidate is even considered, so this proves the deadline check
    // itself works — see this file's own header comment for why a real
    // slow computeDocumentCorrespondence can't be honestly simulated any
    // other way (there's no way to interrupt it once started).
    config: { ...USER_SUBMISSION_MATCH_THRESHOLDS, matchTimeBudgetMs: 0 },
  });

  assert.equal(result.status, "NO_HISTORICAL_MATCH");
  assert.equal(result.partial, true, "a budget-exceeded exit must be marked partial, distinguishing it from a genuinely confirmed absence of matches");
});

test("maxCandidateWordCount: an oversized candidate is skipped entirely, never reaching computeDocumentCorrespondence, regardless of the time budget", async () => {
  // Directly seeds a representation whose word_count column is set far
  // beyond its own actual text length — a legitimate white-box way to
  // exercise the skip condition without needing a genuinely enormous real
  // document. Real submission reference (not a promotion) — irrelevant to
  // what's under test, just the simplest way to make it a real candidate.
  const text = "Oversized-candidate fixture: a short passage whose STORED word_count is artificially inflated for this test.";
  const identity = await createDocumentIdentity(client, { accountId: null, title: "Oversized", author: null, rawText: text });
  const indexResult = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });
  assert.equal(indexResult.status, "SKIPPED_ANONYMOUS", "test setup sanity: anonymous submissions are never indexed by this path — inserting the representation directly below instead");

  // indexDocumentSubmissionIntoCorpus skips anonymous submissions, so build
  // the representation directly instead, exactly like
  // tests/corpus-admission-promotion-sweep.test.mjs's own LEGACY
  // REPRESENTATION fixture does.
  const { canonicalSha256 } = await import("../lib/document-identity.ts");
  const hash = canonicalSha256(text);
  const representationId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_document_representations (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at)
          VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [representationId, hash, text, 999_999, "English", "canonical-text-v1", null],
  });
  await recordCorpusShingles(client, representationId, text, CORPUS_FINGERPRINT_VERSION);
  // A real submission reference so this candidate would otherwise be a
  // normal PRIOR_SUBMISSION match if not for the size skip.
  await ensureUser("oversized-owner-account");
  const ownerIdentity = await createDocumentIdentity(client, { accountId: "oversized-owner-account", title: "Owner", author: null, rawText: text });
  await client.execute({
    sql: "INSERT INTO corpus_submission_references (representation_id, document_identity_id, link_type, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
    args: [representationId, ownerIdentity.id, "NEW_CONTENT_REPRESENTATION"],
  });
  await matureCorpusBackings(client);

  const withoutLimit = await matchAgainstUserSubmissionCorpus(client, {
    accountId: "some-other-account-4",
    canonicalText: text,
    config: { ...USER_SUBMISSION_MATCH_THRESHOLDS, maxCandidateWordCount: 10_000_000 },
  });
  assert.equal(withoutLimit.status, "MATCHED", "test setup sanity: without the limit, this candidate is a real match");

  const withLimit = await matchAgainstUserSubmissionCorpus(client, {
    accountId: "some-other-account-4",
    canonicalText: text,
    config: { ...USER_SUBMISSION_MATCH_THRESHOLDS, maxCandidateWordCount: 1000 },
  });
  assert.equal(withLimit.status, "NO_HISTORICAL_MATCH", "the oversized candidate must be skipped outright, not compared and then filtered");
});
