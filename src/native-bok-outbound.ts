import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  NATIVE_BOK_PROVIDER,
  nativeBokGenerateRequestSchema,
  parseGeneratorOutput,
  parseJudgeOutput,
  type NativeBokRuntimeStatus,
  type TicketAiGeneratorOutput,
  type TicketAiJudgeOutput,
} from "./native-bok-contract.js";
import { NativeBokCorrectionBindingError } from "./native-bok-inference.js";
import {
  NativeOperationalActionDispatchError,
  nativeOperationalActionEnvelopeSchema,
  type NativeOperationalActionDispatchResult,
  type NativeOperationalActionDispatchRuntimeStatus,
} from "./native-bok-operational-dispatch.js";
import {
  fullNativeBokRuntimeStatus,
  type FullNativeBokRuntimeStatus,
} from "./native-bok-runtime.js";

export const NATIVE_BOK_OUTBOUND_SCHEMA_VERSION = 1 as const;
export const MAX_NATIVE_BOK_LEASE_RESPONSE_BYTES = 1_100_000;

const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_LEASE_SAFETY_MARGIN_MS = 10_000;
const DEFAULT_DISPATCH_RETRY_MS = 5_000;
const DEFAULT_ACTIVE_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_RECONNECT_BACKOFF_MS = 30_000;
const RESULT_EXPIRY_MARGIN_MS = 500;
const MAX_NATIVE_BOK_CONTROL_RESPONSE_BYTES = 4 * 1024;

const leaseBaseShape = {
  jobId: z.string().uuid(),
  leaseToken: z.string().uuid(),
  leaseExpiresAt: z.string().datetime({ offset: true }),
  sourceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contextHash: z.string().regex(SHA256),
  operatorGuidanceHash: z.string().regex(SHA256).nullable(),
  requestHash: z.string().regex(SHA256),
};

const decisionLeaseSchema = z
  .object({
    ...leaseBaseShape,
    kind: z.literal("decision"),
    stages: z.tuple([z.literal("generate"), z.literal("judge")]),
    request: nativeBokGenerateRequestSchema,
  })
  .strict()
  .superRefine((lease, context) => {
    const contextHash = nativeBridgeHash(lease.request.context);
    const guidance = lease.request.context.operatorGuidance;
    const operatorGuidanceHash = guidance === undefined ? null : nativeBridgeHash(guidance);
    const requestHash = nativeBridgeHash({
      kind: "decision",
      sourceRevision: lease.sourceRevision,
      contextHash,
      operatorGuidanceHash,
      request: lease.request,
    });
    if (lease.request.context.ticket.revision !== lease.sourceRevision) {
      context.addIssue({ code: "custom", path: ["sourceRevision"], message: "revision_mismatch" });
    }
    if (lease.contextHash !== contextHash) {
      context.addIssue({ code: "custom", path: ["contextHash"], message: "context_hash_mismatch" });
    }
    if (lease.operatorGuidanceHash !== operatorGuidanceHash) {
      context.addIssue({
        code: "custom",
        path: ["operatorGuidanceHash"],
        message: "operator_guidance_hash_mismatch",
      });
    }
    if (lease.requestHash !== requestHash) {
      context.addIssue({ code: "custom", path: ["requestHash"], message: "request_hash_mismatch" });
    }
  });

const dispatchLeaseSchema = z
  .object({
    ...leaseBaseShape,
    kind: z.literal("dispatch"),
    stages: z.tuple([z.literal("dispatch")]),
    request: nativeOperationalActionEnvelopeSchema,
  })
  .strict()
  .superRefine((lease, context) => {
    const contextHash = nativeBridgeHash({
      ticketId: lease.request.ticket.id,
      sourceRevision: lease.sourceRevision,
      sourceSuggestionId: lease.request.sourceSuggestionId,
    });
    const requestHash = nativeBridgeHash({
      kind: "dispatch",
      sourceRevision: lease.sourceRevision,
      contextHash,
      request: lease.request,
    });
    if (lease.request.sourceRevision !== lease.sourceRevision) {
      context.addIssue({ code: "custom", path: ["sourceRevision"], message: "revision_mismatch" });
    }
    if (lease.operatorGuidanceHash !== null) {
      context.addIssue({
        code: "custom",
        path: ["operatorGuidanceHash"],
        message: "operator_guidance_not_allowed",
      });
    }
    if (lease.contextHash !== contextHash) {
      context.addIssue({ code: "custom", path: ["contextHash"], message: "context_hash_mismatch" });
    }
    if (lease.requestHash !== requestHash) {
      context.addIssue({ code: "custom", path: ["requestHash"], message: "request_hash_mismatch" });
    }
  });

export const nativeOutboundLeaseResponseSchema = z
  .object({
    ok: z.literal(true),
    schemaVersion: z.literal(NATIVE_BOK_OUTBOUND_SCHEMA_VERSION),
    lease: z.union([decisionLeaseSchema, dispatchLeaseSchema]).nullable(),
  })
  .strict();

const nativeOutboundResultResponseSchema = z
  .object({
    ok: z.literal(true),
    schemaVersion: z.literal(NATIVE_BOK_OUTBOUND_SCHEMA_VERSION),
    deduplicated: z.boolean(),
  })
  .strict();

const nativeOutboundHeartbeatResponseSchema = z
  .object({
    ok: z.literal(true),
    schemaVersion: z.literal(NATIVE_BOK_OUTBOUND_SCHEMA_VERSION),
    provider: z.literal(NATIVE_BOK_PROVIDER),
    runtimeIdentity: z.string().uuid(),
    storeIdentity: z.string().regex(SHA256),
    statusHash: z.string().regex(SHA256),
  })
  .strict();

const nativeOutboundResultConflictResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z.enum(["lease_lost", "result_conflict"]),
  })
  .strict();

export type NativeBokOutboundLease = NonNullable<
  z.infer<typeof nativeOutboundLeaseResponseSchema>["lease"]
>;

type NativeBokOutboundResult =
  | {
      schemaVersion: 1;
      jobId: string;
      leaseToken: string;
      requestHash: string;
      kind: "decision";
      outcome:
        | {
            status: "completed";
            result: { draft: TicketAiGeneratorOutput; judgement: TicketAiJudgeOutput };
          }
        | { status: "failed"; errorCode: string; retryable: boolean };
    }
  | {
      schemaVersion: 1;
      jobId: string;
      leaseToken: string;
      requestHash: string;
      kind: "dispatch";
      outcome:
        | { status: "completed"; result: NativeOperationalActionDispatchResult }
        | { status: "failed"; errorCode: string; retryable: boolean };
    };

export interface NativeBokOutboundInferencePort {
  runtimeStatus(): NativeBokRuntimeStatus;
  generate(
    context: unknown,
    knowledgeSnapshot: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  judge(
    context: unknown,
    draft: unknown,
    knowledgeSnapshot: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface NativeBokOutboundDispatcherPort {
  runtimeStatus(): NativeOperationalActionDispatchRuntimeStatus;
  dispatch(envelope: unknown): Promise<NativeOperationalActionDispatchResult>;
}

export interface NativeBokOutboundPollerOptions {
  readonly endpointUrl: string;
  readonly token: string;
  readonly requestTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly fetcher?: typeof fetch;
  readonly instanceId?: string;
  readonly processStartedAt?: string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly heartbeatSleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly log?: (code: string) => void;
  readonly leaseSafetyMarginMs?: number;
  readonly dispatchRetryMs?: number;
  readonly activeHeartbeatIntervalMs?: number;
}

export type NativeBokOutboundTickResult =
  | "idle"
  | "completed"
  | "failed"
  | "lease_lost";

export class NativeBokOutboundPollerError extends Error {
  constructor(
    readonly code:
      | "native_outbound_network"
      | "native_outbound_timeout"
      | "native_outbound_rejected"
      | "native_outbound_result_conflict"
      | "native_outbound_malformed",
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "NativeBokOutboundPollerError";
  }
}

class NativeBokOutboundShutdown extends Error {}

export class NativeBokOutboundPoller {
  readonly instanceId: string;
  readonly processStartedAt: string;
  private readonly leaseUrl: string;
  private readonly heartbeatUrl: string;
  private readonly resultUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly heartbeatSleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly log: (code: string) => void;
  private readonly leaseSafetyMarginMs: number;
  private readonly dispatchRetryMs: number;
  private readonly activeHeartbeatIntervalMs: number;

  constructor(
    private readonly inference: NativeBokOutboundInferencePort,
    private readonly dispatcher: NativeBokOutboundDispatcherPort,
    private readonly options: NativeBokOutboundPollerOptions,
  ) {
    this.leaseUrl = nativeBokOutboundUrl(options.endpointUrl, "/api/bok-runtime/v1/lease");
    this.heartbeatUrl = nativeBokOutboundUrl(
      options.endpointUrl,
      "/api/bok-runtime/v1/heartbeat",
    );
    this.resultUrl = nativeBokOutboundUrl(options.endpointUrl, "/api/bok-runtime/v1/result");
    this.fetcher = options.fetcher ?? fetch;
    this.instanceId = options.instanceId ?? randomUUID();
    this.processStartedAt = options.processStartedAt ?? new Date().toISOString();
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.heartbeatSleep = options.heartbeatSleep ?? abortableSleep;
    this.log = options.log ?? ((code) => console.warn(`[bok-native-outbound] ${code}`));
    this.leaseSafetyMarginMs = options.leaseSafetyMarginMs ?? DEFAULT_LEASE_SAFETY_MARGIN_MS;
    this.dispatchRetryMs = options.dispatchRetryMs ?? DEFAULT_DISPATCH_RETRY_MS;
    this.activeHeartbeatIntervalMs =
      options.activeHeartbeatIntervalMs ?? DEFAULT_ACTIVE_HEARTBEAT_INTERVAL_MS;
    if (!z.string().uuid().safeParse(this.instanceId).success) {
      throw new Error("native_outbound_instance_id_invalid");
    }
    if (!z.string().datetime({ offset: true }).safeParse(this.processStartedAt).success) {
      throw new Error("native_outbound_process_started_at_invalid");
    }
    if (!options.token || options.token.trim() !== options.token) {
      throw new Error("native_outbound_token_invalid");
    }
    if (
      !Number.isInteger(options.requestTimeoutMs) ||
      options.requestTimeoutMs < 1_000 ||
      options.requestTimeoutMs > 60_000 ||
      !Number.isInteger(options.pollIntervalMs) ||
      options.pollIntervalMs < 1_000 ||
      options.pollIntervalMs > 60_000 ||
      !Number.isInteger(this.activeHeartbeatIntervalMs) ||
      this.activeHeartbeatIntervalMs < 1 ||
      this.activeHeartbeatIntervalMs > 60_000
    ) {
      throw new Error("native_outbound_timing_invalid");
    }
  }

  runtimeStatus(): FullNativeBokRuntimeStatus {
    return fullNativeBokRuntimeStatus(this.inference, this.dispatcher);
  }

  async runOnce(signal: AbortSignal): Promise<NativeBokOutboundTickResult> {
    if (signal.aborted) throw new NativeBokOutboundShutdown();
    const response = await this.postJson(
      this.leaseUrl,
      JSON.stringify({
        schemaVersion: NATIVE_BOK_OUTBOUND_SCHEMA_VERSION,
        maxJobs: 1,
        poller: {
          instanceId: this.instanceId,
          processStartedAt: this.processStartedAt,
        },
        runtime: this.runtimeStatus(),
      }),
      signal,
      MAX_NATIVE_BOK_LEASE_RESPONSE_BYTES,
    );
    const parsed = nativeOutboundLeaseResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new NativeBokOutboundPollerError("native_outbound_malformed", true);
    }
    const lease = parsed.data.lease;
    if (!lease) return "idle";

    const activeHeartbeatController = new AbortController();
    const activeHeartbeatSignal = AbortSignal.any([signal, activeHeartbeatController.signal]);
    const activeHeartbeat = this.runActiveHeartbeat(activeHeartbeatSignal);
    try {
      const leaseExpiresAt = Date.parse(lease.leaseExpiresAt);
      const processingDeadline = leaseExpiresAt - this.leaseSafetyMarginMs;
      let outcome: NativeBokOutboundResult["outcome"];
      if (processingDeadline <= this.now()) {
        outcome = { status: "failed", errorCode: "lease_deadline", retryable: true };
      } else {
        const processingSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, processingDeadline - this.now())),
        ]);
        try {
          outcome = lease.kind === "decision"
            ? await this.processDecision(lease, processingSignal)
            : await this.processDispatch(lease, processingSignal);
        } catch (error) {
          if (signal.aborted) throw new NativeBokOutboundShutdown();
          outcome = classifyProcessingFailure(error, processingSignal.aborted);
        }
      }

      const result = {
        schemaVersion: NATIVE_BOK_OUTBOUND_SCHEMA_VERSION,
        jobId: lease.jobId,
        leaseToken: lease.leaseToken,
        requestHash: lease.requestHash,
        kind: lease.kind,
        outcome,
      } as NativeBokOutboundResult;
      const acknowledged = await this.postResultUntilSettled(
        JSON.stringify(result),
        leaseExpiresAt,
        signal,
      );
      if (!acknowledged) return "lease_lost";
      return outcome.status === "completed" ? "completed" : "failed";
    } finally {
      activeHeartbeatController.abort();
      await activeHeartbeat;
    }
  }

  async runForever(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const result = await this.runOnce(signal);
        consecutiveFailures = 0;
        if (result === "idle" || result === "lease_lost") {
          await this.sleep(this.options.pollIntervalMs, signal);
        }
      } catch (error) {
        if (signal.aborted || error instanceof NativeBokOutboundShutdown) break;
        consecutiveFailures += 1;
        const code = error instanceof NativeBokOutboundPollerError
          ? error.code
          : "native_outbound_malformed";
        this.log(code);
        await this.sleep(reconnectBackoffMs(this.options.pollIntervalMs, consecutiveFailures), signal)
          .catch((sleepError) => {
            if (!signal.aborted) throw sleepError;
          });
      }
    }
  }

  private async processDecision(
    lease: Extract<NativeBokOutboundLease, { kind: "decision" }>,
    signal: AbortSignal,
  ): Promise<Extract<NativeBokOutboundResult["outcome"], { status: "completed" }>> {
    const draft = parseGeneratorOutput(
      await this.inference.generate(
        lease.request.context,
        lease.request.knowledgeSnapshot,
        signal,
      ),
      lease.request.context,
    );
    const judgement = parseJudgeOutput(
      await this.inference.judge(
        lease.request.context,
        draft,
        lease.request.knowledgeSnapshot,
        signal,
      ),
      draft,
    );
    return { status: "completed", result: { draft, judgement } };
  }

  private async processDispatch(
    lease: Extract<NativeBokOutboundLease, { kind: "dispatch" }>,
    signal: AbortSignal,
  ): Promise<Extract<NativeBokOutboundResult["outcome"], { status: "completed" }>> {
    while (!signal.aborted) {
      const result = await this.dispatcher.dispatch(lease.request);
      if (result.status === "sent") return { status: "completed", result };
      await this.sleep(this.dispatchRetryMs, signal);
    }
    throw new Error("dispatch_deadline");
  }

  private async runActiveHeartbeat(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.heartbeatSleep(this.activeHeartbeatIntervalMs, signal);
      } catch (error) {
        if (signal.aborted || error instanceof NativeBokOutboundShutdown) return;
        throw error;
      }
      if (signal.aborted) return;
      try {
        await this.postHeartbeat(signal);
      } catch (error) {
        if (signal.aborted || error instanceof NativeBokOutboundShutdown) return;
        const code = error instanceof NativeBokOutboundPollerError
          ? error.code
          : "native_outbound_malformed";
        this.log(`heartbeat_${code}`);
      }
    }
  }

  private async postHeartbeat(signal: AbortSignal): Promise<void> {
    const runtime = this.runtimeStatus();
    const response = await this.postJson(
      this.heartbeatUrl,
      JSON.stringify({
        schemaVersion: NATIVE_BOK_OUTBOUND_SCHEMA_VERSION,
        poller: {
          instanceId: this.instanceId,
          processStartedAt: this.processStartedAt,
        },
        runtime,
      }),
      signal,
      MAX_NATIVE_BOK_CONTROL_RESPONSE_BYTES,
    );
    const parsed = nativeOutboundHeartbeatResponseSchema.safeParse(response);
    if (
      !parsed.success
      || parsed.data.runtimeIdentity !== this.instanceId
      || parsed.data.storeIdentity !== runtime.store.identity
      || parsed.data.statusHash !== nativeBridgeHash(runtime)
    ) {
      throw new NativeBokOutboundPollerError("native_outbound_malformed", true);
    }
  }

  private async postResultUntilSettled(
    serialized: string,
    leaseExpiresAt: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    let attempt = 0;
    while (!signal.aborted && this.now() < leaseExpiresAt - RESULT_EXPIRY_MARGIN_MS) {
      attempt += 1;
      try {
        const response = await this.postJson(
          this.resultUrl,
          serialized,
          signal,
          MAX_NATIVE_BOK_CONTROL_RESPONSE_BYTES,
          true,
        );
        if (response === LEASE_LOST) return false;
        const parsed = nativeOutboundResultResponseSchema.safeParse(response);
        if (!parsed.success) {
          throw new NativeBokOutboundPollerError("native_outbound_malformed", true);
        }
        return true;
      } catch (error) {
        if (signal.aborted) throw new NativeBokOutboundShutdown();
        if (error instanceof NativeBokOutboundPollerError && !error.retryable) throw error;
        const delay = Math.min(5_000, 250 * 2 ** Math.min(attempt - 1, 5));
        if (this.now() + delay >= leaseExpiresAt - RESULT_EXPIRY_MARGIN_MS) return false;
        await this.sleep(delay, signal);
      }
    }
    if (signal.aborted) throw new NativeBokOutboundShutdown();
    return false;
  }

  private async postJson(
    url: string,
    serialized: string,
    signal: AbortSignal,
    maximumResponseBytes: number,
    parseResultConflict = false,
  ): Promise<unknown | typeof LEASE_LOST> {
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.options.requestTimeoutMs),
    ]);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
          "User-Agent": "Paryskie-BOK-Agent/0.1",
        },
        body: serialized,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: requestSignal,
      });
    } catch {
      if (signal.aborted) throw new NativeBokOutboundShutdown();
      throw new NativeBokOutboundPollerError(
        requestSignal.aborted ? "native_outbound_timeout" : "native_outbound_network",
        true,
      );
    }
    if (response.status === 409 && parseResultConflict) {
      const body = await readBoundedJson(response, maximumResponseBytes);
      const parsed = nativeOutboundResultConflictResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new NativeBokOutboundPollerError("native_outbound_malformed", false);
      }
      if (parsed.data.error === "lease_lost") return LEASE_LOST;
      throw new NativeBokOutboundPollerError("native_outbound_result_conflict", false);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new NativeBokOutboundPollerError("native_outbound_rejected", retryable);
    }
    return readBoundedJson(response, maximumResponseBytes);
  }
}

const LEASE_LOST = Symbol("lease_lost");

export function nativeBridgeHash(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function nativeBokOutboundUrl(endpointUrl: string, pathname: string): string {
  const url = new URL(endpointUrl);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("native_outbound_url_invalid");
  }
  if (
    url.protocol !== "https:" &&
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
  ) {
    throw new Error("native_outbound_url_insecure");
  }
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function reconnectBackoffMs(pollIntervalMs: number, consecutiveFailures: number): number {
  return Math.min(
    MAX_RECONNECT_BACKOFF_MS,
    Math.max(1_000, pollIntervalMs) * 2 ** Math.min(Math.max(0, consecutiveFailures - 1), 5),
  );
}

function classifyProcessingFailure(
  error: unknown,
  deadlineReached: boolean,
): { status: "failed"; errorCode: string; retryable: boolean } {
  if (deadlineReached) {
    return { status: "failed", errorCode: "lease_deadline", retryable: true };
  }
  if (error instanceof NativeOperationalActionDispatchError) {
    return {
      status: "failed",
      errorCode: error.code,
      retryable: error.code === "capability_unavailable",
    };
  }
  if (error instanceof NativeBokCorrectionBindingError) {
    return { status: "failed", errorCode: error.code, retryable: false };
  }
  return { status: "failed", errorCode: "native_execution_failed", retryable: true };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("native_outbound_canonical_number_invalid");
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
  throw new Error("native_outbound_canonical_value_invalid");
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new NativeBokOutboundPollerError("native_outbound_malformed", true);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new NativeBokOutboundPollerError("native_outbound_malformed", true);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new NativeBokOutboundPollerError("native_outbound_malformed", true);
  const decoder = new TextDecoder();
  let raw = "";
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new NativeBokOutboundPollerError("native_outbound_malformed", true);
    }
    raw += decoder.decode(chunk.value, { stream: true });
  }
  raw += decoder.decode();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new NativeBokOutboundPollerError("native_outbound_malformed", true);
  }
}

export function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new NativeBokOutboundShutdown());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new NativeBokOutboundShutdown());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function assertNativeOutboundProvider(status: FullNativeBokRuntimeStatus): void {
  if (status.provider !== NATIVE_BOK_PROVIDER) throw new Error("native_runtime_provider_mismatch");
}
