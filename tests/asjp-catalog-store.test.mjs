import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isSqliteBusy, openAsjpCatalog } from '../lib/asjp-catalog-store.ts';

/**
 * The ASJP catalog store under concurrency: 8 processes open one WAL catalog at the same instant and read it while a
 * writer commits, with no "database is locked" failure; an immutable open takes no lock and refuses a pending -wal.
 */
const scratch = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'asjp-catalog-store-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const here = path.dirname(fileURLToPath(import.meta.url));

function makeCatalog(file, rows) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE journals (journal_id INTEGER PRIMARY KEY, name TEXT, eissn TEXT);
    CREATE TABLE articles (article_id INTEGER PRIMARY KEY, journal_id INTEGER, canonical_url TEXT, title TEXT, authors_json TEXT, publication_date TEXT, doi TEXT);
    CREATE TABLE article_versions (article_id INTEGER, indexed INTEGER, licence TEXT, licence_version TEXT, licence_basis TEXT, licence_status TEXT, reuse_permitted INTEGER, withdrawn INTEGER);
    INSERT INTO journals VALUES (1, 'Journal', '1111-2222');`);
  const a = db.prepare('INSERT INTO articles VALUES (?, 1, ?, ?, ?, ?, NULL)');
  const v = db.prepare('INSERT INTO article_versions VALUES (?, 1, ?, ?, ?, ?, ?, 0)');
  db.exec('BEGIN');
  for (let id = 1; id <= rows; id += 1) {
    a.run(id, `https://asjp.cerist.dz/en/article/${id}`, `title ${id}`, JSON.stringify([`Author ${id}`]), '2024-01-01');
    v.run(id, id % 3 ? 'CC BY' : null, id % 3 ? '4.0' : null, 'ARTICLE_PDF', id % 3 ? 'PERMITTED' : 'UNKNOWN', id % 3 ? 1 : 0);
  }
  db.exec('COMMIT');
  return db;
}

test('entry(): maps a catalog row to the lane entry; an unknown or unindexed article is null', () => {
  const file = path.join(scratch, 'map.sqlite');
  makeCatalog(file, 10).close();
  const store = openAsjpCatalog(file);
  assert.deepEqual(store.entry('4'), { articleId: '4', canonicalUrl: 'https://asjp.cerist.dz/en/article/4', title: 'title 4', authors: ['Author 4'], journal: 'Journal', issn: '1111-2222', publicationDate: '2024-01-01', doi: null, license: 'CC BY 4.0', licenseBasis: 'ARTICLE_PDF', licenceStatus: 'PERMITTED', reusePermitted: true, withdrawn: false });
  assert.equal(store.entry('3').license, null, 'no licence is null, not "null"');
  assert.equal(store.entry('3').licenceStatus, 'UNKNOWN');
  assert.equal(store.entry('999'), null);
  store.close();
});

test('8 processes opening one WAL catalog at the same instant, with a writer committing: no lock failure', async () => {
  const file = path.join(scratch, 'stress.sqlite');
  const writer = makeCatalog(file, 2_000);
  const worker = path.join(here, 'helpers', 'asjp-catalog-stress-worker.mjs');
  const startAt = Date.now() + 1_500;
  const children = Array.from({ length: 8 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, file, 'shared', String(startAt), '400'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', () => {});
    child.on('close', (code) => resolve({ code, result: out.trim() ? JSON.parse(out.trim().split('\n').at(-1)) : null }));
  }));
  // the writer commits while the readers open and read
  while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 10));
  const update = writer.prepare('UPDATE articles SET title = ? WHERE article_id = ?');
  for (let i = 0; i < 50; i += 1) { writer.exec('BEGIN IMMEDIATE'); update.run(`title ${i}`, 1 + (i % 2_000)); writer.exec('COMMIT'); }
  const results = await Promise.all(children);
  writer.close();
  for (const { code, result } of results) {
    assert.equal(code, 0);
    assert.equal(result.failures, 0);
    assert.equal(result.reads, 400);
    assert.equal(result.found, 400);
  }
});

test('immutable: opens without creating -shm / -wal, and refuses a database with a pending -wal', () => {
  const file = path.join(scratch, 'frozen.sqlite');
  const db = makeCatalog(file, 10);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA journal_mode = DELETE');
  db.close();
  for (const suffix of ['-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  const store = openAsjpCatalog(file, { mode: 'immutable' });
  assert.equal(store.entry('2').title, 'title 2');
  assert.ok(!fs.existsSync(`${file}-shm`) && !fs.existsSync(`${file}-wal`));
  store.close();

  const pending = path.join(scratch, 'pending.sqlite');
  const live = makeCatalog(pending, 5); // still open: its committed rows sit in the -wal
  assert.ok(fs.statSync(`${pending}-wal`).size > 0);
  assert.throws(() => openAsjpCatalog(pending, { mode: 'immutable' }), /non-empty -wal/);
  live.close();
});

test('isSqliteBusy: BUSY and LOCKED (and extended codes) only', () => {
  assert.equal(isSqliteBusy({ errcode: 5 }), true);
  assert.equal(isSqliteBusy({ errcode: 6 }), true);
  assert.equal(isSqliteBusy({ errcode: 517 }), true); // SQLITE_BUSY_SNAPSHOT
  assert.equal(isSqliteBusy({ errcode: 1 }), false);
  assert.equal(isSqliteBusy(new Error('database is locked')), true);
  assert.equal(isSqliteBusy(new Error('no such table')), false);
});
