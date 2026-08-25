import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_user_submission_matching_privacy.db");
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
async function ensureUser(accountId, email) {
  if (accountId === null || knownUsers.has(accountId)) return;
  knownUsers.add(accountId);
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, email ?? `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
}
async function indexSubmission(accountId, title, rawText, email) {
  await ensureUser(accountId, email);
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  return indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
}
async function match(accountId, canonicalText) {
  return matchAgainstUserSubmissionCorpus(client, { accountId, canonicalText });
}

// --- STRUCTURAL (matching every prior phase's own convention) --------------

function importLines(source) {
  return source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const MATCHING_MODULE = "lib/user-submission-matching.ts";

test("C/P: the matching service is never imported by any file under app/ — no public HTTP route can reach it", () => {
  const appDir = path.join(repoRoot, "app");
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const imports = importLines(fs.readFileSync(full, "utf8"));
        if (/user-submission-matching/.test(imports)) offenders.push(path.relative(repoRoot, full));
      }
    }
  }
  walk(appDir);
  assert.deepEqual(offenders, [], `these app/ files import the matching service, which must not be reachable from any route: ${offenders.join(", ")}`);
});

test("P: app/api/reports/route.ts is unchanged by this phase — does not import or call the matching service", () => {
  const source = fs.readFileSync(path.join(repoRoot, "app/api/reports/route.ts"), "utf8");
  assert.doesNotMatch(importLines(source), /user-submission-matching/);
  assert.doesNotMatch(stripComments(source), /matchAgainstUserSubmissionCorpus/);
});

const SCORING_PATH_FILES = [
  "app/similarity-worker.ts", "app/ai-detector-worker.ts", "app/web-check-worker.ts", "app/page.tsx",
  "lib/report-types.ts", "lib/similarity-core.ts", "lib/similarity-enrichment.ts", "lib/receipt-pdf.ts",
  "app/reports/[id]/page.tsx", "app/reports/[id]/report-detail-shell.tsx",
  "components/report/similarity-report-papers.tsx", "components/report/ai-report.tsx",
];
test("O: no live scoring/report-rendering file imports the matching service — production score is untouched by construction", () => {
  const offenders = [];
  for (const relativePath of SCORING_PATH_FILES) {
    const fullPath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const imports = importLines(fs.readFileSync(fullPath, "utf8"));
    if (/user-submission-matching/.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `these scoring/report-path files import the matching service: ${offenders.join(", ")}`);
});

test("the matching service never imports lib/provenance-verification-workflow.ts and never calls a verification-decision function", () => {
  const source = fs.readFileSync(path.join(repoRoot, MATCHING_MODULE), "utf8");
  assert.doesNotMatch(importLines(source), /provenance-verification-workflow/);
  assert.doesNotMatch(
    stripComments(source),
    /\b(approveVerification|rejectVerification|recordDispute|recordRetraction|reaffirmVerification)\s*\(/,
  );
  assert.doesNotMatch(stripComments(source), /VERIFIED_SOURCE/);
});

test("section 13: the matching service never calls resolveFamilyForIdentity and never touches document_families / document_family_members", () => {
  // Comments are stripped first — this file's own header comment
  // legitimately documents that it avoids these exact table names (the
  // same trap tests/provenance-scoring-invariance.test.mjs already warns
  // about: a structural check must scan real code, not prose that happens
  // to name the thing it asserts the absence of).
  const source = fs.readFileSync(path.join(repoRoot, MATCHING_MODULE), "utf8");
  const code = stripComments(source);
  assert.doesNotMatch(importLines(source), /document-family["']/, "must not import lib/document-family.ts at all");
  assert.doesNotMatch(code, /resolveFamilyForIdentity\s*\(/);
  assert.doesNotMatch(code, /document_families|document_family_members/);
});

test("no title or author parameter exists anywhere in the matching service's public signature (sections G/H: matching never uses title or author)", () => {
  const source = fs.readFileSync(path.join(repoRoot, MATCHING_MODULE), "utf8");
  const signature = source.slice(source.indexOf("export async function matchAgainstUserSubmissionCorpus"), source.indexOf("export async function matchAgainstUserSubmissionCorpus") + 600);
  assert.doesNotMatch(signature, /\btitle\b/i);
  assert.doesNotMatch(signature, /\bauthor\b/i);
});

test("the matching service does not log anything — no console.log/error/warn of query or candidate text", () => {
  const source = fs.readFileSync(path.join(repoRoot, MATCHING_MODULE), "utf8");
  assert.doesNotMatch(source, /console\.(log|error|warn|info)/);
});

// --- PRIVACY / SECURITY (section 27, A-P) ------------------------------------

const TOPIC_A_TEXT = [
  "Seismologists analyzing aftershock sequences from a moderate inland earthquake identified an unusually persistent cluster along a previously unmapped fault segment.",
  "The cluster's depth distribution suggested a shallow, brittle failure mechanism distinct from the mainshock's own deeper rupture plane.",
  "Follow-up field surveys located a short surface fissure consistent with the inferred fault segment's mapped orientation and length.",
];
function topicADoc(marker) {
  return TOPIC_A_TEXT.join(" ") + ` ${marker}`;
}

test("A/D: Account A cannot discover Account B's identity through a matching result — no account id, no email, anywhere in the serialized output", async () => {
  const accountA = "privacy-e8b-account-a";
  const accountB = "privacy-e8b-account-b";
  await indexSubmission(accountA, "Doc", topicADoc("privacy-ab-marker"), "alice-e8b@example.test");

  const result = await match(accountB, topicADoc("privacy-ab-marker"));
  assert.equal(result.status, "MATCHED");

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(accountA));
  assert.ok(!serialized.includes("alice-e8b@example.test"));
  assert.ok(!serialized.toLowerCase().includes("email"));
  assert.ok(!serialized.toLowerCase().includes("account"));
});

test("SELF-MATCH-FIX PRIVACY: excludeAccountId (a server-internal value carrying a real account id) never appears anywhere in matchAgainstUserSubmissionCorpus's own result, matched or not", async () => {
  const accountA = "privacy-exclude-account-a";
  const accountB = "privacy-exclude-account-b";
  const text = topicADoc("privacy-exclude-marker");
  await indexSubmission(accountA, "Doc", text, "exclude-a@example.test");

  // A secret-shaped exclusion value — the exact accountId string a real
  // caller (resolvePrimarySimilaritySummary) would pass — with a
  // deliberately identifiable secret so a leak would be unmistakable.
  const secretAccountId = "super-secret-account-id-should-never-leak";
  const excludeAccountId = secretAccountId;

  const result = await matchAgainstUserSubmissionCorpus(client, { accountId: accountB, canonicalText: text, excludeAccountId });
  assert.equal(result.status, "MATCHED", "test setup sanity: excluding an UNRELATED account id must not suppress a genuine match");

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secretAccountId), "the exclusion context's own account id must never appear in the result");
  assert.ok(!serialized.includes("report-upload:"), "no source_ref-shaped string of any kind may appear in the result");
});

test("B: SELF detection works for repeated Account A uploads (privacy-framing check: SELF never exposes anything beyond the relationship itself)", async () => {
  const accountA = "privacy-e8b-self-account";
  const text = topicADoc("privacy-self-marker");
  await indexSubmission(accountA, "Doc", text, "self-owner@example.test");
  const result = await match(accountA, text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].relationshipType, "SELF");
  assert.ok(!JSON.stringify(result).includes("self-owner@example.test"));
});

test("C: PRIOR_SUBMISSION works for Account B after Account A, without exposing Account A", async () => {
  const accountA = "privacy-e8b-prior-a";
  const accountB = "privacy-e8b-prior-b";
  const text = topicADoc("privacy-prior-marker");
  await indexSubmission(accountA, "Doc", text, "prior-a@example.test");
  const result = await match(accountB, text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].relationshipType, "PRIOR_SUBMISSION");
});

test("E: no full historical document is ever returned — passages are bounded and drawn only from the CURRENT query's own text", async () => {
  const historicalText = topicADoc("privacy-e-marker") + " " + "Additional unique historical-only sentence that must never appear verbatim in the result. privacy-e-only-in-history";
  await indexSubmission("privacy-e8b-history-owner", "Doc", historicalText, "history-owner@example.test");

  const queryText = topicADoc("privacy-e-marker"); // deliberately omits the historical-only sentence
  const result = await match("privacy-e8b-history-reader", queryText);
  assert.equal(result.status, "MATCHED");

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("privacy-e-only-in-history"), "text unique to the historical document must never appear in the result");
  for (const m of result.matches) {
    assert.ok(m.passages.length <= 10, "passages must be bounded");
    for (const p of m.passages) assert.ok(p.submittedText.split(/\s+/).length <= 60, "each passage must be bounded in length");
  }
});

test("F: common phrase alone does not match (privacy framing: informative-shingle filtering also prevents trivial-phrase account correlation)", async () => {
  await indexSubmission("privacy-e8b-f-owner", "Doc", topicADoc("privacy-f-marker"), "f-owner@example.test");
  const result = await match("privacy-e8b-f-reader", "Introduction. The results of this study indicate that further research is needed. In conclusion, this paper has shown promising results. Discussion. Conclusion.");
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

test("G: same nominal title alone does not match — the service has no title parameter to even consider", async () => {
  await indexSubmission("privacy-e8b-g-owner", "A Seismology Paper", topicADoc("privacy-g-marker"), "g-owner@example.test");
  const unrelatedButSameTitleConcept = "Botanists surveying an alpine meadow recorded flowering phenology shifts correlated with earlier snowmelt over a fifteen-year observation window across multiple elevation bands. A Seismology Paper.";
  const result = await match("privacy-e8b-g-reader", unrelatedButSameTitleConcept);
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

test("H: same nominal author alone does not match — the service has no author parameter to even consider", async () => {
  await indexSubmission("privacy-e8b-h-owner", "Doc", topicADoc("privacy-h-marker"), "h-owner@example.test");
  const unrelatedText = "Botanists surveying an alpine meadow recorded flowering phenology shifts correlated with earlier snowmelt over a fifteen-year observation window across multiple elevation bands, by the same nominal author.";
  const result = await match("privacy-e8b-h-reader", unrelatedText);
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

test("L: an unrelated document from a different account never matches", async () => {
  await indexSubmission("privacy-e8b-l-owner", "Doc", topicADoc("privacy-l-marker"), "l-owner@example.test");
  const result = await match("privacy-e8b-l-reader", "Botanists surveying an alpine meadow recorded flowering phenology shifts correlated with earlier snowmelt over a fifteen-year observation window across multiple elevation bands and sites.");
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

// --- PERFORMANCE (section 26): indexed candidate lookup, not O(N) full scan ---

function distinctFillerDoc(index) {
  // Every word embeds `index` itself, so no 5-word window can ever recur
  // across two different index values — a shared small word bank rotated
  // per document is NOT enough (informativeGram only requires 2+ words of
  // length >= 4, so plenty of short recurring windows would otherwise pass
  // the filter and cross-match between filler documents).
  const stems = ["topic", "detail", "aspect", "element", "factor", "segment", "feature", "portion"];
  const words = [];
  for (let j = 0; j < 60; j++) words.push(`${stems[j % stems.length]}${index}word${j}`);
  return words.join(" ");
}

const PERFORMANCE_FIXTURE_TEXT = [
  "Glaciologists surveying a retreating alpine glacier's terminus measured a marked acceleration in ice loss over the final three field seasons.",
  "Surface velocity data from embedded GPS units indicated basal sliding had increased substantially relative to the decade-long baseline record.",
  "The observed pattern was consistent with meltwater infiltration reaching the bedrock interface earlier each successive season.",
];
function performanceFixtureDoc(marker) {
  return PERFORMANCE_FIXTURE_TEXT.join(" ") + ` ${marker}`;
}

test("performance: candidate generation stays fast and correct against 100+ unrelated representations plus 2 genuinely related ones", async () => {
  for (let i = 0; i < 100; i++) {
    await indexSubmission(`perf-account-${i}`, "Filler", distinctFillerDoc(i), `perf-${i}@example.test`);
  }
  // Deliberately its own, never-reused-elsewhere-in-this-file base text —
  // topicADoc() is shared by several earlier tests in this same database
  // and would otherwise inflate the match count here (the same isolation
  // lesson already applied to the multi-submitter fixture in
  // tests/user-submission-matching.test.mjs).
  const relatedText = performanceFixtureDoc("performance-fixture-marker");
  await indexSubmission("perf-related-owner", "Doc", relatedText, "perf-related@example.test");

  const startedAt = Date.now();
  const result = await match("perf-related-reader", relatedText);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches.length, 1, "must not spuriously match any of the 100 unrelated filler documents");
  assert.equal(result.matches[0].matchType, "EXACT_CANONICAL_MATCH");
  assert.ok(elapsedMs < 5000, `expected a single match call against 100+ representations to stay well under 5s (indexed lookup, not a full scan); took ${elapsedMs}ms`);
});
