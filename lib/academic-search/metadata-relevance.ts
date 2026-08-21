import { stripBoilerplateSections } from "../boilerplate-section";
import { COMMON_WORDS, tokens } from "../similarity-core";
import type { AcademicSearchCandidate } from "./types";

/**
 * Metadata-relevance investigation (K-drama/Google Trends, RECYT,
 * BayesValidRox real-document offline experiments — see those reports for
 * the full evidence trail this module implements): a candidate-quality
 * signal computed purely from overlap between the submission's own
 * high-information vocabulary and each candidate's title + abstract
 * metadata (both already returned by the real provider search() calls —
 * see providers/openaire.ts and providers/europe-pmc.ts's own header
 * comments — never retrieved full text), so it stays cheap and runs
 * entirely before any retrieval budget is spent.
 *
 * Two things this signal is NOT:
 *  - It is not a replacement for candidate-ranker.ts's existing signals.
 *    It contributes a single bounded bonus (see METADATA_RELEVANCE_CAP)
 *    added on top of the real V11 relevance score — hasDoi, hasUrl,
 *    specificityBonus, and multiProviderCorroboration are entirely
 *    unaffected and untouched by this module.
 *  - It is not computed from the submission's raw text. The submission's
 *    own administrative boilerplate (competing-interest declarations,
 *    acknowledgments, funding disclosures) is stripped first via
 *    lib/boilerplate-section.ts — confirmed live to matter: the real
 *    BayesValidRox PDF's own Acknowledgment/Competing-Interests paragraphs
 *    otherwise pollute its term profile with generic academic-paper-
 *    structure vocabulary ("financial," "interests," "declare," "authors"),
 *    which then spuriously rewards other candidates sharing the same
 *    document STRUCTURE rather than the same TOPIC — see that module's own
 *    header comment for the full account, including a real OpenAIRE-
 *    indexed record whose own title literally IS a boilerplate sentence.
 */

function isInformativeWord(word: string): boolean {
  return word.length >= 4 && !COMMON_WORDS.has(word);
}

export type SubmissionTermProfile = {
  termFreq: Map<string, number>;
  /** Adjacent informative-word bigrams recurring >=2 times in the (boilerplate-stripped) submission — e.g. "google trends," "k-drama industry" — rewarded as exact-phrase matches by rawMetadataScore below, a stronger signal than bag-of-words overlap alone. */
  distinctivePhrases: string[];
};

/** Builds the submission's own term profile once per run — boilerplate-stripped, so administrative sections never contribute vocabulary (see this file's own header comment). */
export function buildSubmissionTermProfile(submissionText: string): SubmissionTermProfile {
  const cleaned = stripBoilerplateSections(submissionText);
  const rawWords = tokens(cleaned);

  const termFreq = new Map<string, number>();
  for (const word of rawWords) {
    if (!isInformativeWord(word)) continue;
    termFreq.set(word, (termFreq.get(word) ?? 0) + 1);
  }

  const bigramFreq = new Map<string, number>();
  for (let i = 0; i < rawWords.length - 1; i++) {
    if (!isInformativeWord(rawWords[i]) || !isInformativeWord(rawWords[i + 1])) continue;
    const bigram = `${rawWords[i]} ${rawWords[i + 1]}`;
    bigramFreq.set(bigram, (bigramFreq.get(bigram) ?? 0) + 1);
  }
  const distinctivePhrases = [...bigramFreq.entries()].filter(([, count]) => count >= 2).map(([phrase]) => phrase);

  return { termFreq, distinctivePhrases };
}

/** Flat credit per exact distinctive-phrase match found verbatim in a candidate's title+abstract — same order of magnitude as one moderately-specific single-term IDF hit, not dominant on its own. */
const DISTINCTIVE_PHRASE_BONUS = 3;

function candidateWords(text: string | null): string[] {
  return text ? tokens(text).filter(isInformativeWord) : [];
}

/**
 * IDF computed over the DISCOVERED CANDIDATE POOL itself, not a general
 * corpus — a term shared by many of this run's own candidates (generic
 * academic vocabulary that happens to recur across an unrelated field,
 * e.g. "search"/"study"/"analysis") is down-weighted; a term only a few
 * candidates share is up-weighted. Only terms the submission itself cares
 * about are counted at all — this is purely a within-run relevance signal,
 * never a general term-rarity model.
 */
function computeIdf(candidates: AcademicSearchCandidate[], profile: SubmissionTermProfile): Map<string, number> {
  const docCount = new Map<string, number>();
  for (const candidate of candidates) {
    const words = new Set([...candidateWords(candidate.title), ...candidateWords(candidate.abstract)]);
    for (const word of words) {
      if (!profile.termFreq.has(word)) continue;
      docCount.set(word, (docCount.get(word) ?? 0) + 1);
    }
  }
  const poolSize = candidates.length;
  const idf = new Map<string, number>();
  for (const [term, documentFrequency] of docCount) {
    idf.set(term, Math.log((poolSize + 1) / (documentFrequency + 0.5)));
  }
  return idf;
}

/** Title matches count double relative to abstract matches — title is the stronger relevance signal. Normalized by sqrt(title+abstract word count) so a long, verbose abstract isn't rewarded purely for length. */
function rawMetadataScore(candidate: AcademicSearchCandidate, profile: SubmissionTermProfile, idf: Map<string, number>): number {
  const titleWords = candidateWords(candidate.title);
  const abstractWords = candidateWords(candidate.abstract);
  if (titleWords.length === 0 && abstractWords.length === 0) return 0;

  let overlapScore = 0;
  const seen = new Set<string>();
  for (const word of [...titleWords, ...abstractWords]) {
    if (!profile.termFreq.has(word) || seen.has(word)) continue;
    seen.add(word);
    overlapScore += (idf.get(word) ?? 0) * (titleWords.includes(word) ? 2 : 1);
  }
  const lengthNorm = Math.sqrt(Math.max(1, titleWords.length + abstractWords.length));
  let score = overlapScore / lengthNorm;

  if (profile.distinctivePhrases.length > 0) {
    const combinedText = `${candidate.title ?? ""} ${candidate.abstract ?? ""}`.toLowerCase();
    for (const phrase of profile.distinctivePhrases) {
      if (combinedText.includes(phrase)) score += DISTINCTIVE_PHRASE_BONUS;
    }
  }
  return score;
}

/** The bonus's ceiling — chosen to sit comfortably inside V11's own scale (hasDoi 3 + hasUrl 1 + specificityBonus up to 8 + multiProviderCorroboration 5 = up to 17) rather than dominate it. Confirmed by offline validation against three real documents (RECYT, BayesValidRox, K-drama/Google Trends) at 4/6/8/10: RECYT and BayesValidRox stayed at their existing rank at every tested value, and 10 gave the largest genuine improvement to the K-drama case without threatening either. */
export const METADATA_RELEVANCE_CAP = 10;

/**
 * Returns each candidate's bonus, normalized so the single
 * highest-scoring candidate in this pool receives exactly `cap` and every
 * other candidate receives a proportional share — never replacing or
 * exceeding the cap, never negative. A pool with no metadata-relevance
 * signal at all (every candidate scores 0 — e.g. no title/abstract
 * overlaps the submission's own vocabulary) returns an all-zero map rather
 * than dividing by zero.
 */
export function computeMetadataRelevanceBonus(
  candidates: AcademicSearchCandidate[],
  profile: SubmissionTermProfile,
  cap: number = METADATA_RELEVANCE_CAP,
): Map<string, number> {
  const idf = computeIdf(candidates, profile);
  const raw = candidates.map((candidate) => ({ key: candidate.candidateKey, score: rawMetadataScore(candidate, profile, idf) }));
  const maxRaw = Math.max(...raw.map((r) => r.score), 0);

  const bonus = new Map<string, number>();
  for (const r of raw) {
    bonus.set(r.key, maxRaw > 0 ? cap * (r.score / maxRaw) : 0);
  }
  return bonus;
}
