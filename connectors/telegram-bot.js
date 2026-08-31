const crypto = require('crypto');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');

// This is a genuine Telegram Bot (BotFather / Bot API), Adam's own identity on Telegram —
// distinct from connectors/telegram.js, which logs into the USER'S OWN Telegram account via
// MTProto. That connector sends as the user, to the user's own contacts; this one lets the
// user talk to Adam directly from their Telegram app, the same conversation as the iOS chat.
const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('telegram bot connector bootstrap');

const API_BASE = 'https://api.telegram.org';
const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;

function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN env var is not set');
  return token;
}

async function callBotApi(method, payload = {}) {
  const res = await fetch(`${API_BASE}/bot${botToken()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) {
    throw new Error(`Telegram Bot API ${method} failed: ${data?.description || res.status}`);
  }
  return data.result;
}

function sendMessage(chatId, text, { replyMarkup = null } = {}) {
  const payload = { chat_id: chatId, text: String(text ?? '').slice(0, 4096) };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return callBotApi('sendMessage', payload);
}

function answerCallbackQuery(callbackQueryId, { text = '' } = {}) {
  return callBotApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// Cosmetic only — a failure here must never block or delay the actual reply.
function sendChatAction(chatId, action = 'typing') {
  return callBotApi('sendChatAction', { chat_id: chatId, action }).catch(() => null);
}

// Best-effort cosmetic cleanup (strips the Confirm/Cancel buttons after a tap) — a failure
// here must never block the actual reply from reaching the user.
function clearInlineKeyboard(chatId, messageId) {
  return callBotApi('editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] }
  }).catch(() => null);
}

function setWebhook(url, secretToken) {
  return callBotApi('setWebhook', { url, secret_token: secretToken });
}

function deleteWebhook() {
  return callBotApi('deleteWebhook', {});
}

// ── Account linking ───────────────────────────────────────────────────────────

// Opaque + random rather than a signed JWT: Telegram's /start deep-link parameter is capped
// at 64 characters from [A-Za-z0-9_-], which a signed JSON payload + HMAC cannot fit into.
// Stored server-side so it also works correctly across multiple app instances.
async function createLinkToken(userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  const { error } = await supabase.from('telegram_bot_link_tokens').insert({
    token,
    user_id: userId,
    expires_at: new Date(Date.now() + LINK_TOKEN_TTL_MS).toISOString()
  });
  if (error) throw error;
  return token;
}

// Single-use: the token row is deleted the moment it's redeemed, whether or not the link
// itself succeeds, so a leaked/replayed token can't be used twice.
async function redeemLinkToken(token) {
  const { data, error } = await supabase
    .from('telegram_bot_link_tokens')
    .select('user_id, expires_at')
    .eq('token', token)
    .maybeSingle();
  if (error || !data) return null;
  await supabase.from('telegram_bot_link_tokens').delete().eq('token', token);
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.user_id;
}

async function getLink(userId) {
  const { data, error } = await supabase
    .from('telegram_bot_links')
    .select('chat_id, telegram_user_id, username')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return { chatId: data.chat_id, telegramUserId: data.telegram_user_id, username: data.username };
}

async function findUserIdByChatId(chatId) {
  const { data, error } = await supabase
    .from('telegram_bot_links')
    .select('user_id')
    .eq('chat_id', String(chatId))
    .maybeSingle();
  if (error || !data) return null;
  return data.user_id;
}

async function saveLink(userId, { chatId, telegramUserId = null, username = null }) {
  const { error } = await supabase.from('telegram_bot_links').upsert({
    user_id: userId,
    chat_id: String(chatId),
    telegram_user_id: telegramUserId != null ? String(telegramUserId) : null,
    username: username || null,
    linked_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

// ── Pure helpers (no IO) — kept here so they're unit-testable without a live bot/DB ────────

// Telegram sends "/start" with no payload for an organic tap, and "/start <payload>" for a
// deep link — only the latter carries our link token.
function parseStartCommand(text) {
  const match = String(text || '').match(/^\/start(?:\s+(\S+))?/);
  if (!match) return null;
  return { token: match[1] || null };
}

// Mirrors what the iOS ConfirmCard is reacting to: an action result marked pending review
// (buildPendingReviewResult in pending-review.js sets both of these).
function findPendingAction(actionResults = []) {
  return actionResults.find(entry => (
    entry?.result?.pending === true || entry?.result?.outcome === 'awaiting_user'
  )) || null;
}

function needsConfirmationButtons(actionResults = []) {
  return findPendingAction(actionResults) !== null;
}

// The top-level reply text can fall back to a raw dump of tool results when the model calls a
// tool with no prose. iOS renders the per-action cardText instead; with no card UI here,
// Telegram has to read those same per-action fields rather than the aggregate text.
function describePendingAction(pendingEntry) {
  const prompt = pendingEntry?.result?.text || 'Ready for review.';
  const detail = pendingEntry?.result?.cardText;
  return detail ? `${detail}\n\n${prompt}` : prompt;
}

module.exports = {
  sendMessage,
  answerCallbackQuery,
  sendChatAction,
  clearInlineKeyboard,
  setWebhook,
  deleteWebhook,
  createLinkToken,
  redeemLinkToken,
  getLink,
  findUserIdByChatId,
  saveLink,
  parseStartCommand,
  findPendingAction,
  needsConfirmationButtons,
  describePendingAction,
  _private: { callBotApi }
};
