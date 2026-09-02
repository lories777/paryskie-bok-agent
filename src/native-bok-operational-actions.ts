import { createHash } from "node:crypto";
import { z } from "zod";
import { TICKET_AI_INTENTS } from "./native-bok-knowledge.js";

const SAFE_FACT_KEY = /^[a-z][a-z0-9_.-]{0,99}$/;

/** Closed MasterLink PR #613 catalogue. The model never supplies routing metadata. */
export const TICKET_OPERATIONAL_ACTION_TYPES = [
  "finance.verify_payment",
  "finance.assign_payment",
  "finance.refund",
  "finance.reconcile",
  "allegro.reply_discussion",
  "allegro.protect_deadline",
  "complaint.replace_product",
  "complaint.reship",
  "complaint.resolve_missing",
  "complaint.resolve_damaged",
  "fulfillment.release",
  "fulfillment.locate",
  "fulfillment.correct",
  "returns.register_received",
  "returns.handle_unclaimed",
  "order.cancel",
  "order.stop",
  "erp.correct",
  "wholesale.review",
  "upsell.add_item",
  "promo.freebie",
  "catalog.originals",
  "privacy.unsubscribe",
  "marketing.creator_partnership",
  "policy.gap",
  "runtime.bad_draft",
] as const;

export type TicketOperationalActionType = (typeof TICKET_OPERATIONAL_ACTION_TYPES)[number];
export type TicketAiIntent = (typeof TICKET_AI_INTENTS)[number];

export const TICKET_AI_OPERATIONAL_ACTION_DECISION_REASONS = [
  "facts_verified",
  "intent_match",
  "missing_fact",
  "intent_mismatch",
  "unsafe_action",
  "unsupported",
] as const;

export type TicketOperationalActionHandling = "masterlink" | "team_escalation";
export const TICKET_OPERATIONAL_ACTION_CATALOG_SCHEMA_VERSION = 2 as const;

interface TicketOperationalActionDefinition {
  readonly actionType: TicketOperationalActionType;
  readonly label: string;
  readonly handling: TicketOperationalActionHandling;
  readonly destination: string;
  readonly orderRequired: boolean;
  readonly allowedAiIntents: readonly TicketAiIntent[];
}

export const TICKET_OPERATIONAL_ACTION_DEFINITIONS = {
  "finance.verify_payment": {
    actionType: "finance.verify_payment",
    label: "Zweryfikuj wpływ płatności",
    handling: "team_escalation",
    destination: "payments",
    orderRequired: true,
    allowedAiIntents: ["payment_status"],
  },
  "finance.assign_payment": {
    actionType: "finance.assign_payment",
    label: "Przypisz wpłatę do zamówienia",
    handling: "masterlink",
    destination: "masterlink",
    orderRequired: true,
    allowedAiIntents: ["payment_status"],
  },
  "finance.refund": {
    actionType: "finance.refund",
    label: "Zleć zwrot środków",
    handling: "team_escalation",
    destination: "payments",
    orderRequired: true,
    allowedAiIntents: ["refund"],
  },
  "finance.reconcile": {
    actionType: "finance.reconcile",
    label: "Uzgodnij rozliczenie płatności",
    handling: "team_escalation",
    destination: "payments",
    orderRequired: true,
    allowedAiIntents: ["payment_status", "refund"],
  },
  "allegro.reply_discussion": {
    actionType: "allegro.reply_discussion",
    label: "Obsłuż Dyskusję Allegro",
    handling: "team_escalation",
    destination: "allegro",
    orderRequired: true,
    allowedAiIntents: ["order_status", "delivery_status", "complaint", "other"],
  },
  "allegro.protect_deadline": {
    actionType: "allegro.protect_deadline",
    label: "Zabezpiecz termin Allegro",
    handling: "team_escalation",
    destination: "allegro",
    orderRequired: true,
    allowedAiIntents: ["order_status", "delivery_status", "complaint", "other"],
  },
  "complaint.replace_product": {
    actionType: "complaint.replace_product",
    label: "Utwórz wymianę produktu",
    handling: "masterlink",
    destination: "masterlink",
    orderRequired: true,
    allowedAiIntents: ["complaint"],
  },
  "complaint.reship": {
    actionType: "complaint.reship",
    label: "Utwórz bezpłatną dosyłkę",
    handling: "masterlink",
    destination: "masterlink",
    orderRequired: true,
    allowedAiIntents: ["complaint", "delivery_status"],
  },
  "complaint.resolve_missing": {
    actionType: "complaint.resolve_missing",
    label: "Obsłuż brakujący produkt",
    handling: "team_escalation",
    destination: "complaints",
    orderRequired: true,
    allowedAiIntents: ["complaint"],
  },
  "complaint.resolve_damaged": {
    actionType: "complaint.resolve_damaged",
    label: "Obsłuż uszkodzony produkt",
    handling: "team_escalation",
    destination: "complaints",
    orderRequired: true,
    allowedAiIntents: ["complaint"],
  },
  "fulfillment.release": {
    actionType: "fulfillment.release",
    label: "Odblokuj realizację zamówienia",
    handling: "masterlink",
    destination: "masterlink",
    orderRequired: true,
    allowedAiIntents: ["order_status", "delivery_status", "payment_status"],
  },
  "fulfillment.locate": {
    actionType: "fulfillment.locate",
    label: "Odnajdź przesyłkę na magazynie",
    handling: "team_escalation",
    destination: "current_affairs",
    orderRequired: true,
    allowedAiIntents: ["order_status", "delivery_status"],
  },
  "fulfillment.correct": {
    actionType: "fulfillment.correct",
    label: "Popraw dane realizacji",
    handling: "masterlink",
    destination: "masterlink",
    orderRequired: true,
    allowedAiIntents: ["order_status", "delivery_status", "cancellation"],
  },
  "returns.register_received": {
    actionType: "returns.register_received",
    label: "Zarejestruj otrzymany zwrot",
    handling: "masterlink",
    destination: "masterlink",
    orderRequired: true,
    allowedAiIntents: ["return", "refund"],
  },
  "returns.handle_unclaimed": {
    actionType: "returns.handle_unclaimed",
    label: "Obsłuż nieodebraną przesyłkę",
    handling: "team_escalation",
    destination: "returns_unreceived",
    orderRequired: true,
    allowedAiIntents: ["return", "delivery_status"],
  },
  "order.cancel": {
    actionType: "order.cancel",
    label: "Anuluj zamówienie",
    handling: "masterlink",
    destination: "masterlink",
    orderRequired: true,
    allowedAiIntents: ["cancellation"],
  },
  "order.stop": {
    actionType: "order.stop",
    label: "Wstrzymaj zamówienie",
    handling: "masterlink",
    destination: "masterlink",
    orderRequired: true,
    allowedAiIntents: ["cancellation"],
  },
  "erp.correct": {
    actionType: "erp.correct",
    label: "Wykonaj korektę dokumentu ERP",
    handling: "team_escalation",
    destination: "cancelled",
    orderRequired: true,
    allowedAiIntents: ["cancellation", "refund"],
  },
  "wholesale.review": {
    actionType: "wholesale.review",
    label: "Obsłuż zapytanie hurtowe",
    handling: "team_escalation",
    destination: "wholesalers",
    orderRequired: false,
    allowedAiIntents: ["other"],
  },
  "upsell.add_item": {
    actionType: "upsell.add_item",
    label: "Dodaj produkt do zamówienia",
    handling: "team_escalation",
    destination: "upsell",
    orderRequired: true,
    allowedAiIntents: ["order_status", "other"],
  },
  "promo.freebie": {
    actionType: "promo.freebie",
    label: "Zweryfikuj promocję lub gratis",
    handling: "team_escalation",
    destination: "promo",
    orderRequired: false,
    allowedAiIntents: ["faq", "order_status", "complaint", "other"],
  },
  "catalog.originals": {
    actionType: "catalog.originals",
    label: "Obsłuż sprawę oryginalności",
    handling: "team_escalation",
    destination: "originals",
    orderRequired: false,
    allowedAiIntents: ["faq", "complaint", "other"],
  },
  "privacy.unsubscribe": {
    actionType: "privacy.unsubscribe",
    label: "Usuń z listy marketingowej",
    handling: "team_escalation",
    destination: "unsubscribe",
    orderRequired: false,
    allowedAiIntents: ["legal_privacy"],
  },
  "marketing.creator_partnership": {
    actionType: "marketing.creator_partnership",
    label: "Oceń współpracę z twórcą",
    handling: "team_escalation",
    destination: "bok_marketing",
    orderRequired: false,
    allowedAiIntents: ["other"],
  },
  "policy.gap": {
    actionType: "policy.gap",
    label: "Uzupełnij regułę BOK",
    handling: "team_escalation",
    destination: "bok",
    orderRequired: false,
    allowedAiIntents: ["faq", "other"],
  },
  "runtime.bad_draft": {
    actionType: "runtime.bad_draft",
    label: "Zgłoś błędny draft agenta",
    handling: "team_escalation",
    destination: "rufus_bok",
    orderRequired: false,
    allowedAiIntents: TICKET_AI_INTENTS,
  },
} as const satisfies Record<TicketOperationalActionType, TicketOperationalActionDefinition>;

export const ticketAiOperationalActionRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    actionType: z.enum(TICKET_OPERATIONAL_ACTION_TYPES),
    factKeys: z.array(z.string().regex(SAFE_FACT_KEY)).min(1).max(50),
  })
  .strict();

export const ticketAiOperationalActionDecisionSchema = z
  .object({
    schemaVersion: z.literal(2),
    actionType: z.enum(TICKET_OPERATIONAL_ACTION_TYPES),
    verdict: z.enum(["approve", "reject"]),
    reasonCodes: z
      .array(z.enum(TICKET_AI_OPERATIONAL_ACTION_DECISION_REASONS))
      .max(10),
  })
  .strict();

export type TicketAiOperationalActionRequest = z.infer<
  typeof ticketAiOperationalActionRequestSchema
>;
export type TicketAiOperationalActionDecision = z.infer<
  typeof ticketAiOperationalActionDecisionSchema
>;

export function ticketOperationalActionAcceptsAiIntent(
  actionType: TicketOperationalActionType,
  intent: TicketAiIntent,
): boolean {
  return (TICKET_OPERATIONAL_ACTION_DEFINITIONS[actionType]
    .allowedAiIntents as readonly string[]).includes(intent);
}

/** Trusted prompt metadata. handling/destination are never accepted in model output. */
export function operationalActionCatalogJson(): string {
  return JSON.stringify(
    TICKET_OPERATIONAL_ACTION_TYPES.map((actionType) => {
      const definition = TICKET_OPERATIONAL_ACTION_DEFINITIONS[actionType];
      return {
        actionType,
        label: definition.label,
        allowedIntents: definition.allowedAiIntents,
        handling: definition.handling,
        destination: definition.destination,
      };
    }),
  );
}

/**
 * Stable safety contract shared with MasterLink. Presentation labels and concrete
 * Discord channel IDs are deliberately outside the hash.
 */
export function operationalActionCatalogContract() {
  return {
    schemaVersion: TICKET_OPERATIONAL_ACTION_CATALOG_SCHEMA_VERSION,
    actions: [...TICKET_OPERATIONAL_ACTION_TYPES]
      .sort()
      .map((actionType) => {
        const definition = TICKET_OPERATIONAL_ACTION_DEFINITIONS[actionType];
        return {
          actionType,
          handling: definition.handling,
          destination: definition.destination,
          orderRequired: definition.orderRequired,
          allowedAiIntents: [...definition.allowedAiIntents].sort(),
        };
      }),
    decisionReasonCodes: [...TICKET_AI_OPERATIONAL_ACTION_DECISION_REASONS].sort(),
  } as const;
}

export function operationalActionCatalogHash(): string {
  return createHash("sha256")
    .update(JSON.stringify(operationalActionCatalogContract()), "utf8")
    .digest("hex");
}

export const TICKET_AI_OPERATIONAL_ACTION_REQUEST_JSON_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        schemaVersion: { type: "integer", enum: [2] },
        actionType: { type: "string", enum: TICKET_OPERATIONAL_ACTION_TYPES },
        factKeys: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,99}$" },
        },
      },
      required: ["schemaVersion", "actionType", "factKeys"],
      additionalProperties: false,
    },
    { type: "null" },
  ],
} as const;

export const TICKET_AI_OPERATIONAL_ACTION_DECISION_JSON_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        schemaVersion: { type: "integer", enum: [2] },
        actionType: { type: "string", enum: TICKET_OPERATIONAL_ACTION_TYPES },
        verdict: { type: "string", enum: ["approve", "reject"] },
        reasonCodes: {
          type: "array",
          maxItems: 10,
          items: {
            type: "string",
            enum: TICKET_AI_OPERATIONAL_ACTION_DECISION_REASONS,
          },
        },
      },
      required: ["schemaVersion", "actionType", "verdict", "reasonCodes"],
      additionalProperties: false,
    },
    { type: "null" },
  ],
} as const;
