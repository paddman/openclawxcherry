---
summary: "Run bounded, self-directed idle work from an explicit AUTOPILOT.md charter"
read_when:
  - Letting an agent discover approved work during heartbeat cycles
  - Defining safe autonomy boundaries for operations agents
  - Keeping autonomous work auditable and approval-gated
title: "Autopilot"
---

Autopilot lets a heartbeat discover one useful, bounded task when the agent is
otherwise idle. It is opt-in: create a non-empty `AUTOPILOT.md` in the agent
workspace. Without that file, heartbeat behavior is unchanged.

Autopilot is for work that has an explicit source of truth, such as health
dashboards, an incident queue, a review backlog, or an internal task list. It
is not permission to invent work from old chat messages or to act outside the
charter.

## Quick start

Set a normal heartbeat cadence. Keep `target: "none"` for a silent worker, or
use a named target when the operator should receive heartbeat alerts.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "15m",
        target: "none",
        skipWhenBusy: true,
      },
    },
  },
}
```

Then create `AUTOPILOT.md` in that agent's workspace:

```md
# Operations autopilot charter

## Approved sources

- Service health dashboards
- Open incident and change queues
- Current runbooks and task records

## Idle-work loop

1. Check for active or blocked work before starting anything new.
2. Select at most one small, high-signal item from the approved sources.
3. Perform read-only inspection, analysis, or a dry run when useful.
4. Verify the result with an independent check or concrete evidence.
5. Report the source, work performed, evidence, and next action.

## Approval boundaries

- Ask for approval before sending messages, changing configuration, restarting services, deploying, or modifying production data.
- Never delete data, infrastructure, or credentials.
- Escalate uncertain or policy-conflicting work instead of guessing.
```

## Runtime behavior

Heartbeat gives priority to due `tasks:` entries, cron or exec events, and
inferred commitments. Autopilot runs only in an idle heartbeat slot, so it does
not compete with scheduled or user-requested work.

Each run receives the charter directly in its prompt and is instructed to:

- use only the named work sources;
- avoid old-chat task inference and duplicate work;
- choose no more than one bounded mission;
- follow execute, verify, and report; and
- preserve existing approval, sandbox, and tool controls.

`AUTOPILOT.md` does not grant a new tool permission or bypass an approval. A
tool policy remains the authority for execution; the charter adds a bounded
reason to look for work.

## Audit and approval

Use the existing task and Task Flow surfaces when a mission needs detached or
multi-step work. Heartbeat transcripts retain the decision and final result.
For changes that need an operator decision, create the normal approval request
instead of performing the action.

Review the charter regularly. Keep sources narrow, remove stale programs, and
expand authority only after the previous scope has produced reliable evidence.

## Related

- [Heartbeat](/gateway/heartbeat) — cadence, routing, and heartbeat task blocks
- [Standing Orders](/automation/standing-orders) — persistent authority for all agent turns
- [Background Tasks](/automation/tasks) — detached-work ledger and audit
- [Task Flow](/automation/taskflow) — durable multi-step work
- [Execution approvals](/tools/exec-approvals) — approval policy for commands
