import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DaktelaReadSession,
  DaktelaReadSessionError,
  type DaktelaAuthenticatedReadPort,
} from "../src/daktela-read-session.js";
import {
  nativeBokDaktelaSourceSnapshotHash,
  type NativeBokDaktelaDecisionSource,
} from "../src/native-bok-attachment-evidence.js";
import { NATIVE_BOK_DECISION_PIPELINE_HASH } from "../src/native-bok-decision-capability.js";

const BYTES = new TextEncoder().encode("fake-jpeg-bytes");
const MESSAGE_ID = "10310b54-06c2-4c1f-84a5-bc19f7c83b10";
const FILE_ID = "987654";
const ATTACHMENT_ID = `daktela-meta:${sha256(FILE_ID)}`;

function source(overrides: Partial<NativeBokDaktelaDecisionSource> = {}) {
  const attachment = {
    messageId: MESSAGE_ID,
    attachmentId: ATTACHMENT_ID,
    externalEventId: "123456",
    fileName: "damage.jpg",
    contentType: "image/jpeg" as const,
    sizeBytes: BYTES.byteLength,
    sourceHash: sha256(BYTES),
  };
  const base = {
    schemaVersion: 1 as const,
    pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
    system: "daktela" as const,
    externalTicketId: "100328",
    externalRevision: "2026-09-02T20:00:00.000Z",
    triggerExternalEventId: "123456",
    latestInboundExternalEventId: "123456",
    queueExternalId: "email_pl",
    attachments: [attachment],
  };
  const complete = { ...base, snapshotHash: nativeBokDaktelaSourceSnapshotHash(base), ...overrides };
  if (overrides.snapshotHash === undefined) {
    return { ...complete, snapshotHash: nativeBokDaktelaSourceSnapshotHash(complete) };
  }
  return complete;
}

class FakeReadPort implements DaktelaAuthenticatedReadPort {
  ticketId = "100328";
  ticketRevision = "2026-09-02T20:00:00.000Z";
  activityTicketId = "100328";
  activityEventId = "123456";
  queueId = "email_pl";
  bytes = BYTES;
  maxConcurrent = 0;
  concurrent = 0;
  calls: string[] = [];
  queueGate: Promise<void> | undefined;
  verifyError: Error | undefined;
  queueError: Error | undefined;
  activitiesError: Error | undefined;
  extraAttachments: Array<{
    externalId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    inline: boolean;
  }> = [];

  async verify() {
    if (this.verifyError) throw this.verifyError;
    return { userType: "agent", profileType: "admin", profileTitle: "Admin" };
  }

  async readQueue() {
    return this.tracked("queue", async () => {
      await this.queueGate;
      if (this.queueError) throw this.queueError;
      return {
        rows: [],
        capabilities: { userType: "agent", profileType: "admin", profileTitle: "Admin" },
      };
    });
  }

  async readTicketActivities() {
    return this.tracked("activities", async () => {
      if (this.activitiesError) throw this.activitiesError;
      return [];
    });
  }

  async openExactTicket() {
    return this.tracked("ticket", async () => ({
      externalId: this.ticketId,
      externalRevision: this.ticketRevision,
    }));
  }

  async readExactActivity() {
    return this.tracked("event", async () => ({
      externalId: this.activityEventId,
      ticketExternalId: this.activityTicketId,
      queueExternalId: this.queueId,
      direction: "inbound" as const,
      attachments: [{
        externalId: FILE_ID,
        fileName: "damage.jpg",
        contentType: "image/jpeg",
        sizeBytes: BYTES.byteLength,
        inline: false,
      }, ...this.extraAttachments],
    }));
  }

  async downloadExactAttachment() {
    return this.tracked("download", async () => this.bytes);
  }

  async close() {}

  private async tracked<T>(name: string, operation: () => Promise<T>): Promise<T> {
    this.calls.push(name);
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      return await operation();
    } finally {
      this.concurrent -= 1;
    }
  }
}

function session(port: FakeReadPort): DaktelaReadSession {
  return new DaktelaReadSession({
    daktelaViewUrl: "https://pariscosmetics.daktela.com/tickets",
    daktelaBrowserCdpUrl: "http://127.0.0.1:9333",
  }, port);
}

test("exact ticket, event, metadata i bajty dają zweryfikowany odczyt", async () => {
  const port = new FakeReadPort();
  const result = await session(port).readExactSource(source(), new AbortController().signal);
  assert.deepEqual(port.calls, ["ticket", "event", "download"]);
  assert.deepEqual(result.attachments[0]?.bytes, BYTES);
  assert.equal(result.source.externalTicketId, "100328");
});

test("wrong-ticket i wrong-event kończą się przed downloadem", async () => {
  for (const mutate of [
    (port: FakeReadPort) => { port.ticketId = "100329"; },
    (port: FakeReadPort) => { port.activityTicketId = "100329"; },
    (port: FakeReadPort) => { port.activityEventId = "123457"; },
    (port: FakeReadPort) => { port.queueId = "email_ee"; },
  ]) {
    const port = new FakeReadPort();
    mutate(port);
    await assert.rejects(
      session(port).readExactSource(source(), new AbortController().signal),
      (error: unknown) =>
        error instanceof DaktelaReadSessionError
        && ["daktela_read_ticket_mismatch", "daktela_read_event_mismatch"].includes(error.code),
    );
    assert.equal(port.calls.includes("download"), false);
  }
});

test("stale source revision jest odrzucana przed activity i modelem", async () => {
  const port = new FakeReadPort();
  port.ticketRevision = "2026-09-02T20:00:01.000Z";
  await assert.rejects(
    session(port).readExactSource(source(), new AbortController().signal),
    (error: unknown) =>
      error instanceof DaktelaReadSessionError && error.code === "daktela_read_revision_stale",
  );
  assert.deepEqual(port.calls, ["ticket"]);
});

test("zmienione bajty i częściowy odczyt nigdy nie zwracają evidence", async () => {
  const port = new FakeReadPort();
  port.bytes = new TextEncoder().encode("changed-content");
  await assert.rejects(
    session(port).readExactSource(source(), new AbortController().signal),
    (error: unknown) =>
      error instanceof DaktelaReadSessionError
      && error.code === "daktela_read_attachment_changed",
  );
});

test("pominięty obraz blokuje partial evidence, techniczny text/plain nie blokuje", async () => {
  const partial = new FakeReadPort();
  partial.extraAttachments.push({
    externalId: "999001",
    fileName: "second.png",
    contentType: "image/png",
    sizeBytes: 123,
    inline: false,
  });
  await assert.rejects(
    session(partial).readExactSource(source(), new AbortController().signal),
    (error: unknown) =>
      error instanceof DaktelaReadSessionError
      && error.code === "daktela_read_attachment_mismatch",
  );
  assert.equal(partial.calls.includes("download"), false);

  const technical = new FakeReadPort();
  technical.extraAttachments.push({
    externalId: "999002",
    fileName: "message.txt",
    contentType: "text/plain",
    sizeBytes: 42,
    inline: false,
  });
  await assert.doesNotReject(
    session(technical).readExactSource(source(), new AbortController().signal),
  );
});

test("monitor i native read są serializowane jednym mutexem", async () => {
  const port = new FakeReadPort();
  let releaseQueue!: () => void;
  port.queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const shared = session(port);
  const monitor = shared.readQueue();
  await new Promise((resolve) => setImmediate(resolve));
  const native = shared.readExactSource(source(), new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.calls, ["queue"]);
  releaseQueue();
  await Promise.all([monitor, native]);
  assert.equal(port.maxConcurrent, 1);
  assert.deepEqual(port.calls, ["queue", "ticket", "event", "download"]);
});

test("mutex pozostaje zajęty przez analizę modeli po exact read", async () => {
  const port = new FakeReadPort();
  const shared = session(port);
  let releaseModel!: () => void;
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  const native = shared.withExactSource(
    source(),
    new AbortController().signal,
    async () => {
      modelStarted();
      await modelGate;
      return "done";
    },
  );
  await started;
  const monitor = shared.readQueue();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.calls.includes("queue"), false);
  releaseModel();
  assert.equal(await native, "done");
  await monitor;
  assert.equal(port.calls.at(-1), "queue");
});

test("każda awaria authenticated read natychmiast wygasza readiness sesji", async () => {
  const port = new FakeReadPort();
  const shared = session(port);
  await shared.verify();
  assert.equal(shared.identityVerified(), true);

  port.queueError = new Error("login expired");
  await assert.rejects(shared.readQueue(), /login expired/);
  assert.equal(shared.identityVerified(), false);

  port.queueError = undefined;
  await shared.readQueue();
  assert.equal(shared.identityVerified(), true);

  port.activitiesError = new Error("browser disconnected");
  await assert.rejects(shared.readTicketActivities("100328"), /browser disconnected/);
  assert.equal(shared.identityVerified(), false);

  port.activitiesError = undefined;
  await shared.verify();
  port.verifyError = new Error("session unauthorized");
  await assert.rejects(shared.verify(), /session unauthorized/);
  assert.equal(shared.identityVerified(), false);
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
