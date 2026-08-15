import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import {
  declareReuseContext,
  confirmReuseContext,
  revokeReuseContext,
  getActiveReuseContextDeclaration,
  getDeclarationsReferencingSubmission,
  canDeclareReuseContext,
} from "../lib/reuse-context-declarations.ts";

/**
 * Phase E8S Step 4: local-only, disposable-SQLite tests for the
 * reuse-context declaration write/read layer. Same test-db-per-file
 * pattern as tests/e8s-match-pair-resolution.test.mjs and
 * tests/user-submission-matching.test.mjs — a throwaway local libsql file,
 * migrated fresh (including drizzle/0022_reuse_context_declarations.sql),
 * deleted on completion. No production connection anywhere in this file.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_reuse_context_declarations.db");
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
  if (knownUsers.has(accountId)) return;
  knownUsers.add(accountId);
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
}

async function indexSubmission(accountId, title, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  const indexResult = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return { identity, indexResult };
}

async function activeRowCount(documentIdentityId, representationId) {
  const r = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM reuse_context_declarations WHERE document_identity_id = ? AND matched_representation_id = ? AND revoked_at IS NULL",
    args: [documentIdentityId, representationId],
  });
  return Number(r.rows[0].n);
}
async function totalRowCount(documentIdentityId, representationId) {
  const r = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM reuse_context_declarations WHERE document_identity_id = ? AND matched_representation_id = ?",
    args: [documentIdentityId, representationId],
  });
  return Number(r.rows[0].n);
}

test("A: one-sided declaration succeeds", async () => {
  const text = "Fixture body for test A, long enough to canonicalize deterministically.";
  const { indexResult: ref1 } = await indexSubmission("acct-a1", "doc", text);
  const { identity: identity2 } = await indexSubmission("acct-a2", "doc", text);

  const result = await declareReuseContext(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: "acct-a2",
    declaredContext: "COAUTHOR_COPY",
  });

  assert.equal(result.status, "DECLARED");
  assert.equal(result.declaration.representationId, ref1.representationId);
  assert.equal(result.declaration.declaredContext, "COAUTHOR_COPY");
  assert.equal(result.declaration.verificationState, "SELF_ASSERTED_UNVERIFIED");
  assert.equal(result.declaration.confirmedAt, null);
  assert.equal(result.declaration.revokedAt, null);
});

test("B: ambiguous pair refused", async () => {
  const text = "Fixture body for test B, distinct from every other fixture in this file.";
  const { indexResult: ref1 } = await indexSubmission("acct-b1", "doc", text);
  await indexSubmission("acct-b2", "doc", text);
  const { identity: identity3 } = await indexSubmission("acct-b3", "doc", text);

  const result = await declareReuseContext(client, {
    documentIdentityId: identity3.id,
    representationId: ref1.representationId,
    declaredByAccountId: "acct-b3",
    declaredContext: "OTHER_AUTHORIZED_REUSE",
  });

  assert.equal(result.status, "AMBIGUOUS_MATCH_PAIR");
  assert.equal(await totalRowCount(identity3.id, ref1.representationId), 0, "no row may be inserted for an ambiguous pair");
});

test("C: no pair refused", async () => {
  const text = "Fixture body for test C, submitted exactly once, no candidate to declare against.";
  const { identity, indexResult } = await indexSubmission("acct-c1", "doc", text);

  const result = await declareReuseContext(client, {
    documentIdentityId: identity.id,
    representationId: indexResult.representationId,
    declaredByAccountId: "acct-c1",
    declaredContext: "OTHER_AUTHORIZED_REUSE",
  });

  assert.equal(result.status, "NO_MATCH_PAIR");
  assert.equal(await totalRowCount(identity.id, indexResult.representationId), 0);
});

test("D: wrong declarer rejected", async () => {
  const text = "Fixture body for test D, a two-different-accounts scenario for the declarer check.";
  const { indexResult: ref1 } = await indexSubmission("acct-d1", "doc", text);
  const { identity: identity2 } = await indexSubmission("acct-d2", "doc", text);

  const result = await declareReuseContext(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: "acct-d-impostor", // not the account backing identity2
    declaredContext: "SUPERVISOR_COPY",
  });

  assert.equal(result.status, "DECLARER_NOT_SUBMISSION_OWNER");
  assert.equal(await totalRowCount(identity2.id, ref1.representationId), 0);
});

// Shared fixture builder for the confirm/revoke lifecycle tests (E-K).
async function declaredFixture(marker) {
  const text = `Fixture body for lifecycle tests, marker ${marker}, long enough to canonicalize deterministically.`;
  const { indexResult: ref1 } = await indexSubmission(`acct-${marker}-original`, "doc", text);
  const { identity: identity2 } = await indexSubmission(`acct-${marker}-reuser`, "doc", text);
  const declared = await declareReuseContext(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: `acct-${marker}-reuser`,
    declaredContext: "SUPERVISOR_COPY",
  });
  assert.equal(declared.status, "DECLARED", `fixture setup for marker ${marker} must succeed`);
  return { originalAccountId: `acct-${marker}-original`, reuserAccountId: `acct-${marker}-reuser`, identity2, ref1, declaration: declared.declaration };
}

test("E: correct original submitter confirms", async () => {
  const { originalAccountId, declaration } = await declaredFixture("e");
  const result = await confirmReuseContext(client, { declarationId: declaration.id, confirmingAccountId: originalAccountId });
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.declaration.verificationState, "MUTUALLY_CONFIRMED");
  assert.notEqual(result.declaration.confirmedAt, null);
});

test("F: wrong confirmer rejected", async () => {
  const { declaration } = await declaredFixture("f");
  const result = await confirmReuseContext(client, { declarationId: declaration.id, confirmingAccountId: "acct-f-unrelated-stranger" });
  assert.equal(result.status, "NOT_ORIGINAL_SUBMITTER");

  const raw = await client.execute({ sql: "SELECT verification_state, confirmed_at FROM reuse_context_declarations WHERE id = ?", args: [declaration.id] });
  assert.equal(raw.rows[0].verification_state, "SELF_ASSERTED_UNVERIFIED", "a rejected confirmer must never advance the state");
  assert.equal(raw.rows[0].confirmed_at, null);
});

test("G: declarer cannot self-confirm", async () => {
  const { reuserAccountId, declaration } = await declaredFixture("g");
  const result = await confirmReuseContext(client, { declarationId: declaration.id, confirmingAccountId: reuserAccountId });
  assert.equal(result.status, "SELF_CONFIRMATION_REJECTED");
});

test("H: revoke works", async () => {
  const { reuserAccountId, declaration } = await declaredFixture("h");
  const result = await revokeReuseContext(client, { declarationId: declaration.id, revokedByAccountId: reuserAccountId });
  assert.equal(result.status, "REVOKED");
  assert.equal(result.declaration.verificationState, "REVOKED");
  assert.notEqual(result.declaration.revokedAt, null);
});

test("I: revoked row retained (never deleted)", async () => {
  const { reuserAccountId, identity2, ref1, declaration } = await declaredFixture("i");
  await revokeReuseContext(client, { declarationId: declaration.id, revokedByAccountId: reuserAccountId });

  const raw = await client.execute({ sql: "SELECT id, revoked_at FROM reuse_context_declarations WHERE id = ?", args: [declaration.id] });
  assert.equal(raw.rows.length, 1, "the row must still exist after revocation");
  assert.notEqual(raw.rows[0].revoked_at, null);
  assert.equal(await totalRowCount(identity2.id, ref1.representationId), 1, "revoke must not add or remove rows, only mark this one");
});

test("J: revoked pair can receive a new declaration", async () => {
  const { reuserAccountId, identity2, ref1, declaration } = await declaredFixture("j");
  await revokeReuseContext(client, { declarationId: declaration.id, revokedByAccountId: reuserAccountId });

  const redeclared = await declareReuseContext(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: reuserAccountId,
    declaredContext: "COAUTHOR_COPY",
  });
  assert.equal(redeclared.status, "DECLARED");
  assert.notEqual(redeclared.declaration.id, declaration.id, "a re-declaration is a new row, never an edit of the revoked one");

  const active = await getActiveReuseContextDeclaration(client, { documentIdentityId: identity2.id, representationId: ref1.representationId });
  assert.equal(active.id, redeclared.declaration.id);
  assert.equal(await totalRowCount(identity2.id, ref1.representationId), 2, "both the revoked row and the new active row must be retained");
});

test("K: duplicate active declaration refused", async () => {
  const { reuserAccountId, identity2, ref1 } = await declaredFixture("k");
  const second = await declareReuseContext(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: reuserAccountId,
    declaredContext: "INSTITUTIONAL_SUBMISSION",
  });
  assert.equal(second.status, "ALREADY_ACTIVE");
  assert.equal(await activeRowCount(identity2.id, ref1.representationId), 1);
});

test("L (structural): the module never references score/archiveScore/aiScore/verifiedSimilarity", () => {
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  const source = stripComments(fs.readFileSync(path.join(repoRoot, "lib/reuse-context-declarations.ts"), "utf8"));
  assert.doesNotMatch(source, /\bscore\b|archiveScore|aiScore|verifiedSimilarity/i);
});

test("M: no PII/document text leakage -- bounded DTO shape and no forbidden columns queried", async () => {
  const text = "Fixture body for test M, the privacy-shape assertion for the declaration layer.";
  const { indexResult: ref1 } = await indexSubmission("acct-m1", "doc", text);
  const { identity: identity2 } = await indexSubmission("acct-m2", "doc", text);
  const declared = await declareReuseContext(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: "acct-m2",
    declaredContext: "AUTHORIZED_ARCHIVAL_COPY",
  });
  assert.equal(declared.status, "DECLARED");
  const confirmed = await confirmReuseContext(client, { declarationId: declared.declaration.id, confirmingAccountId: "acct-m1" });
  assert.equal(confirmed.status, "CONFIRMED");

  for (const view of [declared.declaration, confirmed.declaration]) {
    const keys = Object.keys(view).sort();
    assert.deepEqual(keys, ["confirmedAt", "declaredAt", "declaredContext", "id", "representationId", "revokedAt", "verificationState"]);
    for (const [key, value] of Object.entries(view)) {
      assert.ok(!/account/i.test(key), `DTO key "${key}" must not reference an account`);
      if (typeof value === "string") {
        assert.notEqual(value, "acct-m1");
        assert.notEqual(value, "acct-m2");
        assert.doesNotMatch(value, /@/, "no email-shaped string should ever appear in a declaration view");
      }
    }
  }

  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  const source = stripComments(fs.readFileSync(path.join(repoRoot, "lib/reuse-context-declarations.ts"), "utf8"));
  assert.doesNotMatch(source, /canonical_text|raw_sha256|password_hash|\bemail\b|\btitle\b|\bauthor\b/i, "the module must never select document text, hashes, or account-profile fields");
});

test("N: SELF does not create an authorization declaration", async () => {
  const text = "Fixture body for test N, a same-account repeat submission scenario for the SELF refusal.";
  const { indexResult: ref1 } = await indexSubmission("acct-n1", "doc-v1", text);
  const { identity: identity2 } = await indexSubmission("acct-n1", "doc-v2", text); // SAME account resubmits

  const result = await declareReuseContext(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: "acct-n1",
    declaredContext: "OTHER_AUTHORIZED_REUSE",
  });

  assert.equal(result.status, "SELF_RELATIONSHIP_NOT_DECLARABLE");
  assert.equal(await totalRowCount(identity2.id, ref1.representationId), 0);
});

test("O: concurrent declarations preserve exactly one active row", async () => {
  const text = "Fixture body for test O, the concurrency race scenario.";
  const { indexResult: ref1 } = await indexSubmission("acct-o1", "doc", text);
  const { identity: identity2 } = await indexSubmission("acct-o2", "doc", text);

  const params = {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: "acct-o2",
    declaredContext: "COAUTHOR_COPY",
  };
  const [r1, r2] = await Promise.all([
    declareReuseContext(client, params),
    declareReuseContext(client, params),
  ]);

  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, ["ALREADY_ACTIVE", "DECLARED"], "exactly one concurrent call must win");
  assert.equal(await activeRowCount(identity2.id, ref1.representationId), 1);
});

test("requirement 5 (identity missing): declaring against a nonexistent document_identity_id is refused", async () => {
  const text = "Fixture body for the identity-missing refusal check.";
  const { indexResult: ref1 } = await indexSubmission("acct-p1", "doc", text);
  const result = await declareReuseContext(client, {
    documentIdentityId: "00000000-0000-0000-0000-000000000000",
    representationId: ref1.representationId,
    declaredByAccountId: "acct-p1",
    declaredContext: "OTHER_AUTHORIZED_REUSE",
  });
  assert.equal(result.status, "IDENTITY_NOT_FOUND");
});

test("requirement 5 (representation missing): declaring against a nonexistent representation is refused", async () => {
  const text = "Fixture body for the representation-missing refusal check.";
  const { identity } = await indexSubmission("acct-q1", "doc", text);
  const result = await declareReuseContext(client, {
    documentIdentityId: identity.id,
    representationId: "00000000-0000-0000-0000-000000000000",
    declaredByAccountId: "acct-q1",
    declaredContext: "OTHER_AUTHORIZED_REUSE",
  });
  assert.equal(result.status, "REPRESENTATION_NOT_FOUND");
});

// =============================================================================
// Phase E8S Step 6: unit coverage for the three lib extensions this phase
// added (reverse lookup, the revoke-authorization fix, and the read-only
// ambiguity check). End-to-end coverage through the real HTTP routes lives
// in tests/reuse-context-routes.test.mjs.
// =============================================================================

test("Step 6 / reverse lookup: getDeclarationsReferencingSubmission finds active declarations against my submission, and excludes revoked ones", async () => {
  const text = "Fixture body for the Step 6 reverse-lookup unit test.";
  const { indexResult: ref1, identity: identity1 } = await indexSubmission("acct-rl1", "doc", text);
  const { identity: identity2 } = await indexSubmission("acct-rl2", "doc", text);

  assert.deepEqual(await getDeclarationsReferencingSubmission(client, { documentIdentityId: identity1.id }), []);

  const declared = await declareReuseContext(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: "acct-rl2",
    declaredContext: "COAUTHOR_COPY",
  });
  assert.equal(declared.status, "DECLARED");

  const pending = await getDeclarationsReferencingSubmission(client, { documentIdentityId: identity1.id });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, declared.declaration.id);

  // A reverse lookup from the DECLARER's own identity must not find their own declaration -- it references identity1, not identity2.
  assert.deepEqual(await getDeclarationsReferencingSubmission(client, { documentIdentityId: identity2.id }), []);

  await revokeReuseContext(client, { declarationId: declared.declaration.id, revokedByAccountId: "acct-rl2" });
  assert.deepEqual(await getDeclarationsReferencingSubmission(client, { documentIdentityId: identity1.id }), [], "a revoked declaration must not appear in the reverse lookup");
});

test("Step 6 / revoke-authorization fix: the original submitter can reject a declaration they never confirmed", async () => {
  const text = "Fixture body for the Step 6 revoke-authorization-fix unit test.";
  const { indexResult: ref1 } = await indexSubmission("acct-rv1", "doc", text);
  const { identity: identity2 } = await indexSubmission("acct-rv2", "doc", text);
  const declared = await declareReuseContext(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: "acct-rv2",
    declaredContext: "SUPERVISOR_COPY",
  });
  assert.equal(declared.status, "DECLARED");

  // acct-rv1 is the ORIGINAL submitter -- never declared_by, never confirmed_by.
  // Before the Step 6 fix, revokeReuseContext only authorized declared_by/confirmed_by and would have returned NOT_AUTHORIZED_TO_REVOKE here.
  const result = await revokeReuseContext(client, { declarationId: declared.declaration.id, revokedByAccountId: "acct-rv1" });
  assert.equal(result.status, "REVOKED");
  assert.equal(result.declaration.confirmedAt, null, "rejected without ever having been confirmed");
});

test("Step 6 / revoke-authorization fix: a genuine stranger still cannot revoke", async () => {
  const text = "Fixture body for the Step 6 revoke-authorization-fix stranger test.";
  const { indexResult: ref1 } = await indexSubmission("acct-rvs1", "doc", text);
  const { identity: identity2 } = await indexSubmission("acct-rvs2", "doc", text);
  const declared = await declareReuseContext(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: "acct-rvs2",
    declaredContext: "SUPERVISOR_COPY",
  });
  assert.equal(declared.status, "DECLARED");

  const result = await revokeReuseContext(client, { declarationId: declared.declaration.id, revokedByAccountId: "acct-rvs-stranger" });
  assert.equal(result.status, "NOT_AUTHORIZED_TO_REVOKE");
});

test("Step 6 / canDeclareReuseContext: reasons match declareReuseContext's own refusal conditions exactly, without writing anything", async () => {
  const text = "Fixture body for the Step 6 canDeclareReuseContext unit test.";
  const { indexResult: ref1 } = await indexSubmission("acct-cd1", "doc", text);
  const { identity: identity2 } = await indexSubmission("acct-cd2", "doc", text);

  const ok = await canDeclareReuseContext(client, { documentIdentityId: identity2.id, representationId: ref1.representationId, accountId: "acct-cd2" });
  assert.deepEqual(ok, { canDeclare: true });

  const notOwner = await canDeclareReuseContext(client, { documentIdentityId: identity2.id, representationId: ref1.representationId, accountId: "acct-cd-stranger" });
  assert.deepEqual(notOwner, { canDeclare: false, reason: "NOT_SUBMISSION_OWNER" });

  const missingIdentity = await canDeclareReuseContext(client, { documentIdentityId: "00000000-0000-0000-0000-000000000000", representationId: ref1.representationId, accountId: "acct-cd2" });
  assert.deepEqual(missingIdentity, { canDeclare: false, reason: "IDENTITY_NOT_FOUND" });

  const missingRepresentation = await canDeclareReuseContext(client, { documentIdentityId: identity2.id, representationId: "00000000-0000-0000-0000-000000000000", accountId: "acct-cd2" });
  assert.deepEqual(missingRepresentation, { canDeclare: false, reason: "REPRESENTATION_NOT_FOUND" });

  const declared = await declareReuseContext(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredByAccountId: "acct-cd2",
    declaredContext: "COAUTHOR_COPY",
  });
  assert.equal(declared.status, "DECLARED");
  const alreadyActive = await canDeclareReuseContext(client, { documentIdentityId: identity2.id, representationId: ref1.representationId, accountId: "acct-cd2" });
  assert.deepEqual(alreadyActive, { canDeclare: false, reason: "ALREADY_ACTIVE" });

  // Genuine SELF relationship, on an isolated fixture with exactly two
  // submitters (both the same account) -- reusing `text`/ref1 above would
  // now have three total submitters (acct-cd1, acct-cd2, and a resubmit),
  // making the pair ambiguous rather than a clean single-candidate SELF case.
  const selfText = "A separate fixture body isolated to the SELF-relationship sub-case only.";
  const { indexResult: selfRef1 } = await indexSubmission("acct-cd-self", "doc-v1", selfText);
  const { identity: selfIdentity2 } = await indexSubmission("acct-cd-self", "doc-v2", selfText);
  const selfRelationship = await canDeclareReuseContext(client, { documentIdentityId: selfIdentity2.id, representationId: selfRef1.representationId, accountId: "acct-cd-self" });
  assert.deepEqual(selfRelationship, { canDeclare: false, reason: "SELF_RELATIONSHIP" });
});

test("Step 6 / canDeclareReuseContext: ambiguous pair", async () => {
  const text = "Fixture body for the Step 6 canDeclareReuseContext ambiguity unit test.";
  const { indexResult: ref1 } = await indexSubmission("acct-amb1", "doc", text);
  await indexSubmission("acct-amb2", "doc", text);
  const { identity: identity3 } = await indexSubmission("acct-amb3", "doc", text);

  const result = await canDeclareReuseContext(client, { documentIdentityId: identity3.id, representationId: ref1.representationId, accountId: "acct-amb3" });
  assert.deepEqual(result, { canDeclare: false, reason: "AMBIGUOUS" });
});
