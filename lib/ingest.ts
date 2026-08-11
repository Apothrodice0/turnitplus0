import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3'; // runtime-only, shimmed for types in /types
import { createClient } from '@libsql/client';
import type { Client, InStatement } from '@libsql/client';
import path from 'path';
import fs from 'fs';
import { tokens, grams, gramHash } from './similarity-core';

export type IngestResult = {
  documentId: string;
  contributionId: string;
  created: boolean; // true if newly created, false if already existed
  chunkCount: number;
  provenanceSha256: string;
  uniqueShingleCount: number;
};

function readShingleSize(): number {
  try {
    const metaPath = path.join(process.cwd(), 'public', 'data', 'document-index.meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { shingleSize?: number };
      if (meta && typeof meta.shingleSize === 'number' && Number.isInteger(meta.shingleSize) && meta.shingleSize > 0) return meta.shingleSize;
    }
  } catch (err) {
    // ignore and fall back
  }
  return 5; // fallback to 5 if metadata not present
}

function sha256Hex(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function applyMigrations(db: any, drizzleDir: string) {
  const files = fs.readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
    db.exec(sql);
  }
}

export function ingestDocument(dbPath: string, payload: { id?: string; title?: string; text: string; contributionPolicyVersion: string; provenanceSha256?: string }, options?: { simulateFailureAfterChunkIndex?: number }): IngestResult {
  const db: any = new Database(dbPath);
  try {
    // Ensure foreign keys
    db.pragma('foreign_keys = ON');

    // Compute fingerprint
    const normalizedText = payload.text; // similarity-core.tokens will normalize
    const provenance = payload.provenanceSha256 ?? sha256Hex(normalizedText);

    const existing = db.prepare('SELECT id FROM documents WHERE provenance_sha256 = ?').get(provenance);
    if (existing) {
      // document exists, generate contributionId and return existing info
      const contributionId = randomUUID();
      // create a contribution record by inserting to documents? For now, store contributionId in a lightweight contributions table
      db.prepare(`INSERT INTO contributions (contribution_id, document_id, contribution_policy_version, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)`).run(contributionId, existing.id, payload.contributionPolicyVersion);

      // compute counts for return
      const chunkCountRow = db.prepare('SELECT COUNT(*) as cnt FROM document_chunks WHERE document_id = ?').get(existing.id);
      const uniqueShingleRow = db.prepare('SELECT COUNT(DISTINCT shingle_hash) as cnt FROM chunk_fingerprints cf JOIN document_chunks dc ON cf.chunk_id = dc.id WHERE dc.document_id = ?').get(existing.id);
      return {
        documentId: existing.id,
        contributionId,
        created: false,
        chunkCount: chunkCountRow.cnt,
        provenanceSha256: provenance,
        uniqueShingleCount: uniqueShingleRow.cnt,
      };
    }

    // new document: do transactional insert
    const documentId = payload.id ?? randomUUID();
    const contributionId = randomUUID();

    const insertDocument = db.prepare(`INSERT INTO documents (id, title, provenance_sha256, source_type, original_similarity, word_count, unique_shingle_count, storage_pointer, created_at, updated_at, contribution_policy_version) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?)`);

    const insertChunk = db.prepare('INSERT INTO document_chunks (document_id, chunk_index, token_count, token_start, created_at) VALUES (?,?,?,? ,CURRENT_TIMESTAMP)');
    const insertFingerprint = db.prepare('INSERT INTO chunk_fingerprints (chunk_id, shingle_hash, position, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)');

    const SHINGLE_SIZE = readShingleSize();

    const tx = db.transaction((text: string) => {
      // tokenize entire doc
      const words = tokens(text);
      // deterministic chunking: split into chunks of 1000 tokens (configurable)
      const CHUNK_TOKEN_TARGET = 1000;
      const chunks: { start: number; tokens: string[] }[] = [];
      for (let i = 0; i < words.length; i += CHUNK_TOKEN_TARGET) {
        const slice = words.slice(i, i + CHUNK_TOKEN_TARGET);
        chunks.push({ start: i, tokens: slice });
      }

      insertDocument.run(documentId, payload.title ?? documentId, provenance, 'Publication', null, words.length, 0, null, payload.contributionPolicyVersion);

      let chunkIdSeq = 0;
      const uniqueShingles = new Set<string>();
      for (const [index, chunk] of chunks.entries()) {
        const info = insertChunk.run(documentId, index, chunk.tokens.length, chunk.start);
        const chunkRowId = info.lastInsertRowid as number;
        chunkIdSeq += 1;
        // allow test harness to simulate failure right after inserting a chunk
        if (options?.simulateFailureAfterChunkIndex !== undefined && index === options.simulateFailureAfterChunkIndex) {
          throw new Error('Simulated failure after chunk insert');
        }
        // generate shingles per chunk and store fingerprints; positions are global positions
        const gramsList = grams(chunk.tokens, SHINGLE_SIZE);
        for (let g = 0; g < gramsList.length; g++) {
          const gram = gramsList[g];
          const hash = gramHash(gram);
          uniqueShingles.add(hash);
          const globalPosition = chunk.start + g; // position is start index of shingle in words
          insertFingerprint.run(chunkRowId, hash, globalPosition);
        }
      }

      // update documents.unique_shingle_count
      db.prepare('UPDATE documents SET unique_shingle_count = ? WHERE id = ?').run(uniqueShingles.size, documentId);

      // record contribution
      db.prepare('CREATE TABLE IF NOT EXISTS contributions (contribution_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, contribution_policy_version TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE)').run();
      db.prepare('INSERT INTO contributions (contribution_id, document_id, contribution_policy_version) VALUES (?,?,?)').run(contributionId, documentId, payload.contributionPolicyVersion);

      return { chunkCount: chunks.length, uniqueShingleCount: uniqueShingles.size };
    });

    const info = tx(payload.text);

    return {
      documentId,
      contributionId,
      created: true,
      chunkCount: info.chunkCount,
      provenanceSha256: provenance,
      uniqueShingleCount: info.uniqueShingleCount,
    };
  } finally {
    db.close();
  }
}

// --- libSQL / Turso path -----------------------------------------------
// Independent implementation (not shared with the better-sqlite3 path above)
// so ingestDocument() above stays untouched. Some tokenize/chunk/hash logic
// is intentionally duplicated from ingestDocument's transaction body.

export type LibsqlConnection = { url: string; authToken?: string };

/** Apply the drizzle/*.sql migration files to a libSQL database (local file or remote). */
export async function applyMigrationsLibsql(client: Client, drizzleDir: string) {
  const files = fs.readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
    await client.executeMultiple(sql);
  }
}

function planIngestion(text: string, shingleSize: number) {
  const words = tokens(text);
  const CHUNK_TOKEN_TARGET = 1000;
  const uniqueShingles = new Set<string>();
  const chunks: {
    index: number;
    start: number;
    tokenCount: number;
    fingerprints: { hash: string; position: number }[];
  }[] = [];

  let chunkIndex = 0;
  for (let i = 0; i < words.length; i += CHUNK_TOKEN_TARGET) {
    const slice = words.slice(i, i + CHUNK_TOKEN_TARGET);
    const gramsList = grams(slice, shingleSize);
    const fingerprints = gramsList.map((gram, g) => {
      const hash = gramHash(gram);
      uniqueShingles.add(hash);
      return { hash, position: i + g };
    });
    chunks.push({ index: chunkIndex, start: i, tokenCount: slice.length, fingerprints });
    chunkIndex += 1;
  }

  return { wordCount: words.length, chunks, uniqueShingleCount: uniqueShingles.size };
}

/**
 * libSQL/Turso equivalent of ingestDocument(). Uses client.batch(..., "write")
 * for atomicity instead of better-sqlite3's synchronous transaction: batch()
 * wraps all statements in one server-side transaction and rejects (rolling
 * back everything) if any statement fails. Chunk fingerprints resolve their
 * chunk_id via a `WHERE document_id = ? AND chunk_index = ?` subquery instead
 * of a captured lastInsertRowid, since batch() statements can't read back
 * JS-side results from earlier statements in the same call.
 */
export async function ingestDocumentLibsql(
  connection: LibsqlConnection,
  payload: { id?: string; title?: string; text: string; contributionPolicyVersion: string; provenanceSha256?: string },
): Promise<IngestResult> {
  const client = createClient(connection);
  try {
    const provenance = payload.provenanceSha256 ?? sha256Hex(payload.text);

    const existing = await client.execute({
      sql: 'SELECT id FROM documents WHERE provenance_sha256 = ?',
      args: [provenance],
    });
    const existingRow = existing.rows[0] as unknown as { id: string } | undefined;

    if (existingRow) {
      const contributionId = randomUUID();
      await client.execute({
        sql: 'INSERT INTO contributions (contribution_id, document_id, contribution_policy_version, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)',
        args: [contributionId, existingRow.id, payload.contributionPolicyVersion],
      });
      const chunkCountResult = await client.execute({
        sql: 'SELECT COUNT(*) as cnt FROM document_chunks WHERE document_id = ?',
        args: [existingRow.id],
      });
      const uniqueShingleResult = await client.execute({
        sql: 'SELECT COUNT(DISTINCT shingle_hash) as cnt FROM chunk_fingerprints cf JOIN document_chunks dc ON cf.chunk_id = dc.id WHERE dc.document_id = ?',
        args: [existingRow.id],
      });
      return {
        documentId: existingRow.id,
        contributionId,
        created: false,
        chunkCount: Number((chunkCountResult.rows[0] as unknown as { cnt: number }).cnt),
        provenanceSha256: provenance,
        uniqueShingleCount: Number((uniqueShingleResult.rows[0] as unknown as { cnt: number }).cnt),
      };
    }

    const documentId = payload.id ?? randomUUID();
    const contributionId = randomUUID();
    const SHINGLE_SIZE = readShingleSize();
    const plan = planIngestion(payload.text, SHINGLE_SIZE);

    const statements: InStatement[] = [];
    statements.push({
      sql: 'INSERT INTO documents (id, title, provenance_sha256, source_type, original_similarity, word_count, unique_shingle_count, storage_pointer, created_at, updated_at, contribution_policy_version) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?)',
      args: [documentId, payload.title ?? documentId, provenance, 'Publication', null, plan.wordCount, 0, null, payload.contributionPolicyVersion],
    });

    for (const chunk of plan.chunks) {
      statements.push({
        sql: 'INSERT INTO document_chunks (document_id, chunk_index, token_count, token_start, created_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)',
        args: [documentId, chunk.index, chunk.tokenCount, chunk.start],
      });
      for (const fingerprint of chunk.fingerprints) {
        statements.push({
          sql: 'INSERT INTO chunk_fingerprints (chunk_id, shingle_hash, position, created_at) SELECT id, ?, ?, CURRENT_TIMESTAMP FROM document_chunks WHERE document_id = ? AND chunk_index = ?',
          args: [fingerprint.hash, fingerprint.position, documentId, chunk.index],
        });
      }
    }

    statements.push({
      sql: 'UPDATE documents SET unique_shingle_count = ? WHERE id = ?',
      args: [plan.uniqueShingleCount, documentId],
    });
    statements.push({
      sql: 'CREATE TABLE IF NOT EXISTS contributions (contribution_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, contribution_policy_version TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE)',
    });
    statements.push({
      sql: 'INSERT INTO contributions (contribution_id, document_id, contribution_policy_version) VALUES (?,?,?)',
      args: [contributionId, documentId, payload.contributionPolicyVersion],
    });

    // Atomic: if any statement fails, libSQL rolls back the whole batch and
    // this call rejects — proven empirically in tests/ingest-libsql.test.mjs.
    await client.batch(statements, 'write');

    return {
      documentId,
      contributionId,
      created: true,
      chunkCount: plan.chunks.length,
      provenanceSha256: provenance,
      uniqueShingleCount: plan.uniqueShingleCount,
    };
  } finally {
    client.close();
  }
}
