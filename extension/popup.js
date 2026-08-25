'use strict';

// Share one site's signed-in session with Oxy.
//
// This exists because macOS fences off Chrome's cookie file: a script cannot read it without
// being granted Full Disk Access, which is a far broader permission than "let me share one
// shop". Chrome's own cookies API has no such problem, and asking for host access one site
// at a time is the least privilege that does the job.
//
// The site is always the tab you are looking at. It is never typed, so there is no way to
// mistype a domain and share the wrong site's cookies.

const API = 'https://milgrain-live-2026.fly.dev';

const siteEl = document.getElementById('site');
const tokenEl = document.getElementById('token');
const shareEl = document.getElementById('share');
const statusEl = document.getElementById('status');

let site = null;
let hasPermission = false;

/** Chrome match pattern for the site. `*.host` also matches the bare host. */
function sitePattern() { return `*://*.${site}/*`; }

function say(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = kind;
}

/** Registrable-ish site for the tab: strip the leading www, keep the rest. */
function siteFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  site = siteFromUrl(tab?.url);
  if (!site) {
    siteEl.textContent = 'No site';
    say('Open the site you want to share, then click the extension again.');
    return;
  }
  siteEl.textContent = site;

  const stored = await chrome.storage.local.get('token');
  if (stored.token) tokenEl.value = stored.token;

  // Chrome tears down this popup while it shows its permission prompt, which kills the
  // script mid-run. So the permission state is checked on open: once granted, sharing goes
  // straight through with no prompt and nothing to interrupt it.
  hasPermission = await chrome.permissions.contains({ origins: [sitePattern()] }).catch(() => false);
  shareEl.textContent = hasPermission ? 'Share session' : 'Allow access to this site';
  shareEl.disabled = false;
}

async function share() {
  const token = tokenEl.value.trim();
  if (!token) { say('Paste your Oxy token first.', 'err'); return; }

  shareEl.disabled = true;

  // Requested per site, at the moment of sharing, rather than held permanently for every
  // site. Chrome shows its own prompt, so the grant is the user's, not the page's -- and
  // showing it closes this popup, so the share happens on the next click instead.
  if (!hasPermission) {
    say('Chrome will ask permission for this site.\nIf this panel closes, click the extension again to finish.');
    const granted = await chrome.permissions.request({ origins: [sitePattern()] }).catch(() => false);
    if (!granted) {
      say('Chrome permission was declined, so nothing was read.', 'err');
      shareEl.disabled = false;
      return;
    }
    hasPermission = true;
  }

  say('Reading this site’s cookies…');
  let cookies;
  try {
    cookies = await chrome.cookies.getAll({ domain: site });
  } catch (error) {
    say(`Could not read cookies: ${error.message}`, 'err');
    shareEl.disabled = false;
    return;
  }

  if (!cookies.length) {
    say(`Chrome has no cookies for ${site}. Sign in there first.`, 'err');
    shareEl.disabled = false;
    return;
  }

  // Reshaped into what Playwright expects. Chrome reports sameSite as no_restriction /
  // lax / strict / unspecified; anything else would be rejected on replay.
  const sameSite = value => (
    value === 'no_restriction' ? 'None' : value === 'strict' ? 'Strict' : 'Lax'
  );
  const payload = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.session || !c.expirationDate ? -1 : Math.floor(c.expirationDate),
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: sameSite(c.sameSite)
  }));

  say(`Sending ${payload.length} cookies…`);
  try {
    const response = await fetch(`${API}/vault/browser-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ site, cookies: payload })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      say(body.error || `Failed (HTTP ${response.status}).`, 'err');
      shareEl.disabled = false;
      return;
    }
    // Only remember the token once a request has actually succeeded with it.
    await chrome.storage.local.set({ token });
    const dropped = body.cookiesDropped ? `, ${body.cookiesDropped} not for this site dropped` : '';
    say(`Shared ${body.cookiesStored} cookies for ${body.site}${dropped}.\nExpires ${new Date(body.expiresAt).toLocaleDateString()}.`, 'ok');
  } catch (error) {
    say(`Could not reach Oxy: ${error.message}`, 'err');
    shareEl.disabled = false;
  }
}

shareEl.addEventListener('click', share);
init();
