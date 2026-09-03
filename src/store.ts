import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentTurnOutput,
  ClaimedJob,
  IncomingMessage,
  StoredConversation,
  StoredMessage,
  StoredAction,
  StoredLearnedRule,
  StoredVerifiedHumanCorrection,
  VerifiedHumanCorrectionSnapshot,
} from "./types.js";

type SqlValue = string | number | bigint | null;

interface OperationalActionDispatchRow {
  idempotency_key: string;
  request_hash: string;
  payload_hash: string;
  action_type: string;
  destination: string;
  route_identity: string;
  status: "sending" | "sent";
  external_reference: string | null;
  attempts: number;
  last_attempt_at: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

interface TicketScopedGuidanceRow {
  guidance_id: string;
  guidance_hash: string;
  external_ticket_id: string;
  source_revision: number;
  content: string;
  decision: "yes" | "no" | "custom";
  source_created_at: string;
  store_receipt_id: string;
  conversation_id: number;
  source_message_id: number;
  stored_at: string;
}

interface NativeDaktelaContextBindingRow {
  masterlink_operation_id: string;
  external_ticket_id: string;
  source_revision: number;
  masterlink_ticket_id: string;
  masterlink_trigger_message_id: string;
  source_snapshot_hash: string;
  source_external_revision: string;
  source_trigger_event_id: string;
  context_hash: string;
  conversation_id: number;
  source_message_id: number;
  stored_at: string;
}

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

export type ApproveActionAndEnqueueResult =
  | { status: "queued"; jobPublicId: string }
  | { status: "stale" }
  | { status: "missing" }
  | { status: "already_decided" };

export interface JobCompletionDelivery {
  kind: "message" | "discard";
  message: string;
}

export interface ClaimedDelivery {
  id: number;
  job: ClaimedJob;
  kind: "message" | "discard";
  message: string;
  actions: StoredAction[];
  attempts: number;
}

export interface OperationalActionDispatchRecord {
  idempotencyKey: string;
  requestHash: string;
  payloadHash: string;
  actionType: string;
  destination: string;
  routeIdentity: string;
  status: "sending" | "sent";
  externalReference: string | null;
  attempts: number;
  lastAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface ReserveOperationalActionDispatchInput {
  idempotencyKey: string;
  requestHash: string;
  payloadHash: string;
  actionType: string;
  destination: string;
  routeIdentity: string;
}

export type ReserveOperationalActionDispatchResult =
  | { status: "created"; record: OperationalActionDispatchRecord }
  | { status: "existing"; record: OperationalActionDispatchRecord }
  | { status: "conflict" };

export interface TicketScopedGuidanceInput {
  readonly guidanceId: string;
  readonly guidanceHash: string;
  readonly externalTicketId: string;
  readonly sourceRevision: number;
  readonly content: string;
  readonly decision: "yes" | "no" | "custom";
  readonly createdAt: string;
}

export interface TicketScopedGuidanceReceipt {
  readonly guidanceId: string;
  readonly guidanceHash: string;
  readonly scope: "ticket";
  readonly externalTicketId: string;
  readonly storeReceiptId: string;
  readonly storeIdentity: string;
}

export interface TicketScopedGuidanceRecord {
  readonly receipt: TicketScopedGuidanceReceipt;
  readonly conversationId: number;
  readonly messageId: number;
}

export interface NativeDaktelaContextReconciliationInput {
  readonly masterlinkOperationId: string;
  readonly externalTicketId: string;
  readonly sourceRevision: number;
  readonly masterlinkTicketId: string;
  readonly masterlinkTriggerMessageId: string;
  readonly sourceSnapshotHash: string;
  readonly sourceExternalRevision: string;
  readonly sourceTriggerEventId: string;
  readonly contextHash: string;
  readonly content: string;
}

export interface NativeDaktelaContextReconciliationRecord {
  readonly inserted: boolean;
  readonly conversationId: number;
  readonly messageId: number;
}

export type EnqueueDaktelaMonitorCandidateResult =
  | {
      readonly status: "queued";
      readonly conversationId: number;
      readonly messageId: number;
      readonly jobId: number;
    }
  | {
      readonly status: "duplicate";
      readonly conversationId: number;
      readonly messageId: number;
      readonly jobId: number;
    }
  | { readonly status: "native_reconciled" | "stale" };

function now(): string {
  return new Date().toISOString();
}

function fingerprintsDiffer(previous: string, current: string): boolean {
  // v7 usuwało z fingerprintu niestabilne pole Kendo `edited_by`. Pierwszy skan po wdrożeniu
  // tylko migruje istniejący zapis, żeby nie zakolejkować ponownie całej otwartej kolejki.
  if (/^v7:/.test(current) && !/^v\d+:/.test(previous)) return false;
  return previous !== current;
}

function canonicalDaktelaExternalRevision(value: string): string | null {
  if (!value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function toOperationalActionDispatchRecord(
  row: OperationalActionDispatchRow,
): OperationalActionDispatchRecord {
  return {
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    payloadHash: row.payload_hash,
    actionType: row.action_type,
    destination: row.destination,
    routeIdentity: row.route_identity,
    status: row.status,
    externalReference: row.external_reference,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

function operationalDispatchMatches(
  record: OperationalActionDispatchRecord,
  input: ReserveOperationalActionDispatchInput,
): boolean {
  return record.requestHash === input.requestHash &&
    record.payloadHash === input.payloadHash &&
    record.actionType === input.actionType &&
    record.destination === input.destination &&
    // Po potwierdzonym wysłaniu zapisany receipt pozostaje prawdą także po świadomej
    // zmianie kanału w konfiguracji. Rekordu niepewnego nie wolno natomiast przenieść
    // na nową fizyczną trasę, bo stary POST mógł już zostać przyjęty przez Discord.
    (record.status === "sent" || record.routeIdentity === input.routeIdentity);
}

function assertTicketScopedGuidanceInput(input: TicketScopedGuidanceInput): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.guidanceId)) {
    throw new Error("ticket_guidance_id_invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(input.guidanceHash)) {
    throw new Error("ticket_guidance_hash_invalid");
  }
  if (!/^[A-Za-z0-9_]{1,100}$/.test(input.externalTicketId)) {
    throw new Error("ticket_guidance_ticket_invalid");
  }
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1) {
    throw new Error("ticket_guidance_revision_invalid");
  }
  if (
    input.content.length < 1
    || input.content.length > 4_000
    || input.content.trim().length < 1
    || input.content.normalize("NFC") !== input.content
    || createHash("sha256").update(input.content, "utf8").digest("hex") !== input.guidanceHash
  ) {
    throw new Error("ticket_guidance_content_invalid");
  }
  if (!(["yes", "no", "custom"] as const).includes(input.decision)) {
    throw new Error("ticket_guidance_decision_invalid");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.createdAt)
    || Number.isNaN(Date.parse(input.createdAt))
  ) {
    throw new Error("ticket_guidance_created_at_invalid");
  }
}

function ticketScopedGuidanceMatches(
  row: TicketScopedGuidanceRow,
  input: TicketScopedGuidanceInput,
): boolean {
  return row.guidance_hash === input.guidanceHash
    && row.external_ticket_id === input.externalTicketId
    && row.source_revision === input.sourceRevision
    && row.content === input.content
    && row.decision === input.decision
    && row.source_created_at === input.createdAt;
}

function ticketScopedGuidanceRecord(
  row: TicketScopedGuidanceRow,
  storeIdentity: string,
): TicketScopedGuidanceRecord {
  return {
    receipt: {
      guidanceId: row.guidance_id,
      guidanceHash: row.guidance_hash,
      scope: "ticket",
      externalTicketId: row.external_ticket_id,
      storeReceiptId: row.store_receipt_id,
      storeIdentity,
    },
    conversationId: row.conversation_id,
    messageId: row.source_message_id,
  };
}

function ticketScopedGuidanceReceiptId(
  input: TicketScopedGuidanceInput,
  storeIdentity: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      guidanceHash: input.guidanceHash,
      guidanceId: input.guidanceId,
      externalTicketId: input.externalTicketId,
      sourceRevision: input.sourceRevision,
      storeIdentity,
    }), "utf8")
    .digest("hex");
}

function renderTicketScopedGuidance(input: TicketScopedGuidanceInput): string {
  return [
    `[ZATWIERDZONA WSKAZÓWKA MANAGERA BOK — WYŁĄCZNIE DAKTELA #${input.externalTicketId}]`,
    `Decyzja: ${input.decision}. Rewizja sprawy: ${input.sourceRevision}.`,
    input.content,
    "Nie uogólniaj tej wskazówki na inne tickety ani klientów.",
  ].join("\n\n");
}

function assertNativeDaktelaContextReconciliationInput(
  input: NativeDaktelaContextReconciliationInput,
): void {
  const safeId = /^[A-Za-z0-9_]{1,100}$/;
  if (!safeId.test(input.externalTicketId) || !safeId.test(input.sourceTriggerEventId)) {
    throw new Error("native_daktela_context_source_invalid");
  }
  if (
    !Number.isSafeInteger(input.sourceRevision)
    || input.sourceRevision < 1
    || input.masterlinkOperationId.length < 1
    || input.masterlinkOperationId.length > 100
    || input.masterlinkOperationId.trim() !== input.masterlinkOperationId
    || input.masterlinkTicketId.length < 1
    || input.masterlinkTicketId.length > 100
    || input.masterlinkTicketId.trim() !== input.masterlinkTicketId
    || input.masterlinkTriggerMessageId.length < 1
    || input.masterlinkTriggerMessageId.length > 100
    || input.masterlinkTriggerMessageId.trim() !== input.masterlinkTriggerMessageId
  ) {
    throw new Error("native_daktela_context_binding_invalid");
  }
  if (
    !/^[a-f0-9]{64}$/.test(input.sourceSnapshotHash)
    || !/^[a-f0-9]{64}$/.test(input.contextHash)
    || createHash("sha256").update(input.content, "utf8").digest("hex") !== input.contextHash
  ) {
    throw new Error("native_daktela_context_hash_invalid");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      input.sourceExternalRevision,
    )
    || Number.isNaN(Date.parse(input.sourceExternalRevision))
    || input.content.length < 1
    || input.content.length > 600_000
    || input.content.trim().length < 1
  ) {
    throw new Error("native_daktela_context_payload_invalid");
  }
}

function nativeDaktelaContextBindingMatches(
  row: NativeDaktelaContextBindingRow,
  input: NativeDaktelaContextReconciliationInput,
): boolean {
  return row.masterlink_operation_id === input.masterlinkOperationId
    && row.external_ticket_id === input.externalTicketId
    && row.source_revision === input.sourceRevision
    && row.masterlink_ticket_id === input.masterlinkTicketId
    && row.masterlink_trigger_message_id === input.masterlinkTriggerMessageId
    && row.source_snapshot_hash === input.sourceSnapshotHash
    && row.source_external_revision === input.sourceExternalRevision
    && row.source_trigger_event_id === input.sourceTriggerEventId
    && row.context_hash === input.contextHash;
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
        latest_seen_fingerprint TEXT,
        external_revision TEXT,
        latest_seen_external_revision TEXT,
        stage TEXT NOT NULL,
        assigned_user TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_queued_at TEXT,
        last_job_id INTEGER REFERENCES jobs(id),
        last_queued_fingerprint TEXT,
        last_queued_external_revision TEXT,
        discord_thread_id TEXT
      );

      CREATE TABLE IF NOT EXISTS discord_delivery_routes (
        bot_message_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('message', 'discard')),
        message TEXT NOT NULL DEFAULT '',
        action_public_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        next_attempt_at TEXT,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS draft_reviews (
        action_id INTEGER PRIMARY KEY REFERENCES actions(id) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK(decision = 'accepted'),
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learned_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalized_key TEXT NOT NULL UNIQUE,
        situation TEXT NOT NULL,
        instruction TEXT NOT NULL,
        source_conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        source_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        verified_revision INTEGER,
        source_content TEXT,
        source_author_id TEXT,
        source_author_name TEXT,
        source_external_message_id TEXT,
        source_channel_id TEXT,
        correction_source_kind TEXT CHECK(correction_source_kind IN ('reply', 'direct_mention')),
        reply_to_bot_message_id TEXT,
        authorization_kind TEXT CHECK(authorization_kind IN ('allowed_user', 'allowed_role')),
        authorization_id TEXT
      );

      CREATE TABLE IF NOT EXISTS verified_correction_sources (
        source_message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        source_external_message_id TEXT NOT NULL UNIQUE,
        source_channel_id TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('reply', 'direct_mention')),
        reply_to_bot_message_id TEXT,
        authorization_kind TEXT NOT NULL CHECK(authorization_kind IN ('allowed_user', 'allowed_role')),
        authorization_id TEXT NOT NULL,
        source_revision INTEGER,
        -- Kept only so an SQLite file created by an earlier PR6 build can be migrated safely.
        verified_revision INTEGER,
        derived_situation TEXT,
        derived_instruction TEXT,
        updated_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS verified_correction_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        revision INTEGER NOT NULL CHECK(revision >= 0)
      );
      INSERT OR IGNORE INTO verified_correction_state(singleton, revision) VALUES (1, 0);

      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operational_action_dispatches (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        action_type TEXT NOT NULL,
        destination TEXT NOT NULL,
        route_identity TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sending', 'sent')),
        external_reference TEXT,
        attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts >= 1),
        last_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        CHECK(
          (status = 'sending' AND external_reference IS NULL AND sent_at IS NULL)
          OR (status = 'sent' AND external_reference IS NOT NULL AND sent_at IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS ticket_scoped_guidance (
        guidance_id TEXT PRIMARY KEY,
        guidance_hash TEXT NOT NULL,
        external_ticket_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
        content TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('yes', 'no', 'custom')),
        source_created_at TEXT NOT NULL,
        store_receipt_id TEXT NOT NULL UNIQUE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
        source_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
        stored_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS native_daktela_context_bindings (
        masterlink_operation_id TEXT PRIMARY KEY,
        external_ticket_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
        masterlink_ticket_id TEXT NOT NULL,
        masterlink_trigger_message_id TEXT NOT NULL,
        source_snapshot_hash TEXT NOT NULL,
        source_external_revision TEXT NOT NULL,
        source_trigger_event_id TEXT NOT NULL,
        context_hash TEXT NOT NULL,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
        source_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
        stored_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS jobs_status_id_idx ON jobs(status, id);
      CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages(conversation_id, id);
      CREATE INDEX IF NOT EXISTS actions_status_id_idx ON actions(status, id);
      CREATE INDEX IF NOT EXISTS daktela_observations_last_job_idx
        ON daktela_observations(last_job_id);
      CREATE INDEX IF NOT EXISTS discord_delivery_routes_conversation_idx
        ON discord_delivery_routes(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS deliveries_status_id_idx ON deliveries(status, id);
      CREATE INDEX IF NOT EXISTS learned_rules_updated_idx
        ON learned_rules(updated_at DESC);
      CREATE INDEX IF NOT EXISTS operational_action_dispatches_status_idx
        ON operational_action_dispatches(status, updated_at);
      CREATE INDEX IF NOT EXISTS ticket_scoped_guidance_ticket_idx
        ON ticket_scoped_guidance(external_ticket_id, source_revision);
      CREATE INDEX IF NOT EXISTS native_daktela_context_masterlink_idx
        ON native_daktela_context_bindings(masterlink_ticket_id, source_revision);
      CREATE INDEX IF NOT EXISTS native_daktela_context_source_idx
        ON native_daktela_context_bindings(external_ticket_id, source_external_revision);
    `);
    this.migrateNativeDaktelaContextBindings();
    this.db.prepare(`
      INSERT OR IGNORE INTO runtime_metadata(key, value)
      VALUES ('store_id', ?)
    `).run(randomUUID());
    this.ensureColumn("jobs", "approved_action_id", "INTEGER REFERENCES actions(id)");
    this.ensureColumn("actions", "execution_result", "TEXT");
    this.ensureColumn("actions", "payload", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("actions", "quality_review", "TEXT");
    this.ensureColumn("daktela_observations", "discord_thread_id", "TEXT");
    this.ensureColumn("daktela_observations", "latest_seen_fingerprint", "TEXT");
    this.ensureColumn("daktela_observations", "external_revision", "TEXT");
    this.ensureColumn("daktela_observations", "latest_seen_external_revision", "TEXT");
    this.ensureColumn("daktela_observations", "last_queued_fingerprint", "TEXT");
    this.ensureColumn("daktela_observations", "last_queued_external_revision", "TEXT");
    this.ensureColumn("deliveries", "next_attempt_at", "TEXT");
    this.db
      .prepare(`
        UPDATE daktela_observations
        SET latest_seen_fingerprint = fingerprint
        WHERE latest_seen_fingerprint IS NULL OR latest_seen_fingerprint = ''
      `)
      .run();
    this.ensureColumn(
      "messages",
      "shared_context",
      "INTEGER NOT NULL DEFAULT 0 CHECK(shared_context IN (0, 1))",
    );
    this.ensureColumn("verified_correction_sources", "verified_revision", "INTEGER");
    this.ensureColumn("verified_correction_sources", "source_revision", "INTEGER");
    this.ensureColumn("verified_correction_sources", "derived_situation", "TEXT");
    this.ensureColumn("verified_correction_sources", "derived_instruction", "TEXT");
    this.ensureColumn("verified_correction_sources", "updated_at", "TEXT");
    this.ensureColumn("learned_rules", "verified_revision", "INTEGER");
    this.ensureColumn("learned_rules", "source_content", "TEXT");
    this.ensureColumn("learned_rules", "source_author_id", "TEXT");
    this.ensureColumn("learned_rules", "source_author_name", "TEXT");
    this.ensureColumn("learned_rules", "source_external_message_id", "TEXT");
    this.ensureColumn("learned_rules", "source_channel_id", "TEXT");
    this.ensureColumn("learned_rules", "correction_source_kind", "TEXT");
    this.ensureColumn("learned_rules", "reply_to_bot_message_id", "TEXT");
    this.ensureColumn("learned_rules", "authorization_kind", "TEXT");
    this.ensureColumn("learned_rules", "authorization_id", "TEXT");
    this.ensureColumn(
      "verified_correction_sources",
      "source_kind",
      "TEXT NOT NULL DEFAULT 'reply'",
    );
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS learned_rules_verified_source_idx
        ON learned_rules(source_external_message_id)
        WHERE verified_revision IS NOT NULL;
    `);
    this.migrateVerifiedCorrectionSources();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS verified_correction_source_revision_idx
        ON verified_correction_sources(source_revision)
        WHERE source_revision IS NOT NULL;
    `);
  }

  /**
   * An intermediate build keyed native bindings by ticket revision. Rebuild that unpublished
   * shape transactionally so a newer ML operation may refresh verified facts without inventing a
   * ticket revision. Legacy rows retain their source marker under a deterministic opaque key.
   */
  private migrateNativeDaktelaContextBindings(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(native_daktela_context_bindings)")
      .all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "masterlink_operation_id")) return;
    const legacyRows = this.db
      .prepare(`
        SELECT external_ticket_id, source_revision, masterlink_ticket_id,
               masterlink_trigger_message_id, source_snapshot_hash,
               source_external_revision, source_trigger_event_id, context_hash,
               conversation_id, source_message_id, stored_at
        FROM native_daktela_context_bindings
        ORDER BY external_ticket_id, source_revision
      `)
      .all() as Array<Omit<NativeDaktelaContextBindingRow, "masterlink_operation_id">>;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        DROP INDEX IF EXISTS native_daktela_context_masterlink_idx;
        DROP INDEX IF EXISTS native_daktela_context_source_idx;
        ALTER TABLE native_daktela_context_bindings
          RENAME TO native_daktela_context_bindings_legacy_v1;
        CREATE TABLE native_daktela_context_bindings (
          masterlink_operation_id TEXT PRIMARY KEY,
          external_ticket_id TEXT NOT NULL,
          source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
          masterlink_ticket_id TEXT NOT NULL,
          masterlink_trigger_message_id TEXT NOT NULL,
          source_snapshot_hash TEXT NOT NULL,
          source_external_revision TEXT NOT NULL,
          source_trigger_event_id TEXT NOT NULL,
          context_hash TEXT NOT NULL,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
          source_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
          stored_at TEXT NOT NULL
        );
      `);
      const insert = this.db.prepare(`
        INSERT INTO native_daktela_context_bindings(
          masterlink_operation_id, external_ticket_id, source_revision, masterlink_ticket_id,
          masterlink_trigger_message_id, source_snapshot_hash, source_external_revision,
          source_trigger_event_id, context_hash, conversation_id, source_message_id, stored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of legacyRows) {
        const legacyKey = `legacy-v1:${createHash("sha256")
          .update(JSON.stringify([
            row.external_ticket_id,
            row.source_revision,
            row.masterlink_ticket_id,
            row.masterlink_trigger_message_id,
            row.source_snapshot_hash,
            row.context_hash,
          ]), "utf8")
          .digest("hex")}`;
        insert.run(
          legacyKey,
          row.external_ticket_id,
          row.source_revision,
          row.masterlink_ticket_id,
          row.masterlink_trigger_message_id,
          row.source_snapshot_hash,
          row.source_external_revision,
          row.source_trigger_event_id,
          row.context_hash,
          row.conversation_id,
          row.source_message_id,
          row.stored_at,
        );
      }
      this.db.exec(`
        DROP TABLE native_daktela_context_bindings_legacy_v1;
        CREATE INDEX native_daktela_context_masterlink_idx
          ON native_daktela_context_bindings(masterlink_ticket_id, source_revision);
        CREATE INDEX native_daktela_context_source_idx
          ON native_daktela_context_bindings(external_ticket_id, source_external_revision);
        COMMIT;
      `);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  runtimeIdentity(): string {
    const row = this.db
      .prepare("SELECT value FROM runtime_metadata WHERE key = 'store_id'")
      .get() as { value?: unknown } | undefined;
    if (!row || typeof row.value !== "string" || !/^[0-9a-f-]{36}$/i.test(row.value)) {
      throw new Error("Brak tożsamości wspólnego AgentStore.");
    }
    return row.value;
  }

  runtimeStoreIdentity(): string {
    return createHash("sha256").update(this.runtimeIdentity(), "utf8").digest("hex");
  }

  /**
   * Reconciles the exact ML snapshot into the same conversation used by the Discord pipeline.
   * The caller may invoke this only after independently verifying the canonical Daktela source.
   * One ML operation is immutable: retrying it is a no-op, while a fresh operation may lawfully
   * refresh facts or guidance at the same ticket revision. Older ticket revisions and remaps fail
   * closed before guidance or inference can observe them.
   */
  reconcileNativeDaktelaContext(
    input: NativeDaktelaContextReconciliationInput,
  ): NativeDaktelaContextReconciliationRecord {
    assertNativeDaktelaContextReconciliationInput(input);
    const conversationExternalId = `daktela-ticket:${input.externalTicketId}`;
    const operationKey = createHash("sha256")
      .update(input.masterlinkOperationId, "utf8")
      .digest("hex")
      .slice(0, 24);
    const externalMessageId = `masterlink-native:v2:${input.externalTicketId}:${operationKey}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.nativeDaktelaContextBinding(input.masterlinkOperationId);
      const newest = this.db
        .prepare(`
          SELECT MAX(source_revision) AS source_revision
          FROM native_daktela_context_bindings
          WHERE external_ticket_id = ? OR masterlink_ticket_id = ?
        `)
        .get(input.externalTicketId, input.masterlinkTicketId) as
          | { source_revision: number | null }
          | undefined;
      if (
        newest?.source_revision !== null
        && newest?.source_revision !== undefined
        && newest.source_revision > input.sourceRevision
      ) {
        throw new Error("native_daktela_context_stale");
      }
      if (existing) {
        if (!nativeDaktelaContextBindingMatches(existing, input)) {
          throw new Error("native_daktela_context_conflict");
        }
        const storedMessage = this.db
          .prepare(`
            SELECT messages.content, messages.external_message_id, conversations.external_id
            FROM messages
            JOIN conversations ON conversations.id = messages.conversation_id
            WHERE messages.id = ? AND messages.conversation_id = ?
          `)
          .get(existing.source_message_id, existing.conversation_id) as
            | { content: string; external_message_id: string; external_id: string }
            | undefined;
        if (
          !storedMessage
          || storedMessage.content !== input.content
          || storedMessage.external_message_id !== externalMessageId
          || storedMessage.external_id !== conversationExternalId
        ) {
          throw new Error("native_daktela_context_conflict");
        }
        this.db.exec("COMMIT");
        return {
          inserted: false,
          conversationId: existing.conversation_id,
          messageId: existing.source_message_id,
        };
      }

      const exactSourceRows = this.db
        .prepare(`
          SELECT source_snapshot_hash, source_trigger_event_id
          FROM native_daktela_context_bindings
          WHERE external_ticket_id = ? AND source_external_revision = ?
        `)
        .all(input.externalTicketId, input.sourceExternalRevision) as Array<{
          source_snapshot_hash: string;
          source_trigger_event_id: string;
        }>;
      if (exactSourceRows.some((row) =>
        row.source_snapshot_hash !== input.sourceSnapshotHash
        || row.source_trigger_event_id !== input.sourceTriggerEventId
      )) {
        throw new Error("native_daktela_context_conflict");
      }

      // A real standalone-monitor job owns this exact Daktela revision. Starting a second,
      // synchronous native inference would produce two potentially different answers from the
      // same agent. `last_job_id` remains reserved for actual jobs; native runs use their immutable
      // source binding below as the separate marker.
      const monitorOwner = this.db
        .prepare(`
          SELECT jobs.id AS last_job_id
          FROM jobs
          JOIN messages
            ON messages.id = jobs.trigger_message_id
           AND messages.conversation_id = jobs.conversation_id
          JOIN conversations ON conversations.id = jobs.conversation_id
          LEFT JOIN daktela_observations AS observations
            ON observations.ticket_id = ?
          WHERE conversations.platform = 'discord'
            AND conversations.external_id = ?
            AND messages.author_id = 'daktela-monitor'
            AND messages.role = 'context'
            AND jobs.external_message_id LIKE 'daktela:%'
            AND (
              jobs.status IN ('pending', 'running')
              OR (
                observations.last_job_id = jobs.id
                AND observations.last_queued_external_revision = ?
              )
              OR (
                observations.external_revision = ?
                AND substr(jobs.external_message_id, -16) = substr(observations.fingerprint, 1, 16)
              )
            )
          LIMIT 1
        `)
        .get(
          input.externalTicketId,
          conversationExternalId,
          input.sourceExternalRevision,
          input.sourceExternalRevision,
        ) as
          | { last_job_id: number }
          | undefined;
      if (monitorOwner) throw new Error("native_daktela_context_monitor_owned");

      const incompatibleMapping = this.db
        .prepare(`
          SELECT 1
          FROM native_daktela_context_bindings
          WHERE (external_ticket_id = ? AND masterlink_ticket_id != ?)
             OR (masterlink_ticket_id = ? AND external_ticket_id != ?)
          LIMIT 1
        `)
        .get(
          input.externalTicketId,
          input.masterlinkTicketId,
          input.masterlinkTicketId,
          input.externalTicketId,
        );
      if (incompatibleMapping) throw new Error("native_daktela_context_conflict");

      const timestamp = now();
      this.db
        .prepare(`
          INSERT INTO conversations(platform, external_id, created_at, updated_at)
          VALUES ('discord', ?, ?, ?)
          ON CONFLICT(platform, external_id) DO UPDATE SET updated_at = excluded.updated_at
        `)
        .run(conversationExternalId, timestamp, timestamp);
      const conversation = this.db
        .prepare(`
          SELECT id
          FROM conversations
          WHERE platform = 'discord' AND external_id = ?
        `)
        .get(conversationExternalId) as { id: number } | undefined;
      if (!conversation) throw new Error("native_daktela_context_conversation_missing");

      const insertedMessage = this.db
        .prepare(`
          INSERT OR IGNORE INTO messages(
            conversation_id, external_message_id, role, author_id, author_name, content,
            shared_context, created_at
          ) VALUES (?, ?, 'context', 'masterlink-native-context',
                    'MasterLink — zweryfikowany kontekst ticketu', ?, 0, ?)
        `)
        .run(
          conversation.id,
          externalMessageId,
          input.content,
          input.sourceExternalRevision,
        );
      const message = this.db
        .prepare(`
          SELECT id, content
          FROM messages
          WHERE conversation_id = ? AND external_message_id = ?
        `)
        .get(conversation.id, externalMessageId) as { id: number; content: string } | undefined;
      if (!message || insertedMessage.changes !== 1 || message.content !== input.content) {
        throw new Error("native_daktela_context_conflict");
      }

      this.db
        .prepare(`
          INSERT INTO native_daktela_context_bindings(
            masterlink_operation_id, external_ticket_id, source_revision, masterlink_ticket_id,
            masterlink_trigger_message_id, source_snapshot_hash,
            source_external_revision, source_trigger_event_id, context_hash,
            conversation_id, source_message_id, stored_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.masterlinkOperationId,
          input.externalTicketId,
          input.sourceRevision,
          input.masterlinkTicketId,
          input.masterlinkTriggerMessageId,
          input.sourceSnapshotHash,
          input.sourceExternalRevision,
          input.sourceTriggerEventId,
          input.contextHash,
          conversation.id,
          message.id,
          timestamp,
        );
      this.db.exec("COMMIT");
      return { inserted: true, conversationId: conversation.id, messageId: message.id };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private nativeDaktelaContextBinding(
    masterlinkOperationId: string,
  ): NativeDaktelaContextBindingRow | null {
    const row = this.db
      .prepare(`
        SELECT masterlink_operation_id, external_ticket_id, source_revision, masterlink_ticket_id,
               masterlink_trigger_message_id, source_snapshot_hash,
               source_external_revision, source_trigger_event_id, context_hash,
               conversation_id, source_message_id, stored_at
        FROM native_daktela_context_bindings
        WHERE masterlink_operation_id = ?
      `)
      .get(masterlinkOperationId) as NativeDaktelaContextBindingRow | undefined;
    return row ?? null;
  }

  recordTicketScopedGuidance(input: TicketScopedGuidanceInput): TicketScopedGuidanceRecord {
    assertTicketScopedGuidanceInput(input);
    const conversationExternalId = `daktela-ticket:${input.externalTicketId}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.ticketScopedGuidanceRow(input.guidanceId);
      if (existing) {
        if (!ticketScopedGuidanceMatches(existing, input)) {
          throw new Error("ticket_guidance_conflict");
        }
        this.db.exec("COMMIT");
        return ticketScopedGuidanceRecord(existing, this.runtimeStoreIdentity());
      }
      const conversation = this.db
        .prepare(`
          SELECT id
          FROM conversations
          WHERE platform = 'discord' AND external_id = ?
        `)
        .get(conversationExternalId) as { id: number } | undefined;
      if (!conversation) throw new Error("ticket_guidance_conversation_missing");

      const storeReceiptId = ticketScopedGuidanceReceiptId(input, this.runtimeIdentity());
      const message = this.db
        .prepare(`
          INSERT INTO messages(
            conversation_id, external_message_id, role, author_id, author_name, content,
            shared_context, created_at
          ) VALUES (?, ?, 'human', 'masterlink-guidance', 'Wskazówka managera BOK', ?, 0, ?)
        `)
        .run(
          conversation.id,
          `masterlink-guidance:${input.guidanceId}`,
          renderTicketScopedGuidance(input),
          input.createdAt,
        );
      const messageId = Number(message.lastInsertRowid);
      const storedAt = now();
      this.db
        .prepare(`
          INSERT INTO ticket_scoped_guidance(
            guidance_id, guidance_hash, external_ticket_id, source_revision, content,
            decision, source_created_at, store_receipt_id, conversation_id,
            source_message_id, stored_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.guidanceId,
          input.guidanceHash,
          input.externalTicketId,
          input.sourceRevision,
          input.content,
          input.decision,
          input.createdAt,
          storeReceiptId,
          conversation.id,
          messageId,
          storedAt,
        );
      const inserted = this.ticketScopedGuidanceRow(input.guidanceId);
      if (!inserted) throw new Error("ticket_guidance_insert_missing");
      this.db.exec("COMMIT");
      return ticketScopedGuidanceRecord(inserted, this.runtimeStoreIdentity());
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ticketScopedGuidance(guidanceId: string): TicketScopedGuidanceRecord | null {
    const row = this.ticketScopedGuidanceRow(guidanceId);
    return row ? ticketScopedGuidanceRecord(row, this.runtimeStoreIdentity()) : null;
  }

  syntheticDaktelaDecisionJob(input: {
    externalTicketId: string;
    sourceSnapshotHash: string;
    guidanceMessageId?: number;
    channelId: string;
  }): ClaimedJob {
    if (
      !/^[A-Za-z0-9_]{1,100}$/.test(input.externalTicketId)
      || !/^[a-f0-9]{64}$/.test(input.sourceSnapshotHash)
      || !input.channelId
    ) {
      throw new Error("native_daktela_job_binding_invalid");
    }
    const conversation = this.db
      .prepare(`
        SELECT id
        FROM conversations
        WHERE platform = 'discord' AND external_id = ?
      `)
      .get(`daktela-ticket:${input.externalTicketId}`) as { id: number } | undefined;
    if (!conversation) throw new Error("native_daktela_conversation_missing");
    const trigger = input.guidanceMessageId === undefined
      ? this.db
          .prepare(`
            SELECT id
            FROM messages
            WHERE conversation_id = ? AND role IN ('human', 'context')
            ORDER BY id DESC
            LIMIT 1
          `)
          .get(conversation.id) as { id: number } | undefined
      : this.db
          .prepare(`
            SELECT id
            FROM messages
            WHERE id = ? AND conversation_id = ? AND role = 'human'
              AND author_id = 'masterlink-guidance'
          `)
          .get(input.guidanceMessageId, conversation.id) as { id: number } | undefined;
    if (!trigger) throw new Error("native_daktela_trigger_missing");
    return {
      id: -1,
      publicId: `ML-${input.sourceSnapshotHash.slice(0, 16)}`,
      conversationId: conversation.id,
      triggerMessageId: trigger.id,
      platform: "discord",
      channelId: input.channelId,
      externalMessageId: `daktela:v7:${input.externalTicketId}:${input.sourceSnapshotHash.slice(0, 16)}`,
      attempts: 1,
    };
  }

  private ticketScopedGuidanceRow(guidanceId: string): TicketScopedGuidanceRow | null {
    const row = this.db
      .prepare(`
        SELECT guidance_id, guidance_hash, external_ticket_id, source_revision, content,
               decision, source_created_at, store_receipt_id, conversation_id,
               source_message_id, stored_at
        FROM ticket_scoped_guidance
        WHERE guidance_id = ?
      `)
      .get(guidanceId) as TicketScopedGuidanceRow | undefined;
    return row ?? null;
  }

  reserveOperationalActionDispatch(
    input: ReserveOperationalActionDispatchInput,
  ): ReserveOperationalActionDispatchResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.operationalActionDispatch(input.idempotencyKey);
      if (existing) {
        this.db.exec("COMMIT");
        return operationalDispatchMatches(existing, input)
          ? { status: "existing", record: existing }
          : { status: "conflict" };
      }
      const timestamp = now();
      this.db
        .prepare(`
          INSERT INTO operational_action_dispatches(
            idempotency_key, request_hash, payload_hash, action_type, destination,
            route_identity, status, attempts, last_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?, ?)
        `)
        .run(
          input.idempotencyKey,
          input.requestHash,
          input.payloadHash,
          input.actionType,
          input.destination,
          input.routeIdentity,
          timestamp,
          timestamp,
          timestamp,
        );
      const created = this.operationalActionDispatch(input.idempotencyKey);
      if (!created) throw new Error("operational_dispatch_insert_missing");
      this.db.exec("COMMIT");
      return { status: "created", record: created };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  operationalActionDispatch(idempotencyKey: string): OperationalActionDispatchRecord | null {
    const row = this.db
      .prepare(`
        SELECT idempotency_key, request_hash, payload_hash, action_type, destination,
               route_identity, status, external_reference, attempts, last_attempt_at,
               created_at, updated_at, sent_at
        FROM operational_action_dispatches
        WHERE idempotency_key = ?
      `)
      .get(idempotencyKey) as OperationalActionDispatchRow | undefined;
    return row ? toOperationalActionDispatchRecord(row) : null;
  }

  claimOperationalActionDispatchRetry(input: {
    idempotencyKey: string;
    payloadHash: string;
    retryBefore: string;
  }): boolean {
    const timestamp = now();
    const updated = this.db
      .prepare(`
        UPDATE operational_action_dispatches
        SET attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
        WHERE idempotency_key = ?
          AND payload_hash = ?
          AND status = 'sending'
          AND last_attempt_at <= ?
      `)
      .run(
        timestamp,
        timestamp,
        input.idempotencyKey,
        input.payloadHash,
        input.retryBefore,
      );
    return updated.changes === 1;
  }

  completeOperationalActionDispatch(input: {
    idempotencyKey: string;
    payloadHash: string;
    externalReference: string;
  }): OperationalActionDispatchRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.operationalActionDispatch(input.idempotencyKey);
      if (!existing || existing.payloadHash !== input.payloadHash) {
        throw new Error("operational_dispatch_completion_mismatch");
      }
      if (existing.status === "sent") {
        if (existing.externalReference !== input.externalReference) {
          throw new Error("operational_dispatch_receipt_conflict");
        }
        this.db.exec("COMMIT");
        return existing;
      }
      const timestamp = now();
      const updated = this.db
        .prepare(`
          UPDATE operational_action_dispatches
          SET status = 'sent', external_reference = ?, sent_at = ?, updated_at = ?
          WHERE idempotency_key = ? AND payload_hash = ? AND status = 'sending'
        `)
        .run(
          input.externalReference,
          timestamp,
          timestamp,
          input.idempotencyKey,
          input.payloadHash,
        );
      if (updated.changes !== 1) throw new Error("operational_dispatch_completion_lost");
      const completed = this.operationalActionDispatch(input.idempotencyKey);
      if (!completed) throw new Error("operational_dispatch_completion_missing");
      this.db.exec("COMMIT");
      return completed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureColumn(
    table:
      | "jobs"
      | "actions"
      | "daktela_observations"
      | "messages"
      | "deliveries"
      | "learned_rules"
      | "verified_correction_sources",
    column: string,
    definition: string,
  ): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private migrateVerifiedCorrectionSources(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // PR6 originally versioned a correction only after the model emitted learnedRules.
      // Preserve that derived index when upgrading. Never reuse its old `verified_revision` for
      // source ordering: an older model job could have changed it after a newer human message.
      this.db.exec(`
        UPDATE verified_correction_sources
        SET derived_situation = COALESCE(
              derived_situation,
              (SELECT learned_rules.situation
               FROM learned_rules
               WHERE learned_rules.source_external_message_id =
                     verified_correction_sources.source_external_message_id
                 AND learned_rules.verified_revision IS NOT NULL
               ORDER BY learned_rules.verified_revision DESC
               LIMIT 1)
            ),
            derived_instruction = COALESCE(
              derived_instruction,
              (SELECT learned_rules.instruction
               FROM learned_rules
               WHERE learned_rules.source_external_message_id =
                     verified_correction_sources.source_external_message_id
                 AND learned_rules.verified_revision IS NOT NULL
               ORDER BY learned_rules.verified_revision DESC
               LIMIT 1)
            ),
            updated_at = COALESCE(updated_at, created_at)
      `);
      const maximumSourceRevision = this.db
        .prepare(`
          SELECT COALESCE(MAX(source_revision), 0) AS revision
          FROM verified_correction_sources
        `)
        .get() as { revision: number };
      const unversioned = this.db
        .prepare(`
          SELECT source_message_id
          FROM verified_correction_sources
          WHERE source_revision IS NULL
          ORDER BY created_at, source_message_id
        `)
        .all() as Array<{ source_message_id: number }>;
      let nextSourceRevision = maximumSourceRevision.revision;
      for (const source of unversioned) {
        nextSourceRevision += 1;
        this.db
          .prepare(`
            UPDATE verified_correction_sources
            SET source_revision = ?, updated_at = COALESCE(updated_at, created_at)
            WHERE source_message_id = ? AND source_revision IS NULL
          `)
          .run(nextSourceRevision, source.source_message_id);
      }
      // This is the revision of the whole snapshot, not the ordering revision of a source. It may
      // also advance later when the optional, explicitly untrusted derived index changes.
      this.db
        .prepare(`
          UPDATE verified_correction_state
          SET revision = MAX(revision, ?)
          WHERE singleton = 1
        `)
        .run(nextSourceRevision);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private recordVerifiedCorrectionSource(
    sourceMessageId: number,
    message: IncomingMessage,
    timestamp: string,
  ): void {
    const source = message.verifiedCorrectionSource;
    if (!source) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare(`
          INSERT OR IGNORE INTO verified_correction_sources(
            source_message_id, source_external_message_id, source_channel_id,
            source_kind, reply_to_bot_message_id, authorization_kind, authorization_id,
            updated_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          sourceMessageId,
          message.externalMessageId,
          message.channelId,
          source.sourceKind,
          source.replyToBotMessageId ?? "",
          source.authorizationKind,
          source.authorizationId,
          timestamp,
          timestamp,
        );
      const row = this.db
        .prepare(`
          SELECT source_message_id, source_revision
          FROM verified_correction_sources
          WHERE source_external_message_id = ?
        `)
        .get(message.externalMessageId) as
        | { source_message_id: number; source_revision: number | null }
        | undefined;
      // First-writer-wins provenance: an external id that resolves to another stored message is
      // never promoted or rewritten by a conflicting retry.
      if (row?.source_message_id === sourceMessageId && row.source_revision == null) {
        this.db
          .prepare("UPDATE verified_correction_state SET revision = revision + 1 WHERE singleton = 1")
          .run();
        const state = this.db
          .prepare("SELECT revision FROM verified_correction_state WHERE singleton = 1")
          .get() as { revision: number };
        this.db
          .prepare(`
            UPDATE verified_correction_sources
            SET source_revision = ?, updated_at = ?
            WHERE source_message_id = ? AND source_revision IS NULL
          `)
          .run(state.revision, timestamp, sourceMessageId);
      } else if (inserted.changes > 0 && !row) {
        throw new Error("verified_correction_source_insert_missing");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private recoverInterruptedJobs(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'running'")
        .run();
      this.db
        .prepare(`
          UPDATE deliveries
          SET status = 'pending', started_at = NULL, next_attempt_at = NULL
          WHERE status = 'running'
        `)
        .run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

    if (message.verifiedCorrectionSource && message.platform === "discord" && message.shouldRespond) {
      this.recordVerifiedCorrectionSource(stored.id, message, timestamp);
    }

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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = now();
      const knownCount = this.db
        .prepare("SELECT COUNT(*) AS count FROM daktela_observations")
        .get() as { count: SqlValue };
      const bootstrap = Number(knownCount.count) === 0;
      const existingByTicket = new Map<string, {
        fingerprint: string;
        externalRevision: string | null;
      }>();
      for (const ticket of tickets) {
        const existing = this.db
          .prepare(`
            SELECT fingerprint, external_revision
            FROM daktela_observations
            WHERE ticket_id = ?
          `)
          .get(ticket.ticketId) as
            | { fingerprint: string; external_revision: string | null }
            | undefined;
        if (existing) {
          existingByTicket.set(ticket.ticketId, {
            fingerprint: existing.fingerprint,
            externalRevision: existing.external_revision,
          });
        }
      }
      const nativeReconciledTicketIds = new Set<string>();
      for (const ticket of tickets) {
        const externalRevision = canonicalDaktelaExternalRevision(ticket.edited);
        if (!externalRevision) continue;
        if (this.db
          .prepare(`
            SELECT 1
            FROM native_daktela_context_bindings
            WHERE external_ticket_id = ? AND source_external_revision = ?
            LIMIT 1
          `)
          .get(ticket.ticketId, externalRevision)) {
          nativeReconciledTicketIds.add(ticket.ticketId);
        }
      }
      const candidates = (bootstrap
        ? tickets.filter(
            (ticket) =>
              ticket.stage.toLowerCase() === "open"
              && (!ticket.assignedUser || ticket.assignedUser.toLowerCase() === "system")
              && !nativeReconciledTicketIds.has(ticket.ticketId),
          )
        : tickets.filter((ticket) => {
            const previous = existingByTicket.get(ticket.ticketId);
            return (
              ticket.stage.toLowerCase() === "open"
              && (!previous || fingerprintsDiffer(previous.fingerprint, ticket.fingerprint))
              && !nativeReconciledTicketIds.has(ticket.ticketId)
            );
          }))
        .sort((left, right) =>
          Number(Boolean(left.assignedUser)) - Number(Boolean(right.assignedUser)))
        .slice(0, maxCandidates);
      const selectedTicketIds = new Set(candidates.map((ticket) => ticket.ticketId));

      for (const ticket of tickets) {
        const previous = existingByTicket.get(ticket.ticketId);
        const previousFingerprint = previous?.fingerprint;
        const externalRevision = canonicalDaktelaExternalRevision(ticket.edited);
        const isChanged =
          !previousFingerprint || fingerprintsDiffer(previousFingerprint, ticket.fingerprint);
        const preserveForNextScan =
          !bootstrap &&
          isChanged &&
          ticket.stage.toLowerCase() === "open" &&
          !selectedTicketIds.has(ticket.ticketId)
          && !nativeReconciledTicketIds.has(ticket.ticketId);
        if (!previousFingerprint && preserveForNextScan) continue;
        const storedFingerprint =
          preserveForNextScan && previousFingerprint ? previousFingerprint : ticket.fingerprint;
        const storedExternalRevision = preserveForNextScan
          ? previous?.externalRevision ?? null
          : externalRevision;
        this.db
          .prepare(`
            INSERT INTO daktela_observations(
              ticket_id, fingerprint, latest_seen_fingerprint,
              external_revision, latest_seen_external_revision,
              stage, assigned_user, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticket_id) DO UPDATE SET
              fingerprint = excluded.fingerprint,
              latest_seen_fingerprint = excluded.latest_seen_fingerprint,
              external_revision = excluded.external_revision,
              latest_seen_external_revision = excluded.latest_seen_external_revision,
              stage = excluded.stage,
              assigned_user = excluded.assigned_user,
              last_seen_at = excluded.last_seen_at
          `)
          .run(
            ticket.ticketId,
            storedFingerprint,
            ticket.fingerprint,
            storedExternalRevision,
            externalRevision,
            ticket.stage,
            ticket.assignedUser,
            timestamp,
            timestamp,
          );
      }
      this.db.exec("COMMIT");
      return candidates;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Atomically turns a selected queue row into a real monitor job, unless the exact Daktela
   * revision was reconciled by ML in the meantime. This closes the scan→detail→ingest race.
   */
  enqueueDaktelaMonitorCandidate(
    ticket: DaktelaTicketObservation,
    message: IncomingMessage,
  ): EnqueueDaktelaMonitorCandidateResult {
    const externalRevision = canonicalDaktelaExternalRevision(ticket.edited);
    if (
      message.conversationExternalId !== `daktela-ticket:${ticket.ticketId}`
      || message.authorId !== "daktela-monitor"
      || message.role !== "context"
      || !message.shouldRespond
    ) {
      throw new Error("daktela_monitor_candidate_invalid");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const observation = this.db
        .prepare(`
          SELECT fingerprint, external_revision
          FROM daktela_observations
          WHERE ticket_id = ?
        `)
        .get(ticket.ticketId) as
          | { fingerprint: string; external_revision: string | null }
          | undefined;
      if (
        !observation
        || observation.fingerprint !== ticket.fingerprint
        || observation.external_revision !== externalRevision
      ) {
        this.db.exec("COMMIT");
        return { status: "stale" };
      }
      const nativeMarker = externalRevision
        ? this.db
            .prepare(`
              SELECT 1
              FROM native_daktela_context_bindings
              WHERE external_ticket_id = ? AND source_external_revision = ?
              LIMIT 1
            `)
            .get(ticket.ticketId, externalRevision)
        : undefined;
      if (nativeMarker) {
        this.db.exec("COMMIT");
        return { status: "native_reconciled" };
      }

      const result = this.ingest(message);
      const storedMessage = this.db
        .prepare(`
          SELECT role, author_id, author_name, content
          FROM messages
          WHERE id = ? AND conversation_id = ? AND external_message_id = ?
        `)
        .get(result.messageId, result.conversationId, message.externalMessageId) as
          | { role: string; author_id: string; author_name: string; content: string }
          | undefined;
      if (
        !storedMessage
        || storedMessage.role !== message.role
        || storedMessage.author_id !== message.authorId
        || storedMessage.author_name !== message.authorName
        || storedMessage.content !== message.content
      ) {
        throw new Error("daktela_monitor_candidate_conflict");
      }
      let jobId = result.jobId;
      let queued = result.inserted && jobId !== undefined;
      if (!jobId) {
        const existingJobs = this.db
          .prepare(`
            SELECT id
            FROM jobs
            WHERE conversation_id = ? AND trigger_message_id = ?
              AND platform = 'discord' AND external_message_id = ?
            ORDER BY id
            LIMIT 2
          `)
          .all(result.conversationId, result.messageId, message.externalMessageId) as Array<{
            id: number;
          }>;
        if (existingJobs.length > 1) throw new Error("daktela_monitor_candidate_job_conflict");
        jobId = existingJobs[0]?.id;
        // Recover a legacy crash between message insert and job insert. This is a real worker job,
        // created inside the same transaction as its observation link—not a synthetic marker.
        if (!jobId) {
          const timestamp = now();
          const insertedJob = this.db
            .prepare(`
              INSERT INTO jobs(
                conversation_id, trigger_message_id, platform, channel_id, external_message_id,
                status, created_at
              ) VALUES (?, ?, 'discord', ?, ?, 'pending', ?)
            `)
            .run(
              result.conversationId,
              result.messageId,
              message.channelId,
              message.externalMessageId,
              timestamp,
            );
          jobId = Number(insertedJob.lastInsertRowid);
          this.db
            .prepare("UPDATE jobs SET public_id = ? WHERE id = ?")
            .run(this.publicId("BOK", jobId), jobId);
          queued = true;
        }
      }
      if (!jobId) throw new Error("daktela_monitor_candidate_job_missing");
      const linked = this.db
        .prepare(`
          UPDATE daktela_observations
          SET last_queued_at = ?, last_job_id = ?, last_queued_fingerprint = ?,
              last_queued_external_revision = ?
          WHERE ticket_id = ? AND fingerprint = ? AND external_revision IS ?
        `)
        .run(
          now(),
          jobId,
          ticket.fingerprint,
          externalRevision,
          ticket.ticketId,
          ticket.fingerprint,
          externalRevision,
        );
      if (linked.changes !== 1) throw new Error("daktela_monitor_candidate_stale");
      this.db.exec("COMMIT");
      return {
        status: queued ? "queued" : "duplicate",
        conversationId: result.conversationId,
        messageId: result.messageId,
        jobId,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  linkDaktelaJob(ticketId: string, fingerprint: string, jobId: number): void {
    this.db
      .prepare(`
        UPDATE daktela_observations
        SET last_queued_at = ?, last_job_id = ?, last_queued_fingerprint = ?,
            last_queued_external_revision = external_revision
        WHERE ticket_id = ? AND fingerprint = ?
      `)
      .run(now(), jobId, fingerprint, ticketId, fingerprint);
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
          AND (job_id IS NULL OR job_id < ?)
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

  currentDiscordDeliveryRoutes(
    jobId: number,
  ): Array<{ botMessageId: string; channelId: string }> {
    const rows = this.db
      .prepare(`
        SELECT bot_message_id, channel_id
        FROM discord_delivery_routes
        WHERE job_id = ?
        ORDER BY rowid ASC
      `)
      .all(jobId) as Array<{ bot_message_id: string; channel_id: string }>;
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
      .prepare(`
        SELECT actions.id, actions.kind, actions.status,
               EXISTS(SELECT 1 FROM draft_reviews WHERE action_id = actions.id) AS reviewed
        FROM actions
        WHERE actions.public_id = ?
      `)
      .get(publicId) as
      | { id: number; kind: string; status: string; reviewed: number }
      | undefined;
    if (!row || row.kind !== "reply_customer") return "missing";
    if (row.status !== "proposed" || row.reviewed) return "already_decided";

    const result = this.db
      .prepare(`
        UPDATE actions
        SET status = ?, approved_by = ?, approved_at = ?
        WHERE id = ? AND status = 'proposed'
      `)
      .run(decision, decidedBy, now(), row.id);
    return result.changes > 0 ? "updated" : "already_decided";
  }

  recordDraftAcceptance(
    publicId: string,
    decidedBy: string,
  ): "updated" | "stale" | "missing" | "already_decided" {
    const normalized = publicId.toUpperCase();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(`
          SELECT actions.id, actions.kind, actions.status,
                 EXISTS(SELECT 1 FROM draft_reviews WHERE action_id = actions.id) AS reviewed,
                 jobs.id AS source_job_id, jobs.trigger_message_id,
                 jobs.conversation_id, jobs.external_message_id AS source_external_message_id,
                 conversations.external_id AS conversation_external_id
          FROM actions
          JOIN jobs ON jobs.id = actions.job_id
          JOIN conversations ON conversations.id = jobs.conversation_id
          WHERE actions.public_id = ?
        `)
        .get(normalized) as
        | {
            id: number;
            kind: string;
            status: string;
            reviewed: number;
            source_job_id: number;
            trigger_message_id: number;
            conversation_id: number;
            source_external_message_id: string;
            conversation_external_id: string;
          }
        | undefined;
      if (!row || row.kind !== "reply_customer") {
        this.db.exec("COMMIT");
        return "missing";
      }
      if (row.status !== "proposed" || row.reviewed) {
        this.db.exec("COMMIT");
        return "already_decided";
      }
      const newer = this.db
        .prepare(`
          SELECT
            EXISTS(
              SELECT 1 FROM messages
              WHERE conversation_id = ?
                AND id > ?
                AND role IN ('human', 'context')
            ) AS newer_inbound,
            EXISTS(
              SELECT 1 FROM jobs
              WHERE conversation_id = ? AND id > ?
            ) AS newer_job
        `)
        .get(
          row.conversation_id,
          row.trigger_message_id,
          row.conversation_id,
          row.source_job_id,
        ) as { newer_inbound: number; newer_job: number };
      let stale = Boolean(newer.newer_inbound || newer.newer_job);
      const ticketId = row.conversation_external_id.match(/^daktela-ticket:(\d+)$/)?.[1];
      const sourceFingerprint = row.source_external_message_id
        .match(/^daktela:v\d+:\d+:(.+)$/i)?.[1];
      if (!stale && ticketId && sourceFingerprint) {
        const observation = this.db
          .prepare(`
            SELECT COALESCE(latest_seen_fingerprint, fingerprint) AS latest_seen_fingerprint,
                   last_job_id
            FROM daktela_observations
            WHERE ticket_id = ?
          `)
          .get(ticketId) as
          | { latest_seen_fingerprint: string; last_job_id: number | null }
          | undefined;
        stale = Boolean(
          observation &&
          (!observation.latest_seen_fingerprint.startsWith(sourceFingerprint) ||
            (observation.last_job_id != null && observation.last_job_id > row.source_job_id)),
        );
      }
      if (stale) {
        this.db
          .prepare(`
            UPDATE actions
            SET status = 'rejected', execution_result =
              'Akceptacja draftu odrzucona: pojawił się nowszy kontekst sprawy.'
            WHERE id = ? AND status = 'proposed'
          `)
          .run(row.id);
        this.db.exec("COMMIT");
        return "stale";
      }
      this.db
        .prepare(`
          INSERT INTO draft_reviews(action_id, decision, decided_by, decided_at)
          VALUES (?, 'accepted', ?, ?)
        `)
        .run(row.id, decidedBy, now());
      this.db.exec("COMMIT");
      return "updated";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  completeJob(
    jobId: number,
    output: AgentTurnOutput,
    options: { agentReply?: string; delivery?: JobCompletionDelivery } = {},
  ): string[] {
    const timestamp = now();
    const publicIds: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const jobContext = this.db
        .prepare(`
          SELECT jobs.conversation_id, jobs.trigger_message_id, jobs.channel_id,
                 jobs.external_message_id,
                 messages.role AS trigger_role, messages.author_id AS trigger_author_id,
                 messages.author_name AS trigger_author_name, messages.content AS trigger_content,
                 correction.source_kind AS correction_source_kind,
                 correction.reply_to_bot_message_id,
                 correction.authorization_kind, correction.authorization_id
          FROM jobs
          JOIN messages ON messages.id = jobs.trigger_message_id
          LEFT JOIN verified_correction_sources AS correction
            ON correction.source_message_id = jobs.trigger_message_id
          WHERE jobs.id = ?
        `)
        .get(jobId) as {
          conversation_id: number;
          trigger_message_id: number;
          channel_id: string;
          external_message_id: string;
          trigger_role: "human" | "agent" | "context";
          trigger_author_id: string;
          trigger_author_name: string;
          trigger_content: string;
          correction_source_kind: "reply" | "direct_mention" | null;
          reply_to_bot_message_id: string | null;
          authorization_kind: "allowed_user" | "allowed_role" | null;
          authorization_id: string | null;
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
        let verifiedDerivedIndexProcessed = false;
        for (const rule of output.learnedRules ?? []) {
          const safe = normalizeLearnedRule(rule.situation, rule.instruction);
          if (!safe) continue;
          const verified = Boolean(
            jobContext.correction_source_kind &&
            jobContext.authorization_kind &&
            jobContext.authorization_id,
          );
          if (verified) {
            // One exact human message owns one optional model-derived index. The source was
            // already versioned at ingest; model output can enrich it but can never create,
            // delete, or replace the authoritative source.
            if (verifiedDerivedIndexProcessed) continue;
            verifiedDerivedIndexProcessed = true;
            const replyToBotMessageId = jobContext.reply_to_bot_message_id || null;
            const correction = this.db
              .prepare(`
                SELECT source_revision, derived_situation, derived_instruction
                FROM verified_correction_sources
                WHERE source_message_id = ?
              `)
              .get(jobContext.trigger_message_id) as
              | {
                  source_revision: number | null;
                  derived_situation: string | null;
                  derived_instruction: string | null;
                }
              | undefined;
            if (!correction?.source_revision) {
              throw new Error("verified_correction_source_unversioned");
            }
            let correctionSnapshotRevision = (
              this.db
                .prepare("SELECT revision FROM verified_correction_state WHERE singleton = 1")
                .get() as { revision: number }
            ).revision;
            if (
              correction.derived_situation !== safe.situation ||
              correction.derived_instruction !== safe.instruction
            ) {
              this.db
                .prepare("UPDATE verified_correction_state SET revision = revision + 1 WHERE singleton = 1")
                .run();
              const state = this.db
                .prepare("SELECT revision FROM verified_correction_state WHERE singleton = 1")
                .get() as { revision: number };
              correctionSnapshotRevision = state.revision;
              this.db
                .prepare(`
                  UPDATE verified_correction_sources
                  SET derived_situation = ?, derived_instruction = ?, updated_at = ?
                  WHERE source_message_id = ?
                `)
                .run(
                  safe.situation,
                  safe.instruction,
                  timestamp,
                  jobContext.trigger_message_id,
                );
            }
            const existing = this.db
              .prepare(`
                SELECT normalized_key, situation, instruction, source_external_message_id,
                       source_content, source_author_id, source_author_name, source_channel_id,
                       correction_source_kind, reply_to_bot_message_id,
                       authorization_kind, authorization_id
                FROM learned_rules
                WHERE normalized_key = ? OR source_external_message_id = ?
                ORDER BY source_external_message_id = ? DESC
                LIMIT 1
              `)
              .get(safe.key, jobContext.external_message_id, jobContext.external_message_id) as
              | Record<string, string | null>
              | undefined;
            const unchanged = existing &&
              existing.normalized_key === safe.key &&
              existing.situation === safe.situation &&
              existing.instruction === safe.instruction &&
              existing.source_external_message_id === jobContext.external_message_id &&
              existing.source_content === jobContext.trigger_content &&
              existing.source_author_id === jobContext.trigger_author_id &&
              existing.source_author_name === jobContext.trigger_author_name &&
              existing.source_channel_id === jobContext.channel_id &&
              existing.correction_source_kind === jobContext.correction_source_kind &&
              existing.reply_to_bot_message_id === replyToBotMessageId &&
              existing.authorization_kind === jobContext.authorization_kind &&
              existing.authorization_id === jobContext.authorization_id;
            if (unchanged) continue;
            this.db
              .prepare(`
                DELETE FROM learned_rules
                WHERE source_external_message_id = ? AND normalized_key <> ?
              `)
              .run(jobContext.external_message_id, safe.key);
            this.db
              .prepare(`
                INSERT INTO learned_rules(
                  normalized_key, situation, instruction, source_conversation_id,
                  source_message_id, created_at, updated_at, verified_revision,
                  source_content, source_author_id, source_author_name,
                  source_external_message_id, source_channel_id, reply_to_bot_message_id,
                  correction_source_kind, authorization_kind, authorization_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(normalized_key) DO UPDATE SET
                  situation = excluded.situation,
                  instruction = excluded.instruction,
                  source_conversation_id = excluded.source_conversation_id,
                  source_message_id = excluded.source_message_id,
                  updated_at = excluded.updated_at,
                  verified_revision = excluded.verified_revision,
                  source_content = excluded.source_content,
                  source_author_id = excluded.source_author_id,
                  source_author_name = excluded.source_author_name,
                  source_external_message_id = excluded.source_external_message_id,
                  source_channel_id = excluded.source_channel_id,
                  correction_source_kind = excluded.correction_source_kind,
                  reply_to_bot_message_id = excluded.reply_to_bot_message_id,
                  authorization_kind = excluded.authorization_kind,
                  authorization_id = excluded.authorization_id
              `)
              .run(
                safe.key, safe.situation, safe.instruction,
                jobContext.conversation_id, jobContext.trigger_message_id,
                timestamp, timestamp, correctionSnapshotRevision, jobContext.trigger_content,
                jobContext.trigger_author_id, jobContext.trigger_author_name,
                jobContext.external_message_id, jobContext.channel_id,
                replyToBotMessageId, jobContext.correction_source_kind,
                jobContext.authorization_kind,
                jobContext.authorization_id,
              );
            continue;
          }
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
              WHERE learned_rules.verified_revision IS NULL
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
      if (options.agentReply != null) {
        this.db
          .prepare(`
            INSERT INTO messages(
              conversation_id, external_message_id, role, author_id, author_name, content, created_at
            ) VALUES (?, ?, 'agent', 'bok-agent', 'BOK Agent', ?, ?)
            ON CONFLICT(conversation_id, external_message_id) DO UPDATE SET
              content = excluded.content,
              created_at = excluded.created_at
          `)
          .run(
            jobContext.conversation_id,
            `agent:${this.publicId("BOK", jobId)}`,
            options.agentReply,
            timestamp,
          );
      }
      if (options.delivery) {
        this.db
          .prepare(`
            INSERT INTO deliveries(
              job_id, kind, message, action_public_ids, status, created_at
            ) VALUES (?, ?, ?, ?, 'pending', ?)
            ON CONFLICT(job_id) DO NOTHING
          `)
          .run(
            jobId,
            options.delivery.kind,
            options.delivery.message,
            JSON.stringify(publicIds),
            timestamp,
          );
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

  activeVerifiedHumanCorrections(limit = 100): VerifiedHumanCorrectionSnapshot {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("verified_correction_limit_invalid");
    }
    // The native API may read this database from another process. Keep the revision, total and
    // rows in one SQLite read transaction so an arriving Discord correction cannot split them
    // across two different snapshots.
    this.db.exec("BEGIN");
    try {
      const state = this.db
        .prepare("SELECT revision FROM verified_correction_state WHERE singleton = 1")
        .get() as { revision: number };
      const count = this.db
        .prepare("SELECT COUNT(*) AS total FROM verified_correction_sources")
        .get() as { total: number };
      const rows = this.db
        .prepare(`
          SELECT correction.source_message_id AS id,
                 correction.derived_situation, correction.derived_instruction,
                 correction.created_at, COALESCE(correction.updated_at, correction.created_at) AS updated_at,
                 correction.source_revision, messages.content AS source_content,
                 messages.author_id AS source_author_id, messages.author_name AS source_author_name,
                 correction.source_external_message_id, correction.source_channel_id,
                 correction.source_kind AS correction_source_kind,
                 correction.reply_to_bot_message_id,
                 correction.authorization_kind, correction.authorization_id
          FROM verified_correction_sources AS correction
          JOIN messages ON messages.id = correction.source_message_id
          WHERE correction.source_revision IS NOT NULL
          ORDER BY correction.source_revision DESC, correction.source_message_id DESC
          LIMIT ?
        `)
        .all(limit) as Array<{
          id: number;
          derived_situation: string | null;
          derived_instruction: string | null;
          created_at: string;
          updated_at: string;
          source_revision: number;
          source_content: string;
          source_author_id: string;
          source_author_name: string;
          source_external_message_id: string;
          source_channel_id: string;
          correction_source_kind: "reply" | "direct_mention";
          reply_to_bot_message_id: string | null;
          authorization_kind: "allowed_user" | "allowed_role";
          authorization_id: string;
        }>;
      const corrections = rows.map((row): StoredVerifiedHumanCorrection => ({
        id: row.id,
        derivedSituation: row.derived_situation,
        derivedInstruction: row.derived_instruction,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        sourceRevision: row.source_revision,
        sourceContent: row.source_content,
        sourceAuthorId: row.source_author_id,
        sourceAuthorName: row.source_author_name,
        sourceExternalMessageId: row.source_external_message_id,
        sourceChannelId: row.source_channel_id,
        sourceKind: row.correction_source_kind,
        replyToBotMessageId: row.reply_to_bot_message_id || null,
        authorizationKind: row.authorization_kind,
        authorizationId: row.authorization_id,
      }));
      this.db.exec("COMMIT");
      return {
        revision: state.revision,
        total: count.total,
        truncated: corrections.length !== count.total,
        corrections,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimNextDelivery(): ClaimedDelivery | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(`
          SELECT deliveries.id AS delivery_id, deliveries.kind, deliveries.message,
                 deliveries.action_public_ids, deliveries.attempts AS delivery_attempts,
                 jobs.id AS job_id, jobs.public_id AS job_public_id, jobs.conversation_id,
                 jobs.trigger_message_id, jobs.platform, jobs.channel_id,
                 jobs.external_message_id, jobs.attempts AS job_attempts
          FROM deliveries
          JOIN jobs ON jobs.id = deliveries.job_id
          WHERE deliveries.status = 'pending'
            AND (deliveries.next_attempt_at IS NULL OR deliveries.next_attempt_at <= ?)
            AND NOT EXISTS (
              SELECT 1
              FROM deliveries AS earlier_deliveries
              JOIN jobs AS earlier_jobs ON earlier_jobs.id = earlier_deliveries.job_id
              WHERE earlier_jobs.conversation_id = jobs.conversation_id
                AND earlier_deliveries.id < deliveries.id
                AND earlier_deliveries.status IN ('pending', 'running')
            )
          ORDER BY deliveries.id
          LIMIT 1
        `)
        .get(now()) as
        | {
            delivery_id: number;
            kind: "message" | "discard";
            message: string;
            action_public_ids: string;
            delivery_attempts: number;
            job_id: number;
            job_public_id: string;
            conversation_id: number;
            trigger_message_id: number;
            platform: "discord" | "local";
            channel_id: string;
            external_message_id: string;
            job_attempts: number;
          }
        | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare(`
          UPDATE deliveries
          SET status = 'running', attempts = attempts + 1, started_at = ?,
              next_attempt_at = NULL, error = NULL
          WHERE id = ? AND status = 'pending'
        `)
        .run(now(), row.delivery_id);
      this.db.exec("COMMIT");
      const actionIds = parsePublicIdList(row.action_public_ids);
      return {
        id: row.delivery_id,
        kind: row.kind,
        message: row.message,
        attempts: row.delivery_attempts + 1,
        actions: this.getActions(actionIds),
        job: {
          id: row.job_id,
          publicId: row.job_public_id,
          conversationId: row.conversation_id,
          triggerMessageId: row.trigger_message_id,
          platform: row.platform,
          channelId: row.channel_id,
          externalMessageId: row.external_message_id,
          attempts: row.job_attempts,
        },
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeDelivery(deliveryId: number): void {
    this.db
      .prepare(`
        UPDATE deliveries
        SET status = 'completed', completed_at = ?, next_attempt_at = NULL, error = NULL
        WHERE id = ? AND status = 'running'
      `)
      .run(now(), deliveryId);
  }

  requeueRunningDelivery(deliveryId: number, nextAttemptAt: string | null = null): void {
    this.db
      .prepare(`
        UPDATE deliveries
        SET status = 'pending', started_at = NULL, error = NULL, next_attempt_at = ?
        WHERE id = ? AND status = 'running'
      `)
      .run(nextAttemptAt, deliveryId);
  }

  failDelivery(deliveryId: number, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.db
      .prepare(`
        UPDATE deliveries
        SET status = 'failed', completed_at = ?, next_attempt_at = NULL, error = ?
        WHERE id = ? AND status = 'running'
      `)
      .run(now(), detail.slice(0, 4000), deliveryId);
  }

  redriveDelivery(deliveryId: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE deliveries
        SET status = 'pending', started_at = NULL, completed_at = NULL,
            next_attempt_at = NULL, error = NULL
        WHERE id = ? AND status IN ('pending', 'failed')
      `)
      .run(deliveryId);
    return result.changes > 0;
  }

  failJobWithDelivery(jobId: number, error: unknown, delivery: JobCompletionDelivery): void {
    const detail = error instanceof Error ? error.message : String(error);
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?")
        .run(timestamp, detail.slice(0, 4000), jobId);
      this.db
        .prepare(`
          INSERT INTO deliveries(
            job_id, kind, message, action_public_ids, status, created_at
          ) VALUES (?, ?, ?, '[]', 'pending', ?)
          ON CONFLICT(job_id) DO NOTHING
        `)
        .run(jobId, delivery.kind, delivery.message, timestamp);
      this.db.exec("COMMIT");
    } catch (failure) {
      this.db.exec("ROLLBACK");
      throw failure;
    }
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
  ): ApproveActionAndEnqueueResult {
    const normalized = publicId.toUpperCase();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(`
          SELECT actions.id, actions.public_id, actions.kind, actions.summary, actions.target,
                 actions.payload, actions.reason, actions.risk, actions.status,
                 jobs.id AS source_job_id, jobs.conversation_id, jobs.trigger_message_id,
                 jobs.external_message_id AS source_external_message_id, jobs.platform,
                 conversations.external_id AS conversation_external_id,
                 EXISTS(SELECT 1 FROM draft_reviews WHERE action_id = actions.id) AS reviewed
          FROM actions
          JOIN jobs ON jobs.id = actions.job_id
          JOIN conversations ON conversations.id = jobs.conversation_id
          WHERE actions.public_id = ?
        `)
        .get(normalized) as
        | (StoredAction & {
            status: "proposed" | "approved" | "rejected" | "executed" | "failed";
            source_job_id: number;
            conversation_id: number;
            trigger_message_id: number;
            source_external_message_id: string;
            conversation_external_id: string;
            reviewed: number;
            platform: "discord" | "local";
          })
        | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return { status: "missing" };
      }
      if (row.status !== "proposed" || row.reviewed) {
        this.db.exec("COMMIT");
        return { status: "already_decided" };
      }

      const newer = this.db
        .prepare(`
          SELECT
            EXISTS(
              SELECT 1
              FROM messages
              WHERE conversation_id = ?
                AND id > ?
                AND role IN ('human', 'context')
            ) AS newer_inbound,
            EXISTS(
              SELECT 1
              FROM jobs
              WHERE conversation_id = ? AND id > ?
            ) AS newer_job,
            EXISTS(
              SELECT 1
              FROM actions AS newer_actions
              JOIN jobs AS newer_action_jobs ON newer_action_jobs.id = newer_actions.job_id
              WHERE newer_action_jobs.conversation_id = ? AND newer_action_jobs.id > ?
            ) AS newer_revision
        `)
        .get(
          row.conversation_id,
          row.trigger_message_id,
          row.conversation_id,
          row.source_job_id,
          row.conversation_id,
          row.source_job_id,
        ) as { newer_inbound: number; newer_job: number; newer_revision: number };

      let daktelaRevision = false;
      const ticketId = row.conversation_external_id.match(/^daktela-ticket:(\d+)$/)?.[1];
      const sourceFingerprint = row.source_external_message_id
        .match(/^daktela:v\d+:\d+:(.+)$/i)?.[1];
      if (ticketId && sourceFingerprint) {
        const observation = this.db
          .prepare(`
            SELECT COALESCE(latest_seen_fingerprint, fingerprint) AS latest_seen_fingerprint,
                   last_job_id
            FROM daktela_observations
            WHERE ticket_id = ?
          `)
          .get(ticketId) as
          | { latest_seen_fingerprint: string; last_job_id: number | null }
          | undefined;
        daktelaRevision = Boolean(
          observation &&
          (!observation.latest_seen_fingerprint.startsWith(sourceFingerprint) ||
            (observation.last_job_id != null && observation.last_job_id > row.source_job_id)),
        );
      }

      if (newer.newer_inbound || newer.newer_job || newer.newer_revision || daktelaRevision) {
        this.db
          .prepare(`
            UPDATE actions
            SET status = 'rejected', approved_by = ?, approved_at = ?,
                execution_result = 'Zatwierdzenie odrzucone: po przygotowaniu draftu pojawił się nowszy kontekst sprawy.'
            WHERE id = ? AND status = 'proposed'
          `)
          .run(approverId, now(), row.id);
        this.db.exec("COMMIT");
        return { status: "stale" };
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
      return { status: "queued", jobPublicId };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  assertApprovedActionFresh(executionJobId: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    let stale = false;
    try {
      const row = this.db
        .prepare(`
          SELECT execution_jobs.id AS execution_job_id,
                 execution_jobs.trigger_message_id AS approval_message_id,
                 execution_jobs.conversation_id,
                 actions.status AS action_status,
                 source_jobs.id AS source_job_id,
                 source_jobs.external_message_id AS source_external_message_id,
                 conversations.external_id AS conversation_external_id
          FROM jobs AS execution_jobs
          JOIN actions ON actions.id = execution_jobs.approved_action_id
          JOIN jobs AS source_jobs ON source_jobs.id = actions.job_id
          JOIN conversations ON conversations.id = execution_jobs.conversation_id
          WHERE execution_jobs.id = ?
        `)
        .get(executionJobId) as
        | {
            execution_job_id: number;
            approval_message_id: number;
            conversation_id: number;
            action_status: string;
            source_job_id: number;
            source_external_message_id: string;
            conversation_external_id: string;
          }
        | undefined;
      if (!row || row.action_status !== "approved") {
        stale = true;
      } else {
        const newer = this.db
          .prepare(`
            SELECT
              EXISTS(
                SELECT 1 FROM messages
                WHERE conversation_id = ?
                  AND id > ?
                  AND role IN ('human', 'context')
              ) AS newer_inbound,
              EXISTS(
                SELECT 1 FROM jobs
                WHERE conversation_id = ?
                  AND id > ?
                  AND approved_action_id IS NULL
              ) AS newer_job
          `)
          .get(
            row.conversation_id,
            row.approval_message_id,
            row.conversation_id,
            row.execution_job_id,
          ) as { newer_inbound: number; newer_job: number };
        stale = Boolean(newer.newer_inbound || newer.newer_job);

        const ticketId = row.conversation_external_id.match(/^daktela-ticket:(\d+)$/)?.[1];
        const sourceFingerprint = row.source_external_message_id
          .match(/^daktela:v\d+:\d+:(.+)$/i)?.[1];
        if (!stale && ticketId && sourceFingerprint) {
          const observation = this.db
            .prepare(`
              SELECT COALESCE(latest_seen_fingerprint, fingerprint) AS latest_seen_fingerprint,
                     last_job_id
              FROM daktela_observations
              WHERE ticket_id = ?
            `)
            .get(ticketId) as
            | { latest_seen_fingerprint: string; last_job_id: number | null }
            | undefined;
          stale = Boolean(
            observation &&
            (!observation.latest_seen_fingerprint.startsWith(sourceFingerprint) ||
              (observation.last_job_id != null && observation.last_job_id > row.source_job_id)),
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (stale) {
      throw new Error(
        "Zablokowano nieaktualne zatwierdzenie: po akceptacji pojawiła się nowsza wiadomość, analiza lub rewizja ticketu.",
      );
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
    for (const table of [
      "conversations",
      "messages",
      "daktela_observations",
      "learned_rules",
      "deliveries",
      "draft_reviews",
    ] as const) {
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
    const deliveries = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status")
      .all() as Array<{ status: string; count: SqlValue }>;
    for (const row of deliveries) result[`deliveries_${row.status}`] = Number(row.count);
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

function parsePublicIdList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
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
