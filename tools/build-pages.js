/* Builds the service pages, work.html and privacy.html.
 *
 *   node tools/build-pages.js [version]
 *
 * Every shared piece (head links, footer, scripts, the process steps, the closing section, the
 * four exhibits) is lifted from index.html at build time, so the homepage stays the one source
 * of truth. Copy for each service page lives in pages/<slug>.json; the receptionist proof lives
 * in pages/receptionist-proof.html; the privacy text in pages/privacy.json.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V = process.argv[2] || 'pages1';
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pick = (re) => { const m = index.match(re); if (!m) throw new Error('not found in index.html: ' + re); return m[0]; };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FONTS = pick(/<link rel="icon"[\s\S]*?display=swap" rel="stylesheet">/);
const CSS = index.match(/href="(styles\.css[^"]*)"/)[1];
const FOOTER = pick(/<footer>[\s\S]*?<\/footer>/);
const SCRIPTS = pick(/<script src="js\/three\.min\.js">[\s\S]*?<\/script>\s*<script src="js\/sections\.js[^"]*"><\/script>/);
const PROCESS = pick(/<section class="process"[\s\S]*?<\/section>/);
const CLOSE = pick(/<section class="close"[\s\S]*?<\/section>/);
const WORK = pick(/<section class="work"[\s\S]*?<\/section>/);
const article = (cls) => pick(new RegExp(`<article class="${cls}"[\\s\\S]*?<\\/article>`));

const nav = (want) => `<header class="nav" id="nav"><div class="wrap nav__in"><a class="brand" href="index.html"><img src="assets/realm-mark.png" alt="Realm Systems" width="36" height="36"><span>Realm<br>Systems</span></a><nav aria-label="Main navigation"><a href="work.html">Selected work</a><a href="index.html#services">Services</a><a href="index.html#process">Process</a></nav><a class="nav__cta" href="start.html${want ? '?want=' + want : ''}">Start a job <span aria-hidden="true">↗︎</span></a></div></header>`;

const shell = ({ title, description, body, want, canonical }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:image" content="assets/logo.png">
<link rel="canonical" href="https://realmsystems.pages.dev/${canonical}">
${FONTS}
<link rel="stylesheet" href="${CSS}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${nav(want)}
<canvas id="gl" aria-hidden="true"></canvas>
<main id="main">
${body}
</main>${FOOTER}
${SCRIPTS}</body></html>
`;

const closing = (want, l1, l2) => CLOSE
  .replace(/<h2>[\s\S]*?<\/h2>/, `<h2>${esc(l1)}<br><span class="soft">${esc(l2)}</span></h2>`)
  .replace('href="start.html"', `href="start.html${want ? '?want=' + want : ''}"`);

const EXHIBITS = {
  receptionist: () => read('pages/receptionist-proof.html'),
  websites: () => article('apex'),
  automation: () => article('lead-project') + '\n' + article('ad-project'),
  '3d': () => article('pcbuild'),
};

function servicePage(p) {
  const nn = (i) => String(i + 1).padStart(2, '0');
  const body = `<section class="hero svc-hero" id="top"><div class="wrap">
<div class="eyebrow hero__eyebrow"><span>${esc(p.number)} / ${esc(p.service_name)}</span><span class="hero__edition">${esc(p.hero.eyebrow_right)}</span></div>
<div class="hero__grid"><div class="hero__copy"><h1>${esc(p.hero.headline_line1)}<br><span>${esc(p.hero.headline_line2)}</span></h1><p class="lead">${esc(p.hero.lead)}</p><div class="hero__cta"><a class="btn" href="start.html?want=${p.want}">Start a job <span aria-hidden="true">↗︎</span></a><a class="text-link" href="https://ig.me/m/realmsystems" target="_blank" rel="noopener">or message us on Instagram</a></div></div>
<aside class="pricecard"><span class="eyebrow">The price</span><strong>${esc(p.price.amount)}</strong><small>${esc(p.price.terms)}</small><ul>${p.price.included.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></aside></div>
<div class="hero__bottom"><span>${esc(p.price.note)}</span><a href="#proof">See the proof <span aria-hidden="true">↓</span></a></div>
</div></section>
<section class="block" id="problem"><div class="wrap"><div class="section-top"><span class="eyebrow">The problem</span><span class="mono">01 / 05</span></div><h2>${esc(p.problem.headline)}</h2><div class="points">${p.problem.points.map((x, i) => `<div><span class="mono">${nn(i)}</span><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p></div>`).join('')}</div></div></section>
<section class="block" id="get"><div class="wrap"><div class="section-top"><span class="eyebrow">What you get</span><span class="mono">02 / 05</span></div><h2>${esc(p.get.headline)}</h2><ul class="gets">${p.get.items.map((x, i) => `<li><span class="mono">${nn(i)}</span><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p></li>`).join('')}</ul></div></section>
<section class="block svc-proof" id="proof"><div class="wrap"><div class="section-top"><span class="eyebrow">Proof</span><span class="mono">03 / 05</span></div><h2>${esc(p.proof.headline)}</h2>
${EXHIBITS[p.slug]()}
<p class="proof-caption">${esc(p.proof.caption)}</p></div></section>
<section class="block" id="price"><div class="wrap"><div class="section-top"><span class="eyebrow">What it costs</span><span class="mono">04 / 05</span></div><div class="pricerow"><div><strong>${esc(p.price.amount)}</strong><small>${esc(p.price.terms)}</small></div><div><ul>${p.price.included.map((s) => `<li>${esc(s)}</li>`).join('')}</ul><p>${esc(p.price.extras)}</p><p>${esc(p.price.note)}</p></div></div></div></section>
${PROCESS}
<section class="block" id="faq"><div class="wrap"><div class="section-top"><span class="eyebrow">Questions</span><span class="mono">05 / 05</span></div><div class="faq">${p.faq.map((x) => `<details><summary>${esc(x.q)}</summary><p>${esc(x.a)}</p></details>`).join('')}</div></div></section>
${closing(p.want, p.close.headline_line1, p.close.headline_line2)}`;
  return shell({ title: p.page_title, description: p.meta_description, body, want: p.want, canonical: p.slug });
}

function workPage() {
  const body = WORK.replace('<span class="mono">01 / 04</span>', '<span class="mono">01 / 04</span>')
    + '\n' + closing('', 'Tell us the', 'business and the city.');
  return shell({ title: 'Selected work - Realm Systems', description: 'Four things that exist: a live website, a 3D product site you can take apart, a lead system and an ad engine. Built, not mocked up.', body, want: '', canonical: 'work' });
}

function privacyPage(d) {
  const body = `<section class="hero" id="top"><div class="wrap"><div class="eyebrow hero__eyebrow"><span>Privacy</span><span class="hero__edition">Updated ${esc(d.updated)}</span></div><h1 class="prose-title">${esc(d.title)}</h1><p class="lead">${esc(d.lead)}</p></div></section>
<section class="block" id="policy"><div class="wrap prose">${d.sections.map((s) => `<h2>${esc(s.h)}</h2>${s.p.map((t) => `<p>${esc(t)}</p>`).join('')}`).join('')}</div></section>
${closing('', 'Questions about', 'your data? Ask.')}`;
  return shell({ title: d.page_title, description: d.meta_description, body, want: '', canonical: 'privacy' });
}

const out = [];
for (const slug of ['receptionist', 'websites', 'automation', '3d']) {
  const file = path.join(ROOT, 'pages', slug + '.json');
  if (!fs.existsSync(file)) { console.log('skip', slug, '(no copy yet)'); continue; }
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(path.join(ROOT, slug + '.html'), servicePage(p));
  out.push(slug + '.html');
}
fs.writeFileSync(path.join(ROOT, 'work.html'), workPage()); out.push('work.html');
if (fs.existsSync(path.join(ROOT, 'pages', 'privacy.json'))) { fs.writeFileSync(path.join(ROOT, 'privacy.html'), privacyPage(JSON.parse(read('pages/privacy.json')))); out.push('privacy.html'); }
console.log('built:', out.join(', '), '| css', CSS, '| v', V);
