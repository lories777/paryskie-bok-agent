import { describe, expect, it } from 'vitest';
import { ApiReadRepository } from '../src/masterlink/api-read-repository.js';
import { loadConfig } from '../src/config.js';
import type { MasterLinkApi } from '../src/types.js';
import { makeDetail, reference } from './fixtures.js';

function fakeApi(details: Record<string, unknown>[]) {
  const calls: string[] = [];
  let loggedOut = 0;
  const api: MasterLinkApi & { logout(): Promise<void> } = {
    async ping() { calls.push('ping'); },
    async getOrderDetail(id) {
      calls.push(`detail:${id}`);
      const found = details.find((detail) => detail.id === id);
      if (!found) throw new Error('not found');
      return found;
    },
    async get(path) {
      calls.push(`get:${path}`);
      const q = new URL(`https://ml.test${path}`).searchParams.get('q') ?? '';
      // Jak ML: dopasowanie „zawiera" po numerze, e-mailu, telefonie (cyfry) i trackingu.
      const items = details.filter((detail) => [
        detail.orderNumber, detail.customerEmail, detail.trackingNumber,
        String(detail.customerPhone ?? '').replace(/\D/g, ''),
      ].some((value) => typeof value === 'string' && value.toLowerCase().includes(q.toLowerCase())));
      return {
        items: items.map((detail) => ({
          id: detail.id, orderNumber: detail.orderNumber, trackingNumber: detail.trackingNumber,
        })),
        total: items.length,
      };
    },
    async post() { throw new Error('API read repository nie może zapisywać'); },
    async put() { throw new Error('API read repository nie może zapisywać'); },
    async logout() { loggedOut += 1; },
  };
  return { api, calls, loggedOut: () => loggedOut };
}

const other = makeDetail({
  id: '22222222-2222-4222-8222-222222222222',
  orderNumber: 'PL-100011',
  externalOrderId: '100011',
  customerEmail: 'inny@example.com',
  customerPhone: '+48 600 700 801',
  trackingNumber: 'TRACK-100011',
  createdAt: '2026-08-25T10:00:00.000Z',
});

describe('ApiReadRepository', () => {
  it('numer zamówienia: dokładne dopasowanie mimo trafień „zawiera"', async () => {
    const { api, calls } = fakeApi([makeDetail(), other]);
    const repository = new ApiReadRepository(api);
    expect(await repository.findByOrderNumber(' pl-10001 ')).toEqual(reference);
    expect(calls.filter((call) => call.startsWith('detail:'))).toEqual([`detail:${reference.id}`]);
    expect(await repository.findByOrderNumber('PL-99999')).toBeNull();
  });

  it('niejednoznaczny numer kończy się błędem jak w SQL', async () => {
    const { api } = fakeApi([makeDetail(), makeDetail({ id: '33333333-3333-4333-8333-333333333333' })]);
    await expect(new ApiReadRepository(api).findByOrderNumber('PL-10001')).rejects.toThrow(/Niejednoznaczny/);
  });

  it('telefon i e-mail: jedno słowo zapytania, dokładne porównanie na szczegółach', async () => {
    const { api, calls } = fakeApi([makeDetail(), other]);
    const repository = new ApiReadRepository(api);
    const byPhone = await repository.search({ phone: '+48 600-700-800' }, 10);
    expect(byPhone.rows.map((row) => row.orderNumber)).toEqual(['PL-10001']);
    expect(calls.some((call) => call.includes('q=48600700800'))).toBe(true);
    const byEmail = await repository.customerHistory('SEKRET.klienta@example.com', 10);
    expect(byEmail.rows.map((row) => row.orderNumber)).toEqual(['PL-10001']);
    const both = await repository.search({ email: 'inny@example.com', tracking_number: 'TRACK-10001' }, 10);
    expect(both.rows).toEqual([]);
  });

  it('limit i truncated jak w SQL; tylko GET', async () => {
    const { api, calls } = fakeApi([
      makeDetail({ customerEmail: 'ta@example.com' }),
      { ...other, customerEmail: 'ta@example.com' },
    ]);
    const result = await new ApiReadRepository(api).search({ email: 'ta@example.com' }, 1);
    expect(result.rows.map((row) => row.orderNumber)).toEqual(['PL-100011']);
    expect(result.truncated).toBe(true);
    expect(calls.every((call) => call.startsWith('get:') || call.startsWith('detail:'))).toBe(true);
  });

  it('close() zamyka sesję API', async () => {
    const fake = fakeApi([]);
    await new ApiReadRepository(fake.api).close();
    expect(fake.loggedOut()).toBe(1);
  });
});

describe('ML_READ_BACKEND', () => {
  const base = {
    ML_API_BASE_URL: 'https://ml.test',
    ML_USERNAME: 'bok',
    ML_PASSWORD: 'x',
    ML_AUDIT_HASH_KEY: 'k'.repeat(32),
  };

  it('api nie wymaga URL bazy; db nadal wymaga', () => {
    expect(loadConfig({ ...base, ML_READ_BACKEND: 'api' }).readBackend).toBe('api');
    expect(loadConfig({ ...base, ML_READ_DATABASE_URL: 'postgresql://ro@localhost/ml' }).readBackend).toBe('db');
    expect(() => loadConfig({ ...base })).toThrow(/ML_READ_DATABASE_URL/);
  });
});
