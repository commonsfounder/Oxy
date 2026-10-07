'use strict';
// First real run of the sandbox browser against E2B. Uses a throwaway user and deletes its
// sandbox at the end.   E2B_API_KEY=... node test/dev/e2b-live-check.js [url]
require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env'), quiet: true });
process.env.OXY_BROWSER_TIMING = "1";
process.env.OXY_BROWSER_BACKEND = 'e2b';
process.env.OXY_BROWSER_BACKEND_STRICT = '1';
process.env.OXY_E2B_PAUSE_DELAY_MS = '1000';
process.env.OXY_BROWSER_WARM_POOL = 'false';
process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_KEY ||= 'unused';

const sandboxes = require('../../api/services/browser-sandbox');
const env = require('../../api/services/browser-environment');
const sessions = require('../../api/services/browser-session');
const { Sandbox } = require('e2b');

const user = `live-check-${Date.now()}`;
const url = process.argv[2] || 'https://example.com/';
const step = async (name, fn) => {
  const t = Date.now();
  try { const out = await fn(); console.log(`ok   ${name} (${Date.now() - t}ms)`, out ?? ''); return out; }
  catch (error) { console.log(`FAIL ${name}: ${error.message}`); throw error; }
};

(async () => {
  if (!process.env.E2B_API_KEY) throw new Error('Set E2B_API_KEY.');
  try {
    const first = await step('cold start: create sandbox, start Chromium, connect', () => env.open(user, { url }));
    await step('page perceived', async () => `${first.title} | ${first.elements.length} elements | blocked=${first.blocked}`);
    const live = await step('live-view link', async () => require('../../api/services/browser-live-view').createLink(user)?.url.slice(0, 60));
    if (!live) throw new Error('no live view link');
    await step('persistent profile: set a cookie and localStorage marker', () => sessions.getSession(user).page.evaluate(() => { document.cookie = 'oxy_check=1; max-age=3600'; localStorage.setItem('oxy_check', '1'); return 'set'; }));
    await env.close(user);
    await step('pause after release', async () => {
      await new Promise((r) => setTimeout(r, 4000));
      const items = await Sandbox.list({ query: { metadata: { app: 'adam-browser', user: sandboxes.userTag(user) } } }).nextItems();
      return items.map((i) => i.state).join(',');
    });
    const second = await step('resume: same sandbox, browser state kept', () => env.open(user, { url }));
    await step('profile survived the pause', async () => {
      const found = await sessions.getSession(user).page.evaluate(() => `${document.cookie.includes('oxy_check=1')}/${localStorage.getItem('oxy_check')}`);
      if (found !== 'true/1') throw new Error(`cookie/localStorage lost: ${found}`);
      return found;
    });
    await step('read a hard site', async () => {
      const r = await env.open(user, { url: 'https://www.argos.co.uk/' });
      return `${r.title} | blocked=${r.blocked} | ${r.elements.length} elements`;
    });
    void second;
  } finally {
    await env.close(user).catch(() => {});
    const r = await sandboxes.destroyForUser(user).catch((e) => ({ error: e.message }));
    console.log('cleanup', JSON.stringify(r));
    process.exit(0);
  }
})().catch((error) => { console.error(error); process.exit(1); });
