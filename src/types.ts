import { z } from "zod";
import {
  SHARED_AGENT_OPERATIONAL_ACTION_PROPOSAL_JSON_SCHEMA,
  sharedAgentOperationalActionProposalSchema,
} from "./native-bok-operational-actions.js";

export const actionKindSchema = z.enum([
  "reply_customer",
  "update_daktela",
  "masterlink_write",
  "discord_notify",
  "spreadsheet_write",
  "other",
]);

export const proposedActionSchema = z.object({
  kind: actionKindSchema,
  summary: z.string().min(1).max(500),
  target: z.string().min(1).max(300),
  payload: z.string().min(1).max(5000),
  reason: z.string().min(1).max(1000),
  risk: z.enum(["low", "medium", "high"]),
  qualityReview: z
    .object({
      verdict: z.enum(["pass", "revised", "blocked"]),
      issues: z.array(z.string().min(1).max(500)).max(8),
      confidence: z.enum(["high", "medium", "low"]),
      polishTranslation: z.string().min(1).max(5000).optional(),
    })
    .optional(),
});

export const agentTurnOutputSchema = z.object({
  // Cichy automat może poprawnie zwrócić pusty tekst. Runtime zamienia go na niepublikowaną
  // notatkę, zamiast oznaczać cały ticket jako błąd techniczny.
  reply: z.string(),
  caseState: z.enum(["answered", "needs_data", "waiting_for_human", "action_proposed"]),
  proposedActions: z.array(proposedActionSchema).max(8),
  // Tylko ten zamknięty sidecar może stać się operacją w MasterLink. Legacy
  // proposedActions pozostają prezentacją dla Discorda i nigdy nie są mapowane z tekstu.
  operationalActionProposal: sharedAgentOperationalActionProposalSchema.nullable().optional(),
  learnedRules: z
    .array(
      z.object({
        situation: z.string().min(1).max(500),
        instruction: z.string().min(1).max(1000),
      }),
    )
    // Jedna korekta BOK powinna tworzyć jedną spójną regułę. Większa liczba sprzyjała
    // dopisywaniu pobocznych lub niezwiązanych zasad z wcześniejszego kontekstu.
    .max(1)
    .optional(),
  actionExecution: z
    .object({
      status: z.enum(["executed", "failed"]),
      result: z.string().min(1).max(2000),
    })
    .nullable(),
});

export type AgentTurnOutput = z.infer<typeof agentTurnOutputSchema>;
export type ProposedAction = z.infer<typeof proposedActionSchema>;
export type ActionKind = z.infer<typeof actionKindSchema>;

export const AGENT_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    caseState: {
      type: "string",
      enum: ["answered", "needs_data", "waiting_for_human", "action_proposed"],
    },
    proposedActions: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "reply_customer",
              "update_daktela",
              "masterlink_write",
              "discord_notify",
              "spreadsheet_write",
              "other",
            ],
          },
          summary: { type: "string" },
          target: { type: "string" },
          payload: { type: "string" },
          reason: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["kind", "summary", "target", "payload", "reason", "risk"],
        additionalProperties: false,
      },
    },
    operationalActionProposal: SHARED_AGENT_OPERATIONAL_ACTION_PROPOSAL_JSON_SCHEMA,
    learnedRules: {
      type: "array",
      maxItems: 1,
      items: {
        type: "object",
        properties: {
          situation: { type: "string" },
          instruction: { type: "string" },
        },
        required: ["situation", "instruction"],
        additionalProperties: false,
      },
    },
    actionExecution: {
      anyOf: [
        {
          type: "object",
          properties: {
            status: { type: "string", enum: ["executed", "failed"] },
            result: { type: "string" },
          },
          required: ["status", "result"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: [
    "reply",
    "caseState",
    "proposedActions",
    "operationalActionProposal",
    "learnedRules",
    "actionExecution",
  ],
  additionalProperties: false,
} as const;

export interface IncomingMessage {
  platform: "discord" | "local";
  conversationExternalId: string;
  externalMessageId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  shouldRespond: boolean;
  role?: "human" | "context";
  /** Only messages from explicitly observed Discord channels may become cross-case context. */
  sharedContext?: boolean;
  /**
   * Set only by DiscordGateway after it has verified the sender allowlist and either a reply to
   * this bot or an explicit mention in a command channel. The store persists this provenance
   * before any model runs.
   */
  verifiedCorrectionSource?: {
    sourceKind: "reply" | "direct_mention";
    replyToBotMessageId: string | null;
    authorizationKind: "allowed_user" | "allowed_role";
    authorizationId: string;
  };
}

export interface StoredMessage {
  id: number;
  conversationId: number;
  role: "human" | "agent" | "context";
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface ClaimedJob {
  id: number;
  publicId: string;
  conversationId: number;
  triggerMessageId: number;
  platform: "discord" | "local";
  channelId: string;
  externalMessageId: string;
  attempts: number;
  approvedAction?: StoredAction;
}

export interface StoredAction {
  id: number;
  publicId: string;
  kind: ActionKind;
  summary: string;
  target: string;
  payload: string;
  reason: string;
  risk: "low" | "medium" | "high";
  qualityReview?: DraftQualityReview;
}

export interface DraftQualityReview {
  verdict: "pass" | "revised" | "blocked";
  issues: string[];
  confidence: "high" | "medium" | "low";
  polishTranslation?: string;
}

export interface StoredConversation {
  id: number;
  platform: "discord" | "local";
  externalId: string;
  codexThreadId: string | null;
}

export interface StoredLearnedRule {
  id: number;
  situation: string;
  instruction: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredVerifiedHumanCorrection {
  id: number;
  derivedSituation: string | null;
  derivedInstruction: string | null;
  createdAt: string;
  updatedAt: string;
  /** Immutable ordering revision assigned when the exact human source is first persisted. */
  sourceRevision: number;
  sourceContent: string;
  sourceAuthorId: string;
  sourceAuthorName: string;
  sourceExternalMessageId: string;
  sourceChannelId: string;
  sourceKind: "reply" | "direct_mention";
  replyToBotMessageId: string | null;
  authorizationKind: "allowed_user" | "allowed_role";
  authorizationId: string;
}

export interface VerifiedHumanCorrectionSnapshot {
  /** Changes whenever the complete snapshot changes, including its optional derived index. */
  revision: number;
  /** Total active human sources in durable storage, before applying the read limit. */
  total: number;
  /** True means `corrections` is incomplete and inference must stop fail-closed. */
  truncated: boolean;
  corrections: StoredVerifiedHumanCorrection[];
}
