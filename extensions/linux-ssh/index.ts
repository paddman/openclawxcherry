import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  LinuxPatchOperations,
  registerLinuxInfrastructureProvider,
} from "./runtime-api.js";
import { LinuxSshClient } from "./src/client.js";
import { parseLinuxSshConfig } from "./src/config.js";
import { createLinuxSshToolFactories } from "./src/tools.js";

export default definePluginEntry({
  id: "linux-ssh",
  name: "Linux SSH",
  description:
    "Manage Linux servers through key-based OpenSSH with diagnostics, monitoring, patch management, and approval-gated service actions.",
  register(api) {
    const config = parseLinuxSshConfig(api.pluginConfig);
    const client = new LinuxSshClient(config);
    const operations = new LinuxPatchOperations(client, config);
    let unregisterProvider: (() => void) | undefined;

    for (const factory of createLinuxSshToolFactories(client)) {
      api.registerTool(factory, { optional: true });
    }

    api.registerTrustedToolPolicy({
      id: "linux-ssh.service-actions",
      description: "Require operator approval before Linux systemd service mutations.",
      evaluate(event) {
        if (event.toolName !== "linux_service_action") return;
        return {
          requireApproval: {
            title: "Approve Linux service action",
            description:
              "This operation changes a systemd service on a remote Linux host. Verify the host, unit, dependencies, and maintenance window.",
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
      id: "linux-ssh-configuration",
      start(ctx) {
        const status = client.getConfigurationStatus();
        if (status.configured) {
          unregisterProvider?.();
          unregisterProvider = registerLinuxInfrastructureProvider(operations);
          ctx.logger.info(`Linux SSH plugin configured for ${status.hosts.length} host(s)`);
        } else {
          ctx.logger.warn(
            `Linux SSH plugin enabled but not configured: ${status.problems.join("; ")}`,
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
