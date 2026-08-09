'use strict';

// The part that actually sends. Kept separate from notifications.js (which is pure routing
// logic) because this is where the honesty rules bite: a channel is only "available" if it is
// genuinely configured, and only a provider accepting the message counts as delivered.

const notifications = require('./notifications');

// Which transport actually carries an email right now.
//
// Resend is the dedicated provider and stays first when it is configured — it sends from
// Millie's own identity. But a connected Google account ALREADY grants gmail.modify, which
// includes messages.send, so a user with Gmail connected has a working outbound email path
// with no extra credential at all. Treating that as a real provider is the difference
// between "proactive delivery works once you sign up for Resend" and "proactive delivery
// works". Mail sent this way leaves the user's own mailbox, which is why it is only ever
// used to reach the user themselves — see the destination rules below.
function resolveEmailProvider({ env = process.env, mailboxCanSend = false } = {}) {
  if (env.RESEND_API_KEY) return 'resend';
  if (mailboxCanSend) return 'gmail';
  return null;
}

// Where a notification is allowed to land. In precedence order:
//   1. an address the user explicitly set as their notification destination,
//   2. their verified account address,
//   3. the mailbox they connected — an address they demonstrably own, because we are holding
//      their OAuth grant on it.
// The third is the one that needs no separate verification step: the verification rule exists
// to stop us mailing third parties, and delivering to a mailbox the user personally connected
// is not that.
function resolveEmailDestination({ prefEmailTo = '', verifiedEmail = '', mailboxAddress = '' } = {}) {
  return String(prefEmailTo || verifiedEmail || mailboxAddress || '').trim();
}

// Which channels can actually deliver right now. Deliberately checked per-call rather than at
// boot: adding RESEND_API_KEY (or connecting Google) should make email live without a
// redeploy of this logic, and a channel with code but no credentials must never be offered as
// if it worked.
function availableChannels({ env = process.env, hasPushDevices = false, emailTo = '', mailboxCanSend = false } = {}) {
  const available = [];
  if (env.APNS_BUNDLE_ID && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY && hasPushDevices) {
    available.push('push');
  }
  if (resolveEmailProvider({ env, mailboxCanSend }) && emailTo) available.push('email');
  // The in-app card is always available: it is a row in this database, not a third party.
  available.push('in_app');
  return available;
}

function describeUnavailable({ env = process.env, hasPushDevices = false, emailTo = '', mailboxCanSend = false } = {}) {
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
  return reasons;
}

// Builds the delivery runtime around whatever real primitives the caller injects. Everything
// injected here is a REAL implementation in production (api/index.js passes the live APNs
// sender, the live Resend client and the live briefing writer); tests inject fakes that
// record what they were asked to do.
function createDeliveryRuntime({
  supabase,
  sendPush,
  sendEmail,
  createBriefing,
  getPreferenceMap,
  getUserEmail,
  countPushDevices,
  // Resolves the user's own connected mailbox: { address, canSend } or null. Optional so
  // callers that genuinely have no mail connector keep working — they just get the Resend
  // path, exactly as before.
  getMailbox = async () => null,
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
    return error ? { ok: false, error: error.message } : { ok: true, id: data.id, created: true };
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

    let result;
    try {
      if (decision.channel === 'push') {
        result = await sendPush(userId, { title: event.title, body: event.body, category: event.category });
      } else if (decision.channel === 'email') {
        const shaped = notifications.formatNotificationEmail(event);
        result = await sendEmail({
          userId, to: emailTo, subject: shaped.subject, text: shaped.text, provider: emailProvider
        });
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
      await supabase.from('notification_events').update({
        status: 'delivered',
        channel: decision.channel,
        provider_ref: result.providerRef || result.id || null,
        attempts,
        delivered_at: stamp,
        updated_at: stamp,
        last_error: null
      }).eq('id', event.id);
      return { id: event.id, status: 'delivered', channel: decision.channel };
    }

    const error = result?.dev === true
      ? `${decision.channel} is not really configured (the provider ran in no-op mode)`
      : (result?.error || `${decision.channel} did not accept the message`);
    // Retries stay 'pending' so the next sweep picks them up; only an exhausted event fails
    // for good. Because delivery is keyed on the event row, a retry cannot duplicate a
    // message that already went.
    const exhausted = attempts >= notifications.MAX_ATTEMPTS;
    await supabase.from('notification_events').update({
      status: exhausted ? 'failed' : 'pending',
      attempts,
      last_error: error,
      updated_at: stamp
    }).eq('id', event.id);
    return { id: event.id, status: exhausted ? 'failed' : 'pending', error };
  }

  // Sweeps everything owed to this user. Safe to run repeatedly.
  async function deliverPending(userId, { limit = 20 } = {}) {
    const stamp = now().toISOString();
    const { data: rows, error } = await supabase.from('notification_events')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['pending', 'deferred'])
      .or(`deliver_after.is.null,deliver_after.lte.${stamp}`)
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
    const available = availableChannels({ env, hasPushDevices, emailTo, mailboxCanSend });

    const results = [];
    for (const event of events) {
      results.push(await deliverOne(userId, event, { prefs, available, emailTo, emailProvider }));
    }
    return {
      ok: true,
      available,
      emailProvider,
      unavailable: describeUnavailable({ env, hasPushDevices, emailTo, mailboxCanSend }),
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
