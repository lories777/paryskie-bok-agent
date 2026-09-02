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
import type { AgentTurnOutput, ProposedAction } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_DAKTELA_ID = /^[A-Za-z0-9_]{1,100}$/;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_INTERNAL_NOTE = 12_000;

export const NATIVE_BOK_DECISION_RESULT_SCHEMA_VERSION = 2 as const;
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
  })
  .strict()
  .superRefine((provenance, issue) => {
    if (!isCanonicalStrings(provenance.toolNames)) {
      issue.addIssue({ code: "custom", path: ["toolNames"], message: "tool_names_not_canonical" });
    }
    if (provenance.toolEvidenceHash !== nativeBokDecisionHash({
      toolNames: provenance.toolNames,
    })) {
      issue.addIssue({
        code: "custom",
        path: ["toolEvidenceHash"],
        message: "tool_evidence_hash_mismatch",
      });
    }
  });

export const nativeBokDecisionResultV2Schema = z
  .object({
    schemaVersion: z.literal(NATIVE_BOK_DECISION_RESULT_SCHEMA_VERSION),
    provider: z.literal(NATIVE_BOK_PROVIDER),
    pipeline: z.literal(NATIVE_BOK_DECISION_PIPELINE),
    pipelineHash: z.literal(NATIVE_BOK_DECISION_PIPELINE_HASH),
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
  });

export type NativeBokDecisionResultV2 = z.infer<typeof nativeBokDecisionResultV2Schema>;
export type NativeBokGuidanceReceipt = NonNullable<NativeBokDecisionResultV2["guidanceReceipt"]>;

export interface NativeBokDecisionResultInput {
  readonly output: AgentTurnOutput;
  readonly source: NativeBokDaktelaDecisionSource;
  readonly attachmentEvidence: NativeBokAttachmentEvidence;
  readonly toolNames: readonly string[];
  readonly policyHash: string;
  readonly playbookRevision: string;
  readonly correctionsRevision: number;
  readonly guidanceReceipt?: NativeBokGuidanceReceipt;
}

export function buildNativeBokDecisionResultV2(
  input: NativeBokDecisionResultInput,
): NativeBokDecisionResultV2 {
  assertNativeBokAttachmentEvidenceBound(input.source, input.attachmentEvidence);
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
  return nativeBokDecisionResultV2Schema.parse({
    schemaVersion: NATIVE_BOK_DECISION_RESULT_SCHEMA_VERSION,
    provider: NATIVE_BOK_PROVIDER,
    pipeline: NATIVE_BOK_DECISION_PIPELINE,
    pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
    sourceSnapshotHash: input.source.snapshotHash,
    state,
    customerReply,
    internalNote: input.output.reply,
    reasonCodes: canonicalReasons,
    attachmentEvidence: input.attachmentEvidence,
    provenance: {
      toolEvidenceHash: nativeBokDecisionHash({ toolNames }),
      toolNames,
      reviewHash,
      policyHash: input.policyHash,
      playbookRevision: input.playbookRevision,
      correctionsRevision: input.correctionsRevision,
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
  readonly customerReply: NativeBokDecisionResultV2["customerReply"];
  readonly reasonCodes: readonly (typeof NATIVE_BOK_DECISION_REASON_CODES)[number][];
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
