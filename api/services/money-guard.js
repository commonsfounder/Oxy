// Hard server-side spend limits the model cannot talk its way past. This is defense-in-depth
// BEHIND the human review gate (action-runner routes high-risk/confirmation actions to
// setPendingAction): even if a spend reaches execution — an approved pending action, or any
// future path that sets bypassReview — an out-of-policy amount is refused here, deterministically,
// with no model in the loop. Caps are env-tunable but default conservative.
const DEFAULT_PER_TXN_USD = 100;
const DEFAULT_PER_DAY_USD = 500;

function positiveNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The caps are denominated in ONE currency; every amount must be expressed in it before the
// cap math runs. Default USD (what the concierge account is denominated in); ops can point the
// caps at GBP/EUR without touching amounts.
function capCurrency(env = process.env) {
  const raw = String(env.OXY_SPEND_CAP_CURRENCY || 'USD').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(raw) ? raw : 'USD';
}

// Static USD-per-1-unit FX table, env-overridable so this stays deterministic and unit-testable
// (no live FX call in a spend guard). Conservative, occasionally-refreshed rates — the guard is a
// safety cap, not an accounting ledger, so approximate is fine and erring high is the safe side.
// Codes mirror currency-from-location.js's regions (GBP/EUR/CAD/AUD/USD).
function fxTable(env = process.env) {
  return {
    USD: 1,
    GBP: positiveNum(env.OXY_FX_USD_PER_GBP, 1.27),
    EUR: positiveNum(env.OXY_FX_USD_PER_EUR, 1.08),
    CAD: positiveNum(env.OXY_FX_USD_PER_CAD, 0.73),
    AUD: positiveNum(env.OXY_FX_USD_PER_AUD, 0.66),
  };
}

// Detect an amount's currency from a price string's symbol or trailing ISO code. Returns null
// when there's nothing to go on — callers decide the fallback (the browser path assumes the
// home currency, which for a UK app is the stricter side of the cap).
function detectCurrency(text) {
  if (typeof text !== 'string') return null;
  if (text.includes('£')) return 'GBP';
  if (text.includes('€')) return 'EUR';
  if (text.includes('$')) return 'USD';
  const code = text.match(/\b(gbp|usd|eur|cad|aud)\b/i);
  return code ? code[1].toUpperCase() : null;
}

// Convert an amount between currencies via the USD base. Returns null (fail-closed) for a
// non-finite amount or any currency the table doesn't know, so an unconvertible spend is
// refused rather than silently compared in the wrong units. Rounded to cents to keep the
// "exactly the cap, not a penny over" boundary clean against float noise.
function convertAmount(amount, from, to, env = process.env) {
  const amt = Number(amount);
  if (!Number.isFinite(amt)) return null;
  const table = fxTable(env);
  const fromRate = table[String(from || '').toUpperCase()];
  const toRate = table[String(to || '').toUpperCase()];
  if (!fromRate || !toRate) return null;
  return Math.round((amt * fromRate / toRate) * 100) / 100;
}

// Resolve the active caps from env each call so tests and ops can override without a restart.
function spendLimits(env = process.env) {
  return {
    perTxn: positiveNum(env.OXY_MAX_SPEND_PER_TXN, DEFAULT_PER_TXN_USD),
    perDay: positiveNum(env.OXY_MAX_SPEND_PER_DAY, DEFAULT_PER_DAY_USD),
  };
}

// Pure and unit-testable. Given the requested amount and how much has already been spent in the
// current rolling day, decide if the spend is allowed. Returns { ok, error }. The caller owns
// reading/writing the daily tally (it lives in the user's preferences); this just does the math.
function checkSpendLimit({ amount, currency = null, spentToday = 0, limits = spendLimits(), env = process.env } = {}) {
  // When a currency is supplied, express the amount in the caps' currency before comparing.
  // Omitting currency keeps the historical behaviour: the amount is assumed already in cap
  // currency (spentToday is always stored that way by the guard). Unknown currency fails closed.
  let amt = Number(amount);
  if (currency) {
    const capCur = capCurrency(env);
    if (String(currency).toUpperCase() !== capCur) {
      const converted = convertAmount(amt, currency, capCur, env);
      if (converted === null) {
        return { ok: false, error: `Can't convert ${String(currency).toUpperCase()} into the ${capCur} spend cap — refusing to guess an exchange rate.` };
      }
      amt = converted;
    }
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    return { ok: false, error: 'Invalid amount.' };
  }
  if (amt > limits.perTxn) {
    return {
      ok: false,
      error: `Amount $${amt.toFixed(2)} exceeds the per-transaction cap of $${limits.perTxn.toFixed(2)}. Ask the user to confirm a higher OXY_MAX_SPEND_PER_TXN, or split the spend.`,
    };
  }
  const prior = Number.isFinite(Number(spentToday)) && Number(spentToday) > 0 ? Number(spentToday) : 0;
  if (prior + amt > limits.perDay) {
    return {
      ok: false,
      error: `This would bring today's concierge spend to $${(prior + amt).toFixed(2)}, over the daily cap of $${limits.perDay.toFixed(2)}. It won't go through automatically.`,
    };
  }
  return { ok: true };
}

module.exports = {
  checkSpendLimit,
  spendLimits,
  capCurrency,
  detectCurrency,
  convertAmount,
  DEFAULT_PER_TXN_USD,
  DEFAULT_PER_DAY_USD,
};
