import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadArchiveIndexMeta, findArchiveDocumentMetadata, resolveArchiveDocumentText } from "../lib/e7-archive-adapter.ts";

const repoRoot = path.resolve(".");
const REAL_INDEX_META_PATH = path.join(repoRoot, "public/data/document-index.meta.json");

// --- READ-ONLY ON THE REAL ARCHIVE --------------------------------------------

test("loadArchiveIndexMeta never modifies public/data/document-index.meta.json", () => {
  const before = fs.statSync(REAL_INDEX_META_PATH);
  const beforeHash = createHash("sha256").update(fs.readFileSync(REAL_INDEX_META_PATH)).digest("hex");

  const meta = loadArchiveIndexMeta();
  assert.equal(meta.documentCount, 230);
  assert.equal(meta.articles.length, 230);
  assert.match(meta.corpusVersion, /^archive-v4-230-/);

  const after = fs.statSync(REAL_INDEX_META_PATH);
  const afterHash = createHash("sha256").update(fs.readFileSync(REAL_INDEX_META_PATH)).digest("hex");
  assert.equal(before.mtimeMs, after.mtimeMs, "mtime of the archive index must be unchanged");
  assert.equal(beforeHash, afterHash, "content hash of the archive index must be unchanged");
});

test("findArchiveDocumentMetadata finds a known real archive document and returns null for an unknown id, without mutating the input array", () => {
  const { articles } = loadArchiveIndexMeta();
  const before = JSON.stringify(articles);
  const known = articles[0];
  const found = findArchiveDocumentMetadata(articles, known.id);
  assert.deepEqual(found, known);
  assert.equal(findArchiveDocumentMetadata(articles, "not-a-real-archive-id"), null);
  assert.equal(JSON.stringify(articles), before, "the adapter must not mutate the articles array it was given");
});

test("resolveArchiveDocumentText against this checkout's actual (absent) corpus/ tree reports TEXT_UNAVAILABLE, never fabricated text", () => {
  const { articles } = loadArchiveIndexMeta();
  const metadata = articles[0];
  const result = resolveArchiveDocumentText(metadata, path.join(repoRoot, "corpus"));
  assert.equal(result.status, "TEXT_UNAVAILABLE");
  assert.match(result.reason, /no corpus manifest present/);
  assert.equal(result.metadata.id, metadata.id);
});

// --- TEXT_AVAILABLE / TEXT_UNAVAILABLE PATHS AGAINST A SYNTHETIC FIXTURE ------
// These use a throwaway temp directory outside the repo, standing in for a
// hypothetical corpus/ tree — never the real archive, and never written back
// into the repository.

function makeFixtureCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e7-adapter-fixture-"));
  const textDir = path.join(root, "similarity", "text");
  fs.mkdirSync(textDir, { recursive: true });

  const fixtureText = "This is synthetic fixture text used only to test the adapter's plumbing. It is not real archive content.";
  const textRelPath = path.join("similarity", "text", "fixture-doc.txt");
  fs.writeFileSync(path.join(root, textRelPath), fixtureText, "utf8");
  const sha256 = createHash("sha256").update(fixtureText, "utf8").digest("hex");

  const manifest = [
    {
      id: "fixture-doc-id",
      roles: ["index-source"],
      textPath: textRelPath,
      provenance: { sha256 },
    },
    {
      id: "fixture-doc-id-no-textpath",
      roles: ["index-source"],
      provenance: { sha256: null },
    },
  ];
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { root, fixtureText, sha256 };
}

test("resolveArchiveDocumentText returns TEXT_AVAILABLE with correct text when a matching manifest entry and integrity-checked text file exist", () => {
  const { root, fixtureText } = makeFixtureCorpus();
  try {
    const metadata = { id: "fixture-doc-id", title: "Fixture", sourceType: "Publication", originalSimilarity: null, wordCount: 20, uniqueShingleCount: 15 };
    const result = resolveArchiveDocumentText(metadata, root);
    assert.equal(result.status, "TEXT_AVAILABLE");
    assert.equal(result.submittedText, fixtureText);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveArchiveDocumentText returns TEXT_UNAVAILABLE (never fabricated text) when sha256 integrity check fails", () => {
  const { root } = makeFixtureCorpus();
  try {
    fs.writeFileSync(path.join(root, "similarity", "text", "fixture-doc.txt"), "tampered content that does not match the manifest sha256", "utf8");
    const metadata = { id: "fixture-doc-id", title: "Fixture", sourceType: "Publication", originalSimilarity: null, wordCount: 20, uniqueShingleCount: 15 };
    const result = resolveArchiveDocumentText(metadata, root);
    assert.equal(result.status, "TEXT_UNAVAILABLE");
    assert.match(result.reason, /integrity check/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveArchiveDocumentText returns TEXT_UNAVAILABLE for a document id with no manifest entry, and for one whose entry has no textPath", () => {
  const { root } = makeFixtureCorpus();
  try {
    const unknown = resolveArchiveDocumentText(
      { id: "some-other-archive-id", title: "X", sourceType: "Publication", originalSimilarity: null, wordCount: 1, uniqueShingleCount: 1 },
      root,
    );
    assert.equal(unknown.status, "TEXT_UNAVAILABLE");
    assert.match(unknown.reason, /no index-source manifest entry/);

    const noTextPath = resolveArchiveDocumentText(
      { id: "fixture-doc-id-no-textpath", title: "X", sourceType: "Publication", originalSimilarity: null, wordCount: 1, uniqueShingleCount: 1 },
      root,
    );
    assert.equal(noTextPath.status, "TEXT_UNAVAILABLE");
    assert.match(noTextPath.reason, /no textPath/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveArchiveDocumentText refuses a manifest textPath that escapes the corpus root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e7-adapter-escape-"));
  try {
    const manifest = [{ id: "escape-doc", roles: ["index-source"], textPath: "../../../etc/passwd", provenance: {} }];
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    const result = resolveArchiveDocumentText(
      { id: "escape-doc", title: "X", sourceType: "Publication", originalSimilarity: null, wordCount: 1, uniqueShingleCount: 1 },
      root,
    );
    assert.equal(result.status, "TEXT_UNAVAILABLE");
    assert.match(result.reason, /escapes the corpus root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- WINDOWS ':' -> '_' FALLBACK (the two real archive IDs affected) --------
// D:\Website\corpus's manifest.json (found during E7 data recovery) records
// the literal ':' from these two titles, but the actual files on that
// Windows filesystem were written with '_' in its place. These tests
// reproduce that exact scenario with synthetic fixture text (never real
// archive content) under the two real affected document ids, so the
// fallback logic is proven against the real ids it exists for.

const COLON_AFFECTED_IDS = [
  "adolescent-crisis-and-familial-tension:-from-patterns-of-vertical-identification-to-415719ed314cf21d",
  "causes-and-motivations-of-adolescent-runaway-from-the-family-home:-22b81a24290fa19f",
];

function makeColonFixtureCorpus(id, { tamperText = false, omitSha256 = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e7-adapter-colon-fixture-"));
  const textDir = path.join(root, "similarity", "text");
  fs.mkdirSync(textDir, { recursive: true });

  const fixtureText = `Synthetic fixture text for ${id}. Not real archive content.`;
  const sha256 = createHash("sha256").update(fixtureText, "utf8").digest("hex");

  // Manifest records the literal ':' path (as it would on a non-Windows
  // filesystem where the manifest/text tree was originally built).
  const literalTextPath = path.posix.join("similarity", "text", `${id}.txt`);
  // The on-disk file — as actually observed on Windows — has '_' in place
  // of every ':'.
  const onDiskTextPath = literalTextPath.replace(/:/g, "_");
  fs.writeFileSync(path.join(root, onDiskTextPath), tamperText ? "tampered content, does not match the manifest sha256" : fixtureText, "utf8");

  const manifest = [
    {
      id,
      roles: ["index-source"],
      textPath: literalTextPath,
      provenance: omitSha256 ? {} : { sha256 },
    },
  ];
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { root, fixtureText };
}

for (const id of COLON_AFFECTED_IDS) {
  test(`resolveArchiveDocumentText resolves "${id}" via the Windows ':' -> '_' fallback when the literal path is missing, and verifies it against the manifest sha256`, () => {
    const { root, fixtureText } = makeColonFixtureCorpus(id);
    try {
      const metadata = { id, title: "Fixture", sourceType: "Publication", originalSimilarity: null, wordCount: 5, uniqueShingleCount: 5 };
      const result = resolveArchiveDocumentText(metadata, root);
      assert.equal(result.status, "TEXT_AVAILABLE");
      assert.equal(result.submittedText, fixtureText);
      assert.doesNotMatch(path.basename(result.textSource), /:/, "the resolved filename must be the underscore-substituted name, not the literal colon name");
      assert.match(path.basename(result.textSource), /_-/, "the resolved filename should contain the underscore substitution");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`resolveArchiveDocumentText refuses "${id}" via the ':' fallback when the fallback file's hash does not match the manifest (never silently accepted on filename similarity alone)`, () => {
    const { root } = makeColonFixtureCorpus(id, { tamperText: true });
    try {
      const metadata = { id, title: "Fixture", sourceType: "Publication", originalSimilarity: null, wordCount: 5, uniqueShingleCount: 5 };
      const result = resolveArchiveDocumentText(metadata, root);
      assert.equal(result.status, "TEXT_UNAVAILABLE");
      assert.match(result.reason, /integrity check/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`resolveArchiveDocumentText refuses "${id}" via the ':' fallback when the manifest has no sha256 to verify against`, () => {
    const { root } = makeColonFixtureCorpus(id, { omitSha256: true });
    try {
      const metadata = { id, title: "Fixture", sourceType: "Publication", originalSimilarity: null, wordCount: 5, uniqueShingleCount: 5 };
      const result = resolveArchiveDocumentText(metadata, root);
      assert.equal(result.status, "TEXT_UNAVAILABLE");
      assert.match(result.reason, /filename similarity alone/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("resolveArchiveDocumentText does NOT attempt the ':' fallback for an id whose manifest textPath has no colon at all", () => {
  const { root } = makeFixtureCorpus();
  try {
    fs.unlinkSync(path.join(root, "similarity", "text", "fixture-doc.txt"));
    const metadata = { id: "fixture-doc-id", title: "Fixture", sourceType: "Publication", originalSimilarity: null, wordCount: 20, uniqueShingleCount: 15 };
    const result = resolveArchiveDocumentText(metadata, root);
    assert.equal(result.status, "TEXT_UNAVAILABLE");
    assert.doesNotMatch(result.reason, /fallback/, "no colon in the textPath means no fallback attempt should even be mentioned");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lib/e7-archive-adapter.ts contains no write/delete filesystem call anywhere (writeFileSync, unlinkSync, rmSync, mkdirSync, appendFileSync)", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/e7-archive-adapter.ts"), "utf8");
  assert.doesNotMatch(source, /writeFileSync|unlinkSync|rmSync|mkdirSync|appendFileSync|rmdirSync/, "the archive adapter must be strictly read-only");
});
