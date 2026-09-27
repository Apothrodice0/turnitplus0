import * as core from "../../lib/ai-core.ts";
import { pseudoBpeTokenizer, rng } from "./real-ai-windows.mjs";

/**
 * Stand-in for `@huggingface/transformers` as app/ai-detector-worker.ts uses it (see ./ai-worker-transformers-hooks.mjs):
 * `env`, `AutoTokenizer.from_pretrained` and `AutoModelForSequenceClassification.from_pretrained`. The tokenizer is the
 * deterministic pseudo-BPE of ./real-ai-windows.mjs (encode/decode, plus the batch call the worker's classify() makes for
 * its 256-token guard); the model returns a deterministic logit pair per window text. Every signal handed back is recorded
 * in `stubState.signals`, in order, so a test can rebuild the expected result independently of the worker.
 */

export const stubState = { signals: [], modelCalls: 0 };

export function resetStub() {
  stubState.signals = [];
  stubState.modelCalls = 0;
}

export const env = { cacheKey: "transformers-cache" };

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A plausible human-range logOdds for one window text, with ~3% of windows above the passage threshold. Deterministic. */
function windowLogOdds(text) {
  const random = rng(fnv1a(text));
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  if (random() < 0.03) return core.AI_PASSAGE_LOG_ODDS_THRESHOLD + Math.abs(gauss()) * 0.8;
  return -2.6 + 0.7 * gauss();
}

export const AutoTokenizer = {
  async from_pretrained() {
    const base = pseudoBpeTokenizer();
    const tokenizer = (texts) => {
      let longest = 0;
      for (const text of texts) longest = Math.max(longest, base.encode(text).length);
      return { input_ids: { dims: [texts.length, longest + 2] }, texts };
    };
    tokenizer.encode = (text, options) => base.encode(text, options);
    tokenizer.decode = (ids, options) => base.decode(ids, options);
    return tokenizer;
  },
};

export const AutoModelForSequenceClassification = {
  async from_pretrained() {
    return async (inputs) => {
      stubState.modelCalls += 1;
      const data = new Float64Array(inputs.texts.length * 2);
      inputs.texts.forEach((text, index) => {
        data[index * 2 + 1] = windowLogOdds(text) * core.AI_MODEL_TEMPERATURE;
        const logOdds = core.machineLogOddsFromLogits(data.slice(index * 2, index * 2 + 2));
        stubState.signals.push({ logOdds, probability: core.probabilityFromLogOdds(logOdds) });
      });
      return { logits: { data } };
    };
  },
};
