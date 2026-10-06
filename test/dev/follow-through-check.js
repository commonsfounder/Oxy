'use strict';

// Live check (calls the real model, costs a few cents): when someone says the last answer
// missed what they asked for, does Adam search again instead of apologising?
//   node test/dev/follow-through-check.js [runs]      exits 1 if fewer than 9 in 10 search

require('dotenv').config();
const { callToolsBrain } = require('../../api/services/brain-provider');
const { buildToolsForGemini } = require('../../api/action-contracts');
const { buildSystemPrompt } = require('../../api/prompts');

const RUNS = Number(process.argv[2]) || 10;
const history = [
  ['user', 'something else on twitter maybe'],
  ['model', 'Try this search: https://x.com/search?q=%22funniest%20tweets%22&src=typed_query'],
  ['user', 'bro i asked for a specific tweet']
];
// The recent-results block is what pushes the model toward apologising instead of acting.
const context = {
  memory: '- Likes absurd sketch comedy', preferences: 'Direct, short replies.', connectedCapabilities: 'Gmail, Calendar',
  statedContext: [], dateStr: 'Tuesday 6 October 2026', timeStr: '01:48', autonomy: 'Reactive', guardMode: false,
  extraContext: 'LIVE USER CONTEXT:\nRecent action outcomes: web_search succeeded (query: funniest tweets site:x.com; found a search page, no individual tweet)'
};

(async () => {
  const systemInstruction = buildSystemPrompt({ surface: 'chat', context });
  let searched = 0;
  for (let i = 0; i < RUNS; i++) {
    const res = await callToolsBrain({
      contents: history.map(([role, text]) => ({ role, parts: [{ text }] })),
      config: { systemInstruction, temperature: 0.2, topP: 0.8, tools: buildToolsForGemini(false), toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }
    });
    const parts = res.candidates?.[0]?.content?.parts || [];
    const call = parts.find((p) => p.functionCall);
    if (call) searched++;
    else console.log('  no search:', parts.map((p) => p.text || '').join('').replace(/\s+/g, ' ').slice(0, 160));
  }
  console.log(`searched ${searched}/${RUNS}`);
  process.exit(searched >= Math.ceil(RUNS * 0.9) ? 0 : 1);
})().catch((error) => { console.error(error.message); process.exit(2); });
