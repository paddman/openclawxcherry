// Covers opt-in idle-work discovery through AUTOPILOT.md heartbeats.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

const TELEGRAM_GROUP = "-1001234567890";

function createConfig(params: { tmpDir: string; storePath: string }): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: params.tmpDir,
        heartbeat: { every: "5m", target: "telegram" },
      },
    },
    channels: {
      telegram: {
        token: "test-token",
        allowFrom: ["*"],
        heartbeat: { showOk: false },
      },
    },
    session: { store: params.storePath },
  } as OpenClawConfig;
}

function createDeps(replySpy: HeartbeatDeps["getReplyFromConfig"]): HeartbeatDeps {
  return {
    telegram: vi.fn().mockResolvedValue({ messageId: "m1" }) as unknown,
    getQueueSize: () => 0,
    nowMs: () => 0,
    getReplyFromConfig: replySpy,
  };
}

function readHeartbeatBody(replySpy: ReturnType<typeof vi.fn>): string {
  const context = replySpy.mock.calls[0]?.[0];
  if (!context || typeof context !== "object") {
    throw new Error("expected heartbeat reply context");
  }
  const body = (context as { Body?: unknown }).Body;
  if (typeof body !== "string") {
    throw new Error("expected heartbeat body");
  }
  return body;
}

describe("AUTOPILOT.md heartbeat charter", () => {
  it("runs an idle heartbeat only when the charter has actionable content", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      await fs.writeFile(
        path.join(tmpDir, "HEARTBEAT.md"),
        "<!-- checklist disabled -->\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(tmpDir, "AUTOPILOT.md"),
        `# Operations charter

Approved sources:
- service health dashboards
- open incident queue

Work only on read-only checks and report a verified finding.`,
        "utf-8",
      );
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps(replySpy),
      });

      expect(result.status).toBe("ran");
      expect(readHeartbeatBody(replySpy)).toContain("Autopilot mode is enabled by AUTOPILOT.md");
      expect(readHeartbeatBody(replySpy)).toContain("Approved sources:");
      expect(readHeartbeatBody(replySpy)).toContain("Never bypass that policy.");
    });
  });

  it("keeps an effectively empty charter from consuming heartbeat runs", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      await fs.writeFile(
        path.join(tmpDir, "HEARTBEAT.md"),
        "<!-- checklist disabled -->\n",
        "utf-8",
      );
      await fs.writeFile(path.join(tmpDir, "AUTOPILOT.md"), "<!-- not enabled -->\n", "utf-8");
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps(replySpy),
      });

      expect(result).toEqual({ status: "skipped", reason: "empty-heartbeat-file" });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("keeps the approval guardrail when a charter repeats the default prompt", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      await fs.writeFile(
        path.join(tmpDir, "HEARTBEAT.md"),
        "<!-- checklist disabled -->\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(tmpDir, "AUTOPILOT.md"),
        "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats.",
        "utf-8",
      );
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps(replySpy),
      });

      expect(result.status).toBe("ran");
      expect(readHeartbeatBody(replySpy)).toContain("Autopilot mode is enabled by AUTOPILOT.md");
      expect(readHeartbeatBody(replySpy)).toContain("Never bypass that policy.");
    });
  });

  it("keeps due heartbeat tasks ahead of autonomous discovery", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      await fs.writeFile(
        path.join(tmpDir, "HEARTBEAT.md"),
        `tasks:
  - name: deployment-status
    interval: 5m
    prompt: Check deployment status
`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(tmpDir, "AUTOPILOT.md"),
        "Inspect approved operations sources.\n",
        "utf-8",
      );
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps(replySpy),
      });

      expect(result.status).toBe("ran");
      expect(readHeartbeatBody(replySpy)).toContain("Check deployment status");
      expect(readHeartbeatBody(replySpy)).not.toContain("Autopilot mode is enabled");
    });
  });

  it("uses the charter once configured heartbeat tasks are not due", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      await fs.writeFile(
        path.join(tmpDir, "HEARTBEAT.md"),
        `tasks:
  - name: deployment-status
    interval: 5m
    prompt: Check deployment status
`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(tmpDir, "AUTOPILOT.md"),
        "Inspect approved operations sources.\n",
        "utf-8",
      );
      const cfg = createConfig({ tmpDir, storePath });
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        { heartbeatTaskState?: Record<string, number> }
      >;
      const entry = store[sessionKey];
      if (!entry) {
        throw new Error("expected seeded heartbeat session");
      }
      entry.heartbeatTaskState = { "deployment-status": 0 };
      await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps(replySpy),
      });

      expect(result.status).toBe("ran");
      expect(readHeartbeatBody(replySpy)).toContain("Autopilot mode is enabled by AUTOPILOT.md");
      expect(readHeartbeatBody(replySpy)).not.toContain("Check deployment status");
    });
  });
});
