import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BokCodexAgent } from "../src/codex-agent.js";
import { AgentStore } from "../src/store.js";
import type { IncomingMessage } from "../src/types.js";
import {
  isConcreteOperationalInstruction,
  isConcreteHumanQuestion,
  formatActionCard,
  formatAgentDelivery,
  formatTerminalDaktelaFailureAlert,
  JobWorker,
  shouldDiscardSupersededDaktelaCard,
  shouldDeliverAgentOutput,
  type ReplySink,
} from "../src/worker.js";

test("cichy autoresponder nie usuwa wcześniejszej karty realnej sprawy", () => {
  assert.equal(shouldDiscardSupersededDaktelaCard({
    reply: "Daktela #100022 — ostatnia aktywność to autoresponder bez nowej treści klienta.",
    caseState: "answered",
    proposedActions: [],
    actionExecution: null,
  }, []), false);
  assert.equal(shouldDiscardSupersededDaktelaCard({
    reply: "Daktela #100023 — brak nowej wiadomości klienta lub polecenia BOK.",
    caseState: "answered",
    proposedActions: [],
    actionExecution: null,
  }, []), false);
  assert.equal(shouldDiscardSupersededDaktelaCard({
    reply: "Daktela #100022 — brak nowej merytorycznej wiadomości w tym tickecie.",
    caseState: "answered",
    proposedActions: [],
    actionExecution: null,
  }, []), false);
  assert.equal(shouldDiscardSupersededDaktelaCard({
    reply: "Daktela #100022 — BOK wysłał już merytoryczną odpowiedź.",
    caseState: "answered",
    proposedActions: [],
    actionExecution: null,
  }, []), true);
});

test("odblokowanie realizacji konkretnego ticketu jest publikowaną instrukcją", () => {
  assert.equal(
    isConcreteOperationalInstruction(
      "**Daktela #100023**\n\nZamówienie jest opłacone, ale nie ma przesyłki — trzeba pilnie odblokować realizację i potwierdzić termin nadania.",
    ),
    true,
  );
});

test("draft klienta jest pokazany jak zwykła wiadomość bez identyfikatorów workflow", () => {
  const card = formatActionCard({
    id: 7,
    publicId: "AKCJA-000007",
    kind: "reply_customer",
    summary: "Potwierdź anulowanie",
    target: "Daktela ticket #123",
    payload: "Dobrý den,\n\nobjednávka byla zrušena.",
    reason: "Anulowanie potwierdzone w ML",
    risk: "low",
    qualityReview: {
      verdict: "pass",
      issues: [],
      confidence: "high",
      polishTranslation: "Dzień dobry,\n\nzamówienie zostało anulowane.",
    },
  });
  assert.match(card, /Treść odpowiedzi/);
  assert.match(card, /> Dobrý den/);
  assert.match(card, /Tłumaczenie PL/);
  assert.match(card, /> zamówienie zostało anulowane/);
  assert.doesNotMatch(card, /AKCJA-000007/);
  assert.doesNotMatch(card, /zatwierdź|odrzuć/);
});

test("ticket Dakteli dostaje krótką kartę bez raportowego szablonu", () => {
  const result = formatAgentDelivery(
    "DAKTELA #123 — **Sytuacja** — Klient czeka na przesyłkę.\n**Ustalenia**\n- Paczka została nadana.\n**Następny krok** — Przekazać tracking.",
    [
      {
        id: 8,
        publicId: "AKCJA-000008",
        kind: "reply_customer",
        summary: "Odpowiedź o przesyłce",
        target: "Daktela ticket #123",
        payload: "Dzień dobry,\n\npaczka została nadana.\n\nPozdrawiamy\nParyskie.pl",
        reason: "Status potwierdzony",
        risk: "low",
        qualityReview: { verdict: "revised", issues: ["skrócono"], confidence: "high" },
      },
    ],
  );
  assert.match(result, /^\*\*Daktela #123 · gotowe\*\*/);
  assert.match(result, /\*\*Treść odpowiedzi\*\*/);
  assert.doesNotMatch(result, /kontrolę jakości|Tryb testowy/);
});

test("pusta zapowiedź gotowego draftu nie zajmuje miejsca na karcie", () => {
  const result = formatAgentDelivery("DAKTELA #123 — Gotowa poprawiona odpowiedź.", [
    {
      id: 9,
      publicId: "AKCJA-000009",
      kind: "reply_customer",
      summary: "Odpowiedź",
      target: "Daktela ticket #123",
      payload: "Dzień dobry,\n\nzamówienie zostało anulowane.\n\nPozdrawiamy",
      reason: "Potwierdzone",
      risk: "low",
    },
  ]);
  assert.doesNotMatch(result, /Gotowa poprawiona odpowiedź/);
  assert.match(result, /zamówienie zostało anulowane/);
});

test("automatyczny ticket bez odpowiedzi ani działania pozostaje cichy", () => {
  assert.equal(
    shouldDeliverAgentOutput(
      {
        id: 1,
        publicId: "BOK-000001",
        conversationId: 1,
        triggerMessageId: 1,
        platform: "discord",
        channelId: "channel-1",
        externalMessageId: "daktela:v6:123",
        attempts: 1,
      },
      {
        reply: "Automatyczne odbicie, brak potrzebnej reakcji.",
        caseState: "waiting_for_human",
        proposedActions: [],
        learnedRules: [],
        actionExecution: null,
      },
      [],
    ),
    false,
  );
});

test("cichy nowszy wynik Dakteli usuwa poprzednią kartę sprawy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-silent-cleanup-"));
  const store = new AgentStore(dir);
  try {
    store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:123",
      externalMessageId: "daktela:v7:123:new",
      channelId: "channel-1",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "Ticket został już obsłużony.",
      createdAt: "2026-08-27T12:00:00.000Z",
      shouldRespond: true,
      role: "context",
    });
    const agent = {
      async run() {
        return {
          reply: "DAKTELA #123 — klient dostał już odpowiedź; brak nowej reakcji.",
          caseState: "answered",
          proposedActions: [],
          learnedRules: [],
          actionExecution: null,
        } satisfies import("../src/types.js").AgentTurnOutput;
      },
    } as unknown as BokCodexAgent;
    let discarded = 0;
    const worker = new JobWorker(store, agent, {
      async deliver() { throw new Error("cichy wynik nie może zostać opublikowany"); },
      async discardSuperseded() { discarded += 1; },
    });
    assert.equal(await worker.runOne(), true);
    assert.equal(discarded, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wewnętrzna blokada jakości w rozmowie ticketu nie zaśmieca Discorda", () => {
  assert.equal(
    shouldDeliverAgentOutput(
      {
        id: 2,
        publicId: "BOK-000002",
        conversationId: 7,
        triggerMessageId: 9,
        platform: "discord",
        channelId: "channel-1",
        externalMessageId: "discord-human-correction",
        attempts: 1,
      },
      {
        reply: "DAKTELA #99570\n\nDraft wstrzymany przez kontrolę jakości: brak danych.",
        caseState: "needs_data",
        proposedActions: [],
        learnedRules: [],
        actionExecution: null,
      },
      [],
      "daktela-ticket:99570",
    ),
    false,
  );
});

test("wewnętrzna blokada jakości nie trafia też do zwykłej rozmowy na Discordzie", () => {
  assert.equal(
    shouldDeliverAgentOutput(
      {
        id: 22,
        publicId: "BOK-000022",
        conversationId: 9,
        triggerMessageId: 12,
        platform: "discord",
        channelId: "channel-1",
        externalMessageId: "discord-message",
        attempts: 1,
      },
      {
        reply: "Draft wstrzymany przez kontrolę jakości: brak katalogu.",
        caseState: "needs_data",
        proposedActions: [],
        learnedRules: [],
        actionExecution: null,
      },
      [],
      "channel:channel-1",
    ),
    false,
  );
});

test("konkretne pytanie w rozmowie ticketu nadal trafia do BOK", () => {
  assert.equal(
    shouldDeliverAgentOutput(
      {
        id: 3,
        publicId: "BOK-000003",
        conversationId: 7,
        triggerMessageId: 10,
        platform: "discord",
        channelId: "channel-1",
        externalMessageId: "discord-human-correction-2",
        attempts: 1,
      },
      {
        reply: "DAKTELA #99570 — klientka chce wyjątku od procedury. Czy zatwierdzamy zwrot?",
        caseState: "waiting_for_human",
        proposedActions: [],
        learnedRules: [],
        actionExecution: null,
      },
      [],
      "daktela-ticket:99570",
    ),
    true,
  );
});

test("pytania klienta w tłumaczeniu nie ukrywają jednego pytania decyzyjnego do BOK", () => {
  const reply = [
    "**Daktela #100189**",
    "**Tłumaczenie z estońskiego:** Czy i w jaki sposób mogę otrzymać paczkę? Czy muszę dopłacić?",
    "Czy po powrocie paczki wysyłamy ją ponownie bez dopłaty, czy pobieramy koszt ponownej wysyłki?",
  ].join("\n");
  assert.equal(isConcreteHumanQuestion(reply), true);
  assert.equal(
    shouldDeliverAgentOutput(
      {
        id: 31,
        publicId: "BOK-000031",
        conversationId: 17,
        triggerMessageId: 41,
        platform: "discord",
        channelId: "channel-1",
        externalMessageId: "daktela:v7:100189:fingerprint",
        attempts: 1,
      },
      {
        reply,
        caseState: "waiting_for_human",
        proposedActions: [],
        learnedRules: [],
        actionExecution: null,
      },
      [],
      "daktela-ticket:100189",
    ),
    true,
  );
});

test("opis ręcznej pracy bez pytania nie zalewa kanału Dakteli", () => {
  assert.equal(
    shouldDeliverAgentOutput(
      {
        id: 4,
        publicId: "BOK-000004",
        conversationId: 7,
        triggerMessageId: 11,
        platform: "discord",
        channelId: "channel-1",
        externalMessageId: "daktela:v7:99571:fingerprint",
        attempts: 1,
      },
      {
        reply: "DAKTELA #99571 — trzeba ręcznie sprawdzić wpłatę i przypisać ją do zamówienia.",
        caseState: "waiting_for_human",
        proposedActions: [],
        learnedRules: [],
        actionExecution: null,
      },
      [],
      "daktela-ticket:99571",
    ),
    false,
  );
});

test("konkretna instrukcja operacyjna trafia do BOK także bez formalnej akcji", () => {
  assert.equal(
    isConcreteOperationalInstruction(
      "**Daktela #99978**\n\nKlient chce pobranie. Zmień metodę płatności zamówienia #480034410 z Przelewy24 na pobranie i potwierdź zapis.",
    ),
    true,
  );
  assert.equal(
    isConcreteOperationalInstruction(
      "**Daktela #99972**\n\nBOK powinien uruchomić bezpłatną dosyłkę nowego flakonu N° 241 na zweryfikowany adres.",
    ),
    true,
  );
  assert.equal(
    isConcreteOperationalInstruction(
      "DAKTELA #99571 — trzeba ręcznie sprawdzić wpłatę i przypisać ją do zamówienia.",
    ),
    false,
  );
  assert.equal(
    isConcreteOperationalInstruction(
      "DAKTELA #100021 — Otwórz szczegóły reklamacji Allegro powiązanej z tym ticketem i sprawdź problem kupującego.",
    ),
    true,
  );
  assert.equal(
    isConcreteOperationalInstruction(
      "DAKTELA #100184 — Przesyłka została odebrana; ponowna wysyłka nie jest potrzebna.",
    ),
    false,
  );
});

test("chwilowe przeciążenie modelu wraca do kolejki zamiast trwale gubić ticket", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-transient-retry-"));
  const store = new AgentStore(dir);
  try {
    store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:100024",
      externalMessageId: "daktela:v7:100024:fingerprint",
      channelId: "channel-1",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "Przeanalizuj Daktela #100024",
      createdAt: "2026-08-31T06:00:00.000Z",
      shouldRespond: true,
      role: "context",
    });
    let calls = 0;
    const agent = {
      async run() {
        calls += 1;
        if (calls === 1) throw new Error("Selected model is at capacity. Please try a different model.");
        return {
          reply: "DAKTELA #100024 — brak nowej wiadomości wymagającej reakcji.",
          caseState: "answered",
          proposedActions: [],
          learnedRules: [],
          actionExecution: null,
        } satisfies import("../src/types.js").AgentTurnOutput;
      },
    } as unknown as BokCodexAgent;
    const worker = new JobWorker(store, agent, {
      async deliver() { throw new Error("cichy wynik nie powinien trafić na Discord"); },
    }, { retryDelayMs: 0 });

    assert.equal(await worker.runOne(), true);
    assert.equal(store.status().jobs_pending ?? 0, 1);
    assert.equal(store.status().jobs_failed ?? 0, 0);
    assert.equal(await worker.runOne(), true);
    assert.equal(store.status().jobs_completed ?? 0, 1);
    assert.equal(calls, 2);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("terminalne wyczerpanie retry Dakteli publikuje bezpieczny alert bez PII", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-terminal-alert-"));
  const store = new AgentStore(dir);
  try {
    store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:100025",
      externalMessageId: "daktela:v7:100025:fingerprint",
      channelId: "channel-1",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "Przeanalizuj Daktela #100025",
      createdAt: "2026-09-01T09:00:00.000Z",
      shouldRespond: true,
      role: "context",
    });
    const privateDetail = "429 provider timeout for private.customer@example.com";
    const agent = {
      async run() {
        throw new Error(privateDetail);
      },
    } as unknown as BokCodexAgent;
    const delivered: string[] = [];
    const worker = new JobWorker(store, agent, {
      async deliver(_job, content) { delivered.push(content); },
    }, { retryDelayMs: 0, maxTransientAttempts: 2 });

    assert.equal(await worker.runOne(), true);
    assert.deepEqual(delivered, []);
    assert.equal(store.status().jobs_pending, 1);

    assert.equal(await worker.runOne(), true);
    assert.equal(store.status().jobs_failed, 1);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0] ?? "", /Daktela #100025 · wymaga przejęcia/);
    assert.match(delivered[0] ?? "", /provider_retry_exhausted/);
    assert.match(delivered[0] ?? "", /po 2 próbach/);
    assert.doesNotMatch(delivered[0] ?? "", /private\.customer|example\.com/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("alert terminalny ostrzega przed double-send i nie ujawnia surowego błędu", () => {
  const alert = formatTerminalDaktelaFailureAlert({
    id: 7,
    publicId: "BOK-000007",
    conversationId: 2,
    triggerMessageId: 3,
    platform: "discord",
    channelId: "channel-1",
    externalMessageId: "daktela:v7:100026:fingerprint",
    attempts: 1,
  }, "daktela-ticket:100026", new Error("ticket integrity customer@example.com"));
  assert.match(alert, /ticket_integrity_failed/);
  assert.match(alert, /nie wysłać odpowiedzi drugi raz/);
  assert.doesNotMatch(alert, /customer@example\.com/);
});

test("sama techniczna akcja bez draftu ani pytania nie jest publikowana", () => {
  assert.equal(
    shouldDeliverAgentOutput(
      {
        id: 5,
        publicId: "BOK-000005",
        conversationId: 7,
        triggerMessageId: 12,
        platform: "discord",
        channelId: "channel-1",
        externalMessageId: "daktela:v7:99572:fingerprint",
        attempts: 1,
      },
      {
        reply: "DAKTELA #99572 — zapisano notatkę operacyjną.",
        caseState: "action_proposed",
        proposedActions: [{
          kind: "other",
          summary: "Sprawdź wpłatę",
          target: "BOK",
          payload: "Sprawdź wpłatę",
          reason: "Brak danych",
          risk: "low",
        }],
        learnedRules: [],
        actionExecution: null,
      },
      [],
      "daktela-ticket:99572",
    ),
    false,
  );
});

test("konkretna wymagana zmiana MasterLink trafia do BOK", () => {
  assert.equal(
    shouldDeliverAgentOutput(
      {
        id: 6,
        publicId: "BOK-000006",
        conversationId: 7,
        triggerMessageId: 13,
        platform: "discord",
        channelId: "channel-1",
        externalMessageId: "daktela:v7:99978:fingerprint",
        attempts: 1,
      },
      {
        reply: "DAKTELA #99978 — zmień metodę płatności na pobranie i potwierdź zapis.",
        caseState: "action_proposed",
        proposedActions: [],
        learnedRules: [],
        actionExecution: null,
      },
      [{
        id: 1,
        publicId: "AKCJA-000001",
        kind: "masterlink_write",
        summary: "Zmiana płatności",
        target: "zamówienie",
        payload: "Ustaw pobranie",
        reason: "Prośba klienta",
        risk: "medium",
      }],
      "daktela-ticket:99978",
    ),
    true,
  );
});

test("worker nie zapisuje ani nie publikuje wyniku z numerem innego ticketu", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-ticket-integrity-"));
  const store = new AgentStore(dir);
  try {
    store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:99570",
      externalMessageId: "daktela:v6:99570:fingerprint",
      channelId: "channel-1",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "Przeanalizuj Daktela #99570",
      createdAt: "2026-08-26T12:00:00.000Z",
      shouldRespond: true,
      role: "context",
    });
    const agent = {
      async run() {
        return {
          reply: "DAKTELA #99567 — błędna sprawa",
          caseState: "waiting_for_human",
          proposedActions: [],
          learnedRules: [],
          actionExecution: null,
        } satisfies import("../src/types.js").AgentTurnOutput;
      },
    } as unknown as BokCodexAgent;
    const delivered: string[] = [];
    const worker = new JobWorker(store, agent, {
      async deliver(_job, content) { delivered.push(content); },
    });
    assert.equal(await worker.runOne(), true);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0] ?? "", /ticket_integrity_failed/);
    assert.doesNotMatch(delivered[0] ?? "", /99567/);
    assert.equal(store.status().jobs_failed, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("integrity gate obejmuje korektę Discord przypisaną do rozmowy ticketu", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-ticket-correction-integrity-"));
  const store = new AgentStore(dir);
  try {
    store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:99570",
      externalMessageId: "discord-correction-message",
      channelId: "channel-1",
      authorId: "bok-user",
      authorName: "BOK",
      content: "popraw odpowiedź",
      createdAt: "2026-08-27T10:00:00.000Z",
      shouldRespond: true,
    });
    const agent = {
      async run() {
        return {
          reply: "DAKTELA #99567 — błędna sprawa",
          caseState: "waiting_for_human",
          proposedActions: [],
          learnedRules: [],
          actionExecution: null,
        } satisfies import("../src/types.js").AgentTurnOutput;
      },
    } as unknown as BokCodexAgent;
    const delivered: string[] = [];
    const worker = new JobWorker(store, agent, {
      async deliver(_job, content) { delivered.push(content); },
    });
    assert.equal(await worker.runOne(), true);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0] ?? "", /ticket_integrity_failed/);
    assert.doesNotMatch(delivered[0] ?? "", /99567/);
    assert.equal(store.status().jobs_failed, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("zatwierdzony discord_notify wykonuje deterministyczne narzędzie i weryfikuje wynik", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-worker-"));
  const store = new AgentStore(dir);
  try {
    const incoming: IncomingMessage = {
      platform: "discord",
      conversationExternalId: "channel:test",
      externalMessageId: "proposal-message",
      channelId: "channel-1",
      authorId: "user-1",
      authorName: "Tester",
      content: "Wyślij test",
      createdAt: "2026-08-26T12:00:00.000Z",
      shouldRespond: true,
    };
    store.ingest(incoming);
    const proposalJob = store.claimNextJob();
    assert.ok(proposalJob);
    store.completeJob(proposalJob.id, {
      reply: "Czekam na zgodę.",
      caseState: "action_proposed",
      actionExecution: null,
      proposedActions: [
        {
          kind: "discord_notify",
          summary: "Wyślij test",
          target: "bieżący kanał",
          payload: "TEST AKCJI",
          reason: "Test",
          risk: "low",
        },
      ],
    });
    assert.equal(
      store.approveActionAndEnqueue("AKCJA-000001", "approver", "approval-1", "channel-1"),
      "BOK-000002",
    );

    let agentCalled = false;
    const agent = {
      async run() {
        agentCalled = true;
        throw new Error("agent nie powinien zostać wywołany");
      },
    } as unknown as BokCodexAgent;
    const delivered: string[] = [];
    const sink: ReplySink = {
      async executeApprovedAction(job) {
        assert.equal(job.approvedAction?.payload, "TEST AKCJI");
        return { status: "executed", result: "Wiadomość zweryfikowana." };
      },
      async deliver(_job, message) {
        delivered.push(message);
      },
    };

    const worker = new JobWorker(store, agent, sink);
    assert.equal(await worker.runOne(), true);
    assert.equal(agentCalled, false);
    assert.match(delivered[0] ?? "", /Wykonałem AKCJA-000001/);
    assert.equal(store.status().actions_executed, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
