import { describe, expect, it } from "vitest";
import { PredictionEngine, parsePredictionConfig } from "./prediction.js";
import type { Observation } from "./types.js";

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs-1",
    timestamp: Date.now(),
    modality: "log",
    summary: "Cooling fan timeout detected",
    source: "syslog",
    salience: 0.8,
    novelty: 0.7,
    risk: 0.6,
    uncertainty: 0.2,
    confidence: 0.9,
    ...overrides,
  };
}

describe("PredictionEngine", () => {
  it("normalizes prediction configuration", () => {
    const config = parsePredictionConfig({
      prediction: {
        defaultHorizonMs: 1,
        maxPredictionsPerSession: 1,
        confirmationSimilarity: 2,
      },
    });

    expect(config.defaultHorizonMs).toBe(10_000);
    expect(config.maxPredictionsPerSession).toBe(8);
    expect(config.confirmationSimilarity).toBe(1);
  });

  it("creates falsifiable pending predictions", () => {
    const engine = new PredictionEngine(parsePredictionConfig(undefined));
    const prediction = engine.create("agent:test", {
      hypothesis: "Cooling controller will report a fan timeout",
      expectedSignal: "fan timeout",
      sourceExpectation: "syslog",
      confidence: 0.75,
      horizonMs: 60_000,
    });

    expect(prediction.status).toBe("pending");
    expect(prediction.confidence).toBe(0.75);
    expect(engine.list("agent:test")).toHaveLength(1);
  });

  it("automatically confirms a matching observation", () => {
    const engine = new PredictionEngine(parsePredictionConfig(undefined));
    const prediction = engine.create("agent:test", {
      hypothesis: "Cooling controller will report a fan timeout",
      expectedSignal: "fan timeout",
      sourceExpectation: "syslog",
      confidence: 0.75,
    });

    const confirmed = engine.evaluateObservation("agent:test", observation());
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.id).toBe(prediction.id);
    expect(confirmed[0]?.status).toBe("confirmed");
    expect(confirmed[0]?.probabilityScore).toBeCloseTo((0.75 - 1) ** 2);
  });

  it("records a refuted prediction and calibration score", () => {
    const engine = new PredictionEngine(parsePredictionConfig(undefined));
    const prediction = engine.create("agent:test", {
      hypothesis: "Storage latency will exceed 50ms",
      expectedSignal: "latency above 50ms",
      confidence: 0.8,
    });

    const resolved = engine.resolve(
      "agent:test",
      prediction.id,
      "refute",
      "Latency remained below 10ms",
      [{ summary: "Storage p95 latency 8ms" }],
    );

    expect(resolved.status).toBe("refuted");
    expect(resolved.probabilityScore).toBeCloseTo(0.8 ** 2);
    expect(engine.stats().meanBrierScore).toBeCloseTo(0.8 ** 2);
  });

  it("includes pending hypotheses in prompt context", () => {
    const engine = new PredictionEngine(parsePredictionConfig(undefined));
    engine.create("agent:test", {
      hypothesis: "The next alert will come from rack-07",
      expectedSignal: "rack-07 alert",
      confidence: 0.6,
    });

    const context = engine.buildPromptContext("agent:test");
    expect(context).toContain("Pending hypotheses are predictions to test");
    expect(context).toContain("rack-07");
  });
});
