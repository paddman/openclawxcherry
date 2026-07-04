# OpenClawXCherry

**The agent execution runtime built for CherryFlow.**

OpenClawXCherry exists to execute CherryFlow workflow agent nodes safely and locally. It is not positioned as a separate general-purpose assistant product. CherryFlow is the product and workflow control plane; OpenClawXCherry is its agent runtime, tool layer, channel gateway, and local execution engine.

> CherryFlow decides **what should happen and when**.  
> OpenClawXCherry performs **agent reasoning and approved actions**.

## System relationship

```text
User / LINE / Web / API / Schedule
                 |
                 v
            CherryFlow
  workflow graph · state · retry · approval
  versioning · files · audit · human tasks
                 |
                 v
          OpenClawXCherry
   agents · sessions · memory · tools
 local models · host actions · channels
                 |
                 v
       Infrastructure / Services
```

Repositories:

- CherryFlow: <https://github.com/paddman/CherryFlow>
- OpenClawXCherry: <https://github.com/paddman/openclawxcherry>

## Product boundary

### CherryFlow owns

- Workflow definitions and visual DAGs
- Workflow and node run state
- Retry, timeout, resume, and scheduling
- Human approval and policy state
- Forms, files, artifacts, and generated reports
- Workflow versions and publishing
- Organization, tenant, and user authorization
- Audit history and operational dashboards

### OpenClawXCherry owns

- Agent execution and delegation
- Agent sessions and scoped memory
- Model routing and local inference
- Tool invocation and host/device operations
- Sandboxing and agent-specific tool allowlists
- LINE and other messaging-channel delivery
- Infrastructure skills and runbooks
- The CherryFlow Agent Runtime HTTP API

### Rule

Do not duplicate CherryFlow workflow-engine responsibilities inside OpenClawXCherry. Do not move unrestricted host tools or long-lived conversational state into CherryFlow workers.

## CherryFlow Agent Runtime API

The bundled `cherryflow-bridge` plugin exposes the explicit contract used by CherryFlow's `agent.openclaw` workflow node:

```http
POST /api/agents/run
GET  /api/agents/runs/:runId
GET  /api/agents/health
```

Requests authenticate with:

```http
x-openclaw-token: <shared token>
```

Example request:

```json
{
  "agentId": "linux-doctor",
  "prompt": "Inspect the supplied host and return a concise diagnosis.",
  "context": {
    "workflowRunId": "workflow-run-123",
    "nodeRunId": "node-run-456",
    "host": "server-01",
    "riskLevel": "read"
  },
  "idempotencyKey": "workflow-run-123-diagnose-attempt-1",
  "timeoutMs": 55000
}
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

## Quick setup

### 1. Configure OpenClawXCherry

Set a long random shared token in the Gateway environment:

```bash
export CHERRYFLOW_BRIDGE_TOKEN="replace-with-a-long-random-token"
```

Enable the runtime API in `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "cherryflow-bridge": {
        enabled: true,
        config: {
          tokenEnv: "CHERRYFLOW_BRIDGE_TOKEN",
          allowedAgentIds: [
            "cherryflow-agent",
            "linux-doctor"
          ],
          maxConcurrentRuns: 4,
          defaultTimeoutMs: 55000,
          maxTimeoutMs: 600000,
          retainSessions: true
        }
      }
    }
  }
}
```

The CLI and internal package names remain `openclaw` where upstream compatibility requires them:

```bash
openclaw gateway restart
openclaw plugins inspect cherryflow-bridge --runtime --json
```

### 2. Configure CherryFlow

```env
CHERRYFLOW_AI_PROVIDER=openclaw
OPENCLAW_BRIDGE_URL=http://OPENCLAWXCHERRY_HOST:18789
OPENCLAW_API_TOKEN=replace-with-a-long-random-token
OPENCLAW_AGENT_ID=cherryflow-agent
```

### 3. Verify

```bash
curl http://OPENCLAWXCHERRY_HOST:18789/api/agents/health \
  -H "x-openclaw-token: $CHERRYFLOW_BRIDGE_TOKEN"
```

See [`extensions/cherryflow-bridge/README.md`](extensions/cherryflow-bridge/README.md) for complete API and curl examples.

## Recommended workflow pattern

```text
Grafana or service alert
  -> CherryFlow collects metrics
  -> OpenClawXCherry diagnosis agent (read-only)
  -> CherryFlow human approval
  -> OpenClawXCherry remediation agent (restricted write tools)
  -> CherryFlow verifies service health
  -> OpenClawXCherry sends LINE result
  -> CherryFlow closes and audits the incident
```

Keep diagnosis and remediation as separate agents. The diagnosis agent should be read-only. The remediation agent should have a narrow allowlist and should only run after CherryFlow approval.

## Initial runtime agents

Recommended first agents:

- `cherryflow-agent` — general workflow agent with low-risk tools
- `linux-doctor` — Linux diagnostics and structured root-cause summaries
- `docker-doctor` — container status, logs, health, and recovery plans
- `model-doctor` — vLLM, Ollama, GPU, and Ascend NPU diagnostics
- `proxmox-operator` — Proxmox read operations and approved changes
- `storage-doctor` — NFS, NVMe/TCP, iSCSI, multipath, capacity, and latency
- `report-delivery` — sends CherryFlow outputs to LINE or other channels

## Security model

- CherryFlow approval is the workflow-level authorization gate.
- OpenClawXCherry agent configuration is the execution-level permission boundary.
- Agent IDs should be explicitly allowlisted in the bridge configuration.
- Read and write operations should use separate agents and tool policies.
- The bridge does not grant tools and cannot widen an agent's tool permissions.
- Workflow context is treated as untrusted data, not as privileged system instructions.
- Use sandboxing for agents that process public or multi-user input.
- Keep the Gateway private; expose it through a trusted reverse proxy or private network only.

## Development direction

Priority order:

1. Reliable CherryFlow runtime API
2. Structured JSON agent outputs and schema validation
3. Durable agent-run state and trace correlation
4. Approval verification and scoped execution credentials
5. Ops skill packs for Linux, Docker, AI inference, Proxmox, storage, and networking
6. Callback/event completion instead of polling
7. LINE delivery and incident interaction cards
8. Multi-tenant runtime isolation

## Upstream foundation

OpenClawXCherry is built on the OpenClaw codebase and retains upstream CLI/package identifiers where changing them would break compatibility. Upstream attribution, license terms, and third-party notices remain in this repository.

See [`UPSTREAM.md`](UPSTREAM.md) for the fork policy and sync rules.
