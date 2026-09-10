import type {
  EvidenceInterpretationKind,
  EvidenceInterpretationConfidence,
  EvidenceInterpretationTone,
} from "./kinds";
import type { NormalizedSourceType } from "./normalized-evidence";

/**
 * PHASE 3/4 report payload types — a LEAF module (imports only ./kinds and
 * ./normalized-evidence, never @/lib/report-types) so lib/report-types.ts can
 * reference these on SimilarityReport without an import cycle, exactly like
 * HistoricalMatchPassage's hand-mirror convention but without the duplication.
 *
 * Every field here is additive/explanation-only. No corpus id, DB id, hash,
 * fingerprint, path, Passport/HMAC/provenance internal, or other-account
 * identity ever appears. Source ids are report-local opaque `src-N`.
 */

export type ReportEvidenceNamedSource = {
  label: string;
  contributionPercent: number;
  matchedWords: number;
};

export type ReportEvidenceSource = {
  /** report-local opaque id — `src-1`..`src-n`, stable for the same persisted evidence. */
  id: string;
  label: string;
  sourceType: NormalizedSourceType;
  link: string | null;
  doi: string | null;
  year: number | null;
  contributionPercent: number;
  matchedWords: number;
  interpretation: {
    primaryKind: EvidenceInterpretationKind;
    confidence: EvidenceInterpretationConfidence;
    reasons: string[];
    mixedKinds: EvidenceInterpretationKind[];
  };
  passageRefs: number[];
  /** archive aggregate card only — the individual named archive sources (public-safe names). */
  namedSources?: ReportEvidenceNamedSource[];
};

export type ReportEvidencePassage = {
  id: number;
  /** word indices into the submission's own canonical token stream. */
  wordStart: number;
  wordEnd: number;
  /** bounded excerpt of the STUDENT'S OWN text (never the source's text). */
  excerpt: string;
  sourceIds: string[];
  interpretation: {
    kind: EvidenceInterpretationKind;
    confidence: EvidenceInterpretationConfidence;
    tone: EvidenceInterpretationTone;
  };
};

export type ReportEvidenceInterpretation = {
  version: string;
  /** DISJOINT partition of the authoritative matched-position union. */
  positionsByKind: Record<EvidenceInterpretationKind, number[]>;
  countsByKind: Record<EvidenceInterpretationKind, number>;
  /** Σ countsByKind — equals the authoritative matched-position union size. */
  matchedWordCount: number;
  sources: ReportEvidenceSource[];
  passages: ReportEvidencePassage[];
  deferredKindsFolded: boolean;
};
