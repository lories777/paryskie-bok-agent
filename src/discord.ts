import { createHash } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type Interaction,
  type Message,
  type TextChannel,
} from "discord.js";
import type { AppConfig } from "./config.js";
import type {
  NativeOperationalDiscordPort,
  OperationalActionProofResult,
} from "./native-bok-operational-dispatch.js";
import {
  TICKET_TEAM_ESCALATION_DESTINATIONS,
  type TicketTeamEscalationDestination,
} from "./native-bok-operational-catalog.js";
import type { AgentStore } from "./store.js";
import type { ClaimedJob, IncomingMessage } from "./types.js";
import type { StoredAction } from "./types.js";
import type { ActionExecution, ReplySink } from "./worker.js";

const STATUS_PATTERN = /^!bok\s+status\s*$/i;
const HELP_PATTERN = /^!bok\s+(?:pomoc|help)\s*$/i;
const DRAFT_BUTTON_PATTERN = /^bok:draft:(ready|reject):(AKCJA-[A-Z0-9_-]+)$/;
// Zmiana na true wymaga implementacji idempotentnego sendera i readbacku, nie ustawienia ENV.
export const CUSTOMER_REPLY_SENDER_READY = false;

export type DraftDecisionPersistenceResult =
  | { status: "execution_queued"; jobPublicId: string }
  | { status: "review_recorded" }
  | { status: "rejected" }
  | { status: "stale" }
  | { status: "missing" }
  | { status: "already_decided" };

/**
 * Zapisuje decyzję przycisku. Dopóki sender nie jest gotowy, akceptacja jest wyłącznie
 * feedbackiem managerskim. Gdy obie bramy wykonania są jawnie aktywne,
 * `approveActionAndEnqueue` trzyma zmianę statusu akcji i INSERT joba w jednej transakcji
 * `BEGIN IMMEDIATE`, więc ponowne/dwukrotne kliknięcie nie może stworzyć drugiej wysyłki.
 */
export function persistDraftDecision(
  store: AgentStore,
  input: {
    publicId: string;
    decision: "ready" | "reject";
    decidedBy: string;
    interactionId: string;
    channelId: string;
    externalActionsEnabled: boolean;
    customerReplySenderReady: boolean;
  },
): DraftDecisionPersistenceResult {
  const action = store.getAction(input.publicId);
  if (!action || action.kind !== "reply_customer") return { status: "missing" };

  if (input.decision === "reject") {
    const result = store.decideDraft(input.publicId, "rejected", input.decidedBy);
    return { status: result === "updated" ? "rejected" : result };
  }

  // Akceptacja managerska pozostaje użyteczna także w read-only. Nie nazywamy jej jednak approval
  // wykonania i nie tworzymy joba, dopóki obie niezależne bramy nie potwierdzają gotowego sendera.
  if (!input.externalActionsEnabled || !input.customerReplySenderReady) {
    const review = store.recordDraftAcceptance(input.publicId, input.decidedBy);
    return { status: review === "updated" ? "review_recorded" : review };
  }

  const approval = store.approveActionAndEnqueue(
    input.publicId,
    input.decidedBy,
    input.interactionId,
    input.channelId,
  );
  if (approval.status === "queued") {
    return { status: "execution_queued", jobPublicId: approval.jobPublicId };
  }
  return approval;
}

export async function publishThenRemoveSuperseded(
  publish: () => Promise<void>,
  removeSuperseded: () => Promise<void>,
): Promise<void> {
  // Stara karta pozostaje jedynym widocznym śladem sprawy, dopóki Discord nie potwierdzi całej
  // nowej publikacji. Błąd publikacji nie może najpierw skasować działającej ścieżki przejęcia.
  await publish();
  await removeSuperseded();
}

export function isStatusCommand(content: string): boolean {
  return STATUS_PATTERN.test(content.trim());
}

export function isDiscordUnknownMessage(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown };
  // Receipt wolno usunąć tylko po strukturalnie potwierdzonym Discordowym
  // `Unknown Message` (10008) albo HTTP 404. Sam tekst wyjątku nie jest
  // wiarygodny: błąd sieci/proxy może zawierać te słowa i nadal wymagać retry.
  return candidate.code === 10008 || candidate.status === 404;
}

type ApprovedActionExecutor = (job: ClaimedJob) => Promise<ActionExecution | null>;
type StatusProvider = () => Promise<string> | string;

export class DiscordGateway implements ReplySink, NativeOperationalDiscordPort {
  readonly client: Client;
  private approvedActionExecutor?: ApprovedActionExecutor;
  private statusProvider?: StatusProvider;
  private operationalIdentityVerified = false;

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
    await this.backfillRelevantChannels();
  }

  async stop(): Promise<void> {
    this.operationalIdentityVerified = false;
    this.client.destroy();
  }

  setApprovedActionExecutor(executor: ApprovedActionExecutor): void {
    this.approvedActionExecutor = executor;
  }

  setStatusProvider(provider: StatusProvider): void {
    this.statusProvider = provider;
  }

  async verifyOperationalActionRoutes(): Promise<void> {
    this.operationalIdentityVerified = false;
    const guildId = this.config.nativeOperationalDiscordGuildId;
    const categoryId = this.config.nativeOperationalDiscordCategoryId;
    if (!this.client.isReady() || !guildId || !categoryId) {
      throw new Error("Discord operational identity is not configured or connected.");
    }
    if (
      TICKET_TEAM_ESCALATION_DESTINATIONS.some(
        (destination) => !this.config.nativeOperationalDiscordChannelIds.has(destination),
      )
    ) {
      throw new Error("Discord operational route map is incomplete.");
    }
    const guild = await this.client.guilds.fetch(guildId);
    const category = await guild.channels.fetch(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error("Configured Discord operational category is invalid.");
    }
    const member = guild.members.me ?? await guild.members.fetchMe();
    for (const destination of TICKET_TEAM_ESCALATION_DESTINATIONS) {
      const channel = await this.operationalActionChannel(destination);
      const permissions = channel.permissionsFor(member);
      if (!permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ])) {
        throw new Error(`Discord operational route ${destination} has insufficient permissions.`);
      }
    }
    this.operationalIdentityVerified = true;
  }

  operationalActionIdentityVerified(): boolean {
    return this.operationalIdentityVerified;
  }

  operationalActionReady(): boolean {
    return this.operationalIdentityVerified && this.client.isReady();
  }

  operationalActionRouteIdentity(destination: TicketTeamEscalationDestination): string | null {
    const guildId = this.config.nativeOperationalDiscordGuildId;
    const categoryId = this.config.nativeOperationalDiscordCategoryId;
    const channelId = this.config.nativeOperationalDiscordChannelIds.get(destination);
    if (!this.operationalIdentityVerified || !guildId || !categoryId || !channelId) return null;
    return createHash("sha256")
      .update(JSON.stringify({ guildId, categoryId, destination, channelId }), "utf8")
      .digest("hex");
  }

  async findOperationalActionProof(input: {
    destination: TicketTeamEscalationDestination;
    proof: string;
    expectedContent: string;
  }): Promise<OperationalActionProofResult> {
    const channel = await this.operationalActionChannel(input.destination);
    const ownId = this.client.user?.id;
    if (!ownId) throw new Error("Discord bot identity is unavailable.");
    const messages = await channel.messages.fetch({ limit: 100 });
    const matchingProof = [...messages.values()].filter(
      (message) => message.author.id === ownId && message.content.includes(input.proof),
    );
    if (matchingProof.length === 0) return { status: "missing" };
    if (
      matchingProof.length !== 1 ||
      matchingProof[0]?.content !== input.expectedContent
    ) {
      return { status: "conflict" };
    }
    return { status: "found", externalReference: matchingProof[0].id };
  }

  async sendOperationalAction(input: {
    destination: TicketTeamEscalationDestination;
    content: string;
    nonce: string;
  }): Promise<string> {
    if (input.content.length > 2_000) throw new Error("Discord operational message is too long.");
    const channel = await this.operationalActionChannel(input.destination);
    const sent = await channel.send({
      content: input.content,
      allowedMentions: { parse: [] },
      nonce: input.nonce,
      enforceNonce: true,
    });
    const confirmed = await sent.fetch();
    if (
      confirmed.author.id !== this.client.user?.id ||
      confirmed.channelId !== channel.id ||
      confirmed.content !== input.content
    ) {
      throw new Error("Discord did not confirm the exact operational message.");
    }
    return confirmed.id;
  }

  private async operationalActionChannel(
    destination: TicketTeamEscalationDestination,
  ): Promise<TextChannel> {
    if (!this.client.isReady()) throw new Error("Discord client is not ready.");
    const guildId = this.config.nativeOperationalDiscordGuildId;
    const categoryId = this.config.nativeOperationalDiscordCategoryId;
    const channelId = this.config.nativeOperationalDiscordChannelIds.get(destination);
    if (!guildId || !categoryId || !channelId) throw new Error("Discord route is not configured.");
    const channel = await this.client.channels.fetch(channelId);
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guildId !== guildId ||
      channel.parentId !== categoryId
    ) {
      this.operationalIdentityVerified = false;
      throw new Error(`Discord operational route ${destination} changed identity.`);
    }
    return channel;
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
    const isDaktela = this.store
      .getConversation(job.conversationId)
      .externalId.startsWith("daktela-ticket:");
    const publish = async () => {
      const chunks = splitDiscordMessage(message);
      const existingRoutes = this.store.currentDiscordDeliveryRoutes(job.id);
      if (existingRoutes.length > chunks.length) {
        throw new Error(`Niespójny receipt Discord dla ${job.publicId}`);
      }
      for (const [index, route] of existingRoutes.entries()) {
        const existingChannel = await this.client.channels.fetch(route.channelId);
        if (!existingChannel?.isTextBased() || existingChannel.isDMBased()) {
          throw new Error(`Kanał ${route.channelId} nie jest obsługiwanym kanałem tekstowym`);
        }
        const confirmed = await existingChannel.messages.fetch(route.botMessageId);
        if (
          confirmed.author.id !== this.client.user?.id ||
          confirmed.content !== chunks[index]
        ) {
          throw new Error(`Discord receipt nie zgadza się z ${job.publicId}`);
        }
      }

      const original = existingRoutes.length === 0
        ? await channel.messages.fetch(job.externalMessageId).catch(() => null)
        : null;
      for (let index = existingRoutes.length; index < chunks.length; index += 1) {
        const chunk = chunks[index] ?? "";
        const nonce = `bok-${job.id.toString(36)}-${index.toString(36)}`;
        const components = index === chunks.length - 1
          ? draftDecisionComponents(
              actions,
              this.config.externalActionsEnabled && CUSTOMER_REPLY_SENDER_READY,
            )
          : [];
        const sent =
          index === 0 && original
            ? await original.reply({
                content: chunk,
                components,
                allowedMentions: { repliedUser: false },
                nonce,
                enforceNonce: true,
              })
            : await channel.send({
                content: chunk,
                components,
                allowedMentions: { parse: [] },
                nonce,
                enforceNonce: true,
              });
        // Receipt zapisujemy natychmiast po potwierdzeniu POST przez Discord, jeszcze przed
        // dodatkowym fetch. Deterministyczny nonce chroni też krótkie okno awarii między POST a
        // zapisem receipt. Gdy fetch zwróci 429, retry odczyta ten sam message ID zamiast wysłać
        // drugi egzemplarz.
        this.store.recordDiscordDeliveryRoute(sent.id, job.conversationId, job.id, sent.channelId);
        const confirmed = await sent.fetch();
        if (confirmed.author.id !== this.client.user?.id || confirmed.content !== chunk) {
          throw new Error(`Discord nie potwierdził publikacji ${job.publicId}`);
        }
      }
    };
    if (isDaktela) {
      await publishThenRemoveSuperseded(
        publish,
        () => this.removeSupersededDaktelaDeliveries(job),
      );
    } else {
      await publish();
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
        if (!channel?.isTextBased() || channel.isDMBased()) {
          throw new Error(`Kanał ${route.channelId} nie jest obsługiwanym kanałem tekstowym`);
        }
        await channel.messages.delete(route.botMessageId);
        this.store.removeDiscordDeliveryRoute(route.botMessageId);
      } catch (error) {
        // Sukces delete i potwierdzone 404 są równoważne. Każdy 429/5xx/network zostawia
        // receipt w SQLite i wraca do trwałego outboxa, więc stara karta nie zostaje osierocona.
        if (isDiscordUnknownMessage(error)) {
          this.store.removeDiscordDeliveryRoute(route.botMessageId);
          continue;
        }
        throw error;
      }
    }
  }

  async executeApprovedAction(
    job: ClaimedJob,
  ): Promise<ActionExecution | null> {
    const action = job.approvedAction;
    if (!action) return null;
    if (!this.config.externalActionsEnabled) {
      return {
        status: "failed",
        result: "Wykonanie zewnętrzne jest wyłączone w konfiguracji runtime.",
      };
    }
    if (action.kind === "reply_customer") {
      // Obecny sterownik Dakteli nie ma klucza idempotencji ani pewnego readbacku treści po
      // restarcie. Nie delegujemy więc wysyłki do modelu/przeglądarki: crash window mógłby
      // spowodować ponowną odpowiedź klientowi.
      return {
        status: "failed",
        result:
          "Wysyłka do klienta jest zablokowana fail-closed do czasu wdrożenia idempotencji i readbacku Dakteli.",
      };
    }
    if (action.kind === "discord_notify") {
      // Bez osobnego receipt/idempotency key crash po POST, ale przed zapisem wyniku mógłby
      // wysłać tę samą wiadomość ponownie po restarcie. Zwykłe odpowiedzi agenta korzystają
      // z trwałego outboxa; ta przyszła akcja wykonawcza pozostaje fail-closed.
      return {
        status: "failed",
        result:
          "Powiadomienie Discord jest zablokowane fail-closed do czasu podłączenia idempotentnego executora.",
      };
    }
    return (await this.approvedActionExecutor?.(job)) ?? null;
  }

  private async onMessage(message: Message, historical = false): Promise<void> {
    if (!message.inGuild() || !this.client.user || message.author.id === this.client.user.id) return;

    const replyContext = await this.resolveReplyContext(message);

    const parentId = message.channel.isThread() ? message.channel.parentId : null;
    const inExplicitCommandChannel = isConfiguredDiscordCommandChannel(
      message.channelId,
      parentId,
      this.config.commandChannelIds,
    );
    const inCommandChannel =
      inExplicitCommandChannel ||
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
    const correctionAuthorization = resolveVerifiedCorrectionAuthorization(
      message.author.id,
      message.member?.roles.cache.map((role) => role.id) ?? [],
      this.config.allowedUserIds,
      this.config.allowedRoleIds,
    );
    const verifiedCorrectionSource = resolveVerifiedCorrectionSource({
      authorization: correctionAuthorization,
      inExplicitCommandChannel,
      mentionedAgent: mentioned,
      replyingToAgent: replyContext.replyingToAgent,
      replyToBotMessageId: replyContext.botMessageId,
    });
    if (!message.author.bot && isStatusCommand(message.content)) {
      if (historical) return;
      await this.handleStatus(message, authorized);
      return;
    }
    if (!message.author.bot && HELP_PATTERN.test(message.content.trim())) {
      if (historical) return;
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
      ...(shouldRespond && verifiedCorrectionSource
        ? {
            verifiedCorrectionSource,
          }
        : {}),
    };
    this.store.ingest(incoming);
  }

  private async resolveReplyContext(message: Message): Promise<{
    replyingToAgent: boolean;
    conversationExternalId?: string;
    botMessageId?: string;
  }> {
    const referencedId = message.reference?.messageId;
    if (!referencedId || !this.client.user) return { replyingToAgent: false };

    const route = this.store.resolveDiscordReplyRoute(referencedId);
    if (route) {
      return {
        replyingToAgent: true,
        conversationExternalId: route.conversationExternalId,
        botMessageId: referencedId,
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
      return { replyingToAgent: true, conversationExternalId, botMessageId: referenced.id };
    }
    // Stara wiadomość bota bez zapisanej trasy i bez numeru Dakteli również dostaje własny kontekst,
    // zamiast wpadać do historycznej, wspólnej rozmowy całego kanału.
    return {
      replyingToAgent: true,
      conversationExternalId: `discord-reply:${referenced.id}`,
      botMessageId: referenced.id,
    };
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() || !interaction.inGuild()) return;
    const match = interaction.customId.match(DRAFT_BUTTON_PATTERN);
    if (!match) return;
    if (!canDecideDraft(interaction.user.id, this.config.approverUserIds)) {
      await interaction.reply({ content: "Nie masz uprawnienia do decyzji o tym drafcie.", ephemeral: true });
      return;
    }

    const result = persistDraftDecision(this.store, {
      publicId: match[2] ?? "",
      decision: match[1] === "ready" ? "ready" : "reject",
      decidedBy: interaction.user.id,
      interactionId: interaction.id,
      channelId: interaction.channelId,
      externalActionsEnabled: this.config.externalActionsEnabled,
      customerReplySenderReady: CUSTOMER_REPLY_SENDER_READY,
    });
    if (result.status === "missing" || result.status === "already_decided") {
      await interaction.reply({
        content:
          result.status === "missing"
            ? "Nie znalazłem tego draftu."
            : "Ten draft ma już zapisaną decyzję.",
        ephemeral: true,
      });
      return;
    }

    const label = result.status === "execution_queued"
      ? `✅ Zatwierdzono · ${result.jobPublicId} w kolejce wykonania`
      : result.status === "review_recorded"
        ? "✅ Draft zaakceptowany przez BOK · nie wysłano"
      : result.status === "stale"
        ? "⚠️ Draft nieaktualny — pojawił się nowszy kontekst"
        : "↩️ Do poprawy";
    const content = `${interaction.message.content}\n\n-# ${label}`;
    await interaction.update({ content: content.slice(0, 2_000), components: [] });
    if (result.status === "rejected") {
      await interaction.followUp({
        content: "Napisz w odpowiedzi na tę kartę, co mam zmienić — poprawię właściwy ticket.",
        ephemeral: true,
      });
    }
  }

  private async backfillRelevantChannels(): Promise<void> {
    if (this.config.discordBackfillMessages === 0) return;
    for (const channelId of discordBackfillChannelIds(
      this.config.commandChannelIds,
      this.config.observeChannelIds,
      this.config.daktelaEscalationChannelId,
    )) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel?.isTextBased() || channel.isDMBased()) continue;
        const messages = await channel.messages.fetch({ limit: this.config.discordBackfillMessages });
        for (const message of [...messages.values()].reverse()) {
          // Use exactly the live auth/reference/mention path. Store idempotency prevents duplicate
          // jobs, while an authorized correction sent during downtime is no longer downgraded to
          // generic observed context. Historical status/help commands stay side-effect free.
          await this.onMessage(message, true);
        }
      } catch (error) {
        console.error(`Nie udało się odtworzyć kanału Discord ${channelId}:`, error);
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

export function canDecideDraft(
  userId: string,
  approverUserIds: ReadonlySet<string>,
): boolean {
  return approverUserIds.has(userId);
}

export function resolveVerifiedCorrectionAuthorization(
  userId: string,
  memberRoleIds: readonly string[],
  allowedUserIds: ReadonlySet<string>,
  allowedRoleIds: ReadonlySet<string>,
):
  | { authorizationKind: "allowed_user" | "allowed_role"; authorizationId: string }
  | undefined {
  if (allowedUserIds.has(userId)) {
    return { authorizationKind: "allowed_user", authorizationId: userId };
  }
  const roleId = memberRoleIds.find((id) => allowedRoleIds.has(id));
  return roleId
    ? { authorizationKind: "allowed_role", authorizationId: roleId }
    : undefined;
}

export function resolveVerifiedCorrectionSource(input: {
  authorization:
    | { authorizationKind: "allowed_user" | "allowed_role"; authorizationId: string }
    | undefined;
  inExplicitCommandChannel: boolean;
  mentionedAgent: boolean;
  replyingToAgent: boolean;
  replyToBotMessageId?: string | undefined;
}): IncomingMessage["verifiedCorrectionSource"] {
  if (!input.authorization) return undefined;
  if (input.replyingToAgent) {
    return input.replyToBotMessageId
      ? {
          sourceKind: "reply",
          replyToBotMessageId: input.replyToBotMessageId,
          ...input.authorization,
        }
      : undefined;
  }
  if (!input.inExplicitCommandChannel || !input.mentionedAgent) return undefined;
  return {
    sourceKind: "direct_mention",
    replyToBotMessageId: null,
    ...input.authorization,
  };
}

export function isConfiguredDiscordCommandChannel(
  channelId: string,
  parentId: string | null,
  commandChannelIds: ReadonlySet<string>,
): boolean {
  return commandChannelIds.has(channelId) ||
    Boolean(parentId && commandChannelIds.has(parentId));
}

export function discordBackfillChannelIds(
  commandChannelIds: ReadonlySet<string>,
  observeChannelIds: ReadonlySet<string>,
  daktelaEscalationChannelId?: string,
): string[] {
  return [...new Set([
    ...commandChannelIds,
    ...observeChannelIds,
    ...(daktelaEscalationChannelId ? [daktelaEscalationChannelId] : []),
  ])];
}

function conversationKey(message: Message): string {
  if (message.channel.isThread()) return `thread:${message.channel.id}`;
  return `channel:${message.channelId}`;
}

export function daktelaConversationKey(ticketId: string): string {
  return `daktela-ticket:${ticketId}`;
}

function draftDecisionComponents(
  actions: StoredAction[],
  customerReplyExecutionReady: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  const draft = actions.find((action) => action.kind === "reply_customer");
  if (!draft) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`bok:draft:ready:${draft.publicId}`)
        .setLabel(customerReplyExecutionReady ? "Zatwierdź do wykonania" : "Akceptuj draft")
        .setStyle(ButtonStyle.Success)
        .setDisabled(false),
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
