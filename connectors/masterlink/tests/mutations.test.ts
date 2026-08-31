import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../src/idempotency.js';
import { MutationService } from '../src/mutations.js';
import { FakeApi, FakeRepository, makeDetail, reference } from './fixtures.js';

const tempDirs: string[] = [];
function store(): IdempotencyStore {
  const dir = mkdtempSync(join(tmpdir(), 'ml-mcp-idempotency-'));
  tempDirs.push(dir);
  return new IdempotencyStore(join(dir, 'idempotency.sqlite'));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MutationService gates', () => {
  it('dry-run działa przy wyłączonych mutacjach i niczego nie zapisuje', async () => {
    const api = new FakeApi();
    api.detail = makeDetail({ status: 'imported' });
    const idempotency = store();
    const service = new MutationService(new FakeRepository(), api, { mutationsEnabled: false }, idempotency);
    const result = await service.cancel({
      order_number: reference.orderNumber,
      reason: 'Prośba klienta',
      idempotency_key: 'ticket-123-cancel',
      dry_run: true,
    });

    expect(result.error).toBeNull();
    expect((result.facts as { write_performed: boolean }).write_performed).toBe(false);
    expect(api.posts).toHaveLength(0);
    idempotency.close();
  });

  it('odrzuca niedozwolone przejście statusu przed API', async () => {
    const api = new FakeApi();
    api.detail = makeDetail({ status: 'delivered' });
    const idempotency = store();
    const service = new MutationService(new FakeRepository(), api, { mutationsEnabled: true }, idempotency);
    const result = await service.cancel({
      order_number: reference.orderNumber,
      reason: 'Za późno',
      idempotency_key: 'ticket-456-cancel',
      dry_run: false,
    });

    expect(result.error?.code).toBe('TRANSITION_NOT_ALLOWED');
    expect(api.posts).toHaveLength(0);
    idempotency.close();
  });

  it('wykonuje jednoznaczny zapis bez technicznego approval_ref', async () => {
    const api = new FakeApi();
    api.detail = makeDetail({ status: 'imported' });
    const idempotency = store();
    const service = new MutationService(new FakeRepository(), api, { mutationsEnabled: true }, idempotency);
    const result = await service.cancel({
      order_number: reference.orderNumber,
      reason: 'Prośba klienta',
      idempotency_key: 'ticket-789-cancel',
      dry_run: false,
    });

    expect(result.error).toBeNull();
    expect((result.facts as { write_performed: boolean }).write_performed).toBe(true);
    expect(api.posts).toHaveLength(1);
    idempotency.close();
  });

  it('idempotency_key powoduje replay bez drugiego zapisu', async () => {
    const api = new FakeApi();
    const idempotency = store();
    const service = new MutationService(new FakeRepository(), api, { mutationsEnabled: true }, idempotency);
    const input = {
      order_number: reference.orderNumber,
      note: 'Ustalenie wewnętrzne',
      idempotency_key: 'ticket-999-note',
      dry_run: false,
    } as const;
    const first = await service.addInternalNote(input);
    const second = await service.addInternalNote(input);

    expect(first.error).toBeNull();
    expect(second).toEqual(first);
    expect(api.posts).toHaveLength(1);
    idempotency.close();
  });

  it('wyłącznik środowiskowy blokuje realną mutację', async () => {
    const api = new FakeApi();
    const idempotency = store();
    const service = new MutationService(new FakeRepository(), api, { mutationsEnabled: false }, idempotency);
    const result = await service.addInternalNote({
      order_number: reference.orderNumber,
      note: 'Ustalenie',
      idempotency_key: 'ticket-1000-note',
      dry_run: false,
    });

    expect(result.error?.code).toBe('MUTATIONS_DISABLED');
    expect(api.posts).toHaveLength(0);
    idempotency.close();
  });
});
