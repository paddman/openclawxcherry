import { describe, expect, it } from "vitest";
import { VmwareClient, type CommandRunner } from "./client.js";
import type { VmwareConfig } from "./config.js";

const baseConfig: VmwareConfig = {
  baseUrl: "https://vcenter.example.com",
  username: "svc-openclaw@vsphere.local",
  password: "secret",
  govcPath: "govc",
  verifyTls: true,
  timeoutMs: 10_000,
  allowMutations: false,
  allowedVmPaths: ["/DC01/vm/Managed"],
  allowedHostPaths: ["/DC01/host/Cluster01"],
  maxResults: 100,
};

function runner(
  handler: (args: string[]) => { stdout: string; stderr?: string; exitCode?: number },
): CommandRunner {
  return async (_command, args, options) => {
    expect(options.env.GOVC_URL).toBe(baseConfig.baseUrl);
    expect(options.env.GOVC_USERNAME).toBe(baseConfig.username);
    expect(options.env.GOVC_PASSWORD).toBe(baseConfig.password);
    const response = handler(args);
    return {
      stdout: response.stdout,
      stderr: response.stderr ?? "",
      exitCode: response.exitCode ?? 0,
    };
  };
}

describe("VmwareClient", () => {
  it("reports vSphere 6.x compatibility from govc about", async () => {
    const client = new VmwareClient(
      baseConfig,
      runner((args) =>
        args[0] === "about"
          ? {
              stdout: JSON.stringify({
                About: {
                  Name: "VMware vCenter Server",
                  Version: "6.7.0",
                  ApiVersion: "6.7.3",
                  Build: "12345",
                },
              }),
            }
          : { stdout: "govc 0.52.0" },
      ),
    );
    const connection = await client.testConnection();
    expect(connection.supportedMajorRange).toBe(true);
    expect(connection.apiVersion).toBe("6.7.3");
  });

  it("filters VM inventory through allowedVmPaths", async () => {
    const client = new VmwareClient(
      baseConfig,
      runner(() => ({
        stdout: "/DC01/vm/Managed/app01\n/DC01/vm/Other/db01\n/DC01/vm/Managed/app02\n",
      })),
    );
    const data = await client.listVirtualMachines();
    expect(data.virtualMachines.map((vm) => vm.name)).toEqual(["app01", "app02"]);
  });

  it("blocks power changes by default", async () => {
    const client = new VmwareClient(baseConfig, runner(() => ({ stdout: "" })));
    await expect(client.powerAction("/DC01/vm/Managed/app01", "start")).rejects.toThrow(
      "mutations are disabled",
    );
  });
});
