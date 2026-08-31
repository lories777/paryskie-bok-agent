import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuditLogger } from './security/audit.js';
import type { ConnectorService } from './service.js';
import type { MutationService } from './mutations.js';
import type { ConnectorResult } from './types.js';

const orderNumberSchema = z.string().trim().min(1).max(128).describe('Dokładny numer zamówienia z MasterLinka/sklepu.');
const idempotencySchema = z.string().trim().min(12).max(128).describe('Unikalny klucz tej intencji biznesowej; ponowienie musi użyć tego samego klucza.');
const dryRunSchema = z.boolean().default(true).describe('Domyślnie true. false może wykonać zapis tylko po przejściu wszystkich bramek.');

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutationAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

function response(result: ConnectorResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: result.error != null && result.error.code !== 'NOT_FOUND' && result.error.code !== 'MISSING_DATA',
  };
}

export function buildMcpServer(
  reads: ConnectorService,
  mutations: MutationService,
  audit: AuditLogger,
): McpServer {
  const server = new McpServer(
    { name: 'paryskie-bok-masterlink', version: '1.0.0' },
    {
      instructions:
        'Narzędzia odczytu działają autonomicznie. Dla jednoznacznej, uzasadnionej operacji BOK wykonaj najpierw tę samą mutację z dry_run=true, a po poprawnej walidacji samodzielnie z dry_run=false i unikalnym idempotency_key. Po zapisie ponownie odczytaj rekord i potwierdź stan. Pytaj BOK tylko przy niejednoznacznym zamiarze, wyjątku od polityki lub istotnym ryzyku. Wyniki są faktami z MasterLinka: nie uzupełniaj braków przypuszczeniami. found=false oznacza NOT_FOUND, found=null błąd techniczny, a null w facts brak danych.',
    },
  );

  const invoke = async (
    tool: string,
    args: Record<string, unknown>,
    mutation: boolean,
    handler: () => Promise<ConnectorResult>,
  ) => {
    const started = performance.now();
    let result: ConnectorResult;
    try {
      result = await handler();
    } catch {
      result = {
        found: null,
        market: null,
        facts: {},
        timestamps: {},
        source: {
          system: 'MasterLink',
          access: mutation ? 'authenticated_api_mutation' : 'read_only_database_and_authenticated_api',
          resources: [],
        },
        checked_at: new Date().toISOString(),
        error: { code: 'TECHNICAL_ERROR', message: 'Nieobsłużony błąd connectora.', retryable: true },
      };
    }
    audit.record({ tool, args, result, durationMs: performance.now() - started, mutation });
    return response(result);
  };

  server.registerTool(
    'ml_get_order',
    {
      title: 'MasterLink: zamówienie',
      description: 'Zwraca bezpieczny, aktualny zestaw faktów o dokładnym numerze zamówienia. Bez surowych danych osobowych.',
      inputSchema: { order_number: orderNumberSchema },
      annotations: readAnnotations,
    },
    ({ order_number }) => invoke('ml_get_order', { order_number }, false, () => reads.getOrder(order_number)),
  );

  server.registerTool(
    'ml_search_orders',
    {
      title: 'MasterLink: wyszukaj zamówienia',
      description: 'Dokładne wyszukiwanie AND po e-mailu, telefonie, numerze śledzenia lub external ID. Co najmniej jeden identyfikator.',
      inputSchema: {
        email: z.string().trim().email().max(256).optional(),
        phone: z.string().trim().min(6).max(64).optional(),
        tracking_number: z.string().trim().min(1).max(128).optional(),
        external_id: z.string().trim().min(1).max(256).optional(),
      },
      annotations: readAnnotations,
    },
    (args) => invoke('ml_search_orders', args, false, () => reads.searchOrders(args)),
  );

  server.registerTool(
    'ml_get_payment',
    {
      title: 'MasterLink: płatność',
      description: 'Zwraca wyłącznie fakty o płatności, COD, refundacjach i korektach dla zamówienia.',
      inputSchema: { order_number: orderNumberSchema },
      annotations: readAnnotations,
    },
    ({ order_number }) => invoke('ml_get_payment', { order_number }, false, () => reads.getPayment(order_number)),
  );

  server.registerTool(
    'ml_get_fulfillment',
    {
      title: 'MasterLink: realizacja',
      description: 'Zwraca status realizacji, blokady, dokumenty ERP, kompletację i pakowanie.',
      inputSchema: { order_number: orderNumberSchema },
      annotations: readAnnotations,
    },
    ({ order_number }) => invoke('ml_get_fulfillment', { order_number }, false, () => reads.getFulfillment(order_number)),
  );

  server.registerTool(
    'ml_get_delivery_details',
    {
      title: 'MasterLink: dane dostawy',
      description: 'Zwraca zapisany punkt odbioru albo adres dostawy dla aktywnej sprawy BOK. Dane są wrażliwe: użyj ich tylko do rozwiązania ticketu i nie publikuj na Discordzie.',
      inputSchema: { order_number: orderNumberSchema },
      annotations: readAnnotations,
    },
    ({ order_number }) => invoke('ml_get_delivery_details', { order_number }, false, () => reads.getDeliveryDetails(order_number)),
  );

  server.registerTool(
    'ml_get_shipments',
    {
      title: 'MasterLink: przesyłki',
      description: 'Zwraca wszystkie przesyłki, numery trackingowe, statusy i ograniczoną historię skanów kurierskich.',
      inputSchema: { order_number: orderNumberSchema },
      annotations: readAnnotations,
    },
    ({ order_number }) => invoke('ml_get_shipments', { order_number }, false, () => reads.getShipments(order_number)),
  );

  server.registerTool(
    'ml_get_returns_and_refunds',
    {
      title: 'MasterLink: zwroty i refundacje',
      description: 'Zwraca zwroty, ich pozycje, status refundacji i korekty ERP. Nie zwraca treści notatek zawierających PII.',
      inputSchema: { order_number: orderNumberSchema },
      annotations: readAnnotations,
    },
    ({ order_number }) => invoke('ml_get_returns_and_refunds', { order_number }, false, () => reads.getReturnsAndRefunds(order_number)),
  );

  server.registerTool(
    'ml_get_customer_order_history',
    {
      title: 'MasterLink: historia zamówień klienta',
      description: 'Dokładna historia po pełnym e-mailu albo telefonie. Identyfikator nie jest zwracany w wyniku ani audycie.',
      inputSchema: { customer_identifier: z.string().trim().min(6).max(256) },
      annotations: readAnnotations,
    },
    ({ customer_identifier }) =>
      invoke('ml_get_customer_order_history', { customer_identifier }, false, () => reads.getCustomerOrderHistory(customer_identifier)),
  );

  const queryIdentifiers = z.object({
    order_number: orderNumberSchema.optional(),
    email: z.string().trim().email().max(256).optional(),
    phone: z.string().trim().min(6).max(64).optional(),
    tracking_number: z.string().trim().min(1).max(128).optional(),
    external_id: z.string().trim().min(1).max(256).optional(),
  });
  server.registerTool(
    'ml_query',
    {
      title: 'MasterLink: ogólny odczyt',
      description: 'Ogólny, nadal deterministyczny odczyt dla nietypowego pytania. Zwraca paczki dowodowe, nie generuje odpowiedzi ani SQL. Wymaga identyfikatora.',
      inputSchema: {
        question: z.string().trim().min(3).max(500),
        identifiers: queryIdentifiers,
      },
      annotations: readAnnotations,
    },
    ({ question, identifiers }) => invoke('ml_query', { question, identifiers }, false, () => reads.query(question, identifiers)),
  );

  server.registerTool(
    'ml_cancel_order',
    {
      title: 'MasterLink: anuluj zamówienie',
      description: 'Wąska mutacja anulowania. Zawsze zacznij od dry_run=true. dry_run=false wymaga włączonych mutacji i unikalnego idempotency_key.',
      inputSchema: {
        order_number: orderNumberSchema,
        reason: z.string().trim().min(3).max(500),
        idempotency_key: idempotencySchema,
        dry_run: dryRunSchema,
      },
      annotations: mutationAnnotations,
    },
    (args) => invoke('ml_cancel_order', args, true, () => mutations.cancel(args)),
  );

  server.registerTool(
    'ml_add_internal_note',
    {
      title: 'MasterLink: dodaj notatkę wewnętrzną',
      description: 'Wąska mutacja dodania notatki wewnętrznej. Treść nie trafia do logu connectora. Wykonanie wymaga idempotencji.',
      inputSchema: {
        order_number: orderNumberSchema,
        note: z.string().trim().min(1).max(4000),
        idempotency_key: idempotencySchema,
        dry_run: dryRunSchema,
      },
      annotations: { ...mutationAnnotations, destructiveHint: false },
    },
    (args) => invoke('ml_add_internal_note', args, true, () => mutations.addInternalNote(args)),
  );

  const returnReasons = ['not_collected', 'damaged_in_transit', 'wrong_order', 'customer_withdrew', 'quality_complaint', 'other'] as const;
  server.registerTool(
    'ml_start_return',
    {
      title: 'MasterLink: rozpocznij zwrot/refundację',
      description: 'Wąska mutacja rejestracji zwrotu. MasterLink sam waliduje ilości i decyduje o korekcie/refundacji. Najpierw dry-run.',
      inputSchema: {
        order_number: orderNumberSchema,
        type: z.enum(['full', 'partial']),
        items: z.array(z.object({
          sku: z.string().trim().min(1).max(64),
          qty: z.number().int().min(1).max(10_000),
          unfit_qty: z.number().int().min(0).max(10_000).optional(),
        })).min(1).max(100),
        reason: z.enum(returnReasons),
        reason_note: z.string().trim().max(1000).optional(),
        resolution: z.enum(['correction', 'reshipment']),
        idempotency_key: idempotencySchema,
        dry_run: dryRunSchema,
      },
      annotations: mutationAnnotations,
    },
    (args) => invoke('ml_start_return', args, true, () => mutations.startReturn(args)),
  );

  server.registerTool(
    'ml_correct_delivery_data',
    {
      title: 'MasterLink: skoryguj dane dostawy',
      description: 'Wąska korekta kuriera, punktu odbioru lub adresu dostawy przed pakowaniem. Nie edytuje pozycji, cen, płatności ani statusu.',
      inputSchema: {
        order_number: orderNumberSchema,
        reason: z.string().trim().min(3).max(500),
        carrier_code: z.string().trim().min(1).max(32).nullable().optional(),
        pickup_point_id: z.string().trim().min(1).max(64).nullable().optional(),
        shipping_address: z.object({
          line1: z.string().trim().min(1).max(256).optional(),
          line2: z.string().trim().max(256).optional(),
          city: z.string().trim().min(1).max(128).optional(),
          postal_code: z.string().trim().min(1).max(32).optional(),
          country_code: z.string().trim().length(2).optional(),
        }).optional(),
        idempotency_key: idempotencySchema,
        dry_run: dryRunSchema,
      },
      annotations: mutationAnnotations,
    },
    (args) => invoke('ml_correct_delivery_data', args, true, () => mutations.correctDeliveryData(args)),
  );

  return server;
}
