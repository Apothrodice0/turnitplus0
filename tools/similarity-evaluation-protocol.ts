import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type SimilarityEvaluationSplit = "calibration" | "development-validation" | "locked-final-test";

export function assignSimilarityEvaluationSplit(revisionGroupId: string): {
  revisionGroupId: string;
  digest: string;
  bucket: number;
  split: SimilarityEvaluationSplit;
} {
  if (typeof revisionGroupId !== "string" || !revisionGroupId.trim()) {
    throw new Error("revisionGroupId must be a non-empty string.");
  }
  const normalized = revisionGroupId.trim();
  const digest = createHash("sha256")
    .update(`turnitplus-similarity-evaluation-v1\0${normalized}`)
    .digest("hex");
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % 4;
  const split: SimilarityEvaluationSplit = bucket <= 1
    ? "calibration"
    : bucket === 2
      ? "development-validation"
      : "locked-final-test";
  return { revisionGroupId: normalized, digest, bucket, split };
}

export function loadProtocolLock(path = "corpus/protocol/similarity-evaluation-v1.lock.json") {
  const value = JSON.parse(readFileSync(path, "utf8")) as {
    schema?: string;
    version?: number;
    protocolVersion?: number;
    protocolCommit?: string;
  };
  if (
    value.schema !== "turnitplus-similarity-evaluation-protocol-lock"
    || value.version !== 1
    || value.protocolVersion !== 1
    || typeof value.protocolCommit !== "string"
    || !/^[a-f0-9]{40}$/.test(value.protocolCommit)
  ) {
    throw new Error("Similarity evaluation protocol lock is missing or invalid.");
  }
  return value as Required<typeof value>;
}

if (process.argv[1]?.endsWith("similarity-evaluation-protocol.ts")) {
  const revisionGroupId = process.argv.slice(2).join(" ").trim();
  if (!revisionGroupId) throw new Error("Usage: npm run assign:evaluation-split -- <revisionGroupId>");
  const lock = loadProtocolLock();
  console.log(JSON.stringify({ protocolVersion: lock.protocolVersion, protocolCommit: lock.protocolCommit, ...assignSimilarityEvaluationSplit(revisionGroupId) }, null, 2));
}
