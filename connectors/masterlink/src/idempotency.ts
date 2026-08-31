import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

interface StoredRow {
  tool: string;
  request_hash: string;
  status: 'in_progress' | 'complete' | 'failed';
  response_json: string | null;
}

export type IdempotencyCheck =
  | { state: 'new'; keyHash: string }
  | { state: 'replay'; response: unknown }
  | { state: 'conflict' }
  | { state: 'uncertain' };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function stableHash(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)]));
    }
    return input;
  };
  return sha256(JSON.stringify(sort(value)));
}

export class IdempotencyStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error('Plik idempotencji nie może być dowiązaniem symbolicznym.');
    }
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mutation_idempotency (
        key_hash TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('in_progress', 'complete', 'failed')),
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  check(key: string, tool: string, requestHash: string): IdempotencyCheck {
    const keyHash = sha256(key);
    const row = this.db
      .prepare('SELECT tool, request_hash, status, response_json FROM mutation_idempotency WHERE key_hash = ?')
      .get(keyHash) as unknown as StoredRow | undefined;
    if (!row) return { state: 'new', keyHash };
    if (row.tool !== tool || row.request_hash !== requestHash) return { state: 'conflict' };
    if (row.status === 'complete' && row.response_json) {
      return { state: 'replay', response: JSON.parse(row.response_json) as unknown };
    }
    return { state: 'uncertain' };
  }

  reserve(keyHash: string, tool: string, requestHash: string): boolean {
    const timestamp = new Date().toISOString();
    const outcome = this.db
      .prepare(
        `INSERT OR IGNORE INTO mutation_idempotency
          (key_hash, tool, request_hash, status, response_json, created_at, updated_at)
         VALUES (?, ?, ?, 'in_progress', NULL, ?, ?)`,
      )
      .run(keyHash, tool, requestHash, timestamp, timestamp);
    return outcome.changes === 1;
  }

  complete(keyHash: string, response: unknown): void {
    this.db
      .prepare("UPDATE mutation_idempotency SET status = 'complete', response_json = ?, updated_at = ? WHERE key_hash = ?")
      .run(JSON.stringify(response), new Date().toISOString(), keyHash);
  }

  fail(keyHash: string): void {
    this.db
      .prepare("UPDATE mutation_idempotency SET status = 'failed', updated_at = ? WHERE key_hash = ?")
      .run(new Date().toISOString(), keyHash);
  }

  close(): void {
    this.db.close();
  }
}
