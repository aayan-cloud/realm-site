/* The white build as a full-bleed stage, scrubbed from the Blender renders of the client build:
   72 frames of a full turn, then 48 frames of it coming apart. The page's own scroll is the
   scrubber. Renders instead of live 3D because the renders have real glass, shadows and light
   and the browser could not match them at 60 frames a second. */
(() => {
  'use strict';
  const stage = document.getElementById('pc-stage');
  const pin = document.getElementById('pc-pin');
  const canvas = document.getElementById('pc-glb');
  if (!stage || !pin || !canvas) return;
  const ctx = canvas.getContext('2d');
  const readout = document.getElementById('pc-readout');
  const parts = [...document.querySelectorAll('.pc-parts li')];
  const loadBar = document.getElementById('pc-load');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(hover: none)').matches;

  const TURN = 72, OPEN = 48, N = TURN + OPEN;
  const SET = coarse ? '720' : '1080';   // phones draw the frame small; the 720 set is a third of the bytes
  const src = (i) => `assets/pc/${SET}/${i < TURN ? 'turn_' + String(i).padStart(3, '0') : 'explode_' + String(i - TURN).padStart(3, '0')}.webp`;
  const frames = new Array(N).fill(null);
  let loaded = 0, inflight = 0, next = 0;
  // Every sixth frame first, so the scrub works coarsely within a second, then the rest.
  const order = [...Array(N).keys()].sort((a, b) => (a % 6 ? 1 : 0) - (b % 6 ? 1 : 0) || a - b);
  function pump() { while (inflight < 6 && next < order.length) load(order[next++]); }
  function load(i) {
    inflight++;
    const im = new Image();
    im.decoding = 'async';
    im.onload = im.onerror = () => {
      inflight--;
      if (im.naturalWidth) {
        frames[i] = im; loaded++;
        if (loadBar) loadBar.style.transform = `scaleX(${(loaded / N).toFixed(3)})`;
        if (loaded === 1) pin.classList.add('is-ready');
        if (loaded === N) pin.classList.add('is-full');
        if (i === Math.round(cur)) draw(true);
      }
      pump();
    };
    im.src = src(i);
  }
  // Nearest loaded frame, so scrubbing works while the set is still arriving.
  function nearest(i) {
    for (let d = 0; d < N; d++) { if (frames[i + d]) return frames[i + d]; if (frames[i - d]) return frames[i - d]; }
    return null;
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  let target = 0, p = reduced ? 0.8 : 0, cur = 0, blend = 0, W = 0, H = 0, dpr = 1, running = false, visible = false, lastLabel = '';

  function progress() {
    const r = stage.getBoundingClientRect();
    target = reduced ? 0.8 : clamp(-r.top / Math.max(1, r.height - innerHeight), 0, 1);
  }
  // Square render, fitted to the stage: right of the headline on wide screens, below it on phones.
  function layout() {
    const wide = W / H >= 1.05;
    const s = wide ? Math.min(H, W * 0.6) : Math.min(W * 1.15, H * 0.62);
    return { x: wide ? W * 0.68 - s / 2 : (W - s) / 2, y: wide ? (H - s) / 2 : H * 0.6 - s / 2, s };
  }
  function draw(force) {
    // The turn ends on the front view and the explode starts from a slightly different camera,
    // so the two are crossfaded over a sliver of scroll instead of cut.
    const turnF = Math.min(TURN - 1, Math.round(ease(smooth(0, 0.42, p)) * TURN));
    const openF = TURN + Math.round(smooth(0.42, 0.9, p) * (OPEN - 1));
    const a = smooth(0.40, 0.44, p);
    const f = a < 0.5 ? turnF : openF;
    if (!force && f === cur && Math.abs(a - blend) < 0.01) return;
    cur = f; blend = a;
    const A = nearest(turnF), B = nearest(openF);
    if (!A && !B) return;
    const { x, y, s } = layout();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (a < 1 && A) { ctx.globalAlpha = 1; ctx.drawImage(A, x, y, s, s); }
    if (a > 0 && B) { ctx.globalAlpha = a; ctx.drawImage(B, x, y, s, s); ctx.globalAlpha = 1; }
    const label = p < 0.4 ? 'Turning' : p < 0.9 ? 'Coming apart' : 'Every part, modelled';
    if (readout && label !== lastLabel) { readout.textContent = label; lastLabel = label; pin.classList.toggle('is-end', p >= 0.9); }
    parts.forEach((li) => li.classList.toggle('is-on', p >= +li.dataset.at));
  }
  function tick() {
    if (!visible) { running = false; return; }
    progress();
    p += (target - p) * 0.14;
    draw(false);
    if (reduced) { running = false; return; }
    requestAnimationFrame(tick);
  }
  function start() { running = true; requestAnimationFrame(tick); }
  function resize() {
    W = pin.clientWidth; H = pin.clientHeight; dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const nav = document.getElementById('nav');
    if (nav) pin.style.setProperty('--nav-h', nav.offsetHeight + 'px');   // the sticky header sits over the stage
    progress(); if (reduced) p = target;
    draw(true);
  }
  addEventListener('resize', resize);
  resize();
  pump();
  new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible && !running) start();
  }, { rootMargin: '60%' }).observe(stage);
})();
