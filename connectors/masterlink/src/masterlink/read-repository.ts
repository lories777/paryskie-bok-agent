import pg from 'pg';
import type { AppConfig } from '../config.js';
import type { OrderReference, ReadRepository, SearchIdentifiers } from '../types.js';

const { Pool } = pg;

interface OrderRow {
  id: string;
  order_number: string;
  external_order_id: string;
  market: string;
  status: string;
  payment_status: string | null;
  source_code: string | null;
  placed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  return new Date(value).toISOString();
}

function mapRow(row: OrderRow): OrderReference {
  return {
    id: row.id,
    orderNumber: row.order_number,
    externalOrderId: row.external_order_id,
    market: row.market,
    status: row.status,
    paymentStatus: row.payment_status,
    sourceCode: row.source_code,
    placedAt: iso(row.placed_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, '');
}

const SELECT_COLUMNS = `
  SELECT DISTINCT
    o.id,
    o.order_number,
    o.external_order_id,
    o.market,
    o.status,
    o.payment_status,
    src.code AS source_code,
    o.placed_at,
    o.created_at,
    o.updated_at
  FROM orders o
  LEFT JOIN sources src ON src.id = o.source_id
`;

/**
 * Minimalna warstwa SQL. Każde zapytanie jest stałe i parametryzowane; użytkownik MCP
 * nigdy nie przekazuje SQL-a, nazw kolumn ani operatorów.
 */
export class PostgresReadRepository implements ReadRepository {
  private readonly pool: pg.Pool;
  private readonly timeoutMs: number;

  constructor(config: Pick<AppConfig, 'databaseUrl' | 'databaseSsl' | 'databaseSslCa' | 'timeoutMs'>) {
    this.timeoutMs = config.timeoutMs;
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: config.timeoutMs,
      application_name: 'paryskie-bok-masterlink-mcp-ro',
      ssl: config.databaseSsl
        ? {
            rejectUnauthorized: true,
            ...(config.databaseSslCa ? { ca: config.databaseSslCa } : {}),
          }
        : false,
    });
    this.pool.on('connect', (client) => {
      void client.query('SET default_transaction_read_only = on');
    });
  }

  private async read<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '${this.timeoutMs}ms'`);
      const result = await client.query<T>(text, values);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.read('SELECT 1 AS ok');
  }

  async findByOrderNumber(orderNumber: string): Promise<OrderReference | null> {
    const rows = await this.read<OrderRow>(
      `${SELECT_COLUMNS}
       WHERE lower(o.order_number) = lower($1)
       ORDER BY o.created_at DESC
       LIMIT 2`,
      [orderNumber.trim()],
    );
    if (rows.length > 1) throw new Error('Niejednoznaczny numer zamówienia w MasterLinku.');
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async search(
    identifiers: SearchIdentifiers,
    limit: number,
  ): Promise<{ rows: OrderReference[]; truncated: boolean }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (condition: string, value: string): void => {
      values.push(value);
      conditions.push(condition.replace('$?', `$${values.length}`));
    };

    if (identifiers.email) add('lower(o.customer_email) = lower($?)', identifiers.email.trim());
    if (identifiers.phone) {
      const phone = normalizePhone(identifiers.phone);
      if (!phone) throw new Error('Telefon nie zawiera cyfr.');
      add("regexp_replace(coalesce(o.customer_phone, ''), '[^0-9]', '', 'g') = $?", phone);
    }
    if (identifiers.tracking_number) {
      add(
        `(o.tracking_number = $? OR EXISTS (
          SELECT 1 FROM shipments sh
          WHERE sh.order_id = o.id AND sh.tracking_number = $${values.length + 1}
        ))`,
        identifiers.tracking_number.trim(),
      );
    }
    if (identifiers.external_id) add('lower(o.external_order_id) = lower($?)', identifiers.external_id.trim());
    if (conditions.length === 0) throw new Error('Podaj przynajmniej jeden identyfikator.');

    const rows = await this.read<OrderRow>(
      `${SELECT_COLUMNS}
       WHERE ${conditions.join(' AND ')}
       ORDER BY o.created_at DESC
       LIMIT $${values.length + 1}`,
      [...values, limit + 1],
    );
    return { rows: rows.slice(0, limit).map(mapRow), truncated: rows.length > limit };
  }

  async customerHistory(
    customerIdentifier: string,
    limit: number,
  ): Promise<{ rows: OrderReference[]; truncated: boolean }> {
    const value = customerIdentifier.trim();
    let identifiers: SearchIdentifiers;
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      identifiers = { email: value };
    } else {
      const phone = normalizePhone(value);
      if (phone.length < 6) {
        throw new Error('customer_identifier musi być pełnym adresem e-mail albo numerem telefonu.');
      }
      identifiers = { phone: value };
    }
    return this.search(identifiers, limit);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
