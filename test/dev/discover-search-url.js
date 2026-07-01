// Discover a site's search-results URL pattern by driving the search box deterministically
// (no model). Prints the resulting URL so we can build a SEARCH_SITES fast-path entry.
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const HOME = process.argv[2];
const TERM = process.argv[3] || 'wool coat';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 768 } })).newPage();
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  // dismiss consent best-effort
  for (const name of [/^accept all/i, /^accept/i, /^agree/i, /^allow all/i, /^got it/i]) {
    const b = page.getByRole('button', { name }).first();
    if (await b.isVisible({ timeout: 300 }).catch(() => false)) { await b.click({ force: true }).catch(()=>{}); break; }
  }
  await page.waitForTimeout(800);
  // find a search input
  const candidates = ['input[type="search"]', 'input[name*="search" i]', 'input[placeholder*="search" i]', 'input[aria-label*="search" i]'];
  let filled = false;
  for (const sel of candidates) {
    const inp = page.locator(sel).first();
    if (await inp.isVisible({ timeout: 500 }).catch(() => false)) {
      await inp.fill(TERM).catch(()=>{});
      await inp.press('Enter').catch(()=>{});
      filled = true;
      console.log('used selector:', sel);
      break;
    }
  }
  if (!filled) { console.log('NO SEARCH INPUT FOUND'); await browser.close(); return; }
  await page.waitForTimeout(3500);
  console.log('RESULT URL:', page.url());
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
