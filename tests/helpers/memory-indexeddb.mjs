// A minimal, deterministic in-memory IndexedDB for Node tests — just the
// subset lib/report-store.ts uses: open(name, version) with a versionchange
// upgrade (`oldVersion`, `request.transaction`), object stores with an inline
// keyPath, get/getAll/put/delete/clear requests, and transactions that fire
// `oncomplete` once every request (including ones issued from another
// request's onsuccess) has settled. Values are structured-cloned on the way in
// and out, like the real thing. One factory = one browser profile: every
// "tab" (every import) sharing it sees the same data.

function makeRequest(tx, run) {
  const request = { result: undefined, error: null, onsuccess: null, onerror: null };
  tx._pending += 1;
  queueMicrotask(() => {
    try {
      request.result = run();
      request.onsuccess?.({ target: request });
    } catch (error) {
      request.error = error;
      request.onerror?.({ target: request });
      tx._failed = error;
    } finally {
      tx._pending -= 1;
      tx._maybeComplete();
    }
  });
  return request;
}

function makeTransaction(db) {
  const tx = {
    _pending: 0,
    _done: false,
    _failed: null,
    oncomplete: null,
    onerror: null,
    onabort: null,
    error: null,
    _maybeComplete() {
      if (tx._pending !== 0 || tx._done) return;
      setTimeout(() => {
        if (tx._pending !== 0 || tx._done) return;
        tx._done = true;
        if (tx._failed) {
          tx.error = tx._failed;
          tx.onerror?.({ target: tx });
        } else {
          tx.oncomplete?.({ target: tx });
        }
      }, 0);
    },
    objectStore(name) {
      const store = db.stores.get(name);
      if (!store) throw new Error(`NotFoundError: object store ${name}`);
      return {
        get: (key) => makeRequest(tx, () => (store.data.has(key) ? structuredClone(store.data.get(key)) : undefined)),
        getAll: () => makeRequest(tx, () => [...store.data.values()].map((value) => structuredClone(value))),
        put: (value) => makeRequest(tx, () => {
          store.data.set(value[store.keyPath], structuredClone(value));
          return value[store.keyPath];
        }),
        delete: (key) => makeRequest(tx, () => {
          store.data.delete(key);
        }),
        clear: () => makeRequest(tx, () => {
          store.data.clear();
        }),
      };
    },
  };
  // A transaction with no requests at all still completes.
  queueMicrotask(() => tx._maybeComplete());
  return tx;
}

export function createMemoryIndexedDb() {
  const databases = new Map();

  function connection(db) {
    return {
      get version() {
        return db.version;
      },
      objectStoreNames: { contains: (name) => db.stores.has(name) },
      createObjectStore(name, options = {}) {
        db.stores.set(name, { keyPath: options.keyPath, data: new Map() });
      },
      transaction: () => makeTransaction(db),
      close() {},
      onversionchange: null,
    };
  }

  const factory = {
    open(name, version) {
      const request = { result: undefined, error: null, transaction: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => {
        let db = databases.get(name);
        if (!db) {
          db = { version: 0, stores: new Map() };
          databases.set(name, db);
        }
        const oldVersion = db.version;
        const targetVersion = version ?? Math.max(1, oldVersion);
        if (targetVersion < oldVersion) {
          request.error = new Error("VersionError");
          request.onerror?.({ target: request });
          return;
        }
        const conn = connection(db);
        request.result = conn;
        if (targetVersion > oldVersion) {
          db.version = targetVersion;
          request.transaction = makeTransaction(db);
          request.onupgradeneeded?.({ oldVersion, newVersion: targetVersion, target: request });
        }
        // Let the upgrade transaction's own requests settle first.
        setTimeout(() => {
          request.transaction = null;
          request.onsuccess?.({ target: request });
        }, 0);
      });
      return request;
    },
  };

  return {
    factory,
    /** Seed a database at a given version directly (e.g. a pre-fix v2 profile). */
    seed(name, version, stores) {
      const db = { version, stores: new Map() };
      for (const [storeName, { keyPath, records }] of Object.entries(stores)) {
        db.stores.set(storeName, { keyPath, data: new Map(records.map((record) => [record[keyPath], structuredClone(record)])) });
      }
      databases.set(name, db);
    },
    /** Insert a raw record into an existing store, bypassing the app (e.g. a stale pre-v3 tab writing an untagged record). */
    putRaw(name, storeName, record) {
      const store = databases.get(name).stores.get(storeName);
      store.data.set(record[store.keyPath], structuredClone(record));
    },
    /** Every raw record currently held, per store. */
    dump(name) {
      const db = databases.get(name);
      if (!db) return {};
      return Object.fromEntries([...db.stores.entries()].map(([storeName, store]) => [storeName, [...store.data.values()].map((value) => structuredClone(value))]));
    },
    version(name) {
      return databases.get(name)?.version ?? 0;
    },
    reset() {
      databases.clear();
    },
  };
}

export function createMemoryLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    keys: () => [...store.keys()],
  };
}
