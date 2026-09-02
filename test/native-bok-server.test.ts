import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import test from "node:test";
import {
  MAX_NATIVE_BOK_REQUEST_BYTES,
  NATIVE_BOK_PROVIDER,
  NATIVE_BOK_RUNTIME,
} from "../src/native-bok-contract.js";
import { createNativeBokHttpServerForConfig } from "../src/native-bok-server.js";
import { NativeBokCorrectionBindingError } from "../src/native-bok-inference.js";
import {
  NATIVE_BOK_ATTACHMENT_CONTEXT,
  NATIVE_BOK_CONTEXT,
  NATIVE_BOK_DRAFT,
  NATIVE_BOK_JUDGEMENT,
  NATIVE_BOK_KNOWLEDGE,
} from "./native-bok-fixtures.js";

const TOKEN = "native-bok-test-token-minimum-32-characters";

function fakeInference(overrides: {
  generate?: (
    context: unknown,
    knowledgeSnapshot: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
  judge?: (
    context: unknown,
    draft: unknown,
    knowledgeSnapshot: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
} = {}) {
  return {
    generatorModel: "codex-generator-test",
    judgeModel: "codex-judge-test",
    runtimeStatus: () => ({
      schemaVersion: 1 as const,
      provider: NATIVE_BOK_PROVIDER,
      runtime: NATIVE_BOK_RUNTIME,
      store: {
        source: "shared-agent-store" as const,
        identity: "c".repeat(64),
      },
      corrections: {
        source: "verified-discord-corrections" as const,
        revision: 7,
        activeRules: 3,
        total: 3,
        truncated: false as const,
      },
      playbook: {
        source: "shared-agent-workspace" as const,
        revision: "b".repeat(64),
      },
      operationalActionCatalog: {
        schemaVersion: 2 as const,
        hash: "9c6f8e5341d775d05875fc29afda2911b4e2346e2fdb7c92f5983929d6ca0d6b",
      },
    }),
    generate: overrides.generate ?? (async () => NATIVE_BOK_DRAFT),
    judge: overrides.judge ?? (async () => NATIVE_BOK_JUDGEMENT),
  };
}

test("runtime status wymaga Bearera i potwierdza wspólny Store/workspace bez treści reguł", async () => {
  const server = createServer();
  const runtime = await listen(server);
  try {
    const unauthenticated = await fetch(`${runtime.origin}/v1/bok/runtime`);
    assert.equal(unauthenticated.status, 401);

    const response = await fetch(`${runtime.origin}/v1/bok/runtime`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      schemaVersion: 1,
      provider: NATIVE_BOK_PROVIDER,
      runtime: NATIVE_BOK_RUNTIME,
      store: {
        source: "shared-agent-store",
        identity: "c".repeat(64),
      },
      corrections: {
        source: "verified-discord-corrections",
        revision: 7,
        activeRules: 3,
        total: 3,
        truncated: false,
      },
      playbook: {
        source: "shared-agent-workspace",
        revision: "b".repeat(64),
      },
      operationalActionCatalog: {
        schemaVersion: 2,
        hash: "9c6f8e5341d775d05875fc29afda2911b4e2346e2fdb7c92f5983929d6ca0d6b",
      },
    });
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  } finally {
    await runtime.close();
  }
});

async function listen(server: Server): Promise<{ origin: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function createServer(
  inference = fakeInference(),
  config: Partial<{ maxConcurrency: number; timeoutMs: number }> = {},
) {
  return createNativeBokHttpServerForConfig({
    token: TOKEN,
    maxConcurrency: config.maxConcurrency ?? 2,
    timeoutMs: config.timeoutMs ?? 2_000,
  }, inference);
}

async function post(origin: string, path: string, value: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
}

test("generate zwraca envelope provider/model zgodny z connector-em i no-store", async () => {
  let received: unknown;
  const server = createServer(fakeInference({
    async generate(context, knowledgeSnapshot) {
      received = [context, knowledgeSnapshot];
      return NATIVE_BOK_DRAFT;
    },
  }));
  const runtime = await listen(server);
  try {
    const response = await post(runtime.origin, "/v1/bok/generate", {
      context: NATIVE_BOK_CONTEXT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await response.json(), {
      ok: true,
      result: NATIVE_BOK_DRAFT,
      provider: NATIVE_BOK_PROVIDER,
      model: "codex-generator-test",
    });
    assert.deepEqual(received, [NATIVE_BOK_CONTEXT, NATIVE_BOK_KNOWLEDGE]);
  } finally {
    await runtime.close();
  }
});

test("judge przyjmuje dokładnie context+draft i używa osobnego modelu", async () => {
  let received: unknown[] = [];
  const server = createServer(fakeInference({
    async judge(context, draft, knowledgeSnapshot) {
      received = [context, draft, knowledgeSnapshot];
      return NATIVE_BOK_JUDGEMENT;
    },
  }));
  const runtime = await listen(server);
  try {
    const response = await post(runtime.origin, "/v1/bok/judge", {
      context: NATIVE_BOK_CONTEXT,
      draft: NATIVE_BOK_DRAFT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      result: NATIVE_BOK_JUDGEMENT,
      provider: NATIVE_BOK_PROVIDER,
      model: "codex-judge-test",
    });
    assert.deepEqual(received, [
      NATIVE_BOK_CONTEXT,
      NATIVE_BOK_DRAFT,
      NATIVE_BOK_KNOWLEDGE,
    ]);
  } finally {
    await runtime.close();
  }
});

test("brak server-side bindingu generate kończy judge jawnie i fail-closed", async () => {
  const server = createServer(fakeInference({
    async judge() {
      throw new NativeBokCorrectionBindingError("correction_snapshot_unbound");
    },
  }));
  const runtime = await listen(server);
  try {
    const response = await post(runtime.origin, "/v1/bok/judge", {
      context: NATIVE_BOK_CONTEXT,
      draft: NATIVE_BOK_DRAFT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "correction_snapshot_unbound",
    });
  } finally {
    await runtime.close();
  }
});

test("niepełna pamięć korekt kończy generate jawnym 409 zamiast fallbacku", async () => {
  const server = createServer(fakeInference({
    async generate() {
      throw new NativeBokCorrectionBindingError("correction_snapshot_truncated");
    },
  }));
  const runtime = await listen(server);
  try {
    const response = await post(runtime.origin, "/v1/bok/generate", {
      context: NATIVE_BOK_CONTEXT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "correction_snapshot_truncated",
    });
  } finally {
    await runtime.close();
  }
});

test("Bearer jest obowiązkowy, a payload strict jest odrzucany przed inference", async () => {
  let calls = 0;
  const server = createServer(fakeInference({
    async generate() {
      calls += 1;
      return NATIVE_BOK_DRAFT;
    },
  }));
  const runtime = await listen(server);
  try {
    const unauthorized = await post(
      runtime.origin,
      "/v1/bok/generate",
      { context: NATIVE_BOK_CONTEXT, knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE },
      "wrong-token-with-at-least-32-characters",
    );
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { ok: false, error: "unauthorized" });

    const invalid = await post(runtime.origin, "/v1/bok/generate", {
      context: NATIVE_BOK_CONTEXT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
      extra: "not-allowed",
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { ok: false, error: "invalid_contract" });
    assert.equal(calls, 0);
  } finally {
    await runtime.close();
  }
});

test("nieodczytany obraz jest odrzucany przed inference", async () => {
  let calls = 0;
  const server = createServer(fakeInference({
    async generate() {
      calls += 1;
      return NATIVE_BOK_DRAFT;
    },
  }));
  const runtime = await listen(server);
  try {
    const unread = structuredClone(NATIVE_BOK_ATTACHMENT_CONTEXT) as any;
    unread.conversation[0].attachments[0] = {
      ...unread.conversation[0].attachments[0],
      fileName: "dowod.jpg",
      contentType: "image/jpeg",
      status: "unsupported",
      extractor: null,
      text: null,
    };
    unread.attachmentCoverage.readCount = 0;
    unread.attachmentCoverage.operatorRequiredCount = 1;

    const response = await post(runtime.origin, "/v1/bok/generate", {
      context: unread,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_contract" });
    assert.equal(calls, 0);
  } finally {
    await runtime.close();
  }
});

test("limit body i content type są egzekwowane przed inference", async () => {
  let calls = 0;
  const server = createServer(fakeInference({
    async generate() {
      calls += 1;
      return NATIVE_BOK_DRAFT;
    },
  }));
  const runtime = await listen(server);
  try {
    const wrongType = await fetch(`${runtime.origin}/v1/bok/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);

    const oversized = await fetch(`${runtime.origin}/v1/bok/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: "x".repeat(MAX_NATIVE_BOK_REQUEST_BYTES + 1),
    });
    assert.equal(oversized.status, 413);
    assert.equal(calls, 0);
  } finally {
    await runtime.close();
  }
});

test("przekroczenie concurrency zwraca retryable 429", async () => {
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const server = createServer(fakeInference({
    async generate() {
      started();
      await hold;
      return NATIVE_BOK_DRAFT;
    },
  }), { maxConcurrency: 1 });
  const runtime = await listen(server);
  try {
    const first = post(runtime.origin, "/v1/bok/generate", {
      context: NATIVE_BOK_CONTEXT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    });
    await began;
    const second = await post(runtime.origin, "/v1/bok/generate", {
      context: NATIVE_BOK_CONTEXT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "5");
    release();
    assert.equal((await first).status, 200);
  } finally {
    release();
    await runtime.close();
  }
});

test("timeout abortuje model i kończy się bezpiecznym 408", async () => {
  let aborted = false;
  const server = createServer(fakeInference({
    generate: async (_context, _knowledgeSnapshot, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("sekret lub PII z modelu"));
      }, { once: true });
    }),
  }), { timeoutMs: 20 });
  const runtime = await listen(server);
  try {
    const response = await post(runtime.origin, "/v1/bok/generate", {
      context: NATIVE_BOK_CONTEXT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    });
    assert.equal(response.status, 408);
    assert.deepEqual(await response.json(), { ok: false, error: "timeout" });
    assert.equal(aborted, true);
  } finally {
    await runtime.close();
  }
});

test("rozłączenie klienta przekazuje abort do trwającego Codexa", async () => {
  let started!: () => void;
  let aborted!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const sawAbort = new Promise<void>((resolve) => { aborted = resolve; });
  const server = createServer(fakeInference({
    generate: async (_context, _knowledgeSnapshot, signal) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => {
        aborted();
        reject(new Error("aborted"));
      }, { once: true });
    }),
  }));
  const runtime = await listen(server);
  try {
    const target = new URL("/v1/bok/generate", runtime.origin);
    const request = http.request(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    request.on("error", () => undefined);
    request.end(JSON.stringify({
      context: NATIVE_BOK_CONTEXT,
      knowledgeSnapshot: NATIVE_BOK_KNOWLEDGE,
    }));
    await began;
    request.destroy();
    await sawAbort;
  } finally {
    await runtime.close();
  }
});
