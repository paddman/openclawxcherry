import { describe, expect, it } from "vitest";
import { LinuxSshClient, type CommandRunner } from "./client.js";
import type { LinuxSshConfig } from "./config.js";

const baseConfig: LinuxSshConfig = {
  sshPath: "ssh",
  timeoutMs: 10_000,
  maxOutputBytes: 1_000_000,
  allowMutations: false,
  hosts: [
    {
      id: "web-01",
      hostname: "192.0.2.10",
      port: 22,
      username: "openclaw",
      identityFile: "/keys/id_ed25519",
      knownHostsFile: "/keys/known_hosts",
      strictHostKeyChecking: "yes",
      sudo: true,
      allowedServices: ["nginx.service"],
    },
  ],
};

function runner(output: string): CommandRunner {
  return async (command, args) => {
    expect(command).toBe("ssh");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("openclaw@192.0.2.10");
    return { stdout: output, stderr: "", exitCode: 0 };
  };
}

describe("LinuxSshClient", () => {
  it("parses connection information", async () => {
    const client = new LinuxSshClient(
      baseConfig,
      runner("hostname=web-01\nkernel=Linux 6.8\nuser=openclaw\n"),
    );
    const data = await client.testConnection("web-01");
    expect(data).toMatchObject({ hostname: "web-01", user: "openclaw" });
  });

  it("rejects services outside the allowlist", async () => {
    const client = new LinuxSshClient(baseConfig, runner(""));
    await expect(client.serviceStatus("web-01", "sshd.service")).rejects.toThrow(
      "outside allowedServices",
    );
  });

  it("blocks service changes by default", async () => {
    const client = new LinuxSshClient(baseConfig, runner(""));
    await expect(client.serviceAction("web-01", "nginx.service", "restart")).rejects.toThrow(
      "mutations are disabled",
    );
  });
});
