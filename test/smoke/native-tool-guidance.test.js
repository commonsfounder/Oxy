// Phase 2/3: actionPromptBlock() — 82 tool contracts re-serialised as JSON inside the system
// prompt, ~29KB on top of everything else there — is no longer part of the live prompt.
// Native function declarations are now the SOLE model-facing capability definitions.
//
// Before removing it, the genuinely useful fields (risk, the 18 guidance strings, a handful of
// format/enum parameter hints) were confirmed already present — or newly added — in
// actionToFunctionDeclaration()'s native output. These tests prove three things: the dead text
// is gone from the live prompt, the useful guidance survived the move, and nothing that governs
// real safety (review gating) was ever sourced from the prompt text in the first place.

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
  for (const type of ['workspace_write', 'project_rollback', 'confirm_credential_use', 'stripe_payout_to_user']) {
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
// (33 contracts carry a `guidance` field in total — 22 from earlier phases, plus 10 added
// 2026-08-07 (commit 1) when the prompt restructure moved tool-specific disambiguation rules —
// trains vs directions, music vs calendar, place vs shopping, messaging register, email tone,
// forget_memory scope — out of the numbered static prompt and onto the tool they actually
// govern, plus 1 more added 2026-08-07 (commit 2) on create_agent_task, the ownership mechanism.)
test('exactly 33 contracts define guidance, and every one appears verbatim in its native description', () => {
  const withGuidance = Object.entries(ACTION_CONTRACTS).filter(([, c]) => c.guidance);
  assert.equal(withGuidance.length, 33);
  const decls = nativeDescriptions();
  for (const [type, contract] of withGuidance) {
    assert.ok(decls[type], `${type} has no native declaration at all`);
    assert.ok(
      decls[type].description.includes(contract.guidance),
      `${type}'s guidance did not survive verbatim into its native description`
    );
  }
});

test('browser purchases: run_browser_task, confirm_browser_payment guidance survives natively', () => {
  const decls = nativeDescriptions();
  assert.match(decls.run_browser_task.description, /NEVER call confirm_browser_payment yourself/);
  assert.match(decls.run_browser_task.description, /only after the user explicitly agrees to the price/);
  assert.match(decls.confirm_browser_payment.description, /Only call this after the user has explicitly said yes to the price/);
});

test('credentials: run_browser_task and confirm_credential_use guidance survives natively', () => {
  const decls = nativeDescriptions();
  assert.match(decls.run_browser_task.description, /pass credentialSites as an array/);
  assert.match(decls.confirm_credential_use.description, /Only call this after the user has explicitly said yes to using their saved credential/);
  // The array-format rule ALSO lives on the credentialSites parameter itself now, not only in
  // tool-level prose — the exact fix for the "genuinely needed for argument construction" bar.
  assert.match(decls.run_browser_task.parameters.properties.credentialSites.description, /array of site domains/);
});

test('scheduled watches: create_scheduled_task and cancel_scheduled_task guidance survives natively', () => {
  const decls = nativeDescriptions();
  assert.match(decls.create_scheduled_task.description, /Never invent a schedule or silently turn an ordinary task into recurring work/);
  assert.match(decls.cancel_scheduled_task.description, /Cancel only the matching background watch/);
});

test('calendar read-vs-write: the write-only guidance survives, and the read action has no such restriction', () => {
  const decls = nativeDescriptions();
  assert.match(decls.create_calendar_event.description, /Never use for read-only calendar language/);
  assert.match(decls.create_outlook_event.description, /Never use for read-only calendar language/);
  // get_calendar_events has no guidance field by design — it's a plain read, nothing to warn
  // about — so its description should NOT pick up the write-side restriction by accident.
  assert.doesNotMatch(decls.get_calendar_events.description, /read-only calendar language/);
});

// ── Phase 6 (2026-08-07): disambiguation rules moved out of the numbered static prompt onto
// the tool they actually govern, when the rule was about constructing/choosing THAT tool's call
// rather than general behaviour. ────────────────────────────────────────────────────────────
test('trains vs directions: search_trains/station_board/plan_trip defer to grounded search, get_directions covers generic routes', () => {
  const decls = nativeDescriptions();
  assert.match(decls.search_trains.description, /Prefer a grounded search answer over this/);
  assert.match(decls.station_board.description, /Prefer a grounded search answer over this/);
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

test('run_browser_task: price-correction guidance re-checks the same retailer', () => {
  const decls = nativeDescriptions();
  assert.match(decls.run_browser_task.description, /always re-check the exact same retailer\/site that produced the previous price/);
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

test('payment confirmation: confirm_browser_payment guidance survives, and review gating does not depend on it', () => {
  const decls = nativeDescriptions();
  assert.match(decls.confirm_browser_payment.description, /explicitly said yes to the price/);
  // confirm_browser_payment is intentionally executionMode:'direct' — the human review already
  // happened on the PRIOR turn's run_browser_task result. The actual money-moving actions are
  // what must be review-gated, and that gate is server-side, independent of any prompt text.
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
    log_health: { metric: 'steps|heart_rate' },
    control_smart_home: { device: 'lights|thermostat', command: 'on|off|set 22' },
    github_action: { action: 'status|create_issue' },
    edit_photo: { brief: 'enhance|crop|filter' }
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
  assert.equal(decls.length, Object.keys(ACTION_CONTRACTS).length);
  for (const decl of decls) {
    assert.ok(decl.name);
    assert.ok(decl.description && decl.description.length > 0, `${decl.name} has an empty description`);
    assert.equal(decl.parameters.type, 'OBJECT');
  }
});
