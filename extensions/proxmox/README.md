# Proxmox VE integration

This optional OpenClaw extension connects an agent to the Proxmox VE REST API by using an API token. It intentionally exposes a small allowlisted tool surface instead of an arbitrary API-path tool.

## Capabilities

- Test API connectivity and read the Proxmox version.
- List permitted cluster nodes, QEMU VMs, LXC containers, and storage.
- Read live guest status by VMID.
- Start, gracefully shut down, reboot, or force-stop a guest when mutations are explicitly enabled.
- Poll the UPID task returned by a power action.
- Restrict visibility and actions by node and VMID.
- Require OpenClaw human approval for every power action.

## Security defaults

- `allowMutations` is `false`.
- TLS certificate verification is enabled.
- The token secret is never returned by tools or written to logs.
- No tool accepts an arbitrary Proxmox API path.
- `allowedNodes` and `allowedVmids` can limit the blast radius.

Use a dedicated Proxmox user and API token. For read-only inventory, assign only an audit role such as `PVEAuditor` at the narrowest required path. Add VM power-management privileges only when power actions are required.

## Configure

Prefer environment variables so the token secret does not live in the OpenClaw configuration file:

```bash
export PROXMOX_BASE_URL='https://pve.example.com:8006'
export PROXMOX_TOKEN_ID='openclaw@pve!agent'
export PROXMOX_TOKEN_SECRET='replace-with-token-secret'
export PROXMOX_CA_FILE='/etc/openclaw/proxmox-ca.pem' # optional for a private CA
```

Enable the plugin:

```bash
pnpm install
pnpm openclaw plugins enable proxmox
```

Optional OpenClaw configuration:

```json
{
  "plugins": {
    "entries": {
      "proxmox": {
        "enabled": true,
        "config": {
          "verifyTls": true,
          "allowMutations": false,
          "allowedNodes": ["pve01", "pve02"],
          "allowedVmids": [100, 101, 200],
          "maxResults": 200
        }
      }
    }
  }
}
```

For a lab using the default self-signed certificate, importing the Proxmox CA with `PROXMOX_CA_FILE` is preferred. `verifyTls: false` is supported for temporary testing but is not recommended for production.

Restart the OpenClaw Gateway after changing plugin configuration or environment variables.

## Agent tools

### `proxmox_connection_test`

Verifies API-token authentication and returns Proxmox version and cluster status when permitted.

### `proxmox_cluster_resources`

Lists compact resource and utilization data. Filters include resource type, node, status, template inclusion, and result limit.

### `proxmox_guest_status`

Resolves a VMID to its node and guest type, then returns `/status/current`.

### `proxmox_guest_action`

Supports `start`, `shutdown`, `reboot`, and `stop`. It is blocked unless `allowMutations` is enabled and every call enters the OpenClaw approval flow.

### `proxmox_task_status`

Polls the Proxmox task UPID returned by a power action.

## Validate

```bash
pnpm test extensions/proxmox/src/client.test.ts
```

Recommended first test from an agent:

```text
Use proxmox_connection_test, then list all Proxmox nodes and running guests. Do not perform any power action.
```
