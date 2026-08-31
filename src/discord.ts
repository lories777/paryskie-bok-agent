import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type Message,
} from "discord.js";
import type { AppConfig } from "./config.js";
import type { AgentStore } from "./store.js";
import type { ClaimedJob, IncomingMessage } from "./types.js";
import type { StoredAction } from "./types.js";
import type { ActionExecution, ReplySink } from "./worker.js";

const STATUS_PATTERN = /^!bok\s+status\s*$/i;
const HELP_PATTERN = /^!bok\s+(?:pomoc|help)\s*$/i;
const DRAFT_BUTTON_PATTERN = /^bok:draft:(ready|reject):(AKCJA-[A-Z0-9_-]+)$/;

export function isStatusCommand(content: string): boolean {
  return STATUS_PATTERN.test(content.trim());
}

type ApprovedActionExecutor = (job: ClaimedJob) => Promise<ActionExecution | null>;
type StatusProvider = () => Promise<string> | string;

export class DiscordGateway implements ReplySink {
  readonly client: Client;
  private approvedActionExecutor?: ApprovedActionExecutor;
  private statusProvider?: StatusProvider;

  constructor(
    private readonly config: AppConfig & { discordToken: string },
    private readonly store: AgentStore,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  async start(): Promise<void> {
    this.client.on("messageCreate", (message) => {
      void this.onMessage(message).catch((error) => {
        console.error("Nie udało się przetworzyć wiadomości Discord:", error);
      });
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteraction(interaction).catch((error) => {
        console.error("Nie udało się obsłużyć decyzji draftu:", error);
      });
    });
    this.client.once(Events.ClientReady, (client) => {
      console.log(`BOK Agent online jako ${client.user.tag}.`);
    });
    await this.client.login(this.config.discordToken);
    await this.backfillObservedChannels();
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  setApprovedActionExecutor(executor: ApprovedActionExecutor): void {
    this.approvedActionExecutor = executor;
  }

  setStatusProvider(provider: StatusProvider): void {
    this.statusProvider = provider;
  }

  async sendSystemMessage(channelId: string, message: string): Promise<string> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || channel.isDMBased()) {
      throw new Error(`Kanał ${channelId} nie jest obsługiwanym kanałem tekstowym`);
    }
    const sent = await channel.send({ content: message, allowedMentions: { parse: [] } });
    return sent.id;
  }

  async deliver(job: ClaimedJob, message: string, actions: StoredAction[] = []): Promise<void> {
    if (job.platform !== "discord") {
      console.log(message);
      return;
    }
    const channel = await this.client.channels.fetch(job.channelId);
    if (!channel?.isTextBased() || channel.isDMBased()) {
      throw new Error(`Kanał ${job.channelId} nie jest obsługiwanym kanałem tekstowym`);
    }
    if (this.store.getConversation(job.conversationId).externalId.startsWith("daktela-ticket:")) {
      await this.removeSupersededDaktelaDeliveries(job);
    }
    const chunks = splitDiscordMessage(message);
    const original = await channel.messages.fetch(job.externalMessageId).catch(() => null);
    for (const [index, chunk] of chunks.entries()) {
      const components = index === chunks.length - 1 ? draftDecisionComponents(actions) : [];
      const sent =
        index === 0 && original
          ? await original.reply({
              content: chunk,
              components,
              allowedMentions: { repliedUser: false },
            })
          : await channel.send({ content: chunk, components, allowedMentions: { parse: [] } });
      this.store.recordDiscordDeliveryRoute(sent.id, job.conversationId, job.id, sent.channelId);
    }
  }

  async discardSuperseded(job: ClaimedJob): Promise<void> {
    if (!this.store.getConversation(job.conversationId).externalId.startsWith("daktela-ticket:")) {
      return;
    }
    await this.removeSupersededDaktelaDeliveries(job);
  }

  private async removeSupersededDaktelaDeliveries(job: ClaimedJob): Promise<void> {
    for (const route of this.store.previousDiscordDeliveryRoutes(job.conversationId, job.id)) {
      try {
        const channel = await this.client.channels.fetch(route.channelId);
        if (channel?.isTextBased() && !channel.isDMBased()) {
          await channel.messages.delete(route.botMessageId).catch(() => undefined);
        }
      } finally {
        this.store.removeDiscordDeliveryRoute(route.botMessageId);
      }
    }
  }

  async executeApprovedAction(
    job: ClaimedJob,
  ): Promise<ActionExecution | null> {
    const action = job.approvedAction;
    if (!action) return null;
    if (action.kind !== "discord_notify") {
      return (await this.approvedActionExecutor?.(job)) ?? null;
    }
    if (job.platform !== "discord") return null;
    if (!action.payload) throw new Error(`${action.publicId} nie ma jawnego payloadu do wysłania`);
    if (action.payload.length > 1_900) {
      throw new Error(`${action.publicId} przekracza bezpieczny limit pojedynczej wiadomości Discord`);
    }

    const channel = await this.client.channels.fetch(job.channelId);
    if (!channel?.isTextBased() || channel.isDMBased()) {
      throw new Error(`Kanał ${job.channelId} nie jest obsługiwanym kanałem tekstowym`);
    }
    const sent = await channel.send({
      content: action.payload,
      allowedMentions: { parse: [] },
    });
    const verified = await channel.messages.fetch(sent.id);
    if (verified.author.id !== this.client.user?.id || verified.content !== action.payload) {
      throw new Error(`Nie udało się zweryfikować wyniku ${action.publicId} w Discordzie`);
    }
    return {
      status: "executed",
      result: `Wiadomość Discord została wysłana i zweryfikowana (ID ${verified.id}).`,
    };
  }

  private async onMessage(message: Message): Promise<void> {
    if (!message.inGuild() || !this.client.user || message.author.id === this.client.user.id) return;

    const replyContext = await this.resolveReplyContext(message);

    const parentId = message.channel.isThread() ? message.channel.parentId : null;
    const inCommandChannel =
      this.config.commandChannelIds.has(message.channelId) ||
      Boolean(parentId && this.config.commandChannelIds.has(parentId)) ||
      message.channelId === this.config.daktelaEscalationChannelId ||
      parentId === this.config.daktelaEscalationChannelId;
    const inObserveChannel =
      this.config.observeChannelIds.has(message.channelId) ||
      Boolean(parentId && this.config.observeChannelIds.has(parentId));
    const mentioned = message.mentions.has(this.client.user);
    if (!inCommandChannel && !inObserveChannel && !replyContext.replyingToAgent) return;

    const authorized =
      this.config.allowedUserIds.has(message.author.id) ||
      Boolean(message.member?.roles.cache.some((role) => this.config.allowedRoleIds.has(role.id)));
    if (!message.author.bot && isStatusCommand(message.content)) {
      await this.handleStatus(message, authorized);
      return;
    }
    if (!message.author.bot && HELP_PATTERN.test(message.content.trim())) {
      await this.handleHelp(message, authorized);
      return;
    }

    const mentionsOtherHumans = message.mentions.users.some(
      (user) => user.id !== this.client.user?.id && !user.bot,
    );
    const shouldRespond = shouldRespondToAuthorizedMessage({
      authorized: !message.author.bot && authorized,
      inCommandChannel,
      mentionedAgent: mentioned,
      replyingToAgent: replyContext.replyingToAgent,
      mentionsOtherHumans,
    });
    const content = normalizeDiscordContent(message, this.client.user.id);
    if (!content) return;

    const incoming: IncomingMessage = {
      platform: "discord",
      conversationExternalId:
        replyContext.conversationExternalId ??
        (shouldRespond && mentioned ? directRequestConversationKey(message.id) : conversationKey(message)),
      externalMessageId: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
      authorName: message.member?.displayName ?? message.author.displayName,
      content,
      createdAt: message.createdAt.toISOString(),
      shouldRespond,
      // Zwykłą rozmowę zespołu zapamiętujemy jako nieufne tło, ale nie uruchamiamy nią joba.
      // Dzięki temu późniejsze jawne polecenie może odwołać się np. do szablonu wklejonego chwilę
      // wcześniej, bez zamieniania każdej wiadomości na odpowiedź agenta.
      sharedContext: inObserveChannel || (inCommandChannel && !shouldRespond),
    };
    this.store.ingest(incoming);
  }

  private async resolveReplyContext(message: Message): Promise<{
    replyingToAgent: boolean;
    conversationExternalId?: string;
  }> {
    const referencedId = message.reference?.messageId;
    if (!referencedId || !this.client.user) return { replyingToAgent: false };

    const route = this.store.resolveDiscordReplyRoute(referencedId);
    if (route) {
      return {
        replyingToAgent: true,
        conversationExternalId: route.conversationExternalId,
      };
    }

    const referenced = await message.channel.messages.fetch(referencedId).catch(() => null);
    if (!referenced || referenced.author.id !== this.client.user.id) {
      return { replyingToAgent: false };
    }

    // Odpowiedzi do wiadomości sprzed wdrożenia routingu nadal trafiają do właściwego ticketu.
    const ticketId = referenced.content.match(/DAKTELA\s+#(\d+)/i)?.[1];
    if (ticketId) {
      const conversationExternalId = daktelaConversationKey(ticketId);
      this.store.ingest({
        platform: "discord",
        conversationExternalId,
        externalMessageId: `discord-reference:${referenced.id}`,
        channelId: message.channelId,
        authorId: "bok-agent",
        authorName: "BOK Agent",
        content: referenced.content,
        createdAt: referenced.createdAt.toISOString(),
        shouldRespond: false,
      });
      return { replyingToAgent: true, conversationExternalId };
    }
    // Stara wiadomość bota bez zapisanej trasy i bez numeru Dakteli również dostaje własny kontekst,
    // zamiast wpadać do historycznej, wspólnej rozmowy całego kanału.
    return {
      replyingToAgent: true,
      conversationExternalId: `discord-reply:${referenced.id}`,
    };
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() || !interaction.inGuild()) return;
    const match = interaction.customId.match(DRAFT_BUTTON_PATTERN);
    if (!match) return;
    if (
      !this.config.allowedUserIds.has(interaction.user.id) &&
      !interactionHasAllowedRole(interaction, this.config.allowedRoleIds)
    ) {
      await interaction.reply({ content: "Nie masz uprawnienia do decyzji o tym drafcie.", ephemeral: true });
      return;
    }

    const decision = match[1] === "ready" ? "approved" : "rejected";
    const result = this.store.decideDraft(match[2] ?? "", decision, interaction.user.id);
    if (result !== "updated") {
      await interaction.reply({
        content:
          result === "missing"
            ? "Nie znalazłem tego draftu."
            : "Ten draft ma już zapisaną decyzję.",
        ephemeral: true,
      });
      return;
    }

    const label = decision === "approved" ? "✅ Gotowe" : "↩️ Do poprawy";
    const content = `${interaction.message.content}\n\n-# ${label}`;
    await interaction.update({ content: content.slice(0, 2_000), components: [] });
    if (decision === "rejected") {
      await interaction.followUp({
        content: "Napisz w odpowiedzi na tę kartę, co mam zmienić — poprawię właściwy ticket.",
        ephemeral: true,
      });
    }
  }

  private async backfillObservedChannels(): Promise<void> {
    if (this.config.discordBackfillMessages === 0) return;
    for (const channelId of this.config.observeChannelIds) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel?.isTextBased() || channel.isDMBased()) continue;
        const messages = await channel.messages.fetch({ limit: this.config.discordBackfillMessages });
        for (const message of [...messages.values()].reverse()) {
          if (!this.client.user || message.author.id === this.client.user.id) continue;
          const content = normalizeDiscordContent(message, this.client.user.id);
          if (!content) continue;
          this.store.ingest({
            platform: "discord",
            conversationExternalId: conversationKey(message),
            externalMessageId: message.id,
            channelId: message.channelId,
            authorId: message.author.id,
            authorName: message.member?.displayName ?? message.author.displayName,
            content,
            createdAt: message.createdAt.toISOString(),
            shouldRespond: false,
            sharedContext: true,
          });
        }
      } catch (error) {
        console.error(`Nie udało się pobrać kontekstu kanału Discord ${channelId}:`, error);
      }
    }
  }

  private async handleStatus(message: Message, authorized: boolean): Promise<void> {
    if (!authorized) {
      await message.reply({
        content: "Nie masz uprawnienia do odczytu statusu agenta.",
        allowedMentions: { repliedUser: false },
      });
      return;
    }
    const content = this.statusProvider
      ? await this.statusProvider()
      : "BOK Agent jest online, ale nie ma skonfigurowanego raportu runtime.";
    await message.reply({ content, allowedMentions: { repliedUser: false } });
  }

  private async handleHelp(message: Message, authorized: boolean): Promise<void> {
    if (!authorized) return;
    await message.reply({
      content: [
        "Napisz normalnie, czego potrzebujesz. Sam sprawdzę dostępne źródła, przygotuję odpowiedź albo zadam jedno konkretne pytanie, jeśli naprawdę brakuje decyzji.",
        "`!bok status` służy tylko do technicznego sprawdzenia, czy działam.",
      ].join("\n"),
      allowedMentions: { repliedUser: false },
    });
  }
}

export function shouldRespondToAuthorizedMessage(input: {
  authorized: boolean;
  inCommandChannel: boolean;
  mentionedAgent: boolean;
  replyingToAgent: boolean;
  mentionsOtherHumans: boolean;
}): boolean {
  if (!input.authorized) return false;
  // Kanał BOK jest wspólnym pokojem zespołu, a nie skrzynką poleceń bota. Sama obecność
  // wiadomości na kanale nigdy nie uruchamia agenta: człowiek musi go oznaczyć albo odpowiedzieć
  // bezpośrednio na jego kartę/pytanie.
  if (!input.mentionedAgent && !input.replyingToAgent) return false;
  if (!input.inCommandChannel && !input.replyingToAgent) return false;
  // Wiadomość skierowana wyłącznie do współpracowników jest rozmową zespołu, nie poleceniem.
  if (input.mentionsOtherHumans && !input.mentionedAgent && !input.replyingToAgent) return false;
  return true;
}

export function directRequestConversationKey(messageId: string): string {
  return `discord-request:${messageId}`;
}

function interactionHasAllowedRole(
  interaction: Interaction,
  allowedRoleIds: Set<string>,
): boolean {
  const roles = interaction.member?.roles;
  if (!roles) return false;
  if (Array.isArray(roles)) return roles.some((roleId) => allowedRoleIds.has(roleId));
  return roles.cache.some((role) => allowedRoleIds.has(role.id));
}

function conversationKey(message: Message): string {
  if (message.channel.isThread()) return `thread:${message.channel.id}`;
  return `channel:${message.channelId}`;
}

export function daktelaConversationKey(ticketId: string): string {
  return `daktela-ticket:${ticketId}`;
}

function draftDecisionComponents(actions: StoredAction[]): ActionRowBuilder<ButtonBuilder>[] {
  const draft = actions.find((action) => action.kind === "reply_customer");
  if (!draft) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`bok:draft:ready:${draft.publicId}`)
        .setLabel("Gotowe")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`bok:draft:reject:${draft.publicId}`)
        .setLabel("Do poprawy")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function normalizeDiscordContent(message: Message, botUserId: string): string {
  const withoutMention = message.content.replaceAll(`<@${botUserId}>`, "").replaceAll(`<@!${botUserId}>`, "");
  const attachments = [...message.attachments.values()].map(
    (attachment) => `[załącznik: ${attachment.name ?? "bez nazwy"}, ${attachment.contentType ?? "typ nieznany"}]`,
  );
  return [withoutMention.trim(), ...attachments].filter(Boolean).join("\n").slice(0, 12_000);
}

export function splitDiscordMessage(message: string, limit = 1_900): string[] {
  if (message.length <= limit) return [message];
  const chunks: string[] = [];
  let rest = message;
  while (rest.length > limit) {
    const candidate = rest.slice(0, limit);
    const newline = candidate.lastIndexOf("\n");
    const space = candidate.lastIndexOf(" ");
    const cut = Math.max(newline, space, Math.floor(limit * 0.7));
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
