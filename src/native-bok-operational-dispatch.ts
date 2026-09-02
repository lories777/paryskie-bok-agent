import { createHash } from "node:crypto";
import { z } from "zod";
import {
  nativeOperationalDispatchConfigurationErrors,
  type AppConfig,
} from "./config.js";
import {
  NATIVE_BOK_PROVIDER,
} from "./native-bok-contract.js";
import {
  TICKET_OPERATIONAL_ACTION_CATALOG_SCHEMA_VERSION,
  TICKET_OPERATIONAL_ACTION_DEFINITIONS,
  TICKET_OPERATIONAL_ACTION_TYPES,
  TICKET_TEAM_ESCALATION_ACTION_TYPES,
  TICKET_TEAM_ESCALATION_DESTINATIONS,
  operationalActionCatalogHash,
  type TicketOperationalActionType,
  type TicketTeamEscalationDestination,
} from "./native-bok-operational-catalog.js";
import type { AgentStore } from "./store.js";

export const MAX_NATIVE_OPERATIONAL_DISPATCH_BYTES = 16 * 1024;
export const NATIVE_OPERATIONAL_DISPATCH_SCHEMA_VERSION = 2 as const;

const MARKETS = ["PL", "CZ", "SK", "HU", "RO", "EE", "LT", "DE"] as const;
const PAYMENT_STATUSES = ["paid", "pending", "cod", "cancelled_expired"] as const;
const SAFE_EXTERNAL_TICKET_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,99}$/;
const SAFE_ORDER_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const SAFE_MONEY = /^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$/;
const SAFE_SHA256 = /^[a-f0-9]{64}$/;
const DISCORD_MESSAGE_ID = /^[1-9][0-9]{16,21}$/;

const ticketSchema = z
  .object({
    id: z.string().uuid(),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    externalId: z.string().regex(SAFE_EXTERNAL_TICKET_ID).nullable(),
    market: z.enum(MARKETS),
    url: z.string().url().max(500).nullable(),
  })
  .strict();

const orderSchema = z
  .object({
    id: z.string().uuid(),
    number: z.string().regex(SAFE_ORDER_NUMBER),
    amount: z.string().regex(SAFE_MONEY).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    paymentStatus: z.enum(PAYMENT_STATUSES),
  })
  .strict();

const automationEvidenceSchema = z
  .object({
    kind: z.enum(["customer_transfer_declared", "payment_confirmation_attachment"]),
    inboundMessageId: z.string().uuid(),
  })
  .strict();

export const nativeOperationalActionEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(NATIVE_OPERATIONAL_DISPATCH_SCHEMA_VERSION),
    idempotencyKey: z.string().uuid(),
    requestHash: z.string().regex(SAFE_SHA256),
    actionType: z.enum(TICKET_OPERATIONAL_ACTION_TYPES),
    sourceSuggestionId: z.string().uuid(),
    sourceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ticket: ticketSchema,
    order: orderSchema.nullable(),
    automationEvidence: automationEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((envelope, context) => {
    const definition = TICKET_OPERATIONAL_ACTION_DEFINITIONS[envelope.actionType];
    if (definition.handling !== "team_escalation") {
      context.addIssue({
        code: "custom",
        path: ["actionType"],
        message: "executor_not_native_discord",
      });
    }
    if (definition.orderRequired && envelope.order === null) {
      context.addIssue({ code: "custom", path: ["order"], message: "order_required" });
    }
    if (envelope.actionType !== "finance.verify_payment" && envelope.automationEvidence) {
      context.addIssue({
        code: "custom",
        path: ["automationEvidence"],
        message: "evidence_not_allowed",
      });
    }
    const expectedHash = nativeOperationalActionRequestHash({
      ticketId: envelope.ticket.id,
      sourceRevision: envelope.sourceRevision,
      sourceSuggestionId: envelope.sourceSuggestionId,
      actionType: envelope.actionType,
    });
    if (envelope.requestHash !== expectedHash) {
      context.addIssue({
        code: "custom",
        path: ["requestHash"],
        message: "request_hash_mismatch",
      });
    }
  });

export type NativeOperationalActionEnvelope = z.infer<
  typeof nativeOperationalActionEnvelopeSchema
>;

export interface NativeOperationalActionDispatchResult {
  idempotencyKey: string;
  status: "sent" | "pending";
  destination: TicketTeamEscalationDestination;
  externalReference: string | null;
  deduplicated: boolean;
}

export interface NativeOperationalActionDispatchRuntimeStatus {
  schemaVersion: 2;
  provider: typeof NATIVE_BOK_PROVIDER;
  enabled: boolean;
  configurationReady: boolean;
  identityVerified: boolean;
  ready: boolean;
  kinds: ["team_escalation"];
  actionTypes: TicketOperationalActionType[];
  routeKeys: TicketTeamEscalationDestination[];
  delivery: "discord-gateway";
  receipt: "shared-agent-store";
}

export type OperationalActionProofResult =
  | { status: "found"; externalReference: string }
  | { status: "missing" }
  | { status: "conflict" };

export interface NativeOperationalDiscordPort {
  verifyOperationalActionRoutes(): Promise<void>;
  operationalActionIdentityVerified(): boolean;
  operationalActionReady(): boolean;
  operationalActionRouteIdentity(destination: TicketTeamEscalationDestination): string | null;
  findOperationalActionProof(input: {
    destination: TicketTeamEscalationDestination;
    proof: string;
    expectedContent: string;
  }): Promise<OperationalActionProofResult>;
  sendOperationalAction(input: {
    destination: TicketTeamEscalationDestination;
    content: string;
    nonce: string;
  }): Promise<string>;
}

export class NativeOperationalActionDispatchError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "capability_unavailable"
      | "request_invalid"
      | "idempotency_conflict"
      | "proof_conflict",
  ) {
    super(code);
    this.name = "NativeOperationalActionDispatchError";
  }
}

export interface NativeOperationalActionDispatcherOptions {
  retryAfterMs?: number;
  now?: () => number;
}

export interface NativeOperationalActionSendGuard {
  /**
   * Ostatni zewnętrzny fence wykonywany po reconciliation i bezpośrednio
   * przed nieodwracalnym POST-em do Discorda.
   */
  beforeIrreversibleSend(): Promise<void>;
}

export class NativeOperationalActionDispatcher {
  private readonly retryAfterMs: number;
  private readonly now: () => number;

  constructor(
    private readonly config: AppConfig,
    private readonly store: AgentStore,
    private readonly discord: NativeOperationalDiscordPort,
    options: NativeOperationalActionDispatcherOptions = {},
  ) {
    this.retryAfterMs = options.retryAfterMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    if (!this.config.nativeOperationalDispatchEnabled) return;
    if (nativeOperationalDispatchConfigurationErrors(this.config).length > 0) {
      throw new NativeOperationalActionDispatchError(503, "capability_unavailable");
    }
    await this.discord.verifyOperationalActionRoutes();
    if (!this.discord.operationalActionIdentityVerified()) {
      throw new NativeOperationalActionDispatchError(503, "capability_unavailable");
    }
  }

  runtimeStatus(): NativeOperationalActionDispatchRuntimeStatus {
    const enabled = this.config.nativeOperationalDispatchEnabled;
    const configurationReady = nativeOperationalDispatchConfigurationErrors(this.config).length === 0;
    const identityVerified =
      enabled &&
      configurationReady &&
      this.discord.operationalActionIdentityVerified() &&
      this.discord.operationalActionReady();
    return {
      schemaVersion: NATIVE_OPERATIONAL_DISPATCH_SCHEMA_VERSION,
      provider: NATIVE_BOK_PROVIDER,
      enabled,
      configurationReady,
      identityVerified,
      ready: enabled && configurationReady && identityVerified,
      kinds: ["team_escalation"],
      actionTypes: [...TICKET_TEAM_ESCALATION_ACTION_TYPES],
      routeKeys: [...TICKET_TEAM_ESCALATION_DESTINATIONS],
      delivery: "discord-gateway",
      receipt: "shared-agent-store",
    };
  }

  async dispatch(
    untrustedEnvelope: unknown,
    sendGuard?: NativeOperationalActionSendGuard,
  ): Promise<NativeOperationalActionDispatchResult> {
    if (!this.runtimeStatus().ready) {
      throw new NativeOperationalActionDispatchError(503, "capability_unavailable");
    }
    const parsed = nativeOperationalActionEnvelopeSchema.safeParse(untrustedEnvelope);
    if (!parsed.success) {
      throw new NativeOperationalActionDispatchError(400, "request_invalid");
    }
    const envelope = parsed.data;
    const definition = TICKET_OPERATIONAL_ACTION_DEFINITIONS[envelope.actionType];
    if (definition.handling !== "team_escalation") {
      throw new NativeOperationalActionDispatchError(400, "request_invalid");
    }
    const destination = definition.destination as TicketTeamEscalationDestination;
    const routeIdentity = this.discord.operationalActionRouteIdentity(destination);
    if (!routeIdentity || !SAFE_SHA256.test(routeIdentity)) {
      throw new NativeOperationalActionDispatchError(503, "capability_unavailable");
    }
    const payloadHash = sha256(JSON.stringify(envelope));
    const proof = nativeOperationalActionProof(envelope);
    const content = renderNativeOperationalAction(envelope, proof);
    const reservation = this.store.reserveOperationalActionDispatch({
      idempotencyKey: envelope.idempotencyKey,
      requestHash: envelope.requestHash,
      payloadHash,
      actionType: envelope.actionType,
      destination,
      routeIdentity,
    });
    if (reservation.status === "conflict") {
      throw new NativeOperationalActionDispatchError(409, "idempotency_conflict");
    }
    if (reservation.record.status === "sent") {
      return sentResult(envelope.idempotencyKey, destination, reservation.record.externalReference, true);
    }

    if (reservation.status === "existing") {
      const reconciled = await this.reconcile(destination, proof, content, envelope, payloadHash);
      if (reconciled) return reconciled;
      const retryBefore = new Date(this.now() - this.retryAfterMs).toISOString();
      const claimed = this.store.claimOperationalActionDispatchRetry({
        idempotencyKey: envelope.idempotencyKey,
        payloadHash,
        retryBefore,
      });
      if (!claimed) return pendingResult(envelope.idempotencyKey, destination, true);
    }

    return this.sendAndRecord(
      envelope,
      destination,
      proof,
      content,
      payloadHash,
      reservation.status !== "created",
      sendGuard,
    );
  }

  private async reconcile(
    destination: TicketTeamEscalationDestination,
    proof: string,
    content: string,
    envelope: NativeOperationalActionEnvelope,
    payloadHash: string,
  ): Promise<NativeOperationalActionDispatchResult | null> {
    let proofResult: OperationalActionProofResult;
    try {
      proofResult = await this.discord.findOperationalActionProof({
        destination,
        proof,
        expectedContent: content,
      });
    } catch {
      // Niepewny readback nigdy nie otwiera ponownej wysyłki.
      return pendingResult(envelope.idempotencyKey, destination, true);
    }
    if (proofResult.status === "conflict") {
      throw new NativeOperationalActionDispatchError(409, "proof_conflict");
    }
    if (proofResult.status === "missing") return null;
    if (!DISCORD_MESSAGE_ID.test(proofResult.externalReference)) {
      throw new NativeOperationalActionDispatchError(409, "proof_conflict");
    }
    this.store.completeOperationalActionDispatch({
      idempotencyKey: envelope.idempotencyKey,
      payloadHash,
      externalReference: proofResult.externalReference,
    });
    return sentResult(
      envelope.idempotencyKey,
      destination,
      proofResult.externalReference,
      true,
    );
  }

  private async sendAndRecord(
    envelope: NativeOperationalActionEnvelope,
    destination: TicketTeamEscalationDestination,
    proof: string,
    content: string,
    payloadHash: string,
    deduplicated: boolean,
    sendGuard?: NativeOperationalActionSendGuard,
  ): Promise<NativeOperationalActionDispatchResult> {
    // Nie wolno zamieniać odmowy guarda w `pending`: jeszcze nic nie zostało
    // wysłane, więc reconciliation nie jest potrzebne i mogłoby ukryć utratę lease.
    await sendGuard?.beforeIrreversibleSend();
    try {
      const externalReference = await this.discord.sendOperationalAction({
        destination,
        content,
        nonce: nativeOperationalActionNonce(envelope.idempotencyKey),
      });
      if (!DISCORD_MESSAGE_ID.test(externalReference)) {
        throw new Error("discord_reference_invalid");
      }
      this.store.completeOperationalActionDispatch({
        idempotencyKey: envelope.idempotencyKey,
        payloadHash,
        externalReference,
      });
      return sentResult(envelope.idempotencyKey, destination, externalReference, deduplicated);
    } catch {
      // POST do Discorda mógł zostać przyjęty przed błędem transportu lub zapisu SQLite.
      // Najpierw dokładny readback; brak lub awaria readbacku oznacza pending, nigdy ślepy resend.
      const reconciled = await this.reconcile(destination, proof, content, envelope, payloadHash);
      return reconciled ?? pendingResult(envelope.idempotencyKey, destination, deduplicated);
    }
  }
}

export function nativeOperationalActionRequestHash(input: {
  ticketId: string;
  sourceRevision: number;
  sourceSuggestionId: string;
  actionType: TicketOperationalActionType;
}): string {
  const identity = input.actionType === "finance.verify_payment"
    ? {
        ticketId: input.ticketId,
        expectedRevision: input.sourceRevision,
        sourceSuggestionId: input.sourceSuggestionId,
        kind: "finance",
        operation: "verify_payment",
      }
    : {
        ticketId: input.ticketId,
        expectedRevision: input.sourceRevision,
        sourceSuggestionId: input.sourceSuggestionId,
        actionType: input.actionType,
      };
  return sha256(JSON.stringify(identity));
}

export function nativeOperationalActionProof(
  envelope: Pick<NativeOperationalActionEnvelope, "idempotencyKey" | "requestHash">,
): string {
  return `ML-BOK-ACTION:${envelope.idempotencyKey}:${envelope.requestHash}`;
}

export function nativeOperationalActionNonce(idempotencyKey: string): string {
  return `mlbok-${sha256(idempotencyKey).slice(0, 19)}`;
}

export function renderNativeOperationalAction(
  envelope: NativeOperationalActionEnvelope,
  proof = nativeOperationalActionProof(envelope),
): string {
  const definition = TICKET_OPERATIONAL_ACTION_DEFINITIONS[envelope.actionType];
  const ticketLabel = envelope.ticket.externalId ?? String(envelope.ticket.number);
  const lines = [
    `🔔 **${definition.label}**`,
    `**Ticket:** \`${ticketLabel}\` · ${envelope.ticket.market}`,
  ];
  if (envelope.order) {
    lines.push(`**Zamówienie:** \`${envelope.order.number}\``);
    if (envelope.order.amount && envelope.order.currency) {
      lines.push(`**Kwota:** ${envelope.order.amount} ${envelope.order.currency}`);
    }
    lines.push(`**Płatność:** ${paymentStatusLabel(envelope.order.paymentStatus)}`);
  }
  if (envelope.automationEvidence) {
    lines.push(`**Sygnał płatności:** ${automationEvidenceLabel(envelope.automationEvidence.kind)}`);
  }
  lines.push(`**Źródło:** MasterLink · rewizja ${envelope.sourceRevision}`);
  if (envelope.ticket.url) lines.push(`**Sprawa:** <${envelope.ticket.url}>`);
  lines.push(`-# ||${proof}||`);
  const rendered = lines.join("\n");
  if (rendered.length > 2_000) throw new Error("operational_dispatch_message_too_large");
  return rendered;
}

function paymentStatusLabel(status: "paid" | "pending" | "cod" | "cancelled_expired"): string {
  return {
    paid: "opłacone",
    pending: "oczekuje na płatność",
    cod: "pobranie",
    cancelled_expired: "płatność wygasła",
  }[status];
}

function automationEvidenceLabel(
  kind: "customer_transfer_declared" | "payment_confirmation_attachment",
): string {
  return kind === "payment_confirmation_attachment"
    ? "załącznik z potwierdzeniem"
    : "klient deklaruje wykonanie przelewu";
}

function sentResult(
  idempotencyKey: string,
  destination: TicketTeamEscalationDestination,
  externalReference: string | null,
  deduplicated: boolean,
): NativeOperationalActionDispatchResult {
  if (!externalReference || !DISCORD_MESSAGE_ID.test(externalReference)) {
    throw new NativeOperationalActionDispatchError(409, "proof_conflict");
  }
  return {
    idempotencyKey,
    status: "sent",
    destination,
    externalReference,
    deduplicated,
  };
}

function pendingResult(
  idempotencyKey: string,
  destination: TicketTeamEscalationDestination,
  deduplicated: boolean,
): NativeOperationalActionDispatchResult {
  return {
    idempotencyKey,
    status: "pending",
    destination,
    externalReference: null,
    deduplicated,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function nativeOperationalActionCatalogIdentity() {
  return {
    schemaVersion: TICKET_OPERATIONAL_ACTION_CATALOG_SCHEMA_VERSION,
    hash: operationalActionCatalogHash(),
  } as const;
}
