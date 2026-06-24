const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { createSupabaseServiceClient } = require('../../runtime');

chromium.use(stealth);

let supabaseClient = null;
function getSupabase() {
  if (!supabaseClient) supabaseClient = createSupabaseServiceClient();
  return supabaseClient;
}

// ponytail: site key keeps cookies/login isolated per domain per user. One row
// per (user, site) — fine at personal-assistant scale, revisit if sites multiply.
async function loadStorageState(userId, site) {
  const { data } = await getSupabase()
    .from('browser_sessions')
    .select('storage_state')
    .eq('user_id', userId)
    .eq('site', site)
    .maybeSingle();
  return data?.storage_state || undefined;
}

async function saveStorageState(userId, site, storageState) {
  await getSupabase()
    .from('browser_sessions')
    .upsert({ user_id: userId, site, storage_state: storageState, updated_at: new Date().toISOString() }, { onConflict: 'user_id,site' });
}

function siteKeyFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return 'unknown'; }
}

// Launches local stealth Chromium by default. Set BROWSER_REMOTE_ENDPOINT to a
// managed scraping-browser CDP endpoint (Bright Data, Browserbase, etc.) to
// swap in proxy/fingerprint-rotation reliability without touching call sites.
async function launchBrowser() {
  const remoteEndpoint = process.env.BROWSER_REMOTE_ENDPOINT;
  if (remoteEndpoint) return chromium.connectOverCDP(remoteEndpoint);
  return chromium.launch({ headless: true });
}

const PAYMENT_KEYWORD_PATTERN = /\b(place( your)? order|pay now|confirm purchase|complete order|checkout\s*(and|&)\s*pay|buy now|submit payment|confirm( and)? pay)\b/i;

function matchesPaymentKeyword(text) {
  return PAYMENT_KEYWORD_PATTERN.test(String(text || ''));
}

function buildDecisionPrompt(goal, history, elements) {
  const historyText = history.length
    ? history.map((entry, i) => `${i + 1}. ${entry}`).join('\n')
    : '(nothing yet)';
  const elementsText = elements.map(el => `#${el.id} "${el.text}"`).join('\n');
  return `You are controlling a real web browser to help with this goal: "${goal}"

What's happened so far:
${historyText}

Visible clickable elements on the current page:
${elementsText}

Reply with ONLY one JSON object, one of these shapes:
{"action":"click","elementId":<number>}
{"action":"fill","elementId":<number>,"value":"<text>"}
{"action":"ask","question":"<short question for the user>"}
{"action":"done","summary":"<short summary answering the goal>"}
{"action":"ready_for_payment","summary":"<what's in the cart>","total":"<price as shown on the page>"}

Use "ask" only for genuine ambiguity you cannot resolve from the goal and history (e.g. multiple matching restaurants, a required size/option choice). Use "ready_for_payment" once the cart is built and the next step would be paying — never choose "click" on anything that finalizes a purchase yourself.`;
}

function parseModelDecision(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawText || '').trim());
  } catch {
    return { action: 'invalid', error: 'Could not parse model response as JSON.' };
  }
  const validActions = new Set(['click', 'fill', 'ask', 'done', 'ready_for_payment']);
  if (!parsed || typeof parsed !== 'object' || !validActions.has(parsed.action)) {
    return { action: 'invalid', error: 'Model returned an unrecognized action.' };
  }
  return parsed;
}

function findElementByText(elements, text) {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return null;
  return elements.find(el => el.text.trim().toLowerCase() === needle)
    || elements.find(el => el.text.trim().toLowerCase().includes(needle))
    || null;
}

module.exports = {
  matchesPaymentKeyword,
  buildDecisionPrompt,
  parseModelDecision,
  findElementByText
};
