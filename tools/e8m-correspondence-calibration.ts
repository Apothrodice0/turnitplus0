import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest";
import { createReusableDocumentRepresentation, recordCorpusShingles, findCandidateCorpusRepresentations, findRepresentationById, corpusShingleHashes } from "../lib/user-submission-corpus";
import { canonicalizeText } from "../lib/canonical-text";
import { computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "../lib/document-correspondence";
import { computeRobustCorrespondence, DEFAULT_ROBUST_CORRESPONDENCE_CONFIG, type RobustCorrespondenceConfig } from "../lib/e8m-robust-correspondence";
import { E8M_FIXTURES, INS_DEL_BASE_PASSAGE, PARTIAL_COPY_DOCUMENT } from "../lib/e8m-robust-correspondence-fixtures";
import { generateGenericDocument, generateDistinctiveDocument } from "../lib/e8l-calibration-corpus";
import { tokens } from "../lib/similarity-core";

/**
 * Phase E8M: calibration report comparing V0 (lib/document-correspondence.ts,
 * completely unmodified) against the experimental E8M engine
 * (lib/e8m-robust-correspondence.ts). Pure-function comparisons for most
 * sections; only the performance section connects to a disposable local
 * SQLite file, never production.
 *
 * Usage: node --import tsx tools/e8m-correspondence-calibration.ts
 */

function fmt(n: number, d = 3) { return n.toFixed(d); }

type Row = {
  fixture: (typeof E8M_FIXTURES)[number];
  v0: ReturnType<typeof computeDocumentCorrespondence>;
  e8m: ReturnType<typeof computeRobustCorrespondence>;
};

function evaluateAll(config?: RobustCorrespondenceConfig): Row[] {
  return E8M_FIXTURES.map((fixture) => ({
    fixture,
    v0: computeDocumentCorrespondence(fixture.text, fixture.candidateText, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS),
    e8m: computeRobustCorrespondence(fixture.text, fixture.candidateText, config),
  }));
}

// matchedWordCount alone (not passages.length) is the detection signal —
// lib/document-correspondence.ts's own exact-canonical-match short-circuit
// deliberately returns passages: [] even though matchedWordCount is
// correctly the full document length (same quirk E8K/E8L already found and
// accounted for). Requiring non-empty passages here would wrongly flag a
// perfect exact match as "not detected."
function v0Correct(row: Row): boolean {
  const detected = row.v0.matchedWordCount > 0;
  return row.fixture.expected === "COPIED" ? detected : !detected;
}
function e8mCorrect(row: Row): boolean {
  const detected = row.e8m.matchedWordCount > 0;
  return row.fixture.expected === "COPIED" ? detected : !detected;
}

async function main() {
  console.log("=".repeat(108));
  console.log("PHASE E8M — ROBUST CORRESPONDENCE PROTOTYPE CALIBRATION REPORT");
  console.log("=".repeat(108));
  console.log("Pure-function comparisons for sections A-F; only section G touches a disposable local DB.\n");

  const rows = evaluateAll();

  console.log("-".repeat(108));
  console.log("SECTION A: COMPARISON MATRIX (V0 vs E8M, default config)");
  console.log("-".repeat(108));
  for (const row of rows) {
    const v0c = v0Correct(row);
    const e8mc = e8mCorrect(row);
    console.log(
      `${row.fixture.id.padEnd(32)} expected=${row.fixture.expected.padEnd(12)} ` +
      `V0[matched=${String(row.v0.matchedWordCount).padStart(4)} longest=${String(row.v0.longestMatchWords).padStart(4)} contain=${fmt(row.v0.containment)} ${v0c ? "ok  " : "WRONG"}] ` +
      `E8M[matched=${String(row.e8m.matchedWordCount).padStart(4)} longest=${String(row.e8m.longestMatchWords).padStart(4)} contain=${fmt(row.e8m.containment)} passages=${row.e8m.passageCount} ${e8mc ? "ok  " : "WRONG"}]`,
    );
  }
  const v0Score = rows.filter(v0Correct).length;
  const e8mScore = rows.filter(e8mCorrect).length;
  console.log(`\nTOTAL: V0 correct ${v0Score}/${rows.length}, E8M correct ${e8mScore}/${rows.length}`);

  console.log("\n" + "-".repeat(108));
  console.log("SECTION B: FALSE-POSITIVE GUARDRAIL INVESTIGATION (GENERIC / SAME_TOPIC under E8M default config)");
  console.log("-".repeat(108));
  for (const row of rows.filter((r) => r.fixture.expected !== "COPIED")) {
    console.log(`  ${row.fixture.id.padEnd(32)} matchedWordCount=${row.e8m.matchedWordCount} passageCount=${row.e8m.passageCount} containment=${fmt(row.e8m.containment)} ${row.e8m.matchedWordCount === 0 ? "(zero evidence — anchors never even seeded)" : "(NONZERO — investigate)"}`);
  }

  console.log("\n" + "-".repeat(108));
  console.log("SECTION C: PARTIAL_COPY passage-quality check (known copied zone = paragraphs 1-4 of the E8J fixture)");
  console.log("-".repeat(108));
  {
    const row = rows.find((r) => r.fixture.id === "partial-copy")!;
    const copiedZoneWordCount = tokens(PARTIAL_COPY_DOCUMENT.split("\n\n").slice(0, 4).join("\n\n")).length;
    console.log(`  copied zone: word positions 0-${copiedZoneWordCount - 1}`);
    console.log(`  E8M matchedWordCount=${row.e8m.matchedWordCount}, passages=${row.e8m.passageCount}`);
    for (const p of row.e8m.passages) {
      const within = p.submittedWordEnd < copiedZoneWordCount;
      console.log(`    [${p.submittedWordStart}-${p.submittedWordEnd}] ${p.matchedWordCount} words — ${within ? "WITHIN copied zone (correct)" : "OUTSIDE copied zone (unexpected)"}`);
    }
    console.log(`  V0 matchedWordCount=${row.v0.matchedWordCount} (E8J/E8K's already-established finding — reproduced here unmodified)`);
  }

  console.log("\n" + "-".repeat(108));
  console.log("SECTION D: GAP TOLERANCE SWEEP (0,1,2,3,5,8,10) — recovery on COPIED fixtures vs false positives on GENERIC/SAME_TOPIC");
  console.log("-".repeat(108));
  for (const gapTolerance of [0, 1, 2, 3, 5, 8, 10]) {
    const config = { ...DEFAULT_ROBUST_CORRESPONDENCE_CONFIG, gapTolerance };
    const swept = evaluateAll(config);
    const copiedCorrect = swept.filter((r) => r.fixture.expected === "COPIED" && e8mCorrect(r)).length;
    const copiedTotal = swept.filter((r) => r.fixture.expected === "COPIED").length;
    const falsePositives = swept.filter((r) => r.fixture.expected !== "COPIED" && r.e8m.matchedWordCount > 0).length;
    console.log(`  gapTolerance=${gapTolerance}: copied recovered=${copiedCorrect}/${copiedTotal}, generic/same-topic false positives=${falsePositives}`);
  }

  console.log("\n" + "-".repeat(108));
  console.log("SECTION E: ANCHOR LENGTH SWEEP (3,4,5,6,7,8) — recovery vs false positives");
  console.log("-".repeat(108));
  for (const anchorSize of [3, 4, 5, 6, 7, 8]) {
    const config = { ...DEFAULT_ROBUST_CORRESPONDENCE_CONFIG, anchorSize };
    const swept = evaluateAll(config);
    const copiedCorrect = swept.filter((r) => r.fixture.expected === "COPIED" && e8mCorrect(r)).length;
    const copiedTotal = swept.filter((r) => r.fixture.expected === "COPIED").length;
    const falsePositives = swept.filter((r) => r.fixture.expected !== "COPIED" && r.e8m.matchedWordCount > 0).length;
    console.log(`  anchorSize=${anchorSize}: copied recovered=${copiedCorrect}/${copiedTotal}, generic/same-topic false positives=${falsePositives}`);
  }

  console.log("\n" + "-".repeat(108));
  console.log("SECTION F: SCORE SEPARATION + PRODUCTION IMMUTABILITY (structural)");
  console.log("-".repeat(108));
  function stripComments(source: string) { return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); }
  for (const file of ["lib/e8m-robust-correspondence.ts", "lib/e8m-robust-correspondence-fixtures.ts"]) {
    const source = stripComments(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
    console.log(`${file}: scoring field=${/\b(archiveScore|report\.score|aiScore|verifiedSimilarity)\b/.test(source) ? "YES-INVESTIGATE" : "no"}, imports production matcher=${/from\s+["'].*user-submission-matching["']/.test(source) ? "YES-INVESTIGATE" : "no"}, imports document-correspondence=${/from\s+["'].*\/document-correspondence["']/.test(source) ? "YES (type-only expected, verify)" : "no"}`);
  }
  const dcSource = fs.readFileSync(path.join(process.cwd(), "lib/document-correspondence.ts"), "utf8");
  console.log(`lib/document-correspondence.ts sha256: ${createHash("sha256").update(dcSource).digest("hex").slice(0, 16)}... (record this and diff on any future run to prove V0 was never touched)`);

  console.log("\n" + "-".repeat(108));
  console.log("SECTION G: PERFORMANCE — indexed candidate generation (production-style) + E8M correspondence stage");
  console.log("-".repeat(108));
  const dbFile = path.join(process.cwd(), "e8m-calibration-local.db");
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ } }
  const client: Client = createClient({ url: `file:${dbFile}` });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));

    const canonicalCandidate = canonicalizeText(INS_DEL_BASE_PASSAGE);
    const rep = await createReusableDocumentRepresentation(client, { canonicalText: canonicalCandidate });
    await recordCorpusShingles(client, rep.id, canonicalCandidate);

    let noiseIndex = 0;
    for (const targetTotal of [1, 100, 500, 1000]) {
      const currentCount = Number((await client.execute("SELECT COUNT(*) AS n FROM corpus_document_representations")).rows[0].n);
      for (let i = 0; i < Math.max(0, targetTotal - currentCount); i += 1) {
        const canonicalText = canonicalizeText(noiseIndex % 2 === 0 ? generateGenericDocument(96000 + noiseIndex, 12) : generateDistinctiveDocument(96000 + noiseIndex, 10));
        noiseIndex += 1;
        const noiseRep = await createReusableDocumentRepresentation(client, { canonicalText });
        await recordCorpusShingles(client, noiseRep.id, canonicalText);
      }
      const countAfter = Number((await client.execute("SELECT COUNT(*) AS n FROM corpus_document_representations")).rows[0].n);

      const query = tokens(INS_DEL_BASE_PASSAGE).slice(0, 30).join(" "); // a realistic partial-match query
      const candidateStart = performance.now();
      const queryShingles = corpusShingleHashes(query);
      const candidates = await findCandidateCorpusRepresentations(client, queryShingles, { minSharedShingles: 3, limit: 10 });
      const candidateMs = performance.now() - candidateStart;

      const correspondenceStart = performance.now();
      let evaluatedCount = 0;
      for (const candidate of candidates) {
        const candidateRep = await findRepresentationById(client, candidate.representationId);
        if (!candidateRep) continue;
        computeRobustCorrespondence(query, candidateRep.canonicalText);
        evaluatedCount += 1;
      }
      const correspondenceMs = performance.now() - correspondenceStart;

      console.log(`corpus size ${countAfter}: candidate stage=${fmt(candidateMs, 2)}ms (${candidates.length} candidates), E8M correspondence stage=${fmt(correspondenceMs, 2)}ms (${evaluatedCount} evaluated), total=${fmt(candidateMs + correspondenceMs, 2)}ms`);
    }
  } finally {
    client.close();
    for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ } }
  }

  console.log("\n" + "=".repeat(108));
  console.log("REPORT COMPLETE.");
  console.log("=".repeat(108));
}

main().catch((err) => {
  console.error("e8m-correspondence-calibration failed:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
