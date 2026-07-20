# Phase 3: Personal Memory (Entity/Task Recall) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision note (2026-07-20, before any task executed):** This file previously held a plan written in commit `607726e`, in the same pre-Phase-1 batch as Phase 2's original plan (which needed a full rewrite — see `docs/superpowers/plans/2026-07-20-phase2-credential-vault.md`'s revision note for that story). This version has the same class of problems and was corrected here, before implementation started, so a future session can execute directly: (1) Jest (`jest.mock`, `expect().toBe()`, `npx jest`) throughout — this repo uses `node --test` + `node:assert/strict`, tests in `test/smoke/*.test.js`. (2) Task 2's original design tried to record an entity using `session.taskId` from *inside* `runOrderingTurnImplInner` — but `taskId` is generated in the OUTER wrapper `runOrderingTurnImpl` and merged onto the outcome only after the inner function returns (confirmed by reading the current code — this is the exact same scope trap Phase 2 hit with `pendingCredentialTaskId`, and outcome fields returned in the middle of the inner loop, at the two spots `productName` is actually assembled, have no `taskId` in scope). Rewritten below to hook the outer wrapper instead. (3) Task 3 tried to reassign `message = message.replace(...)` — `message` is declared `const` in the chat handler (`api/index.js:3942`); reassigning it is a `TypeError`. Rewritten to introduce a separate variable instead. (4) Task 4 described "the existing bookmarks/'Work' strip (Gmail, Figma, WhatsApp, Vercel-style row)" in `AgenticHomeView.swift` — no such strip exists anywhere in that file. The only horizontal-scroll strip present is `suggestionRail` (static prompt-suggestion capsules) — rewritten to model the new strip on that instead. (5) The route task used `requireAuth`/no-auth patterns instead of this repo's actual `requireSessionAuth` + `getAuthenticatedUserId` convention (used consistently by every route added in Phase 1 and Phase 2).

**Goal:** Log `{task_id, site, entity_name, timestamp}` for every agent-run task that touches a named entity (a product, a candidate, a listing), and let the chat pipeline resolve vague references ("the candidate I opened yesterday") against that log before falling back to asking the user to clarify.

**Architecture:** A new `task_entities` table, written from the outer `runOrderingTurnImpl` wrapper in `api/services/browser-task.js` (not the inner per-step loop — see Revision note) whenever a turn's outcome already carries a `productName` (added in commit `d810e8d`, confirmed still present in the current code). Resolution is a small, explicit keyword+recency heuristic wired into the chat handler in `api/index.js`, immediately before the existing `inferContextualDeterministicTurn`/`inferDeterministicAction` calls — not a semantic/embedding search. This is deliberately simple: a lookup over structured tags, not a language-understanding system, per the design doc's explicit "entity/task recall, not full-content memory" scope decision.

**Tech Stack:** Node.js/Express (`api/`), Supabase/Postgres, SwiftUI (`OxyApp/OxyApp/Views/Home`).

## Global Constraints

- Follow existing migration naming: `supabase/migrations/supabase-migration-<feature-slug>.sql`, no numeric prefix.
- Test runner is `node --test` over `test/smoke/*.test.js`, using `node:assert/strict` and `node:test` — **not Jest**. No `supertest` dependency exists; new routes get a service-layer test plus a manual curl/code-inspection verification step, not an HTTP integration test (established precedent since Phase 1's Task 3).
- Auth middleware is `requireSessionAuth` (sets `req.auth.userId`) + `getAuthenticatedUserId(req)`, both from root `auth.js`. Use this pair for the new route — do NOT follow the older, unauthenticated `/memory/:userId` route family already in `api/index.js` (`app.get('/memory/:userId', ...)` etc., no auth middleware, userId taken from the URL) — that's legacy code from before the session-auth convention existed, not the pattern to extend. The new route lives at `/memory/recent-entities` (userId from the session, not the URL) to avoid any confusion with that older family.
- Only agent-run tasks are logged — no manual-browsing capture exists or is added (there is no surface for it; out of scope per the design doc's Non-goals).
- No raw page content is stored — only a short entity name/label string plus site and timestamp.
- Resolution is a regex/keyword heuristic against `task_entities`, not a new NLP/embedding pipeline — keep it simple and legible.
- `npm test` must be green before every commit. Never `git add -A`/`git add .` — stage explicit paths only, check `git status` before committing. Work directly on `main`, no feature branches.
- New Supabase migrations must NOT be applied to the live "Oxy" project (`zxfpwuuhwmmzlfhbcdiw`) without asking the user first, even inside an otherwise-autonomous run.
- No AI-isms in UI copy; SF Symbols banned in iOS (real bundled assets only) — same rules as every prior phase.

---

### Task 1: `task_entities` table + record/find/list helpers

**Files:**
- Create: `supabase/migrations/supabase-migration-task-entities.sql`
- Create: `api/services/task-entities.js`
- Test: `test/smoke/task-entities.test.js`

**Interfaces:**
- Produces: `recordTaskEntity(supabase, { taskId, userId, site, entityName, entityType = null }) -> row | {error}` (never throws — mirrors `recordTaskStep`'s defensive style from Phase 1).
- Produces: `findRecentEntity(supabase, userId, { keyword, sinceHours = 72 }) -> entity | null` — the most recent `task_entities` row for that user where `entity_name` or `entity_type` contains `keyword` (case-insensitive) and `created_at` is within `sinceHours`; `null` if none match.
- Produces: `listRecentEntities(supabase, userId, limit = 10) -> { entities: [...] }` — the `limit` most recent rows for that user, no keyword filter (used by Task 4's route).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/supabase-migration-task-entities.sql
create table if not exists task_entities (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  site text not null,
  entity_name text not null,
  entity_type text,
  created_at timestamptz not null default now()
);

create index if not exists task_entities_user_created_idx on task_entities (user_id, created_at desc);

alter table task_entities enable row level security;

create policy "task_entities_select_own" on task_entities
  for select using (auth.uid() = user_id);

create policy "task_entities_insert_own" on task_entities
  for insert with check (auth.uid() = user_id);
```

- [ ] **Step 2: Write the failing tests**

```javascript
// test/smoke/task-entities.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { recordTaskEntity, findRecentEntity, listRecentEntities } = require('../../api/services/task-entities');

function fakeSupabase(rows = []) {
  return {
    from(table) {
      return {
        insert(row) {
          return {
            select() {
              return {
                single: async () => {
                  const inserted = { id: `ent-${rows.length + 1}`, created_at: new Date().toISOString(), ...row };
                  rows.push(inserted);
                  return { data: inserted, error: null };
                }
              };
            }
          };
        },
        select() {
          return {
            eq(col, val) {
              return {
                order: async () => ({
                  data: rows.filter((r) => r[col] === val).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
                  error: null
                })
              };
            }
          };
        }
      };
    }
  };
}

test('recordTaskEntity inserts a row', async () => {
  const rows = [];
  const supabase = fakeSupabase(rows);
  const result = await recordTaskEntity(supabase, { taskId: 't1', userId: 'u1', site: 'linkedin.com', entityName: 'Jane Doe', entityType: 'candidate' });
  assert.equal(rows.length, 1);
  assert.equal(result.entity_name, 'Jane Doe');
});

test('recordTaskEntity never throws even when the supabase client blows up', async () => {
  const brokenSupabase = { from() { throw new Error('boom'); } };
  const result = await recordTaskEntity(brokenSupabase, { taskId: 't1', userId: 'u1', site: 'x.com', entityName: 'y' });
  assert.ok(result.error, 'expected an error field instead of a thrown exception');
});

test('findRecentEntity matches by keyword against entity_name or entity_type, most recent first', async () => {
  const now = Date.now();
  const rows = [
    { id: '1', user_id: 'u1', site: 'linkedin.com', entity_name: 'Jane Doe', entity_type: 'candidate', created_at: new Date(now - 1000 * 60 * 60 * 24).toISOString() },
    { id: '2', user_id: 'u1', site: 'linkedin.com', entity_name: 'John Smith', entity_type: 'candidate', created_at: new Date(now - 1000 * 60 * 60).toISOString() }
  ];
  const supabase = fakeSupabase(rows);
  const result = await findRecentEntity(supabase, 'u1', { keyword: 'candidate' });
  assert.equal(result.entity_name, 'John Smith');
});

test('findRecentEntity returns null outside the sinceHours window', async () => {
  const rows = [
    { id: '1', user_id: 'u1', site: 'x.com', entity_name: 'Old Thing', entity_type: 'candidate', created_at: new Date(Date.now() - 1000 * 60 * 60 * 200).toISOString() }
  ];
  const supabase = fakeSupabase(rows);
  const result = await findRecentEntity(supabase, 'u1', { keyword: 'candidate', sinceHours: 72 });
  assert.equal(result, null);
});

test('findRecentEntity returns null when no row matches the keyword', async () => {
  const rows = [
    { id: '1', user_id: 'u1', site: 'x.com', entity_name: 'A Sofa', entity_type: 'product', created_at: new Date().toISOString() }
  ];
  const supabase = fakeSupabase(rows);
  const result = await findRecentEntity(supabase, 'u1', { keyword: 'candidate' });
  assert.equal(result, null);
});

test('listRecentEntities returns up to limit rows for that user, most recent first', async () => {
  const now = Date.now();
  const rows = [
    { id: '1', user_id: 'u1', site: 'x.com', entity_name: 'Old', entity_type: 'product', created_at: new Date(now - 3000).toISOString() },
    { id: '2', user_id: 'u1', site: 'x.com', entity_name: 'New', entity_type: 'product', created_at: new Date(now - 1000).toISOString() },
    { id: '3', user_id: 'u2', site: 'x.com', entity_name: 'OtherUser', entity_type: 'product', created_at: new Date(now).toISOString() }
  ];
  const supabase = fakeSupabase(rows);
  const { entities } = await listRecentEntities(supabase, 'u1', 10);
  assert.equal(entities.length, 2);
  assert.equal(entities[0].entity_name, 'New');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/smoke/task-entities.test.js`
Expected: FAIL with "Cannot find module '../../api/services/task-entities'"

- [ ] **Step 4: Implement `task-entities.js`**

```javascript
'use strict';

// Personal-memory entity/task recall (Phase 3 of the aside-parity roadmap). Logs a short
// {task_id, site, entity_name, entity_type, timestamp} row for entities the AGENT touches
// while running a task (a product, a candidate, a listing) — never manual browsing (no
// surface for that in this product) and never raw page content, only a label string. Mirrors
// task-steps.js's never-throw contract: this is best-effort telemetry, never allowed to break
// the task it's recording.

async function recordTaskEntity(supabase, { taskId, userId, site, entityName, entityType = null }) {
  try {
    const { data, error } = await supabase
      .from('task_entities')
      .insert({ task_id: taskId, user_id: userId, site, entity_name: entityName, entity_type: entityType })
      .select()
      .single();
    if (error) return { error };
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

async function findRecentEntity(supabase, userId, { keyword, sinceHours = 72 }) {
  const { data, error } = await supabase
    .from('task_entities')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error || !data) return null;

  const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
  const needle = String(keyword || '').toLowerCase();
  if (!needle) return null;

  const match = data.find((row) => {
    const withinWindow = new Date(row.created_at).getTime() >= cutoff;
    const matchesKeyword =
      (row.entity_name || '').toLowerCase().includes(needle) ||
      (row.entity_type || '').toLowerCase().includes(needle);
    return withinWindow && matchesKeyword;
  });

  return match || null;
}

async function listRecentEntities(supabase, userId, limit = 10) {
  const { data, error } = await supabase
    .from('task_entities')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error || !data) return { entities: [] };
  return { entities: data.slice(0, limit) };
}

module.exports = { recordTaskEntity, findRecentEntity, listRecentEntities };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/smoke/task-entities.test.js`
Expected: PASS (6 tests)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all prior tests pass, plus the 6 new ones.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/supabase-migration-task-entities.sql api/services/task-entities.js test/smoke/task-entities.test.js
git commit -m "feat(memory): add task_entities table and record/find/list helpers"
```

---

### Task 2: Wire entity capture into the outer ordering-turn wrapper

**Files:**
- Modify: `api/services/browser-task.js`
- Test: `test/smoke/browser-task-entity-capture.test.js`

**Interfaces:**
- Consumes: `recordTaskEntity` from `./task-entities` (Task 1).
- Produces: no new exports — `runOrderingTurnImpl` (the outer wrapper that already generates `taskId` and merges it onto the outcome — see `api/services/browser-task.js`, the function containing `const taskId = randomUUID();`) additionally fires `recordTaskEntity` when the returned outcome is `'done'` or `'ready_for_payment'` and carries a `productName`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/smoke/browser-task-entity-capture.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

// This task's logic lives inline in runOrderingTurnImpl, which is not itself unit-testable
// without a live browser session (same constraint as makePersistingProgress before it — see
// Phase 1's Task 2, which tested the wrapper helper directly instead of the whole turn). So
// this test targets the extracted decision function below, not the full turn.
const { shouldRecordEntity } = require('../../api/services/browser-task');

test('shouldRecordEntity is true for a done outcome with a productName', () => {
  assert.equal(shouldRecordEntity({ type: 'done', productName: 'Blue Sofa' }), true);
});

test('shouldRecordEntity is true for a ready_for_payment outcome with a productName', () => {
  assert.equal(shouldRecordEntity({ type: 'ready_for_payment', productName: 'Blue Sofa' }), true);
});

test('shouldRecordEntity is false without a productName', () => {
  assert.equal(shouldRecordEntity({ type: 'done' }), false);
});

test('shouldRecordEntity is false for other outcome types even with a productName-shaped field', () => {
  assert.equal(shouldRecordEntity({ type: 'ask', productName: 'Blue Sofa' }), false);
  assert.equal(shouldRecordEntity({ type: 'error', productName: 'Blue Sofa' }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-task-entity-capture.test.js`
Expected: FAIL — `shouldRecordEntity is not a function` (not yet exported)

- [ ] **Step 3: Add the entity-capture call to `runOrderingTurnImpl`**

Find this exact block in `api/services/browser-task.js` (verify it matches — Phase 2 already modified this function, so re-read it before editing rather than assuming the pre-Phase-2 shape):

```javascript
async function runOrderingTurnImpl(userId, { url, goal, location = null, onProgress: rawOnProgress = () => {}, credentialSites = [] }) {
  const taskId = randomUUID();
  const persistingProgress = makePersistingProgress(getSupabase(), { taskId, userId });
  const onProgress = (text) => {
    rawOnProgress?.(text);
    persistingProgress(text);
  };
  const outcome = await runOrderingTurnImplInner(userId, { url, goal, location, onProgress, credentialSites });
  if (outcome.type === 'ready_for_credential_use') {
    const session = getSession(userId);
    if (session) session.pendingCredentialTaskId = taskId;
  }
  return { ...outcome, taskId };
}
```

Add a `shouldRecordEntity` helper near the top of the payment/credential section of this file (anywhere at module scope is fine — place it just above `runOrderingTurnImpl` for locality) and call it from the wrapper:

```javascript
// Personal-memory entity capture (Phase 3) — fires here, in the OUTER wrapper, not inside
// runOrderingTurnImplInner: taskId is only known here (generated above), and the two spots
// deep in the inner loop where productName is actually assembled have no taskId in scope.
// Fire-and-forget-but-safe: recordTaskEntity never throws (task-entities.js's contract), so
// this can never turn a successful turn into a reported failure.
function shouldRecordEntity(outcome) {
  return (outcome?.type === 'done' || outcome?.type === 'ready_for_payment') && Boolean(outcome?.productName);
}

async function runOrderingTurnImpl(userId, { url, goal, location = null, onProgress: rawOnProgress = () => {}, credentialSites = [] }) {
  const taskId = randomUUID();
  const persistingProgress = makePersistingProgress(getSupabase(), { taskId, userId });
  const onProgress = (text) => {
    rawOnProgress?.(text);
    persistingProgress(text);
  };
  const outcome = await runOrderingTurnImplInner(userId, { url, goal, location, onProgress, credentialSites });
  if (outcome.type === 'ready_for_credential_use') {
    const session = getSession(userId);
    if (session) session.pendingCredentialTaskId = taskId;
  }
  if (shouldRecordEntity(outcome)) {
    const site = getSession(userId)?.site || 'unknown';
    await recordTaskEntity(getSupabase(), {
      taskId,
      userId,
      site,
      entityName: outcome.productName,
      entityType: 'product'
    });
  }
  return { ...outcome, taskId };
}
```

Add the import near the top of the file, alongside the other Phase 1/2 service imports (find `const { recordTaskStep } = require('./task-steps');` and add directly below it):

```javascript
const { recordTaskEntity } = require('./task-entities');
```

Then add `shouldRecordEntity,` to the existing `module.exports` list (alongside `makePersistingProgress,`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/smoke/browser-task-entity-capture.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass, including the 4 new ones. No regression expected — this is a pure addition to the wrapper, not the inner loop, so it carries none of Phase 2 Task 4's additivity risk.

- [ ] **Step 6: Commit**

```bash
git add api/services/browser-task.js test/smoke/browser-task-entity-capture.test.js
git commit -m "feat(memory): record product entity from the outer ordering-turn wrapper"
```

---

### Task 3: Chat-pipeline resolution step

**Files:**
- Create: `api/services/entity-recall.js`
- Test: `test/smoke/entity-recall.test.js`
- Modify: `api/index.js` (chat handler)

**Interfaces:**
- Consumes: `findRecentEntity` from `./task-entities` (Task 1).
- Produces: `extractReferentialPhrase(message) -> string | null` — regex-based, matches `"the (\w+) I (?:opened|saw|looked at|checked) (?:yesterday|today|this morning|last week)"`-style phrasing and `"that (\w+)"`, returning the captured noun (`"candidate"`, `"product"`, etc.) as the keyword.
- Produces: `resolveEntityReference(supabase, userId, message) -> { entityName: string, site: string } | null` — calls `extractReferentialPhrase`; if a keyword is found, calls `findRecentEntity` with it; returns `null` if no phrase matched or no entity found (caller falls through to normal handling unchanged).

- [ ] **Step 1: Write the failing tests**

```javascript
// test/smoke/entity-recall.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { extractReferentialPhrase, resolveEntityReference } = require('../../api/services/entity-recall');

test('extractReferentialPhrase matches "the X I opened yesterday" style phrases', () => {
  assert.equal(extractReferentialPhrase('find the candidate I opened yesterday and prep interview notes'), 'candidate');
  assert.equal(extractReferentialPhrase('what is the weather today'), null);
});

test('extractReferentialPhrase matches "that X" style phrases', () => {
  assert.equal(extractReferentialPhrase('add that product to my list'), 'product');
});

test('extractReferentialPhrase returns null for ordinary messages', () => {
  assert.equal(extractReferentialPhrase('order a medium black t-shirt from Rothys'), null);
});

test('resolveEntityReference returns null when no phrase matches', async () => {
  const result = await resolveEntityReference({}, 'u1', 'what time is it');
  assert.equal(result, null);
});

test('resolveEntityReference returns null when a phrase matches but no entity is found', async () => {
  const supabase = {
    from() {
      return { select() { return { eq() { return { order: async () => ({ data: [], error: null }) }; } }; } };
    }
  };
  const result = await resolveEntityReference(supabase, 'u1', 'add that product to my list');
  assert.equal(result, null);
});

test('resolveEntityReference returns the matched entity when a phrase and a stored entity both exist', async () => {
  const rows = [{ user_id: 'u1', entity_name: 'Jane Doe', entity_type: 'candidate', site: 'linkedin.com', created_at: new Date().toISOString() }];
  const supabase = {
    from() {
      return {
        select() {
          return { eq(col, val) { return { order: async () => ({ data: rows.filter((r) => r[col] === val), error: null }) }; } };
        }
      };
    }
  };
  const result = await resolveEntityReference(supabase, 'u1', 'find the candidate I opened yesterday');
  assert.equal(result.entityName, 'Jane Doe');
  assert.equal(result.site, 'linkedin.com');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/smoke/entity-recall.test.js`
Expected: FAIL with "Cannot find module '../../api/services/entity-recall'"

- [ ] **Step 3: Implement `entity-recall.js`**

```javascript
'use strict';

const { findRecentEntity } = require('./task-entities');

const OPENED_PATTERN = /\bthe (\w+) i (?:opened|saw|looked at|checked)\b/i;
const THAT_PATTERN = /\bthat (\w+)\b/i;

function extractReferentialPhrase(message) {
  const text = String(message || '');
  const openedMatch = text.match(OPENED_PATTERN);
  if (openedMatch) return openedMatch[1].toLowerCase();
  const thatMatch = text.match(THAT_PATTERN);
  if (thatMatch) return thatMatch[1].toLowerCase();
  return null;
}

async function resolveEntityReference(supabase, userId, message) {
  const keyword = extractReferentialPhrase(message);
  if (!keyword) return null;
  const entity = await findRecentEntity(supabase, userId, { keyword });
  if (!entity) return null;
  return { entityName: entity.entity_name, site: entity.site };
}

module.exports = { extractReferentialPhrase, resolveEntityReference };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/smoke/entity-recall.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Wire into the chat handler**

`message` is declared `const` far upstream in this handler (`api/index.js`, search for `const message = (req.body.message || '').trim();`) — do NOT attempt to reassign it (that's a `TypeError`, and the source of a bug in this plan's original draft). Introduce a separate variable instead.

Find this exact block in `api/index.js` (search for `inferContextualDeterministicTurn(userId, message, settings, trace, {`):

```javascript
    const contextualTurn = await timedDev('chat', 'intent_classification.contextual', {}, () => inferContextualDeterministicTurn(userId, message, settings, trace, {
      since: chatStartedAt
    }));
```

Add the resolution step immediately before it, and thread the result into this call and the `inferDeterministicAction` call a few lines below:

```javascript
    const resolvedEntity = await resolveEntityReference(supabase, userId, message).catch(() => null);
    const routingMessage = resolvedEntity
      ? message.replace(/\bthat \w+\b|\bthe \w+ i (?:opened|saw|looked at|checked)\b/i, `"${resolvedEntity.entityName}" (from ${resolvedEntity.site})`)
      : message;

    const contextualTurn = await timedDev('chat', 'intent_classification.contextual', {}, () => inferContextualDeterministicTurn(userId, routingMessage, settings, trace, {
      since: chatStartedAt
    }));
```

Then find `const deterministicAction = contextualTurn || inferDeterministicAction(message, { settings });` a few lines below and change its `message` argument to `routingMessage`:

```javascript
    const deterministicAction = contextualTurn || inferDeterministicAction(routingMessage, { settings });
```

Before finalizing this step, grep this same handler function for every other use of the bare `message` variable AFTER this point (not before — code above the resolution step should keep seeing the original, unresolved text). If `message` is passed to the model prompt or logged/displayed later in the same turn in a way where the resolved entity name would give a better result (e.g. a model-facing prompt construction), thread `routingMessage` there too instead of `message`; if it's only used for things like echoing the user's literal words back in a transcript/history record, leave those as `message` — the resolution is meant for ROUTING, not for rewriting what the user is shown they said. Use judgment per this distinction; do not blanket-replace every occurrence.

Add the import near the top of `api/index.js`, alongside the Phase 1/2 service imports (find `const { createRoutine, listRoutines, deleteRoutine } = require('./services/routines');` and add directly below it):

```javascript
const { resolveEntityReference } = require('./services/entity-recall');
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all tests pass. Pay attention to any test file that exercises the chat handler's intent-routing path (search `test/smoke/` for tests referencing `inferContextualDeterministicTurn`/`inferDeterministicAction`/chat routing) — a `routingMessage` that isn't functionally identical to `message` for non-matching input would show up there. Since `resolveEntityReference` returns `null` (making `routingMessage === message`) for any input that doesn't match `extractReferentialPhrase`'s narrow patterns, no existing routing test should change behavior — confirm this rather than assume it.

- [ ] **Step 7: Commit**

```bash
git add api/services/entity-recall.js test/smoke/entity-recall.test.js api/index.js
git commit -m "feat(memory): resolve vague entity references against task_entities before routing"
```

---

### Task 4: `GET /memory/recent-entities` + iOS "Recently touched" strip

**Files:**
- Modify: `api/index.js` (add route)
- Read first: `OxyApp/OxyApp/Views/Home/AgenticHomeView.swift` — specifically the `suggestionRail` property (search for `private var suggestionRail`) — this is the ONLY existing horizontal-scroll strip in this file and is what the new strip should visually/structurally mirror. There is no "Gmail/Figma/WhatsApp" app-bookmark strip anywhere in this codebase; do not go looking for one.
- Create: `OxyApp/OxyApp/Models/RecentEntity.swift`
- Modify: `OxyApp/OxyApp/Views/Home/AgenticHomeView.swift`

**Interfaces:**
- Consumes: `listRecentEntities` from `api/services/task-entities.js` (Task 1).
- Produces route: `GET /memory/recent-entities` → `{ entities: [{id, entity_name, site, created_at}] }`, session-authed via `requireSessionAuth` + `getAuthenticatedUserId(req)` — do NOT follow the older unauthenticated `/memory/:userId` route family (see Global Constraints).
- Produces: `struct RecentEntity: Codable, Identifiable { let id: String; let entityName: String; let site: String; let createdAt: String }` (String, not Date, for `createdAt` — check how `TaskStep.swift` from Phase 1 handles this same shape, since that model made a specific choice here worth reusing rather than re-deciding).

- [ ] **Step 1: Add the route**

In `api/index.js`, add the import near the Task 1 imports (or wherever `task-entities` was required for Task 2/3 — reuse that import line, add `listRecentEntities` to its destructure rather than adding a second `require`):

```javascript
const { listRecentEntities } = require('./services/task-entities');
```

Add the route near the other Phase 1/2 routes (e.g. directly after `/vault/credentials` or `/routines` — anywhere in that cluster is fine):

```javascript
// Recently touched entities (Phase 3 of the aside-parity roadmap) — a light "what did the
// agent last work on" surface, not a search UI. Reuses task_entities written by
// api/services/browser-task.js's runOrderingTurnImpl.
app.get('/memory/recent-entities', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { entities } = await listRecentEntities(supabase, userId, 10);
    res.json({ entities });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all tests pass — Task 1's `listRecentEntities` tests already cover the underlying logic; this route gets manual/code-inspection verification only, per this repo's established no-supertest precedent (same as every other route added in Phase 1/2).

- [ ] **Step 3: Commit the backend half**

```bash
git add api/index.js
git commit -m "feat(memory): add GET /memory/recent-entities endpoint"
```

- [ ] **Step 4: Add the iOS model**

```swift
// OxyApp/OxyApp/Models/RecentEntity.swift
import Foundation

struct RecentEntity: Codable, Identifiable, Equatable {
    let id: String
    let entityName: String
    let site: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case entityName = "entity_name"
        case site
        case createdAt = "created_at"
    }
}
```

Before finalizing this, read `OxyApp/OxyApp/Models/TaskStep.swift` (from Phase 1) to confirm whether `createdAt` should be `String` or `Date` and whether it needs a custom parsing helper (`Date.oxyParse`, per Phase 1's ledger note) — match whatever convention that file established rather than re-deciding independently, since both models decode the same kind of Postgres `timestamptz` JSON field.

- [ ] **Step 5: Add the "Recently touched" strip to `AgenticHomeView.swift`**

Read `suggestionRail`'s full implementation first (already shown in this plan's Revision note context — re-read the live file, it may have shifted). Add a new, similarly-structured horizontal strip that fetches from `/memory/recent-entities` and renders each entity as a small pill/card (entity name + site), placed near `suggestionRail` in the view hierarchy (find where `suggestionRail` is actually used in the view `body`, and add the new strip as a sibling, not nested inside it). This is a small addition to an existing view, not a new full-screen surface, per the design doc's explicit "not a new standalone screen" requirement — do not create a new `View` file beyond the model in Step 4.

Fetch the entities via `APIClient.shared.request(path: "/memory/recent-entities")`, decode `{ entities: [RecentEntity] }`, and only render the strip when the array is non-empty (an empty strip is worse than no strip — omit it entirely rather than showing an empty-state placeholder here, since this is a lightweight ambient surface, not a primary screen).

- [ ] **Step 6: Add the new file to the Xcode project**

Same explicit-file-list requirement as every prior iOS task in this roadmap (Phase 1's Routines/TaskStep files, Phase 2's VaultView) — manually add `RecentEntity.swift` to `OxyApp/OxyApp.xcodeproj/project.pbxproj`, using an existing recently-added file (e.g. `Vault/VaultView.swift` from Phase 2) as the template for the exact PBXBuildFile/PBXFileReference/PBXGroup/PBXSourcesBuildPhase entries needed.

- [ ] **Step 7: Build**

Run: `xcodebuild -project OxyApp/OxyApp.xcodeproj -scheme OxyApp -destination 'platform=iOS Simulator,name=iPhone 16' build` (substitute whatever simulator is actually installed if `iPhone 16` isn't available, same as Phase 2's Task 5 had to).
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 8: Manual verification**

Complete a buy task with a real product, confirm a `task_entities` row is written (check via `GET /memory/recent-entities` or direct DB read once the migration is applied) and the product appears in the new strip; in chat, say "add that product to my list" and confirm `resolveEntityReference` picks it up (check via the `trace`/dev-timing logs this handler already produces, or add a temporary log statement during manual testing).

- [ ] **Step 9: Commit the iOS half**

```bash
git add OxyApp/OxyApp/Models/RecentEntity.swift OxyApp/OxyApp/Views/Home/AgenticHomeView.swift OxyApp/OxyApp.xcodeproj/project.pbxproj
git commit -m "feat(ios): surface recently touched entities on home"
```

---

### Task 5: Final whole-branch review

- [ ] Run `npm test` one final time and confirm the full count (baseline at the start of Phase 3 was whatever `main` is at when this plan is picked up — check `npm test`'s reported count before Task 1 and compare).
- [ ] Dispatch a final review subagent (per `superpowers:subagent-driven-development`) covering the whole diff since Phase 2's last commit — spec compliance against this plan and the design doc's Phase 3 bullets, plus code quality. Use the most capable available model, same as Phase 1 and Phase 2's final reviews.
- [ ] Update the shared memory handoff note (find the current Phase-2-shipped memory file under `~/.claude/projects/-Users-chizigamonyewuchi-Documents-Oxy/memory/` and either rename it or add a new dated file) covering what Phase 3 shipped, any gaps, and that Phase 4 (Scheduling, Controls & Polish) is next. Update `MEMORY.md`'s index.
