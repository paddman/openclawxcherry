export type PolicyMode = "monitor" | "enforce";

export type ToolPolicyConfig = {
  enabled: boolean;
  mode: PolicyMode;
  approvalRiskThreshold: number;
  blockRiskThreshold: number;
  maxCallsPerMinute: number;
  maxSerializedParamChars: number;
  blockedTools: string[];
  approvalTools: string[];
  readOnlyTools: string[];
  destructivePatterns: string[];
  sensitivePatterns: string[];
};

export type CognitiveRiskLevel = "low" | "medium" | "high" | "critical";

export type ToolPolicyInput = {
  sessionKey?: string;
  toolName: string;
  params: Record<string, unknown>;
  cognitiveRiskLevel?: CognitiveRiskLevel;
};

export type ToolPolicyDecision = {
  action: "allow" | "approval" | "block";
  risk: number;
  reason: string;
  matchedSignals: string[];
  rateLimit: {
    count: number;
    limit: number;
    windowMs: number;
  };
};

const DEFAULT_DESTRUCTIVE_PATTERNS = [
  "delete",
  "destroy",
  "drop",
  "erase",
  "format",
  "kill",
  "purge",
  "reboot",
  "remove",
  "reset",
  "revoke",
  "shutdown",
  "terminate",
  "truncate",
  "wipe",
  "rm -rf",
  "mkfs",
  "dd if=",
  "kubectl delete",
  "helm uninstall",
  "docker system prune",
  "qm destroy",
  "pvesh delete",
  "zfs destroy",
  "iptables -f",
  "ลบ",
  "ทำลาย",
  "ปิดระบบ",
  "รีบูต",
];

const DEFAULT_SENSITIVE_PATTERNS = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "private_key",
  "credential",
  "authorization",
  "bearer ",
  "รหัสผ่าน",
  "คีย์ลับ",
];

const DEFAULT_CONFIG: ToolPolicyConfig = {
  enabled: true,
  mode: "enforce",
  approvalRiskThreshold: 0.45,
  blockRiskThreshold: 0.92,
  maxCallsPerMinute: 30,
  maxSerializedParamChars: 100_000,
  blockedTools: [],
  approvalTools: [],
  readOnlyTools: [
    "read",
    "search",
    "list",
    "get",
    "inspect",
    "status",
    "health",
    "metrics",
    "query",
    "fetch",
  ],
  destructivePatterns: DEFAULT_DESTRUCTIVE_PATTERNS,
  sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
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

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const cleaned = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLocaleLowerCase())
    .filter(Boolean);
  return [...new Set(cleaned)].slice(0, 256);
}

function nestedObject(
  source: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const value = source?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseToolPolicyConfig(
  pluginConfig: Record<string, unknown> | undefined,
): ToolPolicyConfig {
  const source = nestedObject(pluginConfig, "policy");
  const mode = source.mode === "monitor" || source.mode === "enforce" ? source.mode : DEFAULT_CONFIG.mode;
  return {
    enabled: booleanValue(source.enabled, DEFAULT_CONFIG.enabled),
    mode,
    approvalRiskThreshold: numberValue(
      source.approvalRiskThreshold,
      DEFAULT_CONFIG.approvalRiskThreshold,
      0,
      1,
    ),
    blockRiskThreshold: numberValue(
      source.blockRiskThreshold,
      DEFAULT_CONFIG.blockRiskThreshold,
      0,
      1,
    ),
    maxCallsPerMinute: Math.round(
      numberValue(source.maxCallsPerMinute, DEFAULT_CONFIG.maxCallsPerMinute, 1, 10_000),
    ),
    maxSerializedParamChars: Math.round(
      numberValue(
        source.maxSerializedParamChars,
        DEFAULT_CONFIG.maxSerializedParamChars,
        1_000,
        2_000_000,
      ),
    ),
    blockedTools: stringArray(source.blockedTools, DEFAULT_CONFIG.blockedTools),
    approvalTools: stringArray(source.approvalTools, DEFAULT_CONFIG.approvalTools),
    readOnlyTools: stringArray(source.readOnlyTools, DEFAULT_CONFIG.readOnlyTools),
    destructivePatterns: stringArray(
      source.destructivePatterns,
      DEFAULT_CONFIG.destructivePatterns,
    ),
    sensitivePatterns: stringArray(source.sensitivePatterns, DEFAULT_CONFIG.sensitivePatterns),
  };
}

function stableSerialize(value: unknown, maxChars: number): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") {
      return item.toString();
    }
    if (item && typeof item === "object") {
      if (seen.has(item)) {
        return "[Circular]";
      }
      seen.add(item);
    }
    return item;
  });
  return (serialized ?? "").slice(0, maxChars + 1);
}

function riskFromCognitiveLevel(level: CognitiveRiskLevel | undefined): number {
  switch (level) {
    case "critical":
      return 0.32;
    case "high":
      return 0.2;
    case "medium":
      return 0.08;
    case "low":
    default:
      return 0;
  }
}

function exactMatch(values: string[], toolName: string): boolean {
  return values.some((value) => value === toolName);
}

function includesAny(haystack: string, needles: string[]): string[] {
  return needles.filter((needle) => haystack.includes(needle));
}

export class ToolPolicyEngine {
  readonly config: ToolPolicyConfig;
  private readonly callsBySession = new Map<string, number[]>();

  constructor(config: ToolPolicyConfig) {
    this.config = config;
  }

  evaluate(input: ToolPolicyInput): ToolPolicyDecision {
    const toolName = input.toolName.trim().toLocaleLowerCase();
    const sessionKey = input.sessionKey?.trim() || "global";
    const now = Date.now();
    const calls = this.pruneAndRecord(sessionKey, now);
    const matchedSignals: string[] = [];

    if (!this.config.enabled) {
      return {
        action: "allow",
        risk: 0,
        reason: "Tool policy engine is disabled.",
        matchedSignals,
        rateLimit: {
          count: calls.length,
          limit: this.config.maxCallsPerMinute,
          windowMs: 60_000,
        },
      };
    }

    if (exactMatch(this.config.blockedTools, toolName)) {
      matchedSignals.push(`blocked-tool:${toolName}`);
    }
    if (exactMatch(this.config.approvalTools, toolName)) {
      matchedSignals.push(`approval-tool:${toolName}`);
    }

    const serialized = stableSerialize(input.params, this.config.maxSerializedParamChars);
    const serializedLower = serialized.toLocaleLowerCase();
    if (serialized.length > this.config.maxSerializedParamChars) {
      matchedSignals.push("oversized-parameters");
    }

    const destructiveMatches = includesAny(
      `${toolName}\n${serializedLower}`,
      this.config.destructivePatterns,
    );
    for (const match of destructiveMatches.slice(0, 12)) {
      matchedSignals.push(`destructive:${match}`);
    }

    const sensitiveMatches = includesAny(serializedLower, this.config.sensitivePatterns);
    for (const match of sensitiveMatches.slice(0, 12)) {
      matchedSignals.push(`sensitive:${match}`);
    }

    const readOnlyHint = this.config.readOnlyTools.some(
      (prefix) => toolName === prefix || toolName.startsWith(`${prefix}_`) || toolName.includes(`_${prefix}`),
    );
    if (readOnlyHint) {
      matchedSignals.push("read-only-hint");
    }

    const rateExceeded = calls.length > this.config.maxCallsPerMinute;
    if (rateExceeded) {
      matchedSignals.push("rate-limit-exceeded");
    }

    let risk = riskFromCognitiveLevel(input.cognitiveRiskLevel);
    risk += destructiveMatches.length > 0 ? Math.min(0.68, 0.42 + destructiveMatches.length * 0.08) : 0;
    risk += sensitiveMatches.length > 0 ? Math.min(0.28, 0.12 + sensitiveMatches.length * 0.04) : 0;
    risk += exactMatch(this.config.approvalTools, toolName) ? 0.58 : 0;
    risk += exactMatch(this.config.blockedTools, toolName) ? 1 : 0;
    risk += serialized.length > this.config.maxSerializedParamChars ? 0.3 : 0;
    risk += rateExceeded ? 0.4 : 0;
    risk -= readOnlyHint && destructiveMatches.length === 0 ? 0.18 : 0;
    risk = clamp01(risk);

    let action: ToolPolicyDecision["action"] = "allow";
    if (risk >= this.config.blockRiskThreshold || exactMatch(this.config.blockedTools, toolName)) {
      action = "block";
    } else if (
      risk >= this.config.approvalRiskThreshold ||
      exactMatch(this.config.approvalTools, toolName)
    ) {
      action = "approval";
    }

    if (this.config.mode === "monitor" && action === "block") {
      action = "approval";
      matchedSignals.push("monitor-mode-downgrade");
    }

    const reason =
      action === "block"
        ? "Tool call exceeds the configured cognitive safety boundary."
        : action === "approval"
          ? "Tool call requires human review because risk signals were detected."
          : "No policy signal requires intervention.";

    return {
      action,
      risk,
      reason,
      matchedSignals,
      rateLimit: {
        count: calls.length,
        limit: this.config.maxCallsPerMinute,
        windowMs: 60_000,
      },
    };
  }

  inspect(): ToolPolicyConfig & { trackedSessions: number } {
    return {
      ...this.config,
      blockedTools: [...this.config.blockedTools],
      approvalTools: [...this.config.approvalTools],
      readOnlyTools: [...this.config.readOnlyTools],
      destructivePatterns: [...this.config.destructivePatterns],
      sensitivePatterns: [...this.config.sensitivePatterns],
      trackedSessions: this.callsBySession.size,
    };
  }

  private pruneAndRecord(sessionKey: string, now: number): number[] {
    const cutoff = now - 60_000;
    const calls = (this.callsBySession.get(sessionKey) ?? []).filter(
      (timestamp) => timestamp >= cutoff,
    );
    calls.push(now);
    this.callsBySession.set(sessionKey, calls);
    return calls;
  }
}
