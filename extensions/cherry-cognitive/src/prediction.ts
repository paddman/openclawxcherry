import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizeControlCharacters } from "./text-sanitize.js";
import type { Observation } from "./types.js";

export type PredictionStatus = "pending" | "confirmed" | "refuted" | "expired" | "cancelled";

export type PredictionConfig = {
  enabled: boolean;
  autoEvaluate: boolean;
  defaultHorizonMs: number;
  maxPredictionsPerSession: number;
  confirmationSimilarity: number;
  persistIntervalMs: number;
};

export type PredictionRecord = {
  id: string;
  sessionKey: string;
  hypothesis: string;
  expectedSignal: string;
  sourceExpectation?: string;
  confidence: number;
  status: PredictionStatus;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  resolvedAt?: number;
  outcomeSummary?: string;
  evidenceObservationIds: string[];
  evidenceSummaries: string[];
  probabilityScore?: number;
  tags: string[];
};

export type PredictionStats = {
  sessions: number;
  total: number;
  pending: number;
  confirmed: number;
  refuted: number;
  expired: number;
  cancelled: number;
  resolved: number;
  accuracy: number;
  meanBrierScore: number;
};

type PersistedPredictionState = {
  version: 1;
  savedAt: number;
  predictions: PredictionRecord[];
};

const DEFAULT_CONFIG: PredictionConfig = {
  enabled: true,
  autoEvaluate: true,
  defaultHorizonMs: 30 * 60 * 1_000,
  maxPredictionsPerSession: 128,
  confirmationSimilarity: 0.46,
  persistIntervalMs: 60_000,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function cleanText(value: unknown, fallback: string, maxLength = 1_200): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const cleaned = sanitizeControlCharacters(value).replace(/\s+/gu, " ").trim();
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
  const value = pluginConfig?.prediction;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parsePredictionConfig(
  pluginConfig: Record<string, unknown> | undefined,
): PredictionConfig {
  const source = nestedConfig(pluginConfig);
  return {
    enabled: booleanValue(source.enabled, DEFAULT_CONFIG.enabled),
    autoEvaluate: booleanValue(source.autoEvaluate, DEFAULT_CONFIG.autoEvaluate),
    defaultHorizonMs: Math.round(
      numberValue(
        source.defaultHorizonMs,
        DEFAULT_CONFIG.defaultHorizonMs,
        10_000,
        30 * 24 * 60 * 60 * 1_000,
      ),
    ),
    maxPredictionsPerSession: Math.round(
      numberValue(
        source.maxPredictionsPerSession,
        DEFAULT_CONFIG.maxPredictionsPerSession,
        8,
        10_000,
      ),
    ),
    confirmationSimilarity: numberValue(
      source.confirmationSimilarity,
      DEFAULT_CONFIG.confirmationSimilarity,
      0.1,
      1,
    ),
    persistIntervalMs: Math.round(
      numberValue(source.persistIntervalMs, DEFAULT_CONFIG.persistIntervalMs, 5_000, 600_000),
    ),
  };
}

function sessionKey(value: string | undefined): string {
  return cleanText(value, "global", 300);
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
      .slice(0, 256),
  );
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function includesPhraseSimilarity(left: string, right: string): number {
  const normalizedLeft = left.toLocaleLowerCase();
  const normalizedRight = right.toLocaleLowerCase();
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return 0.82;
  }
  return 0;
}

function semanticSimilarity(left: string, right: string): number {
  return Math.max(jaccardSimilarity(left, right), includesPhraseSimilarity(left, right));
}

function brierScore(confidence: number, outcome: 0 | 1): number {
  return (clamp01(confidence) - outcome) ** 2;
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => cleanText(tag, "", 80)).filter(Boolean))].slice(
    0,
    24,
  );
}

export class PredictionEngine {
  readonly config: PredictionConfig;
  private readonly predictionsBySession = new Map<string, PredictionRecord[]>();
  private storagePath?: string;
  private persistTimer?: NodeJS.Timeout;
  private dirty = false;

  constructor(config: PredictionConfig) {
    this.config = config;
  }

  async start(stateDir: string): Promise<void> {
    this.storagePath = join(stateDir, "cherry-cognitive", "predictions.json");
    await this.load();
    this.expire();
    this.persistTimer = setInterval(() => {
      this.expire();
      void this.persist();
    }, this.config.persistIntervalMs);
    this.persistTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.expire();
    await this.persist(true);
  }

  create(
    inputSessionKey: string | undefined,
    input: {
      hypothesis: string;
      expectedSignal: string;
      confidence: number;
      horizonMs?: number;
      sourceExpectation?: string;
      tags?: string[];
    },
  ): PredictionRecord {
    if (!this.config.enabled) {
      throw new Error("Prediction engine is disabled");
    }
    const key = sessionKey(inputSessionKey);
    const now = Date.now();
    const horizonMs = Math.round(
      numberValue(input.horizonMs, this.config.defaultHorizonMs, 10_000, 30 * 24 * 60 * 60 * 1_000),
    );
    const prediction: PredictionRecord = {
      id: randomUUID(),
      sessionKey: key,
      hypothesis: cleanText(input.hypothesis, "Unspecified hypothesis", 1_000),
      expectedSignal: cleanText(input.expectedSignal, "Unspecified expected signal", 1_000),
      sourceExpectation: input.sourceExpectation
        ? cleanText(input.sourceExpectation, "", 200)
        : undefined,
      confidence: clamp01(input.confidence),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      deadlineAt: now + horizonMs,
      evidenceObservationIds: [],
      evidenceSummaries: [],
      tags: normalizeTags(input.tags),
    };
    const predictions = this.predictionsBySession.get(key) ?? [];
    predictions.push(prediction);
    this.predictionsBySession.set(
      key,
      predictions
        .toSorted((left, right) => right.createdAt - left.createdAt)
        .slice(0, this.config.maxPredictionsPerSession),
    );
    this.dirty = true;
    return structuredClone(prediction);
  }

  evaluateObservation(
    inputSessionKey: string | undefined,
    observation: Observation,
  ): PredictionRecord[] {
    if (!this.config.enabled || !this.config.autoEvaluate) {
      return [];
    }
    this.expire();
    const key = sessionKey(inputSessionKey);
    const predictions = this.predictionsBySession.get(key) ?? [];
    const confirmed: PredictionRecord[] = [];
    for (const prediction of predictions) {
      if (prediction.status !== "pending") {
        continue;
      }
      const signalSimilarity = semanticSimilarity(prediction.expectedSignal, observation.summary);
      const hypothesisSimilarity = semanticSimilarity(prediction.hypothesis, observation.summary);
      const sourceMatch = prediction.sourceExpectation
        ? semanticSimilarity(prediction.sourceExpectation, observation.source ?? "")
        : 0.5;
      const combined = signalSimilarity * 0.58 + hypothesisSimilarity * 0.27 + sourceMatch * 0.15;
      if (combined < this.config.confirmationSimilarity) {
        continue;
      }
      prediction.status = "confirmed";
      prediction.updatedAt = Date.now();
      prediction.resolvedAt = prediction.updatedAt;
      prediction.outcomeSummary = `Confirmed by observation: ${observation.summary}`;
      prediction.evidenceObservationIds = [observation.id];
      prediction.evidenceSummaries = [observation.summary];
      prediction.probabilityScore = brierScore(prediction.confidence, 1);
      confirmed.push(structuredClone(prediction));
      this.dirty = true;
    }
    return confirmed;
  }

  resolve(
    inputSessionKey: string | undefined,
    predictionId: string,
    outcome: "confirm" | "refute" | "cancel",
    summary: string,
    evidence?: Array<{ observationId?: string; summary: string }>,
  ): PredictionRecord {
    const prediction = this.requirePrediction(inputSessionKey, predictionId);
    if (prediction.status !== "pending") {
      throw new Error(
        `Prediction ${predictionId} cannot be resolved from status ${prediction.status}`,
      );
    }
    const now = Date.now();
    prediction.status =
      outcome === "confirm" ? "confirmed" : outcome === "refute" ? "refuted" : "cancelled";
    prediction.updatedAt = now;
    prediction.resolvedAt = now;
    prediction.outcomeSummary = cleanText(summary, "No outcome summary", 1_200);
    prediction.evidenceObservationIds = (evidence ?? [])
      .map((item) => cleanText(item.observationId, "", 100))
      .filter(Boolean)
      .slice(0, 16);
    prediction.evidenceSummaries = (evidence ?? [])
      .map((item) => cleanText(item.summary, "", 500))
      .filter(Boolean)
      .slice(0, 16);
    if (outcome !== "cancel") {
      prediction.probabilityScore = brierScore(
        prediction.confidence,
        outcome === "confirm" ? 1 : 0,
      );
    }
    this.dirty = true;
    return structuredClone(prediction);
  }

  list(inputSessionKey: string | undefined, includeResolved = false): PredictionRecord[] {
    this.expire();
    const key = sessionKey(inputSessionKey);
    return (this.predictionsBySession.get(key) ?? [])
      .filter((prediction) => includeResolved || prediction.status === "pending")
      .map((prediction) => structuredClone(prediction));
  }

  stats(): PredictionStats {
    this.expire();
    const records = [...this.predictionsBySession.values()].flat();
    const stats: PredictionStats = {
      sessions: this.predictionsBySession.size,
      total: records.length,
      pending: 0,
      confirmed: 0,
      refuted: 0,
      expired: 0,
      cancelled: 0,
      resolved: 0,
      accuracy: 0,
      meanBrierScore: 0,
    };
    for (const record of records) {
      stats[record.status] += 1;
    }
    const scored = records.filter(
      (record) =>
        (record.status === "confirmed" || record.status === "refuted") &&
        typeof record.probabilityScore === "number",
    );
    stats.resolved = scored.length;
    stats.accuracy =
      scored.length === 0
        ? 0
        : scored.filter((record) => record.status === "confirmed").length / scored.length;
    stats.meanBrierScore =
      scored.length === 0
        ? 0
        : scored.reduce((sum, record) => sum + (record.probabilityScore ?? 0), 0) / scored.length;
    return stats;
  }

  buildPromptContext(inputSessionKey: string | undefined): string {
    const pending = this.list(inputSessionKey).slice(0, 6);
    if (pending.length === 0) {
      return "";
    }
    return [
      "[Cherry Predictive Processing]",
      "Pending hypotheses are predictions to test, not facts.",
      ...pending.map(
        (prediction) =>
          `- ${prediction.hypothesis} | expected=${prediction.expectedSignal} | confidence=${prediction.confidence.toFixed(2)} | deadline=${new Date(prediction.deadlineAt).toISOString()}${prediction.sourceExpectation ? ` | source=${prediction.sourceExpectation}` : ""}`,
      ),
      "Seek observations that could refute as well as confirm each hypothesis.",
      "[/Cherry Predictive Processing]",
    ].join("\n");
  }

  async persist(force = false): Promise<void> {
    if (!this.storagePath || (!force && !this.dirty)) {
      return;
    }
    const payload: PersistedPredictionState = {
      version: 1,
      savedAt: Date.now(),
      predictions: [...this.predictionsBySession.values()]
        .flat()
        .map((prediction) => structuredClone(prediction)),
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

  private requirePrediction(
    inputSessionKey: string | undefined,
    predictionId: string,
  ): PredictionRecord {
    const key = sessionKey(inputSessionKey);
    const prediction = (this.predictionsBySession.get(key) ?? []).find(
      (item) => item.id === predictionId,
    );
    if (!prediction) {
      throw new Error(`Prediction not found: ${predictionId}`);
    }
    return prediction;
  }

  private expire(): void {
    const now = Date.now();
    for (const records of this.predictionsBySession.values()) {
      for (const prediction of records) {
        if (prediction.status === "pending" && prediction.deadlineAt <= now) {
          prediction.status = "expired";
          prediction.updatedAt = now;
          prediction.resolvedAt = now;
          prediction.outcomeSummary = "Prediction horizon elapsed without confirming evidence.";
          this.dirty = true;
        }
      }
    }
  }

  private async load(): Promise<void> {
    if (!this.storagePath) {
      return;
    }
    try {
      const raw = await readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedPredictionState;
      if (parsed.version !== 1 || !Array.isArray(parsed.predictions)) {
        return;
      }
      for (const prediction of parsed.predictions) {
        if (
          !prediction ||
          typeof prediction.id !== "string" ||
          typeof prediction.sessionKey !== "string"
        ) {
          continue;
        }
        const records = this.predictionsBySession.get(prediction.sessionKey) ?? [];
        records.push(prediction);
        this.predictionsBySession.set(
          prediction.sessionKey,
          records
            .toSorted((left, right) => right.createdAt - left.createdAt)
            .slice(0, this.config.maxPredictionsPerSession),
        );
      }
      this.dirty = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
