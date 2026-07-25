# Windows Server integration

This optional OpenClaw extension runs fixed PowerShell diagnostics and service operations on Windows Server.

## Transports

### SSH — recommended for a Linux OpenClaw Gateway

The Gateway uses the system `ssh` client and executes an encoded Windows PowerShell command remotely. Configure OpenSSH Server on Windows and use key authentication. This works without WinRM support on the Gateway host.

### WinRM — when the OpenClaw Gateway runs on Windows

The Gateway uses local Windows PowerShell remoting. WinRM is supported between Windows systems. The password is read from a named environment variable and is not stored in the plugin configuration.

`auto` chooses WinRM on a Windows Gateway when `passwordEnv` is configured; otherwise it chooses SSH.

## Capabilities

- Test connectivity and report Windows edition, version, build, PowerShell version, and remote identity.
- Read uptime, memory, CPU, disks, domain, pending reboot, and stopped automatic services.
- Read service status and startup configuration.
- Read bounded Windows event logs.
- Start, stop, or restart explicitly allowed services.

## Security defaults

- `allowMutations` is `false`.
- Every service action requires OpenClaw human approval.
- Service mutations require a non-empty per-host `allowedServices` list.
- SSH uses `BatchMode=yes` and strict host-key checking by default.
- WinRM passwords are read only from `passwordEnv`.
- No arbitrary PowerShell tool is exposed.

Use a dedicated account or JEA endpoint where possible. Prefer WinRM HTTPS or SSH key authentication. Avoid WinRM Basic over unencrypted HTTP.

## SSH configuration example

```json
{
  "plugins": {
    "entries": {
      "windows-server": {
        "enabled": true,
        "config": {
          "allowMutations": false,
          "hosts": [
            {
              "id": "ad-01",
              "hostname": "172.29.29.20",
              "transport": "ssh",
              "port": 22,
              "username": "openclaw-admin",
              "identityFile": "/etc/openclaw/keys/windows_ed25519",
              "knownHostsFile": "/etc/openclaw/ssh_known_hosts",
              "strictHostKeyChecking": "yes",
              "allowedServices": ["NTDS", "DNS"]
            }
          ]
        }
      }
    }
  }
}
```

## WinRM configuration example

Run the Gateway on Windows and set the secret:

```powershell
$env:OPENCLAW_AD01_PASSWORD = 'replace-with-secret'
```

```json
{
  "plugins": {
    "entries": {
      "windows-server": {
        "enabled": true,
        "config": {
          "hosts": [
            {
              "id": "ad-01",
              "hostname": "ad01.example.local",
              "transport": "winrm",
              "username": "EXAMPLE\\openclaw-admin",
              "port": 5986,
              "useSsl": true,
              "passwordEnv": "OPENCLAW_AD01_PASSWORD",
              "authentication": "Negotiate",
              "allowedServices": ["NTDS", "DNS"]
            }
          ]
        }
      }
    }
  }
}
```

Enable and restart:

```bash
pnpm install
pnpm openclaw plugins enable windows-server
pnpm openclaw gateway restart
```

## Tools

- `windows_hosts`
- `windows_connection_test`
- `windows_system_status`
- `windows_service_status`
- `windows_event_logs`
- `windows_service_action`

Recommended first prompt:

```text
Test Windows host ad-01, summarize OS/build, uptime, memory, disk, pending reboot, and stopped automatic services. Do not restart anything.
```
