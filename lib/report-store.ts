import type { DetectedLanguage } from "./similarity-core";

const DATABASE = "turnitplus";
const STORE = "reports";
const SUMMARY_STORE = "report_summaries";
// v3 — browser-local report OWNERSHIP (auth-report local-history isolation fix).
// Every record written from v3 on carries an explicit `localOwner` tag. v1/v2
// records carry none: nothing in them says whether they came from an anonymous
// device or from a signed-in account (and before this fix, account reports DID
// land here — the anonymous auth-error restore, room uploads, AI completion,
// AI retry and the dashboard all wrote them). Ownership is never guessed: the
// v2 -> v3 upgrade PURGES both stores, and every reader below additionally
// refuses any record without a matching tag (defense in depth, e.g. a record
// written by a stale pre-v3 tab after the upgrade).
const VERSION = 3;

/**
 * Who a browser-local report record belongs to.
 *
 * - `anonymous`: a report this browser holds for the signed-out, device-scoped
 *   history ("ON THIS DEVICE"). The only writer is the signed-out restore of
 *   this device key's still-unclaimed server reports (app/page.tsx).
 * - `account`: a report owned by the signed-in account identified by
 *   `accountKey` — its normalized email, the one stable, non-secret account
 *   identifier this client already receives (/api/auth/me, login/signup; the
 *   same identifier lib/report-rooms-cache.ts already scopes its keys by). It
 *   is only a partition label for data already on this device, never a
 *   credential: reading a record still requires the caller to name the owner
 *   it is acting for, and every auth transition purges the other owners.
 */
export type LocalReportOwner =
  | { readonly scope: "anonymous" }
  | { readonly scope: "account"; readonly accountKey: string };

export const ANONYMOUS_LOCAL_REPORT_OWNER: LocalReportOwner = Object.freeze({ scope: "anonymous" as const });

export function normalizeLocalAccountKey(accountEmail: string): string {
  return accountEmail.trim().toLowerCase();
}

/** The owner for a signed-in account, or null when no usable account identifier is known (callers must then skip the local write). */
export function accountLocalReportOwner(accountEmail: string | null | undefined): LocalReportOwner | null {
  if (typeof accountEmail !== "string") return null;
  const accountKey = normalizeLocalAccountKey(accountEmail);
  if (!accountKey) return null;
  return Object.freeze({ scope: "account" as const, accountKey });
}

/** The persisted tag. Throws for anything that is not a well-formed owner — a local write/read with no owner must fail closed, never default to anonymous. */
export function localReportOwnerTag(owner: LocalReportOwner): string {
  if (owner && owner.scope === "anonymous") return "anonymous";
  if (owner && owner.scope === "account" && typeof owner.accountKey === "string" && owner.accountKey.length > 0) {
    return `account:${owner.accountKey}`;
  }
  throw new Error("A browser-local report owner is required.");
}

type StoredReportLike = {
  id: number;
  version: number;
  submissionId: string;
  title: string;
  created: string;
  score: number;
  archiveScore?: number;
  aiScore?: number | null;
  wordCount: number;
  scoreBand: "Low" | "Moderate" | "High";
};

type ReportHistorySummary = StoredReportLike & {
  __summaryOnly: true;
  author: string;
  assignment: string;
  characterCount: number;
  pageCount: number;
  fileSize: string;
  databaseSize: number;
  corpusVersion: string;
  riskStatus: "Elevated" | "Lower";
  riskTarget: number;
  riskCutoff: number;
  riskCalibration: { auc: number; precision: number; recall: number; sampleSize: number };
  features: {
    maxSourceContainment: number;
    longestMatchedSpan: number;
    quotationDensity: number;
    referenceListRatio: number;
    highFrequencyShingleCount: number;
    repeatedThreeGramCount: number;
    detectedLanguage: DetectedLanguage;
  };
  excludedDocuments: number;
  matchedWordCount: number;
  sources: [];
  repeats: [];
  text: string;
};

/** What the full-report store actually holds from v3 on: the report body wrapped with its owner tag, keyed by the report id. */
type OwnedReportRecord = { id: number; localOwner: string; report: unknown };
type OwnedSummaryRecord = ReportHistorySummary & { localOwner: string };

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion ?? 0;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      } else if (oldVersion < 3) {
        // Legacy (pre-ownership) records: ownership unknown -> purged, never guessed.
        request.transaction?.objectStore(STORE).clear();
      }
      if (!database.objectStoreNames.contains(SUMMARY_STORE)) {
        database.createObjectStore(SUMMARY_STORE, { keyPath: "id" });
      } else if (oldVersion < 3) {
        request.transaction?.objectStore(SUMMARY_STORE).clear();
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      // Never hold an old connection open across a future schema upgrade in another tab.
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    // A still-open pre-v3 tab blocks the upgrade: fail (callers already treat
    // local storage as best-effort) rather than leave every caller hanging.
    request.onblocked = () => reject(new Error("Local report storage upgrade is blocked by another open tab."));
  });
}

function summaryScoreBand(value: number): "Low" | "Moderate" | "High" {
  if (value > 40) return "High";
  if (value >= 20) return "Moderate";
  return "Low";
}

function toHistorySummary(report: StoredReportLike): ReportHistorySummary {
  const archiveScore = report.archiveScore ?? report.score;
  return {
    __summaryOnly: true,
    version: 11,
    id: report.id,
    submissionId: report.submissionId,
    title: report.title,
    author: "",
    assignment: "",
    created: report.created,
    score: archiveScore,
    archiveScore,
    aiScore: report.aiScore ?? null,
    wordCount: report.wordCount,
    characterCount: 0,
    pageCount: 0,
    fileSize: "—",
    databaseSize: 0,
    corpusVersion: "",
    scoreBand: summaryScoreBand(archiveScore),
    riskStatus: archiveScore > 40 ? "Elevated" : "Lower",
    riskTarget: 0,
    riskCutoff: 0,
    riskCalibration: { auc: 0, precision: 0, recall: 0, sampleSize: 0 },
    features: {
      maxSourceContainment: 0,
      longestMatchedSpan: 0,
      quotationDensity: 0,
      referenceListRatio: 0,
      highFrequencyShingleCount: 0,
      repeatedThreeGramCount: 0,
      detectedLanguage: "English",
    },
    excludedDocuments: 0,
    matchedWordCount: 0,
    sources: [],
    repeats: [],
    text: "",
  };
}

/** The history summaries `owner` may see — never another owner's, never an untagged legacy record. */
export async function loadStoredReports<T>(reportVersion: number, owner: LocalReportOwner): Promise<T[]> {
  const tag = localReportOwnerTag(owner);
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(SUMMARY_STORE, "readonly").objectStore(SUMMARY_STORE).getAll();
    request.onsuccess = () => resolve(
      (request.result as Array<Partial<OwnedSummaryRecord>>)
        .filter((record) => record.localOwner === tag && record.version === reportVersion)
        .map((record) => {
          const { localOwner: _owner, ...summary } = record;
          return summary as ReportHistorySummary;
        })
        .sort((left, right) => right.created.localeCompare(left.created))
        .slice(0, 50) as unknown as T[],
    );
    request.onerror = () => reject(request.error);
  });
}

// Full reports remain in the primary store and are only fetched when an
// individual report room needs them — and only for the owner that wrote them.
export async function getStoredReportById<T>(id: string, owner: LocalReportOwner): Promise<T | null> {
  const tag = localReportOwnerTag(owner);
  const key = Number(id);
  if (!Number.isFinite(key)) return null;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE, "readonly").objectStore(STORE).get(key);
    request.onsuccess = () => {
      const record = request.result as Partial<OwnedReportRecord> | undefined;
      resolve(record && record.localOwner === tag && record.report !== undefined ? (record.report as T) : null);
    };
    request.onerror = () => reject(request.error);
  });
}

// Removal only (never exposes anything), so it is deliberately owner-agnostic.
export async function deleteStoredReport(id: string) {
  const key = Number(id);
  if (!Number.isFinite(key)) return;
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([STORE, SUMMARY_STORE], "readwrite");
    transaction.objectStore(STORE).delete(key);
    transaction.objectStore(SUMMARY_STORE).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Report delete transaction aborted."));
  });
}

export async function storeReport<T>(report: T, owner: LocalReportOwner) {
  const tag = localReportOwnerTag(owner);
  // Remote/history-only placeholders are deliberately not persisted as full
  // reports. They are summaries, not report-room payloads.
  if (report && typeof report === "object" && "__summaryOnly" in report && (report as { __summaryOnly?: unknown }).__summaryOnly === true) {
    return;
  }

  const database = await openDatabase();
  const fullReport = report as unknown as StoredReportLike;
  const summary: OwnedSummaryRecord = { ...toHistorySummary(fullReport), localOwner: tag };
  const record: OwnedReportRecord = { id: fullReport.id, localOwner: tag, report };
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([STORE, SUMMARY_STORE], "readwrite");
    transaction.objectStore(STORE).put(record);
    transaction.objectStore(SUMMARY_STORE).put(summary);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Report save transaction aborted."));
  });
}

/**
 * storeReport, but never rejects. The local IndexedDB copy is a best-effort
 * cache — the authoritative record is the remote (Turso) save that always
 * runs alongside it (see lib/reports-remote.ts's own "fail-soft by design"
 * comment for the same philosophy applied to the remote side). Before this
 * wrapper existed, an IndexedDB failure (quota exceeded, private-browsing
 * restrictions, a blocked/corrupted database) thrown from an unguarded
 * `await storeReport(...)` could abort the whole save pipeline it was
 * called from — including, at the AI-enrichment resave site, permanently
 * stranding a report at ai_status='processing' with no code path left that
 * would ever mark it ready or failed. Matches this codebase's existing
 * "a best-effort side effect must never block the primary action" pattern
 * (e.g. claimAnonymousReports, maybePromoteToAdmin in lib/admin-role.ts).
 *
 * `owner` is required: a caller with no known owner (e.g. no signed-in
 * account email) passes null and nothing is written — never an anonymous
 * record by default.
 *
 * `store` is injectable (defaults to the real storeReport) purely so tests
 * can supply a deterministic stub without needing a real/fake IndexedDB.
 */
export async function storeReportBestEffort<T>(
  report: T,
  owner: LocalReportOwner | null,
  store: (report: T, owner: LocalReportOwner) => Promise<void> = storeReport,
): Promise<void> {
  if (!owner) return;
  try {
    await store(report, owner);
  } catch (error) {
    console.error("Local IndexedDB report save failed (non-fatal — the remote save is authoritative):", error instanceof Error ? error.message : String(error));
  }
}

async function deleteRecordsWhere(shouldDelete: (localOwner: unknown) => boolean) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([STORE, SUMMARY_STORE], "readwrite");
    for (const storeName of [STORE, SUMMARY_STORE]) {
      const objectStore = transaction.objectStore(storeName);
      const request = objectStore.getAll();
      request.onsuccess = () => {
        for (const record of request.result as Array<{ id: number; localOwner?: unknown }>) {
          if (shouldDelete(record.localOwner)) objectStore.delete(record.id);
        }
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Report purge transaction aborted."));
  });
}

/** "Clear history" for one owner: removes only that owner's local records. */
export async function clearStoredReports(owner: LocalReportOwner) {
  const tag = localReportOwnerTag(owner);
  return deleteRecordsWhere((localOwner) => localOwner === tag);
}

/**
 * Auth-transition purge: deletes every local record NOT owned by `keep` —
 * including untagged records. `keep: null` deletes everything. Sign-out /
 * definitive signed-out hydration keep only anonymous records; a signed-in
 * hydration or a fresh login keeps only that account's records.
 */
export async function purgeStoredReportsExcept(keep: LocalReportOwner | null) {
  const keepTag = keep ? localReportOwnerTag(keep) : null;
  return deleteRecordsWhere((localOwner) => keepTag === null || localOwner !== keepTag);
}
