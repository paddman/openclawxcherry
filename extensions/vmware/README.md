# VMware vSphere integration

This optional OpenClaw extension connects to vCenter Server or a standalone ESXi host through the `govc` CLI from the official VMware `govmomi` project.

## Compatibility

- VMware vSphere / ESXi 6.x through 9.x.
- vCenter and direct ESXi connections.
- Uses the vSphere Web Services API through `govc`, which avoids depending only on REST endpoints that were introduced after vSphere 6.0.
- No agent is installed inside ESXi or guest VMs.

Install `govc` on the OpenClaw Gateway host and verify it is available in `PATH`, or configure `govcPath`.

## Capabilities

- Test connectivity and report product, build, API, and `govc` versions.
- List VMs with name and power-state filters.
- Read detailed VM status.
- Read recent vSphere tasks.
- Start, gracefully shut down, reboot, reset, power off, or suspend a VM when mutations are enabled.

## Security defaults

- `allowMutations` is `false`.
- Every power action requires OpenClaw human approval.
- TLS verification is enabled by default.
- `allowedVmPaths` can restrict inventory and actions to specific folders or VM paths.
- Credentials are passed to `govc` through child-process environment variables and are not returned by tools.

Use a dedicated vSphere service account. Start with the built-in Read-Only role at the narrowest inventory scope. Add only the virtual-machine interaction privileges required for power operations.

## Configuration

Prefer environment variables:

```bash
export VMWARE_BASE_URL='https://vcenter.example.com'
export VMWARE_USERNAME='openclaw@vsphere.local'
export VMWARE_PASSWORD='replace-with-secret'
export VMWARE_CA_FILE='/etc/openclaw/vsphere-ca.pem' # optional
export VMWARE_DATACENTER='DC01'                     # optional
```

Optional plugin configuration:

```json
{
  "plugins": {
    "entries": {
      "vmware": {
        "enabled": true,
        "config": {
          "verifyTls": true,
          "allowMutations": false,
          "allowedVmPaths": [
            "/DC01/vm/Production/Managed-by-Cherry"
          ],
          "maxResults": 200
        }
      }
    }
  }
}
```

Enable and restart:

```bash
pnpm install
pnpm openclaw plugins enable vmware
pnpm openclaw gateway restart
```

## Tools

- `vmware_connection_test`
- `vmware_virtual_machines`
- `vmware_vm_status`
- `vmware_vm_power`
- `vmware_recent_tasks`

Recommended first prompt:

```text
Test the VMware connection, show the vSphere API version, then list powered-on VMs. Do not perform any power action.
```
