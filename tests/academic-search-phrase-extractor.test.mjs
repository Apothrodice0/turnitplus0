import assert from "node:assert/strict";
import test from "node:test";
import { extractCandidatePhrases, sanitizeExtractionArtifacts, DEFAULT_PHRASE_EXTRACTION_CONFIG } from "../lib/academic-search/phrase-extractor.ts";

const DISTINCTIVE_SENTENCE =
  "Photosynthetic efficiency in high-altitude alpine flora demonstrates unexpected resilience under prolonged ultraviolet radiation exposure.";
const GENERIC_SHORT_SENTENCE = "This is nice.";
const SHORT_BUT_DISTINCTIVE = "Mitochondrial biogenesis diverges.";

test("returns [] for empty input", () => {
  assert.deepEqual(extractCandidatePhrases(""), []);
  assert.deepEqual(extractCandidatePhrases("   \n\n  "), []);
});

test("rejects a generic short sentence with fewer than minInformativeWords informative words", () => {
  const queries = extractCandidatePhrases(`${GENERIC_SHORT_SENTENCE} ${DISTINCTIVE_SENTENCE}`);
  assert.ok(!queries.some((q) => q.queryText.toLowerCase().includes("this is nice")));
});

test("rejects a sentence shorter than minWordsPerPhrase even if informative", () => {
  const queries = extractCandidatePhrases(`${SHORT_BUT_DISTINCTIVE} ${DISTINCTIVE_SENTENCE}`);
  assert.ok(!queries.some((q) => q.queryText === SHORT_BUT_DISTINCTIVE));
});

test("includes a long, lexically distinctive sentence", () => {
  const queries = extractCandidatePhrases(`${GENERIC_SHORT_SENTENCE} ${DISTINCTIVE_SENTENCE}`);
  assert.ok(queries.some((q) => q.queryText.includes("Photosynthetic efficiency")));
});

test("caps output at maxQueries plus keywordQueryCount even for a document with many distinctive sentences", () => {
  const sentences = Array.from(
    { length: 40 },
    (_, i) => `Distinctive terminology cluster number ${i} exhibits unusually specific vocabulary combinations rarely observed elsewhere.`,
  );
  const queries = extractCandidatePhrases(sentences.join(" "));
  // Phase 5: total bound is now maxQueries sentence-based queries PLUS up to
  // keywordQueryCount companion keyword queries (see extractKeywordQueries)
  // PLUS up to topicOnlyQueryCount topic-only queries (ISSUE 1) — still a
  // small, fixed, deterministic bound, never proportional to document length.
  assert.ok(queries.length <= DEFAULT_PHRASE_EXTRACTION_CONFIG.maxQueries + DEFAULT_PHRASE_EXTRACTION_CONFIG.keywordQueryCount + DEFAULT_PHRASE_EXTRACTION_CONFIG.topicOnlyQueryCount);
  assert.ok(queries.length >= DEFAULT_PHRASE_EXTRACTION_CONFIG.minQueries, "a long, uniformly distinctive document should reach the target minimum");
});

test("chunks an overlong sentence into windows bounded by maxWordsPerPhrase", () => {
  const words = Array.from({ length: 60 }, (_, i) => `distinctiveword${i}`);
  const longSentence = `${words.join(" ")}.`;
  const queries = extractCandidatePhrases(longSentence);
  for (const query of queries) {
    const wordCount = query.queryText.split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount <= DEFAULT_PHRASE_EXTRACTION_CONFIG.maxWordsPerPhrase, `"${query.queryText}" exceeds maxWordsPerPhrase`);
  }
});

test("deduplicates an exactly-repeated sentence", () => {
  const text = `${DISTINCTIVE_SENTENCE} Some filler paragraph text goes here to separate the repeats from each other in the document body. ${DISTINCTIVE_SENTENCE}`;
  const queries = extractCandidatePhrases(text);
  const matches = queries.filter((q) => q.queryText === DISTINCTIVE_SENTENCE);
  assert.equal(matches.length, 1);
});

test("is deterministic for identical input", () => {
  const text = `${DISTINCTIVE_SENTENCE} ${GENERIC_SHORT_SENTENCE} Another moderately distinctive sentence about cryptographic protocols and entangled photon pairs.`;
  const first = extractCandidatePhrases(text);
  const second = extractCandidatePhrases(text);
  assert.deepEqual(first, second);
});

test("assigns rank 0 to the highest-scoring candidate", () => {
  const text = `${GENERIC_SHORT_SENTENCE} ${DISTINCTIVE_SENTENCE}`;
  const queries = extractCandidatePhrases(text);
  assert.equal(queries[0]?.rank, 0);
});

test("never exceeds ~20 sentence queries plus a small fixed keyword-query addition for a very large document (no full-document leakage)", () => {
  const paragraph = Array.from(
    { length: 300 },
    (_, i) => `Sentence ${i} contains reasonably unique technical vocabulary about biochemistry synthesis pathways.`,
  ).join(" ");
  const queries = extractCandidatePhrases(paragraph);
  assert.ok(queries.length <= 20 + DEFAULT_PHRASE_EXTRACTION_CONFIG.keywordQueryCount + DEFAULT_PHRASE_EXTRACTION_CONFIG.topicOnlyQueryCount);
});

// ---------------------------------------------------------------------------
// REGRESSION (discovery-loss investigation, 2026-08-21): two independent
// failure mechanisms, both traced live against real Social Sciences and
// Humanities exact-copy submissions that never surfaced their own ground-
// truth source paper. Fixtures below use invented subject matter (not the
// real benchmark papers, their titles, or their vocabulary) to prove the
// fix is a general mechanism, not a patch for those two specific documents.
// ---------------------------------------------------------------------------

test("REGRESSION (title-term exclusion): a document's own title term reaches a generated query even when it never repeats in the body", () => {
  // "cryptophasia"/"idioglossia" appear exactly ONCE each (in the title
  // line) — under pure body-frequency ranking (n >= 2 required) they would
  // never even qualify as topic-term candidates, let alone be selected,
  // because four unrelated words repeat 4-5x each in the body. This is the
  // general shape of the real failure: a paper's own title vocabulary can
  // be genuinely rare in its body relative to other recurring terms.
  const title = "Cryptophasia and idioglossia patterns in monozygotic twin language acquisition studies.";
  const body = [
    "Longitudinal caregivers reported vocabulary assessment scores across sixteen consecutive quarterly evaluation sessions throughout the study period.",
    "Caregivers completed longitudinal vocabulary assessment questionnaires during each scheduled clinical evaluation visit without exception.",
    "Assessment protocols required caregivers to document longitudinal vocabulary growth using standardized developmental milestone checklists.",
    "Quarterly longitudinal assessment data from caregivers indicated steady vocabulary expansion across the entire observation window.",
    "Researchers analyzed caregivers assessment responses to track longitudinal vocabulary trajectories throughout early childhood development.",
  ].join(" ");
  const queries = extractCandidatePhrases(`${title} ${body}`);
  assert.ok(
    queries.some((q) => q.queryText.toLowerCase().includes("cryptophasia")),
    `expected the title's own distinctive term to reach at least one query; got: ${JSON.stringify(queries.map((q) => q.queryText))}`,
  );
  // The existing body-frequency signal must still work — this is additive,
  // not a replacement.
  assert.ok(queries.some((q) => q.queryText.toLowerCase().includes("longitudinal") || q.queryText.toLowerCase().includes("vocabulary")));
});

test("REGRESSION (title-term exclusion): a document with no distinctive title term is completely unaffected (frequency ranking alone still decides)", () => {
  const title = "This is a short introduction to the following study.";
  const body = [
    "Longitudinal caregivers reported vocabulary assessment scores across sixteen consecutive quarterly evaluation sessions throughout the study period.",
    "Caregivers completed longitudinal vocabulary assessment questionnaires during each scheduled clinical evaluation visit without exception.",
    "Assessment protocols required caregivers to document longitudinal vocabulary growth using standardized developmental milestone checklists.",
  ].join(" ");
  const queries = extractCandidatePhrases(`${title} ${body}`);
  assert.ok(queries.some((q) => q.queryText.toLowerCase().includes("longitudinal")));
});

test("REGRESSION (rarity tie-break, 2026-08-21): a rare-but-recurring title term beats a highly frequent generic title term for the reserved topic-term slot", () => {
  // Isolates the topic-term mechanism precisely by reading the topic-ONLY
  // query — built from nothing but extractTopicTerms's own output, no
  // per-sentence words mixed in (see extractTopicOnlyQuery) — rather than
  // any sentence-type query, which could pass for unrelated reasons (a
  // short, dense title sentence can score well as a sentence candidate on
  // its own). "resonant" is a generic concept word repeated throughout the
  // body (8x); "glasswing" is a rare, coined term recurring just twice —
  // both are genuine title words. Confirmed live on two real papers
  // (Social Sciences, Humanities) that the frequent-generic word alone
  // returns 1,000+ results with the real target nowhere in the top 5,
  // while the rare-but-real term alone narrows to a handful with the
  // target at rank 0 — this test pins the SELECTION, not a live search.
  const title = "Glasswing resonance patterns and resonant coupling in synthetic membrane arrays.";
  const body = [
    "Resonant coupling between adjacent membrane cells was measured across sixteen consecutive trial configurations under controlled pressure.",
    "Researchers observed resonant behavior consistently whenever coupling strength exceeded the calibrated threshold value.",
    "The resonant response amplitude increased proportionally with membrane thickness across every tested configuration.",
    "Coupling strength and resonant frequency were jointly optimized during the calibration phase of the experiment.",
    "Glasswing membrane samples exhibited the same resonant coupling behavior as the synthetic control group.",
    "Further resonant measurements confirmed the coupling trend held across seven additional membrane thicknesses tested.",
    "Analysis of resonant coupling data revealed no significant deviation from the predicted theoretical model.",
    "The observed resonant coupling pattern was reproducible across independent trials conducted by separate research teams.",
  ].join(" ");
  const queries = extractCandidatePhrases(`${title} ${body}`);
  // extractCandidatePhrases's own construction order is
  // [...sentenceQueries, ...keywordQueries, ...topicOnlyQueries] — with the
  // default config (topicOnlyQueryCount: 1), the topic-only query (built
  // from nothing but extractTopicTerms's own output) is reliably the last
  // element, which is a more robust way to isolate it than pattern-matching
  // its text.
  const topicOnlyQuery = queries[queries.length - 1];
  assert.equal(topicOnlyQuery.queryType, "keyword");
  assert.ok(
    topicOnlyQuery.queryText.toLowerCase().includes("glasswing"),
    `expected the rare title term "glasswing" (2 occurrences) to win over the frequent generic title term "resonant" (8+ occurrences); topic-only query was: "${topicOnlyQuery.queryText}"`,
  );
});

test("REGRESSION (HAL/repository-banner discovery loss, 2026-08-21): a reprinted-title term beats a rarer repository-banner word AND a rarer author-byline word for the reserved topic-term slot", () => {
  // Reproduces the real failure mode (soc-openaire, DOI
  // 10.1057/s41253-026-00314-w, hosted on HAL): a repository deposit banner
  // sits ahead of the paper's real title inside the same 150-word title
  // window, and the paper's own title gets reprinted verbatim in front
  // matter (once as a deposit heading, again in a "to cite this version"
  // line) — generic, invented repository wording here, not HAL's own text,
  // to prove the mechanism is repository-agnostic. Two confounds are
  // deliberately present, both of which previously won the reserved slot
  // over the real title term before this fix:
  //  - "domain" (banner-only vocabulary) has a genuine, unrelated SECOND
  //    mention deep in the body ("crossed into the frequency domain") —
  //    exactly the kind of real, non-banner occurrence a fix must not
  //    discard by simply blacklisting banner-adjacent words.
  //  - "okonkwo" (the author's own byline) is reprinted in front matter for
  //    an unrelated reason (byline + citation line) and picks up one more
  //    incidental body mention ("Corresponding author Okonkwo...") — rare
  //    enough to beat the real title term on frequency alone.
  // Only "vexbriar" (the paper's own coined term) is BOTH reprinted within
  // the window AND recurs 2+ times in the actual body discussion.
  const banner =
    "RepoVault Id rv 88213 Submitted 4 Feb 2026 RepoVault is a multi domain open access repository " +
    "for the deposit and dissemination of scholarly works whether published or not The works may come " +
    "from academic institutions in many countries or from public or private research organizations engaged " +
    "in ongoing investigation Distributed under an Open Access Attribution License version four International " +
    "terms apply to redistribution and reuse of this material without additional restriction beyond attribution " +
    "to the original authors and repository listing";
  const titleBlock =
    "Vexbriar Anomalies in Turbulent Boundary Layers Priya Okonkwo To cite this version Priya Okonkwo " +
    "Vexbriar Anomalies in Turbulent Boundary Layers Fluid Dynamics Review two thousand twenty six volume " +
    "twelve pages one through twenty two";
  const body = [
    "Abstract This review examines turbulent boundary layer anomalies observed under high shear flow conditions across several wind tunnel trials.",
    "Turbulent boundary transitions were recorded at multiple layer depths, and every anomaly measurement was cross validated against reference boundary datasets.",
    "The recurring vexbriar pattern appeared whenever turbulent boundary shear exceeded a critical threshold during layer transition.",
    "Researchers confirmed the vexbriar signature persisted across independent turbulent boundary trials regardless of layer thickness.",
    "Further boundary layer analysis crossed into the frequency domain to characterize the anomaly more precisely.",
    "Corresponding author Okonkwo can be reached for additional turbulent boundary layer trial data upon request.",
  ].join(" ");

  const queries = extractCandidatePhrases(`${banner} ${titleBlock} ${body}`);
  const topicOnlyQuery = queries[queries.length - 1];
  assert.equal(topicOnlyQuery.queryType, "keyword");
  assert.ok(
    topicOnlyQuery.queryText.toLowerCase().includes("vexbriar"),
    `expected the reprinted, body-relevant title term "vexbriar" to win the reserved slot over the banner word "domain" and the author byline "okonkwo"; topic-only query was: "${topicOnlyQuery.queryText}"`,
  );
  assert.ok(!topicOnlyQuery.queryText.toLowerCase().includes("okonkwo"));
});

test("REGRESSION (markup/URL contamination): embedded XML tags and URLs never surface as query terms, and real prose around them still does", () => {
  const document = [
    "Distinctive electrochemical impedance spectroscopy reveals unexpected capacitive behavior across porous graphene electrode assemblies under variable humidity conditions.",
    'See the raw markup example: <note type="fictionalAttributeValue" xml:id="lat.exampleNote.Fake1.aa"> <seg type="testRefKind" xml:id="b.exampleRef.Fake1.zz"> reference content </seg> </note> for full annotation details.',
    "Additional resources are catalogued at http://www.fictionalexamplearchive-notreal.org/en/reference/path and www.another-fictional-example-host.test/index for cross-referencing.",
    "Porous graphene electrode assemblies exhibited consistent capacitive response across every measured humidity threshold examined in this controlled laboratory investigation.",
  ].join(" ");
  const queries = extractCandidatePhrases(document);
  const allQueryText = queries.map((q) => q.queryText.toLowerCase()).join(" | ");
  assert.ok(!allQueryText.includes("<"), `no query should contain a raw "<": ${allQueryText}`);
  assert.ok(!allQueryText.includes(">"), `no query should contain a raw ">": ${allQueryText}`);
  assert.ok(!allQueryText.includes("http"), `no query should contain a URL fragment: ${allQueryText}`);
  assert.ok(!allQueryText.includes("fictionalattributevalue"), `no query should contain a raw XML attribute value: ${allQueryText}`);
  assert.ok(!allQueryText.includes("testrefkind"), `no query should contain a raw XML attribute value: ${allQueryText}`);
  assert.ok(!allQueryText.includes("fictionalexamplearchive"), `no query should contain a URL domain label: ${allQueryText}`);
  assert.ok(allQueryText.includes("graphene") || allQueryText.includes("electrochemical"), "real distinctive prose around the markup must still surface");
});

test("sanitizeExtractionArtifacts: strips http(s) URLs, bare www URLs, and XML/HTML tags", () => {
  const input = 'Visit https://example.test/path?x=1 or www.example-two.test/page for details. <note type="x" id="y"> body </note> continues here.';
  const sanitized = sanitizeExtractionArtifacts(input);
  assert.ok(!sanitized.includes("https://"));
  assert.ok(!sanitized.includes("www."));
  assert.ok(!sanitized.includes("<note"));
  assert.ok(!sanitized.includes("</note>"));
  assert.ok(sanitized.includes("Visit"));
  assert.ok(sanitized.includes("body"));
  assert.ok(sanitized.includes("continues here"));
});

test("sanitizeExtractionArtifacts: strips numbered inline hyperlink markers like [http7] without touching real prose", () => {
  const input = "This finding echoes an earlier framework [http7] that provides open editions of ancient texts linked to canonical references.";
  const sanitized = sanitizeExtractionArtifacts(input);
  assert.ok(!sanitized.toLowerCase().includes("http"));
  assert.ok(sanitized.includes("echoes an earlier framework"));
  assert.ok(sanitized.includes("canonical references"));
});

test("sanitizeExtractionArtifacts: does not mistake mathematical inequality expressions for markup", () => {
  const input = "The model requires x < 5 and y > 3 to hold simultaneously across the entire constrained optimization region.";
  const sanitized = sanitizeExtractionArtifacts(input);
  assert.equal(sanitized, input, "no markup here — the text must pass through completely unchanged");
});
