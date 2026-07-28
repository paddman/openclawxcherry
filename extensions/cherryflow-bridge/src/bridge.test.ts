import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../api.js";
import {
  CherryFlowBridgeError,
  createCherryFlowAgentBridge,
  extractAgentOutput,
} from "./bridge.js";

function createSubagent(): PluginRuntime["subagent"] {
  return {
    run: vi.fn(async () => ({ runId: "runtime-run-1" })),
    waitForRun: vi.fn(async () => ({ status: "ok" as const })),
    getSessionMessages: vi.fn(async () => ({
      messages: [
        { role: "user", content: "Inspect the host" },
        { role: "assistant", content: [{ type: "text", text: "Host is healthy" }] },
      ],
    })),
    getSession: vi.fn(async () => ({ messages: [] })),
    deleteSession: vi.fn(async () => undefined),
  };
}

function createBridge(subagent = createSubagent()) {
  return {
    bridge: createCherryFlowAgentBridge({
      subagent,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      allowedAgentIds: ["linux-doctor"],
      maxConcurrentRuns: 2,
      defaultTimeoutMs: 10_000,
      maxTimeoutMs: 60_000,
      runTtlMs: 60_000,
      retainSessions: true,
    }),
    subagent,
  };
}

describe("CherryFlow agent bridge", () => {
  it("runs an OpenClaw agent and exposes the final assistant text", async () => {
    const { bridge, subagent } = createBridge();
    const created = bridge.createRun({
      agentId: "linux-doctor",
      prompt: "Inspect the host",
      context: { host: "server-01" },
      idempotencyKey: "workflow-1-node-1",
    });

    await vi.waitFor(() => {
      expect(bridge.getRun(created.runId)?.status).toBe("completed");
    });

    expect(bridge.getRun(created.runId)).toMatchObject({
      runId: created.runId,
      status: "completed",
      output: { text: "Host is healthy" },
    });
    expect(subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringContaining("agent:linux-doctor:cherryflow:"),
        idempotencyKey: "workflow-1-node-1",
        deliver: false,
      }),
    );
  });

  it("returns the existing run for an identical idempotent request", () => {
    const { bridge, subagent } = createBridge();
    const request = {
      agentId: "linux-doctor",
      prompt: "Inspect the host",
      idempotencyKey: "same-key",
    };
    const first = bridge.createRun(request);
    const second = bridge.createRun(request);

    expect(second.runId).toBe(first.runId);
    expect(subagent.run).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of an idempotency key with a different request", () => {
    const { bridge } = createBridge();
    bridge.createRun({
      agentId: "linux-doctor",
      prompt: "Inspect host A",
      idempotencyKey: "conflicting-key",
    });

    expect(() =>
      bridge.createRun({
        agentId: "linux-doctor",
        prompt: "Inspect host B",
        idempotencyKey: "conflicting-key",
      }),
    ).toThrowError(CherryFlowBridgeError);
  });

  it("blocks agent ids outside the configured allowlist", () => {
    const { bridge } = createBridge();
    expect(() =>
      bridge.createRun({
        agentId: "dangerous-agent",
        prompt: "Run an action",
        idempotencyKey: "blocked-agent",
      }),
    ).toThrow(/not allowed/);
  });

  it("extracts text from common assistant transcript shapes", () => {
    expect(
      extractAgentOutput([
        { role: "assistant", content: [{ type: "text", text: "first" }, { text: "second" }] },
      ]),
    ).toEqual({ text: "first\nsecond" });
  });
});
