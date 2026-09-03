import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_NATIVE_BOK_INTERNAL_NOTE_CHARS,
  MAX_NATIVE_BOK_NEXT_ACTION_CHARS,
  MAX_NATIVE_BOK_NEXT_ACTIONS,
  nativeBokGenerateRequestSchema,
  nativeBokJudgeRequestSchema,
  parseGeneratorOutput,
  ticketAiGeneratorOutputSchema,
  ticketAiContextSchema,
} from "../src/native-bok-contract.js";
import {
  MAX_NATIVE_BOK_KNOWLEDGE_DOCUMENT_CHARS,
  ticketAiKnowledgeSnapshotHash,
  ticketAiKnowledgeSnapshotSchema,
} from "../src/native-bok-knowledge.js";
import {
  NATIVE_BOK_ATTACHMENT_CONTEXT,
  NATIVE_BOK_CONTEXT,
  NATIVE_BOK_DRAFT,
  NATIVE_BOK_KNOWLEDGE,
  NATIVE_BOK_MASTERLINK_OUTBOUND_CONTEXT,
} from "./native-bok-fixtures.js";

test("kontrakt generate i judge przyjmuje dokładny payload MasterLink", () => {
  assert.deepEqual(
    nativeBokGenerateRequestSchema.parse({
      context: NATIVE_BOK_CONTEXT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    }),
    { context: NATIVE_BOK_CONTEXT, knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE },
  );
  assert.deepEqual(
    nativeBokJudgeRequestSchema.parse({
      context: NATIVE_BOK_CONTEXT,
      draft: NATIVE_BOK_DRAFT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    }),
    {
      context: NATIVE_BOK_CONTEXT,
      draft: NATIVE_BOK_DRAFT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    },
  );
});

test("zarządzany snapshot jest wymagany, zgodny z rynkiem i weryfikowany po hashach", () => {
  // Publiczny wektor wyliczony przez kanoniczny hasher MasterLinka dla tego samego payloadu.
  assert.equal(
    NATIVE_BOK_KNOWLEDGE.snapshotHash,
    "8488352dfebd6ba88a451e38d78f00e3e25a765e7e4d2b3ca180f7a7a83c4825",
  );
  assert.throws(() => nativeBokGenerateRequestSchema.parse({ context: NATIVE_BOK_CONTEXT }));
  assert.throws(() => nativeBokGenerateRequestSchema.parse({
    context: NATIVE_BOK_CONTEXT,
    knowledgeSnapshot: { ...NATIVE_BOK_KNOWLEDGE, snapshotHash: "f".repeat(64) },
  }), /knowledge_snapshot_hash_invalid|knowledge_snapshot_invalid/);
  assert.throws(() => nativeBokGenerateRequestSchema.parse({
    context: NATIVE_BOK_CONTEXT,
    knowledgeSnapshot: { ...NATIVE_BOK_KNOWLEDGE, market: "CZ" },
  }), /knowledge_snapshot_hash_invalid|knowledge_snapshot_invalid/);

  const document = NATIVE_BOK_KNOWLEDGE.documents[0]!;
  const oversizedContent = "x".repeat(MAX_NATIVE_BOK_KNOWLEDGE_DOCUMENT_CHARS + 1);
  const oversized = {
    ...NATIVE_BOK_KNOWLEDGE,
    documents: [{ ...document, content: oversizedContent }],
  };
  const { snapshotHash: _oldHash, ...oversizedHashInput } = oversized;
  assert.throws(() => ticketAiKnowledgeSnapshotSchema.parse({
    ...oversizedHashInput,
    snapshotHash: ticketAiKnowledgeSnapshotHash(oversizedHashInput),
  }));
});

test("kontrakt jest strict i wymaga jawnego contextTruncated oraz polityki read-only", () => {
  const { contextTruncated: _removed, ...withoutTruncation } = NATIVE_BOK_CONTEXT;
  assert.throws(() => ticketAiContextSchema.parse(withoutTruncation));
  assert.throws(() => ticketAiContextSchema.parse({
    ...NATIVE_BOK_CONTEXT,
    unexpected: true,
  }));
  assert.throws(() => ticketAiContextSchema.parse({
    ...NATIVE_BOK_CONTEXT,
    policy: { ...NATIVE_BOK_CONTEXT.policy, tools: "write" },
  }));
});

test("consumer-first przyjmuje legacy bez plików i verified-text-v1", () => {
  assert.deepEqual(ticketAiContextSchema.parse(NATIVE_BOK_CONTEXT), NATIVE_BOK_CONTEXT);
  assert.deepEqual(
    ticketAiContextSchema.parse(NATIVE_BOK_ATTACHMENT_CONTEXT),
    NATIVE_BOK_ATTACHMENT_CONTEXT,
  );

  const legacyUnread = structuredClone(NATIVE_BOK_CONTEXT);
  legacyUnread.conversation[0]!.attachmentCount = 1;
  assert.throws(() => ticketAiContextSchema.parse(legacyUnread), /attachment_unread/);
});

test("outbound decision przyjmuje aktualny verified-content-v2 MasterLinka", () => {
  assert.deepEqual(
    ticketAiContextSchema.parse(NATIVE_BOK_MASTERLINK_OUTBOUND_CONTEXT),
    NATIVE_BOK_MASTERLINK_OUTBOUND_CONTEXT,
  );
  assert.throws(() => ticketAiContextSchema.parse({
    ...NATIVE_BOK_MASTERLINK_OUTBOUND_CONTEXT,
    attachmentCoverage: {
      ...NATIVE_BOK_MASTERLINK_OUTBOUND_CONTEXT.attachmentCoverage,
      policyVersion: "unknown-content-v3",
    },
  }));
});

test("załącznik binarny lub niepełne pokrycie blokuje request przed modelem", () => {
  const unread = structuredClone(NATIVE_BOK_ATTACHMENT_CONTEXT) as any;
  unread.conversation[0].attachments[0] = {
    ...unread.conversation[0].attachments[0],
    fileName: "dowod.jpg",
    contentType: "image/jpeg",
    status: "unsupported",
    extractor: null,
    text: null,
  };
  unread.attachmentCoverage.readCount = 0;
  unread.attachmentCoverage.operatorRequiredCount = 1;
  assert.throws(() => ticketAiContextSchema.parse(unread), /attachment_unread/);

  const incomplete = structuredClone(NATIVE_BOK_ATTACHMENT_CONTEXT) as any;
  incomplete.attachmentCoverage.totalCount = 2;
  incomplete.attachmentCoverage.operatorRequiredCount = 1;
  assert.throws(() => ticketAiContextSchema.parse(incomplete), /attachment_coverage_invalid/);
});

test("kontrakt promptu odrzuca wewnętrzne hashe i niezredagowane polskie PII", () => {
  const withHashes = structuredClone(NATIVE_BOK_ATTACHMENT_CONTEXT) as any;
  withHashes.conversation[0].attachments[0].sourceHash = "c".repeat(64);
  withHashes.conversation[0].attachments[0].textHash = "d".repeat(64);
  assert.throws(() => ticketAiContextSchema.parse(withHashes));

  for (const text of [
    "Telefon 500 600 700",
    "Rachunek 12 3456 7890 1234 5678 9012 3456",
  ]) {
    const payload = structuredClone(NATIVE_BOK_ATTACHMENT_CONTEXT) as any;
    payload.conversation[0].attachments[0].text = text;
    assert.throws(() => ticketAiContextSchema.parse(payload));
  }
});

test("generator nie może deklarować nieznanego ani zdublowanego klucza faktu", () => {
  assert.throws(() => parseGeneratorOutput({
    ...NATIVE_BOK_DRAFT,
    usedFactKeys: ["order.missing"],
  }, NATIVE_BOK_CONTEXT), /generator_fact_key_unknown/);
  assert.throws(() => parseGeneratorOutput({
    ...NATIVE_BOK_DRAFT,
    usedFactKeys: ["order.status", "order.status"],
  }, NATIVE_BOK_CONTEXT), /generator_fact_keys_duplicate/);
  assert.throws(() => parseGeneratorOutput({
    ...NATIVE_BOK_DRAFT,
    body: "x".repeat(20_001),
  }, NATIVE_BOK_CONTEXT));
});

test("generator wymaga osobnego prywatnego briefu i listy maksymalnie pięciu działań", () => {
  const { internalNote: _internalNote, ...withoutInternalNote } = NATIVE_BOK_DRAFT;
  const { nextActions: _nextActions, ...withoutNextActions } = NATIVE_BOK_DRAFT;

  assert.throws(() => ticketAiGeneratorOutputSchema.parse(withoutInternalNote));
  assert.throws(() => ticketAiGeneratorOutputSchema.parse(withoutNextActions));
  assert.throws(() => ticketAiGeneratorOutputSchema.parse({
    ...NATIVE_BOK_DRAFT,
    internalNote: "x".repeat(MAX_NATIVE_BOK_INTERNAL_NOTE_CHARS + 1),
  }));
  assert.throws(() => ticketAiGeneratorOutputSchema.parse({
    ...NATIVE_BOK_DRAFT,
    nextActions: Array.from({ length: MAX_NATIVE_BOK_NEXT_ACTIONS + 1 }, () => "Sprawdź sprawę."),
  }));
  assert.throws(() => ticketAiGeneratorOutputSchema.parse({
    ...NATIVE_BOK_DRAFT,
    nextActions: ["x".repeat(MAX_NATIVE_BOK_NEXT_ACTION_CHARS + 1)],
  }));
  assert.throws(() => ticketAiGeneratorOutputSchema.parse({
    ...NATIVE_BOK_DRAFT,
    unexpected: true,
  }));
});

test("kontekst większy niż budżet bridge jest odrzucany przed modelem", () => {
  const oversized = {
    ...NATIVE_BOK_CONTEXT,
    conversation: Array.from({ length: 6 }, (_, index) => ({
      ...NATIVE_BOK_CONTEXT.conversation[0]!,
      id: `message-${index}`,
      body: "x".repeat(90_000),
    })),
  };
  assert.throws(() => ticketAiContextSchema.parse(oversized));
});
