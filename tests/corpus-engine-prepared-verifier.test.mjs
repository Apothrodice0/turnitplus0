import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { corpusEngineScratch, fixtureSource, inventedText, prng, removeScratch, sliceWords, wordsOf } from './helpers/corpus-engine-fixtures.mjs';
import { compareSubmissionToExternalText } from '../lib/academic-search/comparator.ts';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { normalizeForCorpus } from '../lib/corpus-engine/fingerprints.ts';
import { CORPUS_ENGINE_V1_FLAG } from '../lib/corpus-engine/flag.ts';
import { deriveDocId } from '../lib/corpus-engine/ids.ts';
import { runCorpusEngineCandidateVerification } from '../lib/corpus-engine/index.ts';
import {
  assertPreparedSubmissionForAdmission,
  comparePreparedSubmissionToCandidate,
  correspondPreparedSubmission,
  prepareSubmissionForVerification,
  PreparedSubmissionContractError,
  verifyPreparedSubmissionAgainstCandidate,
} from '../lib/corpus-engine/prepared-verifier.ts';
import { CorpusGenerationReader } from '../lib/corpus-engine/reader.ts';
import { retrieveCandidates } from '../lib/corpus-engine/retrieval.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { admitCandidates, createVerifierArtifactView, DEFAULT_VERIFIER_PATH, finalizeVerification, verifyCandidatesWithExistingVerifier } from '../lib/corpus-engine/verifier-adapter.ts';
import { FAMILY_ADMISSION_POLICY_AWARE_V2, FAMILY_ADMISSION_POLICY_GUARD_V1 } from '../lib/corpus-engine/family-admission.ts';
import { NORMALIZATION_PROBE_TEXT } from '../lib/corpus-engine/versions.ts';
import { computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from '../lib/document-correspondence.ts';
import { documentShingleHashes } from '../lib/document-family.ts';
import { canonicalSha256 } from '../lib/document-identity.ts';
import { runWithScoringNormalization } from '../lib/scoring-normalization-scope.ts';
import { SELECTIVE_CORPUS_STOP_DF } from '../lib/selective-corpus/constants.ts';
import { selectiveCorpusDocumentHashes } from '../lib/selective-corpus/fingerprint.ts';
import { admitSelectiveCorpusCandidate, selectiveCorpusSubmissionWords } from '../lib/selective-corpus/verify.ts';
import { comparisonText, currentScoringNormalizationVersion, gramHash, grams, informativeGram, stripScoringIgnorableFormatCharacters, tokens } from '../lib/similarity-core.ts';

/**
 * Corpus Engine v1 — the equality gate of the prepared-submission verifier.
 *
 * lib/corpus-engine/prepared-verifier.ts prepares the submission once per
 * query and verifies each candidate against that. It is only allowed to be
 * faster. THE EXISTING VERIFIER IS THE ORACLE: for every pair below, each of
 *
 *   correspondPreparedSubmission             vs  computeDocumentCorrespondence
 *   comparePreparedSubmissionToCandidate     vs  compareSubmissionToExternalText
 *   verifyPreparedSubmissionAgainstCandidate vs  admitSelectiveCorpusCandidate
 *
 * must return a deep-equal value, serialize to the same bytes, and read the
 * FAMILY_GUARD artifact with the same calls in the same order. Then the engine
 * adapter is run end to end over a built generation on both paths.
 *
 * A census is kept of which branches the oracle actually took, and the last
 * test fails if a branch went unexercised — equality over cases that never
 * reach a branch would prove nothing about it.
 *
 * Every build finishes before the first test() is registered.
 */

// ── text material ───────────────────────────────────────────────────────────
// Deterministic prose with real function words, short words, punctuation, capitals and diacritics, so the
// reference strip, the common-word filter and the normalization all have something to act on. Invented
// words alone (tests/helpers) make every 5-gram informative and would leave those rules untested.
const VOCABULARY = {
  en: {
    fn: ['the', 'of', 'and', 'to', 'in', 'a', 'is', 'that', 'for', 'it', 'as', 'was', 'with', 'be', 'by', 'on', 'not', 'this', 'are', 'or', 'from', 'at', 'which', 'but', 'have', 'an', 'they', 'were', 'their', 'one', 'all', 'we', 'can', 'has', 'there', 'been', 'if', 'more', 'when', 'will', 'who', 'so', 'no'],
    content: ['evidence', 'structure', 'function', 'measurement', 'temperature', 'pressure', 'velocity', 'molecule', 'protein', 'membrane', 'neuron', 'synapse', 'cortex', 'glacier', 'sediment', 'erosion', 'climate', 'rainfall', 'harvest', 'irrigation', 'village', 'council', 'treaty', 'border', 'empire', 'dynasty', 'manuscript', 'archive', 'printing', 'language', 'grammar', 'syntax', 'dialect', 'translation', 'market', 'inflation', 'currency', 'taxation', 'labour', 'factory', 'railway', 'harbour', 'voyage', 'compass', 'telescope', 'orbit', 'planet', 'gravity', 'quantum', 'particle', 'spectrum', 'voltage', 'circuit', 'algorithm', 'network', 'database', 'encryption', 'protocol', 'hospital', 'vaccine', 'infection', 'diagnosis', 'therapy', 'surgery', 'nutrition', 'vitamin', 'bacteria', 'enzyme', 'genome', 'mutation', 'species', 'habitat', 'predator', 'migration', 'forest', 'wetland', 'coral', 'volcano', 'earthquake', 'mineral', 'copper', 'granite', 'bridge', 'concrete', 'turbine', 'engine', 'aircraft', 'satellite', 'painting', 'sculpture', 'symphony', 'theatre', 'novel', 'poetry', 'philosophy', 'ethics', 'justice', 'parliament', 'election', 'citizen', 'constitution', 'education', 'curriculum', 'university', 'library', 'sea', 'ice', 'law', 'map', 'ore'],
  },
  fr: {
    fn: ['le', 'la', 'les', 'des', 'une', 'un', 'et', 'de', 'du', 'en', 'dans', 'avec', 'pour', 'que', 'qui', 'sur', 'est', 'sont', 'cette', 'ces', 'au', 'aux', 'par', 'plus', 'ne', 'pas', 'se', 'ce', 'il', 'elle', 'nous', 'on', 'à', 'où', "d'une", "l'on", "qu'il"],
    content: ['recherche', 'analyse', 'méthode', 'résultats', 'échantillon', 'théorie', 'preuve', 'structure', 'température', 'pression', 'molécule', 'protéine', 'glacier', 'érosion', 'climat', 'récolte', 'village', 'conseil', 'traité', 'frontière', 'empire', 'manuscrit', 'archives', 'langue', 'grammaire', 'traduction', 'marché', 'monnaie', 'impôt', 'travail', 'usine', 'chemin', 'voyage', 'boussole', 'planète', 'gravité', 'particule', 'tension', 'réseau', 'hôpital', 'vaccin', 'infection', 'thérapie', 'chirurgie', 'bactérie', 'génome', 'espèce', 'forêt', 'volcan', 'séisme', 'minéral', 'cuivre', 'béton', 'moteur', 'avion', 'peinture', 'théâtre', 'roman', 'poésie', 'philosophie', 'éthique', 'justice', 'parlement', 'élection', 'citoyen', 'constitution', 'éducation', 'université', 'bibliothèque', 'société', 'économie', 'république', 'développement', 'étude', 'données', 'modèle', 'système', 'énergie', 'matière', 'œuvre', 'cœur', 'mer', 'loi', 'île'],
  },
  ar: {
    fn: ['في', 'من', 'إلى', 'على', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'كان', 'كانت', 'أن', 'لا', 'ما', 'هو', 'هي', 'بين', 'بعد', 'قبل', 'كل', 'و', 'أو', 'ثم'],
    content: ['البحث', 'التحليل', 'الطريقة', 'النتائج', 'العينة', 'النظرية', 'الدليل', 'البنية', 'الحرارة', 'الضغط', 'الجزيء', 'البروتين', 'المناخ', 'الحصاد', 'القرية', 'المجلس', 'المعاهدة', 'الحدود', 'الإمبراطورية', 'المخطوطة', 'الأرشيف', 'اللغة', 'القواعد', 'الترجمة', 'السوق', 'العملة', 'الضريبة', 'العمل', 'المصنع', 'الطريق', 'الرحلة', 'الكوكب', 'الجاذبية', 'الشبكة', 'المستشفى', 'اللقاح', 'العدوى', 'العلاج', 'الجراحة', 'البكتيريا', 'الغابة', 'البركان', 'الزلزال', 'المعدن', 'النحاس', 'المحرك', 'الطائرة', 'الرسم', 'المسرح', 'الرواية', 'الشعر', 'الفلسفة', 'الأخلاق', 'العدالة', 'البرلمان', 'الانتخابات', 'المواطن', 'الدستور', 'التعليم', 'الجامعة', 'المكتبة', 'المجتمع', 'الاقتصاد', 'الجمهورية', 'التنمية', 'الدراسة', 'البيانات', 'النموذج', 'النظام', 'الطاقة', 'المادة', 'الْعَرَبِيَّةُ', 'لُغَةٌ', 'كِتَابٌ', 'مَدْرَسَةٌ', 'جـــميلة', 'عِلْم', 'نور'],
  },
};

/** `count` whitespace-separated words of pseudo-prose; the same seed always gives the same text. */
function prose(language, seed, count) {
  const random = prng(seed);
  const { fn, content } = VOCABULARY[language];
  const words = [];
  let sinceStop = 0;
  for (let index = 0; index < count; index += 1) {
    let word = random() < 0.36 ? fn[Math.floor(random() * fn.length)] : content[Math.floor(random() * content.length)];
    if (sinceStop === 0 && language !== 'ar') word = word[0].toUpperCase() + word.slice(1);
    sinceStop += 1;
    const mark = random();
    if (sinceStop > 6 && mark < 0.12) {
      word += '.';
      sinceStop = 0;
    } else if (mark < 0.2) word += ',';
    else if (mark < 0.22) word = `(${word})`;
    words.push(word);
  }
  return words.join(' ');
}

/** Only function words: not one informative 5-gram. */
function functionWordsOnly(language, seed, count) {
  const random = prng(seed);
  const { fn } = VOCABULARY[language];
  return Array.from({ length: count }, () => fn[Math.floor(random() * fn.length)]).join(' ');
}

const take = sliceWords;
/** Replaces every n-th word with a word found nowhere else. */
function editEvery(text, n, tag) {
  const words = wordsOf(text);
  for (let index = n - 1; index < words.length; index += n) words[index] = `${tag}${index}zq`;
  return words.join(' ');
}
/** Puts `mark` inside every n-th word of at least four characters. */
function insideWords(text, n, mark) {
  return wordsOf(text).map((word, index) => (index % n === 0 && word.length >= 4 ? `${word.slice(0, 2)}${mark}${word.slice(2)}` : word)).join(' ');
}

// ── the document library ────────────────────────────────────────────────────
const library = new Map();
const add = (id, text) => {
  assert.ok(!library.has(id), id);
  library.set(id, text);
  return text;
};
for (let index = 0; index < 8; index += 1) add(`en-${index}`, prose('en', 100 + index, 300 + 60 * index));
for (let index = 0; index < 4; index += 1) add(`fr-${index}`, prose('fr', 200 + index, 320 + 60 * index));
for (let index = 0; index < 4; index += 1) add(`ar-${index}`, prose('ar', 300 + index, 320 + 60 * index));
for (let index = 0; index < 4; index += 1) add(`inv-${index}`, inventedText(400 + index, 300 + 80 * index));
add('en-long-0', prose('en', 150, 3000));
add('en-long-1', prose('en', 151, 2400));

// Families: one block of text held by N documents, each with its own text before and after it.
// FAMILY_GUARD: a span held by >= 3 documents is shared-family; a fingerprint in >= 13 is a stop hash.
const BLOCKS = {
  x2: { text: prose('en', 9002, 260), language: 'en', holders: 2 },
  x3: { text: prose('en', 9003, 260), language: 'en', holders: 3 },
  x5: { text: prose('en', 9005, 260), language: 'en', holders: 5 },
  x14: { text: inventedText(9014, 260), language: 'en', holders: 14 },
  f3: { text: prose('fr', 9103, 220), language: 'fr', holders: 3 },
  a3: { text: prose('ar', 9203, 220), language: 'ar', holders: 3 },
};
const ownText = new Map();
let familySeed = 5000;
for (const [name, block] of Object.entries(BLOCKS)) {
  for (let index = 0; index < block.holders; index += 1) {
    const before = prose(block.language, (familySeed += 1), 180);
    const after = prose(block.language, (familySeed += 1), 180);
    ownText.set(`${name}-${index}`, { before, after });
    add(`${name}-${index}`, `${before} ${block.text} ${after}`);
  }
}
const holdersOf = (name) => Array.from({ length: BLOCKS[name].holders }, (_, index) => `${name}-${index}`);
const doc = (id) => {
  const text = library.get(id);
  assert.ok(text !== undefined, `no library document ${id}`);
  return text;
};
const fromLibrary = (...ids) => ids.map((id) => [id, doc(id)]);

// Reference lists, in the three languages the strip recognizes.
const REFERENCE_ENTRIES = {
  en: [
    'Smith, J. (2019). A study of glacier sediment and coastal erosion. Journal of Studies, 12(3), 45-67.',
    'Okafor, N. (2017). Irrigation councils in village harvest economies. Review of Context, 3(2), 11-29.',
    'Zhang, W. (2020). Quantum particle spectra under pressure. Annals of Things, 30(4), 400-420.',
    'Kowalski, P. (2015). Protein membranes and neuron synapse function. Quarterly of Nature, 21(2), 201-230.',
    'Tanaka, H. (2014). Telescope measurement of planet orbit and gravity. Measurement Letters, 2(4), 55-71.',
    'Rossi, L. (2016). Manuscript archives and the printing of dialect grammar. Rivista, 9(1), 77-95.',
    'Hughes, M. (2018). Vaccine therapy after hospital infection diagnosis. Clinical Record, 14(2), 90-118.',
    'Alvarez, R. (2021). Railway factory labour and harbour taxation. Economic History, 44(1), 1-33.',
  ],
  fr: [
    'Dupont, A. (2021). Une étude de la frontière et du traité. Revue des études, 8(1), 1-20.',
    'Martin, B. (2018). La monnaie, le marché et la république. Annales économiques, 5(2), 30-52.',
    'Bernard, C. (2016). Théâtre, poésie et philosophie du citoyen. Cahiers, 11(3), 100-131.',
    'Leroy, D. (2019). Le génome de la bactérie et la thérapie. Revue de biologie, 7(4), 200-219.',
    'Moreau, E. (2020). Érosion du glacier et climat de la forêt. Géographie, 2(1), 9-40.',
    'Petit, F. (2015). Le manuscrit des archives du village. Histoire, 19(2), 60-88.',
  ],
  ar: [
    'الحسن، م. (2018). دراسة في اللغة والترجمة والقواعد. مجلة الدراسات، 5(2)، 100-120.',
    'العلي، س. (2020). الاقتصاد والسوق والعملة في الجمهورية. مجلة الاقتصاد، 9(1)، 1-25.',
    'النجار، ف. (2016). المسرح والشعر والفلسفة في المجتمع. مجلة الأدب، 3(4)، 44-70.',
    'الخطيب، ر. (2019). اللقاح والعلاج بعد العدوى في المستشفى. مجلة الطب، 12(3)، 210-233.',
    'يوسف، ن. (2017). المناخ والغابة والبركان والزلزال. مجلة الجغرافيا، 6(2)، 15-39.',
    'حداد، ك. (2021). الدستور والبرلمان والانتخابات والمواطن. مجلة القانون، 8(1)، 77-99.',
  ],
};
const HEADING = { en: 'References', fr: 'Références', ar: 'المراجع' };
const referenceList = (language) => REFERENCE_ENTRIES[language].join('\n');
const withReferences = (language, body) => `${body}\n\n${HEADING[language]}\n${referenceList(language)}`;

// The lines of the engine's normalization probe that carry compatibility forms, invisible format
// characters, Arabic marks and tatweel, and the case-mapping specials.
const SPECIAL_LINES = NORMALIZATION_PROBE_TEXT.split('\n').slice(0, 4);
const specialDocument = [prose('en', 7001, 60), SPECIAL_LINES[0], prose('en', 7002, 40), SPECIAL_LINES[1], prose('fr', 7003, 40), SPECIAL_LINES[2], prose('ar', 7004, 40), SPECIAL_LINES[3], prose('en', 7005, 60)].join(' ');

// ── the brute-force FAMILY_GUARD artifact over the library ──────────────────
// The shape lib/selective-corpus/verify.ts reads: a stop set and a postings accessor. Every call each
// verifier path makes on it is logged, so "same result" can be tightened to "same reads, same order".
const holdersByHash = new Map();
[...library.values()].forEach((text, ordinal) => {
  for (const hex of selectiveCorpusDocumentHashes(text)) {
    const list = holdersByHash.get(hex);
    if (list) list.push(ordinal);
    else holdersByHash.set(hex, [ordinal]);
  }
});
const stopHexes = new Set([...holdersByHash].filter(([, list]) => list.length >= SELECTIVE_CORPUS_STOP_DF).map(([hex]) => hex));
const COLLECTOR = { marker: 'the calling evaluation\'s failure collector' };

function recordingArtifact() {
  const log = [];
  class LoggedStopHashes extends Set {
    has(hex) {
      const answer = stopHexes.has(hex);
      log.push(['stop', hex, answer]);
      return answer;
    }
  }
  return {
    log,
    artifact: {
      stopHashes: new LoggedStopHashes(),
      postingsAccessor: {
        async getPostings(hex, collector) {
          log.push(['postings', hex, collector === COLLECTOR]);
          if (stopHexes.has(hex)) return undefined;
          const list = holdersByHash.get(hex);
          return list ? Uint32Array.from(list) : undefined;
        },
        getStats() {
          return {};
        },
      },
    },
  };
}

// ── the comparison ──────────────────────────────────────────────────────────
const census = {};
const bump = (key, by = 1) => {
  census[key] = (census[key] ?? 0) + by;
};
const sameBytes = (left, right, message) => assert.equal(JSON.stringify(left), JSON.stringify(right), message);
const snapshot = (prepared) => JSON.stringify({ identity: prepared.identity, words: prepared.words, canonical: prepared.canonicalSha256, hashes: prepared.informativeHashes, shingles: [...prepared.shingles] });

/**
 * One submission, prepared ONCE, against each candidate in turn — the way the adapter uses it. All three
 * layers are compared for every pair, under whatever scoring normalization is in force.
 */
async function assertPreparedEqualsOracle(name, submission, candidates) {
  const prepared = prepareSubmissionForVerification(submission);
  const words = selectiveCorpusSubmissionWords(submission);

  // The prepared submission is exactly what the oracle derives from the submission, and nothing else.
  assert.deepStrictEqual([...prepared.words], tokens(submission), `${name}: words`);
  assert.equal(prepared.canonicalSha256, canonicalSha256(submission), `${name}: canonical hash`);
  assert.deepStrictEqual([...prepared.shingles], [...documentShingleHashes(submission, 5)], `${name}: shingle set, in insertion order`);
  assert.deepStrictEqual([...prepared.informativeHashes], grams(words, 5).map((gram) => (informativeGram(gram) ? gramHash(gram) : null)), `${name}: per-position hashes`);
  assert.deepStrictEqual(prepared.identity, { normalizationVersion: currentScoringNormalizationVersion(), shingleSize: 5, thresholdsVersion: 'document-correspondence-thresholds-v1' });
  assert.equal(prepared.thresholds, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS);
  assert.equal(prepared.submissionText, submission);
  assert.deepStrictEqual(Object.keys(prepared).sort(), ['canonicalSha256', 'identity', 'informativeHashes', 'shingles', 'submissionText', 'thresholds', 'words']);
  const before = snapshot(prepared);

  for (const [label, candidate] of candidates) {
    const where = `${name} vs ${label}`;
    const oracleCorrespondence = computeDocumentCorrespondence(submission, candidate);
    const preparedCorrespondence = correspondPreparedSubmission(prepared, candidate);
    assert.deepStrictEqual(preparedCorrespondence, oracleCorrespondence, `${where}: correspondence`);
    sameBytes(preparedCorrespondence, oracleCorrespondence, `${where}: correspondence, serialized`);

    const oracleComparison = compareSubmissionToExternalText(submission, candidate);
    const preparedComparison = comparePreparedSubmissionToCandidate(prepared, candidate);
    assert.deepStrictEqual(preparedComparison, oracleComparison, `${where}: comparison`);
    sameBytes(preparedComparison, oracleComparison, `${where}: comparison, serialized`);

    const oracleArtifact = recordingArtifact();
    const preparedArtifact = recordingArtifact();
    const oracleAdmission = await admitSelectiveCorpusCandidate(submission, words, candidate, oracleArtifact.artifact, COLLECTOR);
    const preparedAdmission = await verifyPreparedSubmissionAgainstCandidate(prepared, candidate, preparedArtifact.artifact, COLLECTOR);
    assert.deepStrictEqual(preparedAdmission, oracleAdmission, `${where}: admission`);
    sameBytes(preparedAdmission, oracleAdmission, `${where}: admission, serialized`);
    assert.deepStrictEqual(preparedArtifact.log, oracleArtifact.log, `${where}: FAMILY_GUARD read the artifact differently`);

    // ── census, from the ORACLE's result ──
    bump('pairs');
    bump(`language:${name.split(':')[0]}`);
    if (oracleCorrespondence.submittedWordCount === 0 || oracleCorrespondence.externalWordCount === 0) bump('emptyText');
    else if (oracleCorrespondence.method === 'canonical_hash') bump('exactCanonical');
    else if (oracleCorrespondence.overlapSharedShingleCount === 0) bump('noSharedShingle');
    else bump('sharedShingles');
    const spanCount = oracleCorrespondence.allMatchedPassages.length;
    if (oracleComparison.matchedPassages.length > 0) bump('pairsWithMatchedPassages');
    bump('matchedPassages', oracleComparison.matchedPassages.length);
    if (spanCount > 1) bump('pairsWithDisjointPassages');
    if (spanCount > oracleCorrespondence.passages.length) bump('pairsOverThePreviewPassageCap');
    if (oracleCorrespondence.allMatchedPassages.some((passage) => passage.matchedWordCount > DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.maxPassageWords)) bump('pairsWithATruncatedPreview');
    if (oracleCorrespondence.allMatchedPassages.some((passage) => passage.matchedWordCount === DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.minimumPassageLengthWords)) bump('pairsWithAMinimumLengthPassage');
    if (oracleCorrespondence.strongCorrespondence) bump('strongCorrespondence');
    if (oracleComparison.exactMatch && oracleComparison.matchedPassages.length === 1) bump('exactMatchSynthesizedPassage');
    if (!oracleAdmission.strictSpanPass) bump(oracleAdmission.spans.length === 0 ? 'strictSpanFailWithoutSpans' : 'strictSpanFailWithSpans');
    else if (!oracleAdmission.familyGuardActivated) bump('admittedDominantSpanNotShared');
    else if (oracleAdmission.admitted) bump('admittedOnSourceSpecificWords');
    else bump('suppressedByFamilyGuard');
    if (oracleAdmission.strictSpanPass && !oracleAdmission.dominantSpanBoilerplate && oracleAdmission.sourceSpecificWords < oracleAdmission.totalMatchedWords) bump('admittedWithASharedSecondarySpan');
    if (oracleArtifact.log.some(([kind]) => kind === 'postings')) bump('pairsThatReadPostings');
    if (oracleArtifact.log.some(([kind, , answer]) => kind === 'stop' && answer)) bump('pairsThatMetAStopHash');
  }
  assert.equal(snapshot(prepared), before, `${name}: verifying a candidate changed the prepared submission`);
}

// ── the engine, end to end: a real generation built from the library ────────
const scratch = corpusEngineScratch('prepared-verifier');
const root = path.join(scratch, 'corpus');
const built = await runCorpusBuild(
  { corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 2, runBufferTuples: 20_000 },
  [new InMemorySourceAdapter('fixture', [...library].map(([id, text]) => fixtureSource(id, text)))],
);
const store = new LocalDirectoryObjectStore(root);
const reader = await CorpusGenerationReader.open({ store, generationId: built.generationId });
const everyDocument = [...reader.allDocumentIds()];
const docIdOf = (id) => deriveDocId(normalizeForCorpus(doc(id)).normalizedContentSha256);

test.after(async () => {
  await store.close();
  removeScratch(scratch);
});

// Submissions reused by the direct comparison and by the engine run.
const host = (language, seed, count) => prose(language, 60_000 + seed, count);
const submissionX3PlusOwn = [host('en', 1, 200), take(BLOCKS.x3.text, 40, 150), host('en', 2, 120), take(ownText.get('x3-0').before, 30, 40), host('en', 3, 100)].join(' ');
const submissionX14 = [host('en', 4, 150), take(BLOCKS.x14.text, 20, 180), host('en', 5, 150)].join(' ');
const submissionManySources = [host('en', 6, 120), take(doc('en-5'), 100, 80), host('en', 7, 90), take(doc('fr-2'), 60, 80), host('fr', 8, 90), take(doc('ar-2'), 40, 80), host('ar', 9, 90), take(doc('inv-1'), 10, 80), host('en', 10, 120)].join(' ');
const longPieces = [];
for (let index = 0; index < 6; index += 1) {
  longPieces.push(host('en', 100 + index, 2050));
  longPieces.push(take(doc(['en-long-0', 'en-long-1', 'en-7', 'fr-3', 'ar-3', 'x5-2'][index]), 200, [400, 150, 90, 120, 120, 200][index]));
}
const submissionLong = [...longPieces, host('en', 199, 300)].join(' ');

// ── tests ───────────────────────────────────────────────────────────────────

test('the oracle is the file content this gate was proven against', () => {
  // prepared-verifier.ts restates statements of these three files. If one of them changes, the restatement
  // may no longer be equal in a way the cases below do not reach. Re-read the change, bring
  // prepared-verifier.ts into line, run this file, and only then update the hash.
  const pinned = {
    'lib/selective-corpus/verify.ts': 'd2688de36b1ea5186d26c44c1b561f96806d8513cbb86d5d2c5c88ba115b53cf',
    'lib/academic-search/comparator.ts': '82e3923921abf3a0c648a833f09952bacb842bdedb0eb3f7f43df9f21e87ac85',
    'lib/document-correspondence.ts': '7975414cf04a13d329fbe809c173af100e6715462aae33402bd472050e60af43',
  };
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const [file, expected] of Object.entries(pinned)) {
    // line endings are normalized so a checkout's CRLF/LF setting cannot move the hash
    const source = fs.readFileSync(path.join(repository, file), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(crypto.createHash('sha256').update(source, 'utf8').digest('hex'), expected, `${file} changed: re-prove the prepared verifier against it before updating this hash`);
  }
});

test('no match: unrelated text in the same language, in another script, and degenerate candidates', async () => {
  const degenerate = [
    ['empty', ''],
    ['whitespace', ' \n\t  '],
    ['punctuation', '... --- !!! (?) « » ،؛'],
    ['four words', 'glacier sediment erosion climate'],
    ['function words only', functionWordsOnly('en', 71, 200)],
  ];
  const unrelated = fromLibrary('en-1', 'en-2', 'fr-0', 'fr-1', 'ar-0', 'ar-1', 'inv-0');
  await assertPreparedEqualsOracle('en:no-match', prose('en', 801, 700), [...unrelated, ...degenerate]);
  await assertPreparedEqualsOracle('fr:no-match', prose('fr', 802, 700), [...unrelated, ...degenerate]);
  await assertPreparedEqualsOracle('ar:no-match', prose('ar', 803, 700), [...unrelated, ...degenerate]);
  await assertPreparedEqualsOracle('en:no-match-invented', inventedText(804, 700), [...unrelated, ...degenerate]);
  // degenerate SUBMISSIONS: nothing to prepare, a submission shorter than one 5-gram, and no informative gram at all
  for (const [label, text] of degenerate) await assertPreparedEqualsOracle(`en:degenerate-submission(${label})`, text, [...fromLibrary('en-1', 'ar-0'), ...degenerate]);
});

test('exact and near-exact copies: the canonical-hash branch, and the same words under a different canonical text', async () => {
  const sources = [
    ['en', 'en-0', doc('en-0')],
    ['fr', 'fr-0', doc('fr-0')],
    ['ar', 'ar-0', doc('ar-0')],
    ['en', 'inv-0', doc('inv-0')],
    ['en', 'probe', NORMALIZATION_PROBE_TEXT],
    ['en', 'with-references', withReferences('en', prose('en', 811, 400))],
    ['en', 'function-words-only', functionWordsOnly('en', 812, 200)],
    ['en', 'four-words', 'glacier sediment erosion climate'],
  ];
  for (const [language, id, text] of sources) {
    await assertPreparedEqualsOracle(`${language}:exact(${id})`, text, [
      ['identical', text],
      ['respaced, CRLF', `  ${text.replace(/ /g, '  \t').replace(/\n/g, '\r\n')} \r\n`],
      ['NFD', text.normalize('NFD')],
      ['zero-width space inside words', insideWords(text, 7, '​')],
      ['soft hyphen inside words', insideWords(text, 5, '­')],
      ['upper case', text.toUpperCase()],
      ['other punctuation', text.replace(/,/g, ' ;').replace(/\./g, ' !')],
      ['with a tail', `${text} ${inventedText(813, 30)}`],
      ['first half', take(text, 0, Math.floor(wordsOf(text).length / 2))],
    ]);
  }
});

test('one copied passage, at every length around the verifier\'s own thresholds', async () => {
  // 8 = minimum passage, 25 = STRICT_SPAN longest span, 60 = STRICT_SPAN matched words and the preview bound
  for (const length of [4, 7, 8, 9, 12, 24, 25, 26, 40, 59, 60, 61, 64, 90, 130, 300]) {
    const submission = [host('en', 20, 250), take(doc('en-7'), 100, length), host('en', 21, 250)].join(' ');
    await assertPreparedEqualsOracle(`en:passage-${length}`, submission, fromLibrary('en-7', 'en-3'));
  }
  for (const [language, source] of [['fr', 'fr-3'], ['ar', 'ar-3']]) {
    for (const length of [12, 25, 60, 66, 90]) {
      const submission = [host(language, 22, 200), take(doc(source), 80, length), host(language, 23, 200)].join(' ');
      await assertPreparedEqualsOracle(`${language}:passage-${length}`, submission, fromLibrary(source, `${language}-1`));
    }
  }
});

test('several disjoint passages, from one source and from several', async () => {
  const from = (id, start, count) => take(doc(id), start, count);
  const alternate = (pieces) => pieces.map((piece, index) => `${host('en', 300 + index, 45)} ${piece}`).join(' ');
  const cases = {
    'two spans, 30 + 35': alternate([from('en-6', 20, 30), from('en-6', 200, 35)]),
    'four spans of 20': alternate([from('en-6', 20, 20), from('en-6', 120, 20), from('en-6', 220, 20), from('en-6', 320, 20)]),
    'one long span and ten short': alternate([from('en-6', 20, 65), ...Array.from({ length: 10 }, (_, index) => from('en-6', 120 + index * 40, 12))]),
    'fourteen spans of 15': alternate(Array.from({ length: 14 }, (_, index) => from('en-7', index * 50, 15))),
    'adjacent passages, out of source order': `${host('en', 320, 80)} ${from('en-6', 300, 40)} ${from('en-6', 100, 40)} ${host('en', 321, 80)}`,
    'the same passage eight times': Array.from({ length: 8 }, (_, index) => `${host('en', 330 + index, 30)} ${from('en-6', 150, 40)}`).join(' '),
  };
  for (const [label, submission] of Object.entries(cases)) {
    await assertPreparedEqualsOracle(`en:${label}`, submission, fromLibrary('en-6', 'en-7', 'en-2', 'inv-2'));
  }
  await assertPreparedEqualsOracle('mixed:four sources in three languages', submissionManySources, fromLibrary('en-5', 'fr-2', 'ar-2', 'inv-1', 'en-4', 'fr-1', 'ar-1'));
});

test('edited passages: a changed word every n words fragments the match', async () => {
  for (const every of [9, 12, 40]) {
    const submission = [host('en', 40, 150), editEvery(take(doc('en-5'), 60, 200), every, `edit${every}x`), host('en', 41, 150)].join(' ');
    await assertPreparedEqualsOracle(`en:edited-every-${every}`, submission, fromLibrary('en-5', 'en-4'));
  }
});

test('FAMILY_GUARD: shared-family spans, stop hashes, source-specific admission and suppression', async () => {
  const own = (id, start, count) => take(ownText.get(id).before, start, count);
  const cases = [
    ['en:family of 2', [host('en', 50, 150), take(BLOCKS.x2.text, 40, 150), host('en', 51, 150)].join(' '), [...holdersOf('x2'), 'en-1']],
    ['en:family of 3', [host('en', 52, 150), take(BLOCKS.x3.text, 40, 150), host('en', 53, 150)].join(' '), [...holdersOf('x3'), 'en-1']],
    ['en:family of 3 + 40 own words', submissionX3PlusOwn, holdersOf('x3')],
    ['en:family of 3 + 20 own words', [host('en', 54, 200), take(BLOCKS.x3.text, 40, 150), host('en', 55, 120), own('x3-0', 30, 20), host('en', 56, 100)].join(' '), holdersOf('x3')],
    ['en:family of 3 + 25 own words', [host('en', 57, 200), take(BLOCKS.x3.text, 40, 150), host('en', 58, 120), own('x3-1', 60, 29), host('en', 59, 100)].join(' '), holdersOf('x3')],
    ['en:family of 5', [host('en', 60, 150), take(BLOCKS.x5.text, 30, 200), host('en', 61, 150)].join(' '), [...holdersOf('x5'), 'x3-0']],
    ['en:family of 14 (stop hashes)', submissionX14, [...holdersOf('x14'), 'inv-0']],
    ['en:own text dominant, family span second', [host('en', 62, 100), take(BLOCKS.x14.text, 20, 100), host('en', 63, 100), own('x14-0', 5, 160), host('en', 64, 100)].join(' '), ['x14-0', 'x14-1', 'x14-2']],
    ['en:two short family spans', [host('en', 65, 150), take(BLOCKS.x3.text, 10, 32), host('en', 66, 150), take(BLOCKS.x3.text, 180, 34), host('en', 67, 150)].join(' '), holdersOf('x3')],
    ['fr:family of 3', [host('fr', 68, 150), take(BLOCKS.f3.text, 30, 150), host('fr', 69, 150)].join(' '), [...holdersOf('f3'), 'fr-1']],
    ['ar:family of 3', [host('ar', 70, 150), take(BLOCKS.a3.text, 30, 150), host('ar', 71, 150)].join(' '), [...holdersOf('a3'), 'ar-1']],
    ['fr:family of 3 + 40 own words', [host('fr', 72, 200), take(BLOCKS.f3.text, 30, 150), host('fr', 73, 120), own('f3-1', 30, 40), host('fr', 74, 100)].join(' '), holdersOf('f3')],
    ['ar:family of 3 + 40 own words', [host('ar', 75, 200), take(BLOCKS.a3.text, 30, 150), host('ar', 76, 120), own('a3-2', 30, 40), host('ar', 77, 100)].join(' '), holdersOf('a3')],
    ['en:family of 5 + 60 own words', [host('en', 78, 200), take(BLOCKS.x5.text, 30, 200), host('en', 79, 120), own('x5-3', 20, 60), host('en', 86, 100)].join(' '), holdersOf('x5')],
    ['en:own text dominant over a family of 3', [host('en', 87, 100), take(BLOCKS.x3.text, 20, 100), host('en', 88, 100), own('x3-2', 5, 160), host('en', 89, 100)].join(' '), holdersOf('x3')],
    ['fr:own text dominant over a family of 3', [host('fr', 92, 100), take(BLOCKS.f3.text, 20, 90), host('fr', 93, 100), own('f3-0', 5, 150), host('fr', 94, 100)].join(' '), holdersOf('f3')],
    ['en:a whole family document', doc('x3-1'), holdersOf('x3')],
    ['en:a whole stop-hash family document', doc('x14-3'), ['x14-3', 'x14-4', 'x14-9']],
  ];
  for (const [name, submission, candidateIds] of cases) await assertPreparedEqualsOracle(name, submission, fromLibrary(...candidateIds));
});

test('reference sections: stripped from whichever side carries one, and only when it is terminal', async () => {
  for (const language of ['en', 'fr', 'ar']) {
    const body = prose(language, 900, 420);
    const list = referenceList(language);
    const submission = withReferences(language, body);
    assert.ok(comparisonText(submission).length < submission.length, `${language}: the fixture's reference section is not recognized`);
    assert.equal(comparisonText(list), list, `${language}: a bare list has no heading and is not a reference section`);
    await assertPreparedEqualsOracle(`${language}:references, terminal`, submission, [
      ['the same reference list, bare', list],
      ['another document citing the same works', withReferences(language, prose(language, 901, 420))],
      ['the same body, no references', body],
      ['the same body and references', `${withReferences(language, body)}\n`],
    ]);
    // the list copied into the BODY of a submission that has no heading is ordinary text, and it matches
    await assertPreparedEqualsOracle(`${language}:reference list as body text`, `${prose(language, 902, 150)}\n${list}\n${prose(language, 903, 600)}`, [
      ['the same reference list, bare', list],
      ['a document whose references section holds that list', withReferences(language, prose(language, 904, 420))],
    ]);
  }
  // a heading in the first half of the document is not a reference section: nothing is stripped
  const early = `${prose('en', 905, 60)}\n\nReferences\n${referenceList('en')}\n\n${prose('en', 906, 700)}`;
  assert.equal(comparisonText(early), early);
  await assertPreparedEqualsOracle('en:references, not terminal', early, [['the same reference list, bare', referenceList('en')], ...fromLibrary('en-2')]);
});

test('duplicate and common text: repeated grams, function-word runs, a shared sentence pool', async () => {
  const pool = Array.from({ length: 30 }, (_, index) => prose('en', 950 + index, 14 + (index % 5)));
  const pooled = (seed, count) => {
    const random = prng(seed);
    return Array.from({ length: count }, () => pool[Math.floor(random() * pool.length)]).join(' ');
  };
  const candidates = [['pool document A', pooled(1, 40)], ['pool document B', pooled(2, 40)], ['pool document C', pooled(3, 25)], ...fromLibrary('en-3')];
  await assertPreparedEqualsOracle('en:sentence pool', pooled(4, 60), candidates);
  await assertPreparedEqualsOracle('en:one sentence, forty times', Array.from({ length: 40 }, () => pool[0]).join(' '), candidates);
  const commonRun = functionWordsOnly('en', 960, 120);
  await assertPreparedEqualsOracle('en:copied function-word run', `${host('en', 80, 200)} ${commonRun} ${host('en', 81, 200)}`, [['the run inside other text', `${prose('en', 961, 200)} ${commonRun} ${prose('en', 962, 200)}`], ['the run alone', commonRun]]);
  await assertPreparedEqualsOracle('fr:copied function-word run', `${host('fr', 82, 200)} ${functionWordsOnly('fr', 963, 120)} ${host('fr', 83, 200)}`, [['the run alone', functionWordsOnly('fr', 963, 120)]]);
  await assertPreparedEqualsOracle('ar:copied function-word run', `${host('ar', 84, 200)} ${functionWordsOnly('ar', 964, 120)} ${host('ar', 85, 200)}`, [['the run alone', functionWordsOnly('ar', 964, 120)]]);
});

test('normalization specials, under each scoring-normalization contract', async () => {
  const variants = [
    ['identical', specialDocument],
    ['invisible format characters removed', stripScoringIgnorableFormatCharacters(specialDocument)],
    ['NFKC', specialDocument.normalize('NFKC')],
    ['NFD', specialDocument.normalize('NFD')],
    ['combining marks removed', specialDocument.normalize('NFD').replace(/\p{M}/gu, '')],
    ['upper case', specialDocument.toUpperCase()],
    ['lower case', specialDocument.toLowerCase()],
    ['soft hyphens inside words', insideWords(specialDocument, 3, '­')],
    ['word joiners and bidi marks inside words', insideWords(specialDocument, 4, '⁠‏')],
    ['tatweel removed', specialDocument.replace(/ـ/g, '')],
  ];
  for (const version of [2, 1]) {
    await runWithScoringNormalization(version, async () => {
      assert.equal(currentScoringNormalizationVersion(), version);
      await assertPreparedEqualsOracle(`mixed:specials under v${version}`, specialDocument, variants);
      await assertPreparedEqualsOracle(`mixed:soft-hyphenated submission under v${version}`, insideWords(specialDocument, 3, '­'), variants);
      await assertPreparedEqualsOracle(`en:plain passage under v${version}`, [host('en', 90, 150), take(doc('en-5'), 60, 120), host('en', 91, 150)].join(' '), fromLibrary('en-5', 'ar-2'));
    });
  }
  // the two contracts really do tokenize this text differently, so both runs above were distinct cases
  assert.notEqual(runWithScoringNormalization(1, () => tokens(specialDocument).length), runWithScoringNormalization(2, () => tokens(specialDocument).length));
});

test('a long submission: about thirteen thousand words against sources of every size', async () => {
  assert.ok(tokens(submissionLong).length > 12_500 && tokens(submissionLong).length < 14_500, `${tokens(submissionLong).length} tokens`);
  await assertPreparedEqualsOracle('en:long submission', submissionLong, fromLibrary('en-long-0', 'en-long-1', 'en-7', 'fr-3', 'ar-3', 'x5-2', 'x5-0', 'en-0', 'inv-3', 'ar-1'));
});

test('thresholds other than the defaults: the comparison layers stay equal, and admission refuses them', async () => {
  const generic = 'this study presented further analysis of the research findings described within the following section and these results were reported throughout the related sections using the standard procedure noted above with additional material from prior work taken during the general review process';
  const submission = [host('en', 95, 120), take(doc('en-6'), 100, 90), host('en', 96, 120), generic, host('en', 97, 120)].join(' ');
  const candidates = [...fromLibrary('en-6', 'en-2'), ['generic register passage', `${prose('en', 970, 150)} ${generic} ${prose('en', 971, 150)}`], ['identical', submission], ['empty', '']];
  const variations = [
    { shingleSize: 3, minimumPassageLengthWords: 3 },
    { shingleSize: 7, strongContainmentThreshold: 0.05, minimumMatchedWords: 5 },
    { maxPassages: 1, maxPassageWords: 10 },
    { minimumDistinctivePassageWords: 30 },
    { minimumDistinctivePassageWords: 30, minimumPassageLengthWords: 20 },
  ];
  let distinctive = 0;
  let longButGeneric = 0;
  for (const variation of variations) {
    const thresholds = { ...DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS, ...variation };
    const prepared = prepareSubmissionForVerification(submission, thresholds);
    assert.equal(prepared.identity.shingleSize, thresholds.shingleSize);
    assert.deepStrictEqual([...prepared.shingles], [...documentShingleHashes(submission, thresholds.shingleSize)]);
    for (const [label, candidate] of candidates) {
      const oracle = computeDocumentCorrespondence(submission, candidate, thresholds);
      const fromPrepared = correspondPreparedSubmission(prepared, candidate);
      assert.deepStrictEqual(fromPrepared, oracle, `${JSON.stringify(variation)} vs ${label}`);
      sameBytes(fromPrepared, oracle, `${JSON.stringify(variation)} vs ${label}, serialized`);
      assert.deepStrictEqual(comparePreparedSubmissionToCandidate(prepared, candidate), compareSubmissionToExternalText(submission, candidate, thresholds), `${JSON.stringify(variation)} vs ${label}: comparison`);
      bump('pairsUnderOtherThresholds');
      if (oracle.distinctivePassageMatch) distinctive += 1;
      else if (variation.minimumDistinctivePassageWords !== undefined && oracle.longestMatchWords >= variation.minimumDistinctivePassageWords) longButGeneric += 1;
    }
    // admitSelectiveCorpusCandidate has no thresholds parameter, so the prepared admission has no such contract either
    await assert.rejects(verifyPreparedSubmissionAgainstCandidate(prepared, candidates[0][1], recordingArtifact().artifact), (error) => error instanceof PreparedSubmissionContractError && error.code === 'PREPARED_THRESHOLDS_MISMATCH');
  }
  assert.ok(distinctive >= 1, 'no case reached distinctivePassageMatch');
  assert.ok(longButGeneric >= 1, 'no case reached a long span rejected as generic register');
});

test('a prepared submission cannot be used outside the contract it was prepared under', async () => {
  const submission = [host('en', 98, 150), take(doc('en-5'), 60, 120), host('en', 99, 150)].join(' ');
  const candidate = doc('en-5');
  const { artifact } = recordingArtifact();
  const prepared = prepareSubmissionForVerification(submission);
  assert.equal(prepared.identity.normalizationVersion, 2);

  // another scoring-normalization contract: the candidate would be tokenized differently than the submission was
  const underV1 = (run) => runWithScoringNormalization(1, run);
  const normalizationMismatch = (error) => error instanceof PreparedSubmissionContractError && error.code === 'PREPARED_NORMALIZATION_MISMATCH';
  assert.throws(() => underV1(() => correspondPreparedSubmission(prepared, candidate)), normalizationMismatch);
  assert.throws(() => underV1(() => comparePreparedSubmissionToCandidate(prepared, candidate)), normalizationMismatch);
  await assert.rejects(underV1(() => verifyPreparedSubmissionAgainstCandidate(prepared, candidate, artifact)), normalizationMismatch);
  assert.throws(() => underV1(() => assertPreparedSubmissionForAdmission(prepared, submission)), normalizationMismatch);
  // and the reverse
  const preparedV1 = underV1(() => prepareSubmissionForVerification(submission));
  assert.equal(preparedV1.identity.normalizationVersion, 1);
  assert.throws(() => correspondPreparedSubmission(preparedV1, candidate), normalizationMismatch);
  assert.doesNotThrow(() => underV1(() => correspondPreparedSubmission(preparedV1, candidate)));

  // thresholds whose shingle size is changed after preparation no longer describe the hashes that were derived
  const thresholds = { ...DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS };
  const drifting = prepareSubmissionForVerification(submission, thresholds);
  thresholds.shingleSize = 4;
  assert.throws(() => correspondPreparedSubmission(drifting, candidate), (error) => error instanceof PreparedSubmissionContractError && error.code === 'PREPARED_SHINGLE_SIZE_MISMATCH');

  // a prepared submission handed to a caller must be the one for the text being verified
  assert.doesNotThrow(() => assertPreparedSubmissionForAdmission(prepared, submission));
  assert.throws(() => assertPreparedSubmissionForAdmission(prepared, `${submission} `), (error) => error instanceof PreparedSubmissionContractError && error.code === 'PREPARED_SUBMISSION_MISMATCH');
  assert.equal(DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.shingleSize, 5, 'a test changed the shared default thresholds');
});

// ── the adapter, over a real generation ─────────────────────────────────────
const untimedAdmission = ({ textReadMs, textDecodeMs, verifyMs, ...rest }) => rest;
const untimedResult = ({ totals, verifierPath, ...rest }) => ({ ...rest, bytes: [totals.textCompressedBytesRead, totals.textDecompressedBytes] });

// The release candidate's FAMILY_GUARD is the policy this gate proves the prepared path against
// (admitSelectiveCorpusCandidate is its oracle); the engine's default family policy is checked separately below.
const GUARD_V1 = { familyPolicy: FAMILY_ADMISSION_POLICY_GUARD_V1 };

test('engine: every document of a generation, admitted on both paths, gives the same admissions and the same final result', async () => {
  assert.equal(everyDocument.length, library.size);
  for (const [name, submission] of [['family + own words', submissionX3PlusOwn], ['stop-hash family', submissionX14], ['four sources, three languages', submissionManySources]]) {
    const oracle = await admitCandidates(reader, submission, everyDocument, undefined, { verifierPath: 'oracle', ...GUARD_V1 });
    const prepared = await admitCandidates(reader, submission, everyDocument, undefined, { verifierPath: 'prepared-submission', ...GUARD_V1 });
    assert.equal(oracle.verifierPath, 'oracle');
    assert.equal(prepared.verifierPath, 'prepared-submission');
    assert.equal(oracle.prepareMs, 0);
    assert.ok(prepared.prepareMs > 0);
    assert.equal(prepared.submissionWordCount, oracle.submissionWordCount);
    assert.deepStrictEqual(prepared.identity, oracle.identity);
    assert.deepStrictEqual(prepared.failures, oracle.failures);
    assert.deepStrictEqual(prepared.admissions.map(untimedAdmission), oracle.admissions.map(untimedAdmission), name);
    assert.equal(oracle.admissions.length, everyDocument.length);
    assert.ok(oracle.admissions.every((admission) => admission.outcome === 'ADMITTED' || admission.outcome === 'NOT_ADMITTED'));

    const oracleFinal = finalizeVerification(oracle.identity, oracle.submissionWordCount, oracle.admissions, oracle.failures, oracle);
    const preparedFinal = finalizeVerification(prepared.identity, prepared.submissionWordCount, prepared.admissions, prepared.failures, prepared);
    assert.deepStrictEqual(untimedResult(preparedFinal), untimedResult(oracleFinal), name);
    assert.equal(oracleFinal.state, 'COMPLETE');
    // every case reaches the gates; the stop-hash family is the one FAMILY_GUARD suppresses entirely
    assert.ok(oracle.admissions.some((admission) => admission.strictSpanPass), `${name}: no candidate reached FAMILY_GUARD`);
    assert.equal(oracleFinal.matchedWordCount > 0, name !== 'stop-hash family', `${name}: matched ${oracleFinal.matchedWordCount} words`);
    assert.equal(oracleFinal.verifierPath, 'oracle');
    assert.equal(preparedFinal.verifierPath, 'prepared-submission');
    assert.equal(oracleFinal.totals.prepareMs, 0);
    assert.equal(preparedFinal.totals.prepareMs, prepared.prepareMs);
    bump('enginePairs', everyDocument.length);
    bump('engineAdmitted', oracle.admissions.filter((admission) => admission.outcome === 'ADMITTED').length);
    bump('engineFamilyGuardActivations', oracleFinal.familyGuardActivations);

    // the same equality under the engine's default family policy (the unmodified comparator on the oracle path)
    const oracleV2 = await admitCandidates(reader, submission, everyDocument, undefined, { verifierPath: 'oracle', familyPolicy: FAMILY_ADMISSION_POLICY_AWARE_V2 });
    const preparedV2 = await admitCandidates(reader, submission, everyDocument, undefined, { verifierPath: 'prepared-submission', familyPolicy: FAMILY_ADMISSION_POLICY_AWARE_V2 });
    assert.deepStrictEqual(preparedV2.admissions.map(untimedAdmission), oracleV2.admissions.map(untimedAdmission), `${name} (v2)`);
    assert.deepStrictEqual(
      untimedResult(finalizeVerification(preparedV2.identity, preparedV2.submissionWordCount, preparedV2.admissions, preparedV2.failures, preparedV2)),
      untimedResult(finalizeVerification(oracleV2.identity, oracleV2.submissionWordCount, oracleV2.admissions, oracleV2.failures, oracleV2)),
      `${name} (v2)`,
    );
  }
});

test('engine: retrieval -> verification is identical on both paths, and the prepared path is the default', async () => {
  assert.equal(DEFAULT_VERIFIER_PATH, 'prepared-submission');
  for (const [name, submission, budget] of [['long submission', submissionLong, 25], ['family + own words', submissionX3PlusOwn, 10], ['four sources, three languages', submissionManySources, 20]]) {
    const retrieval = await retrieveCandidates(reader, submission, { candidateBudget: budget });
    assert.equal(retrieval.state, 'COMPLETE');
    const candidates = retrieval.candidates.map((candidate) => candidate.docId);
    assert.ok(candidates.length >= 3, `${name}: only ${candidates.length} candidates`);
    const oracle = await verifyCandidatesWithExistingVerifier(reader, submission, candidates, { verifierPath: 'oracle' });
    const prepared = await verifyCandidatesWithExistingVerifier(reader, submission, candidates, { verifierPath: 'prepared-submission' });
    const byDefault = await verifyCandidatesWithExistingVerifier(reader, submission, candidates);
    assert.deepStrictEqual(untimedResult(prepared), untimedResult(oracle), name);
    assert.deepStrictEqual(untimedResult(byDefault), untimedResult(oracle), name);
    assert.equal(byDefault.verifierPath, 'prepared-submission');
    assert.equal(oracle.verifierPath, 'oracle');
    assert.ok(oracle.verifiedSources.length >= 1, `${name}: no source verified`);
    bump('enginePairs', candidates.length);
  }
  // the application entry point takes the default path too
  const original = process.env[CORPUS_ENGINE_V1_FLAG];
  try {
    process.env[CORPUS_ENGINE_V1_FLAG] = 'true';
    const response = await runCorpusEngineCandidateVerification({ store, generationId: built.generationId, submissionText: submissionManySources, rankingPolicy: { candidateBudget: 20 } });
    assert.equal(response.state, 'COMPLETE');
    assert.equal(response.verification.verifierPath, 'prepared-submission');
    const oracle = await verifyCandidatesWithExistingVerifier(reader, submissionManySources, response.retrieval.candidates.map((candidate) => candidate.docId), { verifierPath: 'oracle' });
    assert.deepStrictEqual(untimedResult(response.verification), untimedResult(oracle));
  } finally {
    if (original === undefined) delete process.env[CORPUS_ENGINE_V1_FLAG];
    else process.env[CORPUS_ENGINE_V1_FLAG] = original;
  }
});

test('engine: the submission is normalized once per query on the prepared path, and three times per candidate on the oracle path', async () => {
  const submission = submissionManySources;
  const candidateIds = ['en-5', 'fr-2', 'ar-2', 'inv-1', 'en-4', 'fr-1', 'ar-1', 'en-0', 'x3-0', 'x14-5'];
  const candidates = candidateIds.map(docIdOf);
  // the submission is recognized among all normalize() calls by its length: no reference section, no candidate as long
  assert.equal(comparisonText(submission), submission);
  assert.ok(candidateIds.every((id) => doc(id).length !== submission.length));
  const normalizationsOfTheSubmission = async (verifierPath) => {
    const original = String.prototype.normalize;
    const calls = { NFKD: 0, NFC: 0 };
    String.prototype.normalize = function countingNormalize(form) {
      if (this.length === submission.length) calls[form] += 1;
      return original.call(this, form);
    };
    try {
      const pass = await admitCandidates(reader, submission, candidates, undefined, { verifierPath });
      assert.equal(pass.admissions.filter((admission) => admission.outcome === 'ADMITTED' || admission.outcome === 'NOT_ADMITTED').length, candidates.length);
    } finally {
      String.prototype.normalize = original;
    }
    return calls;
  };
  // NFKD = tokens() (the scoring normalization); NFC = canonicalizeText() inside canonicalSha256()
  assert.deepStrictEqual(await normalizationsOfTheSubmission('oracle'), { NFKD: 1 + 3 * candidates.length, NFC: candidates.length });
  assert.deepStrictEqual(await normalizationsOfTheSubmission('prepared-submission'), { NFKD: 1, NFC: 1 });
});

test('engine: a prepared submission handed to a pass is used as is, and refused if it belongs to another text', async () => {
  const submission = submissionX3PlusOwn;
  const candidates = holdersOf('x3').map(docIdOf);
  const own = await admitCandidates(reader, submission, candidates, undefined, GUARD_V1);
  const failures = [];
  const artifact = createVerifierArtifactView(reader, failures);
  const preparedSubmission = prepareSubmissionForVerification(submission);
  const shared = await admitCandidates(reader, submission, candidates, { artifact, failures, preparedSubmission }, GUARD_V1);
  assert.equal(shared.prepareMs, 0, 'the pass prepared the submission again');
  assert.deepStrictEqual(shared.admissions.map(untimedAdmission), own.admissions.map(untimedAdmission));
  assert.deepStrictEqual(own.admissions.map((admission) => admission.outcome), ['ADMITTED', 'NOT_ADMITTED', 'NOT_ADMITTED']);
  assert.deepStrictEqual(own.admissions.map((admission) => admission.familyGuardActivated), [true, true, true]);
  // on the oracle path a handed-in prepared submission is simply not used
  const oracle = await admitCandidates(reader, submission, candidates, { artifact, failures, preparedSubmission }, { verifierPath: 'oracle', ...GUARD_V1 });
  assert.deepStrictEqual(oracle.admissions.map(untimedAdmission), own.admissions.map(untimedAdmission));
  assert.deepStrictEqual(failures, []);

  const wrongFailures = [];
  const wrong = await admitCandidates(reader, submissionX14, candidates, { artifact: createVerifierArtifactView(reader, wrongFailures), failures: wrongFailures, preparedSubmission });
  assert.deepStrictEqual(wrong.admissions, []);
  assert.equal(wrong.failures[0].stage, 'contract');
  assert.equal(wrong.failures[0].code, 'PREPARED_SUBMISSION_MISMATCH');
  assert.equal(finalizeVerification(wrong.identity, wrong.submissionWordCount, wrong.admissions, wrong.failures, wrong).state, 'FAILED');

  // no candidates: nothing is prepared, and the word count is still the submission's
  const none = await admitCandidates(reader, submission, []);
  assert.equal(none.prepareMs, 0);
  assert.equal(none.submissionWordCount, tokens(submission).length);
  assert.equal((await admitCandidates(reader, submission, [], undefined, { verifierPath: 'oracle' })).submissionWordCount, none.submissionWordCount);

  // a generation built under another normalization contract is refused before anything is prepared, on both paths
  for (const verifierPath of ['oracle', 'prepared-submission']) {
    const refused = await runWithScoringNormalization(1, () => verifyCandidatesWithExistingVerifier(reader, submission, candidates, { verifierPath }));
    assert.equal(refused.state, 'FAILED');
    assert.equal(refused.failures[0].code, 'NORMALIZATION_CONTRACT_MISMATCH');
    assert.equal(refused.totals.prepareMs, 0);
  }
});

test('census: every branch of the oracle was reached by the pairs above', () => {
  const atLeast = (key, minimum) => assert.ok((census[key] ?? 0) >= minimum, `${key}: ${census[key] ?? 0}, expected at least ${minimum} — census ${JSON.stringify(census)}`);
  atLeast('pairs', 350);
  atLeast('language:en', 200);
  atLeast('language:fr', 30);
  atLeast('language:ar', 30);
  atLeast('language:mixed', 30);
  // computeDocumentCorrespondence
  atLeast('emptyText', 20);
  atLeast('exactCanonical', 20);
  atLeast('noSharedShingle', 60);
  atLeast('sharedShingles', 150);
  atLeast('pairsWithMatchedPassages', 150);
  atLeast('pairsWithDisjointPassages', 40);
  atLeast('pairsOverThePreviewPassageCap', 3);
  atLeast('pairsWithATruncatedPreview', 60);
  atLeast('pairsWithAMinimumLengthPassage', 1);
  atLeast('strongCorrespondence', 20);
  // compareSubmissionToExternalText
  atLeast('exactMatchSynthesizedPassage', 20);
  // admitSelectiveCorpusCandidate
  atLeast('strictSpanFailWithoutSpans', 80);
  atLeast('strictSpanFailWithSpans', 15);
  atLeast('admittedDominantSpanNotShared', 60);
  atLeast('admittedOnSourceSpecificWords', 5);
  atLeast('suppressedByFamilyGuard', 15);
  atLeast('admittedWithASharedSecondarySpan', 3);
  atLeast('pairsThatReadPostings', 60);
  atLeast('pairsThatMetAStopHash', 10);
  atLeast('pairsUnderOtherThresholds', 25);
  // the adapter
  atLeast('enginePairs', 3 * library.size + 12);
  atLeast('engineAdmitted', 5);
  atLeast('engineFamilyGuardActivations', 10);
});
