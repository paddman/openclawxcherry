export type CognitiveModality =
  | "text"
  | "audio"
  | "vision"
  | "sensor"
  | "api"
  | "log"
  | "tool"
  | "internal";

export type GoalStatus = "active" | "paused" | "completed" | "cancelled";

export type CognitiveConfig = {
  enabled: boolean;
  identity: string;
  tickIntervalMs: number;
  persistIntervalMs: number;
  maxWorkingMemory: number;
  maxEpisodicMemory: number;
  promptInjection: boolean;
  heartbeatAwareness: boolean;
  autoObserveMessages: boolean;
  approvalRequiredTools: string[];
  approvalTimeoutMs: number;
};

export type Observation = {
  id: string;
  timestamp: number;
  modality: CognitiveModality;
  summary: string;
  source?: string;
  salience: number;
  novelty: number;
  risk: number;
  uncertainty: number;
  confidence: number;
  data?: Record<string, unknown>;
};

export type Goal = {
  id: string;
  description: string;
  priority: number;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  progress: number;
  notes?: string;
};

export type Episode = {
  id: string;
  timestamp: number;
  kind: "observation" | "action" | "outcome" | "reflection" | "goal";
  summary: string;
  success?: boolean;
  confidence?: number;
  relatedGoalId?: string;
  metadata?: Record<string, unknown>;
};

export type NcaCellState = {
  activation: number;
  salience: number;
  novelty: number;
  risk: number;
  uncertainty: number;
  valence: number;
};

export type NcaFieldState = {
  width: number;
  height: number;
  step: number;
  cells: NcaCellState[];
};

export type NcaFieldSnapshot = {
  step: number;
  activation: number;
  salience: number;
  novelty: number;
  risk: number;
  uncertainty: number;
  valence: number;
  dominantCell: number;
};

export type WorkspaceItem = {
  observationId: string;
  summary: string;
  modality: CognitiveModality;
  score: number;
  risk: number;
  confidence: number;
  timestamp: number;
};

export type SelfModel = {
  identity: string;
  currentFocus?: string;
  currentGoal?: string;
  confidence: number;
  uncertainty: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  lastAction?: string;
  lastOutcome?: string;
  capabilities: string[];
  limits: string[];
  updatedAt: number;
};

export type WorldModel = {
  activeSignals: string[];
  knownSources: string[];
  currentConditions: string[];
  updatedAt: number;
};

export type SessionCognitiveState = {
  sessionKey: string;
  createdAt: number;
  updatedAt: number;
  field: NcaFieldState;
  workingMemory: Observation[];
  episodicMemory: Episode[];
  goals: Goal[];
  workspace: WorkspaceItem[];
  selfModel: SelfModel;
  worldModel: WorldModel;
  latestPrompt?: string;
  lastPersistedAt?: number;
};

export type PersistedCognitiveState = {
  version: 1;
  savedAt: number;
  sessions: SessionCognitiveState[];
};

export type ObservationInput = {
  modality: CognitiveModality;
  summary: string;
  source?: string;
  salience?: number;
  confidence?: number;
  data?: Record<string, unknown>;
};

export type ReflectionReport = {
  sessionKey: string;
  focus?: string;
  currentGoal?: string;
  confidence: number;
  uncertainty: number;
  riskLevel: SelfModel["riskLevel"];
  field: NcaFieldSnapshot;
  activeGoals: Goal[];
  unresolvedSignals: WorkspaceItem[];
  recentEpisodes: Episode[];
  recommendations: string[];
  generatedAt: number;
};
