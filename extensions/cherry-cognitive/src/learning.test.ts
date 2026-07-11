import { describe, expect, it } from "vitest";
import { AdaptiveLearningEngine, parseLearningConfig } from "./learning.js";
import type { Observation } from "./types.js";

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs-1",
    timestamp: Date.now(),
    modality: "sensor",
    summary: "Rack temperature sample",
    source: "rack-07",
    salience: 0.7,
    novelty: 0.5,
    risk: 0.2,
    uncertainty: 0.2,
    confidence: 0.8,
    ...overrides,
  };
}

describe("AdaptiveLearningEngine", () => {
  it("normalizes learning configuration", () => {
    const config = parseLearningConfig({
      learning: {
        learningRate: 0,
        minimumSamples: 0,
        confidenceFloor: -1,
        confidenceCeiling: 2,
      },
    });

    expect(config.learningRate).toBe(0.01);
    expect(config.minimumSamples).toBe(1);
    expect(config.confidenceFloor).toBe(0);
    expect(config.confidenceCeiling).toBe(1);
  });

  it("learns source reliability and calibrates future confidence", () => {
    const engine = new AdaptiveLearningEngine(
      parseLearningConfig({ learning: { minimumSamples: 2, learningRate: 0.5 } }),
    );
    engine.recordObservation("agent:test", observation({ id: "obs-1", confidence: 0.9 }));
    engine.recordObservation("agent:test", observation({ id: "obs-2", confidence: 0.85 }));

    const calibrated = engine.calibrateObservation("agent:test", {
      modality: "sensor",
      summary: "New rack sample",
      source: "rack-07",
      confidence: 0.4,
      salience: 0.5,
    });

    expect(calibrated.confidence).toBeGreaterThan(0.4);
    expect(calibrated.data?.cognitiveCalibration).toBeDefined();
  });

  it("tracks tool success rate and consecutive failures", () => {
    const engine = new AdaptiveLearningEngine(parseLearningConfig(undefined));
    engine.recordToolOutcome("agent:test", "inspect_vm", true, 100);
    engine.recordToolOutcome("agent:test", "inspect_vm", false, 200, "timeout");
    engine.recordToolOutcome("agent:test", "inspect_vm", false, 300, "timeout");

    const profile = engine.toolReliability("agent:test", "inspect_vm");
    expect(profile?.calls).toBe(3);
    expect(profile?.successRate).toBeCloseTo(1 / 3);
    expect(profile?.consecutiveFailures).toBe(2);
    expect(profile?.lastError).toBe("timeout");
  });

  it("builds prompt guidance for unreliable tools", () => {
    const engine = new AdaptiveLearningEngine(
      parseLearningConfig({ learning: { minimumSamples: 2 } }),
    );
    engine.recordToolOutcome("agent:test", "unstable_tool", false, 100, "error 1");
    engine.recordToolOutcome("agent:test", "unstable_tool", false, 100, "error 2");

    expect(engine.buildPromptContext("agent:test")).toContain("unstable_tool");
  });
});
