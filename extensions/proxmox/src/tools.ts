import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import type {
  ProxmoxClient,
  ProxmoxGuestAction,
  ProxmoxGuestType,
} from "./client.js";

const GUEST_TYPES: ProxmoxGuestType[] = ["qemu", "lxc"];
const GUEST_ACTIONS: ProxmoxGuestAction[] = ["start", "shutdown", "reboot", "stop"];
const RESOURCE_TYPES = ["all", "node", "qemu", "lxc", "storage"] as const;

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

function integerParam(
  params: Record<string, unknown>,
  name: string,
  required = false,
): number | undefined {
  const value = params[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function booleanParam(params: Record<string, unknown>, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

export function createProxmoxToolFactories(
  client: ProxmoxClient,
): OpenClawPluginToolFactory[] {
  const connectionTest: OpenClawPluginToolFactory = () =>
    ({
      name: "proxmox_connection_test",
      label: "Proxmox Connection Test",
      description:
        "Test the configured Proxmox VE API token and return the server and cluster version information.",
      parameters: Type.Object({}),
      async execute() {
        return result({ ok: true, connection: await client.testConnection() });
      },
    }) satisfies AnyAgentTool;

  const clusterResources: OpenClawPluginToolFactory = () =>
    ({
      name: "proxmox_cluster_resources",
      label: "Proxmox Cluster Resources",
      description:
        "List permitted Proxmox nodes, QEMU VMs, LXC containers, or storage with compact utilization data.",
      parameters: Type.Object({
        type: Type.Optional(
          Type.Unsafe<(typeof RESOURCE_TYPES)[number]>({
            type: "string",
            enum: RESOURCE_TYPES,
          }),
        ),
        node: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        status: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
        includeTemplates: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const type = stringParam(params, "type") as
          | (typeof RESOURCE_TYPES)[number]
          | undefined;
        if (type && !RESOURCE_TYPES.includes(type)) {
          throw new Error(`Unsupported resource type: ${type}`);
        }
        const data = await client.listResources({
          type,
          node: stringParam(params, "node"),
          status: stringParam(params, "status"),
          includeTemplates: booleanParam(params, "includeTemplates"),
          limit: integerParam(params, "limit"),
        });
        return result({ ok: true, ...data });
      },
    }) satisfies AnyAgentTool;

  const guestStatus: OpenClawPluginToolFactory = () =>
    ({
      name: "proxmox_guest_status",
      label: "Proxmox Guest Status",
      description:
        "Get the live status of one permitted Proxmox QEMU VM or LXC container by VMID.",
      parameters: Type.Object({
        vmid: Type.Integer({ minimum: 1 }),
        node: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        guestType: Type.Optional(
          Type.Unsafe<ProxmoxGuestType>({ type: "string", enum: GUEST_TYPES }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const guestType = stringParam(params, "guestType") as ProxmoxGuestType | undefined;
        if (guestType && !GUEST_TYPES.includes(guestType)) {
          throw new Error(`Unsupported guestType: ${guestType}`);
        }
        return result({
          ok: true,
          guest: await client.getGuestStatus(
            integerParam(params, "vmid", true) ?? 0,
            stringParam(params, "node"),
            guestType,
          ),
        });
      },
    }) satisfies AnyAgentTool;

  const guestAction: OpenClawPluginToolFactory = () =>
    ({
      name: "proxmox_guest_action",
      label: "Proxmox Guest Power Action",
      description:
        "Start, gracefully shut down, reboot, or force-stop a permitted Proxmox VM or container. Requires allowMutations and human approval.",
      parameters: Type.Object({
        vmid: Type.Integer({ minimum: 1 }),
        action: Type.Unsafe<ProxmoxGuestAction>({
          type: "string",
          enum: GUEST_ACTIONS,
        }),
        node: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        guestType: Type.Optional(
          Type.Unsafe<ProxmoxGuestType>({ type: "string", enum: GUEST_TYPES }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const action = stringParam(params, "action", true) as ProxmoxGuestAction;
        const guestType = stringParam(params, "guestType") as ProxmoxGuestType | undefined;
        if (!GUEST_ACTIONS.includes(action)) throw new Error(`Unsupported action: ${action}`);
        if (guestType && !GUEST_TYPES.includes(guestType)) {
          throw new Error(`Unsupported guestType: ${guestType}`);
        }
        return result({
          ok: true,
          operation: await client.guestAction(
            integerParam(params, "vmid", true) ?? 0,
            action,
            stringParam(params, "node"),
            guestType,
          ),
        });
      },
    }) satisfies AnyAgentTool;

  const taskStatus: OpenClawPluginToolFactory = () =>
    ({
      name: "proxmox_task_status",
      label: "Proxmox Task Status",
      description: "Check a Proxmox asynchronous task (UPID) returned by a guest action.",
      parameters: Type.Object({
        node: Type.String({ minLength: 1, maxLength: 128 }),
        taskId: Type.String({ minLength: 1, maxLength: 2_000 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          task: await client.getTaskStatus(
            stringParam(params, "node", true) ?? "",
            stringParam(params, "taskId", true) ?? "",
          ),
        });
      },
    }) satisfies AnyAgentTool;

  return [connectionTest, clusterResources, guestStatus, guestAction, taskStatus];
}
