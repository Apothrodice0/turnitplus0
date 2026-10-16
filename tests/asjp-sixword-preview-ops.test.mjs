import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { corpusEngineScratch, inventedText, removeScratch } from './helpers/corpus-engine-fixtures.mjs';
import { buildLaneTokens } from '../lib/asjp-lane-tokens.ts';
import { buildSixwordIndex } from '../lib/asjp-sixword-index.ts';
import { ASJP_SIXWORD_MIGRATION_SQL, ASJP_SIXWORD_TABLE, SixwordStorageNotMigrated, applySixwordMigration, dropSixwordStorage, sixwordSchemaProblem, writeSixwordRecord } from '../lib/asjp-sixword-report-store.ts';

/**
 * Preview operations for the six-word experiment (all local; nothing remote is touched): the formal Preview-only
 * migration equals the code's schema, the app never creates schema at run time, the migration script's local
 * validation and its refusals, and the read-only preflight (offline Vercel listing + PC service checks).
 */
const scratch = corpusEngineScratch('asjp-sixword-preview-ops');
test.after(async () => { await new Promise((r) => setTimeout(r, 2000)); try { removeScratch(scratch); } catch { /* a closed libSQL file can stay locked briefly on Windows */ } });
const repo = path.resolve('.');
const node = process.execPath;
const freshDb = async (name) => {
  const file = path.join(scratch, `${name}.db`);
  const client = createClient({ url: `file:${file}` });
  await applyMigrationsLibsql(client, path.join(repo, 'drizzle'));
  return { file, client };
};
const record = { schema: 'asjp-sixword-overlap-record-v1', status: 'UNAVAILABLE', scored: false, matches: [] };
const norm = (s) => s.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();

test('the migration file is exactly the code schema; the Production migration set (drizzle/) does not contain it', () => {
  const file = fs.readFileSync(path.join(repo, 'migrations-preview/asjp-sixword-0001.sql'), 'utf8');
  const statements = file.split('--> statement-breakpoint').map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')).map(norm).filter(Boolean);
  assert.deepEqual(statements, ASJP_SIXWORD_MIGRATION_SQL.map(norm));
  for (const f of fs.readdirSync(path.join(repo, 'drizzle')).filter((f) => f.endsWith('.sql'))) assert.ok(!/asjp_sixword/i.test(fs.readFileSync(path.join(repo, 'drizzle', f), 'utf8')), f);
});

test('no run-time schema: a write is refused until the migration is applied; self-provisioning only locally and never on Vercel', async () => {
  const { client } = await freshDb('runtime');
  assert.equal(await sixwordSchemaProblem(client), 'TABLE_MISSING');
  await assert.rejects(writeSixwordRecord(client, { deviceKey: 'd', reportId: 'r' }, record, {}), (e) => e instanceof SixwordStorageNotMigrated && e.problem === 'TABLE_MISSING');
  await assert.rejects(writeSixwordRecord(client, { deviceKey: 'd', reportId: 'r' }, record, { ASJP_SIXWORD_SELF_PROVISION: 'true', VERCEL_ENV: 'preview' }), SixwordStorageNotMigrated);
  assert.equal(await sixwordSchemaProblem(client), 'TABLE_MISSING', 'nothing was created');
  await writeSixwordRecord(client, { deviceKey: 'd', reportId: 'r' }, record, { ASJP_SIXWORD_SELF_PROVISION: 'true' });
  assert.equal(await sixwordSchemaProblem(client), null, 'local self-provisioning creates exactly the migrated schema');
  await client.execute(`DROP TRIGGER trg_${ASJP_SIXWORD_TABLE}_report_deleted`);
  assert.equal(await sixwordSchemaProblem(client), 'TRIGGER_MISSING');
  await assert.rejects(writeSixwordRecord(client, { deviceKey: 'd', reportId: 'r' }, record, {}), SixwordStorageNotMigrated);
  await applySixwordMigration(client);
  assert.equal(await sixwordSchemaProblem(client), null);
  client.close();
});

test('schema validator: a different column layout is refused; the delete trigger removes the record with its report; rollback drops trigger first', async () => {
  const { client } = await freshDb('schema');
  await client.execute(`CREATE TABLE ${ASJP_SIXWORD_TABLE} (device_key TEXT, report_id TEXT, record_json TEXT, status TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY (device_key, report_id))`);
  await client.execute(ASJP_SIXWORD_MIGRATION_SQL[1]);
  assert.equal(await sixwordSchemaProblem(client), 'COLUMNS_DIFFER');
  await dropSixwordStorage(client);
  await applySixwordMigration(client);
  await client.execute({ sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json) VALUES ('r1','d1','s','t','2025-01-01',1,0,'Low','{}')` });
  await writeSixwordRecord(client, { deviceKey: 'd1', reportId: 'r1' }, record, {});
  await client.execute(`DELETE FROM saved_reports WHERE id = 'r1'`);
  assert.equal(Number((await client.execute(`SELECT count(*) AS n FROM ${ASJP_SIXWORD_TABLE}`)).rows[0].n), 0, 'removed with its report');
  await dropSixwordStorage(client);
  await client.execute({ sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json) VALUES ('r2','d1','s','t','2025-01-01',1,0,'Low','{}')` });
  await client.execute(`DELETE FROM saved_reports WHERE id = 'r2'`); // deletion still works after the rollback
  client.close();
});

test('migration script: dry run opens nothing; local validation PASS then idempotent; remote apply refused without approval / outside a Preview database', async () => {
  const script = path.join(repo, 'scripts/asjp-sixword/migrate-preview-sixword.mjs');
  const runScript = (args, env = {}) => { try { return { code: 0, out: execFileSync(node, ['--import', 'tsx', script, ...args], { cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };
  assert.match(runScript([]).out, /DRY_RUN/);
  const { file, client } = await freshDb('script'); client.close();
  const first = runScript(['--validate-local', file]);
  assert.equal(first.code, 0, first.out); assert.match(first.out, /"before":"TABLE_MISSING".*"result":"PASS"/);
  assert.match(runScript(['--validate-local', file]).out, /"before":"ALREADY_MIGRATED".*"result":"PASS"/);
  assert.equal(runScript(['--validate-local', 'libsql://x.turso.io']).code, 2);
  assert.equal(runScript(['--apply']).code, 2, 'no owner approval');
  for (const [url, confirm] of [['libsql://turnitplus-prod-x.turso.io', 'prod'], ['libsql://turnitplus-preview-x.turso.io', 'shared'], ['file:/tmp/x.db', 'preview'], ['libsql://asjp-preview-prod.turso.io', 'asjp-preview']]) {
    const r = runScript(['--apply', '--owner-approved'], { PREVIEW_TURSO_DATABASE_URL: url, ASJP_PREVIEW_DB_CONFIRM: confirm, PREVIEW_TURSO_AUTH_TOKEN: 'x' });
    assert.equal(r.code, 2, `${url} / ${confirm}`); assert.match(r.out, /REFUSED/);
  }
});

test('preflight (read-only): Vercel listing rules V1–V4 offline; PC service rules S1–S4 against a real local index', async () => {
  const script = path.join(repo, 'scripts/asjp-sixword/preflight-sixword.mjs');
  const runPf = (args) => { try { return { code: 0, out: execFileSync(node, [script, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };
  const listing = (entries) => { const f = path.join(scratch, `listing-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(entries)); return f; };
  const good = [{ key: 'ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED', target: ['preview'], gitBranch: 'preview/asjp-pc' }, { key: 'ASJP_REPORT_EVIDENCE_ENABLED', target: ['preview'], gitBranch: 'preview/asjp-pc' }];
  assert.equal(runPf(['--listing-file', listing(good), '--branch', 'preview/asjp-pc']).code, 0);
  const fails = {
    V1: [...good, { key: 'ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED', target: ['production'], gitBranch: null }],
    V2: [...good, { key: 'ASJP_SIXWORD_SELF_PROVISION', target: ['preview'], gitBranch: 'preview/asjp-pc' }],
    V3: [{ key: 'ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED', target: ['preview'], gitBranch: null }],
    V4: [...good, { key: 'ASJP_SIXWORD_INDEX_DIR', target: ['preview'], gitBranch: 'preview/asjp-pc' }],
  };
  for (const [rule, entries] of Object.entries(fails)) { const r = runPf(['--listing-file', listing(entries), '--branch', 'preview/asjp-pc']); assert.equal(r.code, 1, rule); assert.match(r.out, new RegExp(`FAIL  ${rule}`)); }
  // PC service: a tiny real token store + index
  const tokensDir = path.join(scratch, 'tokens'), indexDir = path.join(scratch, 'six'), wordDf = path.join(scratch, 'df.json');
  async function* docs() { for (let k = 0; k < 5; k += 1) yield { docId: String(900 + k), text: inventedText(70 + k, 200) }; }
  await buildLaneTokens(tokensDir, 2, docs());
  await buildSixwordIndex({ laneTokensDir: tokensDir, outDir: indexDir, tmpDir: path.join(scratch, 'six-tmp'), partitions: 2, generationId: 'gen-pf', logicalManifestSha256: 'f'.repeat(64) });
  fs.writeFileSync(wordDf, JSON.stringify({ documents: 5, df: {} }));
  const genFile = path.join(scratch, 'generation.json');
  fs.writeFileSync(genFile, JSON.stringify({ generationId: 'gen-pf', logicalManifestSha256: 'f'.repeat(64), laneTokensDir: tokensDir }));
  const envFile = (extra) => { const f = path.join(scratch, `service-${Math.random().toString(36).slice(2)}.env`); fs.writeFileSync(f, Object.entries({ ASJP_ALLOWED_ROOTS: scratch, ASJP_SIXWORD_OVERLAP_ENABLED: 'true', ASJP_SIXWORD_INDEX_DIR: indexDir, ASJP_WORD_DF_PATH: wordDf, ...extra }).map(([k, v]) => `${k}=${v}`).join('\n')); return f; };
  const ok = runPf(['--service-env', envFile({}), '--generation', genFile]);
  assert.equal(ok.code, 0, ok.out);
  fs.writeFileSync(path.join(scratch, 'generation-other.json'), JSON.stringify({ generationId: 'gen-other', logicalManifestSha256: 'f'.repeat(64), laneTokensDir: tokensDir }));
  assert.match(runPf(['--service-env', envFile({}), '--generation', path.join(scratch, 'generation-other.json')]).out, /FAIL  S2/);
  assert.match(runPf(['--service-env', envFile({ ASJP_ALLOWED_ROOTS: 'D:/nowhere' }), '--generation', genFile]).out, /FAIL  S4/);
});
