import { nativeBokOutboundUrl } from "./native-bok-outbound.js";
/** Uwierzytelniony odczyt tej samej kanonicznej sprawy co w panelu ML. */
import { createHash } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { DaktelaVerifiedSourceRead } from './daktela-read-session.js';
import { nativeBokDaktelaDecisionSourceSchema, type NativeBokDaktelaDecisionSource } from './native-bok-attachment-evidence.js';
export class MasterlinkReadError extends Error {
  constructor(readonly code: 'mail_source_not_configured' | 'mail_source_unavailable' | 'mail_source_unauthorized' | 'mail_source_stale' | 'mail_source_too_large' | 'mail_source_binding_invalid') { super(code); this.name = 'MasterlinkReadError'; }
}
export class MasterlinkReadSession {
  private verified = false;
  constructor(private readonly config: AppConfig) {}
  configurationReady() { return Boolean(this.config.nativeOutboundUrl && this.config.nativeOutboundToken); }
  identityVerified() { return this.verified; }
  private async request(path: string, body?: unknown, signal?: AbortSignal) {
    if (!this.configurationReady()) throw new MasterlinkReadError('mail_source_not_configured');
    const response = await fetch(nativeBokOutboundUrl(this.config.nativeOutboundUrl!, `/api/bok-runtime${path}`), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.config.nativeOutboundToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) throw new MasterlinkReadError('mail_source_unauthorized');
    if (response.status === 409) throw new MasterlinkReadError('mail_source_stale');
    if (!response.ok || !response.body) throw new MasterlinkReadError('mail_source_unavailable');
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 72 * 1024 * 1024) throw new MasterlinkReadError('mail_source_too_large');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()) as unknown; }
    catch { throw new MasterlinkReadError('mail_source_binding_invalid'); }
  }
  async verify() {
    this.verified = false;
    const result = await this.request('/v1/mail-source/ready');
    if (typeof result !== 'object' || result === null || !('ready' in result) || result.ready !== true) {
      throw new MasterlinkReadError('mail_source_unavailable');
    }
    this.verified = true;
  }
  async withExactSource<T>(source: NativeBokDaktelaDecisionSource, signal: AbortSignal,
    execute: (verified: DaktelaVerifiedSourceRead) => Promise<T>): Promise<T> {
    if (source.system !== 'masterlink') throw new MasterlinkReadError('mail_source_binding_invalid');
    const response = await this.request('/v1/mail-source', { source }, signal);
    if (!response || typeof response !== 'object' || !('source' in response) || !('attachments' in response)) {
      throw new MasterlinkReadError('mail_source_binding_invalid');
    }
    const parsedSource = nativeBokDaktelaDecisionSourceSchema.safeParse(response.source);
    if (!parsedSource.success) throw new MasterlinkReadError('mail_source_binding_invalid');
    const verifiedSource = parsedSource.data;
    if (verifiedSource.snapshotHash !== source.snapshotHash || !Array.isArray(response.attachments)
      || response.attachments.length !== source.attachments.length) throw new MasterlinkReadError('mail_source_binding_invalid');
    const incomingAttachments = response.attachments;
    const attachments = source.attachments.map((expected, index) => {
      const item: unknown = incomingAttachments[index];
      if (!item || typeof item !== 'object' || !('base64' in item) || typeof item.base64 !== 'string') {
        throw new MasterlinkReadError('mail_source_binding_invalid');
      }
      const bytes = Buffer.from(item.base64, 'base64');
      if (bytes.length !== expected.sizeBytes || bytes.toString('base64') !== item.base64
        || createHash('sha256').update(bytes).digest('hex') !== expected.sourceHash) throw new MasterlinkReadError('mail_source_binding_invalid');
      return { source: expected, bytes };
    });
    return execute({ source: verifiedSource, attachments });
  }
}
