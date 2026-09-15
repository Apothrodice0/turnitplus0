import assert from "node:assert/strict";
import test from "node:test";
import { normalize, tokens, tokenSpans, comparisonText } from "../lib/similarity-core.ts";
import { computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "../lib/document-correspondence.ts";

/**
 * MULTILINGUAL NORMALIZATION GAPS — test-only regression coverage for the
 * read-only audit's own findings. Documents CURRENT behavior; changes
 * nothing in lib/similarity-core.ts or lib/document-correspondence.ts.
 *
 * Confirmed by the audit (re-verified directly against the real production
 * functions below, not merely asserted):
 *
 *   - JavaScript's NFC/NFKC/NFKD do NOT decompose French œ/Œ/æ/Æ ligatures,
 *     and do NOT strip/decompose Arabic tatweel (U+0640) — tatweel is
 *     Unicode category Lm (a letter), never a combining mark, so
 *     normalize()'s own `\p{M}` diacritic-stripping step never touches it.
 *     lib/similarity-core.ts's normalize() therefore currently treats
 *     "cœur" != "coeur" and "العربية" != "العـربية" as genuinely different
 *     token strings.
 *   - This gap degrades matching LOCALLY (fewer matched grams touching the
 *     affected word) rather than causing total document-level mismatch —
 *     the surrounding, unaffected words still match normally.
 *   - matchedPositions (from computeDocumentCorrespondence, and by
 *     extension unifiedSimilarity) are WORD/TOKEN-ARRAY INDICES into
 *     tokens(submittedText) — never UTF-16 character offsets.
 *     tokenSpans() is the ONLY place a word-index position is converted to
 *     a character range, and it scans the ORIGINAL (un-normalized)
 *     comparisonText() directly — so a future ligature/tatweel-folding fix
 *     applied only to the matching-side normalization could never affect
 *     what character range gets highlighted; the customer's own original
 *     spelling would always remain what's displayed.
 *
 * CORPUS-REBUILD GUARDRAIL (documentation only — no introspection of any
 * packaged corpus/index performed or implied by this file):
 * lib/similarity-core.ts's normalize()/tokens() feed grams()/gramHash()
 * directly, which in turn feed EVERY production shingle-hash fingerprint in
 * this codebase — lib/selective-corpus/fingerprint.ts's packed Selective
 * Corpus V4 winnowed fingerprints, lib/user-submission-corpus.ts's
 * corpus_document_shingles (DB-persisted), and lib/document-family.ts's
 * shingle hashes all call tokens()/grams()/gramHash() from this exact same
 * shared module. Changing normalize()'s output for any character would
 * therefore change the hash of every gram touching an affected word,
 * silently invalidating already-persisted, already-packed fingerprints
 * built under the OLD normalization — a live query normalized under a NEW
 * rule would stop hash-matching historical corpus content it used to match.
 * This is why the audit's recommendation, and this task's own scope, is
 * test-only: a real fix requires a coordinated, explicitly-approved
 * re-fingerprint/rebuild across Selective Corpus V4, the user-submission
 * corpus shingle table, and document-family shingles — never a
 * normalize()-only runtime change. Nothing in this file touches, rebuilds,
 * or inspects any of those artifacts.
 *
 * TEMPORARY vs. PERMANENT — the current mismatch/degradation behavior below
 * is NOT a desired permanent product contract; it exists only because no one
 * has yet implemented French œ/æ and Arabic tatweel normalization together
 * with the coordinated persisted-index/fingerprint rebuild that change would
 * require (see above). Every "CURRENT GAP:" test and both "...DOCUMENT-
 * LEVEL:..." degradation tests (French and Arabic) are TEMPORARY
 * CHARACTERIZATION tests: they are expected to be UPDATED/FLIPPED (e.g.
 * notDeepEqual -> deepEqual, "measurably lower" -> equal/near-equal
 * matchedWordCount) once that normalization + rebuild is intentionally
 * implemented — a future PASS on today's "CURRENT GAP" assertions would mean
 * this file has gone stale, not that a regression occurred. The "CONTROL:"
 * ordinary-accent test, the "WORD-POSITION SEMANTICS:" test, and both
 * "HIGHLIGHT SAFETY" tests are PERMANENT SAFETY tests, independent of
 * whether/when that future fix ships, and are expected to keep passing
 * unchanged forever.
 */

// ---------------------------------------------------------------------------
// 4. FRENCH LIGATURE — current token-level behavior
// ---------------------------------------------------------------------------

test("CURRENT GAP: tokens('cœur') and tokens('coeur') are different token strings", () => {
  assert.notDeepEqual(tokens("cœur"), tokens("coeur"));
});

test("CURRENT GAP: tokens('Œuvre') and tokens('Oeuvre') are different token strings", () => {
  assert.notDeepEqual(tokens("Œuvre"), tokens("Oeuvre"));
});

test("CURRENT GAP: tokens('encyclopædie') and tokens('encyclopaedie') are different token strings", () => {
  assert.notDeepEqual(tokens("encyclopædie"), tokens("encyclopaedie"));
});

test("CONTROL: ordinary French accents already canonicalize equivalently under the current production normalizer (the remaining gap is specifically non-decomposing ligatures, not general accent handling)", () => {
  assert.deepEqual(tokens("Criminalité"), tokens("Criminalite"));
  assert.equal(normalize("Criminalité"), normalize("Criminalite"));
  // A full sentence mixing several ordinary accented words also canonicalizes
  // identically to its unaccented equivalent — proving the existing
  // NFKD + \p{M}-stripping step already generalizes, not just for one word.
  const accented = "Une étude détaillée révèle une méthode particulièrement générale et légère.";
  const unaccented = "Une etude detaillee revele une methode particulierement generale et legere.";
  assert.deepEqual(tokens(accented), tokens(unaccented));
});

// ---------------------------------------------------------------------------
// 5. ARABIC TATWEEL — current token-level behavior
// ---------------------------------------------------------------------------

test("CURRENT GAP: tokens('العربية') and tokens('العـربية') are different token strings", () => {
  assert.notDeepEqual(tokens("العربية"), tokens("العـربية"));
});

test("CURRENT GAP: Arabic tatweel (U+0640) survives normalize() unchanged — it is Unicode category Lm (a letter), not a combining mark, so the existing \\p{M} diacritic-stripping step never removes it", () => {
  const TATWEEL = "ـ";
  assert.equal(normalize(TATWEEL), TATWEEL);
  assert.ok(normalize("العـربية").includes(TATWEEL), "tatweel must still be present in the normalized word");
});

// ---------------------------------------------------------------------------
// 6. DOCUMENT-LEVEL GRACEFUL DEGRADATION — reduced recall around the
// affected word, never total document mismatch. Real, deterministic
// multi-sentence fixtures through the real computeDocumentCorrespondence.
// ---------------------------------------------------------------------------

const FRENCH_BASE_DOCUMENT = [
  "Le chercheur a présenté une étude détaillée sur le développement économique régional dans plusieurs provinces du pays.",
  "Cette analyse approfondie du phénomène observé révèle des tendances significatives sur une période prolongée.",
  "Au cœur du sujet se trouve la question de la répartition équitable des ressources disponibles entre les collectivités locales.",
  "Les résultats obtenus confirment une amélioration progressive des indicateurs sociaux dans les zones rurales concernées.",
  "Cette œuvre collective de recherche contribue de manière significative à la compréhension globale du sujet traité.",
].join(" ");

// Identical in every word EXCEPT the two ligature-bearing words above
// ("cœur" -> "coeur", "œuvre" -> "oeuvre") — deliberately not touching any
// other accented word, isolating the ligature gap specifically.
const FRENCH_LIGATURE_VARIANT_DOCUMENT = FRENCH_BASE_DOCUMENT
  .replace("cœur", "coeur")
  .replace("œuvre", "oeuvre");

test("FRENCH DOCUMENT-LEVEL: a ligature-only variant still produces strong correspondence (no total mismatch)", () => {
  const result = computeDocumentCorrespondence(FRENCH_BASE_DOCUMENT, FRENCH_LIGATURE_VARIANT_DOCUMENT);
  assert.equal(result.strongCorrespondence, true, "the two ligature-bearing words must not be enough to sink overall document correspondence");
  assert.ok(result.containment > 0.7, `containment should remain high despite the two affected words (actual ${result.containment})`);
});

test("FRENCH DOCUMENT-LEVEL: the ligature-only variant shows measurably LOWER matched coverage than an identical (no-ligature-difference) copy — localized degradation, not silent perfection", () => {
  const identical = computeDocumentCorrespondence(FRENCH_BASE_DOCUMENT, FRENCH_BASE_DOCUMENT);
  const ligatureVariant = computeDocumentCorrespondence(FRENCH_BASE_DOCUMENT, FRENCH_LIGATURE_VARIANT_DOCUMENT);
  assert.equal(identical.exactCanonicalMatch, true);
  assert.ok(
    ligatureVariant.matchedWordCount < identical.matchedWordCount,
    `a document differing only by ligature spelling must match strictly fewer words than a byte-identical copy (ligature-variant=${ligatureVariant.matchedWordCount}, identical=${identical.matchedWordCount})`,
  );
  // But the degradation must stay LOCAL, not collapse the whole comparison —
  // most of the document's real content still matches normally.
  assert.ok(
    ligatureVariant.matchedWordCount > identical.matchedWordCount * 0.6,
    `degradation must stay localized around the two affected words, not gut the whole match (ligature-variant=${ligatureVariant.matchedWordCount}, identical=${identical.matchedWordCount})`,
  );
});

const ARABIC_BASE_DOCUMENT = [
  "تناول الباحث في هذه الدراسة موضوع التنمية الاقتصادية في عدد من المناطق المختلفة من البلاد.",
  "أظهرت النتائج المتحصل عليها وجود تحسن ملحوظ في المؤشرات الاجتماعية خلال السنوات الأخيرة الماضية.",
  "تعد اللغة العربية من أكثر اللغات انتشارا وتستخدم في الكتابة والتحدث اليومي بشكل واسع النطاق.",
  "يشير هذا التحليل المفصل إلى اتجاهات مهمة تستحق المزيد من الدراسة والمتابعة المستقبلية.",
  "تساهم هذه الجهود البحثية المشتركة بشكل كبير في فهم الموضوع المطروح بصورة أوسع وأشمل.",
].join(" ");

// Identical except the tatweel-elongated form of "العربية" ("the Arabic
// language") inserted into the one sentence that contains it.
const ARABIC_TATWEEL_VARIANT_DOCUMENT = ARABIC_BASE_DOCUMENT.replace("العربية", "العـربية");

test("ARABIC DOCUMENT-LEVEL: a tatweel-only variant still produces strong correspondence (no total mismatch)", () => {
  const result = computeDocumentCorrespondence(ARABIC_BASE_DOCUMENT, ARABIC_TATWEEL_VARIANT_DOCUMENT);
  assert.equal(result.strongCorrespondence, true, "one tatweel-elongated word must not be enough to sink overall document correspondence");
  assert.ok(result.containment > 0.7, `containment should remain high despite the one affected word (actual ${result.containment})`);
});

test("ARABIC DOCUMENT-LEVEL: the tatweel-only variant shows measurably LOWER matched coverage than an identical copy — localized degradation, not silent perfection", () => {
  const identical = computeDocumentCorrespondence(ARABIC_BASE_DOCUMENT, ARABIC_BASE_DOCUMENT);
  const tatweelVariant = computeDocumentCorrespondence(ARABIC_BASE_DOCUMENT, ARABIC_TATWEEL_VARIANT_DOCUMENT);
  assert.equal(identical.exactCanonicalMatch, true);
  assert.ok(
    tatweelVariant.matchedWordCount < identical.matchedWordCount,
    `a document differing only by tatweel must match strictly fewer words than a byte-identical copy (tatweel-variant=${tatweelVariant.matchedWordCount}, identical=${identical.matchedWordCount})`,
  );
  assert.ok(
    tatweelVariant.matchedWordCount > identical.matchedWordCount * 0.6,
    `degradation must stay localized around the one affected word, not gut the whole match (tatweel-variant=${tatweelVariant.matchedWordCount}, identical=${identical.matchedWordCount})`,
  );
});

// ---------------------------------------------------------------------------
// 7. WORD-POSITION SEMANTICS — matchedPositions/passage word-start/word-end
// are indices into tokens(submittedText), not UTF-16 character offsets.
// Behavior-level proof (reconstruct the matched phrase FROM the reported
// indices), not a source-text grep.
// ---------------------------------------------------------------------------

test("WORD-POSITION SEMANTICS: a passage's submittedWordStart/submittedWordEnd are word-array indices into tokens(submittedText), not character offsets", () => {
  // A short, deterministic pair with one obvious, long, distinctive shared
  // passage and clearly different surrounding filler on each side, so there
  // is exactly one accepted span to reason about.
  const distinctivePhrase =
    "researchers observed a remarkably consistent correlation between elevated soil moisture levels and increased subterranean fungal biodiversity across every sampled transect";
  const submitted = `Introductory remarks precede the main discussion. ${distinctivePhrase}. Concluding remarks follow after this point in the document.`;
  const external = `A completely different opening paragraph appears here instead. ${distinctivePhrase}. Then a completely different closing paragraph appears as well.`;

  const result = computeDocumentCorrespondence(submitted, external, {
    ...DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
    minimumMatchedWords: 5,
    minimumPassageLengthWords: 5,
  });

  assert.ok(result.passages.length >= 1, "sanity: at least one accepted passage must exist");
  const passage = result.passages[0];

  const submittedTokens = tokens(submitted);
  // Reconstructing the phrase by SLICING tokens(submitted) at the reported
  // [submittedWordStart, submittedWordEnd] word indices must reproduce
  // (a normalized form of) the real distinctive phrase — this is only
  // possible if these numbers are word-array indices, never character
  // offsets (slicing a word array with a character offset would either
  // throw an out-of-range/nonsensical result or silently reconstruct the
  // wrong words).
  const reconstructed = submittedTokens.slice(passage.submittedWordStart, passage.submittedWordEnd + 1).join(" ");
  assert.equal(reconstructed, tokens(distinctivePhrase).join(" "), "slicing tokens(submittedText) at the reported word indices must reconstruct the real matched phrase");

  // A character-offset interpretation would be nonsensical here: the
  // distinctive phrase's real CHARACTER offset in `submitted` is far larger
  // than its WORD index (there is a whole introductory sentence before it),
  // proving the two numbering schemes are not interchangeable and that the
  // production code is using the word-index scheme.
  const realCharacterOffset = submitted.indexOf(distinctivePhrase);
  assert.ok(realCharacterOffset > passage.submittedWordEnd, "the phrase's real character offset must be larger than its reported word-index end -- confirming these are word indices, not character offsets");
});

// ---------------------------------------------------------------------------
// 8. ORIGINAL-TEXT HIGHLIGHT SPAN SAFETY — tokenSpans() maps word positions
// back to character ranges in the ORIGINAL text, never a normalized/folded
// string. A future ligature/tatweel matching fix could not corrupt what
// gets highlighted, because display never goes through the transform used
// for matching.
// ---------------------------------------------------------------------------

test("HIGHLIGHT SAFETY (French): tokenSpans() maps the 'cœur' token back to the exact original 'cœur' substring, ligature intact", () => {
  const text = "Au cœur du sujet se trouve une question essentielle.";
  const spans = tokenSpans(text);
  const coeurSpan = spans.find((span) => span.word.toLowerCase() === "cœur");
  assert.ok(coeurSpan, "sanity: the ligature-bearing word must be found as its own token span");
  const originalSubstring = comparisonText(text).slice(coeurSpan.start, coeurSpan.end);
  assert.equal(originalSubstring, "cœur", "the highlighted character range must reproduce the ORIGINAL ligature spelling, never a folded 'coeur'");
});

test("HIGHLIGHT SAFETY (Arabic): tokenSpans() maps the tatweel-containing token back to the exact original tatweel-containing substring", () => {
  const TATWEEL = "ـ";
  const text = `اللغة العـربية هي لغة رسمية في العديد من الدول.`;
  const spans = tokenSpans(text);
  const tatweelSpan = spans.find((span) => span.word.includes(TATWEEL));
  assert.ok(tatweelSpan, "sanity: the tatweel-bearing word must be found as its own token span");
  const originalSubstring = comparisonText(text).slice(tatweelSpan.start, tatweelSpan.end);
  assert.ok(originalSubstring.includes(TATWEEL), "the highlighted character range must still contain the original tatweel character, never a stripped form");
  assert.equal(originalSubstring, "العـربية", "the highlighted range must reproduce the exact original tatweel-containing word");
});
