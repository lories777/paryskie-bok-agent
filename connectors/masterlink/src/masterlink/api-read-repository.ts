import type { MasterLinkApi, OrderReference, ReadRepository, SearchIdentifiers } from '../types.js';

/**
 * Odczyt zamówień przez oficjalne API MasterLink (rola `bok`), bez bezpośredniego dostępu
 * do PostgreSQL. Używany, gdy baza nie wpuszcza connectora (ML_READ_BACKEND=api).
 *
 * `GET /api/orders?q=` wyszukuje „zawiera" po wielu polach, więc lista służy tylko do
 * zawężenia kandydatów; dokładne dopasowanie (te same reguły co SQL w read-repository.ts)
 * robimy na szczegółach z `GET /api/orders/:id`. Wyłącznie GET — zero zapisów.
 */
const CANDIDATE_PAGE_SIZE = 100;
/** Ile szczegółów pobieramy dla jednego wyszukiwania; resztę zgłaszamy jako `truncated`. */
const MAX_DETAIL_LOOKUPS = 30;
const DETAIL_CONCURRENCY = 4;

interface Candidate {
  id: string;
  orderNumber: string;
  trackingNumber: string | null;
}

type LogoutCapable = MasterLinkApi & { logout?: () => Promise<void> };

function normalizePhone(value: string): string {
  return value.replace(/\D/g, '');
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mapApiOrder(detail: Record<string, unknown>): OrderReference {
  const id = text(detail.id);
  const orderNumber = text(detail.orderNumber);
  const market = text(detail.market);
  const status = text(detail.status);
  const createdAt = iso(detail.createdAt);
  const updatedAt = iso(detail.updatedAt);
  if (!id || !orderNumber || !market || !status || !createdAt || !updatedAt) {
    throw new Error('Nieprawidłowe dane zamówienia z API MasterLink.');
  }
  return {
    id,
    orderNumber,
    externalOrderId: text(detail.externalOrderId) ?? '',
    market,
    status,
    paymentStatus: text(detail.paymentStatus),
    sourceCode: text(detail.sourceCode),
    placedAt: iso(detail.placedAt),
    createdAt,
    updatedAt,
  };
}

function shipmentTrackingNumbers(detail: Record<string, unknown>): string[] {
  const shipments = Array.isArray(detail.shipments) ? detail.shipments : [];
  return shipments
    .map((shipment) => (shipment && typeof shipment === 'object'
      ? text((shipment as Record<string, unknown>).trackingNumber)
      : null))
    .filter((value): value is string => value !== null);
}

function matches(detail: Record<string, unknown>, identifiers: SearchIdentifiers): boolean {
  if (identifiers.email) {
    const email = text(detail.customerEmail);
    if (!email || email.toLowerCase() !== identifiers.email.trim().toLowerCase()) return false;
  }
  if (identifiers.phone) {
    if (normalizePhone(text(detail.customerPhone) ?? '') !== normalizePhone(identifiers.phone)) return false;
  }
  if (identifiers.tracking_number) {
    const wanted = identifiers.tracking_number.trim();
    if (text(detail.trackingNumber) !== wanted && !shipmentTrackingNumbers(detail).includes(wanted)) return false;
  }
  if (identifiers.external_id) {
    const external = text(detail.externalOrderId);
    if (!external || external.toLowerCase() !== identifiers.external_id.trim().toLowerCase()) return false;
  }
  return true;
}

export class ApiReadRepository implements ReadRepository {
  constructor(private readonly api: LogoutCapable) {}

  async ping(): Promise<void> {
    await this.api.ping();
  }

  private async candidates(query: string): Promise<{ items: Candidate[]; total: number }> {
    const params = new URLSearchParams({
      q: query,
      pageSize: String(CANDIDATE_PAGE_SIZE),
      sortBy: 'createdAt',
      sortDir: 'desc',
    });
    const body = await this.api.get(`/api/orders?${params.toString()}`);
    const rawItems = body && typeof body === 'object' ? (body as { items?: unknown }).items : undefined;
    if (!Array.isArray(rawItems)) throw new Error('Nieprawidłowa lista zamówień z API MasterLink.');
    const items = rawItems.flatMap((item): Candidate[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const id = text(record.id);
      const orderNumber = text(record.orderNumber);
      return id && orderNumber ? [{ id, orderNumber, trackingNumber: text(record.trackingNumber) }] : [];
    });
    const total = Number((body as { total?: unknown }).total);
    return { items, total: Number.isFinite(total) ? total : items.length };
  }

  private async details(ids: string[]): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = new Array(ids.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const index = next++;
        results[index] = await this.api.getOrderDetail(ids[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, ids.length) }, worker));
    return results;
  }

  async findByOrderNumber(orderNumber: string): Promise<OrderReference | null> {
    const wanted = orderNumber.trim();
    if (!wanted || /\s/.test(wanted)) return null;
    const { items } = await this.candidates(wanted);
    const exact = items.filter((item) => item.orderNumber.toLowerCase() === wanted.toLowerCase());
    if (exact.length > 1) throw new Error('Niejednoznaczny numer zamówienia w MasterLinku.');
    if (!exact[0]) return null;
    return mapApiOrder(await this.api.getOrderDetail(exact[0].id));
  }

  async search(
    identifiers: SearchIdentifiers,
    limit: number,
  ): Promise<{ rows: OrderReference[]; truncated: boolean }> {
    if (!identifiers.email && !identifiers.phone && !identifiers.tracking_number && !identifiers.external_id) {
      throw new Error('Podaj przynajmniej jeden identyfikator.');
    }
    const phone = identifiers.phone ? normalizePhone(identifiers.phone) : undefined;
    if (identifiers.phone && !phone) throw new Error('Telefon nie zawiera cyfr.');
    // Jedno słowo zapytania: `q` dzieli tekst po spacjach i łączy tokeny przez AND.
    const query = identifiers.tracking_number?.trim()
      ?? identifiers.email?.trim()
      ?? phone
      ?? identifiers.external_id!.trim();
    const { items, total } = await this.candidates(query);
    // Tracking z listy odsiewa obcych kandydatów bez pobierania szczegółów.
    const pool = identifiers.tracking_number
      ? items.filter((item) => item.trackingNumber === identifiers.tracking_number!.trim())
      : items;
    const inspected = pool.slice(0, MAX_DETAIL_LOOKUPS);
    const details = await this.details(inspected.map((item) => item.id));
    const rows = details.filter((detail) => matches(detail, identifiers)).map(mapApiOrder);
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const unchecked = pool.length > inspected.length || total > items.length;
    return { rows: rows.slice(0, limit), truncated: rows.length > limit || unchecked };
  }

  async customerHistory(
    customerIdentifier: string,
    limit: number,
  ): Promise<{ rows: OrderReference[]; truncated: boolean }> {
    const value = customerIdentifier.trim();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return this.search({ email: value }, limit);
    if (normalizePhone(value).length < 6) {
      throw new Error('customer_identifier musi być pełnym adresem e-mail albo numerem telefonu.');
    }
    return this.search({ phone: value }, limit);
  }

  async close(): Promise<void> {
    await this.api.logout?.();
  }
}
