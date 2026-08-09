// Proactive outbound delivery: routing, dedupe, quiet hours, urgency and — most importantly —
// what may and may not be called "delivered".

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PREF, gradeUrgency, dedupeKeyFor, parseQuietHours, inQuietHours,
  resolveDelivery, collapseRelated, formatNotificationEmail, describePreference
} = require('../../api/services/notifications');
const {
  availableChannels, describeUnavailable, createDeliveryRuntime,
  resolveEmailProvider, resolveEmailDestination
} = require('../../api/services/notification-delivery');

const EVENT = { id: 'e1', category: 'watch', urgency: 'normal', title: 'Brighton room', body: 'Now £86 a night.' };
const NOW = new Date('2026-08-09T14:00:00Z');

// ── Channel availability is about credentials, not code existing ───────────────────────
test('a channel with code but no credentials is never offered', () => {
  const none = availableChannels({ env: {}, hasPushDevices: true, emailTo: 'a@b.com' });
  assert.deepEqual(none, ['in_app'], 'push and email both need real configuration');

  const withEmail = availableChannels({ env: { RESEND_API_KEY: 'k' }, hasPushDevices: false, emailTo: 'a@b.com' });
  assert.deepEqual(withEmail, ['email', 'in_app']);

  const full = availableChannels({
    env: { RESEND_API_KEY: 'k', APNS_BUNDLE_ID: 'b', APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_PRIVATE_KEY: 'p' },
    hasPushDevices: true, emailTo: 'a@b.com'
  });
  assert.deepEqual(full, ['push', 'email', 'in_app']);
});

test('push with credentials but no registered device is not available', () => {
  const env = { APNS_BUNDLE_ID: 'b', APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_PRIVATE_KEY: 'p' };
  assert.equal(availableChannels({ env, hasPushDevices: false, emailTo: '' }).includes('push'), false);
  assert.match(describeUnavailable({ env, hasPushDevices: false }).join(' '), /no registered device/);
});

// ── The user's own connected mailbox is a real email provider ──────────────────────────
// Before this, "email" meant "Resend", so a user with Google connected — already holding a
// gmail.modify grant, which includes messages.send — was told no channel was configured.
test('a connected mailbox makes email available with no extra credential', () => {
  assert.equal(resolveEmailProvider({ env: {}, mailboxCanSend: false }), null);
  assert.equal(resolveEmailProvider({ env: {}, mailboxCanSend: true }), 'gmail');
  // Resend stays first when it is genuinely configured: it sends from Millie's own identity
  // rather than out of the user's mailbox.
  assert.equal(resolveEmailProvider({ env: { RESEND_API_KEY: 'k' }, mailboxCanSend: true }), 'resend');

  const viaMailbox = availableChannels({ env: {}, hasPushDevices: false, emailTo: 'me@gmail.com', mailboxCanSend: true });
  assert.deepEqual(viaMailbox, ['email', 'in_app']);
});

test('with neither Resend nor a mailbox, email says so instead of silently vanishing', () => {
  const reasons = describeUnavailable({ env: {}, hasPushDevices: false, emailTo: '', mailboxCanSend: false }).join(' ');
  assert.match(reasons, /RESEND_API_KEY/);
  assert.match(reasons, /connect Google/);
});

test('the connected mailbox is a destination of last resort, never an override', () => {
  // An explicit preference wins, then a verified account address. The mailbox address is used
  // only when there is nothing else — it needs no verification because holding the user's
  // OAuth grant on that mailbox IS proof they own it.
  assert.equal(resolveEmailDestination({
    prefEmailTo: 'chosen@x.com', verifiedEmail: 'acct@x.com', mailboxAddress: 'box@gmail.com'
  }), 'chosen@x.com');
  assert.equal(resolveEmailDestination({
    verifiedEmail: 'acct@x.com', mailboxAddress: 'box@gmail.com'
  }), 'acct@x.com');
  assert.equal(resolveEmailDestination({ mailboxAddress: 'box@gmail.com' }), 'box@gmail.com');
  assert.equal(resolveEmailDestination({}), '');
});

test('delivery routes through the mailbox provider when Resend is absent', async () => {
  const { runtime, rows, calls } = runtimeWith({
    env: {},
    emailTo: '',                                   // no verified account address
    mailbox: { address: 'me@gmail.com', canSend: true }
  });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  const result = await runtime.deliverPending('u1');
  assert.equal(result.emailProvider, 'gmail');
  assert.ok(calls.includes('email:gmail:me@gmail.com'), `expected a gmail send, got ${calls.join(',')}`);
  assert.equal([...rows.values()][0].status, 'delivered');
});

test('no mailbox and no Resend still means no email channel', async () => {
  const { runtime, calls } = runtimeWith({ env: {}, emailTo: '', mailbox: null });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  const result = await runtime.deliverPending('u1');
  assert.equal(result.emailProvider, null);
  assert.equal(result.available.includes('email'), false);
  assert.ok(calls.includes('in_app'));
});

// ── Routing ────────────────────────────────────────────────────────────────────────────
test('with nothing configured everything falls back to the in-app card', () => {
  const decision = resolveDelivery({ event: EVENT, available: ['in_app'], now: NOW });
  assert.equal(decision.deliver, true);
  assert.equal(decision.channel, 'in_app');
});

test('push is preferred over email, and both over the card that does not reach them', () => {
  assert.equal(resolveDelivery({ event: EVENT, available: ['push', 'email', 'in_app'], now: NOW }).channel, 'push');
  assert.equal(resolveDelivery({ event: EVENT, available: ['email', 'in_app'], now: NOW }).channel, 'email');
});

test('"email me if that price drops" routes that category to email', () => {
  const prefs = { [PREF.category('watch')]: 'email' };
  assert.equal(resolveDelivery({ event: EVENT, prefs, available: ['push', 'email', 'in_app'], now: NOW }).channel, 'email');
});

test('"don\'t email me about deliveries, just show those in the app" is honoured per category', () => {
  const prefs = { [PREF.channel]: 'email', [PREF.category('delivery')]: 'in_app' };
  const delivery = resolveDelivery({ event: { ...EVENT, category: 'delivery' }, prefs, available: ['email', 'in_app'], now: NOW });
  assert.equal(delivery.channel, 'in_app');
  // …while everything else still goes to email.
  assert.equal(resolveDelivery({ event: EVENT, prefs, available: ['email', 'in_app'], now: NOW }).channel, 'email');
});

test('turning a category off suppresses it rather than failing', () => {
  const prefs = { [PREF.category('watch')]: 'off' };
  const decision = resolveDelivery({ event: EVENT, prefs, available: ['email', 'in_app'], now: NOW });
  assert.equal(decision.deliver, false);
  assert.equal(decision.status, 'suppressed');
  assert.match(decision.reason, /turned off/);
});

test('"only send urgent things" holds back the rest', () => {
  const prefs = { [PREF.urgentOnly]: 'true' };
  assert.equal(resolveDelivery({ event: EVENT, prefs, available: ['email'], now: NOW }).status, 'suppressed');
  const urgent = resolveDelivery({ event: { ...EVENT, urgency: 'urgent' }, prefs, available: ['email'], now: NOW });
  assert.equal(urgent.deliver, true);
});

// ── Quiet hours defer, they do not drop ────────────────────────────────────────────────
test('quiet hours defer a normal notification to when they end', () => {
  const prefs = { [PREF.quietHours]: '22:00-07:00' };
  const lateNight = new Date('2026-08-09T22:30:00Z');
  const decision = resolveDelivery({ event: EVENT, prefs, available: ['email'], now: lateNight, timeZone: 'UTC' });
  assert.equal(decision.deliver, false);
  assert.equal(decision.status, 'deferred');
  assert.equal(decision.deliverAfter.toISOString(), '2026-08-10T07:00:00.000Z');
});

test('a quiet-hours window that wraps midnight is handled at both ends', () => {
  const quiet = parseQuietHours('22:00-07:00');
  assert.equal(inQuietHours(new Date('2026-08-09T23:30:00Z'), quiet, 'UTC'), true);
  assert.equal(inQuietHours(new Date('2026-08-09T03:00:00Z'), quiet, 'UTC'), true);
  assert.equal(inQuietHours(new Date('2026-08-09T12:00:00Z'), quiet, 'UTC'), false);
});

test('something genuinely urgent still goes out during quiet hours', () => {
  const prefs = { [PREF.quietHours]: '22:00-07:00' };
  const decision = resolveDelivery({
    event: { ...EVENT, urgency: 'urgent' }, prefs, available: ['email'],
    now: new Date('2026-08-09T23:00:00Z'), timeZone: 'UTC'
  });
  assert.equal(decision.deliver, true);
});

// ── Urgency is grounded ────────────────────────────────────────────────────────────────
test('urgency comes from facts, not from wording', () => {
  assert.equal(gradeUrgency({ overdue: true }), 'urgent');
  assert.equal(gradeUrgency({ minutesUntil: 45 }), 'urgent');
  assert.equal(gradeUrgency({ exception: true }), 'urgent');
  assert.equal(gradeUrgency({ thresholdCrossed: true }), 'normal');
  assert.equal(gradeUrgency({ category: 'digest' }), 'normal');
  assert.equal(gradeUrgency({}), 'low');
  assert.equal(gradeUrgency({ minutesUntil: 600 }), 'low', 'a meeting ten hours away is not an emergency');
});

// ── Dedupe and collapsing ──────────────────────────────────────────────────────────────
test('the same watch reporting the same state twice is one notification', () => {
  const a = dedupeKeyFor({ category: 'watch', scheduledTaskId: 'w1', state: '86 is below 90' });
  const b = dedupeKeyFor({ category: 'watch', scheduledTaskId: 'w1', state: '86 is below 90' });
  const c = dedupeKeyFor({ category: 'watch', scheduledTaskId: 'w1', state: '74 is below 90' });
  assert.equal(a, b);
  assert.notEqual(a, c, 'a genuinely new transition is genuinely new news');
});

test('the digest is one notification per day however often it is recomputed', () => {
  assert.equal(
    dedupeKeyFor({ category: 'digest', dateKey: '2026-08-09' }),
    dedupeKeyFor({ category: 'digest', dateKey: '2026-08-09' })
  );
  assert.notEqual(
    dedupeKeyFor({ category: 'digest', dateKey: '2026-08-09' }),
    dedupeKeyFor({ category: 'digest', dateKey: '2026-08-10' })
  );
});

test('three alerts about one parcel collapse into the one that says what happened', () => {
  const kept = collapseRelated([
    { id: '1', title: 'Delivery watch triggered', body: 'Something changed.', dedupe_key: 'a', source_ref: { scheduledTaskId: 'w1' } },
    { id: '2', title: 'Your DPD parcel is out for delivery', body: 'Out for delivery today.', dedupe_key: 'b', source_ref: { scheduledTaskId: 'w1' } }
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, '2');
});

test('unrelated notifications are not collapsed together', () => {
  const kept = collapseRelated([
    { id: '1', title: 'Parcel', body: '', dedupe_key: 'a', source_ref: { scheduledTaskId: 'w1' } },
    { id: '2', title: 'Hotel price', body: '', dedupe_key: 'b', source_ref: { scheduledTaskId: 'w2' } }
  ]);
  assert.equal(kept.length, 2);
});

// ── The rule the whole module exists for ───────────────────────────────────────────────
function runtimeWith(overrides = {}) {
  const rows = new Map();
  const calls = [];
  const supabase = {
    from() {
      const api = {
        _filters: {},
        select() { return api; },
        insert(row) { api._insert = row; return api; },
        update(patch) { api._update = patch; return api; },
        eq(col, val) { api._filters[col] = val; return api; },
        in() { return api; },
        or() { return api; },
        order() { return api; },
        limit() { return api; },
        maybeSingle() {
          if (api._insert) return Promise.resolve({ data: { id: 'n1' } });
          const found = [...rows.values()].find(r => r.dedupe_key === api._filters.dedupe_key);
          return Promise.resolve({ data: found || null });
        },
        single() {
          if (api._insert) {
            const row = { id: `n${rows.size + 1}`, status: 'pending', attempts: 0, ...api._insert };
            rows.set(row.id, row);
            return Promise.resolve({ data: row });
          }
          return Promise.resolve({ data: null });
        },
        then(resolve) {
          if (api._update) {
            if (api._filters.id) {
              const row = rows.get(api._filters.id);
              if (row) Object.assign(row, api._update);
            }
            return Promise.resolve({ data: [], error: null }).then(resolve);
          }
          // The sweep's list query: everything still owed to this user. Without this the
          // fake answered "nothing pending" and deliverPending could never be exercised.
          const pending = [...rows.values()].filter(r => ['pending', 'deferred'].includes(r.status));
          return Promise.resolve({ data: pending, error: null }).then(resolve);
        }
      };
      return api;
    }
  };
  const runtime = createDeliveryRuntime({
    supabase,
    sendPush: async () => { calls.push('push'); return { ok: false, error: 'Apple push is not configured' }; },
    sendEmail: async (args) => { calls.push(`email:${args.provider || 'resend'}:${args.to}`); return overrides.emailResult ?? { ok: true, providerRef: 'resend-1' }; },
    createBriefing: async () => { calls.push('in_app'); return { id: 'b1' }; },
    getPreferenceMap: async () => overrides.prefs || {},
    getUserEmail: async () => overrides.emailTo ?? 'user@example.com',
    getMailbox: async () => overrides.mailbox ?? null,
    countPushDevices: async () => overrides.devices ?? 0,
    env: overrides.env || {},
    now: () => NOW
  });
  return { runtime, rows, calls };
}

test('an email provider running in no-op mode is a FAILURE, never a delivery', async () => {
  // api/services/email.js returns { ok: true, dev: true } when RESEND_API_KEY is absent. If
  // that counted, every notification would report as delivered while nothing was ever sent.
  const { runtime, rows } = runtimeWith({
    env: { RESEND_API_KEY: 'present-but-noop' },
    emailResult: { ok: true, dev: true }
  });
  const raised = await runtime.raise('u1', {
    category: 'watch', title: 'Brighton room', body: 'Now £86.', dedupeKey: 'k1'
  });
  assert.equal(raised.ok, true);

  const event = [...rows.values()][0];
  const result = await runtime.deliverOne('u1', event, {
    prefs: {}, available: ['email'], emailTo: 'user@example.com'
  });
  assert.notEqual(result.status, 'delivered');
  assert.match(result.error, /not really configured/);
});

test('a delivery is only recorded once a provider actually accepted it', async () => {
  const { runtime, rows, calls } = runtimeWith({ env: { RESEND_API_KEY: 'k' } });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  const event = [...rows.values()][0];
  const result = await runtime.deliverOne('u1', event, { prefs: {}, available: ['email'], emailTo: 'user@example.com' });
  assert.equal(result.status, 'delivered');
  assert.equal(result.channel, 'email');
  assert.ok(calls.includes('email:resend:user@example.com'));
});

test('a failed attempt stays pending for retry and only fails for good after the cap', async () => {
  const { runtime, rows } = runtimeWith({ emailResult: { ok: false, error: 'provider rejected' } });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  const event = [...rows.values()][0];

  let result = await runtime.deliverOne('u1', event, { prefs: {}, available: ['email'], emailTo: 'x@y.com' });
  assert.equal(result.status, 'pending', 'first failure is retryable');
  result = await runtime.deliverOne('u1', { ...event, attempts: 1 }, { prefs: {}, available: ['email'], emailTo: 'x@y.com' });
  assert.equal(result.status, 'pending');
  result = await runtime.deliverOne('u1', { ...event, attempts: 2 }, { prefs: {}, available: ['email'], emailTo: 'x@y.com' });
  assert.equal(result.status, 'failed', 'giving up is recorded, not retried forever');
});

test('raising the same event twice does not queue a second message', async () => {
  const { runtime, rows } = runtimeWith();
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'same' });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B updated', dedupeKey: 'same' });
  assert.equal(rows.size, 1);
});

test('a notification without a title, body or dedupe key is refused', async () => {
  const { runtime } = runtimeWith();
  assert.equal((await runtime.raise('u1', { category: 'watch', title: '', body: 'b', dedupeKey: 'k' })).ok, false);
  assert.equal((await runtime.raise('u1', { category: 'watch', title: 't', body: 'b', dedupeKey: '' })).ok, false);
});

// ── Shape of what the user receives ────────────────────────────────────────────────────
test('the outbound email says why it arrived and how to stop it', () => {
  const shaped = formatNotificationEmail({ category: 'reply_needed', title: 'Mia is waiting', body: 'She asked about next week.' });
  assert.equal(shaped.subject, 'Mia is waiting');
  assert.match(shaped.text, /She asked about next week\./);
  assert.match(shaped.text, /because you asked to be told about reply needed updates/);
});

test('preferences read back as a sentence, not a settings dump', () => {
  const text = describePreference({
    [PREF.channel]: 'email', [PREF.urgentOnly]: 'true',
    [PREF.quietHours]: '22:00-07:00', [PREF.category('delivery')]: 'in_app'
  });
  assert.match(text, /channel email/);
  assert.match(text, /urgent only/);
  assert.match(text, /quiet 22:00-07:00/);
  assert.match(text, /delivery: in_app/);
});
