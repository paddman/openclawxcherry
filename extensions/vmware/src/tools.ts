import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import type { VmwareClient, VmwarePowerAction } from "./client.js";

const POWER_ACTIONS: VmwarePowerAction[] = [
  "start",
  "shutdown",
  "reboot",
  "reset",
  "stop",
  "suspend",
];

function result(details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function stringParam(
  params: Record<string, unknown>,
  name: string,
  required = false,
): string | undefined {
  const value = params[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function integerParam(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function createVmwareToolFactories(client: VmwareClient): OpenClawPluginToolFactory[] {
  const connectionTest: OpenClawPluginToolFactory = () =>
    ({
      name: "vmware_connection_test",
      label: "VMware Connection Test",
      description:
        "Test the configured vCenter or ESXi connection and return vSphere product, API, build, and govc version information.",
      parameters: Type.Object({}),
      async execute() {
        return result({ ok: true, connection: await client.testConnection() });
      },
    }) satisfies AnyAgentTool;

  const virtualMachines: OpenClawPluginToolFactory = () =>
    ({
      name: "vmware_virtual_machines",
      label: "VMware Virtual Machines",
      description:
        "List permitted VMware virtual machines from vCenter or direct ESXi inventory, with optional name and power-state filters.",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        powerState: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          ...(await client.listVirtualMachines({
            name: stringParam(params, "name"),
            powerState: stringParam(params, "powerState"),
            limit: integerParam(params, "limit"),
          })),
        });
      },
    }) satisfies AnyAgentTool;

  const virtualMachineStatus: OpenClawPluginToolFactory = () =>
    ({
      name: "vmware_vm_status",
      label: "VMware VM Status",
      description:
        "Get detailed status and configuration data for one permitted VMware VM inventory path.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 1_024 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          virtualMachine: await client.getVirtualMachine(stringParam(params, "path", true) ?? ""),
        });
      },
    }) satisfies AnyAgentTool;

  const powerAction: OpenClawPluginToolFactory = () =>
    ({
      name: "vmware_vm_power",
      label: "VMware VM Power Action",
      description:
        "Start, gracefully shut down, reboot, hard reset, power off, or suspend a permitted VMware VM. Requires allowMutations and human approval.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 1_024 }),
        action: Type.Unsafe<VmwarePowerAction>({ type: "string", enum: POWER_ACTIONS }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const action = stringParam(params, "action", true) as VmwarePowerAction;
        if (!POWER_ACTIONS.includes(action)) throw new Error(`Unsupported action: ${action}`);
        return result({
          ok: true,
          operation: await client.powerAction(stringParam(params, "path", true) ?? "", action),
        });
      },
    }) satisfies AnyAgentTool;

  const recentTasks: OpenClawPluginToolFactory = () =>
    ({
      name: "vmware_recent_tasks",
      label: "VMware Recent Tasks",
      description: "Show recent vSphere tasks globally or for one permitted VM inventory path.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          tasks: await client.recentTasks(
            stringParam(params, "path"),
            integerParam(params, "limit") ?? 25,
          ),
        });
      },
    }) satisfies AnyAgentTool;

  return [connectionTest, virtualMachines, virtualMachineStatus, powerAction, recentTasks];
}
