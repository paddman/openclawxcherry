# Infrastructure Control

This optional OpenClaw extension coordinates the Proxmox, VMware, Linux SSH, and Windows Server connectors.

## Capabilities

- Unified inventory search across every registered provider.
- Normalized monitoring for status, CPU, memory, disk, and uptime.
- Threshold-based warning and critical alerts.
- Optional scheduled monitoring with static administrator-configured webhooks.
- Linux and Windows patch scans and approved patch execution.
- Bulk operations with bounded concurrency and stop-on-error behavior.
- Persisted change plans with rollback coverage analysis.
- Approval-gated execution and rollback.
- Append-only JSONL audit records for plans, operations, alerts, patches, and monitoring.

## Safety defaults

- `allowMutations` defaults to `false`.
- All plan execution, bulk execution, patching, and rollback tools require human approval.
- Operations use fixed provider action names. There is no arbitrary shell, PowerShell, VMware, or Proxmox API-path operation.
- Bulk concurrency is bounded by the configured `maxConcurrency`.
- Webhook destinations are configured by administrators, not supplied to tools.
- Plans and audit logs are stored with owner-only filesystem permissions.

## Configuration

```json
{
  "plugins": {
    "entries": {
      "infrastructure-control": {
        "enabled": true,
        "config": {
          "allowMutations": false,
          "stateDir": "~/.openclaw/infrastructure-control",
          "maxConcurrency": 5,
          "monitoringIntervalSeconds": 300,
          "alertCooldownMinutes": 30,
          "thresholds": {
            "cpuWarningPercent": 80,
            "cpuCriticalPercent": 95,
            "memoryWarningPercent": 80,
            "memoryCriticalPercent": 95,
            "diskWarningPercent": 85,
            "diskCriticalPercent": 95
          },
          "alertWebhooks": [
            {
              "id": "noc",
              "url": "https://alerts.example.com/openclaw",
              "tokenEnv": "INFRA_ALERT_TOKEN",
              "minimumSeverity": "warning"
            }
          ]
        }
      }
    }
  }
}
```

Enable the infrastructure connector plugins and this control plugin:

```bash
pnpm install
pnpm openclaw plugins enable proxmox
pnpm openclaw plugins enable vmware
pnpm openclaw plugins enable linux-ssh
pnpm openclaw plugins enable windows-server
pnpm openclaw plugins enable infrastructure-control
pnpm openclaw gateway restart
```

## Tools

- `infra_providers`
- `infra_provider_query`
- `infra_inventory_search`
- `infra_monitoring_scan`
- `infra_patch_scan`
- `infra_patch_apply`
- `infra_change_plan_create`
- `infra_change_plan_get`
- `infra_change_plan_execute`
- `infra_bulk_plan`
- `infra_bulk_execute`
- `infra_rollback`
- `infra_audit_log`

Recommended first prompt:

```text
List every registered infrastructure provider, search the unified inventory for production web servers, and run a monitoring scan without sending alerts.
```

## Fixed provider operations

Use `infra_change_plan_create` or `infra_bulk_plan` with the following fixed action names.

### Proxmox

- `guest.start`, `guest.shutdown`, `guest.reboot`, `guest.stop`
- `guest.clone`, `guest.migrate`, `guest.resize`
- `snapshot.create`, `snapshot.delete`, `snapshot.rollback`
- `backup.create`

Read-only queries: `snapshot.list`, `backup.list`, `cluster.health`.

### VMware

- `vm.start`, `vm.shutdown`, `vm.reboot`, `vm.reset`, `vm.stop`, `vm.suspend`
- `vm.clone`, `vm.migrate`, `vm.resize`
- `snapshot.create`, `snapshot.remove`, `snapshot.revert`
- `host.maintenance.enter`, `host.maintenance.exit`

Read-only queries: `snapshot.list`, `inventory.hosts`, `inventory.datastores`, and `inventory.networks`.

### Linux and Windows

- Linux services: `service.start`, `service.stop`, `service.restart`, `service.reload`
- Windows services: `service.start`, `service.stop`, `service.restart`
- Patch management: `patch.apply`

Use `infra_providers` to inspect the action and query catalog registered at runtime.
