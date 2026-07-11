import { describe, expect, it } from "vitest";
import { normalizeIngestion, parseIngestionPayload } from "./ingestion.js";

describe("multimodal ingestion adapters", () => {
  it("normalizes Prometheus alerts", () => {
    const observations = normalizeIngestion({
      kind: "prometheus_alert",
      source: "alertmanager",
      payload: {
        status: "firing",
        alerts: [
          {
            status: "firing",
            labels: {
              alertname: "HighRackTemperature",
              severity: "critical",
              instance: "rack-07",
            },
            annotations: {
              description: "Rack temperature is above 44C",
            },
          },
        ],
      },
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]?.modality).toBe("sensor");
    expect(observations[0]?.summary).toContain("HighRackTemperature");
    expect(observations[0]?.salience).toBeGreaterThan(0.9);
  });

  it("normalizes RFC-style syslog data", () => {
    const observations = normalizeIngestion({
      kind: "syslog",
      payload: {
        hostname: "router-bkk-01",
        program: "firewall",
        facility: "local4",
        severity: "error",
        message: "Repeated denied connection from 203.0.113.20",
      },
    });

    expect(observations[0]?.modality).toBe("log");
    expect(observations[0]?.summary).toContain("router-bkk-01");
    expect(observations[0]?.summary).toContain("Repeated denied connection");
  });

  it("normalizes vision events with alarms", () => {
    const observations = normalizeIngestion({
      kind: "vision",
      source: "camera-rack-07",
      payload: {
        caption: "Red light detected on cooling unit",
        objects: ["cooling unit", "alarm LED"],
        events: ["alarm"],
        confidence: 0.88,
      },
    });

    expect(observations[0]?.modality).toBe("vision");
    expect(observations[0]?.salience).toBeGreaterThan(0.9);
    expect(observations[0]?.data?.alarm).toBe(true);
  });

  it("expands multiple sensor readings", () => {
    const observations = normalizeIngestion({
      kind: "sensor",
      source: "rack-07",
      payload: {
        readings: [
          { name: "temperature", value: 44, unit: "C", status: "critical" },
          { name: "humidity", value: 58, unit: "%", status: "normal" },
        ],
      },
    });

    expect(observations).toHaveLength(2);
    expect(observations[0]?.summary).toContain("temperature=44 C");
    expect(observations[1]?.summary).toContain("humidity=58 %");
  });

  it("rejects non-object JSON payloads", () => {
    expect(() => parseIngestionPayload("[]")).toThrow("JSON object");
    expect(() => parseIngestionPayload("not-json")).toThrow("valid JSON");
  });
});
