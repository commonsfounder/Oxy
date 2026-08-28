// The prompt is named sections composed by buildSystemPrompt, not a numbered rule list, so
// nothing here pins rule numbers. What it does pin, unconditionally:
//   - every safety, honesty and review-relevant rule survives verbatim in the core prompt, which
//     every surface uses
//   - the named sections exist and carry the behaviour they're supposed to
//   - the chat-turn RESPONSE RULES tail still carries its memory-suppression and blocker phrasing
// Tool-specific disambiguation lives on each tool's `guidance` field instead — see
// test/smoke/native-tool-guidance.test.js.

const assert = require('node:assert/strict');
const test = require('node:test');

const { CORE_SYSTEM_PROMPT, MILLIE_VOICE_PROMPT, buildSystemPrompt } = require('../../api/prompts');
const { buildDynamicSystemPrompt } = require('../../api/index');

function phrase(text) {
  return new RegExp(text.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
}

// ── Named sections replace numbered rules ──────────────────────────────────────────────────
test('the core chat prompt is composed of named sections, not numbered rules', () => {
  for (const header of ['WHAT YOU CAN DO:', 'HOW YOU WORK:', 'TRUTHFULNESS & SAFETY:', 'WORKING WITH RESULTS:', 'COMMUNICATION CRAFT:']) {
    assert.ok(CORE_SYSTEM_PROMPT.includes(header), `missing section header: ${header}`);
  }
  // No numbered-rule-list artifacts should remain (a lone "N." at the start of a line).
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /^\d+\.\s/m, 'a numbered rule line survived the restructure');
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /ABSOLUTE RULES/);
});

test('the working loop preserves the musing/thinking-aloud carve-out', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('Musing, thinking aloud, or a half-formed thought is not a goal'));
  assert.match(CORE_SYSTEM_PROMPT, phrase("don't start a task, search, or tool call from it"));
  assert.match(CORE_SYSTEM_PROMPT, phrase('follow them there instead of finishing what they walked back'));
  assert.match(CORE_SYSTEM_PROMPT, phrase('Ordinary conversation is not a goal to complete; just talk'));
});

test('the working loop preserves the general missing-info policy', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('Start with what you have'));
  assert.match(CORE_SYSTEM_PROMPT, phrase("Ask only for what's genuinely blocking"));
  assert.match(CORE_SYSTEM_PROMPT, phrase('begin the work rather than front-loading questions'));
});

test('structure guidance (no bullets/headings in ordinary conversation) lives once, in the voice section', () => {
  assert.match(MILLIE_VOICE_PROMPT, phrase('no headings, no bullet points, no numbered lists'));
  assert.match(MILLIE_VOICE_PROMPT, phrase('an actual itinerary, a set of options the person asked to compare, or step-by-step instructions'));
  // It must not ALSO be restated as a separate rule elsewhere in the composed chat prompt.
  const occurrences = (CORE_SYSTEM_PROMPT.match(/no headings/gi) || []).length;
  assert.equal(occurrences, 1, 'structure guidance is duplicated instead of stated once');
});

test('the shopping-vs-place-lookup disambiguation lives on find_place\'s tool guidance, not the static prompt', () => {
  // Moved to action-contracts.js (see native-tool-guidance.test.js) — it must not be
  // duplicated back into the static prompt text.
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /find_place for product searches/);
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /25-CRITICAL/);
});

test('dead/stale references from the pre-restructure prompt are gone', () => {
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /visual actions above/i);
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /\bOXCY\b/);
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /full-service personal concierge/);
});

// ── Safety, honesty, and review protections: unchanged, not just present ──────────────────
test('safety-critical rule text is byte-identical to before the restructure', () => {
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
    assert.ok(CORE_SYSTEM_PROMPT.includes(text), `missing or altered: ${text.slice(0, 60)}...`);
  }
});

test('the money-actions paragraph is unchanged', () => {
  assert.match(
    CORE_SYSTEM_PROMPT,
    phrase('For money actions, use the approved payment and balance tools. Explain what will happen before money moves and get confirmation when required. Never invent a balance, payment, or result.')
  );
});

test('the voice explicitly requires real approval before consequential actions', () => {
  assert.match(
    MILLIE_VOICE_PROMPT,
    phrase("Still get a real yes before anything that spends money, sends something, books something, or otherwise can't be quietly undone")
  );
});

test('public-figure/news grounding and search-staleness honesty are universal, not chat-only', () => {
  // These used to live only in buildDynamicSystemPrompt's chat-turn RESPONSE RULES, so a
  // scheduled task or briefing never saw them. They now live once, in TRUTHFULNESS_SAFETY_
  // SECTION, so every surface — including background and briefing — gets them.
  for (const surface of ['chat', 'background', 'briefing']) {
    const prompt = buildSystemPrompt({ surface, context: {} });
    assert.match(prompt, phrase('do not provide names, dates, or counts unless they are grounded in'), `${surface} missing public-figure grounding rule`);
    assert.match(prompt, phrase('Search and tool results can be stale'), `${surface} missing staleness rule`);
  }
});

// ── Dynamic RESPONSE RULES (buildDynamicSystemPrompt, the chat-turn tail) ──────────────────
test('buildDynamicSystemPrompt suppresses memory as a source of casual-chat filler suggestions', () => {
  const dynamic = buildDynamicSystemPrompt('Has a girlfriend; Founder of a startup', '', 'none', 'ctx', []);
  assert.match(dynamic, phrase('pull ideas from the actual conversation, not from a mental inventory of their stored facts'));
  assert.match(dynamic, phrase("unless they've brought that topic up themselves"));
});

test('buildDynamicSystemPrompt does not teach a fixed "Tiny snag" example', () => {
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

test('buildDynamicSystemPrompt returns a complete, ready-to-use prompt (voice + capabilities included), not a bare fragment', () => {
  // Phase 6: buildDynamicSystemPrompt is now a thin wrapper over buildSystemPrompt({surface:
  // 'chat', ...}) — its return value is the FULL composed prompt, no separate static-prefixing
  // step at the call site anymore.
  const dynamic = buildDynamicSystemPrompt('m', 'p', 'none', 'ctx', []);
  assert.ok(dynamic.startsWith(MILLIE_VOICE_PROMPT));
  assert.match(dynamic, /TRUTHFULNESS & SAFETY:/);
});
