import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import type { LinuxServiceAction, LinuxSshClient } from "./client.js";

const SERVICE_ACTIONS: LinuxServiceAction[] = ["start", "stop", "restart", "reload"];

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

export function createLinuxSshToolFactories(client: LinuxSshClient): OpenClawPluginToolFactory[] {
  const hosts: OpenClawPluginToolFactory = () =>
    ({
      name: "linux_hosts",
      label: "Linux Hosts",
      description: "List configured Linux SSH targets without exposing private-key contents.",
      parameters: Type.Object({}),
      async execute() {
        return result({ ok: true, hosts: client.listHosts() });
      },
    }) satisfies AnyAgentTool;

  const connectionTest: OpenClawPluginToolFactory = () =>
    ({
      name: "linux_connection_test",
      label: "Linux Connection Test",
      description: "Test key-based SSH connectivity to one configured Linux host.",
      parameters: Type.Object({
        hostId: Type.String({ minLength: 1, maxLength: 128 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          connection: await client.testConnection(stringParam(params, "hostId", true) ?? ""),
        });
      },
    }) satisfies AnyAgentTool;

  const systemStatus: OpenClawPluginToolFactory = () =>
    ({
      name: "linux_system_status",
      label: "Linux System Status",
      description:
        "Read OS, kernel, uptime, load, memory, root filesystem, and failed systemd unit status from a configured Linux host.",
      parameters: Type.Object({
        hostId: Type.String({ minLength: 1, maxLength: 128 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          system: await client.systemStatus(stringParam(params, "hostId", true) ?? ""),
        });
      },
    }) satisfies AnyAgentTool;

  const serviceStatus: OpenClawPluginToolFactory = () =>
    ({
      name: "linux_service_status",
      label: "Linux Service Status",
      description: "Read systemd load, active, substate, and unit-file status for one service.",
      parameters: Type.Object({
        hostId: Type.String({ minLength: 1, maxLength: 128 }),
        service: Type.String({ minLength: 1, maxLength: 128 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          service: await client.serviceStatus(
            stringParam(params, "hostId", true) ?? "",
            stringParam(params, "service", true) ?? "",
          ),
        });
      },
    }) satisfies AnyAgentTool;

  const serviceLogs: OpenClawPluginToolFactory = () =>
    ({
      name: "linux_service_logs",
      label: "Linux Service Logs",
      description: "Read a bounded number of recent journal entries for one systemd service.",
      parameters: Type.Object({
        hostId: Type.String({ minLength: 1, maxLength: 128 }),
        service: Type.String({ minLength: 1, maxLength: 128 }),
        lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          logs: await client.serviceLogs(
            stringParam(params, "hostId", true) ?? "",
            stringParam(params, "service", true) ?? "",
            integerParam(params, "lines") ?? 100,
          ),
        });
      },
    }) satisfies AnyAgentTool;

  const serviceAction: OpenClawPluginToolFactory = () =>
    ({
      name: "linux_service_action",
      label: "Linux Service Action",
      description:
        "Start, stop, restart, or reload an explicitly allowed systemd service. Requires allowMutations and human approval.",
      parameters: Type.Object({
        hostId: Type.String({ minLength: 1, maxLength: 128 }),
        service: Type.String({ minLength: 1, maxLength: 128 }),
        action: Type.Unsafe<LinuxServiceAction>({ type: "string", enum: SERVICE_ACTIONS }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const action = stringParam(params, "action", true) as LinuxServiceAction;
        if (!SERVICE_ACTIONS.includes(action)) throw new Error(`Unsupported action: ${action}`);
        return result({
          ok: true,
          operation: await client.serviceAction(
            stringParam(params, "hostId", true) ?? "",
            stringParam(params, "service", true) ?? "",
            action,
          ),
        });
      },
    }) satisfies AnyAgentTool;

  return [hosts, connectionTest, systemStatus, serviceStatus, serviceLogs, serviceAction];
}
