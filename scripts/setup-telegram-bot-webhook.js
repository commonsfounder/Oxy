#!/usr/bin/env node

// One-off: point Millie's Telegram Bot at this deployment's webhook.
//
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_BOT_WEBHOOK_SECRET=... \
//     node scripts/setup-telegram-bot-webhook.js https://milgrain-live-2026.fly.dev
//
// Run this once after creating the bot with @BotFather (or again after rotating
// TELEGRAM_BOT_WEBHOOK_SECRET). Telegram calls this URL for every message/button tap.

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_BOT_WEBHOOK_SECRET;
const baseUrl = process.argv[2];

async function main() {
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN env var is required.');
    process.exit(1);
  }
  if (!baseUrl) {
    console.error('Usage: node scripts/setup-telegram-bot-webhook.js <https://your-deployment>');
    process.exit(1);
  }

  const webhookUrl = `${baseUrl.replace(/\/+$/, '')}/webhooks/telegram-bot`;
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: secret || undefined })
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) {
    console.error(`setWebhook failed: ${body.description || res.status}`);
    process.exit(1);
  }

  console.log(`Webhook registered: ${webhookUrl}`);
  if (!secret) {
    console.warn('TELEGRAM_BOT_WEBHOOK_SECRET was not set — the webhook route will accept requests from anyone. Set it and re-run this script.');
  }

  const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then(r => r.json()).catch(() => null);
  if (me?.ok) {
    console.log(`Bot: @${me.result.username} — set TELEGRAM_BOT_USERNAME=${me.result.username}`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
