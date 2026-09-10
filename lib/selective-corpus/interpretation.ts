/**
 * Selective Corpus — interpretation COMPATIBILITY SHIM.
 *
 * The Evidence Interpretation Layer was generalised out of this file into
 * lib/evidence-interpretation/ so it can classify VERIFIED evidence from ANY
 * producer (archive, scholarly, prior-submission, selective-corpus), not just
 * selective-corpus candidates. Selective Corpus is now ONE producer.
 *
 * This file re-exports the generic layer under the historical
 * `...SelectiveCorpus...` names so lib/selective-corpus/shadow.ts and the
 * existing selective-corpus tests keep working unchanged. There is NO
 * interpretation logic here — see lib/evidence-interpretation/interpret.ts.
 */
import {
  interpretVerifiedEvidence,
  EVIDENCE_INTERPRETATION_VERSION,
  EVIDENCE_INTERPRETATION_KINDS,
  type EvidenceInterpretationKind,
  type EvidenceInterpretationConfidence,
  type EvidenceSpanInterpretation,
  type SameWorkRelationship,
  type InterpretationSourceInput,
  type InterpretationInput,
  type InterpretationResult,
} from "../evidence-interpretation";

export const interpretSelectiveCorpusEvidence = interpretVerifiedEvidence;
export const SELECTIVE_CORPUS_INTERPRETATION_VERSION = EVIDENCE_INTERPRETATION_VERSION;
export const SELECTIVE_CORPUS_INTERPRETATION_KINDS = EVIDENCE_INTERPRETATION_KINDS;

export type SelectiveCorpusInterpretationKind = EvidenceInterpretationKind;
export type SelectiveCorpusInterpretationConfidence = EvidenceInterpretationConfidence;
export type SelectiveCorpusSpanInterpretation = EvidenceSpanInterpretation;
export type SelectiveCorpusSameWorkRelationship = SameWorkRelationship;
export type SelectiveCorpusInterpretationSourceInput = InterpretationSourceInput;
export type SelectiveCorpusInterpretationInput = InterpretationInput;
export type SelectiveCorpusInterpretationResult = InterpretationResult;
