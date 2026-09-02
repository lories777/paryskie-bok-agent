import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  TICKET_TEAM_ESCALATION_DESTINATIONS,
  type TicketTeamEscalationDestination,
} from "./native-bok-operational-catalog.js";

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => value?.trim().toLowerCase() === "true");

const csvFromEnv = z
  .string()
  .optional()
  .transform((value) =>
    new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );

const optionalUrlFromEnv = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional(),
);

const optionalSecretFromEnv = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(32).max(4096).optional(),
);

const optionalSnowflakeFromEnv = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().regex(/^[1-9][0-9]{16,21}$/).optional(),
);

const loopbackHost = z
  .enum(["127.0.0.1", "::1"])
  .default("127.0.0.1");

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().optional(),
  BOK_AGENT_COMMAND_CHANNEL_IDS: csvFromEnv,
  BOK_AGENT_OBSERVE_CHANNEL_IDS: csvFromEnv,
  BOK_AGENT_ALLOWED_USER_IDS: csvFromEnv,
  BOK_AGENT_ALLOWED_ROLE_IDS: csvFromEnv,
  BOK_AGENT_APPROVER_USER_IDS: csvFromEnv,
  BOK_AGENT_BROWSER_RESEARCH: booleanFromEnv,
  BOK_AGENT_EXTERNAL_ACTIONS: booleanFromEnv,
  BOK_AGENT_MODEL: z.string().optional(),
  BOK_AGENT_REASONING_EFFORT: z
    .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    .default("medium"),
  BOK_AGENT_WORKSPACE: z.string().default("./agent-workspace"),
  BOK_AGENT_STATE_DIR: z.string().default("./state"),
  BOK_AGENT_MAX_CONTEXT_MESSAGES: z.coerce.number().int().min(5).max(100).default(30),
  BOK_AGENT_MAX_SHARED_CONTEXT_MESSAGES: z.coerce.number().int().min(0).max(200).default(60),
  BOK_AGENT_DISCORD_BACKFILL_MESSAGES: z.coerce.number().int().min(0).max(200).default(50),
  MASTERLINK_REPORT_URL: optionalUrlFromEnv,
  MASTERLINK_REPORT_TOKEN: z.string().optional(),
  MASTERLINK_REPORT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  MASTERLINK_MCP_ENABLED: booleanFromEnv,
  MASTERLINK_MCP_PROJECT_DIR: z.string().optional(),
  MASTERLINK_MCP_ENV_FILE: z.string().optional(),
  DAKTELA_MONITOR_ENABLED: booleanFromEnv,
  DAKTELA_VIEW_URL: optionalUrlFromEnv,
  DAKTELA_BROWSER_CDP_URL: z.string().url().default("http://127.0.0.1:9333"),
  DAKTELA_ESCALATION_CHANNEL_ID: z.string().optional(),
  DAKTELA_POLL_INTERVAL_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(120_000),
  DAKTELA_MAX_TICKETS_PER_SCAN: z.coerce.number().int().min(1).max(5).default(1),
  BOK_NATIVE_API_ENABLED: booleanFromEnv,
  BOK_NATIVE_API_HOST: loopbackHost,
  BOK_NATIVE_API_PORT: z.coerce.number().int().min(1024).max(65_535).default(8787),
  BOK_NATIVE_API_TOKEN: optionalSecretFromEnv,
  BOK_NATIVE_API_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  BOK_NATIVE_API_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(120_000).default(110_000),
  BOK_NATIVE_OPERATIONAL_DISPATCH_ENABLED: booleanFromEnv,
  BOK_NATIVE_DISCORD_GUILD_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_CATEGORY_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_PAYMENTS_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_ALLEGRO_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_COMPLAINTS_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_CURRENT_AFFAIRS_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_RETURNS_UNRECEIVED_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_CANCELLED_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_WHOLESALERS_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_UPSELL_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_PROMO_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_BOK_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_ORIGINALS_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_UNSUBSCRIBE_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_RUFUS_BOK_CHANNEL_ID: optionalSnowflakeFromEnv,
  BOK_NATIVE_DISCORD_BOK_MARKETING_CHANNEL_ID: optionalSnowflakeFromEnv,
});

export interface AppConfig {
  discordToken?: string;
  commandChannelIds: Set<string>;
  observeChannelIds: Set<string>;
  allowedUserIds: Set<string>;
  allowedRoleIds: Set<string>;
  approverUserIds: Set<string>;
  browserResearchEnabled: boolean;
  externalActionsEnabled: boolean;
  model?: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  workspacePath: string;
  stateDir: string;
  maxContextMessages: number;
  maxSharedContextMessages: number;
  discordBackfillMessages: number;
  masterlinkReportUrl?: string;
  masterlinkReportToken?: string;
  masterlinkReportTimeoutMs: number;
  masterlinkMcpEnabled: boolean;
  masterlinkMcpProjectDir: string;
  masterlinkMcpEnvFile: string;
  daktelaMonitorEnabled: boolean;
  daktelaViewUrl?: string;
  daktelaBrowserCdpUrl: string;
  daktelaEscalationChannelId?: string;
  daktelaPollIntervalMs: number;
  daktelaMaxTicketsPerScan: number;
  nativeApiEnabled: boolean;
  nativeApiHost: "127.0.0.1" | "::1";
  nativeApiPort: number;
  nativeApiToken?: string;
  nativeApiMaxConcurrency: number;
  nativeApiTimeoutMs: number;
  nativeOperationalDispatchEnabled: boolean;
  nativeOperationalDiscordGuildId?: string;
  nativeOperationalDiscordCategoryId?: string;
  nativeOperationalDiscordChannelIds: ReadonlyMap<TicketTeamEscalationDestination, string>;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AppConfig {
  const parsed = envSchema.parse(env);
  const nativeOperationalDiscordChannelIds = new Map<
    TicketTeamEscalationDestination,
    string
  >();
  for (const [destination, channelId] of [
    ["payments", parsed.BOK_NATIVE_DISCORD_PAYMENTS_CHANNEL_ID],
    ["allegro", parsed.BOK_NATIVE_DISCORD_ALLEGRO_CHANNEL_ID],
    ["complaints", parsed.BOK_NATIVE_DISCORD_COMPLAINTS_CHANNEL_ID],
    ["current_affairs", parsed.BOK_NATIVE_DISCORD_CURRENT_AFFAIRS_CHANNEL_ID],
    ["returns_unreceived", parsed.BOK_NATIVE_DISCORD_RETURNS_UNRECEIVED_CHANNEL_ID],
    ["cancelled", parsed.BOK_NATIVE_DISCORD_CANCELLED_CHANNEL_ID],
    ["wholesalers", parsed.BOK_NATIVE_DISCORD_WHOLESALERS_CHANNEL_ID],
    ["upsell", parsed.BOK_NATIVE_DISCORD_UPSELL_CHANNEL_ID],
    ["promo", parsed.BOK_NATIVE_DISCORD_PROMO_CHANNEL_ID],
    ["bok", parsed.BOK_NATIVE_DISCORD_BOK_CHANNEL_ID],
    ["originals", parsed.BOK_NATIVE_DISCORD_ORIGINALS_CHANNEL_ID],
    ["unsubscribe", parsed.BOK_NATIVE_DISCORD_UNSUBSCRIBE_CHANNEL_ID],
    ["rufus_bok", parsed.BOK_NATIVE_DISCORD_RUFUS_BOK_CHANNEL_ID],
    ["bok_marketing", parsed.BOK_NATIVE_DISCORD_BOK_MARKETING_CHANNEL_ID],
  ] as const) {
    if (channelId) nativeOperationalDiscordChannelIds.set(destination, channelId);
  }
  return {
    ...(parsed.DISCORD_BOT_TOKEN ? { discordToken: parsed.DISCORD_BOT_TOKEN } : {}),
    commandChannelIds: parsed.BOK_AGENT_COMMAND_CHANNEL_IDS,
    observeChannelIds: parsed.BOK_AGENT_OBSERVE_CHANNEL_IDS,
    allowedUserIds: parsed.BOK_AGENT_ALLOWED_USER_IDS,
    allowedRoleIds: parsed.BOK_AGENT_ALLOWED_ROLE_IDS,
    approverUserIds: parsed.BOK_AGENT_APPROVER_USER_IDS,
    browserResearchEnabled: parsed.BOK_AGENT_BROWSER_RESEARCH,
    externalActionsEnabled: parsed.BOK_AGENT_EXTERNAL_ACTIONS,
    ...(parsed.BOK_AGENT_MODEL?.trim() ? { model: parsed.BOK_AGENT_MODEL.trim() } : {}),
    reasoningEffort: parsed.BOK_AGENT_REASONING_EFFORT,
    workspacePath: path.resolve(cwd, parsed.BOK_AGENT_WORKSPACE),
    stateDir: path.resolve(cwd, parsed.BOK_AGENT_STATE_DIR),
    maxContextMessages: parsed.BOK_AGENT_MAX_CONTEXT_MESSAGES,
    maxSharedContextMessages: parsed.BOK_AGENT_MAX_SHARED_CONTEXT_MESSAGES,
    discordBackfillMessages: parsed.BOK_AGENT_DISCORD_BACKFILL_MESSAGES,
    ...(parsed.MASTERLINK_REPORT_URL
      ? { masterlinkReportUrl: parsed.MASTERLINK_REPORT_URL }
      : {}),
    ...(parsed.MASTERLINK_REPORT_TOKEN?.trim()
      ? { masterlinkReportToken: parsed.MASTERLINK_REPORT_TOKEN.trim() }
      : {}),
    masterlinkReportTimeoutMs: parsed.MASTERLINK_REPORT_TIMEOUT_MS,
    masterlinkMcpEnabled: parsed.MASTERLINK_MCP_ENABLED,
    masterlinkMcpProjectDir: path.resolve(
      cwd,
      parsed.MASTERLINK_MCP_PROJECT_DIR?.trim() || "connectors/masterlink",
    ),
    masterlinkMcpEnvFile: resolveConfigPath(
      cwd,
      parsed.MASTERLINK_MCP_ENV_FILE?.trim() ||
        path.join(os.homedir(), ".config/paryskie-bok-agent/masterlink.env"),
    ),
    daktelaMonitorEnabled: parsed.DAKTELA_MONITOR_ENABLED,
    ...(parsed.DAKTELA_VIEW_URL ? { daktelaViewUrl: parsed.DAKTELA_VIEW_URL } : {}),
    daktelaBrowserCdpUrl: parsed.DAKTELA_BROWSER_CDP_URL,
    ...(parsed.DAKTELA_ESCALATION_CHANNEL_ID?.trim()
      ? { daktelaEscalationChannelId: parsed.DAKTELA_ESCALATION_CHANNEL_ID.trim() }
      : {}),
    daktelaPollIntervalMs: parsed.DAKTELA_POLL_INTERVAL_MS,
    daktelaMaxTicketsPerScan: parsed.DAKTELA_MAX_TICKETS_PER_SCAN,
    nativeApiEnabled: parsed.BOK_NATIVE_API_ENABLED,
    nativeApiHost: parsed.BOK_NATIVE_API_HOST,
    nativeApiPort: parsed.BOK_NATIVE_API_PORT,
    ...(parsed.BOK_NATIVE_API_TOKEN
      ? { nativeApiToken: parsed.BOK_NATIVE_API_TOKEN }
      : {}),
    nativeApiMaxConcurrency: parsed.BOK_NATIVE_API_MAX_CONCURRENCY,
    nativeApiTimeoutMs: parsed.BOK_NATIVE_API_TIMEOUT_MS,
    nativeOperationalDispatchEnabled: parsed.BOK_NATIVE_OPERATIONAL_DISPATCH_ENABLED,
    ...(parsed.BOK_NATIVE_DISCORD_GUILD_ID
      ? { nativeOperationalDiscordGuildId: parsed.BOK_NATIVE_DISCORD_GUILD_ID }
      : {}),
    ...(parsed.BOK_NATIVE_DISCORD_CATEGORY_ID
      ? { nativeOperationalDiscordCategoryId: parsed.BOK_NATIVE_DISCORD_CATEGORY_ID }
      : {}),
    nativeOperationalDiscordChannelIds,
  };
}

export function nativeOperationalDispatchConfigurationErrors(config: AppConfig): string[] {
  const errors: string[] = [];
  if (!config.externalActionsEnabled) errors.push("BOK_AGENT_EXTERNAL_ACTIONS");
  if (!config.nativeOperationalDiscordGuildId) errors.push("BOK_NATIVE_DISCORD_GUILD_ID");
  if (!config.nativeOperationalDiscordCategoryId) errors.push("BOK_NATIVE_DISCORD_CATEGORY_ID");
  for (const destination of TICKET_TEAM_ESCALATION_DESTINATIONS) {
    if (!config.nativeOperationalDiscordChannelIds.has(destination)) {
      errors.push(`BOK_NATIVE_DISCORD_${destination.toUpperCase()}_CHANNEL_ID`);
    }
  }
  const channelIds = [...config.nativeOperationalDiscordChannelIds.values()];
  if (new Set(channelIds).size !== channelIds.length) {
    errors.push("BOK_NATIVE_DISCORD_*_CHANNEL_ID (duplikat)");
  }
  if (
    config.nativeOperationalDiscordCategoryId &&
    channelIds.includes(config.nativeOperationalDiscordCategoryId)
  ) {
    errors.push("BOK_NATIVE_DISCORD_CATEGORY_ID (kolizja)");
  }
  return errors;
}

export function assertNativeBokApiConfig(config: AppConfig): asserts config is AppConfig & {
  nativeApiToken: string;
} {
  const errors: string[] = [];
  if (!config.nativeApiToken) errors.push("BOK_NATIVE_API_TOKEN");
  if (errors.length > 0) {
    throw new Error(`Brak konfiguracji współdzielonego API BOK: ${errors.join(", ")}`);
  }
}

function resolveConfigPath(cwd: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

export function assertLiveConfig(config: AppConfig): asserts config is AppConfig & {
  discordToken: string;
} {
  const errors: string[] = [];
  if (!config.discordToken) errors.push("DISCORD_BOT_TOKEN");
  if (config.commandChannelIds.size === 0) errors.push("BOK_AGENT_COMMAND_CHANNEL_IDS");
  if (config.allowedUserIds.size === 0 && config.allowedRoleIds.size === 0) {
    errors.push("BOK_AGENT_ALLOWED_USER_IDS lub BOK_AGENT_ALLOWED_ROLE_IDS");
  }
  if (config.daktelaMonitorEnabled && !config.daktelaViewUrl) errors.push("DAKTELA_VIEW_URL");
  if (config.daktelaMonitorEnabled && !config.daktelaEscalationChannelId) {
    errors.push("DAKTELA_ESCALATION_CHANNEL_ID");
  }
  if (config.nativeApiEnabled) {
    try {
      assertNativeBokApiConfig(config);
    } catch {
      errors.push("BOK_NATIVE_API_TOKEN");
    }
  }
  if (config.nativeOperationalDispatchEnabled) {
    errors.push(...nativeOperationalDispatchConfigurationErrors(config));
  }
  if (errors.length > 0) {
    throw new Error(`Brak wymaganej konfiguracji trybu live: ${errors.join(", ")}`);
  }
}
