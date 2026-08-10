'use strict';

// The provider seam for Millie's phone identity.
//
// Every call site that used to `require('./millie-sms-twilio')` directly goes through
// here instead, so the choice of telecom vendor is one registration away from being
// swapped. That choice is not settled: Twilio is where we provision first because it is
// the only provider confirmed to sell UK *mobile* (+447) numbers to an individual with
// no UK proof-of-address, but it is also the most expensive per number, and Telnyx is a
// live candidate pending written confirmation of UK mobile inventory. See
// docs/superpowers/specs/2026-08-10-capability-classes-and-communication-identity-audit.md.
//
// The important asymmetry this file encodes: PROVISIONING follows the currently-active
// provider, but SENDING follows the provider that issued the number being sent from.
// A number bought on Twilio keeps being driven by Twilio even after MILLIE_PHONE_PROVIDER
// flips to something else — otherwise switching vendors would silently orphan every
// number already in the field. That is why millie_identity_handles.provider is written
// from the provisioning result rather than hardcoded, and read back on every send.

const providers = new Map();

// An adapter must supply all four:
//   provisionPhoneNumber(userId) -> { phoneNumber, providerRef }
//   sendSms({ from, to, body })  -> { providerMessageId }
//   parseInboundSms(payload)     -> normalized event | null
//   inboundAck()                 -> { contentType, body }
function registerProvider(name, implementation) {
  providers.set(String(name).trim().toLowerCase(), implementation);
}

function activeProviderName() {
  return String(process.env.MILLIE_PHONE_PROVIDER || 'twilio').trim().toLowerCase();
}

function getProvider(name) {
  const key = String(name || activeProviderName()).trim().toLowerCase();
  const implementation = providers.get(key);
  if (!implementation) {
    throw new Error(
      `Unknown phone provider "${key}". Set MILLIE_PHONE_PROVIDER to one of: ${[...providers.keys()].join(', ')}.`
    );
  }
  return implementation;
}

async function provisionPhoneNumber(userId) {
  const name = activeProviderName();
  const result = await getProvider(name).provisionPhoneNumber(userId);
  // Stamped so the handle row records who owns this number, not who happens to be
  // configured at the moment it is later used.
  return { ...result, provider: name };
}

async function sendSms({ from, to, body, provider }) {
  return getProvider(provider).sendSms({ from, to, body });
}

function parseInboundSms(payload, provider) {
  return getProvider(provider).parseInboundSms(payload);
}

function inboundAck(provider) {
  return getProvider(provider).inboundAck();
}

// --- Built-in adapters ---------------------------------------------------------
// Twilio's connector keeps its own export names; the adapter shape is applied here so
// the existing module (and its tests) stay untouched.

const twilio = require('./millie-sms-twilio');

registerProvider('twilio', {
  provisionPhoneNumber: (userId) => twilio.provisionPhoneNumber(userId),
  sendSms: ({ from, to, body }) => twilio.sendMillieSms({ from, to, body }),
  parseInboundSms: (payload) => twilio.parseInboundSmsPayload(payload),
  // Twilio expects TwiML or an empty 200 on the inbound webhook. That is a Twilio
  // quirk, so it lives with the Twilio adapter rather than in the shared route.
  inboundAck: () => ({ contentType: 'text/xml', body: '<Response></Response>' })
});

module.exports = {
  registerProvider,
  getProvider,
  activeProviderName,
  provisionPhoneNumber,
  sendSms,
  parseInboundSms,
  inboundAck
};
