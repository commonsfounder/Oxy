// Native function declarations are the sole model-facing capability definitions —
// actionPromptBlock(), which re-serialised every contract as ~29KB of JSON inside the system
// prompt, is not in the live prompt. These prove that text is gone, that the guidance which
// mattered survived into the native output, and that review gating never came from prompt text.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ACTION_CONTRACTS,
  buildToolsForGemini,
  actionPromptBlock,
  getActionContract
} = require('../../api/action-contracts');
const { CORE_SYSTEM_PROMPT, MILLIE_VOICE_PROMPT } = require('../../api/prompts');

function nativeDescriptions() {
  const decls = buildToolsForGemini(false)[0].functionDeclarations;
  return Object.fromEntries(decls.map((d) => [d.name, d]));
}

// ── The prompt no longer carries the catalogue ─────────────────────────────────────────────
test('the live system prompt contains no <action> block', () => {
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /<action>/i);
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /<\/action>/i);
});

test('the live system prompt contains no serialised tool catalogue', () => {
  // The catalogue's own JSON.stringify shape — actionPromptList() wraps every entry in
  // {"actions": [...]} — plus a couple of field names that only ever appeared inside it.
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /"actions":\s*\[/);
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /"inputExample"/);
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /"executionMode"/);
  // Spot-check a handful of action type names that appeared ONLY inside the catalogue block,
  // never in prose elsewhere in the static prompt.
  for (const type of ['workspace_write', 'project_rollback', 'browser_sign_in', 'stripe_payout_to_user']) {
    assert.doesNotMatch(CORE_SYSTEM_PROMPT, new RegExp(`"${type}"`), `${type} should only exist as a function declaration now, not prompt text`);
  }
});

test('the static prompt shrank by roughly the size of the removed catalogue', () => {
  // actionPromptBlock() is still a real, callable function (kept for the decommissioned
  // <action> text fallback) — used here only as a size reference, not as something still
  // wired into the prompt.
  const removedBlockSize = actionPromptBlock().length;
  assert.ok(removedBlockSize > 25000, 'sanity: the catalogue itself should still be roughly its known size');
  assert.ok(CORE_SYSTEM_PROMPT.length < 20000, `static prompt is ${CORE_SYSTEM_PROMPT.length} chars — the catalogue should be gone, not just shrunk`);
});

test('the personality block itself is untouched by this phase', () => {
  assert.ok(CORE_SYSTEM_PROMPT.startsWith(MILLIE_VOICE_PROMPT), 'MILLIE_VOICE_PROMPT must still open the prompt, unchanged');
});

test('actionPromptBlock() itself still works — kept as a decommissioned fallback, not deleted', () => {
  const block = actionPromptBlock();
  assert.match(block, /^<action>/);
  assert.match(block, /"actions":/);
});

// ── The dead `confirmation` field never leaks into any tool description ───────────────────
test('confirmation is never copied into a native tool description — nothing reads it', () => {
  const decls = buildToolsForGemini(false)[0].functionDeclarations;
  for (const decl of decls) {
    assert.doesNotMatch(decl.description, /\bconfirmation\b/i, `${decl.name} description must not mention the dead confirmation field`);
  }
});

// ── Guidance survives, natively, verbatim ──────────────────────────────────────────────────
// The invariant is that guidance reaches the model verbatim, not that some exact number of
// contracts carry it — an exact count only fails when a capability is added, which is noise.
// The floor still catches guidance being dropped wholesale.
test('every contract that defines guidance has it appear verbatim in its native description', () => {
  const withGuidance = Object.entries(ACTION_CONTRACTS).filter(([, c]) => c.guidance);
  assert.ok(withGuidance.length >= 60, `guidance collapsed to ${withGuidance.length} contracts`);
  const decls = nativeDescriptions();
  for (const [type, contract] of withGuidance) {
    assert.ok(decls[type], `${type} has no native declaration at all`);
    assert.ok(
      decls[type].description.includes(contract.guidance),
      `${type}'s guidance did not survive verbatim into its native description`
    );
  }
});

test('browser purchases: the transaction capabilities carry the approval guidance natively', () => {
  const decls = nativeDescriptions();
  assert.match(decls.transaction_prepare.description, /It never charges anything/);
  assert.match(decls.transaction_prepare.description, /never a figure you inferred yourself/);
  assert.match(decls.transaction_authorize.description, /Only call this after the person has explicitly agreed to the amount/);
  assert.match(decls.transaction_authorize.description, /that is a pause, not a failure/);
});


// ── 2026-08-08: find_appointment_options only talks to a sandbox provider that isn't
// connected in production — steer the model to the tool that actually works instead of
// retrying a dead end or telling the user booking is impossible. ─────────────────────────
test('appointment booking: find_appointment_options points at the browser primitives as the real path', () => {
  const decls = nativeDescriptions();
  assert.match(decls.find_appointment_options.description, /Do not repeat this call after that error/);
  // Booking through a real website is now the general browser primitives' job, not a
  // purpose-built ordering loop's. Approval still routes through the same money gate.
  assert.match(decls.find_appointment_options.description, /use browser_open and browser_act to book directly through the business's own real website/);
  assert.match(decls.find_appointment_options.description, /transaction_authorize so it still passes the normal approval gate/);
});

test('credentials: using a saved sign-in is gated and never invented', () => {
  const decls = nativeDescriptions();
  assert.match(decls.browser_sign_in.description, /The user is asked before any credential is used, every time/);
  assert.match(decls.browser_sign_in.description, /never invent one/);
});


test('scheduled watches: create_scheduled_task and cancel_scheduled_task guidance survives natively', () => {
  const decls = nativeDescriptions();
  assert.match(decls.create_scheduled_task.description, /Never invent a schedule or silently turn an ordinary task into recurring work/);
  assert.match(decls.cancel_scheduled_task.description, /Cancel only the matching background watch/);
});

// ── 2026-08-08: delivery/tracking watches reuse create_scheduled_task + run_browser_task —
// no fake track_package action, no scheduler changes. ──────────────────────────────────────
test('delivery tracking: create_scheduled_task teaches resolving tracking info, real page reads, state comparison, and notification-intent matching', () => {
  const decls = nativeDescriptions();
  assert.match(decls.create_scheduled_task.description, /resolve the tracking URL\/number yourself first/);
  assert.match(decls.create_scheduled_task.description, /searching recent order\/shipping emails \(search_emails\)/);
  assert.match(decls.create_scheduled_task.description, /use browser_open to read the REAL current page; never invent a status/);
  assert.match(decls.create_scheduled_task.description, /label created, awaiting carrier, collected, in transit, at depot, customs, delayed, delivery attempted, out for delivery, delivered, returned to sender, exception/);
  assert.match(decls.create_scheduled_task.description, /workspace_read the last state you saved for this shipment/);
  assert.match(decls.create_scheduled_task.description, /never on every poll just because a timestamp on the page moved/);
});

test('delivery tracking: notification intent is matched to phrasing, not a single generic "keep checking" rule', () => {
  const decls = nativeDescriptions();
  const desc = decls.create_scheduled_task.description;
  assert.match(desc, /"tell me when it arrives" only triggers on delivered/);
  assert.match(desc, /"tell me if it's delayed" only triggers on a delay\/exception/);
  assert.match(desc, /"tell me when it's out for delivery" only triggers at that stage/);
  assert.match(desc, /"keep me updated" triggers on any meaningful transition/);
});

test('delivery tracking: an ongoing watch re-arms itself after a non-terminal change and stops for real at a terminal one', () => {
  const desc = nativeDescriptions().create_scheduled_task.description;
  assert.match(desc, /ALSO call create_scheduled_task again in the same run before finishing/);
  assert.match(desc, /never keep checking a delivered parcel forever/);
});

test('delivery tracking: a blocked/unreadable carrier page must be reported honestly, never an invented status', () => {
  const desc = nativeDescriptions().create_scheduled_task.description;
  assert.match(desc, /login wall, CAPTCHA, blocked.*never report an invented or stale status/s);
});

test('reading a real courier tracking page is a browser-primitive job', () => {
  assert.match(nativeDescriptions().create_scheduled_task.description, /use browser_open to read the REAL current page/);
});

test('the browser primitives are offered for every kind of web task, not one', () => {
  const desc = nativeDescriptions().browser_open.description;
  for (const task of ['cancelling something', 'a form or application', 'account settings', 'a portal']) {
    assert.ok(desc.includes(task), `browser_open must offer "${task}"`);
  }
});

test('morning digest: daily_digest is steered to compose rather than have the model stitch sources itself', () => {
  const desc = nativeDescriptions().daily_digest.description;
  assert.match(desc, /what do I need to know today\?/);
  assert.match(desc, /what's on my plate\?/);
  assert.match(desc, /Always call this rather than separately calling get_calendar_events, find_reply_needed and find_occasions/);
  assert.match(desc, /ranks them against each other so the user does not have to triage the answer/);
});

test('morning digest: follow-ups are steered at the real refs, and coverage gaps must be admitted', () => {
  const desc = nativeDescriptions().daily_digest.description;
  assert.match(desc, /Each item carries a ref \(threadId, scheduledTaskId, personName, briefingId\)/);
  assert.match(desc, /"draft the reply to Mia" is send_email with that item's thread_id/);
  assert.match(desc, /a source it could not check, say so plainly/);
  assert.match(desc, /do not invent urgency the result does not claim/);
});

test('morning digest: a recurring brief must recompute, never store a copy of today\'s text', () => {
  const desc = nativeDescriptions().daily_digest.description;
  assert.match(desc, /recurrence "daily"/);
  assert.match(desc, /never store a copy of today's digest text as the instruction/);
  assert.match(desc, /each morning must be recomputed from that morning's real state/);
});

test('calendar read-vs-write: the write-only guidance survives, and the read action has no such restriction', () => {
  const decls = nativeDescriptions();
  assert.match(decls.create_calendar_event.description, /Never use for read-only calendar language/);
  assert.match(decls.create_outlook_event.description, /Never use for read-only calendar language/);
  // get_calendar_events has no guidance field by design — it's a plain read, nothing to warn
  // about — so its description should NOT pick up the write-side restriction by accident.
  assert.doesNotMatch(decls.get_calendar_events.description, /read-only calendar language/);
});

test('trains vs directions: search_trains/plan_trip defer to grounded search, get_directions covers generic routes', () => {
  const decls = nativeDescriptions();
  assert.match(decls.search_trains.description, /prefer a grounded search answer/i);
  assert.match(decls.plan_trip.description, /Prefer a grounded search answer over this/);
  assert.match(decls.get_directions.description, /generic local directions, walking, driving, and bus questions/);
  assert.match(decls.get_directions.description, /Never pretend a route opened if all you have is a text answer/);
});

test('calendar beats music: create_calendar_event/create_outlook_event warn against the play_music/add_to_music_playlist mixup', () => {
  const decls = nativeDescriptions();
  assert.match(decls.create_calendar_event.description, /Calendar beats music/);
  assert.match(decls.create_outlook_event.description, /Calendar beats music/);
});

test('music: play_music requires search-grounded resolution for trending/chart queries; add_to_music_playlist is distinguished from playback', () => {
  const decls = nativeDescriptions();
  assert.match(decls.play_music.description, /first resolve the exact title\/artist via search grounding/);
  assert.match(decls.add_to_music_playlist.description, /use play_music instead for immediate playback/);
});

test('find_place: natural-phrase place lookup, never product search/shopping', () => {
  const decls = nativeDescriptions();
  assert.match(decls.find_place.description, /do not ask for a full address or branch details/);
  assert.match(decls.find_place.description, /Never use this for product searches, price lookups, or online shopping/);
});


test('book_uber: natural destination phrase, never an invented address', () => {
  const decls = nativeDescriptions();
  assert.match(decls.book_uber.description, /never invent a branch address/);
});

test('conversational messaging register: send_message and send_telegram both carry it', () => {
  const decls = nativeDescriptions();
  assert.match(decls.send_message.description, /Never paste a "saying X" clause verbatim/);
  assert.match(decls.send_telegram.description, /Never paste a "saying X" clause verbatim/);
});

test('forget_memory: explicit guidance for scope "recent" vs "all"', () => {
  const decls = nativeDescriptions();
  assert.match(decls.forget_memory.description, /use scope "recent" unless they clearly mean all memory/);
});

test('email drafting: send_email guidance survives natively, plus the body/tone parameter hints', () => {
  const decls = nativeDescriptions();
  assert.match(decls.send_email.description, /Do not ask for a subject/);
  assert.match(decls.send_email.description, /Do not use stiff cliches/);
  assert.match(decls.send_email.description, /Match both the user tone and the thread formality/);
  assert.match(decls.send_email.parameters.properties.body.description, /never a terse literal fragment/);
  assert.match(decls.send_email.parameters.properties.tone.description, /casual, warm, professional/);
});

test('email tone guidance (moved from the static prompt): cliches, requested tone, placeholder safety net, on both user-identity email tools', () => {
  const decls = nativeDescriptions();
  for (const type of ['send_email', 'send_outlook_email']) {
    assert.match(decls[type].description, /avoid empty cliches like "I hope this email finds you well"/, `${type} missing cliche guidance`);
    assert.match(decls[type].description, /casual, friendly, firm, apologetic, confident, less desperate, short, professional/, `${type} missing tone list`);
    assert.match(decls[type].description, /never send a placeholder or generic template body/, `${type} missing placeholder safety net`);
  }
});

test('default identity selection: Millie-identity vs personal-mailbox guidance survives natively on all four contracts', () => {
  const decls = nativeDescriptions();
  assert.match(decls.send_millie_email.description, /business, support line, restaurant/);
  assert.match(decls.send_millie_sms.description, /business, support line, restaurant/);
  assert.match(decls.send_email.description, /personal correspondence where the sender should clearly be the user/);
  assert.match(decls.send_outlook_email.description, /personal correspondence where the sender should clearly be the user/);
  assert.match(decls.send_message.description, /always their own identity, never Millie's/);
});

test('project actions: all 7 project_* guidance strings survive natively, including the destructive-action warnings', () => {
  const decls = nativeDescriptions();
  assert.match(decls.project_status.description, /Use before editing or reporting project progress/);
  assert.match(decls.project_diff.description, /Never claim code changed without checking this/);
  assert.match(decls.project_write.description, /never invent a project or use an absolute path/);
  assert.match(decls.project_check.description, /Use check=test by default/);
  assert.match(decls.project_check.parameters.properties.check.description, /test\|release/);
  assert.match(decls.project_commit.description, /does not publish or merge anything/);
  assert.match(decls.project_rollback.description, /destructive and requires explicit approval/);
  assert.match(decls.project_sync.description, /Never merge or push the default branch/);
});

test('every money-moving action is review-gated server-side, independent of any prompt text', () => {
  const decls = nativeDescriptions();
  assert.match(decls.transaction_authorize.description, /explicitly agreed to the amount/);
  const moneyActions = [
    'spend_from_concierge_account', 'top_up_concierge_account', 'receive_to_concierge_account',
    'fund_opportunity', 'stripe_charge', 'stripe_payout_to_user', 'spend_from_concierge_via_stripe'
  ];
  for (const type of moneyActions) {
    assert.equal(getActionContract(type).executionMode, 'review', `${type} must still be review-gated after the prompt catalogue is removed`);
  }
});

// ── New parameter hints: bounded, justified, not a blanket copy of all 142 example values ──
test('format/enum parameter hints were added only where a wrong value breaks argument construction', () => {
  const decls = nativeDescriptions();
  const expected = {
    create_reminder: { due_date: 'ISO date' },
    create_calendar_event: { start_date: 'ISO date', end_date: 'ISO date' },
    create_outlook_event: { start_date: 'ISO date', end_date: 'ISO date' },
    get_directions: { mode: 'driving|walking|transit' },
    plan_trip: { preference: 'balanced|fastest|fewest_changes' },
    forget_memory: { scope: 'recent|all' },
    project_check: { check: 'test|release' },
    create_agent_task: { autonomy: 'Active|High' },
    github_action: { action: 'status|create_issue' },
    // Unavailable device/photo capabilities are intentionally absent from model tools.
  };
  for (const [type, params] of Object.entries(expected)) {
    for (const [param, hint] of Object.entries(params)) {
      assert.match(
        decls[type].parameters.properties[param].description,
        new RegExp(hint.replace(/[|]/g, '\\|')),
        `${type}.${param} should carry its format/enum hint`
      );
    }
  }
});

test('trivial inputExample values were NOT promoted to parameter descriptions', () => {
  // The point of being selective: contact/message/query-shaped placeholders that just restate
  // the key name add nothing a capable model doesn't already infer from "contact (required)".
  const decls = nativeDescriptions();
  assert.equal(decls.send_message.parameters.properties.contact.description, 'contact (required)');
  assert.equal(decls.send_message.parameters.properties.message.description, 'message (required)');
  assert.equal(decls.play_music.parameters.properties.query.description, 'query (required)');
});

test('every native declaration still has a name, a non-empty description, and an OBJECT parameter schema', () => {
  const decls = buildToolsForGemini(false)[0].functionDeclarations;
  assert.equal(decls.length, Object.values(ACTION_CONTRACTS).filter(contract => contract.modelVisible !== false && contract.availability !== 'unavailable').length);
  for (const decl of decls) {
    assert.ok(decl.name);
    assert.ok(decl.description && decl.description.length > 0, `${decl.name} has an empty description`);
    assert.equal(decl.parameters.type, 'OBJECT');
  }
});

test('people layer: find_people is steered at resolution before acting, not just at direct questions', () => {
  const desc = nativeDescriptions().find_people.description;
  assert.match(desc, /who is Mia again\?/);
  assert.match(desc, /"email my manager" \(resolve the real address first — never guess a recipient\)/);
  assert.match(desc, /any "her"\/"him"\/"them" that refers to a person you do not already have/);
  assert.match(desc, /If it comes back ambiguous, ask which person rather than picking one/);
  assert.match(desc, /do not invent a relationship or an address/);
});

test('people layer: remember_person teaches handle-first identity and refuses to guess between namesakes', () => {
  const desc = nativeDescriptions().remember_person.description;
  assert.match(desc, /An email address or phone number is the strong identity signal/);
  assert.match(desc, /resolve to one person instead of three/);
  assert.match(desc, /this refuses and returns the candidates rather than guessing/);
  assert.match(desc, /different_person:true only if the user says it is someone new/);
});

test('people layer: capture is bounded — stated facts and task-relevant ones, not everything extractable', () => {
  const desc = nativeDescriptions().remember_person.description;
  assert.match(desc, /never interrogate the user for contact details or hoover up private facts/);
  assert.match(desc, /not everything that could be extracted/);
});

test('people layer: a correction is one call, and forgetting removes the narrowest thing', () => {
  const remember = nativeDescriptions().remember_person.description;
  assert.match(remember, /"Alisa prefers gold, not silver" is ONE call with facts:"prefers gold" and replaces:"silver"/);
  const forget = nativeDescriptions().forget_person_detail.description;
  assert.match(forget, /Remove the narrowest thing the user asked to remove — never delete a whole person to drop one fact/);
});

test('spend: find_spend must never let a total be relayed as complete spending', () => {
  const desc = nativeDescriptions().find_spend.description;
  assert.match(desc, /Relay the returned figure and its caveat TOGETHER/);
  assert.match(desc, /There is no bank or card feed in this product/);
  assert.match(desc, /card and cash purchases without an emailed receipt are genuinely invisible/);
});

test('spend: unreadable totals, currencies and categories are never filled in with a guess', () => {
  const desc = nativeDescriptions().find_spend.description;
  assert.match(desc, /do not fill them in with a plausible number/);
  assert.match(desc, /Different currencies are never converted or added together/);
  assert.match(desc, /cannot be classified confidently, say which records were excluded rather than guessing/);
});

test('watches: a general watch is told to record what it observed, not to judge for itself', () => {
  const desc = nativeDescriptions().record_watch_observation.description;
  assert.match(desc, /with what you ACTUALLY observed on the real source this run/);
  assert.match(desc, /never a remembered value, never an assumption that nothing changed/);
  assert.match(desc, /relay that verdict, do not overrule it/);
  assert.match(desc, /a watch that silently reports "unchanged" while it is actually broken is worse/);
});

test('watches: create_scheduled_task covers thresholds, target states and recurring checks', () => {
  const desc = nativeDescriptions().create_scheduled_task.description;
  assert.match(desc, /a stated number is a threshold watch/);
  assert.match(desc, /a stated end state \("back in stock"\) is target_state/);
  assert.match(desc, /an open question re-answered on a cadence is watch_type "recurring_check"/);
  assert.match(desc, /Do not invent a threshold or a cadence the user did not give/);
  assert.match(desc, /Repeating a watch the user already has adjusts the existing one/);
});

test('watches: editing is steered away from delete-and-recreate, which would lose the baseline', () => {
  const desc = nativeDescriptions().update_scheduled_task.description;
  assert.match(desc, /Always prefer this over cancelling and re-creating/);
  assert.match(desc, /a new watch has no baseline/);
  assert.match(desc, /If more than one watch matches the title, it asks which — do not guess/);
});

test('watches: the watch list must report a failing check rather than implying health', () => {
  const desc = nativeDescriptions().list_scheduled_tasks.description;
  assert.match(desc, /what are you watching for me\?/);
  assert.match(desc, /If a watch reports lastCheckFailed, say so plainly/);
});

test('travel: search_flights is described as a real search whose prices are observed, not held', () => {
  const desc = nativeDescriptions().search_flights.description;
  assert.match(desc, /performs a REAL web search/);
  assert.match(desc, /Prices are OBSERVED IN SEARCH RESULTS, not held quotes or confirmed availability/);
  // (The date rule itself moved to a three-way dateMatch grade; asserted in its own test.)
  assert.match(desc, /Never claim a flight is bookable or available/);
  // The old text told the model this tool was fake. That must be gone.
  assert.doesNotMatch(desc, /only opens a flight-search page as a link/);
});

test('travel: search_hotels claims availability only when the source stated it', () => {
  const desc = nativeDescriptions().search_hotels.description;
  assert.match(desc, /performs a REAL web search/);
  assert.match(desc, /availability is only claimed when availabilityStated is true/);
  assert.match(desc, /Never present a generic list of well-known hotels as a search result/);
  assert.doesNotMatch(desc, /only opens a hotel-search page as a link/);
});

test('travel: plan_itinerary now composes with the real searches instead of avoiding them', () => {
  const desc = nativeDescriptions().plan_itinerary.description;
  assert.match(desc, /call search_flights and\/or search_hotels FIRST and plan around what they actually return/);
  assert.match(desc, /carry their "observed, not held" caveat into the plan/);
  assert.doesNotMatch(desc, /they only build a browser link and return no real prices/);
});

test('notifications: the user is never told a message will arrive on a channel that cannot send', () => {
  const desc = nativeDescriptions().set_notification_preference.description;
  assert.match(desc, /Relay the returned `unavailable` list honestly/);
  assert.match(desc, /rather than implying it will arrive there/);
  assert.match(desc, /Do not invent channels: only push, email, Telegram and the in-app card exist/);
});

test('notifications: an explicit channel preference is exclusive unless a fallback is set', () => {
  const desc = nativeDescriptions().set_notification_preference.description;
  assert.match(desc, /it does NOT silently fall back to whatever else happens to be configured/);
  assert.match(desc, /"Telegram only" actually means only Telegram/);
  assert.match(desc, /Never set both category and urgency in the same call/);
});

test('commitments: capture is steered conservative, and deadlines are never invented', () => {
  const desc = nativeDescriptions().track_commitment.description;
  assert.match(desc, /an undertaking plus a CONCRETE action is a commitment/);
  assert.match(desc, /"I'll have a look", "I might", "I'll try to" are not, and must not be tracked/);
  assert.match(desc, /Never invent a deadline/);
  assert.match(desc, /a wrong date turns into a wrong "overdue"/);
  assert.match(desc, /never from merely reading their inbox/);
});

test('commitments: resolution requires real evidence, never staleness', () => {
  const desc = nativeDescriptions().resolve_commitment.description;
  assert.match(desc, /Only resolve on real evidence/);
  assert.match(desc, /a silently-wrong "done" is worse than a reminder they do not need/);
});

test('commitments: a sent email containing a promise is captured after it is actually sent', () => {
  const desc = nativeDescriptions().send_email.description;
  assert.match(desc, /call track_commitment straight after it is actually sent/);
  assert.match(desc, /Only for a real undertaking with a concrete action/);
});

test('calendar: availability is never invented when the calendar cannot be read', () => {
  const desc = nativeDescriptions().find_free_time.description;
  assert.match(desc, /It subtracts the user's REAL events from their working window/);
  assert.match(desc, /it never proposes time it has not checked/);
  assert.match(desc, /a slot that turns out to be double-booked is worse than no answer/);
});

test('calendar: booking refuses to double-book, duplicate or book blind', () => {
  const desc = nativeDescriptions().schedule_block.description;
  assert.match(desc, /it refuses to book blind if the calendar cannot be read/);
  assert.match(desc, /will not double-book without allow_conflict/);
  assert.match(desc, /will not create a second copy of a block that is already there/);
  assert.match(desc, /Adding attendees sends a REAL invitation/);
});

test('calendar: replanning modifies the event instead of leaving the old time behind', () => {
  const desc = nativeDescriptions().move_calendar_event.description;
  assert.match(desc, /This MODIFIES the existing event/);
  assert.match(desc, /never create a new one to reschedule/);
  assert.match(desc, /If more than one event matches the description, it asks which/);
});

test('travel: only an exact date match may be presented as satisfying the request', () => {
  const desc = nativeDescriptions().search_flights.description;
  assert.match(desc, /dateMatch: "exact" means the source quoted that price FOR the requested dates/);
  assert.match(desc, /only "exact" may be presented as satisfying the request/);
  assert.match(desc, /give the closest sourced one as the closest, not as an answer/);
  assert.match(desc, /prices in different currencies are never compared or added/);
});

test('travel: hotel availability and stay dates carry the same rule', () => {
  const desc = nativeDescriptions().search_hotels.description;
  assert.match(desc, /only "exact" was quoted for the requested stay/);
  assert.match(desc, /neither may be offered as the price for those nights/);
});

test('travel: trip budgets may only rest on exact-date prices', () => {
  const desc = nativeDescriptions().plan_itinerary.description;
  assert.match(desc, /Budget arithmetic may only use options whose dateMatch is "exact"/);
  assert.match(desc, /evidence about the route, not the price of this trip/);
});
