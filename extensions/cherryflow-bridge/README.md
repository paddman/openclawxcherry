# CherryFlow Agent Bridge

This OpenClaw plugin exposes a small authenticated HTTP API for CherryFlow workflow nodes.

## Responsibility split

- CherryFlow owns workflow graphs, retries, approvals, versions, files, and audit history.
- OpenClaw owns agent sessions, tools, memory, model execution, and messaging channels.
- The bridge only converts a validated CherryFlow agent request into an OpenClaw subagent run.

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

## Configure

Set a long random token in the Gateway environment:

```bash
export CHERRYFLOW_BRIDGE_TOKEN="replace-with-a-long-random-token"
```

Enable and configure the plugin in `openclaw.json`:

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

Restart the Gateway after enabling the plugin:

```bash
openclaw gateway restart
openclaw plugins inspect cherryflow-bridge --runtime --json
```

Configure CherryFlow with the same token:

```env
CHERRYFLOW_AI_PROVIDER=openclaw
OPENCLAW_BRIDGE_URL=http://127.0.0.1:18789
OPENCLAW_API_TOKEN=replace-with-a-long-random-token
OPENCLAW_AGENT_ID=cherryflow-agent
```

Use the actual Gateway origin for `OPENCLAW_BRIDGE_URL`. The bridge routes are served by the OpenClaw Gateway; the plugin does not start a second HTTP server.

## Test the bridge

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
- Agent ids are validated and can be restricted with `allowedAgentIds`.
- Request bodies and prompts have hard size limits.
- Concurrent runs are capped.
- Reusing an idempotency key with different request data returns HTTP `409`.
- CherryFlow context is clearly delimited and labelled as untrusted workflow data.
- The bridge never enables tools itself. Tool allowlists, sandboxing, and approval policy remain part of the selected OpenClaw agent configuration.

For write or destructive operations, use a separate agent with a narrow tool allowlist and let CherryFlow require human approval before it reaches the bridge node.

## Current limitations

- Run state is stored in Gateway memory and is lost when the Gateway restarts.
- Completion uses CherryFlow polling rather than callbacks.
- Cancellation is not exposed because the current trusted subagent runtime does not provide a bridge-safe abort method.
- The response extracts the final assistant text from the session transcript; structured agent output should be returned as JSON text and validated by the CherryFlow workflow node.
