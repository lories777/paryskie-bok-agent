import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_BOK_ATTACHMENT_POLICY_VERSION,
  NATIVE_BOK_DECISION_PIPELINE,
  NATIVE_BOK_DECISION_PIPELINE_HASH,
  nativeBokDecisionCapabilityStatus,
} from "../src/native-bok-decision-capability.js";

test("decision capability ma przypiętą tożsamość pipeline'u v2", () => {
  assert.equal(NATIVE_BOK_DECISION_PIPELINE, "shared-ml-case-v2");
  assert.equal(NATIVE_BOK_ATTACHMENT_POLICY_VERSION, "authenticated-source-evidence-v2");
  assert.equal(
    NATIVE_BOK_DECISION_PIPELINE_HASH,
    "42cc1247ebf440a60d03a236d378ee195035802a5b513d96eda94cd56d9c86ab",
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
