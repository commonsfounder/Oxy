# Phase 2: Full Credential Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision note (2026-07-20):** This file previously held a plan written in commit `607726e`, before Phase 1 was executed. That version assumed Jest (`jest.mock`, `expect().toBe()`, `npx jest`), `requireAuth`/`req.user.id`, and `supertest` — none of which exist in this repo (Phase 1's own plan had the same problem and needed in-flight correction; see `.git/sdd/progress.md`'s Phase 1 ledger). It also had a real regression bug: it gated `send_message` behind chat review, which contradicts the existing, passing test `'SMS uses native composer instead of chat review'` in `test/smoke/action-contracts.test.js` (that action deliberately opens the native iOS Messages composer — the human already has to tap Send). This revision was re-derived from the design doc plus a fresh read of the actual current codebase, and replaces the old content in place.

**Goal:** Give the agent a general-purpose, server-side-encrypted site-credential vault — beyond the existing payment-card-only `agent-card.js` — with scoped per-task grants, a human confirmation gate before any credential is used, and an audit trail rendered through Phase 1's `task_steps` activity feed.

**Architecture:** Add a `vault_credentials` table (one encrypted credential per `(user, site)`, same AES-256-GCM envelope as `agent-card.js`) and a new `api/services/vault-credentials.js` service. Extend `api/services/browser-task.js` with a login-field-filling section that mirrors the existing payment-card section exactly: a new `ready_for_credential_use` → `confirm_credential_use` two-phase gate, parallel to the proven `ready_for_payment` → `confirm_browser_payment` flow. A task only gets to use a credential if the model explicitly passed the site in `run_browser_task`'s new `credentialSites` param — the loop fails closed otherwise. Every successful use writes one `task_steps` row (`recordTaskStep`, already built in Phase 1) — no new audit table, no new UI surface. iOS gets a `VaultView` modeled directly on the existing `PaymentsView`, gated by Face ID (`LocalAuthentication`) before any credential is added, viewed, or deleted.

**Tech Stack:** Node.js/Express (`api/`), Supabase/Postgres, Playwright (`api/services/browser-task.js`), SwiftUI + LocalAuthentication (`OxyApp/OxyApp/Views`).

## Global Constraints

- Follow existing migration naming: `supabase/migrations/supabase-migration-<feature-slug>.sql`, no numeric prefix.
- Test runner is `node --test` over `test/smoke/*.test.js`, using `node:assert/strict` and `node:test` — **not Jest**. No `supertest` dependency exists in this repo; new HTTP routes get a service-layer test (the service function itself, with a fake Supabase client) plus a manual curl verification step, not an automated Express integration test — this is the precedent Phase 1's Task 3 set (`docs/superpowers/plans/2026-07-20-phase1-reliability-visibility.md`, its ledger note in `.git/sdd/progress.md`).
- Auth middleware is `requireSessionAuth` (sets `req.auth.userId`) + `getAuthenticatedUserId(req)`, both from root `auth.js`. Every new route must use this pair, matching the exact shape of the existing `/connectors/agent-card` and `/routines` routes in `api/index.js`.
- `npm test` must be green before every commit, including doc-only ones (AGENTS.md).
- Never `git add -A` / `git add .` — stage explicit paths only, and run `git status` immediately before every commit (AGENTS.md — the user works in Xcode in parallel).
- Work directly on `main`, no feature branches (AGENTS.md).
- New Supabase migrations must NOT be applied to the live "Oxy" project (`zxfpwuuhwmmzlfhbcdiw`) without asking the user first, even inside an otherwise-autonomous run.
- SF Symbols are banned in iOS — every icon is a real bundled asset in `Assets.xcassets` (AGENTS.md rule #7). If Task 5 needs an icon with no existing asset, reuse `ic-card` or the row's default (no icon) rather than adding `Image(systemName:)`.
- No AI-isms in UI copy — terse, factual, no chatty first-person subtitles (AGENTS.md rule #6).

## Adaptations to the design doc (verified against current code before writing this plan)

- **"iOS Keychain + Secure Enclave-backed storage"** (design doc, Phase 2 bullet 1) cannot mean the credential's plaintext lives *only* on-device: the browser-task engine that fills login forms runs server-side (Playwright on Cloud Run), so the secret must reach the server at point of use regardless of where it's entered. This plan keeps the existing `agent-card.js` architecture (server-side AES-256-GCM envelope via `token-crypto.js`, decrypted only inside the browser-task engine at fill time, never returned to a client or a model prompt) and adds the Secure-Enclave property the design doc actually wants — device-level protection against a stolen/unlocked phone — via `LocalAuthentication` (Face ID/Touch ID) gating the iOS Vault screen itself: no credential can be added, viewed, or deleted without a fresh biometric prompt. This is Task 5. There is no separate on-device Keychain copy of the secret — a second store would be a second attack surface with no real benefit, since the server remains the copy of record either way.
- **"Human confirmation gate, generalized beyond money... to cover messages/posts too"** (design doc, Phase 2 bullet 5) was checked against the actual `api/action-contracts.js` and found already satisfied for every live messaging action: `send_email`/`send_outlook_email`/`send_telegram`/`make_call` are already `executionMode: 'review'`, and `send_message` is *deliberately* `executionMode: 'direct'` — it opens the native iOS Messages/SMS composer (`sms:` deep link), so the human already has to tap Send themselves; there is a passing regression test asserting this (`test/smoke/action-contracts.test.js`, `'SMS uses native composer instead of chat review'`). Changing it would silently break a correct, tested design decision, not fix a gap. `send_slack_message` has a contract entry but no executable `case` handler anywhere in `api/index.js` — it's unreachable, so gating it changes nothing real. There is no `create_post`/`publish_post` action in this codebase — inventing one with no execution path behind it would be dead code. The actual, real instance of "a human confirmation gate generalized beyond money" that Phase 2 needs to build is the credential-use gate itself (Task 3/4 below): the same two-phase `ready_for_X` → `confirm_X` mechanism proven for payments (commit `255d0d5`), now also covering "sign in with a saved credential" as a second gated action type. This satisfies the design doc's intent (reuse the money-guardrail *mechanism*, widen the *trigger set*) without a spurious, test-breaking change to `send_message`.
- **Scoped per-task grants** are implemented as an explicit, optional `credentialSites: string[]` parameter on the `run_browser_task` action (normalized domains, e.g. `"delta.com"`). The loop fails closed: if a page shows a password field for a domain not in `session.allowedCredentialSites`, or if the model never passed `credentialSites` at all, the credential-use gate never fires — the task continues exactly as it does today (no regression to existing guest-checkout/login-wall behavior, which is untouched). This is a deliberate scope-narrowing versus an implicit "any stored credential is fair game" design, matching the design doc's "tool layer denies anything outside that scope" language. (The prior revision of this plan proposed a `credentialIds` grant keyed to a task dispatcher that doesn't concretely exist in this codebase — there is no separate "task creation" step upstream of `run_browser_task` to attach grants to. Domain-based scoping on the actual tool call is the mechanism that exists.)
- **Audit log identity**: `task_steps.task_id` is generated fresh per chat turn inside `runOrderingTurnImpl` (Phase 1), not passed into the inner loop or held anywhere accessible from "wherever the code detects a login form." This plan threads it explicitly (Task 4, Step 4) via `session.pendingCredentialTaskId`, set by the outer wrapper right before returning the `ready_for_credential_use` outcome, and read back by `confirmCredentialUse` on the next turn.

---

### Task 1: `vault_credentials` table + `vault-credentials.js` service

**Files:**
- Create: `supabase/migrations/supabase-migration-vault-credentials.sql`
- Create: `api/services/vault-credentials.js`
- Test: `test/smoke/vault-credentials.test.js`

**Interfaces:**
- Consumes: `encryptTokens`/`decryptTokens` from `./token-crypto` (existing, used identically by `agent-card.js`).
- Produces: `normalizeSite(site) -> string`, `validateCredentialInput({site, label, username, password}) -> {ok, credential} | {ok:false, error}`, `saveVaultCredential(supabase, userId, {site, label, username, password}) -> {ok, credential} | {ok:false, error}`, `listVaultCredentials(supabase, userId) -> {credentials: [{id, site, label, username, updated_at}]}` (never includes the password), `getVaultCredential(supabase, userId, site) -> {id, site, label, username, password} | null` (full decrypted — server-internal only), `deleteVaultCredential(supabase, userId, credentialId) -> {ok: boolean}`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/supabase-migration-vault-credentials.sql
create table if not exists vault_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  site text not null,
  label text not null,
  username text,
  tokens jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One credential per (user, site) — keeps scoped-grant matching in browser-task.js a plain
-- domain equality check, and saveVaultCredential upserts on this key so re-saving a site
-- updates the existing row instead of creating a duplicate.
create unique index if not exists vault_credentials_user_site_idx on vault_credentials (user_id, site);

alter table vault_credentials enable row level security;

create policy "vault_credentials_select_own" on vault_credentials
  for select using (auth.uid() = user_id);

create policy "vault_credentials_insert_own" on vault_credentials
  for insert with check (auth.uid() = user_id);

create policy "vault_credentials_update_own" on vault_credentials
  for update using (auth.uid() = user_id);

create policy "vault_credentials_delete_own" on vault_credentials
  for delete using (auth.uid() = user_id);
```

- [ ] **Step 2: Write the failing tests**

```javascript
// test/smoke/vault-credentials.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeSite,
  validateCredentialInput,
  saveVaultCredential,
  listVaultCredentials,
  getVaultCredential,
  deleteVaultCredential
} = require('../../api/services/vault-credentials');

function fakeSupabase(rows = []) {
  return {
    from(table) {
      return {
        upsert(row) {
          return {
            select() {
              return {
                single: async () => {
                  const idx = rows.findIndex((r) => r.user_id === row.user_id && r.site === row.site);
                  const merged = { id: idx >= 0 ? rows[idx].id : `cred-${rows.length + 1}`, ...row };
                  if (idx >= 0) rows[idx] = merged; else rows.push(merged);
                  return {
                    data: { id: merged.id, site: merged.site, label: merged.label, username: merged.username, updated_at: merged.updated_at },
                    error: null
                  };
                }
              };
            }
          };
        },
        select() {
          return {
            eq(col, val) {
              const once = () => rows.filter((r) => r[col] === val);
              return {
                eq(col2, val2) {
                  const twice = () => once().filter((r) => r[col2] === val2);
                  return {
                    maybeSingle: async () => ({ data: twice()[0] || null, error: null }),
                    order: async () => ({ data: twice(), error: null })
                  };
                },
                order: async () => ({ data: once(), error: null })
              };
            }
          };
        },
        delete() {
          return {
            eq(col1, val1) {
              return {
                eq: async (col2, val2) => {
                  const remaining = rows.filter((r) => !(r[col1] === val1 && r[col2] === val2));
                  rows.length = 0;
                  rows.push(...remaining);
                  return { error: null };
                }
              };
            }
          };
        }
      };
    }
  };
}

test('normalizeSite lowercases and strips a leading www.', () => {
  assert.equal(normalizeSite('WWW.Delta.com'), 'delta.com');
  assert.equal(normalizeSite('  delta.com  '), 'delta.com');
  assert.equal(normalizeSite(''), '');
});

test('validateCredentialInput rejects missing site, label, or password', () => {
  assert.equal(validateCredentialInput({ label: 'x', password: 'y' }).ok, false);
  assert.equal(validateCredentialInput({ site: 'delta.com', password: 'y' }).ok, false);
  assert.equal(validateCredentialInput({ site: 'delta.com', label: 'x' }).ok, false);
});

test('validateCredentialInput normalizes site and trims fields', () => {
  const result = validateCredentialInput({ site: 'WWW.Delta.com', label: '  Delta  ', username: ' me ', password: 'pw' });
  assert.equal(result.ok, true);
  assert.equal(result.credential.site, 'delta.com');
  assert.equal(result.credential.label, 'Delta');
  assert.equal(result.credential.username, 'me');
});

test('saveVaultCredential then listVaultCredentials returns a masked summary with no password', async () => {
  const supabase = fakeSupabase();
  const saved = await saveVaultCredential(supabase, 'user-1', { site: 'delta.com', label: 'Delta SkyMiles', username: 'me@example.com', password: 'hunter2' });
  assert.equal(saved.ok, true);
  assert.equal(saved.credential.site, 'delta.com');
  assert.equal('password' in saved.credential, false);

  const { credentials } = await listVaultCredentials(supabase, 'user-1');
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].label, 'Delta SkyMiles');
  assert.equal('password' in credentials[0], false);
});

test('saveVaultCredential rejects invalid input without touching supabase', async () => {
  const supabase = fakeSupabase();
  const result = await saveVaultCredential(supabase, 'user-1', { site: '', label: 'x', password: 'y' });
  assert.equal(result.ok, false);
});

test('getVaultCredential returns the decrypted credential for the matching site only', async () => {
  const supabase = fakeSupabase();
  await saveVaultCredential(supabase, 'user-1', { site: 'delta.com', label: 'Delta', username: 'me', password: 'hunter2' });
  const found = await getVaultCredential(supabase, 'user-1', 'delta.com');
  assert.equal(found.password, 'hunter2');
  assert.equal(found.username, 'me');
  const missing = await getVaultCredential(supabase, 'user-1', 'united.com');
  assert.equal(missing, null);
});

test('deleteVaultCredential removes only the matching id for that user', async () => {
  const supabase = fakeSupabase();
  const saved = await saveVaultCredential(supabase, 'user-1', { site: 'delta.com', label: 'Delta', password: 'hunter2' });
  const result = await deleteVaultCredential(supabase, 'user-1', saved.credential.id);
  assert.equal(result.ok, true);
  const { credentials } = await listVaultCredentials(supabase, 'user-1');
  assert.equal(credentials.length, 0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/smoke/vault-credentials.test.js`
Expected: FAIL with "Cannot find module '../../api/services/vault-credentials'"

- [ ] **Step 4: Implement `vault-credentials.js`**

```javascript
'use strict';

// General-purpose site-credential vault (Phase 2 of the aside-parity roadmap) — extends the
// agent-card.js pattern (server-side AES-256-GCM envelope, decrypted only at point of use)
// from payment cards to arbitrary site username/password credentials. One credential per
// (user, site) so a task's scoped grant (browser-task.js's session.allowedCredentialSites)
// can match a stored credential by plain domain equality, with no credential IDs threaded
// through chat or the model prompt.

const { encryptTokens, decryptTokens } = require('./token-crypto');

function normalizeSite(site) {
  return String(site || '').trim().toLowerCase().replace(/^www\./, '');
}

function validateCredentialInput({ site, label, username, password } = {}) {
  const normalizedSite = normalizeSite(site);
  if (!normalizedSite) return { ok: false, error: 'Site is required.' };
  const trimmedLabel = String(label || '').trim();
  if (!trimmedLabel) return { ok: false, error: 'Label is required.' };
  const trimmedPassword = String(password || '');
  if (!trimmedPassword.trim()) return { ok: false, error: 'Password is required.' };
  return {
    ok: true,
    credential: {
      site: normalizedSite,
      label: trimmedLabel,
      username: String(username || '').trim(),
      password: trimmedPassword
    }
  };
}

async function saveVaultCredential(supabase, userId, rawCredential) {
  const result = validateCredentialInput(rawCredential);
  if (!result.ok) return result;
  const { site, label, username, password } = result.credential;
  const { data, error } = await supabase
    .from('vault_credentials')
    .upsert({
      user_id: userId,
      site,
      label,
      username,
      tokens: encryptTokens({ username, password }),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,site' })
    .select('id, site, label, username, updated_at')
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, credential: data };
}

/** Masked list for clients — never includes the password. */
async function listVaultCredentials(supabase, userId) {
  const { data, error } = await supabase
    .from('vault_credentials')
    .select('id, site, label, username, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) return { credentials: [], error };
  return { credentials: data };
}

/** Full decrypted credential for one site — server-internal use only (confirmCredentialUse
 *  in browser-task.js). Never returned to a client or a model prompt. */
async function getVaultCredential(supabase, userId, site) {
  const normalizedSite = normalizeSite(site);
  if (!normalizedSite) return null;
  const { data } = await supabase
    .from('vault_credentials')
    .select('id, site, label, tokens')
    .eq('user_id', userId)
    .eq('site', normalizedSite)
    .maybeSingle();
  if (!data) return null;
  const decrypted = decryptTokens(data.tokens || {});
  if (!decrypted || !decrypted.password) return null;
  return { id: data.id, site: data.site, label: data.label, username: decrypted.username, password: decrypted.password };
}

async function deleteVaultCredential(supabase, userId, credentialId) {
  const { error } = await supabase
    .from('vault_credentials')
    .delete()
    .eq('id', credentialId)
    .eq('user_id', userId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = {
  normalizeSite,
  validateCredentialInput,
  saveVaultCredential,
  listVaultCredentials,
  getVaultCredential,
  deleteVaultCredential
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/smoke/vault-credentials.test.js`
Expected: PASS (7 tests)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all prior tests still pass, plus the 7 new ones.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/supabase-migration-vault-credentials.sql api/services/vault-credentials.js test/smoke/vault-credentials.test.js
git commit -m "feat(vault): add vault_credentials table and encrypted credential service"
```

---

### Task 2: Vault CRUD routes

**Files:**
- Modify: `api/index.js` (add routes near the existing `/connectors/agent-card` routes)
- Test: covered by Task 1's service-layer tests (per this repo's precedent — no `supertest`, no HTTP-level test for a new route; see Global Constraints)

**Interfaces:**
- Consumes: `saveVaultCredential`, `listVaultCredentials`, `deleteVaultCredential` from `./services/vault-credentials` (Task 1).
- Produces routes: `POST /vault/credentials` → `{saved: true, credential}` or `400 {error}`; `GET /vault/credentials` → `{credentials: [...]}`; `DELETE /vault/credentials/:id` → `{ok: true}`. All session-authed via `requireSessionAuth` + `getAuthenticatedUserId(req)`.

- [ ] **Step 1: Add the require near the existing agent-card import**

Find this line in `api/index.js` (near the top, alongside the other service requires):

```javascript
const { saveAgentCard, getAgentCardSummary, deleteAgentCard } = require('./services/agent-card');
```

Add directly below it:

```javascript
const { saveVaultCredential, listVaultCredentials, deleteVaultCredential } = require('./services/vault-credentials');
```

- [ ] **Step 2: Add the three routes**

Find the existing agent-card routes in `api/index.js` (search for `app.delete('/connectors/agent-card'`) and add the following directly after that block, before the `/connectors/stripe/payment-action` route:

```javascript
// General-purpose credential vault — Phase 2 of the aside-parity roadmap. Any site
// credential (not just payment cards); stored encrypted, one per (user, site), decrypted
// only inside the browser-task engine at point of use (confirmCredentialUse in
// api/services/browser-task.js). GET never returns the password. Credential entry
// happens over these authed routes (iOS Vault screen), NEVER via chat.
app.post('/vault/credentials', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { site, label, username, password } = req.body || {};
    const result = await saveVaultCredential(supabase, userId, { site, label, username, password });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ saved: true, credential: result.credential });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/vault/credentials', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { credentials, error } = await listVaultCredentials(supabase, userId);
    if (error) return res.status(500).json({ error });
    res.json({ credentials });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/vault/credentials/:id', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await deleteVaultCredential(supabase, userId, req.params.id);
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all tests pass (no new automated route test — service layer already covers the logic these routes call).

- [ ] **Step 4: Manual verification**

The `vault_credentials` migration from Task 1 has NOT been applied to any live Supabase project yet (per Global Constraints — do not apply without asking). So a live curl against a real deployment will 500 until that migration runs; that's expected and matches Phase 1's Task 3 precedent (`GET /tasks/:id/steps` before its migration was applied). Verify correctness by code inspection instead: re-read the three route handlers against `saveVaultCredential`/`listVaultCredentials`/`deleteVaultCredential`'s actual signatures from Task 1 and confirm the argument order and response shape match exactly.

- [ ] **Step 5: Commit**

```bash
git add api/index.js
git commit -m "feat(vault): add POST/GET/DELETE /vault/credentials endpoints"
```

---

### Task 3: Login-credential fill primitives in `browser-task.js`

Self-contained new code, mirroring the existing payment-card section exactly. Not yet wired into the ordering loop — that's Task 4. Building it standalone first keeps this task's diff isolated from the loop's existing, regression-tested guest-checkout/login-wall branches.

**Files:**
- Modify: `api/services/browser-task.js`
- Modify: `api/action-contracts.js` (two new action contracts)
- Modify: `api/index.js` (two new `case` handlers)
- Test: `test/smoke/browser-task-credential-fill.test.js`

**Interfaces:**
- Consumes: `getVaultCredential` from `./vault-credentials` (Task 1), `recordTaskStep` from `./task-steps` (Phase 1, already required in this file), `getSession`/`getSupabase`/`settle`/`extractClickableElements`/`CLICKABLE_SELECTOR`/`enumeratePaymentInputs`/`fillFrameTextInput`/`envInt` (all already defined earlier in this same file).
- Produces: `classifyLoginInput(hintText) -> 'username' | 'password' | null`, `formatLoginValue(field, credential) -> string | null`, `fillLoginCredential(session, credential, onProgress) -> Promise<number>` (count of fields filled), `loginCredentialFieldsPresent(page) -> Promise<boolean>`, `confirmCredentialUse(userId, onProgress) -> Promise<{type: 'done'|'error', text?, error?}>`, `cancelCredentialUse(userId) -> void`. These are exported from `browser-task.js` alongside the existing payment exports.

- [ ] **Step 1: Add the `getVaultCredential` import**

Find this line near the top of `api/services/browser-task.js`:

```javascript
const { getAgentCard } = require('./agent-card');
```

Add directly below it:

```javascript
const { getVaultCredential, normalizeSite } = require('./vault-credentials');
```

- [ ] **Step 2: Write the failing tests for the pure/self-contained pieces**

```javascript
// test/smoke/browser-task-credential-fill.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyLoginInput,
  formatLoginValue
} = require('../../api/services/browser-task');

test('classifyLoginInput recognizes password fields', () => {
  assert.equal(classifyLoginInput('Password'), 'password');
  assert.equal(classifyLoginInput('current-password'), 'password');
  assert.equal(classifyLoginInput('pwd'), 'password');
});

test('classifyLoginInput recognizes username/email fields', () => {
  assert.equal(classifyLoginInput('Username'), 'username');
  assert.equal(classifyLoginInput('Email address'), 'username');
  assert.equal(classifyLoginInput('login-id'), 'username');
});

test('classifyLoginInput returns null for unrelated hints', () => {
  assert.equal(classifyLoginInput('Postcode'), null);
  assert.equal(classifyLoginInput(''), null);
  assert.equal(classifyLoginInput(), null);
});

test('formatLoginValue returns the matching credential field', () => {
  const credential = { username: 'me@example.com', password: 'hunter2' };
  assert.equal(formatLoginValue('username', credential), 'me@example.com');
  assert.equal(formatLoginValue('password', credential), 'hunter2');
  assert.equal(formatLoginValue('other', credential), null);
});

test('formatLoginValue returns null for an empty username rather than a falsy crash', () => {
  const credential = { username: '', password: 'hunter2' };
  assert.equal(formatLoginValue('username', credential), null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/smoke/browser-task-credential-fill.test.js`
Expected: FAIL — `classifyLoginInput is not a function` (not yet exported)

- [ ] **Step 4: Add the login-credential section to `browser-task.js`**

Find the end of the existing payment section — the `cancelPayment` function, right before `module.exports`:

```javascript
function cancelPayment(userId) {
  touchSession(userId);
}

module.exports = {
```

Insert the new section between `cancelPayment`'s closing brace and `module.exports`:

```javascript
function cancelPayment(userId) {
  touchSession(userId);
}

// ---------------- Login-credential filling — post-confirmation only ----------------
// Mirrors the payment-card section above exactly: a vault credential (api/services/
// vault-credentials.js) is only ever decrypted here, server-side, strictly after the user
// has explicitly confirmed a ready_for_credential_use gate (see Task 4's addition to the
// ordering loop) — never inside a model prompt.

const LOGIN_INPUT_CLASSIFIERS = [
  { field: 'password', pattern: /\bpassword\b|\bpasswd\b|\bpwd\b/i },
  { field: 'username', pattern: /\b(user(?:name)?|e-?mail(?:\s*address)?|login.?id|account.?id)\b/i },
];

function classifyLoginInput(hintText) {
  const h = String(hintText || '');
  if (!h) return null;
  for (const { field, pattern } of LOGIN_INPUT_CLASSIFIERS) {
    if (pattern.test(h)) return field;
  }
  return null;
}

function formatLoginValue(field, credential) {
  if (field === 'username') return credential.username || null;
  if (field === 'password') return credential.password || null;
  return null;
}

/** Fill every empty, classifiable login field across all frames. Returns count filled.
 *  Reuses enumeratePaymentInputs — despite its name it's a generic input/select
 *  enumerator, not payment-specific; see its definition above for why it lives there. */
async function fillLoginCredential(session, credential, onProgress = () => {}) {
  const page = session.page;
  const done = new Set();
  for (const frame of page.frames()) {
    const inputs = await enumeratePaymentInputs(frame);
    for (const input of inputs) {
      const field = classifyLoginInput(input.hint);
      if (!field || !input.empty || done.has(field)) continue;
      const value = formatLoginValue(field, credential);
      if (!value) continue;
      const ok = await fillFrameTextInput(frame, input.idx, value);
      if (ok) {
        done.add(field);
        onProgress(field === 'password' ? 'Filled password' : 'Filled username');
      }
    }
  }
  return done.size;
}

/** True when any frame currently shows an empty password field. */
async function loginCredentialFieldsPresent(page) {
  for (const frame of page.frames()) {
    const inputs = await enumeratePaymentInputs(frame);
    if (inputs.some((inp) => inp.empty && classifyLoginInput(inp.hint) === 'password')) return true;
  }
  return false;
}

async function findAndClickSignInButton(page) {
  const elements = await extractClickableElements(page);
  const target = elements.find((el) => /^(sign in|log in|login|continue)$/i.test(el.text.trim()));
  if (!target) return null;
  const handle = await page.evaluateHandle(
    ({ selector, idx }) => document.querySelectorAll(selector)[idx] || null,
    { selector: CLICKABLE_SELECTOR, idx: target.locatorIndex }
  ).then((h) => h.asElement());
  if (!handle) return null;
  await handle.click({ timeout: 10000 });
  return target.text;
}

const CREDENTIAL_WATCH_BUDGET_MS = envInt('OXY_BROWSER_CREDENTIAL_WATCH_MS', 20000);

/**
 * Fills and submits the vault credential for session.pendingCredentialSite, set by the
 * ordering loop (Task 4) when it offers a ready_for_credential_use gate and the user
 * confirms. Logs one task_steps audit row per use — recordTaskStep never throws, so a
 * telemetry failure can never break the sign-in it's recording.
 */
async function confirmCredentialUse(userId, onProgress = () => {}) {
  const session = getSession(userId);
  if (!session || !session.pendingCredentialSite) {
    return { type: 'error', error: 'No sign-in is waiting for confirmation — it may have expired.' };
  }
  try {
    const credential = await getVaultCredential(getSupabase(), userId, session.pendingCredentialSite);
    if (!credential) {
      session.pendingCredentialSite = null;
      return { type: 'error', error: 'That saved credential is no longer available — the sign-in was not completed.' };
    }
    if (!(await loginCredentialFieldsPresent(session.page))) {
      return { type: 'error', error: "Couldn't find the sign-in form anymore — the page may have changed." };
    }
    await fillLoginCredential(session, credential, onProgress);
    await settle(session.page, 800);
    const clickedLabel = await findAndClickSignInButton(session.page);

    await recordTaskStep(getSupabase(), {
      taskId: session.pendingCredentialTaskId || 'unknown',
      userId,
      stepName: `Signed in to ${credential.site} with saved credential`,
      phase: 'credential_use',
      detail: { credentialId: credential.id, site: credential.site }
    });

    const site = session.pendingCredentialSite;
    session.pendingCredentialSite = null;
    session.pendingCredentialTaskId = null;
    if (!clickedLabel) {
      return { type: 'done', text: `Filled in your saved ${site} sign-in — the page didn't show a button to submit, so check it looks right.` };
    }

    const deadline = Date.now() + CREDENTIAL_WATCH_BUDGET_MS;
    while (Date.now() < deadline) {
      await settle(session.page, 1000);
      if (!(await loginCredentialFieldsPresent(session.page))) {
        return { type: 'done', text: `Signed in to ${site} with your saved credential.` };
      }
    }
    return { type: 'done', text: `Signed in to ${site} — say "keep going" to continue.` };
  } catch (error) {
    return { type: 'error', error: error.message };
  }
}

function cancelCredentialUse(userId) {
  const session = getSession(userId);
  if (session) {
    session.pendingCredentialSite = null;
    session.pendingCredentialTaskId = null;
  }
}

module.exports = {
```

Then add the six new names to the existing `module.exports` object (find `confirmPayment,` in the export list and add these directly after it):

```javascript
  confirmPayment,
  classifyLoginInput,
  formatLoginValue,
  fillLoginCredential,
  loginCredentialFieldsPresent,
  confirmCredentialUse,
  cancelCredentialUse,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/smoke/browser-task-credential-fill.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Add the two new action contracts**

In `api/action-contracts.js`, find `cancel_browser_payment` (the last entry before the closing `};` of `ACTION_CONTRACTS`) and add two new entries directly after it, before the closing brace:

```javascript
  cancel_browser_payment: {
    risk: 'low',
    required: [],
    inputExample: {},
    successSummary: 'Order cancelled',
    failureSummary: 'Cancel failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  // The second half of the credential-use two-phase flow (Phase 2 of the aside-parity
  // roadmap) — only ever called on a turn AFTER the user has explicitly approved a
  // review_required result from run_browser_task's ready_for_credential_use branch.
  // executionMode: 'direct' is correct here for the same reason it is on
  // confirm_browser_payment: the human review already happened on the prior turn.
  confirm_credential_use: {
    risk: 'high',
    required: [],
    inputExample: {},
    successSummary: 'Signed in',
    failureSummary: 'Sign-in failed',
    confirmation: 'none',
    executionMode: 'direct',
    guidance: 'Only call this after the user has explicitly said yes to using their saved credential, offered by run_browser_task on a prior turn.'
  },
  cancel_credential_use: {
    risk: 'low',
    required: [],
    inputExample: {},
    successSummary: 'Sign-in cancelled',
    failureSummary: 'Cancel failed',
    confirmation: 'none',
    executionMode: 'direct'
  }
```

- [ ] **Step 7: Add the two new case handlers in `api/index.js`**

Find the existing `case 'confirm_browser_payment':` block in the `executeAction` switch (the one that calls `browserTask.confirmPayment`) and add the two new cases directly after its closing brace:

```javascript
    case 'confirm_credential_use': {
      try {
        const result = await browserTask.confirmCredentialUse(userId);
        if (result.type === 'error') return { success: false, error: result.error };
        return { success: true, text: result.text };
      } catch (e) {
        return { success: false, error: `Sign-in confirmation failed: ${e.message}` };
      }
    }

    case 'cancel_credential_use':
      browserTask.cancelCredentialUse(userId);
      return { success: true, text: 'Okay, not signing in.' };
```

Before writing this step, read the existing `case 'cancel_browser_payment':` handler in `api/index.js` (search for it) and match its exact shape (return type, whether it's async) rather than assuming — mirror what's actually there.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: all tests pass, including the 5 new ones.

- [ ] **Step 9: Commit**

```bash
git add api/services/browser-task.js api/action-contracts.js api/index.js test/smoke/browser-task-credential-fill.test.js
git commit -m "feat(vault): add login-credential fill primitives and confirm/cancel actions"
```

---

### Task 4: Wire scoped credential-use detection into the ordering loop

This is the highest-risk task — it touches the long-lived per-step loop in `runOrderingTurnImplInner`, which has many existing, regression-tested branches (guest checkout, login-wall avoidance, delivery preference). Keep the diff strictly additive: a new, self-contained `if` block that returns early, placed BEFORE all existing branches, touching no existing line. Do not restructure or "clean up" anything nearby.

**Files:**
- Modify: `api/services/browser-task.js`
- Modify: `api/action-contracts.js` (`run_browser_task`'s optional params + guidance)
- Modify: `api/index.js` (the `run_browser_task` case handler)
- Test: `test/smoke/browser-task-credential-scope.test.js`

**Interfaces:**
- Consumes: `normalizeSite` from `./vault-credentials` (already imported in Task 3, Step 1), `getVaultCredential` from `./vault-credentials` (already imported in Task 3), `siteKeyFromUrl` (already defined in this file), `PASSWORD_FIELD_SELECTOR` (already defined in this file, used by the existing login-wall checks).
- Produces: a new outcome type `{ type: 'ready_for_credential_use', site, label, taskId }` returned from `runOrderingTurn`, alongside the existing `ready_for_payment`/`done`/`ask`/`awaiting_more`/`error`/`reauth` types. `runOrderingTurn(userId, { url, goal, location, onProgress, credentialSites })` — one new optional arg, threaded straight through to `runOrderingTurnImpl` and `runOrderingTurnImplInner`.

- [ ] **Step 1: Write the failing test for the pure scope-matching helper**

```javascript
// test/smoke/browser-task-credential-scope.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { siteKeyFromUrl } = require('../../api/services/browser-task');
const { normalizeSite } = require('../../api/services/vault-credentials');

test('siteKeyFromUrl and normalizeSite agree on the same domain (scoped-grant matching depends on this)', () => {
  assert.equal(siteKeyFromUrl('https://www.delta.com/login'), normalizeSite('delta.com'));
  assert.equal(siteKeyFromUrl('https://delta.com/login'), normalizeSite('www.delta.com'));
});

test('a credentialSites entry the model passes as a bare domain normalizes to what siteKeyFromUrl produces for that site', () => {
  const modelPassed = ['Delta.com', 'WWW.United.com'];
  const normalized = modelPassed.map(normalizeSite);
  assert.deepEqual(normalized, ['delta.com', 'united.com']);
  assert.equal(siteKeyFromUrl('https://www.united.com/account'), 'united.com');
  assert.ok(normalized.includes(siteKeyFromUrl('https://www.united.com/account')));
});
```

- [ ] **Step 2: Export `siteKeyFromUrl`**

`siteKeyFromUrl` is defined in `api/services/browser-task.js` but not currently exported. Find its existing `module.exports` list (already modified in Task 3) and add `siteKeyFromUrl,` to it.

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/smoke/browser-task-credential-scope.test.js`
Expected: FAIL — `siteKeyFromUrl is not a function` (not yet exported) — then re-run after Step 2 completes; it should pass immediately since both functions already exist and agree by construction (both lowercase + strip `www.`). If it does NOT pass after Step 2, that means `siteKeyFromUrl` and `normalizeSite` disagree on normalization — stop and reconcile them (e.g. make one call the other) before continuing; the scoped-grant check in Step 5 depends on them producing identical output for the same domain.

- [ ] **Step 4: Thread `credentialSites` through the three call layers**

In `api/services/browser-task.js`, find `async function runOrderingTurn(userId, args) {` (the outermost wrapper) — no change needed there, it already forwards `args` opaquely.

Find `async function runOrderingTurnImpl(userId, { url, goal, location = null, onProgress: rawOnProgress = () => {} }) {`. Change its signature and body to:

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

Find `async function runOrderingTurnImplInner(userId, { url, goal, location = null, onProgress = () => {} }) {`. Change its signature to accept the new param:

```javascript
async function runOrderingTurnImplInner(userId, { url, goal, location = null, onProgress = () => {}, credentialSites = [] }) {
```

Then, still inside `runOrderingTurnImplInner`, find this exact line — it's the step counter declared once, immediately before the per-step `while (steps < MAX_STEPS && ...)` loop begins a few lines later:

```javascript
  let steps = 0;
```

Add the new block directly after it (and before the surrounding `consecutiveBadDecisions`/`consecutiveWaits` declarations that follow, or after them — order relative to those two doesn't matter, just keep this before the `while` loop, not inside it). Add:

```javascript
  if (credentialSites.length) {
    session.allowedCredentialSites = credentialSites.map(normalizeSite).filter(Boolean);
    session.credentialOfferAttempted = false;
  }
```

(`normalizeSite` is already imported at the top of this file from Task 3, Step 1 — reuse that import, do not add a second `require('./vault-credentials')`.)

- [ ] **Step 5: Add the additive detection block**

Still in `runOrderingTurnImplInner`, find this existing line (search for it — it's the first line inside the per-step loop that reads the current URL):

```javascript
      const currentUrl = session.page.url();
```

Add the new block immediately after it, before any existing `if` statement that follows:

```javascript
      const currentUrl = session.page.url();

      // Vault credential offer — Phase 2 of the aside-parity roadmap (api/services/
      // vault-credentials.js). Fires for ANY task (order or not), independent of the
      // guest-checkout login-wall machinery below, which is about AVOIDING login. This is
      // the opposite: offering to actually sign in with a credential the user explicitly
      // scoped this task to use (session.allowedCredentialSites, set above from
      // run_browser_task's credentialSites param). Fails closed — no scope, no offer — and
      // only offers once per session so a page that keeps a password field visible doesn't
      // re-ask every step.
      if (!session.credentialOfferAttempted && session.allowedCredentialSites?.length) {
        const currentSite = siteKeyFromUrl(currentUrl);
        if (session.allowedCredentialSites.includes(currentSite)) {
          const pwVisible = await session.page.locator(PASSWORD_FIELD_SELECTOR).first().isVisible().catch(() => false);
          if (pwVisible) {
            const credential = await getVaultCredential(getSupabase(), userId, currentSite).catch(() => null);
            if (credential) {
              session.credentialOfferAttempted = true;
              session.pendingCredentialSite = currentSite;
              return { type: 'ready_for_credential_use', site: currentSite, label: credential.label };
            }
          }
        }
      }
```

Do not modify anything else in the loop. This block returns early exactly like the existing `isCheckoutLoginWallUrl` ask-block a few lines below it, so it fits the loop's established early-return idiom.

- [ ] **Step 6: Run the credential-scope test to verify it passes**

Run: `node --test test/smoke/browser-task-credential-scope.test.js`
Expected: PASS (2 tests)

- [ ] **Step 7: Run the full suite to confirm no regression in the ordering loop**

Run: `npm test`
Expected: all tests pass, including `test/smoke/browser-ordering-loop.test.js` and `test/smoke/browser-reauth.test.js` (the two suites most likely to catch a mistake in this insertion) — if either fails, the new block has interfered with existing control flow; re-check that Step 5's block was inserted additively and does not shadow any existing variable name.

- [ ] **Step 8: Add `credentialSites` to the `run_browser_task` action contract**

In `api/action-contracts.js`, find the `run_browser_task` entry (search for `optional: ['goal', 'url'],`) and change it to:

```javascript
    optional: ['goal', 'url', 'credentialSites'],
```

Then find that same entry's `guidance` field and append a sentence to it (keep the existing text, add this at the end):

```javascript
    guidance: 'Call again with the same goal (or no goal, to continue an in-progress order) for a multi-step order. NEVER call confirm_browser_payment yourself — only after the user explicitly agrees to the price shown in a review_required result. If the user asks you to sign in to a specific site using a saved credential, pass credentialSites as an array of that site\'s domain (e.g. ["delta.com"]) — without it, no stored credential will ever be offered, even if one exists.',
```

- [ ] **Step 9: Handle the new outcome type in `api/index.js`'s `run_browser_task` case**

Find the `run_browser_task` case handler (search for `outcome = await browserTask.runOrderingTurn(userId, { url, goal, location: context.location });`). Change that call to pass through `credentialSites`, and add a new branch for the new outcome type. The line becomes:

```javascript
      const credentialSites = Array.isArray(params?.credentialSites) ? params.credentialSites : [];
      let outcome;
      try {
        outcome = await browserTask.runOrderingTurn(userId, { url, goal, location: context.location, credentialSites });
      } catch (e) {
        return { success: false, error: `Browse task failed: ${e.message}` };
      }
      if (outcome.type === 'ready_for_credential_use') {
        return {
          success: true,
          confirmation: 'review_required',
          text: `I found a sign-in for ${outcome.site} — use your saved "${outcome.label}" credential to sign in?`,
          actionSummary: 'Sign-in ready',
          taskId: outcome.taskId
        };
      }
      if (outcome.type === 'ready_for_payment') {
```

(Keep every existing line inside and after the `if (outcome.type === 'ready_for_payment')` branch exactly as it is — this step only adds the new branch immediately before it, and replaces the `outcome = await browserTask.runOrderingTurn(...)` call with the version above that adds `credentialSites`.)

- [ ] **Step 10: Run the full suite once more**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add api/services/browser-task.js api/action-contracts.js api/index.js test/smoke/browser-task-credential-scope.test.js
git commit -m "feat(vault): wire scoped credential-use offer into the ordering loop"
```

---

### Task 5: iOS — Vault screen, Face-ID gated

**Files:**
- Read first: `OxyApp/OxyApp/Views/Payments/PaymentsView.swift` (the exact pattern to mirror), `OxyApp/OxyApp/Views/MainTabView.swift` (More-menu wiring)
- Create: `OxyApp/OxyApp/Views/Vault/VaultView.swift`
- Modify: `OxyApp/OxyApp/Views/MainTabView.swift`
- Modify: `OxyApp/OxyApp/Info.plist` (add `NSFaceIDUsageDescription`)

**Interfaces:**
- Produces: `struct VaultCredentialSummary: Codable, Equatable { let id: String; let site: String; let label: String; let username: String; let updatedAt: String }`, `struct VaultView: View`. No separate model/service files — this repo's `PaymentsView.swift` keeps its response-decoding structs and networking calls in the same file as the view (see `LinkedCard`/`AgentCardSummary`/`fetchAgentCard` in that file), so `VaultView.swift` follows the same one-file convention rather than splitting into `Models/`+`Services/`.

- [ ] **Step 1: Add the Face ID usage-description string**

In `OxyApp/OxyApp/Info.plist`, find the existing usage-description entries (e.g. `NSContactsUsageDescription`) and add a new key/value pair in the same alphabetically-adjacent spot (after `NSContactsUsageDescription`'s pair, before `NSHealthShareUsageDescription`'s pair):

```xml
	<key>NSFaceIDUsageDescription</key>
	<string>Face ID protects the credentials you save to the Vault.</string>
```

- [ ] **Step 2: Create `VaultView.swift`**

```swift
// OxyApp/OxyApp/Views/Vault/VaultView.swift
import SwiftUI
import LocalAuthentication

struct VaultView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var credentials: [VaultCredentialSummary] = []
    @State private var isLoading = true
    @State private var isUnlocked = false
    @State private var errorMessage: String?
    @State private var showEntrySheet = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Vault", onBack: { dismiss() })

                    if !isUnlocked {
                        lockedState
                    } else if isLoading {
                        VStack(spacing: 12) {
                            OxySkeletonCard(height: 72)
                            OxySkeletonCard(height: 72)
                        }
                        .padding(.horizontal, AppSpacing.margin)
                        .padding(.top, 16)
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 28) {
                                if let errorMessage {
                                    ErrorBanner(message: errorMessage)
                                }
                                credentialsSection
                            }
                            .padding(.horizontal, AppSpacing.margin)
                            .padding(.vertical, 16)
                        }
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .task { await authenticateAndLoad() }
            .refreshable { await loadCredentials() }
            .sheet(isPresented: $showEntrySheet) {
                VaultCredentialEntrySheet { saved in
                    credentials.removeAll { $0.site == saved.site }
                    credentials.insert(saved, at: 0)
                }
            }
        }
    }

    // MARK: - Sections

    private var lockedState: some View {
        VStack(spacing: 12) {
            Text(errorMessage ?? "Unlock with Face ID to view your saved credentials.")
                .font(.rowSecondary)
                .foregroundStyle(Color.appMuted)
                .multilineTextAlignment(.center)
            Button("Unlock") { Task { await authenticateAndLoad() } }
                .font(.rowTitle)
        }
        .padding(.horizontal, AppSpacing.margin)
        .padding(.top, 48)
    }

    private var credentialsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                AppSectionHeader(title: "Saved credentials")
                Spacer()
                Button("Add") { showEntrySheet = true }
                    .font(.rowSecondary)
            }
            .padding(.bottom, 12)

            if credentials.isEmpty {
                Text("No saved credentials. The agent will only use one when a task explicitly asks to sign in to that site.")
                    .font(.rowSecondary)
                    .foregroundStyle(Color.appMuted)
                    .padding(.vertical, 14)
            } else {
                ForEach(credentials) { credential in
                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(credential.label)
                                .font(.rowTitle)
                                .foregroundStyle(Color.appInk)
                            Text("\(credential.site) · \(credential.username.isEmpty ? "no username saved" : credential.username)")
                                .font(.rowSecondary)
                                .foregroundStyle(Color.appMuted)
                        }
                        Spacer(minLength: 8)
                        Button("Remove", role: .destructive) {
                            Task { await removeCredential(credential) }
                        }
                        .font(.rowSecondary)
                    }
                    .padding(.vertical, 14)
                    .frame(minHeight: 44)
                }
            }
        }
    }

    // MARK: - Face ID gate

    private func authenticateAndLoad() async {
        let context = LAContext()
        var evalError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &evalError) else {
            await MainActor.run {
                errorMessage = "Face ID isn't available on this device."
                isUnlocked = false
                isLoading = false
            }
            return
        }
        do {
            let success = try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: "Unlock your Vault"
            )
            await MainActor.run { isUnlocked = success }
            if success { await loadCredentials() }
        } catch {
            await MainActor.run {
                errorMessage = "Face ID unlock failed."
                isUnlocked = false
                isLoading = false
            }
        }
    }

    // MARK: - Networking

    private func loadCredentials() async {
        await MainActor.run { isLoading = true }
        do {
            let data = try await APIClient.shared.request(path: "/vault/credentials")
            let response = try JSONDecoder().decode(VaultCredentialsResponse.self, from: data)
            await MainActor.run {
                credentials = response.credentials
                errorMessage = nil
                isLoading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isLoading = false
            }
        }
    }

    private func removeCredential(_ credential: VaultCredentialSummary) async {
        do {
            _ = try await APIClient.shared.request(path: "/vault/credentials/\(credential.id)", method: "DELETE")
            await MainActor.run { credentials.removeAll { $0.id == credential.id } }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }
}

// MARK: - Credential entry

private struct VaultCredentialEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    let onSaved: (VaultCredentialSummary) -> Void

    @State private var site = ""
    @State private var label = ""
    @State private var username = ""
    @State private var password = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Site (e.g. delta.com)", text: $site)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField("Label (e.g. Delta SkyMiles)", text: $label)
                    TextField("Username or email", text: $username)
                        .textInputAutocapitalization(.never)
                        .textContentType(.username)
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                } footer: {
                    Text("Stored encrypted. Only used when a task explicitly asks to sign in to this site, after you confirm.")
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Add credential")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!isFormPlausible)
                    }
                }
            }
        }
    }

    private var isFormPlausible: Bool {
        !site.trimmingCharacters(in: .whitespaces).isEmpty
            && !label.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        do {
            let data = try await APIClient.shared.request(
                path: "/vault/credentials",
                method: "POST",
                body: [
                    "site": site.trimmingCharacters(in: .whitespaces),
                    "label": label.trimmingCharacters(in: .whitespaces),
                    "username": username.trimmingCharacters(in: .whitespaces),
                    "password": password
                ]
            )
            let response = try JSONDecoder().decode(VaultCredentialSaveResponse.self, from: data)
            if let saved = response.credential {
                onSaved(saved)
                dismiss()
            } else {
                errorMessage = "The credential couldn't be saved."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isSaving = false
    }
}

// MARK: - Models

struct VaultCredentialSummary: Codable, Equatable, Identifiable {
    let id: String
    let site: String
    let label: String
    let username: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, site, label, username
        case updatedAt = "updated_at"
    }
}

private struct VaultCredentialsResponse: Codable {
    let credentials: [VaultCredentialSummary]
}

private struct VaultCredentialSaveResponse: Codable {
    let saved: Bool
    let credential: VaultCredentialSummary?
}

#Preview {
    VaultView()
}
```

Before finalizing this step, read `OxyApp/OxyApp/Views/Payments/PaymentsView.swift` in full and confirm every type/view referenced above (`ScreenHeaderView`, `OxySkeletonCard`, `ErrorBanner`, `AppSectionHeader`, `Color.appBackground`, `Color.appInk`, `Color.appMuted`, `.rowTitle`, `.rowSecondary`, `APIClient.shared.request`) matches its actual signature in this codebase — this plan was written against `PaymentsView.swift` as of commit `74ecd02`; if any of these has since changed, use the current signature, not the one shown here.

- [ ] **Step 3: Wire into `MainTabView`'s More menu**

In `OxyApp/OxyApp/Views/MainTabView.swift`, find the `MoreDestination` enum:

```swift
    enum MoreDestination: Identifiable {
        case profile, pendant, connectors, memory, routines, settings, payments
        var id: String { "\(self)" }
    }
```

Change it to add `vault`:

```swift
    enum MoreDestination: Identifiable {
        case profile, pendant, connectors, memory, routines, settings, payments, vault
        var id: String { "\(self)" }
    }
```

Find the `fullScreenCover` switch:

```swift
                    case .payments: PaymentsView()
                    }
```

Change it to:

```swift
                    case .payments: PaymentsView()
                    case .vault: VaultView()
                    }
```

Find the menu row list (search for `AppRow(title: "Payments")`):

```swift
            AppRow(title: "Payments") { destination = .payments }
            rowDivider
            AppRow(title: "Settings") { destination = .settings }
```

Change it to add a Vault row between Payments and Settings:

```swift
            AppRow(title: "Payments") { destination = .payments }
            rowDivider
            AppRow(title: "Vault") { destination = .vault }
            rowDivider
            AppRow(title: "Settings") { destination = .settings }
```

- [ ] **Step 4: Add the new file to the Xcode project**

This repo's `OxyApp.xcodeproj` uses an explicit file list (`project.pbxproj`), not folder references — Phase 1's Task 4/5 had to manually add new Swift files to it (see their commits, `50e5dda` and `e98bec2`, and the ledger note in `.git/sdd/progress.md`: "Manually added new files to project.pbxproj"). Do the same here: open `OxyApp/OxyApp.xcodeproj/project.pbxproj`, find the entries for an existing file in `Views/Routines/` (e.g. `RoutinesListView.swift`) as a template for the exact PBXBuildFile/PBXFileReference/PBXGroup/PBXSourcesBuildPhase entries a new Swift file needs, and add equivalent entries for `Views/Vault/VaultView.swift`.

- [ ] **Step 5: Build**

Run: `xcodebuild -project OxyApp/OxyApp.xcodeproj -scheme OxyApp -destination 'platform=iOS Simulator,name=iPhone 16' build`
Expected: `** BUILD SUCCEEDED **`. If it fails on a missing symbol from `PaymentsView.swift`'s conventions (e.g. a renamed shared component), fix `VaultView.swift` to match the current signature — do not modify `PaymentsView.swift` or any shared component to fit this plan's assumptions.

- [ ] **Step 6: Manual verification note**

Face ID cannot be exercised in the iOS Simulator without a paired biometric enrollment simulation (Simulator menu → Features → Face ID → Enrolled, then Matching Face during the prompt) — if that setup isn't available in this run, note in the task report that Face ID gating is build-verified and code-reviewed but not simulator-exercised, matching Phase 1's precedent of flagging simulator-verification gaps explicitly rather than silently claiming full verification (see `.git/sdd/progress.md`'s Phase 1 Task 4/5 notes).

- [ ] **Step 7: Commit**

```bash
git add OxyApp/OxyApp/Views/Vault/VaultView.swift OxyApp/OxyApp/Views/MainTabView.swift OxyApp/OxyApp/Info.plist OxyApp/OxyApp.xcodeproj/project.pbxproj
git commit -m "feat(ios): add Face-ID-gated Vault screen for saved site credentials"
```

---

### Task 6: Final whole-branch review

- [ ] Run `npm test` one final time and confirm the full count (baseline was 571 passing at the end of Phase 1 — expect roughly 571 + 7 (Task 1) + 5 (Task 3) + 2 (Task 4) = ~585, adjust for the actual count observed).
- [ ] Dispatch a final review subagent (per `superpowers:subagent-driven-development`) covering the whole diff since `74ecd02` (Phase 1's last commit) — spec compliance against this plan's Adaptations section and the design doc's Phase 2 bullets, plus code quality.
- [ ] Update the shared memory handoff note at `~/.claude/projects/-Users-chizigamonyewuchi-Documents-Oxy/memory/aside-parity-phase1-shipped-phase2-next.md` (rename or add a new dated section) covering: what Phase 2 shipped, the three Adaptations-to-design-doc decisions (server-side-only storage reconciled with the design doc's Keychain language; send_message left alone; scoped grants require explicit `credentialSites`), the still-unapplied `vault_credentials` migration (flag it the same way Phase 1 flagged its two migrations), and that Phase 3 (Personal Memory) is next per `docs/superpowers/specs/2026-07-20-aside-parity-roadmap-design.md`. Update `MEMORY.md`'s index to point at it.
