import { createHash } from "node:crypto";

export const NATIVE_BOK_DECISION_CAPABILITY_SCHEMA_VERSION = 2 as const;
export const NATIVE_BOK_DECISION_PIPELINE = "daktela-discord-parity-v1" as const;
export const NATIVE_BOK_ATTACHMENT_POLICY_VERSION = "daktela-cdp-evidence-v1" as const;

/**
 * Kanoniczna tożsamość pipeline'u. Pola operacyjne (ready) nie wchodzą do hasha;
 * hash opisuje wyłącznie kodowany kontrakt bezpieczeństwa, który ML przypina 1:1.
 */
export const NATIVE_BOK_DECISION_PIPELINE_CONTRACT = Object.freeze({
  schemaVersion: NATIVE_BOK_DECISION_CAPABILITY_SCHEMA_VERSION,
  pipeline: NATIVE_BOK_DECISION_PIPELINE,
  attachmentPolicyVersion: NATIVE_BOK_ATTACHMENT_POLICY_VERSION,
  sourceSystem: "daktela" as const,
  acceptedContentTypes: ["application/pdf", "image/jpeg", "image/png"] as const,
  maxAttachments: 10,
  maxAttachmentBytes: 25 * 1024 * 1024,
  maxTotalSourceBytes: 50 * 1024 * 1024,
  maxPdfPages: 10,
  pdfRenderDpi: 144,
  evidence: Object.freeze({
    source: "authenticated-chrome-cdp" as const,
    exactTicket: true,
    exactTriggerEvent: true,
    exactAttachmentEvent: true,
    sourceHashRequired: true,
    renderHashRequired: true,
    sameEvidenceForGenerateAndJudge: true,
    promptContentTrust: "untrusted" as const,
    noWriteControls: true,
  }),
});

export const NATIVE_BOK_DECISION_PIPELINE_HASH = createHash("sha256")
  .update(canonical(NATIVE_BOK_DECISION_PIPELINE_CONTRACT), "utf8")
  .digest("hex");

export interface NativeBokDecisionCapabilityStatus {
  readonly schemaVersion: typeof NATIVE_BOK_DECISION_CAPABILITY_SCHEMA_VERSION;
  readonly pipeline: typeof NATIVE_BOK_DECISION_PIPELINE;
  readonly pipelineHash: string;
  readonly attachmentPolicyVersion: typeof NATIVE_BOK_ATTACHMENT_POLICY_VERSION;
  readonly ready: boolean;
  readonly components: {
    readonly sharedEngine: boolean;
    readonly daktelaRead: boolean;
    readonly masterlinkRead: boolean;
    readonly attachmentEvidence: boolean;
    readonly independentJudge: boolean;
  };
}

export function nativeBokDecisionCapabilityStatus(
  components: NativeBokDecisionCapabilityStatus["components"],
): NativeBokDecisionCapabilityStatus {
  const ready = components.sharedEngine
    && components.daktelaRead
    && components.masterlinkRead
    && components.attachmentEvidence
    && components.independentJudge;
  return Object.freeze({
    schemaVersion: NATIVE_BOK_DECISION_CAPABILITY_SCHEMA_VERSION,
    pipeline: NATIVE_BOK_DECISION_PIPELINE,
    pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
    attachmentPolicyVersion: NATIVE_BOK_ATTACHMENT_POLICY_VERSION,
    ready,
    components: Object.freeze({ ...components }),
  });
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("decision_pipeline_contract_number_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("decision_pipeline_contract_value_invalid");
}
