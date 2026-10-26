'use strict';

// Tries Exa on a handful of real questions, straight from this machine, and prints each answer with
// what it cost (Exa's own fee plus Luna writing it up). Needs EXA_API_KEY and OPENAI_API_KEY in .env.
//
//   node test/dev/exa-trial.js

require('dotenv').config();
process.env.OXY_USAGE_LOG = 'off';
const { exaSearch, answerPrompt } = require('../../api/services/search-provider');
const { generateBrain } = require('../../api/services/brain-provider');
const usageMeter = require('../../api/services/usage-meter');
const { getLocalDateKey } = require('../../api/lib/time');

const QUESTIONS = [
  'tallest building in Manchester height',
  'Apple Store Birmingham opening hours Saturday',
  'Selfridges Birmingham opening hours Saturday',
  'Rotten Tomatoes score Wonka 2023',
  'cheapest 1.7 litre kettle John Lewis',
  'Birmingham New Street to Manchester Piccadilly trains Monday morning latest before 9:30',
];

(async () => {
  if (!process.env.EXA_API_KEY) { console.error('Add EXA_API_KEY to .env first.'); process.exit(1); }
  let total = 0;
  for (const question of QUESTIONS) {
    const turn = await usageMeter.runWithMeter(async (meter) => {
      const t0 = Date.now();
      const results = await exaSearch(question);
      const response = await generateBrain({ provider: 'openai', model: 'gpt-6-luna', contents: [{ role: 'user', parts: [{ text: answerPrompt({ question, today: getLocalDateKey(), results }) }] }], config: { reasoningEffort: 'low' } });
      return { ms: Date.now() - t0, results: results.length, text: String(response.text || '').replace(/\s+/g, ' ').slice(0, 320), usd: meter.estimatedUsd };
    });
    total += turn.usd;
    console.log(`\n## ${question}\n${turn.ms}ms, ${turn.results} sources, ~$${turn.usd.toFixed(4)}\n${turn.text}`);
  }
  console.log(`\nTotal for ${QUESTIONS.length} searches: ~$${total.toFixed(4)} (about $${(total / QUESTIONS.length).toFixed(4)} each; OpenAI web search is about $0.012 each).`);
  process.exit(0);
})();
