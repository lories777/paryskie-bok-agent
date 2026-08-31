import { describe, expect, it } from 'vitest';
import { ConnectorService } from '../src/service.js';
import { FakeApi, FakeRepository, reference } from './fixtures.js';

describe('ConnectorService read-only', () => {
  it('zwraca pełny kontrakt dla istniejącego zamówienia bez PII', async () => {
    const service = new ConnectorService(new FakeRepository(), new FakeApi(), { maxResults: 25 });
    const result = await service.getOrder('PL-10001');

    expect(result.found).toBe(true);
    expect(result.market).toBe('PL');
    expect(result.error).toBeNull();
    expect(result.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(result)).not.toContain('sekret.klienta@example.com');
    expect(JSON.stringify(result)).not.toContain('Tajna 1');
    expect(JSON.stringify(result)).not.toContain('Sekretna notatka');
  });

  it('odróżnia NOT_FOUND od błędu technicznego', async () => {
    const service = new ConnectorService(new FakeRepository([]), new FakeApi(), { maxResults: 25 });
    const result = await service.getOrder('NIE-MA');

    expect(result.found).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(result.market).toBeNull();
  });

  it('nie echoje identyfikatora klienta w wynikach wyszukiwania', async () => {
    const service = new ConnectorService(new FakeRepository(), new FakeApi(), { maxResults: 25 });
    const result = await service.searchOrders({ email: 'sekret.klienta@example.com' });

    expect(result.found).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sekret.klienta@example.com');
    expect((result.facts as { result_count: number }).result_count).toBe(1);
  });

  it('zwraca skany kurierskie z wąskiego endpointu', async () => {
    const service = new ConnectorService(new FakeRepository(), new FakeApi(), { maxResults: 25 });
    const result = await service.getShipments(reference.orderNumber);
    const shipments = (result.facts as { shipments: Array<{ scans: unknown[] }> }).shipments;

    expect(shipments[0]?.scans).toHaveLength(1);
  });

  it('zwraca dokładne dane dostawy tylko przez dedykowany odczyt BOK', async () => {
    const service = new ConnectorService(new FakeRepository(), new FakeApi(), { maxResults: 25 });
    const result = await service.getDeliveryDetails(reference.orderNumber);
    const delivery = (result.facts as { delivery: Record<string, unknown> }).delivery;

    expect(delivery).toMatchObject({
      delivery_type: 'pickup_point',
      pickup_point: { id: 'WAW01M' },
      shipping_address: { line1: 'Tajna 1', postal_code: '00-001' },
    });
    expect(JSON.stringify(result)).not.toContain('sekret.klienta@example.com');
    expect(JSON.stringify(result)).not.toContain('+48 600 700 800');
  });

  it('ml_query zwraca dowody zamiast wygenerowanej odpowiedzi', async () => {
    const service = new ConnectorService(new FakeRepository(), new FakeApi(), { maxResults: 25 });
    const result = await service.query('Czy paczka została wysłana?', { order_number: reference.orderNumber });
    const facts = result.facts as { answer_mode: string; evidence: unknown[] };

    expect(facts.answer_mode).toBe('source_facts_only');
    expect(facts.evidence).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('Czy paczka');
  });
});
