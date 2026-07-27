import { describe, expect, it } from "vitest";
import { AutonomyPlanner, parseAutonomyConfig } from "./autonomy.js";
import { MemoryConsolidator, parseConsolidationConfig } from "./consolidation.js";
import { AdaptiveLearningEngine, parseLearningConfig } from "./learning.js";
import { ToolPolicyEngine, parseToolPolicyConfig } from "./policy.js";
import { parseCognitiveConfig } from "./runtime.js";
import { buildCognitiveHealth, renderPrometheusMetrics } from "./telemetry.js";
import { TrackedCognitiveRuntime } from "./tracked-runtime.js";

describe("Cherry Cognitive telemetry", () => {
  it("builds aggregate health and Prometheus metrics", () => {
    const runtime = new TrackedCognitiveRuntime(parseCognitiveConfig(undefined));
    const autonomy = new AutonomyPlanner(parseAutonomyConfig(undefined));
    const memory = new MemoryConsolidator(parseConsolidationConfig(undefined));
    const policy = new ToolPolicyEngine(parseToolPolicyConfig(undefined));
    const learning = new AdaptiveLearningEngine(parseLearningConfig(undefined));

    runtime.observe("agent:test", {
      modality: "sensor",
      summary: "Rack temperature normal at 24C",
      source: "rack-07",
      confidence: 0.92,
    });
    runtime.createGoal("agent:test", "Maintain healthy cooling", 0.8);
    learning.recordToolOutcome("agent:test", "inspect_cooling", true, 120);

    const health = buildCognitiveHealth(runtime, autonomy, memory, policy, learning);
    const metrics = renderPrometheusMetrics(health);

    expect(health.runtimeOperational).toBe(true);
    expect(health.sessions.total).toBe(1);
    expect(health.aggregate.observations).toBeGreaterThan(0);
    expect(health.aggregate.activeGoals).toBe(1);
    expect(metrics).toContain("openclaw_cherry_cognitive_up 1");
    expect(metrics).toContain("openclaw_cherry_cognitive_signal");
    expect(metrics).toContain("tool_success_rate");
  });

  it("reports critical risk without declaring the runtime down", () => {
    const runtime = new TrackedCognitiveRuntime(parseCognitiveConfig(undefined));
    const autonomy = new AutonomyPlanner(parseAutonomyConfig(undefined));
    const memory = new MemoryConsolidator(parseConsolidationConfig(undefined));
    const policy = new ToolPolicyEngine(parseToolPolicyConfig(undefined));
    const learning = new AdaptiveLearningEngine(parseLearningConfig(undefined));

    runtime.observe("agent:critical", {
      modality: "log",
      summary: "Critical shutdown attack outage danger alarm urgent immediately now emergency",
      source: "siem",
      confidence: 0.95,
      salience: 1,
    });

    const health = buildCognitiveHealth(runtime, autonomy, memory, policy, learning);
    const metrics = renderPrometheusMetrics(health);
    expect(health.status).toBe("critical");
    expect(health.runtimeOperational).toBe(true);
    expect(health.sessions.criticalRisk).toBeGreaterThan(0);
    expect(metrics).toContain("openclaw_cherry_cognitive_up 1");
  });
});
