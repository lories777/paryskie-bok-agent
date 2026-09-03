import { z } from "zod";
import {
  TICKET_AI_OPERATIONAL_ACTION_DECISION_REASONS,
  TICKET_OPERATIONAL_ACTION_TYPES,
  ticketOperationalActionAcceptsAiIntent,
} from "./native-bok-operational-catalog.js";
import { TICKET_AI_INTENTS } from "./native-bok-knowledge.js";

export * from "./native-bok-operational-catalog.js";

const SAFE_FACT_KEY = /^[a-z][a-z0-9_.-]{0,99}$/;

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
      .min(1)
      .max(10),
  })
  .strict();

export type TicketAiOperationalActionRequest = z.infer<
  typeof ticketAiOperationalActionRequestSchema
>;
export type TicketAiOperationalActionDecision = z.infer<
  typeof ticketAiOperationalActionDecisionSchema
>;

/**
 * Jedyny machine-readable plan operacji, który może opuścić wspólny pipeline
 * Discord/MasterLink. Nie zawiera payloadu, routingu ani tekstu zadania.
 */
export const sharedAgentOperationalActionProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    intent: z.enum(TICKET_AI_INTENTS),
    request: ticketAiOperationalActionRequestSchema,
  })
  .strict()
  .superRefine((proposal, issue) => {
    if (!ticketOperationalActionAcceptsAiIntent(proposal.request.actionType, proposal.intent)) {
      issue.addIssue({
        code: "custom",
        path: ["intent"],
        message: "operational_action_intent_mismatch",
      });
    }
    if (!isCanonicalUnique(proposal.request.factKeys)) {
      issue.addIssue({
        code: "custom",
        path: ["request", "factKeys"],
        message: "operational_action_fact_keys_not_canonical",
      });
    }
  });

/** Oddzielny wynik reviewera; nigdy nie jest tworzony przez autora odpowiedzi. */
export const sharedAgentOperationalActionReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    grounded: z.boolean(),
    policyCompliant: z.boolean(),
    decision: ticketAiOperationalActionDecisionSchema,
  })
  .strict()
  .superRefine((review, issue) => {
    if (!isCanonicalUnique(review.decision.reasonCodes)) {
      issue.addIssue({
        code: "custom",
        path: ["decision", "reasonCodes"],
        message: "operational_action_reason_codes_not_canonical",
      });
    }
    if (review.decision.verdict !== "approve") return;
    if (!review.grounded || !review.policyCompliant) {
      issue.addIssue({
        code: "custom",
        path: ["decision", "verdict"],
        message: "operational_action_approval_unverified",
      });
    }
    const reasons = new Set(review.decision.reasonCodes);
    if (
      reasons.size !== 2
      || !reasons.has("facts_verified")
      || !reasons.has("intent_match")
    ) {
      issue.addIssue({
        code: "custom",
        path: ["decision", "reasonCodes"],
        message: "operational_action_approval_reasons_invalid",
      });
    }
  });

export type SharedAgentOperationalActionProposal = z.infer<
  typeof sharedAgentOperationalActionProposalSchema
>;
export type SharedAgentOperationalActionReview = z.infer<
  typeof sharedAgentOperationalActionReviewSchema
>;

export interface ReviewedSharedAgentOperationalAction {
  readonly proposal: SharedAgentOperationalActionProposal;
  readonly review: SharedAgentOperationalActionReview;
}

export function parseSharedAgentOperationalActionProposal(
  rawProposal: unknown,
  verifiedFacts: Readonly<Record<string, string | number | boolean | null>>,
): SharedAgentOperationalActionProposal {
  const proposal = sharedAgentOperationalActionProposalSchema.parse(rawProposal);
  for (const factKey of proposal.request.factKeys) {
    const value = verifiedFacts[factKey];
    if (value === undefined || value === null || value === "") {
      throw new Error("operational_action_fact_missing");
    }
  }
  return proposal;
}

export function parseSharedAgentOperationalActionReview(
  rawReview: unknown,
  proposal: SharedAgentOperationalActionProposal,
): SharedAgentOperationalActionReview {
  const review = sharedAgentOperationalActionReviewSchema.parse(rawReview);
  if (review.decision.actionType !== proposal.request.actionType) {
    throw new Error("operational_action_review_type_mismatch");
  }
  return review;
}

export function approvedSharedAgentOperationalAction(
  value: ReviewedSharedAgentOperationalAction | null | undefined,
): ReviewedSharedAgentOperationalAction | null {
  if (!value || value.review.decision.verdict !== "approve") return null;
  return value;
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
          minItems: 1,
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

export const SHARED_AGENT_OPERATIONAL_ACTION_PROPOSAL_JSON_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        schemaVersion: { type: "integer", enum: [1] },
        intent: { type: "string", enum: TICKET_AI_INTENTS },
        request: {
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
      },
      required: ["schemaVersion", "intent", "request"],
      additionalProperties: false,
    },
    { type: "null" },
  ],
} as const;

export const SHARED_AGENT_OPERATIONAL_ACTION_REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    grounded: { type: "boolean" },
    policyCompliant: { type: "boolean" },
    decision: {
      type: "object",
      properties: {
        schemaVersion: { type: "integer", enum: [2] },
        actionType: { type: "string", enum: TICKET_OPERATIONAL_ACTION_TYPES },
        verdict: { type: "string", enum: ["approve", "reject"] },
        reasonCodes: {
          type: "array",
          minItems: 1,
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
  },
  required: ["schemaVersion", "grounded", "policyCompliant", "decision"],
  additionalProperties: false,
} as const;

function isCanonicalUnique<T extends string>(values: readonly T[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}
