import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  registerInfrastructureProvider,
  type InfrastructureProvider,
} from "../runtime-api.js";
import type { InfrastructureControlConfig } from "./config.js";
import { InfrastructureControl } from "./control.js";

const unregister: Array<() => void> = [];

afterEach(() => {
  while (unregister.length > 0) unregister.pop()?.();
});

async function testConfig(): Promise<InfrastructureControlConfig> {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-infra-"));
  return {
    allowMutations: true,
    stateDir,
    auditLogFile: join(stateDir, "audit.jsonl"),
    maxConcurrency: 2,
    maxInventoryResults: 100,
    monitoringIntervalSeconds: 0,
    alertCooldownMinutes: 30,
    thresholds: {
      cpuWarningPercent: 80,
      cpuCriticalPercent: 95,
      memoryWarningPercent: 80,
      memoryCriticalPercent: 95,
      diskWarningPercent: 85,
      diskCriticalPercent: 95,
    },
    alertWebhooks: [],
  };
}

function fakeProvider(executed: string[]): InfrastructureProvider {
  return {
    id: "test-linux",
    kind: "linux",
    actions: ["service.start", "service.stop"],
    queries: [],
    async inventory() {
      return [
        {
          providerId: "test-linux",
          providerKind: "linux",
          id: "web-01",
          kind: "host",
          name: "web-01",
          status: "online",
          memoryPercent: 81,
          diskPercent: 50,
          observedAt: new Date().toISOString(),
        },
      ];
    },
    async monitor() {
      return await this.inventory();
    },
    async execute(operation) {
      executed.push(operation.action);
      return { action: operation.action };
    },
    rollbackFor(operation) {
      if (operation.action !== "service.start") return undefined;
      return { ...operation, action: "service.stop" };
    },
  };
}

describe("InfrastructureControl", () => {
  it("aggregates inventory and evaluates monitoring thresholds", async () => {
    const executed: string[] = [];
    unregister.push(registerInfrastructureProvider(fakeProvider(executed)));
    const control = new InfrastructureControl(await testConfig());
    const inventory = await control.inventory({ query: "web-01" });
    expect(inventory.totalMatched).toBe(1);
    const monitoring = await control.monitoringScan();
    expect(monitoring.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: "web-01",
          metric: "memory",
          severity: "warning",
        }),
      ]),
    );
  });

  it("executes a persisted plan and its automatic rollback", async () => {
    const executed: string[] = [];
    unregister.push(registerInfrastructureProvider(fakeProvider(executed)));
    const config = await testConfig();
    const control = new InfrastructureControl(config);
    const plan = await control.createPlan({
      title: "Start test service",
      operations: [
        {
          providerId: "test-linux",
          targetId: "web-01",
          action: "service.start",
          parameters: { service: "nginx.service" },
        },
      ],
    });
    expect(plan.rollbackCoverage).toBe("full");
    const completed = await control.executePlan(plan.id);
    expect(completed.status).toBe("completed");
    const rolledBack = await control.rollbackPlan(plan.id);
    expect(rolledBack.status).toBe("rolled-back");
    expect(executed).toEqual(["service.start", "service.stop"]);
    const audit = await readFile(config.auditLogFile, "utf8");
    expect(audit).toContain("\"event\":\"operation\"");
    expect(audit).toContain("\"event\":\"rollback\"");
  });
});
