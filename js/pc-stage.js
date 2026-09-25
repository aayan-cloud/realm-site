/* The white build in the same framed exhibit as the Apex site: hover and scroll over the frame
   to turn it, keep going to take it apart; swipe on a phone. The frames are the Blender renders
   of the client build (72 of a full turn, 48 of it coming apart), because the renders have real
   glass, shadows and light and a live model in the browser never matched them. */
(() => {
  'use strict';
  const stage = document.getElementById('pc-stage');
  const frame = document.getElementById('pc-frame');
  const screen = document.getElementById('pc-screen');
  const canvas = document.getElementById('pc-glb');
  if (!stage || !frame || !screen || !canvas) return;
  const ctx = canvas.getContext('2d');
  const readout = document.getElementById('pc-readout');
  const parts = [...document.querySelectorAll('.pc-parts li')];
  const loadBar = document.getElementById('pc-load');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(hover: none)').matches;
  const BG = '#0b0c0e';

  const TURN = 72, OPEN = 48, N = TURN + OPEN, LAST = N - 1;
  const SET = coarse ? '720' : '1080';   // phones draw the frame small; the 720 set is a third of the bytes
  const src = (i) => `assets/pc/${SET}/${i < TURN ? 'turn_' + String(i).padStart(3, '0') : 'explode_' + String(i - TURN).padStart(3, '0')}.webp`;
  const frames = new Array(N).fill(null);
  let loaded = 0, inflight = 0, next = 0;
  // Every sixth frame first, so scrubbing works coarsely within a second, then the rest.
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
        if (loaded === 1) screen.classList.add('is-ready');
        if (loaded === N) screen.classList.add('is-full');
        if (i === Math.round(cur)) draw(true);
      }
      pump();
    };
    im.src = src(i);
  }
  function nearest(i) {   // nearest loaded frame, so scrubbing works while the set is still arriving
    for (let d = 0; d < N; d++) { if (frames[i + d]) return frames[i + d]; if (frames[i - d]) return frames[i - d]; }
    return null;
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  let target = 0, cur = 0, W = 0, H = 0, dpr = 1, raf = 0, drawn = '', touched = false;

  function draw(force) {
    // The turn ends on the front view and the explode starts from a slightly different camera,
    // so those two frames are crossfaded instead of cut.
    const n = Math.round(cur);
    let A, B = null, a = 0;
    if (cur > TURN - 1 && cur < TURN) { A = nearest(TURN - 1); B = nearest(TURN); a = cur - (TURN - 1); } else A = nearest(n);
    const key = n + ':' + a.toFixed(2);
    if (!force && key === drawn) return;
    drawn = key;
    if (!A) return;
    const s = Math.min(W, H), x = (W - s) / 2, y = (H - s) / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1; ctx.drawImage(A, x, y, s, s);
    if (B && a > 0) { ctx.globalAlpha = a; ctx.drawImage(B, x, y, s, s); ctx.globalAlpha = 1; }
    // Soften the render's square edges into the box so the studio floor doesn't end in a line.
    const fade = s * 0.1;
    [[x, x + fade], [x + s, x + s - fade]].forEach(([from, to]) => {
      const g = ctx.createLinearGradient(from, 0, to, 0);
      g.addColorStop(0, BG); g.addColorStop(1, 'rgba(11,12,14,0)');
      ctx.fillStyle = g; ctx.fillRect(Math.min(from, to), y, fade, s);
    });
  }
  function ui() {
    const n = Math.round(cur), p = n / LAST;
    if (readout) {
      readout.textContent = !touched ? (coarse ? 'SWIPE TO TURN →' : 'HOVER & SCROLL TO TURN ↓')
        : n < TURN ? `TURN / ${Math.round(n / (TURN - 1) * 100)}%`
        : n < LAST ? `COMING APART / ${Math.round((n - TURN) / (OPEN - 1) * 100)}%` : 'EVERY PART, MODELLED';
    }
    parts.forEach((li) => li.classList.toggle('is-on', p >= +li.dataset.at));
  }
  function tick() {
    raf = 0;
    cur += (target - cur) * (reduced ? 1 : 0.18);
    if (Math.abs(target - cur) < 0.02) cur = target;
    draw(false); ui();
    if (cur !== target) loop();
  }
  function loop() { if (!raf) raf = requestAnimationFrame(tick); }
  function setTarget(v) { target = clamp(v, 0, LAST); touched = true; loop(); }

  // Hover and scroll over the frame, like the Apex exhibit. At either end the page scrolls on.
  screen.addEventListener('wheel', (e) => {
    if (e.ctrlKey || !e.deltaY) return;
    const dir = Math.sign(e.deltaY);
    if ((dir < 0 && target <= 0) || (dir > 0 && target >= LAST)) return;
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    setTarget(target + delta / 22);
  }, { passive: false });
  // Drag sideways (a finger on phones): one screen width is one full turn. Vertical swipes still scroll the page.
  let dragX = null, dragFrom = 0;
  screen.addEventListener('pointerdown', (e) => { dragX = e.clientX; dragFrom = target; try { screen.setPointerCapture(e.pointerId); } catch (_) {} });
  screen.addEventListener('pointermove', (e) => { if (dragX === null) return; setTarget(dragFrom + (e.clientX - dragX) / Math.max(1, W) * TURN); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => screen.addEventListener(t, () => { dragX = null; }));
  screen.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 2, ArrowUp: 2, ArrowLeft: -2, ArrowDown: -2 }[e.key];
    if (e.key === 'Home') setTarget(0); else if (e.key === 'End') setTarget(LAST); else if (step) setTarget(Math.round(target) + step); else return;
    e.preventDefault();
  });

  // The frame leans with the page like the Apex frame does (same numbers as sections.js).
  function tilt() {
    if (reduced) return;
    const r = stage.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const p = clamp((-r.top + innerHeight * 0.12) / (r.height * 0.8), 0, 1);
    frame.style.transform = `rotateX(${3 - p * 2}deg) rotateY(${-3 + p * 2}deg) rotateZ(${-0.4 + p * 0.4}deg)`;   // a third of the Apex lean
  }
  let tiltRaf = 0;
  addEventListener('scroll', () => { if (!tiltRaf) tiltRaf = requestAnimationFrame(() => { tiltRaf = 0; tilt(); }); }, { passive: true });

  function resize() {
    W = screen.clientWidth; H = screen.clientHeight; dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    draw(true); ui(); tilt();
  }
  addEventListener('resize', resize);
  resize();
  pump();
})();
