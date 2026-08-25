import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import {
  indexDocumentSubmissionIntoCorpus,
  findCandidateCorpusRepresentations,
  findSubmissionReferencesForAccount,
  isRepresentationEligibleForMatching,
  corpusShingleHashes,
} from "../lib/user-submission-corpus.ts";

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_user_submission_corpus_privacy.db");
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

// --- STRUCTURAL: matches tests/provenance-scoring-invariance.test.mjs's own convention ---

function importLines(source) {
  return source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const CORPUS_MODULE = "lib/user-submission-corpus.ts";

test("C: the corpus repository is reachable from NO app/ file — corpus-admission hardening removed the save route's former direct write access", () => {
  // Superseded invariant: Phase E8D once activated
  // indexDocumentSubmissionIntoCorpus from app/api/reports/route.ts
  // directly, and this test used to assert that route was the sole
  // authorized importer. The corpus-admission gate revision removes that
  // direct call entirely (app/api/reports/route.ts no longer imports
  // lib/user-submission-corpus.ts at all) — automatic reusable-corpus
  // indexing now requires passing lib/corpus-admission-gate.ts's English-
  // only/3000-word/quality/retention/family-duplicate gate, which no app/
  // file wires up live yet (see tests/corpus-admission-privacy.test.mjs for
  // the corpus-admission-gate-specific structural proof of the same
  // property). So the property enforced here is now the strict, simple
  // one: zero app/ files import the corpus repository, full stop.
  const appDir = path.join(repoRoot, "app");
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const imports = importLines(fs.readFileSync(full, "utf8"));
        if (/user-submission-corpus/.test(imports)) offenders.push(path.relative(repoRoot, full).split(path.sep).join("/"));
      }
    }
  }
  walk(appDir);
  assert.deepEqual(offenders, [], `no app/ file may import the corpus repository any more — found: ${offenders.join(", ")}`);
});

test("app/api/reports/route.ts (POST /api/reports) no longer imports or mentions indexDocumentSubmissionIntoCorpus — corpus indexing is no longer reachable directly from normal report creation", () => {
  const source = fs.readFileSync(path.join(repoRoot, "app/api/reports/route.ts"), "utf8");
  assert.doesNotMatch(importLines(source), /user-submission-corpus/, "the save route must not import lib/user-submission-corpus.ts at all any more");
  assert.doesNotMatch(stripComments(source), /indexDocumentSubmissionIntoCorpus|findCandidateCorpusRepresentations|matchAgainstUserSubmissionCorpus|findSubmissionReferencesForAccount|corpusShingleHashes/, "the save route must never call or even reference a corpus repository function");
});

const SCORING_PATH_FILES = [
  "app/similarity-worker.ts", "app/ai-detector-worker.ts", "app/web-check-worker.ts", "app/page.tsx",
  "lib/report-types.ts", "lib/similarity-core.ts", "lib/similarity-enrichment.ts", "lib/receipt-pdf.ts",
  "app/reports/[id]/page.tsx", "app/reports/[id]/report-detail-shell.tsx",
  "components/report/similarity-report-papers.tsx", "components/report/ai-report.tsx",
];
test("no live scoring/report-rendering file imports the corpus repository", () => {
  const offenders = [];
  for (const relativePath of SCORING_PATH_FILES) {
    const fullPath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const imports = importLines(fs.readFileSync(fullPath, "utf8"));
    if (/user-submission-corpus/.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `these scoring/report-path files import the corpus repository: ${offenders.join(", ")}`);
});

test("O: lib/user-submission-corpus.ts never imports lib/provenance-verification-workflow.ts and never calls a verification-decision function", () => {
  const source = fs.readFileSync(path.join(repoRoot, CORPUS_MODULE), "utf8");
  assert.doesNotMatch(importLines(source), /provenance-verification-workflow/);
  assert.doesNotMatch(
    stripComments(source),
    /\b(approveVerification|rejectVerification|recordDispute|recordRetraction|reaffirmVerification)\s*\(/,
  );
  assert.doesNotMatch(stripComments(source), /VERIFIED_SOURCE/, "this module must never even mention VERIFIED_SOURCE as a value it could write");
});

test("lib/user-submission-corpus.ts never writes to public/data or the historical 230 archive index — it only touches its own three new tables", () => {
  const source = fs.readFileSync(path.join(repoRoot, CORPUS_MODULE), "utf8");
  assert.doesNotMatch(importLines(source), /document-index|e7-archive-adapter|e7-pilot-sampling/, "the user-submission corpus must stay independent of the historical evaluation corpus");
});

// --- FUNCTIONAL PRIVACY / ISOLATION (this phase's own section 20, A-F) -------

async function ensureUser(accountId, email) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, email, accountId, "not-a-real-hash"],
  });
}

const SHARED_TEXT_ALPHA = [
  "Ornithologists tracking migratory songbirds fitted with miniature geolocators documented a previously unrecorded stopover site.",
  "Birds using the stopover site gained significantly more body mass per day than birds recorded at three other established locations.",
  "privacy-test-alpha-marker",
].join(" ");

test("A/B: representation and candidate-search results never carry an account id or email, even when two different accounts share content", async () => {
  const accountA = "privacy-account-a";
  const accountB = "privacy-account-b";
  await ensureUser(accountA, "alice-secret@example.test");
  await ensureUser(accountB, "bob-secret@example.test");

  const identityA = await createDocumentIdentity(client, { accountId: accountA, title: "T", author: null, rawText: SHARED_TEXT_ALPHA });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identityA.id, rawText: SHARED_TEXT_ALPHA });
  const identityB = await createDocumentIdentity(client, { accountId: accountB, title: "T", author: null, rawText: SHARED_TEXT_ALPHA });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identityB.id, rawText: SHARED_TEXT_ALPHA });

  const hashes = corpusShingleHashes(SHARED_TEXT_ALPHA, 5);
  const candidates = await findCandidateCorpusRepresentations(client, hashes);
  assert.ok(candidates.length >= 1);

  const serialized = JSON.stringify(candidates);
  assert.ok(!serialized.includes("alice-secret"), "Account A's email must never appear in a candidate-search result");
  assert.ok(!serialized.includes("bob-secret"), "Account B's email must never appear in a candidate-search result");
  assert.ok(!serialized.includes(accountA), "Account A's id must never appear in a candidate-search result");
  assert.ok(!serialized.includes(accountB), "Account B's id must never appear in a candidate-search result");
  for (const candidate of candidates) {
    // isActivelyPromoted (lib/corpus-admission-promotion.ts's own
    // eligibility signal) added to this shape — still just a boolean, never
    // an identity-shaped field. Asserted explicitly, not just permitted by
    // omission, so a future field addition here still has to touch this
    // test deliberately.
    assert.deepEqual(Object.keys(candidate).sort(), ["canonicalSha256", "containment", "isActivelyPromoted", "representationId", "sharedShingleCount", "wordCount"].sort());
    assert.equal(typeof candidate.isActivelyPromoted, "boolean");
  }
});

test("SELF-MATCH-FIX PRIVACY: excludeAccountId never appears in findCandidateCorpusRepresentations' own results, and isRepresentationEligibleForMatching returns a plain boolean carrying no identifiers at all", async () => {
  const accountA = "privacy-exclude-corpus-account-a";
  await ensureUser(accountA, "exclude-corpus-a@example.test");
  const text = SHARED_TEXT_ALPHA + " exclude-corpus-marker";
  const identityA = await createDocumentIdentity(client, { accountId: accountA, title: "T", author: null, rawText: text });
  const indexed = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identityA.id, rawText: text });

  const secretAccountId = "corpus-secret-account-id-should-never-leak";
  const excludeAccountId = secretAccountId;

  const candidates = await findCandidateCorpusRepresentations(client, corpusShingleHashes(text, 5), { excludeAccountId });
  assert.ok(candidates.length >= 1, "test setup sanity: an unrelated exclusion value must not suppress a genuine submission-reference-backed candidate");
  const serialized = JSON.stringify(candidates);
  assert.ok(!serialized.includes(secretAccountId), "the exclusion context's own account id must never appear in candidate results");

  // isRepresentationEligibleForMatching: boolean-only, same discipline as
  // isRepresentationActivelyPromoted/summarizeSubmissionOwnership.
  const eligible = await isRepresentationEligibleForMatching(client, indexed.representationId, { excludeAccountId });
  assert.equal(typeof eligible, "boolean");
});

test("D: SELF (same-account) queries are correctly scoped to the querying account and do not return another account's submissions", async () => {
  const accountA = "privacy-self-account-a";
  const accountB = "privacy-self-account-b";
  await ensureUser(accountA, "self-a@example.test");
  await ensureUser(accountB, "self-b@example.test");

  const textA = SHARED_TEXT_ALPHA + " self-account-a-only";
  const textB = SHARED_TEXT_ALPHA + " self-account-b-only";
  const identityA = await createDocumentIdentity(client, { accountId: accountA, title: "T", author: null, rawText: textA });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identityA.id, rawText: textA });
  const identityB = await createDocumentIdentity(client, { accountId: accountB, title: "T", author: null, rawText: textB });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identityB.id, rawText: textB });

  const referencesForA = await findSubmissionReferencesForAccount(client, accountA);
  assert.ok(referencesForA.every((r) => r.documentIdentityId === identityA.id));
  assert.ok(!referencesForA.some((r) => r.documentIdentityId === identityB.id), "account A's SELF query must never return account B's submission");
});

test("E: cross-account historical material is identifiable as a candidate without revealing who submitted it (representation-level result only)", async () => {
  const accountA = "privacy-cross-account-a";
  const accountB = "privacy-cross-account-b";
  await ensureUser(accountA, "cross-a@example.test");
  await ensureUser(accountB, "cross-b@example.test");

  const sharedText = SHARED_TEXT_ALPHA + " cross-account-marker";
  const identityA = await createDocumentIdentity(client, { accountId: accountA, title: "T", author: null, rawText: sharedText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identityA.id, rawText: sharedText });

  // Account B has not submitted this yet — simulate B's own upload discovering it as a candidate via shingle overlap.
  const candidates = await findCandidateCorpusRepresentations(client, corpusShingleHashes(sharedText, 5));
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.some((c) => c.containment > 0.9));
  // The result gives B enough to know "this content exists in the corpus"
  // without ever learning it was account A that put it there.
  for (const c of candidates) {
    assert.ok(!("accountId" in c) && !("account_id" in c) && !("submitterEmail" in c));
  }
});

test("F: exact duplicate content submitted by 10 accounts results in one reusable content representation plus 10 submission references, not 10 full-text copies", async () => {
  const text = SHARED_TEXT_ALPHA + " fixture-f-privacy-marker";
  let representationId = null;
  for (let i = 0; i < 10; i++) {
    const accountId = `privacy-ten-accounts-${i}`;
    await ensureUser(accountId, `ten-${i}@example.test`);
    const identity = await createDocumentIdentity(client, { accountId, title: "T", author: null, rawText: text });
    const result = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });
    if (representationId) assert.equal(result.representationId, representationId);
    representationId = result.representationId;
  }
  const textCopies = await client.execute({
    sql: "SELECT COUNT(*) AS cnt FROM corpus_document_representations WHERE id = ?",
    args: [representationId],
  });
  assert.equal(Number(textCopies.rows[0].cnt), 1, "exactly one stored text copy, never one per account");
  const refCount = await client.execute({
    sql: "SELECT COUNT(*) AS cnt FROM corpus_submission_references WHERE representation_id = ?",
    args: [representationId],
  });
  assert.equal(Number(refCount.rows[0].cnt), 10);
});

test("no full corpus content is logged by this module — it contains no console.log/console.error of canonical_text or rawText", () => {
  const source = fs.readFileSync(path.join(repoRoot, CORPUS_MODULE), "utf8");
  assert.doesNotMatch(source, /console\.(log|error|warn|info)/, "the corpus repository must not log anything, let alone document content");
});
