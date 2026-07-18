import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ProxmoxClient } from "./src/client.js";
import { parseProxmoxConfig } from "./src/config.js";
import { createProxmoxToolFactories } from "./src/tools.js";

export default definePluginEntry({
  id: "proxmox",
  name: "Proxmox VE",
  description:
    "Connect OpenClaw agents to Proxmox VE through a least-privilege API token for cluster inventory, guest status, and approval-gated power actions.",
  register(api) {
    const client = new ProxmoxClient(parseProxmoxConfig(api.pluginConfig));

    for (const factory of createProxmoxToolFactories(client)) {
      api.registerTool(factory, { optional: true });
    }

    api.on("before_tool_call", (event) => {
      if (event.toolName !== "proxmox_guest_action") return;
      return {
        requireApproval: {
          title: "Approve Proxmox power action",
          description:
            "This operation can change the runtime state of a virtual machine or container. Verify the VMID, node, action, and production impact before approval.",
          severity: "warning" as const,
          timeoutMs: 60_000,
          timeoutBehavior: "deny" as const,
          allowedDecisions: ["allow-once", "deny"] as Array<"allow-once" | "deny">,
          pluginId: api.id,
        },
      };
    });

    api.registerService({
      id: "proxmox-configuration",
      start(ctx) {
        const status = client.getConfigurationStatus();
        if (status.configured) {
          ctx.logger.info(`Proxmox plugin configured for ${status.endpoint}`);
        } else {
          ctx.logger.warn(`Proxmox plugin enabled but not configured: ${status.problems.join("; ")}`);
        }
      },
      stop() {},
    });
  },
});
