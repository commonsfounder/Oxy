# Ambient agent runtime

This document names the software seam behind the Ambient Delegation Device.

Millie is the persistent agent identity. A runtime session is the durable execution identity
for one delegated goal. The current home device, iOS companion, browser, and future devices are
activation surfaces; they do not own the goal or its history.

## Current slice

```text
ambient device / iOS companion
        -> authenticated chat or task request
        -> agent task
        -> agent runtime session
        -> task-isolated project runtime / controlled workspace
        -> bounded artifact receipt
        -> Work / Trust / voice result
```

There are two deliberate workspace layers. The existing user-scoped text workspace is for
notes, drafts, and research that should outlive a turn. `agent-project-runtime.js` is the first
real agent-machine seam: it provisions a task-scoped clone from a server-side project catalog,
creates an isolated branch, permits bounded Git inspection, runs only named checks, and writes
only relative text paths inside that clone. It can save a local changeset, roll back uncommitted
work, and—only when infrastructure and the action review permit it—publish the isolated branch.
This is a proving ground for inspectable delegated work, not the product’s identity: the same
runtime contract must later serve messages, appointments, research, shopping, reminders, and
household tasks.

## Runtime session contract

`api/services/agent-runtime.js` owns this interface:

- create or reuse one session per `(user, task)`;
- associate the session with a device type, project, and runtime kind;
- move the session through `ready`, `running`, `waiting_approval`, `paused`, `completed`,
  `failed`, and `cancelled`;
- write a workspace file and record a bounded artifact receipt;
- bind the session to a configured project reference and record project files/check results;
- return summaries without file contents, provider payloads, credentials, or browser state.

`agent_tasks` remains the user-visible goal and checkpoint record. `agent_runtime_sessions`
remains the execution identity. `agent_runtime_artifacts` records what the execution produced.
`agent_runtime_approvals` records review-gated actions against the task and runtime that created
them. A plain “yes” is accepted only when one approval is waiting; concurrent approvals stay
separate and require a task-specific confirmation.

Agentic chat now resolves explicit continuation language against resumable user goals before
creating a task. “Continue the website work” reclaims the matching paused goal and its existing
runtime session; ordinary new requests never attach silently, and ambiguous bare continuations
remain unresolved rather than choosing a surprising goal.

## Device vocabulary

The product device is `ambient_home`: a mostly stationary household object with its own battery
that can be moved or taken out occasionally. `ios_companion` is the phone app. Existing
`pendant` routes and types are compatibility names for the current prototype and are not the
product model.

## Runtime boundary now in place

`api/services/agent-project-runtime.js` is intentionally narrow. It does not yet claim to be a
full cloud agent machine: the host must provide `OXY_AGENT_PROJECT_DATA_ROOT` and an allowlisted
`OXY_AGENT_PROJECTS_JSON` catalog such as:

```json
{"milgrain":{"source":"/srv/projects/milgrain","displayName":"Milgrain"}}
```

The runtime hashes user/task identifiers into its storage path, clones each task separately, and
never accepts arbitrary commands, repository URLs, or absolute paths from the model. Project
checks also require `OXY_AGENT_PROJECT_CHECKS_ENABLED=1` and run with a scrubbed environment so
connector credentials and server secrets are not inherited by repository code. This makes the
contract testable now while leaving the persistence provider replaceable by a VM/container runner
with a durable volume.

## Next adapter

The next implementation should move this adapter behind a durable agent-machine provider and add:

- a per-user filesystem and project folders beyond one configured clone;
- persistent browser profiles;
- scoped credentials that never enter model prompts;
- artifacts, logs, and approval-ready changesets.

The task loop, permission engine, runtime session state, and iOS receipts should remain stable
across that replacement.

## Approval continuity

Review-gated actions created inside a durable run are stored in
`agent_runtime_approvals`, with the action payload kept server-side and bounded. Claiming an
approval changes its state atomically from `pending` to `claimed`, so two confirmations cannot
execute the same action. The old `preferences.pending.action` value is read and written only as
a compatibility fallback until the approval migration is applied.
