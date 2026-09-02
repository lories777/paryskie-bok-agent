import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ThreadItem } from "@openai/codex-sdk";
import {
  BokCodexAgent,
  buildCodexConfigOverrides,
  buildPrimaryThreadOptions,
  CHROME_READ_ONLY_TOOLS,
  buildReviewerBusinessContext,
  attachMissingDaktelaIdentity,
  catalogSelectionIntegrityIssues,
  catalogRecommendationResolutionIssues,
  draftReviewIntegrityIssues,
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
    requiredTool: "ml_get_delivery_details",
  });
});

test("jawny siedmiocyfrowy numer zamówienia również wymusza odczyt MasterLink", () => {
  const shortOrder: StoredMessage = {
    ...message,
    content: "Klient prosi o zwrot zamówienia nr 1150102.",
  };
  assert.deepEqual(extractExplicitOrderNumbers([shortOrder]), ["1150102"]);
  assert.deepEqual(requiredMasterlinkResearch([shortOrder], output), {
    orderNumbers: ["1150102"],
    requiredTool: "any_read",
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
    requiredTool: "any_read",
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

  assert.equal(hasRequiredMasterlinkRead([genericCall], "ml_get_delivery_details"), false);
  assert.equal(hasRequiredMasterlinkRead([genericCall, deliveryCall], "ml_get_delivery_details"), true);
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
