import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ProxmoxClient } from "./client.js";
import type { ProxmoxConfig } from "./config.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

function config(baseUrl: string, overrides: Partial<ProxmoxConfig> = {}): ProxmoxConfig {
  return {
    baseUrl,
    tokenId: "openclaw@pve!agent",
    tokenSecret: "test-secret",
    verifyTls: true,
    timeoutMs: 5_000,
    allowMutations: false,
    allowedNodes: [],
    allowedVmids: [],
    maxResults: 200,
    ...overrides,
  };
}

async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("ProxmoxClient", () => {
  it("sends the Proxmox API token without exposing it in the result", async () => {
    let authorization = "";
    const baseUrl = await listen((request, response) => {
      authorization = request.headers.authorization ?? "";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { version: "9.0" } }));
    });
    const client = new ProxmoxClient(config(baseUrl));
    const version = await client.request<Record<string, unknown>>("GET", "/version");
    expect(authorization).toBe("PVEAPIToken=openclaw@pve!agent=test-secret");
    expect(version).toEqual({ version: "9.0" });
    expect(JSON.stringify(version)).not.toContain("test-secret");
  });

  it("keeps mutation operations disabled by default", async () => {
    const client = new ProxmoxClient(config("http://127.0.0.1:9"));
    await expect(client.guestAction(100, "start")).rejects.toThrow("mutations are disabled");
  });

  it("filters cluster resources by node and VMID allowlists", async () => {
    const baseUrl = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            { id: "node/pve01", type: "node", node: "pve01", status: "online" },
            {
              id: "qemu/100",
              type: "qemu",
              node: "pve01",
              vmid: 100,
              name: "allowed",
              status: "running",
            },
            {
              id: "qemu/200",
              type: "qemu",
              node: "pve02",
              vmid: 200,
              name: "hidden",
              status: "running",
            },
          ],
        }),
      );
    });
    const client = new ProxmoxClient(
      config(baseUrl, { allowedNodes: ["pve01"], allowedVmids: [100] }),
    );
    const result = await client.listResources();
    expect(result.resources).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("hidden");
  });
});
