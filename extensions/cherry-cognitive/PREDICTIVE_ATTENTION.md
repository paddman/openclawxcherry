# Predictive Processing and Attention Schema

Cherry Cognitive 2026 uses two explicit operational models to move beyond a simple prompt-response agent:

1. a prediction ledger that stores falsifiable expectations and scores their outcomes;
2. an attention schema that explains what currently occupies the workspace and why.

Neither module proves subjective consciousness. They provide inspectable, testable cognitive functions.

## Predictive processing

The prediction engine stores a hypothesis as a time-bounded record:

```text
hypothesis
expected signal
expected source
confidence
creation time
prediction horizon
status
evidence
calibration score
```

Statuses:

```text
pending
confirmed
refuted
expired
cancelled
```

### Creating a prediction

```json
{
  "action": "create",
  "hypothesis": "The cooling controller will report a fan timeout",
  "expectedSignal": "fan timeout",
  "sourceExpectation": "syslog",
  "confidence": 0.75,
  "horizonMs": 1800000,
  "tags": ["cooling", "rack-07"]
}
```

Tool:

```text
cherry_cognitive_predict
```

### Automatic confirmation

When a new observation enters the cognitive runtime, the prediction engine compares:

- expected signal versus observation summary;
- hypothesis versus observation summary;
- expected source versus actual source.

A weighted semantic score is calculated. Matching evidence can automatically move a pending prediction to `confirmed`.

Automatic matching is intentionally conservative. It does not automatically refute a prediction merely because a different signal was observed. Refutation requires explicit contrary evidence or prediction-horizon expiry.

### Manual resolution

```json
{
  "action": "refute",
  "predictionId": "<prediction-id>",
  "summary": "Storage latency remained below 10ms during the prediction window",
  "evidenceSummaries": [
    "Datastore p95 latency was 8ms",
    "No storage alarm was generated"
  ]
}
```

### Calibration

Confirmed and refuted predictions receive a Brier score:

```text
(confidence - outcome)^2
```

Where:

```text
confirmed outcome = 1
refuted outcome = 0
```

Lower Brier scores indicate better probability calibration.

The engine reports:

- total predictions;
- pending, confirmed, refuted, expired, and cancelled counts;
- resolved count;
- confirmation accuracy;
- mean Brier score.

Accuracy alone is not enough. A system that predicts everything at low confidence can appear accurate while being poorly calibrated. Brier scoring captures confidence quality.

## Attention schema

The attention schema is an explicit model of the current global workspace.

It reports:

- cognitive mode;
- attention capacity;
- occupied slots;
- dominant focus;
- competing signals;
- signals outside the active capacity;
- focus stability;
- switching pressure;
- tunnel-vision risk;
- metacognitive confidence;
- recommended control action.

Tool:

```text
cherry_cognitive_attention
```

### Cognitive modes

#### `idle`

No meaningful workspace item and no active goal.

#### `monitoring`

A stable focus exists with manageable uncertainty and no immediate high-risk condition.

#### `deliberative`

Uncertainty is elevated or several active goals are competing. The agent should compare hypotheses and gather discriminating evidence.

#### `reflex`

The dominant workspace signal exceeds the reflex-risk threshold. The agent should prioritize containment and independent verification, while still respecting approval controls.

### Focus selection

Each workspace candidate is enriched from working memory through its `observationId`.

Selection considers:

```text
salience      28%
risk          28%
novelty       18%
uncertainty   14%
confidence    12%
```

This score is used only for attention ordering. It is not a statement of truth or authorization.

### Stability

Attention stability increases when the top candidate has a clear score advantage over the second candidate.

Low stability means the focus may switch easily. This is useful for identifying indecision or noisy environments.

### Switching pressure

Switching pressure rises when several candidates are close to the dominant score.

High switching pressure recommends holding the current goal long enough to collect decisive evidence rather than repeatedly changing direction.

### Tunnel-vision risk

Tunnel-vision risk rises when selected signals come from:

- one source;
- one modality;
- one dominant repeated stream;
- a highly activated field with little competition.

A high score recommends collecting evidence from another source or modality.

Example:

```text
Prometheus says temperature is critical
+ camera sees a red cooling alarm
+ syslog reports fan timeout
```

This is more reliable than four repeated readings from one temperature sensor.

## Prompt integration

Before an agent turn, Cherry Cognitive can inject:

```text
current self-model
current global workspace
attention schema
pending predictions
semantic memory
source and tool reliability warnings
guarded autonomy proposals
```

The injected blocks are operational state, not hidden chain-of-thought transcripts.

## Persistence

Predictions are stored at:

```text
<openclaw-state-dir>/cherry-cognitive/predictions.json
```

The file is written atomically with mode `0600`.

The attention schema is derived from current state and is not separately persisted.

## Safety rules

- Pending predictions must never be presented as established facts.
- Confirmation should seek independent evidence where possible.
- The agent should search for refuting evidence, not only confirming evidence.
- Expired predictions are unresolved, not automatically false.
- Attention rank does not grant authority to execute a tool.
- Reflex mode does not bypass approval.
- Tunnel-vision warnings should encourage source diversity.
- Prediction calibration should be reviewed over time before enabling broader autonomy.

## Validation

```bash
pnpm test \
  extensions/cherry-cognitive/src/prediction.test.ts \
  extensions/cherry-cognitive/src/attention-schema.test.ts
```
