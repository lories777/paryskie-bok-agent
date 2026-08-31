#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './mcp.js';
import { createRuntime } from './runtime.js';

async function main(): Promise<void> {
  const runtime = createRuntime();
  const server = buildMcpServer(runtime.reads, runtime.mutations, runtime.audit);
  const shutdown = async (): Promise<void> => {
    await server.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
  };
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  // MCP używa stdout jako protokołu. Celowo bez konfiguracji, URL-i i szczegółów błędu.
  process.stderr.write('MasterLink MCP nie uruchomił się. Sprawdź konfigurację i uprawnienia plików.\n');
  process.exit(1);
});
