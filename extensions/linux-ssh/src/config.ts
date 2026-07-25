export type StrictHostKeyChecking = "yes" | "accept-new" | "no";

export type LinuxHostConfig = {
  id: string;
  hostname: string;
  port: number;
  username: string;
  identityFile?: string;
  knownHostsFile?: string;
  strictHostKeyChecking: StrictHostKeyChecking;
  sudo: boolean;
  allowedServices: string[];
};

export type LinuxSshConfig = {
  sshPath: string;
  timeoutMs: number;
  maxOutputBytes: number;
  allowMutations: boolean;
  hosts: LinuxHostConfig[];
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

function strictValue(value: unknown): StrictHostKeyChecking {
  return value === "yes" || value === "accept-new" || value === "no" ? value : "yes";
}

function parseHost(value: unknown, index: number): LinuxHostConfig | undefined {
  const raw = objectValue(value);
  const hostname = optionalString(raw.hostname);
  const username = optionalString(raw.username);
  if (!hostname || !username) return undefined;
  return {
    id: optionalString(raw.id) ?? `linux-${index + 1}`,
    hostname,
    port: integerValue(raw.port, 22, 1, 65535),
    username,
    identityFile: optionalString(raw.identityFile),
    knownHostsFile: optionalString(raw.knownHostsFile),
    strictHostKeyChecking: strictValue(raw.strictHostKeyChecking),
    sudo: booleanValue(raw.sudo, true),
    allowedServices: stringList(raw.allowedServices),
  };
}

function environmentHost(): LinuxHostConfig | undefined {
  const hostname = optionalString(process.env.LINUX_HOSTNAME);
  const username = optionalString(process.env.LINUX_USERNAME);
  if (!hostname || !username) return undefined;
  return {
    id: optionalString(process.env.LINUX_HOST_ID) ?? "default",
    hostname,
    port: integerValue(Number(process.env.LINUX_PORT), 22, 1, 65535),
    username,
    identityFile: optionalString(process.env.LINUX_IDENTITY_FILE),
    knownHostsFile: optionalString(process.env.LINUX_KNOWN_HOSTS_FILE),
    strictHostKeyChecking: strictValue(process.env.LINUX_STRICT_HOST_KEY_CHECKING),
    sudo: process.env.LINUX_SUDO !== "false",
    allowedServices: stringList(undefined, process.env.LINUX_ALLOWED_SERVICES),
  };
}

export function parseLinuxSshConfig(value: unknown): LinuxSshConfig {
  const raw = objectValue(value);
  const configuredHosts = Array.isArray(raw.hosts)
    ? raw.hosts
        .map((host, index) => parseHost(host, index))
        .filter((host): host is LinuxHostConfig => Boolean(host))
    : [];
  const fallbackHost = environmentHost();
  const hosts = configuredHosts.length > 0 ? configuredHosts : fallbackHost ? [fallbackHost] : [];
  const ids = new Set<string>();
  for (const host of hosts) {
    if (ids.has(host.id)) throw new Error(`Duplicate Linux host id: ${host.id}`);
    ids.add(host.id);
  }
  return {
    sshPath: optionalString(raw.sshPath) ?? optionalString(process.env.LINUX_SSH_PATH) ?? "ssh",
    timeoutMs: integerValue(raw.timeoutMs, 20_000, 1_000, 300_000),
    maxOutputBytes: integerValue(raw.maxOutputBytes, 1_000_000, 10_000, 10_000_000),
    allowMutations: booleanValue(
      raw.allowMutations,
      process.env.LINUX_ALLOW_MUTATIONS === "true",
    ),
    hosts,
  };
}

export function configurationProblems(config: LinuxSshConfig): string[] {
  const problems: string[] = [];
  if (config.hosts.length === 0) {
    problems.push("at least one hosts entry or LINUX_HOSTNAME/LINUX_USERNAME is required");
  }
  return problems;
}
