import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../../lib/ai-core.ts";
import { LANGUAGE_DETECTOR_VERSION } from "../../lib/similarity-core.ts";

/**
 * Test helpers that build AI results in their REAL production shape: the real `buildAiTokenChunks` (240-token windows at
 * a 120-token stride, ~50 % overlap, anchored last window, decode + clean-up + trim) over a tokenizer, assembled exactly
 * the way app/ai-detector-worker.ts assembles its `complete` result. Only the per-window MODEL OUTPUTS are simulated
 * (deterministic; their digit counts, not values, drive size) — the structure that made the AI result ~2.4x the
 * manuscript (overlap, 13 fields per window, uncapped) is the real one, which the old non-overlapping fixture was not.
 *
 * Two tokenizers: the REAL ModernBERT tokenizer already cached in node_modules (loaded strictly offline — nothing is
 * ever downloaded — or `null` when it is not cached) and a deterministic, dependency-free pseudo-BPE stand-in for the
 * large-scale size tests. All text is synthetic or read from the developer's local gitignored corpora at run time;
 * none is embedded here.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MODEL_ID = "onnx-community/modernbert-ai-detection-raid-mage-ONNX";

let realTokenizerPromise = null;

/** The real ModernBERT tokenizer from node_modules' own cache, offline. `null` if it is not cached on this machine. */
export function loadRealModernBertTokenizer() {
  realTokenizerPromise ??= (async () => {
    const cacheRoot = path.join(REPO_ROOT, "node_modules", "@huggingface", "transformers", ".cache");
    const modelDir = path.join(cacheRoot, ...MODEL_ID.split("/"));
    if (!fs.existsSync(path.join(modelDir, "tokenizer.json")) || !fs.existsSync(path.join(modelDir, "tokenizer_config.json"))) return null;
    const tf = await import("@huggingface/transformers");
    tf.env.allowRemoteModels = false;
    tf.env.allowLocalModels = true;
    tf.env.localModelPath = `${cacheRoot}${path.sep}`;
    tf.env.useFSCache = false;
    return tf.AutoTokenizer.from_pretrained(MODEL_ID);
  })().catch(() => null);
  return realTokenizerPromise;
}

// transformers.js's `clean_up_tokenization`, which the real tokenizer runs on every decoded window (tokenizer_config.json
// sets clean_up_tokenization_spaces). Spelled out here independently of lib/ai-passage-table.ts's frozen copy — their
// equivalence to the REAL tokenizer is proven separately in tests/ai-passage-table.test.mjs.
const cleanUpTokenization = (text) => text
  .replace(/ \./g, ".").replace(/ \?/g, "?").replace(/ !/g, "!").replace(/ ,/g, ",").replace(/ ' /g, "'")
  .replace(/ n't/g, "n't").replace(/ 'm/g, "'m").replace(/ 's/g, "'s").replace(/ 've/g, "'ve").replace(/ 're/g, "'re");

/**
 * A deterministic, lossless stand-in tokenizer: pieces of up to four non-space characters, each with its one preceding
 * space (~3.5-4.3 characters per token, close to ModernBERT's ~4.2 on English). decode() is the exact concatenation —
 * followed by the tokenizer's clean-up step when asked, as the real one does — so windows are contiguous slices of the
 * text (edges split words mid-way, exactly as BPE windows do).
 */
export function pseudoBpeTokenizer() {
  const vocab = [];
  const index = new Map();
  const idOf = (piece) => {
    let id = index.get(piece);
    if (id === undefined) {
      id = vocab.length;
      vocab.push(piece);
      index.set(piece, id);
    }
    return id;
  };
  return {
    encode(text) {
      const ids = [];
      for (const match of text.matchAll(/\s?\S{1,4}|\s+/g)) ids.push(idOf(match[0]));
      return ids;
    },
    decode(ids, options = {}) {
      let out = "";
      for (const id of ids) out += vocab[id];
      return options.clean_up_tokenization_spaces ? cleanUpTokenization(out) : out;
    },
  };
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** Deterministic stand-in for the ONNX model's per-window output: a plausible human-range logOdds with some flagged windows. */
export function simulateSignals(count, seed = 900, flaggedRate = 0.03) {
  const random = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const centre = -2.6 + 0.6 * gauss();
  const signals = [];
  for (let i = 0; i < count; i += 1) {
    let logOdds = centre + 0.7 * gauss();
    if (random() < flaggedRate) logOdds = core.AI_PASSAGE_LOG_ODDS_THRESHOLD + Math.abs(gauss()) * 0.8;
    signals.push({ logOdds, probability: sigmoid(logOdds) });
  }
  return signals;
}

// The real calculateAiLogOddsDiagnostics spreads a per-token array into Math.max and throws RangeError above ~105k tokens
// (a separate, recorded finding — NOT fixed here). This loop clone is field-for-field identical (asserted against the real
// function wherever the real one survives) so the largest fixtures can still be assembled.
function diagnosticsLoop(chunks, threshold) {
  let totalWords = 0;
  for (const chunk of chunks) if (chunk.wordEnd > totalWords) totalWords = chunk.wordEnd;
  const wordLogOdds = new Array(totalWords).fill(Number.NEGATIVE_INFINITY);
  for (const chunk of chunks) for (let w = chunk.wordStart; w < chunk.wordEnd; w += 1) wordLogOdds[w] = Math.max(wordLogOdds[w], chunk.logOdds);
  let flaggedWords = 0;
  let probabilitySum = 0;
  let maxProbability = 0;
  for (let i = 0; i < totalWords; i += 1) {
    const value = wordLogOdds[i];
    if (core.isAiPassageFlagged(value, threshold)) flaggedWords += 1;
    const probability = Number.isFinite(value) ? core.probabilityFromLogOdds(value) : 0;
    probabilitySum += probability;
    if (probability > maxProbability) maxProbability = probability;
  }
  const meanProbability = totalWords === 0 ? 0 : probabilitySum / totalWords;
  return {
    totalWords,
    flaggedWords,
    percentFlagged: totalWords === 0 ? 0 : Math.round((flaggedWords / totalWords) * 100),
    meanProbability: Math.round(meanProbability * 1000) / 1000,
    maxProbability: Math.round(maxProbability * 1000) / 1000,
  };
}

export function diagnosticsFor(chunks, threshold = core.AI_PASSAGE_LOG_ODDS_THRESHOLD) {
  if (chunks.length * 120 + 240 <= 100_000) {
    const real = core.calculateAiLogOddsDiagnostics(chunks, threshold);
    return { totalWords: real.totalWords, flaggedWords: real.flaggedWords, percentFlagged: real.percentFlagged, meanProbability: real.meanProbability, maxProbability: real.maxProbability };
  }
  return diagnosticsLoop(chunks, threshold);
}

/**
 * Exactly what app/ai-detector-worker.ts analyze() returns for status "complete" (its 24 keys, in its order), given the
 * windows the real chunk builder produced and per-window model outputs.
 */
export function workerShapedAnalysis(text, chunks, signals, { engine = "CPU" } = {}) {
  const passages = chunks.map((chunk, i) => ({
    ...chunk,
    probability: Math.max(0, Math.min(1, signals[i].probability)),
    logOdds: signals[i].logOdds,
  }));
  const eligibleWordCount = core.eligibleAiWordCount(text);
  const diagnostics = diagnosticsFor(passages);
  const documentMedianLogOdds = core.medianLogOdds(passages);
  const populationPercentile = documentMedianLogOdds === null ? null : core.calibratedHumanMedianPercentile(documentMedianLogOdds);
  const flaggedPassageCount = passages.filter((p) => core.isAiPassageFlagged(p.logOdds, core.AI_PASSAGE_LOG_ODDS_THRESHOLD)).length;
  return {
    status: "complete",
    scoringVersion: core.AI_SCORING_VERSION,
    score: populationPercentile,
    coveragePercent: diagnostics.percentFlagged,
    medianLogOdds: documentMedianLogOdds,
    meanProbability: diagnostics.meanProbability,
    maxProbability: diagnostics.maxProbability,
    top3MeanLogOdds: core.calculateTopKMeanLogOdds(passages, 3),
    flaggedWordCount: diagnostics.flaggedWords,
    flaggedPassageCount,
    populationPercentile,
    model: core.AI_MODEL_VERSION,
    engine,
    threshold: core.AI_PASSAGE_THRESHOLD,
    thresholdLogOdds: core.AI_PASSAGE_LOG_ODDS_THRESHOLD,
    eligibleWordCount,
    analyzedWordCount: eligibleWordCount,
    analyzedTokenCount: diagnostics.totalWords,
    flaggedTokenCount: diagnostics.flaggedWords,
    truncatedPassageCount: passages.filter((p) => p.wasTruncated).length,
    passages: passages.map((p) => ({
      ...p,
      probability: Math.round(p.probability * 100000) / 100000,
      logOdds: Math.round(p.logOdds * 10000) / 10000,
      flagged: core.isAiPassageFlagged(p.logOdds, core.AI_PASSAGE_LOG_ODDS_THRESHOLD),
    })),
    detectedLanguage: "English",
    languageDetectorVersion: LANGUAGE_DETECTOR_VERSION,
  };
}

/** The whole production-shaped AI result for `text`: real chunking over `tokenizer`, simulated model outputs. JSON-safe (round-tripped). */
export function buildRealisticAiAnalysis(text, tokenizer, { seed = 900, flaggedRate = 0.03 } = {}) {
  const chunks = core.buildAiTokenChunks(text, tokenizer);
  return JSON.parse(JSON.stringify(workerShapedAnalysis(text, chunks, simulateSignals(chunks.length, seed, flaggedRate))));
}

const WORDS = (
  "the of and to in is that it was for on are as with his they at be this from have or by one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know get through back much before go good new write our used me man too any day same right look think also around another came come work three word must because does part even place well such here take why help put different away again off went old number great tell men say small every found still between name should home big give air line set own under read last never us left end along while might next sound below saw something thought both few those always looked show large often together asked house don't world going want school important until form food keep children feet land side without boy once animal life enough took sometimes four head above kind began almost live page got earth need far hand high year mother light country father let night picture being study second soon story since white ever paper hard near sentence better best across during today however sure knew try told young sun thing whole hear example heard several change answer room sea against top turned learn point city play toward five using himself usually money seen didn't car morning body upon family later turn move face door cut done group true leave color red friend pull car mind river research analysis structure evidence framework measured observed sample pattern method system model result region signal response domain record report summary section approach context variable outcome factor element feature process"
).split(/\s+/);

/**
 * Deterministic English-like prose of about `targetChars` characters: sentences of 8-22 words from a fixed word list, paragraph
 * breaks, commas, occasional questions. No real text, and (being random word order) essentially no overlap with any archive.
 * `messiness` (0-1) is the chance a sentence carries the PDF-extraction artefacts the tokenizer's clean-up step exists for
 * (" ." " ," " 's" " n't"), so clean-up-sensitive windows occur at a realistic-to-pessimistic rate.
 */
export function synthProse(targetChars, { seed = 42, messiness = 0.02 } = {}) {
  const random = rng(seed);
  const pick = () => WORDS[Math.floor(random() * WORDS.length)];
  const parts = [];
  let total = 0;
  while (total < targetChars) {
    const paragraph = [];
    const sentences = 3 + Math.floor(random() * 5);
    for (let s = 0; s < sentences; s += 1) {
      const length = 8 + Math.floor(random() * 15);
      const words = [];
      for (let w = 0; w < length; w += 1) {
        let word = pick();
        if (w === 0) word = word[0].toUpperCase() + word.slice(1);
        words.push(word);
        if (w > 2 && w < length - 2 && random() < 0.08) words[words.length - 1] += ",";
      }
      let sentence = words.join(" ");
      const artefact = random() < messiness;
      sentence += artefact ? " ." : random() < 0.08 ? "?" : ".";
      if (artefact) sentence = sentence.replace(/ (\w+)$/, " 's $1").replace(/ 's (\w+) \.$/, " , $1 .");
      paragraph.push(sentence);
    }
    const text = paragraph.join(" ");
    parts.push(text);
    total += text.length + 2;
  }
  let text = parts.join("\n\n");
  if (text.length > targetChars) {
    const cut = text.lastIndexOf(" ", targetChars);
    text = text.slice(0, cut > targetChars - 200 ? cut : targetChars);
  }
  return text;
}

/** The developer's local, gitignored English calibration corpus (human prose), or `[]` if it is not present on this machine. */
export function localEnglishCorpusFiles() {
  const roots = [
    { dir: path.join(REPO_ROOT, "corpus", "ai-negative", "text"), filter: () => true },
    { dir: path.join(REPO_ROOT, "corpus", "ai-benchmark", "text"), filter: (name) => /^english-reference-/.test(name) },
  ];
  const files = [];
  for (const { dir, filter } of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) if (name.endsWith(".txt") && filter(name)) files.push(path.join(dir, name));
  }
  return files;
}
