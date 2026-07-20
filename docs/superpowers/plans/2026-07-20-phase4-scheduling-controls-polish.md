# Phase 4: Scheduling, Controls & Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Phase 1's routines schedulable (recurring, not just saved-and-manually-run), expose a model/effort picker and a "Guard mode" toggle in the chat UI, and apply a final motion/visual pass across every new surface from Phases 1–3.

**Architecture:** Scheduling extends the existing proactive-job infrastructure (`runProactiveSweep` in `api/index.js`, driven by `proactive-job.js`) rather than introducing a second cron system — a routine with a schedule is just another thing `runProactiveSweep` checks on each tick. Interval-based (`every N minutes`), not full cron-expression parsing, to stay within what one bite-sized task can deliver correctly.

**Tech Stack:** Node.js/Express (`api/`), Supabase/Postgres, SwiftUI.

## Global Constraints

- Do not add a second scheduler/cron dependency — reuse the existing `proactive-job.js` tick mechanism.
- Guard mode and effort settings must be per-user, persisted, and sent with every chat request — not client-only state that resets on relaunch.
- The polish pass (Task 4) touches only visual/motion properties (spacing, transitions, typography) on already-shipped views from Phases 1–3 — no new functionality in that task.

---

### Task 1: Make routines schedulable

**Files:**
- Create: `supabase/migrations/supabase-migration-routines-schedule.sql`
- Modify: `api/services/routines.js`
- Test: `api/services/routines.test.js`

**Interfaces:**
- Produces: `createRoutine(supabase, { userId, name, prompt, intervalMinutes })` — `intervalMinutes` optional; when provided, sets `next_run_at = now() + intervalMinutes`. `listDueRoutines(supabase, now) -> routines[]` (cross-user — the scheduler sweep needs all due routines, not one user's). `markRoutineRun(supabase, routineId, now)` — sets `last_run_at = now`, `next_run_at = now + interval_minutes`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/supabase-migration-routines-schedule.sql
alter table routines add column if not exists interval_minutes integer;
alter table routines add column if not exists next_run_at timestamptz;
alter table routines add column if not exists last_run_at timestamptz;

create index if not exists routines_next_run_idx on routines (next_run_at) where interval_minutes is not null;
```

- [ ] **Step 2: Write the failing tests**

```javascript
// add to api/services/routines.test.js
const { createRoutine, listDueRoutines, markRoutineRun } = require('./routines');

test('createRoutine with intervalMinutes sets next_run_at', async () => {
  const store = [];
  const supabase = makeFakeRoutinesSupabase(store);
  const before = Date.now();
  const routine = await createRoutine(supabase, { userId: 'u1', name: 'Daily digest', prompt: 'Summarize inbox', intervalMinutes: 1440 });
  expect(new Date(routine.next_run_at).getTime()).toBeGreaterThan(before);
});

test('listDueRoutines returns only routines whose next_run_at has passed', async () => {
  const store = [
    { id: 'r1', user_id: 'u1', name: 'a', prompt: 'x', interval_minutes: 60, next_run_at: new Date(Date.now() - 1000).toISOString() },
    { id: 'r2', user_id: 'u1', name: 'b', prompt: 'y', interval_minutes: 60, next_run_at: new Date(Date.now() + 100000).toISOString() },
  ];
  const supabase = makeFakeRoutinesSupabase(store);
  const due = await listDueRoutines(supabase, new Date());
  expect(due.map((r) => r.id)).toEqual(['r1']);
});

test('markRoutineRun advances next_run_at by interval_minutes', async () => {
  const store = [{ id: 'r1', user_id: 'u1', name: 'a', prompt: 'x', interval_minutes: 60, next_run_at: new Date().toISOString() }];
  const supabase = makeFakeRoutinesSupabase(store);
  const now = new Date();
  await markRoutineRun(supabase, 'r1', now);
  const updated = store.find((r) => r.id === 'r1');
  expect(new Date(updated.next_run_at).getTime()).toBe(new Date(now.getTime() + 60 * 60000).getTime());
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx jest api/services/routines.test.js -t "schedul"`
Expected: FAIL, functions undefined

- [ ] **Step 4: Extend `routines.js`**

```javascript
// api/services/routines.js — extend existing file
async function createRoutine(supabase, { userId, name, prompt, intervalMinutes = null }) {
  const nextRunAt = intervalMinutes ? new Date(Date.now() + intervalMinutes * 60000).toISOString() : null;
  const { data, error } = await supabase
    .from('routines')
    .insert({ user_id: userId, name, prompt, interval_minutes: intervalMinutes, next_run_at: nextRunAt })
    .select()
    .single();
  if (error) return { error };
  return data;
}

async function listDueRoutines(supabase, now) {
  const { data, error } = await supabase
    .from('routines')
    .select('*')
    .not('interval_minutes', 'is', null)
    .lte('next_run_at', now.toISOString());
  if (error) return [];
  return data;
}

async function markRoutineRun(supabase, routineId, now) {
  // interval_minutes must be re-read since this function only has the id — fetch first
  const { data: routine } = await supabase.from('routines').select('interval_minutes').eq('id', routineId).single();
  const nextRunAt = new Date(now.getTime() + routine.interval_minutes * 60000).toISOString();
  await supabase.from('routines').update({ last_run_at: now.toISOString(), next_run_at: nextRunAt }).eq('id', routineId);
}

module.exports = { createRoutine, listRoutines, deleteRoutine, listDueRoutines, markRoutineRun };
```

- [ ] **Step 5: Run to verify pass**

Run: `npx jest api/services/routines.test.js`
Expected: PASS (all routines tests, including the 3 new ones)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/supabase-migration-routines-schedule.sql api/services/routines.js api/services/routines.test.js
git commit -m "feat(routines): support interval-based scheduling"
```

---

### Task 2: Wire due routines into the existing proactive sweep

**Files:**
- Modify: `api/index.js` (`runProactiveSweep`, near line 5446)
- Test: `api/index.test.js`

**Interfaces:**
- Consumes: `listDueRoutines`, `markRoutineRun` from Task 1.
- Produces: no new exports — `runProactiveSweep` additionally, on each tick, fetches due routines and dispatches each routine's `prompt` through whatever the existing single-message chat-dispatch path is (the same one a user's own chat message goes through — reuse it, do not build a second execution path), then calls `markRoutineRun`.

- [ ] **Step 1: Write the failing test**

```javascript
test('runProactiveSweep runs due routines and marks them run', async () => {
  const dispatched = [];
  jest.mock('./services/routines', () => ({
    listDueRoutines: jest.fn(async () => [{ id: 'r1', user_id: 'u1', prompt: 'Summarize inbox' }]),
    markRoutineRun: jest.fn(async (supabase, id) => dispatched.push(id)),
  }));
  const { runProactiveSweep } = require('./index');
  await runProactiveSweep(console, new Date());
  expect(dispatched).toEqual(['r1']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest api/index.test.js -t "runProactiveSweep runs due routines"`
Expected: FAIL (routine dispatch not wired yet, `dispatched` stays empty)

- [ ] **Step 3: Extend `runProactiveSweep`**

Read the current body of `runProactiveSweep(logger)` at `api/index.js:5446` first — it likely already loops over users for briefings; add a routines pass in the same function:

```javascript
const { listDueRoutines, markRoutineRun } = require('./services/routines');

async function runProactiveSweep(logger, now = new Date()) {
  // ...existing briefing sweep logic stays as-is above/below this addition...

  const dueRoutines = await listDueRoutines(supabase, now);
  for (const routine of dueRoutines) {
    try {
      await dispatchChatMessage(routine.user_id, routine.prompt); // use the actual existing function name that processes one chat message end-to-end for a user, wherever runProactiveForUser already calls it for briefings
      await markRoutineRun(supabase, routine.id, now);
    } catch (err) {
      logger?.error?.('routine_run_failed', { routineId: routine.id, error: err.message });
    }
  }
}
```

Replace `dispatchChatMessage` with whatever the real internal function name is — `runProactiveForUser` (line 5351) already dispatches a message-like payload for briefings, so reuse that exact call shape rather than inventing a new one.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest api/index.test.js -t "runProactiveSweep runs due routines"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/index.js api/index.test.js
git commit -m "feat(routines): dispatch due scheduled routines from the proactive sweep"
```

---

### Task 3: Model/effort picker + Guard mode toggle

**Files:**
- Create: `supabase/migrations/supabase-migration-chat-settings.sql`
- Create: `api/services/chat-settings.js`
- Test: `api/services/chat-settings.test.js`
- Modify: `api/index.js` (chat handler reads settings before dispatch)
- Create: `OxyApp/OxyApp/Models/ChatSettings.swift`
- Modify: `OxyApp/OxyApp/Views/Chat/ChatViewModel.swift`, `OxyApp/OxyApp/Views/Chat/ChatView.swift`

**Interfaces:**
- Produces: `getChatSettings(supabase, userId) -> { effort: 'low'|'medium'|'high', guardMode: boolean }` (defaults `{ effort: 'medium', guardMode: false }` if no row exists), `saveChatSettings(supabase, userId, { effort, guardMode })`.
- Produces routes: `GET /chat-settings`, `PUT /chat-settings`.
- Produces iOS: `struct ChatSettings: Codable { var effort: String; var guardMode: Bool }`, a picker + toggle in the chat UI (location: wherever the existing chat input/toolbar area is in `ChatView.swift` — read it first).

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
// api/services/chat-settings.test.js
const { getChatSettings, saveChatSettings } = require('./chat-settings');

test('getChatSettings returns defaults when no row exists', async () => {
  const supabase = makeFakeChatSettingsSupabase([]);
  const settings = await getChatSettings(supabase, 'u1');
  expect(settings).toEqual({ effort: 'medium', guardMode: false });
});

test('saveChatSettings then getChatSettings returns the saved values', async () => {
  const store = [];
  const supabase = makeFakeChatSettingsSupabase(store);
  await saveChatSettings(supabase, 'u1', { effort: 'high', guardMode: true });
  const settings = await getChatSettings(supabase, 'u1');
  expect(settings).toEqual({ effort: 'high', guardMode: true });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx jest api/services/chat-settings.test.js`
Expected: FAIL, module not found

- [ ] **Step 4: Implement `chat-settings.js`**

```javascript
// api/services/chat-settings.js
async function getChatSettings(supabase, userId) {
  const { data } = await supabase.from('chat_settings').select('*').eq('user_id', userId).single();
  if (!data) return { effort: 'medium', guardMode: false };
  return { effort: data.effort, guardMode: data.guard_mode };
}

async function saveChatSettings(supabase, userId, { effort, guardMode }) {
  const { error } = await supabase
    .from('chat_settings')
    .upsert({ user_id: userId, effort, guard_mode: guardMode, updated_at: new Date().toISOString() });
  if (error) return { error };
  return { ok: true };
}

module.exports = { getChatSettings, saveChatSettings };
```

- [ ] **Step 5: Run to verify pass**

Run: `npx jest api/services/chat-settings.test.js`
Expected: PASS

- [ ] **Step 6: Add routes**

```javascript
const { getChatSettings, saveChatSettings } = require('./services/chat-settings');

app.get('/chat-settings', requireAuth, async (req, res) => {
  res.json(await getChatSettings(supabase, req.user.id));
});

app.put('/chat-settings', requireAuth, async (req, res) => {
  const { effort, guardMode } = req.body;
  const result = await saveChatSettings(supabase, req.user.id, { effort, guardMode });
  res.json(result);
});
```

- [ ] **Step 7: Read `guardMode` in the chat handler and widen the review-required set when true**

In `api/index.js`'s chat handler, after loading the user's settings, if `guardMode` is true, treat every action contract's `confirmation` as `'review_required'` regardless of its declared value (i.e., call `getActionContract(type)` as usual, but override `executionMode` to `'review'` unconditionally when `guardMode` is on) — this is the "confirm everything" behavior. Locate the exact point where `getActionContract` result is consumed to decide execution and add the override there.

- [ ] **Step 8: iOS model + UI**

```swift
// OxyApp/OxyApp/Models/ChatSettings.swift
import Foundation

struct ChatSettings: Codable {
    var effort: String
    var guardMode: Bool

    enum CodingKeys: String, CodingKey {
        case effort
        case guardMode = "guard_mode"
    }
}
```

Add a picker (`Picker("Effort", selection: $settings.effort)` with `"low"`/`"medium"`/`"high"`) and a `Toggle("Guard mode", isOn: $settings.guardMode)` to whichever toolbar/settings-sheet area `ChatView.swift` already uses for per-conversation controls — read the file first; if no such area exists yet, add a small sheet reachable from the existing chat toolbar, following the toggle styling already fixed in commit `2b1329d` ("Fix toggle knob color").

- [ ] **Step 9: Manual verification**

Toggle guard mode on, trigger an action that's normally `executionMode: 'auto'`, confirm it now pauses for confirmation; toggle off, confirm normal behavior returns.

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/supabase-migration-chat-settings.sql api/services/chat-settings.js api/services/chat-settings.test.js api/index.js OxyApp/OxyApp/Models/ChatSettings.swift OxyApp/OxyApp/Views/Chat/ChatViewModel.swift OxyApp/OxyApp/Views/Chat/ChatView.swift
git commit -m "feat(chat): add effort picker and guard mode toggle"
```

---

### Task 4: Final polish pass on Phases 1–3 surfaces

**Files:**
- Modify: `OxyApp/OxyApp/Views/Home/AgentTaskSessionView.swift`, `OxyApp/OxyApp/Views/Routines/RoutinesListView.swift`, `OxyApp/OxyApp/Views/Vault/VaultListView.swift`, `OxyApp/OxyApp/Views/Home/AgenticHomeView.swift`

**Interfaces:** None — visual/motion only, no new functionality, no new types.

- [ ] **Step 1: Invoke the `apple-design` skill against these four views specifically** — motion (list insert/remove transitions on the live activity feed and routines list), typography (match existing type scale, no ad-hoc font sizes), and translucent-materials usage consistent with the rest of the app (per the existing Apple Design pass conventions already applied app-wide).

- [ ] **Step 2: Verify no SF Symbols were introduced** — grep the four files for `Image(systemName:` and replace any with real Assets.xcassets icons, per the hard ban already in effect app-wide.

```bash
grep -rn "Image(systemName:" OxyApp/OxyApp/Views/Home/AgentTaskSessionView.swift OxyApp/OxyApp/Views/Routines/RoutinesListView.swift OxyApp/OxyApp/Views/Vault/VaultListView.swift OxyApp/OxyApp/Views/Home/AgenticHomeView.swift
```

Expected: no matches. If any exist, replace with real icon assets before proceeding.

- [ ] **Step 3: Run the app in the simulator and manually exercise all four surfaces** — live task steps updating, adding/deleting a routine (including a scheduled one), adding/deleting a vault credential, viewing the recent-entities strip — confirm nothing regressed and motion/typography reads as intentional, not default-SwiftUI.

- [ ] **Step 4: Commit**

```bash
git add OxyApp/OxyApp/Views/Home/AgentTaskSessionView.swift OxyApp/OxyApp/Views/Routines/RoutinesListView.swift OxyApp/OxyApp/Views/Vault/VaultListView.swift OxyApp/OxyApp/Views/Home/AgenticHomeView.swift
git commit -m "polish: motion, typography, and icon pass on Aside-parity surfaces"
```
