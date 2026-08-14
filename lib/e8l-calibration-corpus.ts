import { canonicalizeText } from "./canonical-text";
import {
  E8J_BASE_DOCUMENT, E8J_FIXTURES,
} from "./e8k-calibration-fixtures";
import {
  HIST_DISTINCTIVE_DOCUMENT, HIST_GENERIC_DOCUMENT, SEVERAL_MEDIUM_DISTINCTIVE_OVERLAPS, GENERIC_100, GENERIC_200, GENERIC_300,
} from "./e8k-calibration-fixtures";

/**
 * Phase E8L: a substantially larger (100-300 document) synthetic
 * calibration corpus for redesigning the passage-distinctiveness signal.
 * Deterministic (seeded PRNG, not Math.random) so every run reproduces the
 * exact same corpus and fixtures. No DB, no I/O, no real content — every
 * generic sentence and every invented entity/measurement here was written
 * or generated for this phase.
 *
 * Two distinct roles, deliberately kept separate:
 *   - buildBackgroundCorpus(): the "world" — ~115 documents whose only job
 *     is to give corpus-frequency features (lib/e8l-distinctiveness-v2.ts)
 *     something real to count against. Built with seeds in the 1000-9999
 *     range.
 *   - buildQueryFixtures(): the labeled test cases actually evaluated
 *     against that world. Built with seeds in the 50000+ range so no query
 *     fixture is ever byte-identical to a background corpus document by
 *     construction accident.
 */

// --- deterministic PRNG (mulberry32) -----------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}
function pickN<T>(arr: readonly T[], n: number, rng: () => number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i += 1) {
    const idx = Math.floor(rng() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}
function randomInt(min: number, max: number, rng: () => number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// --- GENERIC sentence bank: 8 subcategories x 10 sentences = 80 sentences ----
// academicBoilerplate is deliberately the same 10 sentences as E8K's
// GENERIC_BOILERPLATE_POOL (not paraphrased) so E8K's existing
// GENERIC_100/200/300 fixtures share real, non-trivial corpus frequency
// with this larger corpus — continuity, not coincidence.

export const GENERIC_SENTENCE_BANK = {
  academicBoilerplate: [
    "This section provides a general overview of the material discussed throughout the remainder of the document.",
    "The analysis presented below is intended to summarize the principal findings arising from the review process.",
    "Readers should note that the discussion that follows reflects a broad synthesis of the available information rather than an exhaustive treatment of every possible consideration.",
    "The purpose of the following discussion is to place the results within their appropriate broader context.",
    "It should further be noted that the conclusions offered here are necessarily provisional pending additional review.",
    "The material presented in this section is organized to proceed from general observations toward more specific points of interest.",
    "Taken together, the observations summarized above provide a reasonable basis for the recommendations that follow.",
    "The present discussion does not attempt to resolve every open question raised during the course of the review.",
    "In general terms, the findings described here are consistent with expectations formed prior to the start of the review process.",
    "The following paragraphs summarize the key considerations that informed the approach adopted throughout this document.",
  ],
  methodology: [
    "Data were collected using a standard survey instrument administered to all participants under comparable conditions.",
    "The sample was selected using a random sampling procedure intended to minimize selection bias across the population studied.",
    "All measurements were taken using calibrated instruments following the manufacturer's recommended procedure.",
    "Statistical analysis was performed using standard methods appropriate to the type of data collected.",
    "Participants were assigned to condition using a randomized allocation procedure determined in advance.",
    "The study design followed established best practices for research of this general type.",
    "Data quality was verified through a standard review process prior to analysis.",
    "The methodology employed here is consistent with approaches commonly used in comparable studies.",
    "Every effort was made to control for confounding variables during the design phase.",
    "The procedure was piloted on a small sample before being applied to the full study population.",
  ],
  introduction: [
    "This paper examines an important question that has received considerable attention in recent years.",
    "The purpose of this research is to investigate a topic of ongoing interest within the field.",
    "This study builds on a substantial body of prior work addressing related questions.",
    "The following sections present a detailed examination of the topic under consideration.",
    "This introduction provides the necessary background for understanding the analysis that follows.",
    "The research described here addresses a gap identified in the existing literature.",
    "This work contributes to a growing area of interest among researchers in the field.",
    "The remainder of this paper is organized as follows.",
    "This section outlines the motivation and scope of the present study.",
    "The following discussion situates the present work within its broader research context.",
  ],
  conclusion: [
    "In conclusion, this paper has shown that further research in this area is warranted.",
    "The results of this study indicate that additional investigation would be valuable.",
    "Overall, the findings presented here are broadly consistent with prior expectations.",
    "These findings should be interpreted with appropriate caution given the scope of the study.",
    "Future work should aim to address the limitations identified in this discussion.",
    "The present study contributes a modest but meaningful addition to the existing literature.",
    "Taken as a whole, the results support the general conclusions outlined above.",
    "This paper concludes with a discussion of directions for future research.",
    "The implications of these findings are discussed in greater detail below.",
    "In summary, the evidence presented here is consistent with the stated hypothesis.",
  ],
  assignmentTemplates: [
    "This assignment requires students to critically evaluate the material covered in class.",
    "Students are expected to submit their completed work by the stated deadline.",
    "This report was prepared in partial fulfillment of the course requirements.",
    "The following analysis was completed as part of a coursework assignment.",
    "This paper was written to satisfy the requirements of the assigned coursework.",
    "Students should reference all sources used in preparing this assignment.",
    "This submission represents the student's own original analysis of the assigned topic.",
    "The assignment was completed individually in accordance with course guidelines.",
    "This document fulfills the written component of the course assessment.",
    "The following work addresses each of the questions outlined in the assignment prompt.",
  ],
  legalAdministrative: [
    "This document is provided for informational purposes only and does not constitute legal advice.",
    "All rights reserved; no part of this document may be reproduced without permission.",
    "The information contained herein is subject to change without prior notice.",
    "This agreement is governed by the laws of the applicable jurisdiction.",
    "Any disputes arising from this document shall be resolved through the standard grievance procedure.",
    "The undersigned acknowledges having read and understood the terms described above.",
    "This policy applies to all parties operating under the terms of the agreement.",
    "Failure to comply with these terms may result in termination of the agreement.",
    "This document supersedes all prior versions and communications on the subject.",
    "The parties agree to the terms and conditions set forth in this document.",
  ],
  bibliographyPatterns: [
    "Smith and Jones argue that further consideration of this question is warranted.",
    "As noted by previous researchers, this topic has been examined from multiple perspectives.",
    "Several studies have reported findings broadly consistent with those described here.",
    "Prior work in this area has established a general framework for analysis.",
    "This finding is consistent with results reported in related studies.",
    "A number of researchers have previously investigated related aspects of this question.",
    "The present findings extend earlier work addressing similar research questions.",
    "This approach draws on methods established in earlier studies of this kind.",
    "Related research has explored comparable questions using similar methods.",
    "These results align with the broader pattern reported in the existing literature.",
  ],
  standardDefinitions: [
    "For the purposes of this document, the term is defined as described below.",
    "This concept refers generally to the phenomenon under discussion throughout this work.",
    "The definition adopted here follows standard usage within the field.",
    "As used in this document, the term carries its conventional meaning unless otherwise noted.",
    "This term is used consistently throughout the document to refer to the concept described.",
    "The following definitions apply throughout the remainder of this document.",
    "For clarity, key terms used in this document are defined in the section below.",
    "This section establishes the terminology used consistently throughout the analysis.",
    "The term is used here in its most general and widely accepted sense.",
    "Terminology used in this document follows conventions standard within the discipline.",
  ],
} as const;

const ALL_GENERIC_SENTENCES: string[] = Object.values(GENERIC_SENTENCE_BANK).flat();

// --- DISTINCTIVE entity/template bank -----------------------------------------

const INVENTED_ORGANIZATIONS = [
  "Meridian Analytics", "Solstice Retail Group", "Kestrel Deep Research Consortium", "Thornfield Instruments",
  "Cascadia Biotech", "Northbridge Materials Lab", "Aurelia Systems", "Halcyon Fabrication Works",
  "Pemberton Dynamics", "Ashgrove Environmental Institute", "Fernhollow Civic Trust", "Blackwater Geoscience Group",
];
const INVENTED_PERSON_NAMES = [
  "Elena Vasquez", "Dr. Marcus Okonkwo", "Priya Ramanathan", "Tobias Lindqvist",
  "Amara Osei", "Felix Bergstrom", "Nadia Kowalski", "Hiroshi Tanaka-Reyes",
];
const INVENTED_TERMS = [
  "the Amberline vent field", "the red-spectrum fulfillment index", "Protocol Kestrel-7",
  "the Halcyon-9 alloy specification", "the Pemberton coefficient", "Compound TX-441",
  "the Northbridge tensile threshold", "the Fernhollow buffer amendment",
];
const MEASUREMENT_UNITS = ["millikelvins", "kilopascals", "nanograms per liter", "megajoules", "microsiemens", "parts per billion", "newton-meters", "hertz"];

const DISTINCTIVE_TEMPLATES = [
  "{ORG} reported that {TERM} exceeded expectations by {MEASUREMENT} during the trial period overseen by {PERSON}.",
  "{PERSON}, working with {ORG}, identified an unusual reading of {MEASUREMENT} associated with {TERM}.",
  "The engineering team at {ORG} traced the anomaly in {TERM} to a configuration issue first flagged by {PERSON}.",
  "{TERM} was measured at {MEASUREMENT} across all sites monitored by {ORG} during the review period.",
  "According to {PERSON}'s internal report, {ORG} plans to expand testing of {TERM} to additional sites next year.",
  "The discrepancy of {MEASUREMENT} observed in {TERM} prompted {ORG} to commission an independent review led by {PERSON}.",
  "{ORG}'s proprietary {TERM} produced a reading of {MEASUREMENT} that surprised the review committee chaired by {PERSON}.",
  "Internal documentation from {ORG} describes {TERM} as having drifted by {MEASUREMENT} over the observation window.",
  "{PERSON} presented findings to {ORG}'s steering committee showing {TERM} had stabilized near {MEASUREMENT}.",
  "A joint statement from {ORG} and its partners confirmed that {TERM} would be recalibrated following the {MEASUREMENT} deviation flagged during testing.",
];

function fillTemplate(template: string, rng: () => number): string {
  return template
    .replace(/\{ORG\}/g, () => pick(INVENTED_ORGANIZATIONS, rng))
    .replace(/\{PERSON\}/g, () => pick(INVENTED_PERSON_NAMES, rng))
    .replace(/\{TERM\}/g, () => pick(INVENTED_TERMS, rng))
    .replace(/\{MEASUREMENT\}/g, () => `${randomInt(2, 987, rng)}.${randomInt(0, 9, rng)} ${pick(MEASUREMENT_UNITS, rng)}`);
}

export function generateGenericSentences(seed: number, sentenceCount = 12): string[] {
  const rng = mulberry32(seed);
  return pickN(ALL_GENERIC_SENTENCES, sentenceCount, rng);
}

export function generateGenericDocument(seed: number, sentenceCount = 12): string {
  return generateGenericSentences(seed, sentenceCount).join(" ");
}

/**
 * Every one of the 80 generic sentences, once each — used as the candidate
 * for GENERIC/COMMON_BOILERPLATE-family query fixtures below so every one
 * of them is guaranteed to genuinely overlap with its candidate, regardless
 * of which random subset it happens to sample. Without this, a query
 * sampling different sentences than an arbitrarily-chosen corpus document
 * could accidentally share nothing at all — a vacuous, not a meaningful,
 * "does the model correctly reject this generic text" test.
 */
export const MASTER_GENERIC_DOCUMENT = ALL_GENERIC_SENTENCES.join(" ");

export function generateDistinctiveDocument(seed: number, sentenceCount = 10): string {
  const rng = mulberry32(seed);
  const sentences: string[] = [];
  for (let i = 0; i < sentenceCount; i += 1) sentences.push(fillTemplate(pick(DISTINCTIVE_TEMPLATES, rng), rng));
  return sentences.join(" ");
}

// --- background corpus ---------------------------------------------------------

export type CorpusDocument = { id: string; label: string; canonicalText: string };

/** ~115 documents: 60 GENERIC, 40 DISTINCTIVE, 3 reused SOURCE documents (E8J/E8K, for REUSE-fixture continuity), 12 topic-cluster INDEPENDENT documents. Seeds 1000-9999 — never overlaps buildQueryFixtures()'s 50000+ range. */
export function buildBackgroundCorpus(): CorpusDocument[] {
  const docs: CorpusDocument[] = [];
  for (let i = 0; i < 60; i += 1) {
    docs.push({ id: `generic-${i}`, label: "GENERIC", canonicalText: canonicalizeText(generateGenericDocument(1000 + i, 10 + (i % 6))) });
  }
  for (let i = 0; i < 40; i += 1) {
    docs.push({ id: `distinctive-${i}`, label: "DISTINCTIVE", canonicalText: canonicalizeText(generateDistinctiveDocument(3000 + i, 9 + (i % 4))) });
  }
  docs.push({ id: "source-e8j-base", label: "SOURCE", canonicalText: canonicalizeText(E8J_BASE_DOCUMENT) });
  docs.push({ id: "source-e8k-distinctive", label: "SOURCE", canonicalText: canonicalizeText(HIST_DISTINCTIVE_DOCUMENT) });
  docs.push({ id: "source-e8k-generic", label: "GENERIC", canonicalText: canonicalizeText(HIST_GENERIC_DOCUMENT) });
  docs.push({ id: "master-generic", label: "GENERIC", canonicalText: canonicalizeText(MASTER_GENERIC_DOCUMENT) });

  // 4 shared topics x 3 independently-written documents each = 12 INDEPENDENT docs.
  const topics = ["renewable-microgrid", "urban-beekeeping", "archival-digitization", "coastal-erosion"];
  for (const [ti, topic] of topics.entries()) {
    for (let variant = 0; variant < 3; variant += 1) {
      const rng = mulberry32(9000 + ti * 100 + variant);
      const generic = pickN(ALL_GENERIC_SENTENCES, 6, rng);
      const distinctiveFlavor: string[] = [];
      for (let i = 0; i < 6; i += 1) distinctiveFlavor.push(fillTemplate(pick(DISTINCTIVE_TEMPLATES, rng), rng));
      docs.push({ id: `independent-${topic}-${variant}`, label: "INDEPENDENT", canonicalText: canonicalizeText([...generic, ...distinctiveFlavor].join(" ")) });
    }
  }
  return docs;
}

// --- query fixtures --------------------------------------------------------------

export type QueryLabel =
  | "GENERIC" | "DISTINCTIVE_COPY" | "LIGHT_REUSE" | "MODERATE_REUSE" | "HEAVY_REUSE"
  | "PARTIAL_COPY" | "MULTI_BLOCK_COPY" | "SAME_TOPIC_INDEPENDENT" | "COMMON_BOILERPLATE";

export type QueryFixture = {
  id: string;
  label: QueryLabel;
  text: string;
  candidateText: string;
  split: "train" | "holdout" | "landmark";
  note: string;
};

/** Landmark fixtures reused directly from E8J/E8K for cross-phase continuity — evaluated after model weights are chosen, never used to tune them. */
function landmarkFixtures(): QueryFixture[] {
  const e8j = (cat: string) => E8J_FIXTURES.find((f) => f.category === cat)!;
  return [
    { id: "landmark-light-reuse", label: "LIGHT_REUSE", text: e8j("LIGHT_EDIT").text, candidateText: E8J_BASE_DOCUMENT, split: "landmark", note: "E8J LIGHT_EDIT, reused verbatim" },
    { id: "landmark-moderate-reuse", label: "MODERATE_REUSE", text: e8j("MODERATE_EDIT").text, candidateText: E8J_BASE_DOCUMENT, split: "landmark", note: "E8J MODERATE_EDIT, reused verbatim" },
    { id: "landmark-heavy-reuse", label: "HEAVY_REUSE", text: e8j("HEAVY_EDIT").text, candidateText: E8J_BASE_DOCUMENT, split: "landmark", note: "E8J HEAVY_EDIT, reused verbatim" },
    { id: "landmark-partial-copy", label: "PARTIAL_COPY", text: e8j("PARTIAL_COPY").text, candidateText: E8J_BASE_DOCUMENT, split: "landmark", note: "E8J PARTIAL_COPY (the critical 435-word case), reused verbatim" },
    { id: "landmark-same-topic", label: "SAME_TOPIC_INDEPENDENT", text: e8j("SAME_TOPIC_DIFFERENT_WORDING").text, candidateText: E8J_BASE_DOCUMENT, split: "landmark", note: "E8J SAME_TOPIC_DIFFERENT_WORDING, reused verbatim" },
    { id: "landmark-boilerplate-100", label: "COMMON_BOILERPLATE", text: GENERIC_100, candidateText: HIST_GENERIC_DOCUMENT, split: "landmark", note: "E8K GENERIC_100, reused verbatim, against E8K's own HIST_GENERIC_DOCUMENT (which genuinely contains it) — the same pairing E8K used" },
    { id: "landmark-boilerplate-200", label: "COMMON_BOILERPLATE", text: GENERIC_200, candidateText: HIST_GENERIC_DOCUMENT, split: "landmark", note: "E8K GENERIC_200 — the exact E8K false-positive case, same pairing E8K used" },
    { id: "landmark-boilerplate-300", label: "COMMON_BOILERPLATE", text: GENERIC_300, candidateText: HIST_GENERIC_DOCUMENT, split: "landmark", note: "E8K GENERIC_300 — the exact E8K false-positive case, same pairing E8K used" },
    { id: "landmark-multi-block", label: "MULTI_BLOCK_COPY", text: SEVERAL_MEDIUM_DISTINCTIVE_OVERLAPS, candidateText: HIST_DISTINCTIVE_DOCUMENT, split: "landmark", note: "E8K SEVERAL_MEDIUM_DISTINCTIVE_OVERLAPS, reused verbatim" },
  ];
}

const UNRELATED_FILLER =
  "The municipal water board's quarterly meeting covered routine maintenance scheduling and a proposal to replace aging meter infrastructure across three older neighborhoods over the coming fiscal year, with the replacement program contingent on approval of a bond measure currently under review by the finance committee.";

function withFiller(excerpt: string): string {
  return `${UNRELATED_FILLER} ${UNRELATED_FILLER}\n\n${excerpt}\n\n${UNRELATED_FILLER}`;
}

/** Multi-instance GENERIC/DISTINCTIVE_COPY/COMMON_BOILERPLATE/MULTI_BLOCK_COPY query fixtures, split train/holdout for a real generalization check — plus a few adversarial variants (sections 14/15), evaluated separately from the split. */
export function buildQueryFixtures(corpus: CorpusDocument[]): { fixtures: QueryFixture[]; adversarialGeneric: QueryFixture[]; adversarialDistinctive: QueryFixture[] } {
  const fixtures: QueryFixture[] = [...landmarkFixtures()];

  // GENERIC: 10 independent instances, split 5/5. Paired against
  // MASTER_GENERIC_DOCUMENT (every generic sentence, once each) so each is
  // GUARANTEED genuine overlap regardless of which random subset it
  // samples — an arbitrary corpus document could easily share nothing at
  // all, which would make the "does the model reject this" check vacuous.
  for (let i = 0; i < 10; i += 1) {
    const text = generateGenericDocument(50000 + i, 20 + (i % 6));
    fixtures.push({ id: `generic-query-${i}`, label: "GENERIC", text, candidateText: MASTER_GENERIC_DOCUMENT, split: i % 2 === 0 ? "train" : "holdout", note: "independent generic document, guaranteed to overlap with MASTER_GENERIC_DOCUMENT" });
  }

  // DISTINCTIVE_COPY: 10 near-exact copies of 10 distinct background DISTINCTIVE documents.
  const distinctiveSources = corpus.filter((d) => d.label === "DISTINCTIVE").slice(0, 10);
  for (const [i, source] of distinctiveSources.entries()) {
    fixtures.push({ id: `distinctive-copy-query-${i}`, label: "DISTINCTIVE_COPY", text: source.canonicalText, candidateText: source.canonicalText, split: i % 2 === 0 ? "train" : "holdout", note: `near-exact copy of background corpus document ${source.id}` });
  }

  // COMMON_BOILERPLATE: 6 additional mixed-category boilerplate documents (section 14's "mixed generic phrases stitched together"), 200-300 words, split 3/3. Same MASTER_GENERIC_DOCUMENT pairing rationale as GENERIC above.
  for (let i = 0; i < 6; i += 1) {
    const text = generateGenericDocument(51000 + i, 22 + (i % 5));
    fixtures.push({ id: `boilerplate-mixed-query-${i}`, label: "COMMON_BOILERPLATE", text, candidateText: MASTER_GENERIC_DOCUMENT, split: i % 2 === 0 ? "train" : "holdout", note: "mixed generic phrases stitched together from multiple subcategories, guaranteed to overlap with MASTER_GENERIC_DOCUMENT" });
  }

  // MULTI_BLOCK_COPY: 4 independent 2-block copies from freshly generated DISTINCTIVE source pairs.
  for (let i = 0; i < 4; i += 1) {
    const rng = mulberry32(52000 + i);
    const blockA = generateDistinctiveDocument(52100 + i, 6);
    const blockB = generateDistinctiveDocument(52200 + i, 6);
    const sourceDoc = `${blockA}\n\n${UNRELATED_FILLER}\n\n${blockB}`;
    const query = withFiller(`${blockA}\n\n${UNRELATED_FILLER}\n\n${blockB}`);
    void rng;
    fixtures.push({ id: `multi-block-query-${i}`, label: "MULTI_BLOCK_COPY", text: query, candidateText: sourceDoc, split: i % 2 === 0 ? "train" : "holdout", note: "two independently-generated distinctive blocks copied into an otherwise-unrelated document" });
  }

  // SAME_TOPIC_INDEPENDENT: pair up the 12 INDEPENDENT corpus docs within each topic (document B queried against document A of the same topic).
  const independentDocs = corpus.filter((d) => d.label === "INDEPENDENT");
  const topicGroups = new Map<string, CorpusDocument[]>();
  for (const d of independentDocs) {
    const topic = d.id.split("-").slice(1, -1).join("-");
    topicGroups.set(topic, [...(topicGroups.get(topic) ?? []), d]);
  }
  let sameTopicIndex = 0;
  for (const [topic, group] of topicGroups) {
    if (group.length < 2) continue;
    fixtures.push({ id: `same-topic-query-${sameTopicIndex}`, label: "SAME_TOPIC_INDEPENDENT", text: group[1].canonicalText, candidateText: group[0].canonicalText, split: sameTopicIndex % 2 === 0 ? "train" : "holdout", note: `independently-written document on the "${topic}" topic, queried against a different document on the same topic` });
    sameTopicIndex += 1;
  }

  // Adversarial generic (section 14): long boilerplate, repeated methodology
  // language, standard legal language, mixed patterns — all paired against
  // MASTER_GENERIC_DOCUMENT so each is guaranteed genuine, substantial
  // overlap (the whole point of an adversarial-generic case is that it DOES
  // match real historical content; the question is whether the model still
  // correctly rejects it as non-distinctive).
  const adversarialGeneric: QueryFixture[] = [
    { id: "adversarial-generic-long-boilerplate", label: "GENERIC", text: generateGenericDocument(60000, 40), candidateText: MASTER_GENERIC_DOCUMENT, split: "landmark", note: "long (40-sentence) boilerplate block" },
    { id: "adversarial-generic-repeated-methodology", label: "GENERIC", text: new Array(8).fill(GENERIC_SENTENCE_BANK.methodology[0]).join(" ") + " " + generateGenericDocument(60001, 10), candidateText: MASTER_GENERIC_DOCUMENT, split: "landmark", note: "repeated methodology sentence + generic filler" },
    { id: "adversarial-generic-legal", label: "GENERIC", text: GENERIC_SENTENCE_BANK.legalAdministrative.join(" ") + " " + GENERIC_SENTENCE_BANK.legalAdministrative.join(" "), candidateText: MASTER_GENERIC_DOCUMENT, split: "landmark", note: "standard legal/administrative language, doubled" },
    { id: "adversarial-generic-mixed", label: "GENERIC", text: generateGenericDocument(60002, 30), candidateText: MASTER_GENERIC_DOCUMENT, split: "landmark", note: "large mixed-category stitch (30 sentences across all 8 subcategories)" },
  ];

  // Adversarial distinctive (section 15): small edits to a genuine distinctive copy — entity swaps, number changes, punctuation changes, sentence merges.
  const advSource = distinctiveSources[0];
  const advRng = mulberry32(61000);
  let advText = advSource.canonicalText
    .replace(INVENTED_ORGANIZATIONS[0], INVENTED_ORGANIZATIONS[1])
    .replace(/\d+\.\d+/, () => `${randomInt(2, 987, advRng)}.${randomInt(0, 9, advRng)}`)
    .replace(/\. /g, ", and ") // sentence merges via punctuation change
    .replace(/,/g, ";");
  const adversarialDistinctive: QueryFixture[] = [
    { id: "adversarial-distinctive-small-edits", label: "DISTINCTIVE_COPY", text: advText, candidateText: advSource.canonicalText, split: "landmark", note: "genuine distinctive copy with entity/number/punctuation/sentence-structure edits — must not be rejected merely because a few high-information tokens changed" },
  ];

  return { fixtures, adversarialGeneric, adversarialDistinctive };
}
