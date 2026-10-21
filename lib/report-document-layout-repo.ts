import type { Client, InStatement, Transaction } from "@libsql/client";

/**
 * SAVED DOCUMENT LAYOUT — storage (drizzle/0055_report_document_layouts.sql). SERVER-SIDE ONLY.
 *
 * Every read and write is keyed by the report AND its owner; callers check the report belongs to the session's
 * account first (findReportRowForUser). No function logs document content.
 *
 * Until migration 0055 is applied to an environment's database the tables do not exist: reads then answer
 * "no saved layout" and deletes do nothing, so the report and its standard PDF are never affected.
 */

type Exec = Pick<Client, "execute"> | Pick<Transaction, "execute">;

function isMissingTable(error: unknown): boolean {
  return /no such table:\s*report_document_(layouts|media)/i.test(error instanceof Error ? error.message : String(error));
}

export type SavedLayoutRow = { layoutVersion: number; textSha256: string; layoutJson: string; mediaIndexes: number[]; createdAt: number };

/** Replaces the report's saved layout and images in one transaction. */
export async function saveReportDocumentLayout(
  client: Pick<Client, "batch">,
  params: { reportId: string; userId: string; layoutVersion: number; textSha256: string; layoutJson: string; media: Array<{ contentType: string; bytes: Uint8Array }> },
): Promise<void> {
  const { reportId, userId } = params;
  const statements: InStatement[] = [
    { sql: "DELETE FROM report_document_media WHERE report_id = ? AND user_id = ?", args: [reportId, userId] },
    { sql: "DELETE FROM report_document_layouts WHERE report_id = ? AND user_id = ?", args: [reportId, userId] },
    {
      sql: "INSERT INTO report_document_layouts (report_id, user_id, layout_version, text_sha256, layout_json, media_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [reportId, userId, params.layoutVersion, params.textSha256, params.layoutJson, params.media.length, Date.now()],
    },
    ...params.media.map((m, i): InStatement => ({
      sql: "INSERT INTO report_document_media (report_id, user_id, media_index, content_type, bytes) VALUES (?, ?, ?, ?, ?)",
      args: [reportId, userId, i, m.contentType, m.bytes],
    })),
  ];
  await client.batch(statements, "write");
}

export async function readReportDocumentLayout(client: Exec, reportId: string, userId: string): Promise<SavedLayoutRow | null> {
  try {
    const row = (await client.execute({
      sql: "SELECT layout_version, text_sha256, layout_json, created_at FROM report_document_layouts WHERE report_id = ? AND user_id = ?",
      args: [reportId, userId],
    })).rows[0];
    if (!row) return null;
    const media = await client.execute({
      sql: "SELECT media_index FROM report_document_media WHERE report_id = ? AND user_id = ? ORDER BY media_index",
      args: [reportId, userId],
    });
    return {
      layoutVersion: Number(row.layout_version),
      textSha256: String(row.text_sha256),
      layoutJson: String(row.layout_json),
      mediaIndexes: media.rows.map((r) => Number(r.media_index)),
      createdAt: Number(row.created_at),
    };
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

export async function readReportDocumentMedia(client: Exec, reportId: string, userId: string, index: number): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  try {
    const row = (await client.execute({
      sql: "SELECT content_type, bytes FROM report_document_media WHERE report_id = ? AND user_id = ? AND media_index = ?",
      args: [reportId, userId, index],
    })).rows[0];
    if (!row) return null;
    const raw = row.bytes as unknown;
    const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
    return bytes ? { contentType: String(row.content_type), bytes } : null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

/**
 * Removes one report's saved layout and images (report delete, room replacement) — scoped to the owner too, since
 * report ids are client-generated and need not be unique across accounts. Best effort; never throws.
 */
export async function deleteReportDocumentLayout(client: Exec, reportId: string, userId: string): Promise<void> {
  for (const sql of ["DELETE FROM report_document_media WHERE report_id = ? AND user_id = ?", "DELETE FROM report_document_layouts WHERE report_id = ? AND user_id = ?"]) {
    try {
      await client.execute({ sql, args: [reportId, userId] });
    } catch (error) {
      if (!isMissingTable(error)) console.error("report document layout cleanup failed (non-fatal)", error instanceof Error ? error.name : "error");
    }
  }
}

/** Removes every saved layout and image of an account (account deletion). Best effort; never throws. */
export async function deleteReportDocumentLayoutsForUser(client: Exec, userId: string): Promise<void> {
  for (const sql of ["DELETE FROM report_document_media WHERE user_id = ?", "DELETE FROM report_document_layouts WHERE user_id = ?"]) {
    try {
      await client.execute({ sql, args: [userId] });
    } catch (error) {
      if (!isMissingTable(error)) console.error("report document layout cleanup failed (non-fatal)", error instanceof Error ? error.name : "error");
    }
  }
}
