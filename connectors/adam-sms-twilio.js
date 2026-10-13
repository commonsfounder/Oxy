'use strict';
const axios = require('axios');

// Adam's phone number and SMS over Twilio's plain REST API, no SDK, like the other connectors
// here. US numbers need A2P 10DLC registration before carriers deliver reliably — an
// account-level prerequisite this file neither detects nor manages; provisioning works without it.

const MILLIE_SMS_SIGNATURE_LINE = '- Adam (assistant)';

function twilioAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not configured.');
  return { sid, token };
}

// Mobile, not Local: UK local numbers need documentary UK proof of address, mobile numbers
// only need government ID, and mobile is also the type businesses and forms accept.
const NUMBER_TYPES = { mobile: 'Mobile', local: 'Local', tollfree: 'TollFree' };

function numberType() {
  const key = String(process.env.TWILIO_NUMBER_TYPE || 'mobile').trim().toLowerCase().replace(/[^a-z]/g, '');
  const type = NUMBER_TYPES[key];
  if (!type) throw new Error(`TWILIO_NUMBER_TYPE must be one of: ${Object.keys(NUMBER_TYPES).join(', ')}.`);
  return type;
}

async function provisionPhoneNumber(userId) {
  const { sid, token } = twilioAuth();
  const countryCode = (process.env.TWILIO_NUMBER_COUNTRY || 'GB').trim().toUpperCase();
  const type = numberType();
  // Every UK number must sit on an approved Regulatory Compliance bundle before Twilio will
  // sell it. Failing here names the fix; letting the purchase fail would buy nothing and say less.
  const bundleSid = (process.env.TWILIO_BUNDLE_SID || '').trim();
  if (countryCode === 'GB' && !bundleSid) {
    throw new Error('UK numbers need an approved Twilio Regulatory Compliance bundle. Set TWILIO_BUNDLE_SID.');
  }
  const appUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!appUrl) throw new Error('APP_URL is not configured, so the number would have nowhere to deliver replies.');

  const search = await axios.get(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/${countryCode}/${type}.json`,
    { auth: { username: sid, password: token }, params: { SmsEnabled: true, VoiceEnabled: true }, timeout: 15000 }
  );
  const candidate = search.data?.available_phone_numbers?.[0];
  if (!candidate) throw new Error(`No available ${type.toLowerCase()} numbers in ${countryCode} right now.`);

  const purchase = new URLSearchParams({
    PhoneNumber: candidate.phone_number,
    SmsUrl: `${appUrl}/webhooks/millie-sms`,
    SmsMethod: 'POST'
  });
  if (bundleSid) purchase.set('BundleSid', bundleSid);
  const addressSid = (process.env.TWILIO_ADDRESS_SID || '').trim();
  if (addressSid) purchase.set('AddressSid', addressSid);

  const purchased = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`,
    purchase,
    { auth: { username: sid, password: token }, timeout: 15000 }
  );
  return { phoneNumber: purchased.data.phone_number, providerRef: purchased.data.sid };
}

async function sendAdamSms({ from, to, body }) {
  const { sid, token } = twilioAuth();
  const text = `${body}\n${MILLIE_SMS_SIGNATURE_LINE}`;
  const response = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    new URLSearchParams({ From: from, To: to, Body: text }),
    { auth: { username: sid, password: token }, timeout: 15000 }
  );
  return { providerMessageId: response.data?.sid || null };
}

function parseInboundSmsPayload(payload) {
  const data = payload || {};
  if (!data.From) return null;
  return {
    fromAddress: String(data.From).trim(),
    toAddress: String(data.To || '').trim(),
    subject: '',
    body: String(data.Body || ''),
    providerMessageId: data.MessageSid || null,
    inReplyTo: null,
    references: null
  };
}

module.exports = { provisionPhoneNumber, sendAdamSms, parseInboundSmsPayload, MILLIE_SMS_SIGNATURE_LINE };
