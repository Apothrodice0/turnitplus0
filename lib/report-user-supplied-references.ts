import { sanitizeExtractionDiagnostic } from "@/lib/evidence-interpretation";
import { canonicalSha256 } from "@/lib/document-identity";
import { DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION } from "@/lib/document-correspondence";
import {
  USER_SUPPLIED_REFERENCE_MATCHER_VERSION,
  type SuppliedReferenceVerifiedEvidence,
  type SuppliedReferenceChannelResult,
} from "@/lib/user-supplied-references";
import {
  SUPPORTED_REFERENCE_FILE_TYPES,
  MAX_REFERENCE_FILES,
  MAX_REFERENCE_FILENAME_CHARS,
  type SuppliedReferenceInput,
  type SuppliedReferenceFileType,
} from "@/lib/user-supplied-reference-constants";

/**
 * USER-SUPPLIED REFERENCES V1 / V1.1 — server-side trust boundary.
 *
 * TRUST SEMANTICS (V1.1 RULE 1). USER_SUPPLIED_REFERENCE is USER-PROVIDED
 * evidence. The server verifies TEXTUAL OVERLAP against the supplied content
 * with the existing matcher, but never represents the source as independently
 * discovered or independently authenticated. Its public-safe label / badge is
 * exactly "Supplied reference" (see lib/evidence-interpretation adapters +
 * lib/report-v2-view.ts). The overlap itself is matcher-verified; the SOURCE is
 * not.
 *
 * The client sends reference files' ALREADY-EXTRACTED text as an
 * `userSuppliedReferences` sibling of the save payload (never inside `payload` —
 * same pattern as `academicSearchDiagnosticsId` / `extractionCompleteness`).
 * From the client we take ONLY: the file's own name, its type, and the extracted
 * text. EVERYTHING derived — matched positions, matched words, contribution %,
 * admission verdict/reason, interpretation, completion — is (re)computed
 * server-side by lib/user-supplied-references.ts's `verifySuppliedReferences`.
 *
 * The in-payload `userSuppliedReferenceEvidence` / `userSuppliedReferenceChannel`
 * / `userSuppliedReferences` / `userSuppliedReferenceGuard` all stay on
 * CLIENT_UNTRUSTED_EVIDENCE_INTERPRETATION_KEYS and are stripped before
 * persistence — only server-computed values are written.
 */

const MAX_FILENAME_CHARS = MAX_REFERENCE_FILENAME_CHARS;

function isFileType(v: unknown): v is SuppliedReferenceFileType {
  return typeof v === "string" && (SUPPORTED_REFERENCE_FILE_TYPES as readonly string[]).includes(v);
}

/**
 * Shape the raw client sibling into a safe SuppliedReferenceInput[] (or []).
 *
 * Structural bounds only — count (`MAX_REFERENCE_FILES`) and filename length. The
 * per-reference extracted text is NEVER truncated here: an over-limit reference
 * is kept verbatim so `referenceTransportBudgetError` (called by the route right
 * after this) can reject the WHOLE request with a 413 rather than silently
 * checking a prefix. Aggregate / byte / per-reference ceilings all live in that
 * one guard so the client and server agree exactly.
 */
export function sanitizeSuppliedReferenceInputs(raw: unknown): SuppliedReferenceInput[] {
  if (!Array.isArray(raw)) return [];
  const out: SuppliedReferenceInput[] = [];
  for (const item of raw.slice(0, MAX_REFERENCE_FILES)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const fileType = isFileType(r.fileType) ? r.fileType : null;
    if (!fileType) continue;
    const fileName =
      typeof r.fileName === "string" && r.fileName.trim().length > 0
        ? r.fileName.slice(0, MAX_FILENAME_CHARS)
        : `reference.${fileType}`;
    const extractedText = typeof r.extractedText === "string" ? r.extractedText : "";
    out.push({
      fileName,
      fileType,
      extractedText,
      extraction: sanitizeExtractionDiagnostic(r.extraction),
    });
  }
  return out;
}

/** For computeUnifiedSimilarity — the admitted references' verified passages. */
export function admittedReferenceEvidenceForUnifiedSimilarity(
  references: readonly SuppliedReferenceVerifiedEvidence[] | null | undefined,
): Array<{ sourceId: string; matchedPassages: SuppliedReferenceVerifiedEvidence["verifiedPassages"] }> {
  return (references ?? [])
    .filter((r) => r.admitted && (r.verifiedPassages?.length ?? 0) > 0)
    .map((r) => ({ sourceId: r.key, matchedPassages: r.verifiedPassages }));
}

// ───────────────────────────────────────────────────────────────────────────
// V1.1 — SAFE RESAVE CARRY-FORWARD
// ───────────────────────────────────────────────────────────────────────────

export const USER_SUPPLIED_REFERENCE_GUARD_VERSION = "user-supplied-reference-guard-v1";

/**
 * V1.1 RULE 3/5 — the INTERNAL carry-forward guard. Persisted inside
 * `payload_json` so a later resave that omits the raw reference inputs can
 * decide whether the persisted verified evidence still applies. NEVER exposed to
 * an ordinary user: stripped from every GET / SSR / receipt response (like
 * `verifiedAcademicSearchDiagnosticsId`). It is not a source identity, carries
 * no filename / storage id / account id, and never appears on a source card.
 *
 * `manuscriptDigest` = `canonicalSha256(manuscript text)` at the moment the
 * reference evidence was computed — the same canonical submission identity the
 * scholarly trust boundary already uses. The version stamps make a carry-forward
 * a strict "compatible cache hit" (V1.1 RULE 6): if the channel or matcher/
 * admission version has since changed, the persisted evidence is NOT reused.
 */
export type UserSuppliedReferenceGuard = {
  manuscriptDigest: string;
  channelVersion: string;
  matcherVersion: string;
  guardVersion: string;
};

export function buildUserSuppliedReferenceGuard(manuscriptText: string): UserSuppliedReferenceGuard {
  return {
    manuscriptDigest: canonicalSha256(manuscriptText ?? ""),
    channelVersion: USER_SUPPLIED_REFERENCE_MATCHER_VERSION,
    matcherVersion: DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION,
    guardVersion: USER_SUPPLIED_REFERENCE_GUARD_VERSION,
  };
}

function sanitizeGuard(raw: unknown): UserSuppliedReferenceGuard | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.manuscriptDigest !== "string" || !/^[a-f0-9]{64}$/.test(g.manuscriptDigest)) return null;
  return {
    manuscriptDigest: g.manuscriptDigest,
    channelVersion: typeof g.channelVersion === "string" ? g.channelVersion : "",
    matcherVersion: typeof g.matcherVersion === "string" ? g.matcherVersion : "",
    guardVersion: typeof g.guardVersion === "string" ? g.guardVersion : "",
  };
}

function sanitizePersistedEvidence(raw: unknown): SuppliedReferenceVerifiedEvidence[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: SuppliedReferenceVerifiedEvidence[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.key !== "string" || typeof r.safeLabel !== "string") continue;
    const passages = Array.isArray(r.verifiedPassages)
      ? r.verifiedPassages
          .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
          .map((p) => ({
            submittedWordStart: Number(p.submittedWordStart) | 0,
            submittedWordEnd: Number(p.submittedWordEnd) | 0,
            matchedWordCount: Number(p.matchedWordCount) | 0,
          }))
          .filter((p) => p.submittedWordEnd >= p.submittedWordStart && p.submittedWordStart >= 0)
      : [];
    out.push({
      key: r.key,
      safeLabel: r.safeLabel,
      fileType: r.fileType === "pdf" || r.fileType === "docx" || r.fileType === "txt" ? r.fileType : "txt",
      extractionStatus:
        r.extractionStatus === "COMPLETE" || r.extractionStatus === "PARTIAL" || r.extractionStatus === "FAILED"
          ? r.extractionStatus
          : "UNKNOWN",
      analyzableWordCount: typeof r.analyzableWordCount === "number" ? r.analyzableWordCount : null,
      matchedWords: Number(r.matchedWords) | 0,
      contributionPercent: Math.min(100, Math.max(0, Number(r.contributionPercent) | 0)),
      admitted: r.admitted === true,
      admissionReason: typeof r.admissionReason === "string" ? r.admissionReason.slice(0, 200) : "",
      verifiedPassages: r.admitted === true ? passages : [],
    });
  }
  return out.length > 0 ? out : null;
}

export type UserSuppliedReferencePersistedChannel = {
  state: "COMPLETE" | "PARTIAL";
  suppliedCount: number;
  checkedCount: number;
  failedCount: number;
};

function channelFromResult(c: SuppliedReferenceChannelResult): UserSuppliedReferencePersistedChannel {
  return {
    state: c.channelState === "PARTIAL" ? "PARTIAL" : "COMPLETE",
    suppliedCount: c.suppliedCount,
    checkedCount: c.checkedCount,
    failedCount: c.failedCount,
  };
}

function sanitizePersistedChannel(raw: unknown): UserSuppliedReferencePersistedChannel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const state = c.state === "PARTIAL" ? "PARTIAL" : c.state === "COMPLETE" ? "COMPLETE" : null;
  if (!state) return null;
  return {
    state,
    suppliedCount: Math.max(0, Number(c.suppliedCount) | 0),
    checkedCount: Math.max(0, Number(c.checkedCount) | 0),
    failedCount: Math.max(0, Number(c.failedCount) | 0),
  };
}

export type ResolveUserSuppliedReferenceEvidenceResult = {
  /** FRESH: new refs supplied, recomputed. CARRY_FORWARD: same manuscript, compatible
   *  version, persisted evidence reused verbatim. NONE: nothing to persist.
   *  DROPPED_MANUSCRIPT_CHANGED: persisted evidence discarded because the manuscript changed.
   *  DROPPED_VERSION_INCOMPATIBLE: discarded because the channel/matcher version moved on. */
  action: "FRESH" | "CARRY_FORWARD" | "NONE" | "DROPPED_MANUSCRIPT_CHANGED" | "DROPPED_VERSION_INCOMPATIBLE";
  evidence: SuppliedReferenceVerifiedEvidence[] | null;
  channel: UserSuppliedReferencePersistedChannel | null;
  guard: UserSuppliedReferenceGuard | null;
};

/**
 * V1.1 RULE 3 — decide what supplied-reference evidence a save should persist.
 *
 *   new refs supplied ............................ FRESH  (recompute + replace, new guard)
 *   no new refs, persisted evidence, SAME
 *     manuscript + COMPATIBLE versions ........... CARRY_FORWARD (reuse verbatim, keep guard/channel)
 *   no new refs, persisted evidence, manuscript
 *     changed ................................... DROPPED_MANUSCRIPT_CHANGED (evidence removed)
 *   no new refs, persisted evidence, version
 *     moved on ................................... DROPPED_VERSION_INCOMPATIBLE (can't reuse; no raw text to recompute)
 *   no new refs, nothing persisted .............. NONE
 *
 * Pure. The manuscript identity check uses `canonicalSha256` — either the
 * persisted guard's own `manuscriptDigest`, or (a report saved before the guard
 * existed) `canonicalSha256(persistedManuscriptText)`.
 */
export function resolveUserSuppliedReferenceEvidenceForSave(input: {
  manuscriptText: string;
  /** the channel result from verifySuppliedReferences, when NEW reference inputs were supplied this save; else null. */
  freshChannel: SuppliedReferenceChannelResult | null;
  /** the previously-persisted, server-generated values (raw from the DB row). */
  persistedEvidenceRaw: unknown;
  persistedChannelRaw: unknown;
  persistedGuardRaw: unknown;
  /** the persisted report's own manuscript text (for the guard-less legacy fallback). */
  persistedManuscriptText?: string | null;
}): ResolveUserSuppliedReferenceEvidenceResult {
  const currentDigest = canonicalSha256(input.manuscriptText ?? "");

  if (input.freshChannel) {
    return {
      action: "FRESH",
      evidence: input.freshChannel.references,
      channel: channelFromResult(input.freshChannel),
      guard: buildUserSuppliedReferenceGuard(input.manuscriptText),
    };
  }

  const persistedEvidence = sanitizePersistedEvidence(input.persistedEvidenceRaw);
  if (!persistedEvidence) return { action: "NONE", evidence: null, channel: null, guard: null };

  const persistedChannel = sanitizePersistedChannel(input.persistedChannelRaw);
  const guard = sanitizeGuard(input.persistedGuardRaw);

  const persistedDigest =
    guard?.manuscriptDigest ??
    (typeof input.persistedManuscriptText === "string" ? canonicalSha256(input.persistedManuscriptText) : null);

  if (!persistedDigest || persistedDigest !== currentDigest) {
    return { action: "DROPPED_MANUSCRIPT_CHANGED", evidence: null, channel: null, guard: null };
  }

  // V1.1 RULE 6 — a carry-forward is a compatible cache hit only. If there is a
  // guard, its channel + matcher versions must match today's. A guard-less
  // legacy report is treated as compatible (it was produced by this same code).
  if (
    guard &&
    (guard.channelVersion !== USER_SUPPLIED_REFERENCE_MATCHER_VERSION ||
      guard.matcherVersion !== DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION)
  ) {
    return { action: "DROPPED_VERSION_INCOMPATIBLE", evidence: null, channel: null, guard: null };
  }

  return {
    action: "CARRY_FORWARD",
    evidence: persistedEvidence,
    channel: persistedChannel,
    guard: buildUserSuppliedReferenceGuard(input.manuscriptText),
  };
}

/** V1.1 RULE 5 — remove the internal carry-forward guard from an outbound
 *  payload (GET / SSR / receipt). Mutates a shallow copy is NOT done here; the
 *  caller `delete`s the key, this is the single source of truth for the name. */
export const USER_SUPPLIED_REFERENCE_GUARD_KEY = "userSuppliedReferenceGuard" as const;
