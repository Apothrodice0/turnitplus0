/**
 * G2 — the single gate for WRITING the ai-compact-v1 AI passage table (lib/ai-passage-table.ts): the lossless
 * compact form of an AI result's per-window `passages`, sent and persisted instead of a copy of every window's text.
 *
 * WHY A WRITE GATE (the same reader-first rollout lib/report-compact-persistence-flag.ts documents for C2): an AI
 * result written compact carries `passages: []` plus a `compactPassages` table. A reader that predates the table
 * would print "0 passages exceeded the review threshold" for it, so every reader must understand the table BEFORE
 * any writer emits one:
 *
 *   PHASE 1  deploy the reader + the server validator everywhere, flag OFF (the default) — every instance can READ
 *            legacy and compact/1 passages, none WRITES compact/1.
 *   PHASE 2  once every client bundle in the field is compact-aware, set the flag to "true" and redeploy — new
 *            automatic AI saves and AI Retries send and persist the compact table.
 *   STOP     set it back to anything else — future writes are legacy again; rows already written compact stay
 *            readable by every current reader.
 *
 * This gate governs WRITES ONLY. The reader (resolveAiPassages) and the server validator always understand compact/1,
 * whatever this returns — turning the flag off can never make an existing compact row unreadable, and the server never
 * refuses a valid compact table because the flag is off (it cannot know what a stale or newer client was built with).
 *
 * WHY `NEXT_PUBLIC_`: unlike the C2 gate (server-only, the SERVER compacts), this compaction happens in the BROWSER,
 * right after the model returns — the only place that still holds both the AI result and the manuscript — so the gate
 * must be visible to client code. Next.js inlines a `NEXT_PUBLIC_*` variable into the bundle at BUILD time, which is
 * what the project's one-flag-one-redeploy practice already assumes; it also means the property access below must stay
 * a literal `process.env.NEXT_PUBLIC_…` (a computed key would not be inlined). Under Node (route handlers, tests) it is
 * read fresh on every call.
 *
 * Absent / anything but the exact string "true" => OFF. No customer UI. Deliberately its own tiny file so the codec
 * has no other environment dependency.
 */
export const AI_COMPACT_PASSAGES_WRITE_FLAG = "NEXT_PUBLIC_AI_COMPACT_PASSAGES_WRITE_ENABLED" as const;

export function isAiCompactPassagesWriteEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AI_COMPACT_PASSAGES_WRITE_ENABLED === "true";
}

/**
 * Every AI-compact WRITE boundary takes this optional override. Omitted (the production case) means "whatever the flag
 * says right now"; tests pin it explicitly.
 */
export type AiCompactPassagesWriteOptions = {
  compactWrites?: boolean;
};

export function resolveAiCompactPassagesWrites(options?: AiCompactPassagesWriteOptions): boolean {
  return options?.compactWrites ?? isAiCompactPassagesWriteEnabled();
}
