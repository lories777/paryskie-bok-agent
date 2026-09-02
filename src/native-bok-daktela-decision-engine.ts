import { z } from "zod";
import type { BokCodexAgent } from "./codex-agent.js";
import {
  type NativeBokAttachmentEvidence,
  nativeBokDaktelaDecisionSourceSchema,
} from "./native-bok-attachment-evidence.js";
import { NativeBokAttachmentRenderer } from "./native-bok-attachment-renderer.js";
import {
  nativeBokDecisionCapabilityStatus,
  type NativeBokDecisionCapabilityStatus,
} from "./native-bok-decision-capability.js";
import {
  buildNativeBokDecisionResultV2,
  type NativeBokDecisionResultV2,
} from "./native-bok-decision-result.js";
import {
  nativeBokGenerateRequestSchema,
  type NativeBokRuntimeStatus,
} from "./native-bok-contract.js";
import { DaktelaReadSession } from "./daktela-read-session.js";

export const nativeBokDaktelaDecisionRequestV2Schema = z
  .object({
    context: nativeBokGenerateRequestSchema.shape.context,
    knowledgeSnapshot: nativeBokGenerateRequestSchema.shape.knowledgeSnapshot,
    source: nativeBokDaktelaDecisionSourceSchema,
  })
  .strict()
  .superRefine((request, issue) => {
    const legacy = nativeBokGenerateRequestSchema.safeParse({
      context: request.context,
      knowledgeSnapshot: request.knowledgeSnapshot,
    });
    if (!legacy.success) {
      issue.addIssue({ code: "custom", path: ["knowledgeSnapshot"], message: "request_context_invalid" });
    }
  });

export type NativeBokDaktelaDecisionRequestV2 = z.infer<
  typeof nativeBokDaktelaDecisionRequestV2Schema
>;

export interface NativeBokDaktelaReadinessLoopOptions {
  readonly intervalMs?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class NativeBokDaktelaDecisionEngineError extends Error {
  constructor(readonly code:
    | "decision_capability_unavailable"
    | "decision_guidance_binding_invalid",
  readonly retryable: boolean) {
    super(code);
    this.name = "NativeBokDaktelaDecisionEngineError";
  }
}

/**
 * Adapter transportowy do dokładnie tego samego BokCodexAgent.run pipeline'u co Discord.
 * Nie ma własnego promptu, generatora, judge'a ani modelu tłumaczącego wynik.
 */
export class NativeBokDaktelaDecisionEngine {
  constructor(
    readonly agent: BokCodexAgent,
    readonly readSession: DaktelaReadSession,
    readonly renderer: NativeBokAttachmentRenderer = new NativeBokAttachmentRenderer(),
  ) {}

  runtimeStatus(): NativeBokRuntimeStatus {
    return this.agent.nativeInference.runtimeStatus();
  }

  decisionCapabilityStatus(): NativeBokDecisionCapabilityStatus {
    return nativeBokDecisionCapabilityStatus({
      sharedEngine: true,
      daktelaRead: this.readSession.configurationReady() && this.readSession.identityVerified(),
      masterlinkRead: this.agent.core.config.masterlinkMcpEnabled,
      attachmentEvidence: this.renderer.ready(),
      independentJudge: true,
    });
  }

  async verifyDaktelaReadiness(): Promise<boolean> {
    if (!this.readSession.configurationReady()) return false;
    try {
      await this.readSession.verify();
      return true;
    } catch {
      return false;
    }
  }

  async runReadinessForever(
    signal: AbortSignal,
    options: NativeBokDaktelaReadinessLoopOptions = {},
  ): Promise<void> {
    const intervalMs = options.intervalMs ?? 15_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000) {
      throw new Error("decision_readiness_interval_invalid");
    }
    const sleep = options.sleep ?? abortableSleep;
    while (!signal.aborted) {
      try {
        await sleep(intervalMs, signal);
      } catch {
        if (signal.aborted) return;
        throw new Error("decision_readiness_sleep_failed");
      }
      if (signal.aborted) return;
      await this.verifyDaktelaReadiness();
    }
  }

  async decide(
    rawRequest: unknown,
    signal: AbortSignal,
  ): Promise<NativeBokDecisionResultV2> {
    const request = nativeBokDaktelaDecisionRequestV2Schema.parse(rawRequest);
    if (!this.decisionCapabilityStatus().ready) {
      throw new NativeBokDaktelaDecisionEngineError("decision_capability_unavailable", true);
    }
    const guidance = request.context.operatorGuidance ?? undefined;
    if (guidance && guidance.sourceRevision !== request.context.ticket.revision) {
      throw new NativeBokDaktelaDecisionEngineError("decision_guidance_binding_invalid", false);
    }
    let storedGuidance: ReturnType<typeof this.agent.core.store.recordTicketScopedGuidance>
      | undefined;
    let attachmentEvidence: NativeBokAttachmentEvidence | undefined;
    const reviewed = await this.agent.runWithPreparedVisualEvidence(
      signal,
      (execute) => this.readSession.withExactSource(request.source, signal, async (verified) => {
        // Never let an unverified/cross-ticket source mutate even ticket-scoped memory.
        try {
          storedGuidance = guidance
            ? this.agent.core.store.recordTicketScopedGuidance({
                guidanceId: guidance.id,
                guidanceHash: guidance.contentHash,
                externalTicketId: request.source.externalTicketId,
                sourceRevision: guidance.sourceRevision,
                content: guidance.content,
                decision: guidance.decision,
                createdAt: guidance.createdAt,
              })
            : undefined;
        } catch (error) {
          if (error instanceof Error && error.message === "ticket_guidance_conflict") {
            throw new NativeBokDaktelaDecisionEngineError(
              "decision_guidance_binding_invalid",
              false,
            );
          }
          throw error;
        }
        const job = this.agent.core.store.syntheticDaktelaDecisionJob({
          externalTicketId: request.source.externalTicketId,
          sourceSnapshotHash: request.source.snapshotHash,
          ...(storedGuidance ? { guidanceMessageId: storedGuidance.messageId } : {}),
          channelId: this.agent.core.config.daktelaEscalationChannelId ?? "masterlink-native",
        });
        const rendered = await this.renderer.render(verified, signal);
        try {
          const result = await execute(job, rendered);
          attachmentEvidence = rendered.evidence;
          return result;
        } finally {
          await rendered.cleanup();
        }
      }),
    );
    if (!attachmentEvidence) throw new Error("decision_attachment_evidence_missing");
    // Cleanup happened only after both primary and independent reviewer consumed the files.
    return buildNativeBokDecisionResultV2({
      output: reviewed.output,
      source: request.source,
      attachmentEvidence,
      toolEvidenceHash: reviewed.provenance.toolEvidenceHash,
      toolNames: reviewed.provenance.toolNames,
      policyHash: reviewed.provenance.policyHash,
      playbookRevision: reviewed.provenance.playbookRevision,
      correctionsRevision: reviewed.provenance.correctionsRevision,
      ...(storedGuidance ? { guidanceReceipt: storedGuidance.receipt } : {}),
    });
  }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: "resolve" | "reject") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (result === "resolve") resolve();
      else reject(new Error("decision_readiness_interrupted"));
    };
    const timer = setTimeout(() => finish("resolve"), milliseconds);
    const onAbort = () => finish("reject");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
