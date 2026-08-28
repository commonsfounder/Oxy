// The one spend guard for every path that moves concierge money out, applying both the
// per-transaction and the rolling daily cap — call sites that reimplement it forget the daily half.
const { checkSpendLimit, capCurrency, convertAmount } = require('./money-guard');

const SPEND_DAY_KEY = 'concierge_account.spend_day';

// `currency` is what `amount` is expressed in, normalized to the cap currency before the cap
// math and before the rolling tally, so the daily total stays single-currency. Omitted, the
// amount is treated as already in the cap currency. `record: false` checks without consuming
// budget — reaching a payment step is not spending, and aborted attempts must not eat the cap.
async function guardConciergeSpend(supabase, userId, amount, currency = null, { record = true } = {}) {
  const capCur = capCurrency();
  const normalized = convertAmount(amount, currency || capCur, capCur);
  if (normalized === null) {
    return { ok: false, error: `Can't convert ${String(currency || capCur).toUpperCase()} into the ${capCur} spend cap — refusing to guess an exchange rate.` };
  }
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const { data } = await supabase
    .from('preferences')
    .select('value')
    .eq('user_id', userId)
    .eq('key', SPEND_DAY_KEY);
  let tally = {};
  try { tally = JSON.parse(data?.[0]?.value || '{}'); } catch { tally = {}; }
  const spentToday = tally.date === today ? Number(tally.total) || 0 : 0;
  const verdict = checkSpendLimit({ amount: normalized, spentToday });
  if (!verdict.ok) return verdict;
  if (!record) return { ok: true };
  await supabase
    .from('preferences')
    .upsert({
      user_id: userId,
      key: SPEND_DAY_KEY,
      value: JSON.stringify({ date: today, total: Math.round((spentToday + normalized) * 100) / 100 }),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,key' });
  return { ok: true };
}

module.exports = { guardConciergeSpend, SPEND_DAY_KEY };
