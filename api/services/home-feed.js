'use strict';

// The cards on Home: one short sentence each, led by a verb, with the company's logo when one is named.
// Everything here comes from things Adam really holds (saved dates, open commitments, fresh photos).

const { daysUntil } = require('./occasions');

const BRANDS = Object.freeze({
  google: 'google', gmail: 'google', calendar: 'google', outlook: 'outlook', telegram: 'telegram', whatsapp: 'whatsapp',
  youtube: 'youtube', spotify: 'spotify', uber: 'uber', netflix: 'netflix', trainline: 'trainline', github: 'github',
  notion: 'notion', slack: 'slack', strava: 'strava', monzo: 'monzo', linkedin: 'linkedin', indeed: 'indeed',
  deliveroo: 'deliveroo', todoist: 'todoist', zoom: 'zoom', instagram: 'instagram', facebook: 'facebook'
});

function clean(value, max = 140) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function brandIn(text) {
  const words = String(text || '').toLowerCase().match(/[a-z]+/g) || [];
  for (const word of words) if (BRANDS[word]) return BRANDS[word];
  return null;
}

function when(days) {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function splitVerb(sentence) {
  const text = clean(sentence).replace(/^want me to\s+/i, '').replace(/^shall i\s+/i, '');
  const [first, ...rest] = text.split(' ');
  if (!first) return null;
  return { verb: first.charAt(0).toUpperCase() + first.slice(1), rest: rest.join(' ') };
}

function card(id, urgency, verb, rest, prompt) {
  return { id, urgency, verb, rest, prompt: clean(prompt, 220), brand: brandIn(`${verb} ${rest}`) };
}

function buildCards({ occasions = [], commitments = [], photoOffers = [], now = new Date(), limit = 8 } = {}) {
  const at = new Date(now).getTime();
  const cards = [];

  for (const row of commitments) {
    if (row.status !== 'open' || !row.due_at) continue;
    const due = Date.parse(row.due_at);
    if (!Number.isFinite(due) || due - at > 3 * 86400000 || at - due > 3 * 86400000) continue;
    const parts = splitVerb(row.what);
    if (!parts) continue;
    const days = Math.max(0, Math.round((due - at) / 86400000));
    const dueText = due < at ? 'It was due a little while ago' : `Due ${when(days)}`;
    cards.push(card(`commitment:${row.id || clean(row.what, 40)}`, days, parts.verb, `${parts.rest || 'this'}? ${dueText}`, `Help me finish this: ${clean(row.what)}.`));
  }

  for (const row of occasions) {
    const days = daysUntil(row.month, row.day, now);
    if (days < 0 || days > 10) continue;
    const name = clean(row.person_name, 40);
    if (!name) continue;
    const type = clean(row.occasion_type || 'birthday', 30).toLowerCase();
    cards.push(card(`occasion:${name.toLowerCase()}:${type}`, days, 'Plan', `something for ${name}'s ${type} ${when(days)}?`, `Help me with ${name}'s ${type} ${when(days)}: suggest a gift and draft a short message.`));
  }

  for (const offer of photoOffers) {
    const parts = splitVerb(offer.ask);
    if (!parts || !offer.prompt) continue;
    cards.push(card(offer.id, 1, parts.verb, parts.rest, offer.prompt));
  }

  return cards.sort((a, b) => a.urgency - b.urgency).slice(0, limit).map(({ urgency, ...rest }) => rest);
}

module.exports = { buildCards, splitVerb, brandIn };
