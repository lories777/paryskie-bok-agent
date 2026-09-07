import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCardText, cardRenderHash, type MasterlinkCard } from '../src/masterlink-discord.js';
const card: MasterlinkCard = { bindingId: '1', channelId: '111111111111111111', rootMessageId: '222222222222222222',
  ticketId: '12345678-1234-4234-8234-123456789012', ticketNumber: 42, revision: 3, status: 'open', channel: 'email',
  suggestionId: '12345678-1234-4234-8234-123456789013', body: 'Dzień dobry,\n\nDokładna odpowiedź zapisana w ML.',
  suggestionStatus: 'suggested', contentHash: 'a'.repeat(64), botMessageId: null, renderHash: null, actionOnly: false, outcome: 'ticket_ai_awaiting_approval', operatorPrompt: null };
test('Discord displays the exact ML answer and ignores delivery receipts in render identity', () => {
  assert.ok(canonicalCardText(card).endsWith(card.body!));
  assert.equal(cardRenderHash(card), cardRenderHash({ ...card, botMessageId: '333333333333333333', renderHash: 'b'.repeat(64) }));
  assert.notEqual(cardRenderHash(card), cardRenderHash({ ...card, body: 'Poprawiona w ML.' }));
  assert.notEqual(cardRenderHash(card), cardRenderHash({ ...card, suggestionStatus: 'invalidated' }));
});
test('blocked agent question is read from ML instead of generating another local answer', () => {
  assert.ok(canonicalCardText({ ...card, body: null, outcome: 'ticket_ai_blocked', operatorPrompt: 'Czy potwierdzamy zwrot?' }).endsWith('Czy potwierdzamy zwrot?'));
});
