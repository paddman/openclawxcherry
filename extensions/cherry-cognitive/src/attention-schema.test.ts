import { describe, expect, it } from "vitest";
import { AttentionSchemaEngine, parseAttentionSchemaConfig } from "./attention-schema.js";
import { parseCognitiveConfig } from "./runtime.js";
import { TrackedCognitiveRuntime } from "./tracked-runtime.js";

describe("AttentionSchemaEngine", () => {
  it("normalizes attention configuration", () => {
    const config = parseAttentionSchemaConfig({
      attention: {
        capacity: 0,
        contenderLimit: 1000,
        suppressedLimit: -1,
        reflexRiskThreshold: 2,
      },
    });

    expect(config.capacity).toBe(1);
    expect(config.contenderLimit).toBe(64);
    expect(config.suppressedLimit).toBe(0);
    expect(config.reflexRiskThreshold).toBe(1);
  });

  it("explains why a signal became the dominant focus", () => {
    const runtime = new TrackedCognitiveRuntime(parseCognitiveConfig(undefined));
    runtime.observe("agent:test", {
      modality: "sensor",
      summary: "Rack temperature warning at 39C",
      source: "rack-07",
      confidence: 0.9,
      salience: 0.75,
    });
    runtime.observe("agent:test", {
      modality: "log",
      summary: "Critical shutdown attack outage danger alarm urgent now",
      source: "siem",
      confidence: 0.95,
      salience: 1,
    });

    const engine = new AttentionSchemaEngine(parseAttentionSchemaConfig(undefined));
    const schema = engine.inspect(runtime.snapshot("agent:test"));

    expect(schema.mode).toBe("reflex");
    expect(schema.dominantFocus).toContain("Critical shutdown");
    expect(schema.selectionExplanation).toContain("Focus selected because");
    expect(schema.contenders[0]?.selected).toBe(true);
  });

  it("reports switching pressure for close competing signals", () => {
    const runtime = new TrackedCognitiveRuntime(parseCognitiveConfig(undefined));
    runtime.observe("agent:test", {
      modality: "sensor",
      summary: "Storage latency warning",
      source: "prometheus",
      confidence: 0.8,
      salience: 0.7,
    });
    runtime.observe("agent:test", {
      modality: "log",
      summary: "Network packet loss warning",
      source: "syslog",
      confidence: 0.8,
      salience: 0.7,
    });

    const engine = new AttentionSchemaEngine(parseAttentionSchemaConfig(undefined));
    const schema = engine.inspect(runtime.snapshot("agent:test"));

    expect(schema.contenders.length).toBeGreaterThanOrEqual(2);
    expect(schema.switchingPressure).toBeGreaterThanOrEqual(0);
    expect(schema.recommendedControl.length).toBeGreaterThan(0);
  });

  it("detects tunnel-vision risk from a single source and modality", () => {
    const runtime = new TrackedCognitiveRuntime(parseCognitiveConfig(undefined));
    for (let index = 0; index < 4; index += 1) {
      runtime.observe("agent:test", {
        modality: "sensor",
        summary: `Rack-07 temperature sample ${index} warning`,
        source: "rack-07",
        confidence: 0.8,
        salience: 0.7,
      });
    }

    const engine = new AttentionSchemaEngine(parseAttentionSchemaConfig(undefined));
    const schema = engine.inspect(runtime.snapshot("agent:test"));

    expect(schema.tunnelVisionRisk).toBeGreaterThanOrEqual(0.6);
    expect(schema.recommendedControl.join(" ")).toContain("different source or modality");
  });
});
