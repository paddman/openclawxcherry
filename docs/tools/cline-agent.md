---
summary: "Run Cline as an OpenClaw coding agent through ACPX"
read_when:
  - Connecting Cline to OpenClaw
  - Running repository coding tasks from Telegram, Slack, Discord, or WebChat
  - Configuring a custom ACP harness alias
  - Troubleshooting Cline ACP startup or permissions
title: "Cline coding agent"
sidebarTitle: "Cline"
---

# Cline coding agent

OpenClaw can use Cline as an external coding worker through the Agent Client Protocol (ACP).
OpenClaw remains responsible for channels, conversation bindings, sessions, delivery, policy,
and background-task state. Cline owns repository inspection, code edits, commands, tests, and
its model/provider configuration.

```text
Telegram / Slack / Discord / WebChat
                |
                v
        OpenClaw Gateway
   sessions + policy + delivery
                |
             ACPX
                |
          cline --acp
                |
       dedicated Git workspace
```

This integration intentionally does not copy the Cline source tree into OpenClaw. Both projects
can be upgraded independently, while ACP provides a stable process and session boundary.

## Requirements

- Node.js 22 or newer. Node.js 24 is recommended for OpenClaw.
- OpenClaw installed and onboarded.
- Cline CLI installed on the same host as the OpenClaw Gateway.
- Provider authentication configured in Cline.
- A repository directory accessible to the Gateway service account.

The integration was prepared against Cline CLI `3.0.46`, which exposes ACP mode through
`cline --acp`.

## Automated setup

Preview the patch without changing configuration:

```bash
node scripts/setup-cline-acp.mjs
```

Install the pinned Cline CLI and apply a read-only ACP profile:

```bash
node scripts/setup-cline-acp.mjs --apply --install-cline
```

Enable coding operations after preparing a dedicated workspace or sandbox:

```bash
node scripts/setup-cline-acp.mjs \
  --apply \
  --install-cline \
  --allow-write \
  --make-default
```

The setup script:

- preserves existing values in `acp.allowedAgents` and adds `cline`;
- installs/enables the official `@openclaw/acpx` runtime plugin;
- registers the custom ACP alias `cline -> cline --acp`;
- validates the patch before writing it;
- runs `openclaw config validate` after applying it.

Use another Cline package version when required:

```bash
node scripts/setup-cline-acp.mjs \
  --apply \
  --install-cline \
  --cline-spec cline@3.0.46
```

## Manual setup

Install and authenticate Cline first:

```bash
npm install -g cline@3.0.46
cline auth
cline --version
```

Install ACPX:

```bash
openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true
```

Apply the included safe preset:

```bash
openclaw config patch \
  --file ./config/examples/cline-acp.patch.json5 \
  --dry-run

openclaw config patch \
  --file ./config/examples/cline-acp.patch.json5

openclaw config validate
```

Restart the Gateway after changing ACPX plugin configuration:

```bash
openclaw gateway restart
```

## Start a Cline session

From an OpenClaw chat:

```text
/acp doctor
/acp spawn cline --bind here
```

Then send a repository task in the bound conversation, for example:

```text
Inspect the project, run its tests, fix the failing authentication tests,
and summarize every changed file. Do not deploy or push.
```

Useful controls:

```text
/acp status
/acp steer keep the public API compatible and add regression tests
/acp cancel
/acp close
```

For programmatic spawning, use `sessions_spawn` with:

```json
{
  "runtime": "acp",
  "agentId": "cline",
  "task": "Inspect the repository and fix the failing tests"
}
```

Provide the repository working directory through the ACP spawn/session options supported by the
calling surface. The directory must exist and be accessible to the Gateway service account.

## Permission profiles

ACP sessions are non-interactive. Native permission prompts cannot be clicked from a remote chat.
The integration therefore uses one of two profiles:

| Profile | ACPX settings | Result |
| --- | --- | --- |
| Read-only default | `approve-reads` + `deny` | Cline can inspect code but write/exec requests are denied without crashing the session. |
| Coding mode | `approve-all` + `fail` | Cline can edit files and run commands without native prompts. Use only in an isolated workspace. |

Enable coding mode with:

```bash
node scripts/setup-cline-acp.mjs --apply --allow-write
openclaw gateway restart
```

Do not expose coding mode to unrestricted public channels. Use channel pairing/allowlists and a
separate OS account, container, VM, or restricted SSH/OpenShell backend.

## Production layout

Recommended separation:

```text
/opt/openclaw                 OpenClaw installation
/var/lib/openclaw             Gateway state
/srv/cline-workspaces/<repo>  writable checked-out repositories
/var/lib/cline                Cline configuration/state
```

Operational recommendations:

- Run the Gateway under a dedicated non-root account.
- Give that account access only to approved repository directories.
- Do not mount production secrets or deployment keys into general coding workspaces.
- Keep deployment as a separate reviewed workflow.
- Require repository tests and `git diff` review before commit or push.
- Set channel allowlists and DM pairing before enabling write access.
- Keep `pluginToolsMcpBridge` and `openClawToolsMcpBridge` disabled unless Cline genuinely needs them.

## Upgrade policy

Upgrade the two systems independently:

```bash
npm install -g openclaw@latest
npm install -g cline@latest
openclaw doctor
openclaw config validate
```

After a Cline upgrade, verify ACP startup before enabling write access:

```bash
cline --acp
```

The command should start an ACP stdio process and wait for a client. Stop it with `Ctrl+C`, then run:

```text
/acp doctor
```

Pin `--cline-spec` in production and test upgrades in a non-production Gateway first.

## Troubleshooting

### `/acp doctor` cannot find `cline`

Confirm the executable is visible to the Gateway service account, not only your login shell:

```bash
command -v cline
sudo -u <gateway-user> env PATH="$PATH" cline --version
```

Use an absolute path when the daemon has a restricted `PATH`:

```bash
openclaw config set \
  plugins.entries.acpx.config.agents.cline.command \
  "/absolute/path/to/cline"
```

### Cline starts but cannot edit files

The read-only profile is active. Use `--allow-write` only after the workspace is isolated:

```bash
node scripts/setup-cline-acp.mjs --apply --allow-write
openclaw gateway restart
```

### Cline reports missing provider authentication

Run Cline authentication as the same OS account that runs the Gateway. Cline owns its own provider
credentials; OpenClaw model credentials are not automatically transferred to the external harness.

### Session starts in the wrong directory

Close the session and spawn a new one with the correct workspace directory through the calling
surface. Do not point Cline at the OpenClaw installation or Gateway state directory.

### Roll back the integration

Disable dispatch and remove the custom alias:

```bash
openclaw config set acp.dispatch.enabled false --strict-json
openclaw config unset plugins.entries.acpx.config.agents.cline
openclaw config unset plugins.entries.acpx.config.probeAgent
openclaw config validate
openclaw gateway restart
```

Remove `cline` from `acp.allowedAgents` only after checking whether other automation depends on it.
Uninstall Cline separately when it is no longer used.

## Related

- [ACP agents](/tools/acp-agents)
- [ACP agents — setup](/tools/acp-agents-setup)
- [Sandboxing](/gateway/sandboxing)
- [Security](/gateway/security)
