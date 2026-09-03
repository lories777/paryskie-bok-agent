import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import {
  NATIVE_BOK_PROVIDER,
  NATIVE_BOK_RUNTIME,
  type NativeBokRuntimeStatus,
} from "../src/native-bok-contract.js";
import {
  NativeBokOutboundPoller,
  NativeBokOutboundPollerError,
  abortableSleep,
  nativeBokOutboundUrl,
  nativeBridgeHash,
  reconnectBackoffMs,
} from "../src/native-bok-outbound.js";
import {
  nativeOperationalActionRequestHash,
  type NativeOperationalActionDispatchResult,
  type NativeOperationalActionEnvelope,
} from "../src/native-bok-operational-dispatch.js";
import {
  operationalActionCatalogHash,
  TICKET_TEAM_ESCALATION_ACTION_TYPES,
  TICKET_TEAM_ESCALATION_DESTINATIONS,
} from "../src/native-bok-operational-catalog.js";
import {
  nativeBokDaktelaSourceSnapshotHash,
  nativeBokAttachmentEvidenceHash,
  type NativeBokDaktelaDecisionSource,
} from "../src/native-bok-attachment-evidence.js";
import {
  NATIVE_BOK_ATTACHMENT_POLICY_VERSION,
  NATIVE_BOK_DECISION_PIPELINE,
  NATIVE_BOK_DECISION_PIPELINE_HASH,
  nativeBokDecisionCapabilityStatus,
} from "../src/native-bok-decision-capability.js";
import {
  buildNativeBokDecisionResultV3,
  nativeBokDecisionHash,
} from "../src/native-bok-decision-result.js";
import {
  NATIVE_BOK_CONTEXT,
  NATIVE_BOK_DRAFT,
  NATIVE_BOK_JUDGEMENT,
  NATIVE_BOK_KNOWLEDGE,
  NATIVE_BOK_MASTERLINK_OUTBOUND_CONTEXT,
} from "./native-bok-fixtures.js";

const NOW = Date.parse("2026-09-02T20:00:00.000Z");
const INSTANCE_ID = "f44eb32c-857e-4d0c-86d2-0ec47e1094ae";
const JOB_ID = "209c394d-0f25-49cf-ab29-e5efe44481f9";
const LEASE_TOKEN = "6b1a274e-e57e-45cd-a9ca-e0f843c56170";
const ACTION_ID = "3f487b89-f426-4af9-b001-e1bd9553bbed";
const TOKEN = "dedicated-native-outbound-token-32";

const RUNTIME: NativeBokRuntimeStatus = {
  schemaVersion: 1,
  provider: NATIVE_BOK_PROVIDER,
  runtime: NATIVE_BOK_RUNTIME,
  store: { source: "shared-agent-store", identity: "c".repeat(64) },
  corrections: {
    source: "verified-discord-corrections",
    revision: 3,
    activeRules: 3,
    total: 3,
    truncated: false,
  },
  playbook: { source: "shared-agent-workspace", revision: "b".repeat(64) },
  operationalActionCatalog: { schemaVersion: 2, hash: operationalActionCatalogHash() },
};

const DISPATCH_RUNTIME = {
  schemaVersion: 2 as const,
  provider: NATIVE_BOK_PROVIDER,
  enabled: true,
  configurationReady: true,
  identityVerified: true,
  ready: true,
  kinds: ["team_escalation"] as ["team_escalation"],
  actionTypes: [...TICKET_TEAM_ESCALATION_ACTION_TYPES],
  routeKeys: [...TICKET_TEAM_ESCALATION_DESTINATIONS],
  delivery: "discord-gateway" as const,
  receipt: "shared-agent-store" as const,
};

const DECISION_CAPABILITY = nativeBokDecisionCapabilityStatus({
  sharedEngine: true,
  daktelaRead: true,
  masterlinkRead: true,
  attachmentEvidence: true,
  independentJudge: true,
});

class FakeInference {
  readonly callOrder: string[] = [];
  generateSnapshot: unknown;
  judgeSnapshot: unknown;

  runtimeStatus(): NativeBokRuntimeStatus {
    return structuredClone(RUNTIME);
  }

  decisionCapabilityStatus() {
    return structuredClone(DECISION_CAPABILITY);
  }

  async decide(request: unknown, signal: AbortSignal) {
    const parsed = request as {
      context: unknown;
      knowledgeSnapshot: unknown;
    };
    if (signal.aborted) throw new Error("aborted");
    await this.generate(parsed.context, parsed.knowledgeSnapshot);
    await this.judge(parsed.context, NATIVE_BOK_DRAFT, parsed.knowledgeSnapshot);
    return decisionResult();
  }

  async generate(_context: unknown, snapshot: unknown): Promise<unknown> {
    this.callOrder.push("generate");
    this.generateSnapshot = snapshot;
    return structuredClone(NATIVE_BOK_DRAFT);
  }

  async judge(_context: unknown, _draft: unknown, snapshot: unknown): Promise<unknown> {
    this.callOrder.push("judge");
    this.judgeSnapshot = snapshot;
    return structuredClone(NATIVE_BOK_JUDGEMENT);
  }
}

class FakeDispatcher {
  readonly requests: unknown[] = [];
  results: NativeOperationalActionDispatchResult[] = [];

  runtimeStatus() {
    return structuredClone(DISPATCH_RUNTIME);
  }

  async dispatch(request: unknown): Promise<NativeOperationalActionDispatchResult> {
    this.requests.push(request);
    return this.results.shift() ?? sentDispatch();
  }
}

interface CapturedRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function capture(
  responses: Array<Response | Error | ((request: CapturedRequest) => Response | Promise<Response>)>,
) {
  const requests: CapturedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request = {
      url: String(input),
      body: String(init?.body ?? ""),
      headers,
    };
    requests.push(request);
    const response = responses.shift();
    if (!response) throw new Error("Brak odpowiedzi testowej");
    if (response instanceof Error) throw response;
    return typeof response === "function" ? response(request) : response;
  };
  return { requests, fetcher };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function heartbeatAck(request: CapturedRequest): Response {
  const body = JSON.parse(request.body) as {
    poller: { instanceId: string };
    runtime: { store: { identity: string } };
    lease?: unknown;
  };
  return json({
    ok: true,
    schemaVersion: 1,
    provider: NATIVE_BOK_PROVIDER,
    runtimeIdentity: body.poller.instanceId,
    storeIdentity: body.runtime.store.identity,
    statusHash: nativeBridgeHash(body.runtime),
    ...(body.lease ? { leaseValid: true } : {}),
  });
}

function heartbeatLease(lease: ReturnType<typeof decisionLease> | ReturnType<typeof dispatchLease>) {
  return {
    jobId: lease.jobId,
    leaseToken: lease.leaseToken,
    kind: lease.kind,
    requestHash: lease.requestHash,
  };
}

function fullRuntime() {
  return {
    ok: true as const,
    ...RUNTIME,
    decisionCapability: DECISION_CAPABILITY,
    operationalActionDispatch: DISPATCH_RUNTIME,
  };
}

function leaseAck(lease: unknown) {
  return {
    ok: true as const,
    schemaVersion: 1 as const,
    provider: NATIVE_BOK_PROVIDER,
    runtimeIdentity: INSTANCE_ID,
    storeIdentity: RUNTIME.store.identity,
    processStartedAt: new Date(NOW).toISOString(),
    statusHash: nativeBridgeHash(fullRuntime()),
    lease,
  };
}

function decisionLease(overrides: Record<string, unknown> = {}) {
  const request = {
    context: structuredClone(NATIVE_BOK_MASTERLINK_OUTBOUND_CONTEXT),
    knowledgeSnapshot: structuredClone(NATIVE_BOK_KNOWLEDGE),
    source: decisionSource(),
  };
  const contextHash = nativeBridgeHash({
    context: request.context,
    source: request.source,
  });
  const operatorGuidanceHash = null;
  const sourceRevision = NATIVE_BOK_MASTERLINK_OUTBOUND_CONTEXT.ticket.revision;
  const requestHash = nativeBridgeHash({
    kind: "decision",
    sourceRevision,
    contextHash,
    operatorGuidanceHash,
    request,
  });
  return {
    jobId: JOB_ID,
    leaseToken: LEASE_TOKEN,
    leaseExpiresAt: new Date(NOW + 300_000).toISOString(),
    runtimeIdentity: INSTANCE_ID,
    storeIdentity: RUNTIME.store.identity,
    processStartedAt: new Date(NOW).toISOString(),
    kind: "decision",
    stages: ["generate", "judge"],
    sourceRevision,
    contextHash,
    operatorGuidanceHash,
    requestHash,
    request,
    ...overrides,
  };
}

function decisionSource(): NativeBokDaktelaDecisionSource {
  const base = {
    schemaVersion: 1 as const,
    pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
    system: "daktela" as const,
    externalTicketId: "100328",
    externalRevision: "2026-09-02T20:00:00.000Z",
    triggerExternalEventId: "activity_123456",
    latestInboundExternalEventId: "activity_123456",
    queueExternalId: "email_pl",
    attachments: [],
  };
  return { ...base, snapshotHash: nativeBokDaktelaSourceSnapshotHash(base) };
}

function decisionResult() {
  const source = decisionSource();
  const evidenceBase = {
    schemaVersion: 1 as const,
    policyVersion: NATIVE_BOK_ATTACHMENT_POLICY_VERSION,
    pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
    snapshotHash: source.snapshotHash,
    receipts: [],
  };
  return buildNativeBokDecisionResultV3({
    output: {
      reply: "DAKTELA #100328 · gotowe",
      caseState: "action_proposed",
      proposedActions: [{
        kind: "reply_customer",
        summary: "Gotowa odpowiedź",
        target: "Daktela ticket #100328",
        payload: NATIVE_BOK_DRAFT.body,
        reason: "Zweryfikowano dane.",
        risk: "low",
        qualityReview: { verdict: "pass", issues: [], confidence: "high" },
      }],
      actionExecution: null,
    },
    source,
    attachmentEvidence: {
      ...evidenceBase,
      evidenceHash: nativeBokAttachmentEvidenceHash(evidenceBase),
    },
    toolEvidenceHash: nativeBokDecisionHash([]),
    toolNames: [],
    policyHash: "d".repeat(64),
    playbookRevision: "e".repeat(64),
    correctionsRevision: 3,
    storeIdentity: RUNTIME.store.identity,
  });
}

function actionEnvelope(): NativeOperationalActionEnvelope {
  const base = {
    schemaVersion: 2 as const,
    idempotencyKey: ACTION_ID,
    actionType: "marketing.creator_partnership" as const,
    sourceSuggestionId: "9d834df2-a4c7-4bde-b12c-5f0883e45a3a",
    sourceRevision: 7,
    ticket: {
      id: "72dcaa2a-16f8-4f68-9ac3-57d67d3026fd",
      number: 100_328,
      externalId: "100328",
      market: "PL" as const,
      url: "https://ml.example/tickets/72dcaa2a-16f8-4f68-9ac3-57d67d3026fd",
    },
    order: null,
  };
  return {
    ...base,
    requestHash: nativeOperationalActionRequestHash({
      ticketId: base.ticket.id,
      sourceRevision: base.sourceRevision,
      sourceSuggestionId: base.sourceSuggestionId,
      actionType: base.actionType,
    }),
  };
}

function dispatchLease(overrides: Record<string, unknown> = {}) {
  const request = actionEnvelope();
  const contextHash = nativeBridgeHash({
    ticketId: request.ticket.id,
    sourceRevision: request.sourceRevision,
    sourceSuggestionId: request.sourceSuggestionId,
  });
  const requestHash = nativeBridgeHash({
    kind: "dispatch",
    sourceRevision: request.sourceRevision,
    contextHash,
    request,
  });
  return {
    jobId: JOB_ID,
    leaseToken: LEASE_TOKEN,
    leaseExpiresAt: new Date(NOW + 300_000).toISOString(),
    runtimeIdentity: INSTANCE_ID,
    storeIdentity: RUNTIME.store.identity,
    processStartedAt: new Date(NOW).toISOString(),
    kind: "dispatch",
    stages: ["dispatch"],
    sourceRevision: request.sourceRevision,
    contextHash,
    operatorGuidanceHash: null,
    requestHash,
    request,
    ...overrides,
  };
}

function sentDispatch(deduplicated = false): NativeOperationalActionDispatchResult {
  return {
    idempotencyKey: ACTION_ID,
    status: "sent",
    destination: "bok_marketing",
    externalReference: "1542184333916372992",
    deduplicated,
  };
}

function poller(
  fetcher: typeof fetch,
  inference = new FakeInference(),
  dispatcher = new FakeDispatcher(),
  overrides: Partial<ConstructorParameters<typeof NativeBokOutboundPoller>[2]> = {},
) {
  return new NativeBokOutboundPoller(inference, dispatcher, {
    endpointUrl: "https://ml.example/api/agent/v1/report",
    token: TOKEN,
    requestTimeoutMs: 5_000,
    pollIntervalMs: 5_000,
    fetcher,
    instanceId: INSTANCE_ID,
    processStartedAt: new Date(NOW).toISOString(),
    now: () => NOW,
    sleep: async () => undefined,
    log: () => undefined,
    ...overrides,
  });
}

test("atomowy decision robi generate→judge na tym samym snapshotcie i jeden terminalny CAS", async () => {
  const inference = new FakeInference();
  const dispatcher = new FakeDispatcher();
  const lease = decisionLease();
  const transport = capture([
    json(leaseAck(lease)),
    json({ ok: true, schemaVersion: 1, deduplicated: false }),
  ]);
  const result = await poller(transport.fetcher, inference, dispatcher).runOnce(
    new AbortController().signal,
  );
  assert.equal(result, "completed");
  assert.deepEqual(inference.callOrder, ["generate", "judge"]);
  assert.equal(inference.generateSnapshot, inference.judgeSnapshot);
  assert.equal(dispatcher.requests.length, 0);
  assert.equal(transport.requests.length, 2);
  assert.equal(new URL(transport.requests[0]!.url).pathname, "/api/bok-runtime/v1/lease");
  assert.equal(new URL(transport.requests[1]!.url).pathname, "/api/bok-runtime/v1/result");
  assert.equal(transport.requests[0]!.headers.authorization, `Bearer ${TOKEN}`);

  const leaseBody = JSON.parse(transport.requests[0]!.body) as Record<string, unknown>;
  assert.deepEqual(leaseBody, {
    schemaVersion: 1,
    maxJobs: 1,
    poller: { instanceId: INSTANCE_ID, processStartedAt: new Date(NOW).toISOString() },
    runtime: {
      ok: true,
      ...RUNTIME,
      decisionCapability: DECISION_CAPABILITY,
      operationalActionDispatch: DISPATCH_RUNTIME,
    },
  });
  const resultBody = JSON.parse(transport.requests[1]!.body) as Record<string, unknown>;
  assert.deepEqual(resultBody, {
    schemaVersion: 1,
    poller: { instanceId: INSTANCE_ID, processStartedAt: new Date(NOW).toISOString() },
    storeIdentity: RUNTIME.store.identity,
    jobId: JOB_ID,
    leaseToken: LEASE_TOKEN,
    requestHash: lease.requestHash,
    kind: "decision",
    outcome: {
      status: "completed",
      result: decisionResult(),
    },
  });
});

test("lease z obcą tożsamością Store jest odrzucany przed inferencją", async () => {
  const inference = new FakeInference();
  const response = {
    ...leaseAck(decisionLease()),
    storeIdentity: "a".repeat(64),
  };
  const transport = capture([json(response)]);
  await assert.rejects(
    poller(transport.fetcher, inference).runOnce(new AbortController().signal),
    (error: unknown) =>
      error instanceof NativeBokOutboundPollerError
      && error.code === "native_outbound_store_identity"
      && !error.retryable,
  );
  assert.deepEqual(inference.callOrder, []);
  assert.equal(transport.requests.length, 1);
});

test("lease wymaga exact tożsamości instalacji i procesu w ACK oraz w samym jobie", async () => {
  const otherRuntime = "e7ef2fc7-924f-491f-b837-565348989275";
  const otherProcess = "2026-09-02T19:59:59.000Z";
  const cases: Array<{
    response: ReturnType<typeof leaseAck>;
    errorCode: NativeBokOutboundPollerError["code"];
  }> = [
    {
      response: { ...leaseAck(decisionLease()), runtimeIdentity: otherRuntime },
      errorCode: "native_outbound_runtime_identity",
    },
    {
      response: { ...leaseAck(decisionLease()), processStartedAt: otherProcess },
      errorCode: "native_outbound_runtime_process_stale",
    },
    {
      response: leaseAck(decisionLease({ runtimeIdentity: otherRuntime })),
      errorCode: "native_outbound_runtime_identity",
    },
    {
      response: leaseAck(decisionLease({ storeIdentity: "a".repeat(64) })),
      errorCode: "native_outbound_store_identity",
    },
    {
      response: leaseAck(decisionLease({ processStartedAt: otherProcess })),
      errorCode: "native_outbound_runtime_process_stale",
    },
  ];
  for (const scenario of cases) {
    const inference = new FakeInference();
    const transport = capture([json(scenario.response)]);
    await assert.rejects(
      poller(transport.fetcher, inference).runOnce(new AbortController().signal),
      (error: unknown) =>
        error instanceof NativeBokOutboundPollerError
        && error.code === scenario.errorCode
        && !error.retryable,
    );
    assert.deepEqual(inference.callOrder, []);
    assert.equal(transport.requests.length, 1);
  }
});

test("jawne błędy pinów ML zatrzymują poller fail-closed przed inferencją", async () => {
  const cases = [
    [409, "runtime_identity_mismatch", "native_outbound_runtime_identity"],
    [409, "store_identity_mismatch", "native_outbound_store_identity"],
    [409, "runtime_process_stale", "native_outbound_runtime_process_stale"],
    [503, "runtime_identity_not_configured", "native_outbound_runtime_identity_not_configured"],
  ] as const;
  for (const [status, remoteCode, localCode] of cases) {
    const inference = new FakeInference();
    const transport = capture([json({
      ok: false,
      error: remoteCode,
      message: "Bez danych klienta: pin runtime został odrzucony.",
    }, status)]);
    await assert.rejects(
      poller(transport.fetcher, inference).runOnce(new AbortController().signal),
      (error: unknown) =>
        error instanceof NativeBokOutboundPollerError
        && error.code === localCode
        && !error.retryable,
    );
    assert.deepEqual(inference.callOrder, []);
    assert.equal(transport.requests.length, 1);
  }
});

test("zmiana lokalnego Store w trakcie życia pollera zatrzymuje transport przed lease", async () => {
  const inference = new FakeInference();
  const originalRuntimeStatus = inference.runtimeStatus.bind(inference);
  let reads = 0;
  inference.runtimeStatus = () => {
    reads += 1;
    const status = originalRuntimeStatus();
    return reads === 1
      ? status
      : { ...status, store: { ...status.store, identity: "a".repeat(64) } };
  };
  const transport = capture([]);
  const runtime = poller(transport.fetcher, inference);
  await assert.rejects(
    runtime.runOnce(new AbortController().signal),
    (error: unknown) =>
      error instanceof NativeBokOutboundPollerError
      && error.code === "native_outbound_store_identity"
      && !error.retryable,
  );
  assert.equal(transport.requests.length, 0);
});

test("decision result musi pochodzić z przypiętego Store na root i w provenance", async () => {
  for (const mutate of [
    (result: ReturnType<typeof decisionResult>) => ({
      ...result,
      storeIdentity: "a".repeat(64),
    }),
    (result: ReturnType<typeof decisionResult>) => ({
      ...result,
      provenance: { ...result.provenance, storeIdentity: "a".repeat(64) },
    }),
  ]) {
    const inference = new FakeInference();
    inference.decide = async () => mutate(decisionResult());
    const transport = capture([json(leaseAck(decisionLease()))]);
    await assert.rejects(
      poller(transport.fetcher, inference).runOnce(new AbortController().signal),
      (error: unknown) =>
        error instanceof NativeBokOutboundPollerError
        && error.code === "native_outbound_store_identity"
        && !error.retryable,
    );
    assert.equal(transport.requests.length, 1, "foreign-store result is never posted to ML");
  }
});

test("długie generate→judge utrzymuje niezależny heartbeat bez lease'owania drugiego joba", async () => {
  let releaseGenerate!: () => void;
  let markGenerateStarted!: () => void;
  const generateStarted = new Promise<void>((resolve) => { markGenerateStarted = resolve; });
  const generateGate = new Promise<void>((resolve) => { releaseGenerate = resolve; });
  const inference = new FakeInference();
  inference.generate = async (_context: unknown, snapshot: unknown) => {
    inference.callOrder.push("generate");
    inference.generateSnapshot = snapshot;
    markGenerateStarted();
    await generateGate;
    return structuredClone(NATIVE_BOK_DRAFT);
  };

  let releaseHeartbeatDelay!: () => void;
  let markHeartbeatObserved!: () => void;
  const heartbeatDelay = new Promise<void>((resolve) => { releaseHeartbeatDelay = resolve; });
  const heartbeatObserved = new Promise<void>((resolve) => { markHeartbeatObserved = resolve; });
  let heartbeatSleeps = 0;
  const transport = capture([
    json(leaseAck(decisionLease())),
    (request) => {
      markHeartbeatObserved();
      return heartbeatAck(request);
    },
    json({ ok: true, schemaVersion: 1, deduplicated: false }),
  ]);
  const runtime = poller(transport.fetcher, inference, new FakeDispatcher(), {
    activeHeartbeatIntervalMs: 10_000,
    heartbeatSleep: async (_milliseconds, signal) => {
      heartbeatSleeps += 1;
      if (heartbeatSleeps === 1) {
        await heartbeatDelay;
        return;
      }
      await abortableSleep(60_000, signal);
    },
  });

  const run = runtime.runOnce(new AbortController().signal);
  await generateStarted;
  releaseHeartbeatDelay();
  await heartbeatObserved;
  assert.deepEqual(
    transport.requests.map((request) => new URL(request.url).pathname),
    ["/api/bok-runtime/v1/lease", "/api/bok-runtime/v1/heartbeat"],
  );
  assert.deepEqual(inference.callOrder, ["generate"]);

  const heartbeatBody = JSON.parse(transport.requests[1]!.body) as Record<string, unknown>;
  assert.deepEqual(heartbeatBody, {
    schemaVersion: 1,
    poller: { instanceId: INSTANCE_ID, processStartedAt: new Date(NOW).toISOString() },
    runtime: {
      ok: true,
      ...RUNTIME,
      decisionCapability: DECISION_CAPABILITY,
      operationalActionDispatch: DISPATCH_RUNTIME,
    },
    lease: heartbeatLease(decisionLease()),
  });
  releaseGenerate();
  assert.equal(await run, "completed");
  assert.deepEqual(inference.callOrder, ["generate", "judge"]);
  assert.deepEqual(
    transport.requests.map((request) => new URL(request.url).pathname),
    [
      "/api/bok-runtime/v1/lease",
      "/api/bok-runtime/v1/heartbeat",
      "/api/bok-runtime/v1/result",
    ],
  );
});

test("lease wymaga exact stages, source/context/guidance/request hash zanim uruchomi model", async () => {
  for (const invalid of [
    decisionLease({ stages: ["judge", "generate"] }),
    decisionLease({ contextHash: "a".repeat(64) }),
    decisionLease({ operatorGuidanceHash: "a".repeat(64) }),
    decisionLease({ requestHash: "a".repeat(64) }),
    decisionLease({ sourceRevision: 8 }),
    { ...decisionLease(), destination: "bok" },
  ]) {
    const inference = new FakeInference();
    const transport = capture([json(leaseAck(invalid))]);
    await assert.rejects(
      poller(transport.fetcher, inference).runOnce(new AbortController().signal),
      (error: unknown) =>
        error instanceof NativeBokOutboundPollerError &&
        error.code === "native_outbound_malformed",
    );
    assert.deepEqual(inference.callOrder, []);
    assert.equal(transport.requests.length, 1);
  }
});

test("dispatch pending jest reconciliowany w tym samym lease i tylko sent trafia do result", async () => {
  const dispatcher = new FakeDispatcher();
  dispatcher.results = [
    {
      idempotencyKey: ACTION_ID,
      status: "pending",
      destination: "bok_marketing",
      externalReference: null,
      deduplicated: false,
    },
    sentDispatch(true),
  ];
  const waits: number[] = [];
  const lease = dispatchLease();
  const transport = capture([
    json(leaseAck(lease)),
    heartbeatAck,
    heartbeatAck,
    json({ ok: true, schemaVersion: 1, deduplicated: false }),
  ]);
  const runtime = poller(transport.fetcher, new FakeInference(), dispatcher, {
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(await runtime.runOnce(new AbortController().signal), "completed");
  assert.equal(dispatcher.requests.length, 2);
  assert.deepEqual(waits, [5_000]);
  const body = JSON.parse(transport.requests[3]!.body) as {
    kind: string;
    outcome: { status: string; result: NativeOperationalActionDispatchResult };
  };
  assert.equal(body.kind, "dispatch");
  assert.equal(body.outcome.status, "completed");
  assert.deepEqual(body.outcome.result, sentDispatch(true));
});

test("dispatch nie dotyka Discorda bez świeżego server-side potwierdzenia exact lease", async () => {
  const dispatcher = new FakeDispatcher();
  const transport = capture([
    json(leaseAck(dispatchLease())),
    (request) => {
      const accepted = heartbeatAck(request);
      return accepted.json().then((body) => json({
        ...(body as Record<string, unknown>),
        leaseValid: false,
      }));
    },
  ]);
  assert.equal(
    await poller(transport.fetcher, new FakeInference(), dispatcher).runOnce(
      new AbortController().signal,
    ),
    "lease_lost",
  );
  assert.equal(dispatcher.requests.length, 0);
  assert.deepEqual(
    transport.requests.map((request) => new URL(request.url).pathname),
    ["/api/bok-runtime/v1/lease", "/api/bok-runtime/v1/heartbeat"],
  );
  const heartbeat = JSON.parse(transport.requests[1]!.body) as { lease?: unknown };
  assert.deepEqual(heartbeat.lease, heartbeatLease(dispatchLease()));
});

test("stary proces nie wykonuje dispatch po 409 runtime_process_stale", async () => {
  const dispatcher = new FakeDispatcher();
  const transport = capture([
    json(leaseAck(dispatchLease())),
    json({
      ok: false,
      error: "runtime_process_stale",
      message: "Nowszy proces przejął runtime.",
    }, 409),
  ]);
  await assert.rejects(
    poller(transport.fetcher, new FakeInference(), dispatcher).runOnce(
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof NativeBokOutboundPollerError
      && error.code === "native_outbound_runtime_process_stale"
      && !error.retryable,
  );
  assert.equal(dispatcher.requests.length, 0);
  assert.equal(transport.requests.length, 2);
});

test("utracony ACK result jest ponawiany exact body bez ponownej inferencji", async () => {
  const inference = new FakeInference();
  const transport = capture([
    json(leaseAck(decisionLease())),
    new Error("ECONNRESET after commit"),
    json({ ok: true, schemaVersion: 1, deduplicated: true }),
  ]);
  assert.equal(
    await poller(transport.fetcher, inference).runOnce(new AbortController().signal),
    "completed",
  );
  assert.deepEqual(inference.callOrder, ["generate", "judge"]);
  assert.equal(transport.requests.length, 3);
  assert.equal(transport.requests[1]!.body, transport.requests[2]!.body);
});

test("409 result oznacza lease_lost i nie uruchamia działania drugi raz", async () => {
  const dispatcher = new FakeDispatcher();
  const transport = capture([
    json(leaseAck(dispatchLease())),
    heartbeatAck,
    json({ ok: false, error: "lease_lost" }, 409),
  ]);
  assert.equal(
    await poller(transport.fetcher, new FakeInference(), dispatcher).runOnce(
      new AbortController().signal,
    ),
    "lease_lost",
  );
  assert.equal(dispatcher.requests.length, 1);
  assert.equal(transport.requests.length, 3);
});

test("409 result_conflict jest jawnym nieretryowalnym błędem kontraktu", async () => {
  const dispatcher = new FakeDispatcher();
  const transport = capture([
    json(leaseAck(dispatchLease())),
    heartbeatAck,
    json({ ok: false, error: "result_conflict" }, 409),
  ]);
  await assert.rejects(
    poller(transport.fetcher, new FakeInference(), dispatcher).runOnce(
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof NativeBokOutboundPollerError
      && error.code === "native_outbound_result_conflict"
      && !error.retryable,
  );
  assert.equal(dispatcher.requests.length, 1);
  assert.equal(transport.requests.length, 3);
});

test("409 store_identity_mismatch na result nie jest maskowany jako lease_lost", async () => {
  const dispatcher = new FakeDispatcher();
  const transport = capture([
    json(leaseAck(dispatchLease())),
    heartbeatAck,
    json({
      ok: false,
      error: "store_identity_mismatch",
      message: "Agent przedstawił inną bazę pamięci.",
    }, 409),
  ]);
  await assert.rejects(
    poller(transport.fetcher, new FakeInference(), dispatcher).runOnce(
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof NativeBokOutboundPollerError
      && error.code === "native_outbound_store_identity"
      && !error.retryable,
  );
  assert.equal(dispatcher.requests.length, 1);
  assert.equal(transport.requests.length, 3);
});

test("nieznany 409 nie jest maskowany jako utrata lease", async () => {
  for (const conflict of [
    json({ ok: false, error: "job_payload_conflict" }, 409),
    new Response("not-json", { status: 409, headers: { "content-type": "text/plain" } }),
    new Response("x".repeat(4_097), {
      status: 409,
      headers: { "content-type": "application/json", "content-length": "4097" },
    }),
  ]) {
    const transport = capture([
      json(leaseAck(decisionLease())),
      conflict,
    ]);
    await assert.rejects(
      poller(transport.fetcher).runOnce(new AbortController().signal),
      (error: unknown) =>
        error instanceof NativeBokOutboundPollerError
        && error.code === "native_outbound_malformed"
        && !error.retryable,
    );
    assert.equal(transport.requests.length, 2);
  }
});

test("lease bez bezpiecznego budżetu nie uruchamia modelu i raportuje retryable failure", async () => {
  const inference = new FakeInference();
  const lease = decisionLease({ leaseExpiresAt: new Date(NOW + 5_000).toISOString() });
  const transport = capture([
    json(leaseAck(lease)),
    json({ ok: true, schemaVersion: 1, deduplicated: false }),
  ]);
  assert.equal(
    await poller(transport.fetcher, inference).runOnce(new AbortController().signal),
    "failed",
  );
  assert.deepEqual(inference.callOrder, []);
  const result = JSON.parse(transport.requests[1]!.body) as {
    outcome: { status: string; errorCode: string; retryable: boolean };
  };
  assert.deepEqual(result.outcome, {
    status: "failed",
    errorCode: "lease_deadline",
    retryable: true,
  });
});

test("runForever robi ograniczony reconnect backoff i resetuje go po heartbeat", async () => {
  const delays: number[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  const transport = capture([
    new Error("offline-1"),
    new Error("offline-2"),
    json(leaseAck(null)),
  ]);
  const runtime = poller(transport.fetcher, new FakeInference(), new FakeDispatcher(), {
    log: (code) => { logs.push(code); },
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
      if (delays.length === 3) controller.abort();
    },
  });
  await runtime.runForever(controller.signal);
  assert.deepEqual(delays, [5_000, 10_000, 5_000]);
  assert.deepEqual(logs, ["native_outbound_network", "native_outbound_network"]);
  assert.equal(transport.requests.length, 3);
  assert.equal(reconnectBackoffMs(5_000, 20), 30_000);
});

test("runForever nie zapętla nieretryowalnego konfliktu tożsamości", async () => {
  const logs: string[] = [];
  const delays: number[] = [];
  const transport = capture([
    json({
      ok: false,
      error: "store_identity_mismatch",
      message: "Obca baza pamięci.",
    }, 409),
  ]);
  const runtime = poller(transport.fetcher, new FakeInference(), new FakeDispatcher(), {
    log: (code) => { logs.push(code); },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  await assert.rejects(
    runtime.runForever(new AbortController().signal),
    (error: unknown) =>
      error instanceof NativeBokOutboundPollerError
      && error.code === "native_outbound_store_identity"
      && !error.retryable,
  );
  assert.deepEqual(logs, ["native_outbound_store_identity"]);
  assert.deepEqual(delays, []);
  assert.equal(transport.requests.length, 1);
});

test("abortableSleep usuwa listener po każdym idle i po abort", async () => {
  const idleController = new AbortController();
  for (let index = 0; index < 100; index += 1) {
    await abortableSleep(0, idleController.signal);
    assert.equal(getEventListeners(idleController.signal, "abort").length, 0);
  }

  const abortController = new AbortController();
  const waiting = abortableSleep(60_000, abortController.signal);
  assert.equal(getEventListeners(abortController.signal, "abort").length, 1);
  abortController.abort();
  await assert.rejects(waiting);
  assert.equal(getEventListeners(abortController.signal, "abort").length, 0);
});

test("bridge używa dedykowanego HTTPS/loopback URL i nie przyjmuje credentiali w URL", () => {
  assert.equal(
    nativeBokOutboundUrl("https://ml.paryskie.pl/anything?secret=no", "/api/bok-runtime/v1/lease"),
    "https://ml.paryskie.pl/api/bok-runtime/v1/lease",
  );
  assert.equal(
    nativeBokOutboundUrl("http://127.0.0.1:8788/report", "/api/bok-runtime/v1/result"),
    "http://127.0.0.1:8788/api/bok-runtime/v1/result",
  );
  assert.throws(
    () => nativeBokOutboundUrl("http://ml.example/report", "/api/bok-runtime/v1/lease"),
    /insecure/,
  );
  assert.throws(
    () => nativeBokOutboundUrl("https://user:pass@ml.example", "/api/bok-runtime/v1/lease"),
    /invalid/,
  );
});

test("canonical hash jest przypięty do kontraktu PR615", () => {
  assert.equal(
    nativeBridgeHash({ z: 1, a: [true, { y: "x", b: null }] }),
    "c0ed89110d52a04c41691ff9ba4c6d2bb229f9b6b910db000ec90f2b42d1eb49",
  );
});
