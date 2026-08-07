// Contextual reference resolution — the nine named follow-up shapes ("remind me tomorrow",
// "book the second one", "send that", "play it", "what about tomorrow?", "do the failed one",
// "the other one", "same place", "yeah that one") plus the guardrails that stop the resolver
// from binding to the wrong, older action. Fixtures are realistic multi-turn conversations, not
// single-turn toys — several deliberately include an intervening UNRELATED action between the
// real antecedent and the follow-up, since that's exactly the shape that used to silently
// mis-resolve under the old single-candidate collapse.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildResolvedContext,
  resolveContextualTurn,
  isContextualReference,
  extractOptionListFromText,
  extractDraftContext,
  extractTopicContext,
  parseOrdinalSelector,
  extractAssistantContexts
} = require('../../api/services/context-brain');

const u = (content, actions) => ({ role: 'user', content, actions });
const a = (content, actions) => ({ role: 'assistant', content, actions });
const action = (type, input, result) => ({ action: type, input, result });

// ── 1. "remind me tomorrow" ────────────────────────────────────────────────────────────────
test('remind me tomorrow: infers the topic from the last substantive turn', () => {
  const history = [
    u('when should I leave for the dentist tomorrow'),
    a("Leave by 8:40 to make your 9am dentist appointment."),
    u('remind me tomorrow')
  ];
  const ctx = buildResolvedContext('remind me tomorrow', history, []);
  assert.equal(ctx.kind, 'topic');
  assert.match(ctx.label, /dentist/i);
});

test('remind me tomorrow: needs a topic (asks) when the prior turn was a dismissal, not a topic', () => {
  // This is the real transcript case: "nah never mind" (cancelling a jacket search) directly
  // precedes "remind me tomorrow" — there is genuinely nothing to infer, so asking is correct.
  const history = [
    u('can you find me a nice jacket?'),
    a('What kind are you after?'),
    u('nah never mind'),
    a('No worries.'),
    u('remind me tomorrow')
  ];
  const ctx = buildResolvedContext('remind me tomorrow', history, []);
  assert.equal(ctx.kind, 'reminder_needs_topic');
});

test('remind me tomorrow: asks instead of creating a blank reminder (regression, live bug 2026-08-07)', () => {
  // Live verification found the model would create create_reminder with a generic
  // title ("Reminder") for this exact transcript instead of asking. resolveContextualTurn
  // must now short-circuit to a spokenOnly clarification before the model ever sees it.
  const history = [
    u('can you find me a nice jacket?'),
    a('What kind are you after?'),
    u('nah never mind'),
    a('No worries.')
  ];
  const resolved = resolveContextualTurn({ message: 'remind me tomorrow', history, recentActions: [] });
  assert.equal(resolved.reason, 'context_reminder_ask_topic');
  assert.equal(resolved.spokenOnly, true);
  assert.ok(!resolved.actions, 'must not create a reminder action');
});

test('remind me tomorrow: a low-confidence topic (no keyword match) also asks rather than guesses', () => {
  const history = [u('I need to buy milk on the way home')];
  const ctx = buildResolvedContext('remind me tomorrow', history, []);
  assert.equal(ctx.kind, 'reminder_needs_topic');
});

test('isContextualReference: ordinary grammatical "it" does not trigger on its own (regression, live bug 2026-08-07)', () => {
  // Live verification found "what time is it in Tokyo?" tripped contextual resolution off the
  // bare word "it" and injected an unrelated hint into an ordinary factual question.
  assert.equal(isContextualReference('what time is it in Tokyo?'), false);
  assert.equal(isContextualReference('is it going to rain today'), false);
  // Supported follow-up shapes (verb+pronoun, or a known noun phrase) must still trigger.
  assert.equal(isContextualReference('play it'), true);
  assert.equal(isContextualReference('send that'), true);
  assert.equal(isContextualReference('same place'), true);
  assert.equal(isContextualReference('yeah that one'), true);
  assert.equal(isContextualReference('do the failed one'), true);
  assert.equal(isContextualReference('book the second one'), true);
});

test('isContextualReference catches the bare reminder shape that has no it/that/one keyword', () => {
  assert.equal(isContextualReference('remind me tomorrow'), true);
  assert.equal(isContextualReference('remind me later'), true);
  // These still correctly fall outside the bare-reminder clause — they name their own subject.
  assert.equal(isContextualReference('remind me to call mum'), false);
  assert.equal(isContextualReference('remind me about the dentist'), false);
});

// ── 2 & 7. "book the second one" / "the other one" — ordinal selection ─────────────────────
test('extractOptionListFromText parses the exact appointmentChoicesText numbered-list shape', () => {
  const text = 'I found these dentist times:\n1. Tue 11 Aug at 6:00 pm\n2. Wed 12 Aug at 2:00 pm\n3. Thu 13 Aug at 9:00 am\n\nTell me which one you want, for example "book option 1".';
  const parsed = extractOptionListFromText(text);
  assert.equal(parsed.kind, 'option_list');
  assert.deepEqual(parsed.options, [
    { index: 1, label: 'Tue 11 Aug at 6:00 pm' },
    { index: 2, label: 'Wed 12 Aug at 2:00 pm' },
    { index: 3, label: 'Thu 13 Aug at 9:00 am' }
  ]);
});

test('extractOptionListFromText requires 2+ CONSECUTIVE numbered lines, not an incidental "1."', () => {
  assert.equal(extractOptionListFromText('Rule 1. Always be honest.'), null);
  assert.equal(extractOptionListFromText('1. First point.\n\n4. Unrelated later point.'), null);
});

test('book the second one: resolves to option index 2 from a real appointment-options turn', () => {
  const history = [
    u('find me a dentist appointment next week'),
    a('I found these dentist times:\n1. Tue 11 Aug at 6:00 pm\n2. Wed 12 Aug at 2:00 pm\n3. Thu 13 Aug at 9:00 am\n\nTell me which one you want, for example "book option 1".'),
    u('book the second one')
  ];
  const ctx = buildResolvedContext('book the second one', history, []);
  assert.equal(ctx.kind, 'option_list_selection');
  assert.equal(ctx.label, 'Wed 12 Aug at 2:00 pm');
  assert.equal(ctx.selectedIndex, 2);
});

test('parseOrdinalSelector recognises "option 1" / "number 2" / "#3" phrasing, not just words', () => {
  assert.deepEqual(parseOrdinalSelector('book option 1'), { index: 0 });
  assert.deepEqual(parseOrdinalSelector('number 2 please'), { index: 1 });
  assert.deepEqual(parseOrdinalSelector('go with #3'), { index: 2 });
});

test('the other one: resolves when exactly two options exist', () => {
  const history = [
    a('I found these times:\n1. Tue 11 Aug at 6pm\n2. Wed 12 Aug at 2pm'),
    u('the other one')
  ];
  const ctx = buildResolvedContext('the other one', history, []);
  assert.equal(ctx.kind, 'option_list_selection');
  assert.equal(ctx.selectedIndex, 2);
});

test('the other one: the built action is authoritative, not left for the model to reconstruct (regression, live bug 2026-08-07)', () => {
  // Live verification found the resolver correctly picked option 2 ("Wed 12 Aug") but the
  // model, left to build the booking action from prose, substituted option 1 instead.
  // resolveContextualTurn must now build the action directly from selectedIndex/label.
  const history = [
    a('I found these times:\n1. Tue 11 Aug at 6pm\n2. Wed 12 Aug at 2pm'),
    u('the other one')
  ];
  const resolved = resolveContextualTurn({ message: 'the other one', history, recentActions: [] });
  assert.equal(resolved.reason, 'context_option_selected');
  assert.equal(resolved.actions[0].type, 'book_appointment');
  assert.equal(resolved.actions[0].input.choice_id, '2');
  assert.equal(resolved.actions[0].input.choice_label, 'Wed 12 Aug at 2pm');
});

test('the other one: does NOT guess when three or more options exist — ambiguous, must ask', () => {
  const history = [
    a('I found these times:\n1. Tue 11 Aug at 6pm\n2. Wed 12 Aug at 2pm\n3. Thu 13 Aug at 9am'),
    u('the other one')
  ];
  const ctx = buildResolvedContext('the other one', history, []);
  assert.equal(ctx.kind, 'unknown', 'three-way "other" is genuinely ambiguous and must not be guessed');
});

test('book the second one: does not fire when there is no real option list to select from', () => {
  const history = [u('hey'), a('Hey.'), u('book the second one')];
  const ctx = buildResolvedContext('book the second one', history, []);
  assert.equal(ctx.kind, 'unknown');
});

// ── 3. "send that" — a drafted-but-unsent message ──────────────────────────────────────────
test('extractDraftContext finds a drafted message that was shown but never sent', () => {
  const history = [
    u('write a text to Sarah saying I will be late'),
    a("Hey Sarah, running about 15 minutes late — sorry about that, see you soon!")
  ];
  const draft = extractDraftContext(history);
  assert.equal(draft.kind, 'draft');
  assert.match(draft.label, /running about 15 minutes late/);
});

test('send that: resolves to the draft, not to an older unrelated action', () => {
  const history = [
    u('find a gym near me'),
    a('', [action('find_place', { query: 'gym' }, { success: true, text: 'PureGym Selfridges' })]),
    u('write a message to Sarah saying I will be late'),
    a('Hey Sarah, running about 15 minutes late — see you soon!'),
    u('send that')
  ];
  const ctx = buildResolvedContext('send that', history, []);
  assert.equal(ctx.kind, 'draft');
  assert.match(ctx.label, /running about 15 minutes late/);
});

test('send that: defers to the dedicated email-drafting path when "email" is explicitly named', () => {
  // "send that email" contains the word email, so the messageKindHints 'draft' clause
  // deliberately does not claim it — index.js's isEmailDraftRequest/buildEmailDraftContext
  // owns that case, with real sender/thread lookups this file has no access to.
  const hints = require('../../api/services/context-brain');
  const history = [u('draft an email to Josh about the meeting'), a('Subject: Meeting — drafted below...')];
  const ctx = hints.buildResolvedContext('send that email', history, []);
  assert.notEqual(ctx.kind, 'draft');
});

// ── 4. "play it" — must survive an intervening unrelated action ────────────────────────────
test('play it: baseline, media is the only recent candidate', () => {
  const history = [u('play some Steve Lacy'), a('', [action('play_music', { query: 'Steve Lacy' })])];
  const resolved = resolveContextualTurn({ message: 'play it', history, recentActions: [] });
  assert.equal(resolved.actions[0].type, 'play_music');
  assert.equal(resolved.actions[0].input.query, 'Steve Lacy');
});

test('play it: does not bind to a MORE RECENT unrelated action just because it is newer', () => {
  const history = [
    u('play some Steve Lacy'),
    a('', [action('play_music', { query: 'Steve Lacy' })]),
    u('is there a gym near me?'),
    a('', [action('find_place', { query: 'gym' }, { success: true, text: 'PureGym Selfridges' })]),
    u('play it')
  ];
  const resolved = resolveContextualTurn({ message: 'play it', history, recentActions: [] });
  assert.ok(resolved, 'should still resolve — this is the adversarial case the old single-candidate collapse got wrong');
  assert.equal(resolved.actions[0].type, 'play_music');
  assert.equal(resolved.actions[0].input.query, 'Steve Lacy');
});

// ── 5. "what about tomorrow?" — re-dates a prior route/train lookup ────────────────────────
test('what about tomorrow: re-issues the same route with the date field swapped', () => {
  const history = [
    u('first train from Birmingham New Street to Apsley'),
    a('The first train from Birmingham New Street to Apsley today is at 05:30.'),
    u('what about tomorrow?')
  ];
  const resolved = resolveContextualTurn({ message: 'what about tomorrow?', history, recentActions: [] });
  assert.equal(resolved.reason, 'context_route_date_shift');
  assert.equal(resolved.actions[0].input.origin, 'Birmingham New Street');
  assert.equal(resolved.actions[0].input.destination, 'Apsley');
  assert.equal(resolved.actions[0].input.departure_time, 'tomorrow');
});

// ── 6. "do the failed one" — retries a failure, never a success ────────────────────────────
test('failed actions are surfaced as their own kind instead of being dropped', () => {
  const recentActions = [
    { type: 'send_email', input: { to: 'a@b.com' }, status: 'failed', error: 'not connected', created_at: '2026-08-06T10:00:00Z' }
  ];
  const ctx = buildResolvedContext('do the failed one', [], recentActions);
  assert.equal(ctx.kind, 'failed_action');
  assert.equal(ctx.suggestedAction, 'send_email');
});

test('do the failed one: retries the failed action, not a more recent succeeded one', () => {
  const recentActions = [
    { type: 'find_place', input: { query: 'gym' }, status: 'executed', created_at: '2026-08-06T11:00:00Z' },
    { type: 'send_email', input: { to: 'a@b.com', body: 'running late' }, status: 'failed', error: 'not connected', created_at: '2026-08-06T10:00:00Z' }
  ];
  const resolved = resolveContextualTurn({ message: 'do the failed one', history: [], recentActions });
  assert.equal(resolved.reason, 'context_retry_failed_action');
  assert.equal(resolved.actions[0].type, 'send_email');
  assert.deepEqual(resolved.actions[0].input, { to: 'a@b.com', body: 'running late' });
});

test('a failed action does not get replayed by ordinary (non-retry) follow-up language', () => {
  const recentActions = [
    { type: 'send_email', input: { to: 'a@b.com' }, status: 'failed', error: 'not connected', created_at: '2026-08-06T10:00:00Z' }
  ];
  // "do it" carries no retry/failed signal, so this must not silently resend a failed email.
  const resolved = resolveContextualTurn({ message: 'do it', history: [], recentActions });
  assert.equal(resolved, null);
});

// ── 8. "same place" — no verb, must still resolve the RIGHT kind ───────────────────────────
test('same place: resolves the place candidate even with no action verb present', () => {
  const history = [
    u('find me a nice restaurant'),
    a('', [action('find_place', { query: 'restaurant' }, { success: true, text: 'Dishoom Birmingham' })]),
    u('same place')
  ];
  const ctx = buildResolvedContext('same place', history, []);
  assert.equal(ctx.kind, 'place');
  assert.match(ctx.label, /Dishoom/);
});

// ── 9. "yeah that one" / no kind signal — falls back to existing recency behaviour ─────────
test('a message with no kind signal at all falls back to plain recency (unchanged baseline)', () => {
  const history = [u('play some Steve Lacy'), a('', [action('play_music', { query: 'Steve Lacy' })])];
  const ctx = buildResolvedContext('yeah that one', history, []);
  assert.equal(ctx.kind, 'media');
});

// ── General kind-relevance guardrail ────────────────────────────────────────────────────────
test('a message with a clear kind signal never falls back to an unrelated candidate', () => {
  const history = [u('find me a gym'), a('', [action('find_place', { query: 'gym' }, { success: true, text: 'PureGym' })])];
  // "play it" clearly wants media; there is none — must say so, not hand back the gym.
  const ctx = buildResolvedContext('play it', history, []);
  assert.equal(ctx.kind, 'unknown');
});

test('extractTopicContext skips fillers and stops at a dismissal', () => {
  assert.equal(extractTopicContext([u('ok'), u('nah never mind')]), null);
  assert.equal(extractTopicContext([u('the dentist wants me in at 9am tomorrow')]).label, 'the dentist wants me in at 9am tomorrow');
});

test('extractAssistantContexts is unaffected by this change for the existing media/route paths', () => {
  const contexts = extractAssistantContexts([{ role: 'assistant', content: 'Playing "Bad Habit" by Steve Lacy.' }]);
  assert.ok(contexts.some(c => c.kind === 'media' && c.label === 'Bad Habit by Steve Lacy'));
});
