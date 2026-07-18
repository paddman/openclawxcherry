export type VmwareConfig = {
  baseUrl?: string;
  username?: string;
  password?: string;
  govcPath: string;
  verifyTls: boolean;
  caFile?: string;
  datacenter?: string;
  timeoutMs: number;
  allowMutations: boolean;
  allowedVmPaths: string[];
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

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.includes("://") ? value : `https://${value}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("VMware baseUrl must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Do not embed credentials in VMware baseUrl");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export function parseVmwareConfig(value: unknown): VmwareConfig {
  const raw = objectValue(value);
  return {
    baseUrl: normalizeBaseUrl(
      optionalString(raw.baseUrl) ?? optionalString(process.env.VMWARE_BASE_URL) ?? optionalString(process.env.GOVC_URL),
    ),
    username:
      optionalString(raw.username) ??
      optionalString(process.env.VMWARE_USERNAME) ??
      optionalString(process.env.GOVC_USERNAME),
    password:
      optionalString(raw.password) ??
      optionalString(process.env.VMWARE_PASSWORD) ??
      optionalString(process.env.GOVC_PASSWORD),
    govcPath: optionalString(raw.govcPath) ?? optionalString(process.env.VMWARE_GOVC_PATH) ?? "govc",
    verifyTls: booleanValue(
      raw.verifyTls,
      process.env.VMWARE_VERIFY_TLS !== "false" && process.env.GOVC_INSECURE !== "1",
    ),
    caFile:
      optionalString(raw.caFile) ??
      optionalString(process.env.VMWARE_CA_FILE) ??
      optionalString(process.env.GOVC_TLS_CA_CERTS),
    datacenter:
      optionalString(raw.datacenter) ??
      optionalString(process.env.VMWARE_DATACENTER) ??
      optionalString(process.env.GOVC_DATACENTER),
    timeoutMs: integerValue(raw.timeoutMs, 30_000, 1_000, 300_000),
    allowMutations: booleanValue(
      raw.allowMutations,
      process.env.VMWARE_ALLOW_MUTATIONS === "true",
    ),
    allowedVmPaths: stringList(raw.allowedVmPaths, process.env.VMWARE_ALLOWED_VM_PATHS),
    maxResults: integerValue(raw.maxResults, 200, 1, 2_000),
  };
}

export function configurationProblems(config: VmwareConfig): string[] {
  const problems: string[] = [];
  if (!config.baseUrl) problems.push("baseUrl, VMWARE_BASE_URL, or GOVC_URL is required");
  if (!config.username) problems.push("username, VMWARE_USERNAME, or GOVC_USERNAME is required");
  if (!config.password) problems.push("password, VMWARE_PASSWORD, or GOVC_PASSWORD is required");
  return problems;
}
