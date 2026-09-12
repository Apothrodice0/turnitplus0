import assert from "node:assert/strict";
import test from "node:test";

import { cleanSourceDocument, stripChromeLines, MIN_ANALYZABLE_WORD_COUNT } from "../lib/selective-corpus/corpus-cleaning.ts";

function pad(text, targetWords) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= targetWords) return text;
  const filler = Array.from({ length: targetWords - words.length }, (_, i) => `fillerword${i}`).join(" ");
  return `${text} ${filler}`;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC REPORTS -- WHO
// ═══════════════════════════════════════════════════════════════════════

test("WHO: clean page retains Key facts..Related body, strips everything else", () => {
  const body = pad("Condition X affects millions of people worldwide. It is treatable with early diagnosis.", 280);
  const text = `Skip to main content\nWorld Health Organization\nKey facts\n${body}\nRelated\nOther fact sheets\nSearch`;
  const res = cleanSourceDocument(text, { family: "B_public_reports", title: "WHO fact sheet: condition-x" });
  assert.equal(res.action, "cleaned");
  assert.match(res.rule, /WHO structural header/);
  assert.match(res.text, /^Key facts/);
  assert.ok(!/Skip to main content/.test(res.text));
  assert.ok(!res.text.split("\n").includes("Related"));
  assert.ok(res.wordCountAfter >= MIN_ANALYZABLE_WORD_COUNT, "cleaned WHO body must clear the analyzable-text floor in this test");
});

test("WHO: contaminated/structurally-broken page (no Key facts marker) is EXCLUDED, not guessed at", () => {
  const text = pad("World Health Organization homepage with no recognizable structural marker at all.", 300);
  const res = cleanSourceDocument(text, { family: "B_public_reports", title: "WHO fact sheet: condition-y" });
  assert.equal(res.action, "excluded");
  assert.match(res.reason, /Key facts.*not found/);
});

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC REPORTS -- MedlinePlus
// ═══════════════════════════════════════════════════════════════════════

test("MedlinePlus: clean page extracts body between 2nd Summary and next ToC-item repeat", () => {
  const bodyText = pad(
    "Some real substantive medical description of the condition, its causes, symptoms, and typical treatment options for patients.",
    280,
  );
  const text = `On this page\nSummary\nCauses\nSymptoms\nTreatment\nSummary\n${bodyText}\nCauses`;
  const res = cleanSourceDocument(text, { family: "B_public_reports", title: "MedlinePlus: some-condition" });
  assert.equal(res.action, "cleaned");
  assert.match(res.rule, /MedlinePlus structural cut/);
  assert.ok(res.text.includes("substantive medical description"));
  assert.ok(!res.text.includes("On this page"));
});

test("MedlinePlus: page whose cleaned body falls below the 250-word floor is EXCLUDED", () => {
  const text = "On this page\nSummary\nCauses\nSummary\nOnly a very short body here that is nowhere near the analyzable-text floor.\nCauses";
  const res = cleanSourceDocument(text, { family: "B_public_reports", title: "MedlinePlus: thin-condition" });
  assert.equal(res.action, "excluded");
  assert.match(res.reason, new RegExp(`fell below the ${MIN_ANALYZABLE_WORD_COUNT}-word`));
});

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC REPORTS -- CDC
// ═══════════════════════════════════════════════════════════════════════

test("CDC: body/footer removal keeps only substantive article text", () => {
  const body = pad("Substantive CDC guidance about the condition, prevention measures, and recommended actions for the public.", 280);
  const text = `An official website of the United States government Here's how you know official, secure websites.${body}\nSources and Page Info\nCitations here`;
  const res = cleanSourceDocument(text, { family: "B_public_reports", title: "cdc-condition-z" });
  assert.equal(res.action, "cleaned");
  assert.match(res.rule, /CDC structural/);
  assert.ok(res.text.includes("Substantive CDC guidance"));
  assert.ok(!res.text.includes("Sources and Page Info"));
});

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC REPORTS -- World Bank
// ═══════════════════════════════════════════════════════════════════════

test("World Bank: always excluded, never guessed at, even with CSS/template leakage present", () => {
  const text = pad("sec-spacing col ctrl col data-table-fragment class=chart-wrapper some real looking prose mixed in", 300);
  const res = cleanSourceDocument(text, { family: "B_public_reports", title: "wb-some-report" });
  assert.equal(res.action, "excluded");
  assert.match(res.reason, /World Bank/);
  assert.match(res.reason, /not confined to a separable/);
});

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC REPORTS -- UN/FAO/UNESCO/IPCC
// ═══════════════════════════════════════════════════════════════════════

test("UN/FAO/UNESCO/IPCC: substantive content preserved, only chrome lines removed", () => {
  const text = pad("Skip navigation\nSearch\nSubstantive UNESCO report content about education policy across member states.\nClose", 280);
  const res = cleanSourceDocument(text, { family: "B_public_reports", title: "unesco-education-report" });
  assert.equal(res.action, "cleaned");
  assert.match(res.rule, /UNESCO light generic chrome-line strip/);
  assert.ok(res.text.includes("Substantive UNESCO report content"));
  assert.ok(!res.text.includes("Skip navigation"));
});

// ═══════════════════════════════════════════════════════════════════════
// FOUNDATIONAL -- OpenStax
// ═══════════════════════════════════════════════════════════════════════

test("OpenStax: boilerplate footer removed, chapter prose preserved", () => {
  const body = pad("Chapter content explaining the biological process in detail with examples and diagrams described in text.", 280);
  const text = `${body}\nCitation/Attribution\nThis work is licensed under a Creative Commons license. Access for free at openstax.org.`;
  const res = cleanSourceDocument(text, { family: "F_foundational", title: "https://openstax.org/books/biology-2e/pages/1-1-intro" });
  assert.equal(res.action, "cleaned");
  assert.match(res.rule, /OpenStax structural footer cut/);
  assert.ok(res.text.includes("Chapter content explaining"));
  assert.ok(!res.text.includes("Citation/Attribution"));
});

test("OpenStax: page missing the Citation/Attribution marker is EXCLUDED, not guessed at", () => {
  const text = pad("Chapter content with no recognizable footer marker at all in this synthetic test page.", 300);
  const res = cleanSourceDocument(text, { family: "F_foundational", title: "https://openstax.org/books/biology-2e/pages/9-9-broken" });
  assert.equal(res.action, "excluded");
  assert.match(res.reason, /Citation\/Attribution/);
});

// ═══════════════════════════════════════════════════════════════════════
// WIKIPEDIA -- Access to public information country-series
// ═══════════════════════════════════════════════════════════════════════

test("Wikipedia: Access-to-public-information template removed, country-specific prose preserved", () => {
  const intro =
    'Access to public information and freedom of information (FOI) refer to the right of access to information held by public bodies also known as "right to know". Access to public information is considered of fundamental importance for the effective functioning of democratic systems, as it enhances governments’ and public officials’ accountability, boosting people participation and allowing their informed participation into public life. The fundamental premise of the right of access to public information is that the information held by governmental institutions is in principle public and may be concealed only on the basis of legitimate reasons which should be detailed in the law.';
  const countrySpecific = pad("In Ruritania, the Freedom of Information Act was passed in 1998 and established a national information commissioner.", 280);
  const text = `${intro}\n\n${countrySpecific}`;
  const res = cleanSourceDocument(text, { family: "A_wikipedia", title: "Access to public information in Ruritania" });
  assert.equal(res.action, "cleaned");
  assert.match(res.rule, /access-to-info country-series/);
  assert.ok(res.text.includes("Ruritania"));
  assert.ok(!res.text.includes("fundamental importance for the effective functioning"));
});

// ═══════════════════════════════════════════════════════════════════════
// WIKIPEDIA -- climate-year-series
// ═══════════════════════════════════════════════════════════════════════

const CORRECT_CLIMATE_INTRO_2022 =
  "This article documents events, research findings, scientific and technological advances, and human actions to measure, predict, mitigate, and adapt to the effects of global warming and climate change—during the year 2022.";
// The real corpus contains BOTH wordings across different years (confirmed via
// exact source-level comparison against the validated corpus): most years say
// "documents events", but 2025/2026 actually say "documents notable events".
// The old broken production rule REQUIRED "notable" -- which is exactly why it
// never matched the far more common "events"-only wording. The fix makes
// "notable" OPTIONAL so the one rule correctly handles both real wordings,
// rather than swapping which single wording is required.
const NOTABLE_VARIANT_CLIMATE_INTRO_2022 =
  "This article documents notable events, research findings, scientific and technological advances, and human actions to measure, predict, mitigate, and adapt to the effects of global warming and climate change—during the year 2022.";

test("Wikipedia: climate 2022 template (real corrected wording) removed, year-specific summaries preserved", () => {
  const summaries = pad("Summaries\n\nIn March, a major climate report was published detailing regional temperature anomalies.", 280);
  const text = `${CORRECT_CLIMATE_INTRO_2022}\n\n${summaries}`;
  const res = cleanSourceDocument(text, { family: "A_wikipedia", title: "2022 in climate change" });
  assert.equal(res.action, "cleaned");
  assert.match(res.rule, /climate-year-series/);
  assert.ok(!res.text.includes("This article documents events"));
  assert.ok(res.text.includes("major climate report was published"));
});

test("Wikipedia: climate em-dash (U+2014) handled -- also verifies plain hyphen and en dash variants all match", () => {
  const summaries = pad("Summaries\n\nContent for the year.", 280);
  for (const dash of ["—", "-", "–"]) {
    const intro = `This article documents events, research findings, scientific and technological advances, and human actions to measure, predict, mitigate, and adapt to the effects of global warming and climate change${dash}during the year 2023.`;
    const res = cleanSourceDocument(`${intro}\n\n${summaries}`, { family: "A_wikipedia", title: "2023 in climate change" });
    assert.equal(res.action, "cleaned", `dash variant ${JSON.stringify(dash)} should be cleaned`);
    assert.ok(!res.text.includes("This article documents events"));
  }
});

test("Wikipedia: the 'documents notable events' wording (real text used by some years, e.g. 2025/2026) is ALSO removed -- the old rule's bug was requiring 'notable' unconditionally, not the word's mere presence", () => {
  const summaries = pad("Summaries\n\nContent for the year.", 280);
  const text = `${NOTABLE_VARIANT_CLIMATE_INTRO_2022}\n\n${summaries}`;
  const res = cleanSourceDocument(text, { family: "A_wikipedia", title: "2022 in climate change" });
  assert.equal(res.action, "cleaned");
  assert.ok(!res.text.includes("This article documents"), "the notable-variant intro must be fully removed, matching validated-corpus behavior for years that use this wording");
  assert.ok(res.text.includes("Content for the year"));
});

test("Wikipedia: 'notable' is optional, not mutually exclusive -- both wordings are recognized as the SAME template by one rule", () => {
  const summaries = pad("Summaries\n\nContent for the year.", 280);
  const withNotable = cleanSourceDocument(`${NOTABLE_VARIANT_CLIMATE_INTRO_2022}\n\n${summaries}`, { family: "A_wikipedia", title: "2022 in climate change" });
  const withoutNotable = cleanSourceDocument(`${CORRECT_CLIMATE_INTRO_2022}\n\n${summaries}`, { family: "A_wikipedia", title: "2022 in climate change" });
  assert.equal(withNotable.action, "cleaned");
  assert.equal(withoutNotable.action, "cleaned");
  assert.equal(withNotable.rule, withoutNotable.rule, "same named rule handles both real wordings");
});

test("Wikipedia: a climate-year-series article with NO intro paragraph at all (neither wording present) is left unchanged", () => {
  const text = pad("Summaries\n\nMay: a report was released regarding renewable energy adoption trends.", 300);
  const res = cleanSourceDocument(text, { family: "A_wikipedia", title: "2025 in climate change" });
  assert.equal(res.action, "unchanged");
  assert.equal(res.text, text);
});

// ═══════════════════════════════════════════════════════════════════════
// WIKIPEDIA -- GM-food disclaimer
// ═══════════════════════════════════════════════════════════════════════

test("Wikipedia: GM-food standalone disclaimer variant (no trailing sentence) removed, surrounding prose preserved", () => {
  const before = pad("Genetic engineering has been used to develop crops resistant to pests and herbicides for decades.", 150);
  const disclaimer =
    "There is a scientific consensus that currently available food derived from GM crops poses no greater risk to human health than conventional food, but that each GM food needs to be tested on a case-by-case basis before introduction. Nonetheless, members of the public are less likely than scientists to perceive GM foods as safe.";
  const after = pad("In popular culture, genetic engineering features in many works of science fiction exploring its implications.", 150);
  const text = `${before} ${disclaimer} ${after}`;
  const res = cleanSourceDocument(text, { family: "A_wikipedia", title: "Genetic engineering" });
  assert.equal(res.action, "cleaned");
  assert.match(res.rule, /GM-food standalone-disclaimer/);
  assert.ok(!res.text.includes("scientific consensus that currently available food"));
  assert.ok(res.text.includes("resistant to pests"));
  assert.ok(res.text.includes("popular culture"));
});

test("Wikipedia: GM-food standalone disclaimer variant WITH the trailing legal/regulatory sentence and 'much less likely' is also removed", () => {
  const before = pad("GM crops have been the subject of regulatory debate across many jurisdictions for decades.", 150);
  const disclaimer =
    "There is a scientific consensus that currently available food derived from GM crops poses no greater risk to human health than conventional food, but that each GM food needs to be tested on a case-by-case basis before introduction. Nonetheless, members of the public are much less likely than scientists to perceive GM foods as safe. The legal and regulatory status of GM foods varies by country, with some nations banning or restricting them, and others permitting them with widely differing degrees of regulation.";
  const after = pad("History\n\nHumans have directly influenced the genetic makeup of plants for millennia through selective breeding.", 150);
  const text = `${before} \n\n ${disclaimer} \n\n${after}`;
  const res = cleanSourceDocument(text, { family: "A_wikipedia", title: "Genetically modified crops" });
  assert.equal(res.action, "cleaned");
  assert.match(res.rule, /GM-food standalone-disclaimer/);
  assert.ok(!res.text.includes("scientific consensus that currently available food"));
  assert.ok(!res.text.includes("legal and regulatory status"));
  assert.ok(res.text.includes("regulatory debate"));
  assert.ok(res.text.includes("selective breeding"));
});

test("Wikipedia: GM-food FUSED-clause variant is left intact (not force-cleaned), preserving substantive content", () => {
  const before = pad("Gene flow between genetically modified crops and wild relatives is a studied phenomenon.", 150);
  const fused =
    "Although there is a scientific consensus that currently available food derived from GM crops poses no greater risk to human health than conventional food, GM food safety is a leading issue with critics.";
  const after = pad("Gene flow, impact on non-target organisms, and escape are the major environmental concerns.", 150);
  const text = `${before} ${fused} ${after}`;
  const res = cleanSourceDocument(text, { family: "A_wikipedia", title: "Genetically modified organism" });
  assert.equal(res.action, "unchanged");
  assert.ok(res.text.includes("GM food safety is a leading issue with critics"), "the fused, genuinely substantive clause must survive intact");
  assert.equal(res.text, text);
});

// ═══════════════════════════════════════════════════════════════════════
// GENERAL
// ═══════════════════════════════════════════════════════════════════════

test("General: a source with no matching cleaning rule remains byte-identical (unchanged)", () => {
  const text = pad("An ordinary Wikipedia article about an unrelated topic with no recognized recurring template pattern.", 300);
  const res = cleanSourceDocument(text, { family: "A_wikipedia", title: "Some Ordinary Topic" });
  assert.equal(res.action, "unchanged");
  assert.equal(res.text, text);
  assert.equal(res.rule, null);
  assert.equal(res.reason, null);
});

test("General: cleaning failure fails CLOSED to exclusion rather than silently retaining known-dirty source", () => {
  const dirtyText = pad("navbar-fixed-top sec-spacing col ctrl col with no Key facts marker at all", 300);
  const res = cleanSourceDocument(dirtyText, { family: "B_public_reports", title: "WHO fact sheet: broken-page" });
  assert.equal(res.action, "excluded");
  // the raw dirty text must never be silently returned as indexable ("cleaned"/"unchanged")
  assert.notEqual(res.action, "cleaned");
  assert.notEqual(res.action, "unchanged");
});

test("stripChromeLines: removes only exact chrome lines, preserves substantive lines untouched", () => {
  const text = "Skip to main content\nReal content line one.\nSearch\nReal content line two.\nClose";
  const out = stripChromeLines(text);
  assert.ok(!out.includes("Skip to main content"));
  assert.ok(!out.split("\n").includes("Search"));
  assert.ok(out.includes("Real content line one."));
  assert.ok(out.includes("Real content line two."));
});
