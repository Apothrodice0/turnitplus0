import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  extractCsrfToken,
  buildAdvancedSearchRequestBody,
  parseSearchResultCandidates,
  deduplicateCandidatesByArticleId,
  parseAsjpArticleMetadata,
  issnMatchesExpected,
  selectIssnClusterSample,
  ASJP_ADVANCED_SEARCH_ACTION_URL,
} from "../lib/e7-asjp-interface.ts";

const repoRoot = path.resolve(".");

test("lib/e7-asjp-interface.ts performs no I/O — pure parsing/logic only", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/e7-asjp-interface.ts"), "utf8");
  const imports = source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  assert.doesNotMatch(imports, /node:fs|node:http|@libsql\/client/, "the interface layer must stay pure — no fetch, no fs, no database");
});

// --- A: CSRF TOKEN EXTRACTION -------------------------------------------------

const SEARCH_FORM_FIXTURE = `<!DOCTYPE html><html><body>
<form method="post" role="form" action="https://asjp.cerist.dz/en/rechercheGeneral" onsubmit="return RechercheEmpty(this.recherche);">
<input type="hidden" name="_token" value="fixture-csrf-token-abc123">
<input type="text" name="rechercheG">
</form>
<form role="form" id="formAdvRecherche" method="POST" action="https://asjp.cerist.dz/en/articleAdvancedResearch">
<input type="hidden" name="_token" value="fixture-csrf-token-abc123">
<input type="text" name="titreArticle">
<select name="listeRevue[]"></select>
</form>
</body></html>`;

test("A: extractCsrfToken finds the real _token hidden-input value", () => {
  assert.equal(extractCsrfToken(SEARCH_FORM_FIXTURE), "fixture-csrf-token-abc123");
});

test("A: extractCsrfToken returns null when no _token field is present", () => {
  assert.equal(extractCsrfToken("<html><body>no form here</body></html>"), null);
});

// --- B: POST SEARCH REQUEST CONSTRUCTION --------------------------------------

test("B: buildAdvancedSearchRequestBody includes the token and title, and only bounded fields", () => {
  const body = buildAdvancedSearchRequestBody("tok-1", { title: "A Distinctive Title" });
  assert.equal(body.get("_token"), "tok-1");
  assert.equal(body.get("titreArticle"), "A Distinctive Title");
  assert.equal(body.get("listeRevue[]"), null, "journal field must be absent unless explicitly supplied");
  assert.equal(ASJP_ADVANCED_SEARCH_ACTION_URL, "https://www.asjp.cerist.dz/en/articleAdvancedResearch");
});

test("B: buildAdvancedSearchRequestBody includes journalNameHint only when supplied", () => {
  const body = buildAdvancedSearchRequestBody("tok-1", { title: "T", journalNameHint: "Revue des Sciences Humaines" });
  assert.equal(body.get("listeRevue[]"), "Revue des Sciences Humaines");
});

// --- J: CANDIDATE DEDUPLICATION + result-list parsing -------------------------

const RESULT_LIST_FIXTURE = `<!DOCTYPE html><html><body>
<div class="card"><a href="https://www.asjp.cerist.dz/en/article/194315">Some Article Title One</a></div>
<div class="card"><a href="https://www.asjp.cerist.dz/en/article/194316">Some Article Title Two</a></div>
<div class="thumb"><a href="https://www.asjp.cerist.dz/en/article/194315"><img src="x.png"></a></div>
</body></html>`;

test("parseSearchResultCandidates extracts article id/url/title from real-shaped result markup", () => {
  const candidates = parseSearchResultCandidates(RESULT_LIST_FIXTURE);
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].articleId, "194315");
  assert.equal(candidates[0].titleSnippet, "Some Article Title One");
});

test("J: deduplicateCandidatesByArticleId collapses repeated links to the same article", () => {
  const candidates = parseSearchResultCandidates(RESULT_LIST_FIXTURE);
  const deduped = deduplicateCandidatesByArticleId(candidates);
  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped.map((c) => c.articleId), ["194315", "194316"]);
});

// --- D/E/F/G: ARTICLE METADATA PARSING ----------------------------------------

function articlePageFixture({ withDoi = false } = {}) {
  return `<!DOCTYPE html><html><head>
<title>Fixture Article | ASJP</title>
<meta name="citation_title" content="A Fixture Study of Something Specific">
<meta name="citation_author" content="Doe, Jane">
<meta name="citation_author" content="Smith, John">
<meta name="citation_journal_title" content="Revue des Sciences Humaines">
<meta name="citation_issn" content="2588-2007">
<meta name="citation_doi" content="${withDoi ? "10.1234/fixture.2024.001" : ""}">
<meta name="citation_volume" content="20">
<meta name="citation_issue" content="2">
<meta name="citation_firstpage" content="10">
<meta name="citation_lastpage" content="25">
<meta name="citation_publication_date" content="2024/12/31">
<meta name="citation_pdf_url" content="https://asjp.cerist.dz/en/downArticle/483/20/2/285260">
<meta name="citation_abstract_html_url" content="https://asjp.cerist.dz/en/article/285260">
</head><body>/en/article/285260 abstract text here</body></html>`;
}

test("D: parseAsjpArticleMetadata extracts the full citation_* metadata set", () => {
  const meta = parseAsjpArticleMetadata(articlePageFixture());
  assert.equal(meta.title, "A Fixture Study of Something Specific");
  assert.deepEqual(meta.authors, ["Doe, Jane", "Smith, John"]);
  assert.equal(meta.journalTitle, "Revue des Sciences Humaines");
  assert.equal(meta.volume, "20");
  assert.equal(meta.issue, "2");
  assert.equal(meta.firstPage, "10");
  assert.equal(meta.lastPage, "25");
  assert.equal(meta.publicationDate, "2024/12/31");
  assert.equal(meta.articleId, "285260");
});

test("D: parseAsjpArticleMetadata returns null for a page with no citation_title (not a real article page)", () => {
  assert.equal(parseAsjpArticleMetadata("<html><body>not an article page</body></html>"), null);
});

test("E: citation_issn is extracted correctly", () => {
  const meta = parseAsjpArticleMetadata(articlePageFixture());
  assert.equal(meta.issn, "2588-2007");
});

test("F: DOI is optional — present when populated, null when the tag is empty (matches the real fixture article's empty citation_doi)", () => {
  const withDoi = parseAsjpArticleMetadata(articlePageFixture({ withDoi: true }));
  assert.equal(withDoi.doi, "10.1234/fixture.2024.001");
  const withoutDoi = parseAsjpArticleMetadata(articlePageFixture({ withDoi: false }));
  assert.equal(withoutDoi.doi, null, "an empty citation_doi content attribute must parse to null, not an empty string");
});

test("G: citation_pdf_url is extracted as the PDF URL", () => {
  const meta = parseAsjpArticleMetadata(articlePageFixture());
  assert.equal(meta.pdfUrl, "https://asjp.cerist.dz/en/downArticle/483/20/2/285260");
});

// --- H/I: ISSN MATCH / MISMATCH ------------------------------------------------

test("H: issnMatchesExpected is true when the candidate's ISSN is in the expected set", () => {
  const meta = parseAsjpArticleMetadata(articlePageFixture());
  assert.equal(issnMatchesExpected(meta, ["2588-2007"]), true);
  assert.equal(issnMatchesExpected(meta, ["1112-4377", "2588-2007"]), true, "any one of several known journal ISSNs should count as a match");
});

test("I: issnMatchesExpected is false when the ISSN does not match — title similarity alone is never sufficient", () => {
  const meta = parseAsjpArticleMetadata(articlePageFixture());
  assert.equal(issnMatchesExpected(meta, ["9999-9999"]), false);
});

test("I: issnMatchesExpected is false when the candidate has no ISSN at all", () => {
  const noIssnMeta = { ...parseAsjpArticleMetadata(articlePageFixture()), issn: null };
  assert.equal(issnMatchesExpected(noIssnMeta, ["2588-2007"]), false);
});

// --- DETERMINISTIC SAMPLE SELECTION -------------------------------------------

test("selectIssnClusterSample is deterministic and reproduces the real 5-document E7D pilot sample", () => {
  const analysis = JSON.parse(fs.readFileSync(path.join(repoRoot, "corpus/e7/publication-signal-analysis.json"), "utf8"));
  const sample = selectIssnClusterSample(analysis.documents, "2588-2007", 5);
  assert.equal(sample.length, 5);
  const sampleAgain = selectIssnClusterSample(analysis.documents, "2588-2007", 5);
  assert.deepEqual(sample, sampleAgain);
  for (let i = 1; i < sample.length; i++) assert.ok(sample[i - 1] < sample[i], "sample must be sorted ascending");
});

test("selectIssnClusterSample never invents a document id not present in the input", () => {
  const documents = [
    { id: "b-doc", issns: ["2588-2007"] },
    { id: "a-doc", issns: ["2588-2007"] },
    { id: "c-doc", issns: ["9999-0000"] },
  ];
  const sample = selectIssnClusterSample(documents, "2588-2007", 5);
  assert.deepEqual(sample, ["a-doc", "b-doc"]);
});
