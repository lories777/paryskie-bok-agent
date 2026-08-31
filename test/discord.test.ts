import assert from "node:assert/strict";
import test from "node:test";
import {
  directRequestConversationKey,
  isStatusCommand,
  shouldRespondToAuthorizedMessage,
  splitDiscordMessage,
} from "../src/discord.js";

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
