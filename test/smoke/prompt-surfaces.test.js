// Phase 6 (2026-08-07): buildSystemPrompt({ surface, context }) is the one path that composes
// Millie's system prompt for all four surfaces. Before this, background runs (scheduled tasks,
// routines, resumed tasks) received ONLY the bare static prompt — no memory, no preferences, no
// connected capabilities, no active goals, no date/time — because buildMillieSystemPrompt's
// dedup guard collapsed `dynamicSystemPrompt: OXCY_SYSTEM_PROMPT` right back down to nothing
// extra. Briefings were generated under a completely separate "You are a personal assistant"
// persona instead of Millie's own voice.
//
// These tests pin: each surface receives the context it's supposed to; background/briefing do
// NOT receive chat-only instructions that make no sense outside a live turn (greeting handling,
// "the user leads the conversation", FAST TURN MODE); and the background/briefing call sites in
// api/index.js were actually rewired, not just capable of being rewired.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildSystemPrompt, MILLIE_VOICE_PROMPT, CORE_SYSTEM_PROMPT } = require('../../api/prompts');

function phrase(text) {
  return new RegExp(text.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
}

// ── buildSystemPrompt covers all four surfaces and defaults sanely ────────────────────────
test('buildSystemPrompt supports chat, quick, background, and briefing', () => {
  for (const surface of ['chat', 'quick', 'background', 'briefing']) {
    const prompt = buildSystemPrompt({ surface, context: {} });
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length > 0, `${surface} produced an empty prompt`);
  }
});

test('an unrecognised surface falls back to chat rather than throwing', () => {
  const fallback = buildSystemPrompt({ surface: 'nonsense', context: {} });
  const chat = buildSystemPrompt({ surface: 'chat', context: {} });
  assert.equal(fallback, chat);
});

// ── Background: receives real context it never got before ─────────────────────────────────
test('background surface renders memory, preferences, connected capabilities, live context (active goals/recent outcomes), and date/time', () => {
  const prompt = buildSystemPrompt({
    surface: 'background',
    context: {
      memory: 'User has a dog named Biscuit.',
      preferences: 'assistant_voice: warm',
      connectedCapabilities: 'google [Full API integration]',
      liveContext: 'LIVE USER CONTEXT:\nActive delegated goals: pending: watch flight prices to Lisbon\nRecent action outcomes: search_flights succeeded',
      dateStr: '2026-08-07',
      timeStr: '14:32'
    }
  });
  assert.match(prompt, /User has a dog named Biscuit\./);
  assert.match(prompt, /assistant_voice: warm/);
  assert.match(prompt, /google \[Full API integration\]/);
  assert.match(prompt, /watch flight prices to Lisbon/);
  assert.match(prompt, /search_flights succeeded/);
  assert.match(prompt, /Current date: 2026-08-07/);
  assert.match(prompt, /Current time for internal reasoning only: 14:32/);
});

test('background surface keeps identity, capabilities, working loop, truthfulness, and results sections', () => {
  const prompt = buildSystemPrompt({ surface: 'background', context: {} });
  assert.ok(prompt.startsWith(MILLIE_VOICE_PROMPT), 'background must open with the same voice as chat');
  for (const header of ['WHAT YOU CAN DO:', 'HOW YOU WORK:', 'TRUTHFULNESS & SAFETY:', 'WORKING WITH RESULTS:']) {
    assert.ok(prompt.includes(header), `background prompt missing ${header}`);
  }
});

test('background surface does NOT receive chat-only turn-taking instructions that make no sense unsupervised', () => {
  const prompt = buildSystemPrompt({ surface: 'background', context: {} });
  // These are chat RESPONSE RULES / COMMUNICATION_CRAFT_SECTION content — a live-conversation
  // framing that presumes a person is actively talking to Millie right now.
  assert.doesNotMatch(prompt, /For greetings or simple check-ins like "hi", "hey", or "ok"/);
  assert.doesNotMatch(prompt, /The user leads the conversation\. Follow their topic/);
  assert.doesNotMatch(prompt, /FAST TURN MODE/);
  assert.doesNotMatch(prompt, /COMMUNICATION CRAFT:/);
  // It gets its own tail instead, acknowledging there is no one to ask right now.
  assert.match(prompt, phrase('This is unsupervised background work, not a live conversation'));
});

test('background surface has its own repeat-avoidance instruction distinct from chat\'s', () => {
  const prompt = buildSystemPrompt({ surface: 'background', context: {} });
  assert.match(prompt, phrase('Do not repeat a step you already completed earlier in this run'));
});

// ── Briefing: routed through Millie's identity/voice, not a separate persona ───────────────
test('briefing surface opens with Millie\'s own voice, not a separate "You are a personal assistant" persona', () => {
  const prompt = buildSystemPrompt({ surface: 'briefing', context: {} });
  assert.ok(prompt.startsWith(MILLIE_VOICE_PROMPT));
  assert.doesNotMatch(prompt, /You are a personal assistant/);
});

test('briefing surface keeps truthfulness/anti-fabrication but not the tool-calling sections', () => {
  const prompt = buildSystemPrompt({ surface: 'briefing', context: {} });
  assert.ok(prompt.includes('TRUTHFULNESS & SAFETY:'));
  // No tools are attached to a briefing generation call — the working-loop/results/capabilities
  // sections describe tool-calling behaviour that has nothing to act on here.
  for (const header of ['WHAT YOU CAN DO:', 'HOW YOU WORK:', 'WORKING WITH RESULTS:', 'COMMUNICATION CRAFT:']) {
    assert.ok(!prompt.includes(header), `briefing prompt should not include ${header}`);
  }
});

test('briefing surface renders memory, preferences, history, native context, window label, word cap, and date/time', () => {
  const prompt = buildSystemPrompt({
    surface: 'briefing',
    context: {
      memory: 'Trains to Leeds most weekends.',
      preferences: 'assistant_name: Millie',
      historyText: 'user: how was the weather\nassistant: sunny all week',
      nativeContextText: 'Native context:\nLocation: 53.8, -1.5\nHealth: not available',
      windowLabel: 'Afternoon',
      maxWords: 70,
      dateStr: '2026-08-07',
      timeStr: '14:32'
    }
  });
  assert.match(prompt, /Trains to Leeds most weekends\./);
  assert.match(prompt, /assistant_name: Millie/);
  assert.match(prompt, /sunny all week/);
  assert.match(prompt, /53\.8, -1\.5/);
  assert.match(prompt, phrase('Write the Afternoon update'));
  assert.match(prompt, /under 70 words/);
  assert.match(prompt, /Current date: 2026-08-07/);
});

test('briefing surface still refuses to invent weather, plans, or events', () => {
  const prompt = buildSystemPrompt({ surface: 'briefing', context: {} });
  assert.match(prompt, phrase('do not invent weather, traffic, calendar events, health facts, plans, or news'));
});

// ── Quick: unchanged from before — full chat static prompt + FAST TURN MODE tail ───────────
test('quick surface still gets the full chat static prompt plus the FAST TURN MODE tail', () => {
  const prompt = buildSystemPrompt({ surface: 'quick', context: { preferences: '', statedContext: [] } });
  assert.ok(prompt.startsWith(CORE_SYSTEM_PROMPT));
  assert.match(prompt, /FAST TURN MODE:/);
});

// ── Wiring: the background call sites in api/index.js actually use buildBackgroundSystemPrompt,
// not a bare static prompt — the exact bug this phase fixes. Source-pattern check, matching the
// convention already used by test/smoke/preference-context-hygiene.test.js for source wiring. ──
test('runScheduledTasksForUser, the routine sweep, and the manual task-run endpoint all build a real background prompt', () => {
  const src = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');
  assert.doesNotMatch(src, /dynamicSystemPrompt:\s*CORE_SYSTEM_PROMPT/, 'a call site still passes the bare static prompt with no per-user context');
  assert.doesNotMatch(src, /dynamicSystemPrompt:\s*OXCY_SYSTEM_PROMPT/, 'the old export name should not still be referenced');

  const start = src.indexOf('async function buildBackgroundSystemPrompt(');
  assert.ok(start >= 0, 'buildBackgroundSystemPrompt not found');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /getMemory\(/);
  assert.match(body, /getPreferences\(/);
  assert.match(body, /getEnabledConnectors\(/);
  assert.match(body, /getUserContext\(/);
  assert.match(body, /surface:\s*'background'/);

  const callSites = [...src.matchAll(/buildBackgroundSystemPrompt\(/g)];
  const starterSrc = fs.readFileSync(require.resolve('../../api/services/delegated-run-starter.js'), 'utf8');
  assert.match(starterSrc, /buildSystemPrompt\(userId\)/, 'the shared durable-run starter must build the injected background prompt before launching');
  assert.ok(callSites.length >= 3, `expected buildBackgroundSystemPrompt to be defined once and called at least twice in index.js, found ${callSites.length} occurrences total`);
});

test('the briefing builders call buildSystemPrompt with surface briefing, not a hand-rolled persona string', () => {
  const src = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');
  assert.doesNotMatch(src, /You are a personal assistant/, 'the old separate briefing persona must be gone from executable code');

  for (const fnName of ['buildMorningBriefing', 'buildIntervalBriefing']) {
    const start = src.indexOf(`async function ${fnName}(`);
    assert.ok(start >= 0, `${fnName} not found`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.match(body, /surface:\s*'briefing'/, `${fnName} must route through buildSystemPrompt's briefing surface`);
  }
});
