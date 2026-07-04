import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCherryFlowAgentBridge } from "./src/bridge.js";
import { createCherryFlowHttpHandlers } from "./src/http.js";

function stringConfig(config: Record<string, unknown>, key: string, fallback: string): string {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function integerConfig(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = config[key];
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function booleanConfig(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = config[key];
  return typeof value === "boolean" ? value : fallback;
}

function agentIdsConfig(config: Record<string, unknown>): string[] {
  const value = config.allowedAgentIds;
  if (!Array.isArray(value)) return ["cherryflow-agent"];
  return value
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .map((entry) => entry.trim());
}

export default definePluginEntry({
  id: "cherryflow-bridge",
  name: "CherryFlow Agent Bridge",
  description: "Authenticated CherryFlow HTTP bridge for OpenClaw agent runs",
  register(api) {
    const config = api.pluginConfig ?? {};
    const tokenEnv = stringConfig(config, "tokenEnv", "CHERRYFLOW_BRIDGE_TOKEN");
    const token = process.env[tokenEnv]?.trim();
    const maxTimeoutMs = integerConfig(config, "maxTimeoutMs", 600_000, 1_000, 3_600_000);
    const defaultTimeoutMs = Math.min(
      integerConfig(config, "defaultTimeoutMs", 55_000, 1_000, 600_000),
      maxTimeoutMs,
    );
    const bridge = createCherryFlowAgentBridge({
      subagent: api.runtime.subagent,
      logger: api.logger,
      allowedAgentIds: agentIdsConfig(config),
      maxConcurrentRuns: integerConfig(config, "maxConcurrentRuns", 4, 1, 64),
      defaultTimeoutMs,
      maxTimeoutMs,
      runTtlMs: integerConfig(config, "runTtlMs", 3_600_000, 60_000, 86_400_000),
      retainSessions: booleanConfig(config, "retainSessions", true),
    });
    const handlers = createCherryFlowHttpHandlers({
      bridge,
      token,
      maxBodyBytes: integerConfig(config, "maxBodyBytes", 1_048_576, 1_024, 8_388_608),
    });

    if (!token) {
      api.logger.warn(
        `CherryFlow bridge is loaded but ${tokenEnv} is empty; HTTP requests will return 503 until configured`,
      );
    }

    api.registerHttpRoute({
      path: "/api/agents/run",
      auth: "plugin",
      match: "exact",
      handler: handlers.createRun,
    });
    api.registerHttpRoute({
      path: "/api/agents/runs/",
      auth: "plugin",
      match: "prefix",
      handler: handlers.getRun,
    });
    api.registerHttpRoute({
      path: "/api/agents/health",
      auth: "plugin",
      match: "exact",
      handler: handlers.health,
    });
  },
});
