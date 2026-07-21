---
name: legacy-web-modernizer
description: "Turn an old website screenshot, URL, or repository into a polished production-ready web application using a reviewed template and Cline."
---

# Legacy Web Modernizer

Modernize an existing website from a screenshot, public URL, authenticated browser session, or source repository. Preserve the user's workflows and information while replacing outdated presentation, interaction patterns, responsiveness, and accessibility.

## Product promise

The result is not a design mockup. Deliver a running preview, source code, build result, responsive verification, and a clear before/after summary.

## Input priority

Use the richest available source:

1. source repository plus a runnable environment;
2. source repository without a runnable environment;
3. reachable website URL;
4. screenshots or screen recording;
5. written description only.

When only screenshots are available, implement visible behavior with realistic mock data and explicitly mark backend behavior as unverified.

## Default workflow

1. **Create a task and isolated workspace**
   - Generate a task ID such as `WEB-YYYYMMDD-NNN`.
   - Create a dedicated Git branch, worktree, container, or sandbox.
   - Never edit the source production checkout or default branch directly.

2. **Capture the legacy system**
   - For a URL, crawl only pages the user is authorized to access.
   - Capture desktop, tablet, and mobile screenshots.
   - Record routes, navigation, forms, tables, dialogs, status values, validation, and critical workflows.
   - For a repository, inspect routes, components, API contracts, auth, environment variables, and data models.
   - Never copy credentials, private user data, analytics tokens, or production secrets into the new project.

3. **Write the migration contract**
   Create:
   - `APP_SPEC.md`
   - `LEGACY_INVENTORY.md`
   - `USER_FLOWS.md`
   - `API_CONTRACT.md`
   - `DESIGN_SYSTEM.md`
   - `ACCEPTANCE_CRITERIA.md`

   Separate requirements into:
   - must preserve;
   - should improve;
   - may replace;
   - unknown or blocked.

4. **Select the strongest visual foundation**
   - Use `scripts/scout-web-template.mjs` when a new external candidate is needed.
   - Review screenshots or live demos for the top candidates. Metadata score alone is not visual proof.
   - Prefer the curated `studio-admin` Golden Template for enterprise dashboards and internal tools.
   - Import through `scripts/import-web-template.mjs`; do not copy arbitrary repositories directly.
   - Preserve the upstream license and attribution.

5. **Import safely**

   ```bash
   node scripts/import-web-template.mjs \
     --template studio-admin \
     --root /workspace/web-factory \
     --target /workspace/web-factory/WEB-001 \
     --name capacity-modern \
     --init-git
   ```

   The importer must reject secret-like files, private keys, symlinks, native executables, unsafe lifecycle scripts, and unapproved licenses. Dependency installation uses `--ignore-scripts` by default.

6. **Delegate implementation to Cline**
   - Give Cline the isolated workspace, migration contract, source references, exact preservation constraints, and quality commands.
   - Rebuild the product around the user's domain, not around the template's demo content.
   - Remove upstream branding, demo accounts, fake analytics, irrelevant pages, and unused dependencies.
   - Preserve API contracts and backend behavior unless the migration plan explicitly changes them.
   - Do not push, merge, deploy production, or access secrets without separate approval.

7. **Apply Web Design Master**
   - Use `web-design-master` for information hierarchy, tokens, states, responsiveness, accessibility, and non-generic visual quality.
   - Prefer a coherent corporate direction over decorative gradients, glass effects, and oversized cards.
   - Implement loading, empty, error, disabled, permission-denied, and destructive-action states.

8. **Verify visually and functionally**
   - Run install, typecheck, lint/check, tests, and production build.
   - Test at 360, 768, 1024, 1440, and 1920 CSS pixels.
   - Exercise login, navigation, forms, filters, tables, dialogs, and error paths.
   - Compare before/after screenshots for workflow preservation, not pixel similarity.
   - Return failures to Cline and repeat until the applicable gates pass.

9. **Deliver preview and review controls**
   Return:
   - preview URL;
   - branch and pull request;
   - before/after images;
   - pages and workflows preserved;
   - files and dependencies changed;
   - test/build/accessibility results;
   - known limitations;
   - actions: request changes, approve merge, or cancel.

## LINE conversation behavior

When the request arrives through LINE:

- accept a screenshot, URL, or repository URL;
- acknowledge the source and task ID;
- show concise progress by major stage only;
- use buttons or quick replies for design direction and approval;
- send the preview URL and before/after images when ready;
- keep each task isolated because LINE has no thread support;
- require explicit approval before merge or deployment.

Recommended user commands:

```text
ปรับเว็บนี้ให้ใหม่ <URL>
ใช้ repo <owner/repo> แล้วเปลี่ยน UI ใหม่
ทำจากรูปนี้ โทน enterprise รักษาเมนูเดิม
สถานะ WEB-001
ยกเลิก WEB-001
```

## Non-negotiable gates

Do not call the work complete until all applicable checks pass:

- source and license recorded;
- no source secrets imported;
- upstream `.git` and workflows removed;
- branding and demo data replaced;
- responsive layouts verified;
- keyboard focus and accessible names verified;
- production build passes;
- critical user flow works;
- no critical dependency vulnerability is knowingly left unresolved;
- preview is reachable;
- changes are reviewable in Git.
