import { describe, expect, it } from 'vitest';
import { HttpMasterLinkApi } from '../src/masterlink/http-client.js';

describe('HttpMasterLinkApi contract', () => {
  it('loguje się sesją i używa istniejących tras domenowych ML', async () => {
    const calls: Array<{ url: string; method: string; body: unknown; cookie: string | null }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null,
        cookie: headers.get('cookie'),
      });
      if (url.endsWith('/api/auth/login')) {
        return new Response(JSON.stringify({ user: { role: 'bok' } }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'masterlink_session=test-session; Path=/; HttpOnly',
          },
        });
      }
      if (url.endsWith('/api/orders/order-id')) {
        return Response.json({ id: 'order-id', orderNumber: 'PL-1', status: 'imported' });
      }
      return Response.json({ ok: true });
    };

    const api = new HttpMasterLinkApi(
      { apiBaseUrl: 'https://ml.example', username: 'bok-agent', password: 'secret', timeoutMs: 5_000 },
      fakeFetch,
    );
    await api.getOrderDetail('order-id');
    await api.post('/api/orders/order-id/action', { action: 'cancel', reason: 'prośba klienta' });
    await api.put('/api/orders/order-id', { carrierCode: 'inpost' });

    expect(calls.map(({ url, method }) => [method, new URL(url).pathname])).toEqual([
      ['POST', '/api/auth/login'],
      ['GET', '/api/orders/order-id'],
      ['POST', '/api/orders/order-id/action'],
      ['PUT', '/api/orders/order-id'],
    ]);
    expect(calls[0]?.body).toEqual({ login: 'bok-agent', password: 'secret' });
    expect(calls.slice(1).every((call) => call.cookie === 'masterlink_session=test-session')).toBe(true);
  });
});
