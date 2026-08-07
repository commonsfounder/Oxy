'use strict';
const axios = require('axios');

// Millie's phone number and SMS, via Twilio's plain REST API (Basic Auth,
// application/x-www-form-urlencoded) — no twilio npm SDK, matching this
// codebase's existing pattern of calling provider REST APIs directly with axios
// (see connectors/google.js). US numbers require A2P 10DLC brand+campaign
// registration with Twilio before carriers reliably deliver SMS — that is an
// account-level, non-code prerequisite; provisioning still creates and persists
// the number without it, but delivery may be filtered until registration
// completes. This file does not attempt to detect or manage that registration.

const MILLIE_SMS_SIGNATURE_LINE = '- Millie (assistant)';

function twilioAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not configured.');
  return { sid, token };
}

async function provisionPhoneNumber(userId) {
  const { sid, token } = twilioAuth();
  const countryCode = process.env.TWILIO_NUMBER_COUNTRY || 'GB';
  const search = await axios.get(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/${countryCode}/Local.json`,
    { auth: { username: sid, password: token }, params: { SmsEnabled: true, VoiceEnabled: true }, timeout: 15000 }
  );
  const candidate = search.data?.available_phone_numbers?.[0];
  if (!candidate) throw new Error(`No available phone numbers in ${countryCode} right now.`);

  const purchase = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`,
    new URLSearchParams({
      PhoneNumber: candidate.phone_number,
      SmsUrl: `${process.env.APP_URL || ''}/webhooks/millie-sms`,
      SmsMethod: 'POST'
    }),
    { auth: { username: sid, password: token }, timeout: 15000 }
  );
  return { phoneNumber: purchase.data.phone_number, providerRef: purchase.data.sid };
}

async function sendMillieSms({ from, to, body }) {
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

module.exports = { provisionPhoneNumber, sendMillieSms, parseInboundSmsPayload, MILLIE_SMS_SIGNATURE_LINE };
