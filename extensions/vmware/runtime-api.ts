import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  registerInfrastructureProvider,
  type InfrastructureOperation,
  type InfrastructureProvider,
  type InfrastructureResource,
} from "../infrastructure-control/runtime-api.js";
import type { VmwareClient, VmwarePowerAction } from "./src/client.js";
import type { VmwareConfig } from "./src/config.js";
import { configurationProblems } from "./src/config.js";

type CommandResult = { stdout: string; stderr: string; exitCode: number };

function pathAllowed(path: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

function stringValue(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  const text = value.trim();
  if (/[\r\n\0]/u.test(text)) throw new Error(`${name} contains unsupported characters`);
  return text;
}

function integerValue(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstObject(value: unknown): Record<string, unknown> {
  const root = objectValue(value);
  for (const key of ["VirtualMachines", "virtualMachines", "Hosts", "hosts"]) {
    const candidate = root[key];
    if (Array.isArray(candidate) && candidate.length > 0) return objectValue(candidate[0]);
  }
  return root;
}

function nested(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  let current = root;
  for (const key of keys) current = objectValue(current[key]);
  return current;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ratio(value: unknown, maximum: unknown): number | undefined {
  const used = numberValue(value);
  const total = numberValue(maximum);
  if (used === undefined || total === undefined || total <= 0) return undefined;
  return Math.round((used / total) * 10_000) / 100;
}

async function runCommand(config: VmwareConfig, args: string[], json = false): Promise<unknown> {
  const problems = configurationProblems(config);
  if (problems.length > 0) {
    throw new Error(`VMware connector is not configured: ${problems.join("; ")}`);
  }
  if (!config.baseUrl || !config.username || !config.password) {
    throw new Error("VMware connector credentials are incomplete");
  }
  if (config.caFile) readFileSync(config.caFile);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GOVC_URL: config.baseUrl,
    GOVC_USERNAME: config.username,
    GOVC_PASSWORD: config.password,
    GOVC_INSECURE: config.verifyTls ? "0" : "1",
    GOVC_PERSIST_SESSION: "false",
  };
  if (config.caFile) env.GOVC_TLS_CA_CERTS = config.caFile;
  if (config.datacenter) env.GOVC_DATACENTER = config.datacenter;

  const response = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(config.govcPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`VMware command timed out after ${config.timeoutMs} ms`));
    }, config.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 10_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 2_000_000) child.kill("SIGKILL");
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
  if (response.exitCode !== 0) {
    const message = response.stderr.trim() || response.stdout.trim() || `exit code ${response.exitCode}`;
    throw new Error(`govc ${args[0] ?? "command"} failed: ${message}`);
  }
  if (!json) return response.stdout.trim();
  const text = response.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`govc ${args[0] ?? "command"} returned invalid JSON`);
  }
}

function normalizeVm(path: string, details: unknown): InfrastructureResource {
  const vm = firstObject(details);
  const summary = nested(vm, ["Summary"]);
  const runtime = objectValue(summary.Runtime ?? vm.Runtime);
  const quickStats = objectValue(summary.QuickStats ?? vm.QuickStats);
  const config = objectValue(summary.Config ?? vm.Config);
  const storage = objectValue(summary.Storage ?? vm.Storage);
  const guest = objectValue(summary.Guest ?? vm.Guest);
  const memoryMb = numberValue(config.MemorySizeMB ?? config.MemorySizeMb);
  const memoryUsageMb = numberValue(quickStats.GuestMemoryUsage);
  const committed = numberValue(storage.Committed);
  const uncommitted = numberValue(storage.Uncommitted);
  const totalStorage = committed === undefined ? undefined : committed + (uncommitted ?? 0);
  const name = stringValue(config.Name, "name") ?? path.split("/").filter(Boolean).at(-1) ?? path;
  return {
    providerId: "vmware",
    providerKind: "vmware",
    id: path,
    kind: "virtual-machine",
    name,
    status:
      typeof runtime.PowerState === "string"
        ? runtime.PowerState
        : typeof runtime.powerState === "string"
          ? runtime.powerState
          : undefined,
    parent: path.split("/").slice(0, -1).join("/") || undefined,
    memoryUsedBytes: memoryUsageMb === undefined ? undefined : memoryUsageMb * 1024 * 1024,
    memoryTotalBytes: memoryMb === undefined ? undefined : memoryMb * 1024 * 1024,
    memoryPercent: ratio(memoryUsageMb, memoryMb),
    diskUsedBytes: committed,
    diskTotalBytes: totalStorage,
    diskPercent: ratio(committed, totalStorage),
    address:
      typeof guest.IpAddress === "string"
        ? guest.IpAddress
        : typeof guest.ipAddress === "string"
          ? guest.ipAddress
          : undefined,
    metadata: {
      guestFullName: guest.GuestFullName,
      numCpu: config.NumCpu,
      host: runtime.Host,
      connectionState: runtime.ConnectionState,
    },
    observedAt: new Date().toISOString(),
  };
}

export class VmwareOperations {
  constructor(
    private readonly client: VmwareClient,
    private readonly config: VmwareConfig,
  ) {}

  async inventory(query?: string): Promise<InfrastructureResource[]> {
    const listed = await this.client.listVirtualMachines({ name: query, limit: this.config.maxResults });
    const items = listed.virtualMachines as Array<{ path: string }>;
    const results = await Promise.allSettled(
      items.map(async (item) =>
        normalizeVm(item.path, (await this.client.getVirtualMachine(item.path)).details),
      ),
    );
    return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  }

  async listInventory(type: "host" | "datastore" | "network") {
    const govcType = type === "host" ? "h" : type === "datastore" ? "s" : "n";
    const output = String(await runCommand(this.config, ["find", ".", "-type", govcType]));
    const paths = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const allowed =
      type === "host" ? paths.filter((path) => pathAllowed(path, this.config.allowedHostPaths)) : paths;
    return {
      type,
      total: allowed.length,
      truncated: allowed.length > this.config.maxResults,
      paths: allowed.slice(0, this.config.maxResults),
    };
  }

  async snapshots(path: string) {
    this.assertVmAllowed(path);
    return await runCommand(this.config, ["snapshot.tree", "-vm", path, "-D", "-i", "-f"]);
  }

  async snapshot(path: string, action: "create" | "remove" | "revert", input: Record<string, unknown>) {
    this.assertMutation();
    this.assertVmAllowed(path);
    const name = stringValue(input.name, "name", true) ?? "";
    if (action === "create") {
      const args = ["snapshot.create", "-vm", path];
      const description = stringValue(input.description, "description");
      if (description) args.push("-d", description);
      const includeMemory = booleanValue(input.includeMemory, "includeMemory");
      if (includeMemory !== undefined) args.push(`-m=${includeMemory}`);
      const quiesce = booleanValue(input.quiesce, "quiesce");
      if (quiesce !== undefined) args.push(`-q=${quiesce}`);
      args.push(name);
      return await runCommand(this.config, args);
    }
    if (action === "remove") {
      return await runCommand(this.config, ["snapshot.remove", "-vm", path, name]);
    }
    return await runCommand(this.config, ["snapshot.revert", "-vm", path, name]);
  }

  async clone(path: string, input: Record<string, unknown>) {
    this.assertMutation();
    this.assertVmAllowed(path);
    const name = stringValue(input.name, "name", true) ?? "";
    const args = ["vm.clone", "-vm", path, "-on=false"];
    const folder = stringValue(input.folder, "folder");
    const datastore = stringValue(input.datastore, "datastore");
    const pool = stringValue(input.pool, "pool");
    const host = stringValue(input.host, "host");
    if (folder) args.push("-folder", folder);
    if (datastore) args.push("-ds", datastore);
    if (pool) args.push("-pool", pool);
    if (host) {
      this.assertHostAllowed(host);
      args.push("-host", host);
    }
    args.push(name);
    return await runCommand(this.config, args);
  }

  async migrate(path: string, input: Record<string, unknown>) {
    this.assertMutation();
    this.assertVmAllowed(path);
    const host = stringValue(input.host, "host", true) ?? "";
    this.assertHostAllowed(host);
    const args = ["vm.migrate", "-vm", path, "-host", host];
    const datastore = stringValue(input.datastore, "datastore");
    const pool = stringValue(input.pool, "pool");
    if (datastore) args.push("-ds", datastore);
    if (pool) args.push("-pool", pool);
    return await runCommand(this.config, args);
  }

  async resize(path: string, input: Record<string, unknown>) {
    this.assertMutation();
    this.assertVmAllowed(path);
    const cpu = integerValue(input.cpu, "cpu");
    const memoryMb = integerValue(input.memoryMb, "memoryMb");
    const diskLabel = stringValue(input.diskLabel, "diskLabel");
    const diskSize = stringValue(input.diskSize, "diskSize");
    if (cpu === undefined && memoryMb === undefined && (!diskLabel || !diskSize)) {
      throw new Error("At least one of cpu, memoryMb, or diskLabel/diskSize is required");
    }
    const results: unknown[] = [];
    if (cpu !== undefined || memoryMb !== undefined) {
      const args = ["vm.change", "-vm", path];
      if (cpu !== undefined) args.push("-c", String(cpu));
      if (memoryMb !== undefined) args.push("-m", String(memoryMb));
      results.push(await runCommand(this.config, args));
    }
    if (diskLabel && diskSize) {
      results.push(
        await runCommand(this.config, [
          "vm.disk.change",
          "-vm",
          path,
          "-disk.label",
          diskLabel,
          "-size",
          diskSize,
        ]),
      );
    }
    return results;
  }

  async hostMaintenance(hostPath: string, action: "enter" | "exit", input: Record<string, unknown>) {
    this.assertMutation();
    this.assertHostAllowed(hostPath);
    if (action === "enter") {
      const timeout = integerValue(input.timeoutSeconds, "timeoutSeconds") ?? 900;
      return await runCommand(this.config, [
        "host.maintenance.enter",
        "-timeout",
        String(timeout),
        hostPath,
      ]);
    }
    return await runCommand(this.config, ["host.maintenance.exit", hostPath]);
  }

  async execute(operation: InfrastructureOperation) {
    const input = operation.parameters ?? {};
    if (operation.action.startsWith("vm.")) {
      const action = operation.action.slice("vm.".length);
      if (["start", "shutdown", "reboot", "reset", "stop", "suspend"].includes(action)) {
        return await this.client.powerAction(operation.targetId, action as VmwarePowerAction);
      }
      if (action === "clone") return await this.clone(operation.targetId, input);
      if (action === "migrate") return await this.migrate(operation.targetId, input);
      if (action === "resize") return await this.resize(operation.targetId, input);
    }
    if (operation.action.startsWith("snapshot.")) {
      const action = operation.action.slice("snapshot.".length);
      if (action === "create" || action === "remove" || action === "revert") {
        return await this.snapshot(operation.targetId, action, input);
      }
    }
    if (operation.action.startsWith("host.maintenance.")) {
      const action = operation.action.slice("host.maintenance.".length);
      if (action === "enter" || action === "exit") {
        return await this.hostMaintenance(operation.targetId, action, input);
      }
    }
    throw new Error(`Unsupported VMware infrastructure action: ${operation.action}`);
  }

  private assertMutation() {
    if (!this.config.allowMutations) {
      throw new Error("VMware mutations are disabled; set allowMutations to true");
    }
  }

  private assertVmAllowed(path: string) {
    if (!pathAllowed(path, this.config.allowedVmPaths)) {
      throw new Error(`VM path is outside allowedVmPaths: ${path}`);
    }
  }

  private assertHostAllowed(path: string) {
    if (this.config.allowedHostPaths.length === 0) {
      throw new Error("VMware host mutations require a non-empty allowedHostPaths list");
    }
    if (!pathAllowed(path, this.config.allowedHostPaths)) {
      throw new Error(`Host path is outside allowedHostPaths: ${path}`);
    }
  }
}

export function createVmwareInfrastructureProvider(
  operations: VmwareOperations,
): InfrastructureProvider {
  return {
    id: "vmware",
    kind: "vmware",
    actions: [
      "vm.start",
      "vm.shutdown",
      "vm.reboot",
      "vm.reset",
      "vm.stop",
      "vm.suspend",
      "vm.clone",
      "vm.migrate",
      "vm.resize",
      "snapshot.create",
      "snapshot.remove",
      "snapshot.revert",
      "host.maintenance.enter",
      "host.maintenance.exit",
    ],
    queries: ["snapshot.list", "inventory.hosts", "inventory.datastores", "inventory.networks"],
    async query(targetId, query) {
      if (query === "snapshot.list") return await operations.snapshots(targetId);
      if (query === "inventory.hosts") return await operations.listInventory("host");
      if (query === "inventory.datastores") return await operations.listInventory("datastore");
      if (query === "inventory.networks") return await operations.listInventory("network");
      throw new Error(`Unsupported VMware query: ${query}`);
    },
    async inventory(query) {
      return await operations.inventory(query);
    },
    async monitor() {
      return await operations.inventory();
    },
    async execute(operation) {
      return await operations.execute(operation);
    },
    rollbackFor(operation) {
      const inverse: Record<string, string> = {
        "vm.start": "vm.stop",
        "vm.stop": "vm.start",
        "snapshot.create": "snapshot.remove",
        "host.maintenance.enter": "host.maintenance.exit",
        "host.maintenance.exit": "host.maintenance.enter",
      };
      const action = inverse[operation.action];
      return action ? { ...operation, action } : undefined;
    },
  };
}

export function registerVmwareInfrastructureProvider(
  operations: VmwareOperations,
): () => void {
  return registerInfrastructureProvider(createVmwareInfrastructureProvider(operations));
}
