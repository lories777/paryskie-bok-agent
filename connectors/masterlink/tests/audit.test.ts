import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLogger } from '../src/security/audit.js';
import type { ConnectorResult } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AuditLogger', () => {
  it('zapisuje wyłącznie hashe identyfikatorów i nie zapisuje treści', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-mcp-audit-'));
    dirs.push(dir);
    const path = join(dir, 'audit.jsonl');
    const audit = new AuditLogger(path, 'x'.repeat(32));
    const result: ConnectorResult = {
      found: true,
      market: 'PL',
      facts: {},
      timestamps: {},
      source: { system: 'MasterLink', access: 'read_only_database_and_authenticated_api', resources: ['orders'] },
      checked_at: new Date().toISOString(),
      error: null,
    };
    audit.record({
      tool: 'ml_query',
      args: {
        order_number: 'PL-SECRET-1',
        question: 'Pytanie z danymi klienta',
        note: 'Treść prywatnej notatki',
        idempotency_key: 'secret-key-1',
      },
      result,
      durationMs: 12,
      mutation: false,
    });
    audit.close();

    const text = readFileSync(path, 'utf8');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(text).not.toContain('PL-SECRET-1');
    expect(text).not.toContain('Pytanie z danymi klienta');
    expect(text).not.toContain('Treść prywatnej notatki');
    expect(text).not.toContain('secret-key-1');
    expect(JSON.parse(text).identifier_hashes[0]).toMatch(/^[a-f0-9]{64}$/);
  });
});
