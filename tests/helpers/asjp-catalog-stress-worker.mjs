// One reader process of the catalog concurrency test / benchmark: waits for a shared start instant, opens the catalog,
// reads `reads` entries, prints {failures, reads, found, busyRetries, openMs, errors}.
// usage: node --import tsx <this> <catalog> <shared|immutable|raw> <startAtMs> <reads> [maxId]
import { DatabaseSync } from 'node:sqlite';
import { openAsjpCatalog } from '../../lib/asjp-catalog-store.ts';

const [file, mode, startAt, readsArg, maxIdArg] = process.argv.slice(2);
const reads = Number(readsArg);
const maxId = Number(maxIdArg ?? 2_000);
while (Date.now() < Number(startAt)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
let failures = 0, found = 0, busyRetries = 0;
const errors = [];
const t0 = performance.now();
let entry, close;
try {
  if (mode === 'raw') {
    // the Phase-3 scripts' open: read-only, no busy timeout, no retry
    const db = new DatabaseSync(file, { readOnly: true });
    const st = db.prepare('SELECT a.title FROM article_versions v JOIN articles a USING(article_id) WHERE v.article_id = ? AND v.indexed = 1');
    entry = (id) => st.get(Number(id)) ?? null;
    close = () => db.close();
  } else {
    const store = openAsjpCatalog(file, { mode });
    entry = store.entry;
    close = store.close;
    busyRetries = () => store.busyRetries();
  }
} catch (error) {
  console.log(JSON.stringify({ failures: reads, reads: 0, found: 0, busyRetries: 0, openMs: performance.now() - t0, errors: [String(error.message)] }));
  process.exit(0);
}
const openMs = performance.now() - t0;
let done = 0;
for (let i = 0; i < reads; i += 1) {
  const id = 1 + ((i * 7919 + process.pid) % maxId);
  try { if (entry(String(id))) found += 1; done += 1; } catch (error) { failures += 1; if (errors.length < 3) errors.push(String(error.message)); }
}
close();
console.log(JSON.stringify({ failures, reads: done, found, busyRetries: typeof busyRetries === 'function' ? busyRetries() : 0, openMs: +openMs.toFixed(1), errors }));
