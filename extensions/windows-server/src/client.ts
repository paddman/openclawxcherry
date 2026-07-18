import { spawn } from "node:child_process";
import type { WindowsHostConfig, WindowsServerConfig, WindowsTransport } from "./config.js";
import { configurationProblems } from "./config.js";

export type WindowsServiceAction = "start" | "stop" | "restart";

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
      reject(new Error(`Windows remote command timed out after ${options.timeoutMs} ms`));
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
        reject(new Error(`Windows remote output exceeded ${options.maxOutputBytes} bytes`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function psQuote(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function validateService(service: string): string {
  const trimmed = service.trim();
  if (!/^[A-Za-z0-9_. -]{1,128}$/u.test(trimmed)) {
    throw new Error("service must be a valid Windows service name");
  }
  return trimmed;
}

function validateLogName(logName: string): string {
  const trimmed = logName.trim();
  if (!/^[A-Za-z0-9 _./-]{1,160}$/u.test(trimmed)) {
    throw new Error("logName contains unsupported characters");
  }
  return trimmed;
}

function parseJson(text: string, context: string): unknown {
  const trimmed = text.trim().replace(/^\uFEFF/u, "");
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${context} returned invalid JSON: ${trimmed.slice(0, 500)}`);
  }
}

export class WindowsServerClient {
  constructor(
    private readonly config: WindowsServerConfig,
    private readonly runner: CommandRunner = defaultRunner,
  ) {}

  getConfigurationStatus() {
    const problems = configurationProblems(this.config);
    return {
      configured: problems.length === 0,
      hosts: this.listHosts(),
      allowMutations: this.config.allowMutations,
      problems,
    };
  }

  listHosts() {
    return this.config.hosts.map((host) => ({
      id: host.id,
      hostname: host.hostname,
      transport: this.resolveTransport(host),
      port: host.port,
      username: host.username,
      useSsl: host.useSsl,
      authentication: host.authentication,
      allowedServices: host.allowedServices,
    }));
  }

  private host(hostId: string): WindowsHostConfig {
    const host = this.config.hosts.find((entry) => entry.id === hostId);
    if (!host) throw new Error(`Unknown Windows host id: ${hostId}`);
    return host;
  }

  private resolveTransport(host: WindowsHostConfig): Exclude<WindowsTransport, "auto"> {
    if (host.transport !== "auto") return host.transport;
    return process.platform === "win32" && host.passwordEnv ? "winrm" : "ssh";
  }

  private sshArgs(host: WindowsHostConfig, encodedScript: string): string[] {
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
    args.push(
      `${host.username}@${host.hostname}`,
      `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedScript}`,
    );
    return args;
  }

  private winrmInvocation(host: WindowsHostConfig, remoteEncodedScript: string): string {
    if (process.platform !== "win32") {
      throw new Error(
        "WinRM transport requires the OpenClaw Gateway to run on Windows; use SSH transport from Linux or macOS",
      );
    }
    if (!host.passwordEnv) {
      throw new Error(`WinRM host ${host.id} requires passwordEnv`);
    }
    const password = process.env[host.passwordEnv];
    if (!password) {
      throw new Error(`Environment variable ${host.passwordEnv} is required for WinRM host ${host.id}`);
    }
    const useSsl = host.useSsl ? "$params.UseSSL = $true" : "";
    return [
      "$ErrorActionPreference = 'Stop'",
      `$secure = ConvertTo-SecureString $env:OPENCLAW_WINDOWS_PASSWORD -AsPlainText -Force`,
      `$credential = New-Object System.Management.Automation.PSCredential(${psQuote(host.username)}, $secure)`,
      `$remoteScript = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(${psQuote(remoteEncodedScript)}))`,
      "$params = @{",
      `  ComputerName = ${psQuote(host.hostname)}`,
      `  Port = ${host.port}`,
      "  Credential = $credential",
      `  Authentication = ${psQuote(host.authentication)}`,
      "  ScriptBlock = [ScriptBlock]::Create($remoteScript)",
      "}",
      useSsl,
      "Invoke-Command @params",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async run(hostId: string, script: string): Promise<unknown> {
    const host = this.host(hostId);
    const transport = this.resolveTransport(host);
    const remoteScript = `$ErrorActionPreference = 'Stop'\n${script}`;
    const encoded = encodePowerShell(remoteScript);
    let command: string;
    let args: string[];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (transport === "ssh") {
      command = this.config.sshPath;
      args = this.sshArgs(host, encoded);
    } else {
      command = this.config.powershellPath;
      args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(this.winrmInvocation(host, encoded))];
      env.OPENCLAW_WINDOWS_PASSWORD = process.env[host.passwordEnv ?? ""];
    }
    const response = await this.runner(command, args, {
      env,
      timeoutMs: this.config.timeoutMs,
      maxOutputBytes: this.config.maxOutputBytes,
    });
    delete env.OPENCLAW_WINDOWS_PASSWORD;
    if (response.exitCode !== 0) {
      const message = response.stderr.trim() || response.stdout.trim() || `exit code ${response.exitCode}`;
      throw new Error(`Windows ${transport} command failed on ${host.id}: ${message}`);
    }
    return parseJson(response.stdout, `Windows ${transport} command`);
  }

  async testConnection(hostId: string) {
    const script = `
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
  ComputerName = $env:COMPUTERNAME
  User = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  PSVersion = $PSVersionTable.PSVersion.ToString()
  Caption = $os.Caption
  Version = $os.Version
  BuildNumber = $os.BuildNumber
  LastBootUpTime = $os.LastBootUpTime
} | ConvertTo-Json -Compress -Depth 4`;
    return { hostId, transport: this.resolveTransport(this.host(hostId)), details: await this.run(hostId, script) };
  }

  async systemStatus(hostId: string) {
    const script = `
$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,VolumeName,Size,FreeSpace
$pendingReboot = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')
[pscustomobject]@{
  ComputerName = $env:COMPUTERNAME
  Caption = $os.Caption
  Version = $os.Version
  BuildNumber = $os.BuildNumber
  LastBootUpTime = $os.LastBootUpTime
  TotalVisibleMemoryKB = $os.TotalVisibleMemorySize
  FreePhysicalMemoryKB = $os.FreePhysicalMemory
  Manufacturer = $computer.Manufacturer
  Model = $computer.Model
  LogicalProcessors = $computer.NumberOfLogicalProcessors
  Domain = $computer.Domain
  PendingReboot = $pendingReboot
  Disks = @($disks)
  StoppedAutomaticServices = @((Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.State -ne 'Running' } | Select-Object Name,DisplayName,State,StartMode))
} | ConvertTo-Json -Compress -Depth 6`;
    return { hostId, details: await this.run(hostId, script) };
  }

  private assertServiceAllowed(host: WindowsHostConfig, service: string, mutation: boolean) {
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
    const script = `Get-CimInstance Win32_Service -Filter "Name='${service.replace(/'/gu, "''")}'" | Select-Object Name,DisplayName,State,StartMode,ProcessId,PathName,StartName | ConvertTo-Json -Compress -Depth 4`;
    return { hostId, service, details: await this.run(hostId, script) };
  }

  async eventLogs(hostId: string, logName: string, maxEvents = 100) {
    const log = validateLogName(logName);
    const count = Math.min(Math.max(maxEvents, 1), 1_000);
    const script = `Get-WinEvent -LogName ${psQuote(log)} -MaxEvents ${count} | Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,Message | ConvertTo-Json -Compress -Depth 4`;
    return { hostId, logName: log, maxEvents: count, events: await this.run(hostId, script) };
  }

  async serviceAction(hostId: string, serviceName: string, action: WindowsServiceAction) {
    if (!this.config.allowMutations) {
      throw new Error("Windows mutations are disabled; set allowMutations to true explicitly");
    }
    const host = this.host(hostId);
    const service = validateService(serviceName);
    this.assertServiceAllowed(host, service, true);
    const cmdlet: Record<WindowsServiceAction, string> = {
      start: "Start-Service",
      stop: "Stop-Service",
      restart: "Restart-Service",
    };
    const script = `${cmdlet[action]} -Name ${psQuote(service)} -ErrorAction Stop; Get-Service -Name ${psQuote(service)} | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress -Depth 4`;
    return { hostId, service, action, details: await this.run(hostId, script) };
  }
}
