import { describe, expect, it } from "vitest";
import { CherryCognitiveRuntime, parseCognitiveConfig } from "./runtime.js";

describe("CherryCognitiveRuntime", () => {
  it("normalizes configuration into safe operating bounds", () => {
    const config = parseCognitiveConfig({
      tickIntervalMs: 10,
      persistIntervalMs: 999_999,
      maxWorkingMemory: 2,
      approvalRequiredTools: ["exec", "exec", " delete "],
    });

    expect(config.tickIntervalMs).toBe(1_000);
    expect(config.persistIntervalMs).toBe(300_000);
    expect(config.maxWorkingMemory).toBe(8);
    expect(config.approvalRequiredTools).toEqual(["exec", "delete"]);
  });

  it("turns multimodal observations into a workspace and self-model", () => {
    const runtime = new CherryCognitiveRuntime(parseCognitiveConfig(undefined));

    runtime.observe("agent:test", {
      modality: "sensor",
      summary: "Critical rack temperature alarm at 44C",
      source: "rack-07",
      confidence: 0.95,
    });
    runtime.observe("agent:test", {
      modality: "vision",
      summary: "Camera sees warning light on cooling unit",
      source: "camera-07",
      confidence: 0.72,
    });

    const snapshot = runtime.snapshot("agent:test");
    expect(snapshot.workspace.length).toBeGreaterThan(0);
    expect(["high", "critical"]).toContain(snapshot.selfModel.riskLevel);
    expect(snapshot.fieldSnapshot.activation).toBeGreaterThan(0);
    expect(runtime.buildPromptContext("agent:test")).toContain("Global workspace");
  });

  it("tracks goals and produces a metacognitive reflection", () => {
    const runtime = new CherryCognitiveRuntime(parseCognitiveConfig(undefined));
    const goal = runtime.createGoal("agent:test", "Diagnose cooling anomaly", 0.9);

    runtime.updateGoal("agent:test", goal.id, {
      progress: 0.5,
      notes: "Sensor and camera evidence collected",
    });
    runtime.observe("agent:test", {
      modality: "log",
      summary: "Cooling controller log has intermittent fan timeout",
      source: "syslog",
      confidence: 0.55,
    });

    const reflection = runtime.reflect("agent:test");
    expect(reflection.activeGoals[0]?.id).toBe(goal.id);
    expect(reflection.currentGoal).toBe("Diagnose cooling anomaly");
    expect(reflection.recommendations.length).toBeGreaterThan(0);
  });
});
