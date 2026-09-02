import assert from "node:assert/strict";
import { type Server } from "node:http";
import test from "node:test";
import {
  NATIVE_BOK_PROVIDER,
  NATIVE_BOK_RUNTIME,
  parseGeneratorOutput,
  parseJudgeOutput,
  TICKET_AI_GENERATOR_OUTPUT_JSON_SCHEMA,
  TICKET_AI_JUDGE_OUTPUT_JSON_SCHEMA,
  type TicketAiGeneratorOutput,
  type TicketAiJudgeOutput,
} from "../src/native-bok-contract.js";
import {
  buildNativeBokGeneratorPrompt,
  buildNativeBokJudgePrompt,
} from "../src/native-bok-inference.js";
import {
  TICKET_OPERATIONAL_ACTION_DEFINITIONS,
  TICKET_OPERATIONAL_ACTION_TYPES,
  operationalActionCatalogContract,
  operationalActionCatalogHash,
} from "../src/native-bok-operational-actions.js";
import { createNativeBokHttpServerForConfig } from "../src/native-bok-server.js";
import {
  NATIVE_BOK_CONTEXT,
  NATIVE_BOK_DRAFT,
  NATIVE_BOK_JUDGEMENT,
  NATIVE_BOK_KNOWLEDGE,
} from "./native-bok-fixtures.js";

const TOKEN = "native-bok-operational-actions-test-token";

const TYPED_REQUEST = {
  schemaVersion: 2,
  actionType: "fulfillment.locate",
  factKeys: ["order.status"],
} satisfies NonNullable<TicketAiGeneratorOutput["operationalActionRequest"]>;

const TYPED_DECISION = {
  schemaVersion: 2,
  actionType: "fulfillment.locate",
  verdict: "approve",
  reasonCodes: ["facts_verified", "intent_match"],
} satisfies NonNullable<TicketAiJudgeOutput["operationalActionDecision"]>;

function typedDraft(): TicketAiGeneratorOutput {
  return {
    ...structuredClone(NATIVE_BOK_DRAFT),
    operationalActionRequest: structuredClone(TYPED_REQUEST),
  };
}

function typedJudgement(): TicketAiJudgeOutput {
  return {
    ...structuredClone(NATIVE_BOK_JUDGEMENT),
    operationalActionDecision: structuredClone(TYPED_DECISION),
  };
}

test("legacy output bez pól operational v2 pozostaje kompatybilny i fail-closed", () => {
  const draft = parseGeneratorOutput(NATIVE_BOK_DRAFT, NATIVE_BOK_CONTEXT);
  const judgement = parseJudgeOutput(NATIVE_BOK_JUDGEMENT, draft);

  assert.equal("operationalActionRequest" in draft, false);
  assert.equal("operationalActionDecision" in judgement, false);
  assert.equal(parseGeneratorOutput({
    ...NATIVE_BOK_DRAFT,
    operationalActionRequest: null,
  }, NATIVE_BOK_CONTEXT).operationalActionRequest, null);
  assert.equal(parseJudgeOutput({
    ...NATIVE_BOK_JUDGEMENT,
    operationalActionDecision: null,
  }, draft).operationalActionDecision, null);
});

test("generator i niezależny judge zachowują zgodny typed request i decyzję", () => {
  const draft = parseGeneratorOutput(typedDraft(), NATIVE_BOK_CONTEXT);
  const judgement = parseJudgeOutput(typedJudgement(), draft);

  assert.deepEqual(draft.operationalActionRequest, TYPED_REQUEST);
  assert.deepEqual(judgement.operationalActionDecision, TYPED_DECISION);
  assert.equal(parseJudgeOutput({
    ...NATIVE_BOK_JUDGEMENT,
    operationalActionDecision: {
      ...TYPED_DECISION,
      verdict: "reject",
      reasonCodes: ["unsafe_action"],
    },
  }, draft).operationalActionDecision?.verdict, "reject");
});

test("request wymaga znanego, użytego i niepustego verifiedFact oraz zgodnej intencji", () => {
  assert.throws(() => parseGeneratorOutput({
    ...typedDraft(),
    operationalActionRequest: { ...TYPED_REQUEST, factKeys: ["order.unknown"] },
  }, NATIVE_BOK_CONTEXT), /generator_operational_fact_key_unknown/);

  assert.throws(() => parseGeneratorOutput({
    ...typedDraft(),
    operationalActionRequest: {
      ...TYPED_REQUEST,
      factKeys: ["shipment.tracking_number"],
    },
  }, NATIVE_BOK_CONTEXT), /generator_operational_fact_key_unused/);

  assert.throws(() => parseGeneratorOutput(typedDraft(), {
    ...NATIVE_BOK_CONTEXT,
    verifiedFacts: { ...NATIVE_BOK_CONTEXT.verifiedFacts, "order.status": "" },
  }), /generator_operational_fact_value_missing/);

  assert.throws(() => parseGeneratorOutput({
    ...typedDraft(),
    intent: "legal_privacy",
  }, NATIVE_BOK_CONTEXT), /generator_operational_intent_mismatch/);
});

test("strict request i decyzja odrzucają typ spoza enum oraz pola routingu lub tekst", () => {
  for (const [field, value] of [
    ["factsHash", "0".repeat(64)],
    ["handling", "team_escalation"],
    ["destination", "current_affairs"],
    ["logicalDestination", "current_affairs"],
    ["orderRequired", true],
    ["channelId", "1072488471895220244"],
    ["message", "wyślij na Discord"],
    ["task", "odnajdź paczkę"],
  ] as const) {
    assert.throws(() => parseGeneratorOutput({
      ...typedDraft(),
      operationalActionRequest: { ...TYPED_REQUEST, [field]: value },
    }, NATIVE_BOK_CONTEXT));
  }

  assert.throws(() => parseGeneratorOutput({
    ...typedDraft(),
    operationalActionRequest: { ...TYPED_REQUEST, actionType: "discord.free_text" },
  }, NATIVE_BOK_CONTEXT));
  assert.throws(() => parseJudgeOutput({
    ...typedJudgement(),
    operationalActionDecision: { ...TYPED_DECISION, message: "dowolny tekst" },
  }, typedDraft()));
});

test("judge nie może stworzyć akcji z body/internalNote/nextActions ani zmienić typu", () => {
  const proseOnly = parseGeneratorOutput({
    ...NATIVE_BOK_DRAFT,
    body: "Wstrzymamy zamówienie.",
    internalNote: "Wstrzymaj zamówienie.",
    nextActions: ["Wstrzymaj zamówienie i napisz na Discordzie."],
  }, NATIVE_BOK_CONTEXT);
  assert.throws(() => parseJudgeOutput(typedJudgement(), proseOnly),
    /judge_operational_action_unrequested/);

  assert.throws(() => parseJudgeOutput({
    ...typedJudgement(),
    operationalActionDecision: {
      ...TYPED_DECISION,
      actionType: "finance.verify_payment",
    },
  }, typedDraft()), /judge_operational_action_mismatch/);

  assert.throws(() => parseJudgeOutput({
    ...typedJudgement(),
    verdict: "human",
  }, typedDraft()), /judge_operational_action_outer_verdict_mismatch/);
});

test("akcja MasterLink jest typed, ale nie staje się eskalacją Discord", () => {
  const stopDraft = parseGeneratorOutput({
    ...NATIVE_BOK_DRAFT,
    intent: "cancellation",
    operationalActionRequest: {
      schemaVersion: 2,
      actionType: "order.stop",
      factKeys: ["order.status"],
    },
  }, NATIVE_BOK_CONTEXT);
  const stopJudge = parseJudgeOutput({
    ...NATIVE_BOK_JUDGEMENT,
    operationalActionDecision: {
      schemaVersion: 2,
      actionType: "order.stop",
      verdict: "approve",
      reasonCodes: ["facts_verified", "intent_match"],
    },
  }, stopDraft);

  assert.equal(stopJudge.operationalActionDecision?.actionType, "order.stop");
  assert.deepEqual(TICKET_OPERATIONAL_ACTION_DEFINITIONS["order.stop"], {
    actionType: "order.stop",
    label: "Wstrzymaj zamówienie",
    handling: "masterlink",
    destination: "masterlink",
    orderRequired: true,
    allowedAiIntents: ["cancellation"],
  });
});

test("reklamacja nie może utworzyć order.stop i kończy się fail-closed", () => {
  assert.throws(() => parseGeneratorOutput({
    ...NATIVE_BOK_DRAFT,
    intent: "complaint",
    operationalActionRequest: {
      schemaVersion: 2,
      actionType: "order.stop",
      factKeys: ["order.status"],
    },
  }, NATIVE_BOK_CONTEXT), /generator_operational_intent_mismatch/);
});

test("katalog i structured-output schema są dokładne i wymagają jawnego null", () => {
  assert.equal(TICKET_OPERATIONAL_ACTION_TYPES.length, 26);
  assert.deepEqual(new Set(Object.keys(TICKET_OPERATIONAL_ACTION_DEFINITIONS)),
    new Set(TICKET_OPERATIONAL_ACTION_TYPES));
  assert.ok(TICKET_AI_GENERATOR_OUTPUT_JSON_SCHEMA.required.includes(
    "operationalActionRequest",
  ));
  assert.ok(TICKET_AI_JUDGE_OUTPUT_JSON_SCHEMA.required.includes(
    "operationalActionDecision",
  ));
});

test("safety hash katalogu jest kanoniczny i nie zawiera pól UI ani channel ID", () => {
  const contract = operationalActionCatalogContract();
  const serialized = JSON.stringify(contract);
  const actionTypes = contract.actions.map(({ actionType }) => actionType);

  assert.equal(contract.schemaVersion, 2);
  assert.deepEqual(actionTypes, [...actionTypes].sort());
  for (const action of contract.actions) {
    assert.deepEqual(action.allowedAiIntents, [...action.allowedAiIntents].sort());
  }
  assert.doesNotMatch(serialized, /label|channelId|107248/);
  assert.match(operationalActionCatalogHash(), /^[a-f0-9]{64}$/);
  assert.equal(
    operationalActionCatalogHash(),
    "9c6f8e5341d775d05875fc29afda2911b4e2346e2fdb7c92f5983929d6ca0d6b",
  );
});

test("prompty wiążą typed request bez ujawnienia prywatnych pól judge", () => {
  const generatorPrompt = buildNativeBokGeneratorPrompt(
    NATIVE_BOK_CONTEXT,
    "wiedza",
    NATIVE_BOK_KNOWLEDGE,
  );
  const draft = {
    ...typedDraft(),
    internalNote: "PRYWATNY-BRIEF-TYPED-SENTINEL",
    nextActions: ["PRYWATNA-AKCJA-TYPED-SENTINEL"],
  };
  const judgePrompt = buildNativeBokJudgePrompt(
    NATIVE_BOK_CONTEXT,
    draft,
    "wiedza",
    NATIVE_BOK_KNOWLEDGE,
  );

  assert.match(generatorPrompt, /"actionType":"order\.stop"/);
  assert.match(generatorPrompt, /"handling":"masterlink"/);
  assert.match(generatorPrompt, /"logicalDestination":"masterlink"/);
  assert.match(generatorPrompt, /"orderRequired":true/);
  assert.match(generatorPrompt, /nigdy z wygenerowanych body,\s+internalNote ani nextActions/);
  assert.match(generatorPrompt, /Nie zwracaj factsHash/);
  assert.match(judgePrompt, /"operationalActionRequest":\{"schemaVersion":2/);
  assert.match(judgePrompt, /Nie wolno tworzyć akcji ani inferować jej z\s+publicznego body/);
  assert.doesNotMatch(judgePrompt, /PRYWATNY-BRIEF-TYPED-SENTINEL/);
  assert.doesNotMatch(judgePrompt, /PRYWATNA-AKCJA-TYPED-SENTINEL/);
});

test("HTTP nie wypuszcza mismatch decyzji zwróconej przez inference", async () => {
  const server = createNativeBokHttpServerForConfig({
    token: TOKEN,
    maxConcurrency: 1,
    timeoutMs: 2_000,
  }, {
    generatorModel: "codex-generator-test",
    judgeModel: "codex-judge-test",
    runtimeStatus() {
      return {
        schemaVersion: 1 as const,
        provider: NATIVE_BOK_PROVIDER,
        runtime: NATIVE_BOK_RUNTIME,
        store: {
          source: "shared-agent-store" as const,
          identity: "c".repeat(64),
        },
        corrections: {
          source: "verified-discord-corrections" as const,
          revision: 1,
          activeRules: 0,
          total: 0,
          truncated: false as const,
        },
        playbook: {
          source: "shared-agent-workspace" as const,
          revision: "b".repeat(64),
        },
        operationalActionCatalog: {
          schemaVersion: 2 as const,
          hash: operationalActionCatalogHash(),
        },
      };
    },
    async generate() {
      return typedDraft();
    },
    async judge() {
      return {
        ...typedJudgement(),
        operationalActionDecision: {
          ...TYPED_DECISION,
          actionType: "finance.verify_payment",
        },
      };
    },
  });
  const runtime = await listen(server);
  try {
    const response = await fetch(`${runtime.origin}/v1/bok/judge`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        context: NATIVE_BOK_CONTEXT,
        draft: typedDraft(),
        knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
      }),
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, error: "inference_failed" });
    assert.notEqual(response.headers.get("x-bok-provider"), NATIVE_BOK_PROVIDER);
  } finally {
    await runtime.close();
  }
});

async function listen(server: Server): Promise<{ origin: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
