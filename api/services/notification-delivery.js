'use strict';

// The part that actually sends. Kept separate from notifications.js (which is pure routing
// logic) because this is where the honesty rules bite: a channel is only "available" if it is
// genuinely configured, and only a provider accepting the message counts as delivered.

const notifications = require('./notifications');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long a row may sit in 'sending' before a sweep may treat it as abandoned rather than in
// flight. Real sends take seconds; this is generous, because reclaiming early duplicates a send.
const CLAIM_STALE_MS = 5 * 60 * 1000;

// Which transport carries an email. Resend goes first when configured, sending from Adam's own
// identity; otherwise a connected Google account already grants messages.send, so delivery works
// with no extra credential. That path leaves the user's own mailbox, so it only ever reaches them.
function resolveEmailProvider({ env = process.env, mailboxCanSend = false } = {}) {
  if (env.RESEND_API_KEY) return 'resend';
  if (mailboxCanSend) return 'gmail';
  return null;
}

// Where a notification may land, in order: an address the user set as their destination, their
// verified account address, then the mailbox they connected. The third needs no separate
// verification — that rule exists to stop us mailing third parties, and this is not one.
function resolveEmailDestination({ prefEmailTo = '', verifiedEmail = '', mailboxAddress = '' } = {}) {
  return String(prefEmailTo || verifiedEmail || mailboxAddress || '').trim();
}

// Which channels can deliver right now, checked per call rather than at boot so connecting an
// account makes a channel live without a redeploy.
function availableChannels({ env = process.env, hasPushDevices = false, emailTo = '', mailboxCanSend = false, telegramCanSend = false } = {}) {
  const available = [];
  if (env.APNS_BUNDLE_ID && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY && hasPushDevices) {
    available.push('push');
  }
  if (resolveEmailProvider({ env, mailboxCanSend }) && emailTo) available.push('email');
  // Telegram needs no per-call destination resolution the way email does — the destination
  // is always the user's own Saved Messages, never a contact — so "can it send" IS "is it
  // available", unlike email's separate provider/destination split.
  if (telegramCanSend) available.push('telegram');
  // The in-app card is always available: it is a row in this database, not a third party.
  available.push('in_app');
  return available;
}

function describeUnavailable({ env = process.env, hasPushDevices = false, emailTo = '', mailboxCanSend = false, telegramCanSend = false } = {}) {
  const reasons = [];
  if (!env.APNS_BUNDLE_ID || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY) {
    reasons.push('push: Apple push credentials are not configured');
  } else if (!hasPushDevices) {
    reasons.push('push: no registered device');
  }
  if (!resolveEmailProvider({ env, mailboxCanSend })) {
    reasons.push('email: no email provider is configured (set RESEND_API_KEY, or connect Google to send from your own mailbox)');
  } else if (!emailTo) {
    reasons.push('email: no destination address is set');
  }
  if (!telegramCanSend) reasons.push('telegram: not connected (authenticate via /auth/telegram/start)');
  return reasons;
}

// Builds the delivery runtime around the primitives the caller injects — the live senders in
// production, recording fakes in tests.
function createDeliveryRuntime({
  supabase,
  sendPush,
  sendEmail,
  sendTelegram,
  createBriefing,
  getPreferenceMap,
  getUserEmail,
  countPushDevices,
  // Resolves the user's own connected mailbox: { address, canSend } or null. Optional so
  // callers that genuinely have no mail connector keep working — they just get the Resend
  // path, exactly as before.
  getMailbox = async () => null,
  // Is Telegram genuinely authenticated right now? { canSend } or null — mirrors getMailbox.
  getTelegram = async () => null,
  env = process.env,
  now = () => new Date()
}) {
  // Raises an event, or folds it into the one already raised for the same real-world thing.
  async function raise(userId, {
    category, urgency, title, body, dedupeKey, sourceRef = {}
  }) {
    const row = {
      user_id: userId,
      category: notifications.normalizeCategory(category),
      urgency: notifications.normalizeUrgency(urgency),
      title: String(title || '').slice(0, 200),
      body: String(body || '').slice(0, 4000),
      dedupe_key: dedupeKey,
      source_ref: sourceRef,
      updated_at: now().toISOString()
    };
    if (!row.title || !row.body || !row.dedupe_key) {
      return { ok: false, error: 'a notification needs a title, a body and a dedupe key' };
    }

    const { data: existing } = await supabase.from('notification_events')
      .select('id, status').eq('user_id', userId).eq('dedupe_key', row.dedupe_key).maybeSingle();

    if (existing) {
      // Already told them about this exact thing — refresh the wording, do not send again.
      if (existing.status === 'delivered') return { ok: true, id: existing.id, duplicate: true };
      const { error } = await supabase.from('notification_events').update(row).eq('id', existing.id);
      return error ? { ok: false, error: error.message } : { ok: true, id: existing.id, updated: true };
    }

    const { data, error } = await supabase.from('notification_events')
      .insert({ ...row, status: 'pending' }).select('id').single();
    if (!error) return { ok: true, id: data.id, created: true };

    // The select-then-insert above is a check-then-act race; the unique index on
    // (user_id, dedupe_key) is what actually prevents a second row. The loser reads that as
    // "already raised" rather than surfacing a constraint violation.
    if (error.code === '23505') {
      const { data: raced } = await supabase.from('notification_events')
        .select('id').eq('user_id', userId).eq('dedupe_key', row.dedupe_key).maybeSingle();
      if (raced) return { ok: true, id: raced.id, duplicate: true };
    }
    return { ok: false, error: error.message };
  }

  // Takes ownership of a claimable row before anything is sent. The UPDATE's WHERE clause is the
  // mechanism: only one writer can flip the status, and the loser gets 0 rows and skips it —
  // otherwise two sweeps produce two real external messages for one event.
  async function claim(event, stamp) {
    // 'sending' is claimable only when stale, and staleness is checked in this same UPDATE
    // rather than trusted from the caller — otherwise a row claimed a millisecond ago looks
    // exactly like one abandoned ten minutes ago, and both racers claim it.
    const staleBefore = new Date(new Date(stamp).getTime() - CLAIM_STALE_MS).toISOString();
    const { data } = await supabase.from('notification_events')
      .update({ status: 'sending', updated_at: stamp })
      .eq('id', event.id)
      .or(`status.in.(pending,deferred),and(status.eq.sending,updated_at.lt.${staleBefore})`)
      .select('id')
      .maybeSingle();
    return Boolean(data);
  }

  // A send the provider accepted must never return to the retry pool. If recording success
  // fails, the write is retried, not the send; if it still won't land the row is marked
  // 'failed' with an error saying the send succeeded, so nothing auto-retries a sent message.
  async function recordDelivered(event, decision, result, stamp) {
    const patch = {
      status: 'delivered',
      channel: decision.channel,
      provider_ref: result.providerRef || result.id || null,
      attempts: (event.attempts || 0) + 1,
      delivered_at: stamp,
      updated_at: stamp,
      last_error: null
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error } = await supabase.from('notification_events').update(patch).eq('id', event.id);
      if (!error) return true;
      if (attempt < 2) await sleep(200 * (attempt + 1));
    }
    // A real try/catch, not a `.catch()` chained onto the query builder — the actual
    // Supabase-js client has no `.catch()` method at all (only `.then()`); that would have
    // thrown a TypeError the first time this fallback write ever ran for real.
    try {
      await supabase.from('notification_events').update({
        status: 'failed',
        attempts: patch.attempts,
        updated_at: stamp,
        last_error: `${decision.channel} accepted this message but the delivery could not be recorded — left as failed rather than pending, so nothing resends a message that already went out`
      }).eq('id', event.id);
    } catch { /* best-effort — nothing further to do if even this write fails */ }
    return false;
  }

  async function deliverOne(userId, event, { prefs, available, emailTo, emailProvider = null }) {
    const decision = notifications.resolveDelivery({ event, prefs, available, now: now() });
    const stamp = now().toISOString();

    if (!decision.deliver) {
      await supabase.from('notification_events').update({
        status: decision.status,
        deliver_after: decision.deliverAfter ? decision.deliverAfter.toISOString() : null,
        last_error: decision.reason,
        updated_at: stamp
      }).eq('id', event.id);
      return { id: event.id, status: decision.status, reason: decision.reason };
    }

    if (!(await claim(event, stamp))) {
      // Another worker already has this one. Not a failure — just not this call's to make.
      return { id: event.id, status: 'claimed_elsewhere' };
    }

    let result;
    try {
      if (decision.channel === 'push') {
        result = await sendPush(userId, { title: event.title, body: event.body, category: event.category });
      } else if (decision.channel === 'email') {
        const shaped = notifications.formatNotificationEmail(event);
        result = await sendEmail({
          userId, to: emailTo, subject: shaped.subject, text: shaped.text, provider: emailProvider
        });
      } else if (decision.channel === 'telegram') {
        const shaped = notifications.formatNotificationTelegram(event);
        result = await sendTelegram(userId, { text: shaped.text });
      } else {
        const briefing = await createBriefing(userId, {
          kind: `notification_${event.category}`,
          title: event.title,
          body: event.body,
          source: 'agent',
          metadata: { notificationId: event.id, ...(event.source_ref || {}) },
          // The push inside createBriefing would be a second, uncontrolled attempt at the
          // same event — this runtime owns channel choice.
          push: false
        });
        result = { ok: Boolean(briefing?.id), providerRef: briefing?.id || null };
      }
    } catch (error) {
      result = { ok: false, error: error.message };
    }

    // The rule this whole module exists for: a provider that did not accept it is a failure,
    // however cheerfully it returned. api/services/email.js in particular returns
    // { ok: true, dev: true } when RESEND_API_KEY is missing — that is a no-op, not a send.
    const accepted = Boolean(result?.ok) && result?.dev !== true;
    const attempts = (event.attempts || 0) + 1;

    if (accepted) {
      await recordDelivered(event, decision, result, stamp);
      return { id: event.id, status: 'delivered', channel: decision.channel };
    }

    const error = result?.dev === true
      ? `${decision.channel} is not really configured (the provider ran in no-op mode)`
      : (result?.error || `${decision.channel} did not accept the message`);
    // Retries stay 'pending' so the next sweep picks them up; only an exhausted event fails
    // for good. Because delivery is keyed on the event row, a retry cannot duplicate a
    // message that already went.
    const exhausted = attempts >= notifications.MAX_ATTEMPTS;
    // A provider-supplied backoff (Telegram's FLOOD_WAIT carries a real number of seconds)
    // is honoured over the default "retry on the next sweep" cadence — hammering retries
    // immediately after a flood wait is exactly what causes the next one.
    const deliverAfter = !exhausted && Number.isFinite(result?.retryAfterSeconds)
      ? new Date(now().getTime() + result.retryAfterSeconds * 1000).toISOString()
      : null;
    await supabase.from('notification_events').update({
      status: exhausted ? 'failed' : 'pending',
      attempts,
      last_error: error,
      deliver_after: deliverAfter,
      updated_at: stamp
    }).eq('id', event.id);
    return { id: event.id, status: exhausted ? 'failed' : 'pending', error };
  }

  // Sweeps everything owed to this user. Safe to run repeatedly.
  async function deliverPending(userId, { limit = 20 } = {}) {
    const stamp = now().toISOString();
    const staleSendingBefore = new Date(now().getTime() - CLAIM_STALE_MS).toISOString();
    // pending/deferred whose deliver_after has passed, OR a 'sending' row old enough that
    // whatever worker claimed it must have died before recording an outcome — the same
    // stale-claim recovery shape used elsewhere in this codebase for stale agent runs.
    const { data: rows, error } = await supabase.from('notification_events')
      .select('*')
      .eq('user_id', userId)
      .or(
        `and(status.in.(pending,deferred),or(deliver_after.is.null,deliver_after.lte.${stamp})),` +
        `and(status.eq.sending,updated_at.lt.${staleSendingBefore})`
      )
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) return { ok: false, error: error.message };

    // Digests already sent today still speak for what they covered — see collapseRelated.
    const since = new Date(now().getTime() - 24 * 3600000).toISOString();
    const { data: sentDigests } = await supabase.from('notification_events')
      .select('source_ref')
      .eq('user_id', userId)
      .eq('category', 'digest')
      .eq('status', 'delivered')
      .gte('delivered_at', since);
    const alreadyCovered = (sentDigests || []).flatMap(row => row.source_ref?.covers || []);

    const events = notifications.collapseRelated(rows || [], { alreadyCovered });
    const collapsed = (rows || []).filter(row => !events.some(kept => kept.id === row.id));
    for (const dropped of collapsed) {
      await supabase.from('notification_events').update({
        status: 'suppressed',
        last_error: 'folded into a related notification about the same thing',
        updated_at: stamp
      }).eq('id', dropped.id);
    }

    const prefs = await getPreferenceMap(userId).catch(() => ({}));
    const mailbox = await getMailbox(userId).catch(() => null);
    const mailboxCanSend = Boolean(mailbox?.canSend && mailbox?.address);
    const emailTo = resolveEmailDestination({
      prefEmailTo: prefs[notifications.PREF.emailTo],
      verifiedEmail: await getUserEmail(userId).catch(() => ''),
      mailboxAddress: mailbox?.address
    });
    const emailProvider = resolveEmailProvider({ env, mailboxCanSend });
    const hasPushDevices = (await countPushDevices(userId).catch(() => 0)) > 0;
    const telegram = await getTelegram(userId).catch(() => null);
    const telegramCanSend = Boolean(telegram?.canSend);
    const available = availableChannels({ env, hasPushDevices, emailTo, mailboxCanSend, telegramCanSend });

    const results = [];
    for (const event of events) {
      results.push(await deliverOne(userId, event, { prefs, available, emailTo, emailProvider }));
    }
    return {
      ok: true,
      available,
      emailProvider,
      unavailable: describeUnavailable({ env, hasPushDevices, emailTo, mailboxCanSend, telegramCanSend }),
      collapsed: collapsed.length,
      results
    };
  }

  return { raise, deliverPending, deliverOne };
}

module.exports = {
  availableChannels,
  describeUnavailable,
  resolveEmailProvider,
  resolveEmailDestination,
  createDeliveryRuntime
};
