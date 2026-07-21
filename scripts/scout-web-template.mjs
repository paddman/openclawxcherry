#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    query: "nextjs shadcn admin dashboard template",
    limit: 8,
    json: false,
    importBest: false,
    target: null,
    root: process.env.WEB_FACTORY_ROOT || process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) fail(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--query": args.query = next(); break;
      case "--limit": args.limit = Number(next()); break;
      case "--json": args.json = true; break;
      case "--import-best": args.importBest = true; break;
      case "--target": args.target = next(); break;
      case "--root": args.root = next(); break;
      case "--help": printHelp(); process.exit(0);
      default: fail(`unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20) fail("--limit must be 1-20");
  if (args.importBest && !args.target) fail("--import-best requires --target");
  return args;
}

function printHelp() {
  console.log(`Find strong open-source web templates and optionally import the best candidate.

Usage:
  node scripts/scout-web-template.mjs [options]

Options:
  --query <text>       GitHub search text
  --limit <1-20>       Number of candidates to evaluate (default: 8)
  --json               Emit JSON
  --import-best        Import the highest-scoring safe candidate
  --target <path>      Destination used with --import-best
  --root <path>        Allowed import workspace root

Environment:
  GITHUB_TOKEN         Optional token to increase GitHub API limits
`);
}

function headers() {
  const result = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openclaw-web-template-scout",
  };
  if (process.env.GITHUB_TOKEN) result.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return result;
}

async function githubJson(url, optional = false) {
  const response = await fetch(url, { headers: headers() });
  if (optional && response.status === 404) return null;
  if (!response.ok) fail(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

function daysSince(dateString) {
  return Math.max(0, (Date.now() - new Date(dateString).getTime()) / 86_400_000);
}

function scoreCandidate(repo, readme, packageJson) {
  let score = 0;
  const reasons = [];
  const warnings = [];
  const text = `${repo.name} ${repo.description || ""} ${readme || ""}`.toLowerCase();
  const dependencies = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  const scripts = packageJson?.scripts || {};
  const license = repo.license?.spdx_id || "UNKNOWN";
  const allowedLicenses = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"]);

  if (allowedLicenses.has(license)) {
    score += 18;
    reasons.push(`approved license: ${license}`);
  } else {
    warnings.push(`license not approved: ${license}`);
  }

  const popularity = Math.min(15, Math.log10((repo.stargazers_count || 0) + 1) * 5);
  score += popularity;
  if (repo.stargazers_count) reasons.push(`${repo.stargazers_count} stars`);

  const age = daysSince(repo.pushed_at);
  const freshness = age <= 30 ? 12 : age <= 90 ? 10 : age <= 180 ? 8 : age <= 365 ? 5 : 1;
  score += freshness;
  reasons.push(`updated ${Math.round(age)} days ago`);

  const visualSignals = [
    ["shadcn", 10], ["tailwind", 6], ["responsive", 5], ["dark mode", 3],
    ["dashboard", 5], ["screenshot", 4], ["demo", 4], ["theme", 3],
    ["chart", 3], ["sidebar", 2], ["mobile", 3],
  ];
  for (const [keyword, points] of visualSignals) {
    if (text.includes(keyword)) score += points;
  }

  if (dependencies.next) { score += 6; reasons.push("Next.js"); }
  if (dependencies.react) score += 3;
  if (dependencies["@tanstack/react-table"]) score += 3;
  if (dependencies.recharts) score += 3;
  if (dependencies.zod) score += 2;
  if (scripts.build) score += 4; else warnings.push("no build script");
  if (scripts.lint || scripts.check) score += 3;
  if (scripts.test) score += 3; else warnings.push("no test script");

  const lifecycle = ["preinstall", "install", "postinstall"].filter((name) => scripts[name]);
  if (lifecycle.length) {
    score -= 20;
    warnings.push(`lifecycle scripts: ${lifecycle.join(", ")}`);
  }
  if (repo.archived) {
    score -= 50;
    warnings.push("archived repository");
  }
  if (repo.fork) score -= 5;

  return {
    score: Math.max(0, Math.round(score * 10) / 10),
    reasons,
    warnings,
    safeToImport: allowedLicenses.has(license) && !repo.archived && lifecycle.length === 0,
    license,
  };
}

async function inspectRepository(repo) {
  const base = `https://api.github.com/repos/${repo.full_name}`;
  const [readmeData, packageData] = await Promise.all([
    githubJson(`${base}/readme`, true),
    githubJson(`${base}/contents/package.json`, true),
  ]);
  const decode = (payload) => payload?.content ? Buffer.from(payload.content, "base64").toString("utf8") : "";
  const readme = decode(readmeData).slice(0, 80_000);
  let packageJson = null;
  try {
    const raw = decode(packageData);
    packageJson = raw ? JSON.parse(raw) : null;
  } catch {
    // Invalid package metadata lowers confidence but does not crash discovery.
  }

  const evaluation = scoreCandidate(repo, readme, packageJson);
  return {
    repository: repo.full_name,
    url: repo.html_url,
    description: repo.description,
    stars: repo.stargazers_count,
    pushedAt: repo.pushed_at,
    defaultBranch: repo.default_branch,
    ...evaluation,
  };
}

const args = parseArgs(process.argv.slice(2));
const query = encodeURIComponent(`${args.query} archived:false fork:false`);
const search = await githubJson(`https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=${Math.min(30, args.limit * 2)}`);
const candidates = [];
for (const repo of search.items.slice(0, args.limit)) candidates.push(await inspectRepository(repo));
candidates.sort((a, b) => b.score - a.score);

if (args.json) console.log(JSON.stringify(candidates, null, 2));
else {
  for (const [index, item] of candidates.entries()) {
    console.log(`${index + 1}. ${item.repository} — ${item.score}/100 — ${item.license}`);
    console.log(`   ${item.description || "No description"}`);
    if (item.reasons.length) console.log(`   + ${item.reasons.join("; ")}`);
    if (item.warnings.length) console.log(`   ! ${item.warnings.join("; ")}`);
  }
}

if (args.importBest) {
  const best = candidates.find((item) => item.safeToImport);
  if (!best) fail("no candidate passed the safe import gate");
  const result = spawnSync(process.execPath, [
    resolve(scriptDir, "import-web-template.mjs"),
    "--template", best.repository,
    "--ref", best.defaultBranch,
    "--target", args.target,
    "--root", args.root,
  ], { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
