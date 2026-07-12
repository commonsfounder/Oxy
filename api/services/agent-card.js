'use strict';

// Stored payment card for browser-checkout ordering — the card the agent types into a
// merchant's own payment form after the user explicitly confirms a ready_for_payment gate.
// Distinct from stripe-cards.js: that card is a Stripe token for charging the user via
// Stripe; this one has to be the real PAN because merchant checkouts want a form filled,
// not an API call. Stored encrypted (token-crypto AES-256-GCM) in the connectors table,
// same envelope as every other connector secret. It is only ever decrypted server-side
// inside confirmPayment — nothing returns the full number to a client or a model prompt.

const { encryptTokens, decryptTokens } = require('./token-crypto');

const AGENT_CARD_CONNECTOR_ID = 'agent_card';

function luhnValid(number) {
  const digits = String(number || '').replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function detectCardBrand(number) {
  const d = String(number || '').replace(/[\s-]/g, '');
  if (/^4/.test(d)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^(6011|65|64[4-9])/.test(d)) return 'discover';
  return 'card';
}

function cardExpiryValid(expMonth, expYear, now = new Date()) {
  const m = Number(expMonth);
  let y = Number(expYear);
  if (!Number.isInteger(m) || m < 1 || m > 12) return false;
  if (!Number.isInteger(y)) return false;
  if (y < 100) y += 2000;
  if (y < now.getFullYear() || y > now.getFullYear() + 30) return false;
  if (y === now.getFullYear() && m < now.getMonth() + 1) return false;
  return true;
}

/**
 * Validate and normalise raw card input. Returns { ok, card } or { ok:false, error }.
 * Normalised card: { name, number (digits only), expMonth (1-12), expYear (4-digit), cvc }.
 */
function normaliseAgentCard({ name, number, expMonth, expYear, cvc } = {}) {
  const digits = String(number || '').replace(/[\s-]/g, '');
  if (!luhnValid(digits)) return { ok: false, error: 'Card number is not valid.' };
  if (!cardExpiryValid(expMonth, expYear)) return { ok: false, error: 'Card expiry is not valid.' };
  const cvcStr = String(cvc || '').trim();
  if (!/^\d{3,4}$/.test(cvcStr)) return { ok: false, error: 'Security code (CVC) must be 3 or 4 digits.' };
  const holder = String(name || '').trim();
  if (!holder) return { ok: false, error: 'Cardholder name is required.' };
  let year = Number(expYear);
  if (year < 100) year += 2000;
  return {
    ok: true,
    card: { name: holder, number: digits, expMonth: Number(expMonth), expYear: year, cvc: cvcStr }
  };
}

async function saveAgentCard(supabase, userId, rawCard) {
  const result = normaliseAgentCard(rawCard);
  if (!result.ok) return result;
  const { error } = await supabase.from('connectors').upsert({
    user_id: userId,
    connector_id: AGENT_CARD_CONNECTOR_ID,
    enabled: true,
    tokens: encryptTokens(result.card),
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,connector_id' });
  if (error) return { ok: false, error: error.message };
  return { ok: true, summary: agentCardSummary(result.card) };
}

/** Full decrypted card — server-internal use only (confirmPayment). Null when none stored. */
async function getAgentCard(supabase, userId) {
  const { data } = await supabase
    .from('connectors')
    .select('tokens, enabled')
    .eq('user_id', userId)
    .eq('connector_id', AGENT_CARD_CONNECTOR_ID)
    .maybeSingle();
  if (!data || !data.enabled) return null;
  const card = decryptTokens(data.tokens || {});
  if (!card || !card.number) return null;
  return card;
}

function agentCardSummary(card) {
  if (!card || !card.number) return null;
  return {
    brand: detectCardBrand(card.number),
    last4: String(card.number).slice(-4),
    expMonth: card.expMonth,
    expYear: card.expYear,
    name: card.name
  };
}

/** Masked view safe to return to clients. */
async function getAgentCardSummary(supabase, userId) {
  const card = await getAgentCard(supabase, userId);
  return agentCardSummary(card);
}

async function deleteAgentCard(supabase, userId) {
  await supabase
    .from('connectors')
    .delete()
    .eq('user_id', userId)
    .eq('connector_id', AGENT_CARD_CONNECTOR_ID);
}

module.exports = {
  AGENT_CARD_CONNECTOR_ID,
  luhnValid,
  detectCardBrand,
  cardExpiryValid,
  normaliseAgentCard,
  saveAgentCard,
  getAgentCard,
  agentCardSummary,
  getAgentCardSummary,
  deleteAgentCard
};
