import { createHash } from "node:crypto";
import { z } from "zod";

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

export const NATIVE_BOK_KNOWLEDGE_SCHEMA_VERSION = 1 as const;
export const MAX_NATIVE_BOK_KNOWLEDGE_INTENTS = 3;
export const MAX_NATIVE_BOK_KNOWLEDGE_DOCUMENTS = 6;
export const MAX_NATIVE_BOK_KNOWLEDGE_DOCUMENT_CHARS = 8_000;
export const MAX_NATIVE_BOK_KNOWLEDGE_TOTAL_BYTES = 24_000;

const MARKETS = ["PL", "CZ", "SK", "HU", "RO", "EE", "LT", "DE"] as const;
const KNOWLEDGE_MARKETS = [...MARKETS, "GLOBAL"] as const;
const SAFE_SHA256 = /^[a-f0-9]{64}$/;

function nonBlank(maximum: number) {
  return z.string().min(1).max(maximum).refine((value) => value.trim() === value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("knowledge_canonical_number_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("knowledge_canonical_value_invalid");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const isoTimestamp = z.string().datetime({ offset: true });

const knowledgeDocumentSchema = z
  .object({
    documentId: nonBlank(100),
    revision: z.number().int().min(1),
    title: nonBlank(200),
    content: nonBlank(MAX_NATIVE_BOK_KNOWLEDGE_DOCUMENT_CHARS),
    contentHash: z.string().regex(SAFE_SHA256),
    markets: z.array(z.enum(KNOWLEDGE_MARKETS)).min(1).max(KNOWLEDGE_MARKETS.length),
    intents: z.array(z.enum(TICKET_AI_INTENTS)).min(1).max(TICKET_AI_INTENTS.length),
    reviewedAt: isoTimestamp,
    reviewDueAt: isoTimestamp,
    effectiveFrom: isoTimestamp,
    effectiveTo: isoTimestamp.nullable(),
  })
  .strict();

const knowledgeSnapshotBaseSchema = z
  .object({
    schemaVersion: z.literal(NATIVE_BOK_KNOWLEDGE_SCHEMA_VERSION),
    snapshotHash: z.string().regex(SAFE_SHA256),
    market: z.enum(MARKETS),
    selectedIntents: z
      .array(z.enum(TICKET_AI_INTENTS))
      .min(1)
      .max(MAX_NATIVE_BOK_KNOWLEDGE_INTENTS),
    documents: z.array(knowledgeDocumentSchema).max(MAX_NATIVE_BOK_KNOWLEDGE_DOCUMENTS),
  })
  .strict();

export type TicketAiKnowledgeSnapshot = z.infer<typeof knowledgeSnapshotBaseSchema>;
export type TicketAiKnowledgeSnapshotHashInput = Omit<TicketAiKnowledgeSnapshot, "snapshotHash">;

export function ticketAiKnowledgeSnapshotHash(
  value: TicketAiKnowledgeSnapshotHashInput,
): string {
  return sha256(canonicalJson(value));
}

function canonicalValues<T extends string>(values: readonly T[], order: readonly T[]): boolean {
  return new Set(values).size === values.length &&
    values.every((value, index) =>
      index === 0 || order.indexOf(values[index - 1]!) < order.indexOf(value),
    );
}

export const ticketAiKnowledgeSnapshotSchema = knowledgeSnapshotBaseSchema.superRefine(
  (snapshot, issue) => {
    const now = Date.now();
    if (
      !canonicalValues(snapshot.selectedIntents, TICKET_AI_INTENTS) ||
      (snapshot.selectedIntents.includes("other") && snapshot.selectedIntents.length !== 1)
    ) {
      issue.addIssue({ code: "custom", message: "knowledge_intents_invalid" });
    }

    const documentIds = new Set<string>();
    let totalBytes = 0;
    for (const document of snapshot.documents) {
      totalBytes += Buffer.byteLength(document.content, "utf8");
      if (documentIds.has(document.documentId)) {
        issue.addIssue({ code: "custom", message: "knowledge_document_duplicate" });
      }
      documentIds.add(document.documentId);
      if (
        !canonicalValues(document.markets, KNOWLEDGE_MARKETS) ||
        !canonicalValues(document.intents, TICKET_AI_INTENTS)
      ) {
        issue.addIssue({ code: "custom", message: "knowledge_document_scope_invalid" });
      }
      if (!document.markets.includes(snapshot.market) && !document.markets.includes("GLOBAL")) {
        issue.addIssue({ code: "custom", message: "knowledge_document_market_invalid" });
      }
      if (!document.intents.some((intent) => snapshot.selectedIntents.includes(intent))) {
        issue.addIssue({ code: "custom", message: "knowledge_document_intent_invalid" });
      }
      if (
        Buffer.byteLength(document.content, "utf8") > MAX_NATIVE_BOK_KNOWLEDGE_DOCUMENT_CHARS ||
        sha256(document.content) !== document.contentHash
      ) {
        issue.addIssue({ code: "custom", message: "knowledge_document_content_invalid" });
      }
      if (
        Date.parse(document.reviewedAt) > now ||
        Date.parse(document.reviewDueAt) <= now ||
        Date.parse(document.effectiveFrom) > now ||
        (document.effectiveTo !== null && Date.parse(document.effectiveTo) <= now)
      ) {
        issue.addIssue({ code: "custom", message: "knowledge_document_expired" });
      }
    }
    if (totalBytes > MAX_NATIVE_BOK_KNOWLEDGE_TOTAL_BYTES) {
      issue.addIssue({ code: "custom", message: "knowledge_snapshot_size_limit" });
    }

    const { snapshotHash, ...hashInput } = snapshot;
    if (ticketAiKnowledgeSnapshotHash(hashInput) !== snapshotHash) {
      issue.addIssue({ code: "custom", message: "knowledge_snapshot_hash_invalid" });
    }
  },
);

export function parseTicketAiKnowledgeSnapshot(
  value: unknown,
  expectedMarket: string,
): TicketAiKnowledgeSnapshot {
  const snapshot = ticketAiKnowledgeSnapshotSchema.parse(value);
  if (snapshot.market !== expectedMarket) throw new Error("knowledge_snapshot_market_mismatch");
  return snapshot;
}
