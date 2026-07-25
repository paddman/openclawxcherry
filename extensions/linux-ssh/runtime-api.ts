import { spawn } from "node:child_process";
import {
  registerInfrastructureProvider,
  type InfrastructureOperation,
  type InfrastructurePatchSummary,
  type InfrastructureProvider,
  type InfrastructureResource,
} from "../infrastructure-control/runtime-api.js";
import type { LinuxSshClient, LinuxServiceAction } from "./src/client.js";
import type { LinuxHostConfig, LinuxSshConfig } from "./src/config.js";

type CommandResult = { stdout: string; stderr: string; exitCode: number };

function hostById(config: LinuxSshConfig, hostId: string): LinuxHostConfig {
  const host = config.hosts.find((entry) => entry.id === hostId);
  if (!host) throw new Error(`Unknown Linux host id: ${hostId}`);
  return host;
}

function booleanValue(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function stringValue(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function parseRootFilesystem(value: unknown): {
  total?: number;
  used?: number;
  available?: number;
  percent?: number;
} {
  if (typeof value !== "string") return {};
  const [total, used, available, percent] = value.split(",");
  return {
    total: Number.isFinite(Number(total)) ? Number(total) : undefined,
    used: Number.isFinite(Number(used)) ? Number(used) : undefined,
    available: Number.isFinite(Number(available)) ? Number(available) : undefined,
    percent: typeof percent === "string" ? Number(percent.replace("%", "")) : undefined,
  };
}

async function runSsh(
  config: LinuxSshConfig,
  host: LinuxHostConfig,
  command: string,
  allowedExitCodes: number[] = [0],
): Promise<string> {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.ceil(config.timeoutMs / 1000))}`,
    "-o",
    `StrictHostKeyChecking=${host.strictHostKeyChecking}`,
    "-p",
    String(host.port),
  ];
  if (host.identityFile) args.push("-i", host.identityFile);
  if (host.knownHostsFile) args.push("-o", `UserKnownHostsFile=${host.knownHostsFile}`);
  args.push(`${host.username}@${host.hostname}`, command);
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(config.sshPath, args, {
      env: process.env,
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
      reject(new Error(`Linux SSH command timed out after ${config.timeoutMs} ms`));
    }, config.timeoutMs);
    const enforceLimit = () => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > config.maxOutputBytes) {
        child.kill("SIGKILL");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      enforceLimit();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      enforceLimit();
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
  if (!allowedExitCodes.includes(result.exitCode)) {
    const message = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Linux SSH command failed on ${host.id}: ${message}`);
  }
  return result.stdout.trim();
}

function parsePatchJson(host: LinuxHostConfig, text: string): InfrastructurePatchSummary {
  const raw = JSON.parse(text) as {
    packageManager?: unknown;
    availableUpdates?: unknown;
    securityUpdates?: unknown;
    rebootRequired?: unknown;
    details?: unknown;
  };
  return {
    providerId: "linux",
    providerKind: "linux",
    targetId: host.id,
    targetName: host.hostname,
    availableUpdates: typeof raw.availableUpdates === "number" ? raw.availableUpdates : 0,
    securityUpdates: typeof raw.securityUpdates === "number" ? raw.securityUpdates : undefined,
    rebootRequired: typeof raw.rebootRequired === "boolean" ? raw.rebootRequired : undefined,
    packageManager: typeof raw.packageManager === "string" ? raw.packageManager : undefined,
    details: raw.details,
    observedAt: new Date().toISOString(),
  };
}

export class LinuxPatchOperations {
  constructor(
    private readonly client: LinuxSshClient,
    private readonly config: LinuxSshConfig,
  ) {}

  async inventory(query?: string): Promise<InfrastructureResource[]> {
    const selected = this.config.hosts.filter((host) => {
      if (!query) return true;
      const needle = query.toLowerCase();
      return host.id.toLowerCase().includes(needle) || host.hostname.toLowerCase().includes(needle);
    });
    const settled = await Promise.allSettled(
      selected.map(async (host) => {
        const status = await this.client.systemStatus(host.id);
        const totalKb = Number(status.memoryTotalKb);
        const availableKb = Number(status.memoryAvailableKb);
        const usedKb =
          Number.isFinite(totalKb) && Number.isFinite(availableKb) ? totalKb - availableKb : undefined;
        const disk = parseRootFilesystem(status.rootFilesystem);
        return {
          providerId: "linux",
          providerKind: "linux",
          id: host.id,
          kind: "host",
          name: typeof status.hostname === "string" ? status.hostname : host.hostname,
          status: Number(status.failedUnits) > 0 ? "warning" : "online",
          address: host.hostname,
          memoryUsedBytes: usedKb === undefined ? undefined : usedKb * 1024,
          memoryTotalBytes: Number.isFinite(totalKb) ? totalKb * 1024 : undefined,
          memoryPercent:
            usedKb === undefined || !Number.isFinite(totalKb) || totalKb <= 0
              ? undefined
              : Math.round((usedKb / totalKb) * 10_000) / 100,
          diskUsedBytes: disk.used,
          diskTotalBytes: disk.total,
          diskPercent: disk.percent,
          uptimeSeconds:
            Number.isFinite(Number(status.uptimeSeconds)) ? Number(status.uptimeSeconds) : undefined,
          metadata: {
            os: status.os,
            kernel: status.kernel,
            loadAverage: status.loadAverage,
            failedUnits: status.failedUnits,
          },
          observedAt: new Date().toISOString(),
        } satisfies InfrastructureResource;
      }),
    );
    return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  }

  async patchScan(targetId?: string): Promise<InfrastructurePatchSummary[]> {
    const hosts = targetId ? [hostById(this.config, targetId)] : this.config.hosts;
    const settled = await Promise.allSettled(
      hosts.map(async (host) => {
        const script = [
          "set -eu",
          "reboot=false",
          "[ -e /var/run/reboot-required ] && reboot=true || true",
          "if command -v apt-get >/dev/null 2>&1; then",
          "  output=$(LC_ALL=C apt-get -s upgrade 2>/dev/null || true)",
          "  available=$(printf '%s\\n' \"$output\" | awk '/^Inst /{count++} END{print count+0}')",
          "  security=$(printf '%s\\n' \"$output\" | awk 'BEGIN{IGNORECASE=1} /^Inst / && /security/{count++} END{print count+0}')",
          "  manager=apt",
          "elif command -v dnf >/dev/null 2>&1; then",
          "  output=$(LC_ALL=C dnf -q check-update 2>/dev/null || true)",
          "  available=$(printf '%s\\n' \"$output\" | awk 'NF>=3 && $1 !~ /^(Last|Obsoleting)/{count++} END{print count+0}')",
          "  security=$(LC_ALL=C dnf -q updateinfo list security updates 2>/dev/null | awk 'NF>=3{count++} END{print count+0}')",
          "  manager=dnf",
          "elif command -v yum >/dev/null 2>&1; then",
          "  output=$(LC_ALL=C yum -q check-update 2>/dev/null || true)",
          "  available=$(printf '%s\\n' \"$output\" | awk 'NF>=3{count++} END{print count+0}')",
          "  security=$(LC_ALL=C yum -q updateinfo list security updates 2>/dev/null | awk 'NF>=3{count++} END{print count+0}')",
          "  manager=yum",
          "elif command -v zypper >/dev/null 2>&1; then",
          "  output=$(LC_ALL=C zypper --non-interactive list-updates 2>/dev/null || true)",
          "  available=$(printf '%s\\n' \"$output\" | awk -F'|' '/^v[[:space:]]*\\|/{count++} END{print count+0}')",
          "  security=$(LC_ALL=C zypper --non-interactive list-patches --category security 2>/dev/null | awk -F'|' '/^.*\\|.*security/{count++} END{print count+0}')",
          "  manager=zypper",
          "else",
          "  echo '{\"error\":\"unsupported package manager\"}'",
          "  exit 2",
          "fi",
          "printf '{\"packageManager\":\"%s\",\"availableUpdates\":%s,\"securityUpdates\":%s,\"rebootRequired\":%s}\\n' \"$manager\" \"$available\" \"$security\" \"$reboot\"",
        ].join("\n");
        return parsePatchJson(host, await runSsh(this.config, host, script));
      }),
    );
    return settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const host = hosts[index] as LinuxHostConfig;
      return {
        providerId: "linux",
        providerKind: "linux",
        targetId: host.id,
        targetName: host.hostname,
        availableUpdates: 0,
        details: { error: result.reason instanceof Error ? result.reason.message : String(result.reason) },
        observedAt: new Date().toISOString(),
      };
    });
  }

  async applyPatch(hostId: string, input: Record<string, unknown>) {
    if (!this.config.allowMutations) {
      throw new Error("Linux mutations are disabled; set allowMutations to true");
    }
    const host = hostById(this.config, hostId);
    const securityOnly = booleanValue(input.securityOnly, "securityOnly") ?? true;
    const reboot = booleanValue(input.reboot, "reboot") ?? false;
    const prefix = host.sudo ? "sudo -n " : "";
    const script = [
      "set -eu",
      "if command -v apt-get >/dev/null 2>&1; then",
      securityOnly
        ? `  if command -v unattended-upgrade >/dev/null 2>&1; then ${prefix}unattended-upgrade -d; else ${prefix}apt-get update && DEBIAN_FRONTEND=noninteractive ${prefix}apt-get -y upgrade; fi`
        : `  ${prefix}apt-get update && DEBIAN_FRONTEND=noninteractive ${prefix}apt-get -y upgrade`,
      "elif command -v dnf >/dev/null 2>&1; then",
      `  ${prefix}dnf -y upgrade${securityOnly ? " --security" : ""}`,
      "elif command -v yum >/dev/null 2>&1; then",
      `  ${prefix}yum -y update${securityOnly ? " --security" : ""}`,
      "elif command -v zypper >/dev/null 2>&1; then",
      securityOnly
        ? `  ${prefix}zypper --non-interactive patch --category security`
        : `  ${prefix}zypper --non-interactive update`,
      "else",
      "  echo 'unsupported package manager' >&2",
      "  exit 2",
      "fi",
      reboot ? `${prefix}systemctl reboot` : "true",
      "printf 'patch operation completed\\n'",
    ].join("\n");
    return { hostId, securityOnly, reboot, output: await runSsh(this.config, host, script) };
  }

  async execute(operation: InfrastructureOperation) {
    const input = operation.parameters ?? {};
    if (operation.action.startsWith("service.")) {
      const action = operation.action.slice("service.".length);
      if (["start", "stop", "restart", "reload"].includes(action)) {
        const service = stringValue(input.service, "service", true) ?? "";
        return await this.client.serviceAction(
          operation.targetId,
          service,
          action as LinuxServiceAction,
        );
      }
    }
    if (operation.action === "patch.apply") return await this.applyPatch(operation.targetId, input);
    throw new Error(`Unsupported Linux infrastructure action: ${operation.action}`);
  }
}

export function createLinuxInfrastructureProvider(
  operations: LinuxPatchOperations,
): InfrastructureProvider {
  return {
    id: "linux",
    kind: "linux",
    actions: ["service.start", "service.stop", "service.restart", "service.reload", "patch.apply"],
    queries: [],
    async inventory(query) {
      return await operations.inventory(query);
    },
    async monitor() {
      return await operations.inventory();
    },
    async patchScan(targetId) {
      return await operations.patchScan(targetId);
    },
    async execute(operation) {
      return await operations.execute(operation);
    },
    rollbackFor(operation) {
      const inverse: Record<string, string> = {
        "service.start": "service.stop",
        "service.stop": "service.start",
      };
      const action = inverse[operation.action];
      return action ? { ...operation, action } : undefined;
    },
  };
}

export function registerLinuxInfrastructureProvider(
  operations: LinuxPatchOperations,
): () => void {
  return registerInfrastructureProvider(createLinuxInfrastructureProvider(operations));
}
