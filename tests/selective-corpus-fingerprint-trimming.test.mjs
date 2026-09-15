import assert from "node:assert/strict";
import test from "node:test";

import { winnowSubmissionFingerprints } from "../lib/selective-corpus/fingerprint.ts";
import { SELECTIVE_CORPUS_MAX_QUERY_FINGERPRINTS } from "../lib/selective-corpus/constants.ts";

/**
 * Selective Corpus query-fingerprint TRIMMING telemetry -- focused coverage
 * for the real winnowSubmissionFingerprints(...) (lib/selective-corpus/fingerprint.ts),
 * which is NOT modified by this telemetry work. These tests exist to prove
 * the {rawCount, trimmed} metadata that lib/selective-corpus/stage-a.ts now
 * threads through into shadow telemetry is exactly what the real function
 * (not a mock) produces, on both sides of the cap.
 *
 * No exact hash values are asserted anywhere here -- only rawCount, trimmed,
 * and fingerprints.length, all of which are cap/count-shaped, never
 * content-derived strings.
 */

// Deterministic (non-random) pseudo-text generator, same shape as the
// SHARD_QUERY_TEXT pattern already used by
// tests/selective-corpus-shadow-telemetry.test.mjs, scaled up with larger,
// distinct moduli so the winnowed (post window-15, shingle-5) fingerprint
// count clears SELECTIVE_CORPUS_MAX_QUERY_FINGERPRINTS (4096). Empirically
// verified: 40,000 words -> rawCount=4979, trimmed=true, runtime ~44ms.
function deterministicText(wordCount) {
  return Array.from(
    { length: wordCount },
    (_, i) => `term${(i * 2654435761) % 100003}x${(i * 40503) % 99991}`,
  ).join(" ");
}

test("winnowSubmissionFingerprints: a large, diverse deterministic submission genuinely exceeds the cap", () => {
  const text = deterministicText(40000);
  const result = winnowSubmissionFingerprints(text);

  assert.equal(typeof result.rawCount, "number");
  assert.ok(result.rawCount > SELECTIVE_CORPUS_MAX_QUERY_FINGERPRINTS, `expected rawCount > ${SELECTIVE_CORPUS_MAX_QUERY_FINGERPRINTS}, got ${result.rawCount}`);
  assert.equal(result.trimmed, true);
  assert.equal(result.fingerprints.length, SELECTIVE_CORPUS_MAX_QUERY_FINGERPRINTS);

  // distinctness is preserved by the cap -- trimming never introduces
  // duplicate hashes into the retained set.
  assert.equal(new Set(result.fingerprints).size, result.fingerprints.length);
});

test("winnowSubmissionFingerprints: a small normal document is never trimmed, and rawCount matches the retained count exactly", () => {
  const text =
    "The quick brown fox jumps over the lazy dog near the riverbank while the sun sets slowly behind the distant hills, painting the sky in shades of orange and purple as evening approaches the quiet countryside town.";
  const result = winnowSubmissionFingerprints(text);

  assert.equal(result.trimmed, false);
  assert.equal(result.rawCount, result.fingerprints.length);
  assert.ok(result.rawCount > 0, "a real document produces at least one winnowed fingerprint");
  assert.ok(result.rawCount < SELECTIVE_CORPUS_MAX_QUERY_FINGERPRINTS);
});
