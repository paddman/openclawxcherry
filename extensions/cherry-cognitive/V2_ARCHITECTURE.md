# Cherry Cognitive 2026 v2

Cherry Cognitive 2026 v2 extends the initial functional cognitive layer into an operational agent control plane. It does not claim subjective consciousness. It provides continuous state, memory, self-monitoring, adaptive confidence, guarded action proposals, policy enforcement, and observable health.

## Runtime flow

```text
Text / STT / Vision / Sensor / Syslog / Webhook / Tool result
                              |
                              v
                 Ingestion adapter normalization
                              |
                              v
               Adaptive source-confidence calibration
                              |
                              v
                   Observation + working memory
                              |
                              v
                  Recurrent NCA-inspired field
                              |
                              v
          Salience / novelty / risk / uncertainty / valence
                              |
                              v
                       Global workspace
                /              |              \
               v               v               v
          Self-model       World model       Goal manager
               \               |               /
                \              v              /
                 Episodic + semantic memory
                              |
                              v
                Metacognition and reflection
                              |
                              v
                 Guarded autonomy proposals
                              |
                              v
           Adaptive policy + learned tool reliability
                              |
                    allow / approval / block
                              |
                              v
                    OpenClaw tool execution
                              |
                              v
                    Outcome feedback loop
```

## New v2 modules

### `ingestion.ts`

Normalizes common operational inputs into bounded `ObservationInput` records:

- Prometheus and Alertmanager alerts
- RFC-style syslog data
- Generic webhooks
- Vision captions, objects, activities, and alarm flags
- Audio transcripts, speaker data, and wake-word flags
- Single or multi-reading sensor payloads

Raw audio, images, and video are still handled by upstream OpenClaw providers. This module receives compact transcripts, captions, events, and structured features.

### `learning.ts`

Maintains adaptive reliability profiles per session:

- source reliability by source and modality
- raw versus calibrated confidence
- average salience and high-risk signal frequency
- tool success rate
- average tool duration
- consecutive failures and latest failure

After enough samples, future observations from the same source are calibrated against learned reliability. Unstable tools are surfaced in prompt context and can force approval even when their name is normally low risk.

### `consolidation.ts`

Converts episodic events into bounded semantic memory:

- facts
- lessons
- failure patterns
- success patterns
- goal context
- source profiles
- operational rules

Near-duplicate memories are reinforced rather than copied indefinitely. Recall combines token similarity, confidence, importance, reinforcement, and recency.

### `autonomy.ts`

Creates persistent guarded proposals instead of executing actions directly.

Proposal lifecycle:

```text
proposed -> approved -> executed
        \-> rejected
        \-> cancelled
        \-> expired
```

Each proposal contains:

- objective and rationale
- supporting evidence
- expected outcome
- risk and confidence
- urgency
- suggested tool and parameters
- approval requirement
- expiry time
- decision and execution notes

The default mode is `suggest`. It does not authorize tool execution.

### `policy.ts`

Evaluates every tool call using:

- explicitly blocked tools
- explicitly approval-required tools
- read-only hints
- destructive command patterns
- sensitive parameter patterns
- cognitive risk state
- oversized payload detection
- per-session call-rate limits
- learned tool reliability from `learning.ts`

Decisions:

- `allow`
- `approval`
- `block`

`monitor` mode downgrades a block to approval for rollout observation. `enforce` applies blocking normally.

### `telemetry.ts`

Exposes aggregate health and Prometheus metrics.

Authenticated gateway endpoints:

```text
GET /api/cherry-cognitive/health
GET /api/cherry-cognitive/metrics
```

Health includes:

- tracked and active sessions
- high and critical risk sessions
- observations, episodes, and goals
- semantic memory totals
- autonomy proposal status
- source and tool learning profiles
- confidence, uncertainty, activation, and maximum risk

## Tools

### Base tools

```text
cherry_cognitive_observe
cherry_cognitive_goal
cherry_cognitive_state
cherry_cognitive_reflect
```

### v2 tools

```text
cherry_cognitive_ingest
cherry_cognitive_autonomy
cherry_cognitive_memory
cherry_cognitive_policy
cherry_cognitive_learning
cherry_cognitive_health
```

## CLI

```bash
openclaw cognitive health
openclaw cognitive sessions
openclaw cognitive policy
openclaw cognitive memory-stats
openclaw cognitive autonomy-stats
openclaw cognitive learning-stats
```

## Persistence

State remains separated by canonical OpenClaw session key.

```text
<state-dir>/cherry-cognitive/state.json
<state-dir>/cherry-cognitive/semantic-memory.json
<state-dir>/cherry-cognitive/autonomy.json
<state-dir>/cherry-cognitive/learning.json
```

Files are written atomically with mode `0600`.

## Recommended rollout

### Phase 1: Observe

```json
{
  "autonomy": {
    "mode": "off"
  },
  "policy": {
    "mode": "monitor"
  }
}
```

Connect inputs and inspect state without generating proposals.

### Phase 2: Suggest

```json
{
  "autonomy": {
    "mode": "suggest",
    "diagnosticOnly": true
  },
  "policy": {
    "mode": "monitor"
  }
}
```

The system creates proposals, but tool execution remains a normal OpenClaw decision.

### Phase 3: Guarded diagnostics

```json
{
  "autonomy": {
    "mode": "guarded",
    "diagnosticOnly": true,
    "allowedTools": ["status", "search", "inspect", "query", "fetch"]
  },
  "policy": {
    "mode": "enforce",
    "approvalRiskThreshold": 0.45,
    "blockRiskThreshold": 0.92
  }
}
```

Only diagnostic proposals are eligible. Existing OpenClaw RBAC and approval controls remain authoritative.

### Phase 4: Domain-specific remediation

Do not enable write actions globally. Add explicit tools one at a time after domain evaluation:

- expected target validation
- idempotency
- rollback plan
- blast-radius limit
- maintenance-window enforcement
- owner approval
- post-action verification
- audit logging

## Input examples

### Prometheus alert

```json
{
  "kind": "prometheus_alert",
  "source": "alertmanager-prod",
  "payloadJson": "{\"status\":\"firing\",\"alerts\":[{\"status\":\"firing\",\"labels\":{\"alertname\":\"HighRackTemperature\",\"severity\":\"critical\",\"instance\":\"rack-07\"},\"annotations\":{\"description\":\"Temperature exceeded 44C\"}}]}"
}
```

### Syslog

```json
{
  "kind": "syslog",
  "source": "mikrotik-ccr-bkk-01",
  "payloadJson": "{\"hostname\":\"ccr-bkk-01\",\"program\":\"firewall\",\"facility\":\"local4\",\"severity\":\"warning\",\"message\":\"Repeated RDP connection attempts\"}"
}
```

### Vision event

```json
{
  "kind": "vision",
  "source": "camera-rack-07",
  "payloadJson": "{\"caption\":\"Red alarm LED on cooling unit\",\"objects\":[\"cooling unit\",\"alarm LED\"],\"events\":[\"alarm\"],\"confidence\":0.88}"
}
```

### Audio transcript

```json
{
  "kind": "audio",
  "source": "control-room-mic",
  "payloadJson": "{\"speaker\":\"operator-1\",\"language\":\"th-TH\",\"transcript\":\"ระบบทำความเย็นมีเสียงผิดปกติ\",\"confidence\":0.84}"
}
```

## Validation commands

Run from a real repository checkout before merging:

```bash
pnpm install --lockfile-only
pnpm format:check
pnpm lint:extensions
pnpm check:test-types
pnpm test extensions/cherry-cognitive/src/runtime.test.ts \
  extensions/cherry-cognitive/src/policy.test.ts \
  extensions/cherry-cognitive/src/ingestion.test.ts \
  extensions/cherry-cognitive/src/autonomy.test.ts \
  extensions/cherry-cognitive/src/consolidation.test.ts \
  extensions/cherry-cognitive/src/learning.test.ts \
  extensions/cherry-cognitive/src/telemetry.test.ts
pnpm build
```

## Boundaries

- No claim of phenomenal consciousness, feelings, suffering, or sentience.
- No direct raw-media understanding inside the cognitive state engine.
- No permission escalation.
- No bypass of OpenClaw policy or approvals.
- No autonomous destructive action by default.
- No continuous LLM call on every NCA tick.
- Learned reliability is an estimate and can be wrong.
- Memory content is untrusted historical context and must not be treated as instructions.
