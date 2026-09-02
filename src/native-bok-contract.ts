import { createHash } from "node:crypto";
import { z } from "zod";
import {
  parseTicketAiKnowledgeSnapshot,
  ticketAiKnowledgeSnapshotSchema,
  TICKET_AI_INTENTS,
} from "./native-bok-knowledge.js";
import {
  TICKET_AI_OPERATIONAL_ACTION_DECISION_JSON_SCHEMA,
  TICKET_AI_OPERATIONAL_ACTION_REQUEST_JSON_SCHEMA,
  ticketAiOperationalActionDecisionSchema,
  ticketAiOperationalActionRequestSchema,
  ticketOperationalActionAcceptsAiIntent,
} from "./native-bok-operational-actions.js";

export { TICKET_AI_INTENTS } from "./native-bok-knowledge.js";
export {
  TICKET_AI_OPERATIONAL_ACTION_DECISION_REASONS,
  TICKET_OPERATIONAL_ACTION_CATALOG_SCHEMA_VERSION,
  TICKET_OPERATIONAL_ACTION_DEFINITIONS,
  TICKET_OPERATIONAL_ACTION_TYPES,
  operationalActionCatalogContract,
  operationalActionCatalogHash,
  ticketAiOperationalActionDecisionSchema,
  ticketAiOperationalActionRequestSchema,
} from "./native-bok-operational-actions.js";

export const NATIVE_BOK_PROVIDER = "paryskie-bok-agent" as const;
export const NATIVE_BOK_RUNTIME = "discord-shared" as const;
export const DEFAULT_NATIVE_BOK_MODEL = "codex-subscription-managed";
export const MAX_NATIVE_BOK_REQUEST_BYTES = 1_000_000;
export const MAX_NATIVE_BOK_CONTEXT_CHARS = 500_000;
export const MAX_NATIVE_BOK_MESSAGE_BODY_CHARS = 100_000;
export const MAX_NATIVE_BOK_DRAFT_BODY_CHARS = 20_000;

export interface NativeBokRuntimeStatus {
  schemaVersion: 1;
  provider: typeof NATIVE_BOK_PROVIDER;
  runtime: typeof NATIVE_BOK_RUNTIME;
  store: {
    source: "shared-agent-store";
    identity: string;
  };
  corrections: {
    source: "verified-discord-corrections";
    revision: number;
    activeRules: number;
    total: number;
    truncated: false;
  };
  playbook: {
    source: "shared-agent-workspace";
    revision: string;
  };
  operationalActionCatalog: {
    schemaVersion: 2;
    hash: string;
  };
}
export const MAX_NATIVE_BOK_INTERNAL_NOTE_CHARS = 1_200;
export const MAX_NATIVE_BOK_NEXT_ACTIONS = 5;
export const MAX_NATIVE_BOK_NEXT_ACTION_CHARS = 300;
export const MAX_NATIVE_BOK_ATTACHMENTS = 20;
export const MAX_NATIVE_BOK_TEXT_ATTACHMENTS = 4;
export const MAX_NATIVE_BOK_ATTACHMENT_BYTES = 64 * 1024;
export const MAX_NATIVE_BOK_ATTACHMENT_TEXT_CHARS = 12_000;
export const MAX_NATIVE_BOK_ATTACHMENT_TOTAL_TEXT_CHARS = 24_000;
export const NATIVE_BOK_ATTACHMENT_POLICY_VERSION = "verified-text-v1" as const;
export const NATIVE_BOK_ATTACHMENT_TEXT_EXTRACTOR = "utf8-text-v1" as const;

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
const SAFE_SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ATTACHMENT_ID = /^(?:daktela-meta:[a-f0-9]{64}|daktela-unread:[a-f0-9]{64})$/;
const EMAIL_PII = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const IBAN_PII = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/i;
const POLISH_NRB_PII = /(?<!\d)(?:\d[ -]?){25}\d(?!\d)/;
const PHONE_PII = /(?<!\w)(?:\+|00)\d{1,3}[ .()-]?(?:\d[ .()-]?){7,13}(?!\w)/;
const POLISH_LOCAL_PHONE_PII = /(?<!\d)(?:\d[ .()-]?){8}\d(?!\d)/;
const CARD_PII = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;
export const SAFE_NATIVE_BOK_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

function nonBlank(maximum: number) {
  return z.string().min(1).max(maximum).refine((value) => value.trim().length > 0);
}

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function containsAttachmentPii(value: string): boolean {
  return EMAIL_PII.test(value) ||
    IBAN_PII.test(value) ||
    POLISH_NRB_PII.test(value) ||
    PHONE_PII.test(value) ||
    POLISH_LOCAL_PHONE_PII.test(value) ||
    [...value.matchAll(CARD_PII)].some((match) => luhn(match[0]));
}

function safeAttachmentText(value: string): boolean {
  return value.normalize("NFC") === value &&
    !value.includes("\r") &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && character !== "\n" && character !== "\t");
    }) &&
    !containsAttachmentPii(value);
}

const conversationMessageBase = {
  id: nonBlank(100),
  direction: z.enum(["inbound", "outbound", "internal"]),
  authorKind: z.enum(["customer", "agent", "ai", "system"]),
  body: nonBlank(MAX_NATIVE_BOK_MESSAGE_BODY_CHARS),
  attachmentCount: z.number().int().min(0).max(100),
  createdAt: nonBlank(50),
};

const legacyConversationMessageSchema = z
  .object({
    ...conversationMessageBase,
  })
  .strict();

const attachmentFileNameSchema = z.string().min(1).max(500).refine((value) =>
  value.normalize("NFC") === value &&
  !value.includes("/") &&
  !value.includes("\\") &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  }) &&
  !containsAttachmentPii(value),
);

const attachmentContentTypeSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)
  .nullable();

const readAttachmentSchema = z
  .object({
    id: z.string().regex(SAFE_ATTACHMENT_ID),
    fileName: attachmentFileNameSchema,
    contentType: attachmentContentTypeSchema,
    sizeBytes: z.number().int().positive().max(MAX_NATIVE_BOK_ATTACHMENT_BYTES),
    status: z.literal("read"),
    extractor: z.literal(NATIVE_BOK_ATTACHMENT_TEXT_EXTRACTOR),
    text: z
      .string()
      .min(1)
      .max(MAX_NATIVE_BOK_ATTACHMENT_TEXT_CHARS)
      .refine(safeAttachmentText),
  })
  .strict()
  .superRefine((attachment, issue) => {
    const extension = attachment.fileName.includes(".")
      ? attachment.fileName.split(".").at(-1)?.toLowerCase()
      : undefined;
    const supported =
      (extension === "txt" && attachment.contentType === "text/plain") ||
      (extension === "csv" && ["text/csv", "text/plain"].includes(attachment.contentType ?? ""));
    if (!supported) issue.addIssue({ code: "custom", message: "attachment_read_contract_invalid" });
  });
type ReadAttachment = z.infer<typeof readAttachmentSchema>;

const unreadAttachmentSchema = z
  .object({
    id: z.string().regex(SAFE_ATTACHMENT_ID),
    fileName: attachmentFileNameSchema,
    contentType: attachmentContentTypeSchema,
    sizeBytes: z.number().int().positive().nullable(),
    status: z.enum(["unsupported", "failed", "truncated"]),
    extractor: z.null(),
    text: z.null(),
  })
  .strict();

const attachmentSchema = z.union([readAttachmentSchema, unreadAttachmentSchema]);

const attachmentConversationMessageSchema = z
  .object({
    ...conversationMessageBase,
    attachments: z.array(attachmentSchema).max(MAX_NATIVE_BOK_ATTACHMENTS),
  })
  .strict()
  .superRefine((message, issue) => {
    if (message.attachments.length !== message.attachmentCount) {
      issue.addIssue({ code: "custom", message: "message_attachments_invalid" });
    }
  });

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

const operatorGuidanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    sourceRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    content: z.string().min(1).max(4_000).refine((value) =>
      value.trim().length > 0 && value.normalize("NFC") === value
    ),
    decision: z.enum(["yes", "no", "custom"]),
    contentHash: z.string().regex(SAFE_SHA256),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

const commonContextFields = {
  operationId: nonBlank(100),
  ticket: ticketSchema,
  triggerMessageId: nonBlank(100),
  contextTruncated: z.boolean(),
  verifiedFacts: verifiedFactsSchema,
  promptVersion: z.string().regex(SAFE_VERSION),
  operatorGuidance: operatorGuidanceSchema.nullable().optional(),
};

const legacyTicketAiContextSchema = z
  .object({
    ...commonContextFields,
    conversation: z.array(legacyConversationMessageSchema).min(1).max(100),
    policy: z
      .object({
        customerContentTrust: z.literal("untrusted"),
        factsSource: z.literal("verifiedFactsOnly"),
        tools: z.literal("readOnly"),
        neverRevealInternalContext: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((context, issue) => {
    if (context.conversation.some((message) => message.attachmentCount > 0)) {
      issue.addIssue({ code: "custom", message: "attachment_unread" });
    }
  });

const attachmentCoverageSchema = z
  .object({
    policyVersion: z.literal(NATIVE_BOK_ATTACHMENT_POLICY_VERSION),
    coverageHash: z.string().regex(SAFE_SHA256),
    totalCount: z.number().int().min(0).max(MAX_NATIVE_BOK_ATTACHMENTS),
    readCount: z.number().int().min(0).max(MAX_NATIVE_BOK_ATTACHMENTS),
    operatorRequiredCount: z.number().int().min(0).max(MAX_NATIVE_BOK_ATTACHMENTS),
  })
  .strict();

/**
 * Strict transport carrier including unresolved visual attachments. The legacy generate/judge
 * endpoints add a second refinement below and still reject anything not extracted as text.
 * Exact Daktela parity uses this carrier only when those media are bound to its source manifest.
 */
const ticketAiAttachmentContextCarrierCoreSchema = z
  .object({
    ...commonContextFields,
    conversation: z.array(attachmentConversationMessageSchema).min(1).max(100),
    attachmentCoverage: attachmentCoverageSchema,
    policy: z
      .object({
        customerContentTrust: z.literal("untrusted"),
        attachmentContentTrust: z.literal("untrusted"),
        factsSource: z.literal("verifiedFactsOnly"),
        tools: z.literal("readOnly"),
        neverRevealInternalContext: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((context, issue) => {
    const attachments = context.conversation.flatMap((message) =>
      message.attachments.map((attachment) => ({ messageId: message.id, attachment })),
    );
    const read = attachments.filter(
      (row): row is { messageId: string; attachment: ReadAttachment } =>
        row.attachment.status === "read",
    );
    const promptKeys = new Set<string>();
    for (const { messageId, attachment } of attachments) {
      const key = `${messageId}\u0000${attachment.id}`;
      if (promptKeys.has(key)) {
        issue.addIssue({ code: "custom", message: "attachment_id_duplicate" });
      }
      promptKeys.add(key);
    }
    if (
      attachments.length > MAX_NATIVE_BOK_ATTACHMENTS ||
      read.length > MAX_NATIVE_BOK_TEXT_ATTACHMENTS ||
      read.reduce((sum, { attachment }) => sum + attachment.text.length, 0) >
        MAX_NATIVE_BOK_ATTACHMENT_TOTAL_TEXT_CHARS
    ) {
      issue.addIssue({ code: "custom", message: "attachment_limit_exceeded" });
    }
    if (
      context.attachmentCoverage.totalCount !== attachments.length ||
      context.attachmentCoverage.readCount !== read.length ||
      context.attachmentCoverage.operatorRequiredCount !== attachments.length - read.length
    ) {
      issue.addIssue({ code: "custom", message: "attachment_coverage_invalid" });
    }
  });

function validateTicketAiContextEnvelope(
  context: z.infer<typeof ticketAiAttachmentContextCarrierCoreSchema>
    | z.infer<typeof legacyTicketAiContextSchema>,
  issue: z.core.$RefinementCtx<unknown>,
): void {
  if (JSON.stringify(context).length > MAX_NATIVE_BOK_CONTEXT_CHARS) {
    issue.addIssue({ code: "custom", message: "context_too_large" });
  }
  const guidance = context.operatorGuidance;
  if (guidance) {
    if (guidance.sourceRevision !== context.ticket.revision) {
      issue.addIssue({ code: "custom", message: "operator_guidance_revision_mismatch" });
    }
    const expectedHash = createHash("sha256")
      .update(guidance.content, "utf8")
      .digest("hex");
    if (guidance.contentHash !== expectedHash) {
      issue.addIssue({ code: "custom", message: "operator_guidance_hash_mismatch" });
    }
  }
}

export const ticketAiAttachmentContextCarrierSchema =
  ticketAiAttachmentContextCarrierCoreSchema.superRefine(validateTicketAiContextEnvelope);

const attachmentTicketAiContextSchema = ticketAiAttachmentContextCarrierSchema.superRefine(
  (context, issue) => {
    const attachments = context.conversation.flatMap((message) => message.attachments);
    if (
      context.attachmentCoverage.operatorRequiredCount > 0
      || attachments.some((attachment) => attachment.status !== "read")
    ) {
      issue.addIssue({ code: "custom", message: "attachment_unread" });
    }
  },
);

const validatedLegacyTicketAiContextSchema =
  legacyTicketAiContextSchema.superRefine(validateTicketAiContextEnvelope);

export const ticketAiContextSchema = z.union([
  attachmentTicketAiContextSchema,
  validatedLegacyTicketAiContextSchema,
]);

export const ticketAiGeneratorOutputSchema = z
  .object({
    body: nonBlank(MAX_NATIVE_BOK_DRAFT_BODY_CHARS),
    internalNote: nonBlank(MAX_NATIVE_BOK_INTERNAL_NOTE_CHARS),
    nextActions: z.array(nonBlank(MAX_NATIVE_BOK_NEXT_ACTION_CHARS)).max(MAX_NATIVE_BOK_NEXT_ACTIONS),
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
    operationalActionRequest: ticketAiOperationalActionRequestSchema.nullable().optional(),
  })
  .strict();

export const ticketAiJudgeOutputSchema = z
  .object({
    verdict: z.enum(["approve", "human", "reject"]),
    score: z.number().min(0).max(1),
    grounded: z.boolean(),
    policyCompliant: z.boolean(),
    reasonCodes: z.array(z.enum(TICKET_AI_JUDGE_REASON_CODES)).max(20),
    operationalActionDecision: ticketAiOperationalActionDecisionSchema.nullable().optional(),
  })
  .strict();

export const nativeBokGenerateRequestSchema = z
  .object({
    context: ticketAiContextSchema,
    knowledgeSnapshot: ticketAiKnowledgeSnapshotSchema,
  })
  .strict()
  .superRefine((request, issue) => {
    try {
      parseTicketAiKnowledgeSnapshot(request.knowledgeSnapshot, request.context.ticket.market);
    } catch {
      issue.addIssue({ code: "custom", message: "knowledge_snapshot_invalid" });
    }
  });

export const nativeBokJudgeRequestSchema = z
  .object({
    context: ticketAiContextSchema,
    draft: ticketAiGeneratorOutputSchema,
    knowledgeSnapshot: ticketAiKnowledgeSnapshotSchema,
  })
  .strict()
  .superRefine((request, issue) => {
    try {
      parseTicketAiKnowledgeSnapshot(request.knowledgeSnapshot, request.context.ticket.market);
    } catch {
      issue.addIssue({ code: "custom", message: "knowledge_snapshot_invalid" });
    }
  });

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
  const request = output.operationalActionRequest;
  if (request) {
    const used = new Set(output.usedFactKeys);
    if (request.factKeys.some((key) => !known.has(key))) {
      throw new Error("generator_operational_fact_key_unknown");
    }
    if (request.factKeys.some((key) => !used.has(key))) {
      throw new Error("generator_operational_fact_key_unused");
    }
    if (request.factKeys.some((key) => {
      const fact = context.verifiedFacts[key];
      return fact === undefined || fact === null || fact === "";
    })) {
      throw new Error("generator_operational_fact_value_missing");
    }
    if (!ticketOperationalActionAcceptsAiIntent(request.actionType, output.intent)) {
      throw new Error("generator_operational_intent_mismatch");
    }
  }
  return output;
}

export function parseJudgeOutput(
  value: unknown,
  draft: TicketAiGeneratorOutput,
): TicketAiJudgeOutput {
  const output = ticketAiJudgeOutputSchema.parse(value);
  const decision = output.operationalActionDecision;
  if (!decision) return output;
  const request = draft.operationalActionRequest;
  if (!request) throw new Error("judge_operational_action_unrequested");
  if (decision.actionType !== request.actionType) {
    throw new Error("judge_operational_action_mismatch");
  }
  if (decision.verdict === "approve" && output.verdict !== "approve") {
    throw new Error("judge_operational_action_outer_verdict_mismatch");
  }
  return output;
}

export const TICKET_AI_GENERATOR_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "string", minLength: 1, maxLength: MAX_NATIVE_BOK_DRAFT_BODY_CHARS },
    internalNote: {
      type: "string",
      minLength: 1,
      maxLength: MAX_NATIVE_BOK_INTERNAL_NOTE_CHARS,
    },
    nextActions: {
      type: "array",
      maxItems: MAX_NATIVE_BOK_NEXT_ACTIONS,
      items: {
        type: "string",
        minLength: 1,
        maxLength: MAX_NATIVE_BOK_NEXT_ACTION_CHARS,
      },
    },
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
    operationalActionRequest: TICKET_AI_OPERATIONAL_ACTION_REQUEST_JSON_SCHEMA,
  },
  required: [
    "body",
    "internalNote",
    "nextActions",
    "intent",
    "confidence",
    "usedFactKeys",
    "unverifiedClaims",
    "needsHumanReview",
    "escalationCode",
    "operationalActionRequest",
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
    operationalActionDecision: TICKET_AI_OPERATIONAL_ACTION_DECISION_JSON_SCHEMA,
  },
  required: [
    "verdict",
    "score",
    "grounded",
    "policyCompliant",
    "reasonCodes",
    "operationalActionDecision",
  ],
  additionalProperties: false,
} as const;
