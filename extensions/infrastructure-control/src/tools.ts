import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import type { InfrastructureOperation } from "../runtime-api.js";
import type { InfrastructureControl } from "./control.js";
import type { InfrastructureAuditEntry } from "./store.js";

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

function booleanParam(params: Record<string, unknown>, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function integerParam(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function stringArrayParam(params: Record<string, unknown>, name: string): string[] | undefined {
  const value = params[name];
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))
  ) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value === undefined
    ? undefined
    : [...new Set((value as string[]).map((entry) => entry.trim()))];
}

function operationsParam(params: Record<string, unknown>): InfrastructureOperation[] {
  const value = params.operations;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("operations must be a non-empty array");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`operations[${index}] must be an object`);
    }
    const operation = entry as Record<string, unknown>;
    const providerId = stringParam(operation, "providerId", true) ?? "";
    const targetId = stringParam(operation, "targetId", true) ?? "";
    const action = stringParam(operation, "action", true) ?? "";
    const parameters =
      operation.parameters &&
      typeof operation.parameters === "object" &&
      !Array.isArray(operation.parameters)
        ? (operation.parameters as Record<string, unknown>)
        : undefined;
    return { providerId, targetId, action, parameters };
  });
}

const operationSchema = Type.Object({
  providerId: Type.String({ minLength: 1, maxLength: 128 }),
  targetId: Type.String({ minLength: 1, maxLength: 1_024 }),
  action: Type.String({ minLength: 1, maxLength: 128 }),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export function createInfrastructureControlToolFactories(
  control: InfrastructureControl,
): OpenClawPluginToolFactory[] {
  const providers: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_providers",
      label: "Infrastructure Providers",
      description:
        "List registered Proxmox, VMware, Linux, and Windows infrastructure providers and supported capabilities.",
      parameters: Type.Object({}),
      async execute() {
        return result({ ok: true, providers: control.providerStatus() });
      },
    }) satisfies AnyAgentTool;

  const providerQuery: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_provider_query",
      label: "Infrastructure Provider Query",
      description:
        "Run one fixed read-only provider query such as snapshot lists, backup lists, cluster health, or VMware inventory lists.",
      parameters: Type.Object({
        providerId: Type.String({ minLength: 1, maxLength: 128 }),
        targetId: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
        query: Type.String({ minLength: 1, maxLength: 128 }),
        parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const rawParameters = params.parameters;
        const parameters =
          rawParameters && typeof rawParameters === "object" && !Array.isArray(rawParameters)
            ? (rawParameters as Record<string, unknown>)
            : undefined;
        return result({
          ok: true,
          data: await control.providerQuery({
            providerId: stringParam(params, "providerId", true) ?? "",
            targetId: stringParam(params, "targetId") ?? "-",
            query: stringParam(params, "query", true) ?? "",
            parameters,
          }),
        });
      },
    }) satisfies AnyAgentTool;

  const inventory: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_inventory_search",
      label: "Unified Infrastructure Inventory",
      description:
        "Search normalized inventory across registered Proxmox, VMware, Linux, and Windows providers.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        providerIds: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }),
        ),
        kinds: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
        ),
        statuses: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          ...(await control.inventory({
            query: stringParam(params, "query"),
            providerIds: stringArrayParam(params, "providerIds"),
            kinds: stringArrayParam(params, "kinds"),
            statuses: stringArrayParam(params, "statuses"),
            limit: integerParam(params, "limit"),
          })),
        });
      },
    }) satisfies AnyAgentTool;

  const monitoring: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_monitoring_scan",
      label: "Infrastructure Monitoring Scan",
      description:
        "Collect normalized health and utilization data, evaluate thresholds, and optionally deliver configured alerts.",
      parameters: Type.Object({
        providerIds: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }),
        ),
        sendAlerts: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          ...(await control.monitoringScan({
            providerIds: stringArrayParam(params, "providerIds"),
            sendAlerts: booleanParam(params, "sendAlerts"),
          })),
        });
      },
    }) satisfies AnyAgentTool;

  const patchScan: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_patch_scan",
      label: "Infrastructure Patch Scan",
      description:
        "Check available Linux package updates and Windows Updates across registered patch-capable providers.",
      parameters: Type.Object({
        providerIds: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }),
        ),
        targetId: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          ...(await control.patchScan({
            providerIds: stringArrayParam(params, "providerIds"),
            targetId: stringParam(params, "targetId"),
          })),
        });
      },
    }) satisfies AnyAgentTool;

  const createPlan: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_change_plan_create",
      label: "Create Infrastructure Change Plan",
      description:
        "Create a persisted cross-platform change plan with rollback coverage analysis. This does not execute changes.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 256 }),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
        operations: Type.Array(operationSchema, { minItems: 1, maxItems: 500 }),
        maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
        stopOnError: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          plan: await control.createPlan({
            title: stringParam(params, "title", true) ?? "",
            reason: stringParam(params, "reason"),
            operations: operationsParam(params),
            maxConcurrency: integerParam(params, "maxConcurrency"),
            stopOnError: booleanParam(params, "stopOnError"),
          }),
        });
      },
    }) satisfies AnyAgentTool;

  const bulkPlan: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_bulk_plan",
      label: "Plan Bulk Infrastructure Operations",
      description:
        "Create a persisted bulk-operation plan with a concurrency limit, stop-on-error behavior, and rollback analysis.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 256 }),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
        operations: Type.Array(operationSchema, { minItems: 1, maxItems: 500 }),
        maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
        stopOnError: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          plan: await control.createPlan({
            title: stringParam(params, "title", true) ?? "",
            reason: stringParam(params, "reason"),
            operations: operationsParam(params),
            maxConcurrency: integerParam(params, "maxConcurrency"),
            stopOnError: booleanParam(params, "stopOnError"),
          }),
        });
      },
    }) satisfies AnyAgentTool;

  const getPlan: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_change_plan_get",
      label: "Get Infrastructure Change Plan",
      description: "Read a persisted infrastructure change plan and its execution results.",
      parameters: Type.Object({
        planId: Type.String({ minLength: 36, maxLength: 36 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          plan: await control.readPlan(stringParam(params, "planId", true) ?? ""),
        });
      },
    }) satisfies AnyAgentTool;

  const executePlan: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_change_plan_execute",
      label: "Execute Infrastructure Change Plan",
      description:
        "Execute a persisted infrastructure change plan. Requires mutations to be enabled and human approval.",
      parameters: Type.Object({
        planId: Type.String({ minLength: 36, maxLength: 36 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          plan: await control.executePlan(stringParam(params, "planId", true) ?? ""),
        });
      },
    }) satisfies AnyAgentTool;

  const bulkExecute: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_bulk_execute",
      label: "Execute Bulk Infrastructure Plan",
      description:
        "Execute a persisted bulk infrastructure plan with bounded concurrency. Requires human approval.",
      parameters: Type.Object({
        planId: Type.String({ minLength: 36, maxLength: 36 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          plan: await control.executePlan(stringParam(params, "planId", true) ?? ""),
        });
      },
    }) satisfies AnyAgentTool;

  const patchApply: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_patch_apply",
      label: "Apply Infrastructure Patches",
      description:
        "Create and execute an approved patch operation for one Linux or Windows target. Requires human approval.",
      parameters: Type.Object({
        providerId: Type.String({ minLength: 1, maxLength: 128 }),
        targetId: Type.String({ minLength: 1, maxLength: 1_024 }),
        securityOnly: Type.Optional(Type.Boolean()),
        reboot: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const plan = await control.createPlan({
          title: `Patch ${stringParam(params, "targetId", true) ?? ""}`,
          reason: "Patch operation requested through infra_patch_apply",
          operations: [
            {
              providerId: stringParam(params, "providerId", true) ?? "",
              targetId: stringParam(params, "targetId", true) ?? "",
              action: "patch.apply",
              parameters: {
                securityOnly: booleanParam(params, "securityOnly") ?? true,
                reboot: booleanParam(params, "reboot") ?? false,
              },
            },
          ],
          maxConcurrency: 1,
          stopOnError: true,
        });
        return result({ ok: true, plan: await control.executePlan(plan.id) });
      },
    }) satisfies AnyAgentTool;

  const rollback: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_rollback",
      label: "Rollback Infrastructure Change Plan",
      description:
        "Execute the automatic rollback operations stored for a completed or failed plan. Requires human approval.",
      parameters: Type.Object({
        planId: Type.String({ minLength: 36, maxLength: 36 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          plan: await control.rollbackPlan(stringParam(params, "planId", true) ?? ""),
        });
      },
    }) satisfies AnyAgentTool;

  const auditLog: OpenClawPluginToolFactory = () =>
    ({
      name: "infra_audit_log",
      label: "Infrastructure Audit Log",
      description:
        "Query the local append-only JSONL audit trail for inventory, monitoring, plans, operations, alerts, patches, and rollbacks.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
        event: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        targetId: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
        planId: Type.Optional(Type.String({ minLength: 36, maxLength: 36 })),
        ok: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return result({
          ok: true,
          entries: await control.auditLog({
            limit: integerParam(params, "limit"),
            event: stringParam(params, "event") as InfrastructureAuditEntry["event"] | undefined,
            providerId: stringParam(params, "providerId"),
            targetId: stringParam(params, "targetId"),
            planId: stringParam(params, "planId"),
            ok: booleanParam(params, "ok"),
          }),
        });
      },
    }) satisfies AnyAgentTool;

  return [
    providers,
    providerQuery,
    inventory,
    monitoring,
    patchScan,
    createPlan,
    bulkPlan,
    getPlan,
    executePlan,
    bulkExecute,
    patchApply,
    rollback,
    auditLog,
  ];
}
