import { createHash, timingSafeEqual } from "node:crypto";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AppConfig } from "./config.js";
import {
  MAX_NATIVE_BOK_REQUEST_BYTES,
  NATIVE_BOK_PROVIDER,
  nativeBokGenerateRequestSchema,
  nativeBokJudgeRequestSchema,
  parseGeneratorOutput,
  parseJudgeOutput,
  type NativeBokRuntimeStatus,
} from "./native-bok-contract.js";
import {
  NativeBokCorrectionBindingError,
  type NativeBokInference,
} from "./native-bok-inference.js";
import {
  MAX_NATIVE_OPERATIONAL_DISPATCH_BYTES,
  NATIVE_OPERATIONAL_DISPATCH_SCHEMA_VERSION,
  NativeOperationalActionDispatchError,
  type NativeOperationalActionDispatcher,
  type NativeOperationalActionDispatchResult,
  type NativeOperationalActionDispatchRuntimeStatus,
} from "./native-bok-operational-dispatch.js";
import {
  TICKET_TEAM_ESCALATION_ACTION_TYPES,
  TICKET_TEAM_ESCALATION_DESTINATIONS,
} from "./native-bok-operational-catalog.js";
import { fullNativeBokRuntimeStatus } from "./native-bok-runtime.js";

interface NativeBokInferencePort {
  readonly generatorModel: string;
  readonly judgeModel: string;
  runtimeStatus(): NativeBokRuntimeStatus;
  generate(context: unknown, knowledgeSnapshot: unknown, signal: AbortSignal): Promise<unknown>;
  judge(
    context: unknown,
    draft: unknown,
    knowledgeSnapshot: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
}

interface NativeBokServerConfig {
  readonly token: string;
  readonly maxConcurrency: number;
  readonly timeoutMs: number;
}

interface NativeOperationalActionDispatcherPort {
  runtimeStatus(): NativeOperationalActionDispatchRuntimeStatus;
  dispatch(value: unknown): Promise<NativeOperationalActionDispatchResult>;
}

const DISABLED_OPERATIONAL_DISPATCHER: NativeOperationalActionDispatcherPort = {
  runtimeStatus: () => ({
    schemaVersion: NATIVE_OPERATIONAL_DISPATCH_SCHEMA_VERSION,
    provider: NATIVE_BOK_PROVIDER,
    enabled: false,
    configurationReady: false,
    identityVerified: false,
    ready: false,
    kinds: ["team_escalation"],
    actionTypes: [...TICKET_TEAM_ESCALATION_ACTION_TYPES],
    routeKeys: [...TICKET_TEAM_ESCALATION_DESTINATIONS],
    delivery: "discord-gateway",
    receipt: "shared-agent-store",
  }),
  async dispatch() {
    throw new NativeOperationalActionDispatchError(503, "capability_unavailable");
  },
};

class SafeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "SafeHttpError";
  }
}

export function createNativeBokHttpServer(
  config: AppConfig & { nativeApiToken: string },
  inference: NativeBokInference | NativeBokInferencePort,
  operationalDispatcher?: NativeOperationalActionDispatcher,
): Server {
  return createNativeBokHttpServerForConfig(
    {
      token: config.nativeApiToken,
      maxConcurrency: config.nativeApiMaxConcurrency,
      timeoutMs: config.nativeApiTimeoutMs,
    },
    inference,
    operationalDispatcher,
  );
}

export function createNativeBokHttpServerForConfig(
  config: NativeBokServerConfig,
  inference: NativeBokInferencePort,
  operationalDispatcher: NativeOperationalActionDispatcherPort = DISABLED_OPERATIONAL_DISPATCHER,
): Server {
  let activeRequests = 0;
  const server = http.createServer(async (request, response) => {
    applyNoStoreHeaders(response);
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/healthz" && url.search === "" && request.method === "GET") {
        sendJson(response, 200, { ok: true, provider: NATIVE_BOK_PROVIDER });
        return;
      }

      if (!authorized(request.headers.authorization, config.token)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendError(response, 401, "unauthorized");
        return;
      }
      if (url.pathname === "/v1/bok/runtime" && url.search === "") {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          sendError(response, 405, "method_not_allowed");
          return;
        }
        sendJson(response, 200, fullNativeBokRuntimeStatus(inference, operationalDispatcher));
        return;
      }
      if (
        url.search !== "" ||
        ![
          "/v1/bok/generate",
          "/v1/bok/judge",
          "/v1/bok/actions/dispatch",
        ].includes(url.pathname)
      ) {
        sendError(response, 404, "not_found");
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendError(response, 405, "method_not_allowed");
        return;
      }
      if (activeRequests >= config.maxConcurrency) {
        response.setHeader("Retry-After", "5");
        sendError(response, 429, "busy");
        return;
      }

      const isOperationalDispatch = url.pathname === "/v1/bok/actions/dispatch";
      const body = await readJsonBody(
        request,
        isOperationalDispatch
          ? MAX_NATIVE_OPERATIONAL_DISPATCH_BYTES
          : MAX_NATIVE_BOK_REQUEST_BYTES,
      );
      const disconnect = new AbortController();
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const signal = AbortSignal.any([disconnect.signal, timeout]);
      const abortOnDisconnect = () => disconnect.abort();
      request.once("aborted", abortOnDisconnect);
      response.once("close", () => {
        if (!response.writableEnded) abortOnDisconnect();
      });

      activeRequests += 1;
      try {
        if (isOperationalDispatch) {
          const result = await operationalDispatcher.dispatch(body);
          sendJson(response, 200, {
            ok: true,
            provider: NATIVE_BOK_PROVIDER,
            result,
          });
          return;
        }
        if (url.pathname === "/v1/bok/generate") {
          const parsed = parseGenerateRequest(body);
          const result = parseGeneratorOutput(
            await inference.generate(parsed.context, parsed.knowledgeSnapshot, signal),
            parsed.context,
          );
          sendSuccess(response, result, inference.generatorModel);
          return;
        }
        const parsed = parseJudgeRequest(body);
        const result = parseJudgeOutput(
          await inference.judge(
            parsed.context,
            parsed.draft,
            parsed.knowledgeSnapshot,
            signal,
          ),
          parsed.draft,
        );
        sendSuccess(response, result, inference.judgeModel);
      } catch (error) {
        if (response.destroyed || response.writableEnded) return;
        if (timeout.aborted) {
          sendError(response, 408, "timeout");
          return;
        }
        if (error instanceof SafeHttpError) {
          sendError(response, error.status, error.code);
          return;
        }
        if (error instanceof NativeBokCorrectionBindingError) {
          sendError(response, 409, error.code);
          return;
        }
        if (error instanceof NativeOperationalActionDispatchError) {
          sendError(response, error.status, error.code);
          return;
        }
        // Szczegóły modelu mogą zawierać treść klienta albo dane runtime. Nie trafiają do HTTP/logu.
        sendError(response, 502, isOperationalDispatch ? "dispatch_failed" : "inference_failed");
      } finally {
        activeRequests -= 1;
      }
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof SafeHttpError) {
        sendError(response, error.status, error.code);
        return;
      }
      sendError(response, 400, "invalid_request");
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  return server;
}

function parseGenerateRequest(value: unknown) {
  const parsed = nativeBokGenerateRequestSchema.safeParse(value);
  if (!parsed.success) throw new SafeHttpError(400, "invalid_contract");
  return parsed.data;
}

function parseJudgeRequest(value: unknown) {
  const parsed = nativeBokJudgeRequestSchema.safeParse(value);
  if (!parsed.success) throw new SafeHttpError(400, "invalid_contract");
  try {
    parseGeneratorOutput(parsed.data.draft, parsed.data.context);
  } catch {
    throw new SafeHttpError(400, "invalid_contract");
  }
  return parsed.data;
}

function authorized(header: string | undefined, token: string): boolean {
  const expected = createHash("sha256").update(`Bearer ${token}`, "utf8").digest();
  const actual = createHash("sha256").update(header ?? "", "utf8").digest();
  return timingSafeEqual(actual, expected);
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new SafeHttpError(415, "json_required");
  const contentEncoding = request.headers["content-encoding"]?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new SafeHttpError(415, "content_encoding_unsupported");
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0) {
    throw new SafeHttpError(400, "invalid_content_length");
  }
  if (declared > maximumBytes) {
    request.resume();
    throw new SafeHttpError(413, "request_too_large");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > maximumBytes) {
      request.resume();
      throw new SafeHttpError(413, "request_too_large");
    }
    chunks.push(bytes);
  }
  if (total === 0) throw new SafeHttpError(400, "empty_body");
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } catch {
    throw new SafeHttpError(400, "invalid_json");
  }
}

function sendSuccess(response: ServerResponse, result: unknown, model: string): void {
  sendJson(response, 200, {
    ok: true,
    result,
    provider: NATIVE_BOK_PROVIDER,
    model,
  });
}

function sendError(response: ServerResponse, status: number, code: string): void {
  sendJson(response, status, { ok: false, error: code });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function applyNoStoreHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
}
