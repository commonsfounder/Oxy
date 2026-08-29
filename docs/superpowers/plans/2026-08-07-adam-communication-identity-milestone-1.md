# Adam Communication Identity — Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every user a persistent Adam-owned communication identity (one email handle, one phone handle) and a channel-agnostic conversation model, with real outbound/inbound **email** working end-to-end and phone/SMS provisioned and working where straightforward — no WhatsApp, Telegram, or voice calling in this milestone.

**Architecture:** One `millie_identities` row per user owns zero-or-more `millie_identity_handles` (one per channel type — `email`, `phone_sms`). A `participants` directory (with `participant_addresses` across channels) represents the businesses/people Adam talks to. `external_conversations` is the channel-agnostic thread — `(millie_identity, participant, optional request)` — and `external_conversation_events` is the append-only log of individual sends/receives, each tagged with its own `channel_type`. Outbound goes through the existing action-contract + pending-review pipeline (`api/action-contracts.js` → `api/services/action-runner.js` → `executeAction`). Inbound arrives via two new thin webhook routes that normalize a provider payload, match it to a conversation, append an event, and classify it (surface-only vs. needs-a-decision) via a new small `reply-policy` module — never auto-reply.

**Tech Stack:** Existing stack only — Node/Express, Supabase (Postgres, service-role client, no RLS — see Global Constraints), `axios` for provider HTTP calls (no new SDK dependencies). New providers: **Resend** for email (already integrated in this codebase for transactional mail — reused, not replaced), **Twilio** for phone number + SMS (net-new, plain REST via `axios`, no `twilio` npm package).

## Global Constraints

- **No RLS, no `auth.uid()` policies on new tables.** This app's real auth is a homegrown session system (`api/index.js`'s `hashPassword`/session tokens) — Supabase Auth is never used, so `auth.uid()` is always null and any RLS policy referencing it is dead on arrival. Access control is enforced entirely in the Node backend via `requireMatchingUser`/session checks before the service-role Supabase client is ever touched. This is a proven, deliberate pattern in this codebase (see `supabase/migrations/supabase-migration-fix-user-id-fk.sql`) — do not add RLS to the new tables.
- **`user_id` columns are `text references users(user_id)`, never `uuid references auth.users(id)`.** This exact bug (wrong FK target) has broken five tables in this codebase before and silently dropped every write. Every new table's `user_id` column must match this pattern exactly.
- **No user-facing jargon.** Nothing in copy shown to the user should say "channel," "webhook," "identity," "adapter," "routing," "conversation thread," etc. Internally these are the right words; externally it's "Adam can contact people for me."
- **No auto-reply in this milestone.** Every outbound send in this milestone is either the user's direct instruction or the user's explicit confirmation of a suggested reply. Nothing is composed and sent by Adam without a human step in between.
- **Outreach must be grounded in a user-authorised goal — three distinct concepts, only one of them built now:**
  1. **User-triggered outreach** — explicitly requested in this turn. **Allowed in Milestone 1** — this is the entire scope of Tasks 6 and 11.
  2. **Proactive continuation** — communication necessary to continue a request the user has *already* delegated (e.g. "sort out this restaurant booking" → the restaurant never replies → Adam may need to follow up, because finishing that communication *is* the job she was asked to do). **Not implemented in Milestone 1** — no code sends anything without a fresh, explicit user instruction or confirmation this milestone. But the data model must retain enough state (below) that adding scheduled follow-up later is an additive service, not a schema redesign.
  3. **Unsolicited cold outreach** — contacting someone with no connection to any user-authorised goal. **Prohibited outright**, not just deferred — this is not a "later" feature, it's out of scope permanently unless a future product decision explicitly revisits it.

  The operating principle for this milestone: *Adam does not initiate unrelated outreach on her own. Communication must be grounded in a user-authorised goal. In this milestone, every outbound send still requires a direct user instruction or explicit confirmation.*
- **Consequential sends stay review-gated.** Every new outbound action type gets `executionMode: 'review'` in its action contract — this is a config value, not a code path to build; `action-runner.js` already routes any contract with that flag through the existing approval flow unconditionally.
- **Inbound content is untrusted.** Inbound message bodies are stored and displayed as data, never treated as instructions, never concatenated into a prompt in a way that could be mistaken for a system or user directive.
- **Adam identifies herself.** Every outbound message is composed with an explicit signature/identifier line — enforced in the sending code, not left to model discretion.
- **Encrypt message bodies at rest**, reusing `api/services/token-crypto.js`'s existing `encryptTokens`/`decryptTokens` (AES-256-GCM, same `OXY_TOKEN_ENCRYPTION_KEY`) rather than inventing new crypto.

---

## What already exists that this plan reuses (do not rebuild)

- `api/services/token-crypto.js` — `encryptTokens(obj)`/`decryptTokens(envelope)`. Works on any JSON-serializable object; message bodies get wrapped as `{ subject, body }` before encrypting.
- `api/services/action-runner.js` — the review-gate dispatcher. A contract with `executionMode: 'review'` is *automatically* routed through `setPendingAction` + `buildPendingReviewResult`. No changes needed to this file.
- `api/services/pending-review.js` — add two `case` entries (copy detail text), nothing structural.
- `api/services/data-retention.js` — `RETENTION_POLICY` is a declarative object; add one entry.
- `api/services/life-briefing.js` — `buildLifeBriefing()`'s dedupe/rank/publicItem pipeline; add one new item-source array, don't touch the pipeline itself.
- `api/services/email.js` — confirms Resend (`RESEND_API_KEY`, `axios.post('https://api.resend.com/emails', ...)`) is **already the platform's email provider**, already sending from a verified domain. Milestone 1's email adapter is a sibling to this file, not a new vendor relationship.
- `agent_tasks` (`task-manager.js`) — the "ongoing request." Gets one new nullable FK column, no new table.

---

### Task 1: Migration — identity, participants, conversations, events

**Files:**
- Create: `supabase/migrations/supabase-migration-adam-identity.sql`
- Test: manual verification via Supabase MCP `execute_sql` after applying (schema-only migration; no app code to unit-test yet)

**Interfaces:**
- Produces: tables `millie_identities`, `millie_identity_handles`, `participants`, `participant_addresses`, `external_conversations`, `external_conversation_events`; new column `agent_tasks.conversation_id`.

- [ ] **Step 1: Write the migration SQL**

```sql
-- Adam's own persistent communication identity — one identity per user, with one
-- handle per channel type. Channel is scoped to email + phone_sms in this milestone;
-- adding 'whatsapp'/'telegram_bot' later is a one-line ALTER on the two check
-- constraints below, not a redesign.
--
-- No RLS: this app never uses Supabase Auth, auth.uid() is always null, and access
-- control is enforced entirely in the Node backend via the service-role client. See
-- supabase-migration-fix-user-id-fk.sql for the established, proven pattern this
-- migration follows exactly (user_id text references users(user_id), no policies).

create table millie_identities (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique references users(user_id) on delete cascade,
  display_name text not null default 'Adam',
  created_at timestamptz not null default now()
);

create table millie_identity_handles (
  id uuid primary key default gen_random_uuid(),
  millie_identity_id uuid not null references millie_identities(id) on delete cascade,
  channel_type text not null check (channel_type in ('email', 'phone_sms')),
  handle_value text not null,
  provider text not null,
  provider_ref text,
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (millie_identity_id, channel_type),
  unique (handle_value)
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  display_name text not null,
  business_name text,
  source text not null default 'learned' check (source in ('learned', 'manual')),
  created_at timestamptz not null default now()
);
create index participants_user_idx on participants (user_id, created_at desc);

create table participant_addresses (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references participants(id) on delete cascade,
  channel_type text not null check (channel_type in ('email', 'phone_sms')),
  address_value text not null,
  created_at timestamptz not null default now(),
  unique (participant_id, channel_type, address_value)
);
-- The hot path for inbound matching: "who is this address talking to already".
create index participant_addresses_lookup_idx on participant_addresses (channel_type, address_value);

create table external_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  millie_identity_id uuid not null references millie_identities(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  request_task_id uuid references agent_tasks(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'awaiting_reply', 'resolved', 'closed')),
  last_activity_at timestamptz not null default now(),
  -- Split from last_activity_at on purpose: a future follow-up scheduler needs to know
  -- "how long has it been since WE last heard from THEM" specifically, not just "when
  -- did anything last happen" (an outbound send updates last_activity_at too, but isn't
  -- a signal that a follow-up is due). Not read by any code in this milestone — reserved
  -- so scheduled follow-up (deferred, see Global Constraints) is an additive service
  -- later, not a schema change.
  last_outbound_at timestamptz,
  last_inbound_at timestamptz,
  -- When a future follow-up scheduler should next consider this conversation. Left null
  -- and unused in this milestone — no code sets or reads it yet.
  next_follow_up_at timestamptz,
  created_at timestamptz not null default now()
);
create index external_conversations_participant_idx on external_conversations (participant_id, status);
create index external_conversations_user_idx on external_conversations (user_id, last_activity_at desc);
-- Reserved for the future follow-up scheduler ("find conversations due for a check"),
-- unused until that service exists — partial index costs nothing while next_follow_up_at
-- is always null.
create index external_conversations_follow_up_idx on external_conversations (next_follow_up_at) where next_follow_up_at is not null;

create table external_conversation_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references external_conversations(id) on delete cascade,
  channel_type text not null check (channel_type in ('email', 'phone_sms')),
  direction text not null check (direction in ('outbound', 'inbound')),
  participant_address_id uuid references participant_addresses(id) on delete set null,
  millie_identity_handle_id uuid references millie_identity_handles(id) on delete set null,
  provider_event_id text,
  -- Encrypted envelope from token-crypto.js's encryptTokens({subject, body}) — never
  -- plaintext subject/body columns. See api/services/external-conversations.js.
  body_encrypted jsonb not null,
  needs_decision boolean not null default false,
  raw_provider_payload jsonb,
  created_at timestamptz not null default now()
);
create index external_conversation_events_conversation_idx on external_conversation_events (conversation_id, created_at);
create index external_conversation_events_needs_decision_idx on external_conversation_events (needs_decision) where needs_decision = true;

alter table agent_tasks add column conversation_id uuid references external_conversations(id) on delete set null;
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP `apply_migration` tool (or the SQL editor) against the `Oxy` project, with this file's contents as the migration body and name `millie_identity`.

- [ ] **Step 3: Verify the tables exist**

Run via Supabase MCP `execute_sql`:
```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('millie_identities', 'millie_identity_handles', 'participants', 'participant_addresses', 'external_conversations', 'external_conversation_events');
```
Expected: all 6 rows returned.

- [ ] **Step 4: Verify the agent_tasks column**

```sql
select column_name from information_schema.columns where table_name = 'agent_tasks' and column_name = 'conversation_id';
```
Expected: 1 row.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/supabase-migration-adam-identity.sql
git commit -m "feat(adam-identity): add schema for Adam's persistent communication identity"
```

---

### Task 2: `api/services/adam-identity.js` — identity + handle provisioning

**Files:**
- Create: `api/services/adam-identity.js`
- Test: Create: `test/smoke/adam-identity.test.js`

**Interfaces:**
- Consumes: a Supabase client (service-role, passed in — same convention as `task-entities.js`), `encryptTokens`/`decryptTokens` from `token-crypto.js` (not needed here — handles don't hold secrets, provider credentials are env vars, not per-user tokens).
- Produces: `ensureAdamIdentity(supabase, userId) -> Promise<{identity, handles}>`, `getAdamIdentity(supabase, userId) -> Promise<{identity, handles} | null>`, `getActiveHandle(supabase, userId, channelType) -> Promise<handleRow | null>`. Later tasks (3, 6, 11) call `getActiveHandle` to find "the" email/phone address to send from.

- [ ] **Step 1: Write the failing test**

```javascript
// test/smoke/adam-identity.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { ensureAdamIdentity, getAdamIdentity, getActiveHandle, buildEmailHandleValue } = require('../../api/services/adam-identity');

function fakeSupabase(seed = {}) {
  const state = {
    millie_identities: [...(seed.millie_identities || [])],
    millie_identity_handles: [...(seed.millie_identity_handles || [])]
  };
  function table(name) {
    return {
      select: () => table(name),
      insert: (row) => {
        const withId = { id: `${name}-${state[name].length + 1}`, ...row };
        state[name].push(withId);
        return { select: () => ({ single: async () => ({ data: withId, error: null }) }) };
      },
      eq(field, value) {
        this._filters = [...(this._filters || []), [field, value]];
        return this;
      },
      limit() { return this; },
      async then(resolve) {
        const rows = state[name].filter(row => (this._filters || []).every(([f, v]) => row[f] === v));
        resolve({ data: rows, error: null });
      }
    };
  }
  return { from: table, _state: state };
}

test('ensureAdamIdentity creates an identity and an email handle for a new user', async () => {
  const supabase = fakeSupabase();
  const result = await ensureAdamIdentity(supabase, 'chizi', { attemptPhone: false });
  assert.equal(result.identity.user_id, 'chizi');
  const emailHandle = result.handles.find(h => h.channel_type === 'email');
  assert.ok(emailHandle, 'expected an email handle to be created');
  assert.equal(emailHandle.handle_value, buildEmailHandleValue('chizi'));
  assert.equal(emailHandle.status, 'active');
});

test('ensureAdamIdentity is idempotent — calling twice does not create a second identity', async () => {
  const supabase = fakeSupabase();
  const first = await ensureAdamIdentity(supabase, 'chizi', { attemptPhone: false });
  const second = await ensureAdamIdentity(supabase, 'chizi', { attemptPhone: false });
  assert.equal(first.identity.id, second.identity.id);
  assert.equal(supabase._state.millie_identities.length, 1);
});

test('buildEmailHandleValue produces a stable per-user address under the configured domain', () => {
  const oldDomain = process.env.MILLIE_EMAIL_DOMAIN;
  process.env.MILLIE_EMAIL_DOMAIN = 'millie.oxy.app';
  try {
    assert.equal(buildEmailHandleValue('chizi'), 'chizi@millie.oxy.app');
  } finally {
    if (oldDomain === undefined) delete process.env.MILLIE_EMAIL_DOMAIN;
    else process.env.MILLIE_EMAIL_DOMAIN = oldDomain;
  }
});

test('getActiveHandle returns null when no handle of that channel exists', async () => {
  const supabase = fakeSupabase();
  await ensureAdamIdentity(supabase, 'chizi', { attemptPhone: false });
  const phone = await getActiveHandle(supabase, 'chizi', 'phone_sms');
  assert.equal(phone, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/smoke/adam-identity.test.js`
Expected: FAIL — `Cannot find module '../../api/services/adam-identity'`

- [ ] **Step 3: Write the implementation**

```javascript
// api/services/adam-identity.js
'use strict';

// Adam's own persistent communication identity. One row per user in
// millie_identities; one row per channel in millie_identity_handles. Provisioning
// is idempotent and safe to call repeatedly — ensureAdamIdentity always returns
// the existing identity/handles if they're already there, never duplicates them.
//
// Phone provisioning can fail (Twilio not configured, no numbers available in the
// user's region, etc.) without blocking email provisioning or user signup — each
// channel is attempted and recorded independently.

function normalizeUserIdForAddress(userId) {
  return String(userId || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '')
    .slice(0, 64);
}

function buildEmailHandleValue(userId) {
  const domain = process.env.MILLIE_EMAIL_DOMAIN || 'millie.oxy.app';
  return `${normalizeUserIdForAddress(userId)}@${domain}`;
}

async function getAdamIdentity(supabase, userId) {
  const { data: identities, error } = await supabase
    .from('millie_identities')
    .select('*')
    .eq('user_id', userId)
    .limit(1);
  if (error || !identities?.length) return null;
  const identity = identities[0];
  const { data: handles } = await supabase
    .from('millie_identity_handles')
    .select('*')
    .eq('millie_identity_id', identity.id);
  return { identity, handles: handles || [] };
}

async function getActiveHandle(supabase, userId, channelType) {
  const existing = await getAdamIdentity(supabase, userId);
  if (!existing) return null;
  return existing.handles.find(h => h.channel_type === channelType && h.status === 'active') || null;
}

async function ensureEmailHandle(supabase, identityId, userId) {
  const handleValue = buildEmailHandleValue(userId);
  const { data } = await supabase.from('millie_identity_handles').insert({
    millie_identity_id: identityId,
    channel_type: 'email',
    handle_value: handleValue,
    provider: 'resend',
    status: 'active'
  }).select().single();
  return data;
}

async function ensurePhoneHandle(supabase, identityId, userId, provisionPhoneNumber) {
  try {
    const provisioned = await provisionPhoneNumber(userId);
    if (!provisioned?.phoneNumber) return null;
    const { data } = await supabase.from('millie_identity_handles').insert({
      millie_identity_id: identityId,
      channel_type: 'phone_sms',
      handle_value: provisioned.phoneNumber,
      provider: 'twilio',
      provider_ref: provisioned.providerRef || null,
      status: 'active'
    }).select().single();
    return data;
  } catch (err) {
    console.warn('[adam-identity] phone provisioning failed, continuing without it:', err.message);
    return null;
  }
}

async function ensureAdamIdentity(supabase, userId, { attemptPhone = true, provisionPhoneNumber } = {}) {
  const existing = await getAdamIdentity(supabase, userId);
  if (existing) {
    // Fill in any missing handle (e.g. phone provisioning was skipped or failed before).
    const handles = [...existing.handles];
    if (!handles.some(h => h.channel_type === 'email')) {
      const created = await ensureEmailHandle(supabase, existing.identity.id, userId);
      if (created) handles.push(created);
    }
    if (attemptPhone && provisionPhoneNumber && !handles.some(h => h.channel_type === 'phone_sms')) {
      const created = await ensurePhoneHandle(supabase, existing.identity.id, userId, provisionPhoneNumber);
      if (created) handles.push(created);
    }
    return { identity: existing.identity, handles };
  }

  const { data: identity, error } = await supabase.from('millie_identities').insert({
    user_id: userId,
    display_name: 'Adam'
  }).select().single();
  if (error) throw new Error(`Failed to create Adam identity: ${error.message}`);

  const handles = [];
  const emailHandle = await ensureEmailHandle(supabase, identity.id, userId);
  if (emailHandle) handles.push(emailHandle);
  if (attemptPhone && provisionPhoneNumber) {
    const phoneHandle = await ensurePhoneHandle(supabase, identity.id, userId, provisionPhoneNumber);
    if (phoneHandle) handles.push(phoneHandle);
  }
  return { identity, handles };
}

module.exports = { ensureAdamIdentity, getAdamIdentity, getActiveHandle, buildEmailHandleValue };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/smoke/adam-identity.test.js`
Expected: PASS, 4/4

- [ ] **Step 5: Commit**

```bash
git add api/services/adam-identity.js test/smoke/adam-identity.test.js
git commit -m "feat(adam-identity): add identity/handle provisioning service"
```

---

### Task 3: `connectors/adam-email-resend.js` — email provider adapter

**Files:**
- Create: `connectors/adam-email-resend.js`
- Test: Create: `test/smoke/adam-email-resend.test.js`

**Interfaces:**
- Consumes: `axios` (mocked in tests, same pattern as `test/smoke/geocoding.test.js`).
- Produces: `sendAdamEmail({ from, to, subject, body, inReplyTo, references }) -> Promise<{providerMessageId}>`; `parseInboundPayload(payload) -> {fromAddress, toAddress, subject, body, providerMessageId, inReplyTo, references} | null`; `MILLIE_EMAIL_SIGNATURE_LINE` (exported constant, used by Task 6 to enforce self-identification).

- [ ] **Step 1: Write the failing test**

```javascript
// test/smoke/adam-email-resend.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const mockAxios = { post: async () => ({}) };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'axios') return mockAxios;
  return originalLoad.call(this, request, parent, isMain);
};
const { sendAdamEmail, parseInboundPayload, MILLIE_EMAIL_SIGNATURE_LINE } = require('../../connectors/adam-email-resend');
Module._load = originalLoad;

test('sendAdamEmail posts to Resend with the from/to/subject/body and appends the signature line', async () => {
  const oldKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  let captured;
  const oldPost = mockAxios.post;
  mockAxios.post = async (url, body, config) => {
    captured = { url, body, config };
    return { data: { id: 'resend-msg-1' } };
  };
  try {
    const result = await sendAdamEmail({
      from: 'chizi@millie.oxy.app',
      to: 'reservations@bistro.example',
      subject: 'Booking change',
      body: 'Could you move our booking to 8pm?'
    });
    assert.equal(captured.url, 'https://api.resend.com/emails');
    assert.equal(captured.body.from, 'chizi@millie.oxy.app');
    assert.equal(captured.body.to, 'reservations@bistro.example');
    assert.match(captured.body.text, /Could you move our booking to 8pm\?/);
    assert.match(captured.body.text, new RegExp(MILLIE_EMAIL_SIGNATURE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(result.providerMessageId, 'resend-msg-1');
  } finally {
    mockAxios.post = oldPost;
    if (oldKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = oldKey;
  }
});

test('parseInboundPayload normalizes a Resend inbound webhook payload', () => {
  const payload = {
    data: {
      from: 'Reservations <reservations@bistro.example>',
      to: ['chizi@millie.oxy.app'],
      subject: 'Re: Booking change',
      text: 'We can do 8:15, does that work?',
      email_id: 'inbound-msg-1',
      headers: { 'in-reply-to': '<outbound-msg-1@resend>', references: '<outbound-msg-1@resend>' }
    }
  };
  const normalized = parseInboundPayload(payload);
  assert.equal(normalized.fromAddress, 'reservations@bistro.example');
  assert.equal(normalized.toAddress, 'chizi@millie.oxy.app');
  assert.equal(normalized.body, 'We can do 8:15, does that work?');
  assert.equal(normalized.providerMessageId, 'inbound-msg-1');
  assert.equal(normalized.inReplyTo, '<outbound-msg-1@resend>');
});

test('parseInboundPayload returns null for a payload with no usable from address', () => {
  assert.equal(parseInboundPayload({ data: {} }), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/smoke/adam-email-resend.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// connectors/adam-email-resend.js
'use strict';
const axios = require('axios');

// Adam's own outbound/inbound email, sent through the same Resend account this
// platform already uses for transactional mail (api/services/email.js) — a
// sibling integration, not a new vendor relationship. Inbound requires Resend's
// inbound-receiving feature to be configured on MILLIE_EMAIL_DOMAIN with a webhook
// pointed at POST /webhooks/millie-email (Task 7) — verify current availability/
// pricing on the Resend plan in use before relying on this in production.

const MILLIE_EMAIL_SIGNATURE_LINE = "— sent by Adam, an assistant, on behalf of the person who asked";

function extractAddress(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(value || '')).trim().toLowerCase();
}

async function sendAdamEmail({ from, to, subject, body, inReplyTo, references }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not configured — Adam cannot send email yet.');
  const text = `${body}\n\n${MILLIE_EMAIL_SIGNATURE_LINE}`;
  const headers = {};
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references) headers['References'] = references;
  const response = await axios.post('https://api.resend.com/emails', {
    from,
    to,
    subject,
    text,
    ...(Object.keys(headers).length ? { headers } : {})
  }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  return { providerMessageId: response.data?.id || null };
}

function parseInboundPayload(payload) {
  const data = payload?.data || payload || {};
  const fromAddress = extractAddress(data.from);
  if (!fromAddress) return null;
  const toRaw = Array.isArray(data.to) ? data.to[0] : data.to;
  return {
    fromAddress,
    toAddress: extractAddress(toRaw),
    subject: String(data.subject || ''),
    body: String(data.text || data.html || ''),
    providerMessageId: data.email_id || data.id || null,
    inReplyTo: data.headers?.['in-reply-to'] || data.headers?.['In-Reply-To'] || null,
    references: data.headers?.references || data.headers?.References || null
  };
}

module.exports = { sendAdamEmail, parseInboundPayload, MILLIE_EMAIL_SIGNATURE_LINE };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/smoke/adam-email-resend.test.js`
Expected: PASS, 3/3

- [ ] **Step 5: Commit**

```bash
git add connectors/adam-email-resend.js test/smoke/adam-email-resend.test.js
git commit -m "feat(adam-identity): add Resend email adapter for Adam's own address"
```

---

### Task 4: `api/services/participants.js` — participant directory + address matching

**Files:**
- Create: `api/services/participants.js`
- Test: Create: `test/smoke/participants.test.js`

**Interfaces:**
- Produces: `findParticipantByAddress(supabase, userId, channelType, addressValue) -> Promise<participantRow | null>`, `findOrCreateParticipant(supabase, userId, { displayName, channelType, addressValue }) -> Promise<{participant, address, created}>`.
- Consumed by: Task 6 (outbound — resolve/create the participant being messaged), Task 7 (inbound — match the sender).

- [ ] **Step 1: Write the failing test**

```javascript
// test/smoke/participants.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { findParticipantByAddress, findOrCreateParticipant } = require('../../api/services/participants');

function fakeSupabase(seed = {}) {
  const state = { participants: [...(seed.participants || [])], participant_addresses: [...(seed.participant_addresses || [])] };
  function table(name) {
    const q = { _filters: [] };
    q.select = () => q;
    q.eq = (f, v) => { q._filters.push([f, v]); return q; };
    q.limit = () => q;
    q.insert = (row) => {
      const withId = { id: `${name}-${state[name].length + 1}`, created_at: new Date().toISOString(), ...row };
      state[name].push(withId);
      return { select: () => ({ single: async () => ({ data: withId, error: null }) }) };
    };
    q.then = (resolve) => resolve({
      data: state[name].filter(row => q._filters.every(([f, v]) => row[f] === v)),
      error: null
    });
    return q;
  }
  return { from: table, _state: state };
}

test('findParticipantByAddress returns null when no participant has that address', async () => {
  const supabase = fakeSupabase();
  const result = await findParticipantByAddress(supabase, 'chizi', 'email', 'reservations@bistro.example');
  assert.equal(result, null);
});

test('findOrCreateParticipant creates a new participant and address on first contact', async () => {
  const supabase = fakeSupabase();
  const { participant, address, created } = await findOrCreateParticipant(supabase, 'chizi', {
    displayName: 'The Bistro',
    channelType: 'email',
    addressValue: 'reservations@bistro.example'
  });
  assert.equal(created, true);
  assert.equal(participant.display_name, 'The Bistro');
  assert.equal(address.address_value, 'reservations@bistro.example');
});

test('findOrCreateParticipant reuses the existing participant on a repeat address', async () => {
  const supabase = fakeSupabase();
  const first = await findOrCreateParticipant(supabase, 'chizi', {
    displayName: 'The Bistro', channelType: 'email', addressValue: 'reservations@bistro.example'
  });
  const second = await findOrCreateParticipant(supabase, 'chizi', {
    displayName: 'Ignored — should not overwrite', channelType: 'email', addressValue: 'reservations@bistro.example'
  });
  assert.equal(second.created, false);
  assert.equal(second.participant.id, first.participant.id);
  assert.equal(second.participant.display_name, 'The Bistro');
});

test('findParticipantByAddress matches an existing participant by address', async () => {
  const supabase = fakeSupabase();
  await findOrCreateParticipant(supabase, 'chizi', {
    displayName: 'The Bistro', channelType: 'email', addressValue: 'reservations@bistro.example'
  });
  const found = await findParticipantByAddress(supabase, 'chizi', 'email', 'reservations@bistro.example');
  assert.equal(found.display_name, 'The Bistro');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/smoke/participants.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// api/services/participants.js
'use strict';

// The people/businesses Adam talks to on the user's behalf. A participant is
// channel-agnostic (participants.js, not "email_contacts.js") — participant_addresses
// is where the channel-specific reachability lives, since one participant (a
// restaurant) may have both a phone number and an email address.

async function findParticipantByAddress(supabase, userId, channelType, addressValue) {
  const normalized = String(addressValue || '').trim().toLowerCase();
  const { data: addresses, error } = await supabase
    .from('participant_addresses')
    .select('*')
    .eq('channel_type', channelType)
    .eq('address_value', normalized);
  if (error || !addresses?.length) return null;

  const { data: participants } = await supabase
    .from('participants')
    .select('*')
    .eq('id', addresses[0].participant_id)
    .eq('user_id', userId);
  return participants?.[0] || null;
}

async function findOrCreateParticipant(supabase, userId, { displayName, channelType, addressValue }) {
  const normalized = String(addressValue || '').trim().toLowerCase();
  const existing = await findParticipantByAddress(supabase, userId, channelType, normalized);
  if (existing) {
    const { data: addresses } = await supabase
      .from('participant_addresses')
      .select('*')
      .eq('participant_id', existing.id)
      .eq('channel_type', channelType)
      .eq('address_value', normalized);
    return { participant: existing, address: addresses[0], created: false };
  }

  const { data: participant, error: pError } = await supabase.from('participants').insert({
    user_id: userId,
    display_name: displayName || normalized,
    source: 'learned'
  }).select().single();
  if (pError) throw new Error(`Failed to create participant: ${pError.message}`);

  const { data: address, error: aError } = await supabase.from('participant_addresses').insert({
    participant_id: participant.id,
    channel_type: channelType,
    address_value: normalized
  }).select().single();
  if (aError) throw new Error(`Failed to create participant address: ${aError.message}`);

  return { participant, address, created: true };
}

module.exports = { findParticipantByAddress, findOrCreateParticipant };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/smoke/participants.test.js`
Expected: PASS, 4/4

- [ ] **Step 5: Commit**

```bash
git add api/services/participants.js test/smoke/participants.test.js
git commit -m "feat(adam-identity): add participant directory with cross-channel address matching"
```

---

### Task 5: `api/services/external-conversations.js` — the channel-agnostic thread

**Files:**
- Create: `api/services/external-conversations.js`
- Test: Create: `test/smoke/external-conversations.test.js`

**Interfaces:**
- Consumes: `encryptTokens`/`decryptTokens` from `api/services/token-crypto.js`.
- Produces: `findOpenConversationsForParticipant(supabase, participantId) -> Promise<conversationRow[]>`, `getOrCreateConversation(supabase, { userId, adamIdentityId, participantId, requestTaskId }) -> Promise<{conversation, created}>`, `appendEvent(supabase, { conversationId, channelType, direction, participantAddressId, adamIdentityHandleId, providerEventId, subject, body, needsDecision, rawProviderPayload }) -> Promise<eventRow>`, `getConversationEvents(supabase, conversationId) -> Promise<decryptedEventRow[]>`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/smoke/external-conversations.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getOrCreateConversation,
  appendEvent,
  getConversationEvents,
  findOpenConversationsForParticipant
} = require('../../api/services/external-conversations');

function fakeSupabase() {
  const state = { external_conversations: [], external_conversation_events: [] };
  function table(name) {
    const q = { _filters: [] };
    q.select = () => q;
    q.eq = (f, v) => { q._filters.push(['eq', f, v]); return q; };
    q.order = () => q;
    q.limit = () => q;
    q.update = (patch) => {
      const rows = state[name].filter(row => q._filters.every(([, f, v]) => row[f] === v));
      rows.forEach(row => Object.assign(row, patch));
      return { eq: () => ({ then: (resolve) => resolve({ error: null }) }) };
    };
    q.insert = (row) => {
      const withId = { id: `${name}-${state[name].length + 1}`, created_at: new Date().toISOString(), ...row };
      state[name].push(withId);
      return { select: () => ({ single: async () => ({ data: withId, error: null }) }) };
    };
    q.then = (resolve) => resolve({
      data: state[name]
        .filter(row => q._filters.every(([type, f, v]) => type !== 'eq' || row[f] === v))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      error: null
    });
    return q;
  }
  return { from: table, _state: state };
}

test('getOrCreateConversation creates a new open conversation for a new participant', async () => {
  const supabase = fakeSupabase();
  const { conversation, created } = await getOrCreateConversation(supabase, {
    userId: 'chizi', adamIdentityId: 'id-1', participantId: 'p-1', requestTaskId: 'task-1'
  });
  assert.equal(created, true);
  assert.equal(conversation.status, 'open');
  assert.equal(conversation.participant_id, 'p-1');
});

test('getOrCreateConversation reuses the existing open conversation for the same participant+request', async () => {
  const supabase = fakeSupabase();
  const first = await getOrCreateConversation(supabase, { userId: 'chizi', adamIdentityId: 'id-1', participantId: 'p-1', requestTaskId: 'task-1' });
  const second = await getOrCreateConversation(supabase, { userId: 'chizi', adamIdentityId: 'id-1', participantId: 'p-1', requestTaskId: 'task-1' });
  assert.equal(second.created, false);
  assert.equal(second.conversation.id, first.conversation.id);
});

test('appendEvent encrypts the body and getConversationEvents decrypts it back', async () => {
  const oldKey = process.env.OXY_TOKEN_ENCRYPTION_KEY;
  process.env.OXY_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64); // 32-byte hex
  try {
    const supabase = fakeSupabase();
    const { conversation } = await getOrCreateConversation(supabase, { userId: 'chizi', adamIdentityId: 'id-1', participantId: 'p-1' });
    await appendEvent(supabase, {
      conversationId: conversation.id,
      channelType: 'email',
      direction: 'outbound',
      subject: 'Booking change',
      body: 'Could you move our booking to 8pm?'
    });
    await appendEvent(supabase, {
      conversationId: conversation.id,
      channelType: 'email',
      direction: 'inbound',
      subject: 'Re: Booking change',
      body: 'We can do 8:15, does that work?',
      needsDecision: true
    });
    const events = await getConversationEvents(supabase, conversation.id);
    assert.equal(events.length, 2);
    assert.equal(events[0].direction, 'outbound');
    assert.equal(events[0].body, 'Could you move our booking to 8pm?');
    assert.equal(events[1].direction, 'inbound');
    assert.equal(events[1].body, 'We can do 8:15, does that work?');
    assert.equal(events[1].needs_decision, true);

    // Not read by anything yet, but must be tracked from day one — a future follow-up
    // scheduler needs to know when Adam last sent vs. last heard back, separately.
    const updatedConversation = supabase._state.external_conversations.find(c => c.id === conversation.id);
    assert.ok(updatedConversation.last_outbound_at, 'last_outbound_at must be set after an outbound event');
    assert.ok(updatedConversation.last_inbound_at, 'last_inbound_at must be set after an inbound event');
  } finally {
    if (oldKey === undefined) delete process.env.OXY_TOKEN_ENCRYPTION_KEY;
    else process.env.OXY_TOKEN_ENCRYPTION_KEY = oldKey;
  }
});

test('findOpenConversationsForParticipant returns only open/awaiting_reply conversations', async () => {
  const supabase = fakeSupabase();
  const { conversation } = await getOrCreateConversation(supabase, { userId: 'chizi', adamIdentityId: 'id-1', participantId: 'p-2' });
  const open = await findOpenConversationsForParticipant(supabase, 'p-2');
  assert.equal(open.length, 1);
  assert.equal(open[0].id, conversation.id);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/smoke/external-conversations.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// api/services/external-conversations.js
'use strict';
const { encryptTokens, decryptTokens } = require('./token-crypto');

// The channel-agnostic thread. A conversation belongs to (millie_identity,
// participant, optional request) — never to a channel. external_conversation_events
// carries the channel per-event, so a conversation can accumulate an email event
// today and (in a later milestone) an SMS or call event tomorrow without becoming
// a different conversation.

async function findOpenConversationsForParticipant(supabase, participantId) {
  const { data, error } = await supabase
    .from('external_conversations')
    .select('*')
    .eq('participant_id', participantId);
  if (error || !data) return [];
  return data.filter(c => c.status === 'open' || c.status === 'awaiting_reply');
}

async function getOrCreateConversation(supabase, { userId, adamIdentityId, participantId, requestTaskId = null }) {
  const open = await findOpenConversationsForParticipant(supabase, participantId);
  const matching = requestTaskId
    ? open.find(c => c.request_task_id === requestTaskId)
    : open.find(c => !c.request_task_id);
  if (matching) return { conversation: matching, created: false };

  const { data: conversation, error } = await supabase.from('external_conversations').insert({
    user_id: userId,
    millie_identity_id: adamIdentityId,
    participant_id: participantId,
    request_task_id: requestTaskId,
    status: 'open',
    last_activity_at: new Date().toISOString()
  }).select().single();
  if (error) throw new Error(`Failed to create conversation: ${error.message}`);
  return { conversation, created: true };
}

async function appendEvent(supabase, {
  conversationId, channelType, direction, participantAddressId = null, adamIdentityHandleId = null,
  providerEventId = null, subject = '', body, needsDecision = false, rawProviderPayload = null
}) {
  const bodyEncrypted = encryptTokens({ subject, body });
  const { data: event, error } = await supabase.from('external_conversation_events').insert({
    conversation_id: conversationId,
    channel_type: channelType,
    direction,
    participant_address_id: participantAddressId,
    millie_identity_handle_id: adamIdentityHandleId,
    provider_event_id: providerEventId,
    body_encrypted: bodyEncrypted,
    needs_decision: needsDecision,
    raw_provider_payload: rawProviderPayload
  }).select().single();
  if (error) throw new Error(`Failed to append conversation event: ${error.message}`);

  // last_outbound_at/last_inbound_at are written now even though nothing reads them
  // yet — this is exactly the state a future follow-up scheduler needs ("we sent
  // something and haven't heard back in N days"), and it's cheaper to keep it accurate
  // from day one than to backfill it later. next_follow_up_at is deliberately left
  // untouched here — no code in this milestone decides when a follow-up is due.
  const now = new Date().toISOString();
  const directionalUpdate = direction === 'outbound' ? { last_outbound_at: now } : { last_inbound_at: now };
  await supabase.from('external_conversations')
    .update({
      last_activity_at: now,
      status: direction === 'outbound' ? 'awaiting_reply' : 'open',
      ...directionalUpdate
    })
    .eq('id', conversationId);

  return event;
}

async function getConversationEvents(supabase, conversationId) {
  const { data, error } = await supabase
    .from('external_conversation_events')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error || !data) return [];
  return data.map(row => {
    const decrypted = decryptTokens(row.body_encrypted);
    return { ...row, subject: decrypted.subject || '', body: decrypted.body || '' };
  });
}

module.exports = { getOrCreateConversation, appendEvent, getConversationEvents, findOpenConversationsForParticipant };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/smoke/external-conversations.test.js`
Expected: PASS, 4/4

- [ ] **Step 5: Commit**

```bash
git add api/services/external-conversations.js test/smoke/external-conversations.test.js
git commit -m "feat(adam-identity): add channel-agnostic conversation + encrypted event log"
```

---

### Task 6: `send_adam_email` action — outbound flow, wired into the review gate

**Files:**
- Modify: `api/action-contracts.js` — add the `send_adam_email` contract
- Modify: `api/services/pending-review.js` — add the review-detail/prompt copy
- Modify: `api/services/user-facing-copy.js` — add the action label
- Modify: `api/index.js` — add `case 'send_adam_email'` to `executeAction`
- Test: Create: `test/smoke/adam-email-action.test.js`

**Interfaces:**
- Consumes: `ensureAdamIdentity`/`getActiveHandle` (Task 2), `findOrCreateParticipant` (Task 4), `getOrCreateConversation`/`appendEvent` (Task 5), `sendAdamEmail` (Task 3).
- Produces: the `send_adam_email` action, reachable via `executeAction(userId, 'send_adam_email', { to, subject, body, request_task_id? }, context)`.

- [ ] **Step 1: Add the action contract**

In `api/action-contracts.js`, add alongside the existing `send_email` entry (do not modify `send_email` itself):

```javascript
  send_adam_email: {
    risk: 'medium',
    required: ['to', 'body'],
    optional: ['subject', 'request_task_id'],
    aliases: { to: ['email', 'recipient'], body: ['message', 'content', 'text'] },
    inputExample: {
      to: 'business or contact email address',
      subject: 'optional subject inferred from the body if omitted',
      body: 'the message to send, on the user\'s behalf',
      request_task_id: 'optional id of the ongoing request this belongs to'
    },
    successSummary: 'Message sent from Adam',
    failureSummary: 'Message failed to send',
    confirmation: 'review_required',
    executionMode: 'review'
  },
```

- [ ] **Step 2: Add review-detail copy**

In `api/services/pending-review.js`, extend the existing `switch` in `reviewDetailForAction`:

```javascript
    case 'send_message':
    case 'send_telegram':
    case 'send_adam_email':
      return [input.to || input.contact, input.body || input.message].filter(Boolean).join(' · ');
```

(This changes the existing case block's fallthrough list to include `'send_adam_email'` — the body of the case is unchanged.)

And extend the prompt-text ternary in `buildPendingReviewResult`:

```javascript
  const prompt = action?.type === 'send_message'
    ? 'Check the message, then tap Send.'
    : action?.type === 'send_adam_email'
      ? 'Check the message, then confirm to send it.'
      : ['send_email', 'send_outlook_email'].includes(action?.type)
        ? 'Check the email, then tap Send.'
        : ['book_uber', 'book_lyft'].includes(action?.type)
          ? 'Check the ride, then tap Book.'
          : action?.type === 'book_appointment'
            ? 'Check the time, then tap Book.'
            : action?.type === 'make_call'
              ? 'Check the number, then tap Call.'
              : action?.type === 'create_calendar_event'
                ? 'Check the details, then tap Add.'
                : action?.type === 'run_browser_task'
                  ? 'Check the order, then tap Place order.'
                  : `${reviewTitleForAction(action)}. Check the details, then tap Confirm or Cancel.`;
```

- [ ] **Step 3: Add the action label**

In `api/services/user-facing-copy.js`, add next to `send_message: 'Message'`:

```javascript
  send_adam_email: 'Message',
```

- [ ] **Step 4: Write the failing test**

```javascript
// test/smoke/adam-email-action.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { executeAction } = require('../../api/index');

test('send_adam_email requires to and body', async () => {
  const result = await executeAction('demo-test-user', 'send_adam_email', { body: 'hi' }, {});
  assert.equal(result.success, false);
  assert.match(result.error, /to|recipient/i);
});
```

(This first test only checks input validation, which needs no DB/network mocking — it establishes the file and confirms the case is wired into the switch before the fuller integration test in Task 10, which needs a running server and real Supabase state.)

- [ ] **Step 5: Run the test to verify it fails**

Run: `node --test test/smoke/adam-email-action.test.js`
Expected: FAIL — `send_adam_email requires contact and message` doesn't exist as a case, falls through to the switch's default (likely `{success: false, error: 'Unknown action: send_adam_email'}` or similar) — confirm it fails for the *right* reason (case missing), then proceed.

- [ ] **Step 6: Add the executeAction case**

In `api/index.js`, add near the existing `case 'send_message'` block:

```javascript
    case 'send_adam_email': {
      const to = String(params?.to || '').trim();
      const body = String(params?.body || '').trim();
      if (!to || !body) return { success: false, error: 'send_adam_email requires a recipient and a message' };
      if (!/[^\s<]+@[^\s>]+\.[^\s>]+/.test(to)) {
        return { success: false, error: `I need ${to}'s email address — that doesn't look like one.` };
      }

      const { ensureAdamIdentity, getActiveHandle } = require('./services/adam-identity');
      const { findOrCreateParticipant } = require('./services/participants');
      const { getOrCreateConversation, appendEvent } = require('./services/external-conversations');
      const { sendAdamEmail } = require('../connectors/adam-email-resend');

      const cap = await checkAdamSendCap(userId, 'email');
      if (!cap.allowed) return { success: false, error: cap.message };

      const { identity, handles } = await ensureAdamIdentity(supabase, userId, { attemptPhone: false });
      const emailHandle = handles.find(h => h.channel_type === 'email') || await getActiveHandle(supabase, userId, 'email');
      if (!emailHandle) return { success: false, error: 'Adam does not have an email address set up yet.' };

      const { participant, address } = await findOrCreateParticipant(supabase, userId, {
        displayName: to, channelType: 'email', addressValue: to
      });
      const requestTaskId = params?.request_task_id || null;
      const { conversation } = await getOrCreateConversation(supabase, {
        userId, adamIdentityId: identity.id, participantId: participant.id, requestTaskId
      });

      const subject = String(params?.subject || '').trim() || 'A message from Adam';
      let sendResult;
      try {
        sendResult = await sendAdamEmail({ from: emailHandle.handle_value, to, subject, body });
      } catch (err) {
        return { success: false, error: `Couldn't send that: ${err.message}` };
      }

      await appendEvent(supabase, {
        conversationId: conversation.id,
        channelType: 'email',
        direction: 'outbound',
        participantAddressId: address.id,
        adamIdentityHandleId: emailHandle.id,
        providerEventId: sendResult.providerMessageId,
        subject,
        body
      });

      return {
        success: true,
        text: `Sent to ${to} from Adam's email.`,
        cardText: `To ${to} · ${body}`,
        actionSummary: 'Message sent',
        conversationId: conversation.id
      };
    }
```

Add the case directly after the existing `case 'send_message': { ... }` block (do not modify that block).

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test test/smoke/adam-email-action.test.js`
Expected: PASS — the validation-only test passes without needing `checkAdamSendCap`/DB calls to be reached (they're gated behind the `to`/`body` presence check, which fails first).

- [ ] **Step 8: Run the full existing suite to confirm no regressions**

Run: `npm test`
Expected: all prior tests still pass (this task only adds a new switch case and two ternary branches to existing files — no existing behavior changed).

- [ ] **Step 9: Commit**

```bash
git add api/action-contracts.js api/services/pending-review.js api/services/user-facing-copy.js api/index.js test/smoke/adam-email-action.test.js
git commit -m "feat(adam-identity): add send_adam_email action, review-gated like every other consequential send"
```

*(Note: `checkAdamSendCap` is implemented in Task 12 — until that task lands, add a temporary local stub in this task's step 6 (`async function checkAdamSendCap() { return { allowed: true }; }` placed above the `switch`) and remove the stub when Task 12 supplies the real one. This is the one place in this plan where a stub is intentional and temporary, not a placeholder left unfinished — Task 12 replaces it in the same file.)*

---

### Task 7: `POST /webhooks/millie-email` — inbound flow

**Files:**
- Create: `api/services/reply-policy.js`
- Modify: `api/index.js` — add the webhook route
- Test: Create: `test/smoke/reply-policy.test.js`
- Test: Create: `test/smoke/adam-email-webhook.test.js`

**Interfaces:**
- Consumes: `parseInboundPayload` (Task 3), `findOrCreateParticipant` (Task 4), `getOrCreateConversation`/`appendEvent`/`findOpenConversationsForParticipant` (Task 5).
- Produces: `classifyReply(body) -> 'ask' | 'surface'` (Task 7's own new module), the live route.

- [ ] **Step 1: Write the failing test for reply-policy**

```javascript
// test/smoke/reply-policy.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyReply } = require('../../api/services/reply-policy');

test('a reply proposing an alternative is classified as needing a decision', () => {
  assert.equal(classifyReply('We can do 8:15 instead, does that work?'), 'ask');
});

test('a purely informational reply is classified as surface-only', () => {
  assert.equal(classifyReply("We're closed on Mondays, sorry!"), 'surface');
});

test('a reply confirming exactly what was asked is surface-only', () => {
  assert.equal(classifyReply('Confirmed, see you at 8pm.'), 'surface');
});

test('a reply asking a question back is classified as needing a decision', () => {
  assert.equal(classifyReply('How many people will be in your party?'), 'ask');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/smoke/reply-policy.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the reply-policy implementation**

```javascript
// api/services/reply-policy.js
'use strict';

// Milestone 1 has exactly two tiers: 'ask' (the reply implies a decision — a
// different time, a price, a question back — Adam must check with the user
// before anything else happens) and 'surface' (purely informational, nothing to
// decide). There is deliberately no 'auto-reply' tier yet — see Global Constraints
// in the plan this file was built from.
//
// Conservative on purpose: anything that isn't confidently a plain confirmation or
// a plain statement of fact defaults to 'ask', never silently 'surface'.

const ALTERNATIVE_OFFER_RE = /\b(instead|how about|we can do|can do|works for you|would.+work|available at)\b/i;
const QUESTION_BACK_RE = /\?\s*$/;
const PLAIN_CONFIRMATION_RE = /^\s*(confirmed|great|sounds good|see you|perfect|all set|you're all set|noted)\b/i;
const INFORMATIONAL_RE = /\b(closed|hours are|we don't|unfortunately|no longer|sorry,? we)\b/i;

function classifyReply(body) {
  const text = String(body || '').trim();
  if (!text) return 'surface';
  if (PLAIN_CONFIRMATION_RE.test(text) && !QUESTION_BACK_RE.test(text)) return 'surface';
  if (ALTERNATIVE_OFFER_RE.test(text)) return 'ask';
  if (QUESTION_BACK_RE.test(text)) return 'ask';
  if (INFORMATIONAL_RE.test(text)) return 'surface';
  // Unclassified content defaults to 'ask' — see file header.
  return 'ask';
}

module.exports = { classifyReply };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/smoke/reply-policy.test.js`
Expected: PASS, 4/4

- [ ] **Step 5: Commit reply-policy**

```bash
git add api/services/reply-policy.js test/smoke/reply-policy.test.js
git commit -m "feat(adam-identity): add reply-policy classifier (ask vs surface, no auto-reply)"
```

- [ ] **Step 6: Write the failing webhook test**

```javascript
// test/smoke/adam-email-webhook.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const app = require('../../api/index');

function postJson(server, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'POST', hostname: '127.0.0.1', port: server.address().port, path, headers: { 'Content-Type': 'application/json' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test('POST /webhooks/millie-email with no matching Adam address returns 200 and does nothing destructive', async () => {
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/webhooks/millie-email', {
      data: { from: 'nobody@example.com', to: ['unclaimed@millie.oxy.app'], subject: 'hi', text: 'hello', email_id: 'evt-1' }
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `node --test test/smoke/adam-email-webhook.test.js`
Expected: FAIL — 404 (route doesn't exist yet)

- [ ] **Step 8: Add the route**

In `api/index.js`, add near the existing `/webhooks/stripe` route:

```javascript
app.post('/webhooks/millie-email', express.json(), async (req, res) => {
  // Always 200 quickly — providers retry on non-2xx, and a malformed/unmatched
  // inbound email is not the sender's problem to see an error for.
  res.status(200).json({ received: true });
  try {
    const { parseInboundPayload } = require('../connectors/adam-email-resend');
    const normalized = parseInboundPayload(req.body);
    if (!normalized?.toAddress || !normalized.fromAddress) return;

    const { data: handles } = await supabase
      .from('millie_identity_handles')
      .select('*')
      .eq('channel_type', 'email')
      .eq('handle_value', normalized.toAddress)
      .eq('status', 'active');
    const handle = handles?.[0];
    if (!handle) {
      log('warn', 'millie_email.inbound.no_matching_handle', { to: normalized.toAddress });
      return;
    }
    const { data: identities } = await supabase.from('millie_identities').select('*').eq('id', handle.millie_identity_id);
    const identity = identities?.[0];
    if (!identity) return;

    const { findOrCreateParticipant } = require('./services/participants');
    const { getOrCreateConversation, appendEvent, findOpenConversationsForParticipant } = require('./services/external-conversations');
    const { classifyReply } = require('./services/reply-policy');

    const { participant, address } = await findOrCreateParticipant(supabase, identity.user_id, {
      displayName: normalized.fromAddress, channelType: 'email', addressValue: normalized.fromAddress
    });

    const openConversations = await findOpenConversationsForParticipant(supabase, participant.id);
    // More than one open conversation with the same participant: do not guess which
    // one this reply belongs to. Attach to the most recently active one and rely on
    // the surfaced update carrying enough context for the user to notice if it's
    // wrong — a stronger disambiguation (asking the user which thread) is future
    // work, not silently picking without any signal at all.
    const conversation = openConversations.length
      ? openConversations.sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at))[0]
      : (await getOrCreateConversation(supabase, {
        userId: identity.user_id, adamIdentityId: identity.id, participantId: participant.id
      })).conversation;

    const decision = classifyReply(normalized.body);
    await appendEvent(supabase, {
      conversationId: conversation.id,
      channelType: 'email',
      direction: 'inbound',
      participantAddressId: address.id,
      adamIdentityHandleId: handle.id,
      providerEventId: normalized.providerMessageId,
      subject: normalized.subject,
      body: normalized.body,
      needsDecision: decision === 'ask',
      rawProviderPayload: req.body
    });
    log('info', 'millie_email.inbound.received', { userId: identity.user_id, conversationId: conversation.id, decision });
  } catch (err) {
    log('error', 'millie_email.inbound.error', { error: err.message });
  }
});
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `node --test test/smoke/adam-email-webhook.test.js`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add api/index.js test/smoke/adam-email-webhook.test.js
git commit -m "feat(adam-identity): add inbound email webhook, matches replies to the right conversation"
```

---

### Task 8: Surface updates on Home — extend `life-briefing.js`

**Files:**
- Modify: `api/services/life-briefing.js`
- Test: Modify: existing `test/smoke/life-briefing.test.js` if present, else create `test/smoke/life-briefing-adam-conversations.test.js`

**Interfaces:**
- Consumes: a list of conversation+latest-event rows (fetched by the caller, not by this file — matches the existing pattern where `buildLifeBriefing` takes already-fetched arrays).
- Produces: `normalizeConversationUpdate(row) -> item` added to the existing normalize/dedupe/rank pipeline; `buildLifeBriefing` gains one new optional input array, `conversationUpdates`.

- [ ] **Step 1: Check whether a life-briefing test file already exists**

Run: `ls test/smoke/ | grep life-briefing`

- [ ] **Step 2: Write the failing test**

```javascript
// test/smoke/life-briefing-adam-conversations.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { buildLifeBriefing, normalizeConversationUpdate } = require('../../api/services/life-briefing');

test('normalizeConversationUpdate surfaces the participant name and latest reply body', () => {
  const item = normalizeConversationUpdate({
    id: 'conv-1',
    participantDisplayName: 'The Bistro',
    latestEventBody: 'We can do 8:15, does that work?',
    needsDecision: true,
    lastActivityAt: new Date().toISOString()
  });
  assert.equal(item.kind, 'conversation_update');
  assert.match(item.text, /The Bistro/);
  assert.match(item.text, /8:15/);
  assert.equal(item.needsDecision, true);
});

test('buildLifeBriefing includes conversation updates alongside existing item types', () => {
  const briefing = buildLifeBriefing({
    conversationUpdates: [{
      id: 'conv-1', participantDisplayName: 'The Bistro', latestEventBody: 'We can do 8:15.',
      needsDecision: true, lastActivityAt: new Date().toISOString()
    }]
  });
  assert.ok(briefing.items.some(i => i.kind === 'conversation_update'));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/smoke/life-briefing-adam-conversations.test.js`
Expected: FAIL — `normalizeConversationUpdate` is not exported, and `buildLifeBriefing` doesn't accept `conversationUpdates`

- [ ] **Step 4: Read the current `buildLifeBriefing` and `normalizeEmail` to match the existing style exactly**

Run: `sed -n '220,330p' api/services/life-briefing.js` before writing the new function, and mirror `normalizeEmail`'s shape (same `cleanText`/`asDate` helpers already in the file) rather than inventing a different item shape.

- [ ] **Step 5: Add the implementation**

Add to `api/services/life-briefing.js`, following the existing `normalizeEmail`-style pattern already in the file, and thread `conversationUpdates` through `buildLifeBriefing` the same way `emails` already is:

```javascript
function normalizeConversationUpdate(update = {}) {
  const name = cleanText(update.participantDisplayName, 'Someone Adam contacted');
  const body = cleanText(update.latestEventBody, '', 240);
  return {
    kind: 'conversation_update',
    id: update.id,
    text: body ? `${name}: "${body}"` : `Update from ${name}`,
    needsDecision: Boolean(update.needsDecision),
    at: asDate(update.lastActivityAt)
  };
}
```

Then in `buildLifeBriefing({ tasks = [], approvals = [], emails = [], events = [], scheduledTasks = [], conversationUpdates = [], now = new Date() } = {})`, add `...conversationUpdates.map(normalizeConversationUpdate)` into the same array-building step where `emails.map(normalizeEmail)` already feeds into the shared dedupe/rank/publicItem pipeline — do not build a second pipeline.

Export `normalizeConversationUpdate` alongside the file's existing exports.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/smoke/life-briefing-adam-conversations.test.js`
Expected: PASS, 2/2

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all pass, including any pre-existing `life-briefing` tests (this task only adds, never removes or renames existing fields).

- [ ] **Step 8: Commit**

```bash
git add api/services/life-briefing.js test/smoke/life-briefing-adam-conversations.test.js
git commit -m "feat(adam-identity): surface conversation updates on the existing Home briefing feed"
```

---

### Task 9: Identity provisioning wiring — signup + backfill

**Files:**
- Modify: `api/index.js` — call `ensureAdamIdentity` from `/auth/register`, add `POST /millie/provision`
- Test: Create: `test/smoke/adam-provision-endpoint.test.js`

**Interfaces:**
- Consumes: `ensureAdamIdentity` (Task 2).

- [ ] **Step 1: Write the failing test**

```javascript
// test/smoke/adam-provision-endpoint.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const app = require('../../api/index');

function postJson(server, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST', hostname: '127.0.0.1', port: server.address().port, path,
      headers: { 'Content-Type': 'application/json', ...headers }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test('POST /millie/provision without auth is rejected', async () => {
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/millie/provision', {});
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/smoke/adam-provision-endpoint.test.js`
Expected: FAIL — 404 (route doesn't exist)

- [ ] **Step 3: Add the backfill endpoint**

In `api/index.js`, add near the other authenticated user-scoped routes (mirror an existing route's auth-check pattern, e.g. `requireMatchingUser` used by `/chat`):

```javascript
app.post('/millie/provision', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    const { ensureAdamIdentity } = require('./services/adam-identity');
    const { identity, handles } = await ensureAdamIdentity(supabase, userId, { attemptPhone: false });
    res.json({
      success: true,
      email: handles.find(h => h.channel_type === 'email')?.handle_value || null
    });
  } catch (err) {
    log('error', 'adam.provision.error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});
```

*(Phone provisioning is deliberately left to Task 11, which supplies the `provisionPhoneNumber` callback — this endpoint stays email-only until then, and Task 11 updates this one call site to pass it.)*

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/smoke/adam-provision-endpoint.test.js`
Expected: PASS

- [ ] **Step 5: Wire provisioning into `/auth/register`**

In `api/index.js`'s `/auth/register` handler, after the existing `log('info', 'auth.register', { userId });` line and before the welcome-email block, add (fire-and-forget, must never block or fail signup):

```javascript
    require('./services/adam-identity').ensureAdamIdentity(supabase, userId, { attemptPhone: false })
      .catch(err => log('warn', 'adam.provision.signup_failed', { userId, error: err.message }));
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass. (No existing registration test should break — this is a non-blocking, caught, fire-and-forget addition.)

- [ ] **Step 7: Commit**

```bash
git add api/index.js test/smoke/adam-provision-endpoint.test.js
git commit -m "feat(adam-identity): provision Adam's email identity at signup, plus a backfill endpoint"
```

---

### Task 10: Live end-to-end verification (the actual acceptance test)

No new files — this task runs the real acceptance test against the real server, real Supabase, and (if configured) the real Resend account, per this project's established live-verification standard (a capability isn't "done" because unit tests pass).

- [ ] **Step 1: Provision a real Adam email handle for `demo-test-user`**

Start the local server with `NODE_ENV=development OXY_ENABLE_DEV_AUTH=true`, log in via `/auth/dev/demo-login`, then:
```bash
curl -s -X POST http://localhost:8091/millie/provision -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"userId":"demo-test-user"}'
```
Expected: `{"success":true,"email":"demo-test-user@millie.oxy.app"}` (or whatever `MILLIE_EMAIL_DOMAIN` resolves to).

- [ ] **Step 2: Ask Adam to contact a real test mailbox**

Via `/chat`, send: `"Email test-business@<a real mailbox you control> and ask if they can move our booking to 8."` Confirm the resulting pending-review card via the existing approve flow (same as any other `review_required` action).

- [ ] **Step 3: Verify the email actually arrives**

Check the real test mailbox's inbox. Confirm: it's from the Adam handle (not the user's own address), the signature line is present, the content matches what was asked.

- [ ] **Step 4: Reply from the test mailbox**

Reply with something like "We can do 8:15, does that work?" — a genuine reply, not a synthetic webhook payload, to exercise Resend's real inbound delivery.

- [ ] **Step 5: Verify the inbound webhook fired and matched correctly**

Check server logs for `millie_email.inbound.received` with the correct `conversationId`. Query Supabase directly:
```sql
select ec.status, ece.direction, ece.needs_decision
from external_conversation_events ece
join external_conversations ec on ec.id = ece.conversation_id
where ec.user_id = 'demo-test-user'
order by ece.created_at;
```
Expected: 2 rows — one `outbound`, one `inbound` with `needs_decision = true`.

- [ ] **Step 6: Verify the user sees it**

Confirm the reply surfaces via the life-briefing/Home path (Task 8) with the participant name and reply body visible, `needsDecision: true`.

- [ ] **Step 7: Clean up test data**

Delete the test rows created in `external_conversations`/`external_conversation_events`/`participants`/`participant_addresses`/`agent_tasks` for `demo-test-user`, matching this project's established test-cleanup discipline (see prior sessions' live-verification cleanup pattern).

- [ ] **Step 8: Report results**

This step has no commit — it's verification, not a code change. If any step fails, fix the specific gap it exposes as a follow-up task before considering the milestone done; do not mark this milestone complete on unit tests alone.

---

### Task 11: Phone number provisioning + SMS (Twilio)

**Files:**
- Create: `connectors/adam-sms-twilio.js`
- Modify: `api/services/adam-identity.js` — pass a real `provisionPhoneNumber` implementation
- Modify: `api/action-contracts.js`, `api/services/pending-review.js`, `api/services/user-facing-copy.js`, `api/index.js` — mirror Task 6 exactly, for `send_adam_sms`
- Modify: `api/index.js` — add `POST /webhooks/millie-sms`, mirroring Task 7
- Modify: `api/index.js` — update `/millie/provision` to attempt phone provisioning too
- Test: Create: `test/smoke/adam-sms-twilio.test.js`
- Test: Create: `test/smoke/adam-sms-action.test.js`
- Test: Create: `test/smoke/adam-sms-webhook.test.js`

**Interfaces:**
- Produces: `provisionPhoneNumber(userId) -> Promise<{phoneNumber, providerRef}>`, `sendAdamSms({from, to, body}) -> Promise<{providerMessageId}>`, `parseInboundSmsPayload(payload) -> normalized shape` (same shape as the email adapter's `parseInboundPayload`, with `subject` always empty).

- [ ] **Step 1: Write the failing test for the Twilio adapter**

```javascript
// test/smoke/adam-sms-twilio.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const mockAxios = { post: async () => ({}), get: async () => ({}) };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'axios') return mockAxios;
  return originalLoad.call(this, request, parent, isMain);
};
const { sendAdamSms, parseInboundSmsPayload, provisionPhoneNumber, MILLIE_SMS_SIGNATURE_LINE } = require('../../connectors/adam-sms-twilio');
Module._load = originalLoad;

test('sendAdamSms posts to Twilio Messages API and appends the signature line', async () => {
  const oldSid = process.env.TWILIO_ACCOUNT_SID;
  const oldToken = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  let captured;
  const oldPost = mockAxios.post;
  mockAxios.post = async (url, body, config) => {
    captured = { url, body, config };
    return { data: { sid: 'SMtest1' } };
  };
  try {
    const result = await sendAdamSms({ from: '+15551230000', to: '+15559876543', body: 'Can you move our booking to 8pm?' });
    assert.match(captured.url, /Accounts\/ACtest\/Messages\.json$/);
    assert.match(captured.body.toString(), /Can you move our booking to 8pm\?/);
    assert.match(captured.body.toString(), new RegExp(MILLIE_SMS_SIGNATURE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(result.providerMessageId, 'SMtest1');
  } finally {
    mockAxios.post = oldPost;
    if (oldSid === undefined) delete process.env.TWILIO_ACCOUNT_SID; else process.env.TWILIO_ACCOUNT_SID = oldSid;
    if (oldToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = oldToken;
  }
});

test('parseInboundSmsPayload normalizes a Twilio inbound webhook payload', () => {
  const normalized = parseInboundSmsPayload({ From: '+15559876543', To: '+15551230000', Body: 'We can do 8:15', MessageSid: 'SMtest2' });
  assert.equal(normalized.fromAddress, '+15559876543');
  assert.equal(normalized.toAddress, '+15551230000');
  assert.equal(normalized.body, 'We can do 8:15');
  assert.equal(normalized.providerMessageId, 'SMtest2');
});

test('provisionPhoneNumber throws a clear error when Twilio env vars are missing', async () => {
  const oldSid = process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_ACCOUNT_SID;
  try {
    await assert.rejects(() => provisionPhoneNumber('demo-test-user'), /TWILIO_ACCOUNT_SID/);
  } finally {
    if (oldSid !== undefined) process.env.TWILIO_ACCOUNT_SID = oldSid;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/smoke/adam-sms-twilio.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// connectors/adam-sms-twilio.js
'use strict';
const axios = require('axios');

// Adam's phone number and SMS, via Twilio's plain REST API (Basic Auth,
// application/x-www-form-urlencoded) — no twilio npm SDK, matching this
// codebase's existing pattern of calling provider REST APIs directly with axios
// (see connectors/google.js). US numbers require A2P 10DLC brand+campaign
// registration with Twilio before carriers reliably deliver SMS — that is an
// account-level, non-code prerequisite; provisioning still creates and persists
// the number without it, but delivery may be filtered until registration
// completes. This file does not attempt to detect or manage that registration.

const MILLIE_SMS_SIGNATURE_LINE = '- Adam (assistant)';

function twilioAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not configured.');
  return { sid, token };
}

async function provisionPhoneNumber(userId) {
  const { sid, token } = twilioAuth();
  const countryCode = process.env.TWILIO_NUMBER_COUNTRY || 'GB';
  const search = await axios.get(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/${countryCode}/Local.json`,
    { auth: { username: sid, password: token }, params: { SmsEnabled: true, VoiceEnabled: true }, timeout: 15000 }
  );
  const candidate = search.data?.available_phone_numbers?.[0];
  if (!candidate) throw new Error(`No available phone numbers in ${countryCode} right now.`);

  const purchase = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`,
    new URLSearchParams({
      PhoneNumber: candidate.phone_number,
      SmsUrl: `${process.env.APP_URL || ''}/webhooks/millie-sms`,
      SmsMethod: 'POST'
    }),
    { auth: { username: sid, password: token }, timeout: 15000 }
  );
  return { phoneNumber: purchase.data.phone_number, providerRef: purchase.data.sid };
}

async function sendAdamSms({ from, to, body }) {
  const { sid, token } = twilioAuth();
  const text = `${body}\n${MILLIE_SMS_SIGNATURE_LINE}`;
  const response = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    new URLSearchParams({ From: from, To: to, Body: text }),
    { auth: { username: sid, password: token }, timeout: 15000 }
  );
  return { providerMessageId: response.data?.sid || null };
}

function parseInboundSmsPayload(payload) {
  const data = payload || {};
  if (!data.From) return null;
  return {
    fromAddress: String(data.From).trim(),
    toAddress: String(data.To || '').trim(),
    subject: '',
    body: String(data.Body || ''),
    providerMessageId: data.MessageSid || null,
    inReplyTo: null,
    references: null
  };
}

module.exports = { provisionPhoneNumber, sendAdamSms, parseInboundSmsPayload, MILLIE_SMS_SIGNATURE_LINE };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/smoke/adam-sms-twilio.test.js`
Expected: PASS, 3/3

- [ ] **Step 5: Commit the adapter**

```bash
git add connectors/adam-sms-twilio.js test/smoke/adam-sms-twilio.test.js
git commit -m "feat(adam-identity): add Twilio phone number provisioning + SMS adapter"
```

- [ ] **Step 6: Wire phone provisioning into `/millie/provision`**

In `api/index.js`, change the `/millie/provision` handler from Task 9 to attempt phone provisioning too, tolerant of failure:

```javascript
app.post('/millie/provision', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    const { ensureAdamIdentity } = require('./services/adam-identity');
    const { provisionPhoneNumber } = require('../connectors/adam-sms-twilio');
    const { identity, handles } = await ensureAdamIdentity(supabase, userId, {
      attemptPhone: true,
      provisionPhoneNumber
    });
    res.json({
      success: true,
      email: handles.find(h => h.channel_type === 'email')?.handle_value || null,
      phone: handles.find(h => h.channel_type === 'phone_sms')?.handle_value || null
    });
  } catch (err) {
    log('error', 'adam.provision.error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 7: Run `test/smoke/adam-provision-endpoint.test.js` to confirm no regression**

Run: `node --test test/smoke/adam-provision-endpoint.test.js`
Expected: PASS (the existing 401-without-auth test is unaffected by this change).

- [ ] **Step 8: Add `send_adam_sms` contract, review copy, and label**

Mirror Task 6 steps 1–3 exactly, substituting `send_adam_sms` for `send_adam_email`, `to`/`body` unchanged, and using `+E.164 phone number` in `inputExample.to` instead of an email address.

- [ ] **Step 9: Write the failing test**

```javascript
// test/smoke/adam-sms-action.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { executeAction } = require('../../api/index');

test('send_adam_sms requires to and body', async () => {
  const result = await executeAction('demo-test-user', 'send_adam_sms', { body: 'hi' }, {});
  assert.equal(result.success, false);
  assert.match(result.error, /to|recipient|number/i);
});
```

- [ ] **Step 10: Add the `executeAction` case**

Mirror Task 6 Step 6's `case 'send_adam_email'` structure exactly, with these substitutions: validate `to` as `looksLikeMessageAddress`-style (reuse the existing `looksLikeMessageAddress` function already defined in `api/index.js` for `send_message`, rather than the email-shape regex), use `getActiveHandle(supabase, userId, 'phone_sms')`, `findOrCreateParticipant(..., { channelType: 'phone_sms', addressValue: to })`, `sendAdamSms` instead of `sendAdamEmail`, `channelType: 'phone_sms'` in `appendEvent`, and no `subject`.

```javascript
    case 'send_adam_sms': {
      const to = String(params?.to || '').trim();
      const body = String(params?.body || '').trim();
      if (!to || !body) return { success: false, error: 'send_adam_sms requires a recipient phone number and a message' };
      if (!looksLikeMessageAddress(to)) {
        return { success: false, error: `I need a phone number for ${to} — that doesn't look like one.` };
      }

      const { ensureAdamIdentity, getActiveHandle } = require('./services/adam-identity');
      const { findOrCreateParticipant } = require('./services/participants');
      const { getOrCreateConversation, appendEvent } = require('./services/external-conversations');
      const { sendAdamSms } = require('../connectors/adam-sms-twilio');

      const cap = await checkAdamSendCap(userId, 'phone_sms');
      if (!cap.allowed) return { success: false, error: cap.message };

      const { identity } = await ensureAdamIdentity(supabase, userId, { attemptPhone: false });
      const phoneHandle = await getActiveHandle(supabase, userId, 'phone_sms');
      if (!phoneHandle) return { success: false, error: 'Adam does not have a phone number set up yet.' };

      const { participant, address } = await findOrCreateParticipant(supabase, userId, {
        displayName: to, channelType: 'phone_sms', addressValue: to
      });
      const requestTaskId = params?.request_task_id || null;
      const { conversation } = await getOrCreateConversation(supabase, {
        userId, adamIdentityId: identity.id, participantId: participant.id, requestTaskId
      });

      let sendResult;
      try {
        sendResult = await sendAdamSms({ from: phoneHandle.handle_value, to, body });
      } catch (err) {
        return { success: false, error: `Couldn't send that: ${err.message}` };
      }

      await appendEvent(supabase, {
        conversationId: conversation.id,
        channelType: 'phone_sms',
        direction: 'outbound',
        participantAddressId: address.id,
        adamIdentityHandleId: phoneHandle.id,
        providerEventId: sendResult.providerMessageId,
        body
      });

      return {
        success: true,
        text: `Sent to ${to} from Adam's number.`,
        cardText: `To ${to} · ${body}`,
        actionSummary: 'Message sent',
        conversationId: conversation.id
      };
    }
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `node --test test/smoke/adam-sms-action.test.js`
Expected: PASS

- [ ] **Step 12: Add the inbound SMS webhook**

Mirror Task 7 Step 8's route exactly, substituting `/webhooks/millie-sms`, `parseInboundSmsPayload` from `connectors/adam-sms-twilio`, `channel_type: 'phone_sms'` in the handle lookup and `appendEvent` call, and no `subject`. Twilio POSTs `application/x-www-form-urlencoded`, not JSON — use `express.urlencoded({ extended: false })` as this route's body parser instead of `express.json()`.

```javascript
app.post('/webhooks/millie-sms', express.urlencoded({ extended: false }), async (req, res) => {
  res.status(200).send('<Response></Response>'); // Twilio expects TwiML or empty 200
  try {
    const { parseInboundSmsPayload } = require('../connectors/adam-sms-twilio');
    const normalized = parseInboundSmsPayload(req.body);
    if (!normalized?.toAddress || !normalized.fromAddress) return;

    const { data: handles } = await supabase
      .from('millie_identity_handles')
      .select('*')
      .eq('channel_type', 'phone_sms')
      .eq('handle_value', normalized.toAddress)
      .eq('status', 'active');
    const handle = handles?.[0];
    if (!handle) {
      log('warn', 'millie_sms.inbound.no_matching_handle', { to: normalized.toAddress });
      return;
    }
    const { data: identities } = await supabase.from('millie_identities').select('*').eq('id', handle.millie_identity_id);
    const identity = identities?.[0];
    if (!identity) return;

    const { findOrCreateParticipant } = require('./services/participants');
    const { getOrCreateConversation, appendEvent, findOpenConversationsForParticipant } = require('./services/external-conversations');
    const { classifyReply } = require('./services/reply-policy');

    const { participant, address } = await findOrCreateParticipant(supabase, identity.user_id, {
      displayName: normalized.fromAddress, channelType: 'phone_sms', addressValue: normalized.fromAddress
    });

    const openConversations = await findOpenConversationsForParticipant(supabase, participant.id);
    const conversation = openConversations.length
      ? openConversations.sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at))[0]
      : (await getOrCreateConversation(supabase, {
        userId: identity.user_id, adamIdentityId: identity.id, participantId: participant.id
      })).conversation;

    const decision = classifyReply(normalized.body);
    await appendEvent(supabase, {
      conversationId: conversation.id,
      channelType: 'phone_sms',
      direction: 'inbound',
      participantAddressId: address.id,
      adamIdentityHandleId: handle.id,
      providerEventId: normalized.providerMessageId,
      body: normalized.body,
      needsDecision: decision === 'ask',
      rawProviderPayload: req.body
    });
    log('info', 'millie_sms.inbound.received', { userId: identity.user_id, conversationId: conversation.id, decision });
  } catch (err) {
    log('error', 'millie_sms.inbound.error', { error: err.message });
  }
});
```

- [ ] **Step 13: Write the failing webhook test**

```javascript
// test/smoke/adam-sms-webhook.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const app = require('../../api/index');

test('POST /webhooks/millie-sms with no matching Adam number returns 200', async () => {
  const server = app.listen(0);
  try {
    const body = new URLSearchParams({ From: '+15559876543', To: '+15550000000', Body: 'hi', MessageSid: 'SMtest' });
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        method: 'POST', hostname: '127.0.0.1', port: server.address().port, path: '/webhooks/millie-sms',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, res => { let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, data })); });
      req.on('error', reject);
      req.write(body.toString());
      req.end();
    });
    assert.equal(result.status, 200);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 14: Run the test to verify it passes**

Run: `node --test test/smoke/adam-sms-webhook.test.js`
Expected: PASS

- [ ] **Step 15: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 16: Commit**

```bash
git add api/index.js api/action-contracts.js api/services/pending-review.js api/services/user-facing-copy.js test/smoke/adam-sms-action.test.js test/smoke/adam-sms-webhook.test.js
git commit -m "feat(adam-identity): add send_adam_sms action + inbound SMS webhook, mirrors the email path"
```

---

### Task 12: Rate limiting and abuse guard

**Files:**
- Modify: `api/index.js` — add `checkAdamSendCap`, use it in both `send_adam_email` and `send_adam_sms` (replacing the Task 6 stub)
- Test: Create: `test/smoke/adam-send-cap.test.js`

**Interfaces:**
- Produces: `checkAdamSendCap(userId, channelType) -> Promise<{allowed: boolean, message?: string}>`.

**Why a DB-backed check, not the existing in-memory `createRateLimiter`:** `createRateLimiter`'s in-memory `Map` doesn't survive a restart and isn't shared across Cloud Run instances if the service scales beyond one — fine for a soft per-minute chat limit, not fine for a hard daily abuse cap. This counts real rows instead.

- [ ] **Step 1: Write the failing test**

```javascript
// test/smoke/adam-send-cap.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { checkAdamSendCap } = require('../../api/index');

test('checkAdamSendCap allows sending when under the daily cap', async () => {
  const result = await checkAdamSendCap.__testOverride(async () => 3, 'demo-test-user', 'email');
  assert.equal(result.allowed, true);
});

test('checkAdamSendCap blocks sending at or above the daily cap', async () => {
  const oldCap = process.env.MILLIE_DAILY_SEND_CAP;
  process.env.MILLIE_DAILY_SEND_CAP = '5';
  try {
    const result = await checkAdamSendCap.__testOverride(async () => 5, 'demo-test-user', 'email');
    assert.equal(result.allowed, false);
    assert.match(result.message, /today/i);
  } finally {
    if (oldCap === undefined) delete process.env.MILLIE_DAILY_SEND_CAP;
    else process.env.MILLIE_DAILY_SEND_CAP = oldCap;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/smoke/adam-send-cap.test.js`
Expected: FAIL — `checkAdamSendCap` is not exported

- [ ] **Step 3: Implement `checkAdamSendCap`**

In `api/index.js`, define near the other helper functions used by `executeAction` (and remove the Task 6 temporary stub):

```javascript
// Testable without hitting Supabase: __testOverride lets tests inject the count
// function directly, matching this file's existing convention of exposing a narrow
// test seam rather than mocking the module's own `supabase` client.
async function countAdamSendsToday(userId, channelType) {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data: identities } = await supabase.from('millie_identities').select('id').eq('user_id', userId).limit(1);
  const identityId = identities?.[0]?.id;
  if (!identityId) return 0;
  const { data: handles } = await supabase.from('millie_identity_handles').select('id').eq('millie_identity_id', identityId).eq('channel_type', channelType);
  const handleIds = (handles || []).map(h => h.id);
  if (!handleIds.length) return 0;
  const { count } = await supabase
    .from('external_conversation_events')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'outbound')
    .in('millie_identity_handle_id', handleIds)
    .gte('created_at', since.toISOString());
  return count || 0;
}

async function checkAdamSendCap(userId, channelType, countFn = countAdamSendsToday) {
  const cap = Number(process.env.MILLIE_DAILY_SEND_CAP) || 20;
  const sentToday = await countFn(userId, channelType);
  if (sentToday >= cap) {
    return { allowed: false, message: `Adam has reached her sending limit for today (${cap}). Try again tomorrow.` };
  }
  return { allowed: true };
}
checkAdamSendCap.__testOverride = (countFn, userId, channelType) => checkAdamSendCap(userId, channelType, countFn);
```

Then in both `case 'send_adam_email'` and `case 'send_adam_sms'`, the existing line:
```javascript
      const cap = await checkAdamSendCap(userId, 'email'); // or 'phone_sms'
```
now calls this real implementation instead of the Task 6 stub — delete the stub function added in Task 6.

- [ ] **Step 4: Export `checkAdamSendCap`**

Add to the existing `module.exports.` block at the bottom of `api/index.js`:
```javascript
module.exports.checkAdamSendCap = checkAdamSendCap;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/smoke/adam-send-cap.test.js`
Expected: PASS, 2/2

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add api/index.js test/smoke/adam-send-cap.test.js
git commit -m "feat(adam-identity): add a real daily send cap — Adam's identity has no human tap-to-send safety net"
```

---

### Task 13: Retention

**Files:**
- Modify: `api/services/data-retention.js`
- Test: Modify: existing retention test file (find via `grep -rl "RETENTION_POLICY" test/`) to assert the new entry exists

- [ ] **Step 1: Find the existing retention test**

Run: `grep -rl "RETENTION_POLICY" test/`

- [ ] **Step 2: Write the failing assertion**

Add to that test file:
```javascript
test('external_conversation_events has a retention policy entry', () => {
  const { RETENTION_POLICY } = require('../../api/services/data-retention');
  assert.ok(RETENTION_POLICY.external_conversation_events);
  assert.equal(RETENTION_POLICY.external_conversation_events.maxAgeDays, 180);
});
```

(If `RETENTION_POLICY` is not currently exported from `data-retention.js`, add it to that file's `module.exports` as part of this step — check first with `grep "module.exports" api/services/data-retention.js`.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test <the file found in Step 1>`
Expected: FAIL

- [ ] **Step 4: Add the policy entry**

In `api/services/data-retention.js`, add to the existing `RETENTION_POLICY` object:
```javascript
  external_conversation_events: { maxAgeDays: 180, column: 'created_at', label: 'Messages Adam has sent or received on your behalf: deleted after 180 days.' },
```

Identity, handle, participant, and conversation *records* are relationship metadata, not message content, and are intentionally left out of this policy — only the event bodies (the actual correspondence) get a retention clock, mirroring how `conversations` (chat) has one but `connectors` (the relationship, not its content) does not.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test <the file found in Step 1>`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add api/services/data-retention.js <the test file found in Step 1>
git commit -m "feat(adam-identity): enforce retention on Adam's conversation events"
```

---

## Ordered commit summary

1. `feat(adam-identity): add schema for Adam's persistent communication identity`
2. `feat(adam-identity): add identity/handle provisioning service`
3. `feat(adam-identity): add Resend email adapter for Adam's own address`
4. `feat(adam-identity): add participant directory with cross-channel address matching`
5. `feat(adam-identity): add channel-agnostic conversation + encrypted event log`
6. `feat(adam-identity): add send_adam_email action, review-gated like every other consequential send`
7. `feat(adam-identity): add reply-policy classifier (ask vs surface, no auto-reply)`
8. `feat(adam-identity): add inbound email webhook, matches replies to the right conversation`
9. `feat(adam-identity): surface conversation updates on the existing Home briefing feed`
10. `feat(adam-identity): provision Adam's email identity at signup, plus a backfill endpoint`
11. *(Task 10 — live verification, no commit)*
12. `feat(adam-identity): add Twilio phone number provisioning + SMS adapter`
13. `feat(adam-identity): add send_adam_sms action + inbound SMS webhook, mirrors the email path`
14. `feat(adam-identity): add a real daily send cap — Adam's identity has no human tap-to-send safety net`
15. `feat(adam-identity): enforce retention on Adam's conversation events`

## Environment variables this milestone introduces

- `MILLIE_EMAIL_DOMAIN` — domain used for per-user Adam addresses (e.g. `millie.oxy.app`). Requires DNS/inbound routing configured with Resend once, not per-user.
- `RESEND_WEBHOOK_SECRET` — verify against Resend's current inbound-webhook signing docs before Task 7's live step; not yet wired into the webhook route above pending that check (flagged, not silently skipped).
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — Twilio credentials.
- `TWILIO_NUMBER_COUNTRY` — defaults to `GB`.
- `MILLIE_DAILY_SEND_CAP` — defaults to `20`.

## Explicitly deferred (per this milestone's scope)

**Reserved, not built — additive later, no redesign needed:** WhatsApp, Telegram, inbound/outbound voice, and **proactive continuation** (Adam following up on an already-authorised request when a reply doesn't arrive — chasing support, a refund, an application, a pre-deadline check, or retrying through another channel). The data model already carries what a future follow-up scheduler needs — `external_conversations.last_outbound_at`, `.last_inbound_at`, `.next_follow_up_at`, `.status`, and `.request_task_id` linking back to the authorising `agent_tasks` row — but nothing in this milestone reads or writes `next_follow_up_at`, and no code sends anything without a fresh, explicit user instruction or confirmation. Building proactive continuation later is a new scheduler service plus wiring those existing columns — not a schema change.

**Prohibited outright, not deferred:** unsolicited cold outreach — contacting someone with no connection to any user-authorised goal. This isn't a "not yet," it's out of scope unless a future product decision explicitly revisits it.

Any UI beyond the existing Home-briefing surface is also out of scope for this milestone, unrelated to the above distinction.
