/**
 * Verifies that the exact browser model contract still separates a small,
 * labelled sanity set before calibration is allowed to run.
 *
 * Source labels come from the official RAID dataset API. This is a smoke
 * control, not an accuracy estimate: the population calibration remains the
 * authority for the product threshold.
 */
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import {
  AI_MODEL_DTYPE,
  AI_MODEL_ID,
  AI_MODEL_MAX_TOKENS,
  AI_MODEL_VERSION,
  AI_OFFICIAL_PASSAGE_THRESHOLD,
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

const tokenizer = await AutoTokenizer.from_pretrained(AI_MODEL_ID);
(tokenizer as unknown as { truncation_side: "left" | "right" }).truncation_side = "left";
const model = await AutoModelForSequenceClassification.from_pretrained(AI_MODEL_ID, {
  device: "cpu",
  dtype: AI_MODEL_DTYPE,
  // See app/ai-detector-worker.ts's identical option for why: the fp16
  // graph fails to initialize under onnxruntime-node's CPU backend with
  // graph optimization enabled (tools/validate-ai-fp16.ts).
  session_options: { graphOptimizationLevel: "disabled" },
});

async function score(text: string) {
  const inputs = tokenizer(text, { truncation: true, max_length: AI_MODEL_MAX_TOKENS });
  const output = await model(inputs);
  return machineProbabilityFromLogits(output.logits.data);
}

const scores: Record<(typeof fixtures)[number]["label"], number[]> = {
  human: [],
  machine: [],
};
for (const fixture of fixtures) {
  const texts = await loadRows(fixture.offset);
  for (const text of texts) scores[fixture.label].push(await score(text));
}

const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
const humanFlagged = scores.human.filter((value) => value >= AI_OFFICIAL_PASSAGE_THRESHOLD).length;
const machineFlagged = scores.machine.filter((value) => value >= AI_OFFICIAL_PASSAGE_THRESHOLD).length;
const humanMean = mean(scores.human);
const machineMean = mean(scores.machine);

console.log(`model: ${AI_MODEL_VERSION}`);
console.log(`human:  ${humanFlagged}/10 flagged, mean ${humanMean.toFixed(3)}`);
console.log(`machine: ${machineFlagged}/10 flagged, mean ${machineMean.toFixed(3)}`);

if (humanFlagged > 4) throw new Error("Model contract failed: more than 4/10 RAID human controls were flagged.");
if (machineFlagged < 8) throw new Error("Model contract failed: fewer than 8/10 RAID machine controls were flagged.");
if (machineMean - humanMean < 0.2) throw new Error("Model contract failed: mean class separation is below 0.20.");
