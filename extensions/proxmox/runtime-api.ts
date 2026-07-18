import {
  registerInfrastructureProvider,
  type InfrastructureOperation,
  type InfrastructureProvider,
  type InfrastructureResource,
} from "../infrastructure-control/runtime-api.js";
import type { ProxmoxClient, ProxmoxGuestType } from "./src/client.js";

type GuestTarget = { node: string; guestType: ProxmoxGuestType; vmid: number };

function pathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function stringValue(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function integerValue(value: unknown, name: string, required = false): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function booleanValue(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function parameters(operation: InfrastructureOperation): Record<string, unknown> {
  return operation.parameters ?? {};
}

function parseGuestTarget(operation: InfrastructureOperation): GuestTarget {
  const parts = operation.targetId.split(":");
  const params = parameters(operation);
  const guestType =
    parts.length === 3 && (parts[0] === "qemu" || parts[0] === "lxc")
      ? parts[0]
      : stringValue(params.guestType, "guestType", true);
  const node = parts.length === 3 ? parts[1] : stringValue(params.node, "node", true);
  const vmid = parts.length === 3 ? Number(parts[2]) : integerValue(params.vmid, "vmid", true);
  if ((guestType !== "qemu" && guestType !== "lxc") || !node || !vmid || !Number.isInteger(vmid)) {
    throw new Error("Proxmox targetId must be qemu:<node>:<vmid> or lxc:<node>:<vmid>");
  }
  return { guestType, node, vmid };
}

function normalizeResources(value: unknown): InfrastructureResource[] {
  const root = value as { resources?: Array<Record<string, unknown>> };
  return (root.resources ?? []).map((resource) => {
    const node = typeof resource.node === "string" ? resource.node : undefined;
    const vmid = typeof resource.vmid === "number" ? resource.vmid : undefined;
    const type = typeof resource.type === "string" ? resource.type : "unknown";
    const name =
      typeof resource.name === "string"
        ? resource.name
        : vmid !== undefined
          ? `VM ${vmid}`
          : String(resource.id ?? type);
    const id =
      (type === "qemu" || type === "lxc") && node && vmid !== undefined
        ? `${type}:${node}:${vmid}`
        : `${type}:${String(resource.id ?? name)}`;
    const kind =
      type === "qemu"
        ? "virtual-machine"
        : type === "lxc"
          ? "container"
          : type === "node"
            ? "node"
            : type === "storage"
              ? "storage"
              : "cluster";
    return {
      providerId: "proxmox",
      providerKind: "proxmox",
      id,
      kind,
      name,
      status: typeof resource.status === "string" ? resource.status : undefined,
      parent: node,
      cpuPercent: typeof resource.cpuPercent === "number" ? resource.cpuPercent : undefined,
      memoryUsedBytes:
        typeof resource.memoryBytes === "number" ? resource.memoryBytes : undefined,
      memoryTotalBytes:
        typeof resource.maxMemoryBytes === "number" ? resource.maxMemoryBytes : undefined,
      memoryPercent:
        typeof resource.memoryPercent === "number" ? resource.memoryPercent : undefined,
      diskUsedBytes: typeof resource.diskBytes === "number" ? resource.diskBytes : undefined,
      diskTotalBytes:
        typeof resource.maxDiskBytes === "number" ? resource.maxDiskBytes : undefined,
      diskPercent: typeof resource.diskPercent === "number" ? resource.diskPercent : undefined,
      uptimeSeconds: typeof resource.uptime === "number" ? resource.uptime : undefined,
      metadata: { vmid, type, node },
      observedAt: new Date().toISOString(),
    } satisfies InfrastructureResource;
  });
}

export class ProxmoxOperations {
  constructor(private readonly client: ProxmoxClient) {}

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    input: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: Record<string, string | number | boolean | undefined>;
    } = {},
  ): Promise<T> {
    const request = this.client.request as unknown as (
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      input?: {
        query?: Record<string, string | number | boolean | undefined>;
        body?: Record<string, string | number | boolean | undefined>;
      },
    ) => Promise<T>;
    return await request.call(this.client, method, path, input);
  }

  async listSnapshots(target: GuestTarget) {
    return await this.request<Array<Record<string, unknown>>>(
      "GET",
      `/nodes/${pathSegment(target.node)}/${target.guestType}/${target.vmid}/snapshot`,
    );
  }

  async snapshot(
    target: GuestTarget,
    action: "create" | "delete" | "rollback",
    input: Record<string, unknown>,
  ) {
    const snapshotName = stringValue(input.name, "name", true) ?? "";
    const base = `/nodes/${pathSegment(target.node)}/${target.guestType}/${target.vmid}/snapshot`;
    if (action === "create") {
      return await this.request<string>("POST", base, {
        body: {
          snapname: snapshotName,
          description: stringValue(input.description, "description"),
          vmstate: booleanValue(input.includeMemory, "includeMemory"),
        },
      });
    }
    const snapshotPath = `${base}/${pathSegment(snapshotName)}`;
    if (action === "delete") return await this.request<string>("DELETE", snapshotPath);
    return await this.request<string>("POST", `${snapshotPath}/rollback`);
  }

  async listBackups(input: Record<string, unknown>) {
    const node = stringValue(input.node, "node", true) ?? "";
    const storage = stringValue(input.storage, "storage", true) ?? "";
    const vmid = integerValue(input.vmid, "vmid");
    return await this.request<Array<Record<string, unknown>>>(
      "GET",
      `/nodes/${pathSegment(node)}/storage/${pathSegment(storage)}/content`,
      { query: { content: "backup", vmid } },
    );
  }

  async createBackup(target: GuestTarget, input: Record<string, unknown>) {
    const storage = stringValue(input.storage, "storage", true) ?? "";
    const mode = stringValue(input.mode, "mode") ?? "snapshot";
    if (!["snapshot", "suspend", "stop"].includes(mode)) {
      throw new Error(`Unsupported Proxmox backup mode: ${mode}`);
    }
    const compress = stringValue(input.compress, "compress") ?? "zstd";
    if (!["0", "gzip", "lzo", "zstd"].includes(compress)) {
      throw new Error(`Unsupported Proxmox backup compression: ${compress}`);
    }
    return await this.request<string>("POST", `/nodes/${pathSegment(target.node)}/vzdump`, {
      body: {
        vmid: target.vmid,
        storage,
        mode,
        compress,
        "notes-template": stringValue(input.notes, "notes"),
      },
    });
  }

  async clone(target: GuestTarget, input: Record<string, unknown>) {
    const newVmid = integerValue(input.newVmid, "newVmid", true) ?? 0;
    return await this.request<string>(
      "POST",
      `/nodes/${pathSegment(target.node)}/${target.guestType}/${target.vmid}/clone`,
      {
        body: {
          newid: newVmid,
          name: stringValue(input.name, "name"),
          target: stringValue(input.targetNode, "targetNode"),
          full: booleanValue(input.full, "full") ?? true,
          storage: stringValue(input.storage, "storage"),
        },
      },
    );
  }

  async migrate(target: GuestTarget, input: Record<string, unknown>) {
    const targetNode = stringValue(input.targetNode, "targetNode", true) ?? "";
    return await this.request<string>(
      "POST",
      `/nodes/${pathSegment(target.node)}/${target.guestType}/${target.vmid}/migrate`,
      {
        body: {
          target: targetNode,
          online: booleanValue(input.online, "online"),
          "with-local-disks": booleanValue(input.withLocalDisks, "withLocalDisks"),
          targetstorage: stringValue(input.targetStorage, "targetStorage"),
        },
      },
    );
  }

  async resize(target: GuestTarget, input: Record<string, unknown>) {
    const cores = integerValue(input.cores, "cores");
    const memoryMb = integerValue(input.memoryMb, "memoryMb");
    const disk = stringValue(input.disk, "disk");
    const diskSize = stringValue(input.diskSize, "diskSize");
    if (cores === undefined && memoryMb === undefined && (!disk || !diskSize)) {
      throw new Error("At least one of cores, memoryMb, or disk/diskSize is required");
    }
    const results: unknown[] = [];
    if (cores !== undefined || memoryMb !== undefined) {
      results.push(
        await this.request<unknown>(
          "PUT",
          `/nodes/${pathSegment(target.node)}/${target.guestType}/${target.vmid}/config`,
          { body: { cores, memory: memoryMb } },
        ),
      );
    }
    if (disk && diskSize) {
      results.push(
        await this.request<unknown>(
          "PUT",
          `/nodes/${pathSegment(target.node)}/${target.guestType}/${target.vmid}/resize`,
          { body: { disk, size: diskSize } },
        ),
      );
    }
    return results;
  }

  async clusterHealth() {
    const resources = await this.client.listResources({ type: "all", limit: 1_000 });
    const clusterStatus = await this.request<unknown>("GET", "/cluster/status");
    const replication = await this.optionalRequest("/cluster/replication");
    const ha = await this.optionalRequest("/cluster/ha/status/current");
    return { clusterStatus, resources, replication, ha };
  }

  async execute(operation: InfrastructureOperation) {
    const input = parameters(operation);
    if (operation.action.startsWith("guest.")) {
      const target = parseGuestTarget(operation);
      const action = operation.action.slice("guest.".length);
      if (["start", "shutdown", "reboot", "stop"].includes(action)) {
        return await this.client.guestAction(
          target.vmid,
          action as "start" | "shutdown" | "reboot" | "stop",
          target.node,
          target.guestType,
        );
      }
      if (action === "clone") return await this.clone(target, input);
      if (action === "migrate") return await this.migrate(target, input);
      if (action === "resize") return await this.resize(target, input);
    }
    if (operation.action.startsWith("snapshot.")) {
      const action = operation.action.slice("snapshot.".length);
      if (action === "create" || action === "delete" || action === "rollback") {
        return await this.snapshot(parseGuestTarget(operation), action, input);
      }
    }
    if (operation.action === "backup.create") {
      return await this.createBackup(parseGuestTarget(operation), input);
    }
    throw new Error(`Unsupported Proxmox infrastructure action: ${operation.action}`);
  }

  private async optionalRequest(path: string) {
    try {
      return await this.request<unknown>("GET", path);
    } catch (error) {
      return { unavailable: true, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function createProxmoxInfrastructureProvider(
  client: ProxmoxClient,
  operations: ProxmoxOperations,
): InfrastructureProvider {
  return {
    id: "proxmox",
    kind: "proxmox",
    actions: [
      "guest.start",
      "guest.shutdown",
      "guest.reboot",
      "guest.stop",
      "guest.clone",
      "guest.migrate",
      "guest.resize",
      "snapshot.create",
      "snapshot.delete",
      "snapshot.rollback",
      "backup.create",
    ],
    queries: ["snapshot.list", "backup.list", "cluster.health"],
    async query(targetId, query, queryParameters = {}) {
      if (query === "cluster.health") return await operations.clusterHealth();
      const operation: InfrastructureOperation = {
        providerId: "proxmox",
        targetId,
        action: query,
        parameters: queryParameters,
      };
      if (query === "snapshot.list") {
        return await operations.listSnapshots(parseGuestTarget(operation));
      }
      if (query === "backup.list") return await operations.listBackups(queryParameters);
      throw new Error(`Unsupported Proxmox query: ${query}`);
    },
    async inventory(query) {
      const data = await client.listResources({ type: "all", limit: 1_000 });
      const resources = normalizeResources(data);
      if (!query) return resources;
      const needle = query.toLowerCase();
      return resources.filter((resource) =>
        [resource.id, resource.name, resource.parent, resource.status]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(needle)),
      );
    },
    async monitor() {
      return normalizeResources(await client.listResources({ type: "all", limit: 1_000 }));
    },
    async execute(operation) {
      return await operations.execute(operation);
    },
    rollbackFor(operation) {
      const inverse: Record<string, string> = {
        "guest.start": "guest.stop",
        "guest.stop": "guest.start",
        "snapshot.create": "snapshot.delete",
      };
      const action = inverse[operation.action];
      return action ? { ...operation, action } : undefined;
    },
  };
}

export function registerProxmoxInfrastructureProvider(
  client: ProxmoxClient,
  operations: ProxmoxOperations,
): () => void {
  return registerInfrastructureProvider(createProxmoxInfrastructureProvider(client, operations));
}
