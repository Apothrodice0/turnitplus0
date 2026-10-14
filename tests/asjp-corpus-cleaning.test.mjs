import assert from "node:assert/strict";
import test from "node:test";
import {
  ASJP_CORPUS_CLEANING_VERSION,
  cleanAsjpJournalArticles,
  reconstructAsjpOriginalText,
  splitExtractedPages,
} from "../lib/asjp-corpus-cleaning.ts";

/** Synthetic body text: distinct words per article and page, so nothing repeats by accident. */
const body = (article, page, words = 120) => Array.from({ length: words }, (_, i) => `w${article}p${page}x${i}`).join(" ");
const HEADER = "مجلة الدراسات القانونية المجلد 05 العدد 01 سنة 2025";
const TOPIC = "africaine des droits de l homme et des peuples";

function article(id, { pages = 8, firstPage = 37, topic = false, frontMatter = null } = {}) {
  return {
    id,
    pages: Array.from({ length: pages }, (_, p) => {
      if (frontMatter && p === pages - 1) return frontMatter;
      const middle = topic ? `${body(id, p, 60)} la cour ${TOPIC} ${body(id, p + 100, 60)}` : body(id, p);
      return `${firstPage + p} ${HEADER} ${middle}`;
    }),
  };
}

test("version tag", () => {
  assert.equal(ASJP_CORPUS_CLEANING_VERSION, "asjp-corpus-cleaning-v2");
});

test("a running header and its page numbers are removed from every page; the body is kept word for word", () => {
  const [a] = cleanAsjpJournalArticles([article("a1")]);
  const pages = splitExtractedPages(a.cleanedText);
  assert.equal(pages.length, 8);
  pages.forEach((page, p) => {
    assert.ok(!page.includes("مجلة الدراسات"), `page ${p + 1} still holds the header`);
    assert.ok(page.includes(body("a1", p)), `page ${p + 1} lost body text`);
  });
  assert.deepEqual([...new Set(a.removed.map((r) => r.rule))].sort(), ["PAGE_NUMBER", "RUNNING_HEADER_FOOTER"]);
});

test("a topic phrase recurring in the BODY of most pages is never removed (edge-anchored blocks only)", () => {
  const [a] = cleanAsjpJournalArticles([article("t1", { topic: true })]);
  assert.equal(a.removed.filter((r) => r.text.includes("droits")).length, 0);
  assert.equal(splitExtractedPages(a.cleanedText).filter((p) => p.includes(TOPIC)).length, 8);
});

test("a number at a page edge is removed only when it continues the page-number sequence", () => {
  const pages = Array.from({ length: 6 }, (_, p) => `${HEADER} ${body("n1", p)} ${p === 3 ? "1985" : ""}`.trim());
  const [a] = cleanAsjpJournalArticles([{ id: "n1", pages }]);
  assert.ok(splitExtractedPages(a.cleanedText)[3].endsWith("1985"), "a year ending the body is not a page number");
});

test("journal front matter bundled into several articles is dropped as a shared page", () => {
  const front = body("front-matter", 0, 200);
  const [a, b] = cleanAsjpJournalArticles([article("f1", { frontMatter: front }), article("f2", { frontMatter: front })]);
  for (const x of [a, b]) {
    assert.equal(splitExtractedPages(x.cleanedText).at(-1).trim(), "");
    assert.ok(x.removed.some((r) => r.rule === "SHARED_PAGE"));
    assert.deepEqual(x.duplicatePublications, [], "sharing a front-matter page does not make two articles one work");
  }
});

/** One work published twice in a journal (ASJP 56643 / 68197): own title page and page numbers, the same body pages. */
function duplicatePair() {
  const copy = (id, firstPage, title) => ({
    id,
    pages: Array.from({ length: 8 }, (_, p) => `${firstPage + p} ${HEADER} ${p === 0 ? body(title, 0) : body("samework", p)}`),
  });
  return [copy("d1", 37, "titleone"), copy("d2", 121, "titletwo")];
}

test("the body pages of a duplicate publication are kept in both copies, and the pair is named", () => {
  const [d1, d2, other] = cleanAsjpJournalArticles([...duplicatePair(), article("o1")]);
  for (const x of [d1, d2]) {
    assert.equal(x.removed.filter((r) => r.rule === "SHARED_PAGE").length, 0);
    const pages = splitExtractedPages(x.cleanedText);
    for (let p = 1; p < 8; p += 1) assert.ok(pages[p].includes(body("samework", p)), `${x.id} page ${p + 1} lost body text`);
    assert.ok(pages.every((page) => !page.includes("مجلة الدراسات")), "the running header is still removed");
  }
  assert.deepEqual(d1.duplicatePublications.map((d) => d.id), ["d2"]);
  assert.deepEqual(d2.duplicatePublications.map((d) => d.id), ["d1"]);
  assert.ok(d1.duplicatePublications[0].containmentOfSmaller >= 0.8);
  assert.deepEqual(other.duplicatePublications, []);
});

test("journal furniture needs three different works: a duplicate pair counts once", () => {
  const PHRASE = "received accepted published online first";
  const withPhrase = (a) => ({ ...a, pages: a.pages.map((page, p) => (p === 0 ? `${PHRASE} ${page}` : page)) });
  const [d1, d2] = duplicatePair().map(withPhrase);
  const [o1, o2] = [article("o1"), article("o2")].map(withPhrase);
  const twoWorks = cleanAsjpJournalArticles([d1, d2, o1]);
  for (const x of twoWorks) assert.ok(splitExtractedPages(x.cleanedText)[0].includes(PHRASE), `${x.id}: 2 works are not furniture`);
  const threeWorks = cleanAsjpJournalArticles([d1, d2, o1, o2]);
  for (const x of threeWorks) assert.ok(!splitExtractedPages(x.cleanedText)[0].includes(PHRASE), `${x.id}: 3 works are furniture`);
});

test("a near-empty text is not a duplicate publication of its journal-mates", () => {
  const scan = { id: "s1", pages: Array.from({ length: 3 }, (_, p) => `${37 + p} ${HEADER}`) };
  const [s, a, b] = cleanAsjpJournalArticles([scan, article("a1"), article("a2")]);
  for (const x of [s, a, b]) assert.deepEqual(x.duplicatePublications, []);
});

test("the ledger rebuilds the original text exactly, and the cleaned text is a pure deletion", () => {
  const input = [article("r1"), article("r2", { topic: true }), article("r3", { firstPage: 101 })];
  const cleaned = cleanAsjpJournalArticles(input);
  cleaned.forEach((c, i) => {
    const original = `${input[i].pages.join("\n\n")}\n\n`;
    assert.equal(reconstructAsjpOriginalText(c), original);
    assert.equal(c.originalTokens - c.removedTokens, c.cleanedText.split(/\s+/).filter(Boolean).length);
  });
});

test("an article with nothing repeated is returned unchanged", () => {
  const pages = Array.from({ length: 5 }, (_, p) => body("u1", p));
  const [a] = cleanAsjpJournalArticles([{ id: "u1", pages }]);
  assert.deepEqual(a.removed, []);
  assert.equal(a.cleanedText, `${pages.join("\n\n")}\n\n`);
});
