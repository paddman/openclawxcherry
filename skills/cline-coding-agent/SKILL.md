---
name: cline-coding-agent
description: "Delegate repository inspection, implementation, testing, and code review to the Cline ACP harness through OpenClaw."
---

# Cline Coding Agent

Use the external Cline harness for repository work that benefits from a coding-specialized agent.
OpenClaw owns the user conversation, policy, session binding, and delivery. Cline owns codebase
inspection, file edits, commands, and test execution inside the selected workspace.

## Preconditions

Before routing work to Cline, verify:

- ACP is enabled and the `acpx` backend is healthy;
- `cline` is present in `acp.allowedAgents`;
- the custom alias launches `cline --acp`;
- the requested repository path exists and is accessible;
- the current channel/user is authorized for repository work;
- write access is enabled only when the workspace is isolated.

Run `/acp doctor` when backend health is unknown.

## When to use Cline

Use Cline for:

- understanding an unfamiliar codebase;
- implementing a feature across multiple files;
- fixing tests, lint errors, type errors, or build failures;
- generating focused regression tests;
- reviewing a diff and identifying concrete defects;
- refactoring while preserving an existing public API;
- preparing a change for human review.

Do not use Cline for production deployment, secret rotation, destructive infrastructure changes,
or unrestricted host administration unless a separate reviewed workflow explicitly authorizes it.

## Delegation contract

Give Cline a bounded task with:

1. the repository/workspace path;
2. the exact objective;
3. constraints that must remain compatible;
4. tests or validation commands to run;
5. prohibited actions such as deploy, push, delete, or dependency upgrades;
6. the required final report.

Example task:

```text
Work only in the supplied repository. Investigate the failing authentication tests,
fix the smallest root cause, add regression coverage, and run the relevant test suite.
Do not deploy, push, rotate secrets, or change unrelated dependencies. Return the
root cause, files changed, commands run, test results, and any remaining risk.
```

## Session behavior

- Prefer a persistent bound ACP session for multi-turn implementation work.
- Prefer a one-shot ACP session for a narrow review or diagnostic task.
- Use `/acp steer` to add constraints without discarding context.
- Use `/acp cancel` when the current turn is unsafe or clearly off course.
- Use `/acp close` after the work is complete so the process and binding are cleaned up.

## Permission policy

Read-only mode is the default safe profile. It is appropriate for inspection, planning, and review.
Coding mode uses ACPX `approve-all`, because ACP sessions cannot answer interactive native prompts.
Enable coding mode only for a dedicated repository workspace under a restricted OS account,
container, VM, or approved sandbox backend.

Never interpret `approve-all` as permission to act outside the task. The prompt must still prohibit
push, deploy, credential access, and unrelated changes unless explicitly approved.

## Review gates

Before accepting Cline's result:

- inspect `git status` and `git diff`;
- confirm no secrets, generated credentials, or unrelated files were added;
- verify the reported commands actually completed successfully;
- run the repository's required test/lint/typecheck gates;
- confirm dependency and lockfile changes are justified;
- require human review before merge, deploy, or production execution.

## Required final report

Cline should return:

- root cause or implementation approach;
- files changed and why;
- commands run;
- tests and results;
- behavior or API changes;
- remaining limitations or risks;
- explicit confirmation that it did not deploy or push, unless that action was separately approved.
