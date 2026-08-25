'use strict';

// Share one site's signed-in session with Oxy.
//
// This exists because macOS fences off Chrome's cookie file: a script cannot read it without
// being granted Full Disk Access, which is a far broader permission than "let me share one
// shop". Chrome's own cookies API has no such problem, and asking for host access one site
// at a time is the least privilege that does the job.
//
// Signing in happens here rather than by fetching a token from a terminal. A feature that
// needs a command line before it works is a feature nobody uses.
//
// The site is always the tab you are looking at. It is never typed, so there is no way to
// mistype a domain and share the wrong site's cookies.

const API = 'https://milgrain-live-2026.fly.dev';

const signinEl = document.getElementById('signin');
const shareSectionEl = document.getElementById('share');
const userIdEl = document.getElementById('userId');
const passwordEl = document.getElementById('password');
const signInBtn = document.getElementById('signInBtn');
const signOutBtn = document.getElementById('signOutBtn');
const siteEl = document.getElementById('site');
const shareBtn = document.getElementById('shareBtn');
const statusEl = document.getElementById('status');

let site = null;
let token = null;
let hasPermission = false;

function say(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = kind;
}

/** Chrome match pattern for the site. `*.host` also matches the bare host. */
function sitePattern() { return `*://*.${site}/*`; }

// Kept in step with api/lib/site.js -- an extension cannot require server modules, so this
// is the one deliberate duplicate. Change both together.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz', 'co.za', 'org.za',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br',
  'com.sg', 'com.my', 'com.hk', 'com.tw', 'com.mx', 'com.tr', 'com.ar',
  'co.in', 'net.in', 'org.in', 'co.kr', 'or.kr'
]);

/**
 * The site a session should be filed under, not the exact page host.
 *
 * Sharing from account.johnlewis.com must file under johnlewis.com: that is what the
 * ordering loop looks up, and Chrome's cookie filter matches a domain and its SUBdomains,
 * so asking for the account host would skip the .johnlewis.com cookies holding the session.
 */
function siteFromUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return null; }
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.') || null;
  const keep = MULTI_PART_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

function showSignIn() {
  signinEl.classList.remove('hidden');
  shareSectionEl.classList.add('hidden');
  (userIdEl.value ? passwordEl : userIdEl).focus();
}

async function showShare() {
  signinEl.classList.add('hidden');
  shareSectionEl.classList.remove('hidden');
  siteEl.textContent = site || 'No site';

  if (!site) {
    say('Open the site you want to share, then click the extension again.');
    return;
  }

  // Chrome tears down this popup while it shows its permission prompt, which kills the
  // script mid-run. So the permission state is checked on open: once granted, sharing goes
  // straight through with no prompt and nothing to interrupt it.
  hasPermission = await chrome.permissions.contains({ origins: [sitePattern()] }).catch(() => false);
  shareBtn.textContent = hasPermission ? 'Share session' : 'Allow access to this site';
  shareBtn.disabled = false;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  site = siteFromUrl(tab?.url);

  const stored = await chrome.storage.local.get(['token', 'userId']);
  token = stored.token || null;
  if (stored.userId) userIdEl.value = stored.userId;

  if (token) await showShare(); else showSignIn();
}

async function signIn() {
  const userId = userIdEl.value.trim();
  const password = passwordEl.value;
  if (!userId || !password) { say('Enter your user ID and password.', 'err'); return; }

  signInBtn.disabled = true;
  say('Signing in…');
  try {
    const response = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, password })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token) {
      say(body.error || `Sign-in failed (HTTP ${response.status}).`, 'err');
      signInBtn.disabled = false;
      return;
    }
    token = body.token;
    // The user id is remembered for convenience; the password is not kept anywhere.
    await chrome.storage.local.set({ token, userId });
    passwordEl.value = '';
    say('');
    await showShare();
  } catch (error) {
    say(`Could not reach Oxy: ${error.message}`, 'err');
    signInBtn.disabled = false;
  } finally {
    signInBtn.disabled = false;
  }
}

async function signOut() {
  await chrome.storage.local.remove('token');
  token = null;
  say('');
  showSignIn();
}

async function share() {
  shareBtn.disabled = true;

  // Requested per site, at the moment of sharing, rather than held permanently for every
  // site. Chrome shows its own prompt, so the grant is the user's, not the page's -- and
  // showing it closes this popup, so the share happens on the next click instead.
  if (!hasPermission) {
    say('Chrome will ask permission for this site.\nIf this panel closes, click the extension again to finish.');
    const granted = await chrome.permissions.request({ origins: [sitePattern()] }).catch(() => false);
    if (!granted) {
      say('Chrome permission was declined, so nothing was read.', 'err');
      shareBtn.disabled = false;
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
    shareBtn.disabled = false;
    return;
  }

  if (!cookies.length) {
    say(`Chrome has no cookies for ${site}. Sign in there first.`, 'err');
    shareBtn.disabled = false;
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

    // An expired or rejected token should send the user back to signing in, not leave them
    // clicking a button that will never work.
    if (response.status === 401) {
      await chrome.storage.local.remove('token');
      token = null;
      showSignIn();
      say('That sign-in expired. Sign in again.', 'err');
      return;
    }
    if (!response.ok) {
      say(body.error || `Failed (HTTP ${response.status}).`, 'err');
      shareBtn.disabled = false;
      return;
    }

    const dropped = body.cookiesDropped ? `, ${body.cookiesDropped} not for this site dropped` : '';
    say(`Shared ${body.cookiesStored} cookies for ${body.site}${dropped}.\nExpires ${new Date(body.expiresAt).toLocaleDateString()}.`, 'ok');
  } catch (error) {
    say(`Could not reach Oxy: ${error.message}`, 'err');
    shareBtn.disabled = false;
  }
}

signInBtn.addEventListener('click', signIn);
signOutBtn.addEventListener('click', signOut);
shareBtn.addEventListener('click', share);
passwordEl.addEventListener('keydown', e => { if (e.key === 'Enter') signIn(); });
init();
