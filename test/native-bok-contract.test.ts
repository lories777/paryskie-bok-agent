import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeBokGenerateRequestSchema,
  nativeBokJudgeRequestSchema,
  parseGeneratorOutput,
  ticketAiContextSchema,
} from "../src/native-bok-contract.js";
import { NATIVE_BOK_CONTEXT, NATIVE_BOK_DRAFT } from "./native-bok-fixtures.js";

test("kontrakt generate i judge przyjmuje dokładny payload MasterLink", () => {
  assert.deepEqual(
    nativeBokGenerateRequestSchema.parse({ context: NATIVE_BOK_CONTEXT }),
    { context: NATIVE_BOK_CONTEXT },
  );
  assert.deepEqual(
    nativeBokJudgeRequestSchema.parse({ context: NATIVE_BOK_CONTEXT, draft: NATIVE_BOK_DRAFT }),
    { context: NATIVE_BOK_CONTEXT, draft: NATIVE_BOK_DRAFT },
  );
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
