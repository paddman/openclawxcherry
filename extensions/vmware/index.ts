import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerVmwareInfrastructureProvider,
  VmwareOperations,
} from "./runtime-api.js";
import { VmwareClient } from "./src/client.js";
import { parseVmwareConfig } from "./src/config.js";
import { createVmwareToolFactories } from "./src/tools.js";

export default definePluginEntry({
  id: "vmware",
  name: "VMware vSphere",
  description:
    "Manage vCenter or direct ESXi 6.x through 9.x with inventory, monitoring, snapshots, clone, migration, resize, and approval-gated operations.",
  register(api) {
    const config = parseVmwareConfig(api.pluginConfig);
    const client = new VmwareClient(config);
    const operations = new VmwareOperations(client, config);
    let unregisterProvider: (() => void) | undefined;

    for (const factory of createVmwareToolFactories(client)) {
      api.registerTool(factory, { optional: true });
    }

    api.registerTrustedToolPolicy({
      id: "vmware.vm-power",
      description: "Require operator approval before VMware VM power actions.",
      evaluate(event) {
        if (event.toolName !== "vmware_vm_power") return;
        return {
          requireApproval: {
            title: "Approve VMware VM power action",
            description:
              "This operation changes a VMware virtual machine power state. Verify the inventory path, action, cluster impact, and guest shutdown requirements.",
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
      id: "vmware-configuration",
      start(ctx) {
        const status = client.getConfigurationStatus();
        if (status.configured) {
          unregisterProvider?.();
          unregisterProvider = registerVmwareInfrastructureProvider(operations);
          ctx.logger.info(`VMware plugin configured for ${status.endpoint}`);
        } else {
          ctx.logger.warn(
            `VMware plugin enabled but not configured: ${status.problems.join("; ")}`,
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
