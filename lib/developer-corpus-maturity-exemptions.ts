import type { Client } from "@libsql/client";

/**
 * Developer control — accounts exempted from the 7-day corpus maturity gate
 * (lib/user-submission-corpus.ts's admissionEligibilitySql /
 * CORPUS_ACTIVATION_DELAY_DAYS). Storage-only CRUD for
 * developer_corpus_maturity_exemptions (drizzle/0047); the maturity gate
 * itself reads this table directly in admissionEligibilitySql — this module
 * is for the developer-dashboard add/remove/list surface only.
 *
 * Email is a LOOKUP KEY ONLY, never persisted. Canonicalization
 * (trim + lowercase) and exact-match lookup are byte-identical to
 * app/api/developer/reset-account-rooms/route.ts's own rule — the same one,
 * not a second copy of it.
 */

const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function canonicalizeExemptionEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isPlausibleEmail(email: string): boolean {
  return email.length > 0 && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}

export type CorpusMaturityExemption = {
  userId: string;
  email: string;
  createdAt: string;
  createdByUserId: string | null;
};

export async function listCorpusMaturityExemptions(client: Client): Promise<CorpusMaturityExemption[]> {
  const result = await client.execute(
    `SELECT e.user_id AS user_id, u.email AS email, e.created_at AS created_at, e.created_by_user_id AS created_by_user_id
     FROM developer_corpus_maturity_exemptions e
     JOIN users u ON u.id = e.user_id
     ORDER BY e.created_at DESC, e.user_id ASC`,
  );
  return (result.rows as unknown as { user_id: string; email: string; created_at: string; created_by_user_id: string | null }[]).map((row) => ({
    userId: row.user_id,
    email: row.email,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
  }));
}

export type AddExemptionResult =
  | { kind: "ok"; userId: string; email: string }
  | { kind: "not_found" }
  | { kind: "invalid_email" };

/** Resolves `email` -> users.id server-side (exact match, never LIKE) and persists ONLY the resolved user_id. */
export async function addCorpusMaturityExemption(
  client: Client,
  params: { email: string; createdByUserId: string },
): Promise<AddExemptionResult> {
  const canonicalEmail = canonicalizeExemptionEmail(params.email);
  if (!isPlausibleEmail(canonicalEmail)) return { kind: "invalid_email" };

  const resolved = await client.execute({
    sql: "SELECT id FROM users WHERE email = ?",
    args: [canonicalEmail],
  });
  if (resolved.rows.length === 0) return { kind: "not_found" };
  const userId = String((resolved.rows[0] as unknown as { id: string }).id);

  await client.execute({
    sql: "INSERT OR IGNORE INTO developer_corpus_maturity_exemptions (user_id, created_by_user_id) VALUES (?, ?)",
    args: [userId, params.createdByUserId],
  });
  return { kind: "ok", userId, email: canonicalEmail };
}

export async function removeCorpusMaturityExemption(client: Client, userId: string): Promise<void> {
  await client.execute({
    sql: "DELETE FROM developer_corpus_maturity_exemptions WHERE user_id = ?",
    args: [userId],
  });
}
