import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { WindowsServerClient } from "./src/client.js";
import { parseWindowsServerConfig } from "./src/config.js";
import { createWindowsServerToolFactories } from "./src/tools.js";

export default definePluginEntry({
  id: "windows-server",
  name: "Windows Server",
  description:
    "Manage Windows Server through PowerShell remoting over cross-platform SSH or Windows-hosted WinRM, with bounded diagnostics and approval-gated service actions.",
  register(api) {
    const client = new WindowsServerClient(parseWindowsServerConfig(api.pluginConfig));

    for (const factory of createWindowsServerToolFactories(client)) {
      api.registerTool(factory, { optional: true });
    }

    api.on("before_tool_call", (event) => {
      if (event.toolName !== "windows_service_action") return;
      return {
        requireApproval: {
          title: "Approve Windows service action",
          description:
            "This operation changes a service on a remote Windows Server. Verify the host, service, action, dependencies, and production impact before approval.",
          severity: "warning" as const,
          timeoutMs: 60_000,
          timeoutBehavior: "deny" as const,
          allowedDecisions: ["allow-once", "deny"] as Array<"allow-once" | "deny">,
          pluginId: api.id,
        },
      };
    });

    api.registerService({
      id: "windows-server-configuration",
      start(ctx) {
        const status = client.getConfigurationStatus();
        if (status.configured) {
          ctx.logger.info(`Windows Server plugin configured for ${status.hosts.length} host(s)`);
        } else {
          ctx.logger.warn(`Windows Server plugin enabled but not configured: ${status.problems.join("; ")}`);
        }
      },
      stop() {},
    });
  },
});
