import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../src/idempotency.js';
import { buildMcpServer } from '../src/mcp.js';
import { MutationService } from '../src/mutations.js';
import { AuditLogger } from '../src/security/audit.js';
import { ConnectorService } from '../src/service.js';
import { FakeApi, FakeRepository } from './fixtures.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MCP contract', () => {
  it('publikuje wszystkie wymagane narzędzia i poprawne adnotacje', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-mcp-contract-'));
    dirs.push(dir);
    const repository = new FakeRepository();
    const api = new FakeApi();
    const reads = new ConnectorService(repository, api, { maxResults: 25 });
    const idempotency = new IdempotencyStore(join(dir, 'idempotency.sqlite'));
    const mutations = new MutationService(repository, api, { mutationsEnabled: false }, idempotency);
    const audit = new AuditLogger(join(dir, 'audit.jsonl'), 'a'.repeat(32));
    const server = buildMcpServer(reads, mutations, audit);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'ml_get_order',
      'ml_search_orders',
      'ml_get_payment',
      'ml_get_fulfillment',
      'ml_get_delivery_details',
      'ml_get_shipments',
      'ml_get_returns_and_refunds',
      'ml_get_customer_order_history',
      'ml_query',
      'ml_cancel_order',
      'ml_add_internal_note',
      'ml_start_return',
      'ml_correct_delivery_data',
    ]));
    expect(listed.tools).toHaveLength(13);
    expect(listed.tools.find((tool) => tool.name === 'ml_get_order')?.annotations?.readOnlyHint).toBe(true);
    const cancelTool = listed.tools.find((tool) => tool.name === 'ml_cancel_order');
    expect(cancelTool?.annotations?.readOnlyHint).toBe(false);
    expect(cancelTool?.inputSchema.properties).not.toHaveProperty('approval_ref');
    expect(cancelTool?.inputSchema.required).toEqual(expect.arrayContaining([
      'order_number',
      'reason',
      'idempotency_key',
    ]));

    const call = await client.callTool({ name: 'ml_get_order', arguments: { order_number: 'PL-10001' } });
    expect(call.structuredContent).toMatchObject({ found: true, market: 'PL', error: null });

    await client.close();
    await server.close();
    idempotency.close();
    audit.close();
  });
});
