import assert from "node:assert/strict";
import test from "node:test";
import { extractTextFromJatsXml } from "../lib/academic-search/providers/jats-text-extractor.ts";
import { computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "../lib/document-correspondence.ts";

test("extracts paragraph text from <body>, joined with newlines between block elements", () => {
  const xml = `<article><body><sec><title>1 Introduction</title><p>First paragraph.</p><p>Second paragraph.</p></sec></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "1 Introduction\nFirst paragraph.\nSecond paragraph.");
});

test("strips tables, figures, and formulas entirely (content included), not just their tags", () => {
  const xml = `<article><body><p>Before.</p><table-wrap><table><tr><td>1.23</td></tr></table></table-wrap><p>After.</p><disp-formula><mml:math><mml:mi>x</mml:mi></mml:math></disp-formula></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "Before.\nAfter.");
  assert.ok(!text.includes("1.23"));
  assert.ok(!text.includes("x"));
});

test("strips <xref> citation markers along with their inner reference number", () => {
  const xml = `<article><body><p>A claim<xref rid="r1" ref-type="bibr">1</xref> follows here.</p></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "A claim follows here.");
});

test("decodes standard XML entities", () => {
  const xml = `<article><body><p>Fish &amp; chips &lt;are&gt; tasty &quot;food&quot;.</p></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, `Fish & chips <are> tasty "food".`);
});

test("decodes numeric character references (decimal and hex)", () => {
  const xml = `<article><body><p>en&#8211;dash and hex&#x2014;dash.</p></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "en–dash and hex—dash.");
});

test("excludes <back> (references/footnotes) entirely — it is a sibling of <body>, never nested inside it", () => {
  const xml = `<article><body><p>Real article prose.</p></body><back><ref-list><ref>Some Citation, 2020.</ref></ref-list></back></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "Real article prose.");
});

test("falls back to <abstract> when there is no <body>", () => {
  const xml = `<article><front><article-meta><abstract><p>Abstract-only record text.</p></abstract></article-meta></front></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "Abstract-only record text.");
});

// --- Phase 5 fix: <abstract> and <body> are both extracted when both are present ---

test("Phase 5: when BOTH <abstract> and <body> are present, both are extracted and concatenated, abstract first — not just <body> as before", () => {
  const xml = `<article>
    <front><article-meta><abstract><p>This is the paper's own abstract summary text.</p></abstract></article-meta></front>
    <body><sec><title>Introduction</title><p>This is the paper's separate introduction prose.</p></sec></body>
  </article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("abstract summary text"), "abstract prose must be present");
  assert.ok(text.includes("introduction prose"), "body prose must still be present too");
  assert.ok(text.indexOf("abstract summary") < text.indexOf("introduction prose"), "abstract must come first, matching natural reading order");
});

test("Phase 5 regression: a submission verbatim-matching ONLY the abstract (not the body) now has real overlapping text to compare against", () => {
  const xml = `<article>
    <front><article-meta><abstract><p>Distinctive biochemical pathway analysis reveals unexpected metabolic divergence across independent cellular lineages.</p></abstract></article-meta></front>
    <body><sec><p>A completely different, unrelated paragraph about the study's broader background and unrelated context, sharing no wording with the abstract at all here.</p></sec></body>
  </article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("Distinctive biochemical pathway analysis reveals unexpected metabolic divergence"), "the old body-only extractor would have silently dropped this exact-match passage");
});

// --- Phase 5 fix: invisible Unicode formatting characters no longer split words ---

test("Phase 5: a zero-width non-joiner (U+200C) embedded mid-word by the publisher's own numeric character reference is stripped, not treated as a word boundary", () => {
  const xml = `<article><body><p>Pain assessme&#x200c;&#x200c;nt remains challenging.</p></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("assessment"), "the word must be reassembled, not split into 'assessme' + 'nt'");
  assert.ok(!text.includes("assessme "), "no stray space should remain where the invisible characters were");
});

test("Phase 5: other invisible-format characters (ZWSP, ZWJ, word joiner, BOM, soft hyphen) are also stripped", () => {
  const xml = `<article><body><p>al&#x200b;go&#x200d;rithm and trans&#x2060;former and pre&#xfeff;fix and soft&#xad;hyphen.</p></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("algorithm"));
  assert.ok(text.includes("transformer"));
  assert.ok(text.includes("prefix"));
  assert.ok(text.includes("softhyphen"));
});

test("returns an empty string, never throws, for XML with neither body nor abstract", () => {
  const xml = `<article><front><article-meta><title-group><article-title>Just a title</article-title></title-group></article-meta></front></article>`;
  assert.equal(extractTextFromJatsXml(xml), "");
});

test("returns an empty string, never throws, for malformed/empty input", () => {
  assert.equal(extractTextFromJatsXml(""), "");
  assert.equal(extractTextFromJatsXml("not xml at all"), "");
  assert.equal(extractTextFromJatsXml("<body>unclosed"), "");
});

test("is deterministic: identical input always produces identical output", () => {
  const xml = `<article><body><sec><title>T</title><p>Some <italic>emphasized</italic> prose with <xref rid="r1">2</xref> a citation.</p></sec></body></article>`;
  const first = extractTextFromJatsXml(xml);
  const second = extractTextFromJatsXml(xml);
  assert.equal(first, second);
  assert.equal(first, "T\nSome emphasized prose with a citation.");
});

test("real-world sample: a captured Europe PMC fullTextXML fragment extracts to clean, table/formula-free prose", () => {
  const xml = `<article><body><sec sec-type="intro" id="sec001"><title>1 Introduction</title><p>Pain assessme‌‌nt <xref rid="pdig.0001424.ref001" ref-type="bibr">1</xref> in non-verbal patients&#8212;neonates, individuals with cognitive impairment, and sedated patients&#8212;represents one of clinical medicine’s most critical unmet needs.</p></sec></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.startsWith("1 Introduction\nPain assessme"));
  assert.ok(!text.includes("<xref"));
  assert.ok(!text.includes("ref-type"));
});

// =============================================================================
// Missing-passage audit fixes: JATS float / sub-article / trans-abstract hygiene
// (D:/TurnitPlusTemp/missing-passage-audit — confirmed defects JATS-1..5).
// =============================================================================

test("audit JATS-1: a <table-wrap> keeps its <label> and <caption> (a copied table title now has text to match), while the cell grid stays dropped", () => {
  const xml = `<article><body><sec><p>Body prose.</p>` +
    `<table-wrap id="t5" position="float"><label>Table 5</label>` +
    `<caption><title>Associations of proteins with retinal nerve fiber layer thickness in UK Biobank.</title></caption>` +
    `<table><thead><tr><th>Protein</th><th>Beta</th></tr></thead><tbody><tr><td>UMOD</td><td>0.322</td></tr></tbody></table>` +
    `</table-wrap></sec></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("Table 5"), "the table label must be kept");
  assert.ok(text.includes("Associations of proteins with retinal nerve fiber layer thickness in UK Biobank"), "the table caption must be kept");
  assert.ok(text.includes("Body prose."), "surrounding body prose is unaffected");
  assert.ok(!text.includes("UMOD") && !text.includes("0.322"), "raw table cell values must NOT be flattened into the text");
});

test("audit JATS-1: a <table-wrap-foot> footnote / abbreviation legend is kept", () => {
  const xml = `<article><body><sec>` +
    `<table-wrap id="t3"><label>Table 3</label><caption><p>Incidence rate ratios.</p></caption>` +
    `<table><tbody><tr><td>1.00</td></tr></tbody></table>` +
    `<table-wrap-foot><fn id="fn3"><p>IRR=incidence rate ratio; CI=confidence interval. All estimates are adjusted for age in one year age band, seasonal effect, opioids and psychotropic medications.</p></fn></table-wrap-foot>` +
    `</table-wrap></sec></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("All estimates are adjusted for age in one year age band, seasonal effect, opioids and psychotropic medications"), "the table footnote prose must survive");
  assert.ok(text.includes("IRR=incidence rate ratio"), "an abbreviation legend in the footnote must survive");
});

test("audit JATS-1: a <fig> keeps its caption, drops the <graphic>", () => {
  const xml = `<article><body><sec><p>See figure.</p>` +
    `<fig id="f2" position="float"><label>Fig 2</label>` +
    `<caption><p>Forest plot summarising the adjusted IRRs for self-harm associated with gabapentinoid use, stratified by sex.</p></caption>` +
    `<alternatives><graphic xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="fig2.jpg"/></alternatives></fig>` +
    `</sec></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("Fig 2"));
  assert.ok(text.includes("Forest plot summarising the adjusted IRRs for self-harm associated with gabapentinoid use, stratified by sex."));
  assert.ok(!text.includes("fig2.jpg") && !text.includes("xlink"), "graphic href / attributes must not leak");
});

test("audit JATS-3: <boxed-text> prose (key-points box, policy box) is kept", () => {
  const xml = `<article><body><sec><p>Main text.</p>` +
    `<boxed-text id="boxa"><sec><title>What this study adds</title><list list-type="simple"><list-item><p>Risk of self-harm is increased before treatment, persists during the initial treatment period, and rises again shortly after discontinuation.</p></list-item></list></sec></boxed-text>` +
    `</sec></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("What this study adds"));
  assert.ok(text.includes("Risk of self-harm is increased before treatment, persists during the initial treatment period, and rises again shortly after discontinuation."));
});

test("audit JATS-4: a <sub-article> (peer review) is not extracted — no duplicate or mis-attributed prose", () => {
  const xml = `<article>` +
    `<front><article-meta><abstract><p>Main article abstract.</p></abstract></article-meta></front>` +
    `<body><sec><p>The article's own body prose about metabolic divergence.</p></sec></body>` +
    `<sub-article article-type="peer-review"><front-stub><title-group><article-title>Peer Review File</article-title></title-group></front-stub>` +
    `<body><sec><p>Reviewer 2 notes the sample size is small and requests clarification of the primary endpoint.</p></sec></body></sub-article>` +
    `</article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("The article's own body prose about metabolic divergence."));
  assert.ok(text.includes("Main article abstract."));
  assert.ok(!text.includes("Reviewer 2"), "reviewer commentary from a <sub-article> must not be extracted as the article's text");
  assert.ok(!text.includes("Peer Review File"));
});

test("audit JATS-4: a document that is ONLY a container of <sub-article>s (conference proceedings) yields '' rather than one arbitrary sub-article", () => {
  const xml = `<article><front><journal-meta><journal-title>Proceedings</journal-title></journal-meta></front>` +
    `<sub-article id="a1"><front-stub/><body><sec><p>First abstract body.</p></sec></body></sub-article>` +
    `<sub-article id="a2"><front-stub/><body><sec><p>Second abstract body.</p></sec></body></sub-article>` +
    `</article>`;
  assert.equal(extractTextFromJatsXml(xml), "");
});

test("audit JATS-5: a <trans-abstract> (translated abstract — still the authors' words) is captured alongside the main abstract, not silently dropped", () => {
  const xml = `<article><front><article-meta>` +
    `<abstract><p>Background: endothelial dysregulation precedes chronic lung allograft dysfunction.</p></abstract>` +
    `<trans-abstract xml:lang="fr"><p>Contexte: la dysregulation endotheliale precede la dysfonction chronique de l'allogreffe pulmonaire.</p></trans-abstract>` +
    `</article-meta></front><body><sec><p>Body prose.</p></sec></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("endothelial dysregulation precedes chronic lung allograft dysfunction"), "main abstract kept");
  assert.ok(text.includes("la dysregulation endotheliale precede la dysfonction chronique"), "translated abstract kept");
  assert.ok(text.includes("Body prose."));
});

test("audit scope: JATS <front> metadata (affiliations, the 'Citation:' line, funding, licence) is NOT pulled in as article text", () => {
  const xml = `<article><front><article-meta>` +
    `<contrib-group><contrib contrib-type="author"><name><surname>Li</surname><given-names>H</given-names></name></contrib></contrib-group>` +
    `<aff id="aff5">5 Centre for Eye and Vision Research (CEVR), Hong Kong, Hong Kong SAR, China</aff>` +
    `<author-notes><fn><p>These authors are co-first authors on this work.</p></fn></author-notes>` +
    `<permissions><license><license-p>This is an open access article distributed under the terms of the Creative Commons Attribution License.</license-p></license></permissions>` +
    `<funding-group><award-group><funding-source>National Natural Science Foundation of China</funding-source></award-group></funding-group>` +
    `<abstract><p>Real abstract prose here.</p></abstract>` +
    `</article-meta></front><body><sec><p>Real body prose here.</p></sec></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("Real abstract prose here."));
  assert.ok(text.includes("Real body prose here."));
  assert.ok(!text.includes("Centre for Eye and Vision Research"), "affiliations are not article text");
  assert.ok(!text.includes("co-first authors"), "author notes are not article text");
  assert.ok(!text.includes("Creative Commons"), "licence boilerplate is not article text");
  assert.ok(!text.includes("National Natural Science Foundation"), "funding metadata is not article text");
});

test("audit scope: the reference list in <back> is still never extracted (no regression from the new elements)", () => {
  const xml = `<article><body><sec><p>Article prose.</p></sec></body>` +
    `<back><ref-list><title>References</title>` +
    `<ref id="r1"><mixed-citation>Gulshan V, et al. Development and validation of a deep learning algorithm. JAMA. 2016;316(22):2402-2410.</mixed-citation></ref>` +
    `</ref-list></back></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("Article prose."));
  assert.ok(!text.includes("Gulshan"), "the bibliography must stay out of the extracted text");
  assert.ok(!text.includes("JAMA. 2016"));
});

test("audit: a <table-wrap> parked in a sibling <floats-group> (not inside <body>) still has its caption salvaged, and is not double-counted when also referenced inline", () => {
  const xml = `<article><body><sec><p>As shown in Table 1, the cohorts were balanced.</p></sec></body>` +
    `<floats-group>` +
    `<table-wrap id="t1"><label>Table 1</label><caption><p>Patient characteristics at baseline across the three enrolment cohorts.</p></caption>` +
    `<table><tbody><tr><td>n</td><td>100</td></tr></tbody></table></table-wrap>` +
    `</floats-group></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("Patient characteristics at baseline across the three enrolment cohorts."), "a floats-group caption must be reachable");
  const occurrences = text.split("Patient characteristics at baseline across the three enrolment cohorts.").length - 1;
  assert.equal(occurrences, 1, "the caption must appear exactly once, not once per place the float is emitted");
});

test("audit: a verbatim-repeated long block (>= 12 words, e.g. a shared table footnote) is de-duplicated, keeping the first occurrence", () => {
  const line = "All models were adjusted for baseline age sex body mass index smoking status and diabetes duration at enrolment.";
  const xml = `<article><body>` +
    `<sec><title>Table 1</title><p>${line}</p></sec>` +
    `<sec><title>Table 2</title><p>${line}</p><p>A distinctive unique results sentence follows here.</p></sec>` +
    `</body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text.split(line).length - 1, 1, "the repeated block appears once");
  assert.ok(text.includes("A distinctive unique results sentence follows here."), "unique prose is untouched");
});

test("audit: deduplication does not remove genuinely recurring SHORT lines (headings, brief notes < 12 words)", () => {
  const xml = `<article><body>` +
    `<sec><title>Results</title><p>First finding.</p><p>Values are mean and standard deviation.</p></sec>` +
    `<sec><title>Results</title><p>Second finding.</p><p>Values are mean and standard deviation.</p></sec>` +
    `</body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text.split("Results").length - 1, 2, "a short heading may legitimately repeat");
  assert.equal(text.split("Values are mean and standard deviation.").length - 1, 2, "a short (< 12-word) recurring note is kept, not de-duplicated");
});

test("audit: deduplication cannot destroy a match when the SAME long block appears in two different surrounding contexts", () => {
  // The de-dup risk: a submission that copied "[context B] + [repeated block] + [context B after]"
  // contiguously, where only context A's copy of the repeated block survives extraction.
  const dupBlock = "The composite endpoint combined cardiovascular death nonfatal myocardial infarction and nonfatal stroke over the full follow up period.";
  const aBefore = "In the primary analysis of the intention to treat population we evaluated the following outcome.";
  const aAfter = "These results were consistent across every prespecified subgroup examined in the trial cohort.";
  const bBefore = "A sensitivity analysis restricted to participants with complete baseline data reported the same estimate.";
  const bAfter = "This robustness check used multiple imputation for the seventeen participants missing a single covariate.";
  const xml = `<article><body>` +
    `<sec><title>Primary analysis</title><p>${aBefore}</p><p>${dupBlock}</p><p>${aAfter}</p></sec>` +
    `<sec><title>Sensitivity analysis</title><p>${bBefore}</p><p>${dupBlock}</p><p>${bAfter}</p></sec>` +
    `</body></article>`;
  const source = extractTextFromJatsXml(xml);

  // 1. The repeated block is de-duplicated (one copy) ...
  assert.equal(source.split(dupBlock).length - 1, 1, "the repeated block appears once in the extracted source");
  // 2. ... but its words, and BOTH surrounding contexts, are still all present:
  for (const chunk of [aBefore, aAfter, bBefore, bAfter, dupBlock]) {
    assert.ok(source.replace(/\s+/g, " ").includes(chunk.replace(/\s+/g, " ")), `context/block still present: "${chunk.slice(0, 40)}..."`);
  }
  // 3. A submission that copied the B-context span contiguously still matches
  //    that whole span against this de-duplicated source, end to end.
  const bSpanCopiedByStudent = `${bBefore} ${dupBlock} ${bAfter}`;
  const result = computeDocumentCorrespondence(bSpanCopiedByStudent, source, {
    ...DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
    strongContainmentThreshold: 0.01,
    minimumMatchedWords: 1,
  });
  const studentWordCount = bSpanCopiedByStudent.split(/\s+/).filter(Boolean).length;
  assert.equal(result.matchedWordCount, studentWordCount, "every word the student copied is still flagged");
  assert.equal(result.allMatchedPassages.length, 1, "the match stays a single contiguous passage — de-dup did not fragment it");
  assert.equal(result.longestMatchWords, studentWordCount, "the flagged passage spans the full copied run");
});
