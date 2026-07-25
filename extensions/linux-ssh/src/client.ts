import { spawn } from "node:child_process";
import type { LinuxHostConfig, LinuxSshConfig } from "./config.js";
import { configurationProblems } from "./config.js";

export type LinuxServiceAction = "start" | "stop" | "restart" | "reload";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
) => Promise<CommandResult>;

function defaultRunner(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      reject(new Error(`Linux SSH command timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    const enforceLimit = () => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > options.maxOutputBytes) {
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
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > options.maxOutputBytes) {
        reject(new Error(`Linux SSH output exceeded ${options.maxOutputBytes} bytes`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function validateService(service: string): string {
  const trimmed = service.trim();
  if (!/^[A-Za-z0-9@_.:-]{1,128}$/u.test(trimmed)) {
    throw new Error("service must be a valid systemd unit name");
  }
  return trimmed;
}

function parseKeyValue(text: string): Record<string, string> {
  const data: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    data[line.slice(0, index)] = line.slice(index + 1);
  }
  return data;
}

export class LinuxSshClient {
  constructor(
    private readonly config: LinuxSshConfig,
    private readonly runner: CommandRunner = defaultRunner,
  ) {}

  getConfigurationStatus() {
    const problems = configurationProblems(this.config);
    return {
      configured: problems.length === 0,
      hosts: this.config.hosts.map((host) => ({
        id: host.id,
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        allowedServices: host.allowedServices,
      })),
      allowMutations: this.config.allowMutations,
      problems,
    };
  }

  listHosts() {
    return this.config.hosts.map((host) => ({
      id: host.id,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      strictHostKeyChecking: host.strictHostKeyChecking,
      sudo: host.sudo,
      allowedServices: host.allowedServices,
    }));
  }

  private host(hostId: string): LinuxHostConfig {
    const host = this.config.hosts.find((entry) => entry.id === hostId);
    if (!host) throw new Error(`Unknown Linux host id: ${hostId}`);
    return host;
  }

  private sshArgs(host: LinuxHostConfig, command: string): string[] {
    const args = [
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${Math.max(1, Math.ceil(this.config.timeoutMs / 1000))}`,
      "-o",
      `StrictHostKeyChecking=${host.strictHostKeyChecking}`,
      "-p",
      String(host.port),
    ];
    if (host.identityFile) args.push("-i", host.identityFile);
    if (host.knownHostsFile) args.push("-o", `UserKnownHostsFile=${host.knownHostsFile}`);
    args.push(`${host.username}@${host.hostname}`, command);
    return args;
  }

  private async run(hostId: string, command: string): Promise<string> {
    const host = this.host(hostId);
    const result = await this.runner(this.config.sshPath, this.sshArgs(host, command), {
      env: process.env,
      timeoutMs: this.config.timeoutMs,
      maxOutputBytes: this.config.maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`Linux SSH command failed on ${host.id}: ${message}`);
    }
    return result.stdout.trim();
  }

  async testConnection(hostId: string) {
    const output = await this.run(
      hostId,
      "printf 'hostname='; hostname; printf 'kernel='; uname -sr; printf 'user='; id -un",
    );
    return { hostId, ...parseKeyValue(output) };
  }

  async systemStatus(hostId: string) {
    const script = [
      "printf 'hostname='; hostname",
      "printf 'kernel='; uname -srmo",
      "printf 'uptimeSeconds='; cut -d. -f1 /proc/uptime",
      "printf 'loadAverage='; cat /proc/loadavg",
      "printf 'memoryTotalKb='; awk '/^MemTotal:/{print $2}' /proc/meminfo",
      "printf 'memoryAvailableKb='; awk '/^MemAvailable:/{print $2}' /proc/meminfo",
      "printf 'rootFilesystem='; df -P -B1 / | awk 'NR==2{print $2\",\"$3\",\"$4\",\"$5}'",
      "printf 'os='; if [ -r /etc/os-release ]; then . /etc/os-release; printf '%s' \"${PRETTY_NAME:-$NAME}\"; else uname -s; fi; printf '\\n'",
      "printf 'failedUnits='; systemctl --failed --no-legend --plain 2>/dev/null | wc -l || printf 'unknown'",
    ].join("; ");
    return { hostId, ...parseKeyValue(await this.run(hostId, script)) };
  }

  private assertServiceAllowed(host: LinuxHostConfig, service: string, mutation: boolean) {
    if (host.allowedServices.length > 0 && !host.allowedServices.includes(service)) {
      throw new Error(`Service is outside allowedServices for ${host.id}: ${service}`);
    }
    if (mutation && host.allowedServices.length === 0) {
      throw new Error(`Service mutations require a non-empty allowedServices list for ${host.id}`);
    }
  }

  async serviceStatus(hostId: string, serviceName: string) {
    const host = this.host(hostId);
    const service = validateService(serviceName);
    this.assertServiceAllowed(host, service, false);
    const output = await this.run(
      hostId,
      `systemctl show --no-pager --property=Id,Description,LoadState,ActiveState,SubState,UnitFileState ${service}`,
    );
    return { hostId, service, ...parseKeyValue(output) };
  }

  async serviceLogs(hostId: string, serviceName: string, lines = 100) {
    const host = this.host(hostId);
    const service = validateService(serviceName);
    this.assertServiceAllowed(host, service, false);
    const count = Math.min(Math.max(lines, 1), 2_000);
    const output = await this.run(
      hostId,
      `journalctl -u ${service} -n ${count} --no-pager -o short-iso 2>&1`,
    );
    return { hostId, service, lines: count, output };
  }

  async serviceAction(hostId: string, serviceName: string, action: LinuxServiceAction) {
    if (!this.config.allowMutations) {
      throw new Error("Linux mutations are disabled; set allowMutations to true explicitly");
    }
    const host = this.host(hostId);
    const service = validateService(serviceName);
    this.assertServiceAllowed(host, service, true);
    const prefix = host.sudo ? "sudo -n " : "";
    const output = await this.run(
      hostId,
      `${prefix}systemctl ${action} ${service} && systemctl show --no-pager --property=ActiveState,SubState ${service}`,
    );
    return { hostId, service, action, ...parseKeyValue(output) };
  }
}
