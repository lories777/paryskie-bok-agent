import assert from "node:assert/strict";
import fs from "node:fs";
import { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type AppConfig } from "../src/config.js";
import {
  NATIVE_BOK_PROVIDER,
  NATIVE_BOK_RUNTIME,
  type NativeBokRuntimeStatus,
} from "../src/native-bok-contract.js";
import {
  NativeOperationalActionDispatchError,
  NativeOperationalActionDispatcher,
  nativeOperationalActionEnvelopeSchema,
  nativeOperationalActionProof,
  nativeOperationalActionRequestHash,
  renderNativeOperationalAction,
  type NativeOperationalActionEnvelope,
  type NativeOperationalDiscordPort,
  type OperationalActionProofResult,
} from "../src/native-bok-operational-dispatch.js";
import {
  operationalActionCatalogHash,
  TICKET_TEAM_ESCALATION_ACTION_TYPES,
  TICKET_TEAM_ESCALATION_DESTINATIONS,
  type TicketTeamEscalationDestination,
} from "../src/native-bok-operational-catalog.js";
import { createNativeBokHttpServerForConfig } from "../src/native-bok-server.js";
import { AgentStore } from "../src/store.js";

const TOKEN = "native-operational-dispatch-test-token-32";
const MESSAGE_ID = "1542184333916372992";

const ROUTE_ENV = {
  BOK_NATIVE_DISCORD_PAYMENTS_CHANNEL_ID: "100000000000000101",
  BOK_NATIVE_DISCORD_ALLEGRO_CHANNEL_ID: "100000000000000102",
  BOK_NATIVE_DISCORD_COMPLAINTS_CHANNEL_ID: "100000000000000103",
  BOK_NATIVE_DISCORD_CURRENT_AFFAIRS_CHANNEL_ID: "100000000000000104",
  BOK_NATIVE_DISCORD_RETURNS_UNRECEIVED_CHANNEL_ID: "100000000000000105",
  BOK_NATIVE_DISCORD_CANCELLED_CHANNEL_ID: "100000000000000106",
  BOK_NATIVE_DISCORD_WHOLESALERS_CHANNEL_ID: "100000000000000107",
  BOK_NATIVE_DISCORD_UPSELL_CHANNEL_ID: "100000000000000108",
  BOK_NATIVE_DISCORD_PROMO_CHANNEL_ID: "100000000000000109",
  BOK_NATIVE_DISCORD_BOK_CHANNEL_ID: "100000000000000110",
  BOK_NATIVE_DISCORD_ORIGINALS_CHANNEL_ID: "100000000000000111",
  BOK_NATIVE_DISCORD_UNSUBSCRIBE_CHANNEL_ID: "100000000000000112",
  BOK_NATIVE_DISCORD_RUFUS_BOK_CHANNEL_ID: "100000000000000113",
  BOK_NATIVE_DISCORD_BOK_MARKETING_CHANNEL_ID: "100000000000000114",
} as const;

function readyConfig(): AppConfig {
  return loadConfig({
    BOK_AGENT_EXTERNAL_ACTIONS: "true",
    BOK_NATIVE_API_ENABLED: "true",
    BOK_NATIVE_API_TOKEN: TOKEN,
    BOK_NATIVE_OPERATIONAL_DISPATCH_ENABLED: "true",
    BOK_NATIVE_DISCORD_GUILD_ID: "100000000000000001",
    BOK_NATIVE_DISCORD_CATEGORY_ID: "100000000000000002",
    ...ROUTE_ENV,
  });
}

function envelope(overrides: Partial<NativeOperationalActionEnvelope> = {}) {
  const base = {
    schemaVersion: 2 as const,
    idempotencyKey: "3f487b89-f426-4af9-b001-e1bd9553bbed",
    actionType: "marketing.creator_partnership" as const,
    sourceSuggestionId: "9d834df2-a4c7-4bde-b12c-5f0883e45a3a",
    sourceRevision: 7,
    ticket: {
      id: "72dcaa2a-16f8-4f68-9ac3-57d67d3026fd",
      number: 10_0328,
      externalId: "100328",
      market: "PL" as const,
      url: "https://ml.example/tickets/72dcaa2a-16f8-4f68-9ac3-57d67d3026fd",
    },
    order: null,
  };
  const candidate = { ...base, ...overrides };
  return {
    ...candidate,
    requestHash: nativeOperationalActionRequestHash({
      ticketId: candidate.ticket.id,
      sourceRevision: candidate.sourceRevision,
      sourceSuggestionId: candidate.sourceSuggestionId,
      actionType: candidate.actionType,
    }),
  };
}

class FakeDiscord implements NativeOperationalDiscordPort {
  verified = true;
  ready = true;
  sendCalls = 0;
  findCalls = 0;
  failNextFind = false;
  failSendAfterCommit = false;
  failSendBeforeCommit = false;
  beforeSend: (() => Promise<void>) | undefined;
  routeVersion = "a";
  readonly messages = new Map<string, { content: string; destination: string; nonce: string }>();

  async verifyOperationalActionRoutes(): Promise<void> {
    this.verified = true;
  }

  operationalActionIdentityVerified(): boolean {
    return this.verified;
  }

  operationalActionReady(): boolean {
    return this.ready;
  }

  operationalActionRouteIdentity(destination: TicketTeamEscalationDestination): string | null {
    return this.verified
      ? `${destination.charCodeAt(0).toString(16)}`.padStart(64, this.routeVersion).slice(-64)
      : null;
  }

  async findOperationalActionProof(input: {
    destination: TicketTeamEscalationDestination;
    proof: string;
    expectedContent: string;
  }): Promise<OperationalActionProofResult> {
    this.findCalls += 1;
    if (this.failNextFind) {
      this.failNextFind = false;
      throw new Error("readback unavailable");
    }
    const matches = [...this.messages.entries()].filter(
      ([, message]) => message.destination === input.destination && message.content.includes(input.proof),
    );
    if (matches.length === 0) return { status: "missing" };
    if (matches.length !== 1 || matches[0]?.[1].content !== input.expectedContent) {
      return { status: "conflict" };
    }
    return { status: "found", externalReference: matches[0][0] };
  }

  async sendOperationalAction(input: {
    destination: TicketTeamEscalationDestination;
    content: string;
    nonce: string;
  }): Promise<string> {
    this.sendCalls += 1;
    await this.beforeSend?.();
    if (this.failSendBeforeCommit) {
      this.failSendBeforeCommit = false;
      throw new Error("network before POST");
    }
    const existing = [...this.messages.entries()].find(([, message]) => message.nonce === input.nonce);
    const id = existing?.[0] ?? MESSAGE_ID;
    this.messages.set(id, { ...input });
    if (this.failSendAfterCommit) {
      this.failSendAfterCommit = false;
      throw new Error("connection lost after Discord commit");
    }
    return id;
  }
}

function withStore(): { dir: string; store: AgentStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-native-dispatch-"));
  return { dir, store: new AgentStore(dir) };
}

function cleanup(dir: string, store: AgentStore): void {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test("runtime readiness ma exact capability bez channel IDs i zachowuje pinned katalog", async () => {
  const { dir, store } = withStore();
  const discord = new FakeDiscord();
  try {
    const dispatcher = new NativeOperationalActionDispatcher(readyConfig(), store, discord);
    await dispatcher.initialize();
    assert.deepEqual(dispatcher.runtimeStatus(), {
      schemaVersion: 2,
      provider: NATIVE_BOK_PROVIDER,
      enabled: true,
      configurationReady: true,
      identityVerified: true,
      ready: true,
      kinds: ["team_escalation"],
      actionTypes: [...TICKET_TEAM_ESCALATION_ACTION_TYPES],
      routeKeys: [...TICKET_TEAM_ESCALATION_DESTINATIONS],
      delivery: "discord-gateway",
      receipt: "shared-agent-store",
    });
    assert.doesNotMatch(JSON.stringify(dispatcher.runtimeStatus()), /100000000000000/);
    assert.equal(
      operationalActionCatalogHash(),
      "9c6f8e5341d775d05875fc29afda2911b4e2346e2fdb7c92f5983929d6ca0d6b",
    );
    discord.ready = false;
    assert.equal(dispatcher.runtimeStatus().identityVerified, false);
    assert.equal(dispatcher.runtimeStatus().ready, false);
  } finally {
    cleanup(dir, store);
  }
});

test("strict v2 envelope odrzuca routing, akcję MasterLink, zły hash i brak zamówienia", () => {
  assert.equal(nativeOperationalActionEnvelopeSchema.safeParse(envelope()).success, true);
  for (const forbidden of [
    { destination: "bok_marketing" },
    { channelId: "100000000000000114" },
    { message: "napisz na kanał" },
  ]) {
    assert.equal(
      nativeOperationalActionEnvelopeSchema.safeParse({ ...envelope(), ...forbidden }).success,
      false,
    );
  }
  assert.equal(
    nativeOperationalActionEnvelopeSchema.safeParse(envelope({ actionType: "order.stop" })).success,
    false,
  );
  assert.equal(
    nativeOperationalActionEnvelopeSchema.safeParse({ ...envelope(), requestHash: "a".repeat(64) }).success,
    false,
  );
  assert.equal(
    nativeOperationalActionEnvelopeSchema.safeParse(envelope({
      actionType: "finance.verify_payment",
      order: null,
    })).success,
    false,
  );
  assert.equal(
    nativeOperationalActionEnvelopeSchema.safeParse({
      ...envelope(),
      automationEvidence: {
        kind: "customer_transfer_declared",
        inboundMessageId: "9c758df9-bf4c-42db-ac3f-7571e46aa36c",
      },
    }).success,
    false,
  );
});

test("dispatch wybiera serwerową trasę, zapisuje exact receipt i nie wysyła treści modelu", async () => {
  const { dir, store } = withStore();
  const discord = new FakeDiscord();
  try {
    const dispatcher = new NativeOperationalActionDispatcher(readyConfig(), store, discord);
    await dispatcher.initialize();
    const request = envelope();
    const result = await dispatcher.dispatch(request);
    assert.deepEqual(result, {
      idempotencyKey: request.idempotencyKey,
      status: "sent",
      destination: "bok_marketing",
      externalReference: MESSAGE_ID,
      deduplicated: false,
    });
    assert.equal(discord.sendCalls, 1);
    const sent = discord.messages.get(MESSAGE_ID);
    assert.equal(sent?.destination, "bok_marketing");
    assert.equal(sent?.content, renderNativeOperationalAction(request, nativeOperationalActionProof(request)));
    assert.match(sent?.content ?? "", /Oceń współpracę z twórcą/);
    assert.doesNotMatch(sent?.content ?? "", /internalNote|nextActions|destination/);
    const record = store.operationalActionDispatch(request.idempotencyKey);
    assert.equal(record?.status, "sent");
    assert.equal(record?.externalReference, MESSAGE_ID);
  } finally {
    cleanup(dir, store);
  }
});

test("równoległy double request tworzy najwyżej jedną wiadomość", async () => {
  const { dir, store } = withStore();
  const discord = new FakeDiscord();
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  discord.beforeSend = async () => {
    started();
    await releasePromise;
  };
  try {
    const dispatcher = new NativeOperationalActionDispatcher(readyConfig(), store, discord);
    const request = envelope();
    const first = dispatcher.dispatch(request);
    await startedPromise;
    const second = await dispatcher.dispatch(request);
    assert.equal(second.status, "pending");
    assert.equal(second.deduplicated, true);
    release();
    assert.equal((await first).status, "sent");
    assert.equal(discord.sendCalls, 1);
  } finally {
    release();
    cleanup(dir, store);
  }
});

test("ten sam idempotencyKey z innym payloadem kończy się 409 bez drugiej wysyłki", async () => {
  const { dir, store } = withStore();
  const discord = new FakeDiscord();
  try {
    const dispatcher = new NativeOperationalActionDispatcher(readyConfig(), store, discord);
    const request = envelope();
    await dispatcher.dispatch(request);
    await assert.rejects(
      dispatcher.dispatch(envelope({ sourceRevision: 8 })),
      (error: unknown) =>
        error instanceof NativeOperationalActionDispatchError &&
        error.status === 409 &&
        error.code === "idempotency_conflict",
    );
    assert.equal(discord.sendCalls, 1);
  } finally {
    cleanup(dir, store);
  }
});

test("zmiana fizycznej trasy zachowuje sent receipt, ale blokuje niepewny pending", async () => {
  const sentRuntime = withStore();
  const sentDiscord = new FakeDiscord();
  try {
    const dispatcher = new NativeOperationalActionDispatcher(
      readyConfig(),
      sentRuntime.store,
      sentDiscord,
    );
    const request = envelope({ idempotencyKey: "cf3de71b-c8ac-4ac6-b909-d420a162f6ac" });
    assert.equal((await dispatcher.dispatch(request)).status, "sent");
    sentDiscord.routeVersion = "b";
    const duplicate = await dispatcher.dispatch(request);
    assert.equal(duplicate.status, "sent");
    assert.equal(duplicate.deduplicated, true);
    assert.equal(sentDiscord.sendCalls, 1);
  } finally {
    cleanup(sentRuntime.dir, sentRuntime.store);
  }

  const pendingRuntime = withStore();
  const pendingDiscord = new FakeDiscord();
  pendingDiscord.failSendBeforeCommit = true;
  pendingDiscord.failNextFind = true;
  try {
    const dispatcher = new NativeOperationalActionDispatcher(
      readyConfig(),
      pendingRuntime.store,
      pendingDiscord,
    );
    const request = envelope({ idempotencyKey: "3566537f-2ed4-4ed7-aeef-c99137c4323e" });
    assert.equal((await dispatcher.dispatch(request)).status, "pending");
    pendingDiscord.routeVersion = "b";
    await assert.rejects(
      dispatcher.dispatch(request),
      (error: unknown) =>
        error instanceof NativeOperationalActionDispatchError &&
        error.code === "idempotency_conflict",
    );
    assert.equal(pendingDiscord.sendCalls, 1);
  } finally {
    cleanup(pendingRuntime.dir, pendingRuntime.store);
  }
});

test("crash po commicie Discord przed ack SQLite jest reconciliowany bez resend", async () => {
  const { dir, store } = withStore();
  const discord = new FakeDiscord();
  discord.failSendAfterCommit = true;
  discord.failNextFind = true;
  try {
    const dispatcher = new NativeOperationalActionDispatcher(readyConfig(), store, discord);
    const request = envelope();
    assert.equal((await dispatcher.dispatch(request)).status, "pending");
    assert.equal(store.operationalActionDispatch(request.idempotencyKey)?.status, "sending");
    const retried = await dispatcher.dispatch(request);
    assert.equal(retried.status, "sent");
    assert.equal(retried.deduplicated, true);
    assert.equal(retried.externalReference, MESSAGE_ID);
    assert.equal(discord.sendCalls, 1);
    assert.equal(store.operationalActionDispatch(request.idempotencyKey)?.status, "sent");
  } finally {
    cleanup(dir, store);
  }
});

test("receipt i reconciliation przeżywają restart procesu na tym samym SQLite", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-native-dispatch-restart-"));
  const discord = new FakeDiscord();
  discord.failSendAfterCommit = true;
  discord.failNextFind = true;
  const request = envelope({ idempotencyKey: "15e9d8de-c9c7-4bd2-a41e-f3c6b03486ef" });
  const firstStore = new AgentStore(dir);
  try {
    const firstDispatcher = new NativeOperationalActionDispatcher(readyConfig(), firstStore, discord);
    assert.equal((await firstDispatcher.dispatch(request)).status, "pending");
    assert.equal(discord.sendCalls, 1);
  } finally {
    firstStore.close();
  }

  const restartedStore = new AgentStore(dir);
  try {
    const restartedDispatcher = new NativeOperationalActionDispatcher(
      readyConfig(),
      restartedStore,
      discord,
    );
    const recovered = await restartedDispatcher.dispatch(request);
    assert.equal(recovered.status, "sent");
    assert.equal(recovered.externalReference, MESSAGE_ID);
    assert.equal(recovered.deduplicated, true);
    assert.equal(discord.sendCalls, 1);
    assert.equal(
      restartedStore.operationalActionDispatch(request.idempotencyKey)?.externalReference,
      MESSAGE_ID,
    );
  } finally {
    restartedStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("proof z tym samym kluczem, ale inną treścią blokuje retry fail-closed", async () => {
  const { dir, store } = withStore();
  const discord = new FakeDiscord();
  discord.failSendAfterCommit = true;
  discord.failNextFind = true;
  try {
    const dispatcher = new NativeOperationalActionDispatcher(readyConfig(), store, discord);
    const request = envelope();
    assert.equal((await dispatcher.dispatch(request)).status, "pending");
    const committed = discord.messages.get(MESSAGE_ID);
    assert.ok(committed);
    discord.messages.set(MESSAGE_ID, { ...committed, content: `NIEZGODNA TREŚĆ\n${committed.content}` });
    await assert.rejects(
      dispatcher.dispatch(request),
      (error: unknown) =>
        error instanceof NativeOperationalActionDispatchError && error.code === "proof_conflict",
    );
    assert.equal(discord.sendCalls, 1);
    assert.equal(store.operationalActionDispatch(request.idempotencyKey)?.status, "sending");
  } finally {
    cleanup(dir, store);
  }
});

test("retry po pewnym braku proof używa tego samego nonce i trwałego rekordu", async () => {
  const { dir, store } = withStore();
  const discord = new FakeDiscord();
  discord.failSendBeforeCommit = true;
  let clock = Date.now();
  try {
    const dispatcher = new NativeOperationalActionDispatcher(readyConfig(), store, discord, {
      retryAfterMs: 1_000,
      now: () => clock,
    });
    const request = envelope();
    assert.equal((await dispatcher.dispatch(request)).status, "pending");
    const firstAttemptAt = store.operationalActionDispatch(request.idempotencyKey)?.lastAttemptAt;
    assert.ok(firstAttemptAt);
    clock = Date.parse(firstAttemptAt) + 1_001;
    const retry = await dispatcher.dispatch(request);
    assert.equal(retry.status, "sent");
    assert.equal(retry.deduplicated, true);
    assert.equal(discord.sendCalls, 2);
    assert.equal(discord.messages.size, 1);
    assert.equal(store.operationalActionDispatch(request.idempotencyKey)?.attempts, 2);
  } finally {
    cleanup(dir, store);
  }
});

test("zewnętrzny permit jest sprawdzany po reconciliation i przed retry Discord POST", async () => {
  const { dir, store } = withStore();
  const discord = new FakeDiscord();
  discord.failSendBeforeCommit = true;
  let clock = Date.now();
  try {
    const dispatcher = new NativeOperationalActionDispatcher(readyConfig(), store, discord, {
      retryAfterMs: 1_000,
      now: () => clock,
    });
    const request = envelope({ idempotencyKey: "8740967a-8a6a-4e8b-bf0b-2c213f46adf0" });
    assert.equal((await dispatcher.dispatch(request)).status, "pending");
    const firstAttemptAt = store.operationalActionDispatch(request.idempotencyKey)?.lastAttemptAt;
    assert.ok(firstAttemptAt);
    clock = Date.parse(firstAttemptAt) + 1_001;

    let permitCalls = 0;
    await assert.rejects(
      dispatcher.dispatch(request, {
        beforeIrreversibleSend: async () => {
          permitCalls += 1;
          throw new Error("dispatch_lease_invalid");
        },
      }),
      /dispatch_lease_invalid/,
    );
    assert.equal(permitCalls, 1);
    assert.equal(discord.findCalls, 2);
    assert.equal(discord.sendCalls, 1);
    assert.equal(discord.messages.size, 0);
    assert.equal(store.operationalActionDispatch(request.idempotencyKey)?.attempts, 2);
  } finally {
    cleanup(dir, store);
  }
});

test("HTTP dispatch wymaga Bearera i zwraca exact provider/result bez routingu requestu", async () => {
  const { dir, store } = withStore();
  const discord = new FakeDiscord();
  const dispatcher = new NativeOperationalActionDispatcher(readyConfig(), store, discord);
  const server = createNativeBokHttpServerForConfig({
    token: TOKEN,
    maxConcurrency: 2,
    timeoutMs: 2_000,
  }, fakeInference(), dispatcher);
  const runtime = await listen(server);
  try {
    const unauthorized = await fetch(`${runtime.origin}/v1/bok/actions/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope()),
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${runtime.origin}/v1/bok/actions/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope()),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      provider: NATIVE_BOK_PROVIDER,
      result: {
        idempotencyKey: envelope().idempotencyKey,
        status: "sent",
        destination: "bok_marketing",
        externalReference: MESSAGE_ID,
        deduplicated: false,
      },
    });
  } finally {
    await runtime.close();
    cleanup(dir, store);
  }
});

function fakeInference() {
  return {
    generatorModel: "test",
    judgeModel: "test",
    runtimeStatus(): NativeBokRuntimeStatus {
      return {
        schemaVersion: 1,
        provider: NATIVE_BOK_PROVIDER,
        runtime: NATIVE_BOK_RUNTIME,
        store: { source: "shared-agent-store", identity: "c".repeat(64) },
        corrections: {
          source: "verified-discord-corrections",
          revision: 0,
          activeRules: 0,
          total: 0,
          truncated: false,
        },
        playbook: { source: "shared-agent-workspace", revision: "b".repeat(64) },
        operationalActionCatalog: { schemaVersion: 2, hash: operationalActionCatalogHash() },
      };
    },
    async generate() { return {}; },
    async judge() { return {}; },
  };
}

async function listen(server: Server): Promise<{ origin: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Brak portu testowego");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
