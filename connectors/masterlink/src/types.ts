export type FoundState = boolean | null;

export interface ConnectorError {
  code:
    | 'NOT_FOUND'
    | 'MISSING_DATA'
    | 'INVALID_INPUT'
    | 'TECHNICAL_ERROR'
    | 'TIMEOUT'
    | 'AUTH_ERROR'
    | 'MUTATIONS_DISABLED'
    | 'TRANSITION_NOT_ALLOWED'
    | 'IDEMPOTENCY_CONFLICT'
    | 'IDEMPOTENCY_UNCERTAIN';
  message: string;
  retryable: boolean;
}

export interface SourceDescriptor {
  system: 'MasterLink';
  access: 'read_only_database_and_authenticated_api' | 'authenticated_api_mutation';
  resources: string[];
}

export interface ConnectorResult<TFacts = unknown, TTimestamps = Record<string, unknown>> {
  found: FoundState;
  market: string | null;
  facts: TFacts;
  timestamps: TTimestamps;
  source: SourceDescriptor;
  checked_at: string;
  error: ConnectorError | null;
}

export interface OrderReference {
  id: string;
  orderNumber: string;
  externalOrderId: string;
  market: string;
  status: string;
  paymentStatus: string | null;
  sourceCode: string | null;
  placedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchIdentifiers {
  email?: string | undefined;
  phone?: string | undefined;
  tracking_number?: string | undefined;
  external_id?: string | undefined;
}

export interface QueryIdentifiers extends SearchIdentifiers {
  order_number?: string | undefined;
}

export interface ReadRepository {
  ping(): Promise<void>;
  findByOrderNumber(orderNumber: string): Promise<OrderReference | null>;
  search(identifiers: SearchIdentifiers, limit: number): Promise<{ rows: OrderReference[]; truncated: boolean }>;
  customerHistory(customerIdentifier: string, limit: number): Promise<{ rows: OrderReference[]; truncated: boolean }>;
  close(): Promise<void>;
}

export interface MasterLinkApi {
  ping(): Promise<void>;
  getOrderDetail(id: string): Promise<Record<string, unknown>>;
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
}
