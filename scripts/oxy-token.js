#!/usr/bin/env node

// Print a session token for pasting into the Chrome extension.
//
//   node scripts/oxy-token.js user123
//
// The password is read without echoing and is never passed as an argument, so it does not
// land in shell history, in `ps` output, or on screen. It goes straight to /auth/login and
// is not kept afterwards.

const readline = require('readline');

const API = process.env.OXY_API_URL || 'https://milgrain-live-2026.fly.dev';

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr; // prompt to stderr so `... | pbcopy` pipes only the token
    if (!input.isTTY) {
      reject(new Error('Run this in a terminal so the password can be typed without echoing.'));
      return;
    }
    const rl = readline.createInterface({ input, output, terminal: true });
    output.write(prompt);
    input.setRawMode(true);
    let value = '';
    const onData = chunk => {
      const char = chunk.toString('utf8');
      if (char === '\r' || char === '\n' || char === '') {
        input.setRawMode(false);
        input.removeListener('data', onData);
        rl.close();
        output.write('\n');
        resolve(value);
        return;
      }
      if (char === '') { // ctrl-c
        input.setRawMode(false);
        rl.close();
        output.write('\n');
        process.exit(130);
      }
      if (char === '' || char === '\b') { value = value.slice(0, -1); return; }
      value += char;
    };
    input.on('data', onData);
  });
}

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('Usage: node scripts/oxy-token.js <userId>');
    process.exit(1);
  }

  const password = await askHidden(`Password for ${userId}: `);
  if (!password) {
    console.error('No password entered.');
    process.exit(1);
  }

  const response = await fetch(`${API.replace(/\/+$/, '')}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, password })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) {
    console.error(`Sign-in failed (HTTP ${response.status}): ${body.error || 'no token returned'}`);
    process.exit(1);
  }

  // Token alone on stdout, so `node scripts/oxy-token.js user123 | pbcopy` works.
  process.stdout.write(`${body.token}\n`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
