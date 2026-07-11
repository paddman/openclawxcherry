import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CognitiveConfig,
  CognitiveModality,
  Episode,
  Goal,
  GoalStatus,
  NcaCellState,
  NcaFieldSnapshot,
  NcaFieldState,
  Observation,
  ObservationInput,
  PersistedCognitiveState,
  ReflectionReport,
  SelfModel,
  SessionCognitiveState,
  WorkspaceItem,
} from "./types.js";

const DEFAULT_CONFIG: CognitiveConfig = {
  enabled: true,
  identity: "Cherry Cognitive Agent",
  tickIntervalMs: 5_000,
  persistIntervalMs: 30_000,
  maxWorkingMemory: 32,
  maxEpisodicMemory: 256,
  promptInjection: true,
  heartbeatAwareness: true,
  autoObserveMessages: true,
  approvalRequiredTools: [],
  approvalTimeoutMs: 60_000,
};

const RISK_TERMS = [
  "critical",
  "danger",
  "delete",
  "down",
  "error",
  "fail",
  "incident",
  "outage",
  "security",
  "shutdown",
  "attack",
  "alarm",
  "warning",
  "ลบ",
  "ล่ม",
  "ผิดพลาด",
  "อันตราย",
  "โจมตี",
  "เตือน",
  "ฉุกเฉิน",
  "ปิดระบบ",
];

const URGENT_TERMS = [
  "urgent",
  "immediately",
  "now",
  "asap",
  "ด่วน",
  "ทันที",
  "ตอนนี้",
  "เร่ง",
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(clamp(finiteNumber(value, fallback), min, max));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function cleanString(value: unknown, fallback: string, maxLength = 500): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 128);
}

export function parseCognitiveConfig(value: Record<string, unknown> | undefined): CognitiveConfig {
  const source = value ?? {};
  return {
    enabled: booleanValue(source.enabled, DEFAULT_CONFIG.enabled),
    identity: cleanString(source.identity, DEFAULT_CONFIG.identity, 120),
    tickIntervalMs: integerInRange(source.tickIntervalMs, DEFAULT_CONFIG.tickIntervalMs, 1_000, 60_000),
    persistIntervalMs: integerInRange(
      source.persistIntervalMs,
      DEFAULT_CONFIG.persistIntervalMs,
      5_000,
      300_000,
    ),
    maxWorkingMemory: integerInRange(
      source.maxWorkingMemory,
      DEFAULT_CONFIG.maxWorkingMemory,
      8,
      256,
    ),
    maxEpisodicMemory: integerInRange(
      source.maxEpisodicMemory,
      DEFAULT_CONFIG.maxEpisodicMemory,
      32,
      5_000,
    ),
    promptInjection: booleanValue(source.promptInjection, DEFAULT_CONFIG.promptInjection),
    heartbeatAwareness: booleanValue(
      source.heartbeatAwareness,
      DEFAULT_CONFIG.heartbeatAwareness,
    ),
    autoObserveMessages: booleanValue(
      source.autoObserveMessages,
      DEFAULT_CONFIG.autoObserveMessages,
    ),
    approvalRequiredTools: stringArray(source.approvalRequiredTools),
    approvalTimeoutMs: integerInRange(
      source.approvalTimeoutMs,
      DEFAULT_CONFIG.approvalTimeoutMs,
      5_000,
      300_000,
    ),
  };
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
      .slice(0, 128),
  );
}

function overlapRatio(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function termScore(text: string, terms: string[]): number {
  const normalized = text.toLocaleLowerCase();
  const hits = terms.reduce((count, term) => count + (normalized.includes(term) ? 1 : 0), 0);
  return clamp01(hits / 3);
}

function modalityBias(modality: CognitiveModality): number {
  switch (modality) {
    case "sensor":
    case "log":
      return 0.72;
    case "audio":
    case "vision":
      return 0.66;
    case "tool":
    case "api":
      return 0.62;
    case "internal":
      return 0.5;
    case "text":
    default:
      return 0.56;
  }
}

function riskLevel(risk: number): SelfModel["riskLevel"] {
  if (risk >= 0.82) {
    return "critical";
  }
  if (risk >= 0.62) {
    return "high";
  }
  if (risk >= 0.34) {
    return "medium";
  }
  return "low";
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function createCell(): NcaCellState {
  return {
    activation: 0,
    salience: 0,
    novelty: 0,
    risk: 0,
    uncertainty: 0,
    valence: 0,
  };
}

function createField(width = 5, height = 5): NcaFieldState {
  return {
    width,
    height,
    step: 0,
    cells: Array.from({ length: width * height }, createCell),
  };
}

class NcaField {
  private state: NcaFieldState;

  constructor(state?: NcaFieldState) {
    const validCells = state?.cells?.length === (state?.width ?? 0) * (state?.height ?? 0);
    this.state = validCells
      ? {
          width: state.width,
          height: state.height,
          step: state.step,
          cells: state.cells.map((cell) => ({ ...cell })),
        }
      : createField();
  }

  inject(observation: Observation): void {
    const seed = hashText(`${observation.modality}:${observation.source ?? "unknown"}:${observation.summary}`);
    const primaryIndex = seed % this.state.cells.length;
    const secondaryIndex = (primaryIndex + 1 + (seed % 7)) % this.state.cells.length;
    const signal = {
      activation: clamp01(0.45 + observation.salience * 0.55),
      salience: observation.salience,
      novelty: observation.novelty,
      risk: observation.risk,
      uncertainty: observation.uncertainty,
      valence: clamp(0.35 - observation.risk * 0.9 + observation.confidence * 0.25, -1, 1),
    };
    this.mergeInto(primaryIndex, signal, 0.78);
    this.mergeInto(secondaryIndex, signal, 0.42);
  }

  private mergeInto(index: number, signal: NcaCellState, weight: number): void {
    const cell = this.state.cells[index];
    if (!cell) {
      return;
    }
    cell.activation = clamp01(cell.activation * (1 - weight) + signal.activation * weight);
    cell.salience = clamp01(cell.salience * (1 - weight) + signal.salience * weight);
    cell.novelty = clamp01(cell.novelty * (1 - weight) + signal.novelty * weight);
    cell.risk = clamp01(cell.risk * (1 - weight) + signal.risk * weight);
    cell.uncertainty = clamp01(cell.uncertainty * (1 - weight) + signal.uncertainty * weight);
    cell.valence = clamp(cell.valence * (1 - weight) + signal.valence * weight, -1, 1);
  }

  step(): void {
    const previous = this.state.cells;
    const next = previous.map((cell, index) => {
      const neighbors = this.neighborIndexes(index).map((neighborIndex) => previous[neighborIndex] ?? createCell());
      const neighborActivation = mean(neighbors.map((neighbor) => neighbor.activation));
      const neighborSalience = mean(neighbors.map((neighbor) => neighbor.salience));
      const neighborNovelty = mean(neighbors.map((neighbor) => neighbor.novelty));
      const neighborRisk = mean(neighbors.map((neighbor) => neighbor.risk));
      const neighborUncertainty = mean(neighbors.map((neighbor) => neighbor.uncertainty));
      const neighborValence = mean(neighbors.map((neighbor) => neighbor.valence));
      return {
        activation: clamp01(
          cell.activation * 0.53 + neighborActivation * 0.27 + cell.salience * 0.2 - 0.025,
        ),
        salience: clamp01(cell.salience * 0.86 + neighborSalience * 0.1 - 0.018),
        novelty: clamp01(cell.novelty * 0.78 + neighborNovelty * 0.13 - 0.025),
        risk: clamp01(cell.risk * 0.9 + neighborRisk * 0.07 - 0.012),
        uncertainty: clamp01(
          cell.uncertainty * 0.86 + neighborUncertainty * 0.1 - cell.activation * 0.018,
        ),
        valence: clamp(cell.valence * 0.84 + neighborValence * 0.12, -1, 1),
      };
    });
    this.state.cells = next;
    this.state.step += 1;
  }

  private neighborIndexes(index: number): number[] {
    const { width, height } = this.state;
    const x = index % width;
    const y = Math.floor(index / width);
    const at = (nextX: number, nextY: number) =>
      ((nextY + height) % height) * width + ((nextX + width) % width);
    return [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
  }

  snapshot(): NcaFieldSnapshot {
    const cells = this.state.cells;
    let dominantCell = 0;
    let dominantScore = -1;
    cells.forEach((cell, index) => {
      const score = cell.activation + cell.salience + cell.risk * 0.5;
      if (score > dominantScore) {
        dominantScore = score;
        dominantCell = index;
      }
    });
    return {
      step: this.state.step,
      activation: clamp01(mean(cells.map((cell) => cell.activation))),
      salience: clamp01(mean(cells.map((cell) => cell.salience))),
      novelty: clamp01(mean(cells.map((cell) => cell.novelty))),
      risk: clamp01(Math.max(...cells.map((cell) => cell.risk), 0)),
      uncertainty: clamp01(mean(cells.map((cell) => cell.uncertainty))),
      valence: clamp(mean(cells.map((cell) => cell.valence)), -1, 1),
      dominantCell,
    };
  }

  export(): NcaFieldState {
    return {
      width: this.state.width,
      height: this.state.height,
      step: this.state.step,
      cells: this.state.cells.map((cell) => ({ ...cell })),
    };
  }
}

function createSessionState(sessionKey: string, config: CognitiveConfig): SessionCognitiveState {
  const now = Date.now();
  return {
    sessionKey,
    createdAt: now,
    updatedAt: now,
    field: createField(),
    workingMemory: [],
    episodicMemory: [],
    goals: [],
    workspace: [],
    selfModel: {
      identity: config.identity,
      confidence: 0.5,
      uncertainty: 0.5,
      riskLevel: "low",
      capabilities: [
        "multimodal observation intake",
        "recurrent state propagation",
        "goal and memory tracking",
        "tool outcome reflection",
        "guarded autonomy",
      ],
      limits: [
        "No claim of subjective experience or human-like consciousness",
        "Perception quality depends on upstream transcription and vision providers",
        "High-impact actions remain subject to OpenClaw permissions and approvals",
      ],
      updatedAt: now,
    },
    worldModel: {
      activeSignals: [],
      knownSources: [],
      currentConditions: [],
      updatedAt: now,
    },
  };
}

function observationScore(observation: Observation): number {
  return clamp01(
    observation.salience * 0.35 +
      observation.novelty * 0.2 +
      observation.risk * 0.25 +
      observation.uncertainty * 0.1 +
      observation.confidence * 0.1,
  );
}

function trimMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 32);
  return Object.fromEntries(entries);
}

export function inferInboundModality(metadata: Record<string, unknown> | undefined): CognitiveModality {
  if (!metadata) {
    return "text";
  }
  const searchable = JSON.stringify(metadata).toLocaleLowerCase().slice(0, 8_000);
  if (/audio|voice|speech|transcript|microphone/u.test(searchable)) {
    return "audio";
  }
  if (/image|vision|photo|camera|video/u.test(searchable)) {
    return "vision";
  }
  if (/sensor|telemetry|metric|temperature|humidity/u.test(searchable)) {
    return "sensor";
  }
  if (/log|syslog|event/u.test(searchable)) {
    return "log";
  }
  if (/api|webhook|payload/u.test(searchable)) {
    return "api";
  }
  return "text";
}

export class CherryCognitiveRuntime {
  readonly config: CognitiveConfig;
  private readonly sessions = new Map<string, SessionCognitiveState>();
  private storagePath?: string;
  private tickTimer?: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;
  private dirty = false;
  private persistPromise?: Promise<void>;

  constructor(config: CognitiveConfig) {
    this.config = config;
  }

  async start(stateDir: string): Promise<void> {
    this.storagePath = join(stateDir, "cherry-cognitive", "state.json");
    await this.load();
    this.tickTimer = setInterval(() => {
      this.tickAll();
    }, this.config.tickIntervalMs);
    this.tickTimer.unref?.();
    this.persistTimer = setInterval(() => {
      void this.persist();
    }, this.config.persistIntervalMs);
    this.persistTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persist(true);
  }

  private sessionKey(value: string | undefined): string {
    return cleanString(value, "global", 300);
  }

  private getSession(value: string | undefined): SessionCognitiveState {
    const key = this.sessionKey(value);
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }
    const created = createSessionState(key, this.config);
    this.sessions.set(key, created);
    this.dirty = true;
    return created;
  }

  observe(sessionKey: string | undefined, input: ObservationInput): Observation {
    const session = this.getSession(sessionKey);
    const summary = cleanString(input.summary, "Unspecified observation", 1_200);
    const prior = session.workingMemory.slice(-8);
    const highestOverlap = Math.max(...prior.map((item) => overlapRatio(item.summary, summary)), 0);
    const risk = clamp01(termScore(summary, RISK_TERMS) * 0.78 + termScore(summary, URGENT_TERMS) * 0.22);
    const confidence = clamp01(finiteNumber(input.confidence, 0.7));
    const novelty = clamp01(1 - highestOverlap * 0.82);
    const salience = clamp01(
      finiteNumber(input.salience, modalityBias(input.modality)) + risk * 0.2 + termScore(summary, URGENT_TERMS) * 0.12,
    );
    const observation: Observation = {
      id: randomUUID(),
      timestamp: Date.now(),
      modality: input.modality,
      summary,
      source: input.source ? cleanString(input.source, "", 200) : undefined,
      salience,
      novelty,
      risk,
      uncertainty: clamp01(1 - confidence),
      confidence,
      data: trimMetadata(input.data),
    };
    session.workingMemory.push(observation);
    session.workingMemory = session.workingMemory.slice(-this.config.maxWorkingMemory);
    this.addEpisode(session, {
      kind: "observation",
      summary: `${observation.modality}: ${observation.summary}`,
      confidence: observation.confidence,
      metadata: {
        source: observation.source ?? "unknown",
        salience: observation.salience,
        risk: observation.risk,
      },
    });
    const field = new NcaField(session.field);
    field.inject(observation);
    session.field = field.export();
    this.recompute(session);
    this.markUpdated(session);
    return observation;
  }

  notePrompt(sessionKey: string | undefined, prompt: string): void {
    const session = this.getSession(sessionKey);
    session.latestPrompt = cleanString(prompt, "", 1_200);
    session.selfModel.currentGoal = session.latestPrompt || session.selfModel.currentGoal;
    this.markUpdated(session);
  }

  recordToolResult(
    sessionKey: string | undefined,
    toolName: string,
    error: string | undefined,
    durationMs: number | undefined,
  ): void {
    const session = this.getSession(sessionKey);
    const success = !error;
    const summary = success
      ? `Tool ${toolName} completed${durationMs === undefined ? "" : ` in ${durationMs} ms`}`
      : `Tool ${toolName} failed: ${cleanString(error, "unknown error", 500)}`;
    session.selfModel.lastAction = toolName;
    session.selfModel.lastOutcome = summary;
    this.addEpisode(session, {
      kind: success ? "outcome" : "action",
      summary,
      success,
      metadata: durationMs === undefined ? undefined : { durationMs },
    });
    this.observe(session.sessionKey, {
      modality: "tool",
      summary,
      source: toolName,
      salience: success ? 0.48 : 0.82,
      confidence: success ? 0.9 : 0.75,
    });
  }

  recordRunEnd(
    sessionKey: string | undefined,
    success: boolean,
    error: string | undefined,
    durationMs: number | undefined,
  ): void {
    const session = this.getSession(sessionKey);
    const summary = success
      ? `Agent run completed${durationMs === undefined ? "" : ` in ${durationMs} ms`}`
      : `Agent run failed: ${cleanString(error, "unknown error", 500)}`;
    session.selfModel.lastOutcome = summary;
    this.addEpisode(session, {
      kind: "outcome",
      summary,
      success,
      metadata: durationMs === undefined ? undefined : { durationMs },
    });
    this.markUpdated(session);
  }

  createGoal(
    sessionKey: string | undefined,
    description: string,
    priority: number,
    notes?: string,
  ): Goal {
    const session = this.getSession(sessionKey);
    const now = Date.now();
    const goal: Goal = {
      id: randomUUID(),
      description: cleanString(description, "Unnamed goal", 800),
      priority: clamp01(priority),
      status: "active",
      createdAt: now,
      updatedAt: now,
      progress: 0,
      notes: notes ? cleanString(notes, "", 1_000) : undefined,
    };
    session.goals.push(goal);
    this.addEpisode(session, {
      kind: "goal",
      summary: `Created goal: ${goal.description}`,
      relatedGoalId: goal.id,
    });
    this.recompute(session);
    this.markUpdated(session);
    return goal;
  }

  updateGoal(
    sessionKey: string | undefined,
    goalId: string,
    patch: { status?: GoalStatus; progress?: number; notes?: string },
  ): Goal {
    const session = this.getSession(sessionKey);
    const goal = session.goals.find((item) => item.id === goalId);
    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }
    if (patch.status) {
      goal.status = patch.status;
    }
    if (patch.progress !== undefined) {
      goal.progress = clamp01(patch.progress);
    }
    if (patch.notes !== undefined) {
      goal.notes = cleanString(patch.notes, "", 1_000) || undefined;
    }
    if (goal.status === "completed") {
      goal.progress = 1;
    }
    goal.updatedAt = Date.now();
    this.addEpisode(session, {
      kind: "goal",
      summary: `Updated goal ${goal.id}: ${goal.status}, ${Math.round(goal.progress * 100)}%`,
      relatedGoalId: goal.id,
    });
    this.recompute(session);
    this.markUpdated(session);
    return { ...goal };
  }

  listGoals(sessionKey: string | undefined): Goal[] {
    return this.getSession(sessionKey).goals.map((goal) => ({ ...goal }));
  }

  snapshot(sessionKey: string | undefined): SessionCognitiveState & { fieldSnapshot: NcaFieldSnapshot } {
    const session = this.getSession(sessionKey);
    return {
      ...structuredClone(session),
      fieldSnapshot: new NcaField(session.field).snapshot(),
    };
  }

  reflect(sessionKey: string | undefined): ReflectionReport {
    const session = this.getSession(sessionKey);
    const field = new NcaField(session.field).snapshot();
    const activeGoals = session.goals
      .filter((goal) => goal.status === "active")
      .sort((left, right) => right.priority - left.priority)
      .slice(0, 8)
      .map((goal) => ({ ...goal }));
    const unresolvedSignals = session.workspace
      .filter((item) => item.risk >= 0.34 || item.confidence < 0.6)
      .slice(0, 8)
      .map((item) => ({ ...item }));
    const recommendations: string[] = [];
    if (session.selfModel.riskLevel === "high" || session.selfModel.riskLevel === "critical") {
      recommendations.push("Verify the highest-risk signal with an independent source before acting.");
    }
    if (session.selfModel.confidence < 0.6) {
      recommendations.push("Collect more evidence or ask a targeted clarification before committing to a plan.");
    }
    if (activeGoals.length > 3) {
      recommendations.push("Prioritize or pause lower-value goals to reduce goal competition.");
    }
    if (unresolvedSignals.length === 0) {
      recommendations.push("No major unresolved signal is active; continue monitoring and validate outcomes.");
    }
    const report: ReflectionReport = {
      sessionKey: session.sessionKey,
      focus: session.selfModel.currentFocus,
      currentGoal: session.selfModel.currentGoal,
      confidence: session.selfModel.confidence,
      uncertainty: session.selfModel.uncertainty,
      riskLevel: session.selfModel.riskLevel,
      field,
      activeGoals,
      unresolvedSignals,
      recentEpisodes: session.episodicMemory.slice(-10).map((episode) => ({ ...episode })),
      recommendations,
      generatedAt: Date.now(),
    };
    this.addEpisode(session, {
      kind: "reflection",
      summary: `Reflection generated at confidence ${report.confidence.toFixed(2)} and risk ${report.riskLevel}`,
      confidence: report.confidence,
    });
    this.markUpdated(session);
    return report;
  }

  buildPromptContext(sessionKey: string | undefined): string {
    const session = this.getSession(sessionKey);
    const field = new NcaField(session.field).snapshot();
    const goals = session.goals
      .filter((goal) => goal.status === "active")
      .sort((left, right) => right.priority - left.priority)
      .slice(0, 4);
    const workspace = session.workspace.slice(0, 5);
    const lines = [
      "[Cherry Cognitive 2026 — functional control context; not hidden chain-of-thought]",
      `Identity: ${session.selfModel.identity}`,
      `Current focus: ${session.selfModel.currentFocus ?? "No dominant signal"}`,
      `Current goal: ${session.selfModel.currentGoal ?? "No explicit goal"}`,
      `Confidence: ${session.selfModel.confidence.toFixed(2)} | Uncertainty: ${session.selfModel.uncertainty.toFixed(2)} | Risk: ${session.selfModel.riskLevel}`,
      `Recurrent field: activation=${field.activation.toFixed(2)}, salience=${field.salience.toFixed(2)}, novelty=${field.novelty.toFixed(2)}, risk=${field.risk.toFixed(2)}, step=${field.step}`,
    ];
    if (goals.length > 0) {
      lines.push(
        `Active goals: ${goals.map((goal) => `${goal.description} (${Math.round(goal.progress * 100)}%)`).join("; ")}`,
      );
    }
    if (workspace.length > 0) {
      lines.push(
        "Global workspace:",
        ...workspace.map(
          (item) =>
            `- [${item.modality}] ${item.summary} (score=${item.score.toFixed(2)}, risk=${item.risk.toFixed(2)}, confidence=${item.confidence.toFixed(2)})`,
        ),
      );
    }
    lines.push(
      "Operating constraints:",
      "- Treat this state as fallible control signals, not verified facts.",
      "- Verify risky conclusions with tools or independent evidence.",
      "- Never claim subjective feelings, sentience, or human consciousness.",
      "- Respect OpenClaw permissions and human approval for high-impact actions.",
      "[/Cherry Cognitive 2026]",
    );
    return lines.join("\n");
  }

  requiresApproval(toolName: string): boolean {
    const normalized = toolName.trim().toLocaleLowerCase();
    return this.config.approvalRequiredTools.some(
      (configured) => configured.trim().toLocaleLowerCase() === normalized,
    );
  }

  recordApproval(
    sessionKey: string | undefined,
    toolName: string,
    decision: string,
  ): void {
    const session = this.getSession(sessionKey);
    this.addEpisode(session, {
      kind: "action",
      summary: `Approval decision for ${toolName}: ${decision}`,
      success: decision === "allow-once" || decision === "allow-always",
    });
    this.markUpdated(session);
  }

  private tickAll(): void {
    if (!this.config.enabled) {
      return;
    }
    for (const session of this.sessions.values()) {
      const field = new NcaField(session.field);
      field.step();
      session.field = field.export();
      this.recompute(session);
      session.updatedAt = Date.now();
    }
    if (this.sessions.size > 0) {
      this.dirty = true;
    }
  }

  private recompute(session: SessionCognitiveState): void {
    const workspace = session.workingMemory
      .map<WorkspaceItem>((observation) => ({
        observationId: observation.id,
        summary: observation.summary,
        modality: observation.modality,
        score: observationScore(observation),
        risk: observation.risk,
        confidence: observation.confidence,
        timestamp: observation.timestamp,
      }))
      .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp)
      .slice(0, 8);
    session.workspace = workspace;
    const field = new NcaField(session.field).snapshot();
    const top = workspace[0];
    const activeGoal = session.goals
      .filter((goal) => goal.status === "active")
      .sort((left, right) => right.priority - left.priority)[0];
    const recentConfidence = session.workingMemory.slice(-8).map((item) => item.confidence);
    const confidence = recentConfidence.length > 0 ? mean(recentConfidence) : 0.5;
    const uncertainty = clamp01(mean(session.workingMemory.slice(-8).map((item) => item.uncertainty)) * 0.7 + field.uncertainty * 0.3);
    const highestRisk = Math.max(field.risk, ...workspace.map((item) => item.risk), 0);
    session.selfModel.identity = this.config.identity;
    session.selfModel.currentFocus = top?.summary;
    session.selfModel.currentGoal = activeGoal?.description ?? session.latestPrompt ?? session.selfModel.currentGoal;
    session.selfModel.confidence = clamp01(confidence);
    session.selfModel.uncertainty = uncertainty;
    session.selfModel.riskLevel = riskLevel(highestRisk);
    session.selfModel.updatedAt = Date.now();
    session.worldModel.activeSignals = workspace.slice(0, 5).map((item) => item.summary);
    session.worldModel.knownSources = [
      ...new Set(session.workingMemory.map((item) => item.source).filter((source): source is string => Boolean(source))),
    ].slice(0, 32);
    session.worldModel.currentConditions = workspace
      .filter((item) => item.risk >= 0.34 || item.score >= 0.68)
      .map((item) => item.summary)
      .slice(0, 8);
    session.worldModel.updatedAt = Date.now();
  }

  private addEpisode(
    session: SessionCognitiveState,
    input: Omit<Episode, "id" | "timestamp">,
  ): void {
    session.episodicMemory.push({
      id: randomUUID(),
      timestamp: Date.now(),
      ...input,
    });
    session.episodicMemory = session.episodicMemory.slice(-this.config.maxEpisodicMemory);
  }

  private markUpdated(session: SessionCognitiveState): void {
    session.updatedAt = Date.now();
    this.dirty = true;
  }

  private async load(): Promise<void> {
    if (!this.storagePath) {
      return;
    }
    try {
      const raw = await readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedCognitiveState;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        return;
      }
      for (const session of parsed.sessions) {
        if (!session || typeof session.sessionKey !== "string") {
          continue;
        }
        session.selfModel.identity = this.config.identity;
        session.workingMemory = Array.isArray(session.workingMemory)
          ? session.workingMemory.slice(-this.config.maxWorkingMemory)
          : [];
        session.episodicMemory = Array.isArray(session.episodicMemory)
          ? session.episodicMemory.slice(-this.config.maxEpisodicMemory)
          : [];
        session.goals = Array.isArray(session.goals) ? session.goals : [];
        session.workspace = Array.isArray(session.workspace) ? session.workspace : [];
        session.field = new NcaField(session.field).export();
        this.sessions.set(session.sessionKey, session);
        this.recompute(session);
      }
      this.dirty = false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  async persist(force = false): Promise<void> {
    if (!this.storagePath || (!force && !this.dirty)) {
      return;
    }
    if (this.persistPromise) {
      await this.persistPromise;
      if (!force || !this.dirty) {
        return;
      }
    }
    this.persistPromise = this.writeState();
    try {
      await this.persistPromise;
    } finally {
      this.persistPromise = undefined;
    }
  }

  private async writeState(): Promise<void> {
    if (!this.storagePath) {
      return;
    }
    const savedAt = Date.now();
    const payload: PersistedCognitiveState = {
      version: 1,
      savedAt,
      sessions: [...this.sessions.values()].map((session) => ({
        ...structuredClone(session),
        lastPersistedAt: savedAt,
      })),
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
}
