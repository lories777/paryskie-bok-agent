import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  Input,
  RunResult,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";
import {
  BokCodexAgent,
  buildCodexConfigOverrides,
  buildPrimaryThreadOptions,
  CHROME_READ_ONLY_TOOLS,
  buildReviewerBusinessContext,
  buildVerifiedDeliveryPromiseFallback,
  attachMissingDaktelaIdentity,
  catalogSelectionIntegrityIssues,
  catalogRecommendationResolutionIssues,
  draftReviewIntegrityIssues,
  deliveryPromiseResolutionIssues,
  deliveryPromiseMustResolveWithoutHuman,
  extractExplicitOrderNumbers,
  assertDaktelaTicketIntegrity,
  correctionEscalationIsActionable,
  correctionRequiresCustomerDraft,
  customerIntentText,
  daktelaTicketIntegrityIssues,
  extractOrderNumbers,
  filterSharedContextForJob,
  formatVerifiedToolEvidence,
  hasRequiredMasterlinkRead,
  hasRequiredMasterlinkReads,
  holdingReplyIntegrityIssues,
  latestDaktelaActivityWasSubstantiveOutgoing,
  requireAllegroClaimDetailsBeforeDecision,
  requireFulfillmentResolutionBeforeCustomerPromise,
  requireStandardReshipmentForConfirmedMissingProduct,
  requiredMasterlinkResearch,
  suppressReplyAfterSubstantiveOutgoing,
} from "../src/codex-agent.js";
import { BokAgentCore } from "../src/bok-agent-core.js";
import { loadConfig } from "../src/config.js";
import { AgentStore } from "../src/store.js";
import type { AgentTurnOutput, ClaimedJob, StoredMessage } from "../src/types.js";

const message: StoredMessage = {
  id: 1,
  conversationId: 1,
  role: "context",
  authorId: "daktela-monitor",
  authorName: "Daktela",
  content: "Klient pyta, czy dobrze podał punkt odbioru dla zamówienia 480033739.",
  createdAt: "2026-08-26T15:00:00.000Z",
};

const output: AgentTurnOutput = {
  reply: "Mam draft.",
  caseState: "action_proposed",
  proposedActions: [{
    kind: "reply_customer",
    summary: "Odpowiedź",
    target: "Daktela ticket #99545",
    payload: "Dzień dobry, proszę podać punkt.",
    reason: "Brak danych",
    risk: "low",
  }],
  learnedRules: [],
  actionExecution: null,
};

const daktelaJob: ClaimedJob = {
  id: 130,
  publicId: "BOK-000130",
  conversationId: 1270,
  triggerMessageId: 1387,
  platform: "discord",
  channelId: "1542184333916372992",
  externalMessageId: "daktela:v6:99570:e9f53df915ac1fab",
  attempts: 1,
};

class ScriptedCodexClient {
  readonly inputs: Input[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: Array<{
    finalResponse: string;
    items?: ThreadItem[];
  }>) {}

  startThread(_options?: ThreadOptions) { return this.thread(); }
  resumeThread(_id: string, _options?: ThreadOptions) { return this.thread(); }

  private thread() {
    return {
      id: "019c-delivery-fallback-test",
      run: async (input: Input, _options?: TurnOptions): Promise<RunResult> => {
        this.inputs.push(structuredClone(input));
        const response = this.responses[this.responseIndex++];
        if (!response) throw new Error("unexpected scripted Codex call");
        return {
          finalResponse: response.finalResponse,
          items: response.items ?? [],
          usage: null,
        };
      },
    };
  }
}

test("worker i native HTTP używają tej samej instancji BokAgentCore", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-shared-core-"));
  const store = new AgentStore(dir);
  try {
    const core = new BokAgentCore(loadConfig({ BOK_AGENT_STATE_DIR: dir }, dir), store);
    const agent = new BokCodexAgent(core);
    assert.equal(agent.core, core);
    assert.equal(agent.nativeInference.core, core);
    assert.equal(agent.nativeInference.core.store, store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("primary, reviewer i native mają jeden wybór modelu oraz reasoning z core", () => {
  const core = new BokAgentCore(loadConfig({
    BOK_AGENT_MODEL: "gpt-5.6-sol",
    BOK_AGENT_REASONING_EFFORT: "high",
  }, "/tmp/paryskie-bok-agent"), {
    activeLearnedRules: () => [],
    activeVerifiedHumanCorrections: () => ({
      revision: 0, total: 0, truncated: false, corrections: [],
    }),
  } as unknown as AgentStore);
  const primary = core.primaryThreadOptions();
  const reviewer = core.reviewerThreadOptions();
  const native = core.nativeThreadOptions("test-native");
  assert.equal(primary.model, core.model);
  assert.equal(reviewer.model, core.model);
  assert.equal(native.model, core.model);
  assert.equal(primary.modelReasoningEffort, "high");
  assert.equal(reviewer.modelReasoningEffort, "high");
  assert.equal(native.modelReasoningEffort, "high");

  const managed = new BokAgentCore(loadConfig({}, "/tmp/paryskie-bok-agent"), {
    activeLearnedRules: () => [],
    activeVerifiedHumanCorrections: () => ({
      revision: 0, total: 0, truncated: false, corrections: [],
    }),
  } as unknown as AgentStore);
  assert.equal(managed.primaryThreadOptions().model, undefined);
  assert.equal(managed.reviewerThreadOptions().model, undefined);
  assert.equal(managed.nativeThreadOptions("test-native").model, undefined);
});

test("reviewer dostaje procedury BOK obok danych konkretnego zamówienia", () => {
  const context = buildReviewerBusinessContext(
    "Zamówienie 480032521 jest doręczone.",
    "Zwrot należy wysłać na ul. Leśną 44.",
  );
  assert.match(context, /<masterlink_snapshot>/);
  assert.match(context, /Zamówienie 480032521 jest doręczone/);
  assert.match(context, /<verified_bok_playbook>/);
  assert.match(context, /Zwrot należy wysłać na ul\. Leśną 44/);
});

test("reviewer zawsze dostaje wydzielony katalog nawet za długim snapshotem MasterLink", () => {
  const context = buildReviewerBusinessContext(
    `${"x".repeat(30_000)}\n\nParyskie katalog: ZWERYFIKOWANE\nNAMED_CATALOG_MATCH number=652 terms=prada`,
    "Reguły BOK",
  );
  assert.match(context, /<verified_product_catalog>/);
  assert.match(context, /NAMED_CATALOG_MATCH number=652 terms=prada/);
});

test("Chrome udostępnia wyłącznie techniczną allowlistę inspekcji read-only", () => {
  const overrides = buildCodexConfigOverrides({ browserResearchEnabled: true });
  assert.ok(overrides.includes("mcp_servers.chrome-devtools.required=true"));
  assert.ok(overrides.includes('mcp_servers.chrome-devtools.default_tools_approval_mode="approve"'));
  assert.ok(overrides.includes(
    `mcp_servers.chrome-devtools.enabled_tools=${JSON.stringify(CHROME_READ_ONLY_TOOLS)}`,
  ));
  for (const forbidden of [
    "click",
    "fill",
    "fill_form",
    "press_key",
    "evaluate_script",
    "new_page",
    "navigate_page",
    "upload_file",
    "get_network_request",
    "list_network_requests",
    "get_console_message",
    "list_console_messages",
  ]) {
    assert.equal(CHROME_READ_ONLY_TOOLS.includes(forbidden as never), false);
  }
  assert.equal(buildPrimaryThreadOptions({
    workspacePath: "/tmp/project",
    reasoningEffort: "medium",
    browserResearchEnabled: true,
  }).networkAccessEnabled, false);
});

test("udany odczyt lokalnego katalogu trafia do dowodów reviewera", () => {
  const evidence = formatVerifiedToolEvidence([{
    id: "catalog-1",
    type: "command_execution",
    command: "node tools/paryskie-knowledge.mjs product 340",
    aggregated_output: '{"products":[{"number":"340","inStock":true}]}',
    exit_code: 0,
    status: "completed",
  }]);
  assert.match(evidence ?? "", /local_paryskie_knowledge/);
  assert.match(evidence ?? "", /340/);
});

test("tekst komendy udający Chrome nie jest uznawany za zweryfikowany dowód", () => {
  const evidence = formatVerifiedToolEvidence([{
    id: "chrome-1",
    type: "command_execution",
    command: "const r = await tools.mcp__chrome_devtools__take_snapshot({pageId:3});",
    aggregated_output: "kod 7LAT: cztery zapachy, najtańszy za 1 grosz",
    status: "completed",
  }]);
  assert.equal(evidence, undefined);
});

test("tekstowy wynik MCP Chrome trafia do reviewera, gdy structured_content jest null", () => {
  const evidence = formatVerifiedToolEvidence([{
    id: "chrome-mcp-1",
    type: "mcp_tool_call",
    server: "chrome-devtools",
    tool: "take_snapshot",
    arguments: { verbose: false },
    result: {
      structured_content: null,
      content: [{ type: "text", text: "7LAT: cztery zapachy, najtańszy za 1 grosz" }],
    },
    status: "completed",
  }]);
  assert.match(evidence ?? "", /authenticated_chrome_read/);
  assert.match(evidence ?? "", /cztery zapachy/);
  assert.match(evidence ?? "", /1 grosz/);
});

test("wynik mutującego narzędzia Chrome nie może zostać dowodem reviewera", () => {
  const evidence = formatVerifiedToolEvidence([{
    id: "chrome-mcp-unsafe",
    type: "mcp_tool_call",
    server: "chrome-devtools",
    tool: "evaluate_script",
    arguments: { function: "() => fetch('/send', {method: 'POST'})" },
    result: { structured_content: { ok: true }, content: [] },
    status: "completed",
  }]);
  assert.equal(evidence, undefined);
});

test("integrity gate blokuje obcy bestseller przy nazwanej marce", () => {
  const action = {
    ...output.proposedActions[0]!,
    payload: "Dzień dobry, wybierzemy N°340 inspirowane Good Girl.",
  };
  const context = [
    "<catalog_named_matches>",
    "NAMED_CATALOG_MATCH number=652 terms=prada",
    "</catalog_named_matches>",
  ].join("\n");
  assert.deepEqual(catalogSelectionIntegrityIssues(action, context), [
    "Klient nazwał markę lub oryginał, a katalog wskazuje N°652 (prada); draft wybrał niepasujący numer N°340.",
  ]);
  assert.deepEqual(catalogSelectionIntegrityIssues({
    ...action,
    payload: "Dzień dobry, wybierzemy N°652 inspirowane Prada Paradoxe.",
  }, context), []);
  assert.match(draftReviewIntegrityIssues({
    ...action,
    payload: "Dzień dobry, wybierzemy N°652 inspirowane Prada Paradoxe.",
  }, {
    verdict: "revised",
    revisedPayload: "Dzień dobry, wybierzemy N°250 inspirowane Black Opium.",
    issues: ["Skrócono odpowiedź"],
    confidence: "high",
    polishTranslation: null,
  }, context)[0] ?? "", /Kontroler jakości próbował zmienić poprawnie dopasowany produkt/);
});

test("jednoznaczne dopasowanie katalogu wymusza draft zamiast pytania do BOK", () => {
  const context = "NAMED_CATALOG_MATCH number=652 terms=prada";
  assert.match(catalogRecommendationResolutionIssues({
    ...output,
    reply: "Czy wybrać N°652?",
    proposedActions: [],
  }, context)[0] ?? "", /przygotuj gotowy draft/);
  assert.deepEqual(catalogRecommendationResolutionIssues({
    ...output,
    proposedActions: [{ ...output.proposedActions[0]!, payload: "Wybierzemy N°652." }],
  }, context), []);
});

test("ręczna odpowiedź wychodząca BOK blokuje duplikat draftu", () => {
  const messages: StoredMessage[] = [{
    ...message,
    content: `<customer_history untrusted="true">
      <customer_activity index="1" direction="outgoing">User: Klaudia Drelich Dzień dobry, wybieramy N°652.</customer_activity>
      <customer_activity index="2" direction="incoming">Klientka prosi o Prada.</customer_activity>
    </customer_history>`,
  }];
  assert.equal(latestDaktelaActivityWasSubstantiveOutgoing(messages), true);
  const suppressed = suppressReplyAfterSubstantiveOutgoing(messages, output);
  assert.equal(suppressed.caseState, "answered");
  assert.equal(suppressed.proposedActions.some((action) => action.kind === "reply_customer"), false);
});

test("ciche zamknięcie po odpowiedzi BOK zachowuje tożsamość bieżącego ticketu", () => {
  const messages = [{
    ...message,
    content: '<customer_history><customer_activity index="1" direction="outgoing">User: Klaudia\nOdpowiedź wysłana</customer_activity></customer_history>',
  }];
  const suppressed = attachMissingDaktelaIdentity(
    daktelaJob,
    suppressReplyAfterSubstantiveOutgoing(messages, output),
    "daktela-ticket:99570",
  );
  assert.match(suppressed.reply, /DAKTELA #99570/i);
  assert.doesNotThrow(() => assertDaktelaTicketIntegrity(daktelaJob, suppressed, "daktela-ticket:99570"));
});

test("autoresponder outgoing nie zamyka realnej wiadomości klienta", () => {
  const messages: StoredMessage[] = [{
    ...message,
    content: `<customer_history untrusted="true">
      <customer_activity index="1" direction="outgoing">User: - Wiadomość została odebrana. Standardowy czas odpowiedzi wynosi 24 godziny.</customer_activity>
      <customer_activity index="2" direction="incoming">Klient prosi o pomoc.</customer_activity>
    </customer_history>`,
  }];
  assert.equal(latestDaktelaActivityWasSubstantiveOutgoing(messages), false);
  assert.equal(suppressReplyAfterSubstantiveOutgoing(messages, output), output);
});

test("estoński autoresponder z User: - nie kasuje przygotowanego draftu", () => {
  const messages: StoredMessage[] = [{
    ...message,
    content: `<customer_history untrusted="true">
      <customer_activity index="1" direction="outgoing">User: - Duration: 0, Direction: Outgoing Teie sõnum on kätte saadud. Tavapärane vastamisaeg on 24 tundi.</customer_activity>
      <customer_activity index="2" direction="incoming">Tellimus pidi jõudma varem. Palun selgitage viivitust.</customer_activity>
    </customer_history>`,
  }];
  assert.equal(latestDaktelaActivityWasSubstantiveOutgoing(messages), false);
  assert.equal(suppressReplyAfterSubstantiveOutgoing(messages, output), output);
});

test("User: - bez znanej frazy automatu nadal nie udaje pracownika BOK", () => {
  const messages: StoredMessage[] = [{
    ...message,
    content: `<customer_history><customer_activity index="1" direction="outgoing">User:    - Duration: 0, Direction: Outgoing Kinnitame kirja saabumist.</customer_activity></customer_history>`,
  }];
  assert.equal(latestDaktelaActivityWasSubstantiveOutgoing(messages), false);
});

test("automat Allegro bez opisu reklamacji wymusza odczyt szczegółów przed decyzją", () => {
  const messages: StoredMessage[] = [{
    ...message,
    content: `<customer_history untrusted="true"><customer_activity index="1" direction="incoming">
      Dzień dobry, masz nową reklamację. Nr reklamacji: claim-123. SZCZEGÓŁY REKLAMACJI.
      Wiadomość została wysłana automatycznie, dlatego na nią nie odpowiadaj. PRZEJDŹ DO REKLAMACJI.
    </customer_activity></customer_history>`,
  }];
  const premature: AgentTurnOutput = {
    ...output,
    reply: "Czy wybieramy odbiór towaru, czy rozpatrzenie bez odsyłania?",
    caseState: "waiting_for_human",
    proposedActions: [],
  };
  const guarded = requireAllegroClaimDetailsBeforeDecision(
    daktelaJob,
    messages,
    premature,
    [],
    "daktela-ticket:99570",
  );
  assert.match(guarded.reply, /DAKTELA #99570/i);
  assert.match(guarded.reply, /Otwórz szczegóły reklamacji Allegro/i);
  assert.doesNotMatch(guarded.reply, /odbiór towaru|bez odsyłania/i);
  assert.equal(guarded.caseState, "action_proposed");
});

test("ogólne zapewnienie o zapoznaniu się z Allegro nie zastępuje konkretnego problemu", () => {
  const messages: StoredMessage[] = [{
    ...message,
    content: `<customer_history><customer_activity index="1" direction="incoming">
      Masz nową reklamację. Nr reklamacji: claim-123. SZCZEGÓŁY REKLAMACJI. PRZEJDŹ DO REKLAMACJI.
      Wiadomość została wysłana automatycznie, dlatego na nią nie odpowiadaj.
    </customer_activity></customer_history>`,
  }];
  const vague: AgentTurnOutput = {
    ...output,
    reply: "Po zapoznaniu się ze zgłoszeniem i dowodami kupującego: czy uznajemy reklamację, czy ją odrzucamy?",
    caseState: "waiting_for_human",
    proposedActions: [],
  };
  const guarded = requireAllegroClaimDetailsBeforeDecision(
    daktelaJob,
    messages,
    vague,
    [],
    "daktela-ticket:99570",
  );
  assert.match(guarded.reply, /Otwórz szczegóły reklamacji Allegro/i);
  assert.doesNotMatch(guarded.reply, /czy uznajemy/i);
});

test("pusta próbka ma standardową bezpłatną dosyłkę bez pytania BOK o wybór", () => {
  const messages: StoredMessage[] = [{
    ...message,
    content: `<customer_history><customer_activity direction="incoming">
      Order number 372495998. Soovin tagastada ebasobivad. Parfüüm 548- oli täiesti tühi pudel.
      Returned products: N° 548 - 1.8 ml.
    </customer_activity></customer_history>`,
  }];
  const undecided: AgentTurnOutput = {
    ...output,
    reply: "**Tłumaczenie z estońskiego:** Klientka zgłasza, że próbka N° 548 była pusta.\nCzy pustą próbkę dosyłamy, czy zwracamy jej wartość?",
    caseState: "waiting_for_human",
    proposedActions: [],
  };
  const guarded = requireStandardReshipmentForConfirmedMissingProduct(
    daktelaJob,
    messages,
    undecided,
    "daktela-ticket:99570",
  );
  assert.match(guarded.reply, /DAKTELA #99570/i);
  assert.match(guarded.reply, /Tłumaczenie z estońskiego/i);
  assert.match(guarded.reply, /Przygotuj bezpłatną dosyłkę próbki N° 548/i);
  assert.match(guarded.reply, /zamówienia 372495998/i);
  assert.doesNotMatch(guarded.reply, /\?/);
  assert.equal(guarded.caseState, "action_proposed");
});

test("źle oznaczony autoresponder nie chowa wcześniejszego potwierdzonego braku", () => {
  const messages: StoredMessage[] = [
    {
      ...message,
      role: "agent",
      content: "**Daktela #99570**\n\n**Tłumaczenie z estońskiego:** Klientka zgłasza pustą próbkę N° 548.",
    },
    {
      ...message,
      id: 2,
      content: `<customer_history>
      <customer_activity index="1" direction="incoming">Teie sõnum on kätte saadud. Tavapärane vastamisaeg on 24 tundi.</customer_activity>
      <customer_activity index="2" direction="incoming">Order number 372495998. Parfüüm 548 oli täiesti tühi pudel. N° 548 - 1.8 ml.</customer_activity>
    </customer_history>`,
    },
  ];
  const guarded = requireStandardReshipmentForConfirmedMissingProduct(
    daktelaJob,
    messages,
    { ...output, reply: "Ostatnia aktywność to autoresponder bez nowej treści klienta.", caseState: "answered", proposedActions: [] },
    "daktela-ticket:99570",
  );
  assert.match(guarded.reply, /bezpłatną dosyłkę próbki N° 548/i);
  assert.match(guarded.reply, /Tłumaczenie z estońskiego/i);
  assert.equal(guarded.caseState, "action_proposed");
});

test("agent nie obiecuje klientowi odblokowania realizacji przed wykonaniem operacji", () => {
  const premature: AgentTurnOutput = {
    ...output,
    reply: "Daktela #100023 · gotowe\nPaczka nie została nadana; trzeba pilnie odblokować zamówienie i potwierdzić termin nadania.",
    proposedActions: [{
      ...output.proposedActions[0]!,
      payload: "Dzień dobry, pilnie zajmiemy się odblokowaniem realizacji. Po utworzeniu przesyłki otrzymają Państwo potwierdzenie.",
    }],
  };
  const guarded = requireFulfillmentResolutionBeforeCustomerPromise(
    { ...daktelaJob, externalMessageId: "daktela:v6:100023:abc" },
    premature,
    "daktela-ticket:100023",
  );
  assert.equal(guarded.proposedActions.some((action) => action.kind === "reply_customer"), false);
  assert.match(guarded.reply, /odblokować zamówienie/i);
  assert.doesNotMatch(guarded.reply, /gotowe/i);
  assert.equal(guarded.caseState, "action_proposed");
});

test("ticket z numerem i pytaniem o punkt wymaga dokładnego odczytu dostawy", () => {
  assert.deepEqual(extractOrderNumbers([message]), ["480033739"]);
  assert.deepEqual(requiredMasterlinkResearch([message], output), {
    orderNumbers: ["480033739"],
    requiredTools: ["ml_get_delivery_details"],
  });
});

test("claim o zamówieniu do 19:00 i dostawie jutro wymaga przewoźnika oraz przesyłek", () => {
  const deliveryPromiseComplaint: StoredMessage = {
    ...message,
    content: "Zamówienie 480033739 złożyłam do 19:00. Miało być jutro, a nadal go nie ma.",
  };
  assert.deepEqual(requiredMasterlinkResearch([deliveryPromiseComplaint], output), {
    orderNumbers: ["480033739"],
    requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
  });
  assert.deepEqual(requiredMasterlinkResearch([deliveryPromiseComplaint], {
    ...output,
    caseState: "answered",
    proposedActions: [],
  }), {
    orderNumbers: ["480033739"],
    requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
  });
  assert.deepEqual(requiredMasterlinkResearch([{
    ...deliveryPromiseComplaint,
    content: "Zamówienie 480033739 miało dotrzeć następnego dnia, ale nadal go nie ma.",
  }], output), {
    orderNumbers: ["480033739"],
    requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
  });

  const continuedHistory: StoredMessage = {
    ...deliveryPromiseComplaint,
    content: `<customer_history>
      <customer_activity index="1" direction="incoming">Zamówienie 480033739 złożyłam do 19:00, miało być jutro i nadal go nie ma.</customer_activity>
      <customer_activity index="2" direction="incoming">Stare zamówienie 480011111 miało dotrzeć jutro.</customer_activity>
    </customer_history>`,
  };
  assert.deepEqual(requiredMasterlinkResearch([continuedHistory], output), {
    orderNumbers: ["480033739"],
    requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
  });
  const followUpHistory: StoredMessage = {
    ...continuedHistory,
    content: `<customer_history>
      <customer_activity index="1" direction="incoming">Nadal jej nie ma — co dalej?</customer_activity>
      <customer_activity index="2" direction="incoming">Zamówienie 480033739 złożyłam do 19:00 i miało być jutro.</customer_activity>
    </customer_history>`,
  };
  assert.deepEqual(requiredMasterlinkResearch([followUpHistory], output), {
    orderNumbers: ["480033739"],
    requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
  });
  const changedIntent: StoredMessage = {
    ...continuedHistory,
    content: `<customer_history>
      <customer_activity index="1" direction="incoming">Chcę zwrócić perfumy z zamówienia 480033739.</customer_activity>
      <customer_activity index="2" direction="incoming">Zamówienie 480011111 miało dotrzeć jutro.</customer_activity>
    </customer_history>`,
  };
  assert.deepEqual(requiredMasterlinkResearch([changedIntent], output), {
    orderNumbers: ["480033739", "480011111"],
    requiredTools: ["any_read"],
  });
  for (const newIntent of [
    "Proszę o informację, kiedy otrzymam zwrot środków.",
    "Proszę o odpowiedź w sprawie faktury.",
    "Proszę o informację dotyczącą uszkodzonego flakonu.",
  ]) {
    const staleDeliveryContext: StoredMessage = {
      ...continuedHistory,
      content: `<customer_history>
        <customer_activity index="1" direction="incoming">${newIntent}</customer_activity>
        <customer_activity index="2" direction="incoming">Zamówienie 480033739 złożyłam do 19:00 i miało być jutro.</customer_activity>
      </customer_history>`,
    };
    assert.notDeepEqual(requiredMasterlinkResearch([staleDeliveryContext], output), {
      orderNumbers: ["480033739"],
      requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
    }, newIntent);
  }
  for (const otherOrderFollowUp of [
    "Jaki jest status zamówienia 480099999?",
    "Nadal nie ma paczki z zamówienia 480099999.",
  ]) {
    const crossOrderFollowUp: StoredMessage = {
      ...continuedHistory,
      content: `<customer_history>
        <customer_activity index="1" direction="incoming">${otherOrderFollowUp}</customer_activity>
        <customer_activity index="2" direction="incoming">Zamówienie 480033739 złożyłam do 19:00 i miało dotrzeć jutro.</customer_activity>
      </customer_history>`,
    };
    assert.notDeepEqual(requiredMasterlinkResearch([crossOrderFollowUp], output), {
      orderNumbers: ["480099999"],
      requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
    }, otherOrderFollowUp);
    assert.equal(buildVerifiedDeliveryPromiseFallback(
      daktelaJob,
      [crossOrderFollowUp],
      output,
      undefined,
    ), null);
  }
  const orderOnlyInTitle: StoredMessage = {
    ...continuedHistory,
    content: `Tytuł: Zamówienie 480033739
      <customer_history>
        <customer_activity index="1" direction="incoming">Zamówiłam do 19:00, miało być jutro, ale paczki nadal nie ma.</customer_activity>
        <customer_activity index="2" direction="incoming">Dzień dobry.</customer_activity>
      </customer_history>`,
  };
  assert.deepEqual(requiredMasterlinkResearch([orderOnlyInTitle], output), {
    orderNumbers: ["480033739"],
    requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
  });
  for (const unrelatedTomorrow of [
    "Zamówienie 480033739: czy mogę odebrać paczkę jutro?",
    "Kurier umówił dostawę na jutro. Czy mogę zmienić adres zamówienia 480033739?",
    "Zamówienie 480033739 złożyłam o 19:00. Czy mogę zmienić produkt?",
    "Proszę przekierować paczkę z zamówienia 480033739 jutro.",
    "DPD napisał, że paczka miała dotrzeć jutro, ale nie dotarła. Zamówienie 480033739.",
    "Kurier zapewnił, że przesyłka miała być jutro, ale nadal jej nie ma. Zamówienie 480033739.",
    "W śledzeniu DPD wskazano dostawę jutro, ale paczka nie dotarła. Zamówienie 480033739.",
    "Paczka miała dotrzeć jutro według DPD, ale nie dotarła. Zamówienie 480033739.",
    "Według kuriera przesyłka miała być jutro, ale nadal jej nie ma. Zamówienie 480033739.",
    "DPD podało termin dostawy. Paczka miała dotrzeć jutro, ale nie dotarła. Zamówienie 480033739.",
    "Termin pochodzi ze śledzenia DPD. Przesyłka miała być jutro, ale nadal jej nie ma. Zamówienie 480033739.",
  ]) {
    assert.notDeepEqual(requiredMasterlinkResearch([{ ...message, content: unrelatedTomorrow }], output), {
      orderNumbers: ["480033739"],
      requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
    });
  }
  for (const storePromiseAfterCarrierContext of [
    "DPD podało status przesyłki. Zamówienie 480033739 złożyłam do 19:00 i miało być jutro, ale nadal go nie ma.",
    "DPD napisało do mnie. Zamówienie 480033739 złożyłam do 19:00 i miało być jutro, ale nadal go nie ma.",
    "Według DPD paczka jest w sortowni. Zamówienie 480033739 złożyłam do 19:00 i miało być jutro, ale nadal go nie ma.",
  ]) {
    assert.deepEqual(requiredMasterlinkResearch([{ ...message, content: storePromiseAfterCarrierContext }], output), {
      orderNumbers: ["480033739"],
      requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
    }, storePromiseAfterCarrierContext);
  }
  for (const negatedCarrierEtaWithStorePromise of [
    "DPD nie podało terminu dostawy na jutro; to sklep obiecał dostawę jutro dla zamówienia 480033739 złożonego do 19:00. Paczki nadal nie ma.",
    "Według DPD nie ma gwarancji dostawy jutro, ale sklep obiecał dostawę jutro dla zamówienia 480033739 złożonego do 19:00. Paczki nadal nie ma.",
    "Kurier nie zapewnił, że dostarczy jutro. Tę obietnicę złożył sklep dla zamówienia 480033739 złożonego do 19:00. Paczki nadal nie ma.",
  ]) {
    assert.deepEqual(requiredMasterlinkResearch([{ ...message, content: negatedCarrierEtaWithStorePromise }], output), {
      orderNumbers: ["480033739"],
      requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
    }, negatedCarrierEtaWithStorePromise);
  }
  for (const foreignComplaint of [
    "Objednávka 480033739 byla podána do 19:00 a měla dorazit zítra, ale zásilka nedorazila.",
    "Tellimus 480033739 esitati enne kella 19:00 ja pidi saabuma homme, kuid pakk pole saabunud.",
    "Wczoraj złożyłam zamówienie 480033739 przed 19:00, miało dotrzeć dzisiaj, ale nie dotarło.",
    "Včera jsem objednala objednávku 480033739 do 19:00, měla dorazit dnes, ale zásilka nedorazila.",
    "Eile tegin tellimuse 480033739 enne kella 19:00, see pidi saabuma täna, kuid pakk ei saabunud.",
    "Objednávka 480033739 byla podána do 19:00 a měla dorazit zítra, ale stále jsem ji neobdržela.",
    "Objednávka 480033739 byla podána do 19:00 a měla dorazit zítra. Dodávka stále chybí.",
    "Tellimus 480033739 esitati enne kella 19:00 ja pidi saabuma homme, kuid ma ei ole pakki saanud.",
    "Tellimus 480033739 esitati enne kella 19:00 ja pidi saabuma homme. Saadetis on ikka puudu.",
  ]) {
    assert.deepEqual(requiredMasterlinkResearch([{ ...message, content: foreignComplaint }], output), {
      orderNumbers: ["480033739"],
      requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
    });
  }
  const explicitStorePromise: StoredMessage = {
    ...message,
    content: "Sklep obiecał, że zamówienie 480033739 dotrze jutro, ale paczka nie dotarła.",
  };
  assert.deepEqual(requiredMasterlinkResearch([explicitStorePromise], output), {
    orderNumbers: ["480033739"],
    requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
  });
  for (const failureWording of [
    "Do dziś nie dostałam paczki.",
    "Paczka nie przyszła.",
    "Paczki brak.",
    "Gdzie jest moja paczka?",
    "Termin już minął.",
    "Mamy pojutrze, a paczki brak.",
    "Do tej pory brak dostawy.",
    "Nie zostało doręczone.",
    "Dostawy do dziś brak.",
  ]) {
    const complaintWording = {
      ...message,
      content: `Zamówienie 480033739 złożyłam do 19:00 i miało być jutro. ${failureWording}`,
    };
    assert.deepEqual(requiredMasterlinkResearch([complaintWording], output), {
      orderNumbers: ["480033739"],
      requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
    }, failureWording);
  }
  for (const noFailure of [
    "Zamówienie 480033739 złożyłam do 19:00 i dotarło jutro. Nie ma opóźnienia.",
    "Zamówienie 480033739 złożyłam do 19:00 i dotarło jutro bez opóźnienia.",
    "Zamówienie 480033739 złożyłam do 19:00 i miało być jutro. Początkowo nie dotarło, ale już je mam, dziękuję.",
    "Zamówienie 480033739 złożyłam do 19:00 i miało być jutro. Nie dostałam go na czas, jednak ostatecznie zostało dostarczone.",
    "Objednávka 480033739 byla podána do 19:00 a měla dorazit zítra. Nejdřív nedorazila, ale už ji mám, děkuji.",
    "Objednávka 480033739 byla podána do 19:00 a měla dorazit zítra. Nebyla doručena včas, ale nakonec dorazila.",
    "Tellimus 480033739 esitati enne kella 19:00 ja pidi saabuma homme. Algul pakk ei saabunud, aga nüüd on see kohal, aitäh.",
    "Tellimus 480033739 esitati enne kella 19:00 ja pidi saabuma homme. Ma ei saanud pakki õigel ajal, kuid lõpuks jõudis see kohale.",
  ]) {
    assert.notDeepEqual(requiredMasterlinkResearch([{ ...message, content: noFailure }], output), {
      orderNumbers: ["480033739"],
      requiredTools: ["ml_get_delivery_details", "ml_get_shipments", "ml_get_fulfillment"],
    }, noFailure);
  }
  for (const policyQuestion of [
    "Czy jeśli zamówię do 19:00, paczka będzie jutro?",
    "Czy dostawa jutro przy zamówieniu do 19:00 dotyczy DPD?",
  ]) {
    const faq = { ...message, content: policyQuestion };
    assert.equal(requiredMasterlinkResearch([faq], output), null, policyQuestion);
    assert.deepEqual(deliveryPromiseResolutionIssues([faq], output), [], policyQuestion);
  }
});

test("regresja screenshot: DPD dostaje znany status i konkretny krok bez pytania człowieka", () => {
  const complaint: StoredMessage = {
    ...message,
    content: "Zamówienie 480033739 złożyłam przed 19:00. Miało być jutro, ale paczki nadal nie ma. Co się dzieje?",
  };
  const result = (payload: string, caseState: AgentTurnOutput["caseState"] = "action_proposed") => ({
    ...output,
    caseState,
    proposedActions: caseState === "action_proposed" ? [{
      ...output.proposedActions[0]!,
      payload,
    }] : [],
  });
  const evidence = (carrier: string | null, includeShipments = true) => JSON.stringify([
    {
      tool: "ml_get_delivery_details",
      arguments: { order_number: "480033739" },
      result: {
        found: true,
        facts: { delivery: { order_number: "480033739", carrier_code: carrier } },
      },
      error: null,
    },
    ...(includeShipments ? [{
      tool: "ml_get_shipments",
      arguments: { order_number: "480033739" },
      result: {
        found: true,
        facts: {
          order_number: "480033739",
          current_tracking_number: "00340434123456789012",
          current_shipment_status: "in_transit",
          shipments: [{
            shipment_id: "shp-1",
            carrier_code: carrier,
            final_carrier_code: carrier,
            tracking_number: "00340434123456789012",
            status: "in_transit",
            canonical: true,
            invalidated_at: null,
            scans: [],
          }],
        },
      },
      error: null,
    }] : []), {
      tool: "ml_get_fulfillment",
      arguments: { order_number: "480033739" },
      result: {
        found: true,
        facts: { order_number: "480033739", order_status: "processing", blocked: false },
      },
      error: null,
    },
  ]);

  const incompleteIssues = deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy za niejasność. Oferta dostawy jutro dotyczy wyłącznie InPost, a w tym zamówieniu wybrano DPD. Pozdrawiamy, Zespół Paryskie Perfumy"),
    evidence("dpd"),
  );
  assert.match(incompleteIssues.join("\n"), /aktualnego stanu przesyłki/);
  assert.match(incompleteIssues.join("\n"), /następnego kroku/);

  const canonicalInTransit = buildVerifiedDeliveryPromiseFallback(
    daktelaJob,
    [complaint],
    result("draft modelu"),
    evidence("dpd"),
  );
  assert.ok(canonicalInTransit);
  assert.equal(deliveryPromiseMustResolveWithoutHuman([complaint], evidence("dpd")), true);
  assert.deepEqual(deliveryPromiseResolutionIssues(
    [complaint],
    canonicalInTransit,
    evidence("dpd"),
  ), []);
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy za niejasny komunikat. Obietnica dostawy jutro przy zamówieniu do 19:00 dotyczy wyłącznie InPost, natomiast w tym zamówieniu wybrano DPD. Paczka jest w drodze, a status może Pani śledzić pod numerem 00340434123456789012. Jeśli status się nie zmieni, skontaktujemy się z DPD. Pozdrawiamy, Zespół Paryskie Perfumy"),
    evidence("dpd"),
  ).join("\n"), /przyszłe działanie BOK/);
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. DPD dostarczy paczkę jutro. InPost dotyczy tylko automatów. Paczka jest w drodze. Prosimy śledzić status pod numerem 00340434123456789012."),
    evidence("dpd"),
  ).join("\n"), /obiecuje dostawę jutro|wyłącznie InPost/);
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost. W tym zamówieniu wybrano DPD. Paczka jest w drodze. Paczka dotrze jutro. Status można śledzić pod numerem 00340434123456789012."),
    evidence("dpd"),
  ).join("\n"), /ponownie obiecuje dostawę jutro/);
  for (const unsupportedEta of [
    "Paczka powinna dotrzeć jutro",
    "Paczka powinna być u Pani jutro",
    "Spodziewamy się dostawy jutro",
    "Planowane doręczenie jest jutro",
    "Przewidywany termin to jutro",
    "Kurier powinien być jutro",
    "Oczekujemy jej jutro",
  ]) {
    assert.match(deliveryPromiseResolutionIssues(
      [complaint],
      result(`Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost. W tym zamówieniu wybrano DPD. Paczka jest w drodze. ${unsupportedEta}. Status można śledzić pod numerem 00340434123456789012.`),
      evidence("dpd"),
    ).join("\n"), /ponownie obiecuje dostawę jutro/);
  }
  for (const noGuarantee of [
    "Nie gwarantujemy, że przesyłka dotrze jutro",
    "Nie możemy obiecać dostawy jutro",
    "Nie potwierdzamy terminu dostawy na jutro",
  ]) {
    const issues = deliveryPromiseResolutionIssues(
      [complaint],
      result(`Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost. W tym zamówieniu wybrano DPD. Paczka jest w drodze. ${noGuarantee}. Status można śledzić pod numerem 00340434123456789012.`),
      evidence("dpd"),
    ).join("\n");
    assert.doesNotMatch(issues, /ponownie obiecuje dostawę jutro/, noGuarantee);
  }
  for (const negatedRule of [
    "Dostawa jutro dotyczy nie tylko InPost",
    "Dostawa jutro nie dotyczy wyłącznie InPost",
  ]) {
    assert.match(deliveryPromiseResolutionIssues(
      [complaint],
      result(`Dzień dobry, przepraszamy. ${negatedRule}. W tym zamówieniu wybrano DPD. Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012.`),
      evidence("dpd"),
    ).join("\n"), /wyłącznie InPost/);
  }
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. InPost jest tylko jednym z przewoźników. W tym zamówieniu wybrano DPD. Paczka jest w drodze. Prosimy śledzić status pod numerem 00340434123456789012."),
    evidence("dpd"),
  ).join("\n"), /wyłącznie InPost/);
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Który wariant odpowiedzi mamy zastosować?", "waiting_for_human"),
    evidence("dpd"),
  )[0] ?? "", /zastosuj regułę samodzielnie/);
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. DPD zajmuje się przesyłką."),
    evidence("dpd", false),
  )[0] ?? "", /Brak jednoznacznie zweryfikowanego stanu przesyłki/);
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, oferta nie obejmuje Państwa przewoźnika."),
    evidence(null),
  )[0] ?? "", /Brak potwierdzonego przewoźnika/);
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    { ...output, reply: "Sprawa zakończona.", caseState: "answered", proposedActions: [] },
    evidence(null),
  ).join("\n"), /po cichu zamykać sprawy/);

  for (const invalidBody of [
    "Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost, a wybrano DPD. Paczka nie jest w drodze. Status można śledzić pod numerem 00340434123456789012.",
    "Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost, a wybrano DPD. Przesyłka nie znajduje się w transporcie. Status można śledzić pod numerem 00340434123456789012.",
    "Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost, a wybrano DPD. Paczka jest w drodze. Nie można sprawdzić statusu, numer 00340434123456789012.",
  ]) {
    assert.ok(deliveryPromiseResolutionIssues(
      [complaint],
      result(invalidBody),
      evidence("dpd"),
    ).length > 0);
  }
  for (const unsupportedAction of [
    "zgłosimy sprawę do DPD",
    "przekażemy sprawę do DPD",
    "poprosimy DPD o wyjaśnienie",
    "podejmiemy kontakt z DPD",
    "zajmiemy się wyjaśnieniem",
  ]) {
    assert.match(deliveryPromiseResolutionIssues(
      [complaint],
      result(`Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost, a wybrano DPD. Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012. Jeśli status się nie zmieni, ${unsupportedAction}.`),
      evidence("dpd"),
    ).join("\n"), /przyszłe działanie BOK/);
  }

  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy za opóźnienie. InPost dostarczy paczkę jutro. Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012."),
    evidence("inpost"),
  ).join("\n"), /ponownie obiecuje dostawę jutro/);
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost. W zamówieniu 480099999 wybrano DPD. Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012."),
    evidence("dpd"),
  ).join("\n"), /obcy numer zamówienia/);
  const withHumanEscalation = result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost. W tym zamówieniu wybrano DPD. Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012.");
  withHumanEscalation.proposedActions.push({
    kind: "discord_notify",
    summary: "Potwierdzenie BOK",
    target: "BOK",
    payload: "Potwierdź wariant odpowiedzi.",
    reason: "Pytanie do zespołu",
    risk: "low",
  });
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    withHumanEscalation,
    evidence("dpd"),
  ).join("\n"), /pobocznej eskalacji/);
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    {
      ...result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost. W tym zamówieniu wybrano DPD. Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012."),
      reply: "DAKTELA #99570 — Czy BOK potwierdza ten wariant?",
    },
    evidence("dpd"),
  ).join("\n"), /wewnętrzne podsumowanie/);

  const crossOrderEvidence = JSON.parse(evidence("dpd"));
  crossOrderEvidence[1].arguments.order_number = "480099999";
  crossOrderEvidence[1].result.facts.order_number = "480099999";
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost; wybrano DPD. Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012."),
    JSON.stringify(crossOrderEvidence),
  ).join("\n"), /Brak jednoznacznie zweryfikowanego stanu przesyłki/);

  const invalidatedEvidence = JSON.parse(evidence("dpd"));
  invalidatedEvidence[1].result.facts.shipments[0].invalidated_at = "2026-09-02T18:00:00.000Z";
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost; wybrano DPD. Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012."),
    JSON.stringify(invalidatedEvidence),
  ).join("\n"), /Brak jednoznacznie zweryfikowanego stanu przesyłki/);

  const stalePointerEvidence = JSON.parse(evidence("dpd"));
  stalePointerEvidence[1].result.facts.shipments.unshift({
    shipment_id: "old",
    carrier_code: "dpd",
    final_carrier_code: "dpd",
    tracking_number: "OLD-TRACKING",
    status: "in_transit",
    canonical: false,
    invalidated_at: "2026-09-02T18:00:00.000Z",
    scans: [],
  });
  stalePointerEvidence[1].result.facts.shipment_count = 2;
  stalePointerEvidence[1].result.facts.current_tracking_number = "OLD-TRACKING";
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost; wybrano DPD. Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012."),
    JSON.stringify(stalePointerEvidence),
  ).join("\n"), /Brak jednoznacznie zweryfikowanego stanu przesyłki/);

  const pointerCanonicalConflict = JSON.parse(evidence("dpd"));
  pointerCanonicalConflict[1].result.facts.shipments.unshift({
    shipment_id: "pointer-old",
    carrier_code: "dpd",
    final_carrier_code: "dpd",
    tracking_number: "00340434123456789012",
    status: "in_transit",
    canonical: false,
    invalidated_at: null,
    scans: [],
  });
  pointerCanonicalConflict[1].result.facts.shipments[1].tracking_number = "NEW-TRACKING";
  pointerCanonicalConflict[1].result.facts.shipment_count = 2;
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost; wybrano DPD."),
    JSON.stringify(pointerCanonicalConflict),
  ).join("\n"), /Brak jednoznacznie zweryfikowanego stanu przesyłki/);

  const duplicateCanonical = JSON.parse(evidence("dpd"));
  duplicateCanonical[1].result.facts.shipments = [{
    ...duplicateCanonical[1].result.facts.shipments[0],
    canonical: false,
  }, {
    ...duplicateCanonical[1].result.facts.shipments[0],
    shipment_id: "canonical-new-1",
    tracking_number: "NEW-1",
    status: "failed",
    canonical: true,
  }, {
    ...duplicateCanonical[1].result.facts.shipments[0],
    shipment_id: "canonical-new-2",
    tracking_number: "NEW-2",
    status: "delivered",
    canonical: true,
  }];
  duplicateCanonical[1].result.facts.shipment_count = 3;
  assert.equal(buildVerifiedDeliveryPromiseFallback(
    daktelaJob,
    [complaint],
    result("Błędny draft"),
    JSON.stringify(duplicateCanonical),
  ), null);

  const conflictingStatusEvidence = JSON.parse(evidence("dpd"));
  conflictingStatusEvidence[1].result.facts.shipments[0].scans = [{
    status: "failed",
    description: "Doręczenie nieudane",
    occurred_at: "2026-09-02T20:00:00.000Z",
  }];
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost; wybrano DPD. Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012."),
    JSON.stringify(conflictingStatusEvidence),
  ).join("\n"), /Brak jednoznacznie zweryfikowanego stanu przesyłki/);

  const noPointerTopConflict = JSON.parse(evidence("dpd"));
  noPointerTopConflict[1].result.facts.current_tracking_number = null;
  noPointerTopConflict[1].result.facts.current_shipment_status = "delivered";
  assert.equal(buildVerifiedDeliveryPromiseFallback(
    daktelaJob,
    [complaint],
    result("Błędny draft"),
    JSON.stringify(noPointerTopConflict),
  ), null);
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przesyłka jest w drodze."),
    JSON.stringify(noPointerTopConflict),
  ).join("\n"), /Brak jednoznacznie zweryfikowanego stanu przesyłki/);

  for (const latestExceptionalStatus of ["parcel_lost", "damaged", "refused"]) {
    const exceptionalEvidence = JSON.parse(evidence("dpd"));
    exceptionalEvidence[1].result.facts.shipments[0].scans = [{
      status: latestExceptionalStatus,
      description: latestExceptionalStatus,
      occurred_at: "2026-09-02T20:00:00.000Z",
    }];
    assert.equal(buildVerifiedDeliveryPromiseFallback(
      daktelaJob,
      [complaint],
      result("Błędny draft"),
      JSON.stringify(exceptionalEvidence),
    ), null, latestExceptionalStatus);
    assert.match(deliveryPromiseResolutionIssues(
      [complaint],
      result("Dzień dobry, przesyłka jest w drodze."),
      JSON.stringify(exceptionalEvidence),
    ).join("\n"), /Brak jednoznacznie zweryfikowanego stanu przesyłki/, latestExceptionalStatus);
  }

  const unknownLatestScan = JSON.parse(evidence("dpd"));
  unknownLatestScan[1].result.facts.shipments[0].scans = [{
    status: "provider_code_x91",
    description: "provider_code_x91",
    occurred_at: "2026-09-02T20:00:00.000Z",
  }];
  assert.equal(buildVerifiedDeliveryPromiseFallback(
    daktelaJob,
    [complaint],
    result("Błędny draft"),
    JSON.stringify(unknownLatestScan),
  ), null, "nieznany najnowszy skan musi być fail-closed");

  const contradictoryEmpty = JSON.parse(evidence("dpd"));
  contradictoryEmpty[1].result.facts.shipments = [];
  contradictoryEmpty[1].result.facts.shipment_count = 0;
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost; wybrano DPD. Nie utworzono jeszcze przesyłki. Po nadaniu otrzyma Pani numer do śledzenia."),
    JSON.stringify(contradictoryEmpty),
  ).join("\n"), /Brak jednoznacznie zweryfikowanego stanu przesyłki/);

  const deliveredEvidence = JSON.parse(evidence("dpd"));
  deliveredEvidence[1].result.facts.current_shipment_status = "delivered";
  deliveredEvidence[1].result.facts.shipments[0].status = "delivered";
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost; wybrano DPD. Status wskazuje, że paczka została doręczona. Prosimy śledzić status pod numerem 00340434123456789012."),
    JSON.stringify(deliveredEvidence),
  ).join("\n"), /następnego kroku/);

  const preTransitEvidence = JSON.parse(evidence("dpd"));
  preTransitEvidence[1].result.facts.current_shipment_status = "pre_transit";
  preTransitEvidence[1].result.facts.shipments[0].status = "pre_transit";
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost; wybrano DPD. Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012."),
    JSON.stringify(preTransitEvidence),
  ).join("\n"), /aktualnego stanu|następnego kroku/);

  for (const negativeStatus of [
    "not_yet_delivered",
    "never_delivered",
    "non_delivered",
    "undelivered",
    "niedoręczona",
    "not_yet_returned",
    "not_returned",
    "not_ready_for_pickup",
    "not_out_for_delivery",
    "never_out_for_delivery",
    "non_out_for_delivery",
    "not_in_transit",
    "not_label_created",
    "not_cancelled",
    "not_invalidated",
    "not_failed",
    "not_delayed",
    "nie_anulowana",
    "nie_opóźniona",
    "není_zrušena",
    "ei_ole_tühistatud",
  ]) {
    const negativeEvidence = JSON.parse(evidence("dpd"));
    negativeEvidence[1].result.facts.current_shipment_status = negativeStatus;
    negativeEvidence[1].result.facts.shipments[0].status = negativeStatus;
    assert.equal(buildVerifiedDeliveryPromiseFallback(
      daktelaJob,
      [complaint],
      result("Błędny draft"),
      JSON.stringify(negativeEvidence),
    ), null, negativeStatus);
    assert.match(deliveryPromiseResolutionIssues(
      [complaint],
      result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost, wybrano DPD."),
      JSON.stringify(negativeEvidence),
    ).join("\n"), /nie daje jeszcze bezpiecznego/, negativeStatus);
  }
  for (const invalidScanTime of [null, "", "not-a-date"]) {
    const invalidScanEvidence = JSON.parse(evidence("dpd"));
    invalidScanEvidence[1].result.facts.shipments[0].scans = [{
      status: "failed",
      description: "delivery failed",
      occurred_at: invalidScanTime,
    }];
    assert.equal(buildVerifiedDeliveryPromiseFallback(
      daktelaJob,
      [complaint],
      result("Błędny draft"),
      JSON.stringify(invalidScanEvidence),
    ), null, String(invalidScanTime));
    assert.match(deliveryPromiseResolutionIssues(
      [complaint],
      result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost, wybrano DPD."),
      JSON.stringify(invalidScanEvidence),
    ).join("\n"), /Brak jednoznacznie zweryfikowanego stanu przesyłki/);
  }

  const blockedEvidence = JSON.parse(evidence("dpd"));
  blockedEvidence[1].result.facts.current_shipment_status = "label_created";
  blockedEvidence[1].result.facts.shipments[0].status = "label_created";
  blockedEvidence[2].result.facts.order_status = "blocked";
  blockedEvidence[2].result.facts.blocked = true;
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost; wybrano DPD. Etykieta przesyłki została utworzona. Pierwszy skan pojawi się po przejęciu paczki przez kuriera; status można sprawdzić tutaj: 00340434123456789012"),
    JSON.stringify(blockedEvidence),
  ).join("\n"), /nie daje jeszcze bezpiecznego/);

  const splitDraft = result("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost; wybrano DPD.");
  splitDraft.proposedActions.push({
    ...splitDraft.proposedActions[0]!,
    payload: "Paczka jest w drodze. Status można śledzić pod numerem 00340434123456789012.",
  });
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    splitDraft,
    evidence("dpd"),
  ).join("\n"), /dokładnie jednego kompletnego draftu/);

  const fallback = buildVerifiedDeliveryPromiseFallback(
    daktelaJob,
    [complaint],
    result("Błędny draft"),
    evidence("dpd"),
  );
  assert.ok(fallback);
  assert.equal(fallback.caseState, "action_proposed");
  assert.equal(fallback.proposedActions.length, 1);
  assert.deepEqual(deliveryPromiseResolutionIssues([complaint], fallback, evidence("dpd")), []);
  assert.match(fallback.proposedActions[0]!.payload, /wyłącznie InPost/);
  assert.match(fallback.proposedActions[0]!.payload, /w drodze/);
  assert.match(fallback.proposedActions[0]!.payload, /00340434123456789012/);

  const multiIntentComplaint: StoredMessage = {
    ...complaint,
    content: `${complaint.content} Czy zapisany adres dostawy to ul. Testowa 1?`,
  };
  const multiIntentEvidence = JSON.parse(evidence("dpd"));
  multiIntentEvidence[0].result.facts.delivery.shipping_address = "ul. Testowa 1";
  const completeMultiIntent = result([
    "Dzień dobry,",
    "",
    "Przepraszamy za niejasny komunikat. Obietnica dostawy następnego dnia dla zamówień złożonych do 19:00 dotyczy wyłącznie InPost, natomiast w zamówieniu 480033739 wybrano DPD.",
    "",
    "Według aktualnego statusu przesyłka jest w drodze. Bieżący status można sprawdzić tutaj: 00340434123456789012",
    "",
    "Tak, zapisany adres dostawy to ul. Testowa 1.",
    "",
    "Pozdrawiamy",
    "Zespół Paryskie Perfumy",
  ].join("\n"));
  assert.deepEqual(deliveryPromiseResolutionIssues(
    [multiIntentComplaint],
    completeMultiIntent,
    JSON.stringify(multiIntentEvidence),
  ), []);
  const canonicalDeliveryCore = fallback.proposedActions[0]!.payload
    .split("\n\n")
    .slice(1, -1)
    .join("\n\n");
  for (const wrappedCore of [
    `Dzień dobry,\n\nTo nieprawda:\n\n${canonicalDeliveryCore}\n\nTak, zapisany adres dostawy to ul. Testowa 1.\n\nPozdrawiamy\nZespół Paryskie Perfumy`,
    `Dzień dobry,\n\nNie należy wysyłać klientowi poniższej roboczej treści: "${canonicalDeliveryCore}"\n\nTak, zapisany adres dostawy to ul. Testowa 1.\n\nPozdrawiamy\nZespół Paryskie Perfumy`,
    `Dzień dobry,\n\n${canonicalDeliveryCore}\n\nJednak powyższy status jest błędny i niepotwierdzony. Tak, zapisany adres dostawy to ul. Testowa 1.\n\nPozdrawiamy\nZespół Paryskie Perfumy`,
  ]) {
    assert.match(deliveryPromiseResolutionIssues(
      [multiIntentComplaint],
      result(wrappedCore),
      JSON.stringify(multiIntentEvidence),
    ).join("\n"), /dokładny, zweryfikowany segment/);
  }
  assert.equal(buildVerifiedDeliveryPromiseFallback(
    daktelaJob,
    [multiIntentComplaint],
    result("Błędny draft"),
    JSON.stringify(multiIntentEvidence),
  ), null, "single-intent fallback nie może zgubić pytania o adres");
  for (const unsafeStatus of [
    "Nie mamy wystarczających ani wiarygodnych danych systemowych, aby potwierdzić, że paczka jest w drodze.",
    "Nie możemy potwierdzić informacji, że paczka jest w drodze.",
    "Paczka podobno jest w drodze.",
    "Być może paczka jest w drodze.",
  ]) {
    const unsafeMultiIntent = result(`Dzień dobry, przepraszamy. Dostawa następnego dnia dotyczy wyłącznie InPost, a wybrano DPD. ${unsafeStatus} Status można śledzić pod numerem 00340434123456789012. Tak, adres dostawy to ul. Testowa 1.`);
    assert.match(deliveryPromiseResolutionIssues(
      [multiIntentComplaint],
      unsafeMultiIntent,
      JSON.stringify(multiIntentEvidence),
    ).join("\n"), /dokładny, zweryfikowany segment/);
  }
  for (const additionalQuestion of [
    "Mam też pytanie: czy N°434 jest dostępny?",
    "Czy mogę dostać próbkę?",
    "Ile punktów lojalnościowych mam na koncie?",
    "Czy wysyłacie również do Niemiec?",
    "Gdzie znajdę formularz reklamacji?",
    "Atomizer w poprzednim flakonie nie działa.",
    "Proszę również o paragon.",
    "Nie naliczyły mi się punkty.",
    "Kosmetyczki również nie było w paczce.",
  ]) {
    const additionalComplaint = { ...complaint, content: `${complaint.content} ${additionalQuestion}` };
    assert.equal(buildVerifiedDeliveryPromiseFallback(
      daktelaJob,
      [additionalComplaint],
      result("Błędny draft"),
      evidence("dpd"),
    ), null, additionalQuestion);
    assert.equal(
      deliveryPromiseMustResolveWithoutHuman([additionalComplaint], evidence("dpd")),
      false,
      `drugi wątek nie może zamienić blokady jakości w terminalny retry: ${additionalQuestion}`,
    );
  }

  const languageCases: Array<{ language: string; complaint: StoredMessage }> = [{
    language: "pl",
    complaint,
  }, {
    language: "cs",
    complaint: {
      ...complaint,
      content: "Objednávka 480033739 byla podána do 19:00 a měla dorazit zítra, ale zásilka nedorazila.",
    },
  }, {
    language: "et",
    complaint: {
      ...complaint,
      content: "Tellimus 480033739 esitati enne kella 19:00 ja pidi saabuma homme, kuid pakk pole saabunud.",
    },
  }];
  for (const { language, complaint: localizedComplaint } of languageCases) {
    for (const status of [
      "in_transit",
      "out_for_delivery",
      "label_created",
      "ready_for_pickup",
      "delivery_failed",
      "delivered",
      "returned",
      "cancelled",
    ]) {
      const localizedEvidence = JSON.parse(evidence("dpd"));
      localizedEvidence[1].result.facts.current_shipment_status = status;
      localizedEvidence[1].result.facts.shipments[0].status = status;
      const localizedFallback = buildVerifiedDeliveryPromiseFallback(
        daktelaJob,
        [localizedComplaint],
        result("Błędny draft"),
        JSON.stringify(localizedEvidence),
      );
      assert.ok(localizedFallback, `${language}/${status}: fallback`);
      assert.deepEqual(
        deliveryPromiseResolutionIssues(
          [localizedComplaint],
          localizedFallback,
          JSON.stringify(localizedEvidence),
        ),
        [],
        `${language}/${status}: own deterministic eval\n${localizedFallback.proposedActions[0]?.payload ?? ""}`,
      );
    }
    const noShipment = JSON.parse(evidence("dpd"));
    noShipment[1].result.facts.current_tracking_number = null;
    noShipment[1].result.facts.current_shipment_status = null;
    noShipment[1].result.facts.shipments = [];
    noShipment[1].result.facts.shipment_count = 0;
    const noShipmentFallback = buildVerifiedDeliveryPromiseFallback(
      daktelaJob,
      [localizedComplaint],
      result("Błędny draft"),
      JSON.stringify(noShipment),
    );
    assert.ok(noShipmentFallback, `${language}/no-shipment: fallback`);
    assert.deepEqual(deliveryPromiseResolutionIssues(
      [localizedComplaint],
      noShipmentFallback,
      JSON.stringify(noShipment),
    ), [], `${language}/no-shipment: own deterministic eval`);
  }
});

test("pełny shared pipeline: trzy błędne drafty przechodzą w zweryfikowany fallback i niezależny review", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-delivery-fallback-e2e-"));
  const store = new AgentStore(dir);
  try {
    store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:99570",
      externalMessageId: "daktela:v7:99570:delivery-complaint",
      channelId: "bok-agent-test",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "Zamówienie 480033739 złożyłam przed 19:00. Miało być jutro, ale paczki nadal nie ma.",
      createdAt: "2026-09-02T20:00:00.000Z",
      shouldRespond: false,
      role: "context",
    });
    const badOutput = JSON.stringify({
      reply: "DAKTELA #99570 · gotowe",
      caseState: "action_proposed",
      proposedActions: [{
        kind: "reply_customer",
        summary: "Niepełna odpowiedź",
        target: "Daktela ticket #99570",
        payload: "Dzień dobry, sprawdzimy to z DPD i wrócimy z informacją.",
        reason: "Klient czeka na paczkę.",
        risk: "low",
      }],
      learnedRules: [],
      actionExecution: null,
    });
    const masterlinkRead = (
      id: string,
      tool: string,
      facts: Record<string, unknown>,
    ): ThreadItem => ({
      id,
      type: "mcp_tool_call",
      server: "masterlink",
      tool,
      arguments: { order_number: "480033739" },
      result: { content: [], structured_content: { found: true, facts } },
      status: "completed",
    });
    const evidenceItems = [
      masterlinkRead("delivery", "ml_get_delivery_details", {
        order_number: "480033739",
        carrier_code: "dpd",
      }),
      masterlinkRead("shipments", "ml_get_shipments", {
        order_number: "480033739",
        current_tracking_number: "00340434123456789012",
        current_shipment_status: "in_transit",
        shipment_count: 1,
        shipments: [{
          shipment_id: "shp-1",
          carrier_code: "dpd",
          final_carrier_code: "dpd",
          tracking_number: "00340434123456789012",
          status: "in_transit",
          canonical: true,
          invalidated_at: null,
          scans: [],
        }],
      }),
      masterlinkRead("fulfillment", "ml_get_fulfillment", {
        order_number: "480033739",
        order_status: "processing",
        blocked: false,
      }),
    ];
    const primary = new ScriptedCodexClient([
      { finalResponse: badOutput, items: evidenceItems },
      { finalResponse: badOutput },
      { finalResponse: badOutput },
    ]);
    const blockedReview = JSON.stringify({
      verdict: "blocked",
      revisedPayload: null,
      issues: ["brak zweryfikowanego statusu i konkretnego kroku"],
      confidence: "high",
      polishTranslation: null,
    });
    const reviewer = new ScriptedCodexClient([
      { finalResponse: blockedReview },
      { finalResponse: blockedReview },
      { finalResponse: blockedReview },
      { finalResponse: JSON.stringify({
        verdict: "pass",
        revisedPayload: null,
        issues: [],
        confidence: "high",
        polishTranslation: null,
      }) },
    ]);
    const config = loadConfig({
      BOK_AGENT_STATE_DIR: dir,
      BOK_AGENT_WORKSPACE: path.join(process.cwd(), "agent-workspace"),
      MASTERLINK_MCP_ENABLED: "true",
    }, process.cwd());
    const agent = new BokCodexAgent(new BokAgentCore(config, store), undefined, {
      primaryCodex: primary,
      reviewerCodex: reviewer,
    });
    const job = store.syntheticDaktelaDecisionJob({
      externalTicketId: "99570",
      sourceSnapshotHash: "a".repeat(64),
      channelId: "bok-agent-test",
    });

    const reviewed = await agent.runWithProvenance(job);

    assert.equal(primary.inputs.length, 3);
    assert.equal(reviewer.inputs.length, 4);
    assert.equal(reviewed.output.caseState, "action_proposed");
    assert.equal(reviewed.output.proposedActions.length, 1);
    const action = reviewed.output.proposedActions[0]!;
    assert.equal(action.kind, "reply_customer");
    assert.equal(action.qualityReview?.verdict, "pass");
    assert.match(action.payload, /wyłącznie InPost/);
    assert.match(action.payload, /DPD/);
    assert.match(action.payload, /w drodze/);
    assert.match(action.payload, /00340434123456789012/);
    assert.doesNotMatch(action.payload, /sprawdzimy|skontaktujemy|jutro dotrze/i);
    assert.match(String(reviewer.inputs[3]), /Według aktualnego statusu przesyłka jest w drodze/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("jawnie zweryfikowany brak przesyłki jest statusem, ale nadal wymaga konkretnego kroku", () => {
  const complaint: StoredMessage = {
    ...message,
    content: "Zamówienie 480033739 złożyłam do 19:00 i miało dotrzeć jutro, ale paczki nie ma.",
  };
  const noShipmentEvidence = JSON.stringify([{
    tool: "ml_get_delivery_details",
    arguments: { order_number: "480033739" },
    result: {
      found: true,
      facts: { delivery: { order_number: "480033739", carrier_code: "dpd" } },
    },
    error: null,
  }, {
    tool: "ml_get_shipments",
    arguments: { order_number: "480033739" },
    result: {
      found: true,
      facts: {
        order_number: "480033739",
        current_tracking_number: null,
        current_shipment_status: null,
        shipment_count: 0,
        shipments: [],
      },
    },
    error: null,
  }, {
    tool: "ml_get_fulfillment",
    arguments: { order_number: "480033739" },
    result: {
      found: true,
      facts: { order_number: "480033739", order_status: "packing", blocked: false },
    },
    error: null,
  }]);
  const action = (payload: string): AgentTurnOutput => ({
    ...output,
    proposedActions: [{ ...output.proposedActions[0]!, payload }],
  });

  const canonicalNoShipment = buildVerifiedDeliveryPromiseFallback(
    daktelaJob,
    [complaint],
    action("draft modelu"),
    noShipmentEvidence,
  );
  assert.ok(canonicalNoShipment);
  assert.deepEqual(deliveryPromiseResolutionIssues(
    [complaint],
    canonicalNoShipment,
    noShipmentEvidence,
  ), []);
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    action("Dzień dobry, przepraszamy za niejasność. Dostawa jutro dotyczy wyłącznie InPost, a wybrano DPD. Zamówienie jest obecnie pakowane i nie utworzono jeszcze przesyłki. Pozdrawiamy, Zespół Paryskie Perfumy"),
    noShipmentEvidence,
  ).join("\n"), /następnego kroku/);
  for (const falseAbsence of [
    "Nie ma problemu z przesyłką",
    "Nie ma opóźnienia w przesyłce",
    "Brak zastrzeżeń do paczki",
  ]) {
    assert.match(deliveryPromiseResolutionIssues(
      [complaint],
      action(`Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost, a wybrano DPD. Zamówienie jest obecnie pakowane. ${falseAbsence}. Po nadaniu otrzyma Pani numer do śledzenia.`),
      noShipmentEvidence,
    ).join("\n"), /jawnego braku utworzonej przesyłki/);
  }

  const unknownFulfillment = JSON.parse(noShipmentEvidence);
  unknownFulfillment[2].result.facts.order_status = "unknown";
  assert.match(deliveryPromiseResolutionIssues(
    [complaint],
    action("Dzień dobry, przepraszamy. Dostawa jutro dotyczy wyłącznie InPost, a wybrano DPD. Zamówienie jest w realizacji i nie utworzono jeszcze przesyłki. Po nadaniu otrzyma Pani numer do śledzenia."),
    JSON.stringify(unknownFulfillment),
  ).join("\n"), /nie daje jeszcze bezpiecznego/);
});

test("jawny siedmiocyfrowy numer zamówienia również wymusza odczyt MasterLink", () => {
  const shortOrder: StoredMessage = {
    ...message,
    content: "Klient prosi o zwrot zamówienia nr 1150102.",
  };
  assert.deepEqual(extractExplicitOrderNumbers([shortOrder]), ["1150102"]);
  assert.deepEqual(requiredMasterlinkResearch([shortOrder], output), {
    orderNumbers: ["1150102"],
    requiredTools: ["any_read"],
  });
});

test("instrukcja techniczna o dostawie nie zmienia reklamacji w pytanie o adres", () => {
  const complaint: StoredMessage = {
    ...message,
    content: `
      Pytanie o adres lub dostawę wymaga użycia właściwego narzędzia.
      <customer_history untrusted="true">
        Klient zgłasza, że wymieniony flakon ponownie przecieka. Zamówienie 480028836.
      </customer_history>
    `,
  };
  assert.match(customerIntentText(complaint), /flakon ponownie przecieka/);
  assert.deepEqual(requiredMasterlinkResearch([complaint], output), {
    orderNumbers: ["480028836"],
    requiredTools: ["any_read"],
  });
});

test("ogólny odczyt zamówienia nie zastępuje odczytu danych dostawy", () => {
  const genericCall: ThreadItem = {
    id: "1",
    type: "mcp_tool_call",
    server: "masterlink",
    tool: "ml_get_order",
    arguments: { order_number: "480033739" },
    result: { content: [], structured_content: { found: true } },
    status: "completed",
  };
  const deliveryCall: ThreadItem = {
    ...genericCall,
    id: "2",
    tool: "ml_get_delivery_details",
  };
  const shipmentsCall: ThreadItem = {
    ...genericCall,
    id: "3",
    tool: "ml_get_shipments",
  };

  assert.equal(hasRequiredMasterlinkRead([genericCall], "ml_get_delivery_details"), false);
  assert.equal(hasRequiredMasterlinkRead([genericCall, deliveryCall], "ml_get_delivery_details"), true);
  assert.equal(hasRequiredMasterlinkRead(
    [{ ...deliveryCall, arguments: { order_number: "480099999" } }],
    "ml_get_delivery_details",
    "480033739",
  ), false);
  assert.equal(hasRequiredMasterlinkReads(
    [genericCall, deliveryCall],
    ["ml_get_delivery_details", "ml_get_shipments"],
  ), false);
  assert.equal(hasRequiredMasterlinkReads(
    [genericCall, deliveryCall, shipmentsCall],
    ["ml_get_delivery_details", "ml_get_shipments"],
  ), true);
});

test("dowody reviewera pozostają parseable i zachowują exact fakty po przekroczeniu limitu", () => {
  const hugeBrowser: ThreadItem = {
    id: "browser-huge",
    type: "mcp_tool_call",
    server: "chrome-devtools",
    tool: "take_snapshot",
    arguments: {},
    result: { content: [{ type: "text", text: "x".repeat(80_000) }], structured_content: null },
    status: "completed",
  };
  const masterlink = (id: string, tool: string, facts: Record<string, unknown>): ThreadItem => ({
    id,
    type: "mcp_tool_call",
    server: "masterlink",
    tool,
    arguments: { order_number: "480033739" },
    result: { content: [], structured_content: { found: true, facts } },
    status: "completed",
  });
  const evidence = formatVerifiedToolEvidence([
    hugeBrowser,
    masterlink("delivery", "ml_get_delivery_details", {
      order_number: "480033739",
      carrier_code: "dpd",
    }),
    masterlink("shipments", "ml_get_shipments", {
      order_number: "480033739",
      current_shipment_status: "in_transit",
      current_tracking_number: "TRACK123",
      shipments: [{
        shipment_id: "one",
        carrier_code: "dpd",
        final_carrier_code: "dpd",
        tracking_number: "TRACK123",
        tracking_url: "https://example.invalid/TRACK123",
        status: "in_transit",
        canonical: true,
        invalidated_at: null,
        scans: [],
      }],
    }),
    masterlink("fulfillment", "ml_get_fulfillment", {
      order_number: "480033739",
      order_status: "processing",
      blocked: false,
    }),
  ]);
  assert.ok(evidence);
  assert.ok(evidence.length <= 30_000);
  const parsed = JSON.parse(evidence) as Array<Record<string, unknown>>;
  assert.equal(parsed.some((item) => item.tool === "ml_get_delivery_details"), true);
  assert.equal(parsed.some((item) => item.tool === "ml_get_shipments"), true);
  assert.equal(parsed.some((item) => item.tool === "ml_get_fulfillment"), true);
});

test("sprzeczne najnowsze skany z tym samym czasem są fail-closed niezależnie od kolejności API", () => {
  const complaint: StoredMessage = {
    ...message,
    content: "Zamówienie 480033739 złożyłam do 19:00 i miało dotrzeć jutro, ale paczki nie ma.",
  };
  const mcpRead = (id: string, tool: string, facts: Record<string, unknown>): ThreadItem => ({
    id,
    type: "mcp_tool_call",
    server: "masterlink",
    tool,
    arguments: { order_number: "480033739" },
    result: { content: [], structured_content: { found: true, facts } },
    status: "completed",
  });
  const scans = [{
    status: "in_transit",
    description: "Paczka jest w drodze",
    occurred_at: "2026-09-02T20:00:00.000Z",
  }, {
    status: "failed",
    description: "Nieudane doręczenie",
    occurred_at: "2026-09-02T20:00:00.000Z",
  }];
  for (const orderedScans of [scans, [...scans].reverse()]) {
    const verified = formatVerifiedToolEvidence([
      mcpRead("delivery", "ml_get_delivery_details", {
        order_number: "480033739",
        carrier_code: "dpd",
      }),
      mcpRead("shipment", "ml_get_shipments", {
        order_number: "480033739",
        current_tracking_number: "TRACK-1",
        current_shipment_status: "in_transit",
        shipment_count: 1,
        shipments: [{
          shipment_id: "shipment-1",
          carrier_code: "dpd",
          final_carrier_code: "dpd",
          tracking_number: "TRACK-1",
          status: "in_transit",
          canonical: true,
          invalidated_at: null,
          scans: orderedScans,
        }],
      }),
      mcpRead("fulfillment", "ml_get_fulfillment", {
        order_number: "480033739",
        order_status: "processing",
        blocked: false,
      }),
    ]);
    assert.ok(verified);
    assert.equal(buildVerifiedDeliveryPromiseFallback(
      daktelaJob,
      [complaint],
      output,
      verified,
    ), null);
    assert.match(deliveryPromiseResolutionIssues(
      [complaint],
      output,
      verified,
    ).join("\n"), /Brak jednoznacznie zweryfikowanego stanu przesyłki/);
  }
});

test("świeższy deterministyczny NOT_FOUND unieważnia wcześniejsze fakty, transient ich nie kasuje", () => {
  const call = (id: string, structured_content: Record<string, unknown>): ThreadItem => ({
    id,
    type: "mcp_tool_call",
    server: "masterlink",
    tool: "ml_get_delivery_details",
    arguments: { order_number: "480033739" },
    result: { content: [], structured_content },
    status: "completed",
  });
  const found = call("found", {
    found: true,
    facts: { order_number: "480033739", carrier_code: "dpd" },
  });
  const notFound = call("not-found", {
    found: false,
    error: { code: "NOT_FOUND", retryable: false },
  });
  const transient = call("transient", {
    found: false,
    error: { code: "TIMEOUT", retryable: true },
  });
  const deterministicEvidence = JSON.parse(formatVerifiedToolEvidence([found, notFound]) ?? "[]");
  assert.equal(deterministicEvidence.length, 1);
  assert.equal(deterministicEvidence[0].result.found, false);
  const transientEvidence = JSON.parse(formatVerifiedToolEvidence([found, transient]) ?? "[]");
  assert.equal(transientEvidence.length, 1);
  assert.equal(transientEvidence[0].result.found, true);
  assert.equal(transientEvidence[0].result.facts.carrier_code, "dpd");
});

test("wspólny kontekst Dakteli zachowuje tylko raport z tym samym numerem zamówienia", () => {
  const current: StoredMessage = {
    ...message,
    content: "Daktela #99570, zamówienie 480032521",
  };
  const shared: StoredMessage[] = [
    { ...message, id: 2, content: "Zwrot dla zamówienia 480027912" },
    { ...message, id: 3, content: "Raport dla zamówienia 480032521" },
  ];
  assert.deepEqual(
    filterSharedContextForJob(daktelaJob, [current], shared).map((item) => item.id),
    [3],
  );
  assert.deepEqual(filterSharedContextForJob(daktelaJob, [{ ...current, content: "Brak numeru" }], shared), []);
});

test("powiązanie ticketów używa tylko jawnie oznaczonego zamówienia, nie NIP ani REGON", () => {
  const messages: StoredMessage[] = [{
    ...message,
    content: "Edycja zamówienia - 480034410. NIP 6372211771, REGON 387462686.",
  }];
  assert.deepEqual(extractExplicitOrderNumbers(messages), ["480034410"]);
  assert.deepEqual(extractOrderNumbers(messages), ["480034410"]);
});

test("integrity gate blokuje odpowiedź oznaczoną numerem innego ticketu", () => {
  const wrong: AgentTurnOutput = {
    ...output,
    reply: "**Daktela #99567**\n\nCzy paczka wróciła?",
    proposedActions: [],
  };
  assert.deepEqual(daktelaTicketIntegrityIssues(daktelaJob, wrong), [
    "reply nie wskazuje bieżącego ticketu #99570",
    "reply wskazuje obcy ticket #99567",
  ]);
  assert.throws(() => assertDaktelaTicketIntegrity(daktelaJob, wrong), /pomieszanie ticketów/);
});

test("brakująca etykieta bieżącego ticketu jest uzupełniana bez zmiany treści", () => {
  const normalized = attachMissingDaktelaIdentity(daktelaJob, {
    ...output,
    reply: "Gotowy draft.",
    proposedActions: [{
      ...output.proposedActions[0]!,
      target: "bieżąca sprawa klienta",
    }],
  });
  assert.match(normalized.reply, /^DAKTELA #99570/);
  assert.match(normalized.proposedActions[0]!.target, /Daktela ticket #99570/);
  assert.doesNotThrow(() => assertDaktelaTicketIntegrity(daktelaJob, normalized));
});

test("deterministyczna normalizacja nie maskuje obcego numeru ticketu", () => {
  const wrong = attachMissingDaktelaIdentity(daktelaJob, {
    ...output,
    reply: "DAKTELA #99567 — obca sprawa",
    proposedActions: [],
  });
  assert.throws(() => assertDaktelaTicketIntegrity(daktelaJob, wrong), /pomieszanie ticketów/);
});

test("integrity gate sprawdza również target draftu dla klienta", () => {
  const valid: AgentTurnOutput = {
    ...output,
    reply: "DAKTELA #99570 — gotowy draft",
    proposedActions: [{
      ...output.proposedActions[0]!,
      target: "Daktela ticket #99570 (https://pariscosmetics.daktela.com/tickets/update/99570)",
    }],
  };
  assert.doesNotThrow(() => assertDaktelaTicketIntegrity(daktelaJob, valid));
  assert.throws(
    () => assertDaktelaTicketIntegrity(daktelaJob, {
      ...valid,
      proposedActions: [{ ...valid.proposedActions[0]!, target: "Daktela ticket #99567" }],
    }),
    /target odpowiedzi klienta/,
  );
});

test("integrity gate rozpoznaje ticket z conversationExternalId przy korekcie Discord", () => {
  const correctionJob = { ...daktelaJob, externalMessageId: "discord-message-id" };
  const wrong: AgentTurnOutput = {
    ...output,
    reply: "DAKTELA #99567 — błędna sprawa",
    proposedActions: [],
  };
  assert.deepEqual(
    daktelaTicketIntegrityIssues(correctionJob, wrong, "daktela-ticket:99570"),
    [
      "reply nie wskazuje bieżącego ticketu #99570",
      "reply wskazuje obcy ticket #99567",
    ],
  );
});

test("jednoznaczna korekta wcześniejszego draftu wymaga nowej kompletnej odpowiedzi", () => {
  const history: StoredMessage[] = [
    {
      ...message,
      role: "agent",
      authorId: "bok-agent",
      content: "## Daktela #99570 · odpowiedź gotowa\n\n### Do klienta\n> Stary draft",
    },
    {
      ...message,
      id: 2,
      role: "human",
      authorId: "bok-user",
      content: "nie pytaj o produkty, napisz od razu co trzeba zrobić do zwrotu",
    },
  ];
  const withoutDraft: AgentTurnOutput = {
    ...output,
    proposedActions: [],
    reply: "DAKTELA #99570 — jakie są zasady zwrotu?",
  };
  assert.equal(correctionRequiresCustomerDraft(history, withoutDraft), true);
  assert.equal(correctionRequiresCustomerDraft(history, {
    ...withoutDraft,
    proposedActions: [{ ...output.proposedActions[0]!, target: "Daktela ticket #99570" }],
  }), false);
});

test("wyraźne polecenie pozostawienia ticketu bez odpowiedzi nie wymusza draftu", () => {
  const history: StoredMessage[] = [
    { ...message, role: "agent", authorId: "bok-agent", content: "### Do klienta\n> Stary draft" },
    { ...message, id: 2, role: "human", content: "to automat, nie odpowiadaj klientowi" },
  ];
  assert.equal(correctionRequiresCustomerDraft(history, {
    ...output,
    proposedActions: [],
    reply: "DAKTELA #99570",
  }), false);
});

test("po pełnym researchu korekta może skończyć się jednym pytaniem o brakujący fakt", () => {
  assert.equal(correctionEscalationIsActionable({
    ...output,
    reply: "DAKTELA #100016 — nie udało się dopasować zamówienia. Jaka była jego wartość?",
    caseState: "waiting_for_human",
    proposedActions: [],
  }), true);
  assert.equal(correctionEscalationIsActionable({
    ...output,
    reply: "DAKTELA #100016 — co robimy?",
    caseState: "waiting_for_human",
    proposedActions: [],
  }), false);
});

test("puste potwierdzenie nie jest publikowane przed niewykonanym krokiem operacyjnym", () => {
  const draft = {
    ...output.proposedActions[0]!,
    payload: "Dzień dobry, dziękujemy za rachunek. Przekażemy dane do realizacji zwrotu.",
  };
  const withPendingAction: AgentTurnOutput = {
    ...output,
    proposedActions: [draft, {
      kind: "other",
      summary: "Zlecić zwrot",
      target: "zamówienie 480033021",
      payload: "Zleć zwrot 389 zł za zamówienie 480033021.",
      reason: "Zwrot nie został wykonany.",
      risk: "medium",
    }],
  };
  assert.equal(holdingReplyIntegrityIssues(draft, withPendingAction).length, 1);
  assert.deepEqual(holdingReplyIntegrityIssues({
    ...draft,
    payload: "Dzień dobry, zwrot został zlecony. Pozdrawiamy",
  }, withPendingAction), []);
});
