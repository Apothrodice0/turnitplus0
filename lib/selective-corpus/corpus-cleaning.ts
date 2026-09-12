/**
 * Selective Corpus deterministic source-cleaning policy (the "V4" cleaning
 * rules), productionized as a real build stage rather than a one-off offline
 * script. Every rule here was validated against the actual corpus text across
 * several rounds of promotion stress-testing before being encoded here; see
 * D:\TurnitPlusTemp\selective-corpus-clean-v4-evaluation\ for the validation
 * record (outside the repo -- this module is the reproducible production
 * encoding of that validated policy).
 *
 * Design constraints (do not violate when editing):
 *   - Deterministic: pure function of (text, family, title). No network, no
 *     randomness, no dependence on evaluation-sample document IDs.
 *   - Fail closed: a rule that cannot find its expected structural marker
 *     EXCLUDES the document rather than guessing at extraction and risking
 *     leaked chrome/CSS/template contamination.
 *   - No semantic/AI filtering, no broad "common phrase" filtering, and no
 *     matcher/scoring/retrieval logic here -- this module only decides what
 *     source TEXT the packer indexes, never how matches are scored.
 *   - No full source text is ever included in a CleaningResult -- only
 *     word counts, a rule name, and a short human-readable reason.
 */

/** A document's cleaned analyzable text must reach this floor or it is
 *  excluded rather than indexed as a near-empty/degenerate source. Shared
 *  with the packer's own pre-cleaning eligibility filter so both stages use
 *  one authoritative threshold. */
export const MIN_ANALYZABLE_WORD_COUNT = 250;

export type CleaningAction = "unchanged" | "cleaned" | "excluded";

export type CleaningResult = {
  action: CleaningAction;
  /** For "unchanged"/"cleaned": the text to index. For "excluded": the
   *  original input text (the packer must not index it, but callers that
   *  want it for other bookkeeping still have it available). */
  text: string;
  /** Which named rule fired, or null if no family/title rule matched
   *  (action is then always "unchanged"). */
  rule: string | null;
  /** Present only when action === "excluded": why. */
  reason: string | null;
  wordCountBefore: number;
  wordCountAfter: number;
};

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function unchanged(text: string): CleaningResult {
  const wc = countWords(text);
  return { action: "unchanged", text, rule: null, reason: null, wordCountBefore: wc, wordCountAfter: wc };
}

function excluded(text: string, reason: string): CleaningResult {
  return { action: "excluded", text, rule: null, reason, wordCountBefore: countWords(text), wordCountAfter: 0 };
}

function cleanedResult(originalText: string, cleanedText: string, rule: string): CleaningResult {
  const wordCountBefore = countWords(originalText);
  const wordCountAfter = countWords(cleanedText);
  if (wordCountAfter < MIN_ANALYZABLE_WORD_COUNT) {
    return { action: "excluded", text: originalText, rule, reason: `cleaned text fell below the ${MIN_ANALYZABLE_WORD_COUNT}-word minimum-analyzable-text threshold (${wordCountAfter} words)`, wordCountBefore, wordCountAfter };
  }
  return { action: "cleaned", text: cleanedText, rule, reason: null, wordCountBefore, wordCountAfter };
}

// ─────────────────────────────────────────────────────────────────────────
// Generic chrome-line blocklist -- exact-line removal only, never fuzzy or
// semantic. Every pattern was directly observed recurring verbatim across
// many documents of the SAME publisher during the promotion stress-test's
// false-attribution review.
// ─────────────────────────────────────────────────────────────────────────
const CHROME_LINE_PATTERNS: RegExp[] = [
  /^Skip navigation$/, /^Skip to main content$/, /^Skip directly to (site content|search)$/,
  /^Select language$/, /^Search( Search)*$/, /^Close$/, /^Share$/,
  /^English$/, /^العربية$/, /^中文$/, /^Fran&#231;ais$/, /^Русский$/, /^Espa&#241;ol$/, /^Français$/, /^Español$/,
];

export function stripChromeLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !CHROME_LINE_PATTERNS.some((re) => re.test(line.trim())))
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// B_public_reports structural extractors. Each returns null if its required
// marker is absent -- the caller EXCLUDES rather than guessing.
// ─────────────────────────────────────────────────────────────────────────

/** WHO fact sheets: retain only "Key facts" through (exclusive) "Related". */
function extractWhoBody(text: string): string | null {
  const startMatch = text.match(/^Key facts$/m);
  if (!startMatch || startMatch.index === undefined) return null;
  const afterStart = text.slice(startMatch.index);
  const endMatch = afterStart.match(/^Related$/m);
  const body = endMatch && endMatch.index !== undefined ? afterStart.slice(0, endMatch.index) : afterStart;
  return stripChromeLines(body).trim();
}

/** MedlinePlus / NIH-hosted MedlinePlus Genetics pages: locate the
 *  "On this page" ToC, collect its item labels, then retain only the text
 *  from the 2nd occurrence of "Summary" through the next line that repeats
 *  any collected ToC label. */
function extractMedlinePlusBody(text: string): string | null {
  const tocMatch = text.match(/^On this page$/m);
  if (!tocMatch || tocMatch.index === undefined) return null;
  const afterToc = text.slice(tocMatch.index + tocMatch[0].length);
  const lines = afterToc.split(/\r?\n/);
  const tocItems = new Set<string>();
  let sawSummaryOnce = false;
  let contentStartLineIdx = -1;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line === "Summary") {
      if (sawSummaryOnce) { contentStartLineIdx = i + 1; break; }
      sawSummaryOnce = true;
      tocItems.add(line);
      continue;
    }
    tocItems.add(line);
  }
  if (contentStartLineIdx === -1) return null;
  let contentEndLineIdx = lines.length;
  for (let j = contentStartLineIdx; j < lines.length; j++) {
    const line = lines[j].trim();
    if (line && tocItems.has(line)) { contentEndLineIdx = j; break; }
  }
  const body = lines.slice(contentStartLineIdx, contentEndLineIdx).join("\n");
  if (body.trim().length < 50) return null;
  return stripChromeLines(body).trim();
}

/** CDC pages: strip everything through the fixed gov-disclaimer paragraph;
 *  optional footer cut at a trailing HHS.gov/USA.gov block or a
 *  "Sources and Page Info" marker. */
function extractCdcBody(text: string): string | null {
  const marker = "official, secure websites.";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  let body = text.slice(idx + marker.length);
  const footerMatch = body.match(/\n\s*HHS\.gov\s*\n\s*USA\.gov\s*$/);
  if (footerMatch && footerMatch.index !== undefined) body = body.slice(0, footerMatch.index);
  const sourcesMatch = body.match(/^Sources and Page Info$/m);
  if (sourcesMatch && sourcesMatch.index !== undefined) body = body.slice(0, sourcesMatch.index);
  return body.trim();
}

/** OpenStax textbook pages: cut everything from the "Citation/Attribution"
 *  footer marker onward, and strip a repeated top-of-page nav/title line if
 *  present. */
function extractOpenStaxBody(text: string): string | null {
  const marker = text.match(/^Citation\/Attribution$/m);
  if (!marker || marker.index === undefined) return null;
  let body = text.slice(0, marker.index);
  body = body.replace(/^.*Skip to Content Go to accessibility page Keyboard shortcuts menu\s*\n/, "");
  return stripChromeLines(body).trim();
}

// ─────────────────────────────────────────────────────────────────────────
// A_wikipedia exact-template strips.
// ─────────────────────────────────────────────────────────────────────────

/** Dash-class covering every Unicode dash variant observed (hyphen, en dash,
 *  em dash U+2014, horizontal bar) between "climate change" and "during". */
const DASH_CLASS = "[\\u2010-\\u2015-]";

/** The real corpus contains TWO coexisting wordings of this template across
 *  different years: most years (2019-2024) say "documents events...", while
 *  others (2025-2026) say "documents notable events...". The old broken
 *  production rule REQUIRED "notable" -- which is exactly why it silently
 *  never matched the far more common "events"-only wording and that
 *  template was never actually removed for 2019-2024. The fix is not to
 *  swap which single wording is required (that would just move the bug to
 *  the other year range) but to make "notable" OPTIONAL, so both real
 *  wordings are matched by the one rule -- confirmed against the actual
 *  bulk source text for every affected year via an exact source-level
 *  comparison to the validated corpus, not assumed. */
const CLIMATE_SERIES_INTRO = new RegExp(
  `This article documents (?:notable )?events, research findings, scientific and technological advances, ` +
    `and human actions to measure, predict, mitigate, and adapt to the effects of global warming ` +
    `and climate change${DASH_CLASS}during the year \\d{4}\\.\\s*`,
  "i",
);

const ACCESS_TO_INFO_INTRO =
  /Access to public information and freedom of information \(FOI\) refer to the right of access to information held by public bodies also known as [“"]right to know[”"]\. Access to public information is considered of fundamental importance for the effective functioning of democratic systems, as it enhances governments[’']? and public officials[’']? accountability, boosting people participation and allowing their informed participation into public life\. The fundamental premise of the right of access to public information is that the information held by governmental institutions is in principle public and may be concealed only on the basis of legitimate reasons which should be detailed in the law\.\s*/i;

/** CORRECTED wording: only the STANDALONE 2-sentence disclaimer form is
 *  removed ("much" and the trailing legal/regulatory sentence are both
 *  optional, matching the real corpus wording variants observed). A second,
 *  DIFFERENT wording exists where the same core clause is grammatically
 *  fused as a subordinate clause to distinct substantive content
 *  ("Although there is a scientific consensus that ..., GM food safety is a
 *  leading issue with critics."). That fused form is intentionally NOT
 *  matched here: removing only the clause leaves a grammatically broken
 *  orphaned fragment, and removing the whole sentence would delete real,
 *  non-boilerplate content. Validation proved that residual is structurally
 *  inert under the current 60-word STRICT_SPAN admission threshold (it
 *  cannot reach 60 matched words on its own, and cleaning the OTHER
 *  occurrence means no second document exists for it to match against) --
 *  it is accepted as-is, not force-cleaned.
 *
 *  Split into two patterns with DIFFERENT trailing-whitespace handling,
 *  each matching the real corpus text exactly (confirmed via exact
 *  source-level comparison against the validated corpus): every real
 *  occurrence that includes the trailing "legal and regulatory status..."
 *  sentence is followed by \s? (at most one trailing whitespace char);
 *  every occurrence WITHOUT that trailing sentence is followed by \s*
 *  (all trailing whitespace up to the next paragraph). This is a
 *  structural distinction based on which literal wording variant matched
 *  -- not a per-document special case. */
const GM_FOOD_STANDALONE_DISCLAIMER_WITH_TRAILING_SENTENCE =
  /There is a scientific consensus that currently available food derived from GM crops poses no greater risk to human health than conventional food, but that each GM food needs to be tested on a case-by-case basis before introduction\.\s*Nonetheless, members of the public are (?:much )?less likely than scientists to perceive GM foods as safe\.\s*The legal and regulatory status of GM foods varies by country[^.]*\.\s?/gi;
const GM_FOOD_STANDALONE_DISCLAIMER_WITHOUT_TRAILING_SENTENCE =
  /There is a scientific consensus that currently available food derived from GM crops poses no greater risk to human health than conventional food, but that each GM food needs to be tested on a case-by-case basis before introduction\.\s*Nonetheless, members of the public are (?:much )?less likely than scientists to perceive GM foods as safe\.\s*/gi;

function stripClimateYearSeriesIntro(text: string, title: string): { changed: boolean; text: string } {
  if (!/^\d{4} in climate change$/.test(title)) return { changed: false, text };
  if (!CLIMATE_SERIES_INTRO.test(text)) return { changed: false, text };
  return { changed: true, text: text.replace(CLIMATE_SERIES_INTRO, "") };
}

function stripAccessToInfoIntro(text: string, title: string): { changed: boolean; text: string } {
  if (!/^Access to public information in /.test(title)) return { changed: false, text };
  if (!ACCESS_TO_INFO_INTRO.test(text)) return { changed: false, text };
  return { changed: true, text: text.replace(ACCESS_TO_INFO_INTRO, "") };
}

function stripGmFoodStandaloneDisclaimer(text: string): { changed: boolean; text: string } {
  // Apply the more specific (longer) WITH-trailing-sentence pattern first,
  // then the WITHOUT-sentence pattern on the result -- independently, so a
  // document containing both wording variants (not observed in practice,
  // but not structurally impossible) has each handled correctly rather
  // than only the first found.
  let out = text;
  let changed = false;

  GM_FOOD_STANDALONE_DISCLAIMER_WITH_TRAILING_SENTENCE.lastIndex = 0;
  if (GM_FOOD_STANDALONE_DISCLAIMER_WITH_TRAILING_SENTENCE.test(out)) {
    GM_FOOD_STANDALONE_DISCLAIMER_WITH_TRAILING_SENTENCE.lastIndex = 0;
    out = out.replace(GM_FOOD_STANDALONE_DISCLAIMER_WITH_TRAILING_SENTENCE, "");
    changed = true;
  }

  GM_FOOD_STANDALONE_DISCLAIMER_WITHOUT_TRAILING_SENTENCE.lastIndex = 0;
  if (GM_FOOD_STANDALONE_DISCLAIMER_WITHOUT_TRAILING_SENTENCE.test(out)) {
    GM_FOOD_STANDALONE_DISCLAIMER_WITHOUT_TRAILING_SENTENCE.lastIndex = 0;
    out = out.replace(GM_FOOD_STANDALONE_DISCLAIMER_WITHOUT_TRAILING_SENTENCE, "");
    changed = true;
  }

  return { changed, text: out };
}

// ─────────────────────────────────────────────────────────────────────────
// Per-family dispatch
// ─────────────────────────────────────────────────────────────────────────

function cleanPublicReport(text: string, title: string): CleaningResult {
  if (/^WHO fact sheet/.test(title)) {
    const body = extractWhoBody(text);
    if (body === null) return excluded(text, "WHO: 'Key facts' structural marker not found -- cannot separate content confidently");
    return cleanedResult(text, body, "WHO structural header/footer cut (Key facts .. Related)");
  }
  if (/^MedlinePlus/.test(title) || /^nih-/.test(title)) {
    const pub = /^nih-/.test(title) ? "NIH (MedlinePlus Genetics template)" : "MedlinePlus";
    const body = extractMedlinePlusBody(text);
    if (body === null) return excluded(text, `${pub}: On-this-page/Summary ToC marker pattern not found -- cannot separate content confidently`);
    return cleanedResult(text, body, `${pub} structural cut (On this page -> 2nd Summary -> next ToC item)`);
  }
  if (/^cdc-/.test(title)) {
    const body = extractCdcBody(text);
    if (body === null) return excluded(text, "CDC: gov-disclaimer marker not found -- cannot separate content confidently");
    return cleanedResult(text, stripChromeLines(body), "CDC structural header cut (gov disclaimer paragraph) + optional footer cut");
  }
  if (/^wb-/.test(title)) {
    return excluded(text, "World Bank: contamination (raw CSS/template class strings interleaved with data-table fragments) occurs throughout the document body, not confined to a separable header/footer block -- excluded rather than guessing at extraction");
  }
  if (/^(un|fao|unesco|ipcc)-/.test(title)) {
    const publisher = title.split("-")[0].toUpperCase();
    return cleanedResult(text, stripChromeLines(text), `${publisher} light generic chrome-line strip`);
  }
  return unchanged(text);
}

function cleanFoundational(text: string, title: string): CleaningResult {
  if (/^https:\/\/openstax\.org\//.test(title)) {
    const body = extractOpenStaxBody(text);
    if (body === null) return excluded(text, "OpenStax: 'Citation/Attribution' marker not found -- cannot separate content confidently");
    return cleanedResult(text, body, "OpenStax structural footer cut (Citation/Attribution marker) + header strip");
  }
  return unchanged(text);
}

function cleanWikipedia(text: string, title: string): CleaningResult {
  let out = text;
  let rule: string | null = null;

  const climate = stripClimateYearSeriesIntro(out, title);
  if (climate.changed) { out = climate.text; rule = "Wikipedia climate-year-series shared-intro strip"; }

  const access = stripAccessToInfoIntro(out, title);
  if (access.changed) { out = access.text; rule = rule ? `${rule} + Wikipedia access-to-info country-series shared-intro strip` : "Wikipedia access-to-info country-series shared-intro strip"; }

  const gmFood = stripGmFoodStandaloneDisclaimer(out);
  if (gmFood.changed) { out = gmFood.text; rule = rule ? `${rule} + Wikipedia GM-food standalone-disclaimer strip` : "Wikipedia GM-food standalone-disclaimer strip"; }

  if (rule === null) return unchanged(text);
  return cleanedResult(text, out, rule);
}

/**
 * The single production entry point. Pure function of (text, family, title).
 * Never touches the filesystem, never depends on document/evaluation IDs.
 */
export function cleanSourceDocument(text: string, meta: { family: string; title?: string }): CleaningResult {
  const title = meta.title ?? "";
  switch (meta.family) {
    case "B_public_reports":
      return cleanPublicReport(text, title);
    case "F_foundational":
      return cleanFoundational(text, title);
    case "A_wikipedia":
      return cleanWikipedia(text, title);
    default:
      return unchanged(text);
  }
}
