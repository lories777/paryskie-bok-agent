import type { AppConfig } from '../config.js';
import type { MasterLinkApi } from '../types.js';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class MasterLinkHttpError extends Error {
  constructor(
    readonly status: number | null,
    readonly safeCode: string,
    readonly retryable: boolean,
  ) {
    super(status == null ? 'Błąd połączenia z MasterLinkiem.' : `MasterLink API zwróciło HTTP ${status}.`);
    this.name = 'MasterLinkHttpError';
  }
}

type Fetch = typeof globalThis.fetch;

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new MasterLinkHttpError(response.status, 'response_too_large', false);
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new MasterLinkHttpError(response.status, 'response_too_large', false);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MasterLinkHttpError(response.status, 'invalid_json', false);
  }
}

function apiErrorCode(body: unknown): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error.slice(0, 80);
  }
  return 'http_error';
}

export class HttpMasterLinkApi implements MasterLinkApi {
  private cookie: string | null = null;
  private loginPromise: Promise<void> | null = null;

  constructor(
    private readonly config: Pick<AppConfig, 'apiBaseUrl' | 'username' | 'password' | 'timeoutMs'>,
    private readonly fetchFn: Fetch = globalThis.fetch,
  ) {}

  private async login(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      let response: Response;
      try {
        response = await this.fetchFn(`${this.config.apiBaseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ login: this.config.username, password: this.config.password }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new MasterLinkHttpError(null, 'timeout', true);
        }
        throw new MasterLinkHttpError(null, 'connection_error', true);
      }
      const body = await boundedJson(response);
      if (!response.ok) throw new MasterLinkHttpError(response.status, apiErrorCode(body), response.status >= 500);

      const headers = response.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
      const session = setCookies
        .flatMap((entry) => entry.split(/,(?=\s*[^;,]+=)/))
        .map((entry) => entry.trim().split(';', 1)[0] ?? '')
        .find((entry) => entry.startsWith('masterlink_session='));
      if (!session) throw new MasterLinkHttpError(response.status, 'session_cookie_missing', false);
      this.cookie = session;
    })().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    retryAuth = true,
  ): Promise<unknown> {
    if (!path.startsWith('/api/')) throw new Error('Niedozwolona ścieżka MasterLink API.');
    if (!this.cookie) await this.login();
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.apiBaseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          cookie: this.cookie!,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new MasterLinkHttpError(null, 'timeout', true);
      }
      throw new MasterLinkHttpError(null, 'connection_error', true);
    }
    const payload = await boundedJson(response);
    if (response.status === 401 && retryAuth) {
      this.cookie = null;
      await this.login();
      return this.request(method, path, body, false);
    }
    if (!response.ok) {
      throw new MasterLinkHttpError(response.status, apiErrorCode(payload), response.status === 429 || response.status >= 500);
    }
    return payload;
  }

  async ping(): Promise<void> {
    await this.request('GET', '/api/auth/me');
  }

  async getOrderDetail(id: string): Promise<Record<string, unknown>> {
    const value = await this.request('GET', `/api/orders/${encodeURIComponent(id)}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new MasterLinkHttpError(200, 'invalid_order_payload', false);
    }
    return value as Record<string, unknown>;
  }

  get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }

  put(path: string, body: unknown): Promise<unknown> {
    return this.request('PUT', path, body);
  }
}
