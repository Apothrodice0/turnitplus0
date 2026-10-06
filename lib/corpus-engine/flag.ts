/**
 * Corpus Engine v1 — the single application gate. DEFAULT OFF.
 *
 * Read fresh on every call, the same convention as lib/selective-corpus/flag.ts:
 * unset, or anything but the exact string "true", is OFF.
 *
 * With the flag OFF the application-facing entry point
 * (lib/corpus-engine/index.ts runCorpusEngineCandidateVerification) returns
 * state "DISABLED" before it resolves a corpus root, opens a file or tokenizes
 * anything. No route imports that entry point in Phase 1, so the hosted
 * report/similarity behaviour is the release candidate's, byte for byte,
 * whatever this variable is set to.
 *
 * Production: not set. Preview: not set.
 */
export const CORPUS_ENGINE_V1_FLAG = "CORPUS_ENGINE_V1_ENABLED";

export function isCorpusEngineV1Enabled(): boolean {
  return process.env[CORPUS_ENGINE_V1_FLAG] === "true";
}
