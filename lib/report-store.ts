const DATABASE = "turnitplus";
const STORE = "reports";
const SUMMARY_STORE = "report_summaries";
const VERSION = 2;

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
    detectedLanguage: "Arabic" | "French" | "English" | "Mixed";
  };
  excludedDocuments: number;
  matchedWordCount: number;
  sources: [];
  repeats: [];
  text: string;
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SUMMARY_STORE)) {
        database.createObjectStore(SUMMARY_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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

export async function loadStoredReports<T>(reportVersion: number): Promise<T[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(SUMMARY_STORE, "readonly").objectStore(SUMMARY_STORE).getAll();
    request.onsuccess = () => resolve(
      (request.result as Array<ReportHistorySummary>)
        .filter((report) => report.version === reportVersion)
        .sort((left, right) => right.created.localeCompare(left.created))
        .slice(0, 50) as unknown as T[],
    );
    request.onerror = () => reject(request.error);
  });
}

// Full reports remain in the primary store and are only fetched when an
// individual report room needs them.
export async function getStoredReportById<T>(id: string): Promise<T | null> {
  const key = Number(id);
  if (!Number.isFinite(key)) return null;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE, "readonly").objectStore(STORE).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

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

export async function storeReport<T>(report: T) {
  // Remote/history-only placeholders are deliberately not persisted as full
  // reports. They are summaries, not report-room payloads.
  if (report && typeof report === "object" && "__summaryOnly" in report && (report as { __summaryOnly?: unknown }).__summaryOnly === true) {
    return;
  }

  const database = await openDatabase();
  const fullReport = report as unknown as StoredReportLike;
  const summary = toHistorySummary(fullReport);
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([STORE, SUMMARY_STORE], "readwrite");
    transaction.objectStore(STORE).put(report);
    transaction.objectStore(SUMMARY_STORE).put(summary);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Report save transaction aborted."));
  });
}

export async function clearStoredReports() {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([STORE, SUMMARY_STORE], "readwrite");
    transaction.objectStore(STORE).clear();
    transaction.objectStore(SUMMARY_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Report history clear transaction aborted."));
  });
}
