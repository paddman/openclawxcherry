export type ProxmoxConfig = {
  baseUrl?: string;
  tokenId?: string;
  tokenSecret?: string;
  verifyTls: boolean;
  caFile?: string;
  timeoutMs: number;
  allowMutations: boolean;
  allowedNodes: string[];
  allowedVmids: number[];
  maxResults: number;
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

function numberList(value: unknown, envValue?: string): number[] {
  const source = Array.isArray(value) ? value : envValue ? envValue.split(",") : [];
  return [
    ...new Set(
      source
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0),
    ),
  ];
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Proxmox baseUrl must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Do not embed credentials in Proxmox baseUrl");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/api2\/json\/?$/u, "").replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export function parseProxmoxConfig(value: unknown): ProxmoxConfig {
  const raw = objectValue(value);
  return {
    baseUrl: normalizeBaseUrl(
      optionalString(raw.baseUrl) ?? optionalString(process.env.PROXMOX_BASE_URL),
    ),
    tokenId: optionalString(raw.tokenId) ?? optionalString(process.env.PROXMOX_TOKEN_ID),
    tokenSecret:
      optionalString(raw.tokenSecret) ?? optionalString(process.env.PROXMOX_TOKEN_SECRET),
    verifyTls: booleanValue(raw.verifyTls, process.env.PROXMOX_VERIFY_TLS !== "false"),
    caFile: optionalString(raw.caFile) ?? optionalString(process.env.PROXMOX_CA_FILE),
    timeoutMs: integerValue(raw.timeoutMs, 15_000, 1_000, 120_000),
    allowMutations: booleanValue(
      raw.allowMutations,
      process.env.PROXMOX_ALLOW_MUTATIONS === "true",
    ),
    allowedNodes: stringList(raw.allowedNodes, process.env.PROXMOX_ALLOWED_NODES),
    allowedVmids: numberList(raw.allowedVmids, process.env.PROXMOX_ALLOWED_VMIDS),
    maxResults: integerValue(raw.maxResults, 200, 10, 1_000),
  };
}

export function configurationProblems(config: ProxmoxConfig): string[] {
  const problems: string[] = [];
  if (!config.baseUrl) problems.push("baseUrl or PROXMOX_BASE_URL is required");
  if (!config.tokenId) problems.push("tokenId or PROXMOX_TOKEN_ID is required");
  if (!config.tokenSecret) problems.push("tokenSecret or PROXMOX_TOKEN_SECRET is required");
  return problems;
}
