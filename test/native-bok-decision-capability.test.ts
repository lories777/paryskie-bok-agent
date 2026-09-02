import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_BOK_ATTACHMENT_POLICY_VERSION,
  NATIVE_BOK_DECISION_PIPELINE,
  NATIVE_BOK_DECISION_PIPELINE_HASH,
  nativeBokDecisionCapabilityStatus,
} from "../src/native-bok-decision-capability.js";

test("decision capability ma przypiętą tożsamość pipeline'u v2", () => {
  assert.equal(NATIVE_BOK_DECISION_PIPELINE, "daktela-discord-parity-v1");
  assert.equal(NATIVE_BOK_ATTACHMENT_POLICY_VERSION, "daktela-cdp-evidence-v1");
  assert.equal(
    NATIVE_BOK_DECISION_PIPELINE_HASH,
    "7c0c38e7e421ae28918dee136e14d58b02cf9174355233606b4f72e1df43241c",
  );
});

test("decision ready jest koniunkcją wszystkich dowodów runtime", () => {
  const ready = nativeBokDecisionCapabilityStatus({
    sharedEngine: true,
    daktelaRead: true,
    masterlinkRead: true,
    attachmentEvidence: true,
    independentJudge: true,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.schemaVersion, 2);

  for (const key of [
    "sharedEngine",
    "daktelaRead",
    "masterlinkRead",
    "attachmentEvidence",
    "independentJudge",
  ] as const) {
    assert.equal(
      nativeBokDecisionCapabilityStatus({ ...ready.components, [key]: false }).ready,
      false,
    );
  }
});
