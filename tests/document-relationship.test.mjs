import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { recordDocumentIdentityShingles, createFamily, attachIdentityToFamily } from "../lib/document-family.ts";
import { classifySubmitterRelationship, classifyFamilyRelationships } from "../lib/document-relationship.ts";

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_document_relationship.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["rel-account-a", "rel-a@example.com", "relaccounta", "hash-a"],
});
await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["rel-account-b", "rel-b@example.com", "relaccountb", "hash-b"],
});

// --- Pure function: classifySubmitterRelationship ---

test("same non-null account on both sides is SELF", () => {
  assert.equal(classifySubmitterRelationship("acct-1", "acct-1"), "SELF");
});

test("different non-null accounts is PRIOR_SUBMISSION", () => {
  assert.equal(classifySubmitterRelationship("acct-1", "acct-2"), "PRIOR_SUBMISSION");
});

test("target anonymous (null) is PRIOR_SUBMISSION, even if the other side matches nothing in particular", () => {
  assert.equal(classifySubmitterRelationship(null, "acct-2"), "PRIOR_SUBMISSION");
});

test("other side anonymous (null) is PRIOR_SUBMISSION, even though the target has an account", () => {
  assert.equal(classifySubmitterRelationship("acct-1", null), "PRIOR_SUBMISSION");
});

test("both sides anonymous (null) is PRIOR_SUBMISSION, not SELF — two unknown submitters are not proven to be the same submitter", () => {
  assert.equal(classifySubmitterRelationship(null, null), "PRIOR_SUBMISSION");
});

// --- classifyFamilyRelationships: integration over a real family ---

test("an identity with no family classifies as having no relationships", async () => {
  const created = await createDocumentIdentity(client, {
    accountId: "rel-account-a",
    title: null,
    author: null,
    rawText: "A lone document with nothing else in its family, used only by this test.",
  });
  const relationships = await classifyFamilyRelationships(client, created.id);
  assert.deepEqual(relationships, []);
});

test("within a three-member family, SELF and PRIOR_SUBMISSION are classified correctly and are relative to the identity being asked about, not absolute", async () => {
  // Build a family with: two members from account A (a genuine revision
  // pair) and one member from account B (an exact-text match). This directly
  // exercises Required scenario framing: relative to the account-B member,
  // BOTH account-A members must read as PRIOR_SUBMISSION; relative to either
  // account-A member, the OTHER account-A member must read as SELF and the
  // account-B member must read as PRIOR_SUBMISSION.
  const base = "Climatologists reconstructing centuries of tree-ring data from alpine forests identified recurring drought cycles correlating with documented historical famines. Cross-referencing these findings against regional agricultural records revealed that crop failure frequency tracked closely with reconstructed precipitation deficits. These correlations offer a longer baseline for evaluating current drought severity than instrumental records alone provide.";
  const revised = "Climatologists reconstructing centuries of tree-ring data from alpine forests identified recurring drought cycles correlating with documented historical famines. Cross-referencing these findings against regional agricultural records revealed that crop failure frequency tracked closely with reconstructed rainfall deficits. These correlations offer a longer baseline for evaluating current drought intensity than instrumental records alone provide.";

  const accountAOriginal = await createDocumentIdentity(client, { accountId: "rel-account-a", title: null, author: null, rawText: base });
  await recordDocumentIdentityShingles(client, accountAOriginal.id, base);
  const family = await createFamily(client);
  await attachIdentityToFamily(client, {
    familyId: family.id,
    documentIdentityId: accountAOriginal.id,
    matchType: "SEED",
    matchedAgainstIdentityId: null,
    evidenceScore: null,
  });

  const accountARevision = await createDocumentIdentity(client, { accountId: "rel-account-a", title: null, author: null, rawText: revised });
  await recordDocumentIdentityShingles(client, accountARevision.id, revised);
  await attachIdentityToFamily(client, {
    familyId: family.id,
    documentIdentityId: accountARevision.id,
    matchType: "STRONG_TEXT_MATCH",
    matchedAgainstIdentityId: accountAOriginal.id,
    evidenceScore: 0.9,
  });

  const accountBExact = await createDocumentIdentity(client, { accountId: "rel-account-b", title: null, author: null, rawText: base });
  await recordDocumentIdentityShingles(client, accountBExact.id, base);
  await attachIdentityToFamily(client, {
    familyId: family.id,
    documentIdentityId: accountBExact.id,
    matchType: "EXACT_CANONICAL_MATCH",
    matchedAgainstIdentityId: accountAOriginal.id,
    evidenceScore: 1,
  });

  // Relative to the first account-A member.
  const relativeToOriginal = await classifyFamilyRelationships(client, accountAOriginal.id);
  const byId1 = new Map(relativeToOriginal.map((r) => [r.documentIdentityId, r]));
  assert.equal(byId1.get(accountARevision.id).relationship, "SELF", "the same account's revision must read as SELF");
  assert.equal(byId1.get(accountBExact.id).relationship, "PRIOR_SUBMISSION", "a different account's exact match must read as PRIOR_SUBMISSION");
  assert.equal(relativeToOriginal.length, 2, "must list every other member, not just the one it was matched against");

  // Relative to the account-B member — the relationship must flip
  // appropriately for both other members, proving this is genuinely
  // relative-to-perspective and not a value cached once and reused blindly.
  const relativeToStranger = await classifyFamilyRelationships(client, accountBExact.id);
  const byId2 = new Map(relativeToStranger.map((r) => [r.documentIdentityId, r]));
  assert.equal(byId2.get(accountAOriginal.id).relationship, "PRIOR_SUBMISSION");
  assert.equal(byId2.get(accountARevision.id).relationship, "PRIOR_SUBMISSION");

  // The identity being asked about is never included in its own relationship list.
  assert.ok(!byId1.has(accountAOriginal.id));
  assert.ok(!byId2.has(accountBExact.id));

  // Account identity itself must still be visible on each classified row
  // (Required Behavior from Phase B, re-verified here since this is the
  // layer that actually consumes it for SELF/PRIOR_SUBMISSION).
  assert.equal(byId1.get(accountBExact.id).accountId, "rel-account-b");
});

test("an anonymous identity's own family relationships are always PRIOR_SUBMISSION, never SELF, even against another anonymous identity", async () => {
  const text = "Volcanologists monitoring seismic swarms beneath a dormant caldera detected gradually increasing magma chamber pressure over several field seasons. Gas emission sampling from nearby fumaroles showed a corresponding shift in sulfur dioxide to carbon dioxide ratios. Researchers cautioned that these signals alone were insufficient to predict eruption timing with confidence.";
  const first = await createDocumentIdentity(client, { accountId: null, title: null, author: null, rawText: text });
  await recordDocumentIdentityShingles(client, first.id, text);
  const family = await createFamily(client);
  await attachIdentityToFamily(client, { familyId: family.id, documentIdentityId: first.id, matchType: "SEED", matchedAgainstIdentityId: null, evidenceScore: null });

  const second = await createDocumentIdentity(client, { accountId: null, title: null, author: null, rawText: text });
  await attachIdentityToFamily(client, { familyId: family.id, documentIdentityId: second.id, matchType: "EXACT_CANONICAL_MATCH", matchedAgainstIdentityId: first.id, evidenceScore: 1 });

  const relationships = await classifyFamilyRelationships(client, second.id);
  assert.equal(relationships.length, 1);
  assert.equal(relationships[0].relationship, "PRIOR_SUBMISSION", "two anonymous submissions of the same document must never be classified SELF");
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
