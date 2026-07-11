import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReflectionReport, SessionCognitiveState } from "./types.js";

export type AutonomyMode = "off" | "suggest" | "guarded";
export type ProposalStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "executed"
  | "expired"
  | "cancelled";

export type AutonomyConfig = {
  enabled: boolean;
  mode: AutonomyMode;
  maxProposalsPerSession: number;
  proposalTtlMs: number;
  minimumConfidence: number;
  maximumAutomaticRisk: number;
  diagnosticOnly: boolean;
  allowedTools: string[];
};

export type ActionProposal = {
  id: string;
  sessionKey: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  status: ProposalStatus;
  title: string;
  objective: string;
  rationale: string;
  evidence: string[];
  expectedOutcome: string;
  risk: number;
  confidence: number;
  urgency: "low" | "medium" | "high" | "critical";
  suggestedTool?: string;
  suggestedParams?: Record<string, unknown>;
  requiresApproval: boolean;
  decisionNote?: string;
  executionSummary?: string;
};

type PersistedProposalState = {
  version: 1;
  savedAt: number;
  proposals: ActionProposal[];
};

const DEFAULT_CONFIG: AutonomyConfig = {
  enabled: true,
  mode: "suggest",
  maxProposalsPerSession: 24,
  proposalTtlMs: 6 * 60 * 60 * 1_000,
  minimumConfidence: 0.45,
  maximumAutomaticRisk: 0.2,
  diagnosticOnly: true,
  allowedTools: [],
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function cleanText(value: unknown, fallback: string, maxLength = 1_000): string {
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
  return Math.min(max, Math.max(min, value));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLocaleLowerCase())
      .filter(Boolean),
  )].slice(0, 256);
}

function nestedConfig(pluginConfig: Record<string, unknown> | undefined): Record<string, unknown> {
  const value = pluginConfig?.autonomy;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseAutonomyConfig(
  pluginConfig: Record<string, unknown> | undefined,
): AutonomyConfig {
  const source = nestedConfig(pluginConfig);
  const mode: AutonomyMode =
    source.mode === "off" || source.mode === "suggest" || source.mode === "guarded"
      ? source.mode
      : DEFAULT_CONFIG.mode;
  return {
    enabled: booleanValue(source.enabled, DEFAULT_CONFIG.enabled),
    mode,
    maxProposalsPerSession: Math.round(
      numberValue(
        source.maxProposalsPerSession,
        DEFAULT_CONFIG.maxProposalsPerSession,
        1,
        500,
      ),
    ),
    proposalTtlMs: Math.round(
      numberValue(source.proposalTtlMs, DEFAULT_CONFIG.proposalTtlMs, 60_000, 30 * 24 * 60 * 60 * 1_000),
    ),
    minimumConfidence: numberValue(
      source.minimumConfidence,
      DEFAULT_CONFIG.minimumConfidence,
      0,
      1,
    ),
    maximumAutomaticRisk: numberValue(
      source.maximumAutomaticRisk,
      DEFAULT_CONFIG.maximumAutomaticRisk,
      0,
      1,
    ),
    diagnosticOnly: booleanValue(source.diagnosticOnly, DEFAULT_CONFIG.diagnosticOnly),
    allowedTools: stringArray(source.allowedTools),
  };
}

function riskNumber(level: ReflectionReport["riskLevel"]): number {
  switch (level) {
    case "critical":
      return 0.96;
    case "high":
      return 0.76;
    case "medium":
      return 0.46;
    case "low":
    default:
      return 0.16;
  }
}

function urgencyFromRisk(risk: number): ActionProposal["urgency"] {
  if (risk >= 0.86) {
    return "critical";
  }
  if (risk >= 0.66) {
    return "high";
  }
  if (risk >= 0.36) {
    return "medium";
  }
  return "low";
}

function normalizeToolName(value: string | undefined): string | undefined {
  const cleaned = value?.trim().toLocaleLowerCase();
  return cleaned || undefined;
}

function isDiagnosticTool(toolName: string): boolean {
  return /(?:read|search|list|get|inspect|status|health|metrics|query|fetch|logs?|describe|show|audit|diagnos)/u.test(
    toolName,
  );
}

function proposalFingerprint(proposal: Pick<ActionProposal, "title" | "suggestedTool" | "objective">): string {
  return `${proposal.title.toLocaleLowerCase()}|${proposal.objective.toLocaleLowerCase()}|${proposal.suggestedTool ?? "none"}`;
}

export class AutonomyPlanner {
  readonly config: AutonomyConfig;
  private readonly proposalsBySession = new Map<string, ActionProposal[]>();
  private storagePath?: string;
  private dirty = false;

  constructor(config: AutonomyConfig) {
    this.config = config;
  }

  async start(stateDir: string): Promise<void> {
    this.storagePath = join(stateDir, "cherry-cognitive", "autonomy.json");
    await this.load();
    this.expire();
  }

  async stop(): Promise<void> {
    await this.persist();
  }

  propose(
    sessionKey: string | undefined,
    input: {
      title: string;
      objective: string;
      rationale: string;
      evidence?: string[];
      expectedOutcome: string;
      risk: number;
      confidence: number;
      suggestedTool?: string;
      suggestedParams?: Record<string, unknown>;
      requiresApproval?: boolean;
    },
  ): ActionProposal {
    const key = cleanText(sessionKey, "global", 300);
    const now = Date.now();
    const tool = normalizeToolName(input.suggestedTool);
    const risk = clamp01(input.risk);
    const confidence = clamp01(input.confidence);
    const requiresApproval =
      input.requiresApproval ??
      risk > this.config.maximumAutomaticRisk ||
      this.config.mode !== "guarded" ||
      Boolean(tool && !this.isAllowedTool(tool));

    const proposal: ActionProposal = {
      id: randomUUID(),
      sessionKey: key,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.config.proposalTtlMs,
      status: "proposed",
      title: cleanText(input.title, "Untitled proposal", 300),
      objective: cleanText(input.objective, "No objective supplied", 800),
      rationale: cleanText(input.rationale, "No rationale supplied", 1_200),
      evidence: [...new Set((input.evidence ?? []).map((item) => cleanText(item, "", 500)).filter(Boolean))].slice(0, 16),
      expectedOutcome: cleanText(input.expectedOutcome, "Unknown outcome", 800),
      risk,
      confidence,
      urgency: urgencyFromRisk(risk),
      suggestedTool: tool,
      suggestedParams: input.suggestedParams ? structuredClone(input.suggestedParams) : undefined,
      requiresApproval,
    };

    const existing = this.proposalsBySession.get(key) ?? [];
    const fingerprint = proposalFingerprint(proposal);
    const duplicate = existing.find(
      (item) =>
        item.status === "proposed" && proposalFingerprint(item) === fingerprint && item.expiresAt > now,
    );
    if (duplicate) {
      duplicate.updatedAt = now;
      duplicate.expiresAt = now + this.config.proposalTtlMs;
      duplicate.confidence = Math.max(duplicate.confidence, proposal.confidence);
      duplicate.risk = Math.max(duplicate.risk, proposal.risk);
      duplicate.urgency = urgencyFromRisk(duplicate.risk);
      duplicate.evidence = [...new Set([...duplicate.evidence, ...proposal.evidence])].slice(0, 16);
      this.dirty = true;
      return structuredClone(duplicate);
    }

    existing.push(proposal);
    this.proposalsBySession.set(
      key,
      existing
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, this.config.maxProposalsPerSession),
    );
    this.dirty = true;
    return structuredClone(proposal);
  }

  deriveFromReflection(
    sessionKey: string | undefined,
    state: SessionCognitiveState,
    reflection: ReflectionReport,
  ): ActionProposal[] {
    if (!this.config.enabled || this.config.mode === "off") {
      return [];
    }

    const proposals: ActionProposal[] = [];
    const risk = riskNumber(reflection.riskLevel);
    const topSignal = reflection.unresolvedSignals[0];
    const activeGoal = reflection.activeGoals[0];

    if (reflection.riskLevel === "high" || reflection.riskLevel === "critical") {
      proposals.push(
        this.propose(sessionKey, {
          title: "Verify high-risk signal independently",
          objective: topSignal?.summary ?? reflection.focus ?? "Validate the active high-risk condition",
          rationale:
            "The cognitive workspace reports elevated risk. Acting on one source would create avoidable false-positive and operational risk.",
          evidence: reflection.unresolvedSignals.slice(0, 4).map((item) => item.summary),
          expectedOutcome: "Confirm or reject the incident hypothesis using an independent read-only source.",
          risk: Math.max(0.22, risk - 0.45),
          confidence: reflection.confidence,
          suggestedTool: "status",
          suggestedParams: {
            focus: topSignal?.summary ?? reflection.focus,
            independentVerification: true,
          },
          requiresApproval: false,
        }),
      );
    }

    if (reflection.confidence < this.config.minimumConfidence || reflection.uncertainty > 0.55) {
      proposals.push(
        this.propose(sessionKey, {
          title: "Collect missing evidence",
          objective: reflection.currentGoal ?? activeGoal?.description ?? "Reduce uncertainty",
          rationale:
            "Confidence is below the configured autonomy threshold or uncertainty is elevated. More evidence is required before selecting a consequential action.",
          evidence: reflection.unresolvedSignals.slice(0, 6).map((item) => item.summary),
          expectedOutcome: "Increase confidence and narrow the plausible causes without changing production state.",
          risk: 0.12,
          confidence: Math.max(0.5, 1 - reflection.uncertainty),
          suggestedTool: "search",
          suggestedParams: {
            query: reflection.focus ?? reflection.currentGoal ?? "current anomaly",
          },
          requiresApproval: false,
        }),
      );
    }

    if (activeGoal && activeGoal.progress < 1) {
      proposals.push(
        this.propose(sessionKey, {
          title: "Advance the highest-priority active goal",
          objective: activeGoal.description,
          rationale: `The goal is active at ${Math.round(activeGoal.progress * 100)}% progress and has priority ${activeGoal.priority.toFixed(2)}.`,
          evidence: [
            state.selfModel.currentFocus ?? "No dominant focus",
            ...state.worldModel.currentConditions.slice(0, 3),
          ],
          expectedOutcome: "Produce one verifiable next step and update goal progress after observing the result.",
          risk: Math.min(0.38, risk * 0.45),
          confidence: reflection.confidence,
          suggestedTool: "inspect",
          suggestedParams: {
            goalId: activeGoal.id,
            focus: state.selfModel.currentFocus,
          },
          requiresApproval: false,
        }),
      );
    }

    if (reflection.unresolvedSignals.length === 0 && reflection.riskLevel === "low") {
      proposals.push(
        this.propose(sessionKey, {
          title: "Continue passive monitoring",
          objective: reflection.currentGoal ?? "Maintain operational awareness",
          rationale:
            "No major unresolved signal is active and current risk is low. The safest next action is to preserve state and monitor for meaningful change.",
          evidence: state.worldModel.activeSignals.slice(0, 4),
          expectedOutcome: "Detect material changes without generating unnecessary actions or model calls.",
          risk: 0.03,
          confidence: Math.max(0.7, reflection.confidence),
          requiresApproval: false,
        }),
      );
    }

    return proposals;
  }

  list(sessionKey: string | undefined, includeClosed = false): ActionProposal[] {
    this.expire();
    const key = cleanText(sessionKey, "global", 300);
    return (this.proposalsBySession.get(key) ?? [])
      .filter((proposal) => includeClosed || proposal.status === "proposed" || proposal.status === "approved")
      .map((proposal) => structuredClone(proposal));
  }

  decide(
    sessionKey: string | undefined,
    proposalId: string,
    decision: "approve" | "reject" | "cancel",
    note?: string,
  ): ActionProposal {
    const proposal = this.requireProposal(sessionKey, proposalId);
    if (proposal.status !== "proposed" && proposal.status !== "approved") {
      throw new Error(`Proposal ${proposalId} cannot be changed from status ${proposal.status}`);
    }
    proposal.status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "cancelled";
    proposal.decisionNote = note ? cleanText(note, "", 1_000) : undefined;
    proposal.updatedAt = Date.now();
    this.dirty = true;
    return structuredClone(proposal);
  }

  markExecuted(
    sessionKey: string | undefined,
    proposalId: string,
    summary: string,
  ): ActionProposal {
    const proposal = this.requireProposal(sessionKey, proposalId);
    if (proposal.status !== "approved") {
      throw new Error(`Proposal ${proposalId} must be approved before it can be marked executed`);
    }
    proposal.status = "executed";
    proposal.executionSummary = cleanText(summary, "Executed", 1_200);
    proposal.updatedAt = Date.now();
    this.dirty = true;
    return structuredClone(proposal);
  }

  buildPromptContext(sessionKey: string | undefined): string {
    const proposals = this.list(sessionKey).slice(0, 4);
    if (proposals.length === 0) {
      return "";
    }
    return [
      "[Cherry Guarded Autonomy Proposals]",
      "These are fallible next-action proposals, not authorization to execute.",
      ...proposals.map(
        (proposal) =>
          `- ${proposal.title} | status=${proposal.status} | risk=${proposal.risk.toFixed(2)} | confidence=${proposal.confidence.toFixed(2)} | approval=${proposal.requiresApproval ? "required" : "not-required"}${proposal.suggestedTool ? ` | suggestedTool=${proposal.suggestedTool}` : ""}`,
      ),
      "Do not execute a proposal marked approval-required until explicit approval is recorded.",
      "[/Cherry Guarded Autonomy Proposals]",
    ].join("\n");
  }

  stats(): {
    sessions: number;
    total: number;
    byStatus: Record<ProposalStatus, number>;
  } {
    this.expire();
    const byStatus: Record<ProposalStatus, number> = {
      proposed: 0,
      approved: 0,
      rejected: 0,
      executed: 0,
      expired: 0,
      cancelled: 0,
    };
    let total = 0;
    for (const proposals of this.proposalsBySession.values()) {
      for (const proposal of proposals) {
        byStatus[proposal.status] += 1;
        total += 1;
      }
    }
    return { sessions: this.proposalsBySession.size, total, byStatus };
  }

  async persist(): Promise<void> {
    if (!this.storagePath || !this.dirty) {
      return;
    }
    const payload: PersistedProposalState = {
      version: 1,
      savedAt: Date.now(),
      proposals: [...this.proposalsBySession.values()].flat().map((proposal) => structuredClone(proposal)),
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

  private isAllowedTool(toolName: string): boolean {
    if (this.config.allowedTools.length > 0 && !this.config.allowedTools.includes(toolName)) {
      return false;
    }
    if (this.config.diagnosticOnly && !isDiagnosticTool(toolName)) {
      return false;
    }
    return true;
  }

  private requireProposal(sessionKey: string | undefined, proposalId: string): ActionProposal {
    const key = cleanText(sessionKey, "global", 300);
    const proposal = (this.proposalsBySession.get(key) ?? []).find((item) => item.id === proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }
    return proposal;
  }

  private expire(): void {
    const now = Date.now();
    for (const proposals of this.proposalsBySession.values()) {
      for (const proposal of proposals) {
        if (
          (proposal.status === "proposed" || proposal.status === "approved") &&
          proposal.expiresAt <= now
        ) {
          proposal.status = "expired";
          proposal.updatedAt = now;
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
      const parsed = JSON.parse(raw) as PersistedProposalState;
      if (parsed.version !== 1 || !Array.isArray(parsed.proposals)) {
        return;
      }
      for (const proposal of parsed.proposals) {
        if (!proposal || typeof proposal.sessionKey !== "string" || typeof proposal.id !== "string") {
          continue;
        }
        const existing = this.proposalsBySession.get(proposal.sessionKey) ?? [];
        existing.push(proposal);
        this.proposalsBySession.set(
          proposal.sessionKey,
          existing
            .sort((left, right) => right.createdAt - left.createdAt)
            .slice(0, this.config.maxProposalsPerSession),
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
