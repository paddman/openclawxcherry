import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  CherryCognitiveRuntime,
  inferInboundModality,
  parseCognitiveConfig,
} from "./src/runtime.js";
import { createCognitiveToolFactories } from "./src/tools.js";

export default definePluginEntry({
  id: "cherry-cognitive",
  name: "Cherry Cognitive 2026",
  description:
    "Functional machine-consciousness layer with multimodal observations, recurrent NCA-inspired state, self-model, memory, goals, reflection, and guarded autonomy.",
  register(api) {
    const config = parseCognitiveConfig(api.pluginConfig);
    if (!config.enabled) {
      api.logger.info("Cherry Cognitive 2026 is disabled by configuration");
      return;
    }

    const runtime = new CherryCognitiveRuntime(config);

    for (const factory of createCognitiveToolFactories(runtime)) {
      api.registerTool(factory, { optional: true });
    }

    api.registerService({
      id: "cherry-cognitive-runtime",
      async start(ctx) {
        await runtime.start(ctx.stateDir);
        ctx.logger.info(
          `Cherry Cognitive 2026 started (tick=${config.tickIntervalMs}ms, persist=${config.persistIntervalMs}ms)`,
        );
      },
      async stop(ctx) {
        await runtime.stop();
        ctx.logger.info("Cherry Cognitive 2026 stopped");
      },
    });

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
      runtime.notePrompt(ctx.sessionKey, event.prompt);
      if (!config.promptInjection) {
        return;
      }
      return {
        prependContext: runtime.buildPromptContext(ctx.sessionKey),
      };
    });

    api.on("heartbeat_prompt_contribution", (_event, ctx) => {
      if (!config.heartbeatAwareness) {
        return;
      }
      return {
        prependContext: runtime.buildPromptContext(ctx.sessionKey),
      };
    });

    api.on("before_tool_call", (event, ctx) => {
      if (!runtime.requiresApproval(event.toolName)) {
        return;
      }
      return {
        requireApproval: {
          title: `Approve ${event.toolName}`,
          description:
            "Cherry Cognitive 2026 marked this tool as approval-required. Review the target and impact before allowing execution.",
          severity: "warning" as const,
          timeoutMs: config.approvalTimeoutMs,
          timeoutBehavior: "deny" as const,
          allowedDecisions: ["allow-once", "allow-always", "deny"] as Array<
            "allow-once" | "allow-always" | "deny"
          >,
          pluginId: api.id,
          onResolution: (decision) => {
            runtime.recordApproval(ctx.sessionKey, event.toolName, decision);
          },
        },
      };
    });

    api.on("after_tool_call", (event, ctx) => {
      runtime.recordToolResult(ctx.sessionKey, event.toolName, event.error, event.durationMs);
    });

    api.on("agent_end", (event, ctx) => {
      runtime.recordRunEnd(ctx.sessionKey, event.success, event.error, event.durationMs);
    });

    api.on("session_end", async () => {
      await runtime.persist();
    });
  },
});
