#!/usr/bin/env node

import net from "node:net";

const bindHost = "127.0.0.1";
const bindPort = Number.parseInt(process.env.ML_DB_RELAY_BIND_PORT ?? "15432", 10);
const targetHost = process.env.ML_DB_RELAY_TARGET_HOST ?? "interchange.proxy.rlwy.net";
const targetPort = Number.parseInt(process.env.ML_DB_RELAY_TARGET_PORT ?? "23078", 10);
const maxConnections = Number.parseInt(process.env.ML_DB_RELAY_MAX_CONNECTIONS ?? "5", 10);

for (const [name, value] of [
  ["ML_DB_RELAY_BIND_PORT", bindPort],
  ["ML_DB_RELAY_TARGET_PORT", targetPort],
  ["ML_DB_RELAY_MAX_CONNECTIONS", maxConnections],
]) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Nieprawidłowe ${name}.`);
  }
}

let activeConnections = 0;
const server = net.createServer({ pauseOnConnect: true }, (client) => {
  if (activeConnections >= maxConnections) {
    client.destroy();
    return;
  }

  activeConnections += 1;
  const upstream = net.createConnection({ host: targetHost, port: targetPort });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    activeConnections -= 1;
    client.destroy();
    upstream.destroy();
  };

  client.setKeepAlive(true, 30_000);
  upstream.setKeepAlive(true, 30_000);
  upstream.once("connect", () => {
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
  client.once("error", close);
  upstream.once("error", close);
  client.once("close", close);
  upstream.once("close", close);
});

server.on("error", () => {
  process.stderr.write("Relay PostgreSQL nie może wystartować.\n");
  process.exitCode = 1;
});

server.listen(bindPort, bindHost, () => {
  process.stdout.write(`Relay PostgreSQL działa na ${bindHost}:${bindPort}.\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
