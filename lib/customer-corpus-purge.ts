import type { Client, Transaction } from "@libsql/client";
import { buildReportAdmissionAccountPrefix } from "./corpus-admission-source-ref";
import { bumpCorpusMatchGeneration } from "./corpus-match-generation";

/**
 * MANUAL TOOL ONLY: nothing in the product calls this. The customer comparison corpus is active (owner decision 2026-10-31)
 * and its records outlive reports by design (lib/comparison-source-lifecycle.ts); removing any of them is an owner decision,
 * run deliberately against a backed-up database. It removes customer manuscript text retained by the corpus admission path
 * and every copy of it: the stored text, its accepted fingerprints, its promotion and the representation and shingles
 * that made it matchable. planRetainedCorpusPurge counts; it writes nothing. applyRetainedCorpusPurge does all of it in one
 * transaction, then bumps the corpus match generation so no other report keeps a match computed from the removed text.
 *
 * Scope is only ever report-upload decisions (customer uploads), for one account or for all of them. A representation is
 * removed only when nothing else backs it: never one in the built-in archive, and never one still referenced by a
 * submission or by a promotion outside this scope. The admin audit log has no document text and is kept.
 */
export type RetainedCorpusScope = { accountId: string } | { allCustomerUploads: true };

export type RetainedCorpusPurgePlan = {
  decisions: number;
  retainedTexts: number;
  retainedCharacters: number;
  acceptedRepresentations: number;
  acceptedShingles: number;
  devicePassportProvenance: number;
  promotions: number;
  admissionJobs: number;
  representationsRemoved: number;
  representationCharactersRemoved: number;
  representationShinglesRemoved: number;
  representationsKeptArchive: number;
  representationsKeptOtherBacking: number;
};

type Executor = Pick<Client, "execute"> | Pick<Transaction, "execute">;
const CHUNK = 200;
const count = (rows: unknown[]) => Number((rows[0] as { n: number | bigint | null }).n ?? 0);

function scopeFilter(scope: RetainedCorpusScope): { sql: string; args: string[] } {
  if ("accountId" in scope) {
    const prefix = buildReportAdmissionAccountPrefix(scope.accountId);
    return { sql: "substr(source_ref, 1, length(?)) = ?", args: [prefix, prefix] };
  }
  return { sql: "source_ref LIKE 'report-upload:%'", args: [] };
}

async function sumOverChunks(exec: Executor, ids: readonly string[], sql: (placeholders: string) => string): Promise<number> {
  let total = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    total += count((await exec.execute({ sql: sql(chunk.map(() => "?").join(",")), args: chunk })).rows);
  }
  return total;
}

async function decisionIds(exec: Executor, scope: RetainedCorpusScope): Promise<string[]> {
  const filter = scopeFilter(scope);
  const result = await exec.execute({ sql: `SELECT id FROM corpus_admission_decisions WHERE ${filter.sql}`, args: filter.args });
  return (result.rows as unknown as { id: string }[]).map((r) => r.id);
}

async function representationsOf(exec: Executor, decisions: readonly string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (let i = 0; i < decisions.length; i += CHUNK) {
    const chunk = decisions.slice(i, i + CHUNK);
    const result = await exec.execute({
      sql: `SELECT DISTINCT representation_id FROM corpus_admission_promotions WHERE representation_id IS NOT NULL AND decision_id IN (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    });
    for (const row of result.rows as unknown as { representation_id: string }[]) ids.add(row.representation_id);
  }
  return [...ids];
}

/** Splits candidate representations into what can go and what something else still needs. `decisions` are about to be removed. */
async function classifyRepresentations(exec: Executor, representations: readonly string[], decisions: readonly string[]) {
  const removing = new Set(decisions);
  const removable: string[] = [];
  let archive = 0;
  let otherBacking = 0;
  for (const id of representations) {
    const inArchive = count((await exec.execute({ sql: "SELECT COUNT(*) AS n FROM archive_document_representations WHERE representation_id = ?", args: [id] })).rows) > 0;
    if (inArchive) {
      archive += 1;
      continue;
    }
    const references = count((await exec.execute({ sql: "SELECT COUNT(*) AS n FROM corpus_submission_references WHERE representation_id = ?", args: [id] })).rows);
    const promotions = (await exec.execute({ sql: "SELECT decision_id FROM corpus_admission_promotions WHERE representation_id = ?", args: [id] })).rows as unknown as { decision_id: string }[];
    if (references > 0 || promotions.some((p) => !removing.has(p.decision_id))) otherBacking += 1;
    else removable.push(id);
  }
  return { removable, archive, otherBacking };
}

export async function planRetainedCorpusPurge(exec: Executor, scope: RetainedCorpusScope): Promise<RetainedCorpusPurgePlan> {
  const decisions = await decisionIds(exec, scope);
  const filter = scopeFilter(scope);
  const { removable, archive, otherBacking } = await classifyRepresentations(exec, await representationsOf(exec, decisions), decisions);
  return {
    decisions: decisions.length,
    retainedTexts: await sumOverChunks(exec, decisions, (p) => `SELECT COUNT(*) AS n FROM corpus_admission_content_store WHERE decision_id IN (${p})`),
    retainedCharacters: await sumOverChunks(exec, decisions, (p) => `SELECT SUM(length(canonical_text)) AS n FROM corpus_admission_content_store WHERE decision_id IN (${p})`),
    acceptedRepresentations: await sumOverChunks(exec, decisions, (p) => `SELECT COUNT(*) AS n FROM corpus_admission_accepted_representations WHERE decision_id IN (${p})`),
    acceptedShingles: await sumOverChunks(exec, decisions, (p) => `SELECT COUNT(*) AS n FROM corpus_admission_accepted_shingles WHERE accepted_representation_id IN (SELECT id FROM corpus_admission_accepted_representations WHERE decision_id IN (${p}))`),
    devicePassportProvenance: await sumOverChunks(exec, decisions, (p) => `SELECT COUNT(*) AS n FROM corpus_admission_decision_device_provenance WHERE decision_id IN (${p})`),
    promotions: await sumOverChunks(exec, decisions, (p) => `SELECT COUNT(*) AS n FROM corpus_admission_promotions WHERE decision_id IN (${p})`),
    admissionJobs: count((await exec.execute({ sql: `SELECT COUNT(*) AS n FROM corpus_admission_report_jobs WHERE ${filter.sql}`, args: filter.args })).rows),
    representationsRemoved: removable.length,
    representationCharactersRemoved: await sumOverChunks(exec, removable, (p) => `SELECT SUM(length(canonical_text)) AS n FROM corpus_document_representations WHERE id IN (${p})`),
    representationShinglesRemoved: await sumOverChunks(exec, removable, (p) => `SELECT COUNT(*) AS n FROM corpus_document_shingles WHERE representation_id IN (${p})`),
    representationsKeptArchive: archive,
    representationsKeptOtherBacking: otherBacking,
  };
}

async function deleteIn(exec: Executor, ids: readonly string[], sql: (placeholders: string) => string): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await exec.execute({ sql: sql(chunk.map(() => "?").join(",")), args: chunk });
  }
}

export async function applyRetainedCorpusPurge(client: Client, scope: RetainedCorpusScope): Promise<RetainedCorpusPurgePlan> {
  const tx = await client.transaction("write");
  try {
    const plan = await planRetainedCorpusPurge(tx, scope);
    const decisions = await decisionIds(tx, scope);
    const filter = scopeFilter(scope);
    const { removable } = await classifyRepresentations(tx, await representationsOf(tx, decisions), decisions);
    await tx.execute({ sql: `DELETE FROM corpus_admission_report_jobs WHERE ${filter.sql}`, args: filter.args });
    await deleteIn(tx, decisions, (p) => `DELETE FROM corpus_admission_promotions WHERE decision_id IN (${p})`);
    await deleteIn(tx, decisions, (p) => `DELETE FROM corpus_admission_accepted_shingles WHERE accepted_representation_id IN (SELECT id FROM corpus_admission_accepted_representations WHERE decision_id IN (${p}))`);
    await deleteIn(tx, decisions, (p) => `DELETE FROM corpus_admission_accepted_representations WHERE decision_id IN (${p})`);
    await deleteIn(tx, decisions, (p) => `DELETE FROM corpus_admission_content_store WHERE decision_id IN (${p})`);
    await deleteIn(tx, decisions, (p) => `DELETE FROM corpus_admission_decision_device_provenance WHERE decision_id IN (${p})`);
    await deleteIn(tx, decisions, (p) => `DELETE FROM corpus_admission_decisions WHERE id IN (${p})`);
    await deleteIn(tx, removable, (p) => `DELETE FROM corpus_document_shingles WHERE representation_id IN (${p})`);
    await deleteIn(tx, removable, (p) => `DELETE FROM corpus_document_representations WHERE id IN (${p})`);
    if (decisions.length > 0) await bumpCorpusMatchGeneration(tx);
    await tx.commit();
    return plan;
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  } finally {
    tx.close();
  }
}
