#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const WINDOWS = process.platform === "win32";
const executable = (name) => (WINDOWS ? `${name}.cmd` : name);

function usage() {
  console.log(`OpenClaw + Cline ACP setup

Usage:
  node scripts/setup-cline-acp.mjs [options]

Options:
  --apply               Validate and write the OpenClaw configuration
  --install-cline       Install the selected Cline npm package globally
  --cline-spec <spec>   npm package spec (default: cline@3.0.46)
  --allow-write         Auto-approve Cline file writes and shell commands
  --make-default        Set Cline as the default ACP harness
  --help                Show this help

Without --apply the script prints the merged config patch and changes nothing.
`);
}

function parseArgs(argv) {
  const options = {
    apply: false,
    installCline: false,
    allowWrite: false,
    makeDefault: false,
    clineSpec: process.env.CLINE_NPM_SPEC || "cline@3.0.46",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--install-cline") options.installCline = true;
    else if (arg === "--allow-write") options.allowWrite = true;
    else if (arg === "--make-default") options.makeDefault = true;
    else if (arg === "--cline-spec") {
      const value = argv[index + 1]?.trim();
      if (!value) throw new Error("--cline-spec requires a package spec");
      options.clineSpec = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function run(command, args, options = {}) {
  const piped = options.capture || options.input !== undefined;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
    input: options.input,
    env: process.env,
  });

  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }

  if (piped && !options.capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.status !== 0 && !options.allowFailure) {
    const detail = piped ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function requireNode22() {
  const major = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node.js 22+ is required; current version is ${process.versions.node}`);
  }
}

function commandAvailable(name) {
  const result = spawnSync(executable(name), ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
    env: process.env,
  });
  return !result.error && result.status === 0;
}

function readJsonConfig(path, fallback) {
  const result = run(executable("openclaw"), ["config", "get", path, "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (result.status !== 0) return fallback;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fallback;
  }
}

function uniqueStrings(values) {
  return [
    ...new Set(
      values
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim()),
    ),
  ];
}

function buildPatch({ existingAllowedAgents, allowWrite, makeDefault }) {
  const acp = {
    enabled: true,
    dispatch: { enabled: true },
    backend: "acpx",
    allowedAgents: uniqueStrings([...existingAllowedAgents, "cline"]),
  };
  if (makeDefault) acp.defaultAgent = "cline";

  return {
    acp,
    plugins: {
      entries: {
        acpx: {
          enabled: true,
          config: {
            agents: {
              cline: {
                command: "cline",
                args: ["--acp"],
              },
            },
            probeAgent: "cline",
            permissionMode: allowWrite ? "approve-all" : "approve-reads",
            nonInteractivePermissions: allowWrite ? "fail" : "deny",
          },
        },
      },
    },
  };
}

function printNextSteps({ allowWrite }) {
  console.log("\nConfiguration complete. Restart the Gateway, then run:");
  console.log("  openclaw gateway restart");
  console.log("  /acp doctor");
  console.log("  /acp spawn cline --bind here");
  if (allowWrite) {
    console.log(
      "\nCline write/exec approval is enabled. Use a dedicated repository workspace or sandbox.",
    );
  } else {
    console.log(
      "\nCline is read-only. Re-run with --allow-write when the isolated workspace is ready.",
    );
  }
}

function main() {
  requireNode22();
  const options = parseArgs(process.argv.slice(2));

  if (!commandAvailable("openclaw")) {
    throw new Error("openclaw CLI was not found in PATH");
  }

  if (options.apply && options.installCline) {
    run(executable("npm"), ["install", "-g", options.clineSpec]);
  }
  if (!commandAvailable("cline")) {
    throw new Error("cline CLI was not found in PATH; use --install-cline or install it first");
  }

  const currentAllowed = readJsonConfig("acp.allowedAgents", []);
  const existingAllowedAgents = Array.isArray(currentAllowed) ? currentAllowed : [];
  const patch = buildPatch({
    existingAllowedAgents,
    allowWrite: options.allowWrite,
    makeDefault: options.makeDefault,
  });
  const patchText = `${JSON.stringify(patch, null, 2)}\n`;

  if (!options.apply) {
    console.log(patchText);
    console.log("Dry run only. Add --apply to validate and write this patch.");
    return;
  }

  // Continue to schema validation if an existing bundled/workspace ACPX plugin
  // reports a non-zero status during package installation.
  run(executable("openclaw"), ["plugins", "install", "@openclaw/acpx"], {
    allowFailure: true,
  });

  run(executable("openclaw"), ["config", "patch", "--stdin", "--dry-run"], {
    input: patchText,
  });
  run(executable("openclaw"), ["config", "patch", "--stdin"], {
    input: patchText,
  });
  run(executable("openclaw"), ["config", "validate"]);
  printNextSteps(options);
}

try {
  main();
} catch (error) {
  console.error(`setup-cline-acp: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
