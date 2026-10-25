'use strict';

// Shapes options Adam found (products, restaurants, services) into cards the app can show
// side by side. Presentation only: it never invents a field the caller did not give.

const MAX_RESULTS = 8;
const MIN_RESULTS = 2;

function text(value, max) {
  const out = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!out) return null;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function shapeResultCard(raw, index) {
  const title = text(raw?.title ?? raw?.name, 90);
  if (!title) return null;
  const rating = number(raw.rating);
  const priceAmount = number(raw.price_amount ?? raw.priceAmount);
  return {
    id: `${index}:${title.toLowerCase()}`,
    title,
    subtitle: text(raw.subtitle ?? raw.detail, 120),
    price: text(raw.price, 40),
    priceAmount: priceAmount !== null && priceAmount >= 0 ? priceAmount : null,
    rating: rating !== null && rating >= 0 && rating <= 5 ? rating : null,
    ratingCount: number(raw.rating_count ?? raw.ratingCount),
    imageUrl: httpsUrl(raw.image_url ?? raw.imageUrl),
    url: httpsUrl(raw.url ?? raw.link),
    source: text(raw.source, 40),
    note: text(raw.note, 120)
  };
}

function shapeResultCards(items) {
  const list = Array.isArray(items) ? items : [];
  const seen = new Set();
  const cards = [];
  list.forEach((raw, index) => {
    const card = shapeResultCard(raw, index);
    if (!card) return;
    const key = card.url || card.title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    cards.push(card);
  });
  return cards.slice(0, MAX_RESULTS);
}

module.exports = { shapeResultCards, MAX_RESULTS, MIN_RESULTS };
