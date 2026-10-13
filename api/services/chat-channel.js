'use strict';

const TELEGRAM_BOT_CHANNEL = 'telegram_bot';
const HOME_DEVICE_CHANNEL = 'home_device';

// "Text" is ordinary conversational language, so on a Telegram conversation it means
// use the channel the person is already in. Keep explicit native-channel requests on the
// native action instead of silently changing the user's chosen medium.
const EXPLICIT_NATIVE_MESSAGE_CHANNEL = /\b(?:sms|i\s*message|messages\s+app|text\s+message|phone\s+message)\b/i;

function normalizeChatChannel(value) {
  const channel = String(value || '').trim().toLowerCase();
  return channel || null;
}

function adaptActionForChannel(action, context = {}) {
  if (
    normalizeChatChannel(context.channel) !== TELEGRAM_BOT_CHANNEL ||
    action?.type !== 'send_message' ||
    action.input?.platform ||
    EXPLICIT_NATIVE_MESSAGE_CHANNEL.test(String(context.userMessage || ''))
  ) {
    return action;
  }

  return { ...action, type: 'send_telegram' };
}

function buildTelegramChatRequest(userId, message) {
  return { userId, message, channel: TELEGRAM_BOT_CHANNEL };
}

function buildDisplayChatRequest(userId, message) {
  return { userId, message, channel: 'display' };
}

function buildHomeDeviceChatRequest(userId, message) {
  return { userId, message, channel: HOME_DEVICE_CHANNEL };
}

function buildChatChannelContext(channel) {
  if (normalizeChatChannel(channel) === HOME_DEVICE_CHANNEL) {
    return `CURRENT CONVERSATION CHANNEL: Adam's home device. The person spoke to a device in a room and your reply will be read aloud there, possibly with other people present.
Answer in one or two short spoken sentences: no lists, links, markdown or symbols. Do not read out private details (message contents, amounts, addresses) unless the person asked for them. Anything needing approval is approved on the phone; say it is waiting there.`;
  }
  if (normalizeChatChannel(channel) !== TELEGRAM_BOT_CHANNEL) return '';
  return `CURRENT CONVERSATION CHANNEL: Telegram.
For an unqualified request to message a personal contact, use Telegram through the user's connected Telegram account. Do not use the native phone Messages action unless the user explicitly asks for SMS, iMessage, or another native phone channel.`;
}

module.exports = {
  TELEGRAM_BOT_CHANNEL,
  HOME_DEVICE_CHANNEL,
  buildHomeDeviceChatRequest,
  normalizeChatChannel,
  adaptActionForChannel,
  buildTelegramChatRequest,
  buildDisplayChatRequest,
  buildChatChannelContext,
  _private: { EXPLICIT_NATIVE_MESSAGE_CHANNEL }
};
