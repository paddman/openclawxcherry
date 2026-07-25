import type { InfrastructureControlConfig } from "./config.js";
import {
  type InfrastructureOperation,
  type InfrastructureOperationResult,
  type InfrastructureResource,
} from "../runtime-api.js";

export type InfrastructureAlert = {
  fingerprint: string;
  severity: "warning" | "critical";
  providerId: string;
  targetId: string;
  targetName: string;
  metric: "status" | "cpu" | "memory" | "disk";
  value?: number | string;
  message: string;
  observedAt: string;
};

export function textMatches(resource: InfrastructureResource, query: string | undefined): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [
    resource.id,
    resource.name,
    resource.status,
    resource.parent,
    resource.address,
    resource.providerId,
    resource.providerKind,
    resource.kind,
    JSON.stringify(resource.metadata ?? {}),
  ].some((value) => value?.toLowerCase().includes(needle));
}

export function operationResult(
  operation: InfrastructureOperation,
  startedAt: string,
  result: unknown,
): InfrastructureOperationResult {
  return {
    operation,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: true,
    result,
  };
}

export function operationError(
  operation: InfrastructureOperation,
  startedAt: string,
  error: unknown,
): InfrastructureOperationResult {
  return {
    operation,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function runWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  shouldStop: (result: R) => boolean,
  worker: (value: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = Array.from({ length: values.length });
  let cursor = 0;
  let stopped = false;

  const runWorker = async () => {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      const result = await worker(values[index] as T, index);
      results[index] = result;
      if (shouldStop(result)) stopped = true;
    }
  };

  const workers = Array.from(
    {
      length: Math.min(Math.max(concurrency, 1), Math.max(values.length, 1)),
    },
    () => runWorker(),
  );
  await Promise.all(workers);
  return results;
}

export function alertForResource(
  resource: InfrastructureResource,
  config: InfrastructureControlConfig,
): InfrastructureAlert[] {
  const alerts: InfrastructureAlert[] = [];
  const status = resource.status?.toLowerCase();
  if (
    status &&
    ["down", "failed", "critical", "error", "disconnected", "unavailable"].includes(status)
  ) {
    alerts.push({
      fingerprint: `${resource.providerId}:${resource.id}:status:${status}`,
      severity: "critical",
      providerId: resource.providerId,
      targetId: resource.id,
      targetName: resource.name,
      metric: "status",
      value: status,
      message: `${resource.name} reported status ${status}`,
      observedAt: resource.observedAt,
    });
  }

  const metricAlert = (
    metric: "cpu" | "memory" | "disk",
    value: number | undefined,
    warning: number,
    critical: number,
  ) => {
    if (value === undefined || value < warning) return;
    const severity = value >= critical ? "critical" : "warning";
    alerts.push({
      fingerprint: `${resource.providerId}:${resource.id}:${metric}:${severity}`,
      severity,
      providerId: resource.providerId,
      targetId: resource.id,
      targetName: resource.name,
      metric,
      value,
      message: `${resource.name} ${metric} usage is ${value.toFixed(2)}%`,
      observedAt: resource.observedAt,
    });
  };

  metricAlert(
    "cpu",
    resource.cpuPercent,
    config.thresholds.cpuWarningPercent,
    config.thresholds.cpuCriticalPercent,
  );
  metricAlert(
    "memory",
    resource.memoryPercent,
    config.thresholds.memoryWarningPercent,
    config.thresholds.memoryCriticalPercent,
  );
  metricAlert(
    "disk",
    resource.diskPercent,
    config.thresholds.diskWarningPercent,
    config.thresholds.diskCriticalPercent,
  );
  return alerts;
}
