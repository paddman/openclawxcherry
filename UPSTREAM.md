# Upstream Policy

OpenClawXCherry is the CherryFlow agent execution runtime. It uses OpenClaw as its technical foundation but has a different product purpose.

## Product intent

- **CherryFlow is the product and workflow control plane.**
- **OpenClawXCherry is a runtime component created for CherryFlow.**
- Upstream compatibility is valuable only when it helps CherryFlow execute agents, tools, channels, local models, and infrastructure operations reliably.

OpenClawXCherry should not drift into an independent general-purpose personal assistant product.

## What remains compatible

Keep upstream-compatible identifiers when changing them would create unnecessary maintenance cost:

- `openclaw` CLI command
- Internal package/import names
- Gateway protocol and plugin SDK contracts
- Existing channel, model, tool, sandbox, session, and agent behavior
- MIT license and third-party attribution

These compatibility identifiers do not define the product identity. The product identity is OpenClawXCherry: the CherryFlow Agent Runtime.

## Cherry-owned layer

Prefer CherryFlow-specific work in isolated paths:

```text
extensions/cherryflow-bridge/
extensions/cherry-*/
skills/cherry-*/
docs/cherryflow-*/
```

Avoid scattering CherryFlow behavior through upstream core unless the plugin or SDK surfaces cannot support the requirement.

## Sync strategy

Recommended remotes:

```bash
git remote add upstream https://github.com/openclaw/openclaw.git
git remote -v
```

Recommended sync branch:

```bash
git checkout -b sync/openclaw-YYYYMMDD main
git fetch upstream
git merge upstream/main
```

Resolve conflicts with these priorities:

1. Preserve CherryFlow runtime API contracts.
2. Preserve CherryFlow security and approval boundaries.
3. Preserve CherryFlow agent/session trace fields.
4. Accept upstream implementation improvements where they do not change CherryFlow behavior.
5. Keep Cherry-specific code isolated so future merges stay reviewable.

Never merge upstream directly into production without running the CherryFlow integration tests.

## Required integration checks

Before accepting an upstream sync, verify:

- Gateway starts with `cherryflow-bridge` enabled.
- `GET /api/agents/health` succeeds with the configured token.
- `POST /api/agents/run` starts an allowlisted agent.
- Idempotent duplicate requests return the same bridge run.
- Conflicting idempotency requests are rejected.
- CherryFlow can poll a run to `completed` or `failed`.
- Read-only agents cannot execute write tools.
- Approval-required CherryFlow nodes do not reach the runtime without approval.
- LINE delivery still works for workflow outputs.

## Attribution

OpenClawXCherry is based on OpenClaw. Keep `LICENSE`, `THIRD_PARTY_NOTICES.md`, upstream copyright notices, and applicable dependency attribution intact.
