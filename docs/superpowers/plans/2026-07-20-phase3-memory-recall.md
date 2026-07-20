# Phase 3: Personal Memory (Entity/Task Recall) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log `{task_id, site, entity_name, timestamp}` for every agent-run task that touches a named entity (a product, a candidate, a listing), and let the chat pipeline resolve vague references ("the candidate I opened yesterday") against that log before falling back to asking the user to clarify.

**Architecture:** A new `task_entities` table, written from the same places `browser-task.js` already extracts entity-like data for outcomes (e.g. `productName` in buy outcomes — see commit `d810e8d`). Resolution is a small, explicit keyword+recency heuristic wired into the chat pipeline ahead of `inferDeterministicAction` (`api/intent-router.js:203`) — not a semantic/embedding search. This is deliberately simple: it is a lookup over structured tags, not a language-understanding system, per the spec's explicit "entity/task recall, not full-content memory" scope decision.

**Tech Stack:** Node.js/Express (`api/`), Supabase/Postgres.

## Global Constraints

- Only agent-run tasks are logged — no manual-browsing capture exists or is added (there is no surface for it; out of scope per the spec's Non-goals).
- No raw page content is stored — only a short entity name/label string plus site and timestamp.
- Resolution is a regex/keyword heuristic against `task_entities`, not a new NLP/embedding pipeline — keep it simple and legible.

---

### Task 1: `task_entities` table + logging helper

**Files:**
- Create: `supabase/migrations/supabase-migration-task-entities.sql`
- Create: `api/services/task-entities.js`
- Test: `api/services/task-entities.test.js`

**Interfaces:**
- Produces: `recordTaskEntity(supabase, { taskId, userId, site, entityName, entityType })` → inserts a row (never throws — mirrors `recordTaskStep`'s defensive style from Phase 1).
- Produces: `findRecentEntity(supabase, userId, { keyword, sinceHours = 72 }) -> entity | null` — returns the most recent `task_entities` row for that user where `entity_name` or `entity_type` contains `keyword` (case-insensitive) and `created_at` is within `sinceHours`; `null` if none match.

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

create policy "task_entities_select_own" on task_entities for select using (auth.uid() = user_id);
create policy "task_entities_insert_own" on task_entities for insert with check (auth.uid() = user_id);
```

- [ ] **Step 2: Write the failing tests**

```javascript
// api/services/task-entities.test.js
const { recordTaskEntity, findRecentEntity } = require('./task-entities');

test('recordTaskEntity inserts a row', async () => {
  const store = [];
  const supabase = makeFakeEntitiesSupabase(store);
  await recordTaskEntity(supabase, { taskId: 't1', userId: 'u1', site: 'linkedin.com', entityName: 'Jane Doe', entityType: 'candidate' });
  expect(store).toHaveLength(1);
  expect(store[0].entity_name).toBe('Jane Doe');
});

test('findRecentEntity matches by keyword against entity_name or entity_type, most recent first', async () => {
  const now = new Date();
  const store = [
    { id: '1', user_id: 'u1', site: 'linkedin.com', entity_name: 'Jane Doe', entity_type: 'candidate', created_at: new Date(now - 1000 * 60 * 60 * 24).toISOString() },
    { id: '2', user_id: 'u1', site: 'linkedin.com', entity_name: 'John Smith', entity_type: 'candidate', created_at: new Date(now - 1000 * 60 * 60).toISOString() },
  ];
  const supabase = makeFakeEntitiesSupabase(store);
  const result = await findRecentEntity(supabase, 'u1', { keyword: 'candidate' });
  expect(result.entity_name).toBe('John Smith');
});

test('findRecentEntity returns null outside the sinceHours window', async () => {
  const store = [
    { id: '1', user_id: 'u1', site: 'x.com', entity_name: 'Old Thing', entity_type: 'candidate', created_at: new Date(Date.now() - 1000 * 60 * 60 * 200).toISOString() },
  ];
  const supabase = makeFakeEntitiesSupabase(store);
  const result = await findRecentEntity(supabase, 'u1', { keyword: 'candidate', sinceHours: 72 });
  expect(result).toBeNull();
});
```

(`makeFakeEntitiesSupabase` — same chainable-fake pattern as prior test files: `.from().insert()`, `.from().select().eq().order()` returning all rows for that user for in-memory filtering in `findRecentEntity`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest api/services/task-entities.test.js`
Expected: FAIL, module not found

- [ ] **Step 4: Implement `task-entities.js`**

```javascript
// api/services/task-entities.js
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
  const needle = keyword.toLowerCase();

  const match = data.find((row) => {
    const withinWindow = new Date(row.created_at).getTime() >= cutoff;
    const matchesKeyword =
      (row.entity_name || '').toLowerCase().includes(needle) ||
      (row.entity_type || '').toLowerCase().includes(needle);
    return withinWindow && matchesKeyword;
  });

  return match || null;
}

module.exports = { recordTaskEntity, findRecentEntity };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest api/services/task-entities.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/supabase-migration-task-entities.sql api/services/task-entities.js api/services/task-entities.test.js
git commit -m "feat(memory): add task_entities table and record/find helpers"
```

---

### Task 2: Wire entity capture into existing outcome-building code

**Files:**
- Modify: `api/services/browser-task.js` (wherever `productName` is already assembled for buy outcomes, per commit `d810e8d`)
- Test: `api/services/browser-task.test.js`

**Interfaces:**
- Consumes: `recordTaskEntity` from Task 1.
- Produces: no new exports; the existing buy-outcome-building code path additionally calls `recordTaskEntity(supabase, { taskId, userId, site, entityName: productName, entityType: 'product' })` once the outcome's `productName` is known.

- [ ] **Step 1: Write the failing test**

```javascript
test('a completed buy outcome with a productName also records a task_entities row', async () => {
  const calls = [];
  jest.mock('./task-entities', () => ({
    recordTaskEntity: jest.fn(async (supabase, args) => calls.push(args)),
  }));
  const { buildBuyOutcome } = require('./browser-task'); // exact function name: use whatever d810e8d actually named it
  await buildBuyOutcome({ /* minimal fixture matching that function's real signature */ });
  expect(calls[0].entityType).toBe('product');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest api/services/browser-task.test.js -t "task_entities row"`
Expected: FAIL

- [ ] **Step 3: Add the call**

Locate the exact function from commit `d810e8d` (`git show d810e8d -- api/services/browser-task.js`) that assembles `productName`/`price`/`colorOptions` on a buy outcome, and add immediately after `productName` is finalized:

```javascript
const { recordTaskEntity } = require('./task-entities');
// ...
await recordTaskEntity(supabase, {
  taskId: session.taskId,
  userId: session.userId,
  site: session.host, // whatever field already holds the site/host in this function
  entityName: productName,
  entityType: 'product',
});
```

Adjust field names (`session.taskId`, `session.host`, etc.) to match whatever the real local variable names are in that function — do not guess if they differ, read the function first.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest api/services/browser-task.test.js -t "task_entities row"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/services/browser-task.js api/services/browser-task.test.js
git commit -m "feat(memory): record product entity on completed buy outcomes"
```

---

### Task 3: Chat-pipeline resolution step

**Files:**
- Create: `api/services/entity-recall.js`
- Test: `api/services/entity-recall.test.js`
- Modify: `api/index.js` (chat handler, near line 6180 where `inferContextualDeterministicTurn`/`inferDeterministicAction` are called)

**Interfaces:**
- Produces: `extractReferentialPhrase(message) -> string | null` — regex-based, matches patterns like `"the (\w+) I (?:opened|saw|looked at) (yesterday|today|this morning|last week)"` and `"that (\w+)"`, returning the captured noun (`"candidate"`, `"product"`, etc.) as the keyword.
- Produces: `resolveEntityReference(supabase, userId, message) -> { entityName: string, site: string } | null` — calls `extractReferentialPhrase`, and if a keyword is found, calls `findRecentEntity` (Task 1) with that keyword; returns `null` if no phrase matched or no entity found (caller falls through to normal handling unchanged).

- [ ] **Step 1: Write the failing tests**

```javascript
// api/services/entity-recall.test.js
const { extractReferentialPhrase, resolveEntityReference } = require('./entity-recall');

test('extractReferentialPhrase matches "the X I opened yesterday" style phrases', () => {
  expect(extractReferentialPhrase('find the candidate I opened yesterday and prep interview notes')).toBe('candidate');
  expect(extractReferentialPhrase('what is the weather today')).toBeNull();
});

test('extractReferentialPhrase matches "that X" style phrases', () => {
  expect(extractReferentialPhrase('add that product to my list')).toBe('product');
});

test('resolveEntityReference returns null when no phrase matches', async () => {
  const result = await resolveEntityReference({}, 'u1', 'what time is it');
  expect(result).toBeNull();
});

test('resolveEntityReference returns the matched entity when a phrase and a stored entity both exist', async () => {
  jest.mock('./task-entities', () => ({
    findRecentEntity: jest.fn(async () => ({ entity_name: 'Jane Doe', site: 'linkedin.com' })),
  }));
  const result = await resolveEntityReference({}, 'u1', 'find the candidate I opened yesterday');
  expect(result.entityName).toBe('Jane Doe');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest api/services/entity-recall.test.js`
Expected: FAIL, module not found

- [ ] **Step 3: Implement `entity-recall.js`**

```javascript
// api/services/entity-recall.js
const { findRecentEntity } = require('./task-entities');

const OPENED_PATTERN = /\bthe (\w+) i (?:opened|saw|looked at|checked)\b/i;
const THAT_PATTERN = /\bthat (\w+)\b/i;

function extractReferentialPhrase(message) {
  const openedMatch = message.match(OPENED_PATTERN);
  if (openedMatch) return openedMatch[1].toLowerCase();
  const thatMatch = message.match(THAT_PATTERN);
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

- [ ] **Step 4: Run to verify pass**

Run: `npx jest api/services/entity-recall.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire into the chat handler**

In `api/index.js`, immediately before the existing call to `inferContextualDeterministicTurn(userId, message, settings, trace, {since})` (near line 6180), add:

```javascript
const { resolveEntityReference } = require('./services/entity-recall');
// ...
const resolvedEntity = await resolveEntityReference(supabase, userId, message);
if (resolvedEntity) {
  trace?.log?.('resolved_entity_reference', resolvedEntity); // use whatever the existing trace/logging call convention is in this handler
  message = message.replace(/\bthat \w+\b|\bthe \w+ i (?:opened|saw|looked at|checked)\b/i, `"${resolvedEntity.entityName}" (from ${resolvedEntity.site})`);
}
```

This rewrites the ambiguous phrase in-place before the message reaches `inferContextualDeterministicTurn`/`inferDeterministicAction`/the model, so no downstream code needs to know resolution happened.

- [ ] **Step 6: Commit**

```bash
git add api/services/entity-recall.js api/services/entity-recall.test.js api/index.js
git commit -m "feat(memory): resolve vague entity references against task_entities before routing"
```

---

### Task 4: iOS — surface recent entities near the activity feed

**Files:**
- Read first: `OxyApp/OxyApp/Views/Home/AgenticHomeView.swift`
- Create: `OxyApp/OxyApp/Models/RecentEntity.swift`
- Modify: `OxyApp/OxyApp/Views/Home/AgenticHomeView.swift`

**Interfaces:**
- Produces: `GET /memory/recent-entities` endpoint (add to `api/index.js`, same auth pattern) returning the 10 most recent `task_entities` rows for the user, reusing `findRecentEntity`'s underlying query shape but without a keyword filter (add a small `listRecentEntities(supabase, userId, limit)` to `task-entities.js` for this — same file, same test file, same fake-supabase pattern as Task 1).
- Produces: `struct RecentEntity: Codable, Identifiable { let id: String; let entityName: String; let site: String; let createdAt: Date }`.

- [ ] **Step 1: Add `listRecentEntities` to `task-entities.js` with a test, following Task 1's exact TDD pattern (write failing test, implement, verify pass).**

- [ ] **Step 2: Add `GET /memory/recent-entities` route to `api/index.js`, following Task 3 of Phase 1's route pattern exactly (auth middleware, JSON response, test in `api/index.test.js`).**

- [ ] **Step 3: Add a small "Recently touched" strip to `AgenticHomeView.swift`** — read the file first to find where the existing bookmarks/"Work" strip (Gmail, Figma, WhatsApp, Vercel-style row) is rendered, and add a second, similarly-styled horizontal strip below it populated from `GET /memory/recent-entities`. Do not create a new full-screen surface for this — it is a small addition to an existing view per the spec's "not a new standalone screen" requirement.

- [ ] **Step 4: Manual verification**

Complete a buy task with a real product, confirm the product appears in the "Recently touched" strip; in chat, say "add that product to my list" and confirm the resolved entity reaches the intended flow.

- [ ] **Step 5: Commit**

```bash
git add api/services/task-entities.js api/services/task-entities.test.js api/index.js api/index.test.js OxyApp/OxyApp/Models/RecentEntity.swift OxyApp/OxyApp/Views/Home/AgenticHomeView.swift
git commit -m "feat(ios): surface recently touched entities on home"
```
