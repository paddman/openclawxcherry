import type { SessionCognitiveState, WorkspaceItem } from "./types.js";

export type CognitiveMode = "idle" | "monitoring" | "deliberative" | "reflex";

export type AttentionContender = {
  rank: number;
  observationId: string;
  summary: string;
  source?: string;
  modality: string;
  score: number;
  salience: number;
  risk: number;
  novelty: number;
  uncertainty: number;
  selected: boolean;
  selectionReason: string;
};

export type AttentionSchema = {
  generatedAt: number;
  sessionKey: string;
  mode: CognitiveMode;
  capacity: number;
  occupiedSlots: number;
  dominantFocus?: string;
  dominantObservationId?: string;
  selectionExplanation: string;
  stability: number;
  switchingPressure: number;
  tunnelVisionRisk: number;
  metacognitiveConfidence: number;
  contenders: AttentionContender[];
  suppressedSignals: AttentionContender[];
  recommendedControl: string[];
};

export type AttentionSchemaConfig = {
  capacity: number;
  contenderLimit: number;
  suppressedLimit: number;
  reflexRiskThreshold: number;
  deliberativeUncertaintyThreshold: number;
};

const DEFAULT_CONFIG: AttentionSchemaConfig = {
  capacity: 4,
  contenderLimit: 8,
  suppressedLimit: 6,
  reflexRiskThreshold: 0.82,
  deliberativeUncertaintyThreshold: 0.58,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return clamp(value, min, max);
}

function nestedConfig(pluginConfig: Record<string, unknown> | undefined): Record<string, unknown> {
  const value = pluginConfig?.attention;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseAttentionSchemaConfig(
  pluginConfig: Record<string, unknown> | undefined,
): AttentionSchemaConfig {
  const source = nestedConfig(pluginConfig);
  return {
    capacity: Math.round(numberValue(source.capacity, DEFAULT_CONFIG.capacity, 1, 16)),
    contenderLimit: Math.round(
      numberValue(source.contenderLimit, DEFAULT_CONFIG.contenderLimit, 1, 64),
    ),
    suppressedLimit: Math.round(
      numberValue(source.suppressedLimit, DEFAULT_CONFIG.suppressedLimit, 0, 64),
    ),
    reflexRiskThreshold: numberValue(
      source.reflexRiskThreshold,
      DEFAULT_CONFIG.reflexRiskThreshold,
      0,
      1,
    ),
    deliberativeUncertaintyThreshold: numberValue(
      source.deliberativeUncertaintyThreshold,
      DEFAULT_CONFIG.deliberativeUncertaintyThreshold,
      0,
      1,
    ),
  };
}

function contenderScore(item: WorkspaceItem): number {
  return clamp01(
    item.salience * 0.28 +
      item.risk * 0.28 +
      item.novelty * 0.18 +
      item.uncertainty * 0.14 +
      item.confidence * 0.12,
  );
}

function selectionReason(item: WorkspaceItem): string {
  const factors = [
    { name: "risk", value: item.risk },
    { name: "salience", value: item.salience },
    { name: "novelty", value: item.novelty },
    { name: "uncertainty", value: item.uncertainty },
    { name: "confidence", value: item.confidence },
  ].sort((left, right) => right.value - left.value);
  return `${factors[0]?.name ?? "combined score"}=${(factors[0]?.value ?? 0).toFixed(2)}; ${factors[1]?.name ?? "context"}=${(factors[1]?.value ?? 0).toFixed(2)}`;
}

function toContender(
  item: WorkspaceItem,
  rank: number,
  capacity: number,
): AttentionContender {
  return {
    rank,
    observationId: item.observationId,
    summary: item.summary,
    source: item.source,
    modality: item.modality,
    score: contenderScore(item),
    salience: item.salience,
    risk: item.risk,
    novelty: item.novelty,
    uncertainty: item.uncertainty,
    selected: rank <= capacity,
    selectionReason: selectionReason(item),
  };
}

function cognitiveMode(
  state: SessionCognitiveState,
  config: AttentionSchemaConfig,
): CognitiveMode {
  const top = state.workspace[0];
  if (!top && state.goals.every((goal) => goal.status !== "active")) {
    return "idle";
  }
  if ((top?.risk ?? state.fieldSnapshot.risk) >= config.reflexRiskThreshold) {
    return "reflex";
  }
  if (
    state.selfModel.uncertainty >= config.deliberativeUncertaintyThreshold ||
    state.goals.filter((goal) => goal.status === "active").length > 1
  ) {
    return "deliberative";
  }
  return "monitoring";
}

function attentionStability(contenders: AttentionContender[]): number {
  if (contenders.length < 2) {
    return contenders.length === 1 ? 0.9 : 1;
  }
  const first = contenders[0]?.score ?? 0;
  const second = contenders[1]?.score ?? 0;
  return clamp01(0.45 + (first - second) * 1.1);
}

function switchingPressure(contenders: AttentionContender[]): number {
  if (contenders.length < 2) {
    return 0;
  }
  const top = contenders[0]?.score ?? 0;
  const closeCompetitors = contenders.slice(1).filter((item) => top - item.score <= 0.12).length;
  return clamp01(closeCompetitors / Math.max(1, contenders.length - 1));
}

function tunnelVisionRisk(
  contenders: AttentionContender[],
  state: SessionCognitiveState,
): number {
  if (contenders.length === 0) {
    return 0;
  }
  const selected = contenders.filter((item) => item.selected);
  const sourceCount = new Set(selected.map((item) => item.source ?? "unknown")).size;
  const modalityCount = new Set(selected.map((item) => item.modality)).size;
  const dominantShare =
    selected.length === 0
      ? 0
      : Math.max(
          ...[...new Set(selected.map((item) => item.source ?? "unknown"))].map(
            (source) =>
              selected.filter((item) => (item.source ?? "unknown") === source).length /
              selected.length,
          ),
        );
  const lowDiversity =
    (sourceCount <= 1 ? 0.38 : 0) + (modalityCount <= 1 ? 0.28 : 0) + dominantShare * 0.2;
  const persistence = state.fieldSnapshot.activation > 0.8 && switchingPressure(contenders) < 0.2 ? 0.14 : 0;
  return clamp01(lowDiversity + persistence);
}

function recommendations(
  mode: CognitiveMode,
  contenders: AttentionContender[],
  tunnelRisk: number,
  state: SessionCognitiveState,
): string[] {
  const result: string[] = [];
  if (mode === "reflex") {
    result.push("Prioritize immediate containment and independent verification before irreversible action.");
  }
  if (mode === "deliberative") {
    result.push("Compare competing hypotheses and identify the cheapest observation that separates them.");
  }
  if (tunnelRisk >= 0.6) {
    result.push("Seek a different source or modality to reduce attentional tunnel vision.");
  }
  if (switchingPressure(contenders) >= 0.5) {
    result.push("Hold the current goal stable long enough to collect decisive evidence before switching focus.");
  }
  if (state.selfModel.confidence < 0.5) {
    result.push("State uncertainty explicitly and avoid presenting a single explanation as settled.");
  }
  if (state.goals.filter((goal) => goal.status === "active").length > 3) {
    result.push("Pause or rank lower-priority goals to reduce goal competition.");
  }
  if (result.length === 0) {
    result.push("Maintain current focus and monitor for materially higher-risk or more novel signals.");
  }
  return result;
}

export class AttentionSchemaEngine {
  readonly config: AttentionSchemaConfig;

  constructor(config: AttentionSchemaConfig) {
    this.config = config;
  }

  inspect(state: SessionCognitiveState): AttentionSchema {
    const sorted = state.workspace
      .map((item) => ({ item, score: contenderScore(item) }))
      .sort((left, right) => right.score - left.score)
      .map(({ item }, index) => toContender(item, index + 1, this.config.capacity));
    const contenders = sorted.slice(0, this.config.contenderLimit);
    const suppressedSignals = sorted
      .filter((item) => !item.selected)
      .slice(0, this.config.suppressedLimit);
    const mode = cognitiveMode(state, this.config);
    const stability = attentionStability(contenders);
    const pressure = switchingPressure(contenders);
    const tunnelRisk = tunnelVisionRisk(contenders, state);
    const dominant = contenders[0];
    const metacognitiveConfidence = clamp01(
      state.selfModel.confidence * 0.5 +
        stability * 0.25 +
        (1 - state.selfModel.uncertainty) * 0.25,
    );
    const selectionExplanation = dominant
      ? `Focus selected because ${dominant.selectionReason}. Mode=${mode}; competing-pressure=${pressure.toFixed(2)}.`
      : "No signal currently occupies the attention workspace.";

    return {
      generatedAt: Date.now(),
      sessionKey: state.sessionKey,
      mode,
      capacity: this.config.capacity,
      occupiedSlots: contenders.filter((item) => item.selected).length,
      dominantFocus: dominant?.summary,
      dominantObservationId: dominant?.observationId,
      selectionExplanation,
      stability,
      switchingPressure: pressure,
      tunnelVisionRisk: tunnelRisk,
      metacognitiveConfidence,
      contenders,
      suppressedSignals,
      recommendedControl: recommendations(mode, contenders, tunnelRisk, state),
    };
  }

  buildPromptContext(state: SessionCognitiveState): string {
    const schema = this.inspect(state);
    return [
      "[Cherry Attention Schema]",
      `Mode=${schema.mode}; capacity=${schema.occupiedSlots}/${schema.capacity}; stability=${schema.stability.toFixed(2)}; switchingPressure=${schema.switchingPressure.toFixed(2)}; tunnelVisionRisk=${schema.tunnelVisionRisk.toFixed(2)}.`,
      `Selection: ${schema.selectionExplanation}`,
      ...schema.contenders.slice(0, schema.capacity).map(
        (item) =>
          `- focus#${item.rank}: ${item.summary} | score=${item.score.toFixed(2)} | ${item.selectionReason}`,
      ),
      ...schema.recommendedControl.map((item) => `- control: ${item}`),
      "This schema is an operational model of attention, not evidence of subjective experience.",
      "[/Cherry Attention Schema]",
    ].join("\n");
  }
}
