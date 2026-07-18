import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type InfrastructureAlertWebhook = {
  id: string;
  url: string;
  tokenEnv?: string;
  minimumSeverity: "warning" | "critical";
};

export type InfrastructureThresholds = {
  cpuWarningPercent: number;
  cpuCriticalPercent: number;
  memoryWarningPercent: number;
  memoryCriticalPercent: number;
  diskWarningPercent: number;
  diskCriticalPercent: number;
};

export type InfrastructureControlConfig = {
  allowMutations: boolean;
  stateDir: string;
  auditLogFile: string;
  maxConcurrency: number;
  maxInventoryResults: number;
  monitoringIntervalSeconds: number;
  alertCooldownMinutes: number;
  thresholds: InfrastructureThresholds;
  alertWebhooks: InfrastructureAlertWebhook[];
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

function numberValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function integerValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function expandPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function webhookValue(value: unknown, index: number): InfrastructureAlertWebhook | undefined {
  const raw = objectValue(value);
  const urlValue = optionalString(raw.url);
  if (!urlValue) return undefined;
  const url = new URL(urlValue);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Infrastructure alert webhook URLs must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Do not embed credentials in an infrastructure alert webhook URL");
  }
  return {
    id: optionalString(raw.id) ?? `webhook-${index + 1}`,
    url: url.toString(),
    tokenEnv: optionalString(raw.tokenEnv),
    minimumSeverity: raw.minimumSeverity === "critical" ? "critical" : "warning",
  };
}

export function parseInfrastructureControlConfig(value: unknown): InfrastructureControlConfig {
  const raw = objectValue(value);
  const thresholdRaw = objectValue(raw.thresholds);
  const stateDir = expandPath(
    optionalString(raw.stateDir) ??
      optionalString(process.env.INFRA_STATE_DIR) ??
      "~/.openclaw/infrastructure-control",
  );
  const auditLogFile = expandPath(
    optionalString(raw.auditLogFile) ??
      optionalString(process.env.INFRA_AUDIT_LOG_FILE) ??
      join(stateDir, "audit.jsonl"),
  );
  const alertWebhooks = Array.isArray(raw.alertWebhooks)
    ? raw.alertWebhooks
        .map((entry, index) => webhookValue(entry, index))
        .filter((entry): entry is InfrastructureAlertWebhook => Boolean(entry))
    : [];
  return {
    allowMutations: booleanValue(
      raw.allowMutations,
      process.env.INFRA_ALLOW_MUTATIONS === "true",
    ),
    stateDir,
    auditLogFile,
    maxConcurrency: integerValue(raw.maxConcurrency, 5, 1, 25),
    maxInventoryResults: integerValue(raw.maxInventoryResults, 1_000, 10, 10_000),
    monitoringIntervalSeconds: integerValue(raw.monitoringIntervalSeconds, 0, 0, 86_400),
    alertCooldownMinutes: integerValue(raw.alertCooldownMinutes, 30, 1, 10_080),
    thresholds: {
      cpuWarningPercent: numberValue(thresholdRaw.cpuWarningPercent, 80, 1, 100),
      cpuCriticalPercent: numberValue(thresholdRaw.cpuCriticalPercent, 95, 1, 100),
      memoryWarningPercent: numberValue(thresholdRaw.memoryWarningPercent, 80, 1, 100),
      memoryCriticalPercent: numberValue(thresholdRaw.memoryCriticalPercent, 95, 1, 100),
      diskWarningPercent: numberValue(thresholdRaw.diskWarningPercent, 85, 1, 100),
      diskCriticalPercent: numberValue(thresholdRaw.diskCriticalPercent, 95, 1, 100),
    },
    alertWebhooks,
  };
}

export function configurationProblems(config: InfrastructureControlConfig): string[] {
  const problems: string[] = [];
  if (config.thresholds.cpuCriticalPercent < config.thresholds.cpuWarningPercent) {
    problems.push("cpuCriticalPercent must be greater than or equal to cpuWarningPercent");
  }
  if (config.thresholds.memoryCriticalPercent < config.thresholds.memoryWarningPercent) {
    problems.push(
      "memoryCriticalPercent must be greater than or equal to memoryWarningPercent",
    );
  }
  if (config.thresholds.diskCriticalPercent < config.thresholds.diskWarningPercent) {
    problems.push("diskCriticalPercent must be greater than or equal to diskWarningPercent");
  }
  return problems;
}
