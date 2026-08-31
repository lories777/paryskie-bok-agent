import { assertDaktelaTicketIntegrity, type BokCodexAgent } from "./codex-agent.js";
import type { AgentStore } from "./store.js";
import type { AgentTurnOutput, ClaimedJob, StoredAction } from "./types.js";

export type ActionExecution = NonNullable<AgentTurnOutput["actionExecution"]>;

export interface ReplySink {
  deliver(job: ClaimedJob, message: string, actions?: StoredAction[]): Promise<void>;
  discardSuperseded?(job: ClaimedJob): Promise<void>;
  executeApprovedAction?(job: ClaimedJob): Promise<ActionExecution | null>;
}

interface JobWorkerOptions {
  retryDelayMs?: number;
  maxTransientAttempts?: number;
}

export class JobWorker {
  private running = false;

  constructor(
    private readonly store: AgentStore,
    private readonly agent: BokCodexAgent,
    private readonly sink: ReplySink,
    private readonly options: JobWorkerOptions = {},
  ) {}

  async runOne(signal?: AbortSignal): Promise<boolean> {
    const job = this.store.claimNextJob();
    if (!job) return false;
    const conversationExternalId = this.store.getConversation(job.conversationId).externalId;
    const browserBaseline = await this.agent.captureBrowserPageIds?.();

    try {
      const directExecution = job.approvedAction
        ? await this.sink.executeApprovedAction?.(job)
        : undefined;
      const output: AgentTurnOutput = directExecution
        ? {
            reply:
              directExecution.status === "executed"
                ? `Wykonałem ${job.approvedAction?.publicId}. ${directExecution.result}`
                : `Nie wykonałem ${job.approvedAction?.publicId}. ${directExecution.result}`,
            caseState: directExecution.status === "executed" ? "answered" : "waiting_for_human",
            proposedActions: [],
            actionExecution: directExecution,
          }
        : await this.agent.run(job, signal);
      assertDaktelaTicketIntegrity(job, output, conversationExternalId);
      if (job.approvedAction) {
        const execution = output.actionExecution ?? {
          status: "failed" as const,
          result: "Agent nie zwrócił potwierdzonego wyniku wykonania.",
        };
        this.store.finishAction(job.approvedAction.id, execution.status, execution.result);
      }
      const actionIds = this.store.completeJob(job.id, output);
      const actions = this.store.getActions(actionIds);
      const reply = formatAgentDelivery(output.reply, actions);
      this.store.recordAgentReply(job.conversationId, job, reply);
      if (shouldDeliverAgentOutput(job, output, actions, conversationExternalId)) {
        await this.sink.deliver(job, reply, actions);
      } else if (
        isDaktelaConversation(job, conversationExternalId) &&
        shouldDiscardSupersededDaktelaCard(output, actions)
      ) {
        // Cichy, nowszy wynik nadal zastępuje starą kartę tej samej sprawy. Inaczej na kanale
        // zostaje nieaktualne pytanie lub draft mimo że ticket został już obsłużony.
        await this.sink.discardSuperseded?.(job);
      }
      return true;
    } catch (error) {
      if (signal?.aborted) {
        this.store.requeueRunningJob(job.id);
        return false;
      }
      if (isRetryableJobError(error) && job.attempts < (this.options.maxTransientAttempts ?? 4)) {
        this.store.requeueRunningJob(job.id);
        const retryDelayMs = this.options.retryDelayMs ?? transientRetryDelayMs(job.attempts);
        if (retryDelayMs > 0) await wait(retryDelayMs, signal ?? new AbortController().signal);
        return true;
      }
      this.store.failJob(job.id, error);
      const detail = error instanceof Error ? error.message : String(error);
      if (job.approvedAction) this.store.finishAction(job.approvedAction.id, "failed", detail);
      if (!isDaktelaConversation(job, conversationExternalId)) {
        await this.sink.deliver(
          job,
          `Nie domknąłem sprawy: ${detail.slice(0, 800)}.`,
        );
      }
      return true;
    } finally {
      await this.agent.cleanupBrowserPages?.(browserBaseline);
    }
  }

  async runForever(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error("Worker już działa");
    this.running = true;
    try {
      while (!signal.aborted) {
        const worked = await this.runOne(signal);
        if (!worked) await wait(750, signal);
      }
    } finally {
      this.running = false;
    }
  }
}

export function formatAgentDelivery(reply: string, actions: StoredAction[]): string {
  const drafts = actions.filter((action) => action.kind === "reply_customer");
  const ticketId = extractTicketId(reply, drafts);
  if (!ticketId) {
    if (drafts.length === 0) return reply;
    return [reply, ...drafts.map(formatActionCard)].join("\n\n");
  }

  const summary = reply
    .replace(/^\s*(?:#+\s*)?(?:🎫\s*)?DAKTELA\s+#\d+\s*(?:[—–:\-]\s*)?/i, "")
    .trim();
  return [
    drafts.length ? `**Daktela #${ticketId} · gotowe**` : `**Daktela #${ticketId}**`,
    drafts.length ? compactDraftSummary(summary) : summary,
    ...drafts.map(formatActionCard),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function formatActionCard(action: StoredAction): string {
  const quote = (value: string) => value
    .split("\n")
    .map((line) => `> ${line || " "}`)
    .join("\n");
  const payload = quote(action.payload);

  if (action.kind === "reply_customer") {
    return [
      "**Treść odpowiedzi**",
      payload,
      ...(action.qualityReview?.polishTranslation
        ? ["**Tłumaczenie PL**", quote(action.qualityReview.polishTranslation)]
        : []),
    ].join("\n");
  }

  return payload;
}

function compactDraftSummary(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "";
  const withoutTranslation = normalized
    .replace(/^(\*\*Tłumaczenie[^\n]*\*\*[^\n]*)\n+/i, "")
    .trim();
  if (
    /^(?:gotow(?:a|y|e)|przygotowa(?:łem|łam|no)|poprawion(?:a|y|e)|odpowiedź (?:jest )?gotowa)\b/i.test(
      withoutTranslation,
    )
  ) {
    return normalized.match(/^(\*\*Tłumaczenie[^\n]*\*\*[^\n]*)/i)?.[1] ?? "";
  }
  return normalized;
}

export function shouldDeliverAgentOutput(
  job: ClaimedJob,
  output: AgentTurnOutput,
  actions: StoredAction[],
  conversationExternalId?: string,
): boolean {
  // Ostatnia bramka dla starych lub nieoczekiwanych wyników. Komunikaty review są wewnętrzne
  // niezależnie od rodzaju rozmowy i nigdy nie są treścią dla BOK.
  if (/Draft wstrzymany przez kontrolę jakości:|\bquality review\b/i.test(output.reply)) return false;
  if (!isDaktelaConversation(job, conversationExternalId)) return true;
  if (actions.some((action) => action.kind === "reply_customer")) return true;
  // Konkretny zapis w MasterLinku, którego runtime na tym etapie nie może wykonać, jest realnym
  // następnym krokiem sprawy. Pokazujemy go raz zespołowi; zwykłe analizy i listy czynności nadal
  // pozostają ciche.
  if (actions.some((action) => action.kind === "masterlink_write")) return true;
  // Model może poprawnie opisać wymagany zapis jako jedną krótką instrukcję zamiast tworzyć
  // formalną akcję. Takie zadanie również musi dotrzeć do BOK, ale tylko gdy zawiera konkretną
  // operację i jej jednoznaczny cel. Ogólne „trzeba sprawdzić” nadal pozostaje ciche.
  if (isConcreteOperationalInstruction(output.reply)) return true;
  // Automatyczny monitor nie jest dziennikiem pracy. Bez gotowego draftu pokazujemy tylko jedno
  // jawne pytanie, na które BOK rzeczywiście ma odpowiedzieć. Opisy typu „trzeba sprawdzić…”,
  // listy czynności i techniczne ograniczenia zostają w historii runtime, ale nie zalewają kanału.
  return (
    (output.caseState === "needs_data" || output.caseState === "waiting_for_human") &&
    isConcreteHumanQuestion(output.reply)
  );
}

export function shouldDiscardSupersededDaktelaCard(
  output: AgentTurnOutput,
  actions: StoredAction[],
): boolean {
  if (actions.length > 0) return true;
  const normalized = output.reply.replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");
  // Błędnie sklasyfikowana kopia autorespondera nie unieważnia wcześniejszej karty z realnym
  // zadaniem lub draftem. Merytoryczna odpowiedź BOK i prawdziwe zamknięcie nadal ją usuwają.
  if (/autoresponder|automatyczna odpowiedź|automatic reply|brak nowej (?:merytorycznej )?wiadomości/.test(normalized)) return false;
  return true;
}

export function isConcreteHumanQuestion(value: string): boolean {
  const bokText = value
    .replace(/^\s*\*{0,2}DAKTELA\s+#\d+\*{0,2}\s*[—–:\-]?\s*/i, "")
    // Pytania klienta są często częścią jednozdaniowego tłumaczenia. Nie są kolejnymi pytaniami
    // do zespołu i nie mogą ukrywać właściwej decyzji BOK znajdującej się w następnym wierszu.
    .replace(/^\s*\*{0,2}Tłumaczenie[^\n]*$/gimu, "")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  const questions = bokText.match(/\?/g)?.length ?? 0;
  return questions === 1 && bokText.length >= 12;
}

export function isConcreteOperationalInstruction(value: string): boolean {
  const normalized = value.replace(/^\*{0,2}DAKTELA\s+#\d+\*{0,2}\s*[—:\n]*/i, "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.includes("?") || normalized.length > 700) return false;
  if (/\b(?:trzeba|należy|proszę)\s+(?:najpierw\s+)?(?:ręcznie\s+)?sprawdzić\b/i.test(normalized)) return false;
  const operation = /(?:^|\s)(?:zmień|anuluj|wstrzymaj|uruchom|utwórz|zleć|przypisz|przygotuj|otwórz|odczytaj|odblok(?:uj|ować|owac))/i.test(normalized);
  const target = /(?:zamówieni[^\s,.;:]*\s*#?\d{7,}|\bzamówieni[^\s,.;:]*\b|\b\d{8,10}\b|N[°º]\s*\d+|flakon[^\s,.;:]*|przesyłk[^\s,.;:]*|zwrot[^\s,.;:]*|metod[^\s,.;:]*\s+płatności|reklamacj[^\s,.;:]*\s+Allegro|Allegro[^\s,.;:]*\s+reklamacj)/i.test(normalized);
  return operation && target;
}

export function isRetryableJobError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:selected model is at capacity|rate limit|too many requests|\b429\b|service unavailable|\b503\b|overloaded|temporarily unavailable|ECONNRESET|ETIMEDOUT)/i.test(message);
}

function transientRetryDelayMs(attempt: number): number {
  return [5_000, 15_000, 30_000][Math.max(0, Math.min(attempt - 1, 2))] ?? 30_000;
}

function isDaktelaConversation(job: ClaimedJob, conversationExternalId?: string): boolean {
  return (
    job.externalMessageId.startsWith("daktela:") ||
    Boolean(conversationExternalId?.startsWith("daktela-ticket:"))
  );
}

function extractTicketId(reply: string, drafts: StoredAction[]): string | undefined {
  const fromReply = reply.match(/DAKTELA\s+#(\d+)/i)?.[1];
  if (fromReply) return fromReply;
  for (const draft of drafts) {
    const fromTarget = draft.target.match(/(?:ticket|zgłoszenie|sprawa)?\s*#(\d+)/i)?.[1];
    if (fromTarget) return fromTarget;
  }
  return undefined;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
