import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:https";
import type { ProxmoxConfig } from "./config.js";
import { configurationProblems } from "./config.js";

export type ProxmoxGuestType = "qemu" | "lxc";
export type ProxmoxGuestAction = "start" | "shutdown" | "reboot" | "stop";

export type ProxmoxResource = {
  id?: string;
  type?: string;
  node?: string;
  vmid?: number;
  name?: string;
  status?: string;
  template?: number;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  [key: string]: unknown;
};

type RequestInput = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, string | number | boolean | undefined>;
};

type ProxmoxEnvelope<T> = { data: T };

type GuestTarget = {
  vmid: number;
  node: string;
  guestType: ProxmoxGuestType;
  name?: string;
  status?: string;
};

export class ProxmoxApiError extends Error {
  readonly statusCode?: number;
  readonly responseBody?: string;

  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message);
    this.name = "ProxmoxApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

function pathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function ratio(value: unknown, maximum: unknown): number | undefined {
  if (typeof value !== "number" || typeof maximum !== "number" || maximum <= 0) {
    return undefined;
  }
  return Math.round((value / maximum) * 10_000) / 100;
}

function safeResource(resource: ProxmoxResource): Record<string, unknown> {
  return {
    id: resource.id,
    type: resource.type,
    node: resource.node,
    vmid: resource.vmid,
    name: resource.name,
    status: resource.status,
    template: Boolean(resource.template),
    uptime: resource.uptime,
    cpuPercent:
      typeof resource.cpu === "number" ? Math.round(resource.cpu * 10_000) / 100 : undefined,
    maxcpu: resource.maxcpu,
    memoryBytes: resource.mem,
    maxMemoryBytes: resource.maxmem,
    memoryPercent: ratio(resource.mem, resource.maxmem),
    diskBytes: resource.disk,
    maxDiskBytes: resource.maxdisk,
    diskPercent: ratio(resource.disk, resource.maxdisk),
  };
}

export class ProxmoxClient {
  readonly config: ProxmoxConfig;
  private readonly ca?: Buffer;
  private readonly caError?: string;

  constructor(config: ProxmoxConfig) {
    this.config = config;
    if (config.caFile) {
      try {
        this.ca = readFileSync(config.caFile);
      } catch (error) {
        this.caError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  getConfigurationStatus(): { configured: boolean; problems: string[]; endpoint?: string } {
    const problems = configurationProblems(this.config);
    if (this.caError) problems.push(`Unable to read caFile: ${this.caError}`);
    return { configured: problems.length === 0, problems, endpoint: this.config.baseUrl };
  }

  private assertConfigured(): asserts this is this & {
    config: ProxmoxConfig & { baseUrl: string; tokenId: string; tokenSecret: string };
  } {
    const problems = configurationProblems(this.config);
    if (this.caError) problems.push(`Unable to read caFile: ${this.caError}`);
    if (problems.length > 0) {
      throw new Error(`Proxmox plugin is not configured: ${problems.join("; ")}`);
    }
  }

  private assertNodeAllowed(node: string): void {
    if (this.config.allowedNodes.length > 0 && !this.config.allowedNodes.includes(node)) {
      throw new Error(`Proxmox node ${node} is outside allowedNodes`);
    }
  }

  private assertVmidAllowed(vmid: number): void {
    if (this.config.allowedVmids.length > 0 && !this.config.allowedVmids.includes(vmid)) {
      throw new Error(`Proxmox VMID ${vmid} is outside allowedVmids`);
    }
  }

  async request<T>(method: "GET" | "POST", path: string, input: RequestInput = {}): Promise<T> {
    this.assertConfigured();
    const url = new URL(
      `${this.config.baseUrl}/api2/json${path.startsWith("/") ? path : `/${path}`}`,
    );
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const payload = new URLSearchParams();
    for (const [key, value] of Object.entries(input.body ?? {})) {
      if (value !== undefined) payload.set(key, String(value));
    }
    const body = payload.toString();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `PVEAPIToken=${this.config.tokenId}=${this.config.tokenSecret}`,
    };
    if (body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }

    const options: RequestOptions = {
      method,
      headers,
      timeout: this.config.timeoutMs,
    };
    if (url.protocol === "https:") {
      options.rejectUnauthorized = this.config.verifyTls;
      if (this.ca) options.ca = this.ca;
    }

    return await new Promise<T>((resolve, reject) => {
      const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = transport(url, options, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new ProxmoxApiError(
                `Proxmox API returned HTTP ${response.statusCode ?? "unknown"}`,
                response.statusCode,
                text.slice(0, 4_000),
              ),
            );
            return;
          }
          try {
            const parsed = JSON.parse(text) as ProxmoxEnvelope<T>;
            resolve(parsed.data);
          } catch {
            reject(new ProxmoxApiError("Proxmox API returned invalid JSON", response.statusCode));
          }
        });
      });
      request.on("timeout", () => request.destroy(new Error("Proxmox API request timed out")));
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }

  async testConnection(): Promise<Record<string, unknown>> {
    const version = await this.request<Record<string, unknown>>("GET", "/version");
    let clusterStatus: unknown;
    try {
      clusterStatus = await this.request<unknown>("GET", "/cluster/status");
    } catch (error) {
      clusterStatus = {
        unavailable: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      endpoint: this.config.baseUrl,
      verifyTls: this.config.verifyTls,
      allowMutations: this.config.allowMutations,
      version,
      clusterStatus,
    };
  }

  async listResources(
    filters: {
      type?: "all" | "node" | "qemu" | "lxc" | "storage";
      node?: string;
      status?: string;
      includeTemplates?: boolean;
      limit?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const resources = await this.request<ProxmoxResource[]>("GET", "/cluster/resources");
    const type = filters.type ?? "all";
    const filtered = resources.filter((resource) => {
      if (type !== "all" && resource.type !== type) return false;
      if (filters.node && resource.node !== filters.node) return false;
      if (filters.status && resource.status !== filters.status) return false;
      if (!filters.includeTemplates && resource.template) return false;
      if (
        resource.node &&
        this.config.allowedNodes.length > 0 &&
        !this.config.allowedNodes.includes(resource.node)
      ) {
        return false;
      }
      if (
        typeof resource.vmid === "number" &&
        this.config.allowedVmids.length > 0 &&
        !this.config.allowedVmids.includes(resource.vmid)
      ) {
        return false;
      }
      return true;
    });
    const summary = {
      total: filtered.length,
      nodes: filtered.filter((item) => item.type === "node").length,
      qemu: filtered.filter((item) => item.type === "qemu").length,
      lxc: filtered.filter((item) => item.type === "lxc").length,
      runningGuests: filtered.filter(
        (item) => (item.type === "qemu" || item.type === "lxc") && item.status === "running",
      ).length,
      stoppedGuests: filtered.filter(
        (item) => (item.type === "qemu" || item.type === "lxc") && item.status === "stopped",
      ).length,
    };
    const limit = Math.min(filters.limit ?? this.config.maxResults, this.config.maxResults);
    return {
      summary,
      truncated: filtered.length > limit,
      resources: filtered.slice(0, limit).map(safeResource),
    };
  }

  private async resolveGuest(
    vmid: number,
    node?: string,
    guestType?: ProxmoxGuestType,
  ): Promise<GuestTarget> {
    this.assertVmidAllowed(vmid);
    if (node) this.assertNodeAllowed(node);
    const resources = await this.request<ProxmoxResource[]>("GET", "/cluster/resources");
    const match = resources.find(
      (resource) =>
        resource.vmid === vmid &&
        (resource.type === "qemu" || resource.type === "lxc") &&
        (!node || resource.node === node) &&
        (!guestType || resource.type === guestType),
    );
    if (!match || !match.node || (match.type !== "qemu" && match.type !== "lxc")) {
      throw new Error(`Proxmox guest VMID ${vmid} was not found`);
    }
    this.assertNodeAllowed(match.node);
    return {
      vmid,
      node: match.node,
      guestType: match.type,
      name: match.name,
      status: match.status,
    };
  }

  async getGuestStatus(vmid: number, node?: string, guestType?: ProxmoxGuestType) {
    const target = await this.resolveGuest(vmid, node, guestType);
    const status = await this.request<Record<string, unknown>>(
      "GET",
      `/nodes/${pathSegment(target.node)}/${target.guestType}/${target.vmid}/status/current`,
    );
    return { target, status };
  }

  async guestAction(
    vmid: number,
    action: ProxmoxGuestAction,
    node?: string,
    guestType?: ProxmoxGuestType,
  ) {
    if (!this.config.allowMutations) {
      throw new Error(
        "Proxmox mutations are disabled. Set allowMutations=true after applying least-privilege RBAC.",
      );
    }
    const target = await this.resolveGuest(vmid, node, guestType);
    const taskId = await this.request<string>(
      "POST",
      `/nodes/${pathSegment(target.node)}/${target.guestType}/${target.vmid}/status/${action}`,
    );
    return { target, action, taskId };
  }

  async getTaskStatus(node: string, taskId: string) {
    this.assertNodeAllowed(node);
    return await this.request<Record<string, unknown>>(
      "GET",
      `/nodes/${pathSegment(node)}/tasks/${pathSegment(taskId)}/status`,
    );
  }
}
