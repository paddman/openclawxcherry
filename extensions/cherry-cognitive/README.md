# Cherry Cognitive 2026

Cherry Cognitive 2026 is an optional OpenClaw extension that adds a continuous functional cognitive layer to an agent.

It is designed for agents that receive text, voice transcripts, image or video summaries, sensor values, logs, webhook payloads, API results, and tool outcomes, then maintain an evolving state instead of treating every prompt as an isolated request.

## What it adds

- Multimodal observation intake for `text`, `audio`, `vision`, `sensor`, `api`, `log`, `tool`, and `internal` signals.
- A recurrent Neural Cellular Automata-inspired field that propagates salience, novelty, risk, uncertainty, activation, and valence across local cells.
- A global workspace containing the most important current signals.
- A self-model with current focus, current goal, confidence, uncertainty, risk level, last action, and last outcome.
- Working memory and bounded episodic memory per OpenClaw session.
- Persistent goals with priority, status, progress, and notes.
- Metacognitive reflection reports.
- Continuous background ticks without continuously calling an LLM.
- Atomic state persistence under the OpenClaw state directory.
- Optional approval gates for configured high-impact tools.
- Prompt and heartbeat context injection so the active agent can use the current functional state.

## Important limitation

This extension implements **functional machine consciousness**, not proof of subjective consciousness.

It can track what the agent is attending to, estimate confidence and risk, remember outcomes, maintain goals, and inspect its own operational state. It must not claim that it feels, suffers, is sentient, or has human-like inner experience.

The recurrent field is NCA-inspired and deterministic. It is not a trained biological brain simulation and does not replace the reasoning model.

## Architecture

```text
Text / Voice / Vision / Sensor / API / Logs / Tool results
                         |
                         v
               Multimodal observations
                         |
                         v
             Recurrent NCA-inspired field
                         |
                         v
                Salience and attention
                         |
                         v
                  Global workspace
              /          |           \
             v           v            v
        Self-model    Goal manager    Memory
             \           |            /
              \          v           /
               Agent prompt context
                         |
                         v
                Planner / LLM / tools
                         |
                         v
                Outcome and reflection
                         |
                         +------ feedback loop
```

OpenClaw remains responsible for model execution, permissions, tools, channels, transcription, vision understanding, and delivery. Cherry Cognitive 2026 maintains the control state around those capabilities.

## Install in this repository

The extension is already part of the workspace through `extensions/*`.

```bash
pnpm install
pnpm test extensions/cherry-cognitive/src/runtime.test.ts
pnpm openclaw plugins enable cherry-cognitive
```

Restart the Gateway after enabling or changing the plugin configuration.

## Configuration

Configure the extension under `plugins.entries.cherry-cognitive.config`.

```json
{
  "plugins": {
    "entries": {
      "cherry-cognitive": {
        "enabled": true,
        "config": {
          "identity": "Cherry IDC Cognitive Agent",
          "tickIntervalMs": 5000,
          "persistIntervalMs": 30000,
          "maxWorkingMemory": 32,
          "maxEpisodicMemory": 256,
          "promptInjection": true,
          "heartbeatAwareness": true,
          "autoObserveMessages": true,
          "approvalRequiredTools": ["exec", "delete_file"],
          "approvalTimeoutMs": 60000
        }
      }
    }
  }
}
```

### Configuration fields

| Field                   |                  Default | Purpose                                                              |
| ----------------------- | -----------------------: | -------------------------------------------------------------------- |
| `enabled`               |                   `true` | Enables the runtime and hooks.                                       |
| `identity`              | `Cherry Cognitive Agent` | Identity shown in the functional self-model.                         |
| `tickIntervalMs`        |                   `5000` | Recurrent field update interval. Minimum 1 second.                   |
| `persistIntervalMs`     |                  `30000` | Atomic state save interval.                                          |
| `maxWorkingMemory`      |                     `32` | Recent observations retained per session.                            |
| `maxEpisodicMemory`     |                    `256` | Episodes retained per session.                                       |
| `promptInjection`       |                   `true` | Injects the current workspace and self-model before each agent turn. |
| `heartbeatAwareness`    |                   `true` | Adds the current state to heartbeat turns.                           |
| `autoObserveMessages`   |                   `true` | Converts inbound messages and attachment metadata into observations. |
| `approvalRequiredTools` |                     `[]` | Exact tool names that require human approval before execution.       |
| `approvalTimeoutMs`     |                  `60000` | Approval timeout. A timeout is denied.                               |

## Agent tools

### `cherry_cognitive_observe`

Feeds a normalized observation into the current session.

Use it after upstream perception has converted raw media into a compact representation:

```json
{
  "modality": "vision",
  "summary": "Camera sees a red alarm LED on cooling unit 3",
  "source": "camera-rack-07",
  "salience": 0.9,
  "confidence": 0.82,
  "dataJson": "{\"rack\":\"07\",\"unit\":3}"
}
```

Raw audio and images should first pass through OpenClaw transcription or media-understanding providers. The cognitive layer consumes the resulting transcript, caption, objects, events, or structured features.

### `cherry_cognitive_goal`

Creates, updates, completes, pauses, cancels, or lists persistent goals.

```json
{
  "action": "create",
  "description": "Diagnose cooling anomaly without interrupting production",
  "priority": 0.95
}
```

### `cherry_cognitive_state`

Returns the current global workspace, self-model, world model, goals, memories, and recurrent field metrics.

### `cherry_cognitive_reflect`

Returns a metacognitive report with:

- dominant focus;
- active goal;
- confidence and uncertainty;
- current risk level;
- unresolved signals;
- recent episodes;
- recommended verification steps.

## Runtime behavior

### Inbound perception

The `message_received` hook automatically records incoming content. Attachment metadata is inspected to classify the signal as text, audio, vision, sensor, API, or log data when possible.

### Continuous cognitive loop

A background service updates the recurrent field every `tickIntervalMs`. This decays stale signals, propagates important local states, and updates the self-model and workspace. It does **not** call a model on every tick.

### Agent turn preparation

The `agent_turn_prepare` hook injects a compact state block before the normal prompt. The block is operational context, not a hidden chain-of-thought transcript.

### Tool learning

The `after_tool_call` hook records success, failure, and duration. Failed tools increase salience and uncertainty so the next turn can adapt.

### Guarded autonomy

Tools listed in `approvalRequiredTools` trigger OpenClaw's approval flow. A timeout is denied. Permissions and existing OpenClaw safety controls remain authoritative.

### Persistence

State is stored at:

```text
<openclaw-state-dir>/cherry-cognitive/state.json
```

The file is written atomically with mode `0600`. State is separated by canonical session key to reduce unintended cross-conversation memory leakage.

## Recommended production rollout

1. Enable the plugin with no approval-required tools and observe state quality.
2. Connect existing audio transcription, vision understanding, monitoring, syslog, and API sources.
3. Feed only compact summaries and structured features, not unrestricted raw payloads.
4. Review salience and risk behavior using `cherry_cognitive_state`.
5. Add high-impact tools to `approvalRequiredTools`.
6. Keep destructive infrastructure actions behind existing RBAC and human approval.
7. Add domain-specific evaluators before allowing autonomous remediation.

## What this does not do yet

- Train the NCA field from reward or gradient updates.
- Generate autonomous LLM turns without OpenClaw heartbeat, cron, or an inbound event.
- Replace speech-to-text, image understanding, or sensor ingestion providers.
- Prove phenomenal consciousness.
- Grant new permissions or bypass approvals.

Those are deliberate boundaries for the first production-safe implementation.
