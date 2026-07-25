import {
  registerInfrastructureProvider,
  type InfrastructureOperation,
  type InfrastructurePatchSummary,
  type InfrastructureProvider,
  type InfrastructureResource,
} from "../infrastructure-control/runtime-api.js";
import type { WindowsServerClient, WindowsServiceAction } from "./src/client.js";
import type { WindowsHostConfig, WindowsServerConfig } from "./src/config.js";

function stringValue(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function booleanValue(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hostById(config: WindowsServerConfig, hostId: string): WindowsHostConfig {
  const host = config.hosts.find((entry) => entry.id === hostId);
  if (!host) throw new Error(`Unknown Windows host id: ${hostId}`);
  return host;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function dateUptimeSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((Date.now() - timestamp) / 1000)) : undefined;
}

export class WindowsPatchOperations {
  constructor(
    private readonly client: WindowsServerClient,
    private readonly config: WindowsServerConfig,
  ) {}

  async inventory(query?: string): Promise<InfrastructureResource[]> {
    const selected = this.config.hosts.filter((host) => {
      if (!query) return true;
      const needle = query.toLowerCase();
      return host.id.toLowerCase().includes(needle) || host.hostname.toLowerCase().includes(needle);
    });
    const settled = await Promise.allSettled(
      selected.map(async (host) => {
        const response = await this.client.systemStatus(host.id);
        const details = objectValue(response.details);
        const totalKb = numberValue(details.TotalVisibleMemoryKB);
        const freeKb = numberValue(details.FreePhysicalMemoryKB);
        const usedKb = totalKb === undefined || freeKb === undefined ? undefined : totalKb - freeKb;
        const disks = Array.isArray(details.Disks) ? details.Disks.map(objectValue) : [];
        const diskTotal = disks.reduce((sum, disk) => sum + (numberValue(disk.Size) ?? 0), 0);
        const diskFree = disks.reduce((sum, disk) => sum + (numberValue(disk.FreeSpace) ?? 0), 0);
        const stopped = Array.isArray(details.StoppedAutomaticServices)
          ? details.StoppedAutomaticServices.length
          : 0;
        return {
          providerId: "windows",
          providerKind: "windows",
          id: host.id,
          kind: "host",
          name: typeof details.ComputerName === "string" ? details.ComputerName : host.hostname,
          status: stopped > 0 ? "warning" : "online",
          address: host.hostname,
          memoryUsedBytes: usedKb === undefined ? undefined : usedKb * 1024,
          memoryTotalBytes: totalKb === undefined ? undefined : totalKb * 1024,
          memoryPercent:
            usedKb === undefined || totalKb === undefined || totalKb <= 0
              ? undefined
              : Math.round((usedKb / totalKb) * 10_000) / 100,
          diskUsedBytes: diskTotal > 0 ? diskTotal - diskFree : undefined,
          diskTotalBytes: diskTotal > 0 ? diskTotal : undefined,
          diskPercent:
            diskTotal > 0 ? Math.round(((diskTotal - diskFree) / diskTotal) * 10_000) / 100 : undefined,
          uptimeSeconds: dateUptimeSeconds(details.LastBootUpTime),
          metadata: {
            caption: details.Caption,
            version: details.Version,
            buildNumber: details.BuildNumber,
            domain: details.Domain,
            pendingReboot: details.PendingReboot,
            stoppedAutomaticServices: stopped,
          },
          observedAt: new Date().toISOString(),
        } satisfies InfrastructureResource;
      }),
    );
    return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  }

  async patchScan(targetId?: string): Promise<InfrastructurePatchSummary[]> {
    const hosts = targetId ? [hostById(this.config, targetId)] : this.config.hosts;
    const settled = await Promise.allSettled(
      hosts.map(async (host) => {
        const details = objectValue(
          await this.remote(
            host.id,
            `
$session = New-Object -ComObject Microsoft.Update.Session
$session.ClientApplicationID = 'OpenClaw Infrastructure Control'
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("IsInstalled=0 and IsHidden=0")
$updates = @(
  for ($index = 0; $index -lt $result.Updates.Count; $index++) {
    $update = $result.Updates.Item($index)
    [pscustomobject]@{
      Title = $update.Title
      KBArticleIDs = @($update.KBArticleIDs)
      MsrcSeverity = $update.MsrcSeverity
      Type = $update.Type
      RebootRequired = $update.RebootRequired
    }
  }
)
[pscustomobject]@{
  AvailableUpdates = $updates.Count
  SecurityUpdates = @($updates | Where-Object { $_.MsrcSeverity -or $_.Title -match 'Security' }).Count
  RebootRequired = [bool](@($updates | Where-Object RebootRequired).Count)
  Updates = $updates
} | ConvertTo-Json -Compress -Depth 6`,
          ),
        );
        return {
          providerId: "windows",
          providerKind: "windows",
          targetId: host.id,
          targetName: host.hostname,
          availableUpdates: numberValue(details.AvailableUpdates) ?? 0,
          securityUpdates: numberValue(details.SecurityUpdates),
          rebootRequired:
            typeof details.RebootRequired === "boolean" ? details.RebootRequired : undefined,
          packageManager: "Windows Update Agent",
          details: details.Updates,
          observedAt: new Date().toISOString(),
        } satisfies InfrastructurePatchSummary;
      }),
    );
    return settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const host = hosts[index] as WindowsHostConfig;
      return {
        providerId: "windows",
        providerKind: "windows",
        targetId: host.id,
        targetName: host.hostname,
        availableUpdates: 0,
        packageManager: "Windows Update Agent",
        details: { error: result.reason instanceof Error ? result.reason.message : String(result.reason) },
        observedAt: new Date().toISOString(),
      };
    });
  }

  async applyPatch(hostId: string, input: Record<string, unknown>) {
    if (!this.config.allowMutations) {
      throw new Error("Windows mutations are disabled; set allowMutations to true");
    }
    hostById(this.config, hostId);
    const securityOnly = booleanValue(input.securityOnly, "securityOnly") ?? true;
    const includeDrivers = booleanValue(input.includeDrivers, "includeDrivers") ?? false;
    const reboot = booleanValue(input.reboot, "reboot") ?? false;
    const criteria = includeDrivers
      ? "IsInstalled=0 and IsHidden=0"
      : "IsInstalled=0 and IsHidden=0 and Type='Software'";
    const securityFilter = securityOnly
      ? "$selected = @($selected | Where-Object { $_.MsrcSeverity -or $_.Title -match 'Security' })"
      : "";
    return {
      hostId,
      securityOnly,
      includeDrivers,
      reboot,
      details: await this.remote(
        hostId,
        `
$session = New-Object -ComObject Microsoft.Update.Session
$session.ClientApplicationID = 'OpenClaw Infrastructure Control'
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search(${JSON.stringify(criteria)})
$selected = @(
  for ($index = 0; $index -lt $result.Updates.Count; $index++) {
    $result.Updates.Item($index)
  }
)
${securityFilter}
$collection = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($update in $selected) {
  if (-not $update.EulaAccepted) { $update.AcceptEula() }
  [void]$collection.Add($update)
}
if ($collection.Count -eq 0) {
  [pscustomobject]@{ Installed = 0; RebootRequired = $false; ResultCode = 2 } |
    ConvertTo-Json -Compress
  return
}
$downloader = $session.CreateUpdateDownloader()
$downloader.Updates = $collection
$downloadResult = $downloader.Download()
$installer = $session.CreateUpdateInstaller()
$installer.Updates = $collection
$installResult = $installer.Install()
$payload = [pscustomobject]@{
  Installed = $collection.Count
  DownloadResultCode = [int]$downloadResult.ResultCode
  ResultCode = [int]$installResult.ResultCode
  RebootRequired = [bool]$installResult.RebootRequired
}
$payload | ConvertTo-Json -Compress
${reboot ? "if ($installResult.RebootRequired) { Restart-Computer -Force }" : ""}`,
      ),
    };
  }

  async execute(operation: InfrastructureOperation) {
    const input = operation.parameters ?? {};
    if (operation.action.startsWith("service.")) {
      const action = operation.action.slice("service.".length);
      if (action === "start" || action === "stop" || action === "restart") {
        const service = stringValue(input.service, "service", true) ?? "";
        return await this.client.serviceAction(
          operation.targetId,
          service,
          action as WindowsServiceAction,
        );
      }
    }
    if (operation.action === "patch.apply") return await this.applyPatch(operation.targetId, input);
    throw new Error(`Unsupported Windows infrastructure action: ${operation.action}`);
  }

  private async remote(hostId: string, script: string): Promise<unknown> {
    const runtimeClient = this.client as unknown as {
      run: (hostId: string, script: string) => Promise<unknown>;
    };
    return await runtimeClient.run(hostId, script);
  }
}

export function createWindowsInfrastructureProvider(
  operations: WindowsPatchOperations,
): InfrastructureProvider {
  return {
    id: "windows",
    kind: "windows",
    actions: ["service.start", "service.stop", "service.restart", "patch.apply"],
    queries: [],
    async inventory(query) {
      return await operations.inventory(query);
    },
    async monitor() {
      return await operations.inventory();
    },
    async patchScan(targetId) {
      return await operations.patchScan(targetId);
    },
    async execute(operation) {
      return await operations.execute(operation);
    },
    rollbackFor(operation) {
      const inverse: Record<string, string> = {
        "service.start": "service.stop",
        "service.stop": "service.start",
      };
      const action = inverse[operation.action];
      return action ? { ...operation, action } : undefined;
    },
  };
}

export function registerWindowsInfrastructureProvider(
  operations: WindowsPatchOperations,
): () => void {
  return registerInfrastructureProvider(createWindowsInfrastructureProvider(operations));
}
