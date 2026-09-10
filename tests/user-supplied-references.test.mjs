import assert from "node:assert/strict";
import test from "node:test";

import {
  verifySuppliedReferences,
  safeReferenceLabel,
  suppliedReferenceCacheKey,
  USER_SUPPLIED_REFERENCE_MATCHER_VERSION,
} from "../lib/user-supplied-references.ts";
import {
  sanitizeSuppliedReferenceInputs,
  admittedReferenceEvidenceForUnifiedSimilarity,
  resolveUserSuppliedReferenceEvidenceForSave,
  buildUserSuppliedReferenceGuard,
  USER_SUPPLIED_REFERENCE_GUARD_VERSION,
} from "../lib/report-user-supplied-references.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { withEvidenceInterpretation } from "../lib/report-evidence-interpretation.ts";
import { resolveReportCompletion } from "../lib/evidence-interpretation/index.ts";
import { buildReportV2ViewModel } from "../lib/report-v2-view.ts";
import { tokens } from "../lib/similarity-core.ts";

// ---------------------------------------------------------------------------
// Fixtures — a manuscript with a distinctive ~90-word passage that a supplied
// reference reproduces verbatim (well past STRICT_SPAN: >=60 matched words AND
// >=25 longest contiguous span).
// ---------------------------------------------------------------------------
const SHARED = Array.from({ length: 90 }, (_, i) => `distinctivephrase${i}`).join(" ");
const MANUSCRIPT = `This manuscript opens with some original framing sentences that belong only to the author. ${SHARED} And then the manuscript closes with a further set of the author's own concluding remarks and analysis.`;
const REFERENCE_MATCH = `An unrelated reference introduction paragraph about a different topic entirely. ${SHARED} A different reference conclusion that shares nothing else with the manuscript.`;
const REFERENCE_NO_OVERLAP = "A completely different document about botany, photosynthesis, chloroplasts and the Calvin cycle, sharing no distinctive phrasing with the manuscript at all whatsoever here.";
const MANUSCRIPT_WORDS = tokens(MANUSCRIPT).length;

const ref = (fileName, fileType, extractedText, extraction) => ({ fileName, fileType, extractedText, extraction });
const COMPLETE = { completeness: "COMPLETE", analyzableWordCount: 100, skipped: null, extractor: "x" };

// ── 1/2/3 — manuscript + one matching PDF / DOCX / TXT ───────────────────
for (const fileType of ["pdf", "docx", "txt"]) {
  test(`scenario ${fileType.toUpperCase()}: a matching ${fileType} reference is admitted (STRICT_SPAN) and its verified passages cover the shared phrase`, () => {
    const r = verifySuppliedReferences(MANUSCRIPT, [ref(`source.${fileType}`, fileType, REFERENCE_MATCH, COMPLETE)], MANUSCRIPT_WORDS);
    assert.equal(r.channelState, "COMPLETE");
    assert.equal(r.references.length, 1);
    const ev = r.references[0];
    assert.equal(ev.admitted, true, "STRICT_SPAN pass");
    assert.equal(ev.fileType, fileType);
    assert.ok(ev.matchedWords >= 60, `matched >= 60 (got ${ev.matchedWords})`);
    assert.ok(ev.verifiedPassages.length > 0);
    assert.match(ev.admissionReason, /STRICT_SPAN pass|exact/);
    assert.ok(ev.contributionPercent > 0 && ev.contributionPercent <= 100);
  });
}

// ── 4 — multiple matching references ────────────────────────────────────
test("scenario 4: multiple matching references are each verified and admitted", () => {
  const r = verifySuppliedReferences(
    MANUSCRIPT,
    [ref("a.pdf", "pdf", REFERENCE_MATCH, COMPLETE), ref("b.txt", "txt", `Prefix. ${SHARED} Suffix two.`, COMPLETE)],
    MANUSCRIPT_WORDS,
  );
  assert.equal(r.suppliedCount, 2);
  assert.equal(r.checkedCount, 2);
  assert.equal(r.failedCount, 0);
  assert.equal(r.channelState, "COMPLETE");
  assert.ok(r.references.every((x) => x.admitted));
});

// ── 5 — overlap from two references counts ONCE in the headline ─────────
test("scenario 5: the same submission passage found by TWO references counts once in the unified score", () => {
  const r = verifySuppliedReferences(
    MANUSCRIPT,
    [ref("a.pdf", "pdf", REFERENCE_MATCH, COMPLETE), ref("b.pdf", "pdf", `Other intro. ${SHARED} Other outro.`, COMPLETE)],
    MANUSCRIPT_WORDS,
  );
  const evidence = admittedReferenceEvidenceForUnifiedSimilarity(r.references);
  assert.equal(evidence.length, 2);

  const unified = computeUnifiedSimilarity({ wordCount: MANUSCRIPT_WORDS, userSuppliedReferenceEvidence: evidence });
  const oneRef = computeUnifiedSimilarity({ wordCount: MANUSCRIPT_WORDS, userSuppliedReferenceEvidence: [evidence[0]] });

  assert.deepEqual(
    unified.matchedPositions,
    oneRef.matchedPositions,
    "two references over the same passage produce the SAME matched-position union — counted once",
  );
  assert.equal(unified.uniqueMatchedWords, oneRef.uniqueMatchedWords);
  assert.equal(unified.unifiedScore, oneRef.unifiedScore, "no adjusted / inflated score from a second attributed source");
  // both are still attributed (contributions), just not double-counted
  assert.equal(unified.contributions.length, 2);
  assert.ok(unified.userSuppliedReferenceOnlyWords > 0);
});

// ── 6 — a no-overlap reference contributes nothing ─────────────────────
test("scenario 6: a reference with no distinctive overlap is not admitted and contributes nothing", () => {
  const r = verifySuppliedReferences(MANUSCRIPT, [ref("botany.pdf", "pdf", REFERENCE_NO_OVERLAP, COMPLETE)], MANUSCRIPT_WORDS);
  assert.equal(r.channelState, "COMPLETE", "a checked-but-no-match reference is not a failure");
  assert.equal(r.references[0].admitted, false);
  assert.equal(r.references[0].matchedWords, 0);
  assert.equal(r.references[0].contributionPercent, 0);
  assert.deepEqual(r.references[0].verifiedPassages, []);

  const unified = computeUnifiedSimilarity({
    wordCount: MANUSCRIPT_WORDS,
    userSuppliedReferenceEvidence: admittedReferenceEvidenceForUnifiedSimilarity(r.references),
  });
  assert.deepEqual(unified.matchedPositions, []);
  assert.equal(unified.userSuppliedReferenceOnlyWords, 0);
});

// ── 7 — one failed reference extraction => channel PARTIAL, report still produced
test("scenario 7: one reference that failed extraction => channel PARTIAL, the other references still checked", () => {
  const r = verifySuppliedReferences(
    MANUSCRIPT,
    [
      ref("ok.pdf", "pdf", REFERENCE_MATCH, COMPLETE),
      ref("broken.pdf", "pdf", "", { completeness: "FAILED", analyzableWordCount: 0, skipped: null, extractor: "x" }),
    ],
    MANUSCRIPT_WORDS,
  );
  assert.equal(r.suppliedCount, 2);
  assert.equal(r.checkedCount, 1);
  assert.equal(r.failedCount, 1);
  assert.equal(r.channelState, "PARTIAL");
  const failed = r.references.find((x) => x.safeLabel === "broken.pdf");
  assert.equal(failed.extractionStatus, "FAILED");
  assert.equal(failed.admitted, false);
  // completion: PARTIAL contributes to the report-level PARTIAL state
  const completion = resolveReportCompletion({ userSuppliedReference: "PARTIAL", verifiedSimilarityPercent: 12 });
  assert.equal(completion.state, "PARTIAL");
  assert.ok(completion.reasons.some((x) => /supplied reference/i.test(x)));
});

// ── 8 — no references => existing behaviour byte-equivalent ─────────────
test("scenario 8: no references supplied => computeUnifiedSimilarity output is byte-identical to before the channel existed", () => {
  const base = { wordCount: 500, archiveMatchedPositions: [10, 11, 12, 13, 14] };
  const withNone = computeUnifiedSimilarity(base);
  assert.deepEqual(computeUnifiedSimilarity({ ...base, userSuppliedReferenceEvidence: undefined }), withNone);
  assert.deepEqual(computeUnifiedSimilarity({ ...base, userSuppliedReferenceEvidence: null }), withNone);
  assert.deepEqual(computeUnifiedSimilarity({ ...base, userSuppliedReferenceEvidence: [] }), withNone);
  assert.equal(withNone.userSuppliedReferenceOnlyWords, 0);
  assert.deepEqual(withNone.userSuppliedReferencePositions, []);

  const chan = verifySuppliedReferences(MANUSCRIPT, [], MANUSCRIPT_WORDS);
  assert.equal(chan.channelState, "ABSENT");
  assert.equal(chan.suppliedCount, 0);
});

test("scenario 8b: withEvidenceInterpretation with no reference channel does not add reference fields", () => {
  const report = { id: 1, text: MANUSCRIPT, wordCount: MANUSCRIPT_WORDS, archiveMatchedPositions: [], sources: [] };
  const wired = withEvidenceInterpretation(report, {});
  assert.equal(wired.userSuppliedReferenceEvidence, undefined);
  assert.equal(wired.userSuppliedReferenceChannel, undefined);
  assert.equal(wired.reportCompletion.signals.userSuppliedReference, null);
});

// ── 9 — 100% overlap reference => NOT POSSIBLE_SAME_WORK ───────────────
test("scenario 9: a reference that covers 100% of the manuscript is DISTINCTIVE_EXTERNAL_MATCH, never POSSIBLE_SAME_WORK", () => {
  const whole = verifySuppliedReferences(MANUSCRIPT, [ref("copy.pdf", "pdf", MANUSCRIPT, COMPLETE)], MANUSCRIPT_WORDS);
  assert.equal(whole.references[0].admitted, true);

  const evidence = admittedReferenceEvidenceForUnifiedSimilarity(whole.references);
  const unified = computeUnifiedSimilarity({ wordCount: MANUSCRIPT_WORDS, userSuppliedReferenceEvidence: evidence });
  const report = {
    id: 2, text: MANUSCRIPT, wordCount: MANUSCRIPT_WORDS, archiveMatchedPositions: [], sources: [],
    unifiedSimilarity: unified,
  };
  const wired = withEvidenceInterpretation(report, {
    userSuppliedReferenceEvidence: whole.references,
    userSuppliedReferenceChannel: { state: "COMPLETE", suppliedCount: 1, checkedCount: 1, failedCount: 0 },
  });
  const ei = wired.evidenceInterpretation;
  assert.equal(ei.countsByKind.POSSIBLE_SAME_WORK, 0, "supplying a reference / 100% overlap must NOT activate POSSIBLE_SAME_WORK");
  assert.ok(
    ei.countsByKind.DISTINCTIVE_EXTERNAL_MATCH > 0 || ei.countsByKind.LEGITIMATE_ALTERNATE_SOURCE > 0,
    "the overlap is classified as distinctive external reuse",
  );
  // no COMMON_DEFINITION / COMMON_ACADEMIC_LANGUAGE in the vocabulary
  assert.ok(!("COMMON_DEFINITION" in ei.countsByKind));
  assert.ok(!("COMMON_ACADEMIC_LANGUAGE" in ei.countsByKind));
});

// ── 10 — forged client positions ignored ──────────────────────────────
test("scenario 10: a client cannot forge matched positions — verification recomputes from the text", () => {
  // the client claims a huge match; the actual reference text shares nothing
  const forgedClaim = {
    fileName: "lies.pdf", fileType: "pdf", extractedText: REFERENCE_NO_OVERLAP, extraction: COMPLETE,
    // any of these client-authored fields are simply not read by the sanitiser
    matchedWords: 9999, contributionPercent: 100, verifiedPassages: [{ submittedWordStart: 0, submittedWordEnd: 9999, matchedWordCount: 9999 }],
    admitted: true, interpretation: "POSSIBLE_SAME_WORK",
  };
  const sanitized = sanitizeSuppliedReferenceInputs([forgedClaim]);
  assert.deepEqual(Object.keys(sanitized[0]).sort(), ["extractedText", "extraction", "fileName", "fileType"]);

  const r = verifySuppliedReferences(MANUSCRIPT, sanitized, MANUSCRIPT_WORDS);
  assert.equal(r.references[0].admitted, false, "server matcher run overrides the forged claim");
  assert.equal(r.references[0].matchedWords, 0);
  assert.deepEqual(r.references[0].verifiedPassages, []);
});

// ── 11 — forged client interpretation ignored ─────────────────────────
test("scenario 11: a client cannot forge the interpretation — it is derived from the server-verified spans", () => {
  const whole = verifySuppliedReferences(MANUSCRIPT, [ref("x.pdf", "pdf", REFERENCE_MATCH, COMPLETE)], MANUSCRIPT_WORDS);
  const evidence = admittedReferenceEvidenceForUnifiedSimilarity(whole.references);
  const unified = computeUnifiedSimilarity({ wordCount: MANUSCRIPT_WORDS, userSuppliedReferenceEvidence: evidence });
  const report = {
    id: 3, text: MANUSCRIPT, wordCount: MANUSCRIPT_WORDS, archiveMatchedPositions: [], sources: [], unifiedSimilarity: unified,
    // forged in-payload values
    evidenceInterpretation: { version: "FORGED", positionsByKind: {}, countsByKind: {}, matchedWordCount: 9999, sources: [], passages: [] },
    userSuppliedReferenceEvidence: [{ key: "k", safeLabel: "FORGED", fileType: "pdf", extractionStatus: "COMPLETE", analyzableWordCount: 1, matchedWords: 9999, contributionPercent: 100, admitted: true, admissionReason: "x", verifiedPassages: [{ submittedWordStart: 0, submittedWordEnd: 9999, matchedWordCount: 9999 }] }],
  };
  const wired = withEvidenceInterpretation(report, {
    userSuppliedReferenceEvidence: whole.references, // the SERVER value
    userSuppliedReferenceChannel: { state: "COMPLETE", suppliedCount: 1, checkedCount: 1, failedCount: 0 },
  });
  assert.notEqual(wired.evidenceInterpretation.version, "FORGED");
  const refCard = wired.evidenceInterpretation.sources.find((s) => s.sourceType === "user-supplied-reference");
  assert.ok(refCard, "a supplied-reference source card exists");
  assert.notEqual(refCard.label, "FORGED");
  assert.equal(refCard.label, "x.pdf");
  assert.ok(refCard.matchedWords <= MANUSCRIPT_WORDS, "matched words bounded by the real manuscript");
});

// ── 12 — a supplied reference cannot enter the shared corpus ───────────
test("scenario 12: the user-supplied-references module has ZERO dependency on any shared-corpus admission/promotion/ingestion path", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../lib/user-supplied-references.ts", import.meta.url), "utf8");
  const srcIntegration = await fs.readFile(new URL("../lib/report-user-supplied-references.ts", import.meta.url), "utf8");
  const forbidden = [
    "corpus-admission", "corpus-promotion", "corpus-admission-gate", "corpus-admission-report-integration",
    "archive-publication", "publishArchive", "user-submission-corpus", "selective-corpus/ingest",
    "selective-corpus/shadow", "selective-corpus/artifact", "ingestCorpus", "promoteToCorpus",
  ];
  for (const f of forbidden) {
    assert.ok(!src.includes(f), `lib/user-supplied-references.ts must not reference ${f}`);
    assert.ok(!srcIntegration.includes(f), `lib/report-user-supplied-references.ts must not reference ${f}`);
  }
  // the ONLY corpus-adjacent import it has is the FROZEN STRICT_SPAN constant (read-only, no runtime).
  const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(imports.includes("./selective-corpus/constants"), "reuses the frozen STRICT_SPAN constant");
  assert.ok(!imports.some((i) => /selective-corpus\/(shadow|artifact|verify|shard|stage-a|index)/.test(i)), "no selective-corpus RUNTIME import");
});

// ── 13 — Report V2 safe source card ──────────────────────────────────
test("scenario 13: Report V2 produces a safe 'Supplied reference' source card with contribution %, matched words, interpretation, passages", () => {
  const whole = verifySuppliedReferences(MANUSCRIPT, [ref("my-thesis-draft.pdf", "pdf", REFERENCE_MATCH, COMPLETE)], MANUSCRIPT_WORDS);
  const evidence = admittedReferenceEvidenceForUnifiedSimilarity(whole.references);
  const unified = computeUnifiedSimilarity({ wordCount: MANUSCRIPT_WORDS, userSuppliedReferenceEvidence: evidence });
  const report = {
    id: 4, version: 11, title: "m", author: "", created: new Date().toISOString(),
    text: MANUSCRIPT, wordCount: MANUSCRIPT_WORDS, characterCount: MANUSCRIPT.length,
    score: 20, archiveScore: 20, scoreBand: "Low", matchedWordCount: unified.uniqueMatchedWords,
    sources: [], repeats: [], archiveMatchedPositions: [], unifiedSimilarity: unified,
  };
  const wired = withEvidenceInterpretation(report, {
    userSuppliedReferenceEvidence: whole.references,
    userSuppliedReferenceChannel: { state: "COMPLETE", suppliedCount: 1, checkedCount: 1, failedCount: 0 },
  });
  const vm = buildReportV2ViewModel(wired);
  assert.ok(vm, "a view model is produced");
  const card = vm.sources.find((s) => s.sourceType === "user-supplied-reference");
  assert.ok(card, "a supplied-reference source card is present");
  assert.equal(card.badge, "Supplied reference");
  assert.equal(card.label, "my-thesis-draft.pdf");
  assert.ok(card.contributionPercent > 0);
  assert.ok(card.matchedWords >= 60);
  assert.ok(card.primaryKind, "the card carries a primary interpretation kind");
  assert.ok(typeof card.primaryLabel === "string" && card.primaryLabel.length > 0);
  assert.ok(card.passageRefs.length > 0 || vm.passages.length > 0);
  assert.equal(card.isGeneric, false, "a supplied reference is attributable (named file), not a generic bucket");
});

// ── 14 — privacy serialization clean ─────────────────────────────────
test("scenario 14: the persisted/served reference evidence carries no path, upload id, account id, hash, db id, or Passport data", () => {
  const whole = verifySuppliedReferences(
    MANUSCRIPT,
    [ref("C:\\\\Users\\\\me\\\\secret\\\\thesis.pdf", "pdf", REFERENCE_MATCH, COMPLETE)],
    MANUSCRIPT_WORDS,
  );
  const evidence = whole.references;
  const unified = computeUnifiedSimilarity({
    wordCount: MANUSCRIPT_WORDS,
    userSuppliedReferenceEvidence: admittedReferenceEvidenceForUnifiedSimilarity(evidence),
  });
  const report = { id: 5, text: MANUSCRIPT, wordCount: MANUSCRIPT_WORDS, archiveMatchedPositions: [], sources: [], unifiedSimilarity: unified };
  const wired = withEvidenceInterpretation(report, {
    userSuppliedReferenceEvidence: evidence,
    userSuppliedReferenceChannel: { state: "COMPLETE", suppliedCount: 1, checkedCount: 1, failedCount: 0 },
  });
  const json = JSON.stringify({
    userSuppliedReferenceEvidence: wired.userSuppliedReferenceEvidence,
    userSuppliedReferenceChannel: wired.userSuppliedReferenceChannel,
    evidenceInterpretation: wired.evidenceInterpretation,
    unifiedSimilarity: { ...wired.unifiedSimilarity, contributions: [] }, // contributions are admin-only (stripped for ordinary users, same as today)
  });
  assert.ok(!/C:\\\\|\/Users\/|secret|[\\/]thesis\.pdf/.test(json), "no filesystem path");
  assert.equal(wired.userSuppliedReferenceEvidence[0].safeLabel, "thesis.pdf", "only the basename survives");
  assert.ok(!/[a-f0-9]{32,}/i.test(json), "no content hash / 32-hex id");
  assert.ok(!/passport|provenance|deviceKey|accountId|representationId/i.test(json), "no passport/provenance/account/representation id");
  // src-N ids only in the interpretation
  for (const s of wired.evidenceInterpretation.sources) assert.match(s.id, /^src-\d+$/);
});

// ── 15 — old saved reports load normally ────────────────────────────
test("scenario 15: a pre-V1 report (no reference fields at all) still wires cleanly", () => {
  const legacy = { id: 6, text: MANUSCRIPT, wordCount: MANUSCRIPT_WORDS, archiveMatchedPositions: [1, 2, 3], sources: [] };
  const wired = withEvidenceInterpretation(legacy, {});
  assert.ok(wired.evidenceInterpretation);
  assert.ok(wired.reportCompletion);
  assert.equal(wired.userSuppliedReferenceEvidence, undefined);
  assert.equal(wired.reportCompletion.signals.userSuppliedReference, null);
  assert.equal(wired.reportCompletion.state, "COMPLETED");
});

// ── admission gate documentation + cache hook ──────────────────────
test("admission gate: the FROZEN STRICT_SPAN thresholds (>=60 matched words AND >=25 longest span) are reused UNCHANGED", () => {
  // a 30-word verbatim run (below the 60-word / but reaches 25-span) is NOT admitted
  const short = Array.from({ length: 30 }, (_, i) => `shortrun${i}`).join(" ");
  const m = `Author intro sentence here for context and padding words. ${short} Author outro sentence with more padding words to round it out.`;
  const rShort = verifySuppliedReferences(m, [ref("s.txt", "txt", `x y z ${short} a b c`, COMPLETE)], tokens(m).length);
  assert.equal(rShort.references[0].admitted, false, "30 verbatim words < 60-word STRICT_SPAN floor => not admitted (gate not loosened)");
  assert.match(rShort.references[0].admissionReason, /fails STRICT_SPAN/);
});

test("cache hook: suppliedReferenceCacheKey is a stable digest of manuscript + reference + extractor/normalizer/matcher versions", () => {
  const a = suppliedReferenceCacheKey({ manuscriptText: MANUSCRIPT, referenceText: REFERENCE_MATCH, fileType: "pdf" });
  const b = suppliedReferenceCacheKey({ manuscriptText: MANUSCRIPT, referenceText: REFERENCE_MATCH, fileType: "pdf" });
  const c = suppliedReferenceCacheKey({ manuscriptText: MANUSCRIPT + " edit", referenceText: REFERENCE_MATCH, fileType: "pdf" });
  assert.equal(a, b, "same pair => same key");
  assert.notEqual(a, c, "changed manuscript => different key");
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("safeReferenceLabel: strips directory components and control chars, bounds length", () => {
  assert.equal(safeReferenceLabel("/home/user/docs/Final Thesis.pdf"), "Final Thesis.pdf");
  assert.equal(safeReferenceLabel("C:\\\\a\\\\b\\\\c.docx"), "c.docx");
  assert.equal(safeReferenceLabel(""), "Supplied reference");
  assert.ok(safeReferenceLabel("x".repeat(500)).length <= 160);
});

test("version tags are present and stable", () => {
  assert.equal(USER_SUPPLIED_REFERENCE_MATCHER_VERSION, "user-supplied-reference-v1");
});

// ---------------------------------------------------------------------------
// ROUTE-LEVEL — the real POST + GET, with the `userSuppliedReferences` sibling
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity } from "./helpers/test-signup.mjs";

const dbFile = path.join(path.resolve("."), "test_user_supplied_refs.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
const dbClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(dbClient, path.join(path.resolve("."), "drizzle"));
test.after(() => {
  dbClient.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let uc = 0;
async function account() {
  uc += 1;
  await resetAuthRateForTest("usr-signup-" + uc);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "usr-signup-" + uc },
    body: JSON.stringify(withTestIdentity({ email: `usr-${uc}@example.test`, password: "usr-pw-123456", username: `usru${uc}`, deviceKey: `usr-dev-${uc}` })),
  }));
  assert.equal(res.status, 201);
  return { deviceKey: `usr-dev-${uc}`, cookie: cookieOf(res), tag: `usr-${uc}` };
}
const RWC = tokens(MANUSCRIPT).length;
async function post(acc, id, extra) {
  await resetRateForTest(acc.tag + "-post");
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": acc.tag + "-post", cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify({
      deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "usr fixture", createdAt: new Date().toISOString(),
      wordCount: RWC, archiveScore: 0, scoreBand: "Low", aiScore: 2, aiTone: "low", aiStatus: "ready", room: 0,
      payload: { version: 11, id, submissionId: "sub-" + id, title: "usr fixture", author: "", assignment: "", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: RWC, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text: MANUSCRIPT },
      ...extra,
    }),
  }));
}
async function readRow(deviceKey, id) {
  const r = await dbClient.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
  return r.rows[0] ? JSON.parse(String(r.rows[0].payload_json)) : null;
}
async function get(acc, id) {
  await resetReadRateForTest(acc.tag + "-get");
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(acc.deviceKey)}`, { headers: { "x-forwarded-for": acc.tag + "-get", cookie: `tp_session_v1=${acc.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  const body = await res.json();
  return body.payload ?? body;
}
const refInput = (fileName, fileType, extractedText) => ({ fileName, fileType, extractedText, extraction: { completeness: "COMPLETE", analyzableWordCount: 100, skipped: null, extractor: "x" } });

test("route: a matching supplied reference is verified server-side, augments the unified score, and produces a safe card; survives GET", async () => {
  const acc = await account();
  const id = "usr-match-1";
  const res = await post(acc, id, { userSuppliedReferences: [refInput("my-source.pdf", "pdf", REFERENCE_MATCH)] });
  assert.equal(res.status, 200);

  const p = await readRow(acc.deviceKey, id);
  assert.ok(Array.isArray(p.userSuppliedReferenceEvidence) && p.userSuppliedReferenceEvidence.length === 1, "verified reference evidence persisted");
  const ev = p.userSuppliedReferenceEvidence[0];
  assert.equal(ev.admitted, true);
  assert.equal(ev.safeLabel, "my-source.pdf");
  assert.ok(ev.matchedWords >= 60);
  assert.equal(p.userSuppliedReferenceChannel.state, "COMPLETE");
  assert.ok(p.unifiedSimilarity.userSuppliedReferencePositions.length >= 60, "reference positions are in the unified union");
  assert.ok(p.unifiedSimilarity.matchedPositions.length >= 60);
  const refCard = p.evidenceInterpretation.sources.find((s) => s.sourceType === "user-supplied-reference");
  assert.ok(refCard, "a supplied-reference card is in the persisted interpretation");
  assert.match(refCard.id, /^src-\d+$/);

  const got = await get(acc, id);
  assert.equal(got.userSuppliedReferenceEvidence[0].admitted, true, "reference evidence survives GET");
  assert.ok(got.unifiedSimilarity.userSuppliedReferencePositions.length >= 60, "reference-augmented score is stable across reload");
  assert.ok(got.evidenceInterpretation.sources.some((s) => s.sourceType === "user-supplied-reference"));
});

test("route: a forged in-payload userSuppliedReferenceEvidence is stripped; only the sibling-derived server value is persisted", async () => {
  const acc = await account();
  const id = "usr-forge-1";
  const res = await post(acc, id, {
    // sibling: an honest no-overlap reference
    userSuppliedReferences: [refInput("real.txt", "txt", REFERENCE_NO_OVERLAP)],
    payload: { version: 11, id, submissionId: "sub-" + id, title: "x", author: "", assignment: "", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: RWC, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text: MANUSCRIPT,
      userSuppliedReferenceEvidence: [{ key: "k", safeLabel: "FORGED", fileType: "pdf", extractionStatus: "COMPLETE", analyzableWordCount: 1, matchedWords: 9999, contributionPercent: 100, admitted: true, admissionReason: "forged", verifiedPassages: [{ submittedWordStart: 0, submittedWordEnd: 5000, matchedWordCount: 5000 }] }],
      userSuppliedReferenceChannel: { state: "COMPLETE", suppliedCount: 1, checkedCount: 1, failedCount: 0 } },
  });
  assert.equal(res.status, 200);
  const p = await readRow(acc.deviceKey, id);
  assert.equal(p.userSuppliedReferenceEvidence[0].safeLabel, "real.txt", "the forged in-payload value did not survive");
  assert.equal(p.userSuppliedReferenceEvidence[0].admitted, false, "the honest sibling reference has no overlap => not admitted");
  assert.deepEqual(p.unifiedSimilarity.userSuppliedReferencePositions, [], "no forged positions in the union");
  assert.deepEqual(p.unifiedSimilarity.matchedPositions, []);
});

test("route: a failed reference extraction => channel PARTIAL, report still succeeds", async () => {
  const acc = await account();
  const id = "usr-partial-1";
  const res = await post(acc, id, {
    userSuppliedReferences: [
      refInput("ok.pdf", "pdf", REFERENCE_MATCH),
      { fileName: "broken.pdf", fileType: "pdf", extractedText: "", extraction: { completeness: "FAILED", analyzableWordCount: 0, skipped: null, extractor: "x" } },
    ],
  });
  assert.equal(res.status, 200, "the manuscript report is still produced");
  const p = await readRow(acc.deviceKey, id);
  assert.equal(p.userSuppliedReferenceChannel.state, "PARTIAL");
  assert.equal(p.userSuppliedReferenceChannel.failedCount, 1);
  assert.equal(p.reportCompletion.state, "PARTIAL");
  assert.ok(p.reportCompletion.reasons.some((x) => /supplied reference/i.test(x)));
  // the good reference still matched
  assert.ok(p.userSuppliedReferenceEvidence.find((r) => r.safeLabel === "ok.pdf").admitted);
});

test("route: no userSuppliedReferences => byte-identical to a plain save (channel absent, not failed)", async () => {
  const acc = await account();
  const withNone = await post(acc, "usr-none-1", {});
  assert.equal(withNone.status, 200);
  const p = await readRow(acc.deviceKey, "usr-none-1");
  assert.equal(p.userSuppliedReferenceEvidence, undefined, "no reference fields on a plain report");
  assert.equal(p.userSuppliedReferenceChannel, undefined);
  assert.equal(p.reportCompletion.signals.userSuppliedReference, null, "channel absent, never 'failed'");
  assert.equal(p.reportCompletion.state, "COMPLETED");
});

test("route: filename-only similarity never contributes — a reference named like the manuscript but with no text overlap is not admitted", async () => {
  const acc = await account();
  const id = "usr-nametrick-1";
  await post(acc, id, { userSuppliedReferences: [refInput("usr fixture.pdf", "pdf", REFERENCE_NO_OVERLAP)] });
  const p = await readRow(acc.deviceKey, id);
  assert.equal(p.userSuppliedReferenceEvidence[0].admitted, false);
  assert.equal(p.userSuppliedReferenceEvidence[0].matchedWords, 0);
  assert.deepEqual(p.unifiedSimilarity.matchedPositions, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// V1.1 — RESAVE + TRUST HARDENING
// ═══════════════════════════════════════════════════════════════════════════

// ── pure: resolveUserSuppliedReferenceEvidenceForSave matrix ─────────────
const persistedEvidenceFixture = [{
  key: "user-supplied-reference:0", safeLabel: "a.pdf", fileType: "pdf", extractionStatus: "COMPLETE",
  analyzableWordCount: 100, matchedWords: 90, contributionPercent: 40, admitted: true,
  admissionReason: "STRICT_SPAN pass", verifiedPassages: [{ submittedWordStart: 14, submittedWordEnd: 103, matchedWordCount: 90 }],
}];
const persistedChannelFixture = { state: "COMPLETE", suppliedCount: 1, checkedCount: 1, failedCount: 0 };

test("V1.1 resolve: FRESH — new references supplied => recompute + new guard", () => {
  const fresh = verifySuppliedReferences(MANUSCRIPT, [ref("new.pdf", "pdf", REFERENCE_MATCH, COMPLETE)], MANUSCRIPT_WORDS);
  const r = resolveUserSuppliedReferenceEvidenceForSave({
    manuscriptText: MANUSCRIPT, freshChannel: fresh,
    persistedEvidenceRaw: persistedEvidenceFixture, persistedChannelRaw: persistedChannelFixture, persistedGuardRaw: null,
  });
  assert.equal(r.action, "FRESH");
  assert.equal(r.evidence[0].safeLabel, "new.pdf");
  assert.equal(r.guard.manuscriptDigest, canonicalSha256(MANUSCRIPT));
  assert.equal(r.guard.guardVersion, USER_SUPPLIED_REFERENCE_GUARD_VERSION);
});

test("V1.1 resolve: CARRY_FORWARD — no new refs, SAME manuscript, compatible guard => persisted evidence reused verbatim", () => {
  const guard = buildUserSuppliedReferenceGuard(MANUSCRIPT);
  const r = resolveUserSuppliedReferenceEvidenceForSave({
    manuscriptText: MANUSCRIPT, freshChannel: null,
    persistedEvidenceRaw: persistedEvidenceFixture, persistedChannelRaw: persistedChannelFixture, persistedGuardRaw: guard,
  });
  assert.equal(r.action, "CARRY_FORWARD");
  assert.deepEqual(r.evidence[0].verifiedPassages, persistedEvidenceFixture[0].verifiedPassages);
  assert.deepEqual(r.channel, persistedChannelFixture);
  assert.equal(r.guard.manuscriptDigest, canonicalSha256(MANUSCRIPT));
});

test("V1.1 resolve: CARRY_FORWARD via legacy fallback — no guard, but persisted manuscript text matches", () => {
  const r = resolveUserSuppliedReferenceEvidenceForSave({
    manuscriptText: MANUSCRIPT, freshChannel: null,
    persistedEvidenceRaw: persistedEvidenceFixture, persistedChannelRaw: persistedChannelFixture, persistedGuardRaw: null,
    persistedManuscriptText: MANUSCRIPT,
  });
  assert.equal(r.action, "CARRY_FORWARD");
});

test("V1.1 resolve: DROPPED_MANUSCRIPT_CHANGED — no new refs, manuscript text changed => evidence removed", () => {
  const guard = buildUserSuppliedReferenceGuard(MANUSCRIPT);
  const r = resolveUserSuppliedReferenceEvidenceForSave({
    manuscriptText: MANUSCRIPT + " a new paragraph the author added later.", freshChannel: null,
    persistedEvidenceRaw: persistedEvidenceFixture, persistedChannelRaw: persistedChannelFixture, persistedGuardRaw: guard,
  });
  assert.equal(r.action, "DROPPED_MANUSCRIPT_CHANGED");
  assert.equal(r.evidence, null);
  assert.equal(r.channel, null);
  assert.equal(r.guard, null);
});

test("V1.1 resolve: DROPPED_VERSION_INCOMPATIBLE — same manuscript but the channel version moved on", () => {
  const r = resolveUserSuppliedReferenceEvidenceForSave({
    manuscriptText: MANUSCRIPT, freshChannel: null,
    persistedEvidenceRaw: persistedEvidenceFixture, persistedChannelRaw: persistedChannelFixture,
    persistedGuardRaw: { manuscriptDigest: canonicalSha256(MANUSCRIPT), channelVersion: "user-supplied-reference-v0-OLD", matcherVersion: "x", guardVersion: "x" },
  });
  assert.equal(r.action, "DROPPED_VERSION_INCOMPATIBLE");
  assert.equal(r.evidence, null);
});

test("V1.1 resolve: NONE — no new refs, nothing persisted", () => {
  const r = resolveUserSuppliedReferenceEvidenceForSave({
    manuscriptText: MANUSCRIPT, freshChannel: null,
    persistedEvidenceRaw: null, persistedChannelRaw: null, persistedGuardRaw: null,
  });
  assert.equal(r.action, "NONE");
  assert.equal(r.evidence, null);
});

test("V1.1 resolve: a FORGED persisted 'admitted' with a 999999-word passage is bounded by sanitisation, not trusted verbatim", () => {
  const forged = [{ key: "k", safeLabel: "x.pdf", admitted: true, verifiedPassages: [{ submittedWordStart: 0, submittedWordEnd: 999999, matchedWordCount: 999999 }], matchedWords: 999999, contributionPercent: 500 }];
  const r = resolveUserSuppliedReferenceEvidenceForSave({
    manuscriptText: MANUSCRIPT, freshChannel: null,
    persistedEvidenceRaw: forged, persistedChannelRaw: persistedChannelFixture,
    persistedGuardRaw: buildUserSuppliedReferenceGuard(MANUSCRIPT),
  });
  // carry-forward only reuses SANITISED persisted evidence (the DB row was
  // itself server-written, but the sanitiser is a defence-in-depth clamp)
  assert.equal(r.action, "CARRY_FORWARD");
  assert.ok(r.evidence[0].contributionPercent <= 100);
});

// ── route-level V1.1 scenarios ─────────────────────────────────────────────
async function resave(acc, id, extra, textOverride) {
  await resetRateForTest(acc.tag + "-resave");
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": acc.tag + "-resave", cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify({
      deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "usr fixture", createdAt: new Date().toISOString(),
      wordCount: tokens(textOverride ?? MANUSCRIPT).length, archiveScore: 0, scoreBand: "Low", aiScore: 7, aiTone: "review", aiStatus: "ready", room: 0,
      payload: { version: 11, id, submissionId: "sub-" + id, title: "usr fixture", author: "", assignment: "", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: tokens(textOverride ?? MANUSCRIPT).length, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text: textOverride ?? MANUSCRIPT },
      ...extra,
    }),
  }));
}

test("V1.1 scenario 1+2: first save computes evidence; a same-manuscript AI resave WITHOUT raw references keeps it", async () => {
  const acc = await account();
  const id = "usr11-carry-1";
  assert.equal((await post(acc, id, { userSuppliedReferences: [refInput("cite.pdf", "pdf", REFERENCE_MATCH)] })).status, 200);
  const first = await readRow(acc.deviceKey, id);
  assert.equal(first.userSuppliedReferenceEvidence[0].admitted, true);
  const firstRefPositions = first.unifiedSimilarity.userSuppliedReferencePositions.length;
  assert.ok(firstRefPositions >= 60);
  assert.ok(first.userSuppliedReferenceGuard, "guard persisted");
  assert.equal(first.userSuppliedReferenceGuard.manuscriptDigest, canonicalSha256(MANUSCRIPT));

  // AI-completion resave: NO userSuppliedReferences sibling, same manuscript text
  assert.equal((await resave(acc, id, {})).status, 200);
  const after = await readRow(acc.deviceKey, id);
  assert.equal(after.userSuppliedReferenceEvidence[0].admitted, true, "carried forward");
  assert.equal(after.userSuppliedReferenceEvidence[0].safeLabel, "cite.pdf");
  assert.equal(after.unifiedSimilarity.userSuppliedReferencePositions.length, firstRefPositions, "reference-augmented score is stable across the resave");
  assert.equal(after.userSuppliedReferenceChannel.state, "COMPLETE");
  assert.ok(after.evidenceInterpretation.sources.some((s) => s.sourceType === "user-supplied-reference"));
});

test("V1.1 scenario 3: a same-manuscript resave WITH new references recomputes/replaces", async () => {
  const acc = await account();
  const id = "usr11-replace-1";
  await post(acc, id, { userSuppliedReferences: [refInput("first.pdf", "pdf", REFERENCE_MATCH)] });
  await resave(acc, id, { userSuppliedReferences: [refInput("second.txt", "txt", REFERENCE_NO_OVERLAP)] });
  const after = await readRow(acc.deviceKey, id);
  assert.equal(after.userSuppliedReferenceEvidence.length, 1);
  assert.equal(after.userSuppliedReferenceEvidence[0].safeLabel, "second.txt", "prior reference evidence replaced");
  assert.equal(after.userSuppliedReferenceEvidence[0].admitted, false, "the new no-overlap reference is not admitted");
  assert.deepEqual(after.unifiedSimilarity.userSuppliedReferencePositions, []);
});

test("V1.1 scenario 4: a changed manuscript + NO references drops the old reference evidence", async () => {
  const acc = await account();
  const id = "usr11-changed-noref-1";
  await post(acc, id, { userSuppliedReferences: [refInput("cite.pdf", "pdf", REFERENCE_MATCH)] });
  assert.ok((await readRow(acc.deviceKey, id)).userSuppliedReferenceEvidence);

  await resave(acc, id, {}, MANUSCRIPT + " A substantial new closing section the author wrote afterwards with fresh material.");
  const after = await readRow(acc.deviceKey, id);
  assert.equal(after.userSuppliedReferenceEvidence, undefined, "old reference evidence removed on a changed manuscript");
  assert.equal(after.userSuppliedReferenceChannel, undefined);
  assert.equal(after.userSuppliedReferenceGuard, undefined);
  assert.deepEqual(after.unifiedSimilarity.userSuppliedReferencePositions, []);
});

test("V1.1 scenario 5: a changed manuscript + NEW references recomputes normally", async () => {
  const acc = await account();
  const id = "usr11-changed-newref-1";
  await post(acc, id, { userSuppliedReferences: [refInput("old.pdf", "pdf", REFERENCE_NO_OVERLAP)] });
  const changedText = "Fresh manuscript intro. " + SHARED + " Fresh manuscript outro paragraph.";
  await resave(acc, id, { userSuppliedReferences: [refInput("new.pdf", "pdf", REFERENCE_MATCH)] }, changedText);
  const after = await readRow(acc.deviceKey, id);
  assert.equal(after.userSuppliedReferenceEvidence[0].safeLabel, "new.pdf");
  assert.equal(after.userSuppliedReferenceEvidence[0].admitted, true);
  assert.equal(after.userSuppliedReferenceGuard.manuscriptDigest, canonicalSha256(changedText));
  assert.ok(after.unifiedSimilarity.userSuppliedReferencePositions.length >= 60);
});

test("V1.1 scenario 6+7: a forged in-payload reference evidence + completion on a resave cannot replace the carried-forward server value", async () => {
  const acc = await account();
  const id = "usr11-forge-resave-1";
  await post(acc, id, { userSuppliedReferences: [refInput("real.pdf", "pdf", REFERENCE_MATCH)] });
  // resave: no sibling, but a forged in-payload evidence + channel claiming a huge match
  await resave(acc, id, {
    payload: { version: 11, id, submissionId: "sub-" + id, title: "usr fixture", author: "", assignment: "", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: MANUSCRIPT_WORDS, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text: MANUSCRIPT,
      userSuppliedReferenceEvidence: [{ key: "k", safeLabel: "FORGED", fileType: "pdf", extractionStatus: "COMPLETE", analyzableWordCount: 1, matchedWords: 8000, contributionPercent: 100, admitted: true, admissionReason: "forged", verifiedPassages: [{ submittedWordStart: 0, submittedWordEnd: 8000, matchedWordCount: 8000 }] }],
      userSuppliedReferenceChannel: { state: "PARTIAL", suppliedCount: 5, checkedCount: 5, failedCount: 4 },
      userSuppliedReferenceGuard: { manuscriptDigest: "0".repeat(64), channelVersion: "user-supplied-reference-v1", matcherVersion: "x", guardVersion: "x" } },
  });
  const after = await readRow(acc.deviceKey, id);
  assert.equal(after.userSuppliedReferenceEvidence[0].safeLabel, "real.pdf", "forged evidence rejected; server-carried value kept");
  assert.equal(after.userSuppliedReferenceChannel.state, "COMPLETE", "forged PARTIAL completion rejected");
  assert.equal(after.userSuppliedReferenceChannel.failedCount, 0);
  assert.equal(after.reportCompletion.state, "COMPLETED");
  assert.ok(after.unifiedSimilarity.userSuppliedReferencePositions.length < 200, "no forged 8000-word span");
});

test("V1.1 scenario 8: a no-reference report resaved is still identical (no reference fields, channel absent)", async () => {
  const acc = await account();
  const id = "usr11-none-resave-1";
  await post(acc, id, {});
  await resave(acc, id, {});
  const after = await readRow(acc.deviceKey, id);
  assert.equal(after.userSuppliedReferenceEvidence, undefined);
  assert.equal(after.userSuppliedReferenceChannel, undefined);
  assert.equal(after.userSuppliedReferenceGuard, undefined);
  assert.equal(after.reportCompletion.signals.userSuppliedReference, null);
});

test("V1.1 scenario 9: the internal carry-forward guard is NEVER in the GET response", async () => {
  const acc = await account();
  const id = "usr11-hide-guard-1";
  await post(acc, id, { userSuppliedReferences: [refInput("cite.pdf", "pdf", REFERENCE_MATCH)] });
  // it IS in the DB blob
  assert.ok((await readRow(acc.deviceKey, id)).userSuppliedReferenceGuard, "guard is persisted in payload_json");
  // it is NOT in the GET payload
  const got = await get(acc, id);
  assert.equal(got.userSuppliedReferenceGuard, undefined, "guard stripped from GET");
  const json = JSON.stringify(got);
  assert.ok(!/manuscriptDigest|guardVersion|userSuppliedReferenceGuard/.test(json), "no guard fields anywhere in the GET response");
  // the reference evidence itself IS served
  assert.ok(got.userSuppliedReferenceEvidence[0].admitted);
});

test("V1.1 scenario 10: the supplied source card stays labelled 'Supplied reference' and never claims independent verification", async () => {
  const acc = await account();
  const id = "usr11-label-1";
  await post(acc, id, { userSuppliedReferences: [refInput("thesis-draft.pdf", "pdf", REFERENCE_MATCH)] });
  const p = await readRow(acc.deviceKey, id);
  const card = p.evidenceInterpretation.sources.find((s) => s.sourceType === "user-supplied-reference");
  assert.equal(card.label, "thesis-draft.pdf");
  const cardJson = JSON.stringify(card).toLowerCase();
  for (const bad of ["independently verified", "discovered source", "verified by turnitplus", "independently authenticated", "external source verified"]) {
    assert.ok(!cardJson.includes(bad), `card must not say "${bad}"`);
  }
  assert.ok(card.interpretation.reasons.some((r) => /you supplied/i.test(r)), "the card explains it is the user's own supplied file");
});

test("V1.1 scenario 11: a carried-forward reference still never enters shared corpus (no corpus module reachable)", async () => {
  const fsp = await import("node:fs/promises");
  const src = await fsp.readFile(new URL("../lib/report-user-supplied-references.ts", import.meta.url), "utf8");
  for (const f of ["corpus-admission", "corpus-promotion", "archive-publication", "user-submission-corpus", "selective-corpus/shadow", "selective-corpus/artifact", "ingestCorpus", "promoteToCorpus"]) {
    assert.ok(!src.includes(f), `report-user-supplied-references.ts must not reference ${f}`);
  }
});

test("V1.1 scenario 12+13: carried-forward positions union is correct and a 100% carried-forward reference still never creates POSSIBLE_SAME_WORK", async () => {
  const acc = await account();
  const id = "usr11-union-samework-1";
  await post(acc, id, { userSuppliedReferences: [refInput("whole-copy.pdf", "pdf", MANUSCRIPT)] });
  await resave(acc, id, {}); // carry forward
  const after = await readRow(acc.deviceKey, id);
  const ei = after.evidenceInterpretation;
  assert.equal(ei.countsByKind.POSSIBLE_SAME_WORK, 0, "100% carried-forward reference must NOT be POSSIBLE_SAME_WORK");
  // positionsByKind is a disjoint partition of the authoritative union
  const partitionTotal = Object.values(ei.positionsByKind).reduce((a, b) => a + b.length, 0);
  assert.equal(partitionTotal, ei.matchedWordCount);
  assert.equal(ei.matchedWordCount, after.unifiedSimilarity.matchedPositions.length);
});
