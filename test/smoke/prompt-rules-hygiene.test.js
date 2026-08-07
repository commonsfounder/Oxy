// Phase 5: the ABSOLUTE RULES list had three top-level numbers used twice (7, 8, 11) — this
// file guards against that regressing, and pins the specific content changes made while
// renumbering: the ask-vs-act merge (old 8 + old 22b -> new 10), the musing/thinking-aloud
// carve-out (new 3), and the strengthened no-bullets rule (new 26). It also asserts every
// safety-, honesty-, and review-relevant rule survived the rewrite untouched, and that the two
// dynamic RESPONSE RULES changes (memory-as-filler suppression, the de-ticked blocker example)
// landed in buildDynamicSystemPrompt's actual output.

const assert = require('node:assert/strict');
const test = require('node:test');

const { OXCY_SYSTEM_PROMPT } = require('../../api/prompts');
const { buildDynamicSystemPrompt } = require('../../api/index');

function phrase(text) {
  return new RegExp(text.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
}

test('no top-level ABSOLUTE RULES number is used twice', () => {
  const nums = [...OXCY_SYSTEM_PROMPT.matchAll(/^(\d+)\./gm)].map(m => Number(m[1]));
  const seen = new Set();
  const dupes = nums.filter(n => (seen.has(n) ? true : (seen.add(n), false)));
  assert.deepEqual(dupes, [], `duplicate rule numbers: ${dupes.join(', ')}`);
});

test('ABSOLUTE RULES numbers run 1..N with no gaps', () => {
  const nums = [...OXCY_SYSTEM_PROMPT.matchAll(/^(\d+)\./gm)].map(m => Number(m[1]));
  assert.deepEqual(nums, Array.from({ length: nums.length }, (_, i) => i + 1));
  assert.ok(nums.length >= 25, 'sanity: renumbering should not have silently dropped rules');
});

test('rule 3 carves out musing/thinking-aloud from vague-goal action', () => {
  assert.match(OXCY_SYSTEM_PROMPT, phrase('Musing, thinking aloud, or a half-formed thought is not a goal'));
  assert.match(OXCY_SYSTEM_PROMPT, phrase("don't start a task, search, or tool call from it"));
  assert.match(OXCY_SYSTEM_PROMPT, phrase('follow them there instead of finishing what they walked back'));
});

test('rule 10 states the general missing-info policy and absorbs the old 22b duplicate', () => {
  assert.match(OXCY_SYSTEM_PROMPT, phrase('Start with what you have'));
  assert.match(OXCY_SYSTEM_PROMPT, phrase("Ask only for what's genuinely blocking"));
  assert.match(OXCY_SYSTEM_PROMPT, phrase('begin the work rather than front-loading questions'));
  // The old 22b text should not exist as a second, separate copy of this policy.
  assert.doesNotMatch(OXCY_SYSTEM_PROMPT, /Missing-info policy:/);
});

test('rule 26 gives a concrete test for when structure is genuinely warranted', () => {
  assert.match(OXCY_SYSTEM_PROMPT, phrase('no headings, bullet points, or numbered lists'));
  assert.match(OXCY_SYSTEM_PROMPT, phrase('unless the person is asking for something that is genuinely a list'));
  assert.match(OXCY_SYSTEM_PROMPT, phrase('One recommendation beats three neutral options'));
});

test('rule 1 distinguishes a real goal from ordinary conversation', () => {
  assert.match(OXCY_SYSTEM_PROMPT, phrase('Ordinary conversation is not a goal to complete; just talk'));
});

test('the 22-CRITICAL shopping-vs-place cluster survived renumbering to 25-CRITICAL', () => {
  assert.match(OXCY_SYSTEM_PROMPT, /25-CRITICAL\. Never use find_place for product searches/);
  assert.match(OXCY_SYSTEM_PROMPT, /25-CRITICAL-B\. When a user says "wrong price"/);
  assert.match(OXCY_SYSTEM_PROMPT, /25-CRITICAL-C\. For follow-up product questions/);
  assert.doesNotMatch(OXCY_SYSTEM_PROMPT, /22-CRITICAL/);
});

test('the lettered sub-rule groups kept their content and their attachment to the right parent', () => {
  assert.match(OXCY_SYSTEM_PROMPT, /9a\. Only use get_directions\/plan_trip/);
  assert.match(OXCY_SYSTEM_PROMPT, /9d\. For follow-ups like/);
  assert.match(OXCY_SYSTEM_PROMPT, /14a\. If the user asks a question about a previous action result/);
  assert.match(OXCY_SYSTEM_PROMPT, /14b\. If the user asks to act on a recent answer/);
  assert.match(OXCY_SYSTEM_PROMPT, /23a\. Never send an email body/);
  assert.match(OXCY_SYSTEM_PROMPT, /23b\. If the user asks you to rewrite/);
  assert.match(OXCY_SYSTEM_PROMPT, /24a\. Calendar beats music/);
  assert.match(OXCY_SYSTEM_PROMPT, /24b\. If the user corrects you with/);
  assert.match(OXCY_SYSTEM_PROMPT, /25a\. For ride\/taxi\/Uber requests/);
  assert.match(OXCY_SYSTEM_PROMPT, /25d\. For music requests that depend on current facts/);
});

// ── Safety, honesty, and review protections: unchanged, not just present ──────────────────
test('safety-critical rule text is byte-identical to before the rewrite', () => {
  const mustSurviveVerbatim = [
    'Never claim to have done something without using the corresponding tool/function call.',
    "Never refuse an action unless it's actively harmful. For high-risk use the review flow.",
    'Never fabricate information — search or use tools instead if you need real-world data.',
    'If the user asks you to send "a link", the outgoing message must contain an actual URL from the user\'s message, tool results, or explicit conversation context. Never invent product links, prices, retailers, model names, or recommendations.',
    'Never send an email body that is just a generic template. The body must contain specific content from the user, current conversation, memory, or tool results.',
    'If the user asks you to rewrite, improve, make more professional, or lengthen a just-sent email, do not send another email unless they explicitly say to resend. Draft the improved version in chat and ask for approval.',
    'If the user asks you to forget, delete, wipe, or remove something from memory, use forget_memory instead of just saying you will do it.'
  ];
  for (const text of mustSurviveVerbatim) {
    assert.ok(OXCY_SYSTEM_PROMPT.includes(text), `missing or altered: ${text.slice(0, 60)}...`);
  }
});

test('the money-actions paragraph is unchanged', () => {
  assert.match(
    OXCY_SYSTEM_PROMPT,
    phrase('For money actions, use the approved payment and balance tools. Explain what will happen before money moves and get confirmation when required. Never invent a balance, payment, or result.')
  );
});

test('the new voice explicitly requires real approval before consequential actions', () => {
  assert.match(
    OXCY_SYSTEM_PROMPT,
    phrase("Still get a real yes before anything that spends money, sends something, books something, or otherwise can't be quietly undone")
  );
});

// ── Dynamic RESPONSE RULES (buildDynamicSystemPrompt) ──────────────────────────────────────
test('buildDynamicSystemPrompt suppresses memory as a source of casual-chat filler suggestions', () => {
  const dynamic = buildDynamicSystemPrompt('Has a girlfriend; Founder of a startup', '', 'none', 'ctx', []);
  assert.match(dynamic, phrase('pull ideas from the actual conversation, not from a mental inventory of their stored facts'));
  assert.match(dynamic, phrase("unless they've brought that topic up themselves"));
});

test('buildDynamicSystemPrompt no longer teaches a fixed "Tiny snag" example', () => {
  const dynamic = buildDynamicSystemPrompt('', '', 'none', 'ctx', []);
  assert.doesNotMatch(dynamic, /Tiny snag/);
  assert.match(dynamic, phrase("in your own words, not a fixed phrase"));
});

test('the existing memory/repetition RESPONSE RULES are untouched', () => {
  const dynamic = buildDynamicSystemPrompt('', '', 'none', 'ctx', []);
  assert.match(dynamic, phrase('The user leads the conversation. Follow their topic instead of steering into unrelated stored memory.'));
  assert.match(dynamic, phrase('Only mention stored memory when it is directly relevant to what the user just said, asked, or asked you to do.'));
  assert.match(dynamic, phrase('Do not repeat context you already stated earlier in this conversation.'));
});
