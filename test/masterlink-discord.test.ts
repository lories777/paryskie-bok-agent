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

test('published ML knowledge reaches the same agent prompt and rejects changed content', async () => {
  const { renderCanonicalMasterlinkKnowledge } = await import('../src/native-bok-daktela-decision-engine.js');
  const { NATIVE_BOK_KNOWLEDGE } = await import('./native-bok-fixtures.js');
  const text = renderCanonicalMasterlinkKnowledge(NATIVE_BOK_KNOWLEDGE, 'PL');
  assert.ok(text.includes(NATIVE_BOK_KNOWLEDGE.snapshotHash));
  assert.ok(text.includes(NATIVE_BOK_KNOWLEDGE.documents[0]!.content));
  const altered = structuredClone(NATIVE_BOK_KNOWLEDGE); altered.documents[0]!.content = 'Nieopublikowana zmiana';
  assert.throws(() => renderCanonicalMasterlinkKnowledge(altered, 'PL'));
});


test('expired case clears its Discord body and does not reveal the old answer', () => {
  const text = canonicalCardText({ ...card, expired: true });
  assert.ok(text.includes('usunięta')); assert.ok(!text.includes(card.body!));
});

test('mail read uses the runtime path for both origin and full configured URLs', async () => {
  const { MasterlinkReadSession } = await import('../src/masterlink-read-session.js');
  const { loadConfig } = await import('../src/config.js');
  const previous = globalThis.fetch; const urls: string[] = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return new Response(JSON.stringify({ ready: true })); };
  try {
    for (const base of ['https://ml.paryskie.pl', 'https://ml.paryskie.pl/api/bok-runtime']) {
      const session = new MasterlinkReadSession({ ...loadConfig({}), nativeOutboundUrl: base, nativeOutboundToken: 'a'.repeat(32) });
      await session.verify(); assert.equal(session.identityVerified(), true);
    }
    assert.deepEqual(urls, ['https://ml.paryskie.pl/api/bok-runtime/v1/mail-source/ready', 'https://ml.paryskie.pl/api/bok-runtime/v1/mail-source/ready']);
  } finally { globalThis.fetch = previous; }
});
