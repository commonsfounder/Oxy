'use strict';
const fs = require('fs');
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const runtime = require('../../runtime');
const E2E_CHECKOUT_EMAIL = process.env.OXY_E2E_CHECKOUT_EMAIL || 'guest@oxy-test.example';
function createE2eSupabase() {
  const ctx = { table: null, op: null };
  const resolve = async () => ({
    data: ctx.table === 'preferences' && ctx.op === 'select' ? [
      { key: 'checkout_profile.email', value: E2E_CHECKOUT_EMAIL },
      { key: 'checkout_profile.name', value: 'Test User' },
      { key: 'checkout_profile.phone', value: '07700900123' },
      { key: 'checkout_profile.address', value: JSON.stringify({ line1: '12 High Street', city: 'London', postcode: 'SW1A 1AA' }) },
      { key: 'checkout_profile.consent', value: 'true' },
    ] : null,
    error: null,
  });
  const builder = {
    from(t) { ctx.table = t; return builder; },
    select() { ctx.op = 'select'; return builder; },
    eq() { return builder; },
    in() { return builder; },
    like() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    delete: async () => ({ data: null, error: null }),
    maybeSingle: resolve,
    single: resolve,
    upsert: async () => ({ data: null, error: null }),
    then(onFulfilled, onRejected) { return resolve().then(onFulfilled, onRejected); },
  };
  return builder;
}
runtime.createSupabaseServiceClient = () => createE2eSupabase();
const { runOrderingTurn, getSession, closeSession } = require('../../api/services/browser-task');

(async () => {
  const user = 'wickes-dump';
  const outcome = await runOrderingTurn(user, {
    url: 'https://www.wickes.co.uk/Crown-Matt-Emulsion-Paint---Pure-Brilliant-White---10L/p/166844',
    goal: 'add white paint to basket and go to checkout',
    onProgress: (m) => process.stderr.write(`· ${m}\n`),
  });
  const sess = getSession(user);
  if (!sess?.page) {
    console.log(JSON.stringify({ outcome, error: 'no session' }));
    process.exit(1);
  }
  const page = sess.page;
  const fields = [];
  for (const loc of await page.locator('input, select, textarea').all()) {
    if (!(await loc.isVisible().catch(() => false))) continue;
    const meta = await loc.evaluate((el) => {
      const id = el.getAttribute('id') || '';
      const labelEl = (el.labels && el.labels[0]) || (id && document.querySelector(`label[for="${id}"]`)) || el.closest('label');
      return {
        tag: el.tagName,
        type: el.getAttribute('type') || el.tagName.toLowerCase(),
        name: el.getAttribute('name'),
        id,
        placeholder: el.getAttribute('placeholder'),
        autocomplete: el.getAttribute('autocomplete'),
        aria: el.getAttribute('aria-label'),
        label: labelEl ? labelEl.innerText.trim().replace(/\s+/g, ' ').slice(0, 80) : '',
        value: el.value || '',
      };
    }).catch(() => null);
    if (meta) fields.push(meta);
  }
  console.log(JSON.stringify({ url: page.url(), outcome: outcome.type, fields }, null, 2));
  await closeSession(user).catch(() => {});
})().catch((e) => { console.error(e); process.exit(1); });