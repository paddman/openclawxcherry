import type { IncomingMessage, ServerResponse } from "node:http";
import type { AutonomyPlanner } from "./autonomy.js";
import type { MemoryConsolidator } from "./consolidation.js";
import type { AdaptiveLearningEngine } from "./learning.js";
import type { ToolPolicyEngine } from "./policy.js";
import type { TrackedCognitiveRuntime } from "./tracked-runtime.js";

export type CognitiveHealthSnapshot = {
  runtimeOperational: true;
  status: "ok" | "degraded" | "critical";
  generatedAt: number;
  uptimeSeconds: number;
  sessions: {
    total: number;
    active: number;
    highRisk: number;
    criticalRisk: number;
  };
  memory: ReturnType<MemoryConsolidator["stats"]>;
  autonomy: ReturnType<AutonomyPlanner["stats"]>;
  learning: ReturnType<AdaptiveLearningEngine["stats"]>;
  policy: {
    enabled: boolean;
    mode: string;
    trackedSessions: number;
  };
  aggregate: {
    observations: number;
    episodes: number;
    goals: number;
    activeGoals: number;
    averageConfidence: number;
    averageUncertainty: number;
    averageActivation: number;
    maximumRisk: number;
  };
};

const startedAt = Date.now();

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function metricLine(name: string, value: number, labels?: Record<string, string>): string {
  const labelText = labels
    ? `{${Object.entries(labels)
        .map(([key, item]) => `${key}="${escapeLabel(item)}"`)
        .join(",")}}`
    : "";
  return `${name}${labelText} ${Number.isFinite(value) ? value : 0}`;
}

export function buildCognitiveHealth(
  runtime: TrackedCognitiveRuntime,
  autonomy: AutonomyPlanner,
  memory: MemoryConsolidator,
  policy: ToolPolicyEngine,
  learning: AdaptiveLearningEngine,
): CognitiveHealthSnapshot {
  const sessionKeys = runtime.listSessionKeys();
  const snapshots = sessionKeys.map((sessionKey) => runtime.snapshot(sessionKey));
  const now = Date.now();
  const activeCutoff = now - 30 * 60 * 1_000;
  const highRisk = snapshots.filter((snapshot) => snapshot.selfModel.riskLevel === "high").length;
  const criticalRisk = snapshots.filter(
    (snapshot) => snapshot.selfModel.riskLevel === "critical",
  ).length;
  const maximumRisk = Math.max(...snapshots.map((snapshot) => snapshot.fieldSnapshot.risk), 0);
  const status: CognitiveHealthSnapshot["status"] =
    criticalRisk > 0 || maximumRisk >= 0.9
      ? "critical"
      : highRisk > 0 || average(snapshots.map((snapshot) => snapshot.selfModel.uncertainty)) > 0.7
        ? "degraded"
        : "ok";
  const policyState = policy.inspect();

  return {
    runtimeOperational: true,
    status,
    generatedAt: now,
    uptimeSeconds: Math.max(0, Math.round((now - startedAt) / 1_000)),
    sessions: {
      total: snapshots.length,
      active: snapshots.filter((snapshot) => snapshot.updatedAt >= activeCutoff).length,
      highRisk,
      criticalRisk,
    },
    memory: memory.stats(),
    autonomy: autonomy.stats(),
    learning: learning.stats(),
    policy: {
      enabled: policyState.enabled,
      mode: policyState.mode,
      trackedSessions: policyState.trackedSessions,
    },
    aggregate: {
      observations: snapshots.reduce(
        (sum, snapshot) => sum + snapshot.workingMemory.length,
        0,
      ),
      episodes: snapshots.reduce(
        (sum, snapshot) => sum + snapshot.episodicMemory.length,
        0,
      ),
      goals: snapshots.reduce((sum, snapshot) => sum + snapshot.goals.length, 0),
      activeGoals: snapshots.reduce(
        (sum, snapshot) =>
          sum + snapshot.goals.filter((goal) => goal.status === "active").length,
        0,
      ),
      averageConfidence: average(
        snapshots.map((snapshot) => snapshot.selfModel.confidence),
      ),
      averageUncertainty: average(
        snapshots.map((snapshot) => snapshot.selfModel.uncertainty),
      ),
      averageActivation: average(
        snapshots.map((snapshot) => snapshot.fieldSnapshot.activation),
      ),
      maximumRisk,
    },
  };
}

export function renderPrometheusMetrics(snapshot: CognitiveHealthSnapshot): string {
  const lines = [
    "# HELP openclaw_cherry_cognitive_up Whether the Cherry Cognitive runtime is operational.",
    "# TYPE openclaw_cherry_cognitive_up gauge",
    metricLine("openclaw_cherry_cognitive_up", snapshot.runtimeOperational ? 1 : 0),
    "# HELP openclaw_cherry_cognitive_uptime_seconds Runtime uptime in seconds.",
    "# TYPE openclaw_cherry_cognitive_uptime_seconds gauge",
    metricLine("openclaw_cherry_cognitive_uptime_seconds", snapshot.uptimeSeconds),
    "# HELP openclaw_cherry_cognitive_sessions Current cognitive sessions by state.",
    "# TYPE openclaw_cherry_cognitive_sessions gauge",
    metricLine("openclaw_cherry_cognitive_sessions", snapshot.sessions.total, { state: "total" }),
    metricLine("openclaw_cherry_cognitive_sessions", snapshot.sessions.active, { state: "active" }),
    metricLine("openclaw_cherry_cognitive_sessions", snapshot.sessions.highRisk, { state: "high_risk" }),
    metricLine("openclaw_cherry_cognitive_sessions", snapshot.sessions.criticalRisk, {
      state: "critical_risk",
    }),
    "# HELP openclaw_cherry_cognitive_items Current cognitive item counts.",
    "# TYPE openclaw_cherry_cognitive_items gauge",
    metricLine("openclaw_cherry_cognitive_items", snapshot.aggregate.observations, {
      kind: "observations",
    }),
    metricLine("openclaw_cherry_cognitive_items", snapshot.aggregate.episodes, { kind: "episodes" }),
    metricLine("openclaw_cherry_cognitive_items", snapshot.aggregate.goals, { kind: "goals" }),
    metricLine("openclaw_cherry_cognitive_items", snapshot.aggregate.activeGoals, {
      kind: "active_goals",
    }),
    metricLine("openclaw_cherry_cognitive_items", snapshot.memory.total, {
      kind: "semantic_memories",
    }),
    metricLine("openclaw_cherry_cognitive_items", snapshot.autonomy.total, {
      kind: "autonomy_proposals",
    }),
    metricLine("openclaw_cherry_cognitive_items", snapshot.learning.sourceProfiles, {
      kind: "source_profiles",
    }),
    metricLine("openclaw_cherry_cognitive_items", snapshot.learning.toolProfiles, {
      kind: "tool_profiles",
    }),
    "# HELP openclaw_cherry_cognitive_signal Aggregate cognitive signal values from 0 to 1.",
    "# TYPE openclaw_cherry_cognitive_signal gauge",
    metricLine("openclaw_cherry_cognitive_signal", snapshot.aggregate.averageConfidence, {
      signal: "confidence",
    }),
    metricLine("openclaw_cherry_cognitive_signal", snapshot.aggregate.averageUncertainty, {
      signal: "uncertainty",
    }),
    metricLine("openclaw_cherry_cognitive_signal", snapshot.aggregate.averageActivation, {
      signal: "activation",
    }),
    metricLine("openclaw_cherry_cognitive_signal", snapshot.aggregate.maximumRisk, {
      signal: "maximum_risk",
    }),
    metricLine("openclaw_cherry_cognitive_signal", snapshot.learning.averageSourceReliability, {
      signal: "source_reliability",
    }),
    metricLine("openclaw_cherry_cognitive_signal", snapshot.learning.averageToolSuccessRate, {
      signal: "tool_success_rate",
    }),
  ];

  for (const [status, count] of Object.entries(snapshot.autonomy.byStatus)) {
    lines.push(
      metricLine("openclaw_cherry_cognitive_autonomy_proposals", count, { status }),
    );
  }
  for (const [category, count] of Object.entries(snapshot.memory.byCategory)) {
    lines.push(
      metricLine("openclaw_cherry_cognitive_semantic_memories", count, { category }),
    );
  }

  return `${lines.join("\n")}\n`;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

export function createHealthHandler(
  runtime: TrackedCognitiveRuntime,
  autonomy: AutonomyPlanner,
  memory: MemoryConsolidator,
  policy: ToolPolicyEngine,
  learning: AdaptiveLearningEngine,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (_req, res) => {
    try {
      const snapshot = buildCognitiveHealth(runtime, autonomy, memory, policy, learning);
      // A critical monitored incident is cognitive data, not a runtime failure.
      // Return 200 while the plugin is operational so orchestrators do not restart it.
      writeJson(res, 200, snapshot);
    } catch (error) {
      writeJson(res, 500, {
        runtimeOperational: false,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export function createMetricsHandler(
  runtime: TrackedCognitiveRuntime,
  autonomy: AutonomyPlanner,
  memory: MemoryConsolidator,
  policy: ToolPolicyEngine,
  learning: AdaptiveLearningEngine,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (_req, res) => {
    try {
      const snapshot = buildCognitiveHealth(runtime, autonomy, memory, policy, learning);
      const body = renderPrometheusMetrics(snapshot);
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-length", Buffer.byteLength(body));
      res.end(body);
    } catch (error) {
      const body = `# Cherry Cognitive telemetry error\n${String(error)}\n`;
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(body);
    }
  };
}
