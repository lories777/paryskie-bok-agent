import { z } from "zod";

export const NATIVE_BOK_PROVIDER = "paryskie-bok-agent" as const;
export const DEFAULT_NATIVE_BOK_MODEL = "codex-subscription-managed";
export const MAX_NATIVE_BOK_REQUEST_BYTES = 1_000_000;
export const MAX_NATIVE_BOK_CONTEXT_CHARS = 500_000;
export const MAX_NATIVE_BOK_MESSAGE_BODY_CHARS = 100_000;
export const MAX_NATIVE_BOK_DRAFT_BODY_CHARS = 20_000;

export const TICKET_AI_INTENTS = [
  "faq",
  "order_status",
  "delivery_status",
  "payment_status",
  "return",
  "complaint",
  "cancellation",
  "refund",
  "legal_privacy",
  "other",
] as const;

export const TICKET_AI_JUDGE_REASON_CODES = [
  "grounded",
  "incomplete",
  "tone",
  "policy",
  "hallucination",
  "missing_context",
  "ambiguous",
  "unsafe_action",
  "needs_human",
  "other",
] as const;

const SAFE_FACT_KEY = /^[a-z][a-z0-9_.-]{0,99}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const SAFE_NATIVE_BOK_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

function nonBlank(maximum: number) {
  return z.string().min(1).max(maximum).refine((value) => value.trim().length > 0);
}

const conversationMessageSchema = z
  .object({
    id: nonBlank(100),
    direction: z.enum(["inbound", "outbound", "internal"]),
    authorKind: z.enum(["customer", "agent", "ai", "system"]),
    body: nonBlank(MAX_NATIVE_BOK_MESSAGE_BODY_CHARS),
    attachmentCount: z.number().int().min(0).max(100),
    createdAt: nonBlank(50),
  })
  .strict();

const ticketSchema = z
  .object({
    id: nonBlank(100),
    revision: z.number().int().min(1),
    subject: nonBlank(500),
    channel: nonBlank(30),
    market: z.string().regex(/^[A-Z]{2}$/),
    priority: nonBlank(30),
    customerName: nonBlank(500).nullable(),
  })
  .strict();

const verifiedFactsSchema = z.record(
  z.string().regex(SAFE_FACT_KEY),
  z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]),
).refine((facts) => Object.keys(facts).length <= 50);

export const ticketAiContextSchema = z
  .object({
    operationId: nonBlank(100),
    ticket: ticketSchema,
    triggerMessageId: nonBlank(100),
    conversation: z.array(conversationMessageSchema).min(1).max(100),
    contextTruncated: z.boolean(),
    verifiedFacts: verifiedFactsSchema,
    policy: z
      .object({
        customerContentTrust: z.literal("untrusted"),
        factsSource: z.literal("verifiedFactsOnly"),
        tools: z.literal("readOnly"),
        neverRevealInternalContext: z.literal(true),
      })
      .strict(),
    promptVersion: z.string().regex(SAFE_VERSION),
  })
  .strict()
  .superRefine((context, issue) => {
    const serialized = JSON.stringify(context);
    if (serialized.length > MAX_NATIVE_BOK_CONTEXT_CHARS) {
      issue.addIssue({ code: "custom", message: "context_too_large" });
    }
  });

export const ticketAiGeneratorOutputSchema = z
  .object({
    body: nonBlank(MAX_NATIVE_BOK_DRAFT_BODY_CHARS),
    intent: z.enum(TICKET_AI_INTENTS),
    confidence: z.enum(["low", "medium", "high"]),
    usedFactKeys: z.array(z.string().regex(SAFE_FACT_KEY)).max(50),
    unverifiedClaims: z.array(nonBlank(500)).max(20),
    needsHumanReview: z.boolean(),
    escalationCode: z
      .enum([
        "missing_order",
        "ambiguous_identity",
        "missing_fact",
        "complaint",
        "refund",
        "cancellation",
        "legal_privacy",
        "attachment_unread",
        "other",
      ])
      .nullable(),
  })
  .strict();

export const ticketAiJudgeOutputSchema = z
  .object({
    verdict: z.enum(["approve", "human", "reject"]),
    score: z.number().min(0).max(1),
    grounded: z.boolean(),
    policyCompliant: z.boolean(),
    reasonCodes: z.array(z.enum(TICKET_AI_JUDGE_REASON_CODES)).max(20),
  })
  .strict();

export const nativeBokGenerateRequestSchema = z
  .object({ context: ticketAiContextSchema })
  .strict();

export const nativeBokJudgeRequestSchema = z
  .object({
    context: ticketAiContextSchema,
    draft: ticketAiGeneratorOutputSchema,
  })
  .strict();

export type TicketAiContext = z.infer<typeof ticketAiContextSchema>;
export type TicketAiGeneratorOutput = z.infer<typeof ticketAiGeneratorOutputSchema>;
export type TicketAiJudgeOutput = z.infer<typeof ticketAiJudgeOutputSchema>;

export function parseGeneratorOutput(
  value: unknown,
  context: TicketAiContext,
): TicketAiGeneratorOutput {
  const output = ticketAiGeneratorOutputSchema.parse(value);
  const known = new Set(Object.keys(context.verifiedFacts));
  if (new Set(output.usedFactKeys).size !== output.usedFactKeys.length) {
    throw new Error("generator_fact_keys_duplicate");
  }
  if (output.usedFactKeys.some((key) => !known.has(key))) {
    throw new Error("generator_fact_key_unknown");
  }
  return output;
}

export const TICKET_AI_GENERATOR_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "string", minLength: 1, maxLength: MAX_NATIVE_BOK_DRAFT_BODY_CHARS },
    intent: { type: "string", enum: TICKET_AI_INTENTS },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    usedFactKeys: {
      type: "array",
      maxItems: 50,
      items: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,99}$" },
    },
    unverifiedClaims: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    needsHumanReview: { type: "boolean" },
    escalationCode: {
      anyOf: [
        {
          type: "string",
          enum: [
            "missing_order",
            "ambiguous_identity",
            "missing_fact",
            "complaint",
            "refund",
            "cancellation",
            "legal_privacy",
            "attachment_unread",
            "other",
          ],
        },
        { type: "null" },
      ],
    },
  },
  required: [
    "body",
    "intent",
    "confidence",
    "usedFactKeys",
    "unverifiedClaims",
    "needsHumanReview",
    "escalationCode",
  ],
  additionalProperties: false,
} as const;

export const TICKET_AI_JUDGE_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "human", "reject"] },
    score: { type: "number", minimum: 0, maximum: 1 },
    grounded: { type: "boolean" },
    policyCompliant: { type: "boolean" },
    reasonCodes: {
      type: "array",
      maxItems: 20,
      items: { type: "string", enum: TICKET_AI_JUDGE_REASON_CODES },
    },
  },
  required: ["verdict", "score", "grounded", "policyCompliant", "reasonCodes"],
  additionalProperties: false,
} as const;
