// Shared daily-rolling-total spend guard for every path that can move concierge money OUT,
// wherever that path lives. Regression: api/index.js had its own local guardConciergeSpend
// (applying both the per-transaction AND rolling daily cap), but connectors/stripe.js — which
// handles spend_from_concierge_via_stripe and stripe_payout_to_user — only ever called
// checkSpendLimit with no spentToday, so those two actions enforced the per-transaction cap
// but NOT the daily one. Extracted here so every spend action shares one real guard instead
// of each call site reimplementing (or forgetting) the daily half.
const { checkSpendLimit } = require('./money-guard');

const SPEND_DAY_KEY = 'concierge_account.spend_day';

async function guardConciergeSpend(supabase, userId, amount) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const { data } = await supabase
    .from('preferences')
    .select('value')
    .eq('user_id', userId)
    .eq('key', SPEND_DAY_KEY);
  let tally = {};
  try { tally = JSON.parse(data?.[0]?.value || '{}'); } catch { tally = {}; }
  const spentToday = tally.date === today ? Number(tally.total) || 0 : 0;
  const verdict = checkSpendLimit({ amount, spentToday });
  if (!verdict.ok) return verdict;
  await supabase
    .from('preferences')
    .upsert({
      user_id: userId,
      key: SPEND_DAY_KEY,
      value: JSON.stringify({ date: today, total: spentToday + Number(amount) }),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,key' });
  return { ok: true };
}

module.exports = { guardConciergeSpend, SPEND_DAY_KEY };
