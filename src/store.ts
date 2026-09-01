import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentTurnOutput,
  ClaimedJob,
  IncomingMessage,
  StoredConversation,
  StoredMessage,
  StoredAction,
  StoredLearnedRule,
} from "./types.js";

type SqlValue = string | number | bigint | null;

export interface DaktelaTicketObservation {
  ticketId: string;
  title: string;
  category: string;
  assignedUser: string;
  status: string;
  stage: string;
  edited: string;
  editedBy: string;
  url: string;
  fingerprint: string;
}

function now(): string {
  return new Date().toISOString();
}

function fingerprintsDiffer(previous: string, current: string): boolean {
  // v7 usuwało z fingerprintu niestabilne pole Kendo `edited_by`. Pierwszy skan po wdrożeniu
  // tylko migruje istniejący zapis, żeby nie zakolejkować ponownie całej otwartej kolejki.
  if (/^v7:/.test(current) && !/^v\d+:/.test(previous)) return false;
  return previous !== current;
}

export class AgentStore {
  readonly db: DatabaseSync;

  constructor(
    stateDir: string,
    filename = "bok-agent.sqlite",
    options: { recoverInterruptedJobs?: boolean } = {},
  ) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(stateDir, filename));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    if (options.recoverInterruptedJobs) this.recoverInterruptedJobs();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK(platform IN ('discord', 'local')),
        external_id TEXT NOT NULL,
        codex_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(platform, external_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        external_message_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('human', 'agent', 'context')),
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        shared_context INTEGER NOT NULL DEFAULT 0 CHECK(shared_context IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE(conversation_id, external_message_id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT UNIQUE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        trigger_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        platform TEXT NOT NULL CHECK(platform IN ('discord', 'local')),
        channel_id TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        approved_action_id INTEGER REFERENCES actions(id)
      );

      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT UNIQUE,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        target TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL,
        risk TEXT NOT NULL CHECK(risk IN ('low', 'medium', 'high')),
        status TEXT NOT NULL CHECK(status IN ('proposed', 'approved', 'rejected', 'executed', 'failed')),
        approved_by TEXT,
        approved_at TEXT,
        execution_result TEXT,
        quality_review TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daktela_observations (
        ticket_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        stage TEXT NOT NULL,
        assigned_user TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_queued_at TEXT,
        last_job_id INTEGER REFERENCES jobs(id),
        discord_thread_id TEXT
      );

      CREATE TABLE IF NOT EXISTS discord_delivery_routes (
        bot_message_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learned_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalized_key TEXT NOT NULL UNIQUE,
        situation TEXT NOT NULL,
        instruction TEXT NOT NULL,
        source_conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        source_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS jobs_status_id_idx ON jobs(status, id);
      CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages(conversation_id, id);
      CREATE INDEX IF NOT EXISTS actions_status_id_idx ON actions(status, id);
      CREATE INDEX IF NOT EXISTS daktela_observations_last_job_idx
        ON daktela_observations(last_job_id);
      CREATE INDEX IF NOT EXISTS discord_delivery_routes_conversation_idx
        ON discord_delivery_routes(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS learned_rules_updated_idx
        ON learned_rules(updated_at DESC);
    `);
    this.ensureColumn("jobs", "approved_action_id", "INTEGER REFERENCES actions(id)");
    this.ensureColumn("actions", "execution_result", "TEXT");
    this.ensureColumn("actions", "payload", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("actions", "quality_review", "TEXT");
    this.ensureColumn("daktela_observations", "discord_thread_id", "TEXT");
    this.ensureColumn(
      "messages",
      "shared_context",
      "INTEGER NOT NULL DEFAULT 0 CHECK(shared_context IN (0, 1))",
    );
  }

  private ensureColumn(
    table: "jobs" | "actions" | "daktela_observations" | "messages",
    column: string,
    definition: string,
  ): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private recoverInterruptedJobs(): void {
    this.db
      .prepare("UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'running'")
      .run();
  }

  ingest(message: IncomingMessage): {
    inserted: boolean;
    conversationId: number;
    messageId: number;
    jobId?: number;
  } {
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO conversations(platform, external_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(platform, external_id) DO UPDATE SET updated_at = excluded.updated_at
      `)
      .run(message.platform, message.conversationExternalId, timestamp, timestamp);

    const conversation = this.db
      .prepare("SELECT id FROM conversations WHERE platform = ? AND external_id = ?")
      .get(message.platform, message.conversationExternalId) as { id: number };

    const role = message.role ?? (message.shouldRespond ? "human" : "context");
    const insert = this.db
      .prepare(`
        INSERT OR IGNORE INTO messages(
          conversation_id, external_message_id, role, author_id, author_name, content,
          shared_context, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        conversation.id,
        message.externalMessageId,
        role,
        message.authorId,
        message.authorName,
        message.content,
        message.sharedContext ? 1 : 0,
        message.createdAt,
      );

    // Discord backfill can revisit a message stored before this column existed. Promote only
    // explicitly observed messages; never infer shared context from a generic Discord platform.
    if (message.sharedContext) {
      this.db
        .prepare(`
          UPDATE messages
          SET shared_context = 1
          WHERE conversation_id = ? AND external_message_id = ?
        `)
        .run(conversation.id, message.externalMessageId);
    }

    const stored = this.db
      .prepare("SELECT id FROM messages WHERE conversation_id = ? AND external_message_id = ?")
      .get(conversation.id, message.externalMessageId) as { id: number };

    let jobId: number | undefined;
    if (insert.changes > 0 && message.shouldRespond) {
      const job = this.db
        .prepare(`
          INSERT INTO jobs(
            conversation_id, trigger_message_id, platform, channel_id, external_message_id,
            status, created_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        `)
        .run(
          conversation.id,
          stored.id,
          message.platform,
          message.channelId,
          message.externalMessageId,
          timestamp,
        );
      jobId = Number(job.lastInsertRowid);
      this.db
        .prepare("UPDATE jobs SET public_id = ? WHERE id = ?")
        .run(this.publicId("BOK", jobId), jobId);
    }

    return {
      inserted: insert.changes > 0,
      conversationId: conversation.id,
      messageId: stored.id,
      ...(jobId ? { jobId } : {}),
    };
  }

  recordDaktelaScan(
    tickets: DaktelaTicketObservation[],
    maxCandidates: number,
  ): DaktelaTicketObservation[] {
    if (tickets.length === 0) return [];
    const timestamp = now();
    const knownCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM daktela_observations")
      .get() as { count: SqlValue };
    const bootstrap = Number(knownCount.count) === 0;
    const existingByTicket = new Map<string, string>();
    for (const ticket of tickets) {
      const existing = this.db
        .prepare("SELECT fingerprint FROM daktela_observations WHERE ticket_id = ?")
        .get(ticket.ticketId) as { fingerprint: string } | undefined;
      if (existing) existingByTicket.set(ticket.ticketId, existing.fingerprint);
    }
    const candidates = (bootstrap
      ? tickets.filter(
          (ticket) =>
            ticket.stage.toLowerCase() === "open" &&
            (!ticket.assignedUser || ticket.assignedUser.toLowerCase() === "system"),
        )
      : tickets.filter((ticket) => {
          const previousFingerprint = existingByTicket.get(ticket.ticketId);
          return (
            ticket.stage.toLowerCase() === "open" &&
            (!previousFingerprint || fingerprintsDiffer(previousFingerprint, ticket.fingerprint))
          );
        }))
      .sort((left, right) => Number(Boolean(left.assignedUser)) - Number(Boolean(right.assignedUser)))
      .slice(0, maxCandidates);
    const selectedTicketIds = new Set(candidates.map((ticket) => ticket.ticketId));

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const ticket of tickets) {
        const previousFingerprint = existingByTicket.get(ticket.ticketId);
        const isChanged =
          !previousFingerprint || fingerprintsDiffer(previousFingerprint, ticket.fingerprint);
        const preserveForNextScan =
          !bootstrap &&
          isChanged &&
          ticket.stage.toLowerCase() === "open" &&
          !selectedTicketIds.has(ticket.ticketId);
        if (!previousFingerprint && preserveForNextScan) continue;
        const storedFingerprint =
          preserveForNextScan && previousFingerprint ? previousFingerprint : ticket.fingerprint;
        this.db
          .prepare(`
            INSERT INTO daktela_observations(
              ticket_id, fingerprint, stage, assigned_user, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticket_id) DO UPDATE SET
              fingerprint = excluded.fingerprint,
              stage = excluded.stage,
              assigned_user = excluded.assigned_user,
              last_seen_at = excluded.last_seen_at
          `)
          .run(
            ticket.ticketId,
            storedFingerprint,
            ticket.stage,
            ticket.assignedUser,
            timestamp,
            timestamp,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return candidates;
  }

  linkDaktelaJob(ticketId: string, fingerprint: string, jobId: number): void {
    this.db
      .prepare(`
        UPDATE daktela_observations
        SET last_queued_at = ?, last_job_id = ?
        WHERE ticket_id = ? AND fingerprint = ?
      `)
      .run(now(), jobId, ticketId, fingerprint);
  }

  hasQueuedDaktelaJob(ticketId: string): boolean {
    const row = this.db
      .prepare("SELECT last_job_id FROM daktela_observations WHERE ticket_id = ?")
      .get(ticketId) as { last_job_id: number | null } | undefined;
    return row?.last_job_id != null;
  }

  getDaktelaThreadId(ticketId: string): string | undefined {
    const row = this.db
      .prepare("SELECT discord_thread_id FROM daktela_observations WHERE ticket_id = ?")
      .get(ticketId) as { discord_thread_id: string | null } | undefined;
    return row?.discord_thread_id ?? undefined;
  }

  setDaktelaThreadId(ticketId: string, threadId: string): void {
    this.db
      .prepare("UPDATE daktela_observations SET discord_thread_id = ? WHERE ticket_id = ?")
      .run(threadId, ticketId);
  }

  hasActiveDaktelaJob(): boolean {
    const row = this.db
      .prepare(`
        SELECT 1 AS found
        FROM jobs
        WHERE external_message_id LIKE 'daktela:%'
          AND status IN ('pending', 'running')
        LIMIT 1
      `)
      .get() as { found: number } | undefined;
    return Boolean(row);
  }

  claimNextJob(): ClaimedJob | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(`
          SELECT jobs.id, jobs.public_id, jobs.conversation_id, jobs.trigger_message_id,
                 jobs.platform, jobs.channel_id, jobs.external_message_id, jobs.attempts,
                 actions.id AS action_id, actions.public_id AS action_public_id,
                 actions.kind AS action_kind, actions.summary AS action_summary,
                 actions.target AS action_target, actions.reason AS action_reason,
                 actions.payload AS action_payload, actions.risk AS action_risk,
                 actions.quality_review AS action_quality_review
          FROM jobs
          LEFT JOIN actions ON actions.id = jobs.approved_action_id
          WHERE jobs.status = 'pending'
          ORDER BY jobs.id
          LIMIT 1
        `)
        .get() as
        | {
            id: number;
            public_id: string;
            conversation_id: number;
            trigger_message_id: number;
            platform: "discord" | "local";
            channel_id: string;
            external_message_id: string;
            attempts: number;
            action_id: number | null;
            action_public_id: string | null;
            action_kind: StoredAction["kind"] | null;
            action_summary: string | null;
            action_target: string | null;
            action_payload: string | null;
            action_reason: string | null;
            action_risk: StoredAction["risk"] | null;
            action_quality_review: string | null;
          }
        | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      this.db
        .prepare(`
          UPDATE jobs
          SET status = 'running', attempts = attempts + 1, started_at = ?
          WHERE id = ? AND status = 'pending'
        `)
        .run(now(), row.id);
      this.db.exec("COMMIT");
      const approvedActionQualityReview = parseQualityReview(row.action_quality_review);
      const approvedAction = row.action_id
        ? {
            id: row.action_id,
            publicId: row.action_public_id ?? "",
            kind: row.action_kind ?? "other",
            summary: row.action_summary ?? "",
            target: row.action_target ?? "",
            payload: row.action_payload ?? "",
            reason: row.action_reason ?? "",
            risk: row.action_risk ?? "high",
            ...(approvedActionQualityReview
              ? { qualityReview: approvedActionQualityReview }
              : {}),
          }
        : undefined;
      return {
        id: row.id,
        publicId: row.public_id,
        conversationId: row.conversation_id,
        triggerMessageId: row.trigger_message_id,
        platform: row.platform,
        channelId: row.channel_id,
        externalMessageId: row.external_message_id,
        attempts: row.attempts + 1,
        ...(approvedAction ? { approvedAction } : {}),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getConversation(id: number): StoredConversation {
    const row = this.db
      .prepare("SELECT id, platform, external_id, codex_thread_id FROM conversations WHERE id = ?")
      .get(id) as
      | {
          id: number;
          platform: "discord" | "local";
          external_id: string;
          codex_thread_id: string | null;
        }
      | undefined;
    if (!row) throw new Error(`Nie znaleziono rozmowy ${id}`);
    return {
      id: row.id,
      platform: row.platform,
      externalId: row.external_id,
      codexThreadId: row.codex_thread_id,
    };
  }

  setCodexThreadId(conversationId: number, threadId: string): void {
    this.db
      .prepare("UPDATE conversations SET codex_thread_id = ?, updated_at = ? WHERE id = ?")
      .run(threadId, now(), conversationId);
  }

  recordDiscordDeliveryRoute(
    botMessageId: string,
    conversationId: number,
    jobId: number,
    channelId: string,
  ): void {
    this.db
      .prepare(`
        INSERT INTO discord_delivery_routes(
          bot_message_id, conversation_id, job_id, channel_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(bot_message_id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          job_id = excluded.job_id,
          channel_id = excluded.channel_id
      `)
      .run(botMessageId, conversationId, jobId, channelId, now());
  }

  previousDiscordDeliveryRoutes(
    conversationId: number,
    currentJobId: number,
  ): Array<{ botMessageId: string; channelId: string }> {
    const rows = this.db
      .prepare(`
        SELECT bot_message_id, channel_id
        FROM discord_delivery_routes
        WHERE conversation_id = ?
          AND (job_id IS NULL OR job_id != ?)
        ORDER BY created_at ASC
      `)
      .all(conversationId, currentJobId) as Array<{
        bot_message_id: string;
        channel_id: string;
      }>;
    return rows.map((row) => ({
      botMessageId: row.bot_message_id,
      channelId: row.channel_id,
    }));
  }

  removeDiscordDeliveryRoute(botMessageId: string): void {
    this.db
      .prepare("DELETE FROM discord_delivery_routes WHERE bot_message_id = ?")
      .run(botMessageId);
  }

  resolveDiscordReplyRoute(botMessageId: string):
    | { conversationId: number; conversationExternalId: string }
    | undefined {
    const row = this.db
      .prepare(`
        SELECT conversations.id AS conversation_id, conversations.external_id
        FROM discord_delivery_routes
        JOIN conversations ON conversations.id = discord_delivery_routes.conversation_id
        WHERE discord_delivery_routes.bot_message_id = ?
      `)
      .get(botMessageId) as
      | { conversation_id: number; external_id: string }
      | undefined;
    return row
      ? { conversationId: row.conversation_id, conversationExternalId: row.external_id }
      : undefined;
  }

  decideDraft(
    publicId: string,
    decision: "rejected",
    decidedBy: string,
  ): "updated" | "missing" | "already_decided" {
    const row = this.db
      .prepare("SELECT id, kind, status FROM actions WHERE public_id = ?")
      .get(publicId) as
      | { id: number; kind: string; status: string }
      | undefined;
    if (!row || row.kind !== "reply_customer") return "missing";
    if (row.status !== "proposed") return "already_decided";

    const result = this.db
      .prepare(`
        UPDATE actions
        SET status = ?, approved_by = ?, approved_at = ?
        WHERE id = ? AND status = 'proposed'
      `)
      .run(decision, decidedBy, now(), row.id);
    return result.changes > 0 ? "updated" : "already_decided";
  }

  recentMessages(
    conversationId: number,
    limit: number,
    upToMessageId?: number,
  ): StoredMessage[] {
    const boundary = upToMessageId ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(`
        SELECT id, conversation_id, role, author_id, author_name, content, created_at
        FROM (
          SELECT id, conversation_id, role, author_id, author_name, content, created_at
          FROM messages
          WHERE conversation_id = ? AND id <= ?
          ORDER BY id DESC
          LIMIT ?
        )
        ORDER BY id ASC
      `)
      .all(conversationId, boundary, limit) as Array<{
      id: number;
      conversation_id: number;
      role: "human" | "agent" | "context";
      author_id: string;
      author_name: string;
      content: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      authorId: row.author_id,
      authorName: row.author_name,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  recentSharedContext(conversationId: number, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(`
        SELECT id, conversation_id, role, author_id, author_name, content, created_at
        FROM (
          SELECT messages.id, messages.conversation_id, messages.role, messages.author_id,
                 messages.author_name, messages.content, messages.created_at
          FROM messages
          JOIN conversations ON conversations.id = messages.conversation_id
          WHERE messages.conversation_id != ?
            AND messages.role = 'context'
            AND messages.shared_context = 1
            AND conversations.platform = 'discord'
          ORDER BY messages.id DESC
          LIMIT ?
        )
        ORDER BY id ASC
      `)
      .all(conversationId, limit) as Array<{
      id: number;
      conversation_id: number;
      role: "context";
      author_id: string;
      author_name: string;
      content: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      authorId: row.author_id,
      authorName: row.author_name,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  recentRelatedDaktelaContext(
    conversationId: number,
    orderNumbers: string[],
    limit = 8,
  ): StoredMessage[] {
    if (orderNumbers.length === 0 || limit < 1) return [];
    const rows = this.db
      .prepare(`
        SELECT messages.id, messages.conversation_id, messages.role, messages.author_id,
               messages.author_name, messages.content, messages.created_at
        FROM messages
        JOIN conversations ON conversations.id = messages.conversation_id
        WHERE messages.conversation_id != ?
          AND messages.role = 'context'
          AND messages.author_id IN ('daktela-monitor', 'daktela-e2e')
          AND conversations.platform = 'discord'
          AND conversations.external_id LIKE 'daktela-ticket:%'
        ORDER BY messages.id DESC
        LIMIT 250
      `)
      .all(conversationId) as Array<{
      id: number;
      conversation_id: number;
      role: "context";
      author_id: string;
      author_name: string;
      content: string;
      created_at: string;
    }>;

    const newestPerConversation = new Map<number, (typeof rows)[number]>();
    for (const row of rows) {
      if (newestPerConversation.has(row.conversation_id)) continue;
      if (!orderNumbers.some((orderNumber) => row.content.includes(orderNumber))) continue;
      newestPerConversation.set(row.conversation_id, row);
      if (newestPerConversation.size >= limit) break;
    }
    return [...newestPerConversation.values()].reverse().map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      authorId: row.author_id,
      authorName: row.author_name,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  recordAgentReply(conversationId: number, job: ClaimedJob, content: string): number {
    const result = this.db
      .prepare(`
        INSERT INTO messages(
          conversation_id, external_message_id, role, author_id, author_name, content, created_at
        ) VALUES (?, ?, 'agent', 'bok-agent', 'BOK Agent', ?, ?)
      `)
      .run(conversationId, `agent:${job.publicId}`, content, now());
    return Number(result.lastInsertRowid);
  }

  completeJob(jobId: number, output: AgentTurnOutput): string[] {
    const timestamp = now();
    const publicIds: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const jobContext = this.db
        .prepare(`
          SELECT jobs.conversation_id, jobs.trigger_message_id,
                 jobs.external_message_id,
                 messages.role AS trigger_role, messages.author_id AS trigger_author_id
          FROM jobs
          JOIN messages ON messages.id = jobs.trigger_message_id
          WHERE jobs.id = ?
        `)
        .get(jobId) as {
          conversation_id: number;
          trigger_message_id: number;
          external_message_id: string;
          trigger_role: "human" | "agent" | "context";
          trigger_author_id: string;
        };
      if (
        jobContext.external_message_id.startsWith("daktela:") &&
        !output.proposedActions.some((action) => action.kind === "reply_customer")
      ) {
        this.db
          .prepare(`
            UPDATE actions
            SET status = 'rejected', execution_result = 'Zastąpiona nowszą analizą sprawy.'
            WHERE status = 'proposed'
              AND kind = 'reply_customer'
              AND job_id IN (SELECT id FROM jobs WHERE conversation_id = ?)
          `)
          .run(jobContext.conversation_id);
      }
      for (const action of output.proposedActions) {
        if (action.qualityReview?.verdict === "blocked") continue;
        this.db
          .prepare(`
            UPDATE actions
            SET status = 'rejected', execution_result = 'Zastąpiona nowszą propozycją.'
            WHERE status = 'proposed'
              AND kind = ?
              AND target = ?
              AND job_id IN (SELECT id FROM jobs WHERE conversation_id = ?)
          `)
          .run(action.kind, action.target, jobContext.conversation_id);
        const insert = this.db
          .prepare(`
            INSERT INTO actions(
              job_id, kind, summary, target, payload, reason, risk, status, quality_review, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
          `)
          .run(
            jobId,
            action.kind,
            action.summary,
            action.target,
            action.payload,
            action.reason,
            action.risk,
            action.qualityReview ? JSON.stringify(action.qualityReview) : null,
            timestamp,
          );
        const actionId = Number(insert.lastInsertRowid);
        const publicId = this.publicId("AKCJA", actionId);
        this.db.prepare("UPDATE actions SET public_id = ? WHERE id = ?").run(publicId, actionId);
        publicIds.push(publicId);
      }
      if (
        jobContext.trigger_role === "human" &&
        !["daktela-monitor", "daktela-e2e"].includes(jobContext.trigger_author_id)
      ) {
        for (const rule of output.learnedRules ?? []) {
          const safe = normalizeLearnedRule(rule.situation, rule.instruction);
          if (!safe) continue;
          this.db
            .prepare(`
              INSERT INTO learned_rules(
                normalized_key, situation, instruction, source_conversation_id,
                source_message_id, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(normalized_key) DO UPDATE SET
                situation = excluded.situation,
                instruction = excluded.instruction,
                source_conversation_id = excluded.source_conversation_id,
                source_message_id = excluded.source_message_id,
                updated_at = excluded.updated_at
            `)
            .run(
              safe.key,
              safe.situation,
              safe.instruction,
              jobContext.conversation_id,
              jobContext.trigger_message_id,
              timestamp,
              timestamp,
            );
        }
      }
      this.db
        .prepare("UPDATE jobs SET status = 'completed', completed_at = ?, error = NULL WHERE id = ?")
        .run(timestamp, jobId);
      this.db.exec("COMMIT");
      return publicIds;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  activeLearnedRules(limit = 100): StoredLearnedRule[] {
    const rows = this.db
      .prepare(`
        SELECT id, situation, instruction, created_at, updated_at
        FROM learned_rules
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `)
      .all(limit) as Array<{
      id: number;
      situation: string;
      instruction: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      situation: row.situation,
      instruction: row.instruction,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  failJob(jobId: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.db
      .prepare("UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?")
      .run(now(), message.slice(0, 4000), jobId);
  }

  requeueRunningJob(jobId: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE conversations
          SET codex_thread_id = NULL, updated_at = ?
          WHERE id = (SELECT conversation_id FROM jobs WHERE id = ? AND status = 'running')
        `)
        .run(now(), jobId);
      this.db
        .prepare(`
          UPDATE jobs
          SET status = 'pending', started_at = NULL, completed_at = NULL, error = NULL
          WHERE id = ? AND status = 'running'
        `)
        .run(jobId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  approveActionAndEnqueue(
    publicId: string,
    approverId: string,
    approvalMessageId: string,
    approvalChannelId: string,
  ): string | null {
    const normalized = publicId.toUpperCase();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(`
          SELECT actions.id, actions.public_id, actions.kind, actions.summary, actions.target,
                 actions.payload, actions.reason, actions.risk, jobs.conversation_id, jobs.platform
          FROM actions
          JOIN jobs ON jobs.id = actions.job_id
          WHERE actions.public_id = ? AND actions.status = 'proposed'
        `)
        .get(normalized) as
        | (StoredAction & { conversation_id: number; platform: "discord" | "local" })
        | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      const timestamp = now();
      this.db
        .prepare(`UPDATE actions SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`)
        .run(approverId, timestamp, row.id);
      const message = this.db
        .prepare(`
          INSERT INTO messages(
            conversation_id, external_message_id, role, author_id, author_name, content, created_at
          ) VALUES (?, ?, 'human', ?, 'Zatwierdzający', ?, ?)
        `)
        .run(
          row.conversation_id,
          `approval:${approvalMessageId}:${normalized}`,
          approverId,
          `Jawnie zatwierdzono wykonanie ${normalized}: ${row.summary}. Cel: ${row.target}.`,
          timestamp,
        );
      const job = this.db
        .prepare(`
          INSERT INTO jobs(
            conversation_id, trigger_message_id, platform, channel_id, external_message_id,
            status, created_at, approved_action_id
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
        `)
        .run(
          row.conversation_id,
          Number(message.lastInsertRowid),
          row.platform,
          approvalChannelId,
          approvalMessageId,
          timestamp,
          row.id,
        );
      const jobId = Number(job.lastInsertRowid);
      const jobPublicId = this.publicId("BOK", jobId);
      this.db.prepare("UPDATE jobs SET public_id = ? WHERE id = ?").run(jobPublicId, jobId);
      this.db.exec("COMMIT");
      return jobPublicId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishAction(actionId: number, status: "executed" | "failed", result: string): void {
    this.db
      .prepare("UPDATE actions SET status = ?, execution_result = ? WHERE id = ? AND status = 'approved'")
      .run(status, result.slice(0, 4000), actionId);
  }

  getAction(publicId: string): StoredAction | null {
    const row = this.db
      .prepare(`
        SELECT id, public_id, kind, summary, target, payload, reason, risk, quality_review
        FROM actions
        WHERE public_id = ?
      `)
      .get(publicId.toUpperCase()) as ActionRow | undefined;
    return row ? mapAction(row) : null;
  }

  getActions(publicIds: string[]): StoredAction[] {
    return publicIds
      .map((publicId) => this.getAction(publicId))
      .filter((action): action is StoredAction => Boolean(action));
  }

  listProposedActions(limit = 10): StoredAction[] {
    const rows = this.db
      .prepare(`
        SELECT id, public_id, kind, summary, target, payload, reason, risk, quality_review
        FROM actions
        WHERE status = 'proposed'
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(limit) as unknown as ActionRow[];
    return rows.map(mapAction);
  }

  rejectAction(publicId: string, rejectedBy: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE actions
        SET status = 'rejected', execution_result = ?
        WHERE public_id = ? AND status = 'proposed'
      `)
      .run(`Odrzucona przez użytkownika Discord ${rejectedBy}.`, publicId.toUpperCase());
    return result.changes > 0;
  }

  status(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const table of ["conversations", "messages", "daktela_observations", "learned_rules"] as const) {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: SqlValue;
      };
      result[table] = Number(row.count);
    }
    const jobs = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
      .all() as Array<{ status: string; count: SqlValue }>;
    for (const row of jobs) result[`jobs_${row.status}`] = Number(row.count);
    const actions = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM actions GROUP BY status")
      .all() as Array<{ status: string; count: SqlValue }>;
    for (const row of actions) result[`actions_${row.status}`] = Number(row.count);
    return result;
  }

  private publicId(prefix: string, id: number): string {
    return `${prefix}-${String(id).padStart(6, "0")}`;
  }
}

interface ActionRow {
  id: number;
  public_id: string;
  kind: StoredAction["kind"];
  summary: string;
  target: string;
  payload: string;
  reason: string;
  risk: StoredAction["risk"];
  quality_review: string | null;
}

function parseQualityReview(value: string | null): StoredAction["qualityReview"] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as StoredAction["qualityReview"];
    if (!parsed || !["pass", "revised", "blocked"].includes(parsed.verdict)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function mapAction(row: ActionRow): StoredAction {
  const qualityReview = parseQualityReview(row.quality_review);
  return {
    id: row.id,
    publicId: row.public_id,
    kind: row.kind,
    summary: row.summary,
    target: row.target,
    payload: row.payload,
    reason: row.reason,
    risk: row.risk,
    ...(qualityReview ? { qualityReview } : {}),
  };
}

function normalizeLearnedRule(
  situationValue: string,
  instructionValue: string,
): { key: string; situation: string; instruction: string } | null {
  const situation = situationValue.trim().replace(/\s+/g, " ").slice(0, 500);
  const instruction = instructionValue.trim().replace(/\s+/g, " ").slice(0, 1_000);
  const combined = `${situation} ${instruction}`;
  if (!situation || !instruction) return null;
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(combined)) return null;
  if (/\b\d{5,}\b/.test(combined)) return null;
  const key = situation.toLocaleLowerCase("pl-PL").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return key ? { key, situation, instruction } : null;
}
