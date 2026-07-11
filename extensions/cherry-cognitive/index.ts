import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAdvancedCognitiveToolFactories } from "./src/advanced-tools.js";
import { AutonomyPlanner, parseAutonomyConfig } from "./src/autonomy.js";
import {
  MemoryConsolidator,
  parseConsolidationConfig,
} from "./src/consolidation.js";
import { AdaptiveLearningEngine, parseLearningConfig } from "./src/learning.js";
import { ToolPolicyEngine, parseToolPolicyConfig } from "./src/policy.js";
import { inferInboundModality, parseCognitiveConfig } from "./src/runtime.js";
import {
  buildCognitiveHealth,
  createHealthHandler,
  createMetricsHandler,
} from "./src/telemetry.js";
import { createCognitiveToolFactories } from "./src/tools.js";
import { TrackedCognitiveRuntime } from "./src/tracked-runtime.js";

export default definePluginEntry({
  id: "cherry-cognitive",
  name: "Cherry Cognitive 2026",
  description:
    "Functional machine-consciousness layer with multimodal ingestion, recurrent NCA-inspired state, semantic memory, adaptive reliability learning, self-model, guarded autonomy, policy enforcement, telemetry, and human-controlled execution.",
  register(api) {
    const config = parseCognitiveConfig(api.pluginConfig);
    if (!config.enabled) {
      api.logger.info("Cherry Cognitive 2026 is disabled by configuration");
      return;
    }

    const runtime = new TrackedCognitiveRuntime(config);
    const autonomy = new AutonomyPlanner(parseAutonomyConfig(api.pluginConfig));
    const memory = new MemoryConsolidator(parseConsolidationConfig(api.pluginConfig));
    const policy = new ToolPolicyEngine(parseToolPolicyConfig(api.pluginConfig));
    const learning = new AdaptiveLearningEngine(parseLearningConfig(api.pluginConfig));

    runtime.setObservationCalibrator((sessionKey, input) =>
      learning.calibrateObservation(sessionKey, input),
    );
    runtime.onObservation((sessionKey, observation) => {
      learning.recordObservation(sessionKey, observation);
    });
    runtime.onToolOutcome((event) => {
      learning.recordToolOutcome(
        event.sessionKey,
        event.toolName,
        event.success,
        event.durationMs,
        event.error,
      );
    });

    for (const factory of createCognitiveToolFactories(runtime)) {
      api.registerTool(factory, { optional: true });
    }
    for (const factory of createAdvancedCognitiveToolFactories({
      runtime,
      autonomy,
      memory,
      policy,
      learning,
    })) {
      api.registerTool(factory, { optional: true });
    }

    api.registerService({
      id: "cherry-cognitive-runtime",
      async start(ctx) {
        await runtime.start(ctx.stateDir);
        await Promise.all([
          memory.start(ctx.stateDir),
          autonomy.start(ctx.stateDir),
          learning.start(ctx.stateDir),
        ]);
        ctx.logger.info(
          `Cherry Cognitive 2026 v2 started (tick=${config.tickIntervalMs}ms, persist=${config.persistIntervalMs}ms, autonomy=${autonomy.config.mode}, policy=${policy.config.mode}, learning=${learning.config.enabled})`,
        );
      },
      async stop(ctx) {
        await Promise.all([runtime.stop(), memory.stop(), autonomy.stop(), learning.stop()]);
        ctx.logger.info("Cherry Cognitive 2026 v2 stopped and persisted");
      },
    });

    api.registerHttpRoute({
      path: "/api/cherry-cognitive/health",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createHealthHandler(runtime, autonomy, memory, policy, learning),
    });

    api.registerHttpRoute({
      path: "/api/cherry-cognitive/metrics",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createMetricsHandler(runtime, autonomy, memory, policy, learning),
    });

    api.registerCli(
      ({ program }) => {
        const command = program
          .command("cognitive")
          .description("Inspect Cherry Cognitive 2026 operational state");

        command
          .command("health")
          .description("Show aggregate cognitive health as JSON")
          .action(() => {
            console.log(
              JSON.stringify(
                buildCognitiveHealth(runtime, autonomy, memory, policy, learning),
                null,
                2,
              ),
            );
          });

        command
          .command("sessions")
          .description("List tracked cognitive sessions")
          .action(() => {
            console.log(JSON.stringify(runtime.listSessionKeys(), null, 2));
          });

        command
          .command("policy")
          .description("Show the effective cognitive tool policy")
          .action(() => {
            console.log(JSON.stringify(policy.inspect(), null, 2));
          });

        command
          .command("memory-stats")
          .description("Show consolidated semantic-memory statistics")
          .action(() => {
            console.log(JSON.stringify(memory.stats(), null, 2));
          });

        command
          .command("autonomy-stats")
          .description("Show guarded-autonomy proposal statistics")
          .action(() => {
            console.log(JSON.stringify(autonomy.stats(), null, 2));
          });

        command
          .command("learning-stats")
          .description("Show adaptive source and tool reliability statistics")
          .action(() => {
            console.log(JSON.stringify(learning.stats(), null, 2));
          });
      },
      { commands: ["cognitive"] },
    );

    api.on("message_received", (event, ctx) => {
      if (!config.autoObserveMessages || !event.content.trim()) {
        return;
      }
      runtime.observe(ctx.sessionKey ?? event.sessionKey, {
        modality: inferInboundModality(event.metadata),
        summary: event.content,
        source: `${ctx.channelId}:${event.from}`,
        confidence: 0.78,
        data: event.metadata,
      });
    });

    api.on("agent_turn_prepare", (event, ctx) => {
      const sessionKey = ctx.sessionKey;
      runtime.notePrompt(sessionKey, event.prompt);
      if (!config.promptInjection) {
        return;
      }
      const contexts = [
        runtime.buildPromptContext(sessionKey),
        memory.buildPromptContext(sessionKey, event.prompt),
        learning.buildPromptContext(sessionKey),
        autonomy.buildPromptContext(sessionKey),
      ].filter(Boolean);
      return {
        prependContext: contexts.join("\n\n"),
      };
    });

    api.on("heartbeat_prompt_contribution", (_event, ctx) => {
      if (!config.heartbeatAwareness) {
        return;
      }
      const contexts = [
        runtime.buildPromptContext(ctx.sessionKey),
        learning.buildPromptContext(ctx.sessionKey),
        autonomy.buildPromptContext(ctx.sessionKey),
      ].filter(Boolean);
      return {
        prependContext: contexts.join("\n\n"),
      };
    });

    api.on("before_tool_call", (event, ctx) => {
      const state = runtime.snapshot(ctx.sessionKey);
      const toolProfile = learning.toolReliability(ctx.sessionKey, event.toolName);
      const decision = policy.evaluate({
        sessionKey: ctx.sessionKey,
        toolName: event.toolName,
        params: event.params,
        cognitiveRiskLevel: state.selfModel.riskLevel,
      });

      if (toolProfile && toolProfile.calls >= learning.config.minimumSamples) {
        if (toolProfile.consecutiveFailures >= 3 || toolProfile.successRate < 0.4) {
          decision.action = decision.action === "block" ? "block" : "approval";
          decision.risk = Math.max(decision.risk, 0.68);
          decision.matchedSignals.push(
            `learned-tool-reliability:${toolProfile.successRate.toFixed(2)}`,
          );
        }
      }

      if (decision.action === "block") {
        runtime.observe(ctx.sessionKey, {
          modality: "internal",
          summary: `Policy blocked tool ${event.toolName}: ${decision.reason}`,
          source: "policy",
          salience: 0.9,
          confidence: 0.95,
          data: {
            risk: decision.risk,
            matchedSignals: decision.matchedSignals,
          },
        });
        return {
          block: true,
          blockReason: `${decision.reason} Risk=${decision.risk.toFixed(2)}; signals=${decision.matchedSignals.join(", ") || "none"}`,
        };
      }

      const configuredApproval = runtime.requiresApproval(event.toolName);
      if (decision.action !== "approval" && !configuredApproval) {
        return;
      }

      return {
        requireApproval: {
          title: `Approve ${event.toolName}`,
          description: [
            "Cherry Cognitive 2026 requires human review before this tool can run.",
            `Policy risk: ${decision.risk.toFixed(2)}.`,
            decision.matchedSignals.length > 0
              ? `Signals: ${decision.matchedSignals.join(", ")}.`
              : "The tool is explicitly listed in approvalRequiredTools.",
            toolProfile
              ? `Learned reliability: ${toolProfile.successRate.toFixed(2)} across ${toolProfile.calls} calls.`
              : "No learned reliability profile is available yet.",
            "Review the target, scope, rollback path, and production impact.",
          ].join(" "),
          severity: decision.risk >= 0.75 ? ("critical" as const) : ("warning" as const),
          timeoutMs: config.approvalTimeoutMs,
          timeoutBehavior: "deny" as const,
          allowedDecisions: ["allow-once", "allow-always", "deny"] as Array<
            "allow-once" | "allow-always" | "deny"
          >,
          pluginId: api.id,
          onResolution: (approvalDecision) => {
            runtime.recordApproval(ctx.sessionKey, event.toolName, approvalDecision);
          },
        },
      };
    });

    api.on("after_tool_call", (event, ctx) => {
      runtime.recordToolResult(ctx.sessionKey, event.toolName, event.error, event.durationMs);
    });

    api.on("agent_end", (event, ctx) => {
      runtime.recordRunEnd(ctx.sessionKey, event.success, event.error, event.durationMs);
      const state = runtime.snapshot(ctx.sessionKey);
      if (memory.config.autoConsolidate) {
        memory.consolidate(state);
      }
      if (autonomy.config.enabled && autonomy.config.mode !== "off") {
        const reflection = runtime.reflect(ctx.sessionKey);
        autonomy.deriveFromReflection(ctx.sessionKey, state, reflection);
      }
    });

    api.on("session_end", async () => {
      await Promise.all([
        runtime.persist(),
        memory.persist(),
        autonomy.persist(),
        learning.persist(),
      ]);
    });
  },
});
