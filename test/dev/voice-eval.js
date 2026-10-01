'use strict';
// Voice check: runs a fixed set of everyday messages through Adam's real instructions and model and
// prints the replies, so a change to the voice is judged on what it actually says, not on adjectives.
// Calls the real provider (costs a few cents); not part of npm test.
//
//   node test/dev/voice-eval.js              # current prompt
//   node test/dev/voice-eval.js --label=after > /tmp/after.txt

const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const promptsArg = process.argv.find(a => a.startsWith('--prompts='));
const { buildSystemPrompt } = require(promptsArg ? path.resolve(promptsArg.split('=')[1]) : '../../api/prompts');
const { generateBrain } = require('../../api/services/brain-provider');
const { resolveModelRoute } = require('../../api/services/model-routing');

const MEMORY = [
  'Name is Chizi. Lives with flatmate Arina, who only drinks oat milk.',
  'Likes the gym on weekday mornings; skips it when tired and feels bad about it.',
  'Working on a startup called Adam; stressed about launch, does not like being told to relax.',
  'Dislikes small talk on the phone. Loves a good deal.'
].join(' ');

const CASES = [
  { id: 'thanks',        say: 'thanks!' },
  { id: 'ok',            say: 'ok' },
  { id: 'lol',           say: 'lol that is actually so true' },
  { id: 'done-booking',  say: 'did the haircut get booked?', ctx: 'Result just now: booked Saturday 10:30 at Nash & Co, £28, confirmed by email.' },
  { id: 'bad-news',      say: 'did the train get booked', ctx: 'Result just now: the 10:14 to Manchester sold out while checking out. Cheapest alternative is 11:14 at £38, 2h08.' },
  { id: 'tonight',       say: 'what should i do tonight' },
  { id: 'late',          say: "can't sleep. brain won't stop", time: '01:12' },
  { id: 'bad-day',       say: 'today was a nightmare honestly' },
  { id: 'milk',          say: 'get milk please', ctx: 'Tool available: add_to_basket. Nothing in the basket yet.' },
  { id: 'opinion',       say: 'should i bother going to the gym or just work' },
  // Held out: never used while tuning the prompt, so they show whether a change generalises.
  { id: 'H-meeting',     say: 'ugh that meeting could have been an email' },
  { id: 'H-phone',       say: 'is it worth upgrading my phone this year' },
  { id: 'H-electrician', say: 'is the electrician sorted?', ctx: 'Result just now: electrician booked Wednesday between 8 and 12, £85 call-out, he will text 30 minutes before arriving.' },
  { id: 'H-bored',       say: "i'm bored" },
  { id: 'H-sunday',      say: 'sorry for the late reply, been a weird week', time: '22:30' }
];

async function main() {
  const label = (process.argv.find(a => a.startsWith('--label=')) || '--label=current').split('=')[1];
  const route = resolveModelRoute({});
  const system = buildSystemPrompt({
    surface: 'chat',
    context: { memory: MEMORY, preferences: 'Short, direct.', connectedCapabilities: 'none', dateStr: 'Friday 2 October 2026', timeStr: '19:40' }
  });
  console.log(`# voice eval · ${label} · ${route.provider}/${route.model}\n`);
  for (const c of CASES) {
    const sys = system + (c.time ? `\n\nCurrent time for this turn: ${c.time}` : '') + (c.ctx ? `\n\n${c.ctx}` : '');
    const res = await generateBrain({
      provider: route.provider,
      model: route.model,
      contents: [{ role: 'user', parts: [{ text: c.say }] }],
      config: { systemInstruction: sys, maxOutputTokens: 400 }
    });
    console.log(`you:  ${c.say}\nadam: ${String(res.text || '').trim()}\n`);
  }
}

main().catch(err => { console.error('eval failed:', err.message); process.exit(1); });
