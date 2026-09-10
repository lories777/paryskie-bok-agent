import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../src/config.js';
import { MasterlinkReadError, MasterlinkReadSession } from '../src/masterlink-read-session.js';

test('odczyt ML zachowuje kody HTTP bez ujawniania treści odpowiedzi serwera', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, code] of [[401, 'mail_source_unauthorized'], [403, 'mail_source_unauthorized'], [409, 'mail_source_stale'], [503, 'mail_source_unavailable']] as const) {
      globalThis.fetch = async () => new Response('private server detail', { status });
      const reader = new MasterlinkReadSession({ nativeOutboundUrl: 'https://ml.example/api/agent/v1/report', nativeOutboundToken: 'test-only' } as AppConfig);
      await assert.rejects(reader.verify(), e => e instanceof MasterlinkReadError && e.code === code && !e.message.includes('private'));
      assert.equal(reader.identityVerified(), false);
    }
    globalThis.fetch = async () => new Response('invalid private JSON', { status: 200 });
    const reader = new MasterlinkReadSession({ nativeOutboundUrl: 'https://ml.example/api/agent/v1/report', nativeOutboundToken: 'test-only' } as AppConfig);
    await assert.rejects(reader.verify(), e => e instanceof MasterlinkReadError && e.code === 'mail_source_binding_invalid');
  } finally { globalThis.fetch = original; }
});
