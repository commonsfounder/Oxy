'use strict';

// call_business: Adam phones a business itself. Review-gated by its contract, so this runs only
// after the person approved the exact call (who, what for, what Adam may share).

const businessCalls = require('../services/business-calls');

function firstName(value) {
  let text = value;
  if (typeof text === 'string') {
    try { const parsed = JSON.parse(text); if (typeof parsed === 'string') text = parsed; } catch { /* plain text */ }
  }
  return String(text || '').trim().split(/\s+/)[0] || '';
}

async function callBusiness({ userId, params, context, deps }) {
  const { supabase, getPreferenceMap } = deps;
  const { getActiveHandle } = require('../services/adam-identity');
  const handle = await getActiveHandle(supabase, userId, 'phone_sms').catch(() => null);
  const fromNumber = handle?.handle_value || process.env.TWILIO_PHONE_NUMBER || null;
  const preferences = getPreferenceMap ? await getPreferenceMap(userId).catch(() => ({})) : {};
  const onBehalfOf = firstName(params?.on_behalf_of) || firstName(preferences['checkout_profile.name']);

  try {
    const { request } = await businessCalls.startCall({
      userId,
      input: params,
      fromNumber,
      baseUrl: process.env.APP_URL || context?.baseUrl || '',
      onBehalfOf
    });
    return {
      success: true,
      outcome: 'incomplete',
      text: `Calling ${request.businessName} now. I'll tell you what they say.`,
      cardText: `${request.businessName} · ${request.phone} · ${request.goal}`,
      actionSummary: 'Calling'
    };
  } catch (error) {
    return { success: false, error: error.message, code: error.code || 'call_failed' };
  }
}

module.exports = { handlers: { call_business: callBusiness } };
