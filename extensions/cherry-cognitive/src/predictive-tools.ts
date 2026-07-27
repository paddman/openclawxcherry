import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import type { AttentionSchemaEngine } from "./attention-schema.js";
import type { PredictionEngine } from "./prediction.js";
import type { TrackedCognitiveRuntime } from "./tracked-runtime.js";

function requiredText(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const cleaned = value.trim();
  return cleaned || undefined;
}

function optionalNumber(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function optionalBoolean(params: Record<string, unknown>, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function optionalStringArray(params: Record<string, unknown>, name: string): string[] | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function result(details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function sessionKey(ctx: OpenClawPluginToolContext): string | undefined {
  return ctx.sessionKey;
}

export function createPredictiveToolFactories(params: {
  runtime: TrackedCognitiveRuntime;
  prediction: PredictionEngine;
  attention: AttentionSchemaEngine;
}): OpenClawPluginToolFactory[] {
  const { runtime, prediction, attention } = params;

  const predictionFactory: OpenClawPluginToolFactory = (ctx) =>
    ({
      name: "cherry_cognitive_predict",
      label: "Cherry Cognitive Prediction",
      description:
        "Create falsifiable hypotheses, list pending predictions, resolve them against evidence, and inspect predictive calibration.",
      parameters: Type.Object({
        action: Type.Unsafe<"create" | "list" | "confirm" | "refute" | "cancel" | "stats">({
          type: "string",
          enum: ["create", "list", "confirm", "refute", "cancel", "stats"],
        }),
        predictionId: Type.Optional(Type.String({ maxLength: 100 })),
        hypothesis: Type.Optional(Type.String({ maxLength: 1_000 })),
        expectedSignal: Type.Optional(Type.String({ maxLength: 1_000 })),
        sourceExpectation: Type.Optional(Type.String({ maxLength: 200 })),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        horizonMs: Type.Optional(Type.Number({ minimum: 10_000, maximum: 2_592_000_000 })),
        summary: Type.Optional(Type.String({ maxLength: 1_200 })),
        evidenceSummaries: Type.Optional(
          Type.Array(Type.String({ maxLength: 500 }), { maxItems: 16 }),
        ),
        tags: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 24 })),
        includeResolved: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, toolParams: Record<string, unknown>) {
        const action = requiredText(toolParams, "action");
        const currentSession = sessionKey(ctx);
        if (action === "stats") {
          return result({ ok: true, stats: prediction.stats() });
        }
        if (action === "list") {
          return result({
            ok: true,
            predictions: prediction.list(
              currentSession,
              optionalBoolean(toolParams, "includeResolved") ?? false,
            ),
          });
        }
        if (action === "create") {
          const created = prediction.create(currentSession, {
            hypothesis: requiredText(toolParams, "hypothesis"),
            expectedSignal: requiredText(toolParams, "expectedSignal"),
            confidence: optionalNumber(toolParams, "confidence") ?? 0.5,
            horizonMs: optionalNumber(toolParams, "horizonMs"),
            sourceExpectation: optionalText(toolParams, "sourceExpectation"),
            tags: optionalStringArray(toolParams, "tags"),
          });
          runtime.observe(currentSession, {
            modality: "internal",
            summary: `Prediction created: ${created.hypothesis}; expected signal: ${created.expectedSignal}`,
            source: "prediction",
            confidence: created.confidence,
            salience: 0.58,
            data: { predictionId: created.id, deadlineAt: created.deadlineAt },
          });
          return result({ ok: true, prediction: created });
        }
        if (action === "confirm" || action === "refute" || action === "cancel") {
          const evidenceSummaries = optionalStringArray(toolParams, "evidenceSummaries") ?? [];
          const resolved = prediction.resolve(
            currentSession,
            requiredText(toolParams, "predictionId"),
            action,
            requiredText(toolParams, "summary"),
            evidenceSummaries.map((summary) => ({ summary })),
          );
          runtime.observe(currentSession, {
            modality: "internal",
            summary: `Prediction ${resolved.status}: ${resolved.hypothesis}. ${resolved.outcomeSummary ?? ""}`,
            source: "prediction",
            confidence: 0.95,
            salience: resolved.status === "refuted" ? 0.82 : 0.68,
            data: {
              predictionId: resolved.id,
              probabilityScore: resolved.probabilityScore,
            },
          });
          return result({ ok: true, prediction: resolved });
        }
        throw new Error(`Unsupported prediction action: ${action}`);
      },
    }) satisfies AnyAgentTool;

  const attentionFactory: OpenClawPluginToolFactory = (ctx) =>
    ({
      name: "cherry_cognitive_attention",
      label: "Cherry Cognitive Attention Schema",
      description:
        "Inspect the agent's explicit operational attention model: current mode, focus selection, contenders, suppressed signals, switching pressure, and tunnel-vision risk.",
      parameters: Type.Object({}),
      async execute() {
        const schema = attention.inspect(runtime.snapshot(sessionKey(ctx)));
        return result({ ok: true, attention: schema });
      },
    }) satisfies AnyAgentTool;

  return [predictionFactory, attentionFactory];
}
