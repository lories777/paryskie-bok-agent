import os from "node:os";
import path from "node:path";
import { z } from "zod";

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

const optionalPathFromEnv = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
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
  BOK_NATIVE_API_HOST: loopbackHost,
  BOK_NATIVE_API_PORT: z.coerce.number().int().min(1024).max(65_535).default(8787),
  BOK_NATIVE_API_TOKEN: optionalSecretFromEnv,
  BOK_NATIVE_API_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  BOK_NATIVE_API_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(120_000).default(110_000),
  BOK_NATIVE_API_GENERATOR_MODEL: z.string().trim().min(1).max(200).optional(),
  BOK_NATIVE_API_JUDGE_MODEL: z.string().trim().min(1).max(200).optional(),
  BOK_NATIVE_CODEX_HOME: optionalPathFromEnv,
});

export interface AppConfig {
  discordToken?: string;
  commandChannelIds: Set<string>;
  observeChannelIds: Set<string>;
  allowedUserIds: Set<string>;
  allowedRoleIds: Set<string>;
  approverUserIds: Set<string>;
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
  nativeApiHost: "127.0.0.1" | "::1";
  nativeApiPort: number;
  nativeApiToken?: string;
  nativeApiMaxConcurrency: number;
  nativeApiTimeoutMs: number;
  nativeApiGeneratorModel?: string;
  nativeApiJudgeModel?: string;
  nativeCodexHome?: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    ...(parsed.DISCORD_BOT_TOKEN ? { discordToken: parsed.DISCORD_BOT_TOKEN } : {}),
    commandChannelIds: parsed.BOK_AGENT_COMMAND_CHANNEL_IDS,
    observeChannelIds: parsed.BOK_AGENT_OBSERVE_CHANNEL_IDS,
    allowedUserIds: parsed.BOK_AGENT_ALLOWED_USER_IDS,
    allowedRoleIds: parsed.BOK_AGENT_ALLOWED_ROLE_IDS,
    approverUserIds: parsed.BOK_AGENT_APPROVER_USER_IDS,
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
    nativeApiHost: parsed.BOK_NATIVE_API_HOST,
    nativeApiPort: parsed.BOK_NATIVE_API_PORT,
    ...(parsed.BOK_NATIVE_API_TOKEN
      ? { nativeApiToken: parsed.BOK_NATIVE_API_TOKEN }
      : {}),
    nativeApiMaxConcurrency: parsed.BOK_NATIVE_API_MAX_CONCURRENCY,
    nativeApiTimeoutMs: parsed.BOK_NATIVE_API_TIMEOUT_MS,
    ...(parsed.BOK_NATIVE_API_GENERATOR_MODEL
      ? { nativeApiGeneratorModel: parsed.BOK_NATIVE_API_GENERATOR_MODEL }
      : {}),
    ...(parsed.BOK_NATIVE_API_JUDGE_MODEL
      ? { nativeApiJudgeModel: parsed.BOK_NATIVE_API_JUDGE_MODEL }
      : {}),
    ...(parsed.BOK_NATIVE_CODEX_HOME
      ? { nativeCodexHome: resolveConfigPath(cwd, parsed.BOK_NATIVE_CODEX_HOME) }
      : {}),
  };
}

export function assertNativeBokApiConfig(config: AppConfig): asserts config is AppConfig & {
  nativeApiToken: string;
  nativeCodexHome: string;
} {
  const errors: string[] = [];
  if (!config.nativeApiToken) errors.push("BOK_NATIVE_API_TOKEN");
  if (!config.nativeCodexHome) {
    errors.push("BOK_NATIVE_CODEX_HOME");
  } else if (sameFilesystemPath(config.nativeCodexHome, path.join(os.homedir(), ".codex"))) {
    errors.push("BOK_NATIVE_CODEX_HOME musi być odseparowany od ~/.codex");
  }
  if (errors.length > 0) {
    throw new Error(`Brak lub niebezpieczna konfiguracja natywnego API BOK: ${errors.join(", ")}`);
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
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
  if (errors.length > 0) {
    throw new Error(`Brak wymaganej konfiguracji trybu live: ${errors.join(", ")}`);
  }
}
