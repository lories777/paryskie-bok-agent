import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertNativeBokAttachmentEvidenceBound,
  nativeBokAttachmentEvidenceSchema,
  type NativeBokAttachmentEvidence,
  type NativeBokDaktelaDecisionSource,
} from "./native-bok-attachment-evidence.js";
import {
  NATIVE_BOK_DECISION_PIPELINE,
  NATIVE_BOK_DECISION_PIPELINE_HASH,
} from "./native-bok-decision-capability.js";
import { NATIVE_BOK_PROVIDER } from "./native-bok-contract.js";
import {
  approvedSharedAgentOperationalAction,
  sharedAgentOperationalActionProposalSchema,
  sharedAgentOperationalActionReviewSchema,
  type ReviewedSharedAgentOperationalAction,
} from "./native-bok-operational-actions.js";
import type { AgentTurnOutput, ProposedAction } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_DAKTELA_ID = /^[A-Za-z0-9_]{1,100}$/;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_INTERNAL_NOTE = 12_000;

export const NATIVE_BOK_DECISION_RESULT_SCHEMA_VERSION = 3 as const;
export const NATIVE_BOK_DECISION_RESULT_V4_SCHEMA_VERSION = 4 as const;
export const NATIVE_BOK_DECISION_REASON_CODES = [
  "reviewed_reply_ready",
  "no_customer_reply",
  "multiple_customer_replies",
  "missing_quality_review",
  "quality_review_blocked",
  "ticket_binding_mismatch",
  "case_requires_human",
] as const;

const readyQualityReviewSchema = z
  .object({
    verdict: z.enum(["pass", "revised"]),
    confidence: z.enum(["high", "medium", "low"]),
    issues: z.array(z.string().min(1).max(500)).max(8),
    polishTranslation: z.string().min(1).max(5_000).optional(),
  })
  .strict();

const customerReplySchema = z
  .object({
    externalTicketId: z.string().regex(SAFE_DAKTELA_ID),
    body: z.string().min(1).max(5_000),
    qualityReview: readyQualityReviewSchema,
  })
  .strict();

const guidanceReceiptSchema = z
  .object({
    guidanceId: z.string().uuid(),
    guidanceHash: z.string().regex(SHA256),
    scope: z.literal("ticket"),
    externalTicketId: z.string().regex(SAFE_DAKTELA_ID),
    storeReceiptId: z.string().regex(SHA256),
    storeIdentity: z.string().regex(SHA256),
  })
  .strict();

const nonExecutableActionSchema = z
  .object({
    kind: z.enum([
      "update_daktela",
      "masterlink_write",
      "discord_notify",
      "spreadsheet_write",
      "other",
    ]),
    summary: z.string().min(1).max(500),
    risk: z.enum(["low", "medium", "high"]),
  })
  .strict();

const provenanceSchema = z
  .object({
    toolEvidenceHash: z.string().regex(SHA256),
    toolNames: z.array(z.string().regex(SAFE_TOOL_NAME)).max(50),
    reviewHash: z.string().regex(SHA256),
    policyHash: z.string().regex(SHA256),
    playbookRevision: z.string().regex(SHA256),
    correctionsRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    storeIdentity: z.string().regex(SHA256),
  })
  .strict()
  .superRefine((provenance, issue) => {
    if (!isCanonicalStrings(provenance.toolNames)) {
      issue.addIssue({ code: "custom", path: ["toolNames"], message: "tool_names_not_canonical" });
    }
  });

export const nativeBokDecisionResultV3Schema = z
  .object({
    schemaVersion: z.literal(NATIVE_BOK_DECISION_RESULT_SCHEMA_VERSION),
    provider: z.literal(NATIVE_BOK_PROVIDER),
    pipeline: z.literal(NATIVE_BOK_DECISION_PIPELINE),
    pipelineHash: z.literal(NATIVE_BOK_DECISION_PIPELINE_HASH),
    storeIdentity: z.string().regex(SHA256),
    sourceSnapshotHash: z.string().regex(SHA256),
    state: z.enum(["ready", "blocked"]),
    customerReply: customerReplySchema.nullable(),
    internalNote: z.string().max(MAX_INTERNAL_NOTE),
    reasonCodes: z.array(z.enum(NATIVE_BOK_DECISION_REASON_CODES)).min(1).max(8),
    attachmentEvidence: nativeBokAttachmentEvidenceSchema,
    provenance: provenanceSchema,
    guidanceReceipt: guidanceReceiptSchema.optional(),
    nonExecutableActions: z.array(nonExecutableActionSchema).max(8),
  })
  .strict()
  .superRefine((result, issue) => {
    if (result.sourceSnapshotHash !== result.attachmentEvidence.snapshotHash) {
      issue.addIssue({
        code: "custom",
        path: ["sourceSnapshotHash"],
        message: "result_source_snapshot_mismatch",
      });
    }
    if (result.storeIdentity !== result.provenance.storeIdentity) {
      issue.addIssue({
        code: "custom",
        path: ["provenance", "storeIdentity"],
        message: "provenance_store_identity_mismatch",
      });
    }
    if (!isCanonicalStrings(result.reasonCodes)) {
      issue.addIssue({ code: "custom", path: ["reasonCodes"], message: "reason_codes_not_canonical" });
    }
    if (
      (result.state === "ready" && result.customerReply === null)
      || (result.state === "blocked" && result.customerReply !== null)
    ) {
      issue.addIssue({ code: "custom", path: ["customerReply"], message: "result_state_invalid" });
    }
    if (
      result.state === "ready"
      && (result.reasonCodes.length !== 1 || result.reasonCodes[0] !== "reviewed_reply_ready")
    ) {
      issue.addIssue({ code: "custom", path: ["reasonCodes"], message: "ready_reason_invalid" });
    }
    if (result.state === "blocked" && result.reasonCodes.includes("reviewed_reply_ready")) {
      issue.addIssue({ code: "custom", path: ["reasonCodes"], message: "blocked_reason_invalid" });
    }
    const reviewHash = nativeBokDecisionReviewHash({
      state: result.state,
      customerReply: result.customerReply,
      reasonCodes: result.reasonCodes,
    });
    if (result.provenance.reviewHash !== reviewHash) {
      issue.addIssue({ code: "custom", path: ["provenance", "reviewHash"], message: "review_hash_mismatch" });
    }
    if (
      result.guidanceReceipt
      && result.guidanceReceipt.externalTicketId !== result.customerReply?.externalTicketId
      && result.state === "ready"
    ) {
      issue.addIssue({
        code: "custom",
        path: ["guidanceReceipt", "externalTicketId"],
        message: "guidance_ticket_mismatch",
      });
    }
    if (
      result.guidanceReceipt
      && result.guidanceReceipt.storeIdentity !== result.provenance.storeIdentity
    ) {
      issue.addIssue({
        code: "custom",
        path: ["guidanceReceipt", "storeIdentity"],
        message: "guidance_store_identity_mismatch",
      });
    }
  });

export const NATIVE_BOK_DECISION_V4_REASON_CODES = [
  ...NATIVE_BOK_DECISION_REASON_CODES,
  "reviewed_action_ready",
  "multiple_decisions",
  "operational_action_rejected",
] as const;

const reviewedOperationalActionSchema = z.object({
  proposal: sharedAgentOperationalActionProposalSchema,
  review: sharedAgentOperationalActionReviewSchema,
}).strict().superRefine((action, issue) => {
  if (action.proposal.request.actionType !== action.review.decision.actionType) {
    issue.addIssue({
      code: "custom",
      path: ["review", "decision", "actionType"],
      message: "operational_action_review_type_mismatch",
    });
  }
});

export const nativeBokDecisionResultV4Schema = z.object({
  schemaVersion: z.literal(NATIVE_BOK_DECISION_RESULT_V4_SCHEMA_VERSION),
  provider: z.literal(NATIVE_BOK_PROVIDER),
  pipeline: z.literal(NATIVE_BOK_DECISION_PIPELINE),
  pipelineHash: z.literal(NATIVE_BOK_DECISION_PIPELINE_HASH),
  storeIdentity: z.string().regex(SHA256),
  sourceSnapshotHash: z.string().regex(SHA256),
  state: z.enum(["ready", "blocked"]),
  readyKind: z.enum(["customer_reply", "operational_action"]).nullable(),
  customerReply: customerReplySchema.nullable(),
  operationalAction: reviewedOperationalActionSchema.nullable(),
  internalNote: z.string().max(MAX_INTERNAL_NOTE),
  reasonCodes: z.array(z.enum(NATIVE_BOK_DECISION_V4_REASON_CODES)).min(1).max(10),
  attachmentEvidence: nativeBokAttachmentEvidenceSchema,
  provenance: provenanceSchema,
  guidanceReceipt: guidanceReceiptSchema.optional(),
  nonExecutableActions: z.array(nonExecutableActionSchema).max(8),
}).strict().superRefine((result, issue) => {
  if (result.sourceSnapshotHash !== result.attachmentEvidence.snapshotHash) {
    issue.addIssue({ code: "custom", path: ["sourceSnapshotHash"], message: "result_source_snapshot_mismatch" });
  }
  if (result.storeIdentity !== result.provenance.storeIdentity) {
    issue.addIssue({ code: "custom", path: ["provenance", "storeIdentity"], message: "provenance_store_identity_mismatch" });
  }
  if (!isCanonicalStrings(result.reasonCodes)) {
    issue.addIssue({ code: "custom", path: ["reasonCodes"], message: "reason_codes_not_canonical" });
  }
  const approvedAction = approvedSharedAgentOperationalAction(result.operationalAction);
  const customerReady = result.customerReply !== null;
  const actionReady = approvedAction !== null;
  if (result.state === "ready") {
    if (customerReady === actionReady) {
      issue.addIssue({ code: "custom", path: ["state"], message: "ready_decision_not_exclusive" });
    }
    if (
      (result.readyKind === "customer_reply") !== customerReady
      || (result.readyKind === "operational_action") !== actionReady
    ) {
      issue.addIssue({ code: "custom", path: ["readyKind"], message: "ready_kind_mismatch" });
    }
    const expectedReason = customerReady ? "reviewed_reply_ready" : "reviewed_action_ready";
    if (result.reasonCodes.length !== 1 || result.reasonCodes[0] !== expectedReason) {
      issue.addIssue({ code: "custom", path: ["reasonCodes"], message: "ready_reason_invalid" });
    }
  } else if (result.readyKind !== null || customerReady || actionReady) {
    issue.addIssue({ code: "custom", path: ["state"], message: "blocked_decision_invalid" });
  }
  if (result.provenance.reviewHash !== nativeBokDecisionReviewHashV4({
    state: result.state,
    readyKind: result.readyKind,
    customerReply: result.customerReply,
    operationalAction: result.operationalAction,
    reasonCodes: result.reasonCodes,
  })) {
    issue.addIssue({ code: "custom", path: ["provenance", "reviewHash"], message: "review_hash_mismatch" });
  }
  if (result.guidanceReceipt && result.guidanceReceipt.storeIdentity !== result.storeIdentity) {
    issue.addIssue({ code: "custom", path: ["guidanceReceipt", "storeIdentity"], message: "guidance_store_identity_mismatch" });
  }
});

export type NativeBokDecisionResultV3 = z.infer<typeof nativeBokDecisionResultV3Schema>;
export type NativeBokGuidanceReceipt = NonNullable<NativeBokDecisionResultV3["guidanceReceipt"]>;
export type NativeBokDecisionResultV4 = z.infer<typeof nativeBokDecisionResultV4Schema>;
export type NativeBokDecisionResult = NativeBokDecisionResultV3 | NativeBokDecisionResultV4;

export interface NativeBokDecisionResultInput {
  readonly output: AgentTurnOutput;
  readonly source: NativeBokDaktelaDecisionSource;
  readonly attachmentEvidence: NativeBokAttachmentEvidence;
  readonly toolEvidenceHash: string;
  readonly toolNames: readonly string[];
  readonly policyHash: string;
  readonly playbookRevision: string;
  readonly correctionsRevision: number;
  readonly storeIdentity: string;
  readonly guidanceReceipt?: NativeBokGuidanceReceipt;
}

export interface NativeBokDecisionResultV4Input extends NativeBokDecisionResultInput {
  readonly operationalAction: ReviewedSharedAgentOperationalAction | null;
}

export function buildNativeBokDecisionResultV3(
  input: NativeBokDecisionResultInput,
): NativeBokDecisionResultV3 {
  assertNativeBokAttachmentEvidenceBound(input.source, input.attachmentEvidence);
  if (
    input.guidanceReceipt
    && input.guidanceReceipt.externalTicketId !== input.source.externalTicketId
  ) {
    throw new Error("guidance_ticket_mismatch");
  }
  const replyActions = input.output.proposedActions.filter((action) => action.kind === "reply_customer");
  const reasonCodes = decisionReasonCodes(input.output, replyActions, input.source.externalTicketId);
  const state = reasonCodes.length === 1 && reasonCodes[0] === "reviewed_reply_ready"
    ? "ready" as const
    : "blocked" as const;
  const action = state === "ready" ? replyActions[0]! : undefined;
  const customerReply = action && action.qualityReview?.verdict !== "blocked"
    ? {
        externalTicketId: input.source.externalTicketId,
        body: action.payload,
        qualityReview: {
          verdict: action.qualityReview!.verdict,
          confidence: action.qualityReview!.confidence,
          issues: action.qualityReview!.issues,
          ...(action.qualityReview!.polishTranslation
            ? { polishTranslation: action.qualityReview!.polishTranslation }
            : {}),
        },
      }
    : null;
  const toolNames = [...new Set(input.toolNames)].sort();
  const canonicalReasons = [...new Set(reasonCodes)].sort();
  const reviewHash = nativeBokDecisionReviewHash({
    state,
    customerReply,
    reasonCodes: canonicalReasons,
  });
  return nativeBokDecisionResultV3Schema.parse({
    schemaVersion: NATIVE_BOK_DECISION_RESULT_SCHEMA_VERSION,
    provider: NATIVE_BOK_PROVIDER,
    pipeline: NATIVE_BOK_DECISION_PIPELINE,
    pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
    storeIdentity: input.storeIdentity,
    sourceSnapshotHash: input.source.snapshotHash,
    state,
    customerReply,
    internalNote: input.output.reply,
    reasonCodes: canonicalReasons,
    attachmentEvidence: input.attachmentEvidence,
    provenance: {
      toolEvidenceHash: input.toolEvidenceHash,
      toolNames,
      reviewHash,
      policyHash: input.policyHash,
      playbookRevision: input.playbookRevision,
      correctionsRevision: input.correctionsRevision,
      storeIdentity: input.storeIdentity,
    },
    ...(input.guidanceReceipt ? { guidanceReceipt: input.guidanceReceipt } : {}),
    nonExecutableActions: input.output.proposedActions
      .filter((item): item is ProposedAction & { kind: Exclude<ProposedAction["kind"], "reply_customer"> } =>
        item.kind !== "reply_customer")
      .map((item) => ({ kind: item.kind, summary: item.summary, risk: item.risk })),
  });
}

export function buildNativeBokDecisionResultV4(
  input: NativeBokDecisionResultV4Input,
): NativeBokDecisionResultV4 {
  assertNativeBokAttachmentEvidenceBound(input.source, input.attachmentEvidence);
  if (
    input.guidanceReceipt
    && input.guidanceReceipt.externalTicketId !== input.source.externalTicketId
  ) {
    throw new Error("guidance_ticket_mismatch");
  }
  const replyActions = input.output.proposedActions.filter((action) => action.kind === "reply_customer");
  const customerReasons = decisionReasonCodes(
    input.output,
    replyActions,
    input.source.externalTicketId,
  );
  const customerReady = customerReasons.length === 1
    && customerReasons[0] === "reviewed_reply_ready";
  const approvedAction = approvedSharedAgentOperationalAction(input.operationalAction);
  const exclusiveReady = Number(customerReady) + Number(Boolean(approvedAction)) === 1;
  const state = exclusiveReady ? "ready" as const : "blocked" as const;
  const readyKind = state === "ready"
    ? customerReady ? "customer_reply" as const : "operational_action" as const
    : null;
  const action = readyKind === "customer_reply" ? replyActions[0]! : undefined;
  const customerReply = action && action.qualityReview?.verdict !== "blocked"
    ? {
        externalTicketId: input.source.externalTicketId,
        body: action.payload,
        qualityReview: {
          verdict: action.qualityReview!.verdict,
          confidence: action.qualityReview!.confidence,
          issues: action.qualityReview!.issues,
          ...(action.qualityReview!.polishTranslation
            ? { polishTranslation: action.qualityReview!.polishTranslation }
            : {}),
        },
      }
    : null;
  const reasonCodes: (typeof NATIVE_BOK_DECISION_V4_REASON_CODES)[number][] = state === "ready"
    ? [readyKind === "customer_reply" ? "reviewed_reply_ready" : "reviewed_action_ready"]
    : [
        ...(customerReady && approvedAction ? ["multiple_decisions" as const] : customerReasons),
        ...(input.operationalAction?.review.decision.verdict === "reject"
          ? ["operational_action_rejected" as const]
          : []),
      ];
  const canonicalReasons = [...new Set(reasonCodes)].sort();
  const toolNames = [...new Set(input.toolNames)].sort();
  const reviewHash = nativeBokDecisionReviewHashV4({
    state,
    readyKind,
    customerReply,
    operationalAction: input.operationalAction,
    reasonCodes: canonicalReasons,
  });
  return nativeBokDecisionResultV4Schema.parse({
    schemaVersion: NATIVE_BOK_DECISION_RESULT_V4_SCHEMA_VERSION,
    provider: NATIVE_BOK_PROVIDER,
    pipeline: NATIVE_BOK_DECISION_PIPELINE,
    pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
    storeIdentity: input.storeIdentity,
    sourceSnapshotHash: input.source.snapshotHash,
    state,
    readyKind,
    customerReply,
    operationalAction: input.operationalAction,
    internalNote: input.output.reply,
    reasonCodes: canonicalReasons,
    attachmentEvidence: input.attachmentEvidence,
    provenance: {
      toolEvidenceHash: input.toolEvidenceHash,
      toolNames,
      reviewHash,
      policyHash: input.policyHash,
      playbookRevision: input.playbookRevision,
      correctionsRevision: input.correctionsRevision,
      storeIdentity: input.storeIdentity,
    },
    ...(input.guidanceReceipt ? { guidanceReceipt: input.guidanceReceipt } : {}),
    nonExecutableActions: input.output.proposedActions
      .filter((item): item is ProposedAction & { kind: Exclude<ProposedAction["kind"], "reply_customer"> } =>
        item.kind !== "reply_customer")
      .map((item) => ({ kind: item.kind, summary: item.summary, risk: item.risk })),
  });
}

export function nativeBokDecisionReviewHash(input: {
  readonly state: "ready" | "blocked";
  readonly customerReply: NativeBokDecisionResultV3["customerReply"];
  readonly reasonCodes: readonly (typeof NATIVE_BOK_DECISION_REASON_CODES)[number][];
}): string {
  return nativeBokDecisionHash(input);
}

export function nativeBokDecisionReviewHashV4(input: {
  readonly state: "ready" | "blocked";
  readonly readyKind: "customer_reply" | "operational_action" | null;
  readonly customerReply: NativeBokDecisionResultV4["customerReply"];
  readonly operationalAction: NativeBokDecisionResultV4["operationalAction"];
  readonly reasonCodes: readonly (typeof NATIVE_BOK_DECISION_V4_REASON_CODES)[number][];
}): string {
  return nativeBokDecisionHash(input);
}

export function nativeBokDecisionHash(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function decisionReasonCodes(
  output: AgentTurnOutput,
  replyActions: ProposedAction[],
  externalTicketId: string,
): (typeof NATIVE_BOK_DECISION_REASON_CODES)[number][] {
  const reasons: (typeof NATIVE_BOK_DECISION_REASON_CODES)[number][] = [];
  if (replyActions.length === 0) reasons.push("no_customer_reply");
  if (replyActions.length > 1) reasons.push("multiple_customer_replies");
  const action = replyActions.length === 1 ? replyActions[0]! : undefined;
  if (action && !action.qualityReview) reasons.push("missing_quality_review");
  if (action?.qualityReview?.verdict === "blocked") reasons.push("quality_review_blocked");
  if (action && !targetMatchesExactDaktelaTicket(action.target, externalTicketId)) {
    reasons.push("ticket_binding_mismatch");
  }
  if (["needs_data", "waiting_for_human"].includes(output.caseState)) {
    reasons.push("case_requires_human");
  }
  if (reasons.length === 0) reasons.push("reviewed_reply_ready");
  return [...new Set(reasons)].sort();
}

function targetMatchesExactDaktelaTicket(target: string, externalTicketId: string): boolean {
  const references = [...target.matchAll(/(?:DAKTELA(?:\s+ticket)?|ticket)\s*#(\d+)/gi)]
    .map((match) => match[1]);
  return references.length > 0 && references.every((value) => value === externalTicketId);
}

function isCanonicalStrings(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("native_decision_result_number_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("native_decision_result_value_invalid");
}
