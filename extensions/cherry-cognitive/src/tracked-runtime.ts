import { CherryCognitiveRuntime } from "./runtime.js";
import type { Goal, GoalStatus, Observation, ObservationInput, ReflectionReport } from "./types.js";

type ObservationCalibrator = (
  sessionKey: string | undefined,
  input: ObservationInput,
) => ObservationInput;

type ObservationListener = (sessionKey: string | undefined, observation: Observation) => void;

type ToolOutcomeListener = (event: {
  sessionKey: string | undefined;
  toolName: string;
  success: boolean;
  error?: string;
  durationMs?: number;
}) => void;

export class TrackedCognitiveRuntime extends CherryCognitiveRuntime {
  private readonly knownSessionKeys = new Set<string>();
  private readonly observationListeners = new Set<ObservationListener>();
  private readonly toolOutcomeListeners = new Set<ToolOutcomeListener>();
  private observationCalibrator?: ObservationCalibrator;

  listSessionKeys(): string[] {
    return [...this.knownSessionKeys].toSorted((left, right) => left.localeCompare(right));
  }

  setObservationCalibrator(calibrator: ObservationCalibrator | undefined): void {
    this.observationCalibrator = calibrator;
  }

  onObservation(listener: ObservationListener): () => void {
    this.observationListeners.add(listener);
    return () => {
      this.observationListeners.delete(listener);
    };
  }

  onToolOutcome(listener: ToolOutcomeListener): () => void {
    this.toolOutcomeListeners.add(listener);
    return () => {
      this.toolOutcomeListeners.delete(listener);
    };
  }

  override observe(sessionKey: string | undefined, input: ObservationInput): Observation {
    this.touch(sessionKey);
    const calibrated = this.observationCalibrator
      ? this.observationCalibrator(sessionKey, input)
      : input;
    const observation = super.observe(sessionKey, calibrated);
    for (const listener of this.observationListeners) {
      try {
        listener(sessionKey, observation);
      } catch {
        // Learning and telemetry listeners must never interrupt the primary agent path.
      }
    }
    return observation;
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
    for (const listener of this.toolOutcomeListeners) {
      try {
        listener({
          sessionKey,
          toolName,
          success: !error,
          error,
          durationMs,
        });
      } catch {
        // Learning and telemetry listeners must never interrupt the primary agent path.
      }
    }
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

  override snapshot(
    sessionKey: string | undefined,
  ): ReturnType<CherryCognitiveRuntime["snapshot"]> {
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
