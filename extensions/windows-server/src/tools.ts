import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import type { WindowsServerClient, WindowsServiceAction } from "./client.js";

const SERVICE_ACTIONS: WindowsServiceAction[] = ["start", "stop", "restart"];

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

export function createWindowsServerToolFactories(
  client: WindowsServerClient,
): OpenClawPluginToolFactory[] {
  const hosts: OpenClawPluginToolFactory = () =>
    ({
      name: "windows_hosts",
      label: "Windows Hosts",
      description: "List configured Windows Server targets and selected remoting transports.",
      parameters: Type.Object({}),
      async execute() {
        return result({ ok: true, hosts: client.listHosts() });
      },
    }) satisfies AnyAgentTool;

  const connectionTest: OpenClawPluginToolFactory = () =>
    ({
      name: "windows_connection_test",
      label: "Windows Connection Test",
      description:
        "Test PowerShell remoting to one Windows Server over SSH or WinRM and report OS, build, PowerShell, and identity information.",
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
      name: "windows_system_status",
      label: "Windows System Status",
      description:
        "Read Windows Server OS/build, uptime, memory, CPU, disks, domain, pending reboot, and stopped automatic service information.",
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
      name: "windows_service_status",
      label: "Windows Service Status",
      description: "Read Windows service state, startup mode, process ID, executable path, and account.",
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

  const eventLogs: OpenClawPluginToolFactory = () =>
    ({
      name: "windows_event_logs",
      label: "Windows Event Logs",
      description:
        "Read a bounded set of recent Windows event log entries from System, Application, Security, or an operational log.",
      parameters: Type.Object({
        hostId: Type.String({ minLength: 1, maxLength: 128 }),
        logName: Type.String({ minLength: 1, maxLength: 160 }),
        maxEvents: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          logs: await client.eventLogs(
            stringParam(params, "hostId", true) ?? "",
            stringParam(params, "logName", true) ?? "",
            integerParam(params, "maxEvents") ?? 100,
          ),
        });
      },
    }) satisfies AnyAgentTool;

  const serviceAction: OpenClawPluginToolFactory = () =>
    ({
      name: "windows_service_action",
      label: "Windows Service Action",
      description:
        "Start, stop, or restart an explicitly allowed Windows service. Requires allowMutations and human approval.",
      parameters: Type.Object({
        hostId: Type.String({ minLength: 1, maxLength: 128 }),
        service: Type.String({ minLength: 1, maxLength: 128 }),
        action: Type.Unsafe<WindowsServiceAction>({ type: "string", enum: SERVICE_ACTIONS }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const action = stringParam(params, "action", true) as WindowsServiceAction;
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

  return [hosts, connectionTest, systemStatus, serviceStatus, eventLogs, serviceAction];
}
