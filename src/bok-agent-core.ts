import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Codex, type ModelReasoningEffort, type ThreadOptions } from "@openai/codex-sdk";
import type { AppConfig } from "./config.js";
import { readBokPlaybook } from "./bok-knowledge.js";
import { DEFAULT_NATIVE_BOK_MODEL, SAFE_NATIVE_BOK_MODEL } from "./native-bok-contract.js";
import type { AgentStore } from "./store.js";
import type { StoredMessage } from "./types.js";
import { buildBokKnowledgeContext } from "./bok-knowledge.js";
import { assertCompleteVerifiedCorrectionSnapshot } from "./verified-corrections-prompt.js";

export const CHROME_READ_ONLY_TOOLS = [
  "list_pages",
  "select_page",
  "take_snapshot",
  "take_screenshot",
  "wait_for",
] as const;

/** Jeden obiekt polityki/runtime współdzielony przez ingress Discord/Daktela i ML HTTP. */
export class BokAgentCore {
  readonly playbook: string;
  readonly model: string;

  constructor(
    readonly config: AppConfig,
    readonly store: AgentStore,
  ) {
    this.playbook = readBokPlaybook(config.workspacePath);
    this.model = resolveModel(config.model ?? DEFAULT_NATIVE_BOK_MODEL);
  }

  policySnapshot(messages: StoredMessage[]) {
    const verifiedCorrections = structuredClone(
      this.store.activeVerifiedHumanCorrections(100),
    );
    assertCompleteVerifiedCorrectionSnapshot(verifiedCorrections);
    return {
      playbook: this.playbook,
      untrustedReference: buildBokKnowledgeContext(
        this.config.workspacePath,
        messages,
        this.store.activeLearnedRules(100),
      ),
      verifiedCorrections,
    };
  }

  createPrimaryCodex(masterlinkMcpOverrides: string[] = []): Codex {
    return new Codex({
      configOverrides: buildPrimaryCodexConfigOverrides(
        this.config,
        masterlinkMcpOverrides,
      ),
    });
  }

  createReviewerCodex(): Codex {
    return new Codex({ configOverrides: buildReviewerCodexConfigOverrides() });
  }

  createNativeCodex(): Codex {
    return new Codex({
      configOverrides: buildNativeBokCodexConfigOverrides(this.config),
      env: buildSharedNativeBokCodexEnvironment(),
    });
  }

  primaryThreadOptions(): ThreadOptions {
    return buildPrimaryThreadOptions({ ...this.config, model: this.model });
  }

  reviewerThreadOptions(): ThreadOptions {
    return {
      workingDirectory: this.config.workspacePath,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: this.config.reasoningEffort as ModelReasoningEffort,
      threadSource: "paryskie-bok-draft-reviewer",
      ...resolvedThreadModel(this.model),
    };
  }

  nativeThreadOptions(threadSource: string): ThreadOptions {
    return {
      workingDirectory: this.config.workspacePath,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: this.config.reasoningEffort as ModelReasoningEffort,
      threadSource,
      ...resolvedThreadModel(this.model),
    };
  }
}

export function buildPrimaryThreadOptions(
  config: Pick<AppConfig, "workspacePath" | "reasoningEffort" | "model" | "browserResearchEnabled">,
): ThreadOptions {
  return {
    workingDirectory: config.workspacePath,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    modelReasoningEffort: config.reasoningEffort as ModelReasoningEffort,
    threadSource: "paryskie-bok-agent",
    ...(config.model ? resolvedThreadModel(config.model) : {}),
  };
}

export function buildPrimaryCodexConfigOverrides(
  config: Pick<AppConfig, "browserResearchEnabled">,
  masterlinkMcpOverrides: string[] = [],
): string[] {
  return [
    `mcp_servers.chrome-devtools.enabled=${config.browserResearchEnabled ? "true" : "false"}`,
    ...(config.browserResearchEnabled
      ? [
          "mcp_servers.chrome-devtools.required=true",
          `mcp_servers.chrome-devtools.enabled_tools=${JSON.stringify(CHROME_READ_ONLY_TOOLS)}`,
          'mcp_servers.chrome-devtools.default_tools_approval_mode="approve"',
        ]
      : []),
    ...buildBaseDisabledMcpOverrides(),
    ...masterlinkMcpOverrides,
  ];
}

export function buildReviewerCodexConfigOverrides(): string[] {
  return [
    "mcp_servers.chrome-devtools.enabled=false",
    ...buildBaseDisabledMcpOverrides(),
  ];
}

function buildBaseDisabledMcpOverrides(): string[] {
  return [
    "mcp_servers.desktop-control.enabled=false",
    "mcp_servers.playwright.enabled=false",
    "mcp_servers.supabase.enabled=false",
    "mcp_servers.openaiDeveloperDocs.enabled=false",
  ];
}

export function buildNativeBokCodexConfigOverrides(
  config?: Pick<AppConfig, "workspacePath">,
  source: NodeJS.ProcessEnv = process.env,
): string[] {
  const discovered = config ? discoverConfiguredMcpServers(config.workspacePath, source) : [];
  return [
    "features.shell_tool=false",
    "features.unified_exec=false",
    "features.multi_agent=false",
    "tools.web_search=false",
    "tools.view_image=false",
    "apps._default.enabled=false",
    'shell_environment_policy.inherit="none"',
    ...buildReviewerCodexConfigOverrides(),
    ...discovered.map((name) => `mcp_servers.${tomlKey(name)}.enabled=false`),
  ];
}

export function buildSharedNativeBokCodexEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed = [
    "HOME", "XDG_CONFIG_HOME", "CODEX_HOME", "PATH", "LANG", "LC_ALL",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
  ] as const;
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = source[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

function discoverConfiguredMcpServers(
  workspacePath: string,
  source: NodeJS.ProcessEnv,
): string[] {
  const codexHome = source.CODEX_HOME
    ?? path.join(source.HOME ?? os.homedir(), ".codex");
  const files = [
    path.join(codexHome, "config.toml"),
    path.join(workspacePath, ".codex", "config.toml"),
  ];
  const names = new Set<string>();
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("native_bok_mcp_config_unreadable");
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (/^\[\s*mcp_servers\s*\]$/.test(trimmed)) {
        // Root table permits arbitrary keys on following lines. Without a complete TOML parser we
        // cannot prove that every inherited server was disabled, so this valid shape fails closed.
        throw new Error("native_bok_mcp_config_unparseable");
      }
      if (/^\[\s*mcp_servers\./.test(trimmed)) {
        const match = trimmed.match(/^\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.|\s*\])/);
        const name = match?.[1] ?? match?.[2] ?? match?.[3];
        if (!name) throw new Error("native_bok_mcp_config_unparseable");
        names.add(name);
        continue;
      }
      if (/^mcp_servers\s*=/.test(trimmed)) {
        throw new Error("native_bok_mcp_config_unparseable");
      }
      if (/^mcp_servers\./.test(trimmed)) {
        const match = trimmed.match(/^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/);
        const name = match?.[1] ?? match?.[2] ?? match?.[3];
        if (!name) throw new Error("native_bok_mcp_config_unparseable");
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function resolveModel(value: string): string {
  if (!SAFE_NATIVE_BOK_MODEL.test(value)) throw new Error("Nieprawidłowy model BOK.");
  return value;
}

function resolvedThreadModel(model: string): Pick<ThreadOptions, "model"> | object {
  // `codex-subscription-managed` oznacza ten sam model zarządzany z tego samego CODEX_HOME;
  // jawny model jest przekazywany identycznie do primary, reviewer i native.
  return model === DEFAULT_NATIVE_BOK_MODEL ? {} : { model };
}
