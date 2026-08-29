// Proactive outbound delivery: routing, dedupe, quiet hours, urgency and — most importantly —
// what may and may not be called "delivered".

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PREF, gradeUrgency, dedupeKeyFor, parseQuietHours, inQuietHours,
  resolveDelivery, collapseRelated, formatNotificationEmail, formatNotificationTelegram, describePreference
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

test('an authenticated Telegram session makes the channel available with no separate destination step', () => {
  // Unlike email, Telegram needs no per-call destination resolution — the destination is
  // always Saved Messages, never a contact — so "can it send" alone gates availability.
  const off = availableChannels({ env: {}, hasPushDevices: false, telegramCanSend: false });
  assert.equal(off.includes('telegram'), false);
  const on = availableChannels({ env: {}, hasPushDevices: false, telegramCanSend: true });
  assert.deepEqual(on, ['telegram', 'in_app']);
  assert.match(describeUnavailable({ env: {}, telegramCanSend: false }).join(' '), /telegram: not connected/);
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
  // Resend stays first when it is genuinely configured: it sends from Adam's own identity
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

// ── Telegram through the SAME runtime as email/push/in-app ─────────────────────────────
// The instruction that shaped this: not a separate Telegram notification subsystem — one
// runtime, one dedupe key space, one delivery record per event, regardless of which channel
// ends up carrying it.
test('a watch trigger with the channel set to telegram reaches Telegram and nothing else', async () => {
  const { runtime, rows, calls } = runtimeWith({
    env: {}, emailTo: 'user@example.com', telegram: { canSend: true },
    prefs: { [PREF.category('watch')]: 'telegram' }
  });
  await runtime.raise('u1', { category: 'watch', title: 'Brighton room', body: 'Now £86.', dedupeKey: 'k1' });
  const result = await runtime.deliverPending('u1');
  assert.equal(result.results[0].channel, 'telegram');
  assert.equal([...rows.values()][0].status, 'delivered');
  assert.equal([...rows.values()][0].channel, 'telegram');
  assert.equal(calls.some(c => c.startsWith('email:')), false, 'not also emailed — one trigger, one channel, unless configured otherwise');
  assert.equal(calls.some(c => c === 'in_app'), false);
});

test('Telegram not connected: describeUnavailable says so and the event still reaches the app', async () => {
  const { runtime, rows } = runtimeWith({ env: {}, emailTo: '', telegram: null });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  const result = await runtime.deliverPending('u1');
  assert.match(result.unavailable.join(' '), /telegram: not connected/);
  assert.equal([...rows.values()][0].channel, 'in_app');
});

test('Telegram running but rejecting the send is a failure, exactly like any other provider', async () => {
  const { runtime, rows } = runtimeWith({
    env: {}, telegram: { canSend: true }, telegramResult: { ok: false, error: 'FLOOD_WAIT' },
    prefs: { [PREF.channel]: 'telegram' }
  });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  const result = await runtime.deliverPending('u1');
  assert.notEqual(result.results[0].status, 'delivered');
  assert.match([...rows.values()][0].last_error, /FLOOD_WAIT/);
});

test('email-as-fallback actually fires when Telegram is unavailable, and only then', async () => {
  const { runtime, rows, calls } = runtimeWith({
    env: { RESEND_API_KEY: 'k' }, emailTo: 'user@example.com', telegram: null,
    prefs: { [PREF.channel]: 'telegram', [PREF.fallback]: 'email' }
  });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  const result = await runtime.deliverPending('u1');
  assert.equal(result.results[0].channel, 'email');
  assert.equal([...rows.values()][0].channel, 'email');
  assert.ok(calls.some(c => c.startsWith('email:resend:')));
});

test('quiet hours still defer a Telegram-routed notification, same as any other channel', () => {
  const prefs = { [PREF.channel]: 'telegram', [PREF.quietHours]: '22:00-07:00' };
  const lateNight = new Date('2026-08-09T22:30:00Z');
  const decision = resolveDelivery({ event: EVENT, prefs, available: ['telegram', 'in_app'], now: lateNight, timeZone: 'UTC' });
  assert.equal(decision.deliver, false);
  assert.equal(decision.status, 'deferred');
});

test('something urgent still reaches Telegram during quiet hours', () => {
  const prefs = { [PREF.channel]: 'telegram', [PREF.quietHours]: '22:00-07:00' };
  const decision = resolveDelivery({
    event: { ...EVENT, urgency: 'urgent' }, prefs, available: ['telegram', 'in_app'],
    now: new Date('2026-08-09T23:00:00Z'), timeZone: 'UTC'
  });
  assert.equal(decision.deliver, true);
  assert.equal(decision.channel, 'telegram');
});

test('re-raising the same event dedupes to one row regardless of which channel will carry it', async () => {
  const { runtime, rows } = runtimeWith({
    env: {}, telegram: { canSend: true }, prefs: { [PREF.channel]: 'telegram' }
  });
  await runtime.raise('u1', { category: 'watch', title: 'Quiet', body: 'B', dedupeKey: 'k1' });
  const again = await runtime.raise('u1', { category: 'watch', title: 'Quiet', body: 'B', dedupeKey: 'k1' });
  assert.ok(again.duplicate || again.updated);
  assert.equal(rows.size, 1);
});

// ── Routing ────────────────────────────────────────────────────────────────────────────
test('with nothing configured everything falls back to the in-app card', () => {
  const decision = resolveDelivery({ event: EVENT, available: ['in_app'], now: NOW });
  assert.equal(decision.deliver, true);
  assert.equal(decision.channel, 'in_app');
});

test('an event backed by an existing briefing uses that card as its in-app delivery', async () => {
  const { runtime, rows, calls } = runtimeWith({ env: {}, emailTo: '' });
  await runtime.raise('u1', {
    category: 'digest', title: 'One thing needs you today', body: 'Call the dentist.',
    dedupeKey: 'digest|day:2026-08-09|state:s1', sourceRef: { briefingId: 'briefing-existing' }
  });
  const result = await runtime.deliverPending('u1');
  assert.equal(result.results[0].status, 'delivered');
  assert.equal(result.results[0].channel, 'in_app');
  assert.equal([...rows.values()][0].provider_ref, 'briefing-existing');
  assert.equal(calls.includes('in_app'), false, 'the existing Home card is not duplicated');
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

test('action-required follow-ups are a first-class category and honor their own preference', () => {
  const event = { ...EVENT, category: 'action_required' };
  const prefs = { [PREF.category('action_required')]: 'off' };
  assert.equal(resolveDelivery({ event, prefs, available: ['push', 'in_app'], now: NOW }).status, 'suppressed');
});

test('"only send urgent things" holds back the rest', () => {
  const prefs = { [PREF.urgentOnly]: 'true' };
  assert.equal(resolveDelivery({ event: EVENT, prefs, available: ['email'], now: NOW }).status, 'suppressed');
  const urgent = resolveDelivery({ event: { ...EVENT, urgency: 'urgent' }, prefs, available: ['email'], now: NOW });
  assert.equal(urgent.deliver, true);
});

// ── Telegram participates in the SAME routing as everything else ───────────────────────
test('"send my alerts on Telegram" routes everything there', () => {
  const prefs = { [PREF.channel]: 'telegram' };
  const decision = resolveDelivery({ event: EVENT, prefs, available: ['email', 'telegram', 'in_app'], now: NOW });
  assert.equal(decision.channel, 'telegram');
});

test('"use Telegram for price watches but email my morning brief" — per-category, same as email/in_app before it', () => {
  const prefs = { [PREF.category('watch')]: 'telegram', [PREF.category('digest')]: 'email' };
  assert.equal(resolveDelivery({ event: EVENT, prefs, available: ['email', 'telegram', 'in_app'], now: NOW }).channel, 'telegram');
  assert.equal(resolveDelivery({
    event: { ...EVENT, category: 'digest' }, prefs, available: ['email', 'telegram', 'in_app'], now: NOW
  }).channel, 'email');
});

test('"send urgent alerts to Telegram" routes by urgency, not category', () => {
  const prefs = { [PREF.urgency('urgent')]: 'telegram' };
  assert.equal(resolveDelivery({
    event: { ...EVENT, urgency: 'urgent' }, prefs, available: ['email', 'telegram', 'in_app'], now: NOW
  }).channel, 'telegram');
  // A normal-urgency event on the same account is untouched by the urgent-only override.
  assert.equal(resolveDelivery({ event: EVENT, prefs, available: ['email', 'telegram', 'in_app'], now: NOW }).channel, 'email');
});

test('a category preference is more specific than an urgency preference', () => {
  const prefs = { [PREF.category('watch')]: 'telegram', [PREF.urgency('urgent')]: 'email' };
  const decision = resolveDelivery({
    event: { ...EVENT, category: 'watch', urgency: 'urgent' }, prefs, available: ['email', 'telegram', 'in_app'], now: NOW
  });
  assert.equal(decision.channel, 'telegram', 'watch (category) is more specific than urgent (urgency)');
});

// ── "Don't email me — Telegram only" must actually mean only Telegram ──────────────────
test('an explicit channel choice does not silently leak to whatever else happens to be configured', () => {
  const prefs = { [PREF.channel]: 'telegram' };
  // Telegram is NOT in available (session expired, say) — email IS available, but the user
  // said Telegram, not "Telegram, or whatever works". Falling through to email here would
  // make "don't email me" a preference the runtime doesn't actually keep.
  const decision = resolveDelivery({ event: EVENT, prefs, available: ['email', 'in_app'], now: NOW });
  assert.equal(decision.channel, 'in_app', 'only the universal last resort, never an unrequested channel');
});

test('"use email if Telegram fails" opts into exactly that fallback, and no other', () => {
  const prefs = { [PREF.channel]: 'telegram', [PREF.fallback]: 'email' };
  const decision = resolveDelivery({ event: EVENT, prefs, available: ['push', 'email', 'in_app'], now: NOW });
  assert.equal(decision.channel, 'email');
  assert.equal(decision.fellBackFrom, 'telegram');
});

test('a fallback that is also unavailable still stops at in_app, not a third guess', () => {
  const prefs = { [PREF.channel]: 'telegram', [PREF.fallback]: 'email' };
  const decision = resolveDelivery({ event: EVENT, prefs, available: ['push', 'in_app'], now: NOW });
  assert.equal(decision.channel, 'in_app');
});

test('with no fallback configured and the chosen channel truly unavailable, it fails rather than defaulting to in_app silently mislabeled', () => {
  const prefs = { [PREF.channel]: 'telegram' };
  const decision = resolveDelivery({ event: EVENT, prefs, available: [], now: NOW });
  assert.equal(decision.deliver, false);
  assert.equal(decision.status, 'failed');
  assert.match(decision.reason, /telegram is not available/);
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

// ── The digest wins over a separate alert about the same thing ─────────────────────────
test('a commitment already named in the digest does not also arrive on its own', () => {
  const kept = collapseRelated([
    {
      id: 'digest', category: 'digest', title: 'Two things need you today',
      body: '...', dedupe_key: 'digest|day:2026-08-09',
      source_ref: { covers: ['commitment:c1', 'thread:t9'] }
    },
    {
      id: 'commit', category: 'commitment', title: 'Send Mia the case study',
      body: 'Due today.', dedupe_key: 'commitment|commitment:c1',
      source_ref: { commitmentId: 'c1' }
    }
  ]);
  assert.deepEqual(kept.map(k => k.id), ['digest'],
    'the same sentence twice in one morning is what makes proactive software feel like nagging');
});

test('a thing the digest does NOT mention still gets its own notification', () => {
  const kept = collapseRelated([
    { id: 'digest', category: 'digest', title: 'One thing needs you today', body: '', dedupe_key: 'd', source_ref: { covers: ['commitment:c1'] } },
    { id: 'other', category: 'commitment', title: 'Pay the invoice', body: '', dedupe_key: 'o', source_ref: { commitmentId: 'c2' } }
  ]);
  assert.deepEqual(kept.map(k => k.id).sort(), ['digest', 'other']);
});

test('a digest ALREADY SENT this morning still speaks for what it covered', () => {
  // The duplicate that survived the first version of this rule: the digest had already been
  // delivered, so it was no longer in the pending set, and the commitment alert raised an
  // hour later went out on its own repeating a line the user had read at breakfast.
  const kept = collapseRelated(
    [{ id: 'commit', category: 'commitment', title: 'Send the board pack', body: '', dedupe_key: 'c', source_ref: { commitmentId: 'c1' } }],
    { alreadyCovered: ['commitment:c1'] }
  );
  assert.deepEqual(kept, [], 'which duplicate you get must not depend on sweep timing');
});

test('with no digest pending, everything is judged on its own merits', () => {
  const kept = collapseRelated([
    { id: 'commit', category: 'commitment', title: 'Send Mia the case study', body: '', dedupe_key: 'c', source_ref: { commitmentId: 'c1' } }
  ]);
  assert.deepEqual(kept.map(k => k.id), ['commit']);
});

test('two concurrent sweeps for one user: digest + the per-item it covers produce exactly one external send', async () => {
  // A digest and a per-item notification it already names, both pending, delivered by two
  // overlapping sweeps. collapseRelated suppresses the per-item on both workers' local view
  // before either claims anything, and the claim then leaves only one sending the digest.
  const { runtime, calls } = runtimeWith({ env: {}, telegram: { canSend: true }, prefs: { [PREF.channel]: 'telegram' } });
  await runtime.raise('u1', {
    category: 'digest', title: 'One thing needs you today', body: 'Send Mia the case study.',
    dedupeKey: 'digest|day:2026-08-09', sourceRef: { covers: ['commitment:c1'] }
  });
  await runtime.raise('u1', {
    category: 'commitment', title: 'Send Mia the case study', body: 'Due today.',
    dedupeKey: 'commitment|commitment:c1', sourceRef: { commitmentId: 'c1' }
  });
  const [a, b] = await Promise.all([runtime.deliverPending('u1'), runtime.deliverPending('u1')]);
  const delivered = [...a.results, ...b.results].filter(r => r.status === 'delivered');
  assert.equal(delivered.length, 1, 'one real message, not a digest from each worker and not a leaked per-item alert');
});

test('a digest for a NEW day is never deduped against a still-pending digest from the day before', () => {
  // Crossing midnight while yesterday's digest was deferred (quiet hours) must not make
  // today's digest look like a re-raise of the same event — the dedupe key IS the day.
  const yesterday = dedupeKeyFor({ category: 'digest', dateKey: '2026-08-09' });
  const today = dedupeKeyFor({ category: 'digest', dateKey: '2026-08-10' });
  assert.notEqual(yesterday, today);
});

test('a digest deferred by quiet hours across midnight delivers once real quiet hours end, not twice', async () => {
  // A single fake row store, shared between two runtime instances that differ only in what
  // time they each believe it is — "the night the digest was raised" and "the next morning,
  // once quiet hours have genuinely ended". Real production is exactly this: one process,
  // two different sweep invocations, real wall-clock time moving on between them.
  const rows = new Map();
  const calls = [];
  const supabase = {
    from() {
      const api = { _filters: {}, _update: null };
      api.select = () => api;
      api.insert = (row) => { api._insert = row; return api; };
      api.update = (patch) => { api._update = patch; return api; };
      api.eq = (col, val) => { api._filters[col] = val; return api; };
      api.in = () => api;
      api.or = (expr) => { api._claim = expr; return api; };
      api.gte = () => { api._gte = true; return api; };
      api.order = () => api;
      api.limit = () => api;
      api.maybeSingle = () => {
        if (api._claim) {
          const row = rows.get(api._filters.id);
          const claimable = row && ['pending', 'deferred'].includes(row.status);
          if (claimable) { Object.assign(row, api._update); return Promise.resolve({ data: { id: row.id } }); }
          return Promise.resolve({ data: null });
        }
        if (api._insert) return Promise.resolve({ data: null });
        return Promise.resolve({ data: [...rows.values()].find(r => r.dedupe_key === api._filters.dedupe_key) || null });
      };
      api.single = () => {
        if (api._insert) {
          const row = { id: `n${rows.size + 1}`, status: 'pending', attempts: 0, ...api._insert };
          rows.set(row.id, row);
          return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({ data: null });
      };
      api.then = (resolve) => {
        if (api._update) {
          if (api._filters.id) { const row = rows.get(api._filters.id); if (row) Object.assign(row, api._update); }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        }
        if (api._gte) return Promise.resolve({ data: [], error: null }).then(resolve);
        return Promise.resolve({
          data: [...rows.values()].filter(r => ['pending', 'deferred'].includes(r.status)),
          error: null
        }).then(resolve);
      };
      return api;
    }
  };
  const buildRuntime = (nowFn) => createDeliveryRuntime({
    supabase, sendPush: async () => ({ ok: false }), sendEmail: async () => ({ ok: false }),
    sendTelegram: async (_u, args) => { calls.push(`telegram:${args.text}`); return { ok: true }; },
    createBriefing: async () => ({ id: 'b' }),
    getPreferenceMap: async () => ({ [PREF.channel]: 'telegram', [PREF.quietHours]: '22:00-07:00' }),
    getUserEmail: async () => '', getMailbox: async () => null, getTelegram: async () => ({ canSend: true }),
    countPushDevices: async () => 0, env: {}, now: nowFn
  });

  // Raised late at night — quiet hours are active, so it defers rather than sends.
  const lateNight = new Date('2026-08-09T23:50:00Z');
  const nightRuntime = buildRuntime(() => lateNight);
  await nightRuntime.raise('u1', { category: 'digest', title: 'T', body: 'B', dedupeKey: 'digest|day:2026-08-09' });
  const nightSweep = await nightRuntime.deliverPending('u1');
  assert.equal(nightSweep.results[0].status, 'deferred');
  const deferredUntil = [...rows.values()][0].deliver_after;
  // deliverPending resolves quiet hours in the default Europe/London timezone (BST, UTC+1,
  // in August) — 07:00 local is 06:00 UTC. The point stands either way: it crosses midnight.
  assert.equal(deferredUntil, '2026-08-10T06:00:00.000Z', 'the wait crosses into the next calendar day');
  assert.equal(calls.length, 0, 'nothing was sent while quiet hours were still active');

  // The SAME event, the next morning, once quiet hours have genuinely ended (07:00 BST).
  const morning = new Date('2026-08-10T06:00:01Z');
  const morningRuntime = buildRuntime(() => morning);
  const morningSweep = await morningRuntime.deliverPending('u1');
  assert.equal(morningSweep.results[0].status, 'delivered');
  assert.equal(calls.length, 1, 'delivered exactly once, not duplicated by crossing midnight');

  // And a THIRD sweep, later that same morning, must not send it again.
  const laterSweep = await morningRuntime.deliverPending('u1');
  assert.equal(laterSweep.results.length, 0, 'already delivered — nothing left to do');
  assert.equal(calls.length, 1);
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
        // Only claim() calls .or() in this module, with the exact staleness-aware shape
        // `status.in.(pending,deferred),and(status.eq.sending,updated_at.lt.X)` — the fake
        // recognises that specific call rather than parsing PostgREST filter syntax, and
        // replicates the same staleness semantics the real conditional UPDATE relies on.
        or(expr) { api._claimOr = expr; return api; },
        gte() { api._gte = true; return api; },
        order() { return api; },
        limit() { return api; },
        maybeSingle() {
          if (api._update && api._filters.id && api._claimOr) {
            const row = rows.get(api._filters.id);
            const staleBefore = api._claimOr.match(/updated_at\.lt\.(\S+)\)/)?.[1];
            const claimable = row && (
              ['pending', 'deferred'].includes(row.status) ||
              (row.status === 'sending' && staleBefore && new Date(row.updated_at) < new Date(staleBefore))
            );
            if (claimable) {
              Object.assign(row, api._update);
              return Promise.resolve({ data: { id: row.id } });
            }
            return Promise.resolve({ data: null });
          }
          if (api._insert) return Promise.resolve({ data: { id: 'n1' } });
          const found = [...rows.values()].find(r => r.dedupe_key === api._filters.dedupe_key);
          return Promise.resolve({ data: found || null });
        },
        single() {
          if (api._insert) {
            const row = { id: `n${rows.size + 1}`, status: 'pending', attempts: 0, ...api._insert };
            rows.set(row.id, row);
            return Promise.resolve({ data: row, error: null });
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
          // The lookback for digests already delivered today.
          if (api._gte) {
            return Promise.resolve({
              data: [...rows.values()].filter(r => r.category === 'digest' && r.status === 'delivered'),
              error: null
            }).then(resolve);
          }
          // The sweep's list query: pending/deferred, plus a 'sending' row stale enough that
          // whatever claimed it must have died — mirrors the real widened SELECT.
          const staleBefore = new Date(NOW.getTime() - 5 * 60000);
          const owed = [...rows.values()].filter(r =>
            ['pending', 'deferred'].includes(r.status) ||
            (r.status === 'sending' && new Date(r.updated_at) < staleBefore));
          return Promise.resolve({ data: owed, error: null }).then(resolve);
        }
      };
      return api;
    }
  };
  const runtime = createDeliveryRuntime({
    supabase,
    sendPush: async () => { calls.push('push'); return { ok: false, error: 'Apple push is not configured' }; },
    sendEmail: async (args) => { calls.push(`email:${args.provider || 'resend'}:${args.to}`); return overrides.emailResult ?? { ok: true, providerRef: 'resend-1' }; },
    sendTelegram: async (_userId, args) => { calls.push(`telegram:${args.text}`); return overrides.telegramResult ?? { ok: true }; },
    createBriefing: async () => { calls.push('in_app'); return { id: 'b1' }; },
    getPreferenceMap: async () => overrides.prefs || {},
    getUserEmail: async () => overrides.emailTo ?? 'user@example.com',
    getMailbox: async () => overrides.mailbox ?? null,
    getTelegram: async () => overrides.telegram ?? null,
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

// ── Reliability: concurrency, ambiguous outcomes, backoff ───────────────────────────────
test('raise() treats a unique-constraint race as "already raised", not a raw DB error', async () => {
  // raise()'s select-then-insert is a check-then-act race, so the unique index on
  // (user_id, dedupe_key) is what stops a second row. The loser must read that as a duplicate,
  // not surface a constraint violation for something that behaved correctly.
  const winner = { id: 'winner', user_id: 'u1', dedupe_key: 'k1', status: 'pending' };
  // Ordered exactly as raise() calls .from(): (1) the pre-insert existence check, from this
  // process's point of view before the winner committed — sees nothing; (2) the insert
  // itself — loses the race; (3) the re-fetch after the conflict — NOW sees the winner,
  // because by real-world time it has committed by then.
  let step = 0;
  let selectCount = 0;
  const supabase = {
    from() {
      step += 1;
      const thisStep = step;
      const api = {
        _filters: {},
        select() { return api; },
        insert() { return api; },
        eq(col, val) { api._filters[col] = val; return api; },
        maybeSingle() {
          if (thisStep === 1) return Promise.resolve({ data: null }); // nothing yet, from here
          selectCount += 1;
          return Promise.resolve({ data: api._filters.dedupe_key === winner.dedupe_key ? winner : null });
        },
        single() {
          // Simulates the real unique-index violation: this call lost the race.
          return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
        }
      };
      return api;
    }
  };
  const runtime = createDeliveryRuntime({
    supabase, sendPush: async () => ({ ok: false }), sendEmail: async () => ({ ok: false }),
    sendTelegram: async () => ({ ok: false }), createBriefing: async () => ({ id: 'b' }),
    getPreferenceMap: async () => ({}), getUserEmail: async () => '', getMailbox: async () => null,
    getTelegram: async () => null, countPushDevices: async () => 0, env: {}, now: () => NOW
  });
  const result = await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  assert.equal(result.ok, true, 'a race loser is not an error');
  assert.equal(result.duplicate, true);
  assert.equal(result.id, 'winner');
  assert.equal(selectCount, 1, 'exactly one re-fetch to find who actually won');
});

test('two concurrent delivery attempts on the SAME event: only one actually sends', async () => {
  const { runtime, rows, calls } = runtimeWith({ env: {}, telegram: { canSend: true }, prefs: { [PREF.channel]: 'telegram' } });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  const event = [...rows.values()][0];
  // Two workers racing on the same row — the claim's conditional UPDATE is the only thing
  // standing between this and two real external Telegram messages for one event.
  const [first, second] = await Promise.all([
    runtime.deliverOne('u1', event, { prefs: { [PREF.channel]: 'telegram' }, available: ['telegram', 'in_app'] }),
    runtime.deliverOne('u1', event, { prefs: { [PREF.channel]: 'telegram' }, available: ['telegram', 'in_app'] })
  ]);
  const outcomes = [first.status, second.status].sort();
  assert.deepEqual(outcomes, ['claimed_elsewhere', 'delivered']);
  assert.equal(calls.filter(c => c.startsWith('telegram:')).length, 1, 'exactly one real send, not two');
});

test('a provider that never responds (mid-send crash) leaves the row claimable again after it goes stale', async () => {
  const { runtime, rows } = runtimeWith({ env: {}, telegram: { canSend: true }, prefs: { [PREF.channel]: 'telegram' } });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  const event = [...rows.values()][0];
  event.status = 'sending';
  event.updated_at = new Date(NOW.getTime() - 10 * 60000).toISOString(); // 10 minutes ago — stale
  const result = await runtime.deliverPending('u1');
  // The stale 'sending' row was picked back up and actually delivered, not left stuck forever.
  assert.equal(result.results[0]?.status, 'delivered');
});

test('a send the provider genuinely accepted is never left eligible for automatic retry, even if the write to record it keeps failing', async () => {
  const rows = new Map();
  rows.set('e1', { id: 'e1', user_id: 'u1', status: 'pending', dedupe_key: 'k1', category: 'watch', urgency: 'normal', title: 'T', body: 'B', attempts: 0 });
  let updateAttempts = 0;
  const supabase = {
    from() {
      const api = { _filters: {} };
      api.select = () => api;
      api.eq = (col, val) => { api._filters[col] = val; return api; };
      api.in = () => api;
      api.or = () => { api._claim = true; return api; }; // claim()'s staleness-aware call
      api.update = (patch) => { api._update = patch; return api; };
      api.maybeSingle = () => {
        const row = rows.get(api._filters.id);
        if (api._claim && row && ['pending', 'deferred'].includes(row.status)) {
          Object.assign(row, api._update);
          return Promise.resolve({ data: { id: row.id } });
        }
        return Promise.resolve({ data: null });
      };
      api.then = (resolve) => {
        if (api._update && api._filters.id) {
          const row = rows.get(api._filters.id);
          // Only the "mark delivered" writes are ever attempted after the claim already
          // succeeded (status is 'sending' by then) — those are the ones made to keep failing.
          if (row?.status === 'sending' && api._update.status === 'delivered') {
            updateAttempts += 1;
            return Promise.resolve({ data: null, error: { message: 'connection reset' } }).then(resolve);
          }
          if (row) Object.assign(row, api._update);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      };
      return api;
    }
  };
  const runtime = createDeliveryRuntime({
    supabase, sendPush: async () => ({ ok: false }), sendEmail: async () => ({ ok: false }),
    sendTelegram: async () => ({ ok: true, providerRef: 'tg-1' }), // the provider genuinely accepted it
    createBriefing: async () => ({ id: 'b' }), getPreferenceMap: async () => ({ [PREF.channel]: 'telegram' }),
    getUserEmail: async () => '', getMailbox: async () => null, getTelegram: async () => ({ canSend: true }),
    countPushDevices: async () => 0, env: {}, now: () => NOW
  });
  const result = await runtime.deliverOne('u1', rows.get('e1'), { prefs: { [PREF.channel]: 'telegram' }, available: ['telegram', 'in_app'] });
  assert.equal(result.status, 'delivered', 'the caller is told the truth: the provider DID accept it');
  assert.equal(updateAttempts, 3, 'the write was retried, not given up on after one try');
  // But the ROW itself must never read as 'pending' after this — that would let the next
  // sweep call the provider a second time for a message that already went out for real.
  assert.equal(rows.get('e1').status, 'failed');
  assert.match(rows.get('e1').last_error, /accepted this message but the delivery could not be recorded/);
});

test('a FLOOD_WAIT backoff is honoured — the row is not eligible for retry until it elapses', async () => {
  const { runtime, rows } = runtimeWith({
    env: {}, telegram: { canSend: true }, prefs: { [PREF.channel]: 'telegram' },
    telegramResult: { ok: false, error: 'Telegram error: A wait of 90 seconds is required', retryAfterSeconds: 90, errorKind: 'flood_wait' }
  });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  const result = await runtime.deliverPending('u1');
  assert.equal(result.results[0].status, 'pending');
  const row = [...rows.values()][0];
  assert.ok(row.deliver_after, 'a backoff deadline was recorded, not left immediately retryable');
  assert.equal(new Date(row.deliver_after).getTime(), NOW.getTime() + 90000);
});

// ── Cross-channel fallback is exactly-once, in both directions ─────────────────────────
test('Telegram recovering later does not resend something email already delivered', async () => {
  const { runtime, rows } = runtimeWith({
    env: { RESEND_API_KEY: 'k' }, emailTo: 'user@example.com', telegram: null, // Telegram down when this ran
    prefs: { [PREF.channel]: 'telegram', [PREF.fallback]: 'email' }
  });
  await runtime.raise('u1', { category: 'watch', title: 'T', body: 'B', dedupeKey: 'k1' });
  const first = await runtime.deliverPending('u1');
  assert.equal(first.results[0].channel, 'email');
  assert.equal([...rows.values()][0].status, 'delivered');

  // Telegram is back now. A second sweep must find nothing left to do for this event — its
  // status is already 'delivered', so it is not even in the claimable set.
  const second = await runtime.deliverPending('u1');
  assert.equal(second.results.length, 0, 'a delivered event is not re-processed just because a different channel recovered');
});

// ── Shape of what the user receives ────────────────────────────────────────────────────
test('the outbound email says why it arrived and how to stop it', () => {
  const shaped = formatNotificationEmail({ category: 'reply_needed', title: 'Mia is waiting', body: 'She asked about next week.' });
  assert.equal(shaped.subject, 'Mia is waiting');
  assert.match(shaped.text, /She asked about next week\./);
  assert.match(shaped.text, /because you asked to be told about reply needed updates/);
});

test('the outbound Telegram message leads with the title — no subject line to carry it', () => {
  const shaped = formatNotificationTelegram({ category: 'watch', title: 'Brighton room dropped', body: 'Now £74 a night.' });
  assert.equal(shaped.text, 'Brighton room dropped\n\nNow £74 a night.');
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
