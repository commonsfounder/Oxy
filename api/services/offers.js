'use strict';

// A proactive offer is one sentence from Adam with a one-tap "yes". The yes sends a normal chat
// turn, so anything it leads to goes through the usual approvals; nothing here acts on its own.

const { daysUntil } = require('./occasions');

const OCCASION_WINDOW_DAYS = 7;
const COMMITMENT_WINDOW_MS = 2 * 86400000;
const OVERDUE_LIMIT_MS = 3 * 86400000;

function clean(value, max = 90) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function when(days) {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function occasionOffers(occasions = [], now) {
  return occasions
    .map(row => ({ row, days: daysUntil(row.month, row.day, now) }))
    .filter(({ days }) => days >= 0 && days <= OCCASION_WINDOW_DAYS)
    .map(({ row, days }) => {
      const name = clean(row.person_name, 40);
      const type = clean(row.occasion_type || 'birthday', 30).toLowerCase();
      if (!name) return null;
      return {
        id: `occasion:${name.toLowerCase()}:${type}:${new Date(now).getUTCFullYear()}`,
        urgency: days,
        text: `${name}'s ${type} is ${when(days)}. Want a hand with a message or a gift?`,
        yes: 'Yes please',
        prompt: `Help me with ${name}'s ${type} ${when(days)}: suggest a gift and draft a short message.`
      };
    })
    .filter(Boolean);
}

function commitmentOffers(commitments = [], now) {
  const at = new Date(now).getTime();
  return commitments
    .filter(row => row.status === 'open' && row.due_at)
    .map(row => ({ row, due: Date.parse(row.due_at) }))
    .filter(({ due }) => Number.isFinite(due) && due - at <= COMMITMENT_WINDOW_MS && at - due <= OVERDUE_LIMIT_MS)
    .map(({ row, due }) => {
      const what = clean(row.what);
      if (!what) return null;
      const days = Math.max(0, Math.round((due - at) / 86400000));
      return {
        id: `commitment:${row.id || what.toLowerCase()}`,
        urgency: days,
        text: due < at ? `You said you'd ${what}, and that was due a little while ago. Want me to help get it done?` : `You said you'd ${what}, due ${when(days)}. Want me to help get it done?`,
        yes: 'Yes please',
        prompt: `Help me finish this: ${what}.`
      };
    })
    .filter(Boolean);
}

// The single most pressing offer, or null. Deliberately at most one: an offer, never a nag.
function chooseOffer({ occasions, commitments, now = new Date(), alreadyOffered = new Set() } = {}) {
  const all = [...commitmentOffers(commitments, now), ...occasionOffers(occasions, now)]
    .filter(offer => !alreadyOffered.has(offer.id))
    .sort((a, b) => a.urgency - b.urgency);
  return all[0] || null;
}

module.exports = { chooseOffer, occasionOffers, commitmentOffers };
