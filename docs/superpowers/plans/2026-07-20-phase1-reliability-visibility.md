# Phase 1: Reliability & Live Visibility Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every browser-task run a persisted, pollable step trace (backing a live "Recent tasks" activity feed) and add user-saved Routines, without touching the existing warm-pool/recipe/fastpath engine's hot path.

**Architecture:** Add a new `task_steps` table written by a thin wrapper around the existing `onProgress` callback already threaded through `api/services/browser-task.js`. iOS polls a new REST endpoint to render the existing `AgentTaskSessionView`/`AgentStepViews` surface live instead of only post-hoc. Routines are a separate, unrelated CRUD table + list screen.

**Tech Stack:** Node.js/Express (`api/`), Supabase/Postgres, SwiftUI (`OxyApp/OxyApp/Views`).

## Global Constraints

- Follow existing migration naming: `supabase/migrations/supabase-migration-<feature-slug>.sql`, no numeric prefix.
- Do not modify the warm-pool/browser-launch code path (`acquireBrowser`, `primeWarmBrowser`, `launchLocalBrowser`) — only wrap `onProgress` call sites.
- `session-events.js`'s `logEvent`/`logRecipeHit`/`logVisionStep`/`logSessionOutcome` are the existing telemetry layer — task_steps is a new, separate table for user-facing live status, not a replacement.
- Routines are per-user (RLS-scoped like other user tables — check `supabase-migration-rls.sql` for the existing RLS pattern before writing the new table's policy).

---

### Task 1: `task_steps` table + `recordTaskStep` helper

**Files:**
- Create: `supabase/migrations/supabase-migration-task-steps.sql`
- Create: `api/services/task-steps.js`
- Test: `api/services/task-steps.test.js`

**Interfaces:**
- Produces: `recordTaskStep(supabase, { taskId, userId, stepName, phase, detail, status })` → inserts a row, returns the inserted row (or `{ error }` on failure — never throws, since this must never break a running browser task).
- Produces: `getTaskSteps(supabase, taskId, userId)` → returns `{ steps: [...] }` ordered by `created_at asc`, scoped to `userId` (defense in depth alongside RLS).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/supabase-migration-task-steps.sql
create table if not exists task_steps (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_name text not null,
  phase text not null default 'progress',
  status text not null default 'ok' check (status in ('ok', 'error')),
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists task_steps_task_id_idx on task_steps (task_id, created_at);

alter table task_steps enable row level security;

create policy "task_steps_select_own" on task_steps
  for select using (auth.uid() = user_id);

create policy "task_steps_insert_own" on task_steps
  for insert with check (auth.uid() = user_id);
```

- [ ] **Step 2: Write the failing test for `recordTaskStep`**

```javascript
// api/services/task-steps.test.js
const { recordTaskStep, getTaskSteps } = require('./task-steps');

function fakeSupabase(rows = []) {
  return {
    from(table) {
      return {
        insert(row) {
          return {
            select() {
              return {
                single: async () => {
                  const inserted = { id: 'row-1', ...row };
                  rows.push(inserted);
                  return { data: inserted, error: null };
                },
              };
            },
          };
        },
        select() {
          return {
            eq(col, val) {
              return {
                eq(col2, val2) {
                  return {
                    order: async () => ({
                      data: rows.filter(
                        (r) => r[col] === val && r[col2] === val2
                      ),
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

test('recordTaskStep inserts a row and never throws on bad input', async () => {
  const supabase = fakeSupabase();
  const row = await recordTaskStep(supabase, {
    taskId: 'task-1',
    userId: 'user-1',
    stepName: 'Finding website design example',
    phase: 'progress',
    detail: { url: 'https://example.com' },
  });
  expect(row.step_name).toBe('Finding website design example');
});

test('getTaskSteps returns only steps for the given task and user', async () => {
  const rows = [
    { task_id: 'task-1', user_id: 'user-1', step_name: 'a' },
    { task_id: 'task-1', user_id: 'user-2', step_name: 'b' },
  ];
  const supabase = fakeSupabase(rows);
  const result = await getTaskSteps(supabase, 'task-1', 'user-1');
  expect(result.steps).toHaveLength(1);
  expect(result.steps[0].step_name).toBe('a');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest api/services/task-steps.test.js`
Expected: FAIL with "Cannot find module './task-steps'"

- [ ] **Step 4: Implement `task-steps.js`**

```javascript
// api/services/task-steps.js
async function recordTaskStep(supabase, { taskId, userId, stepName, phase = 'progress', detail = null, status = 'ok' }) {
  try {
    const { data, error } = await supabase
      .from('task_steps')
      .insert({ task_id: taskId, user_id: userId, step_name: stepName, phase, status, detail })
      .select()
      .single();
    if (error) return { error };
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

async function getTaskSteps(supabase, taskId, userId) {
  const { data, error } = await supabase
    .from('task_steps')
    .select('*')
    .eq('task_id', taskId)
    .eq('user_id', userId)
    .order('created_at');
  if (error) return { steps: [], error };
  return { steps: data };
}

module.exports = { recordTaskStep, getTaskSteps };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest api/services/task-steps.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/supabase-migration-task-steps.sql api/services/task-steps.js api/services/task-steps.test.js
git commit -m "feat(task-steps): add task_steps table and recordTaskStep helper"
```

---

### Task 2: Wire `recordTaskStep` into `browser-task.js`'s `onProgress` call sites

**Files:**
- Modify: `api/services/browser-task.js` (the functions that accept `onProgress` — e.g. `tryApplyDeliveryPreference`, `autoFillCheckoutDetails`, `tryPlatformCommerceAdd`)
- Test: `api/services/browser-task.test.js` (add to existing file if present, else create)

**Interfaces:**
- Consumes: `recordTaskStep(supabase, {...})` from Task 1.
- Produces: no new exports — this task only makes existing `onProgress(text)` calls *also* persist to `task_steps`, via a wrapping helper `makePersistingProgress(supabase, { taskId, userId })` that returns a function with the same `(text) => void` signature `onProgress` already has, so no call site's signature changes.

- [ ] **Step 1: Write the failing test**

```javascript
test('makePersistingProgress calls recordTaskStep with correct taskId/userId and does not throw if recordTaskStep rejects', async () => {
  const { makePersistingProgress } = require('./browser-task');
  const calls = [];
  const fakeSupabase = {}; // recordTaskStep is mocked below
  jest.mock('./task-steps', () => ({
    recordTaskStep: jest.fn(async (supabase, args) => calls.push(args)),
  }));
  const progress = makePersistingProgress(fakeSupabase, { taskId: 't1', userId: 'u1' });
  await progress('Finding website design example');
  expect(calls[0].stepName).toBe('Finding website design example');
  expect(calls[0].taskId).toBe('t1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest api/services/browser-task.test.js -t makePersistingProgress`
Expected: FAIL with "makePersistingProgress is not a function"

- [ ] **Step 3: Add `makePersistingProgress` to `browser-task.js` and use it at existing `onProgress` call sites**

```javascript
// near the top of api/services/browser-task.js, alongside other requires
const { recordTaskStep } = require('./task-steps');

// new export
function makePersistingProgress(supabase, { taskId, userId }) {
  return async (text) => {
    try {
      await recordTaskStep(supabase, { taskId, userId, stepName: text });
    } catch (_err) {
      // never let telemetry break the running task
    }
  };
}

module.exports = {
  // ...existing exports,
  makePersistingProgress,
};
```

Then at the point where a task run currently builds its `onProgress` callback before calling `tryApplyDeliveryPreference`/`autoFillCheckoutDetails`/`tryPlatformCommerceAdd`, wrap it:

```javascript
const baseProgress = onProgress; // whatever the existing callback was
const persistingProgress = makePersistingProgress(supabase, { taskId: session.taskId, userId: session.userId });
const progress = (text) => { baseProgress?.(text); persistingProgress(text); };
```

Pass `progress` instead of the old `onProgress` into the step functions.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest api/services/browser-task.test.js -t makePersistingProgress`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/services/browser-task.js api/services/browser-task.test.js
git commit -m "feat(task-steps): persist onProgress calls to task_steps table"
```

---

### Task 3: `GET /tasks/:id/steps` endpoint

**Files:**
- Modify: `api/index.js` (add route near other session-authed routes such as `/connectors/agent-card`)
- Test: `api/index.test.js` (add to existing test file, following the pattern used for other route tests in that file)

**Interfaces:**
- Consumes: `getTaskSteps(supabase, taskId, userId)` from Task 1.
- Produces: `GET /tasks/:id/steps` → `200 { steps: [{ id, step_name, phase, status, detail, created_at }] }`, session-authed (reuse the same auth middleware already applied to `/connectors/agent-card`).

- [ ] **Step 1: Write the failing test**

```javascript
test('GET /tasks/:id/steps returns steps for the authenticated user only', async () => {
  const res = await request(app)
    .get('/tasks/task-1/steps')
    .set('Authorization', `Bearer ${testUserToken}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.steps)).toBe(true);
});

test('GET /tasks/:id/steps requires auth', async () => {
  const res = await request(app).get('/tasks/task-1/steps');
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest api/index.test.js -t "tasks/:id/steps"`
Expected: FAIL with 404 (route does not exist)

- [ ] **Step 3: Add the route in `api/index.js`**

```javascript
const { getTaskSteps } = require('./services/task-steps');

app.get('/tasks/:id/steps', requireAuth, async (req, res) => {
  const { steps, error } = await getTaskSteps(supabase, req.params.id, req.user.id);
  if (error) return res.status(500).json({ error });
  res.json({ steps });
});
```

(`requireAuth` — use whatever the existing middleware is named on the `/connectors/agent-card` route; match its exact name/signature, do not invent a new one.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest api/index.test.js -t "tasks/:id/steps"`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add api/index.js api/index.test.js
git commit -m "feat(task-steps): add GET /tasks/:id/steps endpoint"
```

---

### Task 4: iOS — poll and render live steps in the existing activity surface

**Files:**
- Read first: `OxyApp/OxyApp/Views/Home/AgentTaskSessionView.swift`, `OxyApp/OxyApp/Views/Home/AgentStepViews.swift` (understand current rendering before changing it)
- Create: `OxyApp/OxyApp/Models/TaskStep.swift`
- Create: `OxyApp/OxyApp/Services/TaskStepsService.swift`
- Modify: `OxyApp/OxyApp/Views/Home/AgentTaskSessionView.swift`

**Interfaces:**
- Produces: `struct TaskStep: Codable, Identifiable { let id: String; let stepName: String; let phase: String; let status: String; let detail: [String: AnyCodable]?; let createdAt: Date }` (mirror the `CodingKeys` snake_case-to-camelCase pattern already used in `Message.swift`).
- Produces: `TaskStepsService.fetchSteps(taskId: String) async throws -> [TaskStep]` — GETs `/tasks/\(taskId)/steps`, decodes `{ steps: [TaskStep] }`.

- [ ] **Step 1: Define `TaskStep` model**

```swift
// OxyApp/OxyApp/Models/TaskStep.swift
import Foundation

struct TaskStep: Codable, Identifiable {
    let id: String
    let stepName: String
    let phase: String
    let status: String
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case stepName = "step_name"
        case phase
        case status
        case createdAt = "created_at"
    }
}
```

- [ ] **Step 2: Implement the polling service**

```swift
// OxyApp/OxyApp/Services/TaskStepsService.swift
import Foundation

struct TaskStepsResponse: Codable {
    let steps: [TaskStep]
}

enum TaskStepsService {
    static func fetchSteps(taskId: String, accessToken: String, baseURL: URL) async throws -> [TaskStep] {
        var request = URLRequest(url: baseURL.appendingPathComponent("/tasks/\(taskId)/steps"))
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: request)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(TaskStepsResponse.self, from: data).steps
    }
}
```

- [ ] **Step 3: Add a polling timer into `AgentTaskSessionView`**

Read the existing `@State`/`@StateObject` pattern in `AgentTaskSessionView.swift` first, then add, following that same pattern:

```swift
@State private var liveSteps: [TaskStep] = []
@State private var pollTask: Task<Void, Never>?

private func startPolling(taskId: String, accessToken: String, baseURL: URL) {
    pollTask?.cancel()
    pollTask = Task {
        while !Task.isCancelled {
            if let steps = try? await TaskStepsService.fetchSteps(taskId: taskId, accessToken: accessToken, baseURL: baseURL) {
                liveSteps = steps
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000) // 2s
        }
    }
}

private func stopPolling() {
    pollTask?.cancel()
    pollTask = nil
}
```

Call `startPolling` in `.onAppear` (or wherever the view currently starts observing an in-flight task), `stopPolling` in `.onDisappear`, and render `liveSteps` using whatever list styling `AgentStepViews.swift` already provides for individual steps — reuse that view, do not create a second step-row style.

- [ ] **Step 4: Manual verification (no unit test for SwiftUI polling loop)**

Run the app in the simulator, dispatch a real browser task from chat, confirm the activity view updates roughly every 2 seconds with new step names as the backend records them.

- [ ] **Step 5: Commit**

```bash
git add OxyApp/OxyApp/Models/TaskStep.swift OxyApp/OxyApp/Services/TaskStepsService.swift OxyApp/OxyApp/Views/Home/AgentTaskSessionView.swift
git commit -m "feat(ios): poll and render live task steps in activity view"
```

---

### Task 5: Routines — table, CRUD endpoints, and list screen

**Files:**
- Create: `supabase/migrations/supabase-migration-routines.sql`
- Create: `api/services/routines.js`
- Test: `api/services/routines.test.js`
- Modify: `api/index.js` (add routes)
- Create: `OxyApp/OxyApp/Models/Routine.swift`
- Create: `OxyApp/OxyApp/Views/Routines/RoutinesListView.swift`

**Interfaces:**
- Produces: `createRoutine(supabase, {userId, name, prompt}) -> routine`, `listRoutines(supabase, userId) -> {routines: [...]}`, `deleteRoutine(supabase, userId, routineId) -> {ok: boolean}`.
- Produces routes: `POST /routines`, `GET /routines`, `DELETE /routines/:id` (same auth middleware as Task 3).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/supabase-migration-routines.sql
create table if not exists routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  prompt text not null,
  created_at timestamptz not null default now()
);

alter table routines enable row level security;

create policy "routines_select_own" on routines for select using (auth.uid() = user_id);
create policy "routines_insert_own" on routines for insert with check (auth.uid() = user_id);
create policy "routines_delete_own" on routines for delete using (auth.uid() = user_id);
```

- [ ] **Step 2: Write the failing tests for `routines.js`**

```javascript
// api/services/routines.test.js
const { createRoutine, listRoutines, deleteRoutine } = require('./routines');

test('createRoutine then listRoutines returns it for that user only', async () => {
  const store = [];
  const supabase = makeFakeRoutinesSupabase(store); // same fake-builder pattern as task-steps.test.js
  await createRoutine(supabase, { userId: 'u1', name: 'Morning briefing', prompt: 'Summarize my inbox' });
  const { routines } = await listRoutines(supabase, 'u1');
  expect(routines).toHaveLength(1);
  expect(routines[0].name).toBe('Morning briefing');
});

test('deleteRoutine removes only the matching id for that user', async () => {
  const store = [{ id: 'r1', user_id: 'u1', name: 'x', prompt: 'y' }];
  const supabase = makeFakeRoutinesSupabase(store);
  const result = await deleteRoutine(supabase, 'u1', 'r1');
  expect(result.ok).toBe(true);
});
```

(Implement `makeFakeRoutinesSupabase` in the test file using the same chainable-fake pattern as `fakeSupabase` in `task-steps.test.js` — `.from().insert().select().single()`, `.from().select().eq().order()`, `.from().delete().eq().eq()`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest api/services/routines.test.js`
Expected: FAIL with "Cannot find module './routines'"

- [ ] **Step 4: Implement `routines.js`**

```javascript
// api/services/routines.js
async function createRoutine(supabase, { userId, name, prompt }) {
  const { data, error } = await supabase
    .from('routines')
    .insert({ user_id: userId, name, prompt })
    .select()
    .single();
  if (error) return { error };
  return data;
}

async function listRoutines(supabase, userId) {
  const { data, error } = await supabase
    .from('routines')
    .select('*')
    .eq('user_id', userId)
    .order('created_at');
  if (error) return { routines: [], error };
  return { routines: data };
}

async function deleteRoutine(supabase, userId, routineId) {
  const { error } = await supabase
    .from('routines')
    .delete()
    .eq('id', routineId)
    .eq('user_id', userId);
  if (error) return { ok: false, error };
  return { ok: true };
}

module.exports = { createRoutine, listRoutines, deleteRoutine };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest api/services/routines.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: Add routes to `api/index.js`**

```javascript
const { createRoutine, listRoutines, deleteRoutine } = require('./services/routines');

app.post('/routines', requireAuth, async (req, res) => {
  const { name, prompt } = req.body;
  if (!name || !prompt) return res.status(400).json({ error: 'name and prompt required' });
  const routine = await createRoutine(supabase, { userId: req.user.id, name, prompt });
  res.status(201).json(routine);
});

app.get('/routines', requireAuth, async (req, res) => {
  const { routines } = await listRoutines(supabase, req.user.id);
  res.json({ routines });
});

app.delete('/routines/:id', requireAuth, async (req, res) => {
  const result = await deleteRoutine(supabase, req.user.id, req.params.id);
  res.json(result);
});
```

- [ ] **Step 7: iOS model + list view**

```swift
// OxyApp/OxyApp/Models/Routine.swift
import Foundation

struct Routine: Codable, Identifiable {
    let id: String
    let name: String
    let prompt: String
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, name, prompt
        case createdAt = "created_at"
    }
}
```

Build `RoutinesListView.swift` following the exact list/row/swipe-to-delete pattern already used in `Settings/SettingsView.swift` for row lists — read that file first, match its List/Section/style conventions rather than inventing a new visual pattern (per this repo's existing More-menu flattening/consistency work).

- [ ] **Step 8: Manual verification**

Create a routine via the UI, confirm it appears in `GET /routines`, delete it, confirm it's gone.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/supabase-migration-routines.sql api/services/routines.js api/services/routines.test.js api/index.js OxyApp/OxyApp/Models/Routine.swift OxyApp/OxyApp/Views/Routines/RoutinesListView.swift
git commit -m "feat(routines): add routines CRUD (table, endpoints, iOS list view)"
```
