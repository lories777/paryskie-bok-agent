import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeBokAttachmentEvidenceHash,
  nativeBokAttachmentContentHash,
  nativeBokDaktelaSourceSnapshotHash,
  type NativeBokAttachmentEvidence,
  type NativeBokDaktelaDecisionSource,
} from "../src/native-bok-attachment-evidence.js";
import {
  NATIVE_BOK_ATTACHMENT_POLICY_VERSION,
  NATIVE_BOK_DECISION_PIPELINE_HASH,
} from "../src/native-bok-decision-capability.js";
import {
  buildNativeBokDecisionResultV3,
  nativeBokDecisionResultV3Schema,
} from "../src/native-bok-decision-result.js";
import type { AgentTurnOutput } from "../src/types.js";

const TICKET_ID = "100328";
const MESSAGE_ID = "10310b54-06c2-4c1f-84a5-bc19f7c83b10";
const ATTACHMENT_ID = `daktela-meta:${"a".repeat(64)}`;

test("reviewed exact reply jest ready i nie przenosi runnable payloadów innych akcji", () => {
  const result = buildNativeBokDecisionResultV3({
    output: output(),
    source: source(),
    attachmentEvidence: evidence(),
    toolEvidenceHash: "a".repeat(64),
    toolNames: ["masterlink.ml_get_order", "masterlink.ml_get_order"],
    policyHash: "c".repeat(64),
    playbookRevision: "d".repeat(64),
    correctionsRevision: 7,
    storeIdentity: "9".repeat(64),
  });
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.storeIdentity, "9".repeat(64));
  assert.equal(result.provenance.storeIdentity, result.storeIdentity);
  assert.equal(result.state, "ready");
  assert.equal(result.customerReply?.body, "Dzień dobry,\n\nPaczka jest w drodze.\n\nPozdrawiamy");
  assert.deepEqual(result.reasonCodes, ["reviewed_reply_ready"]);
  assert.deepEqual(result.provenance.toolNames, ["masterlink.ml_get_order"]);
  assert.deepEqual(result.nonExecutableActions, [{
    kind: "masterlink_write",
    summary: "wstrzymaj zamówienie",
    risk: "high",
  }]);
  assert.equal(JSON.stringify(result).includes("MUTATING SECRET PAYLOAD"), false);
});

test("brak review, obcy ticket i stan human zawsze ukrywają customerReply", () => {
  const raw = output();
  raw.caseState = "waiting_for_human";
  raw.proposedActions[0] = {
    ...raw.proposedActions[0]!,
    target: "Daktela ticket #999999",
    qualityReview: undefined,
  };
  const result = buildNativeBokDecisionResultV3({
    output: raw,
    source: source(),
    attachmentEvidence: evidence(),
    toolEvidenceHash: "a".repeat(64),
    toolNames: [],
    policyHash: "c".repeat(64),
    playbookRevision: "d".repeat(64),
    correctionsRevision: 0,
    storeIdentity: "9".repeat(64),
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.customerReply, null);
  assert.deepEqual(result.reasonCodes, [
    "case_requires_human",
    "missing_quality_review",
    "ticket_binding_mismatch",
  ]);
});

test("guidance receipt jest ticket-scoped, strict i nie może być free-form routingiem", () => {
  const result = buildNativeBokDecisionResultV3({
    output: output(),
    source: source(),
    attachmentEvidence: evidence(),
    toolEvidenceHash: "a".repeat(64),
    toolNames: [],
    policyHash: "c".repeat(64),
    playbookRevision: "d".repeat(64),
    correctionsRevision: 1,
    storeIdentity: "9".repeat(64),
    guidanceReceipt: {
      guidanceId: "99cadcda-8862-4ab7-9a73-729e2c7701f7",
      guidanceHash: "e".repeat(64),
      scope: "ticket",
      externalTicketId: TICKET_ID,
      storeReceiptId: "f".repeat(64),
      storeIdentity: "9".repeat(64),
    },
  });
  assert.equal(result.guidanceReceipt?.scope, "ticket");
  assert.equal(result.guidanceReceipt?.storeIdentity, result.provenance.storeIdentity);
  assert.equal(nativeBokDecisionResultV3Schema.safeParse({
    ...result,
    guidanceReceipt: { ...result.guidanceReceipt, channelId: "free-form" },
  }).success, false);
});

test("tampering evidence/review hashes jest odrzucane", () => {
  const result = buildNativeBokDecisionResultV3({
    output: output(),
    source: source(),
    attachmentEvidence: evidence(),
    toolEvidenceHash: "a".repeat(64),
    toolNames: ["chrome-devtools.take_screenshot"],
    policyHash: "c".repeat(64),
    playbookRevision: "d".repeat(64),
    correctionsRevision: 1,
    storeIdentity: "9".repeat(64),
  });
  for (const tampered of [
    { ...result, sourceSnapshotHash: "0".repeat(64) },
    { ...result, storeIdentity: "0".repeat(64) },
    { ...result, provenance: { ...result.provenance, reviewHash: "0".repeat(64) } },
  ]) {
    assert.equal(nativeBokDecisionResultV3Schema.safeParse(tampered).success, false);
  }
});

test("guidance receipt nie może pochodzić z innego wspólnego Store", () => {
  assert.throws(() => buildNativeBokDecisionResultV3({
    output: output(),
    source: source(),
    attachmentEvidence: evidence(),
    toolEvidenceHash: "a".repeat(64),
    toolNames: [],
    policyHash: "c".repeat(64),
    playbookRevision: "d".repeat(64),
    correctionsRevision: 1,
    storeIdentity: "9".repeat(64),
    guidanceReceipt: {
      guidanceId: "99cadcda-8862-4ab7-9a73-729e2c7701f7",
      guidanceHash: "e".repeat(64),
      scope: "ticket",
      externalTicketId: TICKET_ID,
      storeReceiptId: "f".repeat(64),
      storeIdentity: "8".repeat(64),
    },
  }), /guidance_store_identity_mismatch/);
});

function output(): AgentTurnOutput {
  return {
    reply: "DAKTELA #100328 · gotowe",
    caseState: "action_proposed",
    proposedActions: [{
      kind: "reply_customer",
      summary: "Gotowa odpowiedź",
      target: "Daktela ticket #100328",
      payload: "Dzień dobry,\n\nPaczka jest w drodze.\n\nPozdrawiamy",
      reason: "Status potwierdzony w zamówieniu.",
      risk: "low",
      qualityReview: {
        verdict: "revised",
        issues: ["Skrócono tekst."],
        confidence: "high",
      },
    }, {
      kind: "masterlink_write",
      summary: "wstrzymaj zamówienie",
      target: "MUTATING SECRET TARGET",
      payload: "MUTATING SECRET PAYLOAD",
      reason: "Operator musi potwierdzić.",
      risk: "high",
    }],
    actionExecution: null,
  };
}

function source(): NativeBokDaktelaDecisionSource {
  const base = {
    schemaVersion: 1 as const,
    pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
    system: "daktela" as const,
    externalTicketId: TICKET_ID,
    externalRevision: "2026-09-02T20:00:00.000Z",
    triggerExternalEventId: "123456",
    latestInboundExternalEventId: "123456",
    queueExternalId: "email_pl",
    attachments: [{
      messageId: MESSAGE_ID,
      attachmentId: ATTACHMENT_ID,
      externalEventId: "123456",
      fileName: "photo.png",
      contentType: "image/png" as const,
      sizeBytes: 123,
      sourceHash: "b".repeat(64),
    }],
  };
  return { ...base, snapshotHash: nativeBokDaktelaSourceSnapshotHash(base) };
}

function evidence(): NativeBokAttachmentEvidence {
  const receipt = {
    messageId: MESSAGE_ID,
    attachmentId: ATTACHMENT_ID,
    externalEventId: "123456",
    sourceHash: "b".repeat(64),
    mediaKind: "image" as const,
    renderHashes: ["b".repeat(64)],
    contentHash: nativeBokAttachmentContentHash({
      mediaKind: "image",
      sourceHash: "b".repeat(64),
      renderHashes: ["b".repeat(64)],
    }),
    status: "read" as const,
  };
  const base = {
    schemaVersion: 1 as const,
    policyVersion: NATIVE_BOK_ATTACHMENT_POLICY_VERSION,
    pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
    snapshotHash: source().snapshotHash,
    receipts: [receipt],
  };
  return { ...base, evidenceHash: nativeBokAttachmentEvidenceHash(base) };
}
