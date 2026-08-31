import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentStore } from "../src/store.js";
import type { DaktelaTicketObservation } from "../src/store.js";
import type { IncomingMessage } from "../src/types.js";

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: "local",
    conversationExternalId: "local:test",
    externalMessageId: "message-1",
    channelId: "local",
    authorId: "user-1",
    authorName: "Tester",
    content: "Sprawdź sprawę",
    createdAt: "2026-08-26T12:00:00.000Z",
    shouldRespond: true,
    ...overrides,
  };
}

test("wiadomość jest deduplikowana, a zadanie powstaje tylko raz", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-store-"));
  const store = new AgentStore(dir);
  try {
    assert.equal(store.ingest(message()).inserted, true);
    assert.equal(store.ingest(message()).inserted, false);
    const job = store.claimNextJob();
    assert.ok(job);
    assert.equal(job.publicId, "BOK-000001");
    assert.equal(store.claimNextJob(), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("odczyt przez drugi proces nie resetuje aktywnego zadania, a start runtime może je odzyskać", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-recovery-"));
  const worker = new AgentStore(dir);
  try {
    worker.ingest(message());
    assert.ok(worker.claimNextJob());

    const observer = new AgentStore(dir);
    try {
      assert.equal(observer.claimNextJob(), null);
    } finally {
      observer.close();
    }
  } finally {
    worker.close();
  }

  const restartedRuntime = new AgentStore(dir, "bok-agent.sqlite", {
    recoverInterruptedJobs: true,
  });
  try {
    assert.equal(restartedRuntime.claimNextJob()?.publicId, "BOK-000001");
  } finally {
    restartedRuntime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wiadomość obserwowana buduje kontekst bez zadania", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-store-"));
  const store = new AgentStore(dir);
  try {
    const result = store.ingest(message({ shouldRespond: false }));
    assert.equal(result.inserted, true);
    assert.equal(store.claimNextJob(), null);
    const recent = store.recentMessages(result.conversationId, 10);
    assert.equal(recent[0]?.role, "context");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("powiązany kontekst Dakteli łączy tylko inne tickety z tym samym numerem zamówienia", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-related-daktela-"));
  const store = new AgentStore(dir);
  try {
    const current = store.ingest(message({
      platform: "discord",
      conversationExternalId: "daktela-ticket:100",
      externalMessageId: "current",
      authorId: "daktela-monitor",
      content: "Edycja zamówienia 480034410",
    }));
    store.ingest(message({
      platform: "discord",
      conversationExternalId: "daktela-ticket:101",
      externalMessageId: "related",
      authorId: "daktela-monitor",
      content: "Klient prosi, aby zamówienie 480034410 wysłać za pobraniem.",
      shouldRespond: false,
    }));
    store.ingest(message({
      platform: "discord",
      conversationExternalId: "daktela-ticket:102",
      externalMessageId: "unrelated",
      authorId: "daktela-monitor",
      content: "Inne zamówienie 480099999 wymaga anulowania.",
      shouldRespond: false,
    }));
    const related = store.recentRelatedDaktelaContext(
      current.conversationId,
      ["480034410"],
    );
    assert.deepEqual(related.map((item) => item.content), [
      "Klient prosi, aby zamówienie 480034410 wysłać za pobraniem.",
    ]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("zadanie nie widzi wiadomości, które trafiły do kolejki dopiero po jego triggerze", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-job-boundary-"));
  const store = new AgentStore(dir);
  try {
    const first = store.ingest(message({ externalMessageId: "first", content: "Ticket 100" }));
    store.ingest(message({ externalMessageId: "second", content: "Ticket 200" }));
    const job = store.claimNextJob();
    assert.ok(job);
    const visible = store.recentMessages(first.conversationId, 10, job.triggerMessageId);
    assert.deepEqual(visible.map((item) => item.content), ["Ticket 100"]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("propozycje działań dostają stabilne identyfikatory i wymagają approval", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-store-"));
  const store = new AgentStore(dir);
  try {
    store.ingest(message());
    const job = store.claimNextJob();
    assert.ok(job);
    const ids = store.completeJob(job.id, {
      reply: "Mam propozycję.",
      caseState: "action_proposed",
      actionExecution: null,
      proposedActions: [
        {
          kind: "update_daktela",
          summary: "Dodać notatkę",
          target: "zgłoszenie testowe",
          payload: "Treść notatki testowej",
          reason: "Utrwalenie ustalenia",
          risk: "low",
        },
      ],
    });
    assert.deepEqual(ids, ["AKCJA-000001"]);
    assert.equal(
      store.approveActionAndEnqueue("AKCJA-000001", "approver", "approval-1", "local"),
      "BOK-000002",
    );
    assert.equal(
      store.approveActionAndEnqueue("AKCJA-000001", "approver", "approval-2", "local"),
      null,
    );
    const execution = store.claimNextJob();
    assert.equal(execution?.approvedAction?.publicId, "AKCJA-000001");
    store.finishAction(execution?.approvedAction?.id ?? 0, "executed", "Gotowe");
    assert.equal(store.status().actions_executed, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pierwszy skan Dakteli kolejkuje jedną otwartą nieprzypisaną sprawę i deduplikuje stan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-daktela-"));
  const store = new AgentStore(dir);
  const ticket = (
    ticketId: string,
    stage: string,
    assignedUser: string,
    fingerprint: string,
  ): DaktelaTicketObservation => ({
    ticketId,
    title: `Ticket ${ticketId}`,
    category: "Pytanie",
    assignedUser,
    status: "Nowe",
    stage,
    edited: "1 minute",
    editedBy: "System",
    url: `https://daktela.example/tickets/update/${ticketId}`,
    fingerprint,
  });
  try {
    const initial = [
      ticket("100", "Open", "", "a"),
      ticket("101", "Open", "Klaudia", "b"),
      ticket("102", "Closed", "", "c"),
    ];
    assert.deepEqual(
      store.recordDaktelaScan(initial, 1).map((item) => item.ticketId),
      ["100"],
    );
    assert.deepEqual(store.recordDaktelaScan(initial, 1), []);
    const changed = initial.map((item) =>
      item.ticketId === "101" ? { ...item, fingerprint: "b2" } : item,
    );
    assert.deepEqual(
      store.recordDaktelaScan(changed, 1).map((item) => item.ticketId),
      ["101"],
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("limit skanu nie gubi kolejnych zmienionych ticketów", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-daktela-backlog-"));
  const store = new AgentStore(dir);
  const ticket = (ticketId: string, fingerprint: string): DaktelaTicketObservation => ({
    ticketId,
    title: `Ticket ${ticketId}`,
    category: "Pytanie",
    assignedUser: "",
    status: "Nowe",
    stage: "Open",
    edited: "1 minute",
    editedBy: "System",
    url: `https://daktela.example/tickets/update/${ticketId}`,
    fingerprint,
  });
  try {
    store.recordDaktelaScan(
      [ticket("200", "a"), ticket("201", "b"), ticket("202", "c")],
      1,
    );
    const changed = [ticket("200", "a2"), ticket("201", "b2"), ticket("202", "c2")];
    assert.deepEqual(store.recordDaktelaScan(changed, 1).map((item) => item.ticketId), ["200"]);
    assert.deepEqual(store.recordDaktelaScan(changed, 1).map((item) => item.ticketId), ["201"]);
    assert.deepEqual(store.recordDaktelaScan(changed, 1).map((item) => item.ticketId), ["202"]);
    assert.deepEqual(store.recordDaktelaScan(changed, 1), []);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pierwszy fingerprint v7 migruje zapis bez ponownego kolejkowania ticketu", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-daktela-fingerprint-v7-"));
  const store = new AgentStore(dir);
  const base: DaktelaTicketObservation = {
    ticketId: "300",
    title: "Ticket 300",
    category: "Pytanie",
    assignedUser: "",
    status: "Nowe",
    stage: "Open",
    edited: "2026-08-27T10:00:00.000Z",
    editedBy: "System",
    url: "https://daktela.example/tickets/update/300",
    fingerprint: "legacy-fingerprint",
  };
  try {
    store.recordDaktelaScan([base], 1);
    assert.deepEqual(store.recordDaktelaScan([{ ...base, fingerprint: "v7:new-stable" }], 1), []);
    assert.deepEqual(store.recordDaktelaScan([{ ...base, fingerprint: "v7:new-stable" }], 1), []);
    assert.deepEqual(
      store.recordDaktelaScan([{ ...base, fingerprint: "v7:actually-changed" }], 1)
        .map((item) => item.ticketId),
      ["300"],
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wspólny kontekst pobiera tylko obserwowane wiadomości z innych rozmów", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-shared-context-"));
  const store = new AgentStore(dir);
  try {
    const main = store.ingest(message({ conversationExternalId: "channel:main" }));
    store.ingest(
      message({
        conversationExternalId: "channel:reports",
        externalMessageId: "report-1",
        platform: "discord",
        authorName: "ML Bot",
        content: "Raport zamówienia 123",
        shouldRespond: false,
        sharedContext: true,
      }),
    );
    store.ingest(
      message({
        conversationExternalId: "daktela-ticket:99567",
        externalMessageId: "daktela-1",
        platform: "discord",
        authorId: "daktela-monitor",
        authorName: "Monitor Daktela",
        content: "Poprzedni ticket Daktela #99567",
        shouldRespond: false,
        role: "context",
      }),
    );
    store.ingest(
      message({
        conversationExternalId: "channel:other-command",
        externalMessageId: "human-2",
        platform: "discord",
        content: "Zwykłe polecenie",
        shouldRespond: true,
      }),
    );
    const shared = store.recentSharedContext(main.conversationId, 10);
    assert.deepEqual(shared.map((item) => item.content), ["Raport zamówienia 123"]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backfill może oznaczyć istniejącą wiadomość jako bezpieczny wspólny kontekst bez nowego zadania", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-shared-backfill-"));
  const store = new AgentStore(dir);
  try {
    const main = store.ingest(message({ conversationExternalId: "channel:main" }));
    const observed = message({
      conversationExternalId: "channel:reports",
      externalMessageId: "report-existing",
      platform: "discord",
      content: "Raport 480032521",
      shouldRespond: false,
    });
    assert.equal(store.ingest(observed).inserted, true);
    assert.deepEqual(store.recentSharedContext(main.conversationId, 10), []);
    assert.equal(store.ingest({ ...observed, sharedContext: true }).inserted, false);
    assert.deepEqual(
      store.recentSharedContext(main.conversationId, 10).map((item) => item.content),
      ["Raport 480032521"],
    );
    assert.equal(store.claimNextJob()?.publicId, "BOK-000001");
    assert.equal(store.claimNextJob(), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nowszy draft tej samej odpowiedzi zastępuje starszy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-supersede-"));
  const store = new AgentStore(dir);
  try {
    const first = store.ingest(message());
    const firstJob = store.claimNextJob();
    assert.ok(firstJob);
    store.completeJob(firstJob.id, {
      reply: "Pierwsza wersja",
      caseState: "action_proposed",
      actionExecution: null,
      proposedActions: [
        {
          kind: "reply_customer",
          summary: "Odpowiedź",
          target: "Daktela ticket #123",
          payload: "Wersja 1",
          reason: "Test",
          risk: "low",
        },
      ],
    });
    store.ingest(message({ externalMessageId: "message-2", content: "Popraw draft" }));
    const secondJob = store.claimNextJob();
    assert.ok(secondJob);
    store.completeJob(secondJob.id, {
      reply: "Druga wersja",
      caseState: "action_proposed",
      actionExecution: null,
      proposedActions: [
        {
          kind: "reply_customer",
          summary: "Odpowiedź po poprawce",
          target: "Daktela ticket #123",
          payload: "Wersja 2",
          reason: "Uwagi zespołu",
          risk: "low",
        },
      ],
    });
    assert.equal(first.conversationId, secondJob.conversationId);
    assert.deepEqual(store.listProposedActions().map((action) => action.payload), ["Wersja 2"]);
    assert.equal(store.approveActionAndEnqueue("AKCJA-000001", "approver", "old", "local"), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nowy draft może znaleźć i usunąć starszą trasę Discord tej samej sprawy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-delivery-cleanup-"));
  const store = new AgentStore(dir);
  try {
    const incoming = store.ingest(message());
    const next = store.ingest(message({ externalMessageId: "message-2" }));
    assert.ok(incoming.jobId && next.jobId);
    store.recordDiscordDeliveryRoute("old-message", incoming.conversationId, incoming.jobId, "channel-1");
    store.recordDiscordDeliveryRoute("current-message", incoming.conversationId, next.jobId, "channel-1");

    assert.deepEqual(store.previousDiscordDeliveryRoutes(incoming.conversationId, next.jobId), [
      { botMessageId: "old-message", channelId: "channel-1" },
    ]);
    store.removeDiscordDeliveryRoute("old-message");
    assert.deepEqual(store.previousDiscordDeliveryRoutes(incoming.conversationId, next.jobId), []);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nowsza analiza Dakteli bez draftu odrzuca poprzedni draft klienta", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-daktela-supersede-"));
  const store = new AgentStore(dir);
  try {
    store.ingest(message({
      conversationExternalId: "daktela-ticket:123",
      externalMessageId: "daktela:e2e:first:123",
      role: "context",
      authorId: "daktela-e2e",
    }));
    const firstJob = store.claimNextJob();
    assert.ok(firstJob);
    store.completeJob(firstJob.id, {
      reply: "Draft",
      caseState: "action_proposed",
      actionExecution: null,
      proposedActions: [{
        kind: "reply_customer",
        summary: "Odpowiedź",
        target: "Daktela ticket #123",
        payload: "Wersja do klienta",
        reason: "Test",
        risk: "low",
      }],
    });

    store.ingest(message({
      conversationExternalId: "daktela-ticket:123",
      externalMessageId: "daktela:e2e:second:123",
      role: "context",
      authorId: "daktela-e2e",
    }));
    const secondJob = store.claimNextJob();
    assert.ok(secondJob);
    store.completeJob(secondJob.id, {
      reply: "Czy robimy zwrot czy wymianę?",
      caseState: "waiting_for_human",
      actionExecution: null,
      proposedActions: [],
    });

    assert.deepEqual(store.listProposedActions(), []);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ticket Dakteli pamięta przypisany wątek Discorda", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-thread-"));
  const store = new AgentStore(dir);
  try {
    const ticket: DaktelaTicketObservation = {
      ticketId: "321",
      title: "Test",
      category: "Pytanie",
      assignedUser: "",
      status: "Nowe",
      stage: "Open",
      edited: "now",
      editedBy: "System",
      url: "https://daktela.test/tickets/update/321",
      fingerprint: "one",
    };
    store.recordDaktelaScan([ticket], 1);
    store.setDaktelaThreadId("321", "thread-321");
    assert.equal(store.getDaktelaThreadId("321"), "thread-321");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("odpowiedź na wiadomość bota wraca do dokładnej rozmowy ticketu", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-discord-route-"));
  const store = new AgentStore(dir);
  try {
    const incoming = store.ingest(
      message({
        platform: "discord",
        conversationExternalId: "daktela-ticket:99517",
        externalMessageId: "daktela:v5:99517",
      }),
    );
    const job = store.claimNextJob();
    assert.ok(job);
    store.recordDiscordDeliveryRoute("discord-bot-message", incoming.conversationId, job.id, "channel-1");
    assert.deepEqual(store.resolveDiscordReplyRoute("discord-bot-message"), {
      conversationId: incoming.conversationId,
      conversationExternalId: "daktela-ticket:99517",
    });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pracownik BOK może oznaczyć draft jako gotowy bez tworzenia zadania wysyłki", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-draft-ready-"));
  const store = new AgentStore(dir);
  try {
    store.ingest(message());
    const job = store.claimNextJob();
    assert.ok(job);
    store.completeJob(job.id, {
      reply: "Draft gotowy.",
      caseState: "action_proposed",
      actionExecution: null,
      proposedActions: [
        {
          kind: "reply_customer",
          summary: "Odpowiedź",
          target: "Daktela ticket #123",
          payload: "Dzień dobry, odpowiedź testowa.",
          reason: "Test",
          risk: "low",
        },
      ],
    });
    assert.equal(store.decideDraft("AKCJA-000001", "approved", "bok-user"), "updated");
    assert.equal(store.decideDraft("AKCJA-000001", "approved", "bok-user"), "already_decided");
    assert.equal(store.claimNextJob(), null);
    assert.equal(store.status().actions_approved, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("odpowiedź BOK zapisuje uogólnioną regułę, a monitor nie może uczyć agenta", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-learning-"));
  const store = new AgentStore(dir);
  try {
    store.ingest(message({ content: "Przy takiej reklamacji zawsze prosimy o zdjęcie produktu." }));
    const humanJob = store.claimNextJob();
    assert.ok(humanJob);
    store.completeJob(humanJob.id, {
      reply: "Zapamiętam tę zasadę.",
      caseState: "answered",
      actionExecution: null,
      proposedActions: [],
      learnedRules: [
        {
          situation: "Reklamacja dotycząca uszkodzonego produktu",
          instruction: "Poproś klienta o zdjęcie produktu.",
        },
      ],
    });
    assert.equal(store.activeLearnedRules().length, 1);

    store.ingest(
      message({
        conversationExternalId: "daktela-ticket:123",
        externalMessageId: "daktela:v6:123",
        authorId: "daktela-monitor",
        role: "context",
      }),
    );
    const monitorJob = store.claimNextJob();
    assert.ok(monitorJob);
    store.completeJob(monitorJob.id, {
      reply: "Notatka.",
      caseState: "answered",
      actionExecution: null,
      proposedActions: [],
      learnedRules: [
        { situation: "Nieprawdziwa zasada", instruction: "Nie zapisuj jej." },
      ],
    });
    assert.equal(store.activeLearnedRules().length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
