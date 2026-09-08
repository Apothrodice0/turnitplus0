import assert from "node:assert/strict";
import test from "node:test";
import {
  freshDb, seedCorpus, makeText, spliceSubmission, NONINFORMATIVE_RUN,
} from "./helpers/pmc-coverage-shadow.mjs";
import { winnowSubmissionFingerprints, pmcDocumentFingerprintHashes } from "../lib/pmc-coverage/fingerprint.ts";
import { loadPmcDfBandMap, derivePmcStopHashSet } from "../lib/pmc-coverage/df-bands.ts";
import {
  retrievePmcStageACandidates, loadRetractedPmcIds, loadPmcCandidateTexts,
} from "../lib/pmc-coverage/repository.ts";
import { PMC_MAX_QUERY_FINGERPRINTS } from "../lib/pmc-coverage/constants.ts";

/**
 * Stage A — bounded DF-banded winnowed-fingerprint candidate retrieval.
 * Fingerprint hits only pick candidates; they never score (that is
 * tests/pmc-coverage-verify.test.mjs).
 */

test("Stage A recall@20: the true source of a copied passage is retrieved", async () => {
  const { client, cleanup } = await freshDb("stagea-recall");
  try {
    // 30 distractor docs + 1 true source, each ~600 distinct words.
    const docs = [];
    for (let i = 0; i < 30; i += 1) docs.push({ pmcId: `PMC90${String(i).padStart(3, "0")}`, text: makeText(`distractor-${i}`, 600) });
    const sourceText = makeText("true-source", 600);
    docs.push({ pmcId: "PMC99999", text: sourceText });
    await seedCorpus(client, docs);

    // Submission = unrelated host with a 45-word verbatim passage from the true source.
    const srcWords = sourceText.split(" ");
    const passage = srcWords.slice(120, 165).join(" ");
    const submission = spliceSubmission({ hostSeed: "recall-host", hostWords: 500, passage });

    const q = winnowSubmissionFingerprints(submission);
    const dfMap = await loadPmcDfBandMap(client);
    const stop = derivePmcStopHashSet(dfMap.bandByHash);
    const retracted = await loadRetractedPmcIds(client);
    const result = await retrievePmcStageACandidates(client, q.fingerprints, stop, retracted);

    assert.ok(result.candidates.length > 0, "at least one candidate retrieved");
    assert.ok(result.candidates.length <= 20, "top-K bounded at 20");
    assert.ok(
      result.candidates.some((c) => c.pmcId === "PMC99999"),
      "the true source PMC99999 is among the retrieved candidates (recall@20)",
    );
    // Highest-weight candidate should be the true source (distinctive overlap).
    assert.equal(result.candidates[0].pmcId, "PMC99999", "true source ranks first");
    assert.equal(result.tombstonedHits, 0);
  } finally {
    cleanup();
  }
});

test("Stage A: a common high-DF block is stopped, fan-out stays bounded", async () => {
  const { client, cleanup } = await freshDb("stagea-df");
  try {
    // A shared 60-word block appears in 16 docs => its 5-grams have DF 16 >= 13
    // => they land in pmc_hash_df_bands and become stop hashes.
    const sharedBlock = makeText("shared-common-block", 60);
    const docs = [];
    for (let i = 0; i < 16; i += 1) {
      docs.push({
        pmcId: `PMC80${String(i).padStart(3, "0")}`,
        text: `${makeText(`unique-${i}`, 300)} ${sharedBlock} ${makeText(`tail-${i}`, 200)}`,
      });
    }
    // one doc with a distinctive passage that should still retrieve cleanly
    const distinctText = makeText("distinctive-doc", 600);
    docs.push({ pmcId: "PMC80999", text: distinctText });
    const seedResult = await seedCorpus(client, docs);
    assert.ok(seedResult.dfBands.persistedRows > 0, "shared-block 5-grams were persisted as DF bands");

    const dfMap = await loadPmcDfBandMap(client);
    const stop = derivePmcStopHashSet(dfMap.bandByHash);
    const retracted = await loadRetractedPmcIds(client);

    // Submission carries ONLY the common block => most of its query fingerprints
    // are stopped, and it does not fan out to all 16 docs.
    const commonSub = spliceSubmission({ hostSeed: "common-host", hostWords: 200, passage: sharedBlock });
    const q1 = winnowSubmissionFingerprints(commonSub);
    const r1 = await retrievePmcStageACandidates(client, q1.fingerprints, stop, retracted);
    assert.ok(r1.stoppedFingerprints >= 1, "at least one common-block fingerprint is stopped by the DF-band set");
    assert.equal(r1.truncated, false, "the scan stays within its posting-row bound");

    // Submission carrying a distinctive passage still retrieves its one true source.
    const dWords = distinctText.split(" ");
    const distinctSub = spliceSubmission({ hostSeed: "d-host", hostWords: 400, passage: dWords.slice(100, 150).join(" ") });
    const q2 = winnowSubmissionFingerprints(distinctSub);
    const r2 = await retrievePmcStageACandidates(client, q2.fingerprints, stop, retracted);
    assert.ok(r2.candidates.some((c) => c.pmcId === "PMC80999"), "distinctive passage still retrieves its true source");
  } finally {
    cleanup();
  }
});

test("Stage A: retracted (tombstoned) documents are never returned as candidates", async () => {
  const { client, cleanup } = await freshDb("stagea-tombstone");
  try {
    const sharedText = makeText("retraction-target", 600);
    await seedCorpus(client, [
      { pmcId: "PMC70001", text: sharedText, isRetracted: true },
      { pmcId: "PMC70002", text: makeText("other", 600) },
    ]);

    const words = sharedText.split(" ");
    const submission = spliceSubmission({ hostSeed: "tomb-host", hostWords: 400, passage: words.slice(80, 140).join(" ") });
    const q = winnowSubmissionFingerprints(submission);
    const dfMap = await loadPmcDfBandMap(client);
    const stop = derivePmcStopHashSet(dfMap.bandByHash);
    const retracted = await loadRetractedPmcIds(client);
    assert.ok(retracted.has("PMC70001"), "PMC70001 is in the tombstone set");

    const result = await retrievePmcStageACandidates(client, q.fingerprints, stop, retracted);
    assert.ok(!result.candidates.some((c) => c.pmcId === "PMC70001"), "the retracted doc is excluded from candidates");
    assert.ok(result.tombstonedHits > 0, "its posting hits were counted as tombstoned");

    // ...and even if forced in, loadPmcCandidateTexts refuses it.
    const texts = await loadPmcCandidateTexts(client, ["PMC70001", "PMC70002"]);
    assert.ok(!texts.some((t) => t.pmcId === "PMC70001"), "loadPmcCandidateTexts also excludes retracted docs");
  } finally {
    cleanup();
  }
});

test("Stage A: winnowed submission fingerprints are hard-capped (explicit maximum query fingerprints)", async () => {
  // A very long submission still produces at most PMC_MAX_QUERY_FINGERPRINTS.
  const long = makeText("very-long-submission", 120_000);
  const q = winnowSubmissionFingerprints(long);
  assert.ok(q.rawCount > PMC_MAX_QUERY_FINGERPRINTS, "raw winnow count exceeds the cap for this input");
  assert.equal(q.fingerprints.length, PMC_MAX_QUERY_FINGERPRINTS, "queried set is clamped to the cap");
  assert.equal(q.trimmed, true);
  // deterministic: the kept set is the numerically-lowest hashes
  const sorted = [...q.fingerprints].sort();
  assert.deepEqual(q.fingerprints, sorted, "kept fingerprints are the lowest hashes, in order");
});

test("Stage A: a non-informative shared run still produces a shared fingerprint (retrieval != scoring)", async () => {
  const { client, cleanup } = await freshDb("stagea-noninformative");
  try {
    await seedCorpus(client, [
      { pmcId: "PMC60001", text: `${makeText("nf-doc-head", 200)} ${NONINFORMATIVE_RUN} ${makeText("nf-doc-tail", 200)}` },
      { pmcId: "PMC60002", text: makeText("nf-other", 500) },
    ]);
    const docFps = new Set(pmcDocumentFingerprintHashes(`${makeText("nf-doc-head", 200)} ${NONINFORMATIVE_RUN} ${makeText("nf-doc-tail", 200)}`));

    const submission = spliceSubmission({ hostSeed: "nf-host", hostWords: 300, passage: NONINFORMATIVE_RUN });
    const q = winnowSubmissionFingerprints(submission);
    assert.ok(q.fingerprints.some((h) => docFps.has(h)), "submission shares a winnowed fingerprint with the non-informative doc");

    const dfMap = await loadPmcDfBandMap(client);
    const stop = derivePmcStopHashSet(dfMap.bandByHash);
    const retracted = await loadRetractedPmcIds(client);
    const result = await retrievePmcStageACandidates(client, q.fingerprints, stop, retracted);
    assert.ok(result.candidates.some((c) => c.pmcId === "PMC60001"), "Stage A retrieves it on the shared fingerprint alone — scoring happens later");
  } finally {
    cleanup();
  }
});
