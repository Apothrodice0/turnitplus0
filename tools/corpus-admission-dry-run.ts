import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getReportsDbClient } from "../lib/reports-db";
import { evaluateCorpusAdmissionCandidate, type CorpusAdmissionDecisionRecord, type CorpusInBatchFamilyEntry } from "../lib/corpus-admission-gate";
import { DEFAULT_CORPUS_ADMISSION_LIMITS, type CorpusProvenanceRecord } from "../lib/corpus-admission-types";

/**
 * VALIDATE-ONLY dry-run CLI for the corpus-admission gate (spec section 7 /
 * requirement 4) — every candidate is evaluated with dryRun:true, so no run
 * can ever write to corpus_admission_content_store or the real corpus
 * tables, regardless of decision. Never imports the 770 articles itself —
 * it is the tool that will later be pointed at them, once this feature is
 * reviewed and approved; not run against real data by this implementation
 * phase.
 *
 * Usage: node --import tsx tools/corpus-admission-dry-run.ts --manifest <path> [--out <path>]
 *
 * Manifest shape (JSON):
 *   {
 *     "importRoot": "/absolute/path/to/approved/import/directory",
 *     "candidates": [
 *       { "path": "/absolute/path/.../article1.pdf", "provenance": { ...CorpusProvenanceRecord... } },
 *       ...
 *     ]
 *   }
 *
 * Every candidate path is resolved and checked against importRoot before
 * the file is ever opened (path-traversal defense); every candidate is
 * lstat'd (not stat'd) and rejected outright if it is a symlink (never
 * followed) — both requirement 4's own asks.
 */

type ManifestCandidate = { path: string; provenance: CorpusProvenanceRecord };
type Manifest = { importRoot: string; candidates: ManifestCandidate[] };

function parseArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function createMutex() {
  let queue: Promise<unknown> = Promise.resolve();
  return function withLock<T>(fn: () => T): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function resolveWithinRoot(root: string, candidatePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidatePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing candidate outside the approved import root: "${candidatePath}" resolves to "${resolved}", not under "${resolvedRoot}".`);
  }
  return resolved;
}

export function rejectIfSymlink(resolvedPath: string): void {
  const stat = fs.lstatSync(resolvedPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing symlinked candidate (never followed): "${resolvedPath}".`);
  }
}

async function main() {
  const manifestPath = parseArg("--manifest");
  if (!manifestPath) {
    throw new Error("Usage: node --import tsx tools/corpus-admission-dry-run.ts --manifest <path> [--out <path>]");
  }
  const outPath = parseArg("--out") ?? path.join(process.cwd(), `corpus-admission-dry-run-${Date.now()}.json`);

  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8")) as Manifest;
  const limits = DEFAULT_CORPUS_ADMISSION_LIMITS;
  const runId = randomUUID();
  const client = await getReportsDbClient();

  // In-process, never-persisted "first accepted sample wins" registry for
  // this batch (requirement 2/4) — holds only opaque shingle-hash sets for
  // candidates already ACCEPTed earlier in this run, never raw text (see
  // lib/corpus-admission-gate.ts's CorpusAdmissionDecisionRecord.shingleHashes
  // for why only hashes ever cross that boundary). Only the cheap
  // "snapshot registry, then register" steps are serialized through this
  // mutex — extraction/quality scoring for different candidates still run
  // fully concurrently. "Earliest" here means earliest to COMPLETE
  // evaluation under the configured concurrency, not strict manifest
  // order, when cliMaxConcurrency > 1 — documented explicitly rather than
  // overclaiming a stronger guarantee.
  const acceptedRegistry: CorpusInBatchFamilyEntry[] = [];
  const registryMutex = createMutex();

  const results = await mapWithConcurrency(manifest.candidates, limits.cliMaxConcurrency.value, async (candidate) => {
    const sourceRef = path.relative(manifest.importRoot, candidate.path) || candidate.path;
    try {
      const resolvedPath = resolveWithinRoot(manifest.importRoot, candidate.path);
      rejectIfSymlink(resolvedPath);
      const bytes = fs.readFileSync(resolvedPath);

      const inBatchFamilyCandidates = await registryMutex(() => [...acceptedRegistry]);

      const decision = await evaluateCorpusAdmissionCandidate(client, {
        sourceRef,
        runId,
        filename: path.basename(candidate.path),
        bytes,
        consent: { kind: "BULK_IMPORT_PROVENANCE", provenance: candidate.provenance },
        dryRun: true,
        inBatchFamilyCandidates,
        limits,
      });

      if (decision.decision === "ACCEPT" && decision.canonicalSha256 && decision.shingleHashes) {
        await registryMutex(() => {
          acceptedRegistry.push({
            sourceRef,
            canonicalSha256: decision.canonicalSha256 as string,
            wordCount: decision.extractedWordCount ?? 0,
            shingleHashes: decision.shingleHashes as Set<string>,
          });
        });
      }

      return decision;
    } catch (err) {
      return {
        id: "",
        runId,
        sourceRef,
        policyVersion: "n/a",
        decision: "REJECT" as const,
        reasonCodes: ["EXTRACTION_FAILED" as const],
        hardGatePassed: false,
        hardGateFailureCodes: ["EXTRACTION_FAILED" as const],
        detectedFormat: null,
        extractedWordCount: null,
        detectedLanguage: null,
        languageConfidence: null,
        canonicalSha256: null,
        extractorVersion: null,
        contentStoreId: null,
        acceptedRepresentationId: null,
        qualityScore: null,
        qualityModelVersion: null,
        componentScores: null,
        featureVector: null,
        featureVectorVersion: null,
        corpusValueScore: null,
        corpusValueModelVersion: null,
        familyRelation: "NONE" as const,
        familyMatchedSourceRef: null,
        familyContainment: null,
        consentMetadata: { kind: "BULK_IMPORT_PROVENANCE", provenance: candidate.provenance },
        dryRun: true,
        shingleHashes: null,
        _localValidationError: err instanceof Error ? err.message : String(err),
      } as CorpusAdmissionDecisionRecord & { _localValidationError: string };
    }
  });

  const summary = results.reduce(
    (acc, r) => {
      acc.total += 1;
      acc[r.decision] = (acc[r.decision] ?? 0) + 1;
      return acc;
    },
    { total: 0, ACCEPT: 0, REVIEW: 0, REJECT: 0 } as Record<string, number>,
  );

  // shingleHashes is a Set<string> — an in-process-only field for this
  // CLI's own in-batch registry (JSON.stringify would silently corrupt a
  // Set into "{}"), never meant for the persisted report; every other
  // field is plain JSON-serializable data.
  const reportCandidates = results.map(({ shingleHashes: _shingleHashes, ...rest }) => rest);
  fs.writeFileSync(outPath, JSON.stringify({ runId, generatedAt: new Date().toISOString(), dryRun: true, summary, candidates: reportCandidates }, null, 2));
  console.log(`Dry-run complete: ${summary.total} candidates (${summary.ACCEPT} accept, ${summary.REVIEW} review, ${summary.REJECT} reject). Report: ${outPath}`);

  client.close();
}

// Only runs main() when this file is executed directly (node --import tsx
// tools/corpus-admission-dry-run.ts ...), not when its helpers
// (resolveWithinRoot, rejectIfSymlink) are imported for testing —
// pathToFileURL correctly normalizes Windows drive letters/backslashes,
// unlike a plain string `file://${...}` comparison.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  });
}
