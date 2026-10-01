'use strict';

// What every scene page shares: the policy that blocks the network, Adam's look, and the one bridge
// back to Adam (ask a question, say a line). The scene itself is data rendered by scene-runtime.js;
// the model never supplies markup or code. Scenes can look and compute but never act: anything that
// spends, messages or unlocks still goes through the approval step.

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
.card{background:var(--card);border:1px solid var(--line);border-radius:3vmin;padding:2.6vmin 3vmin;display:flex;flex-direction:column;align-items:flex-start;gap:1.4vmin}
.card>*{margin:0}.card .bar{width:100%;flex:none}.card .btn{margin-top:.6vmin}
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
const BRIDGE_JS = "(function(){function send(t){t=String(t||'').trim().slice(0,200);if(!t)return;var w=window.webkit;if(w&&w.messageHandlers&&w.messageHandlers.adam){w.messageHandlers.adam.postMessage(t)}else{window.parent.postMessage({adamAsk:t},'*')}}function say(t){t=String(t||'').trim().slice(0,400);if(t&&!(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.adam))window.parent.postMessage({adamSay:t},'*')}window.adam={ask:send,say:say};document.addEventListener('click',function(e){var el=e.target&&e.target.closest&&e.target.closest('[data-ask]');if(el)send(el.getAttribute('data-ask'))})})();";

module.exports = {
  CSP,
  KIT_CSS,
  BRIDGE_JS
};
