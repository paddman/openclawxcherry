import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  InfrastructureOperation,
  InfrastructureOperationResult,
} from "../runtime-api.js";

export type InfrastructureAuditEntry = {
  id: string;
  timestamp: string;
  event:
    | "inventory"
    | "monitor"
    | "alert"
    | "plan-created"
    | "plan-executed"
    | "rollback"
    | "patch-scan"
    | "provider-query"
    | "operation";
  actor?: string;
  providerId?: string;
  targetId?: string;
  action?: string;
  planId?: string;
  ok: boolean;
  durationMs?: number;
  details?: unknown;
  error?: string;
};

export type InfrastructureChangePlan = {
  id: string;
  title: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "executing" | "completed" | "failed" | "rolled-back";
  maxConcurrency: number;
  stopOnError: boolean;
  operations: InfrastructureOperation[];
  rollbackOperations: InfrastructureOperation[];
  results: InfrastructureOperationResult[];
  rollbackResults: InfrastructureOperationResult[];
  rollbackCoverage: "full" | "partial" | "none";
};

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}

export class InfrastructureAuditStore {
  constructor(private readonly filePath: string) {}

  async append(entry: Omit<InfrastructureAuditEntry, "id" | "timestamp">): Promise<void> {
    await ensureParent(this.filePath);
    const record: InfrastructureAuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async query(options: {
    limit?: number;
    event?: InfrastructureAuditEntry["event"];
    providerId?: string;
    targetId?: string;
    planId?: string;
    ok?: boolean;
  } = {}): Promise<InfrastructureAuditEntry[]> {
    let text = "";
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 2_000);
    return text
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as InfrastructureAuditEntry;
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is InfrastructureAuditEntry => Boolean(entry))
      .filter((entry) => !options.event || entry.event === options.event)
      .filter((entry) => !options.providerId || entry.providerId === options.providerId)
      .filter((entry) => !options.targetId || entry.targetId === options.targetId)
      .filter((entry) => !options.planId || entry.planId === options.planId)
      .filter((entry) => options.ok === undefined || entry.ok === options.ok)
      .slice(-limit)
      .reverse();
  }
}

export class InfrastructurePlanStore {
  private readonly plansDir: string;

  constructor(stateDir: string) {
    this.plansDir = join(stateDir, "plans");
  }

  private planPath(planId: string): string {
    if (!/^[0-9a-f-]{36}$/u.test(planId)) {
      throw new Error("Invalid infrastructure plan id");
    }
    return join(this.plansDir, `${planId}.json`);
  }

  async create(input: {
    title: string;
    reason?: string;
    maxConcurrency: number;
    stopOnError: boolean;
    operations: InfrastructureOperation[];
    rollbackOperations: InfrastructureOperation[];
  }): Promise<InfrastructureChangePlan> {
    const now = new Date().toISOString();
    const rollbackCoverage =
      input.rollbackOperations.length === 0
        ? "none"
        : input.rollbackOperations.length >= input.operations.length
          ? "full"
          : "partial";
    const plan: InfrastructureChangePlan = {
      id: randomUUID(),
      title: input.title,
      reason: input.reason,
      createdAt: now,
      updatedAt: now,
      status: "draft",
      maxConcurrency: input.maxConcurrency,
      stopOnError: input.stopOnError,
      operations: input.operations,
      rollbackOperations: input.rollbackOperations,
      results: [],
      rollbackResults: [],
      rollbackCoverage,
    };
    await this.save(plan);
    return plan;
  }

  async save(plan: InfrastructureChangePlan): Promise<void> {
    await mkdir(this.plansDir, { recursive: true, mode: 0o700 });
    const path = this.planPath(plan.id);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    const updated = { ...plan, updatedAt: new Date().toISOString() };
    await writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  }

  async read(planId: string): Promise<InfrastructureChangePlan> {
    const text = await readFile(this.planPath(planId), "utf8");
    return JSON.parse(text) as InfrastructureChangePlan;
  }
}
