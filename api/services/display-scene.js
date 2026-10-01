'use strict';

// A scene is a small page Adam writes for a screen in the home (a how-to, a plan, a chart, a
// little interactive). It is shown in a sandboxed frame that cannot reach the network, the
// display's own page, or anything stored in it; the sandbox and CSP are the boundary, the checks
// below only turn away the obvious attempts early. Scenes can look and compute but never act:
// anything that spends, messages or unlocks still goes through the approval step.

const MAX_SCENE_HTML = 48000;

const SECRET_PATTERN = /(?:\bauthorization\s*:\s*bearer\b|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:password|passwd|passphrase|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|cookie|set-cookie|session[_-]?token)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

const BLOCKED = [
  /<\s*(?:iframe|frame|frameset|object|embed|link|base|meta|form|applet)\b/i,
  /<\s*script\b[^>]*\bsrc\s*=/i,
  /\b(?:src|href|action|poster|data|srcset)\s*=\s*["']?\s*(?:https?:|ftp:|wss?:)?\/\//i,
  /\b(?:src|href|action|poster|data|srcset)\s*=\s*["']?\s*javascript:/i,
  /url\(\s*["']?\s*(?:https?:|ftp:)?\/\//i,
  /@import\b/i,
  /\b(?:fetch|importScripts|import)\s*\(/i,
  /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon|WebTransport|RTCPeerConnection)\b/,
  /\bwindow\s*\.\s*(?:parent|top|opener|frames)\b/i,
  /\b(?:parent|top|opener)\s*\.\s*(?:postMessage|document|location|frames)\b/i,
  /\bdocument\.(?:cookie|domain)\b/i,
  /\b(?:localStorage|sessionStorage|indexedDB|serviceWorker)\b/,
  /\blocation\s*(?:=|\.\s*(?:href|assign|replace))/i
];

function sceneError(message) {
  const error = new Error(message);
  error.code = 'invalid_content';
  error.status = 400;
  return error;
}

function validateSceneHtml(html) {
  if (typeof html !== 'string') throw sceneError('A scene must be HTML text.');
  const text = html.trim();
  if (!text) throw sceneError('A scene needs some content.');
  if (text.length > MAX_SCENE_HTML) throw sceneError('That scene is too large for a screen.');
  if (SECRET_PATTERN.test(text)) throw sceneError('A scene cannot contain credentials.');
  if (BLOCKED.some(pattern => pattern.test(text))) {
    throw sceneError('A scene cannot load outside content or reach the page around it.');
  }
  return text;
}

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'media-src data:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'"
].join('; ');

// Adam's look for screens across the room: big calm type, thin outlines, round controls. Scenes
// are told to use these classes so everything Adam shows looks like Adam.
const KIT_CSS = `
:root{color-scheme:light dark;--bg:#F6F9FD;--card:#fff;--ink:#101721;--muted:#5C697A;--line:rgba(16,23,33,.14);--accent:#135EE1;--needs:#C77A0A;--done:#1F9D55}
@media (prefers-color-scheme:dark){:root{--bg:#0E131B;--card:#161D28;--ink:#F2F5F9;--muted:#9AA6B6;--line:rgba(242,245,249,.16);--accent:#5B97FF;--needs:#F0A23A;--done:#46C27F}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--ink);font:400 clamp(18px,3.1vmin,34px)/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.scene{min-height:100%;padding:6vmin 7vmin;display:flex;flex-direction:column;gap:3.2vmin}
.eyebrow{font-size:.62em;letter-spacing:.04em;color:var(--muted)}
.title{font-size:2em;font-weight:600;line-height:1.12;margin:0;letter-spacing:-.01em}
.lede{color:var(--muted);margin:0;max-width:34em}
.muted{color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(24vmin,1fr));gap:2.4vmin}
.card{background:var(--card);border:1px solid var(--line);border-radius:3vmin;padding:2.6vmin 3vmin}
.card h3{margin:0 0 .3em;font-size:1em;font-weight:600}
.big{font-size:3.2em;font-weight:600;line-height:1;letter-spacing:-.02em}
.unit{font-size:.5em;color:var(--muted);margin-left:.3em;font-weight:400}
.steps{list-style:none;counter-reset:s;margin:0;padding:0;display:flex;flex-direction:column;gap:2vmin}
.steps li{counter-increment:s;display:flex;gap:2.4vmin;align-items:flex-start}
.steps li::before{content:counter(s);flex:none;width:2.2em;height:2.2em;border-radius:50%;border:1.5px solid var(--ink);display:flex;align-items:center;justify-content:center;font-size:.8em;font-weight:600}
.steps li.on::before{background:var(--ink);color:var(--bg)}
.chip{display:inline-flex;align-items:center;gap:.5em;border:1px solid var(--line);border-radius:99px;padding:.25em .9em;font-size:.8em;background:var(--card)}
.dot{width:.6em;height:.6em;border-radius:50%;background:var(--muted);display:inline-block}
.dot.working{background:var(--accent)}.dot.needs{background:var(--needs)}.dot.done{background:var(--done)}
.bar{height:1.1vmin;border-radius:99px;background:var(--line);overflow:hidden}.bar>i{display:block;height:100%;background:var(--accent);border-radius:99px}
.row{display:flex;gap:2.4vmin;align-items:center;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;border-radius:99px;padding:.55em 1.4em;border:1.5px solid var(--ink);background:transparent;color:var(--ink);font:inherit;font-weight:600;cursor:pointer}
.btn.main{background:var(--ink);color:var(--bg)}
svg{max-width:100%;height:auto}
`;

// The only way a scene reaches Adam: a tap asks a question or makes a request, exactly as if it
// were typed. It carries no authority; approvals still happen where the person can see them.
const BRIDGE_JS = "(function(){function send(t){t=String(t||'').trim().slice(0,200);if(!t)return;var w=window.webkit;if(w&&w.messageHandlers&&w.messageHandlers.adam){w.messageHandlers.adam.postMessage(t)}else{window.parent.postMessage({adamAsk:t},'*')}}window.adam={ask:send};document.addEventListener('click',function(e){var el=e.target&&e.target.closest&&e.target.closest('[data-ask]');if(el)send(el.getAttribute('data-ask'))})})();";

// The frame the display page shows. The CSP comes first so nothing the scene contains can
// loosen it (extra policies only tighten).
function buildSceneDocument(html, { title = '' } = {}) {
  const safe = validateSceneHtml(html);
  const label = String(title || 'Adam').replace(/[<>&"]/g, '').slice(0, 120);
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label}</title><style>${KIT_CSS}</style></head><body>${safe}<script>${BRIDGE_JS}</script></body></html>`;
}

module.exports = {
  MAX_SCENE_HTML,
  CSP,
  KIT_CSS,
  BRIDGE_JS,
  validateSceneHtml,
  buildSceneDocument
};
