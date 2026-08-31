import type { AppConfig } from './config.js';
import { IdempotencyStore, stableHash } from './idempotency.js';
import { MasterLinkHttpError } from './masterlink/http-client.js';
import { array, object, safeBeforeAfter, string } from './masterlink/facts.js';
import type { ConnectorError, ConnectorResult, MasterLinkApi, ReadRepository, SourceDescriptor } from './types.js';

const MUTATION_SOURCE: SourceDescriptor = {
  system: 'MasterLink',
  access: 'authenticated_api_mutation',
  resources: ['orders', 'order_internal_notes', 'returns', 'erp_corrections'],
};

const CANCELLABLE = new Set([
  'imported',
  'paid_or_cod',
  'sent_to_erp',
  'erp_processing',
  'erp_acknowledged',
  'erp_released',
  'to_pack',
  'exception',
  'hold',
  'data_error',
]);
const RETURNABLE = new Set(['shipped', 'delivered', 'partially_returned']);
const DELIVERY_EDITABLE = new Set(['imported', 'paid_or_cod', 'hold', 'exception', 'data_error']);
interface MutationBase {
  order_number: string;
  idempotency_key: string;
  dry_run: boolean;
}

export interface CancelInput extends MutationBase {
  reason: string;
}

export interface AddNoteInput extends MutationBase {
  note: string;
}

export interface StartReturnInput extends MutationBase {
  type: 'full' | 'partial';
  items: Array<{ sku: string; qty: number; unfit_qty?: number | undefined }>;
  reason: 'not_collected' | 'damaged_in_transit' | 'wrong_order' | 'customer_withdrew' | 'quality_complaint' | 'other';
  reason_note?: string | undefined;
  resolution: 'correction' | 'reshipment';
}

export interface CorrectDeliveryInput extends MutationBase {
  reason: string;
  carrier_code?: string | null | undefined;
  pickup_point_id?: string | null | undefined;
  shipping_address?: {
    line1?: string | undefined;
    line2?: string | undefined;
    city?: string | undefined;
    postal_code?: string | undefined;
    country_code?: string | undefined;
  } | undefined;
}

function timestamp(): string {
  return new Date().toISOString();
}

function result(
  found: boolean | null,
  market: string | null,
  facts: Record<string, unknown>,
  error: ConnectorError | null,
): ConnectorResult {
  return { found, market, facts, timestamps: {}, source: MUTATION_SOURCE, checked_at: timestamp(), error };
}

function invalid(
  code: ConnectorError['code'],
  message: string,
  market: string | null = null,
  orderWasFound = market != null,
): ConnectorResult {
  return result(code === 'NOT_FOUND' ? false : orderWasFound ? true : null, market, {}, { code, message, retryable: false });
}

function mutationError(error: unknown, market: string | null): ConnectorResult {
  if (error instanceof MasterLinkHttpError) {
    const conflict = error.status === 409 || error.status === 422;
    return invalid(
      conflict ? 'TRANSITION_NOT_ALLOWED' : error.safeCode === 'timeout' ? 'TIMEOUT' : 'TECHNICAL_ERROR',
      conflict ? 'MasterLink odrzucił mutację z powodu aktualnego stanu lub reguł domenowych.' : 'Mutacja w MasterLinku nie została potwierdzona.',
      market,
    );
  }
  return invalid('TECHNICAL_ERROR', 'Mutacja w MasterLinku nie została potwierdzona.', market);
}

export class MutationService {
  constructor(
    private readonly repository: ReadRepository,
    private readonly api: MasterLinkApi,
    private readonly config: Pick<AppConfig, 'mutationsEnabled'>,
    private readonly idempotency: IdempotencyStore,
  ) {}

  private async load(orderNumber: string) {
    const reference = await this.repository.findByOrderNumber(orderNumber.trim());
    if (!reference) return null;
    return { reference, detail: await this.api.getOrderDetail(reference.id) };
  }

  private async execute(
    tool: string,
    input: MutationBase,
    validateAndPlan: (loaded: NonNullable<Awaited<ReturnType<MutationService['load']>>>) => ConnectorResult | null,
    write: (orderId: string) => Promise<unknown>,
  ): Promise<ConnectorResult> {
    let loaded: NonNullable<Awaited<ReturnType<MutationService['load']>>> | null = null;
    try {
      loaded = await this.load(input.order_number);
      if (!loaded) return invalid('NOT_FOUND', 'Nie znaleziono zamówienia w MasterLinku.');
      const plan = validateAndPlan(loaded);
      if (plan) return plan;

      const requestForHash = { ...input, dry_run: undefined };
      const requestHash = stableHash(requestForHash);
      const existing = this.idempotency.check(input.idempotency_key, tool, requestHash);
      if (existing.state === 'replay') return existing.response as ConnectorResult;
      if (existing.state === 'conflict') {
        return invalid('IDEMPOTENCY_CONFLICT', 'Ten idempotency_key został użyty dla innej operacji.', loaded.reference.market);
      }
      if (existing.state === 'uncertain') {
        return invalid('IDEMPOTENCY_UNCERTAIN', 'Stan poprzedniej próby jest niepewny. Najpierw odczytaj zamówienie i uzgodnij dalszy krok.', loaded.reference.market);
      }

      const before = safeBeforeAfter(loaded.detail);
      if (input.dry_run) {
        return result(true, loaded.reference.market, {
          operation: tool,
          dry_run: true,
          allowed: true,
          before,
          after: { predicted: true, ...this.prediction(tool, loaded.detail, input) },
          write_performed: false,
        }, null);
      }
      if (!this.config.mutationsEnabled) {
        return invalid('MUTATIONS_DISABLED', 'Mutacje są wyłączone w konfiguracji connectora.', loaded.reference.market);
      }
      const reserved = this.idempotency.reserve(existing.keyHash, tool, requestHash);
      if (!reserved) {
        const concurrent = this.idempotency.check(input.idempotency_key, tool, requestHash);
        if (concurrent.state === 'replay') return concurrent.response as ConnectorResult;
        if (concurrent.state === 'conflict') {
          return invalid('IDEMPOTENCY_CONFLICT', 'Ten idempotency_key został równolegle użyty dla innej operacji.', loaded.reference.market);
        }
        return invalid(
          'IDEMPOTENCY_UNCERTAIN',
          'Operacja z tym idempotency_key jest już wykonywana. Nie ponawiaj jej; najpierw odczytaj stan.',
          loaded.reference.market,
        );
      }
      try {
        await write(loaded.reference.id);
        const afterDetail = await this.api.getOrderDetail(loaded.reference.id);
        const completed = result(true, loaded.reference.market, {
          operation: tool,
          dry_run: false,
          allowed: true,
          before,
          after: safeBeforeAfter(afterDetail),
          write_performed: true,
        }, null);
        this.idempotency.complete(existing.keyHash, completed);
        return completed;
      } catch (error) {
        this.idempotency.fail(existing.keyHash);
        if (error instanceof MasterLinkHttpError && (error.status == null || error.safeCode === 'timeout' || error.status >= 500)) {
          return invalid(
            'IDEMPOTENCY_UNCERTAIN',
            'Nie ma potwierdzenia, czy zapis doszedł do MasterLinka. Nie ponawiaj automatycznie; najpierw wykonaj odczyt i uzgodnij dalszy krok.',
            loaded.reference.market,
          );
        }
        return mutationError(error, loaded.reference.market);
      }
    } catch (error) {
      return mutationError(error, loaded?.reference.market ?? null);
    }
  }

  private prediction(tool: string, detail: Record<string, unknown>, input: MutationBase): Record<string, unknown> {
    if (tool === 'ml_cancel_order') return { ...safeBeforeAfter(detail), status: 'cancelled' };
    if (tool === 'ml_add_internal_note') {
      return { ...safeBeforeAfter(detail), internal_note_count: array(detail.internalNotes).length + 1 };
    }
    if (tool === 'ml_start_return') {
      const ret = input as StartReturnInput;
      return {
        ...safeBeforeAfter(detail),
        status: ret.type === 'full' ? 'returned' : 'partially_returned',
        return_count: array(detail.returns).length + 1,
        refund_or_correction: 'validated_and_decided_by_masterlink_on_execution',
      };
    }
    const delivery = input as CorrectDeliveryInput;
    return {
      ...safeBeforeAfter(detail),
      ...(delivery.carrier_code !== undefined ? { carrier_code: delivery.carrier_code } : {}),
      ...(delivery.pickup_point_id !== undefined ? { pickup_point_present: delivery.pickup_point_id != null } : {}),
      ...(delivery.shipping_address ? { shipping_address_present: true } : {}),
    };
  }

  cancel(input: CancelInput): Promise<ConnectorResult> {
    return this.execute(
      'ml_cancel_order',
      input,
      ({ reference, detail }) => {
        const status = string(detail.status) ?? reference.status;
        return CANCELLABLE.has(status)
          ? null
          : invalid('TRANSITION_NOT_ALLOWED', `Anulowanie nie jest dozwolone ze statusu ${status}.`, reference.market);
      },
      (id) => this.api.post(`/api/orders/${encodeURIComponent(id)}/action`, { action: 'cancel', reason: input.reason }),
    );
  }

  addInternalNote(input: AddNoteInput): Promise<ConnectorResult> {
    return this.execute(
      'ml_add_internal_note',
      input,
      () => null,
      (id) => this.api.post(`/api/orders/${encodeURIComponent(id)}/internal-notes`, { text: input.note }),
    );
  }

  startReturn(input: StartReturnInput): Promise<ConnectorResult> {
    return this.execute(
      'ml_start_return',
      input,
      ({ reference, detail }) => {
        const status = string(detail.status) ?? reference.status;
        if (!RETURNABLE.has(status)) {
          return invalid('TRANSITION_NOT_ALLOWED', `Zwrot nie jest dozwolony ze statusu ${status}.`, reference.market);
        }
        const available = new Map(
          array(detail.items).map((raw) => {
            const item = object(raw);
            return [string(item.sku) ?? '', Math.max(0, Number(item.qty ?? 0) - Number(item.alreadyReturnedQty ?? 0))];
          }),
        );
        const invalidItem = input.items.find((item) => item.qty > (available.get(item.sku) ?? 0));
        if (invalidItem) {
          return invalid('TRANSITION_NOT_ALLOWED', `Ilość do zwrotu przekracza dostępną ilość dla SKU ${invalidItem.sku}.`, reference.market);
        }
        const invalidUnfit = input.items.find((item) => item.unfit_qty != null && item.unfit_qty > item.qty);
        if (invalidUnfit) {
          return invalid('INVALID_INPUT', `unfit_qty nie może przekraczać qty dla SKU ${invalidUnfit.sku}.`, reference.market);
        }
        if (input.reason === 'other' && !input.reason_note?.trim()) {
          return invalid('INVALID_INPUT', 'Dla powodu other wymagany jest reason_note.', reference.market);
        }
        if (input.type === 'full') {
          const requested = new Map<string, number>();
          for (const item of input.items) requested.set(item.sku, (requested.get(item.sku) ?? 0) + item.qty);
          const missing = [...available.entries()].find(([sku, qty]) => qty > 0 && requested.get(sku) !== qty);
          if (missing) {
            return invalid('INVALID_INPUT', `Pełny zwrot musi obejmować całą dostępną ilość SKU ${missing[0]}.`, reference.market);
          }
        }
        return null;
      },
      (id) =>
        this.api.post('/api/returns', {
          orderId: id,
          type: input.type,
          items: input.items.map((item) => ({
            sku: item.sku,
            qty: item.qty,
            ...(item.unfit_qty === undefined ? {} : { unfitQty: item.unfit_qty }),
          })),
          reason: input.reason,
          ...(input.reason_note ? { reasonNote: input.reason_note } : {}),
          rozwiazanie: input.resolution === 'correction' ? 'korekta' : 'ponowna_wysylka',
        }),
    );
  }

  correctDeliveryData(input: CorrectDeliveryInput): Promise<ConnectorResult> {
    return this.execute(
      'ml_correct_delivery_data',
      input,
      ({ reference, detail }) => {
        const status = string(detail.status) ?? reference.status;
        if (!DELIVERY_EDITABLE.has(status)) {
          return invalid('TRANSITION_NOT_ALLOWED', `Dane dostawy nie są edytowalne ze statusu ${status}.`, reference.market);
        }
        const changes = [input.carrier_code !== undefined, input.pickup_point_id !== undefined, input.shipping_address != null];
        if (!changes.some(Boolean)) return invalid('INVALID_INPUT', 'Podaj przynajmniej jedno pole danych dostawy.', reference.market);
        if (input.shipping_address && Object.values(input.shipping_address).every((value) => value === undefined)) {
          return invalid('INVALID_INPUT', 'shipping_address musi zawierać przynajmniej jedno pole.', reference.market);
        }
        return null;
      },
      (id) => {
        const address = input.shipping_address;
        return this.api.put(`/api/orders/${encodeURIComponent(id)}`, {
          ...(input.carrier_code !== undefined ? { carrierCode: input.carrier_code } : {}),
          ...(input.pickup_point_id !== undefined ? { pickupPointId: input.pickup_point_id } : {}),
          ...(address
            ? {
                shippingAddress: {
                  ...(address.line1 !== undefined ? { line1: address.line1 } : {}),
                  ...(address.line2 !== undefined ? { line2: address.line2 } : {}),
                  ...(address.city !== undefined ? { city: address.city } : {}),
                  ...(address.postal_code !== undefined ? { postalCode: address.postal_code } : {}),
                  ...(address.country_code !== undefined ? { countryCode: address.country_code.toUpperCase() } : {}),
                },
              }
            : {}),
        });
      },
    );
  }
}
