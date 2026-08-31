import { createHash } from "node:crypto";
import process from "node:process";
import { chromium, type Page } from "playwright-core";
import { loadConfig } from "../src/config.js";
import {
  buildTicketTask,
  type DaktelaActivitySnapshot,
} from "../src/daktela-monitor.js";
import { daktelaConversationKey } from "../src/discord.js";
import { AgentStore, type DaktelaTicketObservation } from "../src/store.js";

interface RawRow {
  ticketId: string;
  title: string;
  category: string;
  assignedUser: string;
  stage: string;
  edited: string;
  editedBy: string;
}

const cliArgs = process.argv.slice(2);
const ticketsFlagIndex = cliArgs.indexOf("--tickets");
const requestedTicketIds = ticketsFlagIndex >= 0
  ? parseTicketIds(cliArgs[ticketsFlagIndex + 1] ?? "")
  : undefined;
const positionalArgs = ticketsFlagIndex >= 0
  ? cliArgs.filter((_, index) => index !== ticketsFlagIndex && index !== ticketsFlagIndex + 1)
  : cliArgs;
const count = requestedTicketIds?.length ?? Number.parseInt(positionalArgs[0] ?? "10", 10);
if (!Number.isInteger(count) || count < 1 || count > 25) {
  throw new Error("Liczba ticketów musi być z zakresu 1–25.");
}

const config = loadConfig();
const viewUrl = positionalArgs[1] ?? config.daktelaViewUrl;
if (!viewUrl || !config.daktelaEscalationChannelId) {
  throw new Error("Brak URL widoku Dakteli albo kanału docelowego.");
}

const browser = await chromium.connectOverCDP(config.daktelaBrowserCdpUrl);
const context = browser.contexts()[0];
if (!context) throw new Error("Chrome Agent nie udostępnił kontekstu.");
const page = await context.newPage();
const store = new AgentStore(config.stateDir);

try {
  const rows = requestedTicketIds
    ? requestedTicketIds.map((ticketId) => ({
        ticketId,
        title: `Ticket #${ticketId}`,
        category: "",
        assignedUser: "",
        stage: "Open",
        edited: "",
        editedBy: "",
      }))
    : await readLatestRows(page, viewUrl, count);

  const batchId = new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14);
  const queued: Array<{ ticketId: string; jobId: number }> = [];
  for (const [index, row] of rows.entries()) {
    const ticket = normalize(row, viewUrl);
    let activities: DaktelaActivitySnapshot[] = [];
    let detailError: string | undefined;
    try {
      activities = await readActivities(page, ticket.url);
      if (requestedTicketIds) ticket.title = cleanTicketTitle(await page.title(), ticket.ticketId);
    } catch (error) {
      detailError = error instanceof Error ? error.message : String(error);
    }
    const externalMessageId = `daktela:e2e:v6:${batchId}:${ticket.ticketId}`;
    const task = [
      `[TEST E2E ${index + 1}/${count} — bez wysyłki i bez zapisu]`,
      "To jest live test na rzeczywistym tickecie. Zachowuj się jak samodzielny pracownik BOK.",
      "Jeżeli klient powinien dostać wiadomość, przygotuj najlepszy bezpieczny reply_customer. Jeśli potrzebne jest działanie człowieka, napisz tylko co konkretnie trzeba zrobić.",
      "Jeżeli ticket jest automatem, spamem lub nie wymaga reakcji, zakończ go po cichu. Nie publikuj niczego na Discordzie.",
      buildTicketTask(ticket, activities, detailError),
    ].join("\n\n");
    const result = store.ingest({
      platform: "discord",
      conversationExternalId: daktelaConversationKey(ticket.ticketId),
      externalMessageId,
      channelId: config.daktelaEscalationChannelId,
      authorId: "daktela-e2e",
      authorName: "Test E2E Daktela",
      content: task,
      createdAt: new Date().toISOString(),
      shouldRespond: true,
      role: "context",
    });
    if (result.inserted && result.jobId) queued.push({ ticketId: ticket.ticketId, jobId: result.jobId });
  }
  console.log(JSON.stringify({ batchId, queued }));
} finally {
  store.close();
  await page.close().catch(() => undefined);
}

// Połączenie CDP nie ma publicznego `disconnect`; zamykamy tylko naszą kartę, nie Chrome użytkownika.
process.exit(0);

function parseTicketIds(value: string): string[] {
  const ticketIds = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (ticketIds.length < 1 || ticketIds.length > 25 || ticketIds.some((id) => !/^\d+$/.test(id))) {
    throw new Error("--tickets wymaga od 1 do 25 numerów oddzielonych przecinkami.");
  }
  return ticketIds;
}

async function readLatestRows(page: Page, viewUrl: string, count: number): Promise<RawRow[]> {
  await page.goto(viewUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  if (/\/login\/?(?:#.*)?$/.test(new URL(page.url()).pathname)) {
    throw new Error("Daktela wymaga ponownego zalogowania.");
  }
  await waitForGrid(page);
  const rows = (await readRows(page)).slice(0, count);
  if (rows.length !== count) {
    throw new Error(`Widok zwrócił tylko ${rows.length} z wymaganych ${count} ticketów.`);
  }
  return rows;
}

function cleanTicketTitle(value: string, ticketId: string): string {
  return value
    .replace(new RegExp(`^\\(#${ticketId}\\)\\s*-\\s*`), "")
    .replace(/…$/, "")
    .trim()
    .slice(0, 500) || `Ticket #${ticketId}`;
}

async function waitForGrid(page: Page): Promise<void> {
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
}

async function readRows(page: Page): Promise<RawRow[]> {
  return page.evaluate(() => {
    const root = globalThis as unknown as Record<string, unknown>;
    const jq = (root.jQuery ?? root.$) as
      | ((selector: string) => { data(name: string): unknown })
      | undefined;
    const grid = jq?.("#ticketsGrid").data("kendoGrid") as
      | { dataSource?: { view?: () => unknown[] } }
      | undefined;
    const text = (value: unknown): string =>
      typeof value === "string" || typeof value === "number" ? String(value) : "";
    const titled = (value: unknown): string => {
      if (!value || typeof value !== "object") return text(value);
      const record = value as Record<string, unknown>;
      return text(record.title) || text(record.name);
    };
    return (grid?.dataSource?.view?.() ?? []).map((value) => {
      const record = value as Record<string, unknown>;
      const rawEdited = record.edited;
      return {
        ticketId: text(record.name) || text(record.id),
        title: text(record.title),
        category: titled(record.category),
        assignedUser: titled(record.user),
        stage: text(record.stage),
        edited: rawEdited instanceof Date ? rawEdited.toISOString() : text(rawEdited),
        editedBy: titled(record.edited_by) || titled(record.last_activity_operator),
      };
    });
  });
}

function normalize(row: RawRow, baseUrl: string): DaktelaTicketObservation {
  const stage = row.stage.toUpperCase() === "OPEN" ? "Open" : row.stage;
  const url = new URL(`/tickets/update/${row.ticketId}`, baseUrl).toString();
  const fingerprint = createHash("sha256")
    .update(Object.values(row).join("\u001f"))
    .digest("hex");
  return {
    ticketId: row.ticketId,
    title: row.title.slice(0, 500),
    category: row.category.slice(0, 200),
    assignedUser: row.assignedUser.slice(0, 200),
    status: "",
    stage,
    edited: row.edited.slice(0, 100),
    editedBy: row.editedBy.slice(0, 200),
    url,
    fingerprint,
  };
}

async function readActivities(page: Page, url: string): Promise<DaktelaActivitySnapshot[]> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForSelector("text=Ticket detail", { state: "attached", timeout: 20_000 });
  const activities = await page.locator(".card.hd-activity").evaluateAll((cards) =>
    cards.map((card) => ({
      direction: card.querySelector(".activity-in")
        ? ("incoming" as const)
        : card.querySelector(".activity-out")
          ? ("outgoing" as const)
          : ("other" as const),
      text: (card.textContent ?? "").trim().replace(/\s+/g, " "),
    })),
  );
  return activities.slice(0, 8).map((activity) => ({
    direction: activity.direction,
    text: redact(activity.text).slice(0, 6_000),
  }));
}

function redact(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[e-mail ukryty]")
    .replace(/\+\d(?:[\s().-]?\d){8,14}/g, "[telefon ukryty]")
    .replace(/\b\d{3}[\s.-]\d{3}[\s.-]\d{3}\b/g, "[telefon ukryty]");
}
