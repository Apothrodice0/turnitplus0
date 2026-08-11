import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as schema from '../db/schema.ts';

// Permanent schema-drift control: fails the build if db/schema.ts and the
// actual migrated database structure ever disagree. This is a direct
// structural comparison (drizzle-orm's own getTableConfig() vs. PRAGMA/
// sqlite_master introspection), not a snapshot of "what currently exists" —
// any new drift introduced later (a migration that changes structure without
// a matching schema.ts update, or vice versa) must make this test fail.

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_schema_drift.db');

const envUrl = process.env.TURSO_DATABASE_URL;
if (envUrl) {
  const looksLikeDev = envUrl.includes('turnitplus-dev');
  const looksLikeProd = envUrl.toLowerCase().includes('prod');
  if (!looksLikeDev || looksLikeProd) {
    throw new Error(
      `Refusing to run tests/schema-drift.test.mjs against TURSO_DATABASE_URL="${envUrl}" — ` +
      `it does not clearly identify turnitplus-dev.`,
    );
  }
}
const dbUrl = envUrl ?? `file:${dbFile}`;
const authToken = envUrl ? process.env.TURSO_AUTH_TOKEN : undefined;
const remote = Boolean(envUrl);
if (remote && !authToken) {
  throw new Error('TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is set.');
}

if (!remote) {
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

const client = createClient({ url: dbUrl, authToken });
if (remote) {
  const existing = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'");
  if (existing.rows.length === 0) await applyMigrationsLibsql(client, drizzleDir);
} else {
  await applyMigrationsLibsql(client, drizzleDir);
}

const drift = [];

async function loadActualTable(tableName) {
  const columns = await client.execute(`PRAGMA table_info('${tableName}')`);
  const indexes = await client.execute(`PRAGMA index_list('${tableName}')`);
  const foreignKeys = await client.execute(`PRAGMA foreign_key_list('${tableName}')`);
  const indexDetails = [];
  for (const idx of indexes.rows) {
    const info = await client.execute(`PRAGMA index_info('${idx.name}')`);
    indexDetails.push({ name: idx.name, unique: Number(idx.unique) === 1, columns: info.rows.map((r) => r.name) });
  }
  return {
    columns: columns.rows.map((r) => ({ name: r.name, notNull: Number(r.notnull) === 1, pk: Number(r.pk) > 0 })),
    indexes: indexDetails,
    foreignKeys: foreignKeys.rows.map((r) => ({ from: r.from, table: r.table, to: r.to, onDelete: String(r.on_delete).toLowerCase() })),
  };
}

let tablesChecked = 0;
for (const exported of Object.values(schema)) {
  if (!exported || typeof exported !== 'object') continue;
  let config;
  try {
    config = getTableConfig(exported);
  } catch {
    continue; // not a table
  }
  tablesChecked += 1;
  const tableName = config.name;

  const tableExists = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name = ?", args: [tableName] });
  if (tableExists.rows.length === 0) {
    drift.push(`table "${tableName}" is declared in db/schema.ts but does not exist in the database`);
    continue;
  }

  const actual = await loadActualTable(tableName);
  const actualColumnsByName = new Map(actual.columns.map((c) => [c.name, c]));

  for (const col of config.columns) {
    const actualCol = actualColumnsByName.get(col.name);
    if (!actualCol) {
      drift.push(`column "${tableName}.${col.name}" is declared in db/schema.ts but missing in the database`);
      continue;
    }
    const expectedNotNull = col.notNull;
    if (expectedNotNull !== actualCol.notNull) {
      drift.push(`column "${tableName}.${col.name}" NOT NULL mismatch: schema.ts=${expectedNotNull} db=${actualCol.notNull}`);
    }
  }
  for (const actualCol of actual.columns) {
    if (!config.columns.some((c) => c.name === actualCol.name)) {
      drift.push(`column "${tableName}.${actualCol.name}" exists in the database but is not declared in db/schema.ts`);
    }
  }

  for (const idx of config.indexes) {
    const expectedColumns = idx.config.columns.map((c) => c.name);
    const actualIdx = actual.indexes.find((a) => a.name === idx.config.name);
    if (!actualIdx) {
      drift.push(`index "${idx.config.name}" is declared in db/schema.ts but missing in the database`);
      continue;
    }
    if (actualIdx.unique !== idx.config.unique) {
      drift.push(`index "${idx.config.name}" uniqueness mismatch: schema.ts=${idx.config.unique} db=${actualIdx.unique}`);
    }
    if (JSON.stringify(actualIdx.columns) !== JSON.stringify(expectedColumns)) {
      drift.push(`index "${idx.config.name}" column mismatch: schema.ts=${JSON.stringify(expectedColumns)} db=${JSON.stringify(actualIdx.columns)}`);
    }
  }
  const declaredIndexNames = new Set(config.indexes.map((i) => i.config.name));
  for (const actualIdx of actual.indexes) {
    if (actualIdx.name.startsWith('sqlite_autoindex_')) continue; // implicit PK indexes, not user-declared
    if (!declaredIndexNames.has(actualIdx.name)) {
      drift.push(`index "${actualIdx.name}" exists in the database but is not declared in db/schema.ts`);
    }
  }

  for (const fk of config.foreignKeys) {
    const ref = fk.reference();
    const fromColumn = ref.columns[0].name;
    const toTable = ref.foreignTable[Symbol.for('drizzle:Name')] ?? getTableConfig(ref.foreignTable).name;
    const expectedOnDelete = fk.onDelete ?? 'no action';
    const actualFk = actual.foreignKeys.find((a) => a.from === fromColumn && a.table === toTable);
    if (!actualFk) {
      drift.push(`foreign key "${tableName}.${fromColumn}" -> "${toTable}" is declared in db/schema.ts but missing in the database`);
      continue;
    }
    if (actualFk.onDelete !== expectedOnDelete) {
      drift.push(`foreign key "${tableName}.${fromColumn}" -> "${toTable}" onDelete mismatch: schema.ts="${expectedOnDelete}" db="${actualFk.onDelete}"`);
    }
  }
  for (const actualFk of actual.foreignKeys) {
    const declared = config.foreignKeys.some((fk) => fk.reference().columns[0].name === actualFk.from);
    if (!declared) {
      drift.push(`foreign key "${tableName}.${actualFk.from}" -> "${actualFk.table}" exists in the database but is not declared in db/schema.ts`);
    }
  }
}

client.close();
if (!remote) {
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
  }
}

// Guards against the check silently comparing zero tables (e.g. a broken
// filter that skips every export) and reporting a false "0 issues" pass.
assert(tablesChecked >= 8, `expected to check at least 8 tables from db/schema.ts, only checked ${tablesChecked} — the comparison logic itself may be broken`);

if (drift.length > 0) {
  console.error(`Schema drift detected (${drift.length} issue(s)):`);
  for (const line of drift) console.error(` - ${line}`);
}
assert.equal(drift.length, 0, `db/schema.ts must match the migrated database structure exactly (see drift details above)`);
console.log(`Schema drift check passed against ${remote ? 'turnitplus-dev' : 'a local migrated database'}: ${tablesChecked} tables checked, 0 issues.`);
