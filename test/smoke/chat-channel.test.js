const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TELEGRAM_BOT_CHANNEL,
  adaptActionForChannel,
  buildChatChannelContext,
  buildTelegramChatRequest
} = require('../../api/services/chat-channel');

test('Telegram bot bridge declares the channel to the shared chat pipeline', () => {
  assert.deepEqual(buildTelegramChatRequest('user-1', 'Can you text Arina'), {
    userId: 'user-1',
    message: 'Can you text Arina',
    channel: TELEGRAM_BOT_CHANNEL
  });
});

test('an unqualified personal message on Telegram uses the Telegram connector', () => {
  const action = adaptActionForChannel(
    { type: 'send_message', input: { contact: 'Arina', message: 'Hello.' } },
    { channel: TELEGRAM_BOT_CHANNEL, userMessage: 'Can you text Arina' }
  );
  assert.equal(action.type, 'send_telegram');
  assert.deepEqual(action.input, { contact: 'Arina', message: 'Hello.' });
});

test('explicit native messaging requests stay on the native action', () => {
  for (const userMessage of ['Send Arina an SMS', 'Use iMessage for Arina', 'Open the Messages app']) {
    const action = adaptActionForChannel(
      { type: 'send_message', input: { contact: 'Arina', message: 'Hello.' } },
      { channel: TELEGRAM_BOT_CHANNEL, userMessage }
    );
    assert.equal(action.type, 'send_message', userMessage);
  }
});

test('explicit WhatsApp and Telegram actions are not rewritten', () => {
  const whatsapp = adaptActionForChannel(
    { type: 'send_message', input: { contact: 'Arina', message: 'Hello.', platform: 'whatsapp' } },
    { channel: TELEGRAM_BOT_CHANNEL, userMessage: 'Message Arina on WhatsApp' }
  );
  assert.equal(whatsapp.type, 'send_message');

  const telegram = adaptActionForChannel(
    { type: 'send_telegram', input: { contact: 'Arina', message: 'Hello.' } },
    { channel: TELEGRAM_BOT_CHANNEL, userMessage: 'Send Arina a Telegram message' }
  );
  assert.equal(telegram.type, 'send_telegram');
});

test('Telegram channel context is explicit for model turns and absent elsewhere', () => {
  assert.match(buildChatChannelContext(TELEGRAM_BOT_CHANNEL), /unqualified request.*Telegram/i);
  assert.equal(buildChatChannelContext(null), '');
});
