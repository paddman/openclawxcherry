import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { VmwareClient } from "./src/client.js";
import { parseVmwareConfig } from "./src/config.js";
import { createVmwareToolFactories } from "./src/tools.js";

export default definePluginEntry({
  id: "vmware",
  name: "VMware vSphere",
  description:
    "Manage vCenter or direct ESXi environments across vSphere 6.x through 9.x using govc, with inventory allowlists and approval-gated power actions.",
  register(api) {
    const client = new VmwareClient(parseVmwareConfig(api.pluginConfig));

    for (const factory of createVmwareToolFactories(client)) {
      api.registerTool(factory, { optional: true });
    }

    api.on("before_tool_call", (event) => {
      if (event.toolName !== "vmware_vm_power") return;
      return {
        requireApproval: {
          title: "Approve VMware VM power action",
          description:
            "This operation changes a VMware virtual machine power state. Verify the inventory path, action, cluster impact, and guest shutdown requirements before approval.",
          severity: "warning" as const,
          timeoutMs: 60_000,
          timeoutBehavior: "deny" as const,
          allowedDecisions: ["allow-once", "deny"] as Array<"allow-once" | "deny">,
          pluginId: api.id,
        },
      };
    });

    api.registerService({
      id: "vmware-configuration",
      start(ctx) {
        const status = client.getConfigurationStatus();
        if (status.configured) {
          ctx.logger.info(`VMware plugin configured for ${status.endpoint}`);
        } else {
          ctx.logger.warn(`VMware plugin enabled but not configured: ${status.problems.join("; ")}`);
        }
      },
      stop() {},
    });
  },
});
