import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseInfrastructureControlConfig, configurationProblems } from "./src/config.js";
import { InfrastructureControl } from "./src/control.js";
import { createInfrastructureControlToolFactories } from "./src/tools.js";

const MUTATING_TOOLS = new Set([
  "infra_change_plan_execute",
  "infra_bulk_execute",
  "infra_patch_apply",
  "infra_rollback",
]);

export default definePluginEntry({
  id: "infrastructure-control",
  name: "Infrastructure Control",
  description:
    "Unified inventory, monitoring, alerting, patch management, bulk operations, change plans, rollback, and audit for infrastructure connectors.",
  register(api) {
    const config = parseInfrastructureControlConfig(api.pluginConfig);
    const control = new InfrastructureControl(config);

    for (const factory of createInfrastructureControlToolFactories(control)) {
      api.registerTool(factory, { optional: true });
    }

    api.on("before_tool_call", (event) => {
      if (!MUTATING_TOOLS.has(event.toolName)) return;
      return {
        requireApproval: {
          title: "Approve infrastructure change",
          description:
            "This operation can modify one or more infrastructure targets. Review the persisted plan, target scope, concurrency, rollback coverage, and maintenance impact before approval.",
          severity: "warning" as const,
          timeoutMs: 120_000,
          timeoutBehavior: "deny" as const,
          allowedDecisions: ["allow-once", "deny"] as Array<"allow-once" | "deny">,
          pluginId: api.id,
        },
      };
    });

    let timer: NodeJS.Timeout | undefined;
    api.registerService({
      id: "infrastructure-control-monitor",
      start(ctx) {
        const problems = configurationProblems(config);
        if (problems.length > 0) {
          ctx.logger.warn(
            `Infrastructure control configuration problems: ${problems.join("; ")}`,
          );
          return;
        }
        ctx.logger.info(
          `Infrastructure control ready with ${control.providerStatus().length} registered providers`,
        );
        if (config.monitoringIntervalSeconds > 0) {
          timer = setInterval(() => {
            void control.monitoringScan({ sendAlerts: true }).catch((error) => {
              ctx.logger.error(
                `Infrastructure monitoring scan failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          }, config.monitoringIntervalSeconds * 1_000);
          timer.unref();
        }
      },
      stop() {
        if (timer) clearInterval(timer);
        timer = undefined;
      },
    });
  },
});
