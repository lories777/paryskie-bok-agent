import type { MasterLinkApi, OrderReference, ReadRepository, SearchIdentifiers } from '../src/types.js';

export const reference: OrderReference = {
  id: '11111111-1111-4111-8111-111111111111',
  orderNumber: 'PL-10001',
  externalOrderId: '10001',
  market: 'PL',
  status: 'shipped',
  paymentStatus: 'paid',
  sourceCode: 'wc_pl',
  placedAt: '2026-08-20T10:00:00.000Z',
  createdAt: '2026-08-20T10:01:00.000Z',
  updatedAt: '2026-08-22T12:00:00.000Z',
};

export function makeDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: reference.id,
    orderNumber: reference.orderNumber,
    externalOrderId: reference.externalOrderId,
    sourceCode: reference.sourceCode,
    market: reference.market,
    status: reference.status,
    paymentStatus: reference.paymentStatus,
    paymentMethod: 'paynow',
    currency: 'PLN',
    totalGross: '129.90',
    cod: false,
    priority: 0,
    flags: [],
    specialQueue: null,
    totalItems: 1,
    customerEmail: 'sekret.klienta@example.com',
    customerPhone: '+48 600 700 800',
    customerName: 'Dane Klienta',
    shippingAddress: { line1: 'Tajna 1', line2: null, city: 'Warszawa', postalCode: '00-001', countryCode: 'PL' },
    notes: 'Treść z danymi osobowymi',
    placedAt: reference.placedAt,
    createdAt: reference.createdAt,
    updatedAt: reference.updatedAt,
    statusOd: '2026-08-22T11:00:00.000Z',
    items: [{ sku: 'PP-001', name: 'Perfumy 001', qty: 1, unitPrice: 129.9, isGift: false, alreadyReturnedQty: 0 }],
    erpOrderRef: 'ZOP/10001',
    erpOrderDocNumber: 'ZOP/10001',
    wzNumber: 'WZ/10001',
    fvNumber: 'FV/10001',
    pickingStartedAt: '2026-08-21T10:00:00.000Z',
    pickingBatchCode: 'B-01',
    labelPrintedAt: '2026-08-21T11:00:00.000Z',
    luznaEtykieta: false,
    odbiorOsobisty: false,
    carrierCode: 'inpost',
    pickupPointId: 'WAW01M',
    pickupPointName: 'Paczkomat WAW01M, Testowa 2, Warszawa',
    trackingNumber: 'TRACK-10001',
    shipmentStatus: 'in_transit',
    sourcePaymentRefunded: false,
    sourcePaymentFailed: false,
    lastPaymentLinkSmsSentAt: null,
    erpCorrections: [],
    resends: [],
    internalNotes: [{ id: 1, body: 'Sekretna notatka', authorName: 'BOK', createdAt: '2026-08-21T09:00:00.000Z' }],
    statusHistory: [
      { fromStatus: 'labeled', toStatus: 'shipped', reason: 'Przekazano kurierowi', createdAt: '2026-08-22T11:00:00.000Z' },
    ],
    shipments: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        carrierCode: 'inpost',
        przewoznikDocelowy: null,
        externalId: 'SHIP-1',
        trackingNumber: 'TRACK-10001',
        trackingUrl: 'https://tracking.example/TRACK-10001',
        status: 'in_transit',
        canonical: true,
        invalidatedAt: null,
        createdAt: '2026-08-21T10:30:00.000Z',
      },
    ],
    returns: [],
    ...overrides,
  };
}

export class FakeRepository implements ReadRepository {
  constructor(public rows: OrderReference[] = [reference]) {}
  async ping(): Promise<void> {}
  async findByOrderNumber(orderNumber: string): Promise<OrderReference | null> {
    return this.rows.find((row) => row.orderNumber.toLowerCase() === orderNumber.toLowerCase()) ?? null;
  }
  async search(_identifiers: SearchIdentifiers, limit: number) {
    return { rows: this.rows.slice(0, limit), truncated: this.rows.length > limit };
  }
  async customerHistory(_customerIdentifier: string, limit: number) {
    return { rows: this.rows.slice(0, limit), truncated: this.rows.length > limit };
  }
  async close(): Promise<void> {}
}

export class FakeApi implements MasterLinkApi {
  posts: Array<{ path: string; body: unknown }> = [];
  puts: Array<{ path: string; body: unknown }> = [];
  detail = makeDetail();
  async ping(): Promise<void> {}
  async getOrderDetail(_id: string): Promise<Record<string, unknown>> {
    return structuredClone(this.detail);
  }
  async get(_path: string): Promise<unknown> {
    return {
      events: [{
        status: 'in_transit',
        description: 'Przesyłka w drodze',
        occurredAt: '2026-08-22T12:00:00.000Z',
        source: 'poll',
        createdAt: '2026-08-22T12:01:00.000Z',
      }],
    };
  }
  async post(path: string, body: unknown): Promise<unknown> {
    this.posts.push({ path, body });
    if (path.endsWith('/internal-notes')) {
      const notes = this.detail.internalNotes as unknown[];
      notes.push({ id: notes.length + 1, body: (body as { text: string }).text, authorName: 'BOK', createdAt: new Date().toISOString() });
    }
    if (path.endsWith('/action')) this.detail.status = 'cancelled';
    if (path === '/api/returns') {
      const returns = this.detail.returns as unknown[];
      returns.push({ id: 'return-1', type: (body as { type: string }).type, status: 'registered' });
    }
    return { ok: true };
  }
  async put(path: string, body: unknown): Promise<unknown> {
    this.puts.push({ path, body });
    const patch = body as Record<string, unknown>;
    if ('carrierCode' in patch) this.detail.carrierCode = patch.carrierCode;
    if ('pickupPointId' in patch) this.detail.pickupPointId = patch.pickupPointId;
    return { ok: true };
  }
}
