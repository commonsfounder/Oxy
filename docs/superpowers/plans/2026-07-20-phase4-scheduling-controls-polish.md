# Phase 4: Scheduling, Controls & Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision note (2026-07-20, before any task executed):** Same class of problems as Phases 2/3's original drafts, corrected here before implementation: (1) Jest throughout — this repo uses `node --test` + `node:assert/strict`, tests in `test/smoke/*.test.js` (confirmed via `package.json`'s `"test"` script and the existing `test/smoke/routines.test.js`). (2) Task 1's rewritten `createRoutine` dropped the `try/catch` never-throw wrapper the real `api/services/routines.js` already has (verified by reading the file) — every function in this file must preserve that contract, including the two new ones. (3) Task 2's core premise — "reuse the existing single-message chat-dispatch path... the same one a user's own chat message goes through" — **does not exist as a callable function**. `/chat` is one large `app.post` handler (`api/index.js:6056`) tightly coupled to `req`/`res`/SSE streaming, not an extractable function. The actual existing req/res-decoupled execution path is `runAgenticLoop` from `./services/agent-orchestrator`, already used exactly this way at `api/index.js:7371` (`POST /agent/tasks/:id/run`, "fire and forget" background execution for a user's goal). Rewritten below to call `runAgenticLoop` directly instead of an invented `dispatchChatMessage`. (4) Task 3's routes used `requireAuth`/`req.user.id` instead of this repo's actual `requireSessionAuth` + `getAuthenticatedUserId(req)` convention. (5) Task 3 Step 7 named no concrete file/line for where `executionMode` gates execution — it's `api/services/action-runner.js`, two near-identical spots (`contract?.executionMode === 'review' && !context.bypassReview`, once in the parallel branch, once in the sequential branch) — rewritten to name both. (6) Guard mode is a **server-enforced** gate over `action-runner.js`'s executionMode check, and must not be confused with the existing **client-only** `reviewBeforeOpeningApps`/`confirmSensitiveAppOpens` toggles already in `OxySettings` (`OxyApp/OxyApp/Views/Settings/SettingsView.swift:423`) — those gate whether the app auto-opens a deep link locally, a materially different and weaker mechanism. Guard mode gets its own field, not a reuse of those. (7) `settings` reaching the chat handler is `req.body.settings`, built from a manually-whitelisted field list in `ChatService.swift` (`OxyApp/OxyApp/Services/ChatService.swift:33-40`), not a blanket encode of `OxySettings` — adding `guardMode`/`effort` requires editing that whitelist too, not just the struct. (8) Task 4 originally named a `VaultListView.swift`, which does not exist — corrected below to `VaultView.swift`, the real Phase 2 file (confirmed to exist; it holds both list and add-credential UI in one file, the established one-file-per-feature convention).

**Goal:** Make Phase 1's routines schedulable (recurring, not just saved-and-manually-run), expose an effort picker and a server-enforced "Guard mode" toggle in the chat UI, and apply a final motion/visual pass across every new surface from Phases 1–3.

**Architecture:** Scheduling extends the existing proactive-job infrastructure (`runProactiveSweep`/`runProactiveForUser` in `api/index.js`) rather than introducing a second cron system — a routine with a schedule is just another thing `runProactiveSweep` checks on each tick, dispatched via the existing `runAgenticLoop` background-execution path (see revision note item 3). Interval-based (`every N minutes`), not full cron-expression parsing. Guard mode is enforced server-side in `action-runner.js`, not just a client-side confirmation toggle (see revision note item 6) — this is the actual "generalize the confirmation gate" instance for this phase. Effort is stored and surfaced as a preference only; this plan does not wire it into model selection (no such per-request model-switching mechanism exists today, and the plan's own steps never specify behavior beyond storage — treated as out of scope, not an oversight).

**Tech Stack:** Node.js/Express (`api/`), Supabase/Postgres, SwiftUI.

## Global Constraints

- Do not add a second scheduler/cron dependency — reuse `runProactiveSweep`/`runProactiveForUser`'s existing tick mechanism, and `runAgenticLoop` for actually executing a routine's prompt.
- Guard mode and effort settings must be per-user, persisted (`chat_settings` table), and included in the `settings` object the iOS client already sends with every `/chat` request — not client-only state that resets on relaunch.
- Test runner is `node --test` over `test/smoke/*.test.js`, using `node:assert/strict` and `node:test` — not Jest. Every service function follows the existing never-throw contract (see `routines.js`, `task-entities.js`).
- Auth middleware is `requireSessionAuth` + `getAuthenticatedUserId(req)`, same as every prior phase.
- `npm test` must be green before every commit. Never `git add -A`/`git add .` — stage explicit paths only. Work directly on `main`, no feature branches.
- New Supabase migrations must NOT be applied to the live "Oxy" project (`zxfpwuuhwmmzlfhbcdiw`) without asking the user first.
- The polish pass (Task 4) touches only visual/motion properties (spacing, transitions, typography) on already-shipped views from Phases 1–3 — no new functionality in that task. No SF Symbols; real bundled assets only.

---

### Task 1: Make routines schedulable

**Files:**
- Create: `supabase/migrations/supabase-migration-routines-schedule.sql`
- Modify: `api/services/routines.js`
- Modify: `test/smoke/routines.test.js`

**Interfaces:**
- Produces: `createRoutine(supabase, { userId, name, prompt, intervalMinutes = null })` — unchanged never-throw contract; when `intervalMinutes` is provided, sets `next_run_at = now() + intervalMinutes`. `listDueRoutines(supabase, now) -> routines[]` (cross-user — the scheduler sweep needs all due routines, not one user's; never throws, returns `[]` on error). `markRoutineRun(supabase, routineId, now) -> { ok, error? }` — sets `last_run_at = now`, `next_run_at = now + interval_minutes`; never throws.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/supabase-migration-routines-schedule.sql
alter table routines add column if not exists interval_minutes integer;
alter table routines add column if not exists next_run_at timestamptz;
alter table routines add column if not exists last_run_at timestamptz;

create index if not exists routines_next_run_idx on routines (next_run_at) where interval_minutes is not null;

-- Only the service-role client (used by the proactive sweep) ever writes next_run_at/
-- last_run_at, but an update policy keeps this table's RLS surface complete/consistent
-- with the rest of the schema rather than relying solely on service-role bypass.
create policy "routines_update_own" on routines for update using (auth.uid() = user_id);
```

- [ ] **Step 2: Write the failing tests**

Append to `test/smoke/routines.test.js` (reuse the existing `fakeSupabase` helper already in that file — extend it if the new functions need shapes it doesn't yet support, e.g. `update`/`lte`):

```javascript
const { listDueRoutines, markRoutineRun } = require('../../api/services/routines');

test('createRoutine with intervalMinutes sets next_run_at', async () => {
  const supabase = fakeSupabase();
  const before = Date.now();
  const routine = await createRoutine(supabase, { userId: 'u1', name: 'Daily digest', prompt: 'Summarize inbox', intervalMinutes: 1440 });
  assert.ok(new Date(routine.next_run_at).getTime() > before);
});

test('createRoutine without intervalMinutes leaves next_run_at null', async () => {
  const supabase = fakeSupabase();
  const routine = await createRoutine(supabase, { userId: 'u1', name: 'One-off', prompt: 'Do a thing' });
  assert.equal(routine.next_run_at, null);
});

test('listDueRoutines returns only routines whose next_run_at has passed', async () => {
  const rows = [
    { id: 'r1', user_id: 'u1', interval_minutes: 60, next_run_at: new Date(Date.now() - 1000).toISOString() },
    { id: 'r2', user_id: 'u1', interval_minutes: 60, next_run_at: new Date(Date.now() + 100000).toISOString() }
  ];
  const supabase = fakeDueRoutinesSupabase(rows);
  const due = await listDueRoutines(supabase, new Date());
  assert.deepEqual(due.map((r) => r.id), ['r1']);
});

test('listDueRoutines never throws even when the supabase client blows up', async () => {
  const brokenSupabase = { from() { throw new Error('boom'); } };
  const due = await listDueRoutines(brokenSupabase, new Date());
  assert.deepEqual(due, []);
});

test('markRoutineRun advances next_run_at by interval_minutes', async () => {
  const rows = [{ id: 'r1', interval_minutes: 60, next_run_at: new Date().toISOString() }];
  const supabase = fakeMarkRunSupabase(rows);
  const now = new Date();
  await markRoutineRun(supabase, 'r1', now);
  const updated = rows.find((r) => r.id === 'r1');
  assert.equal(new Date(updated.next_run_at).getTime(), now.getTime() + 60 * 60000);
});

test('markRoutineRun never throws even when the supabase client blows up', async () => {
  const brokenSupabase = { from() { throw new Error('boom'); } };
  const result = await markRoutineRun(brokenSupabase, 'r1', new Date());
  assert.ok(result.error);
});
```

Write minimal `fakeDueRoutinesSupabase`/`fakeMarkRunSupabase` helpers alongside the existing `fakeSupabase` in the same file (chainable `.select().not().lte()` returning `{ data, error }`, and `.select().eq().single()` + `.update().eq()` respectively) — don't try to force the one existing `fakeSupabase` to cover every new query shape; a couple of small purpose-built fakes are clearer than one that does everything.

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/smoke/routines.test.js`
Expected: FAIL — `listDueRoutines`/`markRoutineRun` not exported yet

- [ ] **Step 4: Extend `routines.js`**

Preserve the existing `try/catch` never-throw contract used by every function already in this file.

```javascript
// api/services/routines.js — extend existing file
async function createRoutine(supabase, { userId, name, prompt, intervalMinutes = null }) {
  try {
    const nextRunAt = intervalMinutes ? new Date(Date.now() + intervalMinutes * 60000).toISOString() : null;
    const { data, error } = await supabase
      .from('routines')
      .insert({ user_id: userId, name, prompt, interval_minutes: intervalMinutes, next_run_at: nextRunAt })
      .select()
      .single();
    if (error) return { error };
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

async function listDueRoutines(supabase, now) {
  try {
    const { data, error } = await supabase
      .from('routines')
      .select('*')
      .not('interval_minutes', 'is', null)
      .lte('next_run_at', now.toISOString());
    if (error || !data) return [];
    return data;
  } catch (err) {
    return [];
  }
}

async function markRoutineRun(supabase, routineId, now) {
  try {
    const { data: routine, error: fetchError } = await supabase.from('routines').select('interval_minutes').eq('id', routineId).single();
    if (fetchError || !routine) return { ok: false, error: fetchError?.message || 'routine not found' };
    const nextRunAt = new Date(now.getTime() + routine.interval_minutes * 60000).toISOString();
    const { error } = await supabase.from('routines').update({ last_run_at: now.toISOString(), next_run_at: nextRunAt }).eq('id', routineId);
    if (error) return { ok: false, error };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { createRoutine, listRoutines, deleteRoutine, listDueRoutines, markRoutineRun };
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test test/smoke/routines.test.js`
Expected: PASS (all routines tests, including the new ones)

- [ ] **Step 6: Run the full suite, then commit**

Run: `npm test` — confirm no regressions, then:

```bash
git add supabase/migrations/supabase-migration-routines-schedule.sql api/services/routines.js test/smoke/routines.test.js
git commit -m "feat(routines): support interval-based scheduling"
```

---

### Task 2: Wire due routines into the existing proactive sweep

**Files:**
- Modify: `api/index.js` (`runProactiveSweep`, `api/index.js:5478`)
- Manual verification only — no automated test (see rationale below).

**Interfaces:**
- Consumes: `listDueRoutines`, `markRoutineRun` from Task 1; `runAgentLoop` (aliased from `runAgenticLoop` in `./services/agent-orchestrator`, already imported at the top of `api/index.js`) — the real req/res-decoupled execution path, already used identically at `api/index.js:7371` for `POST /agent/tasks/:id/run` ("fire and forget" background execution). A routine dispatch is the same shape: `initialMessage: routine.prompt`, `userId: routine.user_id`.
- Produces: no new exports — `runProactiveSweep` additionally, on each tick, fetches due routines and runs each one through `runAgentLoop`, then calls `markRoutineRun`.
- No automated test for this step: `runProactiveSweep`/`runProactiveForUser` have no existing test coverage in this codebase (no `test/smoke/` file exercises them today), and `runAgentLoop` itself depends on live Gemini calls — the same reason `confirmPayment`/`confirmCredentialUse` in prior phases were verified by code reading, not a test seam. Step 3 below is manual/code-inspection verification instead, consistent with that established precedent.

- [ ] **Step 1: Read the current body of `runProactiveSweep`/`runProactiveForUser`**

`runProactiveSweep(logger = console)` at `api/index.js:5478` loops over users and calls `runProactiveForUser(user.user_id, logger)` for each (line 5488). Add the due-routines pass inside `runProactiveSweep` itself (once per sweep, not once per user, since `listDueRoutines` is already cross-user), not inside `runProactiveForUser`.

- [ ] **Step 2: Extend `runProactiveSweep`**

```javascript
const { listDueRoutines, markRoutineRun } = require('./services/routines');
// runAgentLoop (aliased from runAgenticLoop) and OXCY_SYSTEM_PROMPT are already imported/defined
// near the top of this file — reuse them, do not re-import.

async function runProactiveSweep(logger = console) {
  // ...existing per-user briefing loop stays exactly as-is...

  const dueRoutines = await listDueRoutines(supabase, new Date());
  for (const routine of dueRoutines) {
    try {
      await runAgentLoop({
        userId: routine.user_id,
        initialMessage: routine.prompt,
        dynamicSystemPrompt: OXCY_SYSTEM_PROMPT,
        maxIterations: 6,
        context: { autonomy: 'Active' },
        executeActionsFn: executeActions,
        persistTask: false
      });
      await markRoutineRun(supabase, routine.id, new Date());
    } catch (err) {
      logger?.error?.('routine_run_failed', { routineId: routine.id, error: err.message });
    }
  }
}
```

`persistTask: false` deliberately — a scheduled routine isn't a user-tracked `agent_tasks` row the way a manually-started agent task is (no "Working" card on Home to show for it); it's closer to the existing briefing flow, which also doesn't create a task record. If this turns out to be the wrong call once routines are used for longer-running goals, that's a one-line flip, not a redesign.

- [ ] **Step 3: Manual/code-inspection verification**

Run `node --test` to confirm nothing else broke (this change doesn't touch anything with existing test coverage). Then manually: create a routine with a short `intervalMinutes` via `POST /routines` (once Task 1's fields are exposed — for now, insert a test row directly via the Supabase dashboard/SQL with `next_run_at` in the past), trigger a sweep (however `runProactiveSweep` is already invoked in this deployment — check for an existing cron/interval caller), and confirm the routine's `last_run_at`/`next_run_at` advance and an agent trace exists for that user.

- [ ] **Step 4: Commit**

```bash
git add api/index.js
git commit -m "feat(routines): dispatch due scheduled routines from the proactive sweep"
```

---

### Task 3: Model/effort picker + Guard mode toggle

**Files:**
- Create: `supabase/migrations/supabase-migration-chat-settings.sql`
- Create: `api/services/chat-settings.js`
- Test: `test/smoke/chat-settings.test.js`
- Modify: `api/index.js` (routes + thread `guardMode` into every `executeActions` context in the chat handler)
- Modify: `api/services/action-runner.js` (both executionMode gate sites)
- Modify: `OxyApp/OxyApp/Views/Settings/SettingsView.swift` (`OxySettings` struct — add fields, distinct from the existing client-only `reviewBeforeOpeningApps`/`confirmSensitiveAppOpens`)
- Modify: `OxyApp/OxyApp/Services/ChatService.swift` (add the two new fields to the request-body settings whitelist)
- Modify: `OxyApp/OxyApp/Views/Chat/ChatView.swift` (small settings sheet reachable from the header — read the header area first, no existing toolbar to extend)

**Interfaces:**
- Produces: `getChatSettings(supabase, userId) -> { effort: 'low'|'medium'|'high', guardMode: boolean }` (defaults `{ effort: 'medium', guardMode: false }` if no row exists, never throws), `saveChatSettings(supabase, userId, { effort, guardMode }) -> { ok, error? }` (never throws).
- Produces routes: `GET /chat-settings`, `PUT /chat-settings`, `requireSessionAuth` + `getAuthenticatedUserId(req)` (not `requireAuth`/`req.user.id` — that convention doesn't exist in this repo).
- Guard mode is enforced **server-side**: `action-runner.js`'s two executionMode checks (`contract?.executionMode === 'review' && !context.bypassReview`) become `((contract?.executionMode === 'review') || context.guardMode) && !context.bypassReview`. `context.guardMode` is threaded from `settings.guardMode` (the request's `settings` object, already loaded as `const settings = req.body.settings` at the top of the `/chat` handler) into every `executeActions(userId, actions, { ... })` call within that handler.
- Effort is stored/exposed only — this plan does not wire it into model selection (see architecture note).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/supabase-migration-chat-settings.sql
create table if not exists chat_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  effort text not null default 'medium' check (effort in ('low', 'medium', 'high')),
  guard_mode boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table chat_settings enable row level security;
create policy "chat_settings_select_own" on chat_settings for select using (auth.uid() = user_id);
create policy "chat_settings_upsert_own" on chat_settings for insert with check (auth.uid() = user_id);
create policy "chat_settings_update_own" on chat_settings for update using (auth.uid() = user_id);
```

- [ ] **Step 2: Write the failing tests**

```javascript
// test/smoke/chat-settings.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { getChatSettings, saveChatSettings } = require('../../api/services/chat-settings');

test('getChatSettings returns defaults when no row exists', async () => {
  const supabase = fakeChatSettingsSupabase([]);
  const settings = await getChatSettings(supabase, 'u1');
  assert.deepEqual(settings, { effort: 'medium', guardMode: false });
});

test('getChatSettings never throws even when the supabase client blows up', async () => {
  const brokenSupabase = { from() { throw new Error('boom'); } };
  const settings = await getChatSettings(brokenSupabase, 'u1');
  assert.deepEqual(settings, { effort: 'medium', guardMode: false });
});

test('saveChatSettings then getChatSettings returns the saved values', async () => {
  const store = [];
  const supabase = fakeChatSettingsSupabase(store);
  await saveChatSettings(supabase, 'u1', { effort: 'high', guardMode: true });
  const settings = await getChatSettings(supabase, 'u1');
  assert.deepEqual(settings, { effort: 'high', guardMode: true });
});

test('saveChatSettings never throws even when the supabase client blows up', async () => {
  const brokenSupabase = { from() { throw new Error('boom'); } };
  const result = await saveChatSettings(brokenSupabase, 'u1', { effort: 'low', guardMode: false });
  assert.ok(result.error);
});
```

Write `fakeChatSettingsSupabase` alongside the tests — a simple in-memory upsert-by-`user_id` fake (`.from().select().eq().single()` / `.from().upsert()`), same style as `test/smoke/task-entities.test.js`'s `fakeSupabase`.

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/smoke/chat-settings.test.js`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `chat-settings.js`**

```javascript
// api/services/chat-settings.js
'use strict';

const DEFAULTS = { effort: 'medium', guardMode: false };

async function getChatSettings(supabase, userId) {
  try {
    const { data, error } = await supabase.from('chat_settings').select('*').eq('user_id', userId).single();
    if (error || !data) return { ...DEFAULTS };
    return { effort: data.effort, guardMode: data.guard_mode };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

async function saveChatSettings(supabase, userId, { effort, guardMode }) {
  try {
    const { error } = await supabase
      .from('chat_settings')
      .upsert({ user_id: userId, effort, guard_mode: guardMode, updated_at: new Date().toISOString() });
    if (error) return { error };
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { getChatSettings, saveChatSettings };
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test test/smoke/chat-settings.test.js`
Expected: PASS

- [ ] **Step 6: Add routes**

```javascript
const { getChatSettings, saveChatSettings } = require('./services/chat-settings');

app.get('/chat-settings', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await getChatSettings(supabase, userId));
});

app.put('/chat-settings', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { effort, guardMode } = req.body || {};
  const result = await saveChatSettings(supabase, userId, { effort, guardMode });
  res.json(result);
});
```

- [ ] **Step 7: Thread `guardMode` into `action-runner.js`'s executionMode gate**

In `api/services/action-runner.js`, both spots currently read `contract?.executionMode === 'review' && !context.bypassReview` (one in the parallel branch, one in the sequential branch). Change both to:

```javascript
} else if ((contract?.executionMode === 'review' || context.guardMode) && !context.bypassReview) {
```

In `api/index.js`'s `/chat` handler, `const settings = req.body.settings` is already loaded near the top. At every `executeActions(userId, ..., { ... })` call site within that handler (there are several — grep the handler function body for `executeActions(`), add `guardMode: settings.guardMode` to the context object passed in. Do not touch the two call sites outside the `/chat` handler (`/chat-with-image` etc.) unless the user asks for guard mode there too — out of scope for this task.

- [ ] **Step 8: iOS — extend `OxySettings`, not the existing review toggles**

In `OxyApp/OxyApp/Views/Settings/SettingsView.swift`'s `OxySettings` struct, add:

```swift
var chatEffort: String = "medium"
var guardMode: Bool = false
```

(plus the matching `CodingKeys` case and `decodeIfPresent` lines, following the exact pattern every other field in that struct already uses). Name it `chatEffort` not `effort` to avoid any ambiguity with unrelated "effort" concepts elsewhere in the app. This is intentionally a new, distinct field from `reviewBeforeOpeningApps`/`confirmSensitiveAppOpens` (see revision note item 6) — those stay as they are.

In `OxyApp/OxyApp/Services/ChatService.swift`, add both fields to the manually-whitelisted `settings` dict built in `sendMessage` (currently lines 33-40) — the whitelist, not a blanket encode, so this is a required edit, not automatic:

```swift
"chatEffort": settings.chatEffort,
"guardMode": settings.guardMode
```

- [ ] **Step 9: iOS — sync with the server + UI**

Read `ChatView.swift`'s header area (around its top `HStack`s, roughly lines 63-221) first — there is no existing toolbar/settings-sheet area to extend in this file (the nav bar is hidden). Add a small icon button in that header (same `.ultraThinMaterial`-in-`Circle()` icon-button style used elsewhere in this app, e.g. `AgenticHomeView.swift`'s home button) that presents a small sheet with a `Picker("Effort", selection:)` over `"low"/"medium"/"high"` and a `Toggle("Guard mode", isOn:)`, backed by `OxySettings` (loaded from `UserDefaults` as `currentSettings` already is elsewhere in this app). On sheet appear, `GET /chat-settings` and populate; on change, `PUT /chat-settings` and persist to `UserDefaults`. Follow the toggle styling already fixed in commit `2b1329d` ("Fix toggle knob color") if a `Toggle` is styled anywhere else already, rather than reinventing it.

- [ ] **Step 10: Manual verification**

Run the app in the simulator: toggle guard mode on, trigger an action that's normally `executionMode: 'direct'` (e.g. `open_maps` or similar per `api/action-contracts.js`), confirm it now surfaces a pending-review card instead of executing immediately; toggle off, confirm normal direct execution returns. Relaunch the app and confirm the toggle state survived (proves server persistence, not just in-memory state).

- [ ] **Step 11: Run the full suite, then commit**

```bash
npm test
git add supabase/migrations/supabase-migration-chat-settings.sql api/services/chat-settings.js test/smoke/chat-settings.test.js api/services/action-runner.js api/index.js OxyApp/OxyApp/Views/Settings/SettingsView.swift OxyApp/OxyApp/Services/ChatService.swift OxyApp/OxyApp/Views/Chat/ChatView.swift
git commit -m "feat(chat): add effort picker and server-enforced guard mode toggle"
```

---

### Task 4: Final polish pass on Phases 1–3 surfaces

**Files:**
- Modify: `OxyApp/OxyApp/Views/Home/AgentTaskSessionView.swift`, `OxyApp/OxyApp/Views/Routines/RoutinesListView.swift`, `OxyApp/OxyApp/Views/Vault/VaultView.swift`, `OxyApp/OxyApp/Views/Home/AgenticHomeView.swift`

**Interfaces:** None — visual/motion only, no new functionality, no new types.

- [ ] **Step 1: Invoke the `apple-design` skill against these four views specifically** — motion (list insert/remove transitions on the live activity feed and routines list), typography (match existing type scale, no ad-hoc font sizes), and translucent-materials usage consistent with the rest of the app (per the existing Apple Design pass conventions already applied app-wide).

- [ ] **Step 2: Verify no SF Symbols were introduced** — grep the four files for `Image(systemName:` and replace any with real Assets.xcassets icons, per the hard ban already in effect app-wide.

```bash
grep -rn "Image(systemName:" OxyApp/OxyApp/Views/Home/AgentTaskSessionView.swift OxyApp/OxyApp/Views/Routines/RoutinesListView.swift OxyApp/OxyApp/Views/Vault/VaultView.swift OxyApp/OxyApp/Views/Home/AgenticHomeView.swift
```

Expected: no matches. If any exist, replace with real icon assets before proceeding.

- [ ] **Step 3: Run the app in the simulator and manually exercise all four surfaces** — live task steps updating, adding/deleting a routine (including a scheduled one), adding/deleting a vault credential, viewing the recent-entities strip — confirm nothing regressed and motion/typography reads as intentional, not default-SwiftUI.

- [ ] **Step 4: Commit**

```bash
git add OxyApp/OxyApp/Views/Home/AgentTaskSessionView.swift OxyApp/OxyApp/Views/Routines/RoutinesListView.swift OxyApp/OxyApp/Views/Vault/VaultView.swift OxyApp/OxyApp/Views/Home/AgenticHomeView.swift
git commit -m "polish: motion, typography, and icon pass on Aside-parity surfaces"
```
