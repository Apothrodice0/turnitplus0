import assert from "node:assert/strict";
import test from "node:test";
import { extractCandidatePhrases, DEFAULT_PHRASE_EXTRACTION_CONFIG } from "../lib/academic-search/phrase-extractor.ts";
import { DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, runAcademicSearch } from "../lib/academic-search/orchestrator.ts";
import { createHttpContentRetriever } from "../lib/http-content-retriever.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { tokens } from "../lib/similarity-core.ts";

/**
 * "Investigate two production issues" ISSUE 1 — end-to-end regression
 * coverage for the real OpenAIRE false-negative reproduced live during this
 * investigation against a genuine OpenAIRE-indexed paper
 * (jodakiss:15337, DOI 10.46298/jodakiss.15337, downloaded directly from
 * https://jodakiss.episciences.org/15337/pdf). Real, measured numbers from
 * that live run (not reproduced here — no test in this suite ever makes a
 * real network call):
 *
 *  - BEFORE the fix: 23 queries generated, 46 real (query, provider)
 *    attempts against the real OpenAIRE Graph API v3, 0 provider errors,
 *    0 evidence — status COMPLETE_NO_MATCHES, unifiedScore 0. Root cause:
 *    OpenAIRE's own `search` parameter is conjunctive (effectively AND)
 *    over METADATA ONLY (title/abstract/authors — confirmed live, e.g.
 *    "bayesvalidrox surrogate model documentation repository stuttgart"
 *    -> numFound 0, but "bayesvalidrox surrogate model" alone -> numFound
 *    3, the real record among them), so every existing sentence- and
 *    per-sentence-keyword-derived query (built from the submission's BODY
 *    text) included at least one word absent from the paper's own
 *    title/abstract and silently returned zero results. Even when
 *    discovered, the candidate's own resultUrl() pointed at a bare DOI
 *    resolver, which redirects to an HTML landing page containing only an
 *    abstract (~289 words, confirmed live) — nowhere near the real
 *    article. And even with real text retrieved, the candidate ranked 45th
 *    (score 7: hasDoi + hasUrl + foundByKeywordQuery) behind 42 entirely
 *    unrelated Europe PMC records (score 8: hasDoi + hasUrl +
 *    textAvailable — OpenAIRE never reports textAvailable at all), so it
 *    never reached maxCandidatesToRetrieve (5) to be retrieved in the
 *    first place.
 *  - AFTER the three fixes below: 24 queries, 48 attempts, 0 provider
 *    errors, status COMPLETE_WITH_MATCHES, similarity 100 (the retrieved
 *    text is, byte-for-byte after normalization, the genuine article),
 *    unifiedScore 100.
 *
 * This test reproduces the SAME mechanism with a synthetic (not
 * copyrighted, not the real paper's) submission and a mock provider that
 * faithfully models OpenAIRE's own confirmed-live conjunctive-metadata
 * search behavior — never the real network — so it is fast, deterministic,
 * and fails loudly if any of the three fixes below regresses:
 *
 *  1. phrase-extractor.ts's topicOnlyQueryCount: a query built from ONLY
 *     the document's own recurring topic terms, no per-sentence noise
 *     words mixed in.
 *  2. http-content-retriever.ts's citation_pdf_url following: an HTML
 *     landing page's own citation_pdf_url meta tag is followed once to
 *     reach the real article instead of stopping at an abstract.
 *  3. candidate-ranker.ts's foundByKeywordQuery weight (3 -> 5): without
 *     this raise, the real candidate (score 7) still loses to unrelated
 *     noise (score 8, from hasDoi+hasUrl+textAvailable alone) and never
 *     reaches text retrieval — see this test's own NOISE_CANDIDATE_COUNT
 *     comment for the exact arithmetic this fixture is built to prove.
 *
 * Every assertion below reads a value the real matching algorithm actually
 * computed (extractCandidatePhrases, runAcademicSearch's real dedup/
 * ranking/comparator, computeUnifiedSimilarity) — nothing is hardcoded to
 * a specific similarity number.
 */

const TARGET_DOI = "10.9999/zynthorak-framework";
const TARGET_LANDING_URL = "https://public.example.org/zynthorak-framework";
const TARGET_PDF_URL = "https://public.example.org/zynthorak-framework/pdf";

// A synthetic, self-authored "paper" — not the real jodakiss article, not
// copyrighted third-party content. "zynthorak" is an invented term chosen
// specifically so it (and only it, plus two ordinary words that also
// happen to repeat) recurs often enough to become a real
// extractTopicTerms() output, exactly mirroring "bayesvalidrox" in the
// real reproduction.
const SUBMISSION_TEXT = `
Zynthorak provides an automated workflow for adaptive calibration and validation of computational models using a modular framework.
The zynthorak framework enables researchers to combine surrogate modeling techniques with Bayesian inference procedures across a wide range of engineering disciplines.
Extensive benchmarking on established test problems demonstrates that zynthorak consistently reduces computational cost while preserving predictive accuracy.
Documentation, source code, and worked examples for zynthorak are maintained in a public software repository hosted by the development team.
Future releases of zynthorak will extend support to additional surrogate model architectures and distributed computing environments.
`;

// Mirrors what a real conjunctive-metadata search engine "knows" about the
// paper: only its title/abstract vocabulary, never its full body text.
// Matches extractTopicTerms(SUBMISSION_TEXT)'s own real output exactly —
// see the first test below, which proves that alignment rather than
// assuming it. ("computational" — not "surrogate" — is the real 3rd topic
// term: "computational" and "framework"/"surrogate" all recur exactly
// twice, and extractTopicTerms breaks that tie by length then alphabetically,
// which "computational" (13 letters) wins outright.)
const TITLE_ABSTRACT_VOCABULARY = new Set(["zynthorak", "computational", "framework"]);

function queryWords(queryText) {
  return queryText.toLowerCase().match(/[a-z]+/g) ?? [];
}

/**
 * A faithful stand-in for OpenAIRE's real, confirmed-live Graph API v3
 * `search` behavior: returns the real record ONLY when every word in the
 * query is drawn from the paper's own title/abstract vocabulary (the
 * conjunctive-AND-over-metadata mechanism this investigation confirmed
 * live) — exercised for real by whatever extractCandidatePhrases actually
 * produces below, not a canned query list.
 *
 * NOISE_CANDIDATE_COUNT: also returns 8 entirely unrelated candidates —
 * emitted exactly once (on the provider's first call, using its own fixed
 * DOIs — not once per query call, which would either explode the noise
 * count or, if repeated identically every call, inflate their own score
 * via additionalContributor) — each with hasDoi + hasUrl +
 * textAvailable=true and exactly one contributor, precisely matching the
 * real live pattern (score 8, one contributor). At the OLD
 * foundByKeywordQuery weight of 3, all 8 would outrank the real candidate
 * (score 8 vs 7) and push it outside maxCandidatesToRetrieve (5); at the
 * fixed weight of 5, the real candidate (score 9) outranks all 8. This is
 * what makes the final COMPLETE_WITH_MATCHES assertion below a genuine
 * regression guard for the ranking fix, not just a happy-path check.
 */
const NOISE_CANDIDATE_COUNT = 8;

function mockOpenAireProvider() {
  let noiseEmitted = false;
  return {
    id: "openaire",
    async search(query) {
      const words = queryWords(query.queryText);
      const results = [];
      if (words.length > 0 && words.every((word) => TITLE_ABSTRACT_VOCABULARY.has(word))) {
        results.push({
          providerId: "openaire",
          externalId: "openaire-zynthorak",
          title: "Zynthorak: A Modular Framework for Adaptive Calibration",
          authors: ["A. Researcher"],
          publication: "Journal of Computational Frameworks",
          year: 2025,
          doi: TARGET_DOI,
          url: TARGET_LANDING_URL,
          textAvailable: false, // OpenAIRE's real Graph API never reports this true — see providers/openaire.ts.
          querySignalUsed: query.queryText,
          providerRelevance: null,
        });
      }
      if (!noiseEmitted) {
        noiseEmitted = true;
        for (let i = 1; i <= NOISE_CANDIDATE_COUNT; i += 1) {
          results.push({
            providerId: "openaire",
            externalId: `noise-${i}`,
            title: `Unrelated Work ${i}`,
            authors: null,
            publication: null,
            year: 2024,
            doi: `10.1/noise-${i}`,
            url: `https://example.test/noise-${i}`,
            textAvailable: true,
            querySignalUsed: query.queryText,
            providerRelevance: null,
          });
        }
      }
      return results;
    },
  };
}

function mockEuropePmcProvider() {
  // The real submission (a computational-engineering paper) is correctly
  // out of Europe PMC's biomedical-only scope — confirmed live (hitCount 0
  // for "bayesvalidrox" against the real Europe PMC REST API). Modeled
  // here as a provider that always finds nothing, never as an error.
  return { id: "europe-pmc", async search() { return []; } };
}

// The retriever's own real network layer, mocked by URL rather than by
// call order (retrieval order depends on final ranking, which this test
// deliberately does not hardcode).
function mockFetcher(responsesByUrl) {
  return async (url) => {
    const response = responsesByUrl[String(url)];
    if (response) return response;
    return new Response("Not Found", { status: 404, headers: { "content-type": "text/html" } });
  };
}

function htmlResponse(body) {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

async function publicLookup() {
  return [{ address: "93.184.216.34", family: 4 }];
}

test("SANITY: extractTopicTerms (via extractCandidatePhrases) on the synthetic submission produces exactly the assumed title/abstract vocabulary as a topic-only query", () => {
  const queries = extractCandidatePhrases(SUBMISSION_TEXT, DEFAULT_PHRASE_EXTRACTION_CONFIG);
  const topicOnlyMatch = queries.find((q) => {
    const words = queryWords(q.queryText);
    return words.length > 0 && words.every((w) => TITLE_ABSTRACT_VOCABULARY.has(w)) && words.length === TITLE_ABSTRACT_VOCABULARY.size;
  });
  assert.ok(topicOnlyMatch, "extractCandidatePhrases must produce a query built from exactly the whole-document topic terms, matching this fixture's own assumed vocabulary");
  assert.equal(topicOnlyMatch.queryType, "keyword");
});

test("SANITY: at least one full-sentence query includes a word OUTSIDE the title/abstract vocabulary — proving the OLD failure mode is real for this fixture, not assumed away", () => {
  const queries = extractCandidatePhrases(SUBMISSION_TEXT, DEFAULT_PHRASE_EXTRACTION_CONFIG);
  const sentenceQueries = queries.filter((q) => q.queryType === "sentence");
  assert.ok(sentenceQueries.length > 0);
  assert.ok(
    sentenceQueries.every((q) => queryWords(q.queryText).some((w) => !TITLE_ABSTRACT_VOCABULARY.has(w))),
    "every sentence-window query must contain at least one out-of-vocabulary word, exactly like the real conjunctive-search failure this investigation found",
  );
});

test("END TO END: the real, genuinely-indexed source is discovered, retrieved via its own citation_pdf_url, matched, and reported COMPLETE_WITH_MATCHES", async () => {
  const openAire = mockOpenAireProvider();
  const europePmc = mockEuropePmcProvider();

  const landingPageHtml = `<html><head><meta name="citation_pdf_url" content="${TARGET_PDF_URL}"></head><body><p>Abstract only, not the real article.</p></body></html>`;
  // The real full text — what a "citation_pdf_url" hop actually reaches,
  // deliberately near-identical to SUBMISSION_TEXT (this is what "the
  // article IS the actual source document" means for this fixture, exactly
  // as it was for the real jodakiss reproduction).
  const fullArticleHtml = `<html><body><p>${SUBMISSION_TEXT.trim()}</p></body></html>`;

  const fetcher = mockFetcher({
    [TARGET_LANDING_URL]: htmlResponse(landingPageHtml),
    [TARGET_PDF_URL]: htmlResponse(fullArticleHtml),
  });
  const contentRetriever = createHttpContentRetriever({
    fetcher,
    lookup: publicLookup,
    allowedContentTypes: ["text/html", "application/pdf"],
    timeoutMs: 2_000,
  });

  const result = await runAcademicSearch(SUBMISSION_TEXT, [openAire, europePmc], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, contentRetriever);

  assert.equal(result.stats.providerErrors.length, 0, "no provider errors — a clean, complete search");

  // 1. the correct external academic source is discovered
  const targetCandidate = result.candidates.find((c) => c.doi === TARGET_DOI);
  assert.ok(targetCandidate, "the real candidate must be discovered among result.candidates");
  assert.ok(targetCandidate.rank < DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.maxCandidatesToRetrieve, "the real candidate must rank inside the retrieval window, not be pushed out by noise");

  // 2 & 3. the source is retrieved and matching passages are produced
  const evidence = result.evidence.find((e) => e.doi === TARGET_DOI);
  assert.ok(evidence, "the real candidate must produce a reported evidence entry");
  assert.ok(evidence.matchedPassages.length > 0, "real matched passages, computed by the actual comparator");
  const totalMatchedWords = evidence.matchedPassages.reduce((sum, p) => sum + p.matchedWordCount, 0);
  assert.ok(totalMatchedWords > 20, "a real, substantial word-level match — not a trivial coincidental overlap");
  assert.ok(evidence.similarity > 50, "a strong match, computed by the real comparator against the real retrieved text — never hardcoded");

  // 4. status becomes COMPLETE_WITH_MATCHES
  assert.equal(result.status, "COMPLETE_WITH_MATCHES");

  // 5. the external evidence contributes to the final similarity result
  const wordCount = tokens(SUBMISSION_TEXT).length;
  const unified = computeUnifiedSimilarity({ wordCount, archiveMatchedPositions: [], externalAcademicEvidence: result.evidence });
  assert.ok(unified.liveAcademicOnlyWords > 0, "the live academic evidence must contribute real matched words to the unified result");
  assert.ok(unified.unifiedScore > 0, "the unified score must be computed from the real contribution, not left at zero");
});

test("REGRESSION: without a citation_pdf_url to follow, the same candidate still gets discovered and ranked, but only produces evidence if the landing page's own text is enough to clear the similarity floor", async () => {
  // Isolates fix #2 from #1 and #3: same discovery/ranking mechanics, but
  // the landing page has no citation_pdf_url at all, so retrieval never
  // reaches more than the landing page's own thin body text.
  const openAire = mockOpenAireProvider();
  const europePmc = mockEuropePmcProvider();
  const abstractOnlyHtml = "<html><body><p>Just a short landing page abstract, nowhere near the full article length.</p></body></html>";

  const fetcher = mockFetcher({ [TARGET_LANDING_URL]: htmlResponse(abstractOnlyHtml) });
  const contentRetriever = createHttpContentRetriever({
    fetcher,
    lookup: publicLookup,
    allowedContentTypes: ["text/html", "application/pdf"],
    timeoutMs: 2_000,
  });

  const result = await runAcademicSearch(SUBMISSION_TEXT, [openAire, europePmc], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, contentRetriever);
  const targetCandidate = result.candidates.find((c) => c.doi === TARGET_DOI);
  assert.ok(targetCandidate, "discovery and ranking are unaffected by the absence of a citation_pdf_url");
  assert.ok(targetCandidate.rank < DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.maxCandidatesToRetrieve);
  assert.equal(result.evidence.find((e) => e.doi === TARGET_DOI), undefined, "a thin, unrelated abstract must not itself clear minEvidenceSimilarity — this isolates the citation_pdf_url fix's own real contribution");
});
