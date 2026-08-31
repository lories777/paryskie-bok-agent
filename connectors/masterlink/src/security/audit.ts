import { createHmac } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConnectorResult } from '../types.js';

interface AuditRecordInput {
  tool: string;
  args: Record<string, unknown>;
  result: ConnectorResult;
  durationMs: number;
  mutation: boolean;
}

export class AuditLogger {
  private readonly fd: number;

  constructor(
    path: string,
    private readonly hashKey: string,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error('Plik audytu nie może być dowiązaniem symbolicznym.');
    }
    this.fd = openSync(path, 'a', 0o600);
    fchmodSync(this.fd, 0o600);
  }

  hash(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    return createHmac('sha256', this.hashKey).update(value, 'utf8').digest('hex');
  }

  private identifiers(args: Record<string, unknown>): string[] {
    const nested = args.identifiers && typeof args.identifiers === 'object' ? (args.identifiers as Record<string, unknown>) : {};
    const values = [
      args.order_number,
      args.customer_identifier,
      args.email,
      args.phone,
      args.tracking_number,
      args.external_id,
      nested.order_number,
      nested.email,
      nested.phone,
      nested.tracking_number,
      nested.external_id,
    ];
    return [...new Set(values.map((value) => this.hash(value)).filter((value): value is string => value != null))];
  }

  record(input: AuditRecordInput): void {
    const facts = input.result.facts && typeof input.result.facts === 'object'
      ? (input.result.facts as Record<string, unknown>)
      : {};
    const allowedState = (value: unknown): Record<string, unknown> | null => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const state = value as Record<string, unknown>;
      return Object.fromEntries(
        ['status', 'payment_status', 'carrier_code', 'pickup_point_present', 'shipping_address_present', 'return_count', 'internal_note_count', 'updated_at', 'predicted']
          .filter((key) => key in state)
          .map((key) => [key, state[key]]),
      );
    };
    const record = {
      ts: new Date().toISOString(),
      tool: input.tool,
      mode: input.mutation ? (input.args.dry_run === false ? 'mutation' : 'dry_run') : 'read',
      outcome: input.result.error?.code ?? (input.result.found ? 'FOUND' : input.result.found === false ? 'NOT_FOUND' : 'ERROR'),
      duration_ms: Math.max(0, Math.round(input.durationMs)),
      identifier_hashes: this.identifiers(input.args),
      idempotency_key_hash: this.hash(input.args.idempotency_key),
      question_hash: this.hash(input.args.question),
      reason_hash: this.hash(input.args.reason),
      note_hash: this.hash(input.args.note),
      argument_fields: Object.keys(input.args).sort(),
      result_market: input.result.market,
      mutation_result: input.mutation
        ? {
            operation: typeof facts.operation === 'string' ? facts.operation : input.tool,
            write_performed: facts.write_performed === true,
            before: allowedState(facts.before),
            after: allowedState(facts.after),
          }
        : null,
    };
    writeSync(this.fd, `${JSON.stringify(record)}\n`, undefined, 'utf8');
  }

  close(): void {
    closeSync(this.fd);
  }
}
