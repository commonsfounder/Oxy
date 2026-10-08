'use strict';

// Adam's scene renderer. It takes a checked scene (data only, see scene-spec.js) and plays it: a
// picture that changes over time, a panel of live numbers, captions and narration. The model never
// supplies markup or code, so how a scene looks and moves is decided here, the same way every time.

const displayScene = require('./display-scene');
const kit = require('./display-scene-kit');
const { validateScene } = require('./scene-spec');

const RUNTIME_CSS = String.raw`
body{overflow:hidden}
.stage{position:fixed;left:50%;top:50%;width:var(--W,1280px);height:var(--H,720px);transform:translate(-50%,-50%) scale(var(--k,1));background:var(--bg);overflow:hidden}
.stage .bar{position:absolute;left:0;right:0;top:0;height:6px;background:var(--line)}.stage .bar i{display:block;height:100%;width:100%;background:var(--accent);transform:scaleX(0);transform-origin:left}
.stage .main{position:absolute;left:0;right:0;top:36px;bottom:196px;display:flex;align-items:center;justify-content:center;gap:56px;padding:0 72px}
.stage .visual{flex:none;width:480px;height:480px}.stage.solo .visual{width:560px;height:560px}
.stage .panel{flex:1;max-width:640px;display:flex;flex-direction:column;gap:24px;align-items:stretch;transform-origin:center}
.stage.novis .panel{max-width:1000px}
body.portrait .stage .main{flex-direction:column;gap:32px;top:56px;bottom:260px;padding:0 48px}
body.portrait .stage .visual{width:600px;height:600px}body.portrait .stage.solo .visual{width:640px;height:640px}
body.portrait .stage .panel{max-width:none;width:100%}
.visual svg{width:100%;height:100%;fill:none;stroke:var(--ink);stroke-width:.9;stroke-linecap:round;stroke-linejoin:round;overflow:visible}
.th{transition:opacity .5s,transform .8s cubic-bezier(.3,.7,.2,1)}.th.hid{opacity:0}.th.dim *{stroke-opacity:.22}.th.dim .lbl{fill-opacity:.22}
.th .in{transform-box:fill-box;transform-origin:center;transition:transform .9s cubic-bezier(.3,.7,.2,1)}
.th.acc :not(.lbl),.th.foc :not(.lbl){stroke:var(--accent)}
.lbl{fill:var(--ink);stroke:var(--bg);stroke-width:1.6px;paint-order:stroke;stroke-linejoin:round;font-family:inherit;font-weight:500}.th.acc .lbl,.th.foc .lbl{fill:var(--accent)}
.th.pu .in{animation:pu 1.2s ease-in-out}
@keyframes pu{40%{transform:scale(1.14)}}
.th line.main{transition:stroke-dashoffset .9s ease}.th.hid line.main{stroke-dashoffset:1}
.th.flowing line.main{stroke-dasharray:.07 .05;stroke-dashoffset:0;animation:fl .7s linear infinite}
@keyframes fl{to{stroke-dashoffset:-.12}}
.ring-p{transition:stroke-dashoffset 1s ease;stroke:var(--accent)}.ring-t{stroke:var(--line)}
.blk{transition:opacity .5s,transform .6s}.blk.hid{opacity:0;transform:translateY(16px)}
.blk.dim{opacity:.3}.blk.foc{outline:2px solid var(--accent);outline-offset:8px;border-radius:16px}
.blk .h{font-size:56px;font-weight:600;line-height:1.1;letter-spacing:-.015em;margin:0}.blk .t{font-size:34px;line-height:1.3;margin:0}.blk .sub{font-size:26px;color:var(--muted);margin:0}
.num .lab{font-size:26px;color:var(--muted)}.num .v{font-size:110px;font-weight:600;line-height:1;letter-spacing:-.03em;font-variant-numeric:tabular-nums}.num .u{font-size:36px;color:var(--muted);margin-left:10px}
.bars .row{display:grid;grid-template-columns:200px 1fr 90px;align-items:center;gap:18px;font-size:26px;margin:8px 0}
.bars .tr{height:16px;border-radius:99px;background:var(--line);overflow:hidden}.bars .tr i{display:block;height:100%;width:100%;background:var(--accent);border-radius:99px;transform:scaleX(0);transform-origin:left;transition:transform 1s ease}
.bars .vv{text-align:right;font-variant-numeric:tabular-nums}
.timeline .row{display:grid;grid-template-columns:230px 1fr;align-items:center;gap:20px;font-size:26px;margin:9px 0}
.timeline .tr{position:relative;height:34px;border-radius:10px;background:var(--line)}.timeline .tr i{position:absolute;top:0;bottom:0;border-radius:10px;background:var(--accent);opacity:.85;min-width:10px}
.timeline .tr b{position:absolute;top:0;bottom:0;width:3px;background:var(--needs)}
.timeline .times{display:flex;justify-content:space-between;font-size:22px;color:var(--muted);margin-left:250px}
.timer .v{font-size:96px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1}.timer .lab{font-size:26px;color:var(--muted)}
.st{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px;font-size:30px}
.st li{display:flex;gap:20px;align-items:center;color:var(--muted);transition:color .4s}
.st li::before{content:attr(data-n);flex:none;width:56px;height:56px;border-radius:50%;border:2px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:600;transition:all .4s}
.st li.done{color:var(--ink)}.st li.done::before{border-color:var(--ink)}
.st li.on{color:var(--ink);font-weight:600}.st li.on::before{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.cmp{display:flex;gap:24px}.cmp .card{flex:1;font-size:26px;cursor:pointer;gap:10px}.cmp .card h3{font-size:34px;margin:0}
.cmp .f{display:flex;justify-content:space-between;width:100%;gap:16px}.cmp .f span:first-child{color:var(--muted)}
body.portrait .cmp{flex-direction:column}
.stage .cap{position:absolute;left:0;right:0;bottom:104px;text-align:center;padding:0 72px;font-size:30px;line-height:1.35;color:var(--muted);min-height:2.7em}
.stage .asks{position:absolute;left:0;right:0;bottom:98px;display:flex;justify-content:center;gap:16px;padding:0 48px;flex-wrap:wrap}
.stage .asks .btn{font-size:26px}
body.portrait .stage .cap{bottom:128px;padding:0 48px}body.portrait .stage .asks{bottom:120px}
.stage .ctl{position:absolute;left:0;right:0;bottom:22px;display:flex;justify-content:center;gap:16px}
.stage .ctl button{width:52px;height:52px;border-radius:50%;border:1.5px solid var(--line);background:var(--card);color:var(--ink);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.stage .ctl .pic{width:24px;height:24px;stroke-width:4}
.quiet *{transition:none!important;animation:none!important}
@media (prefers-reduced-motion:reduce){.stage *{transition:none!important;animation:none!important}}
`;

const RUNTIME_JS = String.raw`(function(){
var S=JSON.parse(document.getElementById('spec').textContent);
var NS='http://www.w3.org/2000/svg';
var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function sv(tag,a){var e=document.createElementNS(NS,tag);for(var k in a)e.setAttribute(k,a[k]);return e}
function words(t){return (t||'').trim().split(/\s+/).filter(Boolean).length}
var shown={};S.beats.forEach(function(b){(b.do||[]).forEach(function(d){if(d.verb==='show'&&d.id)shown[d.id]=true})});

var stage=el('div','stage'+(S.visual&&!S.panel?' solo':'')+(!S.visual?' novis':''));
var bar=el('div','bar');bar.appendChild(el('i'));stage.appendChild(bar);
var main=el('div','main');stage.appendChild(main);
var cap=el('div','cap');stage.appendChild(cap);
var asks=el('div','asks');stage.appendChild(asks);
var ctl=el('div','ctl');stage.appendChild(ctl);
document.body.appendChild(stage);

var T={},live=[],panelEl=null;

function head(from,to){var a=Math.atan2(to[1]-from[1],to[0]-from[0]),L=3.4,p=[];[-0.5,0.5].forEach(function(o){p.push((to[0]-L*Math.cos(a+o))+','+(to[1]-L*Math.sin(a+o)))});return p[0]+' '+to[0]+','+to[1]+' '+p[1]}

function slotsFor(n){
  var cols=n<=3?n:n<=4?2:n<=6?3:4,rows=Math.ceil(n/cols),size=n===1?56:n===2?38:n<=4?28:n<=6?24:20,out=[];
  for(var r=0;r<rows;r++){var cnt=Math.min(cols,n-r*cols);for(var k=0;k<cnt;k++)out.push([100*(k+1)/(cnt+1),rows===1?44:28+r*40])}
  return {pos:out,size:size};
}

function mkThing(t,at,size){
  var g=sv('g',{'class':'th'+(shown[t.id]?' hid':'')+(t.accent?' acc':'')}),inner=sv('g',{'class':'in'});g.appendChild(inner);
  var rec={spec:t,node:g,inner:inner,at:at,size:size};
  if(t.type==='piece'){
    inner.appendChild(sv('use',{href:'#p-'+t.piece,x:at[0]-size/2,y:at[1]-size/2,width:size,height:size,'stroke-width':3.2}));
    if(t.label){var l=sv('text',{x:at[0],y:at[1]+size/2+6,'text-anchor':'middle','font-size':size>40?5:4,'class':'lbl'});l.textContent=t.label;g.appendChild(l);rec.text=l}
  }else if(t.type==='ring'){
    var rad=size/2-2,circ=2*Math.PI*rad;
    inner.appendChild(sv('circle',{cx:at[0],cy:at[1],r:rad,'class':'ring-t','stroke-width':2.4}));
    var p=sv('circle',{cx:at[0],cy:at[1],r:rad,'class':'ring-p','stroke-width':2.4,'stroke-dasharray':circ,'stroke-dashoffset':circ*(1-t.value),transform:'rotate(-90 '+at[0]+' '+at[1]+')'});
    inner.appendChild(p);rec.prog=p;rec.circ=circ;
    if(t.label){var rl=sv('text',{x:at[0],y:at[1]+size/2+6,'text-anchor':'middle','font-size':4,'class':'lbl'});rl.textContent=t.label;g.appendChild(rl);rec.text=rl}
  }
  return rec;
}

function mkConnector(t,A,B){
  var g=sv('g',{'class':'th'+(shown[t.id]?' hid':'')+(t.accent?' acc':'')}),inner=sv('g',{'class':'in'});g.appendChild(inner);
  var dx=B.at[0]-A.at[0],dy=B.at[1]-A.at[1],d=Math.sqrt(dx*dx+dy*dy)||1,ux=dx/d,uy=dy/d;
  var f=[A.at[0]+ux*(A.size/2+2),A.at[1]+uy*(A.size/2+2)],e=[B.at[0]-ux*(B.size/2+2),B.at[1]-uy*(B.size/2+2)];
  var ln=sv('line',{x1:f[0],y1:f[1],x2:e[0],y2:e[1],pathLength:1,'class':'main'});
  if(t.dashed&&t.type==='line')ln.setAttribute('stroke-dasharray','.04 .03');else ln.setAttribute('stroke-dasharray',t.type==='flow'?'.07 .05':'1');
  inner.appendChild(ln);
  if(t.type!=='line')inner.appendChild(sv('polyline',{points:head(f,e),fill:'none'}));
  if(t.type==='flow')g.classList.add('flowing');
  return {spec:t,node:g,inner:inner};
}

function clock(hhmm){var p=hhmm.split(':'),d=new Date();d.setHours(+p[0],+p[1],0,0);return d}
function mins(hhmm){var p=hhmm.split(':');return +p[0]*60+ +p[1]}
function pad(n){return (n<10?'0':'')+n}

function mkBlock(b){
  var w=el('div','blk '+b.type+(shown[b.id]?' hid':'')),rec={spec:b,node:w};
  if(b.type==='text'){w.appendChild(el('p',b.style,b.text));rec.text=w.firstChild}
  else if(b.type==='number'){
    if(b.label)w.appendChild(el('div','lab',b.label));
    var row=el('div'),v=el('span','v',''),u=b.unit?el('span','u',b.unit):null;row.appendChild(v);if(u)row.appendChild(u);w.appendChild(row);
    rec.cur=b.value;function fmt(x){return x.toFixed(b.decimals||0)}v.textContent=fmt(b.value);
    rec.setVal=function(to,anim){if(!anim||reduce){rec.cur=to;v.textContent=fmt(to);return}var from=rec.cur,t0=performance.now();(function f(n){var k=Math.min(1,(n-t0)/900);k=1-Math.pow(1-k,3);rec.cur=from+(to-from)*k;v.textContent=fmt(rec.cur);if(k<1)requestAnimationFrame(f)})(t0)};
  }else if(b.type==='bars'){
    var max=Math.max.apply(null,b.items.map(function(i){return i.value}))||1;
    b.items.forEach(function(i){var r=el('div','row');r.appendChild(el('span',null,i.label));var tr=el('div','tr'),f=el('i');tr.appendChild(f);r.appendChild(tr);r.appendChild(el('span','vv',i.value+(b.unit?' '+b.unit:'')));w.appendChild(r);setTimeout(function(){f.style.transform='scaleX('+(i.value/max)+')'},30)});
  }else if(b.type==='timeline'){
    var lo=1e9,hi=-1e9;b.items.forEach(function(i){lo=Math.min(lo,mins(i.from));hi=Math.max(hi,i.to?mins(i.to):mins(i.from)+10)});if(b.end)hi=Math.max(hi,mins(b.end));if(hi<=lo)hi=lo+30;
    var nowEl=[];
    b.items.forEach(function(i){var r=el('div','row');r.appendChild(el('span',null,i.label));var tr=el('div','tr'),f=el('i'),a=mins(i.from),z=i.to?mins(i.to):a+10;f.style.left=((a-lo)/(hi-lo)*100)+'%';f.style.width=((z-a)/(hi-lo)*100)+'%';tr.appendChild(f);var nb=el('b');tr.appendChild(nb);nowEl.push(nb);r.appendChild(tr);w.appendChild(r)});
    var tt=el('div','times');tt.appendChild(el('span',null,pad(Math.floor(lo/60))+':'+pad(lo%60)));tt.appendChild(el('span',null,pad(Math.floor(hi/60))+':'+pad(hi%60)));w.appendChild(tt);
    live.push(function(){var d=new Date(),m=d.getHours()*60+d.getMinutes()+d.getSeconds()/60,k=(m-lo)/(hi-lo);nowEl.forEach(function(n){n.style.display=k>=0&&k<=1?'block':'none';n.style.left=(k*100)+'%'})});
  }else if(b.type==='timer'){
    if(b.label)w.appendChild(el('div','lab',b.label));var tv=el('div','v','');w.appendChild(tv);
    var end=b.to?clock(b.to):new Date(Date.now()+b.secs*1000);if(b.to&&end<=new Date())end=new Date(end.getTime()+864e5);
    live.push(function(){var s=Math.max(0,Math.round((end-new Date())/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60);tv.textContent=(h?h+':'+pad(m):m)+':'+pad(s%60)});
  }else if(b.type==='steps'){
    var ol=el('ol','st');rec.lis=b.items.map(function(t,k){var li=el('li',null,t);li.setAttribute('data-n',k+1);ol.appendChild(li);return li});w.appendChild(ol);
    rec.setStep=function(n){rec.lis.forEach(function(li,k){li.className=k+1<n?'done':k+1===n?'on':''})};
  }else if(b.type==='compare'){
    var cm=el('div','cmp');b.items.forEach(function(i){var c=el('div','card');if(i.ask)c.setAttribute('data-ask',i.ask);c.appendChild(el('h3',null,i.title));i.facts.forEach(function(f){var r=el('div','f');r.appendChild(el('span',null,f.label));r.appendChild(el('span',null,f.value));c.appendChild(r)});cm.appendChild(c)});w.appendChild(cm);
  }
  return rec;
}

function build(){
  main.textContent='';T={};live=[];
  if(S.visual){var vb=el('div','visual'),svg=sv('svg',{viewBox:'0 0 100 100'}),th=S.visual.things;
    var slots=th.filter(function(t){return t.type==='piece'||t.type==='ring'}),lay=slotsFor(slots.length),recs=[];
    slots.forEach(function(t,k){var r=mkThing(t,lay.pos[k],lay.size);T[t.id]=r;recs.push(r)});
    th.forEach(function(t){if(t.type!=='piece'&&t.type!=='ring'){var r=mkConnector(t,T[t.from],T[t.to]);T[t.id]=r;svg.appendChild(r.node)}});
    recs.forEach(function(r){svg.appendChild(r.node)});vb.appendChild(svg);main.appendChild(vb)}
  if(S.panel){panelEl=el('div','panel');S.panel.forEach(function(b){var r=mkBlock(b);T[b.id]=r;panelEl.appendChild(r.node)});main.appendChild(panelEl)}
  live.forEach(function(f){f()});
}

function clearFocus(){Object.keys(T).forEach(function(k){T[k].node.classList.remove('foc','dim')})}
function apply(d,anim){
  var t=d.id?T[d.id]:null,n=t&&t.node;
  switch(d.verb){
    case 'show':case 'trace':if(n)n.classList.remove('hid');break;
    case 'hide':if(n)n.classList.add('hid');break;
    case 'focus':clearFocus();if(n){n.classList.add('foc');Object.keys(T).forEach(function(k){var o=T[k];if(o!==t&&o.spec.type!=='line'&&o.spec.type!=='arrow'&&o.spec.type!=='flow'&&o.spec.type!=='ring')o.node.classList.add('dim')})}break;
    case 'dim':if(n)n.classList.add('dim');break;
    case 'move':if(n&&t.at&&T[d.to]&&T[d.to].at){n.style.transform='translate('+(T[d.to].at[0]-t.at[0])+'px,'+(T[d.to].at[1]-t.at[1])+'px)'}break;
    case 'turn':if(t)t.inner.style.transform='rotate('+d.deg+'deg)';break;
    case 'count':if(t&&t.setVal)t.setVal(d.value,anim);break;
    case 'progress':if(t&&t.prog)t.prog.setAttribute('stroke-dashoffset',t.circ*(1-Math.max(0,Math.min(1,d.value))));break;
    case 'flow':if(n){n.classList.remove('hid');n.classList.add('flowing')}break;
    case 'pulse':if(n){n.classList.remove('pu');void n.getBoundingClientRect();n.classList.add('pu')}break;
    case 'set':if(t&&t.text){t.text.textContent=d.text}break;
    case 'step':if(t&&t.setStep)t.setStep(d.n);break;
  }
}
function run(b,anim){(b.do||[]).forEach(function(d){apply(d,anim)})}

var i=-1,paused=false,ended=false,timer=null;
function size(){var w=innerWidth,h=innerHeight,portrait=h>w*1.1;document.body.classList.toggle('portrait',portrait);var W=portrait?720:1280,H=portrait?1280:720;stage.style.setProperty('--W',W+'px');stage.style.setProperty('--H',H+'px');stage.style.setProperty('--k',Math.min(w/W,h/H));fit()}
function fit(){if(!panelEl)return;panelEl.style.transform='';var k=Math.min(1,main.clientHeight/(panelEl.scrollHeight+8),(main.clientWidth-140)/(panelEl.scrollWidth+1));if(k<1)panelEl.style.transform='scale('+k+')'}
function dur(b){return (b.secs||Math.max(3.5,words(b.say)*0.4+1.5))*1000}
function go(n){
  clearTimeout(timer);n=Math.max(0,Math.min(S.beats.length-1,n));ended=false;asks.textContent='';
  build();stage.classList.add('quiet');for(var k=0;k<n;k++)run(S.beats[k],false);
  void stage.offsetWidth;stage.classList.remove('quiet');void stage.offsetWidth;
  i=n;var b=S.beats[i];run(b,true);
  cap.textContent=b.say||'';if(b.say&&window.adam&&window.adam.say)window.adam.say(b.say);
  var f=bar.firstChild,d=dur(b);f.style.transition='none';f.style.transform='scaleX('+(i/S.beats.length)+')';void f.offsetWidth;f.style.transition='transform '+d+'ms linear';f.style.transform='scaleX('+((i+1)/S.beats.length)+')';
  fit();if(!paused)timer=setTimeout(function(){if(i<S.beats.length-1)go(i+1);else finish()},d);
}
function finish(){ended=true;setIcon('replay');(S.asks||[]).forEach(function(a){var b=el('button','btn',a);b.setAttribute('data-ask',a);asks.appendChild(b)});if(S.asks&&S.asks.length)cap.textContent=''}
function icon(n,label,fn){var b=document.createElement('button');b.setAttribute('aria-label',label);b.innerHTML='<svg class="pic"><use href="#p-'+n+'"/></svg>';b.onclick=function(e){e.stopPropagation();fn()};ctl.appendChild(b);return b}
var back=icon('arrow-right','Back',function(){setIcon(paused?'play':'pause');go(i-1)});back.firstChild.style.transform='scaleX(-1)';
var pb=icon('pause','Pause',function(){if(ended){paused=false;setIcon('pause');go(0);return}paused=!paused;setIcon(paused?'play':'pause');if(paused)clearTimeout(timer);else go(i)});
function setIcon(n){pb.firstChild.firstChild.setAttribute('href','#p-'+n)}
icon('arrow-right','Next',function(){if(i<S.beats.length-1)go(i+1);else finish()});
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight')go(i+1);else if(e.key==='ArrowLeft')go(i-1);else if(e.key===' '||e.key==='Enter')pb.click()});
addEventListener('resize',size);
setInterval(function(){live.forEach(function(f){f()})},1000);
size();go(0);
})();`;

function jsonForScript(spec) {
  return JSON.stringify(spec).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// The whole page for a scene: the policy, Adam's look, the pieces, the scene as inert data, and the
// renderer. The model's scene is never parsed as markup.
function buildSpecDocument(raw) {
  const spec = validateScene(raw);
  const title = spec.title.replace(/[<>&"]/g, '');
  if (spec.mode === 'interface') {
    const ui = require('./task-interface');
    return '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">'
      + `<meta http-equiv="Content-Security-Policy" content="${displayScene.CSP}">`
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + `<title>${title}</title><style>${displayScene.KIT_CSS}${ui.CSS}</style></head><body>`
      + `<script type="application/json" id="spec">${jsonForScript(spec)}</script>`
      + `<script>${displayScene.BRIDGE_JS}</script><script>${ui.JS}</script></body></html>`;
  }
  return '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${displayScene.CSP}">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${title}</title><style>${displayScene.KIT_CSS}${kit.PIECE_CSS}${RUNTIME_CSS}</style></head><body>${kit.SPRITE}`
    + `<script type="application/json" id="spec">${jsonForScript(spec)}</script>`
    + `<script>${displayScene.BRIDGE_JS}</script><script>${RUNTIME_JS}</script></body></html>`;
}

module.exports = { RUNTIME_CSS, RUNTIME_JS, buildSpecDocument };
