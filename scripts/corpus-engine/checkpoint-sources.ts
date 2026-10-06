import { normalizeForCorpus } from "../../lib/corpus-engine/fingerprints";
import {
  LocalFixtureSourceAdapter,
  SelectiveBulkManifestSourceAdapter,
  sourceDocumentFromText,
  type SourceAdapter,
  type SourceDocument,
} from "../../lib/corpus-engine/source-adapter";
import { prng } from "./common";

/**
 * Source configuration for the 10k engineering checkpoint.
 *
 * REAL material comes only from adapters over local files (the existing
 * Selective bulk source staging, read-only, and the staged Wikipedia text).
 * Everything generated here is SYNTHETIC LOAD-ONLY: it is flagged
 * syntheticLoadOnly, typed "synthetic-*", and reported separately. It exists
 * for exactly three engineering behaviours real material does not provide in
 * a controlled amount: a large family of documents sharing one boilerplate
 * block (very common fingerprints), a large family of NEAR-duplicates of one
 * long text (the case where whole-document ranking is crowded out — at 10k
 * the real corpus holds no family that large), and exact-normalized
 * duplicates supplied by a second provider (aliases).
 */

/** A generic terms block — written for this checkpoint, not taken from any source. */
export const SYNTHETIC_LEGAL_BOILERPLATE = [
  "This document is provided for general informational purposes only and does not constitute legal, financial or professional advice of any kind.",
  "The publisher makes no representations or warranties, express or implied, regarding the accuracy, completeness or suitability of the material contained herein,",
  "and expressly disclaims all liability for any loss or damage arising directly or indirectly from reliance upon it.",
  "Reproduction, distribution or transmission of any part of this document, in any form or by any means, electronic or mechanical, including photocopying and recording,",
  "is prohibited without the prior written permission of the copyright holder, except for brief quotations used in critical reviews",
  "and certain other non-commercial uses permitted by applicable copyright law.",
  "All trademarks, service marks and trade names referenced in this document are the property of their respective owners.",
  "Any dispute arising out of or in connection with this document shall be governed by and construed in accordance with the laws of the jurisdiction",
  "in which the publisher is established, and the courts of that jurisdiction shall have exclusive authority to resolve it.",
].join(" ");

const ONSETS = ["b", "d", "f", "g", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z", "br", "dr", "kl", "st", "tr", "pl"];
const VOWELS = ["a", "e", "i", "o", "u", "ai", "ou"];

/** `count` invented words (never real vocabulary), deterministic in `seed`. */
export function inventedWords(seed: number, count: number): string[] {
  const random = prng(seed);
  const words: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let word = "";
    const syllables = 3 + Math.floor(random() * 2);
    for (let syllable = 0; syllable < syllables; syllable += 1) word += ONSETS[Math.floor(random() * ONSETS.length)] + VOWELS[Math.floor(random() * VOWELS.length)];
    words.push(word);
  }
  return words;
}

/** The text of synthetic boilerplate-family document `index`: a unique invented body with the shared block inside it. */
export function syntheticBoilerplateDocumentText(seed: number, index: number): string {
  const random = prng(seed * 7919 + index);
  const bodyLength = 500 + Math.floor(random() * 1000);
  const body = inventedWords(seed * 104729 + index, bodyLength);
  const insertAt = Math.floor(bodyLength * (0.2 + random() * 0.6));
  return [...body.slice(0, insertAt), SYNTHETIC_LEGAL_BOILERPLATE, ...body.slice(insertAt)].join(" ");
}

/** The text every member of the synthetic near-duplicate family is a lightly edited copy of. It is NOT itself a corpus document. */
export const SYNTHETIC_NEAR_DUPLICATE_FAMILY = { seed: 20261007, baseWords: 3000, sourceType: "synthetic-near-duplicate-family" } as const;

export function syntheticNearDuplicateBaseWords(): string[] {
  return inventedWords(SYNTHETIC_NEAR_DUPLICATE_FAMILY.seed, SYNTHETIC_NEAR_DUPLICATE_FAMILY.baseWords);
}

/** Member `index`: the base text with one word in forty replaced by a word of its own (at an offset of its own). */
export function syntheticNearDuplicateMemberText(index: number): string {
  const words = syntheticNearDuplicateBaseWords();
  const replacements = inventedWords(SYNTHETIC_NEAR_DUPLICATE_FAMILY.seed * 31 + index + 1, Math.ceil(words.length / 40) + 1);
  for (let position = index % 40, used = 0; position < words.length; position += 40, used += 1) words[position] = `v${index}${replacements[used]}`;
  return words.join(" ");
}

class SyntheticNearDuplicateFamilyAdapter implements SourceAdapter {
  readonly adapterId: string;
  constructor(private readonly count: number) {
    this.adapterId = `synthetic-near-duplicate-family:${count}:${SYNTHETIC_NEAR_DUPLICATE_FAMILY.seed}`;
  }

  async *documents(): AsyncGenerator<SourceDocument> {
    for (let index = 0; index < this.count; index += 1) {
      yield sourceDocumentFromText({
        provider: "synthetic-generator",
        dataset: "near-duplicate-family-v1",
        datasetVersion: `seed-${SYNTHETIC_NEAR_DUPLICATE_FAMILY.seed}`,
        externalId: `near-duplicate-${String(index).padStart(5, "0")}`,
        text: syntheticNearDuplicateMemberText(index),
        sourceType: SYNTHETIC_NEAR_DUPLICATE_FAMILY.sourceType,
        rights: { license: null, licenseUrl: null, usage: "synthetic load-only engineering material; not a real source", attribution: null },
        provenance: { acquisitionSource: "deterministic-generator", retrievedAt: null, sourceVersion: `seed:${SYNTHETIC_NEAR_DUPLICATE_FAMILY.seed}:member:${index}`, notes: "one invented base text with one word in forty replaced per member" },
        extractionVersion: "synthetic-generator-v1",
        syntheticLoadOnly: true,
      });
    }
  }
}

export function syntheticBoilerplateExternalId(index: number): string {
  return `boilerplate-family-${String(index).padStart(5, "0")}`;
}

class SyntheticBoilerplateFamilyAdapter implements SourceAdapter {
  readonly adapterId: string;
  constructor(private readonly count: number, private readonly seed: number) {
    this.adapterId = `synthetic-boilerplate-family:${count}:${seed}`;
  }

  async *documents(): AsyncGenerator<SourceDocument> {
    for (let index = 0; index < this.count; index += 1) {
      yield sourceDocumentFromText({
        provider: "synthetic-generator",
        dataset: "boilerplate-family-v1",
        datasetVersion: `seed-${this.seed}`,
        externalId: syntheticBoilerplateExternalId(index),
        text: syntheticBoilerplateDocumentText(this.seed, index),
        sourceType: "synthetic-load-only",
        rights: { license: null, licenseUrl: null, usage: "synthetic load-only engineering material; not a real source", attribution: null },
        provenance: { acquisitionSource: "deterministic-generator", retrievedAt: null, sourceVersion: `seed:${this.seed}:index:${index}`, notes: "invented words + one shared generic terms block" },
        extractionVersion: "synthetic-generator-v1",
        syntheticLoadOnly: true,
      });
    }
  }
}

/** Re-spaces a text without changing a word; the result normalizes to the same token stream. */
function respace(text: string): string {
  return `${text.replace(/ /g, "  ")}\n`;
}

/**
 * Every `every`-th document of `inner`, re-supplied by a second, synthetic
 * provider with different whitespace. An alias is emitted ONLY when its
 * normalized content hash really equals the original's — the adapter checks,
 * it does not assume — so every emitted row is a true exact-normalized
 * duplicate.
 */
class SyntheticMirrorAliasAdapter implements SourceAdapter {
  readonly adapterId: string;
  constructor(private readonly inner: SourceAdapter, private readonly every: number, private readonly limit: number) {
    this.adapterId = `synthetic-mirror:${inner.adapterId}:every-${every}:limit-${limit}`;
  }

  async *documents(): AsyncGenerator<SourceDocument> {
    let index = -1;
    let emitted = 0;
    for await (const original of this.inner.documents()) {
      index += 1;
      if (emitted >= this.limit) break;
      if (index % this.every !== 0) continue;
      const text = respace(original.text);
      if (normalizeForCorpus(text).normalizedContentSha256 !== normalizeForCorpus(original.text).normalizedContentSha256) continue;
      emitted += 1;
      yield sourceDocumentFromText({
        provider: "synthetic-mirror",
        dataset: `mirror-of-${original.dataset}`,
        externalId: original.externalId,
        text,
        sourceType: "synthetic-mirror-of-real",
        provenance: { acquisitionSource: "deterministic-generator", retrievedAt: null, sourceVersion: null, notes: `re-spaced copy of ${original.provider}/${original.dataset}/${original.externalId}` },
        rights: { license: null, licenseUrl: null, usage: "synthetic load-only alias; carries no rights of its own", attribution: null },
        extractionVersion: "synthetic-generator-v1",
        syntheticLoadOnly: true,
      });
    }
  }
}

export type SourceSpec =
  | { kind: "selective-bulk"; directory: string; dataset: string; from?: number; to?: number }
  | { kind: "local-fixture"; manifest: string }
  | { kind: "synthetic-boilerplate"; count: number; seed: number }
  | { kind: "synthetic-near-duplicate-family"; count: number }
  | { kind: "synthetic-mirror"; of: SourceSpec; every: number; limit: number };

export function adapterFor(spec: SourceSpec): SourceAdapter {
  switch (spec.kind) {
    case "selective-bulk":
      return new SelectiveBulkManifestSourceAdapter(spec.directory, { dataset: spec.dataset, from: spec.from, to: spec.to });
    case "local-fixture":
      return new LocalFixtureSourceAdapter(spec.manifest);
    case "synthetic-boilerplate":
      return new SyntheticBoilerplateFamilyAdapter(spec.count, spec.seed);
    case "synthetic-near-duplicate-family":
      return new SyntheticNearDuplicateFamilyAdapter(spec.count);
    case "synthetic-mirror":
      return new SyntheticMirrorAliasAdapter(adapterFor(spec.of), spec.every, spec.limit);
    default:
      throw new Error(`unknown source spec ${JSON.stringify(spec)}`);
  }
}
