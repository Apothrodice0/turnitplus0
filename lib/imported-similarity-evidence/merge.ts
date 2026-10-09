import {
  buildImportedSimilarityEvidencePackageFile,
  validateImportedSimilarityEvidencePackage,
  validateImportedSimilarityEvidenceUnitRecord,
  type ImportedSimilarityEvidencePackageFile,
  type ImportedSimilarityEvidenceUnitRecord,
} from "./package";
import type { ImportedSimilarityEvidenceSet } from "./types";

/**
 * IMPORTED SIMILARITY EVIDENCE — combining packages, so a newly imported
 * Turnitin report can be added to the package that is already deployed.
 *
 * Every report build numbers its units PU0001…, and the loader rejects a
 * duplicate evidenceUnitId while unified similarity keys a source by it, so
 * sets from different reports must be namespaced. The rule is IDEMPOTENT so a
 * deployed unit keeps its id however many times the package is extended:
 *
 *   - an id already namespaced with its own set ("<evidenceSetId>:<id>") is
 *     kept as it is;
 *   - bare ids are kept for ONE set: the earliest (by createdAt, then
 *     evidenceSetId) set of the FIRST input that carries bare ids — the first
 *     input is the deployed package — or, when it has none, the earliest such
 *     set overall. Every other set's bare ids become "<evidenceSetId>:<id>".
 *
 * Sets are ordered by (createdAt, evidenceSetId) and copied verbatim
 * (manuscriptIdentitySha256 included) except unitCount / totalScoreMaskWords,
 * which are recounted from the units kept. Units keep their order within a
 * set. An exact duplicate across sets (same anchorTextSha256 and score mask)
 * keeps the first occurrence; the same anchor with a different mask fails the
 * merge. metadata.createdAt (outside the content hash) is the latest set
 * createdAt, so the merged file is byte-reproducible. Pure: no I/O, no clock.
 */

export type ImportedSimilarityEvidenceMergeSetLog = {
  evidenceSetId: string;
  inputUnits: number;
  kept: number;
  droppedExactDuplicates: number;
  renamed: number;
};

export type ImportedSimilarityEvidenceMergeResult = {
  file: ImportedSimilarityEvidencePackageFile;
  perSet: ImportedSimilarityEvidenceMergeSetLog[];
};

function namespaced(setId: string, unitId: string): boolean {
  return unitId.startsWith(`${setId}:`);
}

export function mergeImportedSimilarityEvidencePackageFiles(
  inputs: readonly ImportedSimilarityEvidencePackageFile[],
): ImportedSimilarityEvidenceMergeResult {
  if (inputs.length === 0) throw new Error("merge needs at least one package");
  inputs.forEach((input, index) => {
    const validation = validateImportedSimilarityEvidencePackage(input);
    if (!validation.ok) throw new Error(`input ${index}: invalid package (${validation.reason})`);
    if (validation.rejectedUnits.length > 0) throw new Error(`input ${index}: ${validation.rejectedUnits.length} units would be rejected by the loader`);
  });

  const sets = inputs.flatMap((input, inputIndex) => input.evidenceSets.map((set) => ({ set, inputIndex, units: input.units.filter((u) => u.evidenceSetId === set.evidenceSetId) })));
  const setIds = sets.map(({ set }) => set.evidenceSetId);
  if (new Set(setIds).size !== setIds.length) throw new Error(`duplicate evidenceSetId across inputs: ${setIds.join(", ")}`);
  sets.sort((a, b) =>
    a.set.createdAt < b.set.createdAt ? -1 : a.set.createdAt > b.set.createdAt ? 1 : a.set.evidenceSetId < b.set.evidenceSetId ? -1 : 1);

  const hasBareIds = ({ set, units }: (typeof sets)[number]) => units.some((u) => !namespaced(set.evidenceSetId, u.evidenceUnitId));
  const bareOwner = (sets.find((entry) => entry.inputIndex === 0 && hasBareIds(entry)) ?? sets.find(hasBareIds))?.set.evidenceSetId ?? null;
  const kept: ImportedSimilarityEvidenceUnitRecord[] = [];
  const seenIds = new Set<string>();
  const maskByAnchor = new Map<string, string>();
  const perSet: ImportedSimilarityEvidenceMergeSetLog[] = [];
  for (const { set, units } of sets) {
    const log = { evidenceSetId: set.evidenceSetId, inputUnits: units.length, kept: 0, droppedExactDuplicates: 0, renamed: 0 };
    for (const unit of units) {
      const keepId = namespaced(set.evidenceSetId, unit.evidenceUnitId) || set.evidenceSetId === bareOwner;
      const record = keepId ? { ...unit } : { ...unit, evidenceUnitId: `${set.evidenceSetId}:${unit.evidenceUnitId}` };
      if (!keepId) log.renamed += 1;
      const mask = JSON.stringify(record.scoreMaskRelativePositions);
      const priorMask = maskByAnchor.get(record.anchorTextSha256);
      if (priorMask !== undefined) {
        if (priorMask !== mask) throw new Error(`anchor ${record.anchorTextSha256} appears with conflicting score masks`);
        log.droppedExactDuplicates += 1;
        continue;
      }
      if (seenIds.has(record.evidenceUnitId)) throw new Error(`duplicate evidenceUnitId after namespacing: ${record.evidenceUnitId}`);
      maskByAnchor.set(record.anchorTextSha256, mask);
      seenIds.add(record.evidenceUnitId);
      kept.push(record);
      log.kept += 1;
    }
    perSet.push(log);
  }

  const evidenceSets: ImportedSimilarityEvidenceSet[] = sets.map(({ set }) => {
    const units = kept.filter((u) => u.evidenceSetId === set.evidenceSetId);
    return { ...set, unitCount: units.length, totalScoreMaskWords: units.reduce((total, u) => total + u.scoreMaskWordCount, 0) };
  }).filter((set) => set.unitCount > 0);
  const known = new Set(evidenceSets.map((set) => set.evidenceSetId));
  for (const unit of kept) {
    const result = validateImportedSimilarityEvidenceUnitRecord(unit, known);
    if (!result.ok) throw new Error(`merged unit ${unit.evidenceUnitId} fails loader validation: ${result.reason}`);
  }

  const file = buildImportedSimilarityEvidencePackageFile(evidenceSets, kept);
  file.metadata.createdAt = evidenceSets.map((set) => set.createdAt).sort().at(-1) ?? file.metadata.createdAt;
  const final = validateImportedSimilarityEvidencePackage(JSON.parse(JSON.stringify(file)));
  if (!final.ok) throw new Error(`merged package invalid: ${final.reason}`);
  if (final.rejectedUnits.length > 0) throw new Error(`merged package: ${final.rejectedUnits.length} units rejected by the loader`);
  return { file, perSet };
}
