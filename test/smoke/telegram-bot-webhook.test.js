// The one thing about /webhooks/telegram-bot that's safely testable without a live bot token,
// a real database, or mocking the internal /chat bridge: the webhook secret check. Everything
// past that point touches Supabase and Telegram's real API, and is exercised live once a real
// BotFather token + webhook are configured (see scripts/setup-telegram-bot-webhook.js).

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-session-secret';

const app = require('../../api/index');

function withServer(fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        resolve(await fn(`http://127.0.0.1:${port}`));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('a webhook call with the wrong secret token is rejected before anything else runs', async () => {
  const originalSecret = process.env.TELEGRAM_BOT_WEBHOOK_SECRET;
  process.env.TELEGRAM_BOT_WEBHOOK_SECRET = 'the-real-secret';
  try {
    await withServer(async baseURL => {
      const res = await fetch(`${baseURL}/webhooks/telegram-bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
        body: JSON.stringify({ message: { chat: { id: 1 }, text: 'hi' } })
      });
      assert.equal(res.status, 401);
    });
  } finally {
    if (originalSecret === undefined) delete process.env.TELEGRAM_BOT_WEBHOOK_SECRET;
    else process.env.TELEGRAM_BOT_WEBHOOK_SECRET = originalSecret;
  }
});

test('the right secret token is accepted (ack is immediate, independent of downstream work)', async () => {
  const originalSecret = process.env.TELEGRAM_BOT_WEBHOOK_SECRET;
  process.env.TELEGRAM_BOT_WEBHOOK_SECRET = 'the-real-secret';
  try {
    await withServer(async baseURL => {
      const res = await fetch(`${baseURL}/webhooks/telegram-bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'the-real-secret' },
        body: JSON.stringify({ update_id: 1 })
      });
      assert.equal(res.status, 200);
    });
  } finally {
    if (originalSecret === undefined) delete process.env.TELEGRAM_BOT_WEBHOOK_SECRET;
    else process.env.TELEGRAM_BOT_WEBHOOK_SECRET = originalSecret;
  }
});

test('with no secret configured, the webhook is wide open — every deploy must set one', async () => {
  const originalSecret = process.env.TELEGRAM_BOT_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_BOT_WEBHOOK_SECRET;
  try {
    await withServer(async baseURL => {
      const res = await fetch(`${baseURL}/webhooks/telegram-bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: 1 })
      });
      assert.equal(res.status, 200);
    });
  } finally {
    if (originalSecret !== undefined) process.env.TELEGRAM_BOT_WEBHOOK_SECRET = originalSecret;
  }
});
