# Agentic Loop + Autonomous Tasks — Design

Date: 2026-06-29
Status: approved, executing

## Problem

The assistant promises actions it never runs. Two root causes:

1. **Chat is single-pass.** The model emits actions once; they run in parallel; there is no
   tool→result→tool loop. Multi-step goals ("do X, then based on the result do Y") silently stop.
2. **Scheduled tasks cannot act.** When a task fires, `buildScheduledTaskResponse` calls a
   text-only generator and *strips* any `<action>` markup. A scheduled "book tickets" produces a
   sentence and discards the action.

Plus there are no condition triggers ("when tickets go on sale") — recurrence is time-only.

Goal: "book me tickets when they go on sale" works end-to-end without hardcoding per task type.

## Approach

Build a loop on top of the existing `parseActions` / `executeActions` / action-contracts stack.
No switch to native function-calling (would rewrite the whole tool layer), no agent framework
(new dependency for ~150 lines). Reuses `run_browser_task` as the generic "do a thing on a site"
engine.

## Components

### 1. `runAgentLoop(goal, context, { maxSteps=6, allowActions=true, onStep })`

```
transcript = history + goal
for step in 1..maxSteps:
  text = model(systemPrompt + toolCatalog + transcript)
  { spoken, actions } = parseActions(text)
  if no actions: return { status: 'done', spoken }
  results = executeActions(actions)
  if any result needs the user (pause / missing info): return { status: 'paused', reason, spoken }
  transcript += { model: text, results }
return { status: 'maxSteps', spoken }
```

- Live chat calls it with the SSE streamer (fixes "says it'll do X then stops").
- Scheduler calls it with `allowActions=true`; result delivered via `createBriefing`.
- Termination is bounded: no more actions, a pause, or `maxSteps`.

### 2. Autonomous scheduled execution + condition triggers

- `runDueScheduledTasksForUser` runs instruction-tasks through `runAgentLoop` instead of the
  text-only path. Scheduled tasks can now act.
- New `scheduled_tasks` columns: `condition TEXT`, `expires_at TIMESTAMPTZ`,
  `interval_minutes INT`, `budget_cap NUMERIC`. New recurrence value `poll`.
- A condition task = a `poll` task whose loop first checks the condition (via `run_browser_task`
  or search). Not met → reschedule next poll, do nothing. Met → run the goal, self-cancel via the
  existing `cancel_scheduled_task` action. `expires_at` bounds total polling.
- The chat agent *creates* such a task via `create_scheduled_task` with a `condition` — no new
  task type is hardcoded.
- Polling rides the existing external `POST /proactive/sweep` (~15 min). `advanceScheduledTask`
  advances `poll` tasks by `interval_minutes` and deactivates past `expires_at`.

### 3. Budget cap + approval

- `budget_cap` per task; global default in preferences (£100).
- In autonomous runs, when `run_browser_task` returns `ready_for_payment` with `total`: parse the
  number. `<= cap` → auto-`confirmPayment`, briefing "Booked, £X." `> cap` or unparseable →
  do **not** pay; briefing "over your £X cap — approve?" with a resume action that re-runs the
  purchase on approval (sessions are in-memory/ephemeral, so the cart is rebuilt, not held).
- Payment is the only irreversible step that auto-fires, and only under cap.

## Safety / failure

- `maxSteps` per loop; `expires_at` + interval bound polling; idempotency (mark task done before
  delivering so a retried sweep can't double-book); existing payment keyword-guard retained.

## Testing

- Unit-test loop termination + pause with a mock model/executor (no network).
- Unit-test cap parsing (`"£150" > 100`, `"$5.00"`, unparseable → pause).
- Run the smoke suite.
- Cannot E2E a real purchase here; that path is logic-tested only.
