import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  ProxmoxOperations,
  registerProxmoxInfrastructureProvider,
} from "./runtime-api.js";
import { ProxmoxClient } from "./src/client.js";
import { parseProxmoxConfig } from "./src/config.js";
import { createProxmoxToolFactories } from "./src/tools.js";

export default definePluginEntry({
  id: "proxmox",
  name: "Proxmox VE",
  description:
    "Connect OpenClaw agents to Proxmox VE for inventory, monitoring, snapshots, backups, migration, resize, and approval-gated operations.",
  register(api) {
    const config = parseProxmoxConfig(api.pluginConfig);
    const client = new ProxmoxClient(config);
    const operations = new ProxmoxOperations(client);
    let unregisterProvider: (() => void) | undefined;

    for (const factory of createProxmoxToolFactories(client)) {
      api.registerTool(factory, { optional: true });
    }

    api.on("before_tool_call", (event) => {
      if (event.toolName !== "proxmox_guest_action") return;
      return {
        requireApproval: {
          title: "Approve Proxmox power action",
          description:
            "This operation changes a virtual machine or container power state. Verify the VMID, node, action, and production impact.",
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
          unregisterProvider?.();
          unregisterProvider = registerProxmoxInfrastructureProvider(client, operations);
          ctx.logger.info(`Proxmox plugin configured for ${status.endpoint}`);
        } else {
          ctx.logger.warn(
            `Proxmox plugin enabled but not configured: ${status.problems.join("; ")}`,
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
