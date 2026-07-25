import { describe, expect, it } from "vitest";
import { WindowsServerClient, type CommandRunner } from "./client.js";
import type { WindowsServerConfig } from "./config.js";

const baseConfig: WindowsServerConfig = {
  sshPath: "ssh",
  powershellPath: "pwsh",
  timeoutMs: 10_000,
  maxOutputBytes: 1_000_000,
  allowMutations: false,
  hosts: [
    {
      id: "ad-01",
      hostname: "192.0.2.20",
      transport: "ssh",
      username: "openclaw-admin",
      port: 22,
      identityFile: "/keys/windows_ed25519",
      knownHostsFile: "/keys/known_hosts",
      strictHostKeyChecking: "yes",
      useSsl: true,
      authentication: "Negotiate",
      allowedServices: ["DNS"],
    },
  ],
};

function runner(output: unknown): CommandRunner {
  return async (command, args) => {
    expect(command).toBe("ssh");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("openclaw-admin@192.0.2.20");
    expect(args.at(-1)).toContain("powershell.exe");
    expect(args.at(-1)).toContain("-EncodedCommand");
    return { stdout: JSON.stringify(output), stderr: "", exitCode: 0 };
  };
}

describe("WindowsServerClient", () => {
  it("uses SSH PowerShell remoting from a cross-platform gateway", async () => {
    const client = new WindowsServerClient(
      baseConfig,
      runner({ ComputerName: "AD01", Caption: "Windows Server 2022" }),
    );
    const connection = await client.testConnection("ad-01");
    expect(connection.transport).toBe("ssh");
    expect(connection.details).toEqual({
      ComputerName: "AD01",
      Caption: "Windows Server 2022",
    });
  });

  it("rejects services outside the allowlist", async () => {
    const client = new WindowsServerClient(baseConfig, runner({}));
    await expect(client.serviceStatus("ad-01", "NTDS")).rejects.toThrow(
      "outside allowedServices",
    );
  });

  it("blocks service changes by default", async () => {
    const client = new WindowsServerClient(baseConfig, runner({}));
    await expect(client.serviceAction("ad-01", "DNS", "restart")).rejects.toThrow(
      "mutations are disabled",
    );
  });
});
