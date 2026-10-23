#!/usr/bin/env node
// Przełącza odczyt connectora BOK z API ML na bazę PostgreSQL READ ONLY (rufus).
// Najpierw sprawdza nowe dane sondą na kopii env; plik docelowy zmienia dopiero po
// udanym `SELECT 1`. Sekretów nie wypisuje. Runtime BOK sam wykryje zmianę (sonda co 15–60 s).
//
// Użycie:
//   node bin/switch-masterlink-read-db.mjs --password-file <plik> --ca-file <ca.crt> \
//     [--host 83.168.88.179] [--port 5440] [--database masterlink] [--user masterlink_bok_ro] \
//     [--env-file ~/.config/paryskie-bok-agent/masterlink.env]
//   node bin/switch-masterlink-read-db.mjs --to-api   # powrót do odczytu przez API ML

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const fail = (message) => {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
};

const envFile = resolve(option('env-file', join(homedir(), '.config/paryskie-bok-agent/masterlink.env')));
if (!existsSync(envFile)) fail(`brak pliku env: ${envFile}`);
if (!existsSync(join(projectDir, 'dist/read-probe.js'))) fail('brak dist/read-probe.js — uruchom `npm run build` w connectorze.');

function setVars(text, vars) {
  const lines = text.split('\n');
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const index = lines.findIndex((entry) => entry.startsWith(`${key}=`));
    if (index >= 0) lines[index] = line;
    else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, line);
  }
  return lines.join('\n');
}

function probe(file) {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/read-probe.js'], {
    cwd: projectDir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), ML_ENV_FILE: file },
    stdio: 'ignore',
    timeout: 30_000,
  });
  return result.status === 0;
}

let vars;
let caCandidate;
let caTarget;
if (args.includes('--to-api')) {
  vars = { ML_READ_BACKEND: 'api' };
} else {
  const passwordFile = option('password-file');
  const caSource = option('ca-file');
  if (!passwordFile || !caSource) fail('podaj --password-file i --ca-file (albo --to-api).');
  const password = readFileSync(resolve(passwordFile), 'utf8').trim();
  if (!password) fail('plik hasła jest pusty.');
  const caPem = readFileSync(resolve(caSource), 'utf8');
  if (!caPem.includes('BEGIN CERTIFICATE')) fail('plik CA nie zawiera certyfikatu PEM.');
  // CA trzymamy obok connectora, jak dotychczasowy certyfikat Railway.
  caTarget = join(projectDir, 'config/rufus-ml-prod-db-ca.pem');
  caCandidate = `${caTarget}.candidate`;
  mkdirSync(dirname(caTarget), { recursive: true });
  writeFileSync(caCandidate, caPem, { mode: 0o644 });
  const url = new URL('postgresql://placeholder@localhost/');
  url.username = option('user', 'masterlink_bok_ro');
  url.password = password;
  url.hostname = option('host', '83.168.88.179');
  url.port = option('port', '5440');
  url.pathname = `/${option('database', 'masterlink')}`;
  vars = {
    ML_READ_BACKEND: 'db',
    ML_READ_DATABASE_URL: url.toString(),
    ML_DB_SSL: 'true',
    ML_DB_SSL_CA_FILE: caTarget,
  };
}

const current = readFileSync(envFile, 'utf8');
const candidate = `${envFile}.candidate`;
const probeVars = caCandidate ? { ...vars, ML_DB_SSL_CA_FILE: caCandidate } : vars;
writeFileSync(candidate, setVars(current, probeVars), { mode: 0o600 });
chmodSync(candidate, 0o600);
if (!probe(candidate)) {
  rmSync(candidate, { force: true });
  if (caCandidate) rmSync(caCandidate, { force: true });
  fail(`sonda nie przeszła z nowymi ustawieniami (${vars.ML_READ_BACKEND}); ${envFile} bez zmian.`);
}
const backup = `${envFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(envFile, backup);
chmodSync(backup, 0o600);
if (caCandidate && caTarget) renameSync(caCandidate, caTarget);
writeFileSync(candidate, setVars(current, vars), { mode: 0o600 });
renameSync(candidate, envFile);
process.stdout.write(`OK: odczyt MasterLink = ${vars.ML_READ_BACKEND}; sonda przeszła. Kopia: ${backup}\n`);
process.stdout.write('Runtime BOK przełączy się sam; w logu usługi szukaj masterlink_read_recovered (jeśli był przestój).\n');
