#!/usr/bin/env node
// One-time interactive Uber Eats login.
//
// The @striderlabs/mcp-ubereats server runs fully headless and has no usable
// login flow — it only reads cookies from a per-user cookies.json. This helper
// opens a REAL (headed) browser so you can log in by hand, then writes the
// resulting session cookies to the exact file that user's server reads.
//
// Usage:
//   node scripts/ubereats-login.js            # logs in the default "cli-user"
//   node scripts/ubereats-login.js --user bob # logs in a specific user id

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { cookiesPathForUser, BROWSERS_PATH } = require('../connectors/mcp/ubereats-client');

// Point Playwright at the shared browser install before it launches.
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || BROWSERS_PATH;
const { chromium } = require('playwright');

const SESSION_COOKIE_NAMES = ['uev2.id', 'sid', 'uev2.tok', 'jwt-session'];

function getUser(argv) {
  const a = argv.slice(2);
  const i = a.indexOf('--user');
  if (i >= 0 && a[i + 1]) return a[i + 1];
  if (a[0] && !a[0].startsWith('--')) return a[0];
  return 'cli-user';
}

function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

(async () => {
  const user = getUser(process.argv);
  const cookiesPath = cookiesPathForUser(user);
  fs.mkdirSync(path.dirname(cookiesPath), { recursive: true });

  console.log(`Opening a login window for user "${user}"...`);
  const browser = await chromium.launch({ headless: false });
  // Match the headless server's browser context so the captured session works there.
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });
  const page = await context.newPage();
  await page.goto('https://www.ubereats.com/login', { waitUntil: 'domcontentloaded' });

  console.log('\nA browser window opened. Log into Uber Eats there as you normally would.');
  console.log('Once you can see your Uber Eats home feed (fully logged in), come back here.');
  await waitForEnter('\nPress Enter once you are logged in... ');

  const cookies = await context.cookies();
  const hasSession = cookies.some(c => SESSION_COOKIE_NAMES.includes(c.name));
  fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
  await browser.close();

  console.log(`\nSaved ${cookies.length} cookies → ${cookiesPath}`);
  if (hasSession) {
    console.log(`Looks logged in. Now run:  node scripts/ubereats-cli.js status --user ${user}`);
  } else {
    console.log('WARNING: no Uber Eats session cookie was found — the login may not have completed.');
    console.log('Re-run this and make sure you are fully signed in before pressing Enter.');
  }
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
