import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import mammoth from "mammoth";
import { extractPdfTextDocument } from "../lib/pdf-text-extraction";
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import {
  AI_MODEL_DTYPE,
  AI_MODEL_ID,
  AI_MODEL_MAX_TOKENS,
  AI_PASSAGE_LOG_ODDS_THRESHOLD,
  AI_PASSAGE_THRESHOLD,
  buildAiTokenChunks,
  calculateAiLogOddsDiagnostics,
  calculateTopKMeanLogOdds,
  machineLogOddsFromLogits,
  probabilityFromLogOdds,
} from "../lib/ai-core";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("Missing --output <path>.");
const outputPath = resolve(args[outputIndex + 1]);
const paths = args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1).map((path) => resolve(path));
if (!paths.length) throw new Error("Pass one or more DOCX paths.");

const tokenizer = await AutoTokenizer.from_pretrained(AI_MODEL_ID);
const model = await AutoModelForSequenceClassification.from_pretrained(AI_MODEL_ID, {
  device: "cpu",
  dtype: AI_MODEL_DTYPE,
});

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] * (upper - position) + sorted[upper] * (position - lower);
}

async function classify(texts: string[]) {
  const inputs = tokenizer(texts, { padding: true, truncation: false });
  const sequenceLength = inputs.input_ids.dims.at(-1) ?? 0;
  if (sequenceLength > AI_MODEL_MAX_TOKENS) throw new Error(`Token window exceeded ${AI_MODEL_MAX_TOKENS} tokens.`);
  const output = await model(inputs);
  return texts.map((_, index) => {
    const logOdds = machineLogOddsFromLogits(output.logits.data.slice(index * 2, index * 2 + 2));
    return { logOdds, probability: probabilityFromLogOdds(logOdds) };
  });
}

const results = [];
for (const path of paths) {
  const source = readFileSync(path);
  const extension = extname(path).toLowerCase();
  let text: string;
  if (extension === ".docx") {
    text = (await mammoth.extractRawText({ buffer: source })).value;
  } else if (extension === ".pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await pdfjs.getDocument({ data: new Uint8Array(source) }).promise;
    text = await extractPdfTextDocument(document);
  } else {
    text = source.toString("utf8");
  }
  if (!text.trim()) throw new Error(`${basename(path)} produced empty text.`);
  const chunks = buildAiTokenChunks(text, tokenizer);
  const passages = [];
  for (let index = 0; index < chunks.length; index += 8) {
    const batch = chunks.slice(index, index + 8);
    const signals = await classify(batch.map((chunk) => chunk.text));
    for (let offset = 0; offset < batch.length; offset += 1) passages.push({ ...batch[offset], ...signals[offset] });
    process.stderr.write(`${basename(path)}: ${Math.min(index + batch.length, chunks.length)}/${chunks.length}\n`);
  }
  const diagnostics = calculateAiLogOddsDiagnostics(passages, AI_PASSAGE_LOG_ODDS_THRESHOLD);
  const logOdds = passages.map((passage) => passage.logOdds);
  results.push({
    file: basename(path),
    score: diagnostics.percentFlagged,
    threshold: AI_PASSAGE_THRESHOLD,
    thresholdLogOdds: AI_PASSAGE_LOG_ODDS_THRESHOLD,
    passageCount: passages.length,
    flaggedPassages: diagnostics.flaggedPassages,
    top3MeanLogOdds: calculateTopKMeanLogOdds(passages, 3),
    logOddsSummary: {
      min: Math.min(...logOdds),
      q25: quantile(logOdds, 0.25),
      median: quantile(logOdds, 0.5),
      q75: quantile(logOdds, 0.75),
      max: Math.max(...logOdds),
      mean: logOdds.reduce((total, value) => total + value, 0) / logOdds.length,
      nearThreshold: logOdds.filter((value) => Math.abs(value - AI_PASSAGE_LOG_ODDS_THRESHOLD) <= 0.08).length,
    },
    passages: passages.map((passage, index) => ({
      index: index + 1,
      wordStart: passage.wordStart,
      wordEnd: passage.wordEnd,
      tokenStart: passage.tokenStart,
      tokenEnd: passage.tokenEnd,
      tokenCount: passage.tokenCount,
      wasTruncated: passage.wasTruncated,
      logOdds: passage.logOdds,
      probability: passage.probability,
      flagged: passage.logOdds >= AI_PASSAGE_LOG_ODDS_THRESHOLD,
      preview: passage.text.replace(/\s+/g, " ").slice(0, 180),
    })),
  });
}

writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`);
const summaries = results.map((result) => Object.fromEntries(Object.entries(result).filter(([key]) => key !== "passages")));
console.log(JSON.stringify(summaries, null, 2));
