'use strict';
// Scene check: asks the real model, with the real show_scene instructions, to make a page for a
// few everyday requests, then validates it and writes each page to disk so it can be looked at.
// Calls the real provider (costs a few cents); not part of npm test.
//
//   node test/dev/scene-eval.js [outDir]

const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const { generateBrain } = require('../../api/services/brain-provider');
const { resolveModelRoute } = require('../../api/services/model-routing');
const { getActionContract } = require('../../api/action-contracts');
const sceneRuntime = require('../../api/services/scene-runtime');

const CASES = [
  { id: 'radiator', say: "Explain how to bleed a radiator. I'll be watching the screen from across the room while I do it." },
  { id: 'trains', say: 'Compare the 10:14 (£54, 2h08, direct) and the 11:14 (£38, 2h40, one change) to Manchester so I can pick.' },
  { id: 'dinner', say: "Plan the timings for a roast for six people eating at 7pm: chicken (2h), potatoes (1h15), veg (20 min), gravy." }
];

async function main() {
  const out = process.argv[2] || path.join(__dirname, '..', '..', 'tmp-scenes');
  fs.mkdirSync(out, { recursive: true });
  const contract = getActionContract('show_scene');
  const route = resolveModelRoute({});
  const system = [
    'You are Adam. When someone wants something to look at or tap through, you write one small web page.',
    `Tool: show_scene. ${contract.guidance}`,
    `scene: ${contract.paramHints.scene}`,
    'Reply with ONLY the JSON object for scene. No markdown fences, no commentary.'
  ].join('\n\n');
  console.log(`# scene eval · ${route.provider}/${route.model}`);
  for (const c of CASES) {
    const contents = [{ role: 'user', parts: [{ text: c.say }] }];
    let html = '';
    let verdict = 'accepted';
    let doc = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await generateBrain({
        provider: route.provider,
        model: route.model,
        contents,
        config: { systemInstruction: system, maxOutputTokens: 12000 }
      });
      html = String(res.text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      try {
        doc = sceneRuntime.buildSpecDocument(html);
        verdict = attempt ? `accepted after ${attempt} retry` : 'accepted';
        break;
      } catch (e) {
        verdict = 'REFUSED: ' + e.message;
        contents.push({ role: 'model', parts: [{ text: html }] }, { role: 'user', parts: [{ text: `That was refused: ${e.message} Send the corrected JSON only.` }] });
      }
    }
    if (doc) fs.writeFileSync(path.join(out, c.id + '.html'), doc);
    fs.writeFileSync(path.join(out, c.id + '.raw.json'), html);
    console.log(`${c.id}: ${html.length} chars, ${verdict}`);
  }
}

main().catch(err => { console.error('eval failed:', err.message); process.exit(1); });
