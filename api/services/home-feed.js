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

function buildCards({ occasions = [], commitments = [], photoOffers = [], attentionCards = [], now = new Date(), limit = 8 } = {}) {
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

  for (const item of attentionCards) cards.push({ ...item, urgency: item.urgency ?? 1, brand: item.brand || brandIn(`${item.verb} ${item.rest}`) });

  return cards.sort((a, b) => a.urgency - b.urgency).slice(0, limit).map(({ urgency, ...rest }) => rest);
}

const crypto = require('node:crypto');
const cache = new Map();

const REWRITE_PROMPT = `Rewrite each item below as a short action card for a personal assistant's home screen.
For each item return {"i": number, "verb": string, "rest": string, "prompt": string, "brand": string|null}.
verb: one or two imperative words ("Top up", "Reply", "Review", "Pay").
rest: the rest of the sentence, ending with a question mark, keeping names, amounts and dates, and naming the company when there is one. Never include an email address.
prompt: what the user would ask the assistant to do, in the first person ("Help me top up Monzo by £13.71.").
brand: the company as one lowercase word if there is one (monzo, amazon), otherwise null.
Return a JSON array only, in the same order, with nothing else.`;

// Email digest lines ("Monzo needs you to add at least £13.71...") rewritten as cards, once per set of items.
async function attentionToCards({ items = [], generate, userId = '', ttlMs = 30 * 60 * 1000, now = Date.now() }) {
  const usable = items.filter(item => clean(item?.detail || item?.title, 300)).slice(0, 6);
  if (!usable.length || typeof generate !== 'function') return [];
  const key = `${userId}:${crypto.createHash('sha1').update(JSON.stringify(usable.map(i => [i.title, i.detail]))).digest('hex')}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.cards;
  let cards = [];
  try {
    const lines = usable.map((item, index) => `${index}. ${clean(item.detail || item.title, 300)}`).join('\n');
    const res = await generate({ contents: [{ role: 'user', parts: [{ text: `${REWRITE_PROMPT}\n\n${lines}` }] }], config: { maxOutputTokens: 900, reasoningEffort: 'low' } });
    const parsed = JSON.parse(String(res?.text || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
    cards = (Array.isArray(parsed) ? parsed : []).map((row) => {
      const item = usable[Number(row?.i)];
      const verb = clean(row?.verb, 24);
      const rest = clean(row?.rest, 160).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, 'them');
      const prompt = clean(row?.prompt, 220);
      if (!item || !verb || !rest || !prompt) return null;
      return { id: `mail:${crypto.createHash('sha1').update(String(item.detail || item.title)).digest('hex').slice(0, 10)}`, verb, rest, prompt, brand: BRANDS[String(row?.brand || '').toLowerCase()] || null, urgency: item.urgency === 'now' ? 0 : 1 };
    }).filter(Boolean);
  } catch { cards = []; }
  cache.set(key, { at: now, cards });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return cards;
}

module.exports = { buildCards, splitVerb, brandIn, attentionToCards };
