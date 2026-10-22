/**
 * SIMILARITY PRINT REPORT (2026-10-21) — the printed/PDF similarity report: three fixed introductory pages (cover,
 * overview, sources), then the highlighted manuscript from page 4 (components/report/report-v2/similarity-print-report.tsx,
 * lib/similarity-print-layout.ts).
 *
 * Pins: the same score / counts / evidence as the view model; the exact highlight spans of findHighlightRanges; the
 * full manuscript text, unaltered; source numbering by rank, identical on page 3 and in the manuscript; page numbers
 * that match the pages; no invented cover metadata (never the account email); pages that stay within their sheet.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { tokenSpans, tokens } from "../lib/similarity-core.ts";
import { formatSimilarityPercent, primarySimilarityScore } from "../lib/report-types.ts";
import { buildReportEvidenceInterpretation, resolveReportCompletion, unknownExtractionDiagnostic } from "../lib/evidence-interpretation/index.ts";
import { buildReportV2ViewModel } from "../lib/report-v2-view.ts";
import {
  PRINT_MANUSCRIPT_LAYOUT,
  PRINT_PALETTE,
  printBandColor,
  SOURCES_PAGE_CAPACITY,
  buildPrintCoverFields,
  estimatePrintLines,
  formatPrintSubmittedAt,
  paginateManuscriptForPrint,
  printDocumentTitle,
  printSimilarityScale,
  printSourceIdentity,
  printSourceTone,
  printSourcesPage,
  rankForCharRange,
  rankPrintSources,
} from "../lib/similarity-print-layout.ts";
import { SimilarityPrintReport } from "../components/report/report-v2/similarity-print-report.tsx";
import { findHighlightRanges } from "../components/report/similarity-report-papers.tsx";
import { ReportV2Workspace } from "../components/report/report-v2/report-v2-view.tsx";

// ── fixtures ─────────────────────────────────────────────────────────────
function prose(words) {
  const vocab = ["the", "framework", "governs", "general", "mobilization", "procedures", "during", "periods", "of", "declared", "national", "emergency", "across", "multiple", "sectors", "public", "administration"];
  const out = [];
  for (let i = 0; i < words; i += 1) out.push(vocab[(i * 7 + Math.floor(i / 13)) % vocab.length]);
  // a paragraph break every ~120 words
  return out.map((w, i) => (i > 0 && i % 120 === 0 ? `\n${w}` : w)).join(" ");
}

/** Prose whose wording never repeats, so each matched phrase occurs exactly once (no phrase-search ambiguity). */
function uniqueProse(words) {
  return Array.from({ length: words }, (_, i) => (i > 0 && i % 120 === 0 ? `
term${i}` : `term${i}`)).join(" ");
}

/** A V2 report built through the REAL evidence interpreter: `sourceCount` named sources over `text`. */
function reportWithSources({ text, sourceCount, title = "thesis-final.docx", sameSpanAs = {} }) {
  const spans = tokenSpans(text);
  const wc = tokens(text).length;
  const positions = new Set();
  const evidence = [];
  let cursor = 5;
  for (let i = 0; i < sourceCount; i += 1) {
    const len = Math.max(5, 40 - i);
    let a = cursor;
    let b = Math.min(wc - 1, a + len - 1);
    // sameSpanAs[i] = j: source i also matches (part of) source j's passage — one passage, two sources
    if (sameSpanAs[i] !== undefined) {
      const shared = evidence[sameSpanAs[i]].matchedPassages[0];
      a = shared.submittedWordStart;
      b = Math.min(shared.submittedWordEnd, a + len - 1);
    } else cursor = b + 9;
    if (a >= wc - 1) break;
    for (let w = a; w <= b; w += 1) positions.add(w);
    evidence.push({
      provider: "fixture", providerId: `fx-${i}`, title: `Fixture publication ${i + 1}`, url: `https://journals.example.org/a/${i + 1}`,
      doi: `10.5555/fx.${i + 1}`, publication: "Fixture Journal", year: 2020,
      matchedPassages: [{ submittedWordStart: a, submittedWordEnd: b, matchedWordCount: b - a + 1, submittedText: text.slice(spans[a].start, spans[b].end) }],
    });
  }
  const matched = [...positions].sort((x, y) => x - y);
  const score = Math.round((matched.length / wc) * 100);
  const report = {
    version: 11, id: 42, submissionId: "4471902385", title, author: "owner@example.test", assignment: "",
    created: "2026-10-21T09:42:00.000Z", score, archiveScore: score, wordCount: wc, characterCount: text.length, pageCount: 3,
    fileSize: "214.6 KB", databaseSize: 230, corpusVersion: "fixture", scoreBand: "Low", riskStatus: "Lower", riskTarget: 0, riskCutoff: 0,
    riskCalibration: { auc: 0, precision: 0, recall: 0, sampleSize: 0 },
    features: { maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0, referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0, detectedLanguage: "English" },
    excludedDocuments: 0, matchedWordCount: matched.length, sources: [], repeats: [], text, externalAcademicEvidence: evidence,
    unifiedSimilarity: {
      version: 1, wordCount: wc, unifiedScore: score, uniqueMatchedWords: matched.length, archiveOnlyWords: 0, liveAcademicOnlyWords: 0,
      previousUploadOnlyWords: 0, overlapWords: 0, selfExcludedWords: 0, unknownExcludedWords: 0, deviceSelfExcludedWords: 0,
      userSuppliedReferenceOnlyWords: 0, selectiveCorpusOnlyWords: 0, importedSimilarityEvidenceOnlyWords: 0, contributions: [],
      matchedPositions: matched, previousUploadPositions: [], userSuppliedReferencePositions: [], selectiveCorpusPositions: [], importedSimilarityEvidencePositions: [],
    },
  };
  const ei = buildReportEvidenceInterpretation(report, {});
  const extractionDiagnostic = unknownExtractionDiagnostic();
  const reportCompletion = resolveReportCompletion({ academicSearch: null, selectiveCorpus: null, extraction: extractionDiagnostic, unverifiedCandidateCount: 0, verifiedSimilarityPercent: score });
  return { ...report, evidenceInterpretation: ei, reportCompletion, extractionDiagnostic };
}

const render = (report, submitter = { displayName: "Sample Student", institution: null }) =>
  renderToStaticMarkup(React.createElement(SimilarityPrintReport, { report, submitter }));

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

function pagesOf(html) {
  return [...html.matchAll(/<article class="report-paper spr-page ([^"]*)" data-print-page="(\d+)">([\s\S]*?)<\/article>/g)]
    .map((m) => ({ cls: m[1], n: Number(m[2]), html: m[3] }));
}

/** The manuscript exactly as printed: page text blocks joined, source-number badges removed, tags stripped. */
function printedManuscript(html) {
  return pagesOf(html)
    .filter((p) => p.cls.includes("spr-manuscript"))
    .map((p) => /<div class="spr-manuscript-text"[^>]*>([\s\S]*)<\/div>/.exec(p.html)?.[1] ?? "")
    .map((block) => decode(block.replace(/<sup class="spr-mark-n">[^<]*<\/sup>/g, "").replace(/<[^>]+>/g, "")))
    .join("");
}

// ── pagination ───────────────────────────────────────────────────────────
function assertPagination(text, ranges, label, { allowSplitWord = false } = {}) {
  const pages = paginateManuscriptForPrint(text, ranges);
  assert.equal(pages.map((p) => text.slice(p.start, p.end)).join(""), text, `${label}: pages reconstruct the text exactly`);
  pages.forEach((p, i) => {
    if (i > 0) assert.equal(p.start, pages[i - 1].end, `${label}: contiguous`);
    const budget = (i === 0 ? PRINT_MANUSCRIPT_LAYOUT.firstPageLines : PRINT_MANUSCRIPT_LAYOUT.linesPerPage) + (i === pages.length - 1 ? PRINT_MANUSCRIPT_LAYOUT.tailLines : 0);
    const lines = estimatePrintLines(text, p.start, p.end, ranges);
    if (!allowSplitWord) assert.ok(lines <= budget, `${label}: page ${i + 1} uses ${lines} lines, budget ${budget}`);
    if (i > 0 && !allowSplitWord) assert.ok(/\s/.test(text[p.start - 1]), `${label}: page ${i + 1} starts at a word boundary`);
  });
  return pages;
}

test("PAGINATION: prose, a reference list of short lines, Arabic and French — exact text, every page within its sheet budget, cuts only between words", () => {
  assertPagination(prose(6000), [], "prose");
  const refs = Array.from({ length: 700 }, (_, i) => `[${i + 1}] A. Author. Short reference ${i + 1}. Journal, ${1990 + (i % 30)}.`).join("\n");
  const refPages = assertPagination(refs, [], "short lines");
  assert.ok(refPages.length >= 15, "a page of short lines holds far fewer words than a page of prose");
  const arabic = Array.from({ length: 400 }, () => "يهدف هذا القانون إلى تنظيم التعبئة العامة في أوقات الأزمات الوطنية.").join(" ");
  assertPagination(arabic, [], "arabic");
  const french = Array.from({ length: 120 }, (_, i) => `Paragraphe ${i + 1}. L’étude s’intéresse à l’évolution des systèmes d’information publics et à la qualité des données.`).join("\n\n");
  assertPagination(french, [], "french");
  assert.deepEqual(paginateManuscriptForPrint("", []), []);
});

test("PAGINATION: a highlight shorter than a page is never split across pages; one longer than a page continues, within budget", () => {
  const text = prose(5000);
  const spans = tokenSpans(text);
  const ranges = [];
  for (let w = 30; w + 25 < spans.length; w += 170) ranges.push({ start: spans[w].start, end: spans[w + 25].end });
  const pages = assertPagination(text, ranges, "short highlights");
  for (const b of pages.slice(1).map((p) => p.start)) {
    assert.ok(!ranges.some((r) => b > r.start && b < r.end), `no page break inside a highlight (at ${b})`);
  }
  const whole = [{ start: 0, end: text.length }];
  const longPages = assertPagination(text, whole, "one highlight covering everything");
  assert.ok(longPages.length > 1, "a whole-document match still paginates");
});

test("PAGINATION: trailing whitespace and a final fragment of a line or two join the page before; a longer remainder gets its own page", () => {
  const firstPage = PRINT_MANUSCRIPT_LAYOUT.firstPageLines;
  const lines = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join("\n");
  assert.equal(paginateManuscriptForPrint(`${lines(firstPage)}\n\n   \n`, []).length, 1, "whitespace never makes a blank page");
  assert.equal(paginateManuscriptForPrint(lines(firstPage + 2), []).length, 1, "a two-line tail joins the page");
  assert.equal(paginateManuscriptForPrint(lines(firstPage + 3), []).length, 2, "three lines start a new page");
});

test("PAGINATION: an unbroken run longer than a page is still split and fully kept", () => {
  const run = "x".repeat(20000);
  const pages = paginateManuscriptForPrint(run, []);
  assert.ok(pages.length > 1);
  assert.equal(pages.map((p) => run.slice(p.start, p.end)).join(""), run);
});

// ── ranking and identity ─────────────────────────────────────────────────
test("SOURCES: ranked by matched words (ties by the interpreter's own src-N order, numerically), numbered from 1; page 3 shows the top entries and says how many", () => {
  const vm = { sources: [
    { id: "src-10", matchedWords: 10 }, { id: "src-2", matchedWords: 10 }, { id: "src-3", matchedWords: 30 },
  ] };
  const ranked = rankPrintSources(vm);
  assert.deepEqual(ranked.map((s) => [s.id, s.rank]), [["src-3", 1], ["src-2", 2], ["src-10", 3]]);
  assert.deepEqual(ranked[1].tone, printSourceTone(2));
  const many = rankPrintSources({ sources: Array.from({ length: 40 }, (_, i) => ({ id: `src-${i + 1}`, matchedWords: 100 - i })) });
  const page = printSourcesPage(many);
  assert.equal(page.shown.length, SOURCES_PAGE_CAPACITY);
  assert.equal(page.total, 40);
  assert.equal(page.hidden, 40 - SOURCES_PAGE_CAPACITY);
  // every source highlight is match red (#b42318 on #fde8e8); neighbouring ranks differ in line pattern (and always
  // carry their number)
  assert.equal(PRINT_PALETTE.match, "#b42318");
  assert.equal(PRINT_PALETTE.matchFill, "#fde8e8");
  for (let r = 1; r < 12; r += 1) {
    const a = printSourceTone(r), b = printSourceTone(r + 1);
    assert.equal(a.color, PRINT_PALETTE.match);
    assert.notEqual(a.line, b.line, `ranks ${r} and ${r + 1}`);
  }
});

test("SOURCES: a highlight takes the best-ranked source of the evidence passage it overlaps most", () => {
  const passages = [
    { charStart: 0, charEnd: 50, sourceIds: ["src-10", "src-2"] },
    { charStart: 60, charEnd: 80, sourceIds: ["src-7"] },
  ];
  const rankById = new Map([["src-2", 4], ["src-10", 9], ["src-7", 1]]);
  assert.equal(rankForCharRange(10, 40, passages, rankById), 4);
  assert.equal(rankForCharRange(55, 79, passages, rankById), 1);
  assert.equal(rankForCharRange(90, 99, passages, rankById), null);
});

// ── cover ────────────────────────────────────────────────────────────────
test("COVER: only real fields — the account name (never the email), filename, type, size, words, language, ID; unavailable fields are omitted", () => {
  const report = { title: "مذكرة التخرج.docx", fileSize: "—", wordCount: 0, submissionId: "123", features: { detectedLanguage: "ar" }, author: "someone@example.test" };
  const fields = buildPrintCoverFields(report, null);
  assert.deepEqual(fields.map((f) => f.label), ["Original file", "File type", "Detected language", "Submission ID"]);
  assert.equal(fields.find((f) => f.label === "File type").value, "Word document (DOCX)");
  assert.equal(fields.find((f) => f.label === "Detected language").value, "Arabic");
  assert.ok(!JSON.stringify(fields).includes("@"), "never the email address");
  const named = buildPrintCoverFields({ ...report, fileSize: "2.1 MB", wordCount: 5085 }, { displayName: "Sample Student", institution: null });
  assert.deepEqual(named.slice(0, 1), [{ label: "Submitted by", value: "Sample Student" }]);
  assert.ok(!named.some((f) => f.label === "Institution"), "no unverified institution");
  assert.equal(printDocumentTitle("thesis-final.v2.docx"), "thesis-final.v2");
  assert.equal(formatPrintSubmittedAt("2026-10-21T09:42:00.000Z", "UTC"), "21 October 2026, 09:42 UTC");
  assert.equal(formatPrintSubmittedAt("not a date"), null);
});

// ── the rendered report ──────────────────────────────────────────────────
test("REPORT: exactly three introductory pages, the manuscript from page 4, and every footer reads 'Page n of N' for the real page count", () => {
  const report = reportWithSources({ text: prose(4200), sourceCount: 24 });
  const html = render(report);
  const pages = pagesOf(html);
  assert.deepEqual(pages.slice(0, 4).map((p) => p.cls.split(" ")[0]), ["spr-cover", "spr-overview", "spr-sources", "spr-manuscript"]);
  assert.ok(pages.slice(3).every((p) => p.cls.startsWith("spr-manuscript")), "nothing else after page 3");
  pages.forEach((p, i) => {
    assert.equal(p.n, i + 1);
    assert.match(p.html, new RegExp(`Page ${i + 1} of ${pages.length}<`));
    // the footer is the Submission ID (left) and the page number (right) only — no repeated document title
    assert.match(p.html, new RegExp(`<footer class="spr-foot"><span>Submission ID ${report.submissionId}</span><span class="spr-foot-page">Page ${i + 1} of ${pages.length}</span></footer>`));
  });
  assert.match(pages[0].html, /Highlighted manuscript<\/span><i aria-hidden="true"><\/i><b>4–\d+<\/b>/, "the cover's contents list the manuscript pages");
  assert.match(pages[0].html, /<\/nav><\/div><footer class="spr-foot">/, "nothing sits between the cover's contents and its footer");
  assert.doesNotMatch(html, /spr-cover-note|Similarity measures wording/, "no explanatory footnote on the cover");
});

test("REPORT: the overview shows the authoritative score, counts and evidence of the view model — nothing recomputed", () => {
  const report = reportWithSources({ text: prose(4200), sourceCount: 24 });
  const vm = buildReportV2ViewModel(report);
  const html = render(report);
  const overview = pagesOf(html)[1].html;
  const percent = formatSimilarityPercent(primarySimilarityScore(report), vm.summary.matchedWordCount);
  assert.match(overview, new RegExp(`<div class="spr-score-figure"><strong>${percent}</strong>`));
  for (const [label, value] of [["Matched words", vm.summary.matchedWordCount], ["Words analyzed", vm.summary.totalWordCount], ["Matching evidence entries", vm.summary.matchingEvidenceEntries], ["Highlighted passages", vm.filterCounts.all]]) {
    assert.match(overview, new RegExp(`<dt>${label}</dt><dd>${value.toLocaleString("en-US")}</dd>`), label);
  }
  assert.match(overview, new RegExp(vm.summary.completion.scopeLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/’/g, ".")));
});

test("REPORT: page 3 lists the top entries in rank order and states how many of how many are shown", () => {
  const report = reportWithSources({ text: prose(4200), sourceCount: 24 });
  const vm = buildReportV2ViewModel(report);
  const ranked = rankPrintSources(vm);
  const sourcesPage = pagesOf(render(report))[2].html;
  const rows = [...sourcesPage.matchAll(/<span class="spr-rank"[^>]*>(\d+)<\/span>[\s\S]*?<span class="spr-source-title" dir="auto">([^<]*)<\/span><span class="spr-source-meta" dir="auto">([^<]*?) · /g)];
  assert.equal(rows.length, Math.min(SOURCES_PAGE_CAPACITY, ranked.length));
  rows.forEach((m, i) => {
    assert.equal(Number(m[1]), i + 1);
    assert.equal(decode(m[2]), `Match found #${String(i + 1).padStart(2, "0")}`);
    assert.equal(decode(m[3]), ranked[i].label, "a verified source keeps its own title on the details line");
  });
  assert.ok(ranked.length > SOURCES_PAGE_CAPACITY, "fixture has more entries than fit");
  assert.match(sourcesPage, new RegExp(`Showing the ${SOURCES_PAGE_CAPACITY} highest-ranked of ${ranked.length} matching evidence entries`));
  assert.match(sourcesPage, /The complete inventory — every entry, with its matched passages — is in the interactive TurnitPlus report/);
});

test("SOURCES: rows are 'Match found online #NN' for a verified internet source and 'Match found #NN' otherwise; only verified sources get details", () => {
  const base = { label: "Imported reference match", badge: "Imported reference match", isGeneric: true, sourceType: "imported-similarity-evidence", link: null, doi: null, year: null };
  assert.deepEqual(printSourceIdentity({ ...base, rank: 1 }, 71), { verified: false, title: "Match found #01", details: [], link: null, year: null });
  assert.equal(printSourceIdentity({ ...base, rank: 7 }, 120).title, "Match found #007");
  // even a link or title on a generic entry is never shown
  assert.deepEqual(printSourceIdentity({ ...base, rank: 2, sourceType: "reference-collection", label: "Some archived title", badge: "TurnitPlus reference collection", link: "https://x.example/a" }, 9),
    { verified: false, title: "Match found #02", details: [], link: null, year: null });
  const web = { rank: 4, label: "Waste sorting guide", badge: "Internet source", isGeneric: false, sourceType: "internet", link: "https://www.example.org/guide", doi: null, year: null };
  assert.deepEqual(printSourceIdentity(web, 9), { verified: true, title: "Match found online #04", details: ["Waste sorting guide"], link: { href: "https://www.example.org/guide", text: "www.example.org/guide" }, year: null });
  assert.equal(printSourceIdentity({ ...web, label: "Internet source" }, 9).title, "Match found #04", "an internet entry without its own title is not a verified online match");
  const pub = { rank: 3, label: "A Real Article", badge: "Publication", isGeneric: false, sourceType: "publication", link: "https://journals.example.org/a/3", doi: "10.5555/x", year: 2021 };
  assert.deepEqual(printSourceIdentity(pub, 9), { verified: true, title: "Match found #03", details: ["A Real Article"], link: { href: "https://journals.example.org/a/3", text: "journals.example.org/a/3" }, year: 2021 });
  assert.deepEqual(printSourceIdentity({ ...pub, link: null }, 9).link, { href: "https://doi.org/10.5555/x", text: "doi:10.5555/x" });
  assert.equal(printSourceIdentity({ ...pub, label: "Publication" }, 9).verified, false, "a title that is only the generic badge is not an identity");
});

test("SOURCES: page 3 rows give rank, identity, passages, matched words and share in aligned columns, from the saved entries", () => {
  const report = reportWithSources({ text: prose(4200), sourceCount: 24, sameSpanAs: { 9: 1 } });
  const ranked = rankPrintSources(buildReportV2ViewModel(report));
  const page = pagesOf(render(report))[2].html;
  assert.match(page, /<div class="spr-source-cols" aria-hidden="true"><span><\/span><span>Source<\/span><span>Passages<\/span><span>Matched words<\/span><span>Share of document<\/span><\/div>/);
  const rows = [...page.matchAll(/<span class="spr-rank"[^>]*>(\d+)<\/span>[\s\S]*?<span class="spr-source-title" dir="auto">([^<]*)<\/span><span class="spr-source-meta" dir="auto">([\s\S]*?)<\/span><\/span><span class="spr-source-num">([\d,]+)<\/span><span class="spr-source-num">([\d,]+)<\/span><span class="spr-source-share"><b>([^<]*)<\/b>/g)];
  assert.equal(rows.length, SOURCES_PAGE_CAPACITY);
  rows.forEach((m, i) => {
    const s = ranked[i];
    assert.deepEqual([Number(m[1]), decode(m[2]), Number(m[4]), Number(m[5]), decode(m[6])],
      [s.rank, `Match found #${String(s.rank).padStart(2, "0")}`, s.passageRefs.length, s.matchedWords, formatSimilarityPercent(s.contributionPercent, s.matchedWords)], `row ${i + 1}`);
    assert.ok(decode(m[3]).startsWith(`${s.label} · `), "the verified title leads the details line");
    assert.match(m[3], new RegExp(`<a class="spr-source-link" href="https://journals\\.example\\.org/a/\\d+">journals\\.example\\.org/a/\\d+</a>`), "verified link");
  });
  const row10 = rows.find((m) => Number(m[1]) === 10);
  assert.match(decode(row10[3].replace(/<[^>]+>/g, "")), /Passages marked #02 in the manuscript/, "its only passage is marked with the better-ranked #02");
  assert.doesNotMatch(decode(rows[0][3].replace(/<[^>]+>/g, "")), /Passages marked/);
});

test("REPORT: the manuscript prints the full text unaltered, with exactly the highlight spans of findHighlightRanges, numbered like page 3", () => {
  const report = reportWithSources({ text: prose(4200), sourceCount: 24 });
  const html = render(report);
  assert.equal(printedManuscript(html), report.text, "every character, in order");
  const expected = findHighlightRanges(report, { includeWikipedia: false }).map((r) => `${r.start}-${r.end}`);
  const printed = [...new Set([...html.matchAll(/data-span="(\d+-\d+)"/g)].map((m) => m[1]))];
  assert.deepEqual(printed, expected, "same spans, same order");
  const vm = buildReportV2ViewModel(report);
  const rankById = new Map(rankPrintSources(vm).map((s) => [s.id, s.rank]));
  for (const m of html.matchAll(/data-span="(\d+)-(\d+)">[\s\S]*?<sup class="spr-mark-n">(\d+)<\/sup>/g)) {
    assert.equal(Number(m[3]), rankForCharRange(Number(m[1]), Number(m[2]), vm.passages, rankById));
  }
});

test("REPORT: no matches — still three introductory pages, an honest empty state, and the unhighlighted manuscript", () => {
  const base = reportWithSources({ text: prose(900), sourceCount: 0 });
  const html = render(base, null);
  const pages = pagesOf(html);
  assert.equal(pages[0].cls.split(" ")[0], "spr-cover");
  assert.equal(pages[3].cls.split(" ")[0], "spr-manuscript");
  assert.match(pages[2].html, /No matching sources/);
  assert.match(pages[3].html, /No passages matched/);
  assert.equal(printedManuscript(html), base.text);
  assert.doesNotMatch(pages[0].html, /Submitted by/, "no name when none is known");
});

test("REPORT: the account email never appears anywhere in the printed report", () => {
  const report = reportWithSources({ text: prose(1500), sourceCount: 5 });
  assert.doesNotMatch(render(report), /owner@example\.test/);
});

// ── one numbering on every surface ───────────────────────────────────────
test("CONSISTENCY: 10+ sources — the interactive report and the PDF give every source the same number (src-2 is 2, src-10 is 10), in the same order", () => {
  const report = reportWithSources({ text: prose(4200), sourceCount: 24 });
  const vm = buildReportV2ViewModel(report);
  const ids = vm.sources.map((s) => s.id);
  assert.ok(ids.indexOf("src-2") < ids.indexOf("src-10"), "numeric, not string, id order");
  assert.deepEqual(ids, rankPrintSources(vm).map((s) => s.id), "the view model is already in the PDF's order");
  const workspace = renderToStaticMarkup(React.createElement(ReportV2Workspace, { report }));
  const screenRows = [...workspace.matchAll(/<span class="rv2ws-source-number"[^>]*>(\d+)<\/span><span class="rv2ws-source-body"><span class="rv2ws-source-title">([^<]*)<\/span>/g)]
    .map((m) => [Number(m[1]), decode(m[2])]);
  // page 3 titles are "Match found #NN"; a verified source's own title leads its details line
  const pdfRows = [...pagesOf(render(report))[2].html.matchAll(/<span class="spr-rank"[^>]*>(\d+)<\/span>[\s\S]*?<span class="spr-source-title" dir="auto">Match found #(\d+)<\/span><span class="spr-source-meta" dir="auto">([^<]*?) · /g)]
    .map((m) => { assert.equal(Number(m[2]), Number(m[1]), "the title number is the rank"); return [Number(m[1]), decode(m[3])]; });
  assert.equal(screenRows.length, vm.sources.length);
  assert.deepEqual(pdfRows, screenRows.slice(0, pdfRows.length), "page 3 = the top of the interactive list, number for number");
  const label = (id) => vm.sources.find((s) => s.id === id).label;
  for (const id of ["src-2", "src-10"]) {
    const n = Number(id.slice(4));
    assert.deepEqual(screenRows.find(([, t]) => t === label(id)), [n, label(id)], `${id} is number ${n} on screen`);
    assert.deepEqual(pdfRows.find(([, t]) => t === label(id)), [n, label(id)], `${id} is number ${n} in the PDF`);
  }
});

test("CONSISTENCY: every highlight carries the same source number on screen and in the PDF — including a passage shared by src-2 and src-10", () => {
  const report = reportWithSources({ text: uniqueProse(4200), sourceCount: 24, sameSpanAs: { 9: 1 } });
  const vm = buildReportV2ViewModel(report);
  const shared = vm.passages.find((p) => p.sourceIds.includes("src-2") && p.sourceIds.includes("src-10"));
  assert.ok(shared, "fixture has one passage matched by both src-2 and src-10");
  assert.equal(shared.sourceIds[0], "src-2", "its best-numbered source comes first");
  const workspace = renderToStaticMarkup(React.createElement(ReportV2Workspace, { report }));
  const screen = new Map([...workspace.matchAll(/id="rv2ws-mark-(\d+)"[^>]*>[^<]*<sup class="rv2ws-mark-number"[^>]*>(\d+)<\/sup>/g)]
    .map((m) => [vm.passages.find((p) => p.id === Number(m[1])).charStart, Number(m[2])]));
  const pdf = new Map([...render(report).matchAll(/data-span="(\d+)-\d+">[^<]*<sup class="spr-mark-n">(\d+)<\/sup>/g)].map((m) => [Number(m[1]), Number(m[2])]));
  assert.ok(screen.size >= 20 && pdf.size >= 20);
  let compared = 0;
  for (const [start, n] of screen) {
    if (!pdf.has(start)) continue;
    assert.equal(pdf.get(start), n, `highlight at ${start}`);
    compared += 1;
  }
  assert.ok(compared >= 20, `compared ${compared} highlights`);
  assert.equal(screen.get(shared.charStart), 2);
  assert.equal(pdf.get(shared.charStart), 2);
});

// ── palette ──────────────────────────────────────────────────────────────
test("PALETTE: only blue, green and red plus white, dark text and light greys — green for low/completed, red for high/attention", async () => {
  assert.equal(printBandColor("low"), PRINT_PALETTE.green);
  assert.equal(printBandColor("review"), PRINT_PALETTE.blue);
  assert.equal(printBandColor("high"), PRINT_PALETTE.red);
  const allowed = new Set(Object.values(PRINT_PALETTE).map((c) => c.toLowerCase()));
  const css = (await readFile(new URL("../app/globals.css", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const block = css.slice(css.indexOf("SIMILARITY PRINT REPORT (2026-10-21)"));
  const component = await readFile(new URL("../components/report/report-v2/similarity-print-report.tsx", import.meta.url), "utf8");
  for (const [name, src] of [["print CSS", block], ["print component", component]]) {
    const stray = (src.match(/#[0-9a-fA-F]{6}\b/g) ?? []).filter((h) => !allowed.has(h.toLowerCase()));
    assert.deepEqual(stray, [], `${name} uses only palette colours`);
  }
  const lowReport = reportWithSources({ text: prose(4200), sourceCount: 3 });
  const overview = pagesOf(render(lowReport))[1].html;
  assert.match(overview, /class="spr-pill spr-pill-low">Low similarity</, "a low score shows a green state pill");
  assert.match(overview, /class="spr-pill spr-pill-ok">Search completed</, "a completed search shows a green state pill");
});

test("SCALE: proportional bands on a 0–100 axis, the marker at the score itself, the score's own band active", () => {
  for (const [score, key, align] of [[0, "low", "start"], [15, "low", "center"], [19, "low", "center"], [19.6, "low", "center"], [20, "review", "center"], [40, "review", "center"], [40.4, "high", "center"], [41, "high", "center"], [100, "high", "end"]]) {
    const scale = printSimilarityScale(score);
    assert.equal(scale.markerPercent, score, `marker at ${score}`);
    assert.equal(scale.activeKey, key, `band at ${score}`);
    assert.equal(scale.markerAlign, align, `label anchoring at ${score}`);
    assert.deepEqual(scale.segments.filter((s) => s.active).map((s) => s.key), [key]);
  }
  assert.deepEqual(printSimilarityScale(15).segments.map((s) => [s.label, s.range, s.startPercent, s.widthPercent]), [["Low", "0–19%", 0, 20], ["Moderate", "20–40%", 20, 20], ["High", "41–100%", 40, 60]]);
  assert.equal(printSimilarityScale(-3).markerPercent, 0);
  assert.equal(printSimilarityScale(130).markerPercent, 100);
});

test("SCALE: page 2 draws the full-width scale between the score and the figures, replacing the small scale", () => {
  const overview = pagesOf(render(reportWithSources({ text: prose(4200), sourceCount: 3 })))[1].html;
  assert.match(overview, /<\/section><section class="spr-scale"[^>]*aria-label="Similarity [^"]+"><div class="spr-scale-bar">/, "right after the score block");
  assert.ok(overview.indexOf('class="spr-scale"') < overview.indexOf('class="spr-figures"'), "above the statistics row");
  assert.equal((overview.match(/class="spr-scale-seg/g) ?? []).length, 3);
  assert.equal((overview.match(/class="spr-scale-pin"/g) ?? []).length, 1);
  assert.doesNotMatch(overview, /spr-band-scale/);
});

// ── wiring and print CSS ─────────────────────────────────────────────────
test("WIRING: the report page prints SimilarityPrintReport for a V2 report; AI and legacy print paths are unchanged; the owner's name comes from a SELECT-only read", async () => {
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /<AiReport report=\{report\} signal=\{aiSignal\} printMode \/> : hasV2 \? \(/);
  assert.match(shell, /<SimilarityPrintReport report=\{report\} submitter=\{submitter\} formatted=\{formattedSource\} onFormattedReady=\{handleFormattedReady\} \/>/);
  assert.match(shell, /<OverviewReport report=\{report\} similarityStatus=\{effectiveSimilarityStatus\} \/>\s*<SubmissionReport report=\{report\} \/>\s*<SourcesReport report=\{report\} \/>/);
  const page = await readFile(new URL("../app/reports/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /readAccountIdentityProfile\(client, sessionUser\.id\)/);
  assert.doesNotMatch(page.slice(page.indexOf("async function readReportSubmitter")), /sessionUser\.email[\s\S]*?displayName/);
});

test("PRINT CSS: the three introductory pages are exactly one sheet each; the wrapper adds no box; the font warm-up never prints", async () => {
  const css = (await readFile(new URL("../app/globals.css", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const block = css.slice(css.indexOf("SIMILARITY PRINT REPORT (2026-10-21)"));
  const print = block.slice(block.indexOf("@media print {"));
  assert.match(print, /\.spr-report \{\n\s*display: contents;/);
  assert.match(print, /\.spr-font-warmup,\n\s*\.fm-measure \{\n\s*display: none !important;/, "neither the font warm-up nor the formatted manuscript's measuring layer ever prints");
  assert.match(print, /\.spr-page\.spr-cover,\n\s*\.print-report-bundle \.report-paper\.spr-page\.spr-overview,\n\s*\.print-report-bundle \.report-paper\.spr-page\.spr-sources \{\n\s*height: 11in;\n\s*overflow: hidden;/);
  assert.match(block, /\.spr-mark \{[\s\S]*?print-color-adjust: exact;/, "highlight fill prints with Background graphics off");
  assert.match(block, /--spr-match: #b42318;\n\s*--spr-match-fill: #fde8e8;/);
  // cover rhythm: a moderate gap under the graphic, and the contents follow the details (not pinned to the footer)
  assert.match(block, /\.spr-cover-title-block \{\n\s*margin-top: 42px;/);
  assert.match(block, /\.spr-cover-dense \.spr-cover-title-block \{\n\s*margin-top: 20px;/);
  assert.match(block, /\.spr-cover-contents \{\n\s*margin-top: 0;\n\s*padding-top: 22px;/);
  assert.match(block, /\.spr-mark \{[^}]*border-bottom: 1\.6px solid var\(--spr-c\);[^}]*background: var\(--spr-match-fill\);/, "every matched passage sits on the soft red fill, underlined in its source colour");
  assert.match(block, /unicode-bidi: plaintext;/, "each manuscript paragraph takes its own direction (Arabic RTL)");
});
