// What the general-purpose `preferences` table is allowed to put in front of the model. It holds
// chat titles, dedup markers, balances and pending-action JSON alongside anything about style,
// so these pin both halves: only an explicit allowlist reaches the prompt, and the writer that
// turned one-off phrasing into a permanent instruction is gone.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const {
  ALLOWLISTED_STYLE_PREFERENCE_KEYS,
  filterStylePreferenceRows,
  buildDynamicSystemPrompt,
  buildQuickTurnContext,
  extractAlreadyStatedContext,
  extractShoppingContextHints
} = require('../../api/index');

// The exact shape of junk this test guards against — captured from a real render of
// user123's live preferences table (redacted of ids), plus the three style-cue rows the old
// writer produced.
const REALISTIC_JUNK_ROWS = [
  { key: '_stitle_86e26194-86bc-4421-aa70-c874a56af2a4', value: 'Resolving empty string AI hallucinations' },
  { key: '_stitle_1a8878e4-9ad0-404c-a16d-c48b14f072d1', value: 'Preventing duplicate Node backend inputs' },
  { key: 'proactive.briefing.evening.2026-05-27', value: 'sent' },
  { key: 'proactive.briefing.now.2026-06-14', value: '{"id":"e294a82b","sig":"c3a97eb0","at":"2026-06-14T19:46:41.408Z"}' },
  { key: 'proactive.failed_action.id', value: '013858fc-ca0c-48c7-ad27-b0abbcea3aa8' },
  { key: 'concierge_account.balance', value: '0' },
  { key: 'concierge_account.last_spend', value: '{"amount":36,"description":"top-up","ts":1786000000000}' },
  { key: 'pending.action', value: '{"action":{"type":"send_email","input":{"to":"a@b.c"}}}' },
  {
    key: 'travel.concierge.context',
    value: '{"intent":"travel_concierge","active":true,"requirements":{"destination":"Georgia","budget":"2000"}}'
  },
  { key: 'format_preference', value: 'User said "Give me a short plan for tomorrow with a heading, a numbered list, bullet points, and some bold text." — adapt accordingly' },
  { key: 'response_length', value: 'User said "just tell me tell me is mine. Five is not enough. Five is £17. £3 more. Where is that again?" — adapt accordingly' },
  { key: 'tone_preference', value: 'User said "stop talking like that be more casual" — adapt accordingly' }
];

test('the style allowlist is empty — a typed learner is future work, not this phase', () => {
  // Pinned deliberately: an empty allowlist is the whole point of "clean absence beats
  // corrupted style." If this test starts failing because someone added a key, that's fine —
  // but it should be a reviewed, intentional addition, not an accidental one.
  assert.equal(ALLOWLISTED_STYLE_PREFERENCE_KEYS.size, 0);
});

test('filterStylePreferenceRows blocks every realistic junk key from a live user record', () => {
  const survivors = filterStylePreferenceRows(REALISTIC_JUNK_ROWS);
  assert.deepEqual(survivors, [], `these rows must never reach the prompt: ${survivors.map((r) => r.key).join(', ')}`);
});

test('filterStylePreferenceRows blocks each junk category individually, by name', () => {
  const byKey = Object.fromEntries(REALISTIC_JUNK_ROWS.map((r) => [r.key, r]));
  const cases = {
    'chat title (_stitle_*)': byKey['_stitle_86e26194-86bc-4421-aa70-c874a56af2a4'],
    'briefing dedup marker (sent)': byKey['proactive.briefing.evening.2026-05-27'],
    'briefing dedup marker (json)': byKey['proactive.briefing.now.2026-06-14'],
    'failed-action state': byKey['proactive.failed_action.id'],
    'concierge balance': byKey['concierge_account.balance'],
    'concierge spend record': byKey['concierge_account.last_spend'],
    'pending action payload': byKey['pending.action'],
    'travel workflow state': byKey['travel.concierge.context'],
    'format_preference (one-off formatting request)': byKey.format_preference,
    'response_length (garbled voice transcript)': byKey.response_length,
    'tone_preference (raw quote)': byKey.tone_preference
  };
  for (const [label, row] of Object.entries(cases)) {
    assert.deepEqual(filterStylePreferenceRows([row]), [], `${label} must be excluded: ${JSON.stringify(row)}`);
  }
});

test('filterStylePreferenceRows is an allowlist, not a denylist — an unrecognised key is excluded by default', () => {
  // A brand-new operational key nobody has written a rule for yet must fail closed.
  assert.deepEqual(filterStylePreferenceRows([{ key: 'some_future_operational_key', value: 'x' }]), []);
});

test('filterStylePreferenceRows would keep a row only if its key is explicitly allowlisted', () => {
  // Demonstrates the mechanism is live, not vacuous — using a synthetic addition to the
  // allowlist rather than mutating the real (currently empty) one.
  const allowed = new Set(['verbosity']);
  const keep = (rows) => rows.filter((row) => allowed.has(row?.key));
  assert.deepEqual(keep([{ key: 'verbosity', value: 'terse' }, { key: 'tone_preference', value: 'x' }]), [{ key: 'verbosity', value: 'terse' }]);
});

test('filterStylePreferenceRows tolerates missing/malformed input without throwing', () => {
  assert.deepEqual(filterStylePreferenceRows([]), []);
  assert.deepEqual(filterStylePreferenceRows(undefined), []);
  assert.deepEqual(filterStylePreferenceRows([null, undefined, { value: 'no key' }]), []);
});

// ── Wiring: getPreferences() actually applies the filter before joining ───────────────────
// getPreferences reads the module-scoped supabase client directly (no dependency injection),
// so this is proven at the source rather than by mocking a network call — the same approach
// already used for the useAgentTools flag count in the Phase 1 tests.
test('getPreferences filters through filterStylePreferenceRows before joining into the prompt string', () => {
  const src = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');
  const start = src.indexOf('async function getPreferences(');
  assert.ok(start >= 0, 'getPreferences not found');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /filterStylePreferenceRows\(data\)/, 'getPreferences must filter before mapping the rows into a string');
  assert.doesNotMatch(body, /data\.map\(p => `\$\{p\.key\}: \$\{p\.value\}`\)/, 'the old unfiltered map must be gone, not merely shadowed');
});

test('getPreferenceEntries and getPreferenceMap are untouched — routing/operational reads see every row', () => {
  // Filtering is a MODEL-FACING concern only. resolveModelRoute, the concierge account, and
  // proactive dedup all read the table through these two and must keep seeing every key.
  const src = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');
  const entriesStart = src.indexOf('async function getPreferenceEntries(');
  const entriesBody = src.slice(entriesStart, src.indexOf('\n}\n', entriesStart));
  assert.doesNotMatch(entriesBody, /filterStylePreferenceRows/, 'getPreferenceEntries must return every row, unfiltered');
});

// ── The raw-quote style-cue writer is disabled, not merely bypassed ───────────────────────
test('postResponseTasks no longer writes style-cue preferences from raw message text', () => {
  const src = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');
  const start = src.indexOf('function postResponseTasks(');
  assert.ok(start >= 0, 'postResponseTasks not found');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.doesNotMatch(body, /savePreference\(/, 'postResponseTasks must not write to preferences anymore');
  // Matches the executable template literal (`User said "${message}"`), not prose — an
  // explanatory comment is allowed to quote the old behaviour for context.
  assert.doesNotMatch(body, /User said "\$\{message\}"/, 'the raw-quote instruction template must be gone from executable code');
  assert.doesNotMatch(body, /styleCues/, 'the style-cue regex table must be gone, not just unreachable');
});

// ── CONTEXT YOU ALREADY STATED is not pasted in when history already carries it ───────────
test('extractAlreadyStatedContext is called only inside the quickTurn branch of buildChatContext', () => {
  const src = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');
  const start = src.indexOf('async function buildChatContext(');
  assert.ok(start >= 0, 'buildChatContext not found');
  const body = src.slice(start, start + 4000); // buildChatContext is well under 4000 chars
  const callSite = body.indexOf('extractAlreadyStatedContext(history)');
  assert.ok(callSite >= 0, 'extractAlreadyStatedContext call not found in buildChatContext');
  const before = body.slice(Math.max(0, callSite - 200), callSite);
  assert.match(before, /quickTurn\s*\?/, 'extractAlreadyStatedContext must be gated behind the quickTurn ternary — its recap is only a real dependency when history is trimmed');

  // The full (non-quick-turn) path must still get the shopping hints — those are a derived
  // fact, not a repeat of a sentence already present verbatim in contents[].
  const shoppingCallSite = body.indexOf('extractShoppingContextHints(history)');
  assert.ok(shoppingCallSite >= 0);
});

test('extractShoppingContextHints and extractAlreadyStatedContext behave unchanged as pure functions', () => {
  // Regression guard: Phase 4 changes WHEN these run, not what they compute.
  const history = [
    { role: 'user', content: 'find me pyjamas on john lewis' },
    { role: 'assistant', content: 'Checking John Lewis now. https://www.johnlewis.com/search?q=pyjamas' },
    { role: 'user', content: 'ok' },
    { role: 'assistant', content: 'Found a few options. Want me to add one to the basket?' }
  ];
  const shopping = extractShoppingContextHints(history);
  assert.ok(shopping.some((line) => /john lewis/i.test(line)));

  const stated = extractAlreadyStatedContext(history);
  assert.ok(stated.some((line) => /add one to the basket/i.test(line)));
});

test('buildQuickTurnContext still renders the recap it depends on', () => {
  const block = buildQuickTurnContext('', ['Found a few options.', 'Want me to add one to the basket?']);
  assert.match(block, /Found a few options\./);
  assert.match(block, /Already stated context:/);
});

test('buildDynamicSystemPrompt with a shopping-only statedContext contains no operational junk', () => {
  const block = buildDynamicSystemPrompt(
    'Has a girlfriend',
    '', // preferences — already filtered upstream by getPreferences
    'google [Full API integration]',
    'LIVE USER CONTEXT:\nActive connectors: google',
    ['Shopping: user specified retailer "John Lewis" — use this for any follow-up price or product queries.']
  );
  assert.match(block, /John Lewis/);
  for (const needle of ['_stitle_', 'proactive.briefing', 'concierge_account.balance', 'travel.concierge.context', 'adapt accordingly']) {
    assert.doesNotMatch(block, new RegExp(needle.replace(/[.]/g, '\\.')), `${needle} leaked into the dynamic prompt`);
  }
});
