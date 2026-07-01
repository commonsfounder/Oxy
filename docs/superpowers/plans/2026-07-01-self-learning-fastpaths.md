# Self-Learning Browser Fast-Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browser-task search-URL fast-path registry populate itself — capture a site's search-results URL template from the first successful manual search, reuse it on every later visit, and self-heal when it goes stale.

**Architecture:** A new focused module `api/services/browser-fastpaths.js` holds pure URL helpers (learn a template from a results URL; fill a template with a term) and an in-memory store backed by injected persistence (so the hot path never awaits the DB and the store is trivially testable). `browser-task.js` wires the store to Supabase, consults it in `directSearchUrl`, learns after a search navigation, and records success/failure for self-heal. Curated seeds stay in code (`SEARCH_SITES`); only *learned* rows live in a new global `browser_fastpaths` table.

**Tech Stack:** Node.js, Playwright, `@supabase/supabase-js`, `node:test`.

## Global Constraints

- Learn the durable thing only: query-string search-URL templates. Never learn selectors or click sequences.
- The LLM vision loop is always the fallback — a missing/stale/disabled template must degrade to today's behaviour (open the given url), never error.
- Store only templates with a `{{term}}` placeholder — never the user's actual search term.
- Learned patterns are shared/global (no user scoping) and contain no personal data.
- Self-heal: disable a template after `FAIL_DISABLE_THRESHOLD` (3) consecutive failures; a success resets the counter.
- Every env/DB touch is best-effort: a Supabase failure must never abort a turn.
- Curated `SEARCH_SITES` seeds take precedence over a learned entry for the same host.

---

### Task 1: Pure URL helpers (learn a template, apply a template)

**Files:**
- Create: `api/services/browser-fastpaths.js`
- Test: `test/smoke/browser-fastpaths.test.js`

**Interfaces:**
- Produces: `learnTemplateFromUrl(url: string, filledValue: string) → { host: string, param: string, template: string } | null`
- Produces: `applyTemplate(template: string, term: string) → string | null`
- Produces: constant `TERM = '{{term}}'`

- [ ] **Step 1: Write the failing test**

Create `test/smoke/browser-fastpaths.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { learnTemplateFromUrl, applyTemplate, TERM } = require('../../api/services/browser-fastpaths');

test('learnTemplateFromUrl derives a template from the param carrying the search term', () => {
  const jl = learnTemplateFromUrl('https://www.johnlewis.com/search?search-term=wool%20coat', 'wool coat');
  assert.deepEqual(jl, { host: 'johnlewis.com', param: 'search-term', template: `https://www.johnlewis.com/search?search-term=${TERM}` });

  const sf = learnTemplateFromUrl('https://www.selfridges.com/GB/en/cat/?freeText=wool%20coat&srch=Y', 'wool coat');
  assert.equal(sf.host, 'selfridges.com');
  assert.equal(sf.param, 'freeText');
  assert.equal(sf.template, `https://www.selfridges.com/GB/en/cat/?freeText=${TERM}&srch=Y`);
});

test('learnTemplateFromUrl returns null when the term is not a query param value', () => {
  assert.equal(learnTemplateFromUrl('https://x.com/product/12345', 'wool coat'), null); // term in path, not query
  assert.equal(learnTemplateFromUrl('https://x.com/?q=other', 'wool coat'), null);       // no matching param
  assert.equal(learnTemplateFromUrl('not a url', 'wool coat'), null);
  assert.equal(learnTemplateFromUrl('https://x.com/?q=a', 'a'), null);                    // term too short (<2)
});

test('applyTemplate fills the placeholder with an encoded term', () => {
  assert.equal(applyTemplate(`https://x.com/s?q=${TERM}`, "men's coat"), 'https://x.com/s?q=men\'s%20coat');
  assert.equal(applyTemplate('https://x.com/s?q=fixed', 'coat'), null); // no placeholder → null
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-fastpaths.test.js`
Expected: FAIL — "Cannot find module '../../api/services/browser-fastpaths'".

- [ ] **Step 3: Write minimal implementation**

Create `api/services/browser-fastpaths.js`:

```js
'use strict';
// Self-learning search-URL fast-paths.
// See docs/superpowers/specs/2026-07-01-self-learning-fastpaths-design.md
// Learns only the DURABLE thing — a site's search-results URL template — from the first
// successful manual search, so repeat visits skip the slow LLM loop. Never learns brittle
// selectors; the LLM loop is always the fallback, and a stale template self-heals.

const TERM = '{{term}}';
const FAIL_DISABLE_THRESHOLD = 3;

// Given a results URL and the text just typed into search, derive a reusable template
// (host + the query param that carried the term). Returns null unless the term is a
// query-param value — we only learn query-string search URLs in v1.
function learnTemplateFromUrl(url, filledValue) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const needle = String(filledValue || '').trim().toLowerCase();
  if (needle.length < 2) return null;
  for (const [key, val] of u.searchParams.entries()) {
    if (String(val).trim().toLowerCase() === needle) {
      const clone = new URL(u.toString());
      clone.searchParams.set(key, '__OXY_TERM__'); // sentinel has no special chars → stays literal
      return {
        host: u.hostname.replace(/^www\./, ''),
        param: key,
        template: clone.toString().replace('__OXY_TERM__', TERM)
      };
    }
  }
  return null;
}

// Fill a template with a real search term (URL-encoded). null if the template has no placeholder.
function applyTemplate(template, term) {
  if (!template || !template.includes(TERM)) return null;
  return template.replace(TERM, encodeURIComponent(String(term)));
}

module.exports = { learnTemplateFromUrl, applyTemplate, TERM, FAIL_DISABLE_THRESHOLD };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/smoke/browser-fastpaths.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add api/services/browser-fastpaths.js test/smoke/browser-fastpaths.test.js
git commit -m "feat(browser-task): pure URL-template learn/apply helpers"
```

---

### Task 2: In-memory fast-path store with self-heal

**Files:**
- Modify: `api/services/browser-fastpaths.js`
- Test: `test/smoke/browser-fastpaths.test.js`

**Interfaces:**
- Consumes: `applyTemplate`, `FAIL_DISABLE_THRESHOLD` (Task 1).
- Produces: `createFastpathStore({ loadRows?, saveRow? }) → { load(): Promise<void>, getLearnedSearchUrl(host, term): string|null, learn(host, param, template): boolean, recordOutcome(host, ok): void, _map: Map }`
  - `loadRows()` returns rows `{ host, url_template, param, fail_count }[]`.
  - `saveRow({ host, url_template, param, fail_count })` persists one row (best-effort, fire-and-forget).

- [ ] **Step 1: Write the failing test**

Append to `test/smoke/browser-fastpaths.test.js`:

```js
const { createFastpathStore, FAIL_DISABLE_THRESHOLD } = require('../../api/services/browser-fastpaths');

function fakePersistence() {
  const rows = new Map();
  return {
    rows,
    loadRows: async () => Array.from(rows.values()),
    saveRow: async (r) => { rows.set(r.host, { ...rows.get(r.host), ...r }); }
  };
}

test('store learns a template and serves it back applied', () => {
  const store = createFastpathStore(fakePersistence());
  assert.equal(store.learn('shop.com', 'q', `https://shop.com/s?q=${TERM}`), true);
  assert.equal(store.getLearnedSearchUrl('shop.com', 'wool coat'), 'https://shop.com/s?q=wool%20coat');
  assert.equal(store.getLearnedSearchUrl('other.com', 'x'), null); // unknown host
  assert.equal(store.learn('shop.com', 'q', `https://shop.com/s?q=${TERM}`), false); // unchanged → no-op
});

test('store disables a template after consecutive failures and re-enables on a learn', () => {
  const store = createFastpathStore(fakePersistence());
  store.learn('shop.com', 'q', `https://shop.com/s?q=${TERM}`);
  for (let i = 0; i < FAIL_DISABLE_THRESHOLD; i++) store.recordOutcome('shop.com', false);
  assert.equal(store.getLearnedSearchUrl('shop.com', 'coat'), null, 'disabled after 3 fails');
  store.learn('shop.com', 'q', `https://shop.com/search?q=${TERM}`); // relearn a fresh template
  assert.equal(store.getLearnedSearchUrl('shop.com', 'coat'), 'https://shop.com/search?q=coat');
});

test('store recordOutcome(ok=true) resets the failure streak', () => {
  const store = createFastpathStore(fakePersistence());
  store.learn('shop.com', 'q', `https://shop.com/s?q=${TERM}`);
  store.recordOutcome('shop.com', false);
  store.recordOutcome('shop.com', false);
  store.recordOutcome('shop.com', true); // reset
  store.recordOutcome('shop.com', false);
  assert.ok(store.getLearnedSearchUrl('shop.com', 'coat'), 'not disabled — streak was reset');
});

test('store load() hydrates the map from persisted rows and honours disabled state', async () => {
  const p = fakePersistence();
  p.rows.set('a.com', { host: 'a.com', url_template: `https://a.com/s?q=${TERM}`, param: 'q', fail_count: 0 });
  p.rows.set('b.com', { host: 'b.com', url_template: `https://b.com/s?q=${TERM}`, param: 'q', fail_count: FAIL_DISABLE_THRESHOLD });
  const store = createFastpathStore(p);
  await store.load();
  assert.equal(store.getLearnedSearchUrl('a.com', 'coat'), 'https://a.com/s?q=coat');
  assert.equal(store.getLearnedSearchUrl('b.com', 'coat'), null); // loaded as disabled
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-fastpaths.test.js`
Expected: FAIL — "createFastpathStore is not a function".

- [ ] **Step 3: Write minimal implementation**

In `api/services/browser-fastpaths.js`, add before `module.exports`:

```js
// In-memory store backed by injected persistence (loadRows/saveRow). The hot path
// (getLearnedSearchUrl) is synchronous and never awaits the DB; persistence is best-effort.
function createFastpathStore({ loadRows, saveRow } = {}) {
  const map = new Map(); // host -> { template, param, failCount, disabled }

  async function load() {
    if (!loadRows) return;
    try {
      const rows = await loadRows();
      for (const r of rows || []) {
        const failCount = r.fail_count || 0;
        map.set(r.host, { template: r.url_template, param: r.param, failCount, disabled: failCount >= FAIL_DISABLE_THRESHOLD });
      }
    } catch { /* boot-time load is best-effort; the loop works without it */ }
  }

  function getLearnedSearchUrl(host, term) {
    const e = map.get(host);
    if (!e || e.disabled) return null;
    return applyTemplate(e.template, term);
  }

  function persist(host) {
    if (!saveRow) return;
    const e = map.get(host);
    Promise.resolve(saveRow({ host, url_template: e.template, param: e.param, fail_count: e.failCount })).catch(() => {});
  }

  function learn(host, param, template) {
    const existing = map.get(host);
    if (existing && existing.template === template && !existing.disabled) return false; // already known
    map.set(host, { template, param, failCount: 0, disabled: false });
    persist(host);
    return true;
  }

  function recordOutcome(host, ok) {
    const e = map.get(host);
    if (!e) return;
    e.failCount = ok ? 0 : e.failCount + 1;
    e.disabled = e.failCount >= FAIL_DISABLE_THRESHOLD;
    persist(host);
  }

  return { load, getLearnedSearchUrl, learn, recordOutcome, _map: map };
}
```

Update the exports line to:

```js
module.exports = { learnTemplateFromUrl, applyTemplate, createFastpathStore, TERM, FAIL_DISABLE_THRESHOLD };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/smoke/browser-fastpaths.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add api/services/browser-fastpaths.js test/smoke/browser-fastpaths.test.js
git commit -m "feat(browser-task): in-memory fast-path store with self-heal"
```

---

### Task 3: Supabase persistence, migration, and boot load

**Files:**
- Create: `supabase-migration-fastpaths.sql`
- Modify: `api/services/browser-task.js` (wire the store + export `primeFastpaths`)
- Modify: `server.js` (call `primeFastpaths` on boot)
- Test: `test/smoke/browser-latency.test.js`

**Interfaces:**
- Consumes: `createFastpathStore` (Task 2), `getSupabase()` (existing in `browser-task.js`).
- Produces: module singleton `fastpathStore` (exported as `_fastpathStore` for tests) and `primeFastpaths(): Promise<void>` in `browser-task.js`.

- [ ] **Step 1: Write the migration**

Create `supabase-migration-fastpaths.sql`:

```sql
-- Global, self-learning browser search-URL fast-paths (api/services/browser-fastpaths.js).
-- One row per host; contains only generic URL templates (never user search terms). Shared
-- across all users. Safe to run repeatedly.
CREATE TABLE IF NOT EXISTS browser_fastpaths (
  host         text PRIMARY KEY,
  url_template text NOT NULL,
  param        text,
  fail_count   int  NOT NULL DEFAULT 0,
  last_ok_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Wire the store into browser-task.js**

In `api/services/browser-task.js`, add near the top (after the `require` of `../../runtime`):

```js
const { learnTemplateFromUrl, createFastpathStore } = require('./browser-fastpaths');
```

After the `getSupabase()` definition, add:

```js
// Self-learning fast-path store. loadRows/saveRow are Supabase-backed but best-effort — a DB
// hiccup never blocks a turn. Only LEARNED hosts live here; curated SEARCH_SITES stay in code.
const fastpathStore = createFastpathStore({
  loadRows: async () => {
    const { data } = await getSupabase().from('browser_fastpaths').select('host,url_template,param,fail_count');
    return data || [];
  },
  saveRow: async (row) => {
    await getSupabase().from('browser_fastpaths').upsert(
      { ...row, last_ok_at: row.fail_count === 0 ? new Date().toISOString() : undefined, updated_at: new Date().toISOString() },
      { onConflict: 'host' }
    );
  }
});

// Load the learned fast-paths into memory (call on server boot, alongside primeWarmBrowser).
async function primeFastpaths() { await fastpathStore.load(); }
```

Add both to `module.exports` (next to `primeWarmBrowser`):

```js
  primeWarmBrowser,
  primeFastpaths,
  _fastpathStore: fastpathStore,
```

- [ ] **Step 3: Call primeFastpaths on boot**

In `server.js`, inside the `server.listen` callback, extend the existing warm-pool line:

```js
    try {
      const bt = require('./api/services/browser-task');
      bt.primeWarmBrowser();
      bt.primeFastpaths();
    } catch { /* non-fatal */ }
```

(Replace the existing single `require('./api/services/browser-task').primeWarmBrowser();` line.)

- [ ] **Step 4: Write the wiring test**

Append to `test/smoke/browser-latency.test.js`:

```js
const bt = require('../../api/services/browser-task');

test('browser-task exposes the fast-path store and boot primer', () => {
  assert.equal(typeof bt.primeFastpaths, 'function');
  assert.ok(bt._fastpathStore && typeof bt._fastpathStore.getLearnedSearchUrl === 'function');
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/smoke/browser-latency.test.js`
Expected: PASS (existing + 1 new).

- [ ] **Step 6: Commit**

```bash
git add supabase-migration-fastpaths.sql api/services/browser-task.js server.js test/smoke/browser-latency.test.js
git commit -m "feat(browser-task): supabase-backed fast-path store + boot load"
```

---

### Task 4: Wire learning into the loop (consult, learn, self-heal)

**Files:**
- Modify: `api/services/browser-task.js` (`directSearchUrl`, `openNewSession`, the step loop, return paths)
- Test: `test/smoke/browser-latency.test.js`

**Interfaces:**
- Consumes: `fastpathStore.getLearnedSearchUrl/learn/recordOutcome`, `learnTemplateFromUrl`, existing `deriveSearchTerm`, `SEARCH_SITES`.
- Produces: `directSearchUrl` now returns a learned URL when no seed matches; session field `usedFastpath: string|null`.

- [ ] **Step 1: Write the failing test**

Append to `test/smoke/browser-latency.test.js` (`directSearchUrl` and `bt` are already required at the top of this file from earlier tasks — do NOT re-declare them):

```js
test('directSearchUrl uses a LEARNED template when no code seed matches', () => {
  // Nothing seeded for example-shop.com; teach the live store, then expect directSearchUrl to use it.
  bt._fastpathStore.learn('example-shop.com', 'q', 'https://example-shop.com/s?q={{term}}');
  const url = directSearchUrl('https://example-shop.com', 'find a wool coat and tell me the price');
  assert.equal(url, 'https://example-shop.com/s?q=wool%20coat');
});

test('directSearchUrl still returns null for a truly unknown host', () => {
  assert.equal(directSearchUrl('https://never-seen-this.example', 'find a wool coat'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-latency.test.js`
Expected: FAIL — learned host returns `null` (directSearchUrl doesn't consult the store yet).

- [ ] **Step 3: Extend directSearchUrl to consult the store**

In `api/services/browser-task.js`, replace the body of `directSearchUrl` after the pathname guard:

```js
  // Only short-circuit a homepage/root. If the url is already a deep link (a search,
  // product, or category page) the caller meant to land there — don't override it.
  if (parsed.pathname.replace(/\/+$/, '') !== '') return null;
  const host = parsed.hostname.replace(/^www\./, '');
  const site = SEARCH_SITES[host];
  // For a curated site, use its names to strip; otherwise strip using the host's brand word.
  const term = deriveSearchTerm(goal, site || { names: [host.split('.')[0]] });
  if (!term) return null;
  if (site) return site.searchUrl(term);          // curated seed wins
  return fastpathStore.getLearnedSearchUrl(host, term); // else a learned template, or null
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/smoke/browser-latency.test.js`
Expected: PASS.

- [ ] **Step 5: Track fast-path use in openNewSession**

In `openNewSession`, change the open-url block to record which host used a fast-path:

```js
  const directUrl = directSearchUrl(url, goal);
  const openUrl = directUrl || url;
  await timed('open.goto', () => page.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }));
```

Then in the `createSession({ ... })` call at the end of `openNewSession`, add the field:

```js
  usedFastpath: directUrl ? siteKeyFromUrl(url) : null,
```

- [ ] **Step 6: Learn after a search navigation, and record outcomes**

In the step loop of `runOrderingTurn`, immediately after the `await timed('step.settle', ...)` line, add the learn probe:

```js
      // Learn a fast-path: if the last thing we typed now shows up as a query param in the
      // URL, we've discovered this site's search-results template. Don't override a code seed.
      if (session.lastFilledValue) {
        const learned = learnTemplateFromUrl(session.page.url(), session.lastFilledValue);
        if (learned && !SEARCH_SITES[learned.host]) {
          fastpathStore.learn(learned.host, learned.param, learned.template);
        }
        session.lastFilledValue = null;
      }
```

In the successful `fill` branch (right after `session.history.push(\`Step ${steps}: filled ...\`)`), record the typed value:

```js
          session.lastFilledValue = value;
```

In the non-order `done` return (where it does `await closeSession(userId); return { type: 'done', ... }`), record success first:

```js
        if (session.usedFastpath) fastpathStore.recordOutcome(session.usedFastpath, true);
        await closeSession(userId);
        return { type: 'done', text: decision.summary || 'Done.' };
```

In the blocked/empty-shell early return (the `if (steps === 1 && elements.length < 3)` block), record a failure before returning:

```js
        if (session.usedFastpath) fastpathStore.recordOutcome(session.usedFastpath, false);
```

(Add that line inside the `if (bodyLen < 200) {` block, before its `return`.)

- [ ] **Step 7: Run the full smoke suite**

Run: `node --test test/smoke/*.test.js`
Expected: PASS (all).

- [ ] **Step 8: Verify the learn→reuse cycle in one process (dev script)**

Create `test/dev/fastpath-learn.js`:

```js
// Proves the learn→reuse cycle in ONE process (the E2E harness stubs Supabase, so learned
// rows don't survive across processes; in prod they persist in browser_fastpaths).
const fs = require('fs');
process.chdir(require('path').join(__dirname, '..', '..'));
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const runtime = require('../../runtime');
const chainable = new Proxy(function () {}, { get: (_t, p) => {
  if (p === 'then') return undefined;
  if (p === 'maybeSingle' || p === 'single') return async () => ({ data: null });
  if (['upsert', 'insert', 'update', 'select', 'eq', 'order', 'limit'].includes(p)) return () => chainable;
  return () => chainable;
}, apply: () => chainable });
runtime.createSupabaseServiceClient = () => chainable;

const { runOrderingTurn, closeSession, _fastpathStore } = require('../../api/services/browser-task');
const HOST = process.argv[2] || 'https://www.next.co.uk';
const GOAL = process.argv[3] || 'find a wool coat and tell me the exact price shown';

(async () => {
  console.log('--- run 1 (should learn) ---');
  await runOrderingTurn('learn-user-1', { url: HOST, goal: GOAL, onProgress: (l) => process.stdout.write(`  ${l}\n`) });
  await closeSession('learn-user-1').catch(() => {});
  const host = new URL(HOST).hostname.replace(/^www\./, '');
  console.log('learned entry for', host, ':', _fastpathStore._map.get(host) || '(none)');
  console.log('--- done ---');
  process.exit(0);
})();
```

Run: `node test/dev/fastpath-learn.js "https://www.next.co.uk" "find a wool coat and tell me the exact price shown"`
Expected: after run 1, the printed learned entry has a `template` containing `{{term}}` (proves learning fired). If `(none)`, the site puts search in the path, not a query param — acceptable (v1 only learns query-param search).

- [ ] **Step 9: Commit**

```bash
git add api/services/browser-task.js test/smoke/browser-latency.test.js test/dev/fastpath-learn.js
git commit -m "feat(browser-task): learn + reuse + self-heal search fast-paths in the loop"
```

---

### Task 5: Seed the common UK sites

**Files:**
- Modify: `api/services/browser-task.js` (`SEARCH_SITES`)
- Test: `test/smoke/browser-latency.test.js`

**Interfaces:**
- Consumes: existing `SEARCH_SITES` shape `{ names: string[], searchUrl: (term) => string }`.

- [ ] **Step 1: Discover each site's search-URL pattern**

For each candidate, run the discovery harness (drives the search box, prints the results URL — no model tokens):

```bash
NODE_PATH="$PWD/node_modules" node test/dev/discover-search-url.js "https://www.next.co.uk" "wool coat"
NODE_PATH="$PWD/node_modules" node test/dev/discover-search-url.js "https://www.marksandspencer.com" "wool coat"
NODE_PATH="$PWD/node_modules" node test/dev/discover-search-url.js "https://www.asos.com" "wool coat"
NODE_PATH="$PWD/node_modules" node test/dev/discover-search-url.js "https://www.endclothing.com" "wool coat"
NODE_PATH="$PWD/node_modules" node test/dev/discover-search-url.js "https://www.tesco.com" "milk"
NODE_PATH="$PWD/node_modules" node test/dev/discover-search-url.js "https://www.sainsburys.co.uk" "milk"
NODE_PATH="$PWD/node_modules" node test/dev/discover-search-url.js "https://www.ocado.com" "milk"
NODE_PATH="$PWD/node_modules" node test/dev/discover-search-url.js "https://www.waitrose.com" "milk"
```

First copy the discovery harness into the repo so it lives with the other dev tools:
create `test/dev/discover-search-url.js` from the working scratchpad version (drives the first
visible search input, presses Enter, prints `page.url()`; consent-dismiss best-effort).

Record, for each site that returns a `RESULT URL` containing the term as a **query param**, the host, the param name, and the base path. If a site returns `NO SEARCH INPUT FOUND`, times out, or puts the term in the path (not a query), **skip it** — a seed URL can't defeat a bot-wall or a path-based search in v1; note it in the handoff as deferred.

- [ ] **Step 2: Add a verified entry per surviving site**

For each surviving site, add to `SEARCH_SITES` in `api/services/browser-task.js`, using the discovered param/path. Example shape (use the REAL discovered values, not these):

```js
  'next.co.uk': {
    names: ['next'],
    searchUrl: (term) => `https://www.next.co.uk/search?w=${encodeURIComponent(term)}`
  },
```

- [ ] **Step 3: Add a template assertion per added site**

Append to `test/smoke/browser-latency.test.js`, one per site actually added (example):

```js
test('directSearchUrl builds the Next results URL', () => {
  assert.equal(
    directSearchUrl('https://www.next.co.uk', 'find a wool coat and tell me the price'),
    'https://www.next.co.uk/search?w=wool%20coat'
  );
});
```

- [ ] **Step 4: Run the smoke suite**

Run: `node --test test/smoke/*.test.js`
Expected: PASS (all, incl. new per-site assertions).

- [ ] **Step 5: (Optional but recommended) Spot-check one seed E2E**

Run: `node test/dev/browser-task-e2e.js "find a wool coat and tell me the exact price shown" "https://www.next.co.uk" 4`
Expected: completes with a product + price in ~1 step (fast-path fired). If it bot-walls or mis-searches, remove that seed and note it deferred.

- [ ] **Step 6: Commit**

```bash
git add api/services/browser-task.js test/smoke/browser-latency.test.js test/dev/discover-search-url.js
git commit -m "feat(browser-task): seed common UK dept/fashion + grocery fast-paths"
```

---

## Notes for the implementer
- The E2E and dev scripts need `.env` (GEMINI_API_KEY, SUPABASE_URL/KEY) at repo root and local Chromium; run from repo root.
- Gemini's API has intermittently returned transient `fetch failed`; `decideNextAction` now bounds + retries, so a one-off blip degrades to a recoverable step, but a run may still occasionally need a re-run.
- `browser_fastpaths` is global by design — do NOT add a `user_id`. Learned templates carry no personal data.
- Apply `supabase-migration-fastpaths.sql` in the Supabase project before the learned store can persist across restarts (in-memory learning still works within a process without it).
