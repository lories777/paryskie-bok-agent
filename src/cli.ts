import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import "dotenv/config";
import { BokAgentCore } from "./bok-agent-core.js";
import { BokCodexAgent } from "./codex-agent.js";
import { assertLiveConfig, assertNativeBokApiConfig, loadConfig } from "./config.js";
import { DiscordGateway } from "./discord.js";
import { DaktelaMonitor } from "./daktela-monitor.js";
import { MasterLinkReportClient } from "./masterlink.js";
import { createNativeBokHttpServer } from "./native-bok-server.js";
import { AgentStore } from "./store.js";
import type { ClaimedJob, IncomingMessage } from "./types.js";
import { JobWorker, type ReplySink } from "./worker.js";

async function main(): Promise<void> {
  const config = loadConfig();
  assertWorkspace(config.workspacePath);
  const command = process.argv[2] ?? "help";
  const store = new AgentStore(config.stateDir, "bok-agent.sqlite", {
    recoverInterruptedJobs: command === "run" || command === "local",
  });
  const masterlink =
    config.masterlinkReportUrl && config.masterlinkReportToken
      ? new MasterLinkReportClient({
          endpointUrl: config.masterlinkReportUrl,
          token: config.masterlinkReportToken,
          timeoutMs: config.masterlinkReportTimeoutMs,
        })
      : undefined;
  try {
    if (command === "status") {
      console.log(JSON.stringify(store.status(), null, 2));
      return;
    }

    if (command === "local") {
      const prompt = process.argv.slice(3).join(" ").trim();
      if (!prompt) throw new Error('Użycie: npm run dev -- local "wiadomość"');
      const incoming: IncomingMessage = {
        platform: "local",
        conversationExternalId: "local:default",
        externalMessageId: `local:${Date.now()}`,
        channelId: "local",
        authorId: "local-user",
        authorName: "Oliwer",
        content: prompt,
        createdAt: new Date().toISOString(),
        shouldRespond: true,
      };
      store.ingest(incoming);
      const core = new BokAgentCore(config, store);
      const agent = new BokCodexAgent(core, masterlink);
      const sink: ReplySink = {
        async deliver(_job: ClaimedJob, message: string) {
          console.log(message);
        },
      };
      const worker = new JobWorker(store, agent, sink);
      await worker.runOne();
      return;
    }

    if (command === "run") {
      assertLiveConfig(config);
      const discord = new DiscordGateway(config, store);
      const core = new BokAgentCore(config, store);
      const agent = new BokCodexAgent(core, masterlink);
      const worker = new JobWorker(store, agent, discord);
      const daktela = config.daktelaMonitorEnabled
        ? new DaktelaMonitor(config, store)
        : undefined;
      if (daktela) {
        discord.setApprovedActionExecutor((job) => daktela.executeApprovedAction(job));
        discord.setStatusProvider(() => daktela.runtimeStatus());
      } else {
        discord.setStatusProvider(() =>
          [
            "BOK Agent: ONLINE",
            "Daktela monitor: OFF",
            "Tryb pracy: analiza i drafty na wspólnym kanale",
          ].join("\n"),
        );
      }
      const controller = new AbortController();
      const shutdown = () => controller.abort();
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      const nativeServer = config.nativeApiEnabled
        ? await startSharedNativeApi(config, agent)
        : undefined;
      let discordStarted = false;
      try {
        await discord.start();
        discordStarted = true;
        await daktela?.start();
        await worker.runForever(controller.signal);
      } finally {
        await daktela?.stop();
        if (discordStarted) await discord.stop();
        await stopSharedNativeApi(nativeServer);
      }
      return;
    }

    console.log(`
Paryskie BOK Agent

  npm run dev -- local "pytanie"   lokalna rozmowa przez zalogowany Codex
  npm run dev -- status             stan trwałej kolejki
  npm run dev -- run                uruchom gateway Discord + worker 24/7
  BOK_NATIVE_API_ENABLED=true       wystawia prywatne API w tym samym procesie co Discord
`.trim());
  } finally {
    store.close();
  }
}

async function startSharedNativeApi(
  config: ReturnType<typeof loadConfig>,
  agent: BokCodexAgent,
) {
  assertNativeBokApiConfig(config);
  const server = createNativeBokHttpServer(config, agent.nativeInference);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.nativeApiPort, config.nativeApiHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(
    `Współdzielone API BOK działa na ${config.nativeApiHost}:${config.nativeApiPort} (Discord + ML + jeden Store).`,
  );
  return server;
}

async function stopSharedNativeApi(server: ReturnType<typeof createNativeBokHttpServer> | undefined) {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

function assertWorkspace(workspacePath: string): void {
  const agentsFile = path.join(workspacePath, "AGENTS.md");
  if (!fs.existsSync(agentsFile)) {
    throw new Error(`Brak kontraktu agenta: ${agentsFile}`);
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
