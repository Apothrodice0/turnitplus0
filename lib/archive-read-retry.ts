import type { Client, InStatement, InArgs, ResultSet } from "@libsql/client";

/**
 * 100k-scale architecture — bounded read-retry resilience for the SERVER-SIDE
 * archive matcher ONLY (lib/archive-server-analysis.ts →
 * lib/archive-corpus-matching.ts and its discovery helpers).
 *
 * WHY: Turso/libsql occasionally answers an archive discovery read with a
 * transient HTTP 502/503/504 or a connection-reset / timeout at the transport
 * layer — most visibly during the phrase-fallback fan-out, which issues many
 * small FTS round-trips. A single such blip currently makes
 * matchAgainstArchiveCorpus throw, POST /api/archive/match fail, and the whole
 * client analysis fail (no browser fallback — that is deliberate, see
 * lib/archive-analysis-runtime.ts). A short, strictly-bounded retry recovers
 * the overwhelming majority of these without changing any result.
 *
 * WHAT THIS IS NOT: it is not a general application DB retry layer. It wraps
 * ONLY `execute()` (the sole method the matcher request path uses — it never
 * batches or opens a transaction), retries ONLY clearly-transient transport
 * failures on statements that are read-shaped (SELECT / WITH), and its retry
 * budget is shared across ONE matcher request then discarded. It never touches
 * a write path (rate-limit buckets, report writes, migrations, seeds, DF /
 * co-source / FTS rebuilds) — none of those construct this wrapper.
 *
 * FAIL-CLOSED is preserved: once the per-read attempt cap or the shared
 * per-request retry budget is exhausted, the next transient failure propagates
 * unchanged and the matcher still throws.
 */

/** The narrow client surface the archive matcher request path uses. A real
 *  @libsql/client `Client` satisfies it structurally; the retry wrapper
 *  implements exactly this and nothing else, so it can never be used to batch
 *  or open a transaction. */
export type ArchiveReadClient = Pick<Client, "execute">;

// ── LOCKED retry policy ───────────────────────────────────────────────────
// A change to any of these is a visible, reviewed edit.

/** Initial attempt + at most this many retries, PER individual read. */
export const ARCHIVE_READ_MAX_RETRIES_PER_READ = 2;
/** Retries (attempts beyond the initial one) shared across the WHOLE matcher
 *  request. Not a count of database operations — a count of recoveries. */
export const ARCHIVE_READ_SHARED_RETRY_BUDGET = 6;
/** Backoff before retry N (0-indexed: before the 1st retry, before the 2nd).
 *  A 3rd+ retry never happens (per-read cap is 2), but the last value is
 *  reused defensively if the cap is ever raised. */
export const ARCHIVE_READ_BACKOFF_MS: readonly number[] = [250, 600];
/** ± jitter applied to each backoff (production only; tests pass random=()=>0.5
 *  for exact values). */
export const ARCHIVE_READ_JITTER_RATIO = 0.2;

// ── transient-transport classification ────────────────────────────────────

/** HTTP statuses that are a transient gateway/upstream blip, not a client or
 *  application error. 500 / 501 / 505 are deliberately NOT here. */
const RETRIABLE_HTTP_STATUS = new Set([502, 503, 504]);

/** Node / undici transport error codes that mean "the connection failed in
 *  flight" — safe to retry an idempotent read. Deliberately narrow. */
const RETRIABLE_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function* errorChain(err: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (!err || typeof err !== "object" || depth > 5) return;
  yield err as Record<string, unknown>;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) yield* errorChain(cause, depth + 1);
}

/** An HTTP status if the error (or a cause in its chain) carries one — either a
 *  numeric `.status` (hrana's HttpServerError) or the "Server returned HTTP
 *  status NNN" message @libsql/client wraps into a SERVER_ERROR LibsqlError. */
function extractHttpStatus(err: unknown): number | undefined {
  for (const node of errorChain(err)) {
    if (typeof node.status === "number") return node.status;
    if (typeof node.message === "string") {
      const m = /\bHTTP status (\d{3})\b/.exec(node.message);
      if (m) return Number(m[1]);
    }
  }
  return undefined;
}

function extractTransportCode(err: unknown): string | undefined {
  for (const node of errorChain(err)) {
    if (typeof node.code === "string" && RETRIABLE_TRANSPORT_CODES.has(node.code)) return node.code;
  }
  return undefined;
}

export type ArchiveReadErrorClass = { retriable: boolean; reason: string };

/**
 * Decide whether a failed archive read may be retried. Retriable ONLY for a
 * proven-transient transport class:
 *   - HTTP 502 / 503 / 504
 *   - a narrow set of connection-reset / timeout transport codes
 *
 * Everything else propagates immediately — SQL / missing-table / constraint /
 * malformed-query errors, auth errors, every other HTTP 4xx (incl. 429) and
 * 5xx (incl. a bare SERVER_ERROR with no transient status), and any unknown
 * exception. A found status decides on its own: a non-{502,503,504} status is
 * never retried even if some transport code is also present.
 */
export function classifyArchiveReadError(err: unknown): ArchiveReadErrorClass {
  const status = extractHttpStatus(err);
  if (typeof status === "number") {
    return RETRIABLE_HTTP_STATUS.has(status)
      ? { retriable: true, reason: `http-${status}` }
      : { retriable: false, reason: `http-${status}-non-retriable` };
  }
  const code = extractTransportCode(err);
  if (code) return { retriable: true, reason: `transport-${code}` };
  return { retriable: false, reason: "non-transient" };
}

// ── read-shape guard ─────────────────────────────────────────────────────

const READ_STATEMENT_PREFIX = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(?:SELECT|WITH)\b/i;
const WRITE_OR_DDL_KEYWORD =
  /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|ATTACH|DETACH|REINDEX|VACUUM|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|GRANT|REVOKE)\b/i;

/** Conservative: the statement must OPEN with SELECT/WITH and contain no
 *  write/DDL keyword anywhere. Matches every statement the matcher issues
 *  (compact discovery, DF-band load, candidate order/text, FTS phrase probes,
 *  co-source adjacency); anything else is executed once WITHOUT retry so an
 *  ambiguous / non-read statement can never be replayed. */
export function isArchiveReadShapedSql(sql: string): boolean {
  return READ_STATEMENT_PREFIX.test(sql) && !WRITE_OR_DDL_KEYWORD.test(sql);
}

// ── the wrapper ──────────────────────────────────────────────────────────

export type ArchiveReadRetryHooks = {
  /** Backoff sleep. Production: real setTimeout. Tests: record + resolve now. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1). Production: Math.random. Tests: () => 0.5 for
   *  exact backoff values. */
  random?: () => number;
};

export type ArchiveReadRetryState = {
  /** Shared retries still available for this matcher request. */
  retriesRemaining: number;
  /** Shared retries consumed so far (server logs / diagnostics). */
  retriesConsumed: number;
  /** Total base-client execute() calls issued (initial attempts + retries +
   *  any non-read pass-throughs). */
  executions: number;
};

export type ArchiveReadRetryClient = {
  client: ArchiveReadClient;
  state: ArchiveReadRetryState;
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function applyJitter(baseMs: number, random: () => number): number {
  const factor = 1 + (random() * 2 - 1) * ARCHIVE_READ_JITTER_RATIO;
  return Math.max(0, Math.round(baseMs * factor));
}

/**
 * Wrap `base` so that `execute()` on a read-shaped statement retries a
 * transient transport failure within the locked policy: at most
 * ARCHIVE_READ_MAX_RETRIES_PER_READ retries for that individual read, drawing
 * from ONE shared ARCHIVE_READ_SHARED_RETRY_BUDGET for the whole request.
 *
 * Construct exactly one per matcher request (analyzeArchiveOnServer) and
 * discard it when the request ends. Non-read statements pass straight through
 * to `base.execute` with no retry. The wrapper exposes only `execute`.
 */
export function createArchiveReadRetryClient(
  base: ArchiveReadClient,
  hooks: ArchiveReadRetryHooks = {},
): ArchiveReadRetryClient {
  const sleep = hooks.sleep ?? realSleep;
  const random = hooks.random ?? Math.random;

  const state: ArchiveReadRetryState = {
    retriesRemaining: ARCHIVE_READ_SHARED_RETRY_BUDGET,
    retriesConsumed: 0,
    executions: 0,
  };

  async function execute(stmt: InStatement): Promise<ResultSet>;
  async function execute(sql: string, args?: InArgs): Promise<ResultSet>;
  async function execute(stmtOrSql: InStatement | string, args?: InArgs): Promise<ResultSet> {
    const statement: InStatement =
      typeof stmtOrSql === "string" ? { sql: stmtOrSql, args: args ?? [] } : stmtOrSql;
    const sqlText = typeof statement === "string" ? statement : statement.sql;

    // Ambiguous / non-read statement: run once, never retry, never touch budget.
    if (!isArchiveReadShapedSql(sqlText)) {
      state.executions += 1;
      return base.execute(statement);
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        state.executions += 1;
        return await base.execute(statement);
      } catch (err) {
        const { retriable } = classifyArchiveReadError(err);
        const perReadExhausted = attempt >= ARCHIVE_READ_MAX_RETRIES_PER_READ;
        const budgetExhausted = state.retriesRemaining <= 0;
        if (!retriable || perReadExhausted || budgetExhausted) throw err;

        state.retriesRemaining -= 1;
        state.retriesConsumed += 1;
        const backoff = ARCHIVE_READ_BACKOFF_MS[Math.min(attempt, ARCHIVE_READ_BACKOFF_MS.length - 1)];
        await sleep(applyJitter(backoff, random));
      }
    }
  }

  return { client: { execute }, state };
}

export type ArchiveReadRetrySummary = {
  retriesConsumed: number;
  retriesRemaining: number;
  executions: number;
};

export function summarizeArchiveReadRetry(state: ArchiveReadRetryState): ArchiveReadRetrySummary {
  return {
    retriesConsumed: state.retriesConsumed,
    retriesRemaining: state.retriesRemaining,
    executions: state.executions,
  };
}
