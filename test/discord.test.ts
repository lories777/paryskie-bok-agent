import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canDecideDraft,
  directRequestConversationKey,
  isStatusCommand,
  persistDraftDecision,
  shouldRespondToAuthorizedMessage,
  splitDiscordMessage,
} from "../src/discord.js";
import { AgentStore } from "../src/store.js";

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
    }), { status: "execution_queued", jobPublicId: "BOK-000002" });
    assert.deepEqual(persistDraftDecision(store, {
      publicId: draftId,
      decision: "ready",
      decidedBy: "approver-1",
      interactionId: "interaction-1-retry",
      channelId: "channel-1",
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
