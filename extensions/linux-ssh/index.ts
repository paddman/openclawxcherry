import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { LinuxSshClient } from "./src/client.js";
import { parseLinuxSshConfig } from "./src/config.js";
import { createLinuxSshToolFactories } from "./src/tools.js";

export default definePluginEntry({
  id: "linux-ssh",
  name: "Linux SSH",
  description:
    "Manage configured Linux servers through key-based OpenSSH with fixed read-only diagnostics and approval-gated systemd service actions.",
  register(api) {
    const client = new LinuxSshClient(parseLinuxSshConfig(api.pluginConfig));

    for (const factory of createLinuxSshToolFactories(client)) {
      api.registerTool(factory, { optional: true });
    }

    api.on("before_tool_call", (event) => {
      if (event.toolName !== "linux_service_action") return;
      return {
        requireApproval: {
          title: "Approve Linux service action",
          description:
            "This operation changes a systemd service on a remote Linux host. Verify the host, unit name, action, dependency impact, and maintenance window before approval.",
          severity: "warning" as const,
          timeoutMs: 60_000,
          timeoutBehavior: "deny" as const,
          allowedDecisions: ["allow-once", "deny"] as Array<"allow-once" | "deny">,
          pluginId: api.id,
        },
      };
    });

    api.registerService({
      id: "linux-ssh-configuration",
      start(ctx) {
        const status = client.getConfigurationStatus();
        if (status.configured) {
          ctx.logger.info(`Linux SSH plugin configured for ${status.hosts.length} host(s)`);
        } else {
          ctx.logger.warn(`Linux SSH plugin enabled but not configured: ${status.problems.join("; ")}`);
        }
      },
      stop() {},
    });
  },
});
