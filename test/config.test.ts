import assert from "node:assert/strict";
import test from "node:test";
import { assertLiveConfig, assertNativeBokApiConfig, loadConfig } from "../src/config.js";

test("konfiguracja rozdziela listy i domyślnie blokuje działania zewnętrzne", () => {
  const config = loadConfig(
    {
      BOK_AGENT_COMMAND_CHANNEL_IDS: "1, 2",
      BOK_AGENT_OBSERVE_CHANNEL_IDS: "2,3",
      BOK_AGENT_ALLOWED_USER_IDS: "10",
      BOK_AGENT_ALLOWED_ROLE_IDS: "20,21",
      BOK_AGENT_APPROVER_USER_IDS: "30",
    },
    "/tmp/project",
  );
  assert.deepEqual([...config.commandChannelIds], ["1", "2"]);
  assert.deepEqual([...config.observeChannelIds], ["2", "3"]);
  assert.deepEqual([...config.allowedRoleIds], ["20", "21"]);
  assert.deepEqual([...config.approverUserIds], ["30"]);
  assert.equal(config.browserResearchEnabled, false);
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

test("read-only research przeglądarki jest niezależny od writebacku", () => {
  const config = loadConfig({
    BOK_AGENT_BROWSER_RESEARCH: "true",
    BOK_AGENT_EXTERNAL_ACTIONS: "false",
  }, "/tmp/project");
  assert.equal(config.browserResearchEnabled, true);
  assert.equal(config.externalActionsEnabled, false);
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

test("współdzielone API jest loopback-only i działa wyłącznie w procesie live z sekretem", () => {
  const defaults = loadConfig({}, "/tmp/project");
  assert.equal(defaults.nativeApiEnabled, false);
  assert.equal(defaults.nativeApiHost, "127.0.0.1");
  assert.equal(defaults.nativeApiPort, 8787);
  assert.throws(() => assertNativeBokApiConfig(defaults), /BOK_NATIVE_API_TOKEN/);
  assert.throws(() => loadConfig({ BOK_NATIVE_API_HOST: "0.0.0.0" }, "/tmp/project"));
  assert.throws(() => loadConfig({ BOK_NATIVE_API_TOKEN: "too-short" }, "/tmp/project"));

  const ready = loadConfig({
    BOK_NATIVE_API_ENABLED: "true",
    BOK_NATIVE_API_HOST: "::1",
    BOK_NATIVE_API_TOKEN: "native-api-token-with-at-least-32-characters",
  }, "/tmp/project");
  assert.doesNotThrow(() => assertNativeBokApiConfig(ready));
  assert.equal(ready.nativeApiHost, "::1");

  const liveWithoutToken = loadConfig({
    DISCORD_BOT_TOKEN: "test-token",
    BOK_AGENT_COMMAND_CHANNEL_IDS: "1",
    BOK_AGENT_ALLOWED_USER_IDS: "10",
    BOK_NATIVE_API_ENABLED: "true",
  }, "/tmp/project");
  assert.throws(() => assertLiveConfig(liveWithoutToken), /BOK_NATIVE_API_TOKEN/);
});
