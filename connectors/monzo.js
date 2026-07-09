const axios = require('axios');
const { createSupabaseServiceClient } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();

const SUPPORTED_ACTIONS = ['check_monzo_balance', 'get_monzo_transactions', 'transfer_to_concierge_account'];

async function getMonzoToken(userId) {
  try {
    const { data } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'monzo')
      .eq('enabled', true)
      .limit(1);
    if (data?.length > 0 && data[0].tokens) {
      const tokens = decryptTokens(data[0].tokens);
      return tokens.access_token;
    }
  } catch (e) {}
  return process.env.MONZO_ACCESS_TOKEN || null;
}

async function execute(userId, action, params) {
  const token = await getMonzoToken(userId);
  if (!token) {
    return { success: true, text: `Monzo ${action} - connect your Monzo account (env MONZO_ACCESS_TOKEN or connector) for real banking.`, webLink: 'https://monzo.com' };
  }

  const headers = { Authorization: `Bearer ${token}` };

  try {
    if (action === 'check_monzo_balance') {
      const accountId = params.account_id || (await axios.get('https://api.monzo.com/accounts', { headers })).data.accounts[0]?.id;
      const res = await axios.get(`https://api.monzo.com/balance?account_id=${accountId}`, { headers });
      const bal = (res.data.balance / 100).toFixed(2);
      return { success: true, text: `Monzo balance: £${bal}`, balance: res.data.balance / 100 };
    }

    if (action === 'get_monzo_transactions') {
      const accountId = params.account_id || (await axios.get('https://api.monzo.com/accounts', { headers })).data.accounts[0]?.id;
      const res = await axios.get(`https://api.monzo.com/transactions?account_id=${accountId}&limit=5`, { headers });
      const txs = res.data.transactions.map(t => `${t.description}: £${(t.amount / 100).toFixed(2)}`).join('; ');
      return { success: true, text: `Recent Monzo transactions: ${txs}` };
    }

    if (action === 'transfer_to_concierge_account') {
      // Regression: this claimed "Transferred £X to concierge account (synced from Monzo)"
      // without ever calling a real Monzo money-movement endpoint — Monzo has no API for
      // transferring into a virtual/third-party account, so this only ever inflated the
      // virtual concierge balance while implying real money had moved out of the user's real
      // account. Fixed to (a) verify the real Monzo balance actually covers the amount, so the
      // credit is at least grounded in a real, checked balance, and (b) say plainly that this
      // is a tracked ledger entry, not a real transfer.
      const amount = Number(params.amount || 10);
      const accountId = params.account_id || (await axios.get('https://api.monzo.com/accounts', { headers })).data.accounts[0]?.id;
      const res = await axios.get(`https://api.monzo.com/balance?account_id=${accountId}`, { headers });
      const monzoBalance = res.data.balance / 100;
      if (monzoBalance < amount) {
        return { success: false, error: `Your Monzo balance (£${monzoBalance.toFixed(2)}) is less than £${amount.toFixed(2)} — nothing was credited.` };
      }
      const prefs = await supabase.from('preferences').select('value').eq('user_id', userId).eq('key', 'concierge_account.balance').single();
      let balance = Number(prefs.data?.value || 0);
      balance += amount;
      await supabase.from('preferences').upsert({ user_id: userId, key: 'concierge_account.balance', value: balance });
      return { success: true, text: `Noted £${amount.toFixed(2)} against your concierge balance — Monzo has no API for a real transfer into a virtual account, so no money actually moved out of your Monzo account. This only updates the tracked balance here (verified you had at least that much in Monzo: £${monzoBalance.toFixed(2)}). New virtual balance: £${balance.toFixed(2)}`, amount, balance };
    }

    return { success: false, error: 'Unknown Monzo action' };
  } catch (e) {
    return { success: false, error: `Monzo error: ${e.response?.data?.message || e.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };