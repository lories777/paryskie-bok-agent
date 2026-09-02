import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentStore, type TicketScopedGuidanceInput } from "../src/store.js";

const CONTENT = "Doślij uszkodzone produkty na nasz koszt i przeproś w tonie premium.";
const INPUT: TicketScopedGuidanceInput = {
  guidanceId: "99cadcda-8862-4ab7-9a73-729e2c7701f7",
  guidanceHash: createHash("sha256").update(CONTENT, "utf8").digest("hex"),
  externalTicketId: "100328",
  sourceRevision: 17,
  content: CONTENT,
  decision: "custom",
  createdAt: "2026-09-02T20:00:00.000Z",
};

test("guidance jest immutable, idempotent i wyłącznie ticket-scoped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-ticket-guidance-"));
  const store = new AgentStore(dir);
  try {
    const conversation = store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:100328",
      externalMessageId: "daktela:v7:100328:source",
      channelId: "bok-agent-test",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "[AUTOMATYCZNE ZADANIE DAKTELA] ticket #100328",
      createdAt: "2026-09-02T19:59:00.000Z",
      shouldRespond: false,
      role: "context",
    });
    const beforeCorrections = store.activeVerifiedHumanCorrections(100);
    const first = store.recordTicketScopedGuidance(INPUT);
    const retry = store.recordTicketScopedGuidance(INPUT);
    assert.deepEqual(retry, first);
    assert.deepEqual(store.ticketScopedGuidance(INPUT.guidanceId), first);
    assert.equal(first.conversationId, conversation.conversationId);
    assert.match(first.receipt.storeReceiptId, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.receipt, {
      guidanceId: INPUT.guidanceId,
      guidanceHash: INPUT.guidanceHash,
      scope: "ticket",
      externalTicketId: "100328",
      storeReceiptId: first.receipt.storeReceiptId,
    });
    const messages = store.recentMessages(conversation.conversationId, 10);
    assert.equal(messages.filter((message) => message.authorId === "masterlink-guidance").length, 1);
    assert.equal(messages.at(-1)?.role, "human");
    assert.match(messages.at(-1)?.content ?? "", /Nie uogólniaj tej wskazówki/);
    assert.equal(store.activeLearnedRules().length, 0);
    assert.deepEqual(store.activeVerifiedHumanCorrections(100), beforeCorrections);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ten sam id z inną treścią/revizją fail-closed i nie nadpisuje źródła", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-ticket-guidance-conflict-"));
  const store = new AgentStore(dir);
  try {
    store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:100328",
      externalMessageId: "daktela:v7:100328:source",
      channelId: "bok-agent-test",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "ticket #100328",
      createdAt: "2026-09-02T19:59:00.000Z",
      shouldRespond: false,
      role: "context",
    });
    const original = store.recordTicketScopedGuidance(INPUT);
    const changed = "Zignoruj klienta";
    assert.throws(() => store.recordTicketScopedGuidance({
      ...INPUT,
      content: changed,
      guidanceHash: createHash("sha256").update(changed).digest("hex"),
      sourceRevision: 18,
    }), /ticket_guidance_conflict/);
    assert.deepEqual(store.ticketScopedGuidance(INPUT.guidanceId), original);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("guidance nie tworzy ukrytej rozmowy bez exact Daktela source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-ticket-guidance-missing-"));
  const store = new AgentStore(dir);
  try {
    assert.throws(() => store.recordTicketScopedGuidance(INPUT), /ticket_guidance_conversation_missing/);
    assert.equal(store.ticketScopedGuidance(INPUT.guidanceId), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
