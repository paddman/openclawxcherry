import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import type { AutonomyPlanner } from "./autonomy.js";
import type { MemoryConsolidator, SemanticMemoryCategory } from "./consolidation.js";
import {
  normalizeIngestion,
  parseIngestionPayload,
  type IngestionKind,
} from "./ingestion.js";
import type { AdaptiveLearningEngine } from "./learning.js";
import type { ToolPolicyEngine } from "./policy.js";
import type { TrackedCognitiveRuntime } from "./tracked-runtime.js";
import { buildCognitiveHealth } from "./telemetry.js";

const INGESTION_KINDS: IngestionKind[] = [
  "generic",
  "prometheus_alert",
  "syslog",
  "webhook",
  "vision",
  "audio",
  "sensor",
];

const MEMORY_CATEGORIES: SemanticMemoryCategory[] = [
  "fact",
  "lesson",
  "failure_pattern",
  "success_pattern",
  "goal_context",
  "source_profile",
  "operational_rule",
];

function textParam(
  params: Record<string, unknown>,
  name: string,
  required = false,
): string | undefined {
  const value = params[name];
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function numberParam(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function booleanParam(params: Record<string, unknown>, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function parseJsonObject(
  value: string | undefined,
  fieldName: string,
  maxChars = 250_000,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length > maxChars) {
    throw new Error(`${fieldName} exceeds the ${maxChars} character limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function stringListParam(params: Record<string, unknown>, name: string): string[] | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean).slice(0, 32);
}

function result(details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function currentSession(ctx: OpenClawPluginToolContext): string | undefined {
  return ctx.sessionKey;
}

export function createAdvancedCognitiveToolFactories(params: {
  runtime: TrackedCognitiveRuntime;
  autonomy: AutonomyPlanner;
  memory: MemoryConsolidator;
  policy: ToolPolicyEngine;
  learning: AdaptiveLearningEngine;
}): OpenClawPluginToolFactory[] {
  const { runtime, autonomy, memory, policy, learning } = params;

  const ingestionFactory: OpenClawPluginToolFactory = (ctx) =>
    ({
      name: "cherry_cognitive_ingest",
      label: "Cherry Cognitive Ingest",
      description:
        "Normalize and ingest Prometheus alerts, syslog, webhooks, vision events, audio transcripts, or sensor payloads into the cognitive workspace.",
      parameters: Type.Object({
        kind: Type.Unsafe<IngestionKind>({ type: "string", enum: INGESTION_KINDS }),
        source: Type.Optional(Type.String({ maxLength: 200 })),
        payloadJson: Type.String({
          minLength: 2,
          maxLength: 250_000,
          description: "JSON object from the upstream monitoring, perception, or webhook source.",
        }),
      }),
      async execute(_id: string, toolParams: Record<string, unknown>) {
        const kind = textParam(toolParams, "kind", true) as IngestionKind;
        if (!INGESTION_KINDS.includes(kind)) {
          throw new Error(`Unsupported ingestion kind: ${kind}`);
        }
        const payload = parseIngestionPayload(textParam(toolParams, "payloadJson", true) ?? "{}");
        const observations = normalizeIngestion({
          kind,
          source: textParam(toolParams, "source"),
          payload,
        }).map((observation) => runtime.observe(currentSession(ctx), observation));
        return result({ ok: true, kind, count: observations.length, observations });
      },
    }) satisfies AnyAgentTool;

  const autonomyFactory: OpenClawPluginToolFactory = (ctx) =>
    ({
      name: "cherry_cognitive_autonomy",
      label: "Cherry Cognitive Autonomy",
      description:
        "Generate, list, approve, reject, cancel, or mark execution of guarded action proposals. Proposals never bypass OpenClaw permissions or tool approvals.",
      parameters: Type.Object({
        action: Type.Unsafe<
          "derive" | "create" | "list" | "approve" | "reject" | "cancel" | "executed"
        >({
          type: "string",
          enum: ["derive", "create", "list", "approve", "reject", "cancel", "executed"],
        }),
        proposalId: Type.Optional(Type.String({ maxLength: 100 })),
        title: Type.Optional(Type.String({ maxLength: 300 })),
        objective: Type.Optional(Type.String({ maxLength: 800 })),
        rationale: Type.Optional(Type.String({ maxLength: 1_200 })),
        expectedOutcome: Type.Optional(Type.String({ maxLength: 800 })),
        evidence: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 16 })),
        risk: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        suggestedTool: Type.Optional(Type.String({ maxLength: 200 })),
        suggestedParamsJson: Type.Optional(Type.String({ maxLength: 100_000 })),
        requiresApproval: Type.Optional(Type.Boolean()),
        note: Type.Optional(Type.String({ maxLength: 1_000 })),
        executionSummary: Type.Optional(Type.String({ maxLength: 1_200 })),
        includeClosed: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, toolParams: Record<string, unknown>) {
        const action = textParam(toolParams, "action", true);
        const sessionKey = currentSession(ctx);
        if (action === "list") {
          return result({
            ok: true,
            proposals: autonomy.list(sessionKey, booleanParam(toolParams, "includeClosed") ?? false),
          });
        }
        if (action === "derive") {
          const state = runtime.snapshot(sessionKey);
          const reflection = runtime.reflect(sessionKey);
          const proposals = autonomy.deriveFromReflection(sessionKey, state, reflection);
          return result({ ok: true, generated: proposals.length, proposals });
        }
        if (action === "create") {
          const proposal = autonomy.propose(sessionKey, {
            title: textParam(toolParams, "title", true) ?? "",
            objective: textParam(toolParams, "objective", true) ?? "",
            rationale: textParam(toolParams, "rationale", true) ?? "",
            evidence: stringListParam(toolParams, "evidence"),
            expectedOutcome: textParam(toolParams, "expectedOutcome", true) ?? "",
            risk: numberParam(toolParams, "risk") ?? 0.5,
            confidence: numberParam(toolParams, "confidence") ?? 0.5,
            suggestedTool: textParam(toolParams, "suggestedTool"),
            suggestedParams: parseJsonObject(
              textParam(toolParams, "suggestedParamsJson"),
              "suggestedParamsJson",
              100_000,
            ),
            requiresApproval: booleanParam(toolParams, "requiresApproval"),
          });
          return result({ ok: true, proposal });
        }
        if (action === "approve" || action === "reject" || action === "cancel") {
          const proposal = autonomy.decide(
            sessionKey,
            textParam(toolParams, "proposalId", true) ?? "",
            action,
            textParam(toolParams, "note"),
          );
          runtime.observe(sessionKey, {
            modality: "internal",
            summary: `Autonomy proposal ${proposal.id} changed to ${proposal.status}: ${proposal.title}`,
            source: "autonomy",
            confidence: 0.95,
            salience: proposal.status === "approved" ? 0.72 : 0.52,
          });
          return result({ ok: true, proposal });
        }
        if (action === "executed") {
          const proposal = autonomy.markExecuted(
            sessionKey,
            textParam(toolParams, "proposalId", true) ?? "",
            textParam(toolParams, "executionSummary", true) ?? "Executed",
          );
          runtime.observe(sessionKey, {
            modality: "internal",
            summary: `Autonomy proposal executed: ${proposal.title}. ${proposal.executionSummary ?? ""}`,
            source: "autonomy",
            confidence: 0.9,
            salience: 0.76,
          });
          return result({ ok: true, proposal });
        }
        throw new Error(`Unsupported autonomy action: ${action}`);
      },
    }) satisfies AnyAgentTool;

  const memoryFactory: OpenClawPluginToolFactory = (ctx) =>
    ({
      name: "cherry_cognitive_memory",
      label: "Cherry Cognitive Semantic Memory",
      description:
        "Consolidate episodic events into bounded semantic memory, recall relevant lessons, forget a memory, or inspect memory statistics.",
      parameters: Type.Object({
        action: Type.Unsafe<"consolidate" | "recall" | "forget" | "stats">({
          type: "string",
          enum: ["consolidate", "recall", "forget", "stats"],
        }),
        query: Type.Optional(Type.String({ maxLength: 1_000 })),
        memoryId: Type.Optional(Type.String({ maxLength: 100 })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
        force: Type.Optional(Type.Boolean()),
        categories: Type.Optional(
          Type.Array(
            Type.Unsafe<SemanticMemoryCategory>({
              type: "string",
              enum: MEMORY_CATEGORIES,
            }),
            { maxItems: MEMORY_CATEGORIES.length },
          ),
        ),
      }),
      async execute(_id: string, toolParams: Record<string, unknown>) {
        const action = textParam(toolParams, "action", true);
        const sessionKey = currentSession(ctx);
        if (action === "stats") {
          return result({ ok: true, stats: memory.stats() });
        }
        if (action === "consolidate") {
          const memories = memory.consolidate(
            runtime.snapshot(sessionKey),
            booleanParam(toolParams, "force") ?? false,
          );
          return result({ ok: true, changed: memories.length, memories });
        }
        if (action === "recall") {
          const categories = toolParams.categories as SemanticMemoryCategory[] | undefined;
          const memories = memory.recall(
            sessionKey,
            textParam(toolParams, "query") ?? "",
            numberParam(toolParams, "limit") ?? 8,
            categories,
          );
          return result({ ok: true, count: memories.length, memories });
        }
        if (action === "forget") {
          const removed = memory.forget(
            sessionKey,
            textParam(toolParams, "memoryId", true) ?? "",
          );
          return result({ ok: removed, removed });
        }
        throw new Error(`Unsupported memory action: ${action}`);
      },
    }) satisfies AnyAgentTool;

  const policyFactory: OpenClawPluginToolFactory = (ctx) =>
    ({
      name: "cherry_cognitive_policy",
      label: "Cherry Cognitive Policy",
      description:
        "Inspect the cognitive tool policy or simulate a policy decision before attempting a potentially risky action.",
      parameters: Type.Object({
        action: Type.Unsafe<"inspect" | "evaluate">({
          type: "string",
          enum: ["inspect", "evaluate"],
        }),
        toolName: Type.Optional(Type.String({ maxLength: 200 })),
        paramsJson: Type.Optional(Type.String({ maxLength: 100_000 })),
      }),
      async execute(_id: string, toolParams: Record<string, unknown>) {
        const action = textParam(toolParams, "action", true);
        if (action === "inspect") {
          return result({ ok: true, policy: policy.inspect() });
        }
        if (action === "evaluate") {
          const sessionKey = currentSession(ctx);
          const state = runtime.snapshot(sessionKey);
          const decision = policy.evaluate({
            sessionKey,
            toolName: textParam(toolParams, "toolName", true) ?? "",
            params:
              parseJsonObject(textParam(toolParams, "paramsJson"), "paramsJson", 100_000) ?? {},
            cognitiveRiskLevel: state.selfModel.riskLevel,
          });
          return result({ ok: true, decision });
        }
        throw new Error(`Unsupported policy action: ${action}`);
      },
    }) satisfies AnyAgentTool;

  const learningFactory: OpenClawPluginToolFactory = (ctx) =>
    ({
      name: "cherry_cognitive_learning",
      label: "Cherry Cognitive Learning",
      description:
        "Inspect adaptive source confidence and tool reliability learned from observations and execution outcomes.",
      parameters: Type.Object({
        action: Type.Unsafe<"snapshot" | "stats" | "tool">({
          type: "string",
          enum: ["snapshot", "stats", "tool"],
        }),
        toolName: Type.Optional(Type.String({ maxLength: 200 })),
      }),
      async execute(_id: string, toolParams: Record<string, unknown>) {
        const action = textParam(toolParams, "action", true);
        if (action === "stats") {
          return result({ ok: true, stats: learning.stats() });
        }
        if (action === "snapshot") {
          return result({ ok: true, learning: learning.snapshot(currentSession(ctx)) });
        }
        if (action === "tool") {
          return result({
            ok: true,
            profile: learning.toolReliability(
              currentSession(ctx),
              textParam(toolParams, "toolName", true) ?? "",
            ),
          });
        }
        throw new Error(`Unsupported learning action: ${action}`);
      },
    }) satisfies AnyAgentTool;

  const healthFactory: OpenClawPluginToolFactory = () =>
    ({
      name: "cherry_cognitive_health",
      label: "Cherry Cognitive Health",
      description:
        "Return aggregate health, session risk, memory, autonomy, policy, learning, and recurrent-field telemetry for Cherry Cognitive 2026.",
      parameters: Type.Object({}),
      async execute() {
        return result({
          ok: true,
          health: buildCognitiveHealth(runtime, autonomy, memory, policy, learning),
        });
      },
    }) satisfies AnyAgentTool;

  return [
    ingestionFactory,
    autonomyFactory,
    memoryFactory,
    policyFactory,
    learningFactory,
    healthFactory,
  ];
}
