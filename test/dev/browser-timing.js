// Faithful timing harness for the run_browser_task perception loop.
// Replicates the exact code paths from api/services/browser-task.js so we can measure
// where the 18s whole-turn budget actually goes. No Gemini tokens spent — we measure
// the deterministic browser phases (launch, goto, settle, extract, screenshot), which
// is the load-bearing cost the model call sits on top of.
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const MAX_DURATION_MS = 18 * 1000; // from browser-task.js

// --- verbatim from browser-task.js ---
const CLICKABLE_SELECTOR = 'button, a, input, textarea, [role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="combobox"]';
const MAX_ELEMENTS = 60;

async function extractClickableElements(page) {
  const locator = page.locator(CLICKABLE_SELECTOR);
  const count = await locator.count();
  const elements = [];
  let scanned = 0;
  for (let i = 0; i < count && elements.length < MAX_ELEMENTS; i++) {
    scanned++;
    const el = locator.nth(i);
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const text = (await el.innerText().catch(() => ''))
      || (await el.getAttribute('aria-label').catch(() => ''))
      || (await el.getAttribute('placeholder').catch(() => ''))
      || (await el.getAttribute('value').catch(() => ''))
      || '';
    const trimmed = text.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!trimmed) continue;
    const box = await el.boundingBox().catch(() => null);
    elements.push({ id: elements.length, text: trimmed, locatorIndex: i, box });
  }
  return { elements, count, scanned };
}

async function captureMarkedScreenshot(page, elements) {
  const marks = elements.filter(el => el.box).map(el => ({ id: el.id, ...el.box }));
  await page.evaluate((marks) => {
    const layer = document.createElement('div');
    layer.id = '__oxy_marks__';
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(layer);
  }, marks).catch(() => {});
  try {
    const shot = await page.screenshot({ type: 'png' });
    return shot.toString('base64');
  } finally {
    await page.evaluate(() => document.getElementById('__oxy_marks__')?.remove()).catch(() => {});
  }
}

async function settle(page, timeout = 2500) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}

const ms = (a, b) => `${(b - a).toFixed(0)}ms`;

async function timeSite(url) {
  console.log(`\n================ ${url} ================`);
  const turnStart = Date.now();

  let t = Date.now();
  const browser = await chromium.launch({ headless: true });
  const tLaunch = Date.now();
  console.log(`launchBrowser          ${ms(t, tLaunch)}`);

  const context = await browser.newContext();
  const page = await context.newPage();

  t = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch (e) {
    console.log(`goto FAILED: ${e.message.split('\n')[0]}`);
  }
  const tGoto = Date.now();
  console.log(`goto(domcontentloaded)  ${ms(t, tGoto)}`);

  t = Date.now();
  await settle(page, 5000); // openNewSession uses 5000 for the first hydrate
  const tSettle = Date.now();
  console.log(`settle(5000)            ${ms(t, tSettle)}`);

  const openTotal = Date.now() - turnStart;
  console.log(`--- openNewSession total: ${openTotal}ms  (budget ${MAX_DURATION_MS}ms, ${(MAX_DURATION_MS - openTotal)}ms left for the loop) ---`);

  // ---- one perception step (what every loop iteration pays) ----
  for (let step = 1; step <= 2; step++) {
    const stepStart = Date.now();
    t = Date.now();
    await settle(page); // default 2500 inside the loop
    const tS = Date.now();
    const { elements, count, scanned } = await extractClickableElements(page);
    const tE = Date.now();
    await captureMarkedScreenshot(page, elements);
    const tShot = Date.now();
    console.log(`\nstep ${step}: settle ${ms(t, tS)} | extract ${ms(tS, tE)} (DOM matches=${count}, scanned=${scanned}, kept=${elements.length}) | screenshot ${ms(tE, tShot)} | step total ${Date.now() - stepStart}ms`);
    const elapsed = Date.now() - turnStart;
    console.log(`   cumulative turn time: ${elapsed}ms ${elapsed > MAX_DURATION_MS ? '>>> OVER BUDGET (model call not even reached)' : ''}`);
  }

  await browser.close();
}

(async () => {
  const sites = process.argv.slice(2);
  for (const s of sites.length ? sites : ['https://www.johnlewis.com']) {
    try { await timeSite(s); } catch (e) { console.log('site error:', e.message); }
  }
})();
