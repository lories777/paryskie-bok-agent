import { z } from "zod";
import {
  TICKET_AI_OPERATIONAL_ACTION_DECISION_REASONS,
  TICKET_OPERATIONAL_ACTION_TYPES,
} from "./native-bok-operational-catalog.js";

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
      .max(10),
  })
  .strict();

export type TicketAiOperationalActionRequest = z.infer<
  typeof ticketAiOperationalActionRequestSchema
>;
export type TicketAiOperationalActionDecision = z.infer<
  typeof ticketAiOperationalActionDecisionSchema
>;

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
