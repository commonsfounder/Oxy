// Unit coverage for the parts of connectors/telegram-bot.js that don't need a live bot token
// or a real database: the pure /start-parsing and confirm-button decisions, and the Bot API
// HTTP wrapper's success/error handling (mocked fetch, since Bot API is plain HTTPS — unlike
// connectors/telegram.js's gramJS/MTProto client, which the existing telegram-connector.test.js
// deliberately leaves unmocked). The linking/lookup functions need a real Supabase connection
// and are exercised live once a real BotFather token + webhook are configured.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';

const telegramBot = require('../../connectors/telegram-bot');
const { parseStartCommand, needsConfirmationButtons, findPendingAction, describePendingAction, _private } = telegramBot;

test('an organic /start with no payload carries no link token', () => {
  assert.deepEqual(parseStartCommand('/start'), { token: null });
});

test('a deep-linked /start carries its token', () => {
  assert.deepEqual(parseStartCommand('/start abc123XYZ_-'), { token: 'abc123XYZ_-' });
});

test('ordinary chat text is not a /start command at all', () => {
  assert.equal(parseStartCommand('hello there'), null);
  assert.equal(parseStartCommand(''), null);
  assert.equal(parseStartCommand(undefined), null);
});

test('a pending review-gated action asks for confirm buttons', () => {
  const actions = [{ action: 'send_email', result: { success: false, pending: true, outcome: 'awaiting_user' } }];
  assert.equal(needsConfirmationButtons(actions), true);
});

test('a completed action needs no buttons', () => {
  const actions = [{ action: 'get_calendar_events', result: { success: true } }];
  assert.equal(needsConfirmationButtons(actions), false);
});

test('no actions at all needs no buttons', () => {
  assert.equal(needsConfirmationButtons([]), false);
  assert.equal(needsConfirmationButtons(undefined), false);
});

// ── describePendingAction: this is the fix for a real bug found live — when the model calls
// a tool with no accompanying prose, /chat's aggregate `text` falls back to a raw JSON dump
// of tool results (agent-orchestrator.js's spoken || lastToolResultsText). The iOS app never
// shows that because ConfirmCard renders the per-action cardText/text fields instead; Telegram
// has no separate card UI, so it must read those same clean fields directly. ──────────────────
test('a pending action with card detail shows both the detail and the prompt', () => {
  const entry = { action: 'send_telegram', result: { pending: true, text: 'Check the details, then tap Confirm or Cancel.', cardText: 'Arina · Hey' } };
  assert.equal(describePendingAction(entry), 'Arina · Hey\n\nCheck the details, then tap Confirm or Cancel.');
});

test('a pending action with no card detail falls back to the prompt alone', () => {
  const entry = { action: 'book_uber', result: { pending: true, text: 'Check the ride, then tap Book.' } };
  assert.equal(describePendingAction(entry), 'Check the ride, then tap Book.');
});

test('a pending action missing even its own text still gets a sane default, never the raw fallback', () => {
  assert.equal(describePendingAction({ result: {} }), 'Ready for review.');
  assert.equal(describePendingAction(null), 'Ready for review.');
});

test('findPendingAction returns the actual entry, not just a boolean', () => {
  const pending = { action: 'send_telegram', result: { pending: true, text: 'hi' } };
  const done = { action: 'get_calendar_events', result: { success: true } };
  assert.equal(findPendingAction([done, pending]), pending);
  assert.equal(findPendingAction([done]), null);
});

// ── callBotApi: the thin wrapper other exports build on ─────────────────────────────────
test('callBotApi returns .result on a genuine ok response', async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  global.fetch = async (url, opts) => {
    assert.equal(url, 'https://api.telegram.org/bottest-token/sendMessage');
    assert.equal(JSON.parse(opts.body).chat_id, 42);
    return { json: async () => ({ ok: true, result: { message_id: 7 } }) };
  };
  try {
    const result = await _private.callBotApi('sendMessage', { chat_id: 42 });
    assert.deepEqual(result, { message_id: 7 });
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});

test('callBotApi surfaces Telegram\'s own error description on failure', async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  global.fetch = async () => ({ json: async () => ({ ok: false, description: 'chat not found' }) });
  try {
    await assert.rejects(
      () => _private.callBotApi('sendMessage', { chat_id: 999 }),
      /chat not found/
    );
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});

test('callBotApi refuses to call out at all with no bot token configured', async () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    await assert.rejects(() => _private.callBotApi('sendMessage', {}), /TELEGRAM_BOT_TOKEN/);
  } finally {
    if (originalToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});
