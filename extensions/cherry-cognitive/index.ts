import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginAgentTurnPrepareEvent,
  PluginHeartbeatPromptContributionEvent,
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/core";
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

    api.registerHook(
      "message_received",
      (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => {
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
      },
    );

    api.registerHook(
      "agent_turn_prepare",
      (event: PluginAgentTurnPrepareEvent, ctx: PluginHookAgentContext) => {
        runtime.notePrompt(ctx.sessionKey, event.prompt);
        if (!config.promptInjection) {
          return;
        }
        return {
          prependContext: runtime.buildPromptContext(ctx.sessionKey),
        };
      },
    );

    api.registerHook(
      "heartbeat_prompt_contribution",
      (
        _event: PluginHeartbeatPromptContributionEvent,
        ctx: PluginHookAgentContext,
      ) => {
        if (!config.heartbeatAwareness) {
          return;
        }
        return {
          prependContext: runtime.buildPromptContext(ctx.sessionKey),
        };
      },
    );

    api.registerHook(
      "before_tool_call",
      (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
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
            allowedDecisions: ["allow-once", "allow-always", "deny"] as const,
            pluginId: api.id,
            onResolution: (decision) => {
              runtime.recordApproval(ctx.sessionKey, event.toolName, decision);
            },
          },
        };
      },
    );

    api.registerHook(
      "after_tool_call",
      (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
        runtime.recordToolResult(
          ctx.sessionKey,
          event.toolName,
          event.error,
          event.durationMs,
        );
      },
    );

    api.registerHook(
      "agent_end",
      (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => {
        runtime.recordRunEnd(ctx.sessionKey, event.success, event.error, event.durationMs);
      },
    );

    api.registerHook(
      "session_end",
      async (_event: PluginHookSessionEndEvent, _ctx: PluginHookSessionContext) => {
        await runtime.persist();
      },
    );
  },
});
