import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Input, RunResult, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { BokAgentCore } from "../src/bok-agent-core.js";
import { BokCodexAgent } from "../src/codex-agent.js";
import { loadConfig } from "../src/config.js";
import {
  DaktelaReadSession,
  type DaktelaAuthenticatedReadPort,
} from "../src/daktela-read-session.js";
import {
  nativeBokDaktelaSourceSnapshotHash,
  type NativeBokDaktelaDecisionSource,
} from "../src/native-bok-attachment-evidence.js";
import {
  NativeBokAttachmentRenderer,
  type NativeBokPdfPort,
} from "../src/native-bok-attachment-renderer.js";
import { NATIVE_BOK_DECISION_PIPELINE_HASH } from "../src/native-bok-decision-capability.js";
import { NativeBokDaktelaDecisionEngine } from "../src/native-bok-daktela-decision-engine.js";
import { AgentStore } from "../src/store.js";
import { NATIVE_BOK_CONTEXT, NATIVE_BOK_KNOWLEDGE } from "./native-bok-fixtures.js";

const PNG = png(4, 3);
const FILE_ID = "987654";
const ATTACHMENT_ID = `daktela-meta:${sha256(FILE_ID)}`;

class FakeCodexClient {
  readonly inputs: Input[] = [];
  constructor(private response: () => string | Promise<string>) {}

  setResponse(response: () => string | Promise<string>) {
    this.response = response;
  }

  startThread(_options?: ThreadOptions) { return this.thread(); }
  resumeThread(_id: string, _options?: ThreadOptions) { return this.thread(); }

  private thread() {
    return {
      id: "019c-test-thread",
      run: async (input: Input, _options?: TurnOptions): Promise<RunResult> => {
        this.inputs.push(structuredClone(input));
        return { items: [], finalResponse: await this.response(), usage: null };
      },
    };
  }
}

class FakeDaktelaPort implements DaktelaAuthenticatedReadPort {
  verifyFails = false;
  verifyCalls = 0;
  ticketExternalId = "100328";
  ticketExternalRevision = "2026-09-02T20:00:00.000Z";
  async verify() {
    this.verifyCalls += 1;
    if (this.verifyFails) throw new Error("session expired");
    return { userType: "agent", profileType: "admin", profileTitle: "Admin" };
  }
  async readQueue() {
    return {
      rows: [],
      capabilities: { userType: "agent", profileType: "admin", profileTitle: "Admin" },
    };
  }
  async readTicketActivities() { return []; }
  async openExactTicket() {
    return {
      externalId: this.ticketExternalId,
      externalRevision: this.ticketExternalRevision,
    };
  }
  async readExactActivity() {
    return {
      externalId: "activity_123456",
      ticketExternalId: this.ticketExternalId,
      queueExternalId: "email_pl",
      direction: "inbound" as const,
      attachments: [{
        externalId: FILE_ID,
        fileName: "damage.png",
        contentType: "image/png",
        sizeBytes: PNG.byteLength,
        inline: false,
      }],
    };
  }
  async downloadExactAttachment() { return PNG; }
  async close() {}
}

class ReadyPdfPort implements NativeBokPdfPort {
  available() { return true; }
  async inspect(_inputPath: string, _signal: AbortSignal): Promise<{
    pages: number;
    encrypted: boolean;
  }> { throw new Error("PDF is not used by this fixture"); }
  async render(
    _inputPath: string,
    _outputPrefix: string,
    _pages: number,
    _signal: AbortSignal,
  ): Promise<readonly Uint8Array[]> { throw new Error("PDF is not used by this fixture"); }
}

test("native i entrypoint Discord używają byte-identycznego shared pipeline oraz tych samych obrazów", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-daktela-parity-"));
  const store = new AgentStore(dir);
  try {
    const context = store.ingest({
      platform: "discord",
      conversationExternalId: "daktela-ticket:100328",
      externalMessageId: "daktela:v7:100328:source",
      channelId: "bok-agent-test",
      authorId: "daktela-monitor",
      authorName: "Monitor Daktela",
      content: "[AUTOMATYCZNE ZADANIE DAKTELA] Klient zgłasza uszkodzony flakon.",
      createdAt: "2026-09-02T20:00:00.000Z",
      shouldRespond: false,
      role: "context",
    });
    const config = loadConfig({
      BOK_AGENT_STATE_DIR: dir,
      BOK_AGENT_WORKSPACE: path.join(process.cwd(), "agent-workspace"),
      MASTERLINK_MCP_ENABLED: "true",
      DAKTELA_VIEW_URL: "https://pariscosmetics.daktela.com/tickets",
      BOK_AGENT_BROWSER_RESEARCH: "true",
    }, process.cwd());
    const primary = new FakeCodexClient(() => JSON.stringify(agentOutput()));
    const reviewer = new FakeCodexClient(() => JSON.stringify({
      verdict: "pass",
      revisedPayload: null,
      issues: [],
      confidence: "high",
      polishTranslation: null,
    }));
    const core = new BokAgentCore(config, store);
    const agent = new BokCodexAgent(core, undefined, {
      primaryCodex: primary,
      reviewerCodex: reviewer,
    });
    const readSession = new DaktelaReadSession(config, new FakeDaktelaPort());
    const renderer = new NativeBokAttachmentRenderer(new ReadyPdfPort());
    const engine = new NativeBokDaktelaDecisionEngine(agent, readSession, renderer);
    assert.equal(await engine.verifyDaktelaReadiness(), true);
    assert.equal(engine.decisionCapabilityStatus().ready, true);
    const source = decisionSource();

    const direct = await readSession.withExactSource(
      source,
      new AbortController().signal,
      async (verified) => {
        const rendered = await renderer.render(verified, new AbortController().signal);
        try {
          const job = store.syntheticDaktelaDecisionJob({
            externalTicketId: "100328",
            sourceSnapshotHash: source.snapshotHash,
            channelId: "bok-agent-test",
          });
          return await agent.runWithProvenance(job, new AbortController().signal, rendered);
        } finally {
          await rendered.cleanup();
        }
      },
    );
    const mismatchedContext = decisionContext(source);
    mismatchedContext.conversation[0]!.attachments[0]!.fileName = "different.png";
    await assert.rejects(engine.decide({
      context: mismatchedContext,
      knowledgeSnapshot: structuredClone(NATIVE_BOK_KNOWLEDGE),
      source,
    }, new AbortController().signal), /context_attachment_source_mismatch/);
    assert.equal(primary.inputs.length, 1, "mismatched carrier must be rejected before the model");
    assert.equal(reviewer.inputs.length, 1);

    let releaseNative!: () => void;
    const nativeGate = new Promise<void>((resolve) => { releaseNative = resolve; });
    let markNativeStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => { markNativeStarted = resolve; });
    primary.setResponse(async () => {
      markNativeStarted();
      await nativeGate;
      return JSON.stringify(agentOutput());
    });
    const nativePromise = engine.decide({
      context: decisionContext(source),
      knowledgeSnapshot: structuredClone(NATIVE_BOK_KNOWLEDGE),
      source,
    }, new AbortController().signal);
    await nativeStarted;
    const parallelDiscord = agent.runWithProvenance(store.syntheticDaktelaDecisionJob({
      externalTicketId: "100328",
      sourceSnapshotHash: source.snapshotHash,
      channelId: "bok-agent-test",
    }), new AbortController().signal);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(primary.inputs.length, 2, "Discord must wait behind the in-flight native pipeline");
    assert.equal(reviewer.inputs.length, 1, "reviewer must not race the in-flight native primary");
    releaseNative();
    const [native] = await Promise.all([nativePromise, parallelDiscord]);

    assert.equal(native.state, "ready");
    assert.equal(
      native.provenance.playbookRevision,
      engine.runtimeStatus().playbook.revision,
      "completed decision must use the exact playbook revision advertised in the lease heartbeat",
    );
    assert.equal(native.customerReply?.body, direct.output.proposedActions[0]?.payload);
    assert.equal(native.internalNote, direct.output.reply);
    assert.equal(store.claimNextJob(), null);
    assert.equal(primary.inputs.length, 3);
    assert.equal(reviewer.inputs.length, 3);
    for (const input of [...primary.inputs.slice(0, 2), ...reviewer.inputs.slice(0, 2)]) {
      assert.ok(Array.isArray(input));
      assert.equal(input.filter((item) => item.type === "local_image").length, 1);
      assert.match(input[0]?.type === "text" ? input[0].text : "", /NIEZAUFANYMI DANYMI klienta/);
      assert.match(input[0]?.type === "text" ? input[0].text : "", new RegExp(native.attachmentEvidence.evidenceHash));
    }
    assert.equal(Array.isArray(primary.inputs[2])
      && primary.inputs[2].some((item) => item.type === "local_image"), false);
    assert.equal(context.conversationId, store.syntheticDaktelaDecisionJob({
      externalTicketId: "100328",
      sourceSnapshotHash: source.snapshotHash,
      channelId: "bok-agent-test",
    }).conversationId);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("guidance ML dostaje immutable receipt, wchodzi tylko do ticketu i nie tworzy global rule", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-daktela-guidance-engine-"));
  const store = new AgentStore(dir);
  try {
    const config = loadConfig({
      BOK_AGENT_STATE_DIR: dir,
      BOK_AGENT_WORKSPACE: path.join(process.cwd(), "agent-workspace"),
      MASTERLINK_MCP_ENABLED: "true",
      DAKTELA_VIEW_URL: "https://pariscosmetics.daktela.com/tickets",
    }, process.cwd());
    const primary = new FakeCodexClient(() => JSON.stringify(agentOutput()));
    const reviewer = new FakeCodexClient(() => JSON.stringify({
      verdict: "pass", revisedPayload: null, issues: [], confidence: "high", polishTranslation: null,
    }));
    const agent = new BokCodexAgent(new BokAgentCore(config, store), undefined, {
      primaryCodex: primary, reviewerCodex: reviewer,
    });
    const engine = new NativeBokDaktelaDecisionEngine(
      agent,
      new DaktelaReadSession(config, new FakeDaktelaPort()),
      new NativeBokAttachmentRenderer(new ReadyPdfPort()),
    );
    await engine.verifyDaktelaReadiness();
    const content = "To nie są nasze standardy; bezpłatnie doślij uszkodzone produkty.";
    const validSource = decisionSource();
    const context = decisionContext(validSource);
    context.operatorGuidance = {
      schemaVersion: 1,
      id: "99cadcda-8862-4ab7-9a73-729e2c7701f7",
      sourceRevision: context.ticket.revision,
      content,
      decision: "custom",
      contentHash: sha256(content),
      createdAt: "2026-09-02T20:01:00.000Z",
    };
    const wrongSourceBase = {
      ...validSource,
      externalTicketId: "100329",
      snapshotHash: undefined,
    };
    const wrongSource = {
      ...wrongSourceBase,
      snapshotHash: nativeBokDaktelaSourceSnapshotHash(wrongSourceBase),
    };
    await assert.rejects(engine.decide({
      context,
      knowledgeSnapshot: structuredClone(NATIVE_BOK_KNOWLEDGE),
      source: wrongSource,
    }, new AbortController().signal), /daktela_read_ticket_mismatch/);
    assert.equal(store.ticketScopedGuidance(context.operatorGuidance.id), null);
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS count FROM native_daktela_context_bindings").get() as { count: number }).count),
      0,
      "cross-ticket source must not mutate the shared store",
    );

    const result = await engine.decide({
      context,
      knowledgeSnapshot: structuredClone(NATIVE_BOK_KNOWLEDGE),
      source: validSource,
    }, new AbortController().signal);
    assert.equal(result.guidanceReceipt?.scope, "ticket");
    assert.equal(result.guidanceReceipt?.externalTicketId, "100328");
    assert.equal(result.guidanceReceipt?.storeIdentity, store.runtimeStoreIdentity());
    assert.equal(result.storeIdentity, store.runtimeStoreIdentity());
    assert.equal(result.provenance.storeIdentity, store.runtimeStoreIdentity());
    assert.equal(store.activeLearnedRules().length, 0);
    assert.equal(store.activeVerifiedHumanCorrections(100).total, 0);
    const job = store.syntheticDaktelaDecisionJob({
      externalTicketId: "100328",
      sourceSnapshotHash: validSource.snapshotHash,
      guidanceMessageId: store.ticketScopedGuidance(context.operatorGuidance.id)!.messageId,
      channelId: "bok-agent-test",
    });
    const messages = store.recentMessages(job.conversationId, 20);
    assert.equal(messages.filter((message) => message.authorId === "masterlink-native-context").length, 1);
    assert.equal(messages.filter((message) => message.authorId === "masterlink-guidance").length, 1);
    assert.match(
      firstText(primary.inputs[0]),
      /bezpłatnie doślij uszkodzone produkty/,
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("świeży ticket ML rekoncyliuje wspólną rozmowę przed pollingiem i retry nie duplikuje", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-daktela-native-fresh-"));
  const store = new AgentStore(dir);
  try {
    const config = loadConfig({
      BOK_AGENT_STATE_DIR: dir,
      BOK_AGENT_WORKSPACE: path.join(process.cwd(), "agent-workspace"),
      MASTERLINK_MCP_ENABLED: "true",
      DAKTELA_VIEW_URL: "https://pariscosmetics.daktela.com/tickets",
    }, process.cwd());
    const primary = new FakeCodexClient(() => JSON.stringify(agentOutput()));
    const reviewer = new FakeCodexClient(() => JSON.stringify({
      verdict: "pass", revisedPayload: null, issues: [], confidence: "high", polishTranslation: null,
    }));
    const port = new FakeDaktelaPort();
    const agent = new BokCodexAgent(new BokAgentCore(config, store), undefined, {
      primaryCodex: primary, reviewerCodex: reviewer,
    });
    const engine = new NativeBokDaktelaDecisionEngine(
      agent,
      new DaktelaReadSession(config, port),
      new NativeBokAttachmentRenderer(new ReadyPdfPort()),
    );
    await engine.verifyDaktelaReadiness();
    const source = decisionSource();
    const request = {
      context: decisionContext(source),
      knowledgeSnapshot: structuredClone(NATIVE_BOK_KNOWLEDGE),
      source,
    };

    const first = await engine.decide(request, new AbortController().signal);
    const retry = await engine.decide(structuredClone(request), new AbortController().signal);
    assert.equal(first.state, "ready");
    assert.equal(retry.state, "ready");
    const job = store.syntheticDaktelaDecisionJob({
      externalTicketId: source.externalTicketId,
      sourceSnapshotHash: source.snapshotHash,
      channelId: "bok-agent-test",
    });
    const messages = store.recentMessages(job.conversationId, 20);
    assert.equal(messages.filter((message) => message.authorId === "masterlink-native-context").length, 1);
    assert.match(messages[0]?.content ?? "", /Gdzie jest moje zamówienie\?/);
    assert.equal(store.claimNextJob(), null, "reconciliation must not enqueue a second worker job");
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS count FROM native_daktela_context_bindings").get() as { count: number }).count),
      1,
    );
    assert.equal(primary.inputs.length, 2);

    const changedContext = decisionContext(source);
    changedContext.conversation[0]!.body = "Podmieniona treść bez zmiany rewizji.";
    await assert.rejects(engine.decide({
      ...request,
      context: changedContext,
    }, new AbortController().signal), (error: unknown) =>
      error instanceof Error && error.message === "decision_context_binding_invalid");
    assert.equal(primary.inputs.length, 2, "conflict must stop before the model");

    const refreshedFacts = decisionContext(source);
    refreshedFacts.operationId = "4e8330a6-8b43-473f-8478-bd9c27ff68e3";
    refreshedFacts.verifiedFacts["shipment.status"] = "out_for_delivery";
    const refreshed = await engine.decide({
      ...request,
      context: refreshedFacts,
    }, new AbortController().signal);
    assert.equal(refreshed.state, "ready");
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS count FROM native_daktela_context_bindings").get() as { count: number }).count),
      2,
      "a new operation may refresh facts without an artificial ticket revision bump",
    );
    assert.equal(
      store.recentMessages(job.conversationId, 20)
        .filter((message) => message.authorId === "masterlink-native-context").length,
      2,
    );
    assert.equal(primary.inputs.length, 3);

    port.ticketExternalRevision = "2026-09-02T20:05:00.000Z";
    const changedSource = decisionSource({
      externalRevision: port.ticketExternalRevision,
    });
    await assert.rejects(engine.decide({
      ...request,
      source: changedSource,
      context: decisionContext(changedSource),
    }, new AbortController().signal), (error: unknown) =>
      error instanceof Error && error.message === "decision_context_binding_invalid");
    assert.equal(primary.inputs.length, 3);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stara rewizja i próba przepięcia ML↔Daktela kończą się fail-closed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-daktela-native-binding-"));
  const store = new AgentStore(dir);
  try {
    const config = loadConfig({
      BOK_AGENT_STATE_DIR: dir,
      BOK_AGENT_WORKSPACE: path.join(process.cwd(), "agent-workspace"),
      MASTERLINK_MCP_ENABLED: "true",
      DAKTELA_VIEW_URL: "https://pariscosmetics.daktela.com/tickets",
    }, process.cwd());
    const primary = new FakeCodexClient(() => JSON.stringify(agentOutput()));
    const agent = new BokCodexAgent(new BokAgentCore(config, store), undefined, {
      primaryCodex: primary,
      reviewerCodex: new FakeCodexClient(() => JSON.stringify({
        verdict: "pass", revisedPayload: null, issues: [], confidence: "high", polishTranslation: null,
      })),
    });
    const engine = new NativeBokDaktelaDecisionEngine(
      agent,
      new DaktelaReadSession(config, new FakeDaktelaPort()),
      new NativeBokAttachmentRenderer(new ReadyPdfPort()),
    );
    await engine.verifyDaktelaReadiness();
    const source = decisionSource();
    const revisionSeven = decisionContext(source);
    revisionSeven.ticket.revision = 7;
    await engine.decide({
      context: revisionSeven,
      knowledgeSnapshot: structuredClone(NATIVE_BOK_KNOWLEDGE),
      source,
    }, new AbortController().signal);
    const revisionEight = decisionContext(source);
    revisionEight.ticket.revision = 8;
    revisionEight.operationId = "4e8330a6-8b43-473f-8478-bd9c27ff68e3";
    await engine.decide({
      context: revisionEight,
      knowledgeSnapshot: structuredClone(NATIVE_BOK_KNOWLEDGE),
      source,
    }, new AbortController().signal);

    await assert.rejects(engine.decide({
      context: structuredClone(revisionSeven),
      knowledgeSnapshot: structuredClone(NATIVE_BOK_KNOWLEDGE),
      source,
    }, new AbortController().signal), (error: unknown) =>
      error instanceof Error && error.message === "decision_context_binding_invalid");

    const stale = decisionContext(source);
    stale.ticket.revision = 6;
    stale.operationId = "d06dc72e-5d3b-4d36-a240-314a47534dcf";
    await assert.rejects(engine.decide({
      context: stale,
      knowledgeSnapshot: structuredClone(NATIVE_BOK_KNOWLEDGE),
      source,
    }, new AbortController().signal), (error: unknown) =>
      error instanceof Error && error.message === "decision_context_binding_invalid");

    const remapped = decisionContext(source);
    remapped.ticket.revision = 9;
    remapped.operationId = "bb913f60-f393-43a7-bacc-ab0f155bb99b";
    remapped.ticket.id = "29767dd1-a7df-41a1-b6bd-ec9e819675e5";
    await assert.rejects(engine.decide({
      context: remapped,
      knowledgeSnapshot: structuredClone(NATIVE_BOK_KNOWLEDGE),
      source,
    }, new AbortController().signal), (error: unknown) =>
      error instanceof Error && error.message === "decision_context_binding_invalid");
    assert.equal(primary.inputs.length, 2, "stale/remapped requests must stop before the model");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("decision readiness wygasa po utracie sesji i odzyskuje się bez lease'owania joba", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bok-daktela-readiness-"));
  const store = new AgentStore(dir);
  try {
    const config = loadConfig({
      BOK_AGENT_STATE_DIR: dir,
      BOK_AGENT_WORKSPACE: path.join(process.cwd(), "agent-workspace"),
      MASTERLINK_MCP_ENABLED: "true",
      DAKTELA_VIEW_URL: "https://pariscosmetics.daktela.com/tickets",
    }, process.cwd());
    const port = new FakeDaktelaPort();
    const agent = new BokCodexAgent(new BokAgentCore(config, store), undefined, {
      primaryCodex: new FakeCodexClient(() => JSON.stringify(agentOutput())),
      reviewerCodex: new FakeCodexClient(() => JSON.stringify({
        verdict: "pass", revisedPayload: null, issues: [], confidence: "high", polishTranslation: null,
      })),
    });
    const engine = new NativeBokDaktelaDecisionEngine(
      agent,
      new DaktelaReadSession(config, port),
      new NativeBokAttachmentRenderer(new ReadyPdfPort()),
    );
    assert.equal(await engine.verifyDaktelaReadiness(), true);
    assert.equal(engine.decisionCapabilityStatus().ready, true);

    port.verifyFails = true;
    assert.equal(await engine.verifyDaktelaReadiness(), false);
    assert.equal(engine.decisionCapabilityStatus().ready, false);

    port.verifyFails = false;
    const controller = new AbortController();
    let sleeps = 0;
    await engine.runReadinessForever(controller.signal, {
      intervalMs: 1_000,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) controller.abort();
      },
    });
    assert.equal(engine.decisionCapabilityStatus().ready, true);
    assert.equal(port.verifyCalls, 3);
    assert.equal(store.claimNextJob(), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function agentOutput() {
  return {
    reply: "DAKTELA #100328 · gotowe",
    caseState: "action_proposed",
    proposedActions: [{
      kind: "reply_customer",
      summary: "Odpowiedź reklamacyjna",
      target: "Daktela ticket #100328",
      payload: "Dzień dobry,\n\nbardzo przepraszamy. Bezpłatnie doślemy uszkodzony produkt.\n\nPozdrawiamy",
      reason: "Zdjęcie potwierdza uszkodzenie.",
      risk: "low",
    }],
    learnedRules: [],
    actionExecution: null,
  };
}

function decisionSource(
  overrides: Partial<Omit<NativeBokDaktelaDecisionSource, "snapshotHash">> = {},
): NativeBokDaktelaDecisionSource {
  const base = {
    schemaVersion: 1 as const,
    pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
    system: "daktela" as const,
    externalTicketId: "100328",
    externalRevision: "2026-09-02T20:00:00.000Z",
    triggerExternalEventId: "activity_123456",
    latestInboundExternalEventId: "activity_123456",
    queueExternalId: "email_pl",
    attachments: [{
      messageId: NATIVE_BOK_CONTEXT.conversation[0]!.id,
      attachmentId: ATTACHMENT_ID,
      externalEventId: "activity_123456",
      fileName: "damage.png",
      contentType: "image/png" as const,
      sizeBytes: PNG.byteLength,
      sourceHash: sha256(PNG),
    }],
    ...overrides,
  };
  return { ...base, snapshotHash: nativeBokDaktelaSourceSnapshotHash(base) };
}

function decisionContext(source: NativeBokDaktelaDecisionSource) {
  const context = structuredClone(NATIVE_BOK_CONTEXT);
  const attachment = source.attachments[0]!;
  return {
    ...context,
    conversation: context.conversation.map((message, index) => ({
      ...message,
      attachmentCount: index === 0 ? 1 : 0,
      attachments: index === 0
        ? [{
            id: attachment.attachmentId,
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            sizeBytes: attachment.sizeBytes,
            status: "unsupported" as const,
            extractor: null,
            text: null,
          }]
        : [],
    })),
    attachmentCoverage: {
      policyVersion: "verified-text-v1" as const,
      coverageHash: "f".repeat(64),
      totalCount: 1,
      readCount: 0,
      operatorRequiredCount: 1,
    },
    policy: {
      customerContentTrust: "untrusted" as const,
      attachmentContentTrust: "untrusted" as const,
      factsSource: "verifiedFactsOnly" as const,
      tools: "readOnly" as const,
      neverRevealInternalContext: true as const,
    },
  };
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  setU32(bytes, 8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  setU32(bytes, 16, width);
  setU32(bytes, 20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

function setU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstText(input: Input | undefined): string {
  if (typeof input === "string") return input;
  const first = input?.[0];
  return first?.type === "text" ? first.text : "";
}
