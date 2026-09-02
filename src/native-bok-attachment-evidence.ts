import { createHash } from "node:crypto";
import { z } from "zod";
import {
  NATIVE_BOK_ATTACHMENT_POLICY_VERSION,
  NATIVE_BOK_DECISION_PIPELINE_HASH,
} from "./native-bok-decision-capability.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_DAKTELA_ID = /^[A-Za-z0-9_]{1,100}$/;
const SAFE_ATTACHMENT_ID = /^daktela-meta:[a-f0-9]{64}$/;
const MAX_FILE_NAME = 500;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_PDF_PAGES = 10;

const safeFileNameSchema = z.string().min(1).max(MAX_FILE_NAME).refine((value) =>
  value.normalize("NFC") === value
  && !value.includes("/")
  && !value.includes("\\")
  && ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  }), "attachment_file_name_invalid");

export const nativeBokAttachmentSourceItemSchema = z
  .object({
    messageId: z.string().uuid(),
    attachmentId: z.string().regex(SAFE_ATTACHMENT_ID),
    externalEventId: z.string().regex(SAFE_DAKTELA_ID),
    fileName: safeFileNameSchema,
    contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
    sizeBytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
    sourceHash: z.string().regex(SHA256),
  })
  .strict();

export const nativeBokDaktelaDecisionSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    pipelineHash: z.literal(NATIVE_BOK_DECISION_PIPELINE_HASH),
    system: z.literal("daktela"),
    externalTicketId: z.string().regex(SAFE_DAKTELA_ID),
    externalRevision: z.string().datetime({ offset: true }),
    triggerExternalEventId: z.string().regex(SAFE_DAKTELA_ID),
    latestInboundExternalEventId: z.string().regex(SAFE_DAKTELA_ID),
    queueExternalId: z.string().regex(SAFE_DAKTELA_ID),
    snapshotHash: z.string().regex(SHA256),
    attachments: z.array(nativeBokAttachmentSourceItemSchema).max(MAX_ATTACHMENTS),
  })
  .strict()
  .superRefine((source, issue) => {
    if (source.triggerExternalEventId !== source.latestInboundExternalEventId) {
      issue.addIssue({
        code: "custom",
        path: ["latestInboundExternalEventId"],
        message: "trigger_not_latest_inbound",
      });
    }
    const ordered = normalizedSourceAttachments(source.attachments);
    if (ordered.some((item, index) => item !== source.attachments[index])) {
      issue.addIssue({ code: "custom", path: ["attachments"], message: "attachments_not_canonical" });
    }
    const unique = new Set(source.attachments.map((attachment) => attachment.attachmentId));
    if (unique.size !== source.attachments.length) {
      issue.addIssue({ code: "custom", path: ["attachments"], message: "attachment_duplicate" });
    }
    const totalBytes = source.attachments.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (totalBytes > 50 * 1024 * 1024) {
      issue.addIssue({ code: "custom", path: ["attachments"], message: "attachment_total_too_large" });
    }
    if (source.snapshotHash !== nativeBokDaktelaSourceSnapshotHash(source)) {
      issue.addIssue({ code: "custom", path: ["snapshotHash"], message: "snapshot_hash_mismatch" });
    }
  });

export type NativeBokDaktelaDecisionSource = z.infer<
  typeof nativeBokDaktelaDecisionSourceSchema
>;
export type NativeBokAttachmentSourceItem = z.infer<
  typeof nativeBokAttachmentSourceItemSchema
>;

export const nativeBokAttachmentReadReceiptSchema = z
  .object({
    messageId: z.string().uuid(),
    attachmentId: z.string().regex(SAFE_ATTACHMENT_ID),
    externalEventId: z.string().regex(SAFE_DAKTELA_ID),
    sourceHash: z.string().regex(SHA256),
    mediaKind: z.enum(["image", "pdf"]),
    renderHashes: z.array(z.string().regex(SHA256)).min(1).max(MAX_PDF_PAGES),
    contentHash: z.string().regex(SHA256),
    status: z.literal("read"),
  })
  .strict()
  .superRefine((receipt, issue) => {
    const expected = nativeBokAttachmentContentHash({
      mediaKind: receipt.mediaKind,
      sourceHash: receipt.sourceHash,
      renderHashes: receipt.renderHashes,
    });
    if (receipt.contentHash !== expected) {
      issue.addIssue({ code: "custom", path: ["contentHash"], message: "content_hash_mismatch" });
    }
    if (receipt.mediaKind === "image" && receipt.renderHashes.length !== 1) {
      issue.addIssue({ code: "custom", path: ["renderHashes"], message: "image_render_count_invalid" });
    }
  });

export const nativeBokAttachmentEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.literal(NATIVE_BOK_ATTACHMENT_POLICY_VERSION),
    pipelineHash: z.literal(NATIVE_BOK_DECISION_PIPELINE_HASH),
    snapshotHash: z.string().regex(SHA256),
    evidenceHash: z.string().regex(SHA256),
    receipts: z.array(nativeBokAttachmentReadReceiptSchema).max(MAX_ATTACHMENTS),
  })
  .strict()
  .superRefine((evidence, issue) => {
    if (evidence.evidenceHash !== nativeBokAttachmentEvidenceHash(evidence)) {
      issue.addIssue({ code: "custom", path: ["evidenceHash"], message: "evidence_hash_mismatch" });
    }
  });

export type NativeBokAttachmentReadReceipt = z.infer<
  typeof nativeBokAttachmentReadReceiptSchema
>;
export type NativeBokAttachmentEvidence = z.infer<
  typeof nativeBokAttachmentEvidenceSchema
>;

export function nativeBokDaktelaSourceSnapshotHash(
  source: Omit<NativeBokDaktelaDecisionSource, "snapshotHash"> | NativeBokDaktelaDecisionSource,
): string {
  return sha256(canonical({
    schemaVersion: source.schemaVersion,
    pipelineHash: source.pipelineHash,
    system: source.system,
    externalTicketId: source.externalTicketId,
    externalRevision: source.externalRevision,
    triggerExternalEventId: source.triggerExternalEventId,
    latestInboundExternalEventId: source.latestInboundExternalEventId,
    queueExternalId: source.queueExternalId,
    attachments: source.attachments,
  }));
}

export function nativeBokAttachmentContentHash(input: {
  readonly mediaKind: "image" | "pdf";
  readonly sourceHash: string;
  readonly renderHashes: readonly string[];
}): string {
  return sha256(canonical(input));
}

export function nativeBokAttachmentEvidenceHash(
  evidence: Omit<NativeBokAttachmentEvidence, "evidenceHash"> | NativeBokAttachmentEvidence,
): string {
  return sha256(canonical({
    schemaVersion: evidence.schemaVersion,
    policyVersion: evidence.policyVersion,
    pipelineHash: evidence.pipelineHash,
    snapshotHash: evidence.snapshotHash,
    receipts: evidence.receipts,
  }));
}

export function assertNativeBokAttachmentEvidenceBound(
  source: NativeBokDaktelaDecisionSource,
  evidence: NativeBokAttachmentEvidence,
): void {
  if (evidence.snapshotHash !== source.snapshotHash) {
    throw new Error("attachment_evidence_snapshot_mismatch");
  }
  if (evidence.receipts.length !== source.attachments.length) {
    throw new Error("attachment_evidence_partial");
  }
  for (let index = 0; index < source.attachments.length; index += 1) {
    const expected = source.attachments[index]!;
    const actual = evidence.receipts[index]!;
    if (
      actual.messageId !== expected.messageId
      || actual.attachmentId !== expected.attachmentId
      || actual.externalEventId !== expected.externalEventId
      || actual.sourceHash !== expected.sourceHash
    ) {
      throw new Error("attachment_evidence_binding_mismatch");
    }
  }
}

function normalizedSourceAttachments(
  attachments: readonly NativeBokAttachmentSourceItem[],
): readonly NativeBokAttachmentSourceItem[] {
  return [...attachments].sort((left, right) =>
    left.messageId.localeCompare(right.messageId)
    || left.attachmentId.localeCompare(right.attachmentId));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("attachment_evidence_number_invalid");
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
  throw new Error("attachment_evidence_value_invalid");
}
