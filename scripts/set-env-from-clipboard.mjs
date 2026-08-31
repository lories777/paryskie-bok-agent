#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const [envPath, key = "DISCORD_BOT_TOKEN"] = process.argv.slice(2);

if (!envPath) {
  throw new Error("Użycie: set-env-from-clipboard.mjs <plik-env> [KLUCZ]");
}

if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
  throw new Error("Nieprawidłowa nazwa zmiennej środowiskowej");
}

const secret = execFileSync("xclip", ["-selection", "clipboard", "-o"], {
  encoding: "utf8",
}).trim();

if (secret.length < 40 || /[\r\n\0]/.test(secret)) {
  throw new Error("Schowek nie zawiera oczekiwanej wartości sekretu");
}

const current = readFileSync(envPath, "utf8");
const line = `${key}=${secret}`;
const matcher = new RegExp(`^${key}=.*$`, "m");
const next = matcher.test(current)
  ? current.replace(matcher, line)
  : `${current.replace(/\n?$/, "\n")}${line}\n`;

writeFileSync(envPath, next, { encoding: "utf8", mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(`Zapisano ${key}; wartość nie została wyświetlona.`);
