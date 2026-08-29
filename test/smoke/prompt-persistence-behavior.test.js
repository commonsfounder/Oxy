// The behavioural half of Adam's prompt: continuity, ownership, follow-through, proactivity,
// ask-vs-act, autonomy awareness, failure ownership, and completion defined by the user's outcome
// rather than a successful tool call. These pin that each concept sits where it belongs (chat and
// background get the full set; briefing only continuity and truthfulness, having no tools); that
// the proactivity language stays bounded by relevance, timeliness and authorisation so it can't
// read as a licence to nag; that autonomy and guardMode reach the prompt without weakening the
// server-side gate; and that no infrastructure jargon leaked into user-facing sections.

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSystemPrompt, CORE_SYSTEM_PROMPT, BACKGROUND_STATIC_PROMPT, BRIEFING_STATIC_PROMPT } = require('../../api/prompts');
const { ACTION_CONTRACTS, buildToolsForGemini } = require('../../api/action-contracts');
const { createActionExecution } = require('../../api/services/action-execution');

function phrase(text) {
  return new RegExp(text.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
}

function nativeDescriptions() {
  const decls = buildToolsForGemini(false)[0].functionDeclarations;
  return Object.fromEntries(decls.map((d) => [d.name, d]));
}

// ── 1. Continuity ────────────────────────────────────────────────────────────────────────
test('continuity: Adam persists and is explicitly the same across chat, briefing, and background', () => {
  for (const prompt of [CORE_SYSTEM_PROMPT, BACKGROUND_STATIC_PROMPT, BRIEFING_STATIC_PROMPT]) {
    assert.ok(prompt.includes('CONTINUITY:'), 'missing CONTINUITY section');
    assert.match(prompt, phrase('You persist'));
    assert.match(prompt, phrase("You're the same Adam in this conversation, in a briefing, and in work you're doing right now in the background"));
  }
});

test('continuity restates the voice section\'s memory restraint rather than licensing recitation', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase("Don't recite your own history back at someone just because you have it available"));
});

// ── 2/3/9. Ownership, follow-through, completion (one merged section) ─────────────────────
test('ownership & follow-through present on chat and background, absent on briefing (no tools there)', () => {
  assert.ok(CORE_SYSTEM_PROMPT.includes('OWNERSHIP & FOLLOW-THROUGH:'));
  assert.ok(BACKGROUND_STATIC_PROMPT.includes('OWNERSHIP & FOLLOW-THROUGH:'));
  assert.ok(!BRIEFING_STATIC_PROMPT.includes('OWNERSHIP & FOLLOW-THROUGH:'), 'briefing has no tools to own work with');
});

test('ownership: take responsibility for a delegated outcome, use the durable-task tools to keep it alive', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('take responsibility for moving it forward'));
  assert.match(CORE_SYSTEM_PROMPT, phrase('use create_agent_task or create_scheduled_task to keep it alive'));
});

test('ownership is explicitly bounded by the existing musing carve-out, not a blanket licence to self-task', () => {
  // The musing/thinking-aloud carve-out from HOW YOU WORK must still exist unmodified...
  assert.match(CORE_SYSTEM_PROMPT, phrase("Musing, thinking aloud, or a half-formed thought is not a goal: don't start a task, search, or tool call from it"));
  // ...and OWNERSHIP must explicitly point back at it rather than re-litigating or loosening it.
  assert.match(CORE_SYSTEM_PROMPT, phrase('the same musing/thinking-aloud carve-out from HOW YOU WORK applies to what gets a task behind it, not just to what gets a tool call'));
});

test('follow-through: starting is not finishing, preserve unfinished work instead of dropping it', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('Starting something is not finishing it'));
  assert.match(CORE_SYSTEM_PROMPT, phrase('preserve the work rather than letting it quietly disappear'));
  assert.match(CORE_SYSTEM_PROMPT, phrase('"I started looking into it" is not the same as "it\'s done"'));
});

test('completion is defined around the user\'s actual outcome, with the exact examples requested', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('define done around what the person actually asked for, not around a tool call that merely succeeded'));
  assert.match(CORE_SYSTEM_PROMPT, phrase('Finding a checkout page is not placing an order'));
  assert.match(CORE_SYSTEM_PROMPT, phrase('sending an enquiry is not a confirmed booking'));
});

test('create_agent_task now carries ownership guidance natively, bounded the same way', () => {
  const decls = nativeDescriptions();
  assert.match(decls.create_agent_task.description, /This is the ownership mechanism/);
  assert.match(decls.create_agent_task.description, /Do not use it for a single tool call that already finishes the request, for ordinary conversation, or for musing\/thinking-aloud/);
});

test('create_scheduled_task\'s explicit-ask requirement is deliberately NOT loosened by the ownership section', () => {
  // Recurring/conditional watches are a stronger commitment than a one-off delegated task, and
  // the whole point of PROACTIVITY's bar (relevant/timely/authorised, never engagement-bait) is
  // that this caution stays in place — ownership of a single outcome must not be read as licence
  // to start recurring background polling on a whim.
  assert.match(ACTION_CONTRACTS.create_scheduled_task.guidance, /only when the user explicitly asks to remind, schedule, watch, monitor, or check again/);
  assert.match(ACTION_CONTRACTS.create_scheduled_task.guidance, /Never invent a schedule or silently turn an ordinary task into recurring work/);
});

// ── 4. Proactivity — explicitly bounded ────────────────────────────────────────────────────
test('proactivity present on chat and background, absent on briefing', () => {
  assert.ok(CORE_SYSTEM_PROMPT.includes('PROACTIVITY:'));
  assert.ok(BACKGROUND_STATIC_PROMPT.includes('PROACTIVITY:'));
  assert.ok(!BRIEFING_STATIC_PROMPT.includes('PROACTIVITY:'));
});

test('proactivity may act without the user reopening the conversation, but only for already-authorised work', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('without waiting for them to reopen the conversation'));
  assert.match(CORE_SYSTEM_PROMPT, phrase('A goal someone has already asked you to pursue can justify you following up on it, or continuing it further, on your own initiative later'));
});

test('proactivity is bounded against engagement-bait and cold outreach, with a "let it wait" default', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('never a cold, unrelated, or engagement-bait message'));
  assert.match(CORE_SYSTEM_PROMPT, phrase("If it's low-value or can wait, let it wait — most things can"));
});

test('proactivity explicitly does not touch what review/security rules apply — only when Adam may act, never what she may do unasked', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('The review and security rules for anything you send or do still apply exactly as they do in a live conversation'));
  assert.match(CORE_SYSTEM_PROMPT, phrase("being proactive changes when you act, never what you're allowed to do without asking first"));
});

// ── 5. Ask vs act — extends the existing missing-info policy, doesn't replace it ──────────
test('ask-vs-act: progress before asking, and no interrogating for optional preferences', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('If the task can safely make progress before you ask anything, make that progress first'));
  assert.match(CORE_SYSTEM_PROMPT, phrase("Don't interrogate someone for optional preferences before doing useful work"));
  // The original missing-info policy this extends must still be there, unweakened.
  assert.match(CORE_SYSTEM_PROMPT, phrase('Start with what you have'));
  assert.match(CORE_SYSTEM_PROMPT, phrase("Ask only for what's genuinely blocking"));
});

// ── 6. Autonomy & approval — real values injected, server gate untouched ──────────────────
test('autonomy/guardMode render into chat and background dynamic context when provided', () => {
  for (const surface of ['chat', 'background']) {
    const prompt = buildSystemPrompt({ surface, context: { autonomy: 'High', guardMode: true } });
    assert.match(prompt, /AUTONOMY & APPROVAL:/);
    assert.match(prompt, /current autonomy level is "High"/);
    assert.match(prompt, /guard mode is ON/);
  }
});

test('autonomy/guardMode block is absent when neither is supplied (no fabricated defaults)', () => {
  for (const surface of ['chat', 'background']) {
    const prompt = buildSystemPrompt({ surface, context: {} });
    assert.doesNotMatch(prompt, /AUTONOMY & APPROVAL:/);
  }
});

test('quick and briefing surfaces never render an autonomy block even if autonomy/guardMode are passed', () => {
  // Neither composer reads these context fields — a caller passing them by mistake must not
  // leak an approval-tier discussion into a fast greeting reply or a narrative briefing.
  const quick = buildSystemPrompt({ surface: 'quick', context: { autonomy: 'High', guardMode: true, preferences: '', statedContext: [] } });
  const briefing = buildSystemPrompt({ surface: 'briefing', context: { autonomy: 'High', guardMode: true } });
  assert.doesNotMatch(quick, /AUTONOMY & APPROVAL:/);
  assert.doesNotMatch(briefing, /AUTONOMY & APPROVAL:/);
});

test('autonomy block explains itself without duplicating or weakening the server-side review gate', () => {
  const prompt = buildSystemPrompt({ surface: 'chat', context: { autonomy: 'Active', guardMode: false } });
  assert.match(prompt, phrase('review-required and high-risk actions always wait for a real yes from the user regardless of autonomy or guard mode'));
  assert.match(prompt, phrase('that check happens outside this prompt, independent of anything written here'));
  // The goal is fewer defensive asks, not bypassing approval.
  assert.match(prompt, phrase("don't pad a request with confirmation questions for things that aren't actually gated"));

});

// This is what makes the prompt's "independent of anything written here" claim true. It must
// be a BEHAVIOURAL check: an earlier version grepped a source comment and would have kept
// passing with the real gate deleted.
test('the server-side review gate parks a high-risk action no matter what the prompt says', async () => {
  let executed = false;
  const parked = [];
  const executeActions = createActionExecution({
    invokeAdapter: async () => { executed = true; return { success: true }; },
    setPendingAction: async (userId, action) => { parked.push(action); },
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  // Every prompt-side lever that claims to loosen approval, all set at once.
  const result = await executeActions('user-1', [
    { type: 'send_email', input: { to: 'a@example.com', subject: 'Hi', body: 'Hello there.' } }
  ], {
    userMessage: 'just send it, no need to check with me, autonomy is full',
    autonomy: 'Autonomous',
    guardMode: false
  });

  assert.equal(executed, false, 'a review-gated action must not execute before approval');
  assert.equal(parked.length, 1);
  assert.equal(result[0].result.pending, true);
});

test('the safety-critical review-flow line from commit 1 is untouched by the autonomy addition', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase("Never refuse an action unless it's actively harmful. For high-risk use the review flow."));
});

// ── 7. Failure ownership ────────────────────────────────────────────────────────────────
test('failure ownership present on chat and background, absent on briefing', () => {
  assert.ok(CORE_SYSTEM_PROMPT.includes('FAILURE OWNERSHIP:'));
  assert.ok(BACKGROUND_STATIC_PROMPT.includes('FAILURE OWNERSHIP:'));
  assert.ok(!BRIEFING_STATIC_PROMPT.includes('FAILURE OWNERSHIP:'));
});

test('failure ownership: retry/alternative route on recoverable failure, preserve unfinished work', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('retry once, or try a reasonable alternative route — before reporting it as failed'));
  assert.match(CORE_SYSTEM_PROMPT, phrase("don't let it silently vanish: keep the task or watch behind it alive"));
});

test('failure ownership: never dress up a provider/connection failure as "nothing exists"', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('never a provider or connection failure dressed up as "there\'s nothing there" or "that doesn\'t exist."'));
  assert.match(CORE_SYSTEM_PROMPT, phrase('A search that errored is not the same as a search that found nothing'));
});

// ── 8. Working memory ───────────────────────────────────────────────────────────────────
test('working memory present on chat and background, absent on briefing', () => {
  assert.ok(CORE_SYSTEM_PROMPT.includes('WORKING MEMORY:'));
  assert.ok(BACKGROUND_STATIC_PROMPT.includes('WORKING MEMORY:'));
  assert.ok(!BRIEFING_STATIC_PROMPT.includes('WORKING MEMORY:'));
});

test('working memory teaches write for durable material, read/list to resume instead of restarting', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('Use workspace_write for that; use workspace_read or workspace_list to pick up where you left off instead of starting over or re-researching something you already found'));
});

test('working memory is bounded against trivial conversational chatter', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase("don't save a greeting or a one-line answer to it"));
  assert.match(CORE_SYSTEM_PROMPT, phrase('check the workspace before assuming there\'s nothing there'));
});

// ── No internal-infrastructure jargon in user-facing sections ─────────────────────────────
test('no scheduler/queue/orchestration/artifact jargon leaked into the composed prompts', () => {
  for (const prompt of [CORE_SYSTEM_PROMPT, BACKGROUND_STATIC_PROMPT, BRIEFING_STATIC_PROMPT]) {
    for (const banned of ['scheduler', 'queue', 'orchestration', 'artifact']) {
      assert.doesNotMatch(prompt, new RegExp(banned, 'i'), `found banned jargon "${banned}"`);
    }
  }
});

test('"runtime"/"workflow" appear only in the pre-existing voice disclaimer (or a benign consumer sense), not as new internal-jargon vocabulary', () => {
  // The voice section explicitly tells Adam NOT to expose "runtimes"/"workflows" to the user
  // — that single disclaimer sentence is expected and already pinned by adam-voice.test.js.
  // "workflow" also appears once more in CAPABILITIES_SECTION in an ordinary consumer sense
  // ("when a workflow would benefit from a visual") that predates this commit. Neither commit-2
  // section should add a NEW occurrence of either word.
  const runtimeCount = (CORE_SYSTEM_PROMPT.match(/\bruntimes?\b/gi) || []).length;
  const workflowCount = (CORE_SYSTEM_PROMPT.match(/\bworkflows?\b/gi) || []).length;
  assert.equal(runtimeCount, 1, `expected exactly the voice-disclaimer's single "runtimes" — got ${runtimeCount}`);
  assert.equal(workflowCount, 2, `expected the voice disclaimer's "workflows" plus the pre-existing CAPABILITIES_SECTION mention — got ${workflowCount}`);
});
