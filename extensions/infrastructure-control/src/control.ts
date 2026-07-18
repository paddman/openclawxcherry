import type { InfrastructureControlConfig } from "./config.js";
import {
  getInfrastructureProvider,
  listInfrastructureProviders,
  type InfrastructureOperation,
  type InfrastructureOperationResult,
  type InfrastructurePatchSummary,
  type InfrastructureProvider,
  type InfrastructureResource,
} from "../runtime-api.js";
import {
  InfrastructureAuditStore,
  InfrastructurePlanStore,
  type InfrastructureChangePlan,
} from "./store.js";
import {
  alertForResource,
  operationError,
  operationResult,
  runWithConcurrency,
  textMatches,
  type InfrastructureAlert,
} from "./control-helpers.js";

export class InfrastructureControl {
  private readonly audit: InfrastructureAuditStore;
  private readonly plans: InfrastructurePlanStore;
  private readonly lastAlertAt = new Map<string, number>();

  constructor(readonly config: InfrastructureControlConfig) {
    this.audit = new InfrastructureAuditStore(config.auditLogFile);
    this.plans = new InfrastructurePlanStore(config.stateDir);
  }

  providerStatus() {
    return listInfrastructureProviders().map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      actions: provider.actions,
      queries: provider.queries,
      supportsMonitoring: Boolean(provider.monitor),
      supportsPatchManagement: Boolean(provider.patchScan),
    }));
  }

  async providerQuery(input: {
    providerId: string;
    targetId: string;
    query: string;
    parameters?: Record<string, unknown>;
  }) {
    const provider = getInfrastructureProvider(input.providerId);
    if (!provider.query || !provider.queries.includes(input.query)) {
      throw new Error(`Provider ${provider.id} does not support query ${input.query}`);
    }
    const startedAt = Date.now();
    try {
      const data = await provider.query(input.targetId, input.query, input.parameters);
      await this.audit.append({
        event: "provider-query",
        providerId: provider.id,
        targetId: input.targetId,
        action: input.query,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return data;
    } catch (error) {
      await this.audit.append({
        event: "provider-query",
        providerId: provider.id,
        targetId: input.targetId,
        action: input.query,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async inventory(options: {
    query?: string;
    providerIds?: string[];
    kinds?: string[];
    statuses?: string[];
    limit?: number;
  } = {}) {
    const startedAt = Date.now();
    const providers = this.selectProviders(options.providerIds);
    const settled = await Promise.allSettled(
      providers.map(async (provider) => ({
        provider,
        resources: await provider.inventory(options.query),
      })),
    );
    const resources: InfrastructureResource[] = [];
    const errors: Array<{ providerId: string; error: string }> = [];
    settled.forEach((entry, index) => {
      const provider = providers[index] as InfrastructureProvider;
      if (entry.status === "fulfilled") {
        resources.push(...entry.value.resources);
      } else {
        errors.push({
          providerId: provider.id,
          error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        });
      }
    });
    const kindSet = new Set(options.kinds ?? []);
    const statusSet = new Set((options.statuses ?? []).map((status) => status.toLowerCase()));
    const limit = Math.min(
      Math.max(options.limit ?? this.config.maxInventoryResults, 1),
      this.config.maxInventoryResults,
    );
    const filtered = resources
      .filter((resource) => textMatches(resource, options.query))
      .filter((resource) => kindSet.size === 0 || kindSet.has(resource.kind))
      .filter(
        (resource) =>
          statusSet.size === 0 ||
          (resource.status ? statusSet.has(resource.status.toLowerCase()) : false),
      )
      .toSorted(
        (left, right) =>
          left.providerId.localeCompare(right.providerId) ||
          left.kind.localeCompare(right.kind) ||
          left.name.localeCompare(right.name),
      );
    await this.audit.append({
      event: "inventory",
      ok: errors.length === 0,
      durationMs: Date.now() - startedAt,
      details: {
        providers: providers.map((provider) => provider.id),
        returned: Math.min(filtered.length, limit),
        errors,
      },
    });
    return {
      providers: this.providerStatus(),
      totalMatched: filtered.length,
      truncated: filtered.length > limit,
      resources: filtered.slice(0, limit),
      errors,
    };
  }

  async monitoringScan(options: { providerIds?: string[]; sendAlerts?: boolean } = {}) {
    const startedAt = Date.now();
    const providers = this.selectProviders(options.providerIds);
    const settled = await Promise.allSettled(
      providers.map(async (provider) => ({
        provider,
        resources: await (provider.monitor?.() ?? provider.inventory()),
      })),
    );
    const resources: InfrastructureResource[] = [];
    const errors: Array<{ providerId: string; error: string }> = [];
    settled.forEach((entry, index) => {
      const provider = providers[index] as InfrastructureProvider;
      if (entry.status === "fulfilled") {
        resources.push(...entry.value.resources);
      } else {
        errors.push({
          providerId: provider.id,
          error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        });
      }
    });
    const alerts = resources.flatMap((resource) => alertForResource(resource, this.config));
    const deliverableAlerts = alerts.filter((alert) => this.shouldDeliverAlert(alert));
    const deliveries =
      options.sendAlerts === true && deliverableAlerts.length > 0
        ? await this.deliverAlerts(deliverableAlerts)
        : [];
    await this.audit.append({
      event: "monitor",
      ok: errors.length === 0,
      durationMs: Date.now() - startedAt,
      details: {
        resources: resources.length,
        alerts: alerts.length,
        deliverableAlerts: deliverableAlerts.length,
        deliveries,
        errors,
      },
    });
    return { resources, alerts, deliverableAlerts, deliveries, errors };
  }

  async patchScan(options: { providerIds?: string[]; targetId?: string } = {}) {
    const startedAt = Date.now();
    const providers = this.selectProviders(options.providerIds).filter(
      (provider) => provider.patchScan,
    );
    const settled = await Promise.allSettled(
      providers.map((provider) => provider.patchScan?.(options.targetId) ?? Promise.resolve([])),
    );
    const summaries: InfrastructurePatchSummary[] = [];
    const errors: Array<{ providerId: string; error: string }> = [];
    settled.forEach((entry, index) => {
      const provider = providers[index] as InfrastructureProvider;
      if (entry.status === "fulfilled") {
        summaries.push(...entry.value);
      } else {
        errors.push({
          providerId: provider.id,
          error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        });
      }
    });
    await this.audit.append({
      event: "patch-scan",
      ok: errors.length === 0,
      durationMs: Date.now() - startedAt,
      details: { summaries: summaries.length, errors },
    });
    return { summaries, errors };
  }

  async createPlan(input: {
    title: string;
    reason?: string;
    operations: InfrastructureOperation[];
    maxConcurrency?: number;
    stopOnError?: boolean;
  }): Promise<InfrastructureChangePlan> {
    if (input.operations.length === 0) {
      throw new Error("At least one infrastructure operation is required");
    }
    if (input.operations.length > 500) {
      throw new Error("A change plan may contain at most 500 operations");
    }
    const rollbackOperations: InfrastructureOperation[] = [];
    for (const operation of input.operations) {
      const provider = getInfrastructureProvider(operation.providerId);
      if (!provider.actions.includes(operation.action)) {
        throw new Error(`Provider ${provider.id} does not support action ${operation.action}`);
      }
      const rollback = await provider.rollbackFor?.(operation);
      if (rollback) rollbackOperations.unshift(rollback);
    }
    const plan = await this.plans.create({
      title: input.title,
      reason: input.reason,
      maxConcurrency: Math.min(
        Math.max(input.maxConcurrency ?? this.config.maxConcurrency, 1),
        this.config.maxConcurrency,
      ),
      stopOnError: input.stopOnError ?? true,
      operations: input.operations,
      rollbackOperations,
    });
    await this.audit.append({
      event: "plan-created",
      planId: plan.id,
      ok: true,
      details: {
        title: plan.title,
        operations: plan.operations,
        rollbackCoverage: plan.rollbackCoverage,
      },
    });
    return plan;
  }

  async readPlan(planId: string): Promise<InfrastructureChangePlan> {
    return await this.plans.read(planId);
  }

  async executePlan(planId: string): Promise<InfrastructureChangePlan> {
    this.assertMutationsEnabled();
    const plan = await this.plans.read(planId);
    if (plan.status !== "draft" && plan.status !== "failed") {
      throw new Error(`Infrastructure plan ${plan.id} cannot run from status ${plan.status}`);
    }
    plan.status = "executing";
    plan.results = [];
    await this.plans.save(plan);
    const startedAt = Date.now();
    const results = await runWithConcurrency<InfrastructureOperation, InfrastructureOperationResult>(
      plan.operations,
      plan.maxConcurrency,
      (result) => plan.stopOnError && !result.ok,
      async (operation) => await this.executeOperation(operation, plan.id),
    );
    plan.results = results.filter(
      (result): result is InfrastructureOperationResult => Boolean(result),
    );
    plan.status = plan.results.some((result) => !result.ok) ? "failed" : "completed";
    await this.plans.save(plan);
    await this.audit.append({
      event: "plan-executed",
      planId: plan.id,
      ok: plan.status === "completed",
      durationMs: Date.now() - startedAt,
      details: { status: plan.status, results: plan.results },
    });
    return plan;
  }

  async rollbackPlan(planId: string): Promise<InfrastructureChangePlan> {
    this.assertMutationsEnabled();
    const plan = await this.plans.read(planId);
    if (plan.rollbackOperations.length === 0) {
      throw new Error(`Infrastructure plan ${plan.id} has no automatic rollback operations`);
    }
    const startedAt = Date.now();
    const results: InfrastructureOperationResult[] = [];
    for (const operation of plan.rollbackOperations) {
      const result = await this.executeOperation(operation, plan.id);
      results.push(result);
      if (!result.ok && plan.stopOnError) break;
    }
    plan.rollbackResults = results;
    if (results.length === plan.rollbackOperations.length && results.every((entry) => entry.ok)) {
      plan.status = "rolled-back";
    } else {
      plan.status = "failed";
    }
    await this.plans.save(plan);
    await this.audit.append({
      event: "rollback",
      planId: plan.id,
      ok: plan.status === "rolled-back",
      durationMs: Date.now() - startedAt,
      details: { status: plan.status, results },
    });
    return plan;
  }

  async auditLog(options: Parameters<InfrastructureAuditStore["query"]>[0] = {}) {
    return await this.audit.query(options);
  }

  private selectProviders(providerIds: string[] | undefined): InfrastructureProvider[] {
    const providers = listInfrastructureProviders();
    if (!providerIds || providerIds.length === 0) return providers;
    const wanted = new Set(providerIds);
    const selected = providers.filter((provider) => wanted.has(provider.id));
    const missing = providerIds.filter(
      (providerId) => !selected.some((item) => item.id === providerId),
    );
    if (missing.length > 0) {
      throw new Error(`Unknown infrastructure providers: ${missing.join(", ")}`);
    }
    return selected;
  }

  private assertMutationsEnabled(): void {
    if (!this.config.allowMutations) {
      throw new Error(
        "Infrastructure mutations are disabled; set infrastructure-control allowMutations to true",
      );
    }
  }

  private async executeOperation(
    operation: InfrastructureOperation,
    planId?: string,
  ): Promise<InfrastructureOperationResult> {
    const provider = getInfrastructureProvider(operation.providerId);
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    try {
      const result = await provider.execute(operation);
      const record = operationResult(operation, startedAt, result);
      await this.audit.append({
        event: "operation",
        providerId: operation.providerId,
        targetId: operation.targetId,
        action: operation.action,
        planId,
        ok: true,
        durationMs: Date.now() - startedMs,
        details: result,
      });
      return record;
    } catch (error) {
      const record = operationError(operation, startedAt, error);
      await this.audit.append({
        event: "operation",
        providerId: operation.providerId,
        targetId: operation.targetId,
        action: operation.action,
        planId,
        ok: false,
        durationMs: Date.now() - startedMs,
        error: record.error,
      });
      return record;
    }
  }

  private shouldDeliverAlert(alert: InfrastructureAlert): boolean {
    const now = Date.now();
    const last = this.lastAlertAt.get(alert.fingerprint) ?? 0;
    if (now - last < this.config.alertCooldownMinutes * 60_000) return false;
    this.lastAlertAt.set(alert.fingerprint, now);
    return true;
  }

  private async deliverAlerts(alerts: InfrastructureAlert[]) {
    const payload = {
      source: "openclaw-infrastructure-control",
      generatedAt: new Date().toISOString(),
      alerts,
    };
    const deliveries = await Promise.allSettled(
      this.config.alertWebhooks.map(async (webhook) => {
        const eligible = alerts.filter(
          (alert) => webhook.minimumSeverity === "warning" || alert.severity === "critical",
        );
        if (eligible.length === 0) {
          return { webhookId: webhook.id, skipped: true, reason: "no eligible alerts" };
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (webhook.tokenEnv) {
            const token = process.env[webhook.tokenEnv];
            if (!token) {
              throw new Error(`Missing alert token environment variable ${webhook.tokenEnv}`);
            }
            headers.Authorization = `Bearer ${token}`;
          }
          const response = await fetch(webhook.url, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...payload, alerts: eligible }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Alert webhook returned HTTP ${response.status}`);
          await this.audit.append({
            event: "alert",
            ok: true,
            details: { webhookId: webhook.id, alerts: eligible.length },
          });
          return { webhookId: webhook.id, ok: true, alerts: eligible.length };
        } finally {
          clearTimeout(timeout);
        }
      }),
    );
    return deliveries.map((entry, index) => {
      const webhook = this.config.alertWebhooks[index];
      if (entry.status === "fulfilled") return entry.value;
      return {
        webhookId: webhook?.id ?? `webhook-${index + 1}`,
        ok: false,
        error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
      };
    });
  }
}
