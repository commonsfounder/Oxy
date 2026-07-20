# Phase 2: Full Credential Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing encrypted agent-card pattern (`api/services/agent-card.js`) to arbitrary site credentials, add per-task scoped access grants, an audit log (via Phase 1's `task_steps`), and a human-confirmation gate for sensitive actions beyond payments.

**Architecture:** Credentials are encrypted at rest server-side using the same envelope-encryption helpers (`encryptTokens`/`decryptTokens` from `api/services/token-crypto.js`) already used for the payment card — **not** on-device-only Secure Enclave storage. This is a deliberate deviation from a literal reading of the design doc's "iOS Keychain + Secure Enclave-backed storage": `browser-task.js`'s automation runs server-side and must be able to inject the credential into a page during a task, so the secret cannot live exclusively on-device. iOS Keychain is still used, but only to cache the *masked/display* summary (site, username, last-used date) for fast local UI — never the plaintext secret. If true on-device-only storage is a hard requirement later, that needs a different architecture (device-side automation), which is out of scope for this plan.

**Tech Stack:** Node.js/Express (`api/`), Supabase/Postgres, `token-crypto.js` envelope encryption, SwiftUI + iOS Keychain (`Security` framework).

## Global Constraints

- Reuse `encryptTokens`/`decryptTokens` from `api/services/token-crypto.js` — do not add a second encryption scheme.
- Every credential use MUST call `recordTaskStep(..., phase: 'credential_use')` from Phase 1 — no separate audit UI, it rides the existing activity feed.
- Sensitive-action confirmation follows the exact `executionMode: 'review'` pattern already in `api/action-contracts.js` (see `stripe_charge` etc.) — do not invent a second confirmation mechanism.
- A credential must never appear in an LLM prompt/context — it is only ever handled inside `browser-task.js`'s page-injection code, server-side, outside the model's context window.

---

### Task 1: `credentials` table + vault service

**Files:**
- Create: `supabase/migrations/supabase-migration-credentials.sql`
- Create: `api/services/credential-vault.js`
- Test: `api/services/credential-vault.test.js`

**Interfaces:**
- Consumes: `encryptTokens(payload)` / `decryptTokens(blob)` from `api/services/token-crypto.js` (same signatures `agent-card.js` already uses).
- Produces: `saveCredential(supabase, userId, { site, username, secret }) -> credential` (encrypts `secret` before storage), `getCredentialForUse(supabase, userId, credentialId) -> { site, username, secret } | null` (decrypts — only ever called from within `browser-task.js` during an active task, never from a chat/model-facing path), `listCredentials(supabase, userId) -> { credentials: [masked...] }` (never includes `secret`), `deleteCredential(supabase, userId, credentialId) -> { ok }`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/supabase-migration-credentials.sql
create table if not exists credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  site text not null,
  username text not null,
  secret_encrypted text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists credentials_user_site_idx on credentials (user_id, site);

alter table credentials enable row level security;

create policy "credentials_select_own" on credentials for select using (auth.uid() = user_id);
create policy "credentials_insert_own" on credentials for insert with check (auth.uid() = user_id);
create policy "credentials_delete_own" on credentials for delete using (auth.uid() = user_id);
```

- [ ] **Step 2: Write the failing tests**

```javascript
// api/services/credential-vault.test.js
jest.mock('./token-crypto', () => ({
  encryptTokens: jest.fn((payload) => `enc(${JSON.stringify(payload)})`),
  decryptTokens: jest.fn((blob) => JSON.parse(blob.replace(/^enc\(|\)$/g, ''))),
}));

const { saveCredential, listCredentials, getCredentialForUse, deleteCredential } = require('./credential-vault');

test('saveCredential encrypts the secret and listCredentials never exposes it', async () => {
  const store = [];
  const supabase = makeFakeCredentialsSupabase(store);
  await saveCredential(supabase, 'u1', { site: 'linkedin.com', username: 'jane@x.com', secret: 'hunter2' });
  const { credentials } = await listCredentials(supabase, 'u1');
  expect(credentials).toHaveLength(1);
  expect(credentials[0].secret).toBeUndefined();
  expect(credentials[0].site).toBe('linkedin.com');
});

test('getCredentialForUse decrypts and returns the plaintext secret', async () => {
  const store = [];
  const supabase = makeFakeCredentialsSupabase(store);
  const saved = await saveCredential(supabase, 'u1', { site: 'linkedin.com', username: 'jane@x.com', secret: 'hunter2' });
  const full = await getCredentialForUse(supabase, 'u1', saved.id);
  expect(full.secret).toBe('hunter2');
});

test('deleteCredential only removes the matching user+id', async () => {
  const store = [];
  const supabase = makeFakeCredentialsSupabase(store);
  const saved = await saveCredential(supabase, 'u1', { site: 'x.com', username: 'a', secret: 'b' });
  const result = await deleteCredential(supabase, 'u1', saved.id);
  expect(result.ok).toBe(true);
});
```

(`makeFakeCredentialsSupabase` — same chainable-fake builder pattern as `task-steps.test.js`/`routines.test.js`: `.from().insert().select().single()`, `.from().select().eq().order()`/no-order, `.from().delete().eq().eq()`, plus `.from().update().eq().eq()` for `last_used_at`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest api/services/credential-vault.test.js`
Expected: FAIL with "Cannot find module './credential-vault'"

- [ ] **Step 4: Implement `credential-vault.js`**

```javascript
// api/services/credential-vault.js
const { encryptTokens, decryptTokens } = require('./token-crypto');

async function saveCredential(supabase, userId, { site, username, secret }) {
  const secretEncrypted = encryptTokens({ username, secret });
  const { data, error } = await supabase
    .from('credentials')
    .insert({ user_id: userId, site, username, secret_encrypted: secretEncrypted })
    .select()
    .single();
  if (error) return { error };
  return data;
}

async function listCredentials(supabase, userId) {
  const { data, error } = await supabase
    .from('credentials')
    .select('id, site, username, created_at, last_used_at')
    .eq('user_id', userId);
  if (error) return { credentials: [], error };
  return { credentials: data };
}

async function getCredentialForUse(supabase, userId, credentialId) {
  const { data, error } = await supabase
    .from('credentials')
    .select('*')
    .eq('id', credentialId)
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  const { username, secret } = decryptTokens(data.secret_encrypted);
  await supabase.from('credentials').update({ last_used_at: new Date().toISOString() }).eq('id', credentialId).eq('user_id', userId);
  return { site: data.site, username, secret };
}

async function deleteCredential(supabase, userId, credentialId) {
  const { error } = await supabase.from('credentials').delete().eq('id', credentialId).eq('user_id', userId);
  if (error) return { ok: false, error };
  return { ok: true };
}

module.exports = { saveCredential, listCredentials, getCredentialForUse, deleteCredential };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest api/services/credential-vault.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/supabase-migration-credentials.sql api/services/credential-vault.js api/services/credential-vault.test.js
git commit -m "feat(vault): add credentials table and encrypted vault service"
```

---

### Task 2: Vault REST endpoints

**Files:**
- Modify: `api/index.js` (add routes near `/connectors/agent-card`, same auth middleware)
- Test: `api/index.test.js`

**Interfaces:**
- Produces: `POST /vault/credentials` `{site, username, secret}` → `201 {id, site, username, created_at}` (never echoes `secret`); `GET /vault/credentials` → `200 {credentials: [...]}`; `DELETE /vault/credentials/:id` → `200 {ok}`.

- [ ] **Step 1: Write the failing tests**

```javascript
test('POST /vault/credentials saves and never returns the secret', async () => {
  const res = await request(app)
    .post('/vault/credentials')
    .set('Authorization', `Bearer ${testUserToken}`)
    .send({ site: 'linkedin.com', username: 'jane@x.com', secret: 'hunter2' });
  expect(res.status).toBe(201);
  expect(res.body.secret).toBeUndefined();
});

test('GET /vault/credentials lists without secrets', async () => {
  const res = await request(app).get('/vault/credentials').set('Authorization', `Bearer ${testUserToken}`);
  expect(res.status).toBe(200);
  expect(res.body.credentials.every((c) => c.secret === undefined)).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest api/index.test.js -t "vault/credentials"`
Expected: FAIL (404, routes don't exist)

- [ ] **Step 3: Implement routes**

```javascript
const { saveCredential, listCredentials, deleteCredential } = require('./services/credential-vault');

app.post('/vault/credentials', requireAuth, async (req, res) => {
  const { site, username, secret } = req.body;
  if (!site || !username || !secret) return res.status(400).json({ error: 'site, username, secret required' });
  const saved = await saveCredential(supabase, req.user.id, { site, username, secret });
  res.status(201).json({ id: saved.id, site: saved.site, username: saved.username, created_at: saved.created_at });
});

app.get('/vault/credentials', requireAuth, async (req, res) => {
  const { credentials } = await listCredentials(supabase, req.user.id);
  res.json({ credentials });
});

app.delete('/vault/credentials/:id', requireAuth, async (req, res) => {
  const result = await deleteCredential(supabase, req.user.id, req.params.id);
  res.json(result);
});
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest api/index.test.js -t "vault/credentials"`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add api/index.js api/index.test.js
git commit -m "feat(vault): add /vault/credentials REST endpoints"
```

---

### Task 3: Scoped per-task grants + audit logging on use

**Files:**
- Create: `api/services/credential-grants.js`
- Test: `api/services/credential-grants.test.js`
- Modify: `api/services/browser-task.js` (autofill call site)

**Interfaces:**
- Produces: `checkGrant(taskGrants, credentialId)` — `taskGrants` is `string[]` of credential ids the dispatching task declared it needs (set at task-creation time by whatever already builds a browser-task session — the task dispatcher must be extended to accept an optional `credentialIds` field); returns `boolean`.
- Produces: `useCredential(supabase, { userId, taskId, credentialId, taskGrants })` → looks up via `getCredentialForUse` (Task 1) **only if** `checkGrant(taskGrants, credentialId)` is true, else returns `{ error: 'not_granted' }`; on success, calls `recordTaskStep(supabase, { taskId, userId, stepName: `Used saved credential for ${site}`, phase: 'credential_use', detail: { credentialId, site } })` (Phase 1's helper) before returning the credential.

- [ ] **Step 1: Write the failing tests**

```javascript
// api/services/credential-grants.test.js
const { checkGrant, useCredential } = require('./credential-grants');

test('checkGrant returns true only if the credential id is in the task grants', () => {
  expect(checkGrant(['cred-1', 'cred-2'], 'cred-1')).toBe(true);
  expect(checkGrant(['cred-1'], 'cred-2')).toBe(false);
  expect(checkGrant([], 'cred-1')).toBe(false);
});

test('useCredential refuses an ungranted credential without touching the vault', async () => {
  const vaultCalls = [];
  jest.mock('./credential-vault', () => ({
    getCredentialForUse: jest.fn(async () => { vaultCalls.push('called'); return { site: 'x', username: 'a', secret: 'b' }; }),
  }));
  const result = await useCredential({}, { userId: 'u1', taskId: 't1', credentialId: 'cred-2', taskGrants: ['cred-1'] });
  expect(result.error).toBe('not_granted');
  expect(vaultCalls).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest api/services/credential-grants.test.js`
Expected: FAIL, module not found

- [ ] **Step 3: Implement `credential-grants.js`**

```javascript
// api/services/credential-grants.js
const { getCredentialForUse } = require('./credential-vault');
const { recordTaskStep } = require('./task-steps');

function checkGrant(taskGrants, credentialId) {
  return Array.isArray(taskGrants) && taskGrants.includes(credentialId);
}

async function useCredential(supabase, { userId, taskId, credentialId, taskGrants }) {
  if (!checkGrant(taskGrants, credentialId)) {
    return { error: 'not_granted' };
  }
  const credential = await getCredentialForUse(supabase, userId, credentialId);
  if (!credential) return { error: 'not_found' };
  await recordTaskStep(supabase, {
    taskId,
    userId,
    stepName: `Used saved credential for ${credential.site}`,
    phase: 'credential_use',
    detail: { credentialId, site: credential.site },
  });
  return credential;
}

module.exports = { checkGrant, useCredential };
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest api/services/credential-grants.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire into `browser-task.js` login autofill**

Find the point in `browser-task.js` where a task session is dispatched (same place Task 2 of Phase 1 wraps `onProgress`) and add a `credentialIds: string[]` field to whatever object represents the incoming task request, defaulting to `[]`. Wherever the automation needs to log into a site (new code, since general-login autofill doesn't exist yet — model it on the existing `confirmPayment` iframe/plain-form-fill classifier), call `useCredential(supabase, { userId, taskId, credentialId, taskGrants: session.credentialIds })` and fill the returned `username`/`secret` into the detected login form fields, following the same "fill only after explicit readiness check, never log the raw values" discipline already used for card fill.

- [ ] **Step 6: Commit**

```bash
git add api/services/credential-grants.js api/services/credential-grants.test.js api/services/browser-task.js
git commit -m "feat(vault): scoped per-task credential grants + audit log on use"
```

---

### Task 4: Generalize the confirmation gate beyond payments

**Files:**
- Modify: `api/action-contracts.js`
- Test: `api/action-contracts.test.js`

**Interfaces:**
- Consumes: existing `getActionContract(type)` (line 449) fail-safe logic — `executionMode: 'review'` whenever `confirmation` is `'review'`/`'review_required'` or `risk: 'high'`.
- Produces: two new contract types, `send_message` and `create_post`, both declared with `confirmation: 'review_required'`, so they fall through the existing fail-safe with zero new logic — this task is additive data, not new mechanism.

- [ ] **Step 1: Write the failing tests**

```javascript
test('send_message and create_post contracts require review', () => {
  const { getActionContract } = require('./action-contracts');
  expect(getActionContract('send_message').executionMode).toBe('review');
  expect(getActionContract('create_post').executionMode).toBe('review');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest api/action-contracts.test.js -t "send_message and create_post"`
Expected: FAIL (contract undefined)

- [ ] **Step 3: Add the two contracts**

Find the object/map where `stripe_charge` etc. are declared in `api/action-contracts.js` and add, following its exact shape:

```javascript
send_message: {
  confirmation: 'review_required',
  risk: 'high',
},
create_post: {
  confirmation: 'review_required',
  risk: 'high',
},
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest api/action-contracts.test.js -t "send_message and create_post"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/action-contracts.js api/action-contracts.test.js
git commit -m "feat(guardrails): require review confirmation for send_message and create_post"
```

---

### Task 5: iOS vault settings screen (Keychain-cached display only)

**Files:**
- Read first: `OxyApp/OxyApp/Views/Settings/SettingsView.swift`, `OxyApp/OxyApp/Views/Connectors/` (existing connectors list pattern)
- Create: `OxyApp/OxyApp/Models/VaultCredential.swift`
- Create: `OxyApp/OxyApp/Services/VaultService.swift`
- Create: `OxyApp/OxyApp/Views/Vault/VaultListView.swift`

**Interfaces:**
- Produces: `struct VaultCredential: Codable, Identifiable { let id: String; let site: String; let username: String; let createdAt: Date; let lastUsedAt: Date? }`.
- Produces: `VaultService.add(site:username:secret:) async throws`, `VaultService.list() async throws -> [VaultCredential]`, `VaultService.delete(id:) async throws` — thin REST wrappers over the Task 2 endpoints, following the same `URLSession`/auth-header pattern as `TaskStepsService` from Phase 1.

- [ ] **Step 1: Model + service**

```swift
// OxyApp/OxyApp/Models/VaultCredential.swift
import Foundation

struct VaultCredential: Codable, Identifiable {
    let id: String
    let site: String
    let username: String
    let createdAt: Date
    let lastUsedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, site, username
        case createdAt = "created_at"
        case lastUsedAt = "last_used_at"
    }
}
```

```swift
// OxyApp/OxyApp/Services/VaultService.swift
import Foundation

enum VaultService {
    static func add(site: String, username: String, secret: String, accessToken: String, baseURL: URL) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("/vault/credentials"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["site": site, "username": username, "secret": secret])
        _ = try await URLSession.shared.data(for: request)
    }

    static func list(accessToken: String, baseURL: URL) async throws -> [VaultCredential] {
        var request = URLRequest(url: baseURL.appendingPathComponent("/vault/credentials"))
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: request)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        struct Response: Codable { let credentials: [VaultCredential] }
        return try decoder.decode(Response.self, from: data).credentials
    }

    static func delete(id: String, accessToken: String, baseURL: URL) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("/vault/credentials/\(id)"))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        _ = try await URLSession.shared.data(for: request)
    }
}
```

- [ ] **Step 2: Build `VaultListView`**

Follow the exact list/row/add-sheet/swipe-to-delete pattern already used in the Connectors view (read `OxyApp/OxyApp/Views/Connectors/` first) — a vault credential row is conceptually the same shape as a connector row (icon/site, username subtitle, swipe to remove), so reuse that visual pattern rather than inventing new list styling.

- [ ] **Step 3: Manual verification**

Add a credential via the UI, confirm it appears in `GET /vault/credentials`, dispatch a task that references it, confirm a `credential_use` step shows up in the Phase 1 activity feed, delete it, confirm removal.

- [ ] **Step 4: Commit**

```bash
git add OxyApp/OxyApp/Models/VaultCredential.swift OxyApp/OxyApp/Services/VaultService.swift OxyApp/OxyApp/Views/Vault/VaultListView.swift
git commit -m "feat(ios): add vault settings screen for credential management"
```
