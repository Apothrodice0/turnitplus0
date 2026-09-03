import type { DeclaredContext } from "./reuse-context-declarations";

/**
 * The single source of truth for the user-facing wording of each reuse
 * context. Every component that renders a declared context imports from
 * here rather than keeping its own copy — see components/reuse-context/*.
 *
 * `badge` is the concise noun-phrase shown next to a verification badge or
 * in a confirmation panel. `awaitingPhrase` completes the sentence
 * "You indicated this is …" on the unverified state. Neither string ever
 * uses "authorized", "verified", or "confirmed" as an affirmative
 * descriptor of an UNVERIFIED declaration — the confirmed-state copy that
 * does use "authorized" is only ever paired with MUTUALLY_CONFIRMED.
 *
 * These labels are contextual-authorization wording only. They never imply
 * same owner, same person, SELF, verified authorship, plagiarism-free, or
 * removal from the similarity score.
 */
export const REUSE_CONTEXT_LABELS: Record<DeclaredContext, { badge: string; awaitingPhrase: string }> = {
  SUPERVISOR_COPY: { badge: "Supervisor-held copy", awaitingPhrase: "a copy held by your supervisor" },
  COAUTHOR_COPY: { badge: "Co-author's copy", awaitingPhrase: "a copy submitted by a co-author" },
  INSTITUTIONAL_SUBMISSION: { badge: "Institutional submission", awaitingPhrase: "a submission made through your institution or instructor" },
  AUTHORIZED_ARCHIVAL_COPY: { badge: "Authorized archival copy", awaitingPhrase: "an authorized archival copy" },
  OTHER_AUTHORIZED_REUSE: { badge: "Other authorized reuse", awaitingPhrase: "another authorized reuse of your work" },
};

/** The one canonical sentence that keeps a confirmed annotation from being read as score suppression. */
export const REUSE_CONTEXT_SCORE_UNCHANGED_CONFIRMED =
  "Confirmed reuse context. This source is still counted in your similarity score.";

/** The unverified-state equivalent. */
export const REUSE_CONTEXT_SCORE_UNCHANGED_UNVERIFIED =
  "This does not change your similarity score, confirmed or not.";

export const REUSE_CONTEXT_BADGE_CONFIRMED = "Confirmed authorized reuse";
export const REUSE_CONTEXT_BADGE_UNVERIFIED = "Reuse context declared — awaiting confirmation";

/** The declare-form radio options — value + the sentence a submitter picks. */
export const REUSE_CONTEXT_FORM_OPTIONS: { value: DeclaredContext; label: string }[] = [
  { value: "SUPERVISOR_COPY", label: "My supervisor submitted this" },
  { value: "COAUTHOR_COPY", label: "A co-author submitted this" },
  { value: "INSTITUTIONAL_SUBMISSION", label: "This was submitted through my institution/instructor" },
  { value: "AUTHORIZED_ARCHIVAL_COPY", label: "This is an authorized archival copy" },
  { value: "OTHER_AUTHORIZED_REUSE", label: "Other authorized reuse" },
];
