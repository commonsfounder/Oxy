#!/usr/bin/env node

// One-time setup for Adam's business calls. Needs an ElevenLabs API key and a Twilio number (its
// account SID and auth token); after this, Adam only ever talks to ElevenLabs.
//
//   ELEVENLABS_API_KEY=... TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... \
//     node scripts/setup-calls.js --number +447700900000 [--app-url https://milgrain-live-2026.fly.dev] [--voice <voice_id>] [--apply]
//
// Creates the agent (phone audio, hang-up/voicemail/transfer tools, the callback webhook), imports the
// number into ElevenLabs, points it at the agent, and prints the Fly secrets. --apply sets them with
// `fly secrets set` (needs flyctl logged in).

require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createAgent, importTwilioNumber } = require('../api/services/call-engine-elevenlabs');
const { normalizeCallNumber } = require('../api/services/business-call');

function option(name, fallback) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function main() {
  const missing = ['ELEVENLABS_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'].filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} first.`);
  const number = normalizeCallNumber(option('--number', process.env.TWILIO_PHONE_NUMBER));
  const appUrl = option('--app-url', process.env.APP_URL || 'https://milgrain-live-2026.fly.dev').replace(/\/+$/, '');
  const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex');

  const agentId = await createAgent({
    voiceId: option('--voice'),
    webhookUrl: `${appUrl}/webhooks/calls/elevenlabs-inbound`,
    webhookSecret
  });
  console.log(`Agent created: ${agentId}`);
  const phoneNumberId = await importTwilioNumber({
    phoneNumber: number, sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN, agentId
  });
  console.log(`Number ${number} imported and linked: ${phoneNumberId}`);

  const secrets = {
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID: agentId,
    ELEVENLABS_PHONE_NUMBER_ID: phoneNumberId,
    ELEVENLABS_WEBHOOK_SECRET: webhookSecret
  };
  const pairs = Object.entries(secrets).map(([key, value]) => `${key}=${value}`);
  if (process.argv.includes('--apply')) {
    execFileSync('fly', ['secrets', 'set', '--app', option('--fly-app', 'milgrain-live-2026'), ...pairs], { stdio: 'inherit' });
    console.log('Fly secrets set. The next deploy picks them up.');
  } else {
    console.log(`\nfly secrets set --app milgrain-live-2026 ${pairs.map(p => p.replace(/=(.*)$/, (_, v) => `='${v}'`)).join(' ')}`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
