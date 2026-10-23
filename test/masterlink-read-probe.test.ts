import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConnectorMasterlinkReadProbe } from "../src/masterlink-read-probe.js";

test("sonda odczytu ML: kod wyjścia connectora decyduje, brak skryptu to niedostępność", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-ml-probe-"));
  try {
    const envFile = path.join(dir, "masterlink.env");
    assert.equal(await new ConnectorMasterlinkReadProbe(dir, envFile).check(), false);

    fs.mkdirSync(path.join(dir, "dist"));
    const script = path.join(dir, "dist/read-probe.js");
    // Sonda przekazuje connectorowi wyłącznie ścieżkę env, nie sekrety runtime BOK.
    fs.writeFileSync(script, `process.exit(process.env.ML_ENV_FILE === ${JSON.stringify(envFile)} && !process.env.DISCORD_TOKEN ? 0 : 3);`);
    process.env.DISCORD_TOKEN = "nie-dla-sondy";
    try {
      assert.equal(await new ConnectorMasterlinkReadProbe(dir, envFile).check(), true);
    } finally {
      delete process.env.DISCORD_TOKEN;
    }

    fs.writeFileSync(script, "process.exit(1);");
    assert.equal(await new ConnectorMasterlinkReadProbe(dir, envFile).check(), false);

    fs.writeFileSync(script, "setTimeout(() => {}, 60_000);");
    assert.equal(await new ConnectorMasterlinkReadProbe(dir, envFile, 300).check(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
