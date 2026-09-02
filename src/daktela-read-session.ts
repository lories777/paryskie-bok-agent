import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { AppConfig } from "./config.js";
import {
  nativeBokDaktelaDecisionSourceSchema,
  type NativeBokAttachmentSourceItem,
  type NativeBokDaktelaDecisionSource,
} from "./native-bok-attachment-evidence.js";

const API_RESPONSE_LIMIT = 2 * 1024 * 1024;
const NAVIGATION_TIMEOUT_MS = 30_000;
const API_TIMEOUT_MS = 30_000;
const SAFE_FILE_ID = /^\d{1,20}$/;
const SESSION_PAGE_NAME = "paryskie-bok-shared-read-session";

export interface DaktelaSessionCapabilities {
  readonly userType: string;
  readonly profileType: string;
  readonly profileTitle: string;
}

export interface DaktelaQueueRow {
  readonly ticketId: string;
  readonly title: string;
  readonly deadline: string;
  readonly category: string;
  readonly contact: string;
  readonly assignedUser: string;
  readonly status: string;
  readonly stage: string;
  readonly edited: string;
  readonly editedBy: string;
  readonly href: string;
}

export interface DaktelaActivitySummary {
  readonly direction: "incoming" | "outgoing" | "other";
  readonly text: string;
  readonly attachments: readonly string[];
}

interface ExactDaktelaAttachment {
  readonly externalId: string;
  readonly fileName: string;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly inline: boolean;
}

interface ExactDaktelaActivity {
  readonly externalId: string;
  readonly ticketExternalId: string | null;
  readonly queueExternalId: string | null;
  readonly direction: "inbound" | "outbound" | "unknown";
  readonly attachments: readonly ExactDaktelaAttachment[];
}

interface ExactDaktelaTicket {
  readonly externalId: string;
  readonly externalRevision: string | null;
}

export interface DaktelaVerifiedAttachment {
  readonly source: NativeBokAttachmentSourceItem;
  readonly bytes: Uint8Array;
}

export interface DaktelaVerifiedSourceRead {
  readonly source: NativeBokDaktelaDecisionSource;
  readonly attachments: readonly DaktelaVerifiedAttachment[];
}

export interface DaktelaAuthenticatedReadPort {
  verify(viewUrl: string): Promise<DaktelaSessionCapabilities>;
  readQueue(viewUrl: string): Promise<{
    rows: readonly DaktelaQueueRow[];
    capabilities: DaktelaSessionCapabilities;
  }>;
  readTicketActivities(
    viewUrl: string,
    externalTicketId: string,
  ): Promise<readonly DaktelaActivitySummary[]>;
  openExactTicket(viewUrl: string, externalTicketId: string): Promise<ExactDaktelaTicket>;
  readExactActivity(viewUrl: string, externalEventId: string): Promise<ExactDaktelaActivity>;
  downloadExactAttachment(
    viewUrl: string,
    fileId: string,
    fileName: string,
    maximumBytes: number,
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}

export class DaktelaReadSessionError extends Error {
  constructor(readonly code:
    | "daktela_read_not_configured"
    | "daktela_read_session_unverified"
    | "daktela_read_ticket_mismatch"
    | "daktela_read_revision_stale"
    | "daktela_read_event_mismatch"
    | "daktela_read_attachment_mismatch"
    | "daktela_read_attachment_changed"
    | "daktela_read_interrupted"
    | "daktela_read_failed") {
    super(code);
    this.name = "DaktelaReadSessionError";
  }
}

/**
 * Jeden serializowany port do zalogowanego Chrome. Monitor kolejki i natywna analiza
 * nie mogą wzajemnie zmienić strony w trakcie weryfikacji exact ticket/event/file.
 */
export class DaktelaReadSession {
  private tail: Promise<void> = Promise.resolve();
  private verified = false;

  constructor(
    private readonly config: Pick<AppConfig, "daktelaViewUrl" | "daktelaBrowserCdpUrl">,
    private readonly port: DaktelaAuthenticatedReadPort = new ChromeDaktelaReadPort(
      config.daktelaBrowserCdpUrl,
    ),
  ) {}

  configurationReady(): boolean {
    return this.config.daktelaViewUrl !== undefined;
  }

  identityVerified(): boolean {
    return this.verified;
  }

  async verify(): Promise<DaktelaSessionCapabilities> {
    return this.exclusive(async () => {
      try {
        const capabilities = await this.port.verify(this.requiredViewUrl());
        assertSessionCapabilities(capabilities);
        this.verified = true;
        return capabilities;
      } catch (error) {
        this.verified = false;
        throw error;
      }
    });
  }

  async readQueue(): Promise<{
    rows: readonly DaktelaQueueRow[];
    capabilities: DaktelaSessionCapabilities;
  }> {
    return this.exclusive(async () => {
      try {
        const result = await this.port.readQueue(this.requiredViewUrl());
        assertSessionCapabilities(result.capabilities);
        this.verified = true;
        return result;
      } catch (error) {
        this.verified = false;
        throw error;
      }
    });
  }

  async readTicketActivities(
    externalTicketId: string,
  ): Promise<readonly DaktelaActivitySummary[]> {
    assertDaktelaId(externalTicketId);
    return this.exclusive(async () => {
      try {
        const result = await this.port.readTicketActivities(
          this.requiredViewUrl(),
          externalTicketId,
        );
        this.verified = true;
        return result;
      } catch (error) {
        this.verified = false;
        throw error;
      }
    });
  }

  async readExactSource(
    rawSource: unknown,
    signal: AbortSignal,
  ): Promise<DaktelaVerifiedSourceRead> {
    return this.withExactSource(rawSource, signal, async (verified) => verified);
  }

  async withExactSource<T>(
    rawSource: unknown,
    signal: AbortSignal,
    operation: (verified: DaktelaVerifiedSourceRead) => Promise<T>,
  ): Promise<T> {
    const source = nativeBokDaktelaDecisionSourceSchema.parse(rawSource);
    return this.exclusive(async () => {
      let verified: DaktelaVerifiedSourceRead;
      try {
        assertNotAborted(signal);
        const viewUrl = this.requiredViewUrl();
        const ticket = await this.port.openExactTicket(viewUrl, source.externalTicketId);
        assertNotAborted(signal);
        if (ticket.externalId !== source.externalTicketId) {
          throw new DaktelaReadSessionError("daktela_read_ticket_mismatch");
        }
        if (ticket.externalRevision !== source.externalRevision) {
          throw new DaktelaReadSessionError("daktela_read_revision_stale");
        }

        const activities = new Map<string, ExactDaktelaActivity>();
        const eventIds = new Set([
          source.triggerExternalEventId,
          ...source.attachments.map((attachment) => attachment.externalEventId),
        ]);
        for (const externalEventId of eventIds) {
          assertNotAborted(signal);
          const activity = await this.port.readExactActivity(viewUrl, externalEventId);
          assertExactActivity(source, activity, externalEventId);
          assertCompleteAttachmentManifest(source, activity, externalEventId);
          activities.set(externalEventId, activity);
        }

        const attachments: DaktelaVerifiedAttachment[] = [];
        for (const expected of source.attachments) {
          assertNotAborted(signal);
          const activity = activities.get(expected.externalEventId);
          if (!activity) throw new DaktelaReadSessionError("daktela_read_event_mismatch");
          const candidate = activity.attachments.find((attachment) =>
            daktelaMetadataId(attachment.externalId) === expected.attachmentId);
          if (!candidate || !SAFE_FILE_ID.test(candidate.externalId)) {
            throw new DaktelaReadSessionError("daktela_read_attachment_mismatch");
          }
          if (
            candidate.inline
            || candidate.fileName !== expected.fileName
            || normalizedContentType(candidate.contentType) !== expected.contentType
            || candidate.sizeBytes !== expected.sizeBytes
          ) {
            throw new DaktelaReadSessionError("daktela_read_attachment_mismatch");
          }
          const bytes = await this.port.downloadExactAttachment(
            viewUrl,
            candidate.externalId,
            expected.fileName,
            expected.sizeBytes,
          );
          if (
            bytes.byteLength !== expected.sizeBytes
            || sha256(bytes) !== expected.sourceHash
          ) {
            throw new DaktelaReadSessionError("daktela_read_attachment_changed");
          }
          attachments.push({ source: expected, bytes });
        }
        this.verified = true;
        verified = Object.freeze({
          source,
          attachments: Object.freeze(attachments),
        });
      } catch (error) {
        if (error instanceof DaktelaReadSessionError) throw error;
        if (signal.aborted) throw new DaktelaReadSessionError("daktela_read_interrupted");
        this.verified = false;
        throw new DaktelaReadSessionError("daktela_read_failed");
      }
      // Keep the shared page/mutex pinned until both models consume the same bytes. Errors from
      // the model/store are not Daktela identity failures and must retain their original codes.
      return operation(verified);
    });
  }

  async close(): Promise<void> {
    await this.exclusive(async () => {
      this.verified = false;
      await this.port.close();
    });
  }

  private requiredViewUrl(): string {
    if (!this.config.daktelaViewUrl) {
      throw new DaktelaReadSessionError("daktela_read_not_configured");
    }
    return this.config.daktelaViewUrl;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

class ChromeDaktelaReadPort implements DaktelaAuthenticatedReadPort {
  private browser: Browser | undefined;
  private page: Page | undefined;

  constructor(private readonly cdpUrl: string) {}

  async verify(viewUrl: string): Promise<DaktelaSessionCapabilities> {
    const page = await this.exactPage(viewUrl);
    return readSessionCapabilities(page);
  }

  async readQueue(viewUrl: string): Promise<{
    rows: readonly DaktelaQueueRow[];
    capabilities: DaktelaSessionCapabilities;
  }> {
    const page = await this.exactPage(viewUrl);
    await page.waitForFunction(
      () => {
        const root = globalThis as unknown as Record<string, unknown>;
        const jq = (root.jQuery ?? root.$) as
          | ((selector: string) => { data(name: string): unknown })
          | undefined;
        const grid = jq?.("#ticketsGrid").data("kendoGrid") as
          | { dataSource?: { view?: () => unknown[] } }
          | undefined;
        return (grid?.dataSource?.view?.().length ?? 0) > 0;
      },
      undefined,
      { timeout: 20_000 },
    );
    const rows = await page.evaluate(readQueueRowsInPage);
    return { rows, capabilities: await readSessionCapabilities(page) };
  }

  async readTicketActivities(
    viewUrl: string,
    externalTicketId: string,
  ): Promise<readonly DaktelaActivitySummary[]> {
    const page = await this.exactTicketPage(viewUrl, externalTicketId);
    const activities = await page.locator(".card.hd-activity").evaluateAll((cards) =>
      cards.map((card) => ({
        direction: card.querySelector(".activity-in")
          ? ("incoming" as const)
          : card.querySelector(".activity-out")
            ? ("outgoing" as const)
            : ("other" as const),
        text: (card.textContent ?? "").trim().replace(/\s+/g, " "),
        attachments: [...card.querySelectorAll('a[href*="/file/download.php"]')]
          .map((link) =>
            (link.textContent ?? link.getAttribute("title") ?? "").trim().replace(/\s+/g, " "))
          .filter(Boolean),
      })),
    );
    return activities.slice(0, 8);
  }

  async openExactTicket(viewUrl: string, externalTicketId: string): Promise<ExactDaktelaTicket> {
    await this.exactTicketPage(viewUrl, externalTicketId);
    const raw = await this.getJsonDetail(viewUrl, `/api/v6/tickets/${externalTicketId}.json`, [
      "name",
      "edited",
      "last_activity",
      "created",
    ]);
    return {
      externalId: referenceId(raw.name) ?? "",
      externalRevision: dateTime(raw.edited) ?? dateTime(raw.last_activity) ?? dateTime(raw.created),
    };
  }

  async readExactActivity(viewUrl: string, externalEventId: string): Promise<ExactDaktelaActivity> {
    const raw = await this.getJsonDetail(
      viewUrl,
      `/api/v6/activities/${externalEventId}.json`,
      ["name", "ticket", "type", "queue", "item", "attachments", "inlineAttachments"],
    );
    return exactActivity(raw);
  }

  async downloadExactAttachment(
    viewUrl: string,
    fileId: string,
    fileName: string,
    maximumBytes: number,
  ): Promise<Uint8Array> {
    if (!SAFE_FILE_ID.test(fileId)) throw new Error("daktela_file_id_invalid");
    const url = new URL("/file/download.php", viewUrl);
    url.search = new URLSearchParams({
      mapper: "activitiesEmail",
      name: fileId,
      iconHash: fileName,
      download: "1",
      fullsize: "1",
    }).toString();
    const response = await (await this.context()).request.get(url.toString(), {
      headers: { Accept: "application/octet-stream" },
      maxRedirects: 0,
      timeout: API_TIMEOUT_MS,
    });
    try {
      if (!response.ok()) throw new Error("daktela_download_status_invalid");
      const contentType = response.headers()["content-type"] ?? "";
      if (/(?:json|html)/i.test(contentType)) throw new Error("daktela_download_type_invalid");
      const declared = Number(response.headers()["content-length"]);
      if (Number.isFinite(declared) && declared > maximumBytes) {
        throw new Error("daktela_download_too_large");
      }
      const body = await response.body();
      if (body.byteLength < 1 || body.byteLength > maximumBytes) {
        throw new Error("daktela_download_too_large");
      }
      return new Uint8Array(body);
    } finally {
      await response.dispose();
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.page = undefined;
    this.browser = undefined;
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
  }

  private async exactPage(url: string): Promise<Page> {
    const page = await this.namedPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    assertAuthenticatedUrl(page.url());
    return page;
  }

  private async exactTicketPage(viewUrl: string, externalTicketId: string): Promise<Page> {
    assertDaktelaId(externalTicketId);
    const url = new URL(`/tickets/update/${externalTicketId}`, viewUrl);
    const page = await this.exactPage(url.toString());
    const actual = new URL(page.url()).pathname.match(/^\/tickets\/update\/([A-Za-z0-9_]+)\/?$/)?.[1];
    if (actual !== externalTicketId) throw new Error("daktela_ticket_navigation_mismatch");
    await page.waitForSelector("text=Ticket detail", {
      state: "attached",
      timeout: 20_000,
    });
    return page;
  }

  private async getJsonDetail(
    viewUrl: string,
    pathname: string,
    fields: readonly string[],
  ): Promise<Record<string, unknown>> {
    const url = new URL(pathname, viewUrl);
    for (let index = 0; index < fields.length; index += 1) {
      url.searchParams.set(`fields[${index}]`, fields[index]!);
    }
    const response = await (await this.context()).request.get(url.toString(), {
      headers: { Accept: "application/json", "X-TIMEZONE": "UTC" },
      maxRedirects: 0,
      timeout: API_TIMEOUT_MS,
    });
    try {
      if (!response.ok()) throw new Error("daktela_api_status_invalid");
      const declared = Number(response.headers()["content-length"]);
      if (Number.isFinite(declared) && declared > API_RESPONSE_LIMIT) {
        throw new Error("daktela_api_response_too_large");
      }
      const bytes = await response.body();
      if (bytes.byteLength > API_RESPONSE_LIMIT) throw new Error("daktela_api_response_too_large");
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      const envelope = record(parsed);
      if (!envelope || hasApiError(envelope.error)) throw new Error("daktela_api_envelope_invalid");
      const result = record(envelope.result);
      if (!result) throw new Error("daktela_api_result_invalid");
      return result;
    } finally {
      await response.dispose();
    }
  }

  private async context(): Promise<BrowserContext> {
    if (!this.browser?.isConnected()) {
      this.page = undefined;
      const browser = await chromium.connectOverCDP(this.cdpUrl);
      this.browser = browser;
      browser.once("disconnected", () => {
        if (this.browser === browser) {
          this.browser = undefined;
          this.page = undefined;
        }
      });
    }
    const context = this.browser.contexts()[0];
    if (!context) throw new Error("daktela_browser_context_missing");
    return context;
  }

  private async namedPage(): Promise<Page> {
    const context = await this.context();
    if (this.page && !this.page.isClosed()) return this.page;
    for (const page of context.pages()) {
      const currentName = await page
        .evaluate(() => (globalThis as unknown as { name: string }).name)
        .catch(() => "");
      if (currentName === SESSION_PAGE_NAME) {
        this.page = page;
        return page;
      }
    }
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.evaluate((pageName) => {
      (globalThis as unknown as { name: string }).name = pageName;
    }, SESSION_PAGE_NAME);
    this.page = page;
    return page;
  }
}

function assertExactActivity(
  source: NativeBokDaktelaDecisionSource,
  activity: ExactDaktelaActivity,
  externalEventId: string,
): void {
  if (
    activity.externalId !== externalEventId
    || activity.ticketExternalId !== source.externalTicketId
    || activity.queueExternalId !== source.queueExternalId
    || activity.direction !== "inbound"
  ) {
    throw new DaktelaReadSessionError("daktela_read_event_mismatch");
  }
}

function assertCompleteAttachmentManifest(
  source: NativeBokDaktelaDecisionSource,
  activity: ExactDaktelaActivity,
  externalEventId: string,
): void {
  const expected = source.attachments
    .filter((attachment) => attachment.externalEventId === externalEventId)
    .map((attachment) => attachment.attachmentId)
    .sort();
  // Daktela attaches technical text/plain MIME parts for some e-mails. They are not visual
  // customer evidence. Every non-inline PDF/JPEG/PNG is relevant and must be present 1:1.
  const actual = activity.attachments
    .filter((attachment) =>
      !attachment.inline
      && ["application/pdf", "image/jpeg", "image/png"].includes(
        normalizedContentType(attachment.contentType) ?? "",
      ))
    .map((attachment) => daktelaMetadataId(attachment.externalId))
    .sort();
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new DaktelaReadSessionError("daktela_read_attachment_mismatch");
  }
}

function exactActivity(raw: Record<string, unknown>): ExactDaktelaActivity {
  const item = record(raw.item) ?? {};
  const activityQueue = referenceId(raw.queue);
  const itemQueue = referenceId(item.queue);
  if (activityQueue && itemQueue && activityQueue !== itemQueue) {
    throw new Error("daktela_activity_queue_conflict");
  }
  const attachments = [
    ...relationRows(item.attachments).map((value) => exactAttachment(value, false)),
    ...relationRows(raw.attachments).map((value) => exactAttachment(value, false)),
    ...relationRows(item.inlineAttachments).map((value) => exactAttachment(value, true)),
    ...relationRows(raw.inlineAttachments).map((value) => exactAttachment(value, true)),
  ].filter((value): value is ExactDaktelaAttachment => value !== null);
  const unique = new Map<string, ExactDaktelaAttachment>();
  for (const attachment of attachments) {
    const existing = unique.get(attachment.externalId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(attachment)) {
      throw new Error("daktela_attachment_metadata_conflict");
    }
    unique.set(attachment.externalId, attachment);
  }
  const direction = text(item.direction);
  return {
    externalId: referenceId(raw.name) ?? "",
    ticketExternalId: referenceId(raw.ticket),
    queueExternalId: activityQueue ?? itemQueue,
    direction: direction === "in" ? "inbound" : direction === "out" ? "outbound" : "unknown",
    attachments: [...unique.values()],
  };
}

function exactAttachment(value: unknown, forceInline: boolean): ExactDaktelaAttachment | null {
  const file = record(value);
  if (!file) return null;
  const externalId = referenceId(file.file) ?? text(file.path);
  const fileName = text(file.title);
  if (!externalId || !fileName) return null;
  return {
    externalId,
    fileName: fileName.trim(),
    contentType: normalizedContentType(text(file.type)),
    sizeBytes: finiteInteger(file.size),
    inline: forceInline || booleanValue(file.inline),
  };
}

function readQueueRowsInPage(): DaktelaQueueRow[] {
  const root = globalThis as unknown as Record<string, unknown>;
  const jq = (root.jQuery ?? root.$) as
    | ((selector: string) => { data(name: string): unknown })
    | undefined;
  const grid = jq?.("#ticketsGrid").data("kendoGrid") as
    | { dataSource?: { view?: () => unknown[] } }
    | undefined;
  const records = grid?.dataSource?.view?.() ?? [];
  const valueText = (value: unknown): string =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const titled = (value: unknown): string => {
    if (!value || typeof value !== "object") return valueText(value);
    const valueRecord = value as Record<string, unknown>;
    return valueText(valueRecord.title) || valueText(valueRecord.name);
  };
  return records.map((value) => {
    const valueRecord = value as Record<string, unknown>;
    const ticketId = valueText(valueRecord.name) || valueText(valueRecord.id);
    const rawEdited = valueRecord.edited;
    const edited = rawEdited instanceof Date ? rawEdited.toISOString() : valueText(rawEdited);
    const stageCode = valueText(valueRecord.stage).toUpperCase();
    return {
      ticketId,
      title: valueText(valueRecord.title),
      deadline: "",
      category: titled(valueRecord.category),
      contact: "",
      assignedUser: titled(valueRecord.user),
      status: "",
      stage: stageCode === "OPEN" ? "Open" : stageCode === "CLOSE" ? "Closed" : stageCode,
      edited,
      editedBy: titled(valueRecord.edited_by) || titled(valueRecord.last_activity_operator),
      href: ticketId ? `/tickets/update/${ticketId}` : "",
    };
  });
}

async function readSessionCapabilities(page: Page): Promise<DaktelaSessionCapabilities> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v6/whoim.json", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("whoim_status_invalid");
    const json = (await response.json()) as {
      error?: unknown;
      result?: { user?: { type?: string; profile?: { type?: string; title?: string } } };
    };
    const hasError = Array.isArray(json.error)
      ? json.error.length > 0
      : json.error && typeof json.error === "object"
        ? Object.keys(json.error).length > 0
        : Boolean(json.error);
    if (hasError) throw new Error("whoim_envelope_invalid");
    return {
      userType: json.result?.user?.type ?? "",
      profileType: json.result?.user?.profile?.type ?? "",
      profileTitle: json.result?.user?.profile?.title ?? "",
    };
  });
}

function assertAuthenticatedUrl(value: string): void {
  if (/\/login\/?(?:#.*)?$/.test(new URL(value).pathname)) {
    throw new Error("daktela_session_unauthorized");
  }
}

function assertSessionCapabilities(capabilities: DaktelaSessionCapabilities): void {
  if (!capabilities.userType.trim() || !capabilities.profileType.trim()) {
    throw new Error("daktela_session_identity_invalid");
  }
}

function assertDaktelaId(value: string): void {
  if (!/^[A-Za-z0-9_]{1,100}$/.test(value)) {
    throw new DaktelaReadSessionError("daktela_read_ticket_mismatch");
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DaktelaReadSessionError("daktela_read_interrupted");
}

function daktelaMetadataId(externalId: string): string {
  return `daktela-meta:${sha256(externalId)}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedContentType(value: string | null): string | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasApiError(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  const valueRecord = record(value);
  return valueRecord ? Object.keys(valueRecord).length > 0 : true;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function referenceId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const direct = text(value);
  if (direct) return direct;
  const valueRecord = record(value);
  return valueRecord ? referenceId(valueRecord.name) ?? referenceId(valueRecord.id) : null;
}

function relationRows(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  const valueRecord = record(value);
  return valueRecord && Array.isArray(valueRecord.data) ? valueRecord.data : [];
}

function finiteInteger(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function dateTime(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
