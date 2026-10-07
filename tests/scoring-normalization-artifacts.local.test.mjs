import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import { grams, gramHash, hasScoringIgnorableFormatCharacter, tokensForScoringNormalization } from "../lib/similarity-core.ts";
import { scoringContractsAgreeOnText } from "../lib/scoring-normalization-artifacts.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { loadArchiveSourceEntries } from "../lib/archive-corpus-seed.ts";
import { archiveIndexNormalizationIdentity } from "../lib/archive-corpus-matching.ts";
import { winnow } from "../lib/archive-fingerprint.ts";
import { loadSelectiveCorpusArtifact } from "../lib/selective-corpus/artifact.ts";
import {
  SELECTIVE_CORPUS_NORMALIZATION_IDENTITY,
  SELECTIVE_CORPUS_EXPECTED_DIGEST,
  SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST,
} from "../lib/selective-corpus/constants.ts";

/**
 * The deterministic proofs behind the scoring-normalization identities this
 * build relies on, re-run from the real bytes whenever they are on disk (each
 * test SKIPS when its data is absent). Read-only.
 *   - the shipped Archive (corpus/, 321 index-source texts) and a read-only
 *     copy of the hosted Archive replica: CONTRACT_INDEPENDENT;
 *   - SELECTIVE_CORPUS_NORMALIZATION_IDENTITY: each declared proof hash and
 *     count, and the dev artifact's v1 build contract from its postings.
 */

const CORPUS_ROOT = path.join(process.cwd(), "corpus");
const META_PATH = path.join(process.cwd(), "public", "data", "document-index.meta.json");
const HAVE_CORPUS = fs.existsSync(path.join(CORPUS_ROOT, "manifest.json")) && fs.existsSync(META_PATH);
const ARCHIVE_REPLICA = process.env.TURNITPLUS_ARCHIVE_REPLICA_DB ?? "D:/TurnitPlusTemp/gold-gap-fix-20261007/archive-321-copy.db";
const SELECTIVE = {
  [SELECTIVE_CORPUS_EXPECTED_DIGEST]: process.env.SELECTIVE_CORPUS_PROOF_ARTIFACT ?? "D:/TurnitPlusTemp/selective-corpus-clean-v4/run-20260912-183619/artifact",
  [SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST]: process.env.SELECTIVE_CORPUS_PROOF_DEV_ARTIFACT ?? "D:/TurnitPlusTemp/selective-corpus-bulk-v1/run-20260909-224038",
};
const SELECTIVE_FIXTURES = process.env.SELECTIVE_CORPUS_FIXTURE_PATH ?? "D:/TurnitPlusTemp/selective-corpus-v1/run-20260909-211001";

test("F. shipped Archive: every index-source text tokenizes identically under v1 and v2", { skip: !HAVE_CORPUS }, () => {
  const entries = loadArchiveSourceEntries(CORPUS_ROOT, META_PATH);
  assert.equal(entries.length, 321);
  const dependent = entries.filter((entry) => !scoringContractsAgreeOnText(canonicalizeText(entry.text)));
  assert.deepEqual(dependent.map((entry) => entry.archiveArticleId), []);
});

test("F. hosted Archive replica: archiveIndexNormalizationIdentity proves the index CONTRACT_INDEPENDENT", { skip: !fs.existsSync(ARCHIVE_REPLICA) }, async () => {
  const client = createClient({ url: `file:///${ARCHIVE_REPLICA}` });
  const readOnly = {
    execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (!/^\s*SELECT/i.test(sql)) throw new Error(`read-only: refused ${sql.slice(0, 40)}`);
      return client.execute(statement);
    },
  };
  try {
    const identity = await archiveIndexNormalizationIdentity(readOnly);
    assert.equal(identity.kind, "CONTRACT_INDEPENDENT");
  } finally {
    client.close();
  }
});

/** docmap rows, each with its source path (lib/selective-corpus/source-loader.ts's rule). */
function selectiveSources(artifactPath) {
  return fs.readFileSync(path.join(artifactPath, "packed", "docmap.tsv"), "utf8").split("\n").filter(Boolean).map((line) => {
    const [ordinal, , family, rawId] = line.split("\t");
    const file = rawId.startsWith("fixture:")
      ? path.join(SELECTIVE_FIXTURES, "families", family, `${rawId.slice(8)}.txt`)
      : path.join(artifactPath, "raw", `${rawId.replace(/^bulk:/, "")}.txt`);
    return { ordinal: Number(ordinal), rawId, file };
  });
}

for (const [digest, artifactPath] of Object.entries(SELECTIVE)) {
  const present = fs.existsSync(path.join(artifactPath, "packed", "docmap.tsv"));
  test(`Selective ${digest.slice(0, 8)}: the declared proof hash and counts are re-derived from the artifact's own texts`, { skip: !present }, () => {
    const proof = crypto.createHash("sha256");
    let holding = 0;
    const dependent = [];
    const sources = selectiveSources(artifactPath);
    for (const source of sources) {
      const bytes = fs.readFileSync(source.file);
      proof.update(`${source.rawId}\t${crypto.createHash("sha256").update(bytes).digest("hex")}\n`);
      const text = bytes.toString("utf8");
      if (hasScoringIgnorableFormatCharacter(text)) holding += 1;
      if (!scoringContractsAgreeOnText(text)) dependent.push(source);
    }
    const declared = SELECTIVE_CORPUS_NORMALIZATION_IDENTITY[digest];
    assert.ok(declared.proof.includes(proof.digest("hex")), "proof hash");
    assert.ok(declared.proof.startsWith(`${sources.length.toLocaleString("en-US")} source texts`), "document count");
    if (declared.kind === "CONTRACT_INDEPENDENT") {
      assert.deepEqual(dependent, []);
      assert.ok(declared.proof.includes(`${holding} hold a scoring-ignorable code point`));
    } else {
      assert.deepEqual(dependent.map((source) => source.rawId), ["fixture:A-wiki-112"]);
    }
  });
}

test("Selective dev artifact: its contract-dependent document's postings were built under v1", { skip: !fs.existsSync(path.join(SELECTIVE[SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST], "packed", "docmap.tsv")) }, async () => {
  const artifactPath = SELECTIVE[SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST];
  const artifact = await loadSelectiveCorpusArtifact(artifactPath, { mode: "in-memory", expectedDigest: SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST });
  const source = selectiveSources(artifactPath).find((entry) => entry.rawId === "fixture:A-wiki-112");
  const text = fs.readFileSync(source.file, "utf8");
  const fingerprints = (version) => new Set(winnow(grams(tokensForScoringNormalization(text, version), 5).map(gramHash), 15).map((entry) => entry.hash));
  const v1 = fingerprints(1);
  const v2 = fingerprints(2);
  const posted = async (hash) => [...((await artifact.postingsAccessor.getPostings(hash)) ?? [])].includes(source.ordinal);
  const onlyV1 = [...v1].filter((hash) => !v2.has(hash) && !artifact.stopHashes.has(hash));
  const onlyV2 = [...v2].filter((hash) => !v1.has(hash) && !artifact.stopHashes.has(hash));
  assert.ok(onlyV1.length > 0 && onlyV2.length > 0);
  for (const hash of onlyV1) assert.equal(await posted(hash), true, `v1-only ${hash} is posted`);
  for (const hash of onlyV2) assert.equal(await posted(hash), false, `v2-only ${hash} is not posted`);
});
