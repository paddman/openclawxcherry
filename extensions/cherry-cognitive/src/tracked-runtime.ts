import { CherryCognitiveRuntime } from "./runtime.js";
import type {
  CognitiveConfig,
  Goal,
  GoalStatus,
  Observation,
  ObservationInput,
  ReflectionReport,
} from "./types.js";

export class TrackedCognitiveRuntime extends CherryCognitiveRuntime {
  private readonly knownSessionKeys = new Set<string>();

  constructor(config: CognitiveConfig) {
    super(config);
  }

  listSessionKeys(): string[] {
    return [...this.knownSessionKeys].sort((left, right) => left.localeCompare(right));
  }

  override observe(sessionKey: string | undefined, input: ObservationInput): Observation {
    this.touch(sessionKey);
    return super.observe(sessionKey, input);
  }

  override notePrompt(sessionKey: string | undefined, prompt: string): void {
    this.touch(sessionKey);
    super.notePrompt(sessionKey, prompt);
  }

  override recordToolResult(
    sessionKey: string | undefined,
    toolName: string,
    error: string | undefined,
    durationMs: number | undefined,
  ): void {
    this.touch(sessionKey);
    super.recordToolResult(sessionKey, toolName, error, durationMs);
  }

  override recordRunEnd(
    sessionKey: string | undefined,
    success: boolean,
    error: string | undefined,
    durationMs: number | undefined,
  ): void {
    this.touch(sessionKey);
    super.recordRunEnd(sessionKey, success, error, durationMs);
  }

  override createGoal(
    sessionKey: string | undefined,
    description: string,
    priority: number,
    notes?: string,
  ): Goal {
    this.touch(sessionKey);
    return super.createGoal(sessionKey, description, priority, notes);
  }

  override updateGoal(
    sessionKey: string | undefined,
    goalId: string,
    patch: { status?: GoalStatus; progress?: number; notes?: string },
  ): Goal {
    this.touch(sessionKey);
    return super.updateGoal(sessionKey, goalId, patch);
  }

  override listGoals(sessionKey: string | undefined): Goal[] {
    this.touch(sessionKey);
    return super.listGoals(sessionKey);
  }

  override snapshot(sessionKey: string | undefined): ReturnType<CherryCognitiveRuntime["snapshot"]> {
    this.touch(sessionKey);
    return super.snapshot(sessionKey);
  }

  override reflect(sessionKey: string | undefined): ReflectionReport {
    this.touch(sessionKey);
    return super.reflect(sessionKey);
  }

  override buildPromptContext(sessionKey: string | undefined): string {
    this.touch(sessionKey);
    return super.buildPromptContext(sessionKey);
  }

  override recordApproval(
    sessionKey: string | undefined,
    toolName: string,
    decision: string,
  ): void {
    this.touch(sessionKey);
    super.recordApproval(sessionKey, toolName, decision);
  }

  private touch(sessionKey: string | undefined): void {
    this.knownSessionKeys.add(sessionKey?.trim() || "global");
  }
}
