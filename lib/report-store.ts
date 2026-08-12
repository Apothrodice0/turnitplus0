const DATABASE = "turnitplus";
const STORE = "reports";
const VERSION = 1;

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadStoredReports<T>(reportVersion: number): Promise<T[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve(
      (request.result as Array<T & { version: number; created: string }>)
        .filter((report) => report.version === reportVersion)
        .sort((left, right) => right.created.localeCompare(left.created))
        .slice(0, 50),
    );
    request.onerror = () => reject(request.error);
  });
}

// Reports are stored keyed by their numeric `id` field (see SimilarityReport
// in lib/report-types.ts), but callers (route params, API ids) work with the
// string form, so both functions below accept a string and convert.

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
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function storeReport<T>(report: T) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).put(report);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function clearStoredReports() {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
