'use strict';

// The parts Adam builds explainers from. The model arranges and labels pieces we drew once, so they
// look right every time, instead of drawing from scratch. A deck is a fixed stage (16:9 on a TV,
// portrait on a phone) that shows one slide at a time, advances by itself, captions what is said,
// and fits its content, so a page can never run off the screen.

const PIECES = {
  radiator: '<rect x="8" y="14" width="44" height="34" rx="5"/><path d="M18 20v22M26 20v22M34 20v22M42 20v22"/><path d="M8 26H4v14h4M52 26h4v14h-4"/><circle cx="47" cy="9" r="3.5" style="stroke:var(--accent)"/>',
  valve: '<path d="M24 22h16l8 12-8 12H24l-8-12z"/><circle cx="32" cy="34" r="5" style="stroke:var(--accent)"/><path d="M32 8v14"/>',
  key: '<circle cx="20" cy="22" r="9"/><path d="M27 29l24 24M43 45l6-6M36 52l5-5"/>',
  turn: '<path d="M47 19a19 19 0 1 0 4 14"/><path d="M51 9v11H40" style="stroke:var(--accent)"/>',
  drop: '<path d="M32 8c10 14 16 22 16 32a16 16 0 0 1-32 0c0-10 6-18 16-32z"/>',
  bubbles: '<circle cx="22" cy="44" r="7"/><circle cx="40" cy="32" r="5"/><circle cx="29" cy="16" r="3.5"/>',
  cloth: '<path d="M12 14h40v30c-7 8-13-5-20 1s-13-7-20 0z"/><path d="M12 24h40"/>',
  clock: '<circle cx="32" cy="32" r="22"/><path d="M32 18v14l9 6" style="stroke:var(--accent)"/>',
  pot: '<path d="M12 28h40v16a8 8 0 0 1-8 8H20a8 8 0 0 1-8-8z"/><path d="M8 28h48M24 20c0-4 3-4 3-9M36 20c0-4 3-4 3-9"/>',
  oven: '<rect x="10" y="10" width="44" height="44" rx="6"/><path d="M10 23h44"/><circle cx="20" cy="16.5" r="2"/><circle cx="30" cy="16.5" r="2"/><rect x="18" y="30" width="28" height="16" rx="3"/>',
  person: '<circle cx="32" cy="20" r="9"/><path d="M14 54c2-12 10-18 18-18s16 6 18 18"/>',
  house: '<path d="M8 30L32 10l24 20"/><path d="M14 26v26h36V26"/><path d="M27 52V38h10v14"/>',
  train: '<rect x="14" y="8" width="36" height="38" rx="8"/><path d="M14 28h36"/><circle cx="24" cy="37" r="2"/><circle cx="40" cy="37" r="2"/><path d="M22 46l-6 10M42 46l6 10"/>',
  check: '<circle cx="32" cy="32" r="22"/><path d="M22 33l7 7 14-15" style="stroke:var(--accent)"/>',
  alert: '<path d="M32 8L58 52H6z"/><path d="M32 24v14M32 45v1" style="stroke:var(--accent)"/>',
  bulb: '<path d="M24 44c0-6-8-8-8-18a16 16 0 0 1 32 0c0 10-8 12-8 18z"/><path d="M26 52h12M28 58h8"/>',
  'arrow-right': '<path d="M10 32h40M38 20l12 12-12 12"/>',
  'arrow-down': '<path d="M32 10v40M20 38l12 12 12-12"/>',
  calendar: '<rect x="10" y="14" width="44" height="40" rx="6"/><path d="M10 26h44M22 8v12M42 8v12"/>',
  heat: '<path d="M26 10a6 6 0 0 1 12 0v26a12 12 0 1 1-12 0z"/><circle cx="32" cy="46" r="5" style="stroke:var(--accent)"/>',
  bell: '<path d="M16 42V28a16 16 0 0 1 32 0v14l4 6H12z"/><path d="M27 54a5 5 0 0 0 10 0"/>',
  play: '<path d="M22 14l26 18-26 18z"/>',
  pause: '<path d="M22 14v36M42 14v36"/>',
  replay: '<path d="M50 32a18 18 0 1 1-6-13"/><path d="M47 8v12H35"/>'
};

const PIECE_NAMES = Object.keys(PIECES);

const SPRITE = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'
  + PIECE_NAMES.map(name => `<symbol id="p-${name}" viewBox="0 0 64 64">${PIECES[name]}</symbol>`).join('')
  + '</defs></svg>';

const DECK_CSS = `
.pic{width:220px;height:220px;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;flex:none}
.pic.acc{stroke:var(--accent)}.pic.xl{width:340px;height:340px}.pic.sm{width:96px;height:96px}.pic.xs{width:56px;height:56px}
.deck{position:fixed;left:50%;top:50%;width:var(--W,1280px);height:var(--H,720px);transform:translate(-50%,-50%) scale(var(--k,1));overflow:hidden;background:var(--bg)}
.deck .slide{position:absolute;inset:0;display:none;align-items:center;justify-content:center;padding:56px 72px 200px}
.deck .slide.on{display:flex}
.deck .inner{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;text-align:center;max-width:100%;transform-origin:center}
.deck .cols{display:flex;align-items:center;justify-content:center;gap:56px}
.deck .col{display:flex;flex-direction:column;gap:18px;align-items:flex-start;text-align:left;max-width:640px}
.deck .h{font-size:60px;font-weight:600;line-height:1.1;letter-spacing:-.015em;margin:0}
.deck .t{font-size:36px;line-height:1.3;margin:0}.deck .sub{font-size:28px;color:var(--muted);margin:0}
.deck .num{width:84px;height:84px;border-radius:50%;border:2px solid var(--ink);display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:600;flex:none}
body:has(.deck){overflow:hidden}
body.portrait .deck .slide{padding:96px 48px 260px}body.portrait .deck .cols{flex-direction:column;gap:32px}
body.portrait .deck .col{align-items:center;text-align:center}body.portrait .deck .h{font-size:54px}body.portrait .deck .t{font-size:34px}
.deck .cap{position:absolute;left:0;right:0;bottom:92px;text-align:center;padding:0 72px;font-size:30px;line-height:1.35;color:var(--muted);min-height:2.7em}
body.portrait .deck .cap{bottom:120px;padding:0 48px}
.deck .bar{position:absolute;left:0;right:0;top:0;height:6px;background:var(--line)}.deck .bar i{display:block;height:100%;width:0;background:var(--accent)}
.deck .ctl{position:absolute;left:0;right:0;bottom:20px;display:flex;justify-content:center;gap:16px}
.deck .ctl button{width:52px;height:52px;border-radius:50%;border:1.5px solid var(--line);background:var(--card);color:var(--ink);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.deck .ctl .pic{width:24px;height:24px;stroke-width:4}
@keyframes up{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:none}}
@keyframes pop{0%{opacity:0;transform:scale(.6)}70%{transform:scale(1.07)}100%{opacity:1;transform:scale(1)}}
@keyframes rise{0%{opacity:0;transform:translateY(46px)}30%{opacity:1}100%{opacity:0;transform:translateY(-46px)}}
@keyframes drip{0%{opacity:0;transform:translateY(-14px)}30%{opacity:1}100%{opacity:0;transform:translateY(46px)}}
@keyframes pulse{50%{transform:scale(1.07)}}
@keyframes quarter{from{transform:rotate(0)}to{transform:rotate(90deg)}}
.deck .in{animation:up .6s both}.deck .pop{animation:pop .6s both}
.deck .rise{animation:rise 2.2s ease-in infinite}.deck .drip{animation:drip 1.6s ease-in infinite}
.deck .pulse{animation:pulse 1.6s ease-in-out infinite}.deck .turn{animation:quarter 1.4s .6s ease-in-out both}
@media (prefers-reduced-motion:reduce){.deck *{animation:none!important}}
`;

// Runs the deck. Trusted code added by the wrapper after the page is checked; it only reads the
// slides and calls adam.say, the one bridge to the screen's speaker.
const DECK_JS = `(function(){
var deck=document.querySelector('.deck');if(!deck)return;
var slides=[].slice.call(deck.querySelectorAll('.slide'));if(!slides.length)return;
var cap=document.createElement('div');cap.className='cap';deck.appendChild(cap);
var bar=document.createElement('div');bar.className='bar';bar.innerHTML='<i></i>';deck.appendChild(bar);
var ctl=document.createElement('div');ctl.className='ctl';deck.appendChild(ctl);
function btn(icon,label,fn){var b=document.createElement('button');b.setAttribute('aria-label',label);b.innerHTML='<svg class="pic"><use href="#p-'+icon+'"/></svg>';b.onclick=function(e){e.stopPropagation();fn()};ctl.appendChild(b);return b}
slides.forEach(function(s){var inner=document.createElement('div');inner.className='inner';while(s.firstChild)inner.appendChild(s.firstChild);s.appendChild(inner)});
var i=-1,paused=false,timer=null,started=0,dur=0;
function size(){var w=innerWidth,h=innerHeight,portrait=h>w*1.1;document.body.classList.toggle('portrait',portrait);var W=portrait?720:1280,H=portrait?1280:720;deck.style.setProperty('--W',W+'px');deck.style.setProperty('--H',H+'px');deck.style.setProperty('--k',Math.min(w/W,h/H));fit()}
function fit(){var s=slides[i];if(!s)return;var inner=s.firstChild;inner.style.transform='';var aw=s.clientWidth-parseFloat(getComputedStyle(s).paddingLeft)-parseFloat(getComputedStyle(s).paddingRight),ah=s.clientHeight-parseFloat(getComputedStyle(s).paddingTop)-parseFloat(getComputedStyle(s).paddingBottom);var k=Math.min(1,aw/inner.scrollWidth,ah/inner.scrollHeight);if(k<1)inner.style.transform='scale('+k+')'}
function words(t){return (t||'').trim().split(/\\s+/).filter(Boolean).length}
function show(n){clearTimeout(timer);n=Math.max(0,Math.min(slides.length-1,n));if(i>=0)slides[i].classList.remove('on');i=n;var s=slides[i];s.classList.add('on');
var k=0;[].forEach.call(s.querySelectorAll('.in,.pop'),function(el){el.style.animationDelay=(k++*0.3)+'s'});
var say=s.getAttribute('data-say')||'';cap.textContent=say;if(say&&window.adam&&window.adam.say)window.adam.say(say);
dur=(+s.getAttribute('data-secs')||Math.min(14,Math.max(4,words(say)*0.42+2)))*1000;started=Date.now();
var f=bar.firstChild;f.style.transition='none';f.style.width=(i/slides.length*100)+'%';void f.offsetWidth;f.style.transition='width '+dur+'ms linear';f.style.width=((i+1)/slides.length*100)+'%';
fit();if(!paused)timer=setTimeout(function(){if(i<slides.length-1)show(i+1);else{ended=true;setIcon('replay')}},dur)}
var ended=false;
var back=btn('arrow-right','Back',function(){ended=false;setIcon(paused?'play':'pause');show(i-1)});back.firstChild.style.transform='scaleX(-1)';
var pbtn=btn('pause','Pause',function(){if(ended){ended=false;paused=false;setIcon('pause');show(0);return}paused=!paused;setIcon(paused?'play':'pause');if(paused){clearTimeout(timer)}else{show(i)}});
function setIcon(n){pbtn.firstChild.firstChild.setAttribute('href','#p-'+n)}
btn('arrow-right','Next',function(){show(i+1)});
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight')show(i+1);else if(e.key==='ArrowLeft')show(i-1);else if(e.key===' '||e.key==='Enter')pbtn.click()});
addEventListener('resize',size);size();show(0);
})();`;

module.exports = { PIECES, PIECE_NAMES, SPRITE, DECK_CSS, DECK_JS };
