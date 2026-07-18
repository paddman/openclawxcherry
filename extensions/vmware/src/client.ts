import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { VmwareConfig } from "./config.js";
import { configurationProblems } from "./config.js";

export type VmwarePowerAction = "start" | "shutdown" | "reboot" | "reset" | "stop" | "suspend";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<CommandResult>;

function defaultRunner(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
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
      reject(new Error(`VMware command timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);

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
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function parseJson(text: string, context: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function versionMajor(value: unknown): number | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  const major = Number(text.split(".")[0]);
  return Number.isInteger(major) ? major : undefined;
}

type VmwareAboutSummary = {
  name?: unknown;
  vendor?: unknown;
  version?: unknown;
  build?: unknown;
  apiType?: unknown;
  apiVersion?: unknown;
  productLineId?: unknown;
  supportedMajorRange: boolean | "unknown";
  raw: Record<string, unknown>;
};

function flattenAbout(value: unknown): VmwareAboutSummary {
  const root = objectValue(value);
  const about = objectValue(root.About ?? root.about ?? root);
  const apiVersion = about.ApiVersion ?? about.apiVersion;
  const version = about.Version ?? about.version;
  const major = versionMajor(apiVersion ?? version);
  return {
    name: about.Name ?? about.name,
    vendor: about.Vendor ?? about.vendor,
    version,
    build: about.Build ?? about.build,
    apiType: about.ApiType ?? about.apiType,
    apiVersion,
    productLineId: about.ProductLineId ?? about.productLineId,
    supportedMajorRange: major === undefined ? "unknown" : major >= 6 && major <= 9,
    raw: about,
  };
}

function pathAllowed(path: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

function sanitizeFilter(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 256 || /[\r\n\0]/u.test(trimmed)) {
    throw new Error(`${name} contains unsupported characters`);
  }
  return trimmed;
}

export class VmwareClient {
  constructor(
    private readonly config: VmwareConfig,
    private readonly runner: CommandRunner = defaultRunner,
  ) {}

  getConfigurationStatus() {
    const problems = configurationProblems(this.config);
    return {
      configured: problems.length === 0,
      endpoint: this.config.baseUrl,
      govcPath: this.config.govcPath,
      allowMutations: this.config.allowMutations,
      allowedVmPaths: this.config.allowedVmPaths,
      problems,
    };
  }

  private environment(): NodeJS.ProcessEnv {
    const problems = configurationProblems(this.config);
    if (problems.length > 0) {
      throw new Error(`VMware connector is not configured: ${problems.join("; ")}`);
    }
    const baseUrl = this.config.baseUrl;
    const username = this.config.username;
    const password = this.config.password;
    if (!baseUrl || !username || !password) {
      throw new Error("VMware connector credentials are incomplete");
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GOVC_URL: baseUrl,
      GOVC_USERNAME: username,
      GOVC_PASSWORD: password,
      GOVC_INSECURE: this.config.verifyTls ? "0" : "1",
      GOVC_PERSIST_SESSION: "false",
    };
    if (this.config.caFile) {
      readFileSync(this.config.caFile);
      env.GOVC_TLS_CA_CERTS = this.config.caFile;
    }
    if (this.config.datacenter) env.GOVC_DATACENTER = this.config.datacenter;
    return env;
  }

  private async run(args: string[], json?: false): Promise<string>;
  private async run(args: string[], json: true): Promise<unknown>;
  private async run(args: string[], json = false): Promise<string | unknown> {
    const result = await this.runner(this.config.govcPath, args, {
      env: this.environment(),
      timeoutMs: this.config.timeoutMs,
    });
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`govc ${args[0] ?? "command"} failed: ${message}`);
    }
    return json ? parseJson(result.stdout, `govc ${args[0] ?? "command"}`) : result.stdout.trim();
  }

  async testConnection() {
    const [about, govcVersion] = await Promise.all([
      this.run(["about", "-json"], true),
      this.run(["version"]),
    ]);
    return {
      endpoint: this.config.baseUrl,
      govcVersion,
      ...flattenAbout(about),
      compatibility:
        "Uses govc/vSphere Web Services API so the same connector works with vCenter or direct ESXi across vSphere 6.x through 9.x, subject to server privileges and govc compatibility.",
    };
  }

  async listVirtualMachines(options: {
    name?: string;
    powerState?: string;
    limit?: number;
  } = {}) {
    const name = sanitizeFilter(options.name, "name");
    const powerState = sanitizeFilter(options.powerState, "powerState");
    const limit = Math.min(options.limit ?? this.config.maxResults, this.config.maxResults);
    const args = ["find", ".", "-type", "m"];
    if (name) args.push("-name", name);
    if (powerState) args.push("-runtime.powerState", powerState);
    const output = String(await this.run(args));
    const allPaths = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((path) => pathAllowed(path, this.config.allowedVmPaths));
    return {
      totalMatched: allPaths.length,
      truncated: allPaths.length > limit,
      virtualMachines: allPaths.slice(0, limit).map((path) => ({
        path,
        name: path.split("/").filter(Boolean).at(-1) ?? path,
      })),
    };
  }

  async getVirtualMachine(path: string) {
    const normalized = sanitizeFilter(path, "path");
    if (!normalized) throw new Error("path is required");
    if (!pathAllowed(normalized, this.config.allowedVmPaths)) {
      throw new Error(`VM path is outside allowedVmPaths: ${normalized}`);
    }
    const details = await this.run(["vm.info", "-json", normalized], true);
    return { path: normalized, details };
  }

  async powerAction(path: string, action: VmwarePowerAction) {
    if (!this.config.allowMutations) {
      throw new Error("VMware mutations are disabled; set allowMutations to true explicitly");
    }
    const normalized = sanitizeFilter(path, "path");
    if (!normalized) throw new Error("path is required");
    if (!pathAllowed(normalized, this.config.allowedVmPaths)) {
      throw new Error(`VM path is outside allowedVmPaths: ${normalized}`);
    }
    const flags: Record<VmwarePowerAction, string[]> = {
      start: ["-on"],
      shutdown: ["-s"],
      reboot: ["-r"],
      reset: ["-reset"],
      stop: ["-off"],
      suspend: ["-suspend"],
    };
    const output = await this.run(["vm.power", ...flags[action], "-wait=true", normalized]);
    return { path: normalized, action, output };
  }

  async recentTasks(path?: string, limit = 25) {
    const normalized = path ? sanitizeFilter(path, "path") : undefined;
    if (normalized && !pathAllowed(normalized, this.config.allowedVmPaths)) {
      throw new Error(`VM path is outside allowedVmPaths: ${normalized}`);
    }
    const count = Math.min(Math.max(limit, 1), 200);
    const args = ["tasks", "-n", String(count)];
    if (normalized) args.push(normalized);
    return { path: normalized, output: await this.run(args) };
  }
}
