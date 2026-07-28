import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginHttpRouteHandler } from "../api.js";
import {
  CherryFlowBridgeError,
  type CherryFlowAgentBridge,
  type CherryFlowAgentRunRequest,
} from "./bridge.js";

const RUN_PATH_PREFIX = "/api/agents/runs/";

type HttpOptions = {
  bridge: CherryFlowAgentBridge;
  token?: string;
  maxBodyBytes: number;
};

function sendJson(res: ServerResponse, statusCode: number, body: unknown): true {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
  return true;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function secureTokenEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function authorize(req: IncomingMessage, res: ServerResponse, token: string | undefined): boolean {
  if (!token) {
    sendJson(res, 503, {
      error: "CherryFlow bridge token is not configured",
      code: "bridge_token_missing",
    });
    return false;
  }
  if (!secureTokenEquals(headerValue(req, "x-openclaw-token"), token)) {
    sendJson(res, 401, { error: "Unauthorized", code: "unauthorized" });
    return false;
  }
  return true;
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      throw new CherryFlowBridgeError(413, `request body exceeds ${maxBodyBytes} bytes`);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new CherryFlowBridgeError(400, "JSON request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CherryFlowBridgeError(400, "request body must be valid JSON");
  }
}

function toRunRequest(value: unknown): CherryFlowAgentRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CherryFlowBridgeError(400, "request body must be a JSON object");
  }
  const body = value as Record<string, unknown>;
  return {
    agentId: typeof body.agentId === "string" ? body.agentId : "",
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
    ...(body.context !== undefined ? { context: body.context as Record<string, unknown> } : {}),
    ...(body.timeoutMs !== undefined ? { timeoutMs: Number(body.timeoutMs) } : {}),
  };
}

function handleError(res: ServerResponse, error: unknown): true {
  if (error instanceof CherryFlowBridgeError) {
    return sendJson(res, error.statusCode, { error: error.message, code: "bridge_request_rejected" });
  }
  const message = error instanceof Error ? error.message : "Internal bridge error";
  return sendJson(res, 500, { error: message.slice(0, 500), code: "bridge_internal_error" });
}

export function createCherryFlowHttpHandlers(options: HttpOptions): {
  createRun: OpenClawPluginHttpRouteHandler;
  getRun: OpenClawPluginHttpRouteHandler;
  health: OpenClawPluginHttpRouteHandler;
} {
  return {
    async createRun(req, res) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
      if (!authorize(req, res, options.token)) return true;
      try {
        const request = toRunRequest(await readJsonBody(req, options.maxBodyBytes));
        return sendJson(res, 202, options.bridge.createRun(request));
      } catch (error) {
        return handleError(res, error);
      }
    },

    getRun(req, res) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
      if (!authorize(req, res, options.token)) return true;
      try {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (!pathname.startsWith(RUN_PATH_PREFIX)) return false;
        const encodedRunId = pathname.slice(RUN_PATH_PREFIX.length);
        if (!encodedRunId || encodedRunId.includes("/")) {
          return sendJson(res, 404, { error: "Run not found", code: "run_not_found" });
        }
        const run = options.bridge.getRun(decodeURIComponent(encodedRunId));
        return run
          ? sendJson(res, 200, run)
          : sendJson(res, 404, { error: "Run not found", code: "run_not_found" });
      } catch (error) {
        return handleError(res, error);
      }
    },

    health(req, res) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
      if (!authorize(req, res, options.token)) return true;
      return sendJson(res, 200, options.bridge.getHealth());
    },
  };
}
