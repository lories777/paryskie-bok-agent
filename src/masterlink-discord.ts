/** Jeden zapis odpowiedzi: Discord wyświetla ticket_messages z ML. */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, type ButtonInteraction, type Client, type Message } from 'discord.js';
import { z } from 'zod';
import type { AppConfig } from './config.js';
const cardSchema = z.object({ bindingId: z.string(), channelId: z.string(), rootMessageId: z.string(), ticketId: z.string().uuid(),
  ticketNumber: z.number(), revision: z.number(), status: z.string(), channel: z.string(), suggestionId: z.string().uuid().nullable(),
  body: z.string().nullable(), suggestionStatus: z.string().nullable(), contentHash: z.string().nullable(),
  actionOnly: z.boolean(), outcome: z.string().nullable(), operatorPrompt: z.string().nullable(),
  botMessageId: z.string().nullable(), renderHash: z.string().nullable() });
export type MasterlinkCard = z.infer<typeof cardSchema>;
export function cardRenderHash(card: MasterlinkCard): string {
  const { botMessageId: _botMessageId, renderHash: _renderHash, ...state } = card;
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}
export function canonicalCardText(card: MasterlinkCard): string {
  const header = `[ML #${card.ticketNumber}](https://ml.paryskie.pl/tickets?ticket=${card.ticketId})`;
  if (!card.body && card.operatorPrompt) return `${header}\n\n${card.operatorPrompt}`;
  if (!card.body && card.outcome === 'ticket_ai_run_failed') return `${header}\nAnaliza nie zakończyła się poprawnie. Stan i możliwość ponowienia są w ML.`;
  if (!card.body && card.outcome === 'ticket_ai_blocked') return `${header}\nSprawa wymaga decyzji BOK. Szczegóły są zapisane w ML; odpowiedz tutaj z ustaleniem.`;
  if (card.actionOnly) return `${header} · Wymagane działanie\n\n${card.body ?? card.operatorPrompt ?? ''}`;
  if (!card.body) return `${header}\nAgent przygotowuje odpowiedź. Ustalenia i wynik zapisują się w tej samej sprawie w ML.`;
  const status = card.suggestionStatus === 'suggested' ? 'Odpowiedź do akceptacji'
    : card.suggestionStatus === 'accepted' || card.suggestionStatus === 'edited' ? 'Odpowiedź zaakceptowana'
    : 'Poprzednia odpowiedź — wymaga aktualizacji';
  return `${header} · ${status}\n\n${card.body}`;
}
export class MasterlinkDiscord {
  private syncing = false;
  constructor(private readonly config: AppConfig, private readonly client: Client) {}
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.config.nativeOutboundUrl!.replace(/\/$/, '')}/v1/discord${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${this.config.nativeOutboundToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(240_000),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { message?: unknown };
      throw new Error(typeof result.message === 'string' ? result.message : 'ML nie potwierdził zapisu. Odśwież sprawę i ponów polecenie.');
    }
    return response.json();
  }
  async command(message: Message, content: string, replyToMessageId?: string): Promise<void> {
    const numbers = [...content.matchAll(/\bML\s*#?\s*(\d+)\b/gi)].map((m) => Number(m[1]));
    if (new Set(numbers).size > 1) {
      await message.reply({ content: 'Wskaż jedną sprawę ML dla tej odpowiedzi.', allowedMentions: { parse: [], repliedUser: false } }); return;
    }
    const ticketNumber = numbers[0];
    const show = ticketNumber !== undefined && /^(?:(?:pokaż|pokaz|status|otwórz|otworz)\s+)?ML\s*#?\s*\d+\s*[.!?]?$/i.test(content.trim());
    try {
      await this.request('/command', { actor: { userId: message.author.id, roleIds: message.member?.roles.cache.map((role) => role.id) ?? [],
        name: (message.member?.displayName ?? message.author.displayName).slice(0,100) }, channelId: message.channelId,
        messageId: message.id, ...(replyToMessageId ? { replyToMessageId } : {}), ...(ticketNumber ? { ticketNumber } : {}), content, action: show ? 'show' : 'draft' });
      await this.sync();
    } catch (error) {
      await message.reply({ content: error instanceof Error ? error.message.slice(0,1900) : 'ML nie potwierdził zapisu.', allowedMentions: { parse: [], repliedUser: false } });
    }
  }
  async decision(interaction: ButtonInteraction): Promise<void> {
    const match = interaction.customId.match(/^ml:(send|reject):(\d+):([a-f0-9-]{36}):(\d+)$/);
    if (!match) return;
    await interaction.deferReply({ ephemeral: true });
    if (!this.config.approverUserIds.has(interaction.user.id)) { await interaction.editReply('Nie masz uprawnienia do zatwierdzania odpowiedzi.'); return; }
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    try {
      await this.request('/decision', { actor: { userId: interaction.user.id, roleIds: member.roles.cache.map((role) => role.id), name: member.displayName.slice(0,100) },
        channelId: interaction.channelId, interactionId: interaction.id, decision: match[1], bindingId: match[2], suggestionId: match[3], expectedRevision: Number(match[4]) });
      await interaction.editReply(match[1] === 'send' ? 'Odpowiedź zapisana w ML i przekazana do wysyłki Gmail.' : 'Odpowiedź odrzucona również w ML. Odpowiedz na kartę z poprawką dla agenta.');
      await this.sync();
    } catch (error) { await interaction.editReply(error instanceof Error ? error.message.slice(0,1900) : 'ML nie potwierdził decyzji.'); }
  }
  async sync(): Promise<void> {
    if (this.syncing || !this.client.isReady()) return;
    this.syncing = true;
    try {
      const { cards } = z.object({ cards: z.array(cardSchema).max(100) }).parse(await this.request('/cards'));
      for (const card of cards) {
        const hash = cardRenderHash(card);
        if (hash === card.renderHash) continue;
        const channel = await this.client.channels.fetch(card.channelId);
        if (!channel?.isTextBased() || channel.isDMBased() || !('send' in channel)) throw new Error('Kanał BOK nie jest dostępny.');
        let existing = card.botMessageId ? await channel.messages.fetch(card.botMessageId).catch((error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 10008) return null;
          throw error;
        }) : null;
        if (!existing) {
          const recent = await channel.messages.fetch({ limit: 100 });
          existing = recent.find((m) => m.author.id === this.client.user!.id && m.content.startsWith(`[ML #${card.ticketNumber}](https://ml.paryskie.pl/tickets?ticket=${card.ticketId})`)) ?? null;
        }
        const full = canonicalCardText(card);
        const options = { content: full.length <= 2000 ? full : `${full.slice(0,1600)}\n\nPełna odpowiedź w załączonym pliku i w ML.`,
          files: full.length <= 2000 ? [] : [new AttachmentBuilder(Buffer.from(card.body!, 'utf8'), { name: `ML-${card.ticketNumber}-odpowiedz.txt` })],
          allowedMentions: { parse: [] as [], repliedUser: false }, components: card.suggestionStatus === 'suggested' && card.suggestionId
            ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...(card.channel === 'email' && !card.actionOnly ? [new ButtonBuilder().setCustomId(`ml:send:${card.bindingId}:${card.suggestionId}:${card.revision}`).setLabel('Wyślij przez Gmail').setStyle(ButtonStyle.Success)] : []),
              new ButtonBuilder().setCustomId(`ml:reject:${card.bindingId}:${card.suggestionId}:${card.revision}`).setLabel('Niepełna — do poprawy').setStyle(ButtonStyle.Secondary))] : [], attachments: [] };
        const sent = existing ? await existing.edit(options) : await channel.send({ ...options,
          nonce: createHash('sha256').update(`ml-card:${card.bindingId}`).digest('hex').slice(0,24), enforceNonce: true });
        await this.request('/receipt', { bindingId: card.bindingId, channelId: card.channelId, botMessageId: sent.id, renderHash: hash });
      }
    } finally { this.syncing = false; }
  }
  async runForever(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.sync(); } catch { console.error('[bok-discord] Nie udało się odświeżyć wspólnych kart ML.'); }
      await delay(5000, undefined, { signal }).catch(() => {});
    }
  }
}
