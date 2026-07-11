import { describe, expect, it } from "vitest";
import { ToolPolicyEngine, parseToolPolicyConfig } from "./policy.js";

describe("ToolPolicyEngine", () => {
  it("normalizes policy configuration", () => {
    const config = parseToolPolicyConfig({
      policy: {
        approvalRiskThreshold: -1,
        blockRiskThreshold: 2,
        maxCallsPerMinute: 0,
        blockedTools: [" Destroy_VM ", "destroy_vm"],
      },
    });

    expect(config.approvalRiskThreshold).toBe(0);
    expect(config.blockRiskThreshold).toBe(1);
    expect(config.maxCallsPerMinute).toBe(1);
    expect(config.blockedTools).toEqual(["destroy_vm"]);
  });

  it("allows read-only diagnostic calls", () => {
    const engine = new ToolPolicyEngine(parseToolPolicyConfig(undefined));
    const decision = engine.evaluate({
      sessionKey: "agent:test",
      toolName: "get_vm_status",
      params: { vmId: 110 },
      cognitiveRiskLevel: "low",
    });

    expect(decision.action).toBe("allow");
    expect(decision.matchedSignals).toContain("read-only-hint");
  });

  it("requires approval for destructive parameters", () => {
    const engine = new ToolPolicyEngine(parseToolPolicyConfig(undefined));
    const decision = engine.evaluate({
      sessionKey: "agent:test",
      toolName: "exec",
      params: { command: "kubectl delete pod api-0" },
      cognitiveRiskLevel: "medium",
    });

    expect(decision.action).toBe("approval");
    expect(decision.risk).toBeGreaterThanOrEqual(engine.config.approvalRiskThreshold);
    expect(decision.matchedSignals.some((signal) => signal.startsWith("destructive:"))).toBe(true);
  });

  it("blocks an explicitly blocked tool", () => {
    const engine = new ToolPolicyEngine(
      parseToolPolicyConfig({ policy: { blockedTools: ["destroy_vm"] } }),
    );
    const decision = engine.evaluate({
      toolName: "destroy_vm",
      params: { vmId: 110 },
      cognitiveRiskLevel: "low",
    });

    expect(decision.action).toBe("block");
    expect(decision.matchedSignals).toContain("blocked-tool:destroy_vm");
  });

  it("downgrades blocks to approval in monitor mode", () => {
    const engine = new ToolPolicyEngine(
      parseToolPolicyConfig({
        policy: {
          mode: "monitor",
          blockedTools: ["destroy_vm"],
        },
      }),
    );
    const decision = engine.evaluate({
      toolName: "destroy_vm",
      params: {},
    });

    expect(decision.action).toBe("approval");
    expect(decision.matchedSignals).toContain("monitor-mode-downgrade");
  });

  it("raises a rate-limit signal", () => {
    const engine = new ToolPolicyEngine(
      parseToolPolicyConfig({ policy: { maxCallsPerMinute: 1 } }),
    );
    engine.evaluate({ toolName: "status", params: {}, sessionKey: "rate:test" });
    const decision = engine.evaluate({
      toolName: "status",
      params: {},
      sessionKey: "rate:test",
    });

    expect(decision.matchedSignals).toContain("rate-limit-exceeded");
    expect(decision.action).not.toBe("allow");
  });
});
