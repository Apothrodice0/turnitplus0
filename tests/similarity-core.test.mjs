import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateSimilaritySources,
  acceptedSimilaritySpans,
  containment,
  detectDominantLanguage,
  detectLanguage,
  gramHash,
  grams,
  informativeGram,
  normalize,
  similarityScore,
  tokens,
} from "../lib/similarity-core.ts";

test("normalizes punctuation and accents consistently", () => {
  assert.equal(normalize("Criminalité — INTERNATIONALE!"), "criminalite internationale");
});

test("removes a trailing references section", () => {
  // lib/reference-section.ts's shared detector requires the content after a
  // "References" heading to actually look like a reference list (a
  // numbered marker, or a cluster of publication years plus citation
  // vocabulary) before treating it as a real section boundary — a bare
  // "Hidden source title" with no such markers no longer qualifies, which
  // is the intended fix for the PDF/DOCX parity investigation (an ordinary
  // prose sentence mentioning "references" must never be stripped either).
  assert.deepEqual(
    tokens("Useful article text.\n\nReferences\n[1] Hidden, S. Source title. Journal, 2020."),
    ["useful", "article", "text"],
  );
});

test("creates consecutive five-word grams", () => {
  assert.deepEqual(grams(["one", "two", "three", "four", "five", "six"], 5), [
    "one two three four five",
    "two three four five six",
  ]);
});

test("requires two informative terms", () => {
  assert.equal(informativeGram("of the international criminal court"), true);
  assert.equal(informativeGram("of the law in court"), false);
});

test("hashing is stable and distinguishes grams", () => {
  assert.equal(gramHash("of the international criminal court"), "ea00e4331f0142ef");
  assert.notEqual(gramHash("first distinctive phrase here now"), gramHash("second distinctive phrase here now"));
});

test("content containment drives self-match exclusion", () => {
  assert.equal(containment(75, 100, 90) >= 0.75, true);
  assert.equal(containment(50, 100, 90) >= 0.75, false);
});

test("score counts matched positions once", () => {
  assert.equal(similarityScore(19, 100), 19);
  assert.equal(similarityScore(120, 100), 100);
});

test("accepted spans reject isolated short matches after source assignment", () => {
  const matchedBySource = new Map([
    [0, new Set([0, 1, 2, 3, 4])],
    [1, new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])],
  ]);
  const result = acceptedSimilaritySpans(matchedBySource, 8);
  assert.deepEqual([...result.acceptedPositions], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  assert.equal(result.spansBySource.has(0), false);
  assert.deepEqual(result.spansBySource.get(1), [[10, 21]]);
  assert.throws(() => acceptedSimilaritySpans(matchedBySource, 0), /positive integer/);
});

test("accepted spans remain continuous when adjacent words choose different sources", () => {
  const matchedBySource = new Map([
    [0, new Set([0, 2, 4, 6])],
    [1, new Set([1, 3, 5, 7])],
  ]);
  const result = acceptedSimilaritySpans(matchedBySource, 8);
  assert.deepEqual([...result.acceptedPositions], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(result.acceptedGlobalSpans, [[0, 7]]);
});

test("source aggregation can suppress trivial contributors and cap retained sources", () => {
  const evidence = [
    { sourceIndex: 0, positions: new Set([0, 1, 2, 3]), containment: 0.5 },
    { sourceIndex: 1, positions: new Set([4, 5]), containment: 0.25 },
    { sourceIndex: 2, positions: new Set([6]), containment: 0.1 },
  ];
  const result = aggregateSimilaritySources(evidence, 100, {
    minimumSourceContribution: 2,
    maximumContributingSources: 1,
    sourceWeighting: "raw",
  });
  assert.equal(result.score, 4);
  assert.deepEqual(result.sourceContributions.map((source) => source.sourceIndex), [0]);
  const weighted = aggregateSimilaritySources(evidence.slice(0, 1), 100, {
    minimumSourceContribution: 0,
    maximumContributingSources: null,
    sourceWeighting: "containment",
  });
  assert.equal(weighted.matchedWordEquivalent, 2);
  assert.equal(weighted.score, 2);
});

test("detects Arabic, French, English, and mixed text", () => {
  assert.equal(detectLanguage("هذا نص عربي يشرح البحث في القانون الدولي"), "Arabic");
  assert.equal(detectLanguage("Le droit de la recherche dans les universités avec une méthode claire"), "French");
  assert.equal(detectLanguage("This research paper describes international criminal law"), "English");
  assert.equal(detectLanguage("This paper يناقش القانون الدولي وطرق البحث العلمي"), "Mixed");
});

test("Arabic stopwords do not make a phrase informative by themselves", () => {
  assert.equal(informativeGram("في من على هذا التي"), false);
  assert.equal(informativeGram("القانون الدولي في المحكمة الجنائية"), true);
});

/**
 * detectDominantLanguage regression suite.
 *
 * Reproduces a real misclassification: "Philanthropy, Socioemotional Wealth,
 * and Cultural Embeddedness in the Maghrebi Family Firm" is a predominantly
 * English article with a Spanish-translated abstract on page 1-2. The old
 * whole-document, presence-only detector counted the Spanish abstract's
 * "la"/"le"/"les" as French stopword evidence (Spanish and French share
 * those tokens) and had no Spanish label at all, so the document was
 * misclassified "French" at confidence 0.5 - below the 0.65 admission floor
 * - which routed the corpus decision to REVIEW with LANGUAGE_UNCERTAIN, and
 * separately made the AI-detector's English-only eligibility gate
 * (app/ai-detector-worker.ts) treat the document as non-English, producing
 * "AI analysis unavailable" for a document that is overwhelmingly English.
 *
 * The fixtures below use fixed, hand-curated word banks (not natural prose)
 * so weight ratios and window-boundary quantization are exactly
 * reproducible; the expected outputs were verified empirically against this
 * exact detector before being hard-coded here (see PR description / session
 * notes - not repeated as a comment per file since the values are the
 * regression contract itself).
 */

const ENGLISH_WORDS = [
  "the", "study", "examined", "population", "sample", "and", "the", "results",
  "were", "compared", "with", "previous", "findings", "in", "this", "research",
  "which", "was", "conducted", "across", "several", "institutions", "over",
  "a", "period", "of", "years", "before", "publication",
];
const FRENCH_WORDS = [
  "le", "droit", "de", "la", "recherche", "dans", "les", "universites",
  "avec", "une", "methode", "claire", "pour", "des", "etudiants", "sur",
  "cette", "question", "qui", "demeure", "importante", "ainsi", "nous",
  "concluons", "que", "chaque", "resultat", "est", "significatif",
];
const SPANISH_WORDS = [
  "el", "estudio", "examina", "la", "filantropia", "y", "la", "riqueza",
  "en", "las", "empresas", "familiares", "con", "una", "metodologia",
  "para", "estos", "resultados", "muestran", "que", "es", "un", "factor",
  "determinante", "del", "comportamiento", "al", "comprender", "este",
  "fenomeno", "tambien", "desde", "hacia",
];
const ARABIC_WORDS = [
  "هذا", "البحث", "يشرح", "القانون", "الدولي", "والعلاقات", "بين", "الدول",
  "المختلفة", "في", "هذا", "المجال", "الواسع", "والمهم", "جدا", "لفهم",
  "النظام", "القانوني", "الدولي", "الحديث", "والمعاصر",
];

function repeatWords(bank, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(bank[i % bank.length]);
  return out.join(" ");
}

function mix(bankA, countA, bankB, countB) {
  return `${repeatWords(bankA, countA)} ${repeatWords(bankB, countB)}`;
}

const REAL_SPANISH_ABSTRACT =
  "Resumen: Este articulo examina la filantropia y la riqueza socioemocional en las empresas familiares del Magreb. " +
  "El estudio analiza como la cultura influye en las decisiones filantropicas de estas empresas. Los resultados " +
  "muestran que la incrustacion cultural es un factor determinante para entender el comportamiento filantropico de " +
  "las familias empresarias en la region.";

test("dominant language: a real English/French/Spanish/Arabic document each resolve to their own label at full confidence", () => {
  assert.deepEqual(detectDominantLanguage(repeatWords(ENGLISH_WORDS, 3000)), { language: "English", confidence: 1 });
  assert.deepEqual(detectDominantLanguage(repeatWords(FRENCH_WORDS, 3000)), { language: "French", confidence: 1 });
  assert.deepEqual(detectDominantLanguage(repeatWords(SPANISH_WORDS, 3000)), { language: "Spanish", confidence: 1 });
  assert.deepEqual(detectDominantLanguage(repeatWords(ARABIC_WORDS, 1000)), { language: "Arabic", confidence: 1 });
});

test("dominant language: bug reproduction - a long English body with a short Spanish abstract is confidently English, not French or Mixed", () => {
  const result = detectDominantLanguage(mix(SPANISH_WORDS, 60, ENGLISH_WORDS, 3000));
  assert.equal(result.language, "English");
  assert.ok(result.confidence >= 0.65, `expected confidence >= the 0.65 admission floor, got ${result.confidence}`);
});

test("dominant language: bug reproduction with the real reported Spanish abstract text prepended to a long English body", () => {
  const result = detectDominantLanguage(`${REAL_SPANISH_ABSTRACT} ${repeatWords(ENGLISH_WORDS, 3000)}`);
  assert.equal(result.language, "English");
  assert.ok(result.confidence >= 0.65, `expected confidence >= the 0.65 admission floor, got ${result.confidence}`);
});

test("dominant language: a short embedded French passage inside a long English body does not dominate - still English", () => {
  const result = detectDominantLanguage(mix(FRENCH_WORDS, 80, ENGLISH_WORDS, 3000));
  assert.equal(result.language, "English");
  assert.ok(result.confidence >= 0.65);
});

test("dominant language: predominantly Spanish resolves to Spanish, not French or English, even though Spanish and French share stopwords", () => {
  const result = detectDominantLanguage(mix(SPANISH_WORDS, 2400, ENGLISH_WORDS, 600));
  assert.equal(result.language, "Spanish");
  assert.ok(result.confidence >= 0.65);
});

test("dominant language: predominantly French resolves to French", () => {
  const result = detectDominantLanguage(mix(FRENCH_WORDS, 2400, ENGLISH_WORDS, 600));
  assert.equal(result.language, "French");
  assert.ok(result.confidence >= 0.65);
});

test("dominant language: a genuinely balanced 50/50 English/Spanish document is Mixed, not defaulted to English", () => {
  const result = detectDominantLanguage(mix(ENGLISH_WORDS, 1500, SPANISH_WORDS, 1500));
  assert.equal(result.language, "Mixed");
});

test("dominant language: a 55/45 split still fails to dominate (margin gate) and is Mixed", () => {
  const result = detectDominantLanguage(mix(ENGLISH_WORDS, 1650, SPANISH_WORDS, 1350));
  assert.equal(result.language, "Mixed");
});

test("dominant language: a 60/40 split clears dominance but lands below the 0.65 admission floor - distinct from a genuinely confident document", () => {
  const result = detectDominantLanguage(mix(ENGLISH_WORDS, 1800, SPANISH_WORDS, 1200));
  assert.equal(result.language, "English");
  assert.ok(result.confidence < 0.65, `expected a merely-dominant, not confidently-dominant, score below 0.65, got ${result.confidence}`);
});

test("dominant language: no evidence anywhere (empty text, or text with no recognizable words) falls back to English at confidence 0, never a confident guess", () => {
  assert.deepEqual(detectDominantLanguage(""), { language: "English", confidence: 0 });
  assert.deepEqual(detectDominantLanguage("1234 5678 90 123"), { language: "English", confidence: 0 });
});

test("detectLanguage remains a thin label-only wrapper around detectDominantLanguage", () => {
  const text = mix(SPANISH_WORDS, 60, ENGLISH_WORDS, 3000);
  assert.equal(detectLanguage(text), detectDominantLanguage(text).language);
});
