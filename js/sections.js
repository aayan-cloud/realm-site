/* Editorial exhibits: preserve natural scroll and accessible controls. */
(() => {
'use strict';
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const year=document.getElementById('year');if(year)year.textContent=new Date().getFullYear();
const descriptions={map:['01 / Discover','Search Google Maps for businesses in your city and trade.'],filter:['02 / Filter','Keep businesses with plenty of reviews and no website.'],check:['03 / Check','Check each business and whether it has a working website.'],message:['04 / Write','Write a personal message for each lead. Some steps run on their own; others are run by hand.'],lead:['05 / Output','A checked lead with a personal message. A list pointed at your city and your trade.']};
const nodes=[...document.querySelectorAll('.pipe__node')];
nodes.forEach(node=>node.addEventListener('click',()=>{nodes.forEach(n=>{n.classList.toggle('is-active',n===node);n.setAttribute('aria-pressed',String(n===node));});const copy=descriptions[node.dataset.key];document.getElementById('pipe-title').textContent=copy[0];document.getElementById('pipe-desc').textContent=copy[1];}));
document.querySelectorAll('.svc__row').forEach(row=>{['pointerenter','focusin'].forEach(type=>row.addEventListener(type,()=>row.classList.add('is-hot')));['pointerleave','focusout'].forEach(type=>row.addEventListener(type,()=>row.classList.remove('is-hot')));});
/* Framed site captures: Apex and the PC build site share one behaviour. Hover and scroll inside to inspect; page scrolling only leans the frame. */
const exhibits=[['apex','Apex website preview. Scroll here to inspect.'],['pc','PC build site preview. Scroll here to inspect.']].map(([key,label])=>({stage:document.getElementById(key+'-stage'),frame:document.getElementById(key+'-frame'),shot:document.getElementById(key+'-shot'),readout:document.getElementById(key+'-readout'),label})).filter(x=>x.stage&&x.frame&&x.shot);
const journey=document.getElementById('journey'),steps=[...document.querySelectorAll('.jstep')];
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));let queued=false;
exhibits.forEach(x=>{const screen=x.shot.parentElement,idle=x.readout?x.readout.textContent:'';screen.tabIndex=0;screen.setAttribute('role','region');screen.setAttribute('aria-label',x.label);const status=()=>{const travel=screen.scrollHeight-screen.clientHeight;if(x.readout)x.readout.textContent=screen.scrollTop>0?`PAGE INSPECTION / ${Math.round(screen.scrollTop/Math.max(1,travel)*100)}%`:idle;};screen.addEventListener('scroll',status,{passive:true});status();x.shot.addEventListener('load',request);});
/* 3D examples: one frame, two sites. The PC build is the default; the engine is live WebGL, so it
   only loads when chosen, and switching back unloads it. PC copy is read from the markup. */
const xTabs=[...document.querySelectorAll('.xswitch [role=tab]')],xShot=document.getElementById('pc-shot');
if(xTabs.length&&xShot){const $=id=>document.getElementById(id),el={title:$('x3d-title'),link:$('x3d-link'),linkText:$('x3d-link-text'),edgeL:$('x3d-edge-l'),edgeR:$('x3d-edge-r'),foot:$('x3d-foot'),readout:$('pc-readout'),panel:$('pc-frame')};
const X={engine:{src:xShot.getAttribute('src'),frameTitle:xShot.title,h:el.title&&el.title.innerHTML,href:el.link&&el.link.href,link:el.linkText&&el.linkText.textContent,edgeL:el.edgeL&&el.edgeL.textContent,edgeR:el.edgeR&&el.edgeR.textContent,foot:el.foot&&el.foot.textContent,readout:el.readout&&el.readout.textContent},
pc:{src:'https://aayan-cloud.github.io/techhoman-builds/white-screen-pc/',frameTitle:'The White PC with a Screen build site, live: scroll it, turn the build, take it apart',h:'A PC build you<br>can take apart.',href:'https://aayan-cloud.github.io/techhoman-builds/white-screen-pc/',link:'Open the original 3D build',edgeL:'WHITE SCREEN PC · TECH HOMAN',edgeR:'aayan-cloud.github.io/techhoman-builds ↗︎',foot:"A client asked for a $1,100 white PC. Every part modelled in 3D from the maker's photos and priced, on a page where the build turns and comes apart as you scroll.",readout:'HOVER & SCROLL INSIDE ↓ · SCROLL ON THE RENDER TO TURN IT'}};
const pick=(tab,focus)=>{const d=X[tab.dataset.x];if(!d)return;xTabs.forEach(t=>{const on=t===tab;t.setAttribute('aria-selected',String(on));t.tabIndex=on?0:-1;});if(focus)tab.focus();
if(xShot.getAttribute('src')!==d.src){xShot.src=d.src;xShot.title=d.frameTitle;}
if(el.title)el.title.innerHTML=d.h;if(el.link)el.link.href=d.href;if(el.linkText)el.linkText.textContent=d.link;if(el.edgeL)el.edgeL.textContent=d.edgeL;if(el.edgeR)el.edgeR.textContent=d.edgeR;if(el.foot)el.foot.textContent=d.foot;if(el.readout)el.readout.textContent=d.readout;if(el.panel)el.panel.setAttribute('aria-labelledby',tab.id);};
xTabs.forEach((t,i)=>{t.addEventListener('click',()=>pick(t));t.addEventListener('keydown',e=>{const k=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!k)return;e.preventDefault();pick(xTabs[(i+k+xTabs.length)%xTabs.length],true);});});}
function update(){queued=false;const vh=innerHeight;
if(!reduced)exhibits.forEach(x=>{const r=x.stage.getBoundingClientRect();if(r.bottom>0&&r.top<vh){const p=clamp((-r.top+vh*.12)/(r.height*.8));x.frame.style.transform=`rotateX(${3-p*2}deg) rotateY(${-3+p*2}deg) rotateZ(${-.4+p*.4}deg)`;}});
if(journey){const r=journey.getBoundingClientRect();let active;if(innerWidth<=760){active=0;steps.forEach((s,i)=>{if(s.getBoundingClientRect().top<vh*.62)active=i;});}else active=Math.min(3,Math.floor(clamp((vh*.9-r.top)/(vh*.7))*4));steps.forEach((s,i)=>{s.classList.toggle('is-active',i===active);s.classList.toggle('is-past',i<active);if(i===active)s.setAttribute('aria-current','step');else s.removeAttribute('aria-current');});document.getElementById('journey-rail-fill').style.width=`${(active+1)*25}%`;}
}
function request(){if(!queued){queued=true;requestAnimationFrame(update);}}
addEventListener('scroll',request,{passive:true});addEventListener('resize',request,{passive:true});update();
})();
