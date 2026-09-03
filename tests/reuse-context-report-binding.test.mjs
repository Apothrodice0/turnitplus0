import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { hashToken } from "../lib/auth-session.ts";
import {
  buildReuseContextEnvelope,
  firstEligiblePriorSubmissionRepresentationId,
  resolveCallerOwnedReportBinding,
} from "../lib/reuse-context-report-binding.ts";

/**
 * Server-side report-bound resolution + envelope building
 * (lib/reuse-context-report-binding.ts). Disposable local SQLite.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_reuse_context_report_binding.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const c = `${dbFile}${suffix}`;
  if (fs.existsSync(c)) fs.unlinkSync(c);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const c = `${dbFile}${suffix}`;
    try { fs.unlinkSync(c); } catch { /* ignore */ }
  }
});

let n = 0;
async function account(prefix) {
  n += 1;
  const id = `${prefix}-${n}`;
  await client.execute({ sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [id, `${id}@b.test`, id, "h"] });
  return id;
}
async function indexSub(accountId, rawText) {
  const identity = await createDocumentIdentity(client, { accountId, title: "d", author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return identity;
}
async function seed(accountId, documentIdentityId, rawText, { reportId } = {}) {
  n += 1;
  const rid = reportId ?? `b-${n}`;
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, document_identity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [rid, `d-${n}`, `s-${n}`, "d", new Date().toISOString(), 20, 0, "Low", JSON.stringify({ text: rawText }), accountId, documentIdentityId ?? null],
  });
  return rid;
}

const KEY = hashToken("binding-test-session-token-abcdefghij");

// --- resolveCallerOwnedReportBinding cardinality -------------------------

test("binding: exactly one caller-owned row -> OK with the exact document_identity_id", async () => {
  const acct = await account("ok");
  const identity = await indexSub(acct, "binding fixture body text canonicalizes into stable shingles");
  const reportId = await seed(acct, identity.id, "binding fixture body text canonicalizes into stable shingles");
  const b = await resolveCallerOwnedReportBinding(client, { reportId, accountId: acct });
  assert.equal(b.status, "OK");
  assert.equal(b.documentIdentityId, identity.id);
  assert.equal(b.rawText, "binding fixture body text canonicalizes into stable shingles");
});

test("binding: 0 caller-owned rows -> NOT_FOUND", async () => {
  const acct = await account("none");
  const b = await resolveCallerOwnedReportBinding(client, { reportId: "does-not-exist", accountId: acct });
  assert.equal(b.status, "NOT_FOUND");
});

test("binding: another account's report -> NOT_FOUND", async () => {
  const owner = await account("owner");
  const stranger = await account("stranger");
  const identity = await indexSub(owner, "cross account binding body text here for the matcher");
  const reportId = await seed(owner, identity.id, "cross account binding body text here for the matcher");
  const b = await resolveCallerOwnedReportBinding(client, { reportId, accountId: stranger });
  assert.equal(b.status, "NOT_FOUND");
});

test("binding: > 1 caller-owned (reportId, user_id) rows -> AMBIGUOUS (fail closed)", async () => {
  const acct = await account("dup");
  const identity = await indexSub(acct, "ambiguous binding body text for the matcher to canonicalize");
  const reportId = await seed(acct, identity.id, "ambiguous binding body text for the matcher to canonicalize");
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, document_identity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, `dup-dev-2`, "s2", "d", new Date().toISOString(), 20, 0, "Low", JSON.stringify({ text: "x" }), acct, identity.id],
  });
  const b = await resolveCallerOwnedReportBinding(client, { reportId, accountId: acct });
  assert.equal(b.status, "AMBIGUOUS");
});

test("binding: NULL document_identity_id -> REUSE_CONTEXT_UNAVAILABLE (fail closed)", async () => {
  const acct = await account("nullid");
  const reportId = await seed(acct, null, "no identity link");
  const b = await resolveCallerOwnedReportBinding(client, { reportId, accountId: acct });
  assert.equal(b.status, "REUSE_CONTEXT_UNAVAILABLE");
});

// --- firstEligiblePriorSubmissionRepresentationId ----------------------

function match(...entries) {
  return {
    status: "MATCHED", computedAt: "now", matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v",
    matches: entries.map((e) => ({
      relationshipType: e.rel, matchedRepresentationId: e.rep, matchType: "EXACT_CANONICAL_MATCH",
      containment: 1, matchedWordCount: 10, passageCount: 1, longestMatchWords: 10, passages: [], historicalSubmissionCount: 1,
    })),
  };
}

test("first-eligible: SELF at index 0 does not hide PRIOR_SUBMISSION at index 1", () => {
  assert.equal(
    firstEligiblePriorSubmissionRepresentationId(match({ rel: "SELF", rep: "rep-self" }, { rel: "PRIOR_SUBMISSION", rep: "rep-prior" })),
    "rep-prior",
  );
});

test("first-eligible: TURNITPLUS_CORPUS_SOURCE at index 0 does not hide PRIOR_SUBMISSION later", () => {
  assert.equal(
    firstEligiblePriorSubmissionRepresentationId(match({ rel: "TURNITPLUS_CORPUS_SOURCE", rep: "rep-corpus" }, { rel: "UNKNOWN_RELATIONSHIP", rep: "rep-unk" }, { rel: "PRIOR_SUBMISSION", rep: "rep-prior-2" })),
    "rep-prior-2",
  );
});

test("first-eligible: two PRIOR_SUBMISSION entries -> the first (deterministic order) only", () => {
  assert.equal(
    firstEligiblePriorSubmissionRepresentationId(match({ rel: "PRIOR_SUBMISSION", rep: "rep-A" }, { rel: "PRIOR_SUBMISSION", rep: "rep-B" })),
    "rep-A",
  );
});

test("first-eligible: no PRIOR_SUBMISSION -> null; non-MATCHED -> null", () => {
  assert.equal(firstEligiblePriorSubmissionRepresentationId(match({ rel: "SELF", rep: "x" })), null);
  assert.equal(firstEligiblePriorSubmissionRepresentationId(undefined), null);
  assert.equal(firstEligiblePriorSubmissionRepresentationId({ status: "NO_HISTORICAL_MATCH" }), null);
});

// --- buildReuseContextEnvelope shape / privacy ------------------------

test("envelope: no PRIOR_SUBMISSION match -> available:false, empty, id-free", async () => {
  const acct = await account("env-empty");
  const identity = await indexSub(acct, "envelope empty fixture body text canonicalizes for the matcher");
  await seed(acct, identity.id, "envelope empty fixture body text canonicalizes for the matcher", { reportId: "env-empty-rpt" });
  const env = await buildReuseContextEnvelope(client, {
    reportId: "env-empty-rpt", documentIdentityId: identity.id, accountId: acct, sessionKey: KEY,
    historicalSubmissionMatch: { status: "NO_HISTORICAL_MATCH" },
  });
  assert.equal(env.reportId, "env-empty-rpt");
  assert.equal(env.declare.available, false);
  assert.deepEqual(env.declare.activeDeclarations, []);
  assert.deepEqual(env.confirm.pending, []);
  assert.deepEqual(env.confirm.confirmed, []);
  assert.ok(!JSON.stringify(env).includes(identity.id), "no document identity id in the envelope");
});

test("envelope: matches present but none PRIOR_SUBMISSION -> unavailableReason NO_PRIOR_SUBMISSION_MATCH", async () => {
  const acct = await account("env-nopr");
  const identity = await indexSub(acct, "envelope no-prior fixture body text for the matcher here");
  await seed(acct, identity.id, "envelope no-prior fixture body text for the matcher here", { reportId: "env-nopr-rpt" });
  const env = await buildReuseContextEnvelope(client, {
    reportId: "env-nopr-rpt", documentIdentityId: identity.id, accountId: acct, sessionKey: KEY,
    historicalSubmissionMatch: match({ rel: "SELF", rep: "rep-self-x" }),
  });
  assert.equal(env.declare.available, false);
  assert.equal(env.declare.unavailableReason, "NO_PRIOR_SUBMISSION_MATCH");
});

test("envelope: an active declaration surfaces as an id-free entry with a session-bound actionRef and isCurrent", async () => {
  const original = await account("env-orig");
  const reuser = await account("env-reuse");
  const text = "envelope active-declaration fixture body text that canonicalizes for matching";
  const originalIdentity = await indexSub(original, text);
  const reuserIdentity = await indexSub(reuser, text);
  const ref = await client.execute({ sql: "SELECT id FROM corpus_submission_references WHERE document_identity_id = ?", args: [originalIdentity.id] });
  await client.execute({
    sql: `INSERT INTO reuse_context_declarations (document_identity_id, matched_representation_id, matched_submission_reference_id, declared_context, declared_by_account_id, declared_at, verification_state, created_at)
          VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,'SELF_ASSERTED_UNVERIFIED',CURRENT_TIMESTAMP)`,
    args: [reuserIdentity.id, "rep-current-x", Number(ref.rows[0].id), "SUPERVISOR_COPY", reuser],
  });
  await seed(reuser, reuserIdentity.id, text, { reportId: "env-active-rpt" });

  const env = await buildReuseContextEnvelope(client, {
    reportId: "env-active-rpt", documentIdentityId: reuserIdentity.id, accountId: reuser, sessionKey: KEY,
    historicalSubmissionMatch: match({ rel: "PRIOR_SUBMISSION", rep: "rep-current-x" }),
  });
  assert.equal(env.declare.activeDeclarations.length, 1);
  const d = env.declare.activeDeclarations[0];
  assert.deepEqual(Object.keys(d).sort(), ["actionRef", "declaredContext", "isCurrent", "state"].sort());
  assert.match(d.actionRef, /^[0-9a-f]{64}$/);
  assert.equal(d.isCurrent, true);
  // different session key -> different actionRef
  const env2 = await buildReuseContextEnvelope(client, {
    reportId: "env-active-rpt", documentIdentityId: reuserIdentity.id, accountId: reuser, sessionKey: hashToken("a-completely-different-session"),
    historicalSubmissionMatch: match({ rel: "PRIOR_SUBMISSION", rep: "rep-current-x" }),
  });
  assert.notEqual(env2.declare.activeDeclarations[0].actionRef, d.actionRef);
});

test("envelope: a MUTUALLY_CONFIRMED declaration referencing the original report appears in confirm.confirmed[], id-free", async () => {
  const original = await account("env-conf-orig");
  const reuser = await account("env-conf-reuse");
  const text = "envelope confirmed-declaration fixture body text for the matcher to canonicalize";
  const originalIdentity = await indexSub(original, text);
  const reuserIdentity = await indexSub(reuser, text);
  const ref = await client.execute({ sql: "SELECT id FROM corpus_submission_references WHERE document_identity_id = ?", args: [originalIdentity.id] });
  await client.execute({
    sql: `INSERT INTO reuse_context_declarations (document_identity_id, matched_representation_id, matched_submission_reference_id, declared_context, declared_by_account_id, declared_at, confirmed_by_account_id, confirmed_at, verification_state, created_at)
          VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,?,CURRENT_TIMESTAMP,'MUTUALLY_CONFIRMED',CURRENT_TIMESTAMP)`,
    args: [reuserIdentity.id, "rep-conf-x", Number(ref.rows[0].id), "COAUTHOR_COPY", reuser, original],
  });
  await seed(original, originalIdentity.id, text, { reportId: "env-conf-rpt" });

  const env = await buildReuseContextEnvelope(client, {
    reportId: "env-conf-rpt", documentIdentityId: originalIdentity.id, accountId: original, sessionKey: KEY,
    historicalSubmissionMatch: { status: "NO_HISTORICAL_MATCH" },
  });
  assert.deepEqual(env.confirm.pending, []);
  assert.equal(env.confirm.confirmed.length, 1);
  const c = env.confirm.confirmed[0];
  assert.deepEqual(Object.keys(c).sort(), ["actionRef", "confirmedDate", "declaredContext"].sort());
  assert.match(c.actionRef, /^[0-9a-f]{64}$/);
  assert.equal(c.declaredContext, "COAUTHOR_COPY");
  assert.ok(!JSON.stringify(env).includes(reuserIdentity.id) && !JSON.stringify(env).includes(originalIdentity.id));
});

test("STRUCTURAL: binding module references no score/scoring identifier and no matcher import", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const src = strip(fs.readFileSync(path.join(repoRoot, "lib/reuse-context-report-binding.ts"), "utf8"));
  assert.doesNotMatch(src, /archiveScore|aiScore|verifiedSimilarity|\.score\b|\bscore\s*[:=]/i);
  assert.doesNotMatch(src, /matchAgainstUserSubmissionCorpus|getOrComputeHistoricalMatchSnapshot/, "the matcher is passed in, never imported here");
});
