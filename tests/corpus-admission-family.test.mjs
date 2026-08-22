import assert from "node:assert/strict";
import test from "node:test";
import { resolveCorpusArticleFamily } from "../lib/corpus-admission-family.ts";

function candidate(overrides = {}) {
  return { sourceRef: "prior-1", canonicalSha256: "hash-prior", wordCount: 4000, containment: 0.5, ...overrides };
}

test("exact reupload (identical canonical hash) resolves EXACT_DUPLICATE regardless of containment value", () => {
  const result = resolveCorpusArticleFamily(
    { canonicalSha256: "hash-prior", wordCount: 4000 },
    [candidate({ canonicalSha256: "hash-prior", containment: 0 })],
  );
  assert.deepEqual(result, { relation: "EXACT_DUPLICATE", matchedSourceRef: "prior-1" });
});

test("formatting-only change resolves via the exact-hash path in practice — canonicalizeText already normalizes whitespace/line-endings, so two extractions of the same reformatted document hash identically upstream of this function", () => {
  // This module only ever sees hashes; the canonicalization guarantee itself
  // is covered by lib/canonical-text.ts's own tests. Demonstrated here as: a
  // target whose hash exactly matches a prior candidate's hash is EXACT_DUPLICATE
  // no matter how different the two documents' original byte-level formatting was.
  const result = resolveCorpusArticleFamily(
    { canonicalSha256: "same-canonical-hash", wordCount: 4200 },
    [candidate({ canonicalSha256: "same-canonical-hash", wordCount: 4000, containment: 1 })],
  );
  assert.equal(result.relation, "EXACT_DUPLICATE");
});

test("light editing (high containment, compatible length) resolves EDITED_VERSION", () => {
  const result = resolveCorpusArticleFamily(
    { canonicalSha256: "hash-new", wordCount: 4050 },
    [candidate({ canonicalSha256: "hash-old", wordCount: 4000, containment: 0.9 })],
  );
  assert.equal(result.relation, "EDITED_VERSION");
  assert.equal(result.matchedSourceRef, "prior-1");
  assert.equal(result.containment, 0.9);
});

test("partial overlap (high containment but incompatible length — a short excerpt of a much longer article) does NOT resolve as a family match", () => {
  const result = resolveCorpusArticleFamily(
    { canonicalSha256: "hash-excerpt", wordCount: 500 },
    [candidate({ canonicalSha256: "hash-full-article", wordCount: 5000, containment: 0.95 })],
  );
  assert.equal(result.relation, "NONE");
});

test("genuinely different documents (low containment) do not resolve as a family match", () => {
  const result = resolveCorpusArticleFamily(
    { canonicalSha256: "hash-different", wordCount: 4000 },
    [candidate({ canonicalSha256: "hash-other", wordCount: 4100, containment: 0.1 })],
  );
  assert.equal(result.relation, "NONE");
});

test("moderate-but-below-threshold containment does not resolve as a family match, even with compatible length", () => {
  const result = resolveCorpusArticleFamily(
    { canonicalSha256: "hash-a", wordCount: 4000 },
    [candidate({ canonicalSha256: "hash-b", wordCount: 4000, containment: 0.6 })],
  );
  assert.equal(result.relation, "NONE");
});

test("the best (highest-containment) match among several candidates is chosen", () => {
  const result = resolveCorpusArticleFamily(
    { canonicalSha256: "hash-target", wordCount: 4000 },
    [
      candidate({ sourceRef: "low", canonicalSha256: "hash-low", wordCount: 4000, containment: 0.86 }),
      candidate({ sourceRef: "high", canonicalSha256: "hash-high", wordCount: 4000, containment: 0.97 }),
    ],
  );
  assert.equal(result.relation, "EDITED_VERSION");
  assert.equal(result.matchedSourceRef, "high");
});

test("no candidates at all resolves NONE", () => {
  const result = resolveCorpusArticleFamily({ canonicalSha256: "hash-x", wordCount: 4000 }, []);
  assert.deepEqual(result, { relation: "NONE" });
});
