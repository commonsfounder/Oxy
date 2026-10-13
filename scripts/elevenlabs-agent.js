#!/usr/bin/env node

// Creates the ElevenLabs agent Adam's business calls run on: phone audio (μ-law 8 kHz) both ways,
// end-call and voicemail tools, and per-call overrides allowed only for the brief, the opening line
// and the time limit. Run once, then set the printed id as ELEVENLABS_AGENT_ID.
//
//   ELEVENLABS_API_KEY=... node scripts/elevenlabs-agent.js [--voice <voice_id>] [--llm gpt-5.4-mini]

require('dotenv').config({ quiet: true });
const { createAgent, agentDefinition } = require('../api/services/call-engine-elevenlabs');

function option(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const options = { voiceId: option('--voice'), llm: option('--llm') || undefined };
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(agentDefinition(options), null, 2));
    return;
  }
  const agentId = await createAgent(options);
  console.log(`Created agent ${agentId}.`);
  console.log(`fly secrets set --app milgrain-live-2026 ELEVENLABS_AGENT_ID=${agentId} ELEVENLABS_API_KEY=<your key>`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
