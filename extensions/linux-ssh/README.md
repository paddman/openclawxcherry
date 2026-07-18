# Linux SSH integration

This optional OpenClaw extension manages Linux servers through the system OpenSSH client on the OpenClaw Gateway host. Nothing is installed on the target except the SSH server that Linux systems normally already use.

## Capabilities

- List configured targets.
- Test key-based SSH connectivity.
- Read OS, kernel, uptime, load, memory, root filesystem, and failed-unit status.
- Read systemd service state.
- Read bounded service logs from `journalctl`.
- Start, stop, restart, or reload explicitly allowed services.

## Security defaults

- Password authentication is not supported. Use an SSH key or an existing `ssh-agent`.
- `BatchMode=yes` prevents interactive password prompts.
- Host-key verification defaults to `yes`.
- `allowMutations` defaults to `false`.
- Service actions require both a non-empty per-host `allowedServices` list and OpenClaw human approval.
- No arbitrary shell-command tool is exposed.

Use a dedicated Linux account. Grant only the minimum `sudo` commands required, for example selected `systemctl` units rather than unrestricted root access.

## Configuration

```json
{
  "plugins": {
    "entries": {
      "linux-ssh": {
        "enabled": true,
        "config": {
          "allowMutations": false,
          "hosts": [
            {
              "id": "web-01",
              "hostname": "172.29.29.101",
              "port": 22,
              "username": "openclaw",
              "identityFile": "/etc/openclaw/keys/linux_ed25519",
              "knownHostsFile": "/etc/openclaw/ssh_known_hosts",
              "strictHostKeyChecking": "yes",
              "sudo": true,
              "allowedServices": ["nginx.service", "docker.service"]
            }
          ]
        }
      }
    }
  }
}
```

A single host can also be configured with environment variables:

```bash
export LINUX_HOST_ID='web-01'
export LINUX_HOSTNAME='172.29.29.101'
export LINUX_USERNAME='openclaw'
export LINUX_IDENTITY_FILE='/etc/openclaw/keys/linux_ed25519'
export LINUX_KNOWN_HOSTS_FILE='/etc/openclaw/ssh_known_hosts'
export LINUX_ALLOWED_SERVICES='nginx.service,docker.service'
```

Enable and restart:

```bash
pnpm install
pnpm openclaw plugins enable linux-ssh
pnpm openclaw gateway restart
```

## Tools

- `linux_hosts`
- `linux_connection_test`
- `linux_system_status`
- `linux_service_status`
- `linux_service_logs`
- `linux_service_action`

Recommended first prompt:

```text
Test Linux host web-01, summarize CPU/load, memory, disk, and failed services, then show nginx status. Do not restart anything.
```
