import { describe, expect, it } from "vitest";
import { MemoryConsolidator, parseConsolidationConfig } from "./consolidation.js";
import { parseCognitiveConfig } from "./runtime.js";
import { TrackedCognitiveRuntime } from "./tracked-runtime.js";

describe("MemoryConsolidator", () => {
  it("normalizes consolidation configuration", () => {
    const config = parseConsolidationConfig({
      consolidation: {
        minEpisodes: 0,
        maxSemanticMemoriesPerSession: 1,
        duplicateThreshold: 2,
      },
    });

    expect(config.minEpisodes).toBe(2);
    expect(config.maxSemanticMemoriesPerSession).toBe(16);
    expect(config.duplicateThreshold).toBe(1);
  });

  it("consolidates episodic events into semantic memories", () => {
    const runtime = new TrackedCognitiveRuntime(parseCognitiveConfig(undefined));
    runtime.observe("agent:test", {
      modality: "log",
      summary: "Cooling controller fan timeout",
      source: "syslog",
      confidence: 0.8,
    });
    runtime.recordToolResult("agent:test", "inspect_cooling", "connection timeout", 3_000);

    const consolidator = new MemoryConsolidator(parseConsolidationConfig(undefined));
    const changed = consolidator.consolidate(runtime.snapshot("agent:test"), true);

    expect(changed.length).toBeGreaterThan(0);
    expect(consolidator.stats().total).toBeGreaterThan(0);
    expect(
      changed.some((memory) =>
        ["fact", "failure_pattern", "operational_rule"].includes(memory.category),
      ),
    ).toBe(true);
  });

  it("reinforces duplicate memories rather than creating unlimited copies", () => {
    const runtime = new TrackedCognitiveRuntime(parseCognitiveConfig(undefined));
    runtime.observe("agent:test", {
      modality: "sensor",
      summary: "Rack temperature is 44C",
      source: "rack-07",
      confidence: 0.9,
    });

    const consolidator = new MemoryConsolidator(
      parseConsolidationConfig({ consolidation: { duplicateThreshold: 0.5 } }),
    );
    consolidator.consolidate(runtime.snapshot("agent:test"), true);
    runtime.observe("agent:test", {
      modality: "sensor",
      summary: "Rack temperature remains at 44C",
      source: "rack-07",
      confidence: 0.9,
    });
    consolidator.consolidate(runtime.snapshot("agent:test"), true);

    const recalled = consolidator.recall("agent:test", "rack temperature 44C", 10);
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled.some((memory) => memory.reinforcement > 1)).toBe(true);
  });

  it("forgets a selected semantic memory", () => {
    const runtime = new TrackedCognitiveRuntime(parseCognitiveConfig(undefined));
    runtime.observe("agent:test", {
      modality: "text",
      summary: "Operator prefers read-only diagnosis first",
      source: "operator",
      confidence: 0.95,
    });
    const consolidator = new MemoryConsolidator(parseConsolidationConfig(undefined));
    const [memory] = consolidator.consolidate(runtime.snapshot("agent:test"), true);

    expect(memory).toBeDefined();
    expect(consolidator.forget("agent:test", memory?.id ?? "missing")).toBe(true);
    expect(consolidator.recall("agent:test", "read-only diagnosis", 10)).toHaveLength(0);
  });
});
