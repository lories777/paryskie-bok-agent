import type { AppConfig } from './config.js';
import { MasterLinkHttpError } from './masterlink/http-client.js';
import {
  fulfillmentFacts,
  deliveryFacts,
  object,
  orderFacts,
  orderTimestamps,
  paymentFacts,
  returnsFacts,
  shipmentFacts,
  string,
} from './masterlink/facts.js';
import type {
  ConnectorError,
  ConnectorResult,
  MasterLinkApi,
  OrderReference,
  QueryIdentifiers,
  ReadRepository,
  SearchIdentifiers,
  SourceDescriptor,
} from './types.js';

const READ_SOURCE: SourceDescriptor = {
  system: 'MasterLink',
  access: 'read_only_database_and_authenticated_api',
  resources: ['orders', 'order_status_history', 'payments', 'shipments', 'tracking_events', 'returns', 'erp_corrections'],
};

function now(): string {
  return new Date().toISOString();
}

function technicalError(error: unknown): ConnectorError {
  if (error instanceof MasterLinkHttpError) {
    if (error.safeCode === 'timeout') return { code: 'TIMEOUT', message: 'MasterLink nie odpowiedział w limicie czasu.', retryable: true };
    if (error.status === 401 || error.status === 403) return { code: 'AUTH_ERROR', message: 'MasterLink odrzucił dostęp connectora.', retryable: false };
    return { code: 'TECHNICAL_ERROR', message: 'Nie udało się odczytać danych z MasterLinka.', retryable: error.retryable };
  }
  const code = object(error).code;
  if (code === '57014') return { code: 'TIMEOUT', message: 'Zapytanie do MasterLinka przekroczyło limit czasu.', retryable: true };
  if (code === '28P01' || code === '42501') return { code: 'AUTH_ERROR', message: 'Baza MasterLinka odrzuciła dostęp connectora.', retryable: false };
  return { code: 'TECHNICAL_ERROR', message: 'Wystąpił błąd techniczny podczas odczytu MasterLinka.', retryable: true };
}

function emptyTechnical(error: unknown): ConnectorResult<Record<string, never>> {
  return {
    found: null,
    market: null,
    facts: {},
    timestamps: {},
    source: READ_SOURCE,
    checked_at: now(),
    error: technicalError(error),
  };
}

function notFound(identifierType: string): ConnectorResult<Record<string, unknown>> {
  return {
    found: false,
    market: null,
    facts: { identifier_type: identifierType },
    timestamps: {},
    source: READ_SOURCE,
    checked_at: now(),
    error: { code: 'NOT_FOUND', message: 'Nie znaleziono pasujących danych w MasterLinku.', retryable: false },
  };
}

function invalidInput(message: string): ConnectorResult<Record<string, never>> {
  return {
    found: null,
    market: null,
    facts: {},
    timestamps: {},
    source: READ_SOURCE,
    checked_at: now(),
    error: { code: 'INVALID_INPUT', message, retryable: false },
  };
}

function searchSummary(reference: OrderReference): Record<string, unknown> {
  return {
    order_number: reference.orderNumber,
    external_id: reference.externalOrderId,
    market: reference.market,
    status: reference.status,
    payment_status: reference.paymentStatus,
    source_code: reference.sourceCode,
    placed_at: reference.placedAt,
    created_at: reference.createdAt,
    updated_at: reference.updatedAt,
  };
}

export class ConnectorService {
  constructor(
    readonly repository: ReadRepository,
    readonly api: MasterLinkApi,
    readonly config: Pick<AppConfig, 'maxResults'>,
  ) {}

  private async load(orderNumber: string): Promise<{ reference: OrderReference; detail: Record<string, unknown> } | null> {
    const reference = await this.repository.findByOrderNumber(orderNumber.trim());
    if (!reference) return null;
    return { reference, detail: await this.api.getOrderDetail(reference.id) };
  }

  async getOrder(orderNumber: string): Promise<ConnectorResult> {
    try {
      const loaded = await this.load(orderNumber);
      if (!loaded) return notFound('order_number');
      const { detail, reference } = loaded;
      return {
        found: true,
        market: reference.market,
        facts: {
          order: orderFacts(detail, this.config.maxResults),
          payment: paymentFacts(detail),
          fulfillment: fulfillmentFacts(detail),
          shipments: shipmentFacts(detail),
          returns_and_refunds: returnsFacts(detail),
        },
        timestamps: orderTimestamps(detail),
        source: READ_SOURCE,
        checked_at: now(),
        error: null,
      };
    } catch (error) {
      return emptyTechnical(error);
    }
  }

  async searchOrders(identifiers: SearchIdentifiers): Promise<ConnectorResult> {
    if (!Object.values(identifiers).some((value) => typeof value === 'string' && value.trim().length > 0)) {
      return invalidInput('Podaj przynajmniej jeden identyfikator wyszukiwania.');
    }
    try {
      const result = await this.repository.search(identifiers, this.config.maxResults);
      if (result.rows.length === 0) return notFound('search_identifiers');
      const markets = [...new Set(result.rows.map((row) => row.market))];
      return {
        found: true,
        market: markets.length === 1 ? markets[0]! : null,
        facts: {
          orders: result.rows.map(searchSummary),
          result_count: result.rows.length,
          truncated: result.truncated,
          matched_by: Object.keys(identifiers).filter((key) => identifiers[key as keyof SearchIdentifiers] != null),
        },
        timestamps: { newest_match_at: result.rows[0]?.createdAt ?? null },
        source: READ_SOURCE,
        checked_at: now(),
        error: null,
      };
    } catch (error) {
      return emptyTechnical(error);
    }
  }

  async getPayment(orderNumber: string): Promise<ConnectorResult> {
    return this.getSection(orderNumber, 'payment', paymentFacts);
  }

  async getFulfillment(orderNumber: string): Promise<ConnectorResult> {
    return this.getSection(orderNumber, 'fulfillment', fulfillmentFacts);
  }

  async getDeliveryDetails(orderNumber: string): Promise<ConnectorResult> {
    return this.getSection(orderNumber, 'delivery', deliveryFacts);
  }

  async getShipments(orderNumber: string): Promise<ConnectorResult> {
    try {
      const loaded = await this.load(orderNumber);
      if (!loaded) return notFound('order_number');
      const events = new Map<string, unknown[]>();
      const shipments = Array.isArray(loaded.detail.shipments) ? loaded.detail.shipments : [];
      await Promise.all(
        shipments.slice(0, this.config.maxResults).map(async (raw) => {
          const shipmentId = string(object(raw).id);
          if (!shipmentId) return;
          const response = object(await this.api.get(`/api/shipments/${encodeURIComponent(shipmentId)}/tracking-events`));
          const rows = Array.isArray(response.events) ? response.events.slice(0, this.config.maxResults) : [];
          events.set(shipmentId, rows);
        }),
      );
      return {
        found: true,
        market: loaded.reference.market,
        facts: shipmentFacts(loaded.detail, events),
        timestamps: orderTimestamps(loaded.detail),
        source: READ_SOURCE,
        checked_at: now(),
        error: null,
      };
    } catch (error) {
      return emptyTechnical(error);
    }
  }

  async getReturnsAndRefunds(orderNumber: string): Promise<ConnectorResult> {
    return this.getSection(orderNumber, 'returns_and_refunds', returnsFacts);
  }

  private async getSection(
    orderNumber: string,
    section: string,
    mapper: (detail: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<ConnectorResult> {
    try {
      const loaded = await this.load(orderNumber);
      if (!loaded) return notFound('order_number');
      return {
        found: true,
        market: loaded.reference.market,
        facts: { [section]: mapper(loaded.detail) },
        timestamps: orderTimestamps(loaded.detail),
        source: READ_SOURCE,
        checked_at: now(),
        error: null,
      };
    } catch (error) {
      return emptyTechnical(error);
    }
  }

  async getCustomerOrderHistory(customerIdentifier: string): Promise<ConnectorResult> {
    try {
      const result = await this.repository.customerHistory(customerIdentifier, this.config.maxResults);
      if (result.rows.length === 0) return notFound('customer_identifier');
      const markets = [...new Set(result.rows.map((row) => row.market))];
      return {
        found: true,
        market: markets.length === 1 ? markets[0]! : null,
        facts: {
          orders: result.rows.map(searchSummary),
          order_count: result.rows.length,
          truncated: result.truncated,
          customer_identifier_echoed: false,
        },
        timestamps: {
          first_order_at: result.rows.at(-1)?.createdAt ?? null,
          last_order_at: result.rows[0]?.createdAt ?? null,
        },
        source: READ_SOURCE,
        checked_at: now(),
        error: null,
      };
    } catch (error) {
      return emptyTechnical(error);
    }
  }

  async query(_question: string, identifiers: QueryIdentifiers): Promise<ConnectorResult> {
    const present = Object.entries(identifiers).filter(([, value]) => typeof value === 'string' && value.trim().length > 0);
    if (present.length === 0) return invalidInput('ml_query wymaga przynajmniej jednego identyfikatora.');
    if (identifiers.order_number && present.length > 1) {
      return invalidInput('order_number w ml_query musi być jedynym identyfikatorem; dla wielu kryteriów użyj pozostałych pól AND.');
    }
    try {
      let references: OrderReference[];
      let truncated = false;
      if (identifiers.order_number) {
        const reference = await this.repository.findByOrderNumber(identifiers.order_number);
        references = reference ? [reference] : [];
      } else {
        const searched = await this.repository.search(identifiers, this.config.maxResults);
        references = searched.rows;
        truncated = searched.truncated;
      }
      if (references.length === 0) return notFound('query_identifiers');

      const bundles = await Promise.all(
        references.map(async (reference) => {
          const detail = await this.api.getOrderDetail(reference.id);
          return {
            order: orderFacts(detail, this.config.maxResults),
            payment: paymentFacts(detail),
            fulfillment: fulfillmentFacts(detail),
            shipments: shipmentFacts(detail),
            returns_and_refunds: returnsFacts(detail),
            timestamps: orderTimestamps(detail),
          };
        }),
      );
      const markets = [...new Set(references.map((reference) => reference.market))];
      return {
        found: true,
        market: markets.length === 1 ? markets[0]! : null,
        facts: {
          answer_mode: 'source_facts_only',
          question_echoed: false,
          evidence: bundles,
          result_count: bundles.length,
          truncated,
        },
        timestamps: { evidence_checked_at: now() },
        source: READ_SOURCE,
        checked_at: now(),
        error: null,
      };
    } catch (error) {
      return emptyTechnical(error);
    }
  }
}
