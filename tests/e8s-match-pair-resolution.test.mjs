import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { resolveExactMatchPairReference } from "../lib/e8s-match-pair-resolution.ts";

/**
 * Phase E8S Step 3: local-only tests for resolveExactMatchPairReference.
 * Same test-db-per-file pattern as tests/user-submission-matching.test.mjs
 * — a throwaway local libsql file, migrated fresh, deleted on completion.
 * No production connection anywhere in this file.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_e8s_match_pair_resolution.db");
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

test("A: one prior reference -> exact reference returned", async () => {
  const text = "Fixture body for test A, long enough to canonicalize deterministically, paragraph one of its own filler content.";
  const { indexResult: ref1 } = await indexSubmission("acct-a1", "doc", text);
  const { identity: identity2 } = await indexSubmission("acct-a2", "doc", text);

  const result = await resolveExactMatchPairReference(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
  });

  assert.equal(result.representationId, ref1.representationId);
  assert.equal(result.ambiguous, false);
  assert.equal(result.referenceId, ref1.submissionReferenceId);
});

test("B: multiple references -> ambiguous", async () => {
  const text = "Fixture body for test B, distinct from every other fixture in this file, paragraph one of its own filler content.";
  const { indexResult: ref1 } = await indexSubmission("acct-b1", "doc", text);
  await indexSubmission("acct-b2", "doc", text);
  const { identity: identity3 } = await indexSubmission("acct-b3", "doc", text);

  const result = await resolveExactMatchPairReference(client, {
    documentIdentityId: identity3.id,
    representationId: ref1.representationId,
  });

  assert.equal(result.ambiguous, true);
  assert.equal(result.referenceId, null, "no reference id may be returned once the match pair is ambiguous");
});

test("C: SELF case -- current identity excluded correctly, same account's own other reference still resolves", async () => {
  const text = "Fixture body for test C, a same-account repeat submission scenario, paragraph one of its own filler content.";
  const { indexResult: ref1 } = await indexSubmission("acct-c1", "doc-v1", text);
  // Same account resubmits (a distinct document_identities row, per lib/document-identity.ts's own "always inserts" design).
  const { identity: identity2 } = await indexSubmission("acct-c1", "doc-v2", text);

  const result = await resolveExactMatchPairReference(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
  });

  assert.equal(result.ambiguous, false);
  assert.equal(
    result.referenceId,
    ref1.submissionReferenceId,
    "the same account's own earlier reference must still resolve -- this function is relationship-blind by design and must not special-case SELF",
  );
});

test("D: cross-account case -- exact source returned when unique", async () => {
  const text = "Fixture body for test D, a two-different-accounts scenario, paragraph one of its own filler content.";
  const { indexResult: ref1 } = await indexSubmission("acct-d1", "doc", text);
  const { identity: identity2 } = await indexSubmission("acct-d2", "doc", text);

  const result = await resolveExactMatchPairReference(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
  });

  assert.equal(result.ambiguous, false);
  assert.equal(result.referenceId, ref1.submissionReferenceId);
});

test("E: no candidate -> no pair (distinguished from ambiguous by the ambiguous flag being false)", async () => {
  const text = "Fixture body for test E, submitted exactly once, paragraph one of its own filler content.";
  const { identity, indexResult } = await indexSubmission("acct-e1", "doc", text);

  const result = await resolveExactMatchPairReference(client, {
    documentIdentityId: identity.id,
    representationId: indexResult.representationId,
  });

  assert.equal(result.ambiguous, false);
  assert.equal(result.referenceId, null);
});

test("F: no privacy leakage -- bounded return shape, and the resolver never queries document_identities or users at all", async () => {
  const text = "Fixture body for test F, the privacy-shape assertion, paragraph one of its own filler content.";
  const { indexResult: ref1 } = await indexSubmission("acct-f1", "doc", text);
  const { identity: identity2 } = await indexSubmission("acct-f2", "doc", text);

  const result = await resolveExactMatchPairReference(client, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
  });

  const keys = Object.keys(result).sort();
  assert.deepEqual(keys, ["ambiguous", "referenceId", "representationId"], "only these three bounded fields may ever be returned");
  assert.equal(typeof result.representationId, "string");
  assert.equal(typeof result.ambiguous, "boolean");
  assert.ok(result.referenceId === null || typeof result.referenceId === "number");

  // stripComments avoids the recurring self-referential false positive seen
  // elsewhere in this repo (e.g. tests/report-historical-ui-consolidation.test.mjs's
  // own test H): this file's own header comment names document_identities/
  // users by name to explain why the SQL below never queries them.
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  const source = stripComments(fs.readFileSync(path.join(repoRoot, "lib/e8s-match-pair-resolution.ts"), "utf8"));
  assert.doesNotMatch(
    source,
    /document_identities|\busers\b|account_id|\bemail\b/i,
    "the resolver must never join to document_identities or users, and must never reference account_id/email -- privacy must be structural, not just an unused field",
  );
});
