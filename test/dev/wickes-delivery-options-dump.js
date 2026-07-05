'use strict';
const fs = require('fs');
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const runtime = require('../../runtime');
const email = process.env.OXY_E2E_CHECKOUT_EMAIL || 'guest@oxy-test.example';
runtime.createSupabaseServiceClient = () => {
  const ctx = { table: null, op: null };
  const resolve = async () => ({
    data: ctx.table === 'preferences' && ctx.op === 'select' ? [
      { key: 'checkout_profile.email', value: email },
      { key: 'checkout_profile.name', value: 'Test User' },
      { key: 'checkout_profile.phone', value: '07700900123' },
      { key: 'checkout_profile.address', value: JSON.stringify({ line1: '12 High Street', city: 'London', postcode: 'SW1A 1AA' }) },
      { key: 'checkout_profile.consent', value: 'true' },
    ] : null,
    error: null,
  });
  const b = {
    from(t) { ctx.table = t; return b; },
    select() { ctx.op = 'select'; return b; },
    eq() { return b; }, in() { return b; }, like() { return b; },
    order() { return b; }, limit() { return b; },
    delete: async () => ({}),
    maybeSingle: resolve, single: resolve, upsert: async () => ({}),
    then: (a, c) => resolve().then(a, c),
  };
  return b;
};
const { runOrderingTurn, getSession, closeSession } = require('../../api/services/browser-task');

(async () => {
  const user = 'wickes-do-dump';
  const url = 'https://www.wickes.co.uk/Crown-Matt-Emulsion-Paint---Pure-Brilliant-White---10L/p/166844';
  let out;
  for (let i = 0; i < 4; i++) {
    out = await runOrderingTurn(user, {
      url: i === 0 ? url : null,
      goal: i === 0 ? 'add white paint to basket and go to checkout' : '',
      onProgress: (m) => process.stderr.write(`· ${m}\n`),
    });
    process.stderr.write(`turn ${i + 1}: ${out.type} ${getSession(user)?.page?.url() || ''}\n`);
    if (out.type === 'error') break;
    if ((getSession(user)?.page?.url() || '').includes('delivery-option')) break;
  }
  const page = getSession(user)?.page;
  if (!page) {
    console.log(JSON.stringify({ error: 'no session', out }, null, 2));
    process.exit(1);
  }
  await page.getByRole('button', { name: /^show delivery products/i }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const dump = await page.evaluate(() => {
    const vis = (el) => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const nodes = [...document.querySelectorAll('button,a,input,select,td,th,label,div,span,li,[role="button"],[role="radio"],[role="gridcell"],[role="option"]')]
      .filter(vis)
      .map((el) => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        type: el.type || '',
        cls: String(el.className || '').slice(0, 100),
        text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      }))
      .filter((n) => n.text.length > 0 && n.text.length < 130);
    return {
      url: location.href,
      hash: location.hash,
      body: (document.body.innerText || '').slice(0, 6000),
      nodes: nodes.slice(0, 150),
    };
  });
  console.log(JSON.stringify(dump, null, 2));
  await closeSession(user).catch(() => {});
})().catch((e) => { console.error(e); process.exit(1); });