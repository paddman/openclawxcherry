import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Observation, ObservationInput } from "./types.js";

export type LearningConfig = {
  enabled: boolean;
  learningRate: number;
  minimumSamples: number;
  confidenceFloor: number;
  confidenceCeiling: number;
  maxProfilesPerSession: number;
  persistIntervalMs: number;
};

export type SourceReliabilityProfile = {
  key: string;
  sessionKey: string;
  source: string;
  modality: string;
  observations: number;
  averageRawConfidence: number;
  calibratedReliability: number;
  averageSalience: number;
  highRiskSignals: number;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type ToolReliabilityProfile = {
  key: string;
  sessionKey: string;
  toolName: string;
  calls: number;
  successes: number;
  failures: number;
  successRate: number;
  averageDurationMs: number;
  consecutiveFailures: number;
  lastError?: string;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type LearningSnapshot = {
  sessionKey: string;
  sources: SourceReliabilityProfile[];
  tools: ToolReliabilityProfile[];
  generatedAt: number;
};

type PersistedLearningState = {
  version: 1;
  savedAt: number;
  sources: SourceReliabilityProfile[];
  tools: ToolReliabilityProfile[];
};

const DEFAULT_CONFIG: LearningConfig = {
  enabled: true,
  learningRate: 0.18,
  minimumSamples: 3,
  confidenceFloor: 0.15,
  confidenceCeiling: 0.98,
  maxProfilesPerSession: 256,
  persistIntervalMs: 60_000,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function cleanText(value: unknown, fallback: string, maxLength = 500): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return clamp(value, min, max);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function nestedConfig(pluginConfig: Record<string, unknown> | undefined): Record<string, unknown> {
  const value = pluginConfig?.learning;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseLearningConfig(
  pluginConfig: Record<string, unknown> | undefined,
): LearningConfig {
  const source = nestedConfig(pluginConfig);
  return {
    enabled: booleanValue(source.enabled, DEFAULT_CONFIG.enabled),
    learningRate: numberValue(source.learningRate, DEFAULT_CONFIG.learningRate, 0.01, 1),
    minimumSamples: Math.round(
      numberValue(source.minimumSamples, DEFAULT_CONFIG.minimumSamples, 1, 1_000),
    ),
    confidenceFloor: numberValue(
      source.confidenceFloor,
      DEFAULT_CONFIG.confidenceFloor,
      0,
      1,
    ),
    confidenceCeiling: numberValue(
      source.confidenceCeiling,
      DEFAULT_CONFIG.confidenceCeiling,
      0,
      1,
    ),
    maxProfilesPerSession: Math.round(
      numberValue(
        source.maxProfilesPerSession,
        DEFAULT_CONFIG.maxProfilesPerSession,
        8,
        10_000,
      ),
    ),
    persistIntervalMs: Math.round(
      numberValue(source.persistIntervalMs, DEFAULT_CONFIG.persistIntervalMs, 5_000, 600_000),
    ),
  };
}

function sessionKey(value: string | undefined): string {
  return cleanText(value, "global", 300);
}

function sourceKey(session: string, source: string, modality: string): string {
  return `${session}|${modality.toLocaleLowerCase()}|${source.toLocaleLowerCase()}`;
}

function toolKey(session: string, toolName: string): string {
  return `${session}|${toolName.toLocaleLowerCase()}`;
}

function exponentialAverage(current: number, next: number, rate: number): number {
  return current * (1 - rate) + next * rate;
}

export class AdaptiveLearningEngine {
  readonly config: LearningConfig;
  private readonly sourceProfiles = new Map<string, SourceReliabilityProfile>();
  private readonly toolProfiles = new Map<string, ToolReliabilityProfile>();
  private storagePath?: string;
  private persistTimer?: NodeJS.Timeout;
  private dirty = false;

  constructor(config: LearningConfig) {
    this.config = config;
  }

  async start(stateDir: string): Promise<void> {
    this.storagePath = join(stateDir, "cherry-cognitive", "learning.json");
    await this.load();
    this.persistTimer = setInterval(() => {
      void this.persist();
    }, this.config.persistIntervalMs);
    this.persistTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persist(true);
  }

  calibrateObservation(
    inputSessionKey: string | undefined,
    input: ObservationInput,
  ): ObservationInput {
    if (!this.config.enabled || !input.source) {
      return input;
    }
    const session = sessionKey(inputSessionKey);
    const source = cleanText(input.source, "unknown", 200);
    const key = sourceKey(session, source, input.modality);
    const profile = this.sourceProfiles.get(key);
    if (!profile || profile.observations < this.config.minimumSamples) {
      return input;
    }
    const rawConfidence = clamp01(input.confidence ?? 0.7);
    const calibratedConfidence = clamp(
      rawConfidence * 0.55 + profile.calibratedReliability * 0.45,
      this.config.confidenceFloor,
      this.config.confidenceCeiling,
    );
    const reliabilityBoost = (profile.calibratedReliability - 0.5) * 0.18;
    return {
      ...input,
      confidence: calibratedConfidence,
      salience:
        input.salience === undefined
          ? undefined
          : clamp01(input.salience + reliabilityBoost),
      data: {
        ...(input.data ?? {}),
        cognitiveCalibration: {
          sourceReliability: profile.calibratedReliability,
          sourceSamples: profile.observations,
          rawConfidence,
          calibratedConfidence,
        },
      },
    };
  }

  recordObservation(inputSessionKey: string | undefined, observation: Observation): void {
    if (!this.config.enabled) {
      return;
    }
    const session = sessionKey(inputSessionKey);
    const source = cleanText(observation.source, "unknown", 200);
    const key = sourceKey(session, source, observation.modality);
    const now = Date.now();
    const existing = this.sourceProfiles.get(key);
    const rawConfidence = clamp01(observation.confidence);
    if (!existing) {
      this.sourceProfiles.set(key, {
        key,
        sessionKey: session,
        source,
        modality: observation.modality,
        observations: 1,
        averageRawConfidence: rawConfidence,
        calibratedReliability: clamp(rawConfidence, 0.25, 0.9),
        averageSalience: clamp01(observation.salience),
        highRiskSignals: observation.risk >= 0.62 ? 1 : 0,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      this.trimSources(session);
      this.dirty = true;
      return;
    }

    existing.observations += 1;
    existing.averageRawConfidence = exponentialAverage(
      existing.averageRawConfidence,
      rawConfidence,
      this.config.learningRate,
    );
    existing.averageSalience = exponentialAverage(
      existing.averageSalience,
      clamp01(observation.salience),
      this.config.learningRate,
    );
    existing.highRiskSignals += observation.risk >= 0.62 ? 1 : 0;
    existing.calibratedReliability = clamp(
      exponentialAverage(
        existing.calibratedReliability,
        rawConfidence * (1 - observation.uncertainty * 0.35),
        this.config.learningRate,
      ),
      this.config.confidenceFloor,
      this.config.confidenceCeiling,
    );
    existing.lastSeenAt = now;
    this.dirty = true;
  }

  recordToolOutcome(
    inputSessionKey: string | undefined,
    toolNameValue: string,
    success: boolean,
    durationMs: number | undefined,
    error?: string,
  ): void {
    if (!this.config.enabled) {
      return;
    }
    const session = sessionKey(inputSessionKey);
    const toolName = cleanText(toolNameValue, "unknown", 200).toLocaleLowerCase();
    const key = toolKey(session, toolName);
    const now = Date.now();
    const duration =
      typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
        ? durationMs
        : 0;
    const existing = this.toolProfiles.get(key);
    if (!existing) {
      this.toolProfiles.set(key, {
        key,
        sessionKey: session,
        toolName,
        calls: 1,
        successes: success ? 1 : 0,
        failures: success ? 0 : 1,
        successRate: success ? 1 : 0,
        averageDurationMs: duration,
        consecutiveFailures: success ? 0 : 1,
        lastError: success ? undefined : cleanText(error, "unknown error", 500),
        firstSeenAt: now,
        lastSeenAt: now,
      });
      this.trimTools(session);
      this.dirty = true;
      return;
    }

    existing.calls += 1;
    existing.successes += success ? 1 : 0;
    existing.failures += success ? 0 : 1;
    existing.successRate = existing.successes / existing.calls;
    existing.averageDurationMs = exponentialAverage(
      existing.averageDurationMs,
      duration,
      this.config.learningRate,
    );
    existing.consecutiveFailures = success ? 0 : existing.consecutiveFailures + 1;
    existing.lastError = success ? undefined : cleanText(error, "unknown error", 500);
    existing.lastSeenAt = now;
    this.dirty = true;
  }

  sourceReliability(
    inputSessionKey: string | undefined,
    sourceValue: string,
    modality: string,
  ): number | undefined {
    const session = sessionKey(inputSessionKey);
    const source = cleanText(sourceValue, "unknown", 200);
    return this.sourceProfiles.get(sourceKey(session, source, modality))?.calibratedReliability;
  }

  toolReliability(
    inputSessionKey: string | undefined,
    toolNameValue: string,
  ): ToolReliabilityProfile | undefined {
    const session = sessionKey(inputSessionKey);
    const toolName = cleanText(toolNameValue, "unknown", 200).toLocaleLowerCase();
    const profile = this.toolProfiles.get(toolKey(session, toolName));
    return profile ? structuredClone(profile) : undefined;
  }

  snapshot(inputSessionKey: string | undefined): LearningSnapshot {
    const session = sessionKey(inputSessionKey);
    return {
      sessionKey: session,
      sources: [...this.sourceProfiles.values()]
        .filter((profile) => profile.sessionKey === session)
        .sort((left, right) =>
          right.observations - left.observations ||
          right.calibratedReliability - left.calibratedReliability,
        )
        .map((profile) => structuredClone(profile)),
      tools: [...this.toolProfiles.values()]
        .filter((profile) => profile.sessionKey === session)
        .sort((left, right) => right.calls - left.calls || right.successRate - left.successRate)
        .map((profile) => structuredClone(profile)),
      generatedAt: Date.now(),
    };
  }

  buildPromptContext(inputSessionKey: string | undefined): string {
    const snapshot = this.snapshot(inputSessionKey);
    const unreliableSources = snapshot.sources
      .filter(
        (profile) =>
          profile.observations >= this.config.minimumSamples &&
          profile.calibratedReliability < 0.5,
      )
      .slice(0, 4);
    const unstableTools = snapshot.tools
      .filter((profile) => profile.calls >= this.config.minimumSamples && profile.successRate < 0.7)
      .slice(0, 4);
    if (unreliableSources.length === 0 && unstableTools.length === 0) {
      return "";
    }
    return [
      "[Cherry Adaptive Reliability Context]",
      ...unreliableSources.map(
        (profile) =>
          `- Source ${profile.source} (${profile.modality}) reliability=${profile.calibratedReliability.toFixed(2)} after ${profile.observations} observations; verify independently.`,
      ),
      ...unstableTools.map(
        (profile) =>
          `- Tool ${profile.toolName} successRate=${profile.successRate.toFixed(2)} across ${profile.calls} calls; consecutiveFailures=${profile.consecutiveFailures}.`,
      ),
      "Treat reliability scores as operational estimates, not ground truth.",
      "[/Cherry Adaptive Reliability Context]",
    ].join("\n");
  }

  stats(): {
    sourceProfiles: number;
    toolProfiles: number;
    averageSourceReliability: number;
    averageToolSuccessRate: number;
  } {
    const sources = [...this.sourceProfiles.values()];
    const tools = [...this.toolProfiles.values()];
    const average = (values: number[]) =>
      values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      sourceProfiles: sources.length,
      toolProfiles: tools.length,
      averageSourceReliability: average(
        sources.map((profile) => profile.calibratedReliability),
      ),
      averageToolSuccessRate: average(tools.map((profile) => profile.successRate)),
    };
  }

  async persist(force = false): Promise<void> {
    if (!this.storagePath || (!force && !this.dirty)) {
      return;
    }
    const payload: PersistedLearningState = {
      version: 1,
      savedAt: Date.now(),
      sources: [...this.sourceProfiles.values()].map((profile) => structuredClone(profile)),
      tools: [...this.toolProfiles.values()].map((profile) => structuredClone(profile)),
    };
    await mkdir(dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.storagePath);
    this.dirty = false;
  }

  private trimSources(session: string): void {
    const profiles = [...this.sourceProfiles.values()]
      .filter((profile) => profile.sessionKey === session)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
    for (const profile of profiles.slice(this.config.maxProfilesPerSession)) {
      this.sourceProfiles.delete(profile.key);
    }
  }

  private trimTools(session: string): void {
    const profiles = [...this.toolProfiles.values()]
      .filter((profile) => profile.sessionKey === session)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
    for (const profile of profiles.slice(this.config.maxProfilesPerSession)) {
      this.toolProfiles.delete(profile.key);
    }
  }

  private async load(): Promise<void> {
    if (!this.storagePath) {
      return;
    }
    try {
      const raw = await readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedLearningState;
      if (parsed.version !== 1) {
        return;
      }
      for (const profile of Array.isArray(parsed.sources) ? parsed.sources : []) {
        if (profile && typeof profile.key === "string") {
          this.sourceProfiles.set(profile.key, profile);
        }
      }
      for (const profile of Array.isArray(parsed.tools) ? parsed.tools : []) {
        if (profile && typeof profile.key === "string") {
          this.toolProfiles.set(profile.key, profile);
        }
      }
      this.dirty = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
