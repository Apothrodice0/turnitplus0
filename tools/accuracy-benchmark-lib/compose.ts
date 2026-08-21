// Accuracy & Coverage Benchmark — composes controlled test submissions with
// known ground truth: a precise copied-word-count span from a real source
// paper, embedded in freshly-authored filler text that is never copied from
// any real, independently-discoverable source (so it can never itself be
// matched — the ONLY real content in a composed case is the deliberate
// copied span, keeping ground truth unambiguous).
import { tokens } from "../../lib/similarity-core";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Discovery-loss investigation follow-up (2026-08-21): a repository-hosted
 * source paper's own fetched fullText often opens with several paragraphs of
 * deposit/front-matter boilerplate that reprint the paper's own title
 * verbatim (a deposit heading, then again in a "to cite this version" line)
 * BEFORE any of the paper's own genuine prose begins — confirmed live on a
 * real HAL-hosted paper (soc-openaire, DOI 10.1057/s41253-026-00314-w): the
 * "fewSentences" condition below, which is supposed to probe whether a
 * SMALL amount of genuinely copied prose is still discoverable, was instead
 * grabbing 4 sentences of pure HAL banner (deposit id/URL, an English then a
 * duplicate French administrative paragraph, a license line) — zero
 * scholarly content, not a realistic stand-in for "a user copied a few
 * sentences of the actual paper." No real user submission looks like this
 * (nobody copies only a repository's own deposit banner into their own
 * work), so this is a test-fixture construction defect, not a production
 * discovery-pipeline defect — confirmed by running the actual generated
 * queries against live OpenAIRE: none of them found the target, while the
 * one genuinely distinctive word available in that banner span ("infoxicated")
 * found it immediately on its own, proving the pipeline's query generation
 * and provider integration are not at fault; the copied span itself simply
 * carried almost no real content to work with.
 *
 * Skips past any such repeated front matter using data every caller already
 * has (the paper's own confirmed title, from the provider that sourced it)
 * rather than any paper-specific string or content-sniffing heuristic:
 * finds the LAST place, within a generous front-matter window, where the
 * first several words of the title appear in sequence (case/punctuation-
 * insensitive, so it survives curly-vs-straight quotes and PDF line-wrap
 * hyphenation), and starts sentence-splitting just after it — landing past
 * every reprint, on the paper's own byline/abstract/body.
 *
 * Requires at least TWO matches, not just one — a plain PDF/DOCX that opens
 * directly with its own title, stated once, is the common case, and finding
 * that single ordinary title line is not evidence of a repeated front-matter
 * banner (confirmed by a regression test below: a one-off match must never
 * be skipped, or this would strip a completely normal document's own title
 * sentence instead of only genuine repository preambles). Only a second
 * occurrence proves the pattern this fix targets — a repository reprinting
 * the title again in a deposit heading or "to cite this version" line before
 * its own body content begins — so a document with no such repetition is
 * always returned completely unchanged.
 */
function skipRepeatedFrontMatter(sourceText: string, title: string | null | undefined): string {
  if (!title) return sourceText;
  const titleWords = tokens(title).slice(0, 6);
  if (titleWords.length < 3) return sourceText;

  const pattern = titleWords.map(escapeRegExp).join("[\\s\\W]+");
  const regex = new RegExp(pattern, "gi");
  const frontMatterWindow = sourceText.slice(0, 3000);

  let matchCount = 0;
  let lastMatchEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(frontMatterWindow)) !== null) {
    matchCount += 1;
    lastMatchEnd = match.index + match[0].length;
  }
  return matchCount < 2 ? sourceText : sourceText.slice(lastMatchEnd);
}

export type CopyCondition = "exact" | "fifty" | "twentyfive" | "ten" | "fewSentences" | "original";

export const COPY_CONDITION_PROPORTION: Record<Exclude<CopyCondition, "exact" | "fewSentences" | "original">, number> = {
  fifty: 0.5,
  twentyfive: 0.25,
  ten: 0.1,
};

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9"'])/;

export function splitSentences(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.split(SENTENCE_SPLIT_RE))
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length > 0);
}

export function wordCount(text: string): number {
  return tokens(text).length;
}

/** Accumulates whole sentences (never a mid-sentence cut) until reaching >= targetWords, measured with the same tokenizer the production pipeline itself uses. */
function takeSentencesForWordCount(sentences: string[], startIndex: number, targetWords: number) {
  let text = "";
  let count = 0;
  let index = startIndex;
  while (index < sentences.length && count < targetWords) {
    text = text ? `${text} ${sentences[index]}` : sentences[index];
    count = wordCount(text);
    index += 1;
  }
  return { text, actualWords: count, endIndex: index };
}

// ---------------------------------------------------------------------------
// Filler banks — one per domain, freshly authored, generic academic-register
// prose. Deliberately not about any specific real finding/dataset/citation,
// so it can never coincidentally match a real indexed source. Cycled to
// reach arbitrary target lengths (short/medium/long).
// ---------------------------------------------------------------------------

export const FILLER_BANKS: Record<string, string[]> = {
  "Computer Science / AI / ML": [
    "This section considers how a candidate design decision was evaluated against the alternatives that were available at the time. The evaluation process weighed implementation cost, maintainability, and the expected effect on downstream users before any conclusion was reached.",
    "A recurring challenge in this area of practice is balancing throughput against latency under realistic operating conditions. Teams that optimize narrowly for one dimension often find that the other degrades in ways that are difficult to notice until a system is under sustained load.",
    "Several supporting utilities were assembled to make the workflow reproducible across environments. Version pinning, deterministic seeding, and a shared configuration format each played a role in reducing the number of surprises encountered when moving between a development machine and a production deployment.",
    "The reviewers noted that documentation quality varied considerably across the modules under discussion, and that this variability tended to correlate with how recently a given module had last been substantially revised by its maintainers.",
    "Instrumentation was added at each stage of the pipeline so that a failure could be localized quickly rather than requiring a broad, manual investigation across every component. This proved useful during the period immediately following the initial rollout.",
    "A working group was convened to discuss naming conventions, and after some deliberation a convention was adopted that favored explicitness over brevity, on the reasoning that a slightly longer identifier is easier to search for later than a short one that could mean several things.",
    "The system's default configuration was chosen to be conservative, on the assumption that most operators would rather tune a setting upward deliberately than discover, after the fact, that a more aggressive default had caused an unexpected outcome.",
    "Feedback from early adopters shaped several of the interface decisions described here, particularly around how errors were surfaced and how much context was included alongside a given warning message.",
    "The overall approach favored incremental delivery: each milestone was scoped narrowly enough to be verified on its own, which made it straightforward to identify which change was responsible when a regression was later observed.",
    "A short retrospective was held once the initial phase concluded, and the resulting notes were used to adjust the plan for the following phase rather than being filed away and forgotten.",
  ],
  "Medicine / Biomedical": [
    "Clinical practice in this setting has historically relied on a combination of observational reporting and periodically updated guidelines, with the balance between the two shifting as new evidence has accumulated over successive review cycles.",
    "Patient-reported outcomes were collected through a standard questionnaire administered at intervals agreed upon in advance, and the resulting responses were reviewed by staff who had not been involved in the initial recruitment process.",
    "A number of practical constraints shaped how the broader program was implemented in this setting, including staffing availability, the physical layout of the facility, and the scheduling preferences expressed by participants during an earlier consultation period.",
    "Adverse events, where they occurred, were logged promptly and reviewed by an independent committee before any determination was made about whether a given event was related to the intervention under discussion.",
    "Follow-up communication with participants was maintained through a combination of scheduled visits and periodic check-ins, with the frequency of each adjusted based on individual circumstances rather than applied uniformly.",
    "Training materials for staff were revised twice during the period covered by this account, each revision reflecting feedback gathered from the staff members who used the materials most directly in day-to-day work.",
    "Consent procedures followed the applicable institutional requirements, and every participant was given the opportunity to ask questions before any decision was finalized, with additional time made available upon request.",
    "Resource allocation across the different components of the program was reviewed on a quarterly basis, allowing adjustments to be made without waiting for a full annual review cycle to conclude.",
    "Coordination between the different teams involved required regular meetings, and a shared record-keeping system was adopted partway through in order to reduce the amount of duplicated effort across teams.",
    "A brief summary of lessons learned was circulated at the close of the reporting period, intended primarily to inform planning for any similar effort undertaken subsequently.",
  ],
  "Social Sciences": [
    "Survey respondents were drawn from a broad range of backgrounds, and the resulting sample was weighted during analysis to better reflect the composition of the wider population under consideration.",
    "Interviews were conducted in a semi-structured format, allowing a consistent set of core questions while still leaving room for a participant to raise topics that had not been anticipated in advance.",
    "Coding of the qualitative material proceeded in two passes: an initial open coding stage followed by a second stage in which related codes were grouped into broader thematic categories.",
    "Attitudes expressed by participants varied considerably depending on prior exposure to the topic under discussion, a pattern that was noted repeatedly across the different subgroups examined.",
    "Fieldwork logistics required coordination with several local contacts, whose assistance in scheduling and translation was acknowledged as an important factor in the overall feasibility of the effort.",
    "A pilot round preceded the main data collection effort, and the instrument was revised in several small ways based on what was learned during that earlier round.",
    "Confidentiality was maintained throughout by removing identifying details from the transcripts before they were shared with anyone beyond the immediate research team.",
    "Discussion of the findings was organized around the themes that emerged most consistently across the different data sources, rather than being structured strictly around the original research questions.",
    "Limitations of the approach were acknowledged openly, including the possibility that participants who agreed to take part differed in relevant ways from those who declined.",
    "The broader implications of the patterns observed here are discussed with appropriate caution, given the scope of the sample and the specific context in which the material was gathered.",
  ],
  "Business / Marketing": [
    "Market conditions during the period under review were characterized by shifting consumer preferences, which required the team to revisit its assumptions about demand more frequently than in prior periods.",
    "Internal reporting on the initiative was consolidated into a single dashboard so that stakeholders across departments could review the same figures rather than reconciling separate spreadsheets.",
    "Customer feedback was gathered through a combination of surveys and direct outreach, and the resulting themes were shared with the product and support teams on a recurring basis.",
    "Budget allocation across the different channels involved was reviewed midway through the period and adjusted in response to early performance indicators rather than left unchanged until the end.",
    "Competitive positioning was assessed through a review of publicly available materials, supplemented by informal conversations with contacts familiar with the relevant segment of the market.",
    "Staff turnover in the relevant team was modest during the period, which helped preserve institutional knowledge that might otherwise have been lost during a transition.",
    "A revised pricing structure was piloted in a limited number of markets before any decision was made about whether to extend it more broadly.",
    "Vendor relationships were reviewed as part of a broader cost assessment, with particular attention paid to contract terms that had not been revisited in some time.",
    "Internal communication about the initiative emphasized the reasoning behind each decision, on the view that this would make the eventual rollout easier for affected teams to accept.",
    "A brief post-mortem was conducted once the initiative concluded, focusing on what had gone according to plan and what had required an unplanned adjustment along the way.",
  ],
  "Engineering": [
    "Structural components were inspected according to a schedule agreed upon with the relevant regulatory body, with each inspection documented and filed for future reference.",
    "Material selection for the project balanced cost against expected service life, taking into account the specific environmental conditions the components would be exposed to over time.",
    "Load calculations were reviewed independently by a second engineer before the design was finalized, a step intended to catch errors that a single reviewer might overlook.",
    "Field testing was not applicable here; instead, site visits were conducted at key milestones to confirm that installed conditions matched what had been specified in the design documents.",
    "Maintenance procedures were documented in sufficient detail that staff unfamiliar with the specific installation could still carry out a routine check without additional supervision.",
    "Safety margins applied throughout the design were consistent with the relevant published standards, with additional margin applied in areas where operating conditions were judged less predictable.",
    "Coordination with other trades on site required careful sequencing, and a shared schedule was maintained to reduce the likelihood of conflicting work occurring in the same area at the same time.",
    "Instrumentation installed as part of the project allowed ongoing monitoring of key parameters, with alerts configured to notify staff if a reading fell outside the expected range.",
    "Cost overruns during the project were tracked against the original estimate, and the reasons for any significant deviation were documented for use in future planning.",
    "A closeout review was conducted once the project was substantially complete, summarizing what had worked well and what would be handled differently on a similar future project.",
  ],
  "Humanities": [
    "The archival material consulted for this account was held across several collections, and access to some items required advance arrangement with the relevant institution.",
    "Translation choices made throughout this discussion favored readability over strict literalness, with the original wording noted separately wherever the distinction seemed likely to matter.",
    "Provenance of the material under discussion was established through a combination of documentary evidence and physical examination, with any point of uncertainty noted explicitly rather than resolved by assumption.",
    "Earlier commentary on this subject has tended to emphasize certain aspects of the material at the expense of others, a pattern this discussion attempts to address without dismissing the earlier commentary outright.",
    "Contextual background is provided at some length here, on the view that the material under discussion is difficult to interpret responsibly without a reasonably full account of the circumstances surrounding it.",
    "Dating of the material relied on a combination of internal evidence and comparison with related items whose dates are better established, and the resulting estimate should be read as approximate.",
    "Curatorial decisions about how the material is presented reflect a balance between preserving the original arrangement and making the material accessible to a contemporary audience.",
    "Several minor discrepancies between different copies of the material are noted where they occur, though none were judged significant enough to affect the overall interpretation offered here.",
    "The broader cultural context in which this material was produced is discussed briefly, primarily to situate the specific items under discussion rather than to offer a comprehensive account of that context.",
    "Closing remarks return to the questions raised at the outset, with an acknowledgment that several of them remain open and would benefit from further investigation beyond the scope of this account.",
  ],
};

export function fillerText(domain: string, targetWords: number, startParagraph = 0): string {
  const bank = FILLER_BANKS[domain];
  if (!bank || bank.length === 0) throw new Error(`No filler bank registered for domain: ${domain}`);
  if (targetWords <= 0) return "";
  const paragraphs: string[] = [];
  let count = 0;
  let index = startParagraph;
  while (count < targetWords) {
    const paragraph = bank[index % bank.length];
    paragraphs.push(paragraph);
    count += wordCount(paragraph);
    index += 1;
  }
  return paragraphs.join("\n\n");
}

export type ComposedCase = {
  text: string;
  totalWordCount: number;
  copiedWordCount: number;
  copiedProportion: number;
  trueCopiedWordStart: number;
  trueCopiedWordEnd: number;
};

export type ComposeCaseParams = {
  sourceText: string;
  domain: string;
  condition: CopyCondition;
  /** Ignored for "exact" (uses the source's own natural length). */
  targetTotalWords: number;
  fillerSeed: number;
  /** Optional: the source paper's own confirmed title, used only by the "fewSentences" condition to skip past repeated repository front matter — see skipRepeatedFrontMatter's own comment. Every other condition is unaffected by this field. */
  sourceTitle?: string | null;
};

const FEW_SENTENCES_COUNT = 4;
/** Fraction of the target total placed as filler BEFORE the copied span, so matched-position reporting can be checked against a known non-zero true offset rather than always starting at position 0. */
const FILLER_BEFORE_FRACTION = 0.12;

export function composeCase(params: ComposeCaseParams): ComposedCase {
  const { sourceText, domain, condition, targetTotalWords, fillerSeed, sourceTitle } = params;

  if (condition === "exact") {
    const text = sourceText.trim();
    const total = wordCount(text);
    return { text, totalWordCount: total, copiedWordCount: total, copiedProportion: 1, trueCopiedWordStart: 0, trueCopiedWordEnd: Math.max(0, total - 1) };
  }

  if (condition === "original") {
    const text = fillerText(domain, targetTotalWords, fillerSeed);
    const total = wordCount(text);
    return { text, totalWordCount: total, copiedWordCount: 0, copiedProportion: 0, trueCopiedWordStart: -1, trueCopiedWordEnd: -1 };
  }

  // "fewSentences" copies a FIXED sentence count (not a word-count target) —
  // it exists to probe the minimum-detectable-copy floor, independent of
  // the target document's overall length. It sources from PAST any repeated
  // repository front matter (see skipRepeatedFrontMatter) so the "few
  // sentences" are a realistic stand-in for genuine copied prose rather
  // than a repository's own deposit banner; every other condition sources
  // from the untouched sourceText exactly as before.
  const sentences = condition === "fewSentences"
    ? splitSentences(skipRepeatedFrontMatter(sourceText, sourceTitle))
    : splitSentences(sourceText);

  const copied = condition === "fewSentences"
    ? (() => {
      const text = sentences.slice(0, FEW_SENTENCES_COUNT).join(" ");
      return { text, actualWords: wordCount(text) };
    })()
    : takeSentencesForWordCount(sentences, 0, Math.round(COPY_CONDITION_PROPORTION[condition] * targetTotalWords));

  const fillerBeforeWords = Math.max(0, Math.round(targetTotalWords * FILLER_BEFORE_FRACTION));
  const fillerAfterWords = Math.max(0, targetTotalWords - copied.actualWords - fillerBeforeWords);

  const fillerBefore = fillerText(domain, fillerBeforeWords, fillerSeed);
  const fillerAfter = fillerText(domain, fillerAfterWords, fillerSeed + 5);

  const trueCopiedWordStart = wordCount(fillerBefore);
  const trueCopiedWordEnd = trueCopiedWordStart + copied.actualWords - 1;

  const parts = [fillerBefore, copied.text, fillerAfter].filter((part) => part.length > 0);
  const text = parts.join("\n\n");
  const totalWordCount = wordCount(text);

  return {
    text,
    totalWordCount,
    copiedWordCount: copied.actualWords,
    copiedProportion: copied.actualWords / Math.max(1, totalWordCount),
    trueCopiedWordStart,
    trueCopiedWordEnd,
  };
}
