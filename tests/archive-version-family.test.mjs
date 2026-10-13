import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { gramHash, grams, tokens } from "../lib/similarity-core.ts";
import {
  ARCHIVE_VERSION_MINIMUM_CONTAINMENT,
  normalizedArchiveTitle,
  scoreAgainstArchive,
} from "../lib/archive-similarity-scoring.ts";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";

/**
 * Same-work versions in the archive: when a submission self-excludes an
 * archive record (it IS that record), another archive record with the same
 * normalized title that still shares a substantial part of the submission is
 * an earlier/later version of the same work and is excluded too. Neither the
 * title alone (a same-titled record with little overlap is still a source)
 * nor overlap alone (a differently titled record with the same overlap is
 * still a source) excludes anything, and nothing changes when the submission
 * self-excludes no record. On the server path the rule is applied to scoring
 * only: candidate discovery is exactly what it is without it, so no
 * independent source goes undiscovered because a version stopped covering
 * part of the text.
 */

const SYLLABLES = ["ka", "lo", "mi", "ru", "te", "sa", "no", "vi", "be", "zu", "fo", "ge"];
const word = (index) => {
  let value = "";
  for (let rest = index + SYLLABLES.length ** 2, digits = 0; digits < 3; digits += 1, rest = Math.floor(rest / SYLLABLES.length)) {
    value += SYLLABLES[rest % SYLLABLES.length];
  }
  return value;
};
const words = (from, count) => Array.from({ length: count }, (_, offset) => word(from + offset));

const TITLE = "The Impact of Digital Transformation on Human Resources";
const SUBMISSION = words(0, 200).join(" ");

function index(sources) {
  const postings = new Map();
  const articles = sources.map(({ title, text }, sourceIndex) => {
    const hashes = new Set(grams(tokens(text), 5).map(gramHash));
    for (const hash of hashes) postings.set(hash, [...(postings.get(hash) ?? []), sourceIndex]);
    return { title, sourceType: "Publication", uniqueShingleCount: hashes.size };
  });
  return {
    shingleSize: 5,
    documentCount: articles.length,
    maximumDocumentFrequency: 12,
    articles,
    getPostings: (hash) => postings.get(hash) ?? [],
  };
}

const range = (start, end) => Array.from({ length: end - start + 1 }, (_, offset) => start + offset);

// ── server-path fixtures: two archives identical except the version record's title ──
// (every top-level await resolves before the first test())
const SERVER_SUBMISSION = words(0, 240);
const OTHER_TITLE = "A Survey of Supply Chain Practices";
async function seededArchive(file, versionTitle) {
  const dbFile = path.join(process.cwd(), file);
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));
  const docs = [
    { id: "vf-self", title: TITLE, body: SERVER_SUBMISSION.join(" ") },
    { id: "vf-version", title: versionTitle, body: [...SERVER_SUBMISSION.slice(0, 150), ...words(1000, 90)].join(" ") },
    { id: "vf-independent", title: "Organisational Change in Public Administration", body: [...words(1200, 120), ...SERVER_SUBMISSION.slice(170, 200), ...words(1350, 120)].join(" ") },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `vf-filler-${i}`, title: `Unrelated Filler Study ${i}`, body: words(500 + 100 * i, 90).join(" ") })),
  ];
  for (const [order, doc] of docs.entries()) {
    const r = await seedArchiveDocument(client, { archiveArticleId: doc.id, title: doc.title, originalSimilarity: null, text: doc.body, archiveOrder: order }, {
      corpusVersion: "test-version-family-v1",
      firstSeenAt: "2020-01-01 00:00:00",
    });
    assert.equal(r.status, "SEEDED", `fresh seed for ${doc.id}`);
  }
  await rebuildArchiveScalableIndex(client);
  return { client, dbFile };
}
const sameTitleArchive = await seededArchive("test_archive_version_family_same.db", TITLE);
const otherTitleArchive = await seededArchive("test_archive_version_family_other.db", OTHER_TITLE);
test.after(() => {
  for (const { client, dbFile } of [sameTitleArchive, otherTitleArchive]) {
    client.close();
    for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
  }
});

test("a same-titled earlier version of a self-excluded record is excluded with it", () => {
  const result = scoreAgainstArchive(SUBMISSION, index([
    { title: TITLE, text: SUBMISSION }, // the submission itself (containment 1)
    { title: "the impact of DIGITAL transformation on human resources.", text: [...words(0, 120), ...words(1000, 80)].join(" ") }, // draft, ~0.59
    { title: TITLE, text: [...words(0, 40), ...words(1200, 160)].join(" ") }, // same title, ~0.18: still a source
    { title: "Organisational Change in Public Administration", text: [...words(80, 120), ...words(1400, 80)].join(" ") }, // other work, ~0.59
  ]), { minimumMatchedWords: 6 });

  assert.equal(result.excludedDocuments, 2);
  assert.deepEqual(result.sources.map((source) => source.sourceIndex).sort(), [2, 3]);
  assert.deepEqual(result.archiveMatchedPositions, [...range(0, 39), ...range(80, 199)]);
});

test("without the version rule's evidence nothing extra is excluded", () => {
  // Same-titled record below the containment floor: a source, not a version.
  const low = scoreAgainstArchive(SUBMISSION, index([
    { title: TITLE, text: SUBMISSION },
    { title: TITLE, text: [...words(0, 80), ...words(1000, 120)].join(" ") }, // ~0.39
  ]), { minimumMatchedWords: 6 });
  assert.ok(76 / 196 < ARCHIVE_VERSION_MINIMUM_CONTAINMENT);
  assert.equal(low.excludedDocuments, 1);
  assert.deepEqual(low.archiveMatchedPositions, range(0, 79));

  // No record self-excludes: two same-titled partial copies stay sources.
  const partial = [...words(0, 120), ...words(9000, 80)].join(" ");
  const none = scoreAgainstArchive(partial, index([
    { title: TITLE, text: [...words(0, 120), ...words(1000, 80)].join(" ") },
    { title: TITLE, text: [...words(0, 60), ...words(1200, 140)].join(" ") },
  ]), { minimumMatchedWords: 6 });
  assert.equal(none.excludedDocuments, 0);
  assert.deepEqual(none.archiveMatchedPositions, range(0, 119));

  // A title under three words never forms a family.
  const short = scoreAgainstArchive(SUBMISSION, index([
    { title: "Introduction", text: SUBMISSION },
    { title: "introduction", text: [...words(0, 120), ...words(1000, 80)].join(" ") },
  ]), { minimumMatchedWords: 6 });
  assert.equal(short.excludedDocuments, 1);
  assert.deepEqual(short.archiveMatchedPositions, range(0, 119));
});

test("excludeSameWorkVersions: false scores exactly as if the version carried another title", () => {
  const sources = (draftTitle) => [
    { title: TITLE, text: SUBMISSION },
    { title: draftTitle, text: [...words(0, 120), ...words(1000, 80)].join(" ") },
  ];
  const off = scoreAgainstArchive(SUBMISSION, index(sources(TITLE)), { minimumMatchedWords: 6 }, undefined, { excludeSameWorkVersions: false });
  const otherTitle = scoreAgainstArchive(SUBMISSION, index(sources(OTHER_TITLE)), { minimumMatchedWords: 6 });
  assert.equal(off.excludedDocuments, 1);
  assert.deepEqual(off.archiveMatchedPositions, range(0, 119));
  assert.deepEqual({ ...off, sources: off.sources.map(({ name, ...rest }) => rest) }, { ...otherTitle, sources: otherTitle.sources.map(({ name, ...rest }) => rest) });
});

test("server path: the version is excluded from scoring only — discovery is unchanged and independent sources keep their credit", async () => {
  const options = { maximumDocumentFrequency: 12, matchingParameters: { maximumDocumentFrequency: 12, minimumMatchedWords: 6 } };
  const same = await matchAgainstArchiveCorpus(sameTitleArchive.client, SERVER_SUBMISSION.join(" "), options);
  const other = await matchAgainstArchiveCorpus(otherTitleArchive.client, SERVER_SUBMISSION.join(" "), options);

  // Discovery never sees the rule: identical candidates, probes and seeds.
  assert.deepEqual(same.archiveDiscovery, other.archiveDiscovery);

  // Another work with the same overlap is an ordinary source …
  assert.equal(other.excludedDocuments, 1);
  assert.equal(other.sources.find((source) => source.name === OTHER_TITLE)?.matchedWords, 150);
  // … the same work is excluded with the self record.
  assert.equal(same.excludedDocuments, 2);
  assert.ok(!same.sources.some((source) => source.name === TITLE));

  // The independent source keeps its 30 words either way.
  for (const result of [same, other]) {
    assert.equal(result.sources.find((source) => source.name.startsWith("Organisational"))?.matchedWords, 30);
  }
  assert.deepEqual(same.archiveMatchedPositions, range(170, 199));
});

test("normalizedArchiveTitle ignores case, diacritics and punctuation; short titles have no key", () => {
  assert.equal(normalizedArchiveTitle("L'Économie  Numérique: Défis!"), "l economie numerique defis");
  assert.equal(normalizedArchiveTitle(TITLE), normalizedArchiveTitle(`  ${TITLE.toUpperCase()}.`));
  assert.notEqual(normalizedArchiveTitle("أثر التحول الرقمي على الموارد البشرية"), "");
  assert.equal(normalizedArchiveTitle("أَثَرُ التَّحَوُّلِ الرَّقْمِيّ"), normalizedArchiveTitle("أثر التحول الرقمي"));
  assert.equal(normalizedArchiveTitle("Introduction"), "");
  assert.equal(normalizedArchiveTitle("Case study"), "");
  assert.equal(normalizedArchiveTitle(""), "");
});
