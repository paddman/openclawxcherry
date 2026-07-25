export type WindowsTransport = "auto" | "ssh" | "winrm";
export type WinrmAuthentication = "Default" | "Negotiate" | "Kerberos" | "Basic";
export type StrictHostKeyChecking = "yes" | "accept-new" | "no";

export type WindowsHostConfig = {
  id: string;
  hostname: string;
  transport: WindowsTransport;
  username: string;
  port: number;
  identityFile?: string;
  knownHostsFile?: string;
  strictHostKeyChecking: StrictHostKeyChecking;
  useSsl: boolean;
  passwordEnv?: string;
  authentication: WinrmAuthentication;
  allowedServices: string[];
};

export type WindowsServerConfig = {
  sshPath: string;
  powershellPath: string;
  timeoutMs: number;
  maxOutputBytes: number;
  allowMutations: boolean;
  hosts: WindowsHostConfig[];
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integerValue(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function stringList(value: unknown, envValue?: string): string[] {
  const source = Array.isArray(value) ? value : envValue ? envValue.split(",") : [];
  return [
    ...new Set(
      source
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function transportValue(value: unknown): WindowsTransport {
  return value === "ssh" || value === "winrm" || value === "auto" ? value : "auto";
}

function authenticationValue(value: unknown): WinrmAuthentication {
  return value === "Default" ||
    value === "Negotiate" ||
    value === "Kerberos" ||
    value === "Basic"
    ? value
    : "Negotiate";
}

function strictValue(value: unknown): StrictHostKeyChecking {
  return value === "yes" || value === "accept-new" || value === "no" ? value : "yes";
}

function parseHost(value: unknown, index: number): WindowsHostConfig | undefined {
  const raw = objectValue(value);
  const hostname = optionalString(raw.hostname);
  const username = optionalString(raw.username);
  if (!hostname || !username) return undefined;
  const useSsl = booleanValue(raw.useSsl, true);
  const transport = transportValue(raw.transport);
  const passwordEnv = optionalString(raw.passwordEnv);
  const resolvedTransport =
    transport === "auto" ? (process.platform === "win32" && passwordEnv ? "winrm" : "ssh") : transport;
  const defaultPort = resolvedTransport === "ssh" ? 22 : useSsl ? 5986 : 5985;
  return {
    id: optionalString(raw.id) ?? `windows-${index + 1}`,
    hostname,
    transport,
    username,
    port: integerValue(raw.port, defaultPort, 1, 65535),
    identityFile: optionalString(raw.identityFile),
    knownHostsFile: optionalString(raw.knownHostsFile),
    strictHostKeyChecking: strictValue(raw.strictHostKeyChecking),
    useSsl,
    passwordEnv,
    authentication: authenticationValue(raw.authentication),
    allowedServices: stringList(raw.allowedServices),
  };
}

function environmentHost(): WindowsHostConfig | undefined {
  const hostname = optionalString(process.env.WINDOWS_HOSTNAME);
  const username = optionalString(process.env.WINDOWS_USERNAME);
  if (!hostname || !username) return undefined;
  const transport = transportValue(process.env.WINDOWS_TRANSPORT);
  const useSsl = process.env.WINDOWS_USE_SSL !== "false";
  const passwordEnv = optionalString(process.env.WINDOWS_PASSWORD_ENV) ?? "WINDOWS_PASSWORD";
  const resolvedTransport =
    transport === "auto" ? (process.platform === "win32" && process.env[passwordEnv] ? "winrm" : "ssh") : transport;
  return {
    id: optionalString(process.env.WINDOWS_HOST_ID) ?? "default",
    hostname,
    transport,
    username,
    port: integerValue(
      Number(process.env.WINDOWS_PORT),
      resolvedTransport === "ssh" ? 22 : useSsl ? 5986 : 5985,
      1,
      65535,
    ),
    identityFile: optionalString(process.env.WINDOWS_IDENTITY_FILE),
    knownHostsFile: optionalString(process.env.WINDOWS_KNOWN_HOSTS_FILE),
    strictHostKeyChecking: strictValue(process.env.WINDOWS_STRICT_HOST_KEY_CHECKING),
    useSsl,
    passwordEnv,
    authentication: authenticationValue(process.env.WINDOWS_AUTHENTICATION),
    allowedServices: stringList(undefined, process.env.WINDOWS_ALLOWED_SERVICES),
  };
}

export function parseWindowsServerConfig(value: unknown): WindowsServerConfig {
  const raw = objectValue(value);
  const configuredHosts = Array.isArray(raw.hosts)
    ? raw.hosts
        .map((host, index) => parseHost(host, index))
        .filter((host): host is WindowsHostConfig => Boolean(host))
    : [];
  const fallbackHost = environmentHost();
  const hosts = configuredHosts.length > 0 ? configuredHosts : fallbackHost ? [fallbackHost] : [];
  const ids = new Set<string>();
  for (const host of hosts) {
    if (ids.has(host.id)) throw new Error(`Duplicate Windows host id: ${host.id}`);
    ids.add(host.id);
  }
  return {
    sshPath: optionalString(raw.sshPath) ?? optionalString(process.env.WINDOWS_SSH_PATH) ?? "ssh",
    powershellPath:
      optionalString(raw.powershellPath) ??
      optionalString(process.env.WINDOWS_POWERSHELL_PATH) ??
      (process.platform === "win32" ? "powershell.exe" : "pwsh"),
    timeoutMs: integerValue(raw.timeoutMs, 30_000, 1_000, 300_000),
    maxOutputBytes: integerValue(raw.maxOutputBytes, 2_000_000, 10_000, 10_000_000),
    allowMutations: booleanValue(
      raw.allowMutations,
      process.env.WINDOWS_ALLOW_MUTATIONS === "true",
    ),
    hosts,
  };
}

export function configurationProblems(config: WindowsServerConfig): string[] {
  const problems: string[] = [];
  if (config.hosts.length === 0) {
    problems.push("at least one hosts entry or WINDOWS_HOSTNAME/WINDOWS_USERNAME is required");
  }
  return problems;
}
