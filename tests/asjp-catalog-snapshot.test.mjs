import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openAsjpCatalog } from '../lib/asjp-catalog-store.ts';
import { AsjpCatalogSource, loadAsjpCatalogSnapshot } from '../lib/asjp-catalog-snapshot.ts';

/** The serving catalog snapshot: same entries as the store, non-blocking refresh under a lock, takedown, failure. */
const scratch = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'asjp-catalog-snapshot-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
function makeCatalog(file, rows) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE journals (journal_id INTEGER PRIMARY KEY, name TEXT, eissn TEXT);
    CREATE TABLE articles (article_id INTEGER PRIMARY KEY, journal_id INTEGER, canonical_url TEXT, title TEXT, authors_json TEXT, publication_date TEXT, doi TEXT);
    CREATE TABLE article_versions (article_id INTEGER, indexed INTEGER, licence TEXT, licence_version TEXT, licence_basis TEXT, licence_status TEXT, reuse_permitted INTEGER, withdrawn INTEGER);
    INSERT INTO journals VALUES (1, 'Journal', '1111-2222');`);
  const a = db.prepare('INSERT INTO articles VALUES (?, 1, ?, ?, ?, ?, NULL)');
  const v = db.prepare('INSERT INTO article_versions VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
  db.exec('BEGIN');
  for (let id = 1; id <= rows; id += 1) { a.run(id, `https://asjp.cerist.dz/en/article/${id}`, `title ${id}`, JSON.stringify([`Author ${id}`]), '2024-01-01'); v.run(id, id % 10 ? 1 : 0, 'CC BY', '4.0', 'ARTICLE_PDF', 'PERMITTED', 1); }
  db.exec('COMMIT');
  return db;
}

test('the snapshot holds exactly the store\'s entries (indexed articles only)', async () => {
  const file = path.join(scratch, 'same.sqlite');
  makeCatalog(file, 200).close();
  const snap = await loadAsjpCatalogSnapshot(file);
  const store = openAsjpCatalog(file);
  let n = 0;
  for (let id = 1; id <= 200; id += 1) { assert.deepEqual(snap.entries.get(String(id)) ?? null, store.entry(String(id))); if (store.entry(String(id))) n += 1; }
  assert.equal(snap.entries.size, n);
  store.close();
});

test('refresh under an exclusive writer lock retries asynchronously: the event loop keeps running, then it succeeds', async () => {
  const file = path.join(scratch, 'locked.sqlite');
  const writer = makeCatalog(file, 50);
  const source = await AsjpCatalogSource.open(file);
  writer.exec('PRAGMA locking_mode = EXCLUSIVE');
  writer.exec('BEGIN EXCLUSIVE');
  writer.exec("UPDATE article_versions SET withdrawn = 1 WHERE article_id = 7");
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  setTimeout(() => { writer.exec('COMMIT'); writer.exec('PRAGMA locking_mode = NORMAL'); writer.prepare('SELECT 1').get(); writer.close(); }, 200);
  assert.equal(source.entry('7').withdrawn, false, 'until the refresh, the old snapshot answers');
  const swapped = await source.refresh();
  clearInterval(timer);
  assert.equal(swapped, true, String(source.lastRefreshError));
  assert.ok(source.current.busyRetries >= 1, 'it met the lock and retried');
  assert.ok(ticks >= 10, `the event loop kept running (${ticks} ticks)`);
  assert.equal(source.entry('7').withdrawn, true, 'the takedown is effective after the refresh');
});

test('a failed refresh keeps the current snapshot and reports the error', async () => {
  const file = path.join(scratch, 'gone.sqlite');
  makeCatalog(file, 20).close();
  const source = await AsjpCatalogSource.open(file);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  assert.equal(await source.refresh(), false);
  assert.match(source.lastRefreshError, /not found/);
  assert.equal(source.entry('3').title, 'title 3');
});
