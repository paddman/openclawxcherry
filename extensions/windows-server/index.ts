import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerWindowsInfrastructureProvider,
  WindowsPatchOperations,
} from "./runtime-api.js";
import { WindowsServerClient } from "./src/client.js";
import { parseWindowsServerConfig } from "./src/config.js";
import { createWindowsServerToolFactories } from "./src/tools.js";

export default definePluginEntry({
  id: "windows-server",
  name: "Windows Server",
  description:
    "Manage Windows Server through SSH or Windows-hosted WinRM with diagnostics, monitoring, Windows Update, and approval-gated service actions.",
  register(api) {
    const config = parseWindowsServerConfig(api.pluginConfig);
    const client = new WindowsServerClient(config);
    const operations = new WindowsPatchOperations(client, config);
    let unregisterProvider: (() => void) | undefined;

    for (const factory of createWindowsServerToolFactories(client)) {
      api.registerTool(factory, { optional: true });
    }

    api.registerTrustedToolPolicy({
      id: "windows-server.service-actions",
      description: "Require operator approval before Windows service mutations.",
      evaluate(event) {
        if (event.toolName !== "windows_service_action") return;
        return {
          requireApproval: {
            title: "Approve Windows service action",
            description:
              "This operation changes a remote Windows service. Verify the host, service, dependencies, and production impact.",
            severity: "warning" as const,
            timeoutMs: 60_000,
            timeoutBehavior: "deny" as const,
            allowedDecisions: ["allow-once", "deny"] as Array<"allow-once" | "deny">,
            pluginId: api.id,
          },
        };
      },
    });

    api.registerService({
      id: "windows-server-configuration",
      start(ctx) {
        const status = client.getConfigurationStatus();
        if (status.configured) {
          unregisterProvider?.();
          unregisterProvider = registerWindowsInfrastructureProvider(operations);
          ctx.logger.info(`Windows Server plugin configured for ${status.hosts.length} host(s)`);
        } else {
          ctx.logger.warn(
            `Windows Server plugin enabled but not configured: ${status.problems.join("; ")}`,
          );
        }
      },
      stop() {
        unregisterProvider?.();
        unregisterProvider = undefined;
      },
    });
  },
});
