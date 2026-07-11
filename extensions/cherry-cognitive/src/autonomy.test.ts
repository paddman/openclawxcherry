import { describe, expect, it } from "vitest";
import { AutonomyPlanner, parseAutonomyConfig } from "./autonomy.js";
import { parseCognitiveConfig } from "./runtime.js";
import { TrackedCognitiveRuntime } from "./tracked-runtime.js";

describe("AutonomyPlanner", () => {
  it("normalizes autonomy configuration", () => {
    const config = parseAutonomyConfig({
      autonomy: {
        mode: "guarded",
        maxProposalsPerSession: 0,
        proposalTtlMs: 1,
        maximumAutomaticRisk: 2,
      },
    });

    expect(config.mode).toBe("guarded");
    expect(config.maxProposalsPerSession).toBe(1);
    expect(config.proposalTtlMs).toBe(60_000);
    expect(config.maximumAutomaticRisk).toBe(1);
  });

  it("deduplicates equivalent open proposals", () => {
    const planner = new AutonomyPlanner(parseAutonomyConfig(undefined));
    const first = planner.propose("agent:test", {
      title: "Inspect storage latency",
      objective: "Diagnose VM slowdown",
      rationale: "Storage latency is elevated",
      expectedOutcome: "Identify the affected datastore",
      risk: 0.1,
      confidence: 0.7,
      suggestedTool: "inspect_storage",
    });
    const second = planner.propose("agent:test", {
      title: "Inspect storage latency",
      objective: "Diagnose VM slowdown",
      rationale: "A second signal confirms elevated latency",
      expectedOutcome: "Identify the affected datastore",
      risk: 0.2,
      confidence: 0.8,
      evidence: ["latency > 30ms"],
      suggestedTool: "inspect_storage",
    });

    expect(second.id).toBe(first.id);
    expect(planner.list("agent:test")).toHaveLength(1);
    expect(second.confidence).toBe(0.8);
    expect(second.evidence).toContain("latency > 30ms");
  });

  it("requires approval before an approved proposal can be executed", () => {
    const planner = new AutonomyPlanner(parseAutonomyConfig(undefined));
    const proposal = planner.propose("agent:test", {
      title: "Restart failed service",
      objective: "Restore API availability",
      rationale: "The service is not responding",
      expectedOutcome: "API returns healthy status",
      risk: 0.7,
      confidence: 0.8,
      suggestedTool: "restart_service",
    });

    expect(() => planner.markExecuted("agent:test", proposal.id, "done")).toThrow(
      "must be approved",
    );
    const approved = planner.decide("agent:test", proposal.id, "approve", "operator approved");
    expect(approved.status).toBe("approved");
    const executed = planner.markExecuted("agent:test", proposal.id, "service healthy");
    expect(executed.status).toBe("executed");
  });

  it("derives verification proposals from high-risk state", () => {
    const runtime = new TrackedCognitiveRuntime(parseCognitiveConfig(undefined));
    runtime.observe("agent:test", {
      modality: "sensor",
      summary: "Critical shutdown alarm and security incident detected",
      source: "monitoring",
      confidence: 0.72,
      salience: 0.98,
    });
    const state = runtime.snapshot("agent:test");
    const reflection = runtime.reflect("agent:test");
    const planner = new AutonomyPlanner(parseAutonomyConfig(undefined));
    const proposals = planner.deriveFromReflection("agent:test", state, reflection);

    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.some((proposal) => proposal.title.includes("Verify high-risk"))).toBe(true);
  });
});
