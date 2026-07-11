import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import type { CherryCognitiveRuntime } from "./runtime.js";
import type { CognitiveModality, GoalStatus } from "./types.js";

const MODALITIES: CognitiveModality[] = [
  "text",
  "audio",
  "vision",
  "sensor",
  "api",
  "log",
  "tool",
  "internal",
];

const GOAL_STATUSES: GoalStatus[] = ["active", "paused", "completed", "cancelled"];

function textParam(params: Record<string, unknown>, name: string, required = false): string | undefined {
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

function parseObjectJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length > 100_000) {
    throw new Error("dataJson exceeds the 100 KB limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("dataJson must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("dataJson must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
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

export function createCognitiveToolFactories(
  runtime: CherryCognitiveRuntime,
): OpenClawPluginToolFactory[] {
  const observeFactory: OpenClawPluginToolFactory = (ctx) =>
    ({
      name: "cherry_cognitive_observe",
      label: "Cherry Cognitive Observe",
      description:
        "Feed a text, audio transcript, vision summary, sensor value, API payload, log event, or internal signal into Cherry Cognitive 2026.",
      parameters: Type.Object({
        modality: Type.Unsafe<CognitiveModality>({ type: "string", enum: MODALITIES }),
        summary: Type.String({ minLength: 1, maxLength: 1_200 }),
        source: Type.Optional(Type.String({ maxLength: 200 })),
        salience: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        dataJson: Type.Optional(
          Type.String({
            description: "Optional JSON object with compact structured sensor or event data.",
            maxLength: 100_000,
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const modalityValue = textParam(params, "modality", true);
        if (!MODALITIES.includes(modalityValue as CognitiveModality)) {
          throw new Error(`Unsupported modality: ${modalityValue}`);
        }
        const observation = runtime.observe(sessionKey(ctx), {
          modality: modalityValue as CognitiveModality,
          summary: textParam(params, "summary", true) ?? "",
          source: textParam(params, "source"),
          salience: numberParam(params, "salience"),
          confidence: numberParam(params, "confidence"),
          data: parseObjectJson(textParam(params, "dataJson")),
        });
        return result({ ok: true, observation });
      },
    }) satisfies AnyAgentTool;

  const goalFactory: OpenClawPluginToolFactory = (ctx) =>
    ({
      name: "cherry_cognitive_goal",
      label: "Cherry Cognitive Goal",
      description:
        "Create, update, complete, pause, cancel, or list persistent goals in the current cognitive session.",
      parameters: Type.Object({
        action: Type.Unsafe<"create" | "update" | "list">({
          type: "string",
          enum: ["create", "update", "list"],
        }),
        description: Type.Optional(Type.String({ minLength: 1, maxLength: 800 })),
        priority: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        goalId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        status: Type.Optional(
          Type.Unsafe<GoalStatus>({ type: "string", enum: GOAL_STATUSES }),
        ),
        progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        notes: Type.Optional(Type.String({ maxLength: 1_000 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const action = textParam(params, "action", true);
        if (action === "list") {
          return result({ ok: true, goals: runtime.listGoals(sessionKey(ctx)) });
        }
        if (action === "create") {
          const goal = runtime.createGoal(
            sessionKey(ctx),
            textParam(params, "description", true) ?? "",
            numberParam(params, "priority") ?? 0.7,
            textParam(params, "notes"),
          );
          return result({ ok: true, goal });
        }
        if (action === "update") {
          const status = textParam(params, "status");
          if (status && !GOAL_STATUSES.includes(status as GoalStatus)) {
            throw new Error(`Unsupported goal status: ${status}`);
          }
          const goal = runtime.updateGoal(sessionKey(ctx), textParam(params, "goalId", true) ?? "", {
            status: status as GoalStatus | undefined,
            progress: numberParam(params, "progress"),
            notes: textParam(params, "notes"),
          });
          return result({ ok: true, goal });
        }
        throw new Error(`Unsupported action: ${action}`);
      },
    }) satisfies AnyAgentTool;

  const stateFactory: OpenClawPluginToolFactory = (ctx) =>
    ({
      name: "cherry_cognitive_state",
      label: "Cherry Cognitive State",
      description:
        "Inspect the current functional cognitive state, global workspace, self-model, goals, memory, and NCA field metrics.",
      parameters: Type.Object({}),
      async execute() {
        return result({ ok: true, state: runtime.snapshot(sessionKey(ctx)) });
      },
    }) satisfies AnyAgentTool;

  const reflectFactory: OpenClawPluginToolFactory = (ctx) =>
    ({
      name: "cherry_cognitive_reflect",
      label: "Cherry Cognitive Reflect",
      description:
        "Generate a metacognitive report covering focus, confidence, uncertainty, risk, unresolved signals, goal competition, and recommended next checks.",
      parameters: Type.Object({}),
      async execute() {
        return result({ ok: true, reflection: runtime.reflect(sessionKey(ctx)) });
      },
    }) satisfies AnyAgentTool;

  return [observeFactory, goalFactory, stateFactory, reflectFactory];
}
