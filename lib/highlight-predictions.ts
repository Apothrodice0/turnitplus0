import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type { SessionUser } from "./auth-session";
import { accountActivationEnforced, resolveRoomPolicy } from "./account-entitlements";
import { HighlightModelError, highlightModelConfig, requestPredictedHighlights, sanitizePredictedRanges, type HighlightModelConfig } from "./highlight-model";
import { getReportsDbClient } from "./reports-db";
import type { PredictedHighlightRange, SimilarityReport } from "./report-types";
import { runAfterResponse } from "./run-after-response";
import { comparisonText } from "./similarity-core";

/**
 * HIGHLIGHT PREDICTIONS — the one stored result of the highlight model for a saved report (drizzle/0058). A report's
 * first save queues it and a background job fills it in; every later view only reads it, so opening, reopening or
 * downloading a report never calls the model. A report that gets no prediction (the service down, the account not
 * eligible, a document over the limit) is simply its verified report.
 *
 * ONE WORKER, BOUNDED RETRIES. claimPrediction moves a due row to 'running' under a lease, so concurrent triggers
 * collapse to one model call, and the attempt number fences the result: a worker that lost its lease cannot overwrite a
 * newer one, and completing only ever UPDATEs, so a result that arrives after the report was deleted writes nothing.
 * A retryable failure waits (RETRY_DELAYS_MS); a further attempt starts from the sweep or from the owner's next read.
 *
 * NO REPORT LEFT WITHOUT A JOB. A report saved while the model was off or out of reach, or before the current model
 * version, has no current row; its owner's read queues one under the same rules as a first save. A finished failure is
 * reported as failed (never as a result with no passages), and the owner can start it again
 * (app/api/reports/[id]/highlight-prediction).
 *
 * DAILY CEILING. Every call first reserves its words against HIGHLIGHT_MODEL_DAILY_WORD_LIMIT for the UTC day
 * (highlight_model_usage_daily); one that does not fit waits for the next day without using up an attempt. This is the
 * exact, immediate spending stop; the cloud budget only reports after the fact.
 *
 * ACCESS. Rows answer only for their own report, and the routes that read them have already passed the report's
 * ownership and subscription checks. Reuse of a finished result stays inside one account, so one customer's document
 * never reveals anything about another's. Rows go with their report (lib/account-deletion.ts, app/api/reports).
 */
const LEASE_MS = 6 * 60_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const SWEEP_LIMIT = 5;

export type HighlightPredictionKey = { deviceKey: string; reportId: string };
type Executor = Pick<Client, "execute">;

let tableKnownPresent = false;

/** Whether drizzle/0058 has been applied. A positive answer is remembered for the process. */
export async function highlightPredictionTableExists(client: Executor): Promise<boolean> {
  if (tableKnownPresent) return true;
  const result = await client.execute({ sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'report_highlight_predictions'", args: [] });
  tableKnownPresent = Number((result.rows[0] as unknown as { n: number | bigint }).n) === 1;
  return tableKnownPresent;
}

/** Tests only: a test may drop or recreate its database. */
export function resetHighlightPredictionTableCacheForTest(): void {
  tableKnownPresent = false;
}

export function highlightPredictionTextHash(text: string): string {
  return createHash("sha256").update(comparisonText(text), "utf8").digest("hex");
}

const wordCount = (text: string) => text.match(/[^\W_]+/gu)?.length ?? 0;

/**
 * Who a prediction is made for, decided when the report is saved: an administrator or an account on
 * HIGHLIGHT_MODEL_OWNER_EMAILS, and with HIGHLIGHT_MODEL_SUBSCRIBERS_ENABLED=1 a customer whose subscription is active
 * right now (never the legacy free-access grace, an expired or a suspended plan).
 */
export async function canReceiveHighlightPredictions(client: Client, user: SessionUser, config: HighlightModelConfig): Promise<boolean> {
  if (!config.enabled) return false;
  if (user.role === "admin") return true;
  if (typeof user.email === "string" && config.ownerEmails.includes(user.email.trim().toLowerCase())) return true;
  if (!config.subscribersEnabled || !accountActivationEnforced()) return false;
  const policy = await resolveRoomPolicy(client, user);
  return policy.enforced && policy.state === "active" && policy.block === null && policy.grace === null;
}

/** Whether this report should get a prediction for this user: English, within the word limit, an eligible account. */
async function predictionWanted(client: Client, user: SessionUser, text: string, detectedLanguage: unknown, config: HighlightModelConfig): Promise<boolean> {
  if (!config.enabled || detectedLanguage !== "English" || wordCount(comparisonText(text)) > config.maxWords) return false;
  return (await highlightPredictionTableExists(client)) && (await canReceiveHighlightPredictions(client, user, config));
}

/** Queues the report's prediction, once; a report whose text or model changed starts again. */
async function enqueuePrediction(client: Executor, key: HighlightPredictionKey, accountId: string, modelVersion: string, textSha256: string, nowMs: number): Promise<void> {
  await client.execute({
    sql: `INSERT INTO report_highlight_predictions
            (report_device_key, report_id, account_id, model_version, text_sha256, status, attempts, next_attempt_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
          ON CONFLICT (report_device_key, report_id) DO UPDATE SET
            model_version = excluded.model_version, text_sha256 = excluded.text_sha256, status = 'pending', ranges_json = NULL,
            attempts = 0, lease_until = NULL, next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at
          WHERE report_highlight_predictions.model_version <> excluded.model_version
             OR report_highlight_predictions.text_sha256 <> excluded.text_sha256`,
    args: [key.deviceKey, key.reportId, accountId, modelVersion, textSha256, nowMs, nowMs, nowMs],
  });
}

/** The attempt number when this worker now owns the row; null when it is not due, finished, or owned by another worker. */
async function claimPrediction(client: Executor, key: HighlightPredictionKey, nowMs: number): Promise<number | null> {
  const result = await client.execute({
    sql: `UPDATE report_highlight_predictions
             SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
           WHERE report_device_key = ? AND report_id = ? AND attempts < ?
             AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'running' AND lease_until <= ?))
           RETURNING attempts`,
    args: [nowMs + LEASE_MS, nowMs, key.deviceKey, key.reportId, MAX_ATTEMPTS, nowMs, nowMs],
  });
  const row = result.rows[0] as unknown as { attempts: number | bigint } | undefined;
  return row ? Number(row.attempts) : null;
}

async function completePrediction(client: Executor, key: HighlightPredictionKey, attempt: number, ranges: PredictedHighlightRange[], nowMs: number): Promise<void> {
  await client.execute({
    sql: `UPDATE report_highlight_predictions SET status = 'complete', ranges_json = ?, lease_until = NULL, updated_at = ?
           WHERE report_device_key = ? AND report_id = ? AND status = 'running' AND attempts = ?`,
    args: [JSON.stringify(ranges), nowMs, key.deviceKey, key.reportId, attempt],
  });
}

async function recordFailure(client: Executor, key: HighlightPredictionKey, attempt: number, retryable: boolean, nowMs: number): Promise<void> {
  const delay = retryable ? RETRY_DELAYS_MS[attempt - 1] : undefined;
  await client.execute({
    sql: `UPDATE report_highlight_predictions SET status = ?, lease_until = NULL, next_attempt_at = ?, updated_at = ?
           WHERE report_device_key = ? AND report_id = ? AND status = 'running' AND attempts = ?`,
    args: [delay === undefined ? "failed" : "pending", nowMs + (delay ?? 0), nowMs, key.deviceKey, key.reportId, attempt],
  });
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Reserves today's share of the daily word limit for one call; false when it does not fit. Exact under concurrency. */
async function reserveDailyWords(client: Executor, words: number, limit: number, nowMs: number): Promise<boolean> {
  if (words > limit) return false;
  const result = await client.execute({
    sql: `INSERT INTO highlight_model_usage_daily (day, calls, words) VALUES (?, 1, ?)
          ON CONFLICT (day) DO UPDATE SET calls = calls + 1, words = words + excluded.words
           WHERE highlight_model_usage_daily.words + excluded.words <= ?
          RETURNING calls`,
    args: [utcDay(nowMs), words, limit],
  });
  return result.rows.length === 1;
}

/** Hands the claim back without using up an attempt; it runs again after the next UTC midnight. */
async function deferToNextDay(client: Executor, key: HighlightPredictionKey, attempt: number, nowMs: number): Promise<void> {
  const nextDay = Date.parse(`${utcDay(nowMs)}T00:00:00Z`) + 24 * 60 * 60_000 + 5 * 60_000;
  await client.execute({
    sql: `UPDATE report_highlight_predictions SET status = 'pending', attempts = attempts - 1, lease_until = NULL, next_attempt_at = ?, updated_at = ?
           WHERE report_device_key = ? AND report_id = ? AND status = 'running' AND attempts = ?`,
    args: [nextDay, nowMs, key.deviceKey, key.reportId, attempt],
  });
}

/** Rows whose lease ran out on their last attempt can never be claimed again: they are finished. */
async function closeExhaustedPredictions(client: Executor, nowMs: number): Promise<void> {
  await client.execute({
    sql: "UPDATE report_highlight_predictions SET status = 'failed', lease_until = NULL, updated_at = ? WHERE status = 'running' AND lease_until <= ? AND attempts >= ?",
    args: [nowMs, nowMs, MAX_ATTEMPTS],
  });
}

/** A finished result of this account for this exact text and model, from another report. */
async function reusableRanges(client: Executor, accountId: string, modelVersion: string, textSha256: string): Promise<string | null> {
  const result = await client.execute({
    sql: `SELECT ranges_json FROM report_highlight_predictions
           WHERE account_id = ? AND model_version = ? AND text_sha256 = ? AND status = 'complete' LIMIT 1`,
    args: [accountId, modelVersion, textSha256],
  });
  return (result.rows[0] as unknown as { ranges_json: string | null } | undefined)?.ranges_json ?? null;
}

/** Runs one prediction if it is due and unclaimed. Never throws: a failure is recorded and the report stays as it is. */
export async function processHighlightPrediction(
  key: HighlightPredictionKey,
  options: { config?: HighlightModelConfig; fetchImpl?: typeof fetch; openClient?: () => Promise<Client>; nowMs?: () => number } = {},
): Promise<void> {
  const config = options.config ?? highlightModelConfig();
  if (!config.enabled) return;
  const now = options.nowMs ?? Date.now;
  const client = await (options.openClient ?? getReportsDbClient)();
  try {
    const attempt = await claimPrediction(client, key, now());
    if (attempt === null) return;
    try {
      const row = (await client.execute({
        sql: `SELECT p.account_id, p.model_version, p.text_sha256,
                     CASE WHEN json_valid(r.payload_json) THEN json_extract(r.payload_json, '$.text') END AS text
                FROM report_highlight_predictions p
                LEFT JOIN saved_reports r ON r.device_key = p.report_device_key AND r.id = p.report_id
               WHERE p.report_device_key = ? AND p.report_id = ?`,
        args: [key.deviceKey, key.reportId],
      })).rows[0] as unknown as { account_id: string; model_version: string; text_sha256: string; text: unknown } | undefined;
      if (!row || typeof row.text !== "string" || highlightPredictionTextHash(row.text) !== row.text_sha256 || row.model_version !== config.modelVersion) {
        await recordFailure(client, key, attempt, false, now());
        return;
      }
      const reused = await reusableRanges(client, row.account_id, row.model_version, row.text_sha256);
      if (reused !== null) {
        await completePrediction(client, key, attempt, sanitizePredictedRanges(JSON.parse(reused), comparisonText(row.text).length), now());
        return;
      }
      if (!(await reserveDailyWords(client, wordCount(comparisonText(row.text)), config.dailyWordLimit, now()))) {
        console.error("highlight prediction deferred (non-fatal): daily word limit reached");
        await deferToNextDay(client, key, attempt, now());
        return;
      }
      const ranges = await requestPredictedHighlights(row.text, config, options.fetchImpl ?? fetch);
      await completePrediction(client, key, attempt, ranges, now());
    } catch (err) {
      const retryable = err instanceof HighlightModelError ? err.retryable : true;
      console.error("highlight prediction failed (non-fatal):", err instanceof Error ? err.name : "unknown", err instanceof HighlightModelError ? err.message : "");
      await recordFailure(client, key, attempt, retryable, now());
    }
  } catch (err) {
    console.error("highlight prediction job failed (non-fatal):", err instanceof Error ? err.name : "unknown");
  } finally {
    client.close();
  }
}

/**
 * Called once, right after a report's first save: queues the prediction and runs it after the response. Never fails the
 * save, and the customer does nothing: the report is usable at once, with its predictions when they arrive.
 */
export async function scheduleHighlightPrediction(
  client: Client,
  user: SessionUser,
  report: { deviceKey: string; reportId: string; text: string; detectedLanguage: unknown },
  options: { config?: HighlightModelConfig; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  try {
    const config = options.config ?? highlightModelConfig();
    if (!(await predictionWanted(client, user, report.text, report.detectedLanguage, config))) return;
    const key = { deviceKey: report.deviceKey, reportId: report.reportId };
    await enqueuePrediction(client, key, user.id, config.modelVersion, highlightPredictionTextHash(report.text), Date.now());
    await runAfterResponse(() => processHighlightPrediction(key, { config, fetchImpl: options.fetchImpl }));
  } catch (err) {
    console.error("highlight prediction not queued (non-fatal):", err instanceof Error ? err.name : "unknown");
  }
}

/**
 * Adds the stored prediction to one outgoing report for its owner. The model is never called from the read itself. A
 * row for another model or another text answers nothing; given its owner as `owner`, a report with no current row is
 * queued instead (see NO REPORT LEFT WITHOUT A JOB). `retry` (the API read, not the page) also lets a due prediction run
 * after the response, which is what finishes one when no scheduled sweep exists, as on a Preview deployment.
 */
export async function attachStoredPredictedHighlights(
  client: Client,
  report: SimilarityReport,
  key: HighlightPredictionKey,
  options: { owner?: SessionUser | null; retry?: boolean; config?: HighlightModelConfig; fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<void> {
  try {
    const config = options.config ?? highlightModelConfig();
    if (!config.enabled || !report.text || !(await highlightPredictionTableExists(client))) return;
    const row = (await client.execute({
      sql: `SELECT status, ranges_json, model_version, text_sha256, next_attempt_at, lease_until, attempts
              FROM report_highlight_predictions WHERE report_device_key = ? AND report_id = ?`,
      args: [key.deviceKey, key.reportId],
    })).rows[0] as unknown as
      | { status: string; ranges_json: string | null; model_version: string; text_sha256: string; next_attempt_at: number | bigint; lease_until: number | bigint | null; attempts: number | bigint }
      | undefined;
    const now = options.nowMs ?? Date.now();
    const textSha256 = highlightPredictionTextHash(report.text);
    if (!row || row.model_version !== config.modelVersion || row.text_sha256 !== textSha256) {
      const owner = options.owner;
      if (!owner || !(await predictionWanted(client, owner, report.text, report.features?.detectedLanguage, config))) return;
      await enqueuePrediction(client, key, owner.id, config.modelVersion, textSha256, now);
      report.predictedHighlightsPending = true;
      if (options.retry) await runAfterResponse(() => processHighlightPrediction(key, { config, fetchImpl: options.fetchImpl }));
      return;
    }
    if (row.status === "complete") {
      report.predictedHighlights = sanitizePredictedRanges(JSON.parse(row.ranges_json ?? "[]"), comparisonText(report.text).length);
      return;
    }
    const due = row.status === "pending" ? Number(row.next_attempt_at) <= now : row.lease_until !== null && Number(row.lease_until) <= now;
    // A last attempt whose worker was stopped (its lease ran out) can never be claimed again: finished, like a failure,
    // even before a sweep closes it (Preview has no scheduled sweep).
    if (row.status === "failed" || (row.status === "running" && due && Number(row.attempts) >= MAX_ATTEMPTS)) {
      report.predictedHighlightsFailed = true;
      return;
    }
    report.predictedHighlightsPending = true;
    if (options.retry && due) await runAfterResponse(() => processHighlightPrediction(key, { config, fetchImpl: options.fetchImpl }));
  } catch (err) {
    console.error("highlight prediction not read (non-fatal):", err instanceof Error ? err.name : "unknown");
  }
}

/**
 * The owner's "Try again" on a finished failure: a fresh set of attempts for the current model, run after the response.
 * False when there is nothing to start again (no row, another model, still pending or running, or complete). The daily
 * word ceiling still applies to every call it leads to.
 */
export async function retryFailedHighlightPrediction(
  client: Client,
  key: HighlightPredictionKey,
  options: { config?: HighlightModelConfig; fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<boolean> {
  const config = options.config ?? highlightModelConfig();
  if (!config.enabled || !(await highlightPredictionTableExists(client))) return false;
  const now = options.nowMs ?? Date.now();
  const result = await client.execute({
    sql: `UPDATE report_highlight_predictions
             SET status = 'pending', ranges_json = NULL, attempts = 0, lease_until = NULL, next_attempt_at = ?, updated_at = ?
           WHERE report_device_key = ? AND report_id = ? AND model_version = ?
             AND (status = 'failed' OR (status = 'running' AND lease_until <= ? AND attempts >= ?))
           RETURNING attempts`,
    args: [now, now, key.deviceKey, key.reportId, config.modelVersion, now, MAX_ATTEMPTS],
  });
  if (result.rows.length !== 1) return false;
  await runAfterResponse(() => processHighlightPrediction(key, { config, fetchImpl: options.fetchImpl }));
  return true;
}

/** Removes one report's stored prediction; part of deleting that report. A database without drizzle/0058 has nothing to remove. */
export async function deleteHighlightPrediction(client: Executor, key: HighlightPredictionKey): Promise<void> {
  if (!(await highlightPredictionTableExists(client))) return;
  await client.execute({ sql: "DELETE FROM report_highlight_predictions WHERE report_device_key = ? AND report_id = ?", args: [key.deviceKey, key.reportId] });
}

/** Removes an account's predictions whose report no longer exists, so it runs after the account's report rows are deleted. */
export async function deleteOrphanedHighlightPredictions(client: Executor, accountId: string): Promise<void> {
  if (!(await highlightPredictionTableExists(client))) return;
  await client.execute({
    sql: `DELETE FROM report_highlight_predictions
           WHERE account_id = ? AND NOT EXISTS (SELECT 1 FROM saved_reports r
                  WHERE r.device_key = report_highlight_predictions.report_device_key AND r.id = report_highlight_predictions.report_id)`,
    args: [accountId],
  });
}

/** The scheduled backstop: predictions that are due, for customers who never reopen their report. One at a time. */
export async function runHighlightPredictionSweep(
  client: Client,
  options: { limit?: number; nowMs?: number; config?: HighlightModelConfig; fetchImpl?: typeof fetch; openClient?: () => Promise<Client> } = {},
): Promise<{ due: number }> {
  const config = options.config ?? highlightModelConfig();
  if (!config.enabled || !(await highlightPredictionTableExists(client))) return { due: 0 };
  const nowMs = options.nowMs ?? Date.now();
  await closeExhaustedPredictions(client, nowMs);
  const due = (await client.execute({
    sql: `SELECT report_device_key, report_id FROM report_highlight_predictions
           WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'running' AND lease_until <= ?)
           ORDER BY next_attempt_at LIMIT ?`,
    args: [nowMs, nowMs, options.limit ?? SWEEP_LIMIT],
  })).rows as unknown as Array<{ report_device_key: string; report_id: string }>;
  for (const row of due) {
    await processHighlightPrediction({ deviceKey: row.report_device_key, reportId: row.report_id }, { config, fetchImpl: options.fetchImpl, openClient: options.openClient });
  }
  return { due: due.length };
}
