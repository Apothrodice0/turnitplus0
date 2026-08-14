import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest";
import { createDocumentIdentity } from "../lib/document-identity";
import { indexDocumentSubmissionIntoCorpus, createReusableDocumentRepresentation, recordCorpusShingles } from "../lib/user-submission-corpus";
import { matchAgainstUserSubmissionCorpus, USER_SUBMISSION_MATCH_THRESHOLDS, type UserSubmissionMatchResult } from "../lib/user-submission-matching";
import { computeDocumentCorrespondence } from "../lib/document-correspondence";
import { canonicalizeText } from "../lib/canonical-text";
import { tokens } from "../lib/similarity-core";
import { CALIBRATION_FIXTURES, BASE_DOCUMENT, PARTIAL_COPY_DOCUMENT } from "../lib/e8j-calibration-fixtures";

/**
 * Phase E8J: controlled calibration report for the user-submission
 * historical matcher. Entirely local — builds and destroys its own
 * disposable SQLite file, never touches process.env, never connects to
 * Turso/production, never modifies USER_SUBMISSION_MATCH_THRESHOLDS (every
 * threshold-curve computation below passes an explicit override object to
 * computeDocumentCorrespondence; the imported constant itself is never
 * reassigned). Read-only with respect to the real codebase and to
 * production — this file only writes to its own throwaway local db file.
 *
 * Usage: node --import tsx tools/e8j-calibration-report.ts
 */

const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "e8j-calibration-local.db");

function cleanupDbFile() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
}

async function freshClient(): Promise<Client> {
  cleanupDbFile();
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));
  return client;
}

async function ensureUser(client: Client, id: string) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [id, `${id}@example.test`, id, "not-a-real-hash"],
  });
}

async function indexSubmission(client: Client, accountId: string, title: string, rawText: string) {
  await ensureUser(client, accountId);
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  const indexResult = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return { identity, indexResult };
}

async function timedMatch(client: Client, accountId: string | null, canonicalText: string) {
  const start = performance.now();
  const result = await matchAgainstUserSubmissionCorpus(client, { accountId, canonicalText });
  const runtimeMs = performance.now() - start;
  return { result, runtimeMs };
}

// --- synthetic noise corpus for performance testing (representations/shingles only, no identities) ---

const NOISE_VOCAB = [
  "orbital", "sediment", "logistics", "polymer", "cartography", "ferment", "acoustic", "irrigation",
  "telemetry", "pigment", "masonry", "vaccine", "turbine", "cipher", "wetland", "alloy", "harbor",
  "lattice", "quartz", "diesel", "topology", "estuary", "granite", "voltage", "canopy", "reservoir",
];
function syntheticNoiseText(index: number): string {
  const words: string[] = [];
  for (let i = 0; i < 220; i += 1) {
    words.push(NOISE_VOCAB[(index * 7 + i * 13) % NOISE_VOCAB.length] + (i % 5 === 0 ? String(index) : ""));
  }
  return `Synthetic noise document number ${index}. ` + words.join(" ") + ".";
}

async function populateNoiseCorpus(client: Client, count: number, startIndex: number) {
  for (let i = 0; i < count; i += 1) {
    const canonicalText = canonicalizeText(syntheticNoiseText(startIndex + i));
    const representation = await createReusableDocumentRepresentation(client, { canonicalText });
    await recordCorpusShingles(client, representation.id, canonicalText);
  }
}

function fmt(n: number, digits = 3) { return n.toFixed(digits); }

async function main() {
  const client = await freshClient();
  const ACCOUNT_A = "e8j-account-a";
  const ACCOUNT_B = "e8j-account-b";

  console.log("=".repeat(78));
  console.log("PHASE E8J — USER-SUBMISSION HISTORICAL MATCH CALIBRATION REPORT");
  console.log("=".repeat(78));
  console.log("Entirely local/disposable database. No production connection. No");
  console.log("USER_SUBMISSION_MATCH_THRESHOLDS mutation anywhere in this file.\n");

  console.log(`Base document word count: ${tokens(BASE_DOCUMENT).length}`);
  console.log("Fixture composition (measured, not estimated):");
  for (const f of CALIBRATION_FIXTURES) {
    const pct = f.actualModifiedPercent === null ? "n/a" : `${fmt(f.actualModifiedPercent * 100, 2)}%`;
    const target = f.targetModifiedPercentRange ? `${f.targetModifiedPercentRange[0] * 100}-${f.targetModifiedPercentRange[1] * 100}%` : "n/a";
    console.log(`  ${f.label.padEnd(34)} words=${tokens(f.text).length.toString().padStart(5)}  modified=${pct.padStart(7)} (target ${target})`);
  }

  // Index Account A's base document into the corpus — this is the "prior submission" everything else is measured against.
  await indexSubmission(client, ACCOUNT_A, "Aurelia Pilot Evaluation Report", BASE_DOCUMENT);

  console.log("\n" + "-".repeat(78));
  console.log("SECTION 1: PER-FIXTURE MEASURED RESULTS (Account B, cross-account query)");
  console.log("-".repeat(78));

  type FixtureResult = {
    category: string;
    label: string;
    expectedStatus: string;
    result: UserSubmissionMatchResult;
    runtimeMs: number;
  };
  const fixtureResults: FixtureResult[] = [];

  for (const fixture of CALIBRATION_FIXTURES) {
    const { result, runtimeMs } = await timedMatch(client, ACCOUNT_B, fixture.text);
    fixtureResults.push({ category: fixture.category, label: fixture.label, expectedStatus: fixture.expectedStatus, result, runtimeMs });

    console.log(`\n${fixture.label} [${fixture.category}]`);
    console.log(`  expected status: ${fixture.expectedStatus}`);
    console.log(`  actual status:   ${result.status}${result.status === fixture.expectedStatus ? "  (MATCHES EXPECTATION)" : "  *** DID NOT MATCH EXPECTATION ***"}`);
    console.log(`  runtime: ${fmt(runtimeMs, 2)}ms`);
    if (result.status === "MATCHED") {
      const m = result.matches[0];
      console.log(`  relationshipType=${m.relationshipType} matchType=${m.matchType} containment=${fmt(m.containment)} matchedWordCount=${m.matchedWordCount} passageCount=${m.passageCount} longestMatchWords=${m.longestMatchWords} historicalSubmissionCount=${m.historicalSubmissionCount}`);
      console.log(`  matcherVersion=${m.evidenceVersion.matcherVersion} fingerprintVersion=${m.evidenceVersion.fingerprintVersion} canonicalizationVersion=${m.evidenceVersion.canonicalizationVersion}`);
    } else {
      // Diagnostic only — the real pipeline discards this candidate below the
      // strongCorrespondence threshold, so its numbers never reach the
      // caller. Recomputed here directly via computeDocumentCorrespondence
      // (a pure function) purely to see what got filtered out and why.
      const diag = computeDocumentCorrespondence(fixture.text, BASE_DOCUMENT, USER_SUBMISSION_MATCH_THRESHOLDS.correspondence);
      console.log(`  [diagnostic, not returned to caller] containment=${fmt(diag.containment)} matchedWordCount=${diag.matchedWordCount} passages=${diag.passages.length} longestMatchWords=${diag.longestMatchWords} strongCorrespondence=${diag.strongCorrespondence} (threshold=${USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.strongContainmentThreshold})`);
    }
  }

  console.log("\n" + "-".repeat(78));
  console.log("SECTION 2: RELATIONSHIP CLASSIFICATION (SELF vs PRIOR_SUBMISSION)");
  console.log("-".repeat(78));
  {
    const { result: selfResult } = await timedMatch(client, ACCOUNT_A, BASE_DOCUMENT);
    console.log(`Account A resubmits its own exact document -> status=${selfResult.status}, relationshipType=${selfResult.status === "MATCHED" ? selfResult.matches[0].relationshipType : "n/a"} (expected SELF)`);
    const { result: priorResult } = await timedMatch(client, ACCOUNT_B, BASE_DOCUMENT);
    console.log(`Account B submits Account A's exact document -> status=${priorResult.status}, relationshipType=${priorResult.status === "MATCHED" ? priorResult.matches[0].relationshipType : "n/a"} (expected PRIOR_SUBMISSION)`);
  }

  console.log("\n" + "-".repeat(78));
  console.log("SECTION 3: PASSAGE QUALITY — PARTIAL_COPY inspection");
  console.log("-".repeat(78));
  {
    const partialResult = fixtureResults.find((f) => f.category === "PARTIAL_COPY")!.result;
    // The copied zone is exactly the first N tokens of PARTIAL_COPY_DOCUMENT,
    // where N = token count of the 4 verbatim base paragraphs it starts with.
    const copiedZoneText = PARTIAL_COPY_DOCUMENT.split("\n\n").slice(0, 4).join("\n\n");
    const copiedZoneWordCount = tokens(copiedZoneText).length;
    console.log(`copied zone: token positions 0-${copiedZoneWordCount - 1} of the submitted PARTIAL_COPY document`);
    if (partialResult.status === "MATCHED") {
      const m = partialResult.matches[0];
      console.log(`passages returned: ${m.passages.length}`);
      for (const p of m.passages) {
        const inCopiedZone = p.submittedWordEnd < copiedZoneWordCount;
        console.log(`  [${p.submittedWordStart}-${p.submittedWordEnd}] ${p.matchedWordCount} words — ${inCopiedZone ? "WITHIN copied zone (correct)" : "OUTSIDE copied zone (unexpected — would indicate generic text incorrectly selected)"}`);
      }
      console.log(`whole-fixture containment=${fmt(m.containment)} (well below 1.0 is expected/correct — only ~${fmt((1 - (copiedZoneWordCount / tokens(PARTIAL_COPY_DOCUMENT).length)) * -100 + 100, 0)}% of the document was actually copied)`);
    } else {
      console.log("PARTIAL_COPY did not match at all under production thresholds — this is the key finding this phase asked to investigate.");
      const diag = computeDocumentCorrespondence(PARTIAL_COPY_DOCUMENT, BASE_DOCUMENT, USER_SUBMISSION_MATCH_THRESHOLDS.correspondence);
      console.log(`diagnostic (not returned to any caller): whole-document containment=${fmt(diag.containment)}, matchedWordCount=${diag.matchedWordCount}, passages found=${diag.passages.length}`);
      console.log(`  the ${copiedZoneWordCount}-word copied passage IS locally detectable (see passages below) but gets diluted by the ${tokens(PARTIAL_COPY_DOCUMENT).length - copiedZoneWordCount} words of genuinely new surrounding content when containment is computed over the WHOLE submitted document — this is a whole-document-similarity computation, not a passage-level one.`);
      for (const p of diag.passages) {
        const inCopiedZone = p.submittedWordEnd < copiedZoneWordCount;
        console.log(`  [${p.submittedWordStart}-${p.submittedWordEnd}] ${p.matchedWordCount} words — ${inCopiedZone ? "WITHIN copied zone (correct localization)" : "OUTSIDE copied zone (unexpected)"}`);
      }
    }
  }

  console.log("\n" + "-".repeat(78));
  console.log("SECTION 4: FALSE-POSITIVE ANALYSIS (COMMON_PHRASE_ONLY, SAME_TOPIC)");
  console.log("-".repeat(78));
  for (const category of ["COMMON_PHRASE_ONLY", "SAME_TOPIC_DIFFERENT_WORDING"] as const) {
    const fr = fixtureResults.find((f) => f.category === category)!;
    if (fr.result.status === "MATCHED") {
      const label = category === "COMMON_PHRASE_ONLY" ? "FALSE_POSITIVE_COMMON_TEXT" : "FALSE_POSITIVE_TOPIC_SIMILARITY";
      console.log(`${category}: MATCHED — classified ${label}`);
      console.log(`  containment=${fmt(fr.result.matches[0].containment)} matchedWordCount=${fr.result.matches[0].matchedWordCount}`);
    } else {
      console.log(`${category}: NO_HISTORICAL_MATCH — no false positive.`);
    }
  }

  console.log("\n" + "-".repeat(78));
  console.log("SECTION 5: THRESHOLD CURVE (pure function calls, real thresholds constant never mutated)");
  console.log("-".repeat(78));
  const CURVE_THRESHOLDS = [0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90];
  const curveFixtures = CALIBRATION_FIXTURES.filter((f) => f.category !== "FORMATTING_ONLY"); // canonical-hash short-circuit — containment threshold is not even consulted for it
  console.log(`containment threshold ->  ${CURVE_THRESHOLDS.map((t) => t.toFixed(2).padStart(6)).join(" ")}`);
  const curveRows: Record<string, boolean[]> = {};
  for (const fixture of curveFixtures) {
    const row = CURVE_THRESHOLDS.map((t) => {
      const correspondence = computeDocumentCorrespondence(fixture.text, BASE_DOCUMENT, {
        ...USER_SUBMISSION_MATCH_THRESHOLDS.correspondence,
        strongContainmentThreshold: t,
      });
      return correspondence.strongCorrespondence;
    });
    curveRows[fixture.category] = row;
    console.log(`${fixture.category.padEnd(26)} ${row.map((v) => (v ? "MATCH " : "  .   ")).join(" ")}`);
  }
  console.log(`(current production threshold: ${USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.strongContainmentThreshold} — column closest to 0.50 above)`);

  console.log("\n" + "-".repeat(78));
  console.log("SECTION 6: SCORE SEPARATION (structural)");
  console.log("-".repeat(78));
  const matcherSource = fs.readFileSync(path.join(repoRoot, "lib/user-submission-matching.ts"), "utf8");
  const touchesScore = /\b(archiveScore|report\.score|aiScore|verifiedSimilarity)\b/.test(matcherSource);
  console.log(`lib/user-submission-matching.ts references any scoring field: ${touchesScore ? "YES — INVESTIGATE" : "NO (confirmed)"}`);

  console.log("\n" + "-".repeat(78));
  console.log("SECTION 7: PERFORMANCE — indexed candidate generation at scale");
  console.log("-".repeat(78));
  const planResult = await client.execute(
    "EXPLAIN QUERY PLAN SELECT s.representation_id AS representation_id, COUNT(*) AS shared FROM corpus_document_shingles s JOIN corpus_document_representations r ON r.id = s.representation_id WHERE s.fingerprint_version = 'corpus-shingle-v1' AND s.shingle_hash IN ('a','b','c') GROUP BY s.representation_id HAVING COUNT(*) >= 3 ORDER BY shared DESC LIMIT 10",
  );
  console.log("EXPLAIN QUERY PLAN for candidate-generation query:");
  for (const row of planResult.rows) console.log(`  ${JSON.stringify(row)}`);
  const usesIndex = planResult.rows.some((r) => String((r as unknown as { detail?: string }).detail ?? JSON.stringify(r)).toUpperCase().includes("IDX_CORPUS_DOCUMENT_SHINGLES_HASH"));
  console.log(`query plan uses idx_corpus_document_shingles_hash: ${usesIndex ? "YES" : "NO — investigate, this would mean a full scan"}`);

  for (const targetTotal of [100, 500, 1000]) {
    const currentCount = Number((await client.execute("SELECT COUNT(*) AS n FROM corpus_document_representations")).rows[0].n);
    const toAdd = Math.max(0, targetTotal - currentCount);
    if (toAdd > 0) await populateNoiseCorpus(client, toAdd, currentCount);
    const countAfter = Number((await client.execute("SELECT COUNT(*) AS n FROM corpus_document_representations")).rows[0].n);
    const { runtimeMs } = await timedMatch(client, "e8j-perf-query-account", CALIBRATION_FIXTURES[2].text); // LIGHT_EDIT, a realistic non-trivial query
    console.log(`corpus size ${countAfter} representations total -> LIGHT_EDIT match runtime: ${fmt(runtimeMs, 2)}ms`);
  }

  console.log("\n" + "=".repeat(78));
  console.log("REPORT COMPLETE — cleaning up local disposable database.");
  console.log("=".repeat(78));

  client.close();
  cleanupDbFile();
}

main().catch((err) => {
  console.error("e8j-calibration-report failed:", err instanceof Error ? err.stack ?? err.message : String(err));
  cleanupDbFile();
  process.exitCode = 1;
});
