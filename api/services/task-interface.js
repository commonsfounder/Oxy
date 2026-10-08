'use strict';

// The same checked panel data renders in chat and on paired displays. Buttons only ask Adam.
const CSS = `
body{font-size:16px;overflow:auto}main{max-width:760px;margin:auto;padding:24px 20px 32px;display:grid;gap:24px}
h1{font-size:26px;line-height:1.15;margin:0;font-weight:600}h2{font-size:20px;margin:0}p{margin:0;white-space:pre-wrap}
section{min-width:0;display:grid;gap:12px}button,input,textarea{font:inherit;color:inherit}button{min-height:44px;cursor:pointer;border:1px solid var(--line);border-radius:12px;background:var(--card);padding:10px 14px;text-align:left}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.5;cursor:default}
.choice{display:grid;gap:4px}.choice span,.label,.detail{color:var(--muted);font-size:14px}.compare{display:flex;gap:12px;overflow:auto}.option{min-width:220px;flex:1;display:grid;gap:12px;padding:16px;border:1px solid var(--line);border-radius:16px}
.fact{display:flex;justify-content:space-between;gap:20px}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:12px;min-width:120px;border-bottom:1px solid var(--line);vertical-align:top;white-space:pre-wrap}th{font-weight:600}
label{display:grid;gap:8px}input,textarea{width:100%;border:1px solid var(--line);border-radius:10px;background:var(--card);padding:12px;min-height:44px}input::placeholder,textarea::placeholder{color:var(--muted)}.check{display:flex;align-items:center;gap:12px;min-height:44px}.check input{width:20px;min-height:20px;accent-color:var(--accent)}
.submit{background:var(--ink);color:var(--bg);text-align:center}.number{font-size:32px;font-weight:600;font-variant-numeric:tabular-nums}.bars{display:grid;gap:10px}.track{height:8px;background:var(--line);border-radius:8px;overflow:hidden}.track i{display:block;height:100%;background:var(--accent)}.followups{display:flex;gap:8px;flex-wrap:wrap}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}`;

const JS = String.raw`(function(){
var S=JSON.parse(document.getElementById('spec').textContent),main=document.createElement('main');
function el(tag,text,cls){var e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e}
function send(text){window.adam.ask('For '+S.title+': '+text)}
function button(label,request){var b=el('button',label);b.type='button';b.onclick=function(){send(request)};return b}
main.appendChild(el('h1',S.title));document.body.appendChild(main);
S.panel.forEach(function(b){var section=el('section');section.setAttribute('aria-label',b.id);main.appendChild(section);
if(b.type==='text'){section.appendChild(el(b.style==='h'?'h2':'p',b.text,b.style==='sub'?'detail':null))}
else if(b.type==='choices'){b.items.forEach(function(i){var x=button(i.title,i.ask);x.className='choice';if(i.detail)x.appendChild(el('span',i.detail));section.appendChild(x)})}
else if(b.type==='compare'){var row=el('div',null,'compare');b.items.forEach(function(i){var x=el('div',null,'option');x.appendChild(el('h2',i.title));i.facts.forEach(function(f){var r=el('div',null,'fact');r.appendChild(el('span',f.label,'label'));r.appendChild(el('span',f.value));x.appendChild(r)});if(i.ask)x.appendChild(button('Choose '+i.title,i.ask));row.appendChild(x)});section.appendChild(row)}
else if(b.type==='table'){var wrap=el('div',null,'table-wrap'),table=el('table'),head=el('thead'),tr=el('tr');b.columns.forEach(function(c){var th=el('th',c);th.scope='col';tr.appendChild(th)});head.appendChild(tr);table.appendChild(head);var body=el('tbody');b.rows.forEach(function(r){var t=el('tr');r.forEach(function(c){t.appendChild(el('td',c))});body.appendChild(t)});table.appendChild(body);wrap.appendChild(table);section.appendChild(wrap)}
else if(b.type==='form'){var form=el('form'),fields=[];b.fields.forEach(function(f){var label=el('label',f.label),input=el(f.type==='multiline'?'textarea':'input');if(f.type==='number')input.type='number';if(f.type==='number')input.step='any';input.required=f.required;input.maxLength=160;input.placeholder=f.placeholder||'';input.id=b.id+'-'+f.id;label.htmlFor=input.id;label.appendChild(input);form.appendChild(label);fields.push({f:f,input:input})});var submit=el('button',b.submit,'submit');submit.type='submit';form.appendChild(submit);form.onsubmit=function(e){e.preventDefault();if(!form.reportValidity())return;var values=fields.filter(function(x){return x.input.value.trim()}).map(function(x){return x.f.label+': '+x.input.value.trim().slice(0,160)});send(b.ask+'\n'+values.join('\n'))};section.appendChild(form)}
else if(b.type==='steps'){var checked=[];b.items.forEach(function(t,k){var label=el('label',null,'check'),input=el('input');input.type='checkbox';input.onchange=function(){checked[k]=input.checked};label.appendChild(input);label.appendChild(el('span',t));section.appendChild(label)});var share=el('button','Share progress');share.onclick=function(){var done=b.items.filter(function(t,k){return checked[k]});send('Checklist progress: '+(done.length?done.join('; '):'No items checked'))};section.appendChild(share)}
else if(b.type==='number'){if(b.label)section.appendChild(el('p',b.label,'label'));section.appendChild(el('p',b.value.toFixed(b.decimals||0)+(b.unit?' '+b.unit:''),'number'))}
else if(b.type==='bars'){var max=Math.max.apply(null,b.items.map(function(i){return i.value}))||1;b.items.forEach(function(i){var r=el('div',null,'fact');r.appendChild(el('span',i.label));r.appendChild(el('span',i.value+(b.unit?' '+b.unit:'')));section.appendChild(r);var track=el('div',null,'track'),fill=el('i');fill.style.width=(i.value/max*100)+'%';track.appendChild(fill);section.appendChild(track)})}
else if(b.type==='timeline'){b.items.forEach(function(i){var r=el('div',null,'fact');r.appendChild(el('span',i.from+(i.to?'–'+i.to:''),'label'));r.appendChild(el('span',i.label));section.appendChild(r)})}
});
if(S.asks&&S.asks.length){var footer=el('div',null,'followups');S.asks.forEach(function(a){footer.appendChild(button(a,a))});main.appendChild(footer)}
})();`;

module.exports = { CSS, JS };
