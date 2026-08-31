import assert from "node:assert/strict";
import test from "node:test";
import { assertLiveConfig, loadConfig } from "../src/config.js";

test("konfiguracja rozdziela listy i domyślnie blokuje działania zewnętrzne", () => {
  const config = loadConfig(
    {
      BOK_AGENT_COMMAND_CHANNEL_IDS: "1, 2",
      BOK_AGENT_OBSERVE_CHANNEL_IDS: "2,3",
      BOK_AGENT_ALLOWED_USER_IDS: "10",
      BOK_AGENT_ALLOWED_ROLE_IDS: "20,21",
    },
    "/tmp/project",
  );
  assert.deepEqual([...config.commandChannelIds], ["1", "2"]);
  assert.deepEqual([...config.observeChannelIds], ["2", "3"]);
  assert.deepEqual([...config.allowedRoleIds], ["20", "21"]);
  assert.equal(config.externalActionsEnabled, false);
  assert.equal(config.workspacePath, "/tmp/project/agent-workspace");
  assert.equal(config.masterlinkMcpProjectDir, "/tmp/project/connectors/masterlink");
});

test("ścieżki connectora MasterLink można przenieść konfiguracją", () => {
  const config = loadConfig({
    MASTERLINK_MCP_PROJECT_DIR: "./integrations/ml",
    MASTERLINK_MCP_ENV_FILE: "./runtime/ml.env",
  }, "/srv/bok-agent");
  assert.equal(config.masterlinkMcpProjectDir, "/srv/bok-agent/integrations/ml");
  assert.equal(config.masterlinkMcpEnvFile, "/srv/bok-agent/runtime/ml.env");
});

test("pusty opcjonalny URL MasterLinka nie blokuje startu", () => {
  const config = loadConfig({ MASTERLINK_REPORT_URL: "" }, "/tmp/test");
  assert.equal(config.masterlinkReportUrl, undefined);
});

test("tryb live odmawia startu bez tokenu i allowlisty", () => {
  const config = loadConfig({}, "/tmp/project");
  assert.throws(() => assertLiveConfig(config), /DISCORD_BOT_TOKEN/);
  assert.throws(() => assertLiveConfig(config), /BOK_AGENT_ALLOWED_USER_IDS/);
});

test("rola zespołu BOK wystarcza jako allowlista trybu live", () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: "test-token",
    BOK_AGENT_COMMAND_CHANNEL_IDS: "1",
    BOK_AGENT_ALLOWED_ROLE_IDS: "20",
  }, "/tmp/project");
  assert.doesNotThrow(() => assertLiveConfig(config));
});

test("włączony monitor Dakteli wymaga widoku i kanału eskalacji", () => {
  const base = {
    DISCORD_BOT_TOKEN: "test-token",
    BOK_AGENT_COMMAND_CHANNEL_IDS: "1",
    BOK_AGENT_ALLOWED_USER_IDS: "10",
    DAKTELA_MONITOR_ENABLED: "true",
  };
  assert.throws(() => assertLiveConfig(loadConfig(base, "/tmp/project")), /DAKTELA_VIEW_URL/);
  const withView = loadConfig(
    { ...base, DAKTELA_VIEW_URL: "https://daktela.example/tickets/" },
    "/tmp/project",
  );
  assert.throws(() => assertLiveConfig(withView), /DAKTELA_ESCALATION_CHANNEL_ID/);
});
