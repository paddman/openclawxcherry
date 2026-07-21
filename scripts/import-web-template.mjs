#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(scriptDir, "../config/web-factory/template-catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    template: catalog.defaultTemplate,
    target: null,
    root: process.env.WEB_FACTORY_ROOT || process.cwd(),
    name: null,
    ref: null,
    force: false,
    install: false,
    build: false,
    initGit: false,
    allowLifecycleScripts: false,
    allowUnknownLicense: false,
    unsafeTarget: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) fail(`${arg} requires a value`);
      return value;
    };

    switch (arg) {
      case "--template": args.template = next(); break;
      case "--target": args.target = next(); break;
      case "--root": args.root = next(); break;
      case "--name": args.name = next(); break;
      case "--ref": args.ref = next(); break;
      case "--force": args.force = true; break;
      case "--install": args.install = true; break;
      case "--build": args.build = true; args.install = true; break;
      case "--init-git": args.initGit = true; break;
      case "--allow-lifecycle-scripts": args.allowLifecycleScripts = true; break;
      case "--allow-unknown-license": args.allowUnknownLicense = true; break;
      case "--unsafe-target": args.unsafeTarget = true; break;
      case "--help": printHelp(); process.exit(0);
      default: fail(`unknown option: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Import a reviewed web template into an isolated project directory.

Usage:
  node scripts/import-web-template.mjs --target <path> [options]

Options:
  --template <catalog-id|owner/repo|github-url>  Template source (default: studio-admin)
  --target <path>                               Destination directory (required)
  --root <path>                                 Allowed workspace root (default: cwd)
  --name <package-name>                         New package name
  --ref <branch|tag|sha>                        Override source ref
  --install                                     Run npm ci --ignore-scripts
  --build                                       Install and run npm run build
  --init-git                                    Initialize a fresh Git repository
  --force                                       Replace an existing target directory
  --allow-lifecycle-scripts                     Permit package lifecycle scripts
  --allow-unknown-license                       Permit a source without an approved license
  --unsafe-target                               Allow a target outside --root
`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stderr || result.stdout || ""}` : "";
    fail(`${command} ${commandArgs.join(" ")} exited with ${result.status}${details}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function normalizeSource(templateArg) {
  const curated = catalog.templates.find((item) => item.id === templateArg);
  if (curated) return { ...curated, curated: true };

  let repository = templateArg;
  if (repository.startsWith("https://github.com/")) {
    repository = repository.slice("https://github.com/".length).replace(/\.git$/, "").replace(/\/$/, "");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail(`invalid template source: ${templateArg}`);
  }
  return {
    id: repository.replace("/", "-"),
    name: repository,
    repository,
    cloneUrl: `https://github.com/${repository}.git`,
    ref: "main",
    license: null,
    curated: false,
  };
}

function assertSafeTarget(target, root, unsafeTarget) {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolvedTarget);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (outside && !unsafeTarget) {
    fail(`target must be inside workspace root ${resolvedRoot}; pass --unsafe-target to override`);
  }
  if (resolvedTarget === resolvedRoot) fail("target cannot be the workspace root itself");
  return resolvedTarget;
}

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.name === ".git") continue;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) fail(`symbolic link rejected: ${relative(root, full)}`);
      if (entry.isDirectory()) stack.push(full);
      else files.push(full);
    }
  }
  return files;
}

function detectLicense(sourceDir, source) {
  if (source.license) return source.license;
  const names = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];
  for (const name of names) {
    const path = join(sourceDir, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").slice(0, 600).toLowerCase();
    if (text.includes("mit license")) return "MIT";
    if (text.includes("apache license") && text.includes("version 2.0")) return "Apache-2.0";
    if (text.includes("isc license")) return "ISC";
    if (text.includes("redistribution and use in source and binary forms")) return "BSD";
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

function inspectPackage(sourceDir, allowLifecycleScripts) {
  const packagePath = join(sourceDir, "package.json");
  if (!existsSync(packagePath)) return { packageManager: null, warnings: ["No package.json found"] };

  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const scripts = pkg.scripts || {};
  const lifecycle = ["preinstall", "install", "postinstall"].filter((name) => scripts[name]);
  if (lifecycle.length && !allowLifecycleScripts) {
    fail(`unsafe package lifecycle scripts found: ${lifecycle.join(", ")}`);
  }

  const suspicious = [];
  const pattern = /(curl|wget)\s+[^\n|;]+\|\s*(sh|bash)|powershell\s+-enc|base64\s+(-d|--decode)|nc\s+-e|\/dev\/tcp\//i;
  for (const [name, value] of Object.entries(scripts)) {
    if (pattern.test(String(value))) suspicious.push(`${name}: ${value}`);
  }
  if (suspicious.length) fail(`suspicious package script found: ${suspicious.join(" | ")}`);

  return {
    packageManager: existsSync(join(sourceDir, "pnpm-lock.yaml")) ? "pnpm"
      : existsSync(join(sourceDir, "yarn.lock")) ? "yarn"
      : existsSync(join(sourceDir, "package-lock.json")) ? "npm"
      : null,
    packageName: pkg.name || null,
    lifecycleScripts: lifecycle,
    warnings: scripts.prepare ? ["prepare script exists; imports install with --ignore-scripts by default"] : [],
  };
}

function securityScan(sourceDir) {
  const files = walk(sourceDir);
  const rejectedExtensions = new Set([".exe", ".dll", ".dylib", ".so", ".bat", ".cmd", ".scr", ".apk"]);
  const secretNames = /(^|\/)(\.env($|\.)|id_rsa|id_ed25519|.*\.(pem|p12|pfx|key))$/i;
  const privateKey = /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/;
  let scannedBytes = 0;

  for (const file of files) {
    const rel = relative(sourceDir, file).replaceAll("\\", "/");
    const ext = rel.includes(".") ? `.${rel.split(".").pop().toLowerCase()}` : "";
    if (rejectedExtensions.has(ext)) fail(`executable or native binary rejected: ${rel}`);
    if (secretNames.test(rel) && !/\.env\.example$/i.test(rel)) fail(`secret-like file rejected: ${rel}`);

    const stat = lstatSync(file);
    if (stat.size > 2_000_000 || scannedBytes > 25_000_000) continue;
    scannedBytes += stat.size;
    try {
      const text = readFileSync(file, "utf8");
      if (privateKey.test(text)) fail(`private key material rejected: ${rel}`);
    } catch {
      // Binary assets are allowed unless their extension is explicitly rejected.
    }
  }

  return { filesScanned: files.length, bytesScanned: scannedBytes };
}

function sanitizeImportedTree(sourceDir) {
  const removals = [
    ".git",
    ".github",
    ".vercel",
    "vercel.json",
    ".env",
    ".env.local",
    ".env.development.local",
    ".env.production.local",
    "node_modules",
    ".next",
    "dist",
    "build",
  ];
  for (const name of removals) rmSync(join(sourceDir, name), { recursive: true, force: true });
}

function rewritePackageName(sourceDir, packageName) {
  if (!packageName) return;
  const packagePath = join(sourceDir, "package.json");
  if (!existsSync(packagePath)) return;
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  pkg.name = packageName;
  pkg.version = "0.1.0";
  pkg.private = true;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.target) fail("--target is required");
if (Number(process.versions.node.split(".")[0]) < 22) fail("Node.js 22 or newer is required");

const source = normalizeSource(args.template);
const target = assertSafeTarget(args.target, args.root, args.unsafeTarget);
const sourceRef = args.ref || source.ref || "main";
const projectName = args.name || basename(target).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");

if (existsSync(target)) {
  if (!args.force) fail(`target already exists: ${target}; pass --force to replace it`);
  rmSync(target, { recursive: true, force: true });
}

const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-web-template-"));
const checkout = join(tempRoot, "source");

try {
  console.log(`Cloning ${source.repository}@${sourceRef}...`);
  const cloneArgs = ["clone", "--depth", "1", "--filter=blob:none"];
  if (sourceRef && !/^[0-9a-f]{40}$/i.test(sourceRef)) cloneArgs.push("--branch", sourceRef);
  cloneArgs.push(source.cloneUrl, checkout);
  run("git", cloneArgs);

  if (/^[0-9a-f]{40}$/i.test(sourceRef)) {
    run("git", ["fetch", "--depth", "1", "origin", sourceRef], { cwd: checkout });
    run("git", ["checkout", "--detach", sourceRef], { cwd: checkout });
  }

  const resolvedCommit = run("git", ["rev-parse", "HEAD"], { cwd: checkout, capture: true });
  const license = detectLicense(checkout, source);
  const allowed = new Set(catalog.allowedLicenses);
  const licenseAllowed = allowed.has(license) || (license === "BSD" && [...allowed].some((item) => item.startsWith("BSD-")));
  if (!licenseAllowed && !args.allowUnknownLicense) {
    fail(`license ${license} is not in the approved list: ${catalog.allowedLicenses.join(", ")}`);
  }

  const packageInspection = inspectPackage(checkout, args.allowLifecycleScripts);
  const scan = securityScan(checkout);
  sanitizeImportedTree(checkout);
  rewritePackageName(checkout, projectName);

  const manifest = {
    importedAt: new Date().toISOString(),
    sourceRepository: source.repository,
    sourceRef,
    resolvedCommit,
    sourceLicense: license,
    curatedTemplateId: source.curated ? source.id : null,
    projectName,
    security: {
      installScriptsExecuted: false,
      filesScanned: scan.filesScanned,
      bytesScanned: scan.bytesScanned,
      lifecycleScripts: packageInspection.lifecycleScripts,
      warnings: packageInspection.warnings,
    },
  };

  writeFileSync(join(checkout, ".web-factory-origin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(checkout, "THIRD_PARTY_TEMPLATE.md"), `# Third-party template attribution\n\n- Source: https://github.com/${source.repository}\n- Imported ref: ${sourceRef}\n- Resolved commit: ${resolvedCommit}\n- License: ${license}\n- Imported: ${manifest.importedAt}\n\nThe original license file is preserved. Product branding, content, assets, and business logic must be replaced before release.\n`);

  renameSync(checkout, target);

  if (args.install) {
    if (packageInspection.packageManager !== "npm") {
      fail(`automatic install currently supports npm lockfiles only; detected ${packageInspection.packageManager || "none"}`);
    }
    const installArgs = ["ci"];
    if (!args.allowLifecycleScripts) installArgs.push("--ignore-scripts");
    run("npm", installArgs, { cwd: target });
  }

  if (args.build) run("npm", ["run", "build"], { cwd: target });

  if (args.initGit) {
    run("git", ["init", "-b", "main"], { cwd: target });
    run("git", ["add", "."], { cwd: target });
    run("git", ["commit", "-m", `chore: import ${source.id} web template`], { cwd: target });
  }

  console.log(JSON.stringify({
    status: "imported",
    target,
    source: source.repository,
    ref: sourceRef,
    commit: resolvedCommit,
    license,
    installed: args.install,
    built: args.build,
  }, null, 2));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
