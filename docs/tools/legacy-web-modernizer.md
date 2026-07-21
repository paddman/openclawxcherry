---
summary: "Modernize an old website from a screenshot, URL, or repository with a curated frontend template and Cline"
read_when:
  - Rebuilding an old website with a modern interface
  - Importing an open-source frontend template safely
  - Running website modernization from LINE
  - Creating a preview before merge or deployment
title: "Legacy website modernizer"
sidebarTitle: "Website modernizer"
---

# Legacy website modernizer

OpenClaw can turn a screenshot, URL, or existing source repository into a redesigned web application. OpenClaw coordinates source capture, template selection, policy, tasks, and delivery. Cline performs bounded coding work inside an isolated workspace.

```text
Screenshot / URL / repository
            |
            v
     OpenClaw modernizer
 inventory + migration contract
            |
            v
 reviewed Golden Template
            |
            v
        Cline ACP
 implementation + tests + build
            |
            v
 preview + before/after + pull request
```

## Curated default

The initial Golden Template is `studio-admin`, imported from `arhamkhnz/next-shadcn-admin-dashboard`. It is intended for admin portals, infrastructure consoles, internal tools, and operational dashboards. The catalog records its source, license, stack, categories, and verification date.

The template is a visual and structural foundation, not finished product code. Remove demo content and upstream branding, then rebuild the page model around the target system.

## Find candidate templates

Use the scout when the curated default does not fit:

```bash
node scripts/scout-web-template.mjs \
  --query "nextjs shadcn infrastructure dashboard" \
  --limit 8
```

The scout scores license, freshness, popularity, stack, screenshots/demo signals, responsive signals, build tooling, and risky lifecycle scripts. Its score is a shortlist signal only. Review a live demo or screenshots before selecting the final visual foundation.

Import the highest safe candidate automatically:

```bash
node scripts/scout-web-template.mjs \
  --query "nextjs shadcn infrastructure dashboard" \
  --limit 8 \
  --import-best \
  --root /workspace/web-factory \
  --target /workspace/web-factory/WEB-001
```

Set `GITHUB_TOKEN` to avoid low unauthenticated GitHub API limits.

## Import the curated template

```bash
mkdir -p /workspace/web-factory

node scripts/import-web-template.mjs \
  --template studio-admin \
  --root /workspace/web-factory \
  --target /workspace/web-factory/WEB-001 \
  --name capacity-modern \
  --init-git
```

Optional validation:

```bash
node scripts/import-web-template.mjs \
  --template studio-admin \
  --root /workspace/web-factory \
  --target /workspace/web-factory/WEB-001 \
  --name capacity-modern \
  --install \
  --build \
  --init-git
```

Installation runs with `npm ci --ignore-scripts` unless lifecycle scripts are explicitly allowed. Do not enable lifecycle scripts for an unreviewed repository.

## What the importer enforces

- destination must remain under the configured workspace root;
- an approved open-source license is required by default;
- symlinks, secret-like files, private keys, and native executables are rejected;
- suspicious package scripts are rejected;
- upstream Git metadata, workflows, generated output, local environment files, and deployment metadata are removed;
- the original license is retained;
- `.web-factory-origin.json` records the exact resolved source commit;
- `THIRD_PARTY_TEMPLATE.md` records attribution and release obligations.

## Modernize from a URL

1. Capture public or authorized pages at desktop, tablet, and mobile sizes.
2. Extract routes, menus, forms, tables, statuses, dialogs, and critical user flows.
3. Write the migration contract before implementation.
4. Import a reviewed template into an isolated workspace.
5. Bind a Cline ACP session to that workspace.
6. Replace demo content and implement the legacy workflows.
7. Run functional and visual checks.
8. Publish a preview and open a pull request.

For websites requiring login, use a dedicated test account. Do not provide production administrator credentials to the coding agent.

## Modernize from screenshots

Screenshots reveal presentation, but not hidden workflow or backend behavior. Build the visible application with realistic mock data, identify unknown behavior explicitly, and avoid claiming that an unseen workflow was preserved.

## LINE workflow

A typical LINE request is:

```text
ปรับเว็บ https://old.example.com ให้เป็น enterprise dashboard
รักษาเมนูและฟังก์ชันเดิม ใช้สีเหลือง เทา และรองรับมือถือ
```

Recommended task response:

```text
Task: WEB-20260721-001
Source captured: 12 pages
Critical workflows: 4
Template: Studio Admin
Status: waiting for design approval
```

After approval, bind the conversation to Cline:

```text
/acp spawn cline --bind here
```

Keep merge and production deployment behind separate explicit approval gates.

## Release checklist

- inspect imported attribution and license;
- review Git diff for unrelated template content;
- run typecheck, lint/check, tests, and production build;
- verify responsive behavior at 360, 768, 1024, 1440, and 1920 pixels;
- verify keyboard navigation, focus visibility, labels, loading, empty, error, and permission states;
- scan dependencies and secrets;
- publish a preview;
- review before/after captures;
- merge only after human approval.
