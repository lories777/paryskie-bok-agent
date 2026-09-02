import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canDecideDraft,
  directRequestConversationKey,
  DiscordGateway,
  isDiscordUnknownMessage,
  isConfiguredDiscordCommandChannel,
  isStatusCommand,
  persistDraftDecision,
  publishThenRemoveSuperseded,
  resolveVerifiedCorrectionAuthorization,
  resolveVerifiedCorrectionSource,
  shouldRespondToAuthorizedMessage,
  splitDiscordMessage,
} from "../src/discord.js";
import { loadConfig } from "../src/config.js";
import { AgentStore } from "../src/store.js";
import type { ClaimedJob } from "../src/types.js";

test("krótka odpowiedź pozostaje w jednym kawałku", () => {
  assert.deepEqual(splitDiscordMessage("gotowe"), ["gotowe"]);
});

test("długa odpowiedź jest dzielona bez utraty treści", () => {
  const message = Array.from({ length: 80 }, (_, index) => `wiersz-${index}`).join("\n");
  const chunks = splitDiscordMessage(message, 120);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join("\n"), message);
  assert.ok(chunks.every((chunk) => chunk.length <= 120));
});

test("komenda statusu jest rozpoznawana bez uruchamiania agenta", () => {
  assert.equal(isStatusCommand("!bok status"), true);
  assert.equal(isStatusCommand("  !BOK   status  "), true);
  assert.equal(isStatusCommand("jaki jest status?"), false);
});

test("decyzja draftu wymaga jawnej allowlisty approverów i bez niej jest blokowana", () => {
  assert.equal(canDecideDraft("allowed-bok-user", new Set()), false);
  assert.equal(canDecideDraft("allowed-bok-user", new Set(["explicit-approver"])), false);
  assert.equal(canDecideDraft("explicit-approver", new Set(["explicit-approver"])), true);
});

test("źródło korekty wymaga jawnie dozwolonego użytkownika albo roli", () => {
  assert.deepEqual(
    resolveVerifiedCorrectionAuthorization(
      "bok-manager",
      [],
      new Set(["bok-manager"]),
      new Set(),
    ),
    { authorizationKind: "allowed_user", authorizationId: "bok-manager" },
  );
  assert.deepEqual(
    resolveVerifiedCorrectionAuthorization(
      "bok-worker",
      ["ordinary", "bok-role"],
      new Set(),
      new Set(["bok-role"]),
    ),
    { authorizationKind: "allowed_role", authorizationId: "bok-role" },
  );
  assert.equal(
    resolveVerifiedCorrectionAuthorization(
      "outsider",
      ["ordinary"],
      new Set(),
      new Set(["bok-role"]),
    ),
    undefined,
  );
});

test("gateway ufa tylko reply albo jawnemu mention w command channel", () => {
  const authorization = { authorizationKind: "allowed_role" as const, authorizationId: "bok-role" };
  assert.deepEqual(resolveVerifiedCorrectionSource({
    authorization,
    inExplicitCommandChannel: false,
    mentionedAgent: false,
    replyingToAgent: true,
    replyToBotMessageId: "bot-card-1",
  }), {
    sourceKind: "reply",
    replyToBotMessageId: "bot-card-1",
    ...authorization,
  });
  assert.deepEqual(resolveVerifiedCorrectionSource({
    authorization,
    inExplicitCommandChannel: true,
    mentionedAgent: true,
    replyingToAgent: false,
  }), {
    sourceKind: "direct_mention",
    replyToBotMessageId: null,
    ...authorization,
  });
  assert.equal(resolveVerifiedCorrectionSource({
    authorization,
    inExplicitCommandChannel: true,
    mentionedAgent: false,
    replyingToAgent: false,
  }), undefined, "zwykła wiadomość bez mention nie uczy pamięci");
  assert.equal(resolveVerifiedCorrectionSource({
    authorization,
    inExplicitCommandChannel: false,
    mentionedAgent: true,
    replyingToAgent: false,
  }), undefined, "mention w observe-only nie uczy pamięci");
});

test("direct mention rozpoznaje tylko skonfigurowany command channel lub jego thread", () => {
  const commandChannels = new Set(["bok-command"]);
  assert.equal(isConfiguredDiscordCommandChannel("bok-command", null, commandChannels), true);
  assert.equal(isConfiguredDiscordCommandChannel("thread-1", "bok-command", commandChannels), true);
  assert.equal(
    isConfiguredDiscordCommandChannel("daktela-escalation", null, commandChannels),
    false,
  );
});

test("Gotowe atomowo zatwierdza draft i kolejkuje dokładnie jedno wykonanie", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-discord-decision-"));
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
      createdAt: "2026-09-01T08:00:00.000Z",
      shouldRespond: true,
      role: "context",
    });
    const sourceJob = store.claimNextJob();
    assert.ok(sourceJob);
    const [draftId] = store.completeJob(sourceJob.id, {
      reply: "DAKTELA #100024 — odpowiedź gotowa.",
      caseState: "action_proposed",
      proposedActions: [{
        kind: "reply_customer",
        summary: "Odpowiedź klientowi",
        target: "Daktela ticket #100024",
        payload: "Dzień dobry, odpowiedź testowa.",
        reason: "Obsługa zgłoszenia",
        risk: "medium",
      }],
      learnedRules: [],
      actionExecution: null,
    });
    assert.equal(draftId, "AKCJA-000001");

    assert.deepEqual(persistDraftDecision(store, {
      publicId: draftId,
      decision: "ready",
      decidedBy: "approver-1",
      interactionId: "interaction-1",
      channelId: "channel-1",
      externalActionsEnabled: true,
      customerReplySenderReady: true,
    }), { status: "execution_queued", jobPublicId: "BOK-000002" });
    assert.deepEqual(persistDraftDecision(store, {
      publicId: draftId,
      decision: "ready",
      decidedBy: "approver-1",
      interactionId: "interaction-1-retry",
      channelId: "channel-1",
      externalActionsEnabled: true,
      customerReplySenderReady: true,
    }), { status: "already_decided" });

    const execution = store.claimNextJob();
    assert.equal(execution?.publicId, "BOK-000002");
    assert.equal(execution?.approvedAction?.publicId, draftId);
    assert.equal(store.claimNextJob(), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("brak mutacji lub gotowego sendera zapisuje tylko review i nie tworzy joba", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-discord-off-"));
  const store = new AgentStore(dir);
  try {
    store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:100027",
      externalMessageId: "daktela:v7:100027:fingerprint",
      channelId: "channel-1",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "Przeanalizuj Daktela #100027",
      createdAt: "2026-09-01T08:00:00.000Z",
      shouldRespond: true,
      role: "context",
    });
    const sourceJob = store.claimNextJob();
    assert.ok(sourceJob);
    const [draftId] = store.completeJob(sourceJob.id, {
      reply: "DAKTELA #100027 — odpowiedź gotowa.",
      caseState: "action_proposed",
      proposedActions: [{
        kind: "reply_customer",
        summary: "Odpowiedź klientowi",
        target: "Daktela ticket #100027",
        payload: "Draft tylko do wglądu.",
        reason: "Test OFF",
        risk: "medium",
      }],
      learnedRules: [],
      actionExecution: null,
    });
    assert.equal(draftId, "AKCJA-000001");

    assert.deepEqual(persistDraftDecision(store, {
      publicId: draftId,
      decision: "ready",
      decidedBy: "approver-1",
      interactionId: "interaction-off",
      channelId: "channel-1",
      externalActionsEnabled: false,
      customerReplySenderReady: false,
    }), { status: "review_recorded" });
    assert.equal(store.status().actions_proposed, 1);
    assert.equal(store.status().actions_approved ?? 0, 0);
    assert.equal(store.status().draft_reviews, 1);
    assert.equal(store.claimNextJob(), null);

    store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:100032",
      externalMessageId: "daktela:v7:100032:fingerprint",
      channelId: "channel-1",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "Przeanalizuj Daktela #100032",
      createdAt: "2026-09-01T08:01:00.000Z",
      shouldRespond: true,
      role: "context",
    });
    const secondSourceJob = store.claimNextJob();
    assert.ok(secondSourceJob);
    const [secondDraftId] = store.completeJob(secondSourceJob.id, {
      reply: "DAKTELA #100032 — odpowiedź gotowa.",
      caseState: "action_proposed",
      proposedActions: [{
        kind: "reply_customer",
        summary: "Odpowiedź klientowi",
        target: "Daktela ticket #100032",
        payload: "Draft przy niegotowym senderze.",
        reason: "Test sender gate",
        risk: "medium",
      }],
      learnedRules: [],
      actionExecution: null,
    });
    assert.equal(secondDraftId, "AKCJA-000002");
    assert.deepEqual(persistDraftDecision(store, {
      publicId: secondDraftId,
      decision: "ready",
      decidedBy: "approver-1",
      interactionId: "interaction-sender-off",
      channelId: "channel-1",
      externalActionsEnabled: true,
      customerReplySenderReady: false,
    }), { status: "review_recorded" });
    assert.equal(store.status().actions_proposed, 2);
    assert.equal(store.status().actions_approved ?? 0, 0);
    assert.equal(store.status().draft_reviews, 2);
    assert.equal(store.claimNextJob(), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DiscordGateway blokuje wykonanie także po zmianie konfiguracji i nie deleguje reply_customer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-discord-runtime-gate-"));
  const store = new AgentStore(dir);
  const action = {
    id: 1,
    publicId: "AKCJA-000001",
    kind: "reply_customer" as const,
    summary: "Odpowiedź",
    target: "Daktela ticket #100028",
    payload: "Treść, której nie wolno wysłać",
    reason: "Test fail-closed",
    risk: "medium" as const,
  };
  const job: ClaimedJob = {
    id: 2,
    publicId: "BOK-000002",
    conversationId: 1,
    triggerMessageId: 2,
    platform: "discord",
    channelId: "channel-1",
    externalMessageId: "approval-1",
    attempts: 1,
    approvedAction: action,
  };
  try {
    let delegated = 0;
    const off = new DiscordGateway({
      ...loadConfig({ BOK_AGENT_EXTERNAL_ACTIONS: "false" }, "/tmp/project"),
      discordToken: "test-token",
    }, store);
    off.setApprovedActionExecutor(async () => {
      delegated += 1;
      return { status: "executed", result: "nie wolno" };
    });
    assert.deepEqual(await off.executeApprovedAction(job), {
      status: "failed",
      result: "Wykonanie zewnętrzne jest wyłączone w konfiguracji runtime.",
    });

    const on = new DiscordGateway({
      ...loadConfig({ BOK_AGENT_EXTERNAL_ACTIONS: "true" }, "/tmp/project"),
      discordToken: "test-token",
    }, store);
    on.setApprovedActionExecutor(async () => {
      delegated += 1;
      return { status: "executed", result: "nie wolno" };
    });
    const result = await on.executeApprovedAction(job);
    assert.equal(result?.status, "failed");
    assert.match(result?.result ?? "", /fail-closed/);
    const notifyResult = await on.executeApprovedAction({
      ...job,
      approvedAction: {
        ...action,
        kind: "discord_notify",
        target: "channel-1",
      },
    });
    assert.equal(notifyResult?.status, "failed");
    assert.match(notifyResult?.result ?? "", /fail-closed|idempotentnego executora/);
    assert.equal(delegated, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nowa karta jest potwierdzana przed usunięciem poprzedniej", async () => {
  const events: string[] = [];
  await publishThenRemoveSuperseded(
    async () => { events.push("published"); },
    async () => { events.push("removed-old"); },
  );
  assert.deepEqual(events, ["published", "removed-old"]);

  const failedEvents: string[] = [];
  await assert.rejects(() => publishThenRemoveSuperseded(
    async () => {
      failedEvents.push("publish-failed");
      throw new Error("Discord unavailable");
    },
    async () => { failedEvents.push("removed-old"); },
  ));
  assert.deepEqual(failedEvents, ["publish-failed"]);
});

test("receipt jest zapisany przed fetch i retry nie publikuje drugiej karty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-discord-receipt-"));
  const store = new AgentStore(dir);
  try {
    store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:100031",
      externalMessageId: "daktela:v7:100031:fingerprint",
      channelId: "channel-1",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "Przeanalizuj Daktela #100031",
      createdAt: "2026-09-01T10:00:00.000Z",
      shouldRespond: true,
      role: "context",
    });
    const job = store.claimNextJob();
    assert.ok(job);
    const gateway = new DiscordGateway({
      ...loadConfig({}, "/tmp/project"),
      discordToken: "test-token",
    }, store);
    gateway.client.user = { id: "bot-1" } as typeof gateway.client.user;

    let sendCalls = 0;
    let confirmationCalls = 0;
    const channel = {
      isTextBased: () => true,
      isDMBased: () => false,
      messages: {
        async fetch(messageId: string) {
          if (messageId === job.externalMessageId) throw new Error("source not found");
          assert.equal(messageId, "discord-card-1");
          return { id: messageId, channelId: "channel-1", content: "Nowa karta", author: { id: "bot-1" } };
        },
        async delete() {},
      },
      async send(options: { content: string; nonce?: string; enforceNonce?: boolean }) {
        sendCalls += 1;
        assert.equal(options.nonce, `bok-${job.id.toString(36)}-0`);
        assert.equal(options.enforceNonce, true);
        return {
          id: "discord-card-1",
          channelId: "channel-1",
          async fetch() {
            confirmationCalls += 1;
            throw new Error("Discord 429 during confirmation");
          },
        };
      },
    };
    gateway.client.channels.fetch = async () => channel as never;

    await assert.rejects(() => gateway.deliver(job, "Nowa karta"), /429/);
    assert.deepEqual(store.currentDiscordDeliveryRoutes(job.id), [{
      botMessageId: "discord-card-1",
      channelId: "channel-1",
    }]);
    await gateway.deliver(job, "Nowa karta");
    assert.equal(sendCalls, 1);
    assert.equal(confirmationCalls, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("błąd kasowania starej karty zachowuje receipt do retry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-agent-discord-delete-retry-"));
  const store = new AgentStore(dir);
  try {
    const first = store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:100034",
      externalMessageId: "daktela:v7:100034:old",
      channelId: "channel-1",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "Stara analiza",
      createdAt: "2026-09-01T10:00:00.000Z",
      shouldRespond: true,
      role: "context",
    });
    const oldJob = store.claimNextJob();
    assert.ok(oldJob);
    store.completeJob(oldJob.id, {
      reply: "Stara karta",
      caseState: "waiting_for_human",
      proposedActions: [],
      actionExecution: null,
    });
    store.recordDiscordDeliveryRoute("old-card", first.conversationId, oldJob.id, "channel-1");

    store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:100034",
      externalMessageId: "daktela:v7:100034:new",
      channelId: "channel-1",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "Nowa analiza",
      createdAt: "2026-09-01T10:01:00.000Z",
      shouldRespond: true,
      role: "context",
    });
    const newJob = store.claimNextJob();
    assert.ok(newJob);
    const gateway = new DiscordGateway({
      ...loadConfig({}, "/tmp/project"),
      discordToken: "test-token",
    }, store);
    let deleteCalls = 0;
    const channel = {
      isTextBased: () => true,
      isDMBased: () => false,
      messages: {
        async delete(messageId: string) {
          deleteCalls += 1;
          assert.equal(messageId, "old-card");
          if (deleteCalls === 1) throw new Error("Discord 502 Bad Gateway");
        },
      },
    };
    gateway.client.channels.fetch = async () => channel as never;

    await assert.rejects(() => gateway.discardSuperseded(newJob), /502/);
    assert.equal(store.previousDiscordDeliveryRoutes(first.conversationId, newJob.id).length, 1);
    await gateway.discardSuperseded(newJob);
    assert.equal(deleteCalls, 2);
    assert.deepEqual(store.previousDiscordDeliveryRoutes(first.conversationId, newJob.id), []);
    assert.equal(isDiscordUnknownMessage({ code: 10008 }), true);
    assert.equal(isDiscordUnknownMessage({ status: 404 }), true);
    assert.equal(isDiscordUnknownMessage({ status: 429 }), false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent nie wtrąca się do wiadomości skierowanej do innych pracowników", () => {
  assert.equal(shouldRespondToAuthorizedMessage({
    authorized: true,
    inCommandChannel: true,
    mentionedAgent: false,
    replyingToAgent: false,
    mentionsOtherHumans: true,
  }), false);
  assert.equal(shouldRespondToAuthorizedMessage({
    authorized: true,
    inCommandChannel: true,
    mentionedAgent: true,
    replyingToAgent: false,
    mentionsOtherHumans: true,
  }), true);
});

test("zwykła wiadomość na kanale BOK nie uruchamia agenta", () => {
  assert.equal(shouldRespondToAuthorizedMessage({
    authorized: true,
    inCommandChannel: true,
    mentionedAgent: false,
    replyingToAgent: false,
    mentionsOtherHumans: false,
  }), false);
});

test("oznaczenie agenta uruchamia osobną rozmowę dla każdego nowego zadania", () => {
  assert.equal(shouldRespondToAuthorizedMessage({
    authorized: true,
    inCommandChannel: true,
    mentionedAgent: true,
    replyingToAgent: false,
    mentionsOtherHumans: false,
  }), true);
  assert.equal(directRequestConversationKey("123"), "discord-request:123");
  assert.notEqual(directRequestConversationKey("123"), directRequestConversationKey("124"));
});
