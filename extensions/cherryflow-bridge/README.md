# CherryFlow Agent Runtime API

This is the built-in HTTP ingress for **OpenClawXCherry**, the agent execution runtime created for CherryFlow.

It is not an optional third-party integration between two unrelated products. CherryFlow is the workflow control plane; OpenClawXCherry is the runtime that executes CherryFlow agent nodes, tools, sessions, local models, and approved infrastructure actions.

The plugin id remains `cherryflow-bridge` because it implements the explicit network boundary between the CherryFlow control plane and its OpenClawXCherry runtime.

## Responsibility split

- CherryFlow owns workflow graphs, retries, approvals, versions, files, tenants, and audit history.
- OpenClawXCherry owns agent sessions, tools, memory, model execution, host operations, and messaging channels.
- This API converts a validated CherryFlow agent-node request into an OpenClawXCherry subagent run.

## Endpoints

```text
POST /api/agents/run
GET  /api/agents/runs/:runId
GET  /api/agents/health
```

Every request must include:

```http
x-openclaw-token: <shared token>
```

## Configure OpenClawXCherry

Set a long random token in the Gateway environment:

```bash
export CHERRYFLOW_BRIDGE_TOKEN="replace-with-a-long-random-token"
```

Enable and configure the runtime API in `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "cherryflow-bridge": {
        enabled: true,
        config: {
          tokenEnv: "CHERRYFLOW_BRIDGE_TOKEN",
          allowedAgentIds: ["cherryflow-agent", "linux-doctor"],
          maxConcurrentRuns: 4,
          maxBodyBytes: 1048576,
          defaultTimeoutMs: 55000,
          maxTimeoutMs: 600000,
          runTtlMs: 3600000,
          retainSessions: true
        }
      }
    }
  }
}
```

Restart the OpenClawXCherry Gateway after enabling the API:

```bash
openclaw gateway restart
openclaw plugins inspect cherryflow-bridge --runtime --json
```

The `openclaw` command and internal package names are retained for upstream compatibility. The deployed product role is OpenClawXCherry: CherryFlow's agent runtime.

## Configure CherryFlow

```env
CHERRYFLOW_AI_PROVIDER=openclaw
OPENCLAW_BRIDGE_URL=http://127.0.0.1:18789
OPENCLAW_API_TOKEN=replace-with-a-long-random-token
OPENCLAW_AGENT_ID=cherryflow-agent
```

Use the actual OpenClawXCherry Gateway origin for `OPENCLAW_BRIDGE_URL`. The API is served by the Gateway and does not start a second HTTP server.

## Test the runtime

Health:

```bash
curl http://127.0.0.1:18789/api/agents/health \
  -H "x-openclaw-token: $CHERRYFLOW_BRIDGE_TOKEN"
```

Create an agent run:

```bash
curl -X POST http://127.0.0.1:18789/api/agents/run \
  -H "content-type: application/json" \
  -H "x-openclaw-token: $CHERRYFLOW_BRIDGE_TOKEN" \
  -d '{
    "agentId": "linux-doctor",
    "prompt": "Inspect the supplied host and return a concise diagnosis.",
    "context": {
      "host": "server-01",
      "workflowRunId": "workflow-run-123",
      "nodeRunId": "node-run-456",
      "riskLevel": "read"
    },
    "idempotencyKey": "workflow-run-123-diagnose-attempt-1",
    "timeoutMs": 55000
  }'
```

The create endpoint returns HTTP `202`:

```json
{
  "runId": "cfrun_...",
  "status": "running",
  "createdAt": "2026-07-04T00:00:00.000Z",
  "startedAt": "2026-07-04T00:00:00.001Z"
}
```

Poll the run:

```bash
curl http://127.0.0.1:18789/api/agents/runs/cfrun_... \
  -H "x-openclaw-token: $CHERRYFLOW_BRIDGE_TOKEN"
```

Terminal response:

```json
{
  "runId": "cfrun_...",
  "status": "completed",
  "output": {
    "text": "The host is healthy."
  },
  "createdAt": "2026-07-04T00:00:00.000Z",
  "startedAt": "2026-07-04T00:00:00.001Z",
  "completedAt": "2026-07-04T00:00:04.200Z"
}
```

## Security behavior

- Requests use a dedicated shared token and constant-time token comparison.
- Agent IDs are validated and can be restricted with `allowedAgentIds`.
- Request bodies and prompts have hard size limits.
- Concurrent runs are capped.
- Reusing an idempotency key with different request data returns HTTP `409`.
- CherryFlow context is delimited and labelled as untrusted workflow data.
- The API never grants tools itself. Sandboxing and tool allowlists belong to the selected OpenClawXCherry agent.
- Human approval belongs to CherryFlow and must occur before a write-capable runtime node executes.

For write or destructive operations, use a separate runtime agent with a narrow tool allowlist. Do not reuse a broad conversational agent for infrastructure changes.

## Current limitations

- Run state is stored in Gateway memory and is lost when the Gateway restarts.
- Completion uses CherryFlow polling rather than callbacks.
- Cancellation is not exposed because the trusted subagent runtime does not yet provide a bridge-safe abort method.
- The API currently extracts final assistant text from the session transcript. Structured output should be returned as JSON text and validated by CherryFlow.
