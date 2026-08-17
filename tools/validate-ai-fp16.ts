/**
 * TurnitPlus — "start the two fixes now" TASK 4: empirical FP16-vs-FP32
 * validation for the AI-writing detector model (onnx-community/modernbert-
 * ai-detection-raid-mage-ONNX), before AI_MODEL_DTYPE is ever changed in
 * lib/ai-core.ts. Loads BOTH the current production fp32 weights and the
 * fp16 variant, runs them on the IDENTICAL set of real texts (the same
 * live RAID human/machine fixture tools/check-ai-model-contract.ts already
 * uses as its production sanity control, so this is real published text,
 * not synthetic filler), and reports the per-text logit/log-odds/
 * probability delta between the two dtypes plus whether either dtype's
 * classification (flagged vs not, at the existing production threshold)
 * ever disagrees with the other. This script only measures and reports —
 * it never writes to lib/ai-core.ts itself.
 */
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import {
  AI_MODEL_ID,
  AI_MODEL_MAX_TOKENS,
  AI_OFFICIAL_PASSAGE_THRESHOLD,
  AI_PASSAGE_LOG_ODDS_THRESHOLD,
  machineLogOddsFromLogits,
  machineProbabilityFromLogits,
} from "../lib/ai-core";

type RaidRow = { row?: { generation?: string; model?: string } };
type RaidResponse = { rows?: RaidRow[] };

const RAID_API = "https://datasets-server.huggingface.co/rows";
const fixtures = [
  { label: "human", offset: 0 },
  { label: "machine", offset: 100000 },
] as const;

async function loadRows(offset: number) {
  const query = new URLSearchParams({
    dataset: "liamdugan/raid",
    config: "raid",
    split: "train",
    offset: String(offset),
    length: "10",
  });
  const response = await fetch(`${RAID_API}?${query}`);
  if (!response.ok) throw new Error(`RAID fixture request failed: ${response.status}`);
  const payload = await response.json() as RaidResponse;
  const texts = (payload.rows ?? [])
    .map((entry) => entry.row?.generation)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
  if (texts.length !== 10) throw new Error(`Expected 10 RAID rows, received ${texts.length}.`);
  return texts;
}

console.log(`Loading tokenizer + both dtype variants of ${AI_MODEL_ID} ...`);
const tokenizer = await AutoTokenizer.from_pretrained(AI_MODEL_ID);
(tokenizer as unknown as { truncation_side: "left" | "right" }).truncation_side = "left";

const modelFp32 = await AutoModelForSequenceClassification.from_pretrained(AI_MODEL_ID, {
  device: "cpu",
  dtype: "fp32",
});
// The plain fp16 ONNX graph fails to initialize under onnxruntime-node's CPU
// execution provider with a SimplifiedLayerNormFusion graph-utils error
// (confirmed empirically on this exact model/runtime combination before this
// option was added) — disabling ONNX Runtime's graph-optimization pass is
// the standard, well-known workaround for this class of fp16 fusion bug and
// was verified to load and run correctly here.
const modelFp16 = await AutoModelForSequenceClassification.from_pretrained(AI_MODEL_ID, {
  device: "cpu",
  dtype: "fp16",
  session_options: { graphOptimizationLevel: "disabled" },
});
console.log("Both variants loaded.\n");

async function scoreWith(model: typeof modelFp32, text: string) {
  const inputs = tokenizer(text, { truncation: true, max_length: AI_MODEL_MAX_TOKENS });
  const output = await model(inputs);
  const logits = Array.from(output.logits.data as ArrayLike<number>);
  const logOdds = machineLogOddsFromLogits(logits);
  const probability = machineProbabilityFromLogits(logits);
  return { logits, logOdds, probability };
}

type Row = {
  label: string;
  index: number;
  fp32: Awaited<ReturnType<typeof scoreWith>>;
  fp16: Awaited<ReturnType<typeof scoreWith>>;
};

const rows: Row[] = [];
for (const fixture of fixtures) {
  const texts = await loadRows(fixture.offset);
  for (const [index, text] of texts.entries()) {
    const fp32 = await scoreWith(modelFp32, text);
    const fp16 = await scoreWith(modelFp16, text);
    rows.push({ label: fixture.label, index, fp32, fp16 });
  }
}

console.log("label    idx  fp32_logOdds  fp16_logOdds  delta   fp32_prob  fp16_prob  flag_agree");
let maxAbsLogOddsDelta = 0;
let sumAbsLogOddsDelta = 0;
let flagDisagreements = 0;
for (const row of rows) {
  const delta = row.fp16.logOdds - row.fp32.logOdds;
  const absDelta = Math.abs(delta);
  maxAbsLogOddsDelta = Math.max(maxAbsLogOddsDelta, absDelta);
  sumAbsLogOddsDelta += absDelta;
  const fp32Flag = row.fp32.logOdds >= AI_PASSAGE_LOG_ODDS_THRESHOLD;
  const fp16Flag = row.fp16.logOdds >= AI_PASSAGE_LOG_ODDS_THRESHOLD;
  const agree = fp32Flag === fp16Flag;
  if (!agree) flagDisagreements += 1;
  console.log(
    `${row.label.padEnd(8)} ${String(row.index).padStart(3)}  ${row.fp32.logOdds.toFixed(4).padStart(12)}  ${row.fp16.logOdds.toFixed(4).padStart(12)}  ${delta.toFixed(4).padStart(6)}  ${row.fp32.probability.toFixed(4).padStart(9)}  ${row.fp16.probability.toFixed(4).padStart(9)}  ${agree ? "yes" : "NO"}`,
  );
}

const meanAbsLogOddsDelta = sumAbsLogOddsDelta / rows.length;

console.log("\n--- summary ---");
console.log(`rows compared: ${rows.length}`);
console.log(`mean |logOdds delta|: ${meanAbsLogOddsDelta.toFixed(4)}`);
console.log(`max  |logOdds delta|: ${maxAbsLogOddsDelta.toFixed(4)}`);
console.log(`passage-threshold flag disagreements: ${flagDisagreements}/${rows.length}`);

function contractCheck(dtypeLabel: string, get: (row: Row) => Awaited<ReturnType<typeof scoreWith>>) {
  const human = rows.filter((r) => r.label === "human").map((r) => get(r).probability);
  const machine = rows.filter((r) => r.label === "machine").map((r) => get(r).probability);
  const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
  const humanFlagged = human.filter((value) => value >= AI_OFFICIAL_PASSAGE_THRESHOLD).length;
  const machineFlagged = machine.filter((value) => value >= AI_OFFICIAL_PASSAGE_THRESHOLD).length;
  const humanMean = mean(human);
  const machineMean = mean(machine);
  console.log(`[${dtypeLabel}] human: ${humanFlagged}/10 flagged, mean ${humanMean.toFixed(3)} | machine: ${machineFlagged}/10 flagged, mean ${machineMean.toFixed(3)} | separation ${(machineMean - humanMean).toFixed(3)}`);
  return { humanFlagged, machineFlagged, separation: machineMean - humanMean };
}

console.log("\n--- existing production contract, run under each dtype ---");
const fp32Contract = contractCheck("fp32", (r) => r.fp32);
const fp16Contract = contractCheck("fp16", (r) => r.fp16);

const fp16PassesContract = fp16Contract.humanFlagged <= 4 && fp16Contract.machineFlagged >= 8 && fp16Contract.separation >= 0.2;
console.log(`\nfp16 passes the same production contract thresholds as fp32: ${fp16PassesContract ? "YES" : "NO"}`);
console.log(`fp32 passes its own contract (sanity check on this run): ${fp32Contract.humanFlagged <= 4 && fp32Contract.machineFlagged >= 8 && fp32Contract.separation >= 0.2 ? "YES" : "NO"}`);
