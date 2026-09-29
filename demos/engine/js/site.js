// site.js — a scroll through the machine.
//
// Five chapters. The camera moves, the section opens, the numbers change. The
// studio that lights the metal is built in code; the warm light that moves comes
// from whichever cylinder is on its power stroke at that instant. That last part
// is the point: the glow and the physics are the same system.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import {
  SPEC, Engine, clamp, wrap720, wristHeight, wristVelocity,
  cylinderPressure, torqueAt, powerAt, bsfc, airFuelRatio, volumetricEfficiency,
  imep, setCompressionRatio, peakTorque, peakPower, FIRE_ANGLE, TDC_Y,
} from './sim.js';
import { buildEngine, updateEngine, setSection, intakeLift, exhaustLift } from './engine.js';
import { Post } from './post.js';
import { makeEmbers, makeDust, makeShaft, makeGlow } from './atmos.js';
import { makeFloor } from './stage.js';

const $ = s => document.querySelector(s);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SLOWMO = 0.14;
const fmt = (v, d = 0) => Number(v).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------------------------------------------------------------- renderer
// Hex colours are sRGB and the lighting maths runs in linear. This has to be set
// before any material or colour is made.
THREE.ColorManagement.legacyMode = false;
const canvas = $('#view');
// no canvas MSAA: the scene is drawn into its own multisampled target by post.js
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
// Framed on the Realm site the canvas shares the GPU with the host page, so it is
// held to a pixel budget rather than a flat ratio: the 1164px desktop frame stays
// at 1.5x, and the 340px phone frame on a 3x phone is drawn at 3x instead of at
// 1.5x and blown up, soft and jagged beside crisp text. (That is 0.7 megapixels,
// under half of the desktop frame.) Standalone it is held to a budget as well, up
// to 2x: a 1440x900 window on a 2x screen is 5.2 megapixels at full ratio, and it
// ran under 40 fps through the first seconds on the test machine; at 2.3 it holds
// 60 with room. (post.js scales the scene pass further on still bigger windows.)
const EMBED = window.self !== window.top || document.documentElement.classList.contains('framed');
const dpr = () => {
  const a = Math.max(1, innerWidth * innerHeight);
  return Math.min(devicePixelRatio, EMBED ? Math.min(3, Math.max(1, Math.sqrt(1.65e6 / a))) : Math.min(2, Math.max(1, Math.sqrt(2.3e6 / a))));
};
renderer.setPixelRatio(dpr());
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.localClippingEnabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
window.__renderer = renderer;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07070a);

// a product-photography tele: less distortion on a machine this size
const camera = new THREE.PerspectiveCamera(26, 1, 0.02, 24);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 0.30;
controls.maxDistance = 2.6;
controls.maxPolarAngle = Math.PI * 0.56;
controls.enabled = false;                 // the scroll drives the camera; drag only nudges it

// ---------------------------------------------------------------- light
// A dark studio: one warm key with a soft shadow, a rim to find the silhouette,
// a whisper of neutral fill, and reflections from a studio room built in code
// (no image). The only warm, moving light is still the one the combustion makes.
// (the key a little up and the fill and sky a little down from where they were:
// the shadow side of the block and the underside of the runners now fall away,
// which is most of what separates a photographed casting from a flat-lit one)
scene.add(new THREE.HemisphereLight(0x2a3038, 0x05050a, 0.08));
const key = new THREE.DirectionalLight(0xfffaf5, 2.25);
key.position.set(0.45, 1.5, 0.75);
key.castShadow = true;
// half the shadow map on touch devices, where the fill rate is what runs out
key.shadow.mapSize.setScalar(matchMedia('(pointer: coarse)').matches ? 1024 : 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.0015;
scene.add(key, key.target);
// A neutral, slightly cool rim: a warm one turned the alloy and the floor brown
// and competed with the one warm light that means something, the combustion.
const rim = new THREE.DirectionalLight(0xdde4ee, 1.3);
rim.position.set(-0.9, 0.35, -1.1);
scene.add(rim);
const fill = new THREE.DirectionalLight(0xc8d0da, 0.25);
fill.position.set(-0.6, -0.2, 0.9);
scene.add(fill);
scene.environment = studioEnvironment(renderer);

// The room the metal reflects: a dark box with emissive softboxes aimed at the
// engine, turned into a prefiltered environment once, before the curtain lifts.
function studioEnvironment(r) {
  const room = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 10), new THREE.MeshBasicMaterial({ color: 0x16171a, side: THREE.BackSide }));
  box.position.y = 2;
  room.add(box);
  // A softbox is brightest in the middle and falls off toward its frame, so each
  // panel carries a falloff in its vertex colours: a broad face of cast alloy then
  // shows a gradient in its sheen, the way metal photographs, not a flat tone.
  const panel = (w, h, x, y, z, k, col = 0xffffff, fall = 0.55) => {
    const g = new THREE.PlaneGeometry(w, h, 10, 10), p = g.attributes.position, c = new Float32Array(p.count * 3), base = new THREE.Color(col).multiplyScalar(k);
    for (let i = 0; i < p.count; i++) {
      const u = (2 * p.getX(i)) / w, v = (2 * p.getY(i)) / h, f = 1 - fall * Math.min(1, u * u * 0.6 + v * v * 0.6 + (u * u * v * v) * 0.4);
      c[i * 3] = base.r * f; c[i * 3 + 1] = base.g * f; c[i * 3 + 2] = base.b * f;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0.2, 0); room.add(m);
    return m;
  };
  panel(3.0, 1.6, 0.6, 4.6, 1.6, 2.2);                  // overhead key softbox
  // A broad, dim scrim on the camera side, above the lens: every face of the
  // casting turned toward the viewer reflects it, so the alloy reads as metal with
  // a soft sheen across it instead of as grey paint under a lamp.
  panel(6.0, 2.6, 1.2, 2.2, 4.4, 0.55, 0xf4f1ec, 0.7);
  // Two hard strips, narrow and bright: turned edges, journals, bolt chamfers and
  // pulley rims catch them as crisp white lines, the glints a photograph of
  // machined steel clips on. Too small to add to the light on anything matte.
  panel(0.16, 3.6, 2.4, 3.4, -0.6, 14.0, 0xffffff, 0.2);
  panel(3.4, 0.12, -0.8, 4.2, 2.2, 12.0, 0xffffff, 0.2);
  // warm strip, rear left: only just warm. A saturated one put copper on every
  // alloy face turned away from the key (manifold runners, barrel flanks).
  panel(0.5, 3.2, -4.4, 1.6, -2.0, 2.6, 0xffeee0);
  panel(0.5, 3.2, 4.4, 1.6, -1.6, 2.0, 0xd8e4ff);       // cool strip, rear right
  panel(2.4, 1.2, 3.2, 1.2, 3.6, 0.6);                  // front fill card
  // floor bounce, kept low: brighter, every face turned down (the skirts, the sump
  // flanks) mirrored it and read as pale plaster beside the same casting facing out
  panel(6.0, 6.0, 0, -0.95, 0, 0.05);
  panel(3.2, 2.0, -3.4, 0.9, 3.2, 0.8);                 // low front-left card: the intake faces reflect it
  panel(4.0, 1.2, 0.0, 4.9, -1.0, 1.2);                 // high rear strip: a top edge light on the metal
  const pm = new THREE.PMREMGenerator(r);
  const tex = pm.fromScene(room, 0.035).texture;
  pm.dispose();
  room.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  return tex;
}

// the chamber that is firing lights its own interior. One light, moved and pulsed
// per frame, so the engine's warmth is never a static lamp. It casts no shadow, so
// its reach is held to the bore it is in and its neighbours (0.2 m): at 0.55 m it
// lit the cam sprocket and the cover from inside the casting, as if through it.
const fire = new THREE.PointLight(0xff7a2a, 0, 0.2, 2);
scene.add(fire);

// ---------------------------------------------------------------- engine
const E = buildEngine();
scene.add(E.root);          // the engine sets its own shadow flags part by part

const BOX = new THREE.Box3().setFromObject(E.root);
const MID = new THREE.Vector3(); BOX.getCenter(MID);
const REACH = Math.max(BOX.max.x - BOX.min.x, BOX.max.y - BOX.min.y, BOX.max.z - BOX.min.z);

{
  // a tight frustum on the engine: 2048 texels over 0.9 m is under half a millimetre
  key.target.position.copy(MID);
  key.position.copy(MID).add(new THREE.Vector3(0.45, 1.5, 0.75));
  const R = Math.max(0.42, REACH * 0.68);
  key.shadow.camera.left = -R; key.shadow.camera.right = R;
  key.shadow.camera.top = R; key.shadow.camera.bottom = -R;
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 3.2;
  key.shadow.camera.updateProjectionMatrix();
}
// A studio floor under the sump (stage.js): a lit pool that melts into the
// background with no edge, the shadow held grey and fading with distance.
const floor = makeFloor(MID, BOX, REACH, scene.background);
scene.add(floor);

const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0.12);
let section = 0;
// fully open, the cut runs through the bore axes, the chamber ridge and the crank
// centreline, where a museum cutaway is cut
// The clip stays switched on and, while the casting is closed, is parked well clear
// of the engine. Switching it on at the first scroll recompiled every clipped
// material: a 1.6 s freeze just as the section began to open. Every other engine
// material carries one plane too, parked where it cuts nothing, so the sectioned
// shells share their shader programs and the engine compiles once, under the
// curtain, instead of twice.
{
  const parked = new THREE.Plane(new THREE.Vector3(0, 0, -1), 50);
  E.root.traverse(o => {
    if (!o.material || o.userData.helper) return;
    for (const m of [].concat(o.material)) if (!E.clipMats.includes(m) && !m.clippingPlanes) m.clippingPlanes = [parked];
  });
}
const applySection = () => {
  sectionPlane.constant = section > 0.002 ? 0.12 - section * 0.118 : 50;
  setSection(E, 1, sectionPlane);
};

// The sectioned interior was falling to pure black, which reads as a solid box
// rather than a cutaway. This sits in the crankcase and lifts just enough to
// separate the mechanism from the void behind it; the studio reflections do the rest.
// It casts no shadow, so its reach is held to the crankcase and the bores: at 1.5 m
// it put a copper sheen on the cam sprocket, lit through the front of the block.
const guts = new THREE.PointLight(0xffb277, 0.50, REACH * 0.85, 2);
// pushed behind the crank line: close in, it blew the crankpin journals to white
guts.position.set(MID.x, E.DECK - 0.13, -0.085);
scene.add(guts);
// It casts no shadow, so while the casting is closed it shone straight through it
// and put a copper cast on every face underneath (runners, barrels, skirts): the
// engine brings it up with the cut instead (engine.js, setSection).
E.guts = guts;

// ---------------------------------------------------------------- atmosphere
const embers = makeEmbers(SPEC, E.DECK, E.CYL_X, 460);
const dust = makeDust(950, REACH * 1.25);
const shaft = makeShaft(MID.y + REACH * 1.5, E.DECK - REACH * 0.55, REACH * 0.72);
const glow = makeGlow(REACH * 2.4);
glow.object.position.set(MID.x, MID.y + REACH * 0.10, MID.z - REACH * 0.85);
scene.add(embers.object, dust.object, shaft.object, glow.object);

// ---------------------------------------------------------------- post
// bloom threshold is in linear now (the encode happens at the end), grain is halved.
// Reflected light is rolled off under 1.0 before the tone map (materials.js), so a
// threshold above where that lands leaves the bloom to what glows: the burn, the
// hot header. No lens fringing: over the surface detail it read as CG.
const post = new Post(renderer, { bloom: 0.9, grain: 0.031, vignette: 0.62, aberration: 0, threshold: 0.8 });
window.__post = post;       // test hook: post.sceneInfo holds the scene pass's draw calls and triangles
// window.__ready means the first full engine frame is on screen. The shaders
// compile in the background first (warm.js), so the end of this module is not
// "booted"; the plain assignment at the end of boot is a no-op against this.
Object.defineProperty(window, '__ready', { configurable: true, get: () => post.ready, set() {} });

// ---------------------------------------------------------------- chapters
// Each chapter is a camera station and a state for the machine. The scroll
// interpolates between them, so the page is one continuous move rather than
// five slides.
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const at = (dx, dy, dz) => V(MID.x + dx * REACH, MID.y + dy * REACH, MID.z + dz * REACH);

// A station as yaw (degrees from the intake side toward the timing end), elevation
// and distance in REACH units, looking at a height above the crank centreline.
const st = (yaw, el, dist, lookY) => {
  const a = yaw * Math.PI / 180, e = el * Math.PI / 180;
  const look = V(MID.x, lookY ?? MID.y, MID.z);
  return { cam: look.clone().add(V(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).multiplyScalar(dist * REACH)), look };
};
const CHAPTERS = [
  // front accessory drive and intake side, three-quarter, a little above
  { id: '00', label: 'The object', section: 0.00, ...st(35, 16, 2.3), heat: 0.10, glow: 1.00, shaft: 0.10 },
  // the red section nearly square to the lens
  { id: '01', label: 'The section', section: 0.85, ...st(20, 14, 2.3), heat: 0.35, glow: 0.55, shaft: 0.85 },
  // low, from the flywheel quarter: rod angularity and the crank throws. From the
  // timing quarter the belt and the cam pulley stood in front of cylinder 1.
  { id: '02', label: 'The cycle', section: 1.00, ...st(-30, 4, 2.3, 0.08), heat: 0.85, glow: 0.30, shaft: 0.45 },
  // high and close on the head, from the flywheel quarter, so the view runs along the
  // cams and the lobes turn toward the lens: cams, buckets, springs, valves, and the
  // crowns under them. Close, so the perspective is steep and the head is the
  // nearest, largest thing. Where the screen is tall enough the whole engine is in
  // the frame: from 60 degrees round and 32 up, the fit hung the head from the top
  // and the flywheel ran a few pixels off the bottom, a crop that looked accidental.
  // Only the small frame, too short for the whole engine at a readable size, crops
  // it (see computeCrops). Narrow screens come round less and lower (`narrow`): from
  // up here a phone's column held the whole engine at 55 % of the width, the
  // smallest engine of the story in its close-up.
  { id: '03', label: 'The breath', section: 1.00, ...st(-45, 30, 1.0, E.CAM_Y), narrow: st(-38, 16, 1.0, E.CAM_Y), head: true, heat: 1.00, glow: 0.35, shaft: 0.30 },
  // wide and low, a three-quarter view from the flywheel end for the proof: square on
  // and from above it was the flattest view of the tour, a slab of section paint
  // over an empty sump, more drawing than photograph
  { id: '04', label: 'The proof', section: 1.00, ...st(-16, 5, 2.6), heat: 0.25, glow: 0.70, shaft: 0.20 },
];

// A chapter may carry its own station for phones and narrow tablets (style.css's
// 900 px break, where the copy sits above the engine rather than beside it).
let NARROW = false;
const stn = c => (NARROW && c.narrow) || c;

// ---------------------------------------------------------------- state
const eng = new Engine();
let crOnly = reduceMotion;
let scrubbing = false;
let scrollY = 0;
let chapter = 0, localT = 0;
let orbitYaw = 0, orbitPitch = 0, orbiting = 0;

const camPos = new THREE.Vector3().copy(CHAPTERS[0].cam);
const camLook = new THREE.Vector3().copy(CHAPTERS[0].look);
const aimPos = camPos.clone(), aimLook = camLook.clone();
let heat = CHAPTERS[0].heat, glowAmt = CHAPTERS[0].glow, shaftAmt = CHAPTERS[0].shaft;

// ---------------------------------------------------------------- diagram
const dgc = $('#diagram'), dctx = dgc.getContext('2d');
const tgc = $('#chart'), tctx = tgc.getContext('2d');
let dW = 0, dH = 0, tW = 0, tH = 0, dDPR = 1, chartLabel = false;

const CURVE = (() => {
  const N = 361, piston = [], intake = [], exhaust = [], press = [];
  for (let i = 0; i < N; i++) {
    const a = (i * 720) / (N - 1);
    piston.push((wristHeight(a) - (SPEC.rodLength - SPEC.crankRadius)) / SPEC.stroke);
    // the lift that moves the valves (engine.js): sim.js's own valveLift() taken
    // either side of each event's centre, so both flanks are drawn and the trace
    // opens where the card says it does
    intake.push(intakeLift(a) / SPEC.intakeLift);
    exhaust.push(exhaustLift(a) / SPEC.exhaustLift);
    press.push(cylinderPressure(a) / 1e5);
  }
  return { N, piston, intake, exhaust, press, maxPress: Math.max(...press), peak: 0 };
})();
// The trace is drawn from samples 2 degrees apart, so its highest sample can sit a
// digit under the true peak (38.6 against sim.js's 38.66 at CR 9). The Peak cyl
// figure is sim.js's own maximum: cylinderPressure() swept at 0.01 degrees either
// side of the highest sample.
function refinePeak() {
  let k = 0;
  for (let i = 1; i < CURVE.N; i++) if (CURVE.press[i] > CURVE.press[k]) k = i;
  const a0 = (k * 720) / (CURVE.N - 1);
  let best = CURVE.press[k];
  for (let j = -200; j <= 200; j++) best = Math.max(best, cylinderPressure(wrap720(a0 + j / 100)) / 1e5);
  CURVE.peak = best;
}
refinePeak();
// The pressure trace depends on the compression ratio; the lift and travel curves
// do not. Without this the peak-pressure figure and the diagram stayed at their
// load-time values while IMEP beside them moved with the slider.
function rebuildPressure() {
  for (let i = 0; i < CURVE.N; i++) CURVE.press[i] = cylinderPressure((i * 720) / (CURVE.N - 1)) / 1e5;
  CURVE.maxPress = Math.max(...CURVE.press);
  refinePeak();
}

// The power curve is always the full-load one, so its peak is the Peak power
// figure beside it. Built at whatever load the engine happened to be at, it was a
// different curve each time the ratio moved, and a blank one on overrun.
const CHART = { pts: [], maxKw: 1 };
// The chart's scale is fixed at the most the slider can ask for (the full-load peak
// at the highest ratio it offers), so moving the ratio visibly lifts or drops the
// curve; scaled to its own peak, every ratio drew a curve of the same height.
const CHART_TOP = (() => {
  const cr = SPEC.compression;
  setCompressionRatio(Number($('#r-cr').max));
  const kw = peakPower().kw;
  setCompressionRatio(cr);
  return kw;
})();
function buildChart() {
  CHART.pts = []; let maxKw = 1;
  for (let r = 800; r <= SPEC.redline; r += 100) {
    const kw = powerAt(r, 1) / 1000;
    CHART.pts.push([r, kw]);
    if (kw > maxKw) maxKw = kw;
  }
  CHART.maxKw = maxKw;
}
buildChart();

// ---------------------------------------------------------------- stage framing
// Every layout leaves the engine some clear space: right of the copy on a desktop,
// between the copy and the controls on a phone, under the title in a small frame.
// That space is measured from the page itself, once per chapter, and every frame
// the engine's projected silhouette is scaled and shifted into it. It is a 2D
// transform applied to the projection, so perspective, shadows and piston picking
// are untouched, and the copy and the instruments never sit on the machine at any
// size, whatever size the model turns out to be.
const PBASE = new THREE.Matrix4(), FIT = new THREE.Matrix4(), VP = new THREE.Matrix4(), HOLD = new THREE.Matrix4();
// per chapter: the clear space; the clear space once the copy has faded (a piston
// is being followed); the boxes a close-up crop must keep off; the part of the
// silhouette that is framed (all of it, or the head of a close-up)
const STAGES = [], FREE = [], OBST = [], CROP = [];
// Following a piston, the copy stands aside only as far as the engine can use its
// room (per chapter, 0..1, from computeCrops). Where the copy shares a column with
// the controls, as in the 1164 frame, the engine gains nothing from it, and fading
// it only left the left third of the screen empty and dark beside the same engine.
const ASIDE = [];
let SAMPLES = null, SFLAG = null, SGRP = null, SZMIN = null, cropsDirty = true, focusAmt = 0;
// the bolted-on accessories (alternator, filter, starter, manifold) come off whole
// as the section reaches them: which are on, for the silhouette being taken
const ACC = (E.accGroups || []).map(a => a.g), ACCON = new Uint8Array(ACC.length + 1);
const accNow = () => { ACC.forEach((g, i) => { ACCON[i + 1] = g.visible ? 1 : 0; }); };
// for a chapter not yet on screen: a group is on while the plane has not reached it
const accAt = zc => { (E.accGroups || []).forEach((a, i) => { ACCON[i + 1] = a.bb.max.z < zc ? 1 : 0; }); };
const CLIPPED = 1, HEADPT = 2;           // sample flags: cut by the section; part of the head

// Points from every mesh, in world space, with the crank posed right round the
// cycle so the swing of the counterweights and rods is inside the fit too. A
// coarse grid keeps one point per cell, so the per-frame cost stays small however
// detailed the model gets. It runs inside the first frame, so after the first pose
// only parts that actually moved are sampled again, and the grid key is a number.
function sampleEngine(crankNow) {
  const v = new THREE.Vector3(), m = new THREE.Matrix4();
  const cell = REACH / 90, seen = new Set(), pts = [], flags = [], grp = [], zmin = [], was = new Map(), bb = new THREE.Box3();
  const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  // parts the section plane cuts, so a sectioned chapter frames what is left of them
  const clipSet = new Set(E.clipMats || []);
  for (let pose = 0; pose < 720; pose += 45) {
    updateEngine(E, pose);
    E.root.updateMatrixWorld(true);
    E.root.traverse(o => {
      const pa = o.isMesh && o.geometry && o.geometry.attributes.position;
      if (!pa) return;
      for (let p = o; p; p = p.parent) if (!p.visible) return;
      const now = o.isInstancedMesh ? [o.matrixWorld.elements, o.instanceMatrix.array] : [o.matrixWorld.elements];
      const before = was.get(o);
      if (before && before.every((a, k) => same(a, now[k]))) return;
      was.set(o, now.map(a => a.slice()));
      const step = Math.max(1, Math.floor(pa.count / 400));
      const copies = o.isInstancedMesh ? o.count : 1;
      const cf = [].concat(o.material).some(mt => clipSet.has(mt)) ? CLIPPED : 0;
      let gi = 0;
      for (let p = o; p && !gi; p = p.parent) gi = ACC.indexOf(p) + 1;
      if (cf && !o.geometry.boundingBox) o.geometry.computeBoundingBox();
      for (let j = 0; j < copies; j++) {
        if (o.isInstancedMesh) { o.getMatrixAt(j, m); m.premultiply(o.matrixWorld); } else m.copy(o.matrixWorld);
        // a cut part's nearest face to the lens side of the plane: if the plane
        // passes through the part, its cut face lies on the plane (see silhouette)
        const z0 = cf ? bb.copy(o.geometry.boundingBox).applyMatrix4(m).min.z : 0;
        for (let i = 0; i < pa.count; i += step) {
          v.fromBufferAttribute(pa, i).applyMatrix4(m);
          const key = (Math.round(v.x / cell) + 1024) * 4194304 + (Math.round(v.y / cell) + 1024) * 2048 + Math.round(v.z / cell) + 1024;
          if (seen.has(key)) continue;
          seen.add(key); pts.push(v.x, v.y, v.z);
          // the head and the bores down to the crowns at the bottom of the stroke, so
          // a close-up that crops the block still shows every piston crown
          flags.push(cf | (v.y > E.DECK - SPEC.stroke - 0.012 ? HEADPT : 0));
          grp.push(gi);
          zmin.push(z0);
        }
      }
    });
  }
  updateEngine(E, crankNow);
  E.root.updateMatrixWorld(true);
  SFLAG = Uint8Array.from(flags);
  SGRP = Uint8Array.from(grp);
  SZMIN = Float32Array.from(zmin);
  return new Float32Array(pts);
}

// A sample of a cut part that lies beyond the plane is not drawn, but the part's
// cut face is, on the plane, and its outline runs between the vertices. Dropping
// those samples left the cut outline out of the fitted box, so the sump's cut edge
// ran into the hint under it. Taken onto the plane, they bound the cut face; a part
// wholly beyond the plane is gone and is left out. Returns the z to project, or NaN.
const cutZ = (j, z, zc) => !(SFLAG[j] & CLIPPED) || z <= zc ? z : SZMIN[j] < zc ? zc : NaN;

// The silhouette's box in NDC under the view-projection e, from every sample (or
// only those flagged `only`), with what a plane at z = zc has cut away taken onto
// the plane (cutZ), and without the accessories that are off (ACCON).
function silhouette(e, only, out, zc) {
  const P = SAMPLES, F = SFLAG, G = SGRP;
  ACCON[0] = 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0, j = 0; i < P.length; i += 3, j++) {
    const f = F[j];
    if (only && !(f & only)) continue;
    if (!ACCON[G[j]]) continue;
    const x = P[i], y = P[i + 1], z = cutZ(j, P[i + 2], zc);
    if (z !== z) continue;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 1e-4) continue;
    const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w, ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
    if (nx < x0) x0 = nx; if (nx > x1) x1 = nx;
    if (ny < y0) y0 = ny; if (ny > y1) y1 = ny;
  }
  out.x0 = x0; out.y0 = y0; out.x1 = x1; out.y1 = y1;
  return x1 > x0 && y1 > y0;
}
// where the section plane stands for a given openness (applySection's rule)
const cutAt = s => (s > 0.002 ? 0.12 - s * 0.118 : Infinity);

// The clear space per chapter: start from the whole screen, then cut away every
// visible piece of furniture (that chapter's copy, the controls, the readout, the
// cam card once it shows), each on one side. Every combination of sides is tried
// (pruned, it is a handful of boxes) and the one that leaves the engine the most
// room wins, with a mild preference for a stage near the middle of the screen.
// The canvas's own size, not the window's: with a desktop scrollbar the window is
// 15 px wider than the canvas, and the engine was fitted to a stage that ran under
// the scrollbar, 13 px from the readout's first column at 1164.
const VW = () => canvas.clientWidth || innerWidth, VH = () => canvas.clientHeight || innerHeight;
function measureStages() {
  const W = VW(), H = VH();
  if (!W || !H) return;
  // (at least 10 px: at 8 the small frame's sump sat on the host's bezel and a
  // phone's sump on the pedal's top edge)
  const gap = clamp(Math.min(W, H) * 0.022, 10, 22);
  // Against the copy and the instruments a desktop wants more air than against the
  // screen's edges: at 13-16 px the plenum's end cap sat 15 px from "not a picture."
  // and the crank pulley 14 px from the readout, which read as cramped.
  const room2 = W > 900 && H > 480 ? clamp(W * 0.02, 22, 34) : gap;
  // (a phone's floor pool runs under the scrim over the controls: a few more pixels
  // there keep the sump and its contact shadow clear of it)
  const roomCtl = W <= 900 && H > 480 ? gap + 16 : room2;
  const air = (r, g) => r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom, g };
  const box = el => { const r = el && el.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 ? r : null; };
  const text = el => {
    if (!box(el)) return null;
    const rg = document.createRange(); rg.selectNodeContents(el);
    const r = rg.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : box(el);
  };
  // How big the engine can be in a stage (it is a little taller than wide), a
  // mild pull toward the middle of the screen so it does not hop from beside the
  // title to under it between chapters, and a little credit for spare room in the
  // other direction to settle ties.
  const room = s => Math.min(s.x1 - s.x0, (s.y1 - s.y0) * 0.9);
  const spare = s => Math.max(s.x1 - s.x0, (s.y1 - s.y0) * 0.9);
  const score = s => room(s) * (1 - 0.5 * Math.abs((s.x0 + s.x1) / 2 - W / 2) / (W / 2)) + 0.04 * spare(s);
  const bound = s => room(s) + 0.04 * spare(s);                     // no later cut can beat this
  // (a box within its gap of the stage still counts: when the controls had already
  // pushed the stage's edge a pixel past the headline's, the headline went uncut
  // and the engine stood 1 px from it)
  const hits = (o, S, g = o.g || gap) => !(o.right + g <= S.x0 || o.left - g >= S.x1 || o.bottom + g <= S.y0 || o.top - g >= S.y1);
  const cut = (o, S, side, g = o.g || gap) => side === 'top' ? { ...S, y0: Math.max(S.y0, o.bottom + g) }
    : side === 'bottom' ? { ...S, y1: Math.min(S.y1, o.top - g) }
    : side === 'left' ? { ...S, x0: Math.max(S.x0, o.right + g) }
    : { ...S, x1: Math.min(S.x1, o.left - g) };
  const SIDES = ['top', 'bottom', 'left', 'right'];
  const valid = s => s.x1 > s.x0 && s.y1 > s.y0;
  const full = { x0: gap, y0: gap, x1: W - gap, y1: H - gap };
  // every obstacle cut on one of its four sides, all combinations, pruned: cuts
  // only ever shrink a stage, so a branch that cannot beat the best is dropped
  const solve = obs => {
    let best = null, bestScore = -1;
    const walk = (i, S) => {
      if (bound(S) <= bestScore) return;
      if (i === obs.length) { const sc = score(S); if (sc > bestScore) { bestScore = sc; best = S; } return; }
      if (!hits(obs[i], S)) { walk(i + 1, S); return; }
      for (const side of SIDES) { const s = cut(obs[i], S, side); if (valid(s)) walk(i + 1, s); }
    };
    walk(0, full);
    return best;
  };

  // the hint, the stamp and the scroll cue step aside for a close-up (see .crop)
  const minor = ['.cue', '#hint', '.stamp'].map(s => box($(s))).filter(Boolean);
  const major = ['.topbar', '.vert', '.controls', '.readout', '#rev']
    .map(s => air(box($(s)), s === '.controls' ? roomCtl : s === '.readout' ? room2 : 0)).filter(Boolean);
  const card = air(box($('.camcard')), room2);
  // a layout with no real room left (should not happen at any size shipped) falls
  // back to the whole screen rather than a postage stamp
  const sane = S => (!S || S.x1 - S.x0 < W * 0.2 || S.y1 - S.y0 < H * 0.18) ? { x0: gap, y0: Math.min(H * 0.3, 56), x1: W - gap, y1: H - gap } : S;
  const pad = b => { const g = (b.g || gap) / 2; return { left: b.left - g, top: b.top - g, right: b.right + g, bottom: b.bottom + g }; };
  document.querySelectorAll('.chapter').forEach((ch, i) => {
    const copy = [...ch.querySelectorAll('.kicker, h1, h2, .lede')].map(el => air(text(el), room2)).filter(Boolean);
    const inst = [...major, ...(i >= 1 && card ? [card] : [])];                   // the cam card shows from 01
    STAGES[i] = sane(solve([...inst, ...minor, ...copy]));
    FREE[i] = sane(solve([...inst, ...minor]));
    // what a close-up may not run under: the copy, the instruments, and the top,
    // left and right edges of the screen (running off the bottom is the crop)
    OBST[i] = [...inst, ...copy].map(pad).concat(
      { left: -1e6, right: 1e6, top: -1e6, bottom: 0 },
      { left: -1e6, right: 0, top: -1e6, bottom: 1e6 },
      { left: W, right: 1e6, top: -1e6, bottom: 1e6 });
  });
  cropsDirty = true;
  // On a phone the pedal and the figures sit over the lit floor under the engine;
  // a scrim from the top of the controls down keeps them legible (style.css). The
  // engine's stage ends above the controls, so it never darkens the machine.
  const ctl = box($('.controls'));
  document.body.style.setProperty('--scrim', ctl ? `${Math.max(0, Math.round(H - ctl.top))}px` : '0px');
}
document.fonts && document.fonts.ready.then(measureStages);

// Fit the silhouette seen from the station (orbit and focus come after, so a drag
// still turns the machine rather than refitting it) into this scroll position's
// stage, eased between chapters exactly as the camera is.
const BOXF = {}, BOXH = {}, RECT = {}, STG = { ok: false }, TF = {};
const FULLCROP = { x0: 0, y0: 0, x1: 1, y1: 1, align: 0.5 };
const lerpRect = (a, b, t, out = {}) => {
  for (const k of ['x0', 'y0', 'x1', 'y1', 'align']) if (k in a) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
};
const toNDC = (S, W, H, out = {}) => {                   // a stage in px, y down, into NDC, y up
  out.x0 = S.x0 / W * 2 - 1; out.x1 = S.x1 / W * 2 - 1;
  out.y0 = 1 - S.y1 / H * 2; out.y1 = 1 - S.y0 / H * 2;
  return out;
};
// The 2D transform that puts rectangle r into stage s (both NDC), centred across,
// and placed down the stage by `align`: 0.5 centres it, 0 hangs it from the top.
function fitRect(r, s, align, out) {
  const k = clamp(Math.min((s.x1 - s.x0) / (r.x1 - r.x0), (s.y1 - s.y0) / (r.y1 - r.y0)), 0.2, 4);
  out.k = k;
  out.tx = (s.x0 + s.x1) / 2 - k * (r.x0 + r.x1) / 2;
  out.ty = s.y1 - ((s.y1 - s.y0) - k * (r.y1 - r.y0)) * align - k * r.y1;
  return out;
}

// A chapter marked `head` is a close-up: it frames the head, from the cam cover to
// the deck, and lets the block run off below it. How far the crop can go is
// measured rather than assumed: it widens from the head toward the whole engine
// until no point of the silhouette lands on the copy, the instruments or a side
// of the screen. A desktop, with nothing under the engine, gets the close-up; a
// phone, with the controls under it, gets as much of one as fits.
function computeCrops() {
  cropsDirty = false;
  const W = VW(), H = VH(), S = {}, T = {}, r = {};
  CHAPTERS.forEach((c, i) => {
    CROP[i] = FULLCROP;
    ASIDE[i] = 1;
    if (!STAGES[i] || !FREE[i]) return;
    camera.position.copy(stn(c).cam); camera.lookAt(stn(c).look); camera.updateMatrixWorld();
    VP.multiplyMatrices(PBASE, camera.matrixWorldInverse);
    const zc = cutAt(c.section), e = VP.elements;
    accAt(zc);
    // how much bigger the engine fits once the copy is out of the way
    if (silhouette(e, 0, BOXF, zc)) {
      const kIn = s => { toNDC(s, W, H, S); return Math.min((S.x1 - S.x0) / (BOXF.x1 - BOXF.x0), (S.y1 - S.y0) / (BOXF.y1 - BOXF.y0)); };
      // (all or nothing: a copy half faded with the engine half into its room is
      // the smudge the chapter hand-overs are timed to avoid)
      ASIDE[i] = kIn(FREE[i]) / kIn(STAGES[i]) > 1.05 ? 1 : 0;
    }
    // (only a short screen crops: see CHAPTERS[3])
    if (!c.head || H > 480) return;
    if (!silhouette(e, 0, BOXF, zc) || !silhouette(e, HEADPT, BOXH, zc)) return;
    const F = BOXF, fw = F.x1 - F.x0, fh = F.y1 - F.y0;
    const head = { x0: (BOXH.x0 - F.x0) / fw, y0: (BOXH.y0 - F.y0) / fh, x1: (BOXH.x1 - F.x0) / fw, y1: (BOXH.y1 - F.y0) / fh, align: 0 };
    // every sample left standing, projected once
    const nx = [], ny = [];
    for (let p = 0, j = 0; p < SAMPLES.length; p += 3, j++) {
      if (!ACCON[SGRP[j]]) continue;
      const x = SAMPLES[p], y = SAMPLES[p + 1], z = cutZ(j, SAMPLES[p + 2], zc);
      if (z !== z) continue;
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 1e-4) continue;
      nx.push((e[0] * x + e[4] * y + e[8] * z + e[12]) / w); ny.push((e[1] * x + e[5] * y + e[9] * z + e[13]) / w);
    }
    toNDC(STAGES[i], W, H, S);
    const boxes = OBST[i];
    const clear = lam => {
      lerpRect(head, FULLCROP, lam, r);
      const R = { x0: F.x0 + r.x0 * fw, x1: F.x0 + r.x1 * fw, y0: F.y0 + r.y0 * fh, y1: F.y0 + r.y1 * fh };
      fitRect(R, S, r.align, T);
      for (let j = 0; j < nx.length; j++) {
        const sx = (T.k * nx[j] + T.tx + 1) / 2 * W, sy = (1 - (T.k * ny[j] + T.ty)) / 2 * H;
        for (const b of boxes) if (sx > b.left && sx < b.right && sy > b.top && sy < b.bottom) return false;
      }
      return true;
    };
    let lam = 0;
    if (!clear(0)) {
      let lo = 0, hi = 1;
      for (let n = 0; n < 9; n++) { const m = (lo + hi) / 2; if (clear(m)) hi = m; else lo = m; }
      lam = hi;
    }
    CROP[i] = lerpRect(head, FULLCROP, lam);
  });
}

const asideNow = t => { const a = ASIDE[chapter] ?? 1, b = ASIDE[Math.min(chapter + 1, CHAPTERS.length - 1)] ?? 1; return a + (b - a) * t; };
// This scroll position's stage in NDC (into STG) and the part of the silhouette
// box F to put in it (into RECT).
function stageNow(t) {
  const a = STAGES[chapter], b = STAGES[Math.min(chapter + 1, CHAPTERS.length - 1)];
  const S = lerpRect(a, b, t);
  // The outgoing chapter's copy stays on screen until it has faded out, so the
  // stage may not reach into its room until then: easing straight toward the next
  // chapter's stage ran a phone's engine into the last line of the copy above it.
  const op = 1 - Math.pow(Math.max(0, (localT - 0.78) / 0.22), 2);
  S.x0 += Math.max(0, a.x0 - S.x0) * op; S.y0 += Math.max(0, a.y0 - S.y0) * op;
  S.x1 -= Math.max(0, S.x1 - a.x1) * op; S.y1 -= Math.max(0, S.y1 - a.y1) * op;
  // following a piston, the copy fades and the engine may use its room
  if (focusAmt * asideNow(t) > 0.001) lerpRect(S, lerpRect(FREE[chapter], FREE[Math.min(chapter + 1, CHAPTERS.length - 1)], t), focusAmt * asideNow(t), S);
  toNDC(S, VW(), VH(), STG);
  STG.ok = true;
}
function cropNow(t, F) {
  const c = lerpRect(CROP[chapter] || FULLCROP, CROP[Math.min(chapter + 1, CHAPTERS.length - 1)] || FULLCROP, t);
  const fw = F.x1 - F.x0, fh = F.y1 - F.y0;
  RECT.x0 = F.x0 + c.x0 * fw; RECT.x1 = F.x0 + c.x1 * fw;
  RECT.y0 = F.y0 + c.y0 * fh; RECT.y1 = F.y0 + c.y1 * fh;
  RECT.align = c.align;
  return c;
}

function fitStage() {
  if (!SAMPLES) SAMPLES = sampleEngine(eng.crank);
  const a = STAGES[chapter], b = STAGES[Math.min(chapter + 1, CHAPTERS.length - 1)];
  if (!a || !b || !SAMPLES.length) return;
  if (cropsDirty) computeCrops();
  camera.position.copy(camPos); camera.lookAt(camLook); camera.updateMatrixWorld();
  VP.multiplyMatrices(PBASE, camera.matrixWorldInverse);
  accNow();
  if (!silhouette(VP.elements, 0, BOXF, cutAt(section))) return;
  const t = easeInOut(localT);
  stageNow(t);
  const c = cropNow(t, BOXF);
  fitRect(RECT, STG, RECT.align, TF);
  // when a close-up runs the block below its stage, the hint and the stamp that
  // live down there step aside for it
  document.body.classList.toggle('crop', c.y0 > 0.02 && TF.k * BOXF.y0 + TF.ty < STG.y0 - 0.01);
  FIT.set(TF.k, 0, 0, TF.tx, 0, TF.k, 0, TF.ty, 0, 0, 1, 0, 0, 0, 0, 1);
  camera.projectionMatrix.multiplyMatrices(FIT, PBASE);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

// After the visitor's orbit and a followed piston have moved the camera, the
// framed part of the silhouette is pulled back inside the stage if it has left
// it: scaled down about the stage's centre, then shifted in. It never enlarges, so
// a drag still turns the machine rather than refitting it, and following a piston
// can no longer run the engine under the headline, the cam card or the controls.
let lastFocus = -1;                           // the cylinder followed, kept while the follow fades out
function holdInStage() {
  if (!SAMPLES || !STG.ok) return;
  camera.updateMatrixWorld();
  VP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  if (!silhouette(VP.elements, 0, BOXF, cutAt(section))) return;
  cropNow(easeInOut(localT), BOXF);
  const r = RECT, s = STG;
  const k = Math.min(1, (s.x1 - s.x0) / (r.x1 - r.x0), (s.y1 - s.y0) / (r.y1 - r.y0));
  const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
  const x0 = cx + (r.x0 - cx) * k, x1 = cx + (r.x1 - cx) * k, y0 = cy + (r.y0 - cy) * k, y1 = cy + (r.y1 - cy) * k;
  const dx = x0 < s.x0 ? s.x0 - x0 : x1 > s.x1 ? s.x1 - x1 : 0;
  const dy = y0 < s.y0 ? s.y0 - y0 : y1 > s.y1 ? s.y1 - y1 : 0;
  if (k > 0.9999 && Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) return;
  HOLD.set(k, 0, 0, cx * (1 - k) + dx, 0, k, 0, cy * (1 - k) + dy, 0, 0, 1, 0, 0, 0, 0, 1);
  camera.projectionMatrix.premultiply(HOLD);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

function sizeCanvases() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setPixelRatio(dpr());           // the budget depends on the size
  renderer.setSize(w, h, false);
  post.setSize(w, h, dpr());
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  PBASE.copy(camera.projectionMatrix);
  NARROW = w <= 900;
  measureStages();
  dDPR = Math.min(devicePixelRatio, 2);
  dW = dgc.clientWidth; dH = dgc.clientHeight;
  if (dW && dH) { dgc.width = Math.round(dW * dDPR); dgc.height = Math.round(dH * dDPR); }
  tW = tgc.clientWidth; tH = tgc.clientHeight;
  if (tW && tH) { tgc.width = Math.round(tW * dDPR); tgc.height = Math.round(tH * dDPR); }
  // on short screens the caption under the power curve gives its line back, so the
  // curve names itself instead of being an unlabelled sparkline
  chartLabel = getComputedStyle($('.camcard .cap')).display === 'none';
  if (!canFollow()) focusCyl = -1;          // nothing left on screen to name it
}
addEventListener('resize', sizeCanvases);

function drawDiagram(crank) {
  if (!dW || !dH) return;
  dctx.setTransform(dDPR, 0, 0, dDPR, 0, 0);
  dctx.clearRect(0, 0, dW, dH);
  // The firing marks live in their own gutter above the plot, so they no longer
  // print on the stroke names; the pressure band is scaled to the live peak, so it
  // cannot overshoot into the labels when the compression ratio goes up.
  // The stroke names have a lane of their own at the top of the plot, and every
  // trace starts under it: with the names over the pressure band, the hump after
  // TDC rose through POWER and the names sat on the traces on short screens.
  const padL = 26, padR = 6, padT = 22, padB = 15, LANE = 14;
  const W = dW - padL - padR, H = dH - padT - padB;
  const X = a => padL + (a / 720) * W;
  const Y = (v, top, hh) => padT + top + (1 - v) * hh;
  const PN = CURVE.maxPress * 1.05;
  const FONT = '10px "IBM Plex Mono", monospace';
  const hP = (H - LANE) * 0.36, top = LANE + hP + 5, hh = H - top;

  [['POWER', 0, 180], ['EXHAUST', 180, 360], ['INTAKE', 360, 540], ['COMPRESSION', 540, 720]]
    .forEach(([label, a0, a1], i) => {
      dctx.fillStyle = i % 2 ? 'rgba(255,255,255,.020)' : 'rgba(255,255,255,.042)';
      dctx.fillRect(X(a0), padT, X(a1) - X(a0), H);
      dctx.fillStyle = 'rgba(255,255,255,.42)';
      dctx.font = FONT;
      dctx.textAlign = 'center';
      const w = X(a1) - X(a0);
      dctx.fillText(dctx.measureText(label).width > w - 4 ? label.slice(0, 5) + '.' : label, (X(a0) + X(a1)) / 2, padT + 10);
    });

  dctx.strokeStyle = 'rgba(255,255,255,.09)';
  dctx.lineWidth = 1;
  dctx.font = FONT;
  dctx.fillStyle = 'rgba(255,255,255,.42)';
  dctx.textAlign = 'center';
  for (let a = 0; a <= 720; a += 90) {
    dctx.beginPath(); dctx.moveTo(X(a), padT); dctx.lineTo(X(a), padT + H); dctx.stroke();
    if (a < 720) dctx.fillText(String(a), X(a), dH - 3);
  }

  dctx.beginPath();
  dctx.moveTo(X(0), Y(0, LANE, hP));
  for (let i = 0; i < CURVE.N; i++) {
    const a = (i * 720) / (CURVE.N - 1);
    dctx.lineTo(X(a), Y(CURVE.press[i] / PN, LANE, hP));
  }
  dctx.lineTo(X(720), Y(0, LANE, hP));
  dctx.closePath();
  dctx.fillStyle = 'rgba(255,120,50,.20)';
  dctx.fill();
  dctx.strokeStyle = 'rgba(255,140,70,.75)';
  dctx.stroke();

  const curve = (arr, style, w, scale = 0.78) => {
    dctx.beginPath();
    for (let i = 0; i < CURVE.N; i++) {
      const a = (i * 720) / (CURVE.N - 1);
      const x = X(a), y = Y(arr[i], top, hh * scale);
      i ? dctx.lineTo(x, y) : dctx.moveTo(x, y);
    }
    dctx.strokeStyle = style; dctx.lineWidth = w; dctx.stroke();
  };
  curve(CURVE.piston, 'rgba(226,222,212,.82)', 1.3, 0.92);
  curve(CURVE.intake, 'rgba(150,200,255,.80)', 1.1);
  curve(CURVE.exhaust, 'rgba(255,110,50,.85)', 1.1);

  dctx.fillStyle = 'rgba(255,190,130,.95)';
  dctx.textAlign = 'left';
  FIRE_ANGLE.forEach((a, i) => {
    dctx.fillRect(X(a) - 0.5, padT - 7, 1, 7);
    dctx.fillText(String(i + 1), X(a) + 3, 11);
  });

  const px = X(crank);
  dctx.strokeStyle = 'rgba(255,150,90,.95)';
  dctx.lineWidth = 1;
  dctx.beginPath(); dctx.moveTo(px, padT - 4); dctx.lineTo(px, padT + H + 2); dctx.stroke();
  dctx.fillStyle = 'rgba(255,150,90,1)';
  dctx.beginPath(); dctx.arc(px, padT - 5, 2.2, 0, Math.PI * 2); dctx.fill();

  // A focused cylinder is drawn bright and on top, at its own crank angle, so you
  // can watch one cylinder go round while the others sit behind it.
  if (focusCyl >= 0) {
    const off = FIRE_ANGLE[focusCyl];
    const hP2 = hP, top2 = top, hh2 = hh;
    // the cylinder's own cycle, drawn at the crank angles it happens at: its phase
    // a is at crank a + off. Where that wraps past 720 the trace is broken and
    // picked up at 0, rather than ruled straight back across the plot.
    const at2 = a => X(wrap720(a + off));
    const trace = (arr, y, fillTo) => {
      let px = -1, seg = [];
      const flush = () => {
        if (seg.length < 2) { seg = []; return; }
        dctx.beginPath();
        seg.forEach(([x, yy], k) => (k ? dctx.lineTo(x, yy) : dctx.moveTo(x, yy)));
        if (fillTo !== undefined) {
          dctx.save();
          dctx.lineTo(seg[seg.length - 1][0], fillTo); dctx.lineTo(seg[0][0], fillTo); dctx.closePath();
          dctx.fill();
          dctx.restore();
          dctx.beginPath();
          seg.forEach(([x, yy], k) => (k ? dctx.lineTo(x, yy) : dctx.moveTo(x, yy)));
        }
        dctx.stroke();
        seg = [];
      };
      for (let i = 0; i < CURVE.N; i++) {
        const x = at2((i * 720) / (CURVE.N - 1));
        if (x < px) flush();
        seg.push([x, y(arr[i])]); px = x;
      }
      flush();
    };
    dctx.save();
    dctx.fillStyle = 'rgba(255,150,60,.42)';
    dctx.strokeStyle = 'rgba(255,190,120,.98)';
    dctx.lineWidth = 1.8;
    trace(CURVE.press, v => Y(v / PN, LANE, hP2), Y(0, LANE, hP2));
    const bright = (arr, style, scale) => {
      dctx.strokeStyle = style; dctx.lineWidth = 1.9;
      trace(arr, v => Y(v, top2, hh2 * scale));
    };
    bright(CURVE.piston, '#f4efe4', 0.92);
    bright(CURVE.intake, '#a8d4ff', 0.78);
    bright(CURVE.exhaust, '#ff8a3c', 0.78);
    // now, for this cylinder as for the others, is the crank angle itself
    const fx = X(crank);
    dctx.strokeStyle = 'rgba(255,220,170,1)';
    dctx.lineWidth = 1.6;
    dctx.beginPath(); dctx.moveTo(fx, padT - 4); dctx.lineTo(fx, padT + H + 2); dctx.stroke();
    dctx.restore();
  }
}

const STROKE = a => (a < 180 ? 'power' : a < 360 ? 'exhaust' : a < 540 ? 'intake' : 'compression');
function paintFocus(crank) {
  const el = $('#v-focus');
  $('.camcard').classList.toggle('focused', focusCyl >= 0);
  if (focusCyl < 0) { el.textContent = ''; return; }
  const phi = wrap720(crank - FIRE_ANGLE[focusCyl]);
  // the chamber's pressure at the charge actually trapped now, scaled exactly as
  // sim.js scales it for torque (charge = volumetric efficiency x load)
  // On overrun (and at the limiter) sim.js cuts the fuel and the trapped charge is
  // zero: the line says so, as the readout's A/F and fuel use do, rather than quoting
  // an absolute 0.0 bar mid-power-stroke, which reads as a bug.
  if (!(eng.load > 0)) { el.textContent = `cyl ${focusCyl + 1} · ${STROKE(phi)} · fuel cut`; return; }
  const p = cylinderPressure(phi) * volumetricEfficiency(eng.rpm) * eng.load / 1e5;
  el.textContent = `cyl ${focusCyl + 1} · ${STROKE(phi)} · ${p.toFixed(1)} bar`;
}

function drawChart(rpm) {
  if (!tW || !tH) return;
  tctx.setTransform(dDPR, 0, 0, dDPR, 0, 0);
  tctx.clearRect(0, 0, tW, tH);
  // With the caption hidden (short screens) the curve names itself, in a band of its
  // own above the plot: drawn over the plot, the curve ran through the words.
  const padT = chartLabel ? 17 : 5, padB = 4, H = tH - padT - padB, W = tW;
  const X = r => ((clamp(r, 800, SPEC.redline) - 800) / (SPEC.redline - 800)) * W;
  // the full-load curve bounds every live point (less load is less power at any
  // speed), and overrun, where the power is negative, sits on the baseline
  const top = Math.max(CHART_TOP, CHART.maxKw) * 1.06;
  const Y = kw => padT + (1 - clamp(kw, 0, top) / top) * H;
  tctx.beginPath();
  tctx.moveTo(X(800), Y(0));
  CHART.pts.forEach(([r, kw]) => tctx.lineTo(X(r), Y(kw)));
  tctx.lineTo(X(SPEC.redline), Y(0));
  tctx.closePath();
  tctx.fillStyle = 'rgba(255,120,50,.14)';
  tctx.fill();
  tctx.beginPath();
  CHART.pts.forEach(([r, kw], i) => (i ? tctx.lineTo(X(r), Y(kw)) : tctx.moveTo(X(r), Y(kw))));
  tctx.strokeStyle = 'rgba(255,140,70,.95)';
  tctx.lineWidth = 1.4;
  tctx.stroke();
  if (chartLabel) {
    tctx.font = '10px "IBM Plex Mono", monospace';
    tctx.textAlign = 'left'; tctx.textBaseline = 'top';
    tctx.fillStyle = 'rgba(233,228,218,.62)';
    tctx.fillText('POWER AT FULL LOAD, kW, AGAINST RPM', 0, 3);
    tctx.textAlign = 'right';
    tctx.fillText('NOW', W, 3);
    tctx.fillStyle = '#ffd9a8';
    tctx.beginPath(); tctx.arc(W - tctx.measureText('NOW').width - 7, 8, 2.8, 0, Math.PI * 2); tctx.fill();
    tctx.textAlign = 'left'; tctx.textBaseline = 'alphabetic';
  }
  // the engine now: its speed and the power it is making at the load it is at,
  // under the full-load curve unless the throttle is wide open
  const mx = X(rpm), my = Y(powerAt(rpm, eng.load) / 1000);
  tctx.fillStyle = 'rgba(255,217,168,.16)';
  tctx.fillRect(Math.round(mx) - 0.5, padT, 1, H);
  tctx.fillStyle = '#ffd9a8';
  tctx.beginPath(); tctx.arc(clamp(mx, 3, W - 3), clamp(my, padT + 3, padT + H - 1), 2.8, 0, Math.PI * 2); tctx.fill();
}

// ---------------------------------------------------------------- readout
function paintReadout(crank) {
  const rpm = eng.rpm, load = eng.load;
  // Brake torque exactly as sim.js computes it: the figure Power is made from and
  // the one Peak torque is the maximum of, so the three always agree on screen.
  // Negative while the engine is being slowed by its own friction (engine braking).
  const shown = torqueAt(rpm, load);
  const kw = powerAt(rpm, load) / 1000;

  $('#v-rpm').textContent = fmt(rpm);
  $('#v-torque').textContent = fmt(shown);
  $('#v-power').textContent = fmt(kw, 1);
  $('#v-crank').textContent = fmt(crank) + '°';
  $('#v-imep').textContent = fmt(imep() / 1e5, 2);
  $('#v-peakp').textContent = fmt(CURVE.peak, 1);
  // on overrun (and at the limiter) the fuel is cut: there is no mixture to quote
  $('#v-af').textContent = load > 0 ? airFuelRatio(load).toFixed(1) : '—';
  $('#v-bsfc').textContent = isFinite(bsfc(rpm, load)) ? fmt(bsfc(rpm, load)) : '—';
  $('#v-cr').textContent = SPEC.compression.toFixed(1);
  $('#v-bar').style.transform = `scaleX(${clamp(rpm / SPEC.redline, 0, 1)})`;
  $('#v-bar-load').style.transform = `scaleX(${clamp(load, 0, 1)})`;

  // The same live figures, next to the pedal that causes them. Scaled against the
  // engine's own peaks so the bars read as "how much of the available output" and
  // stay meaningful when the compression ratio changes underneath them.
  const pk = Math.max(1, peakTorque().nm), pkp = Math.max(1, peakPower().kw);
  $('#v-bar-tq').style.transform = `scaleX(${clamp(shown / pk, 0, 1)})`;
  $('#v-bar-pw').style.transform = `scaleX(${clamp(kw / pkp, 0, 1)})`;
  $('#v-tq').textContent = fmt(shown);
  $('#v-pw').textContent = fmt(kw, 1);
  // frozen: the figures are where the simulation stopped, so they say so, and the
  // hint says a drag now walks the crank
  $('.readout').classList.toggle('held', crOnly);
  document.body.classList.toggle('held', crOnly);
}

// Copy that quotes the engine's dimensions and cam timing reads them from sim.js,
// so the page cannot state a figure the simulation does not use.
{
  const deg = d => `${d}°`;
  const mm = m => fmt(m * 1000, 1);
  document.querySelectorAll('[data-spec]').forEach(el => {
    const k = el.dataset.spec;
    if (k === 'rod') el.textContent = fmt(SPEC.rodLength * 1000);
    if (k === 'bore') el.textContent = mm(SPEC.bore);
    if (k === 'stroke') el.textContent = mm(SPEC.stroke);
    // the rail down the left edge names the engine from the simulation's own spec
    if (k === 'rail') el.textContent = `${SPEC.name} — ${SPEC.label} · ${fmt(SPEC.displacement * 1e6)} cc`;
  });
  $('#ev-in').textContent = `${deg(360 - SPEC.intakeOpen)} BTDC · ${deg(SPEC.intakeClose - 540)} ABDC`;
  $('#ev-ex').textContent = `${deg(180 - SPEC.exhaustOpen)} BBDC · ${deg(SPEC.exhaustClose - 360)} ATDC`;
  $('#ev-sp').textContent = `spark ${deg(SPEC.sparkBTDC)} BTDC`;
  $('#ev-pi').textContent = `firing ${SPEC.firingOrder.join('–')}`;
}

// ---------------------------------------------------------------- scroll
function readScroll() {
  scrollY = window.scrollY || 0;
  const vh = Math.max(1, innerHeight);
  // The last chapter starts at the very end of the scroll, so a page resting a
  // pixel or two short of the end (rounding, a fractional viewport) is on it: it
  // used to read as the last 0.2% of chapter 03, with its copy faded to nothing.
  const end = document.documentElement.scrollHeight - vh;
  const p = end > 0 && scrollY >= end - 2 ? CHAPTERS.length - 1 : scrollY / vh;   // 0 .. CHAPTERS.length - 1
  const i = clamp(Math.floor(p), 0, CHAPTERS.length - 1);
  chapter = i;
  localT = clamp(p - i, 0, 1);
}
addEventListener('scroll', readScroll, { passive: true });

const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
// The first cut is timed, not scrolled: once the scroll passes CUT0 of the way
// through chapter 00, the plane sweeps to chapter 01's depth in CUT_S seconds (and
// back again, scrolling up). Mid-cut, the plane paints the manifolds and the front
// wall of the block as flat boards, which reads as a rendering fault rather than a
// cut being made. Tied to the scroll, a visitor could stop on that; timed and eased,
// it lasts a few frames whatever the scroll does.
const CUT0 = 0.72, CUT_S = 0.38;
let cutK = -1, cutT = 0, cutPin = null;       // how far the first cut has gone, 0..1
let lastNamed = -1, handT = 0;                // the chapter whose copy is up

function applyChapter() {
  const a = CHAPTERS[chapter];
  const b = CHAPTERS[Math.min(chapter + 1, CHAPTERS.length - 1)];
  const t = easeInOut(localT);
  aimPos.lerpVectors(stn(a).cam, stn(b).cam, t);
  aimLook.lerpVectors(stn(a).look, stn(b).look, t);
  // The first cut is made at the turn from 00 to 01, as the chapter 00 copy gives
  // way to "Cut it open", and it is made quickly (see CUT_S). From 01 on, the scroll
  // takes the plane the rest of the way, once the first cut has finished.
  const nowC = performance.now();
  const want = chapter > 0 || localT >= CUT0 ? 1 : 0;
  const step = Math.min(0.05, (nowC - cutT) / 1000) / CUT_S;
  cutK = cutPin !== null ? cutPin : cutK < 0 || reduceMotion ? want : clamp(cutK + (want ? step : -step), 0, 1);
  cutT = nowC;
  const open = CHAPTERS[1].section * easeInOut(cutK);
  const scrolled = a.section + (b.section - a.section) * t;
  section = chapter === 0 ? open : cutK < 1 ? Math.min(scrolled, open) : scrolled;
  heat = a.heat + (b.heat - a.heat) * t;
  glowAmt = a.glow + (b.glow - a.glow) * t;
  shaftAmt = a.shaft + (b.shaft - a.shaft) * t;
  applySection();

  // Copy is fully legible the moment you arrive at a chapter, and only dissolves
  // in the last fifth on the way out. Fading it in from localT=0 meant it was
  // invisible exactly where every scroll position lands.
  // (While a piston is being followed the copy stands aside and the engine takes
  // its room; see stageNow.)
  // The cut belongs to chapter 01: from the moment it starts, "Cut it open" is up
  // and 01 is lit, so the copy names what is happening rather than arriving after.
  const s = 1 - Math.pow(Math.max(0, (localT - 0.78) / 0.22), 2);
  const named = chapter === 0 && localT >= CUT0 ? 1 : chapter;
  // At a hand-over the new copy waits until the old has nearly gone: the two
  // headlines cross-fading on top of each other read as a smudge.
  if (named !== lastNamed) {
    const first = lastNamed < 0;
    lastNamed = named;
    // The old copy goes in a fifth of a second and the new one waits a third of a
    // second, so the two are never up together: with the old copy on its half-second
    // fade and the new one after 0.22 s, the new headline faded in over a ghost of
    // the old one at the automatic cut and at the demo's loop back to 00.
    document.querySelectorAll('.chapter').forEach((el, i) => {
      const inc = i === named && !first;
      el.style.transitionDelay = inc ? '.34s' : '0s';
      el.style.transitionDuration = inc || first ? '' : '.2s';
    });
    clearTimeout(handT);
    handT = setTimeout(() => document.querySelectorAll('.chapter').forEach(el => { el.style.transitionDelay = '0s'; el.style.transitionDuration = ''; }), 900);
  }
  document.querySelectorAll('.chapter').forEach((el, i) => {
    const o = i !== named ? 0 : named === chapter ? s : 1;
    el.style.opacity = o * (1 - focusAmt * asideNow(t));
    el.style.transform = `translateY(${(1 - (i === named ? o : 1)) * -16}px)`;
  });
  document.querySelectorAll('.chapnum').forEach((el, i) => {
    el.classList.toggle('on', i === named);
    if (i === named) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
  });
  // the cam card earns its space once the casting is open and the cycle is running
  $('.camcard').classList.toggle('show', chapter >= 1);
  // "Nothing here is a picture of a number" is up: the small frame, which shows no
  // readout otherwise, shows the live figures it is talking about (style.css)
  document.documentElement.classList.toggle('at4', named === 4);
  $('.cue').classList.toggle('gone', scrollY > innerHeight * 0.25);
  $('#hint').classList.toggle('show', scrollY > innerHeight * 0.25);   // takes over from the scroll cue
}

// chapter nav jumps the story rather than nudging it
document.querySelectorAll('.chapnum').forEach(b => b.addEventListener('click', () => {
  scrollTo({ top: Number(b.dataset.go) * innerHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
}));

// ---------------------------------------------------------------- input
function bindRange(id, fn) {
  const el = $(id);
  const run = () => fn(Number(el.value));
  el.addEventListener('input', run);
  run();
}
bindRange('#r-throttle', v => {
  $('#v-throttle').textContent = fmt(v * 100);
  if (v > 0 && crOnly) { crOnly = false; $('#btn-run').textContent = 'Freeze'; }
  // Touching the throttle is a claim on the controls. The demo writes
  // eng.throttle every frame, so without this it would quietly pull the slider
  // back down mid-rev and the engine would never spool up.
  if (Math.abs(v - eng.throttle) > 0.001) cancelDemo();
  eng.throttle = v;
  // (the take-over repaints the slider at a closed throttle; this is the visitor's)
  $('#r-throttle').value = String(v);
  $('#v-throttle').textContent = fmt(v * 100);
});
bindRange('#r-cr', v => {
  setCompressionRatio(v);
  rebuildPressure();
  buildChart();
  const pt = peakTorque(), pp = peakPower();
  $('#v-pkt').textContent = fmt(pt.nm);
  $('#v-pkp').textContent = fmt(pp.kw, 1);
  $('#v-pkq').textContent = fmt(pp.rpm);
});
$('#btn-run').addEventListener('click', () => {
  crOnly = !crOnly;
  $('#btn-run').textContent = crOnly ? 'Run engine' : 'Freeze';
  if (!crOnly) { eng.throttle = 0; setPedal(false); }
});
if (crOnly) $('#btn-run').textContent = 'Run engine';

// ---------------------------------------------------------------- interaction
// One gesture set for the canvas. Drag turns the engine, hover finds a cylinder,
// a click without a drag focuses it. In reduced-motion mode the drag scrubs the
// crank instead, because there is no crank motion to look around.
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const drag = { on: false, x: 0, y: 0, moved: 0, id: -1 };
let hoverCyl = -1, focusCyl = -1;

function pickCyl(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(E.units.map(u => u.piston), true);
  if (!hit.length) return -1;
  return E.units.findIndex(u => u.piston === hit[0].object.parent || isDescendant(u.piston, hit[0].object));
}
function isDescendant(root, node) { for (let p = node; p; p = p.parent) if (p === root) return true; return false; }
const canFollow = () => getComputedStyle($('.camcard')).display !== 'none';

canvas.addEventListener('pointerdown', e => {
  cancelDemo();
  drag.on = true; drag.x = e.clientX; drag.y = e.clientY; drag.moved = 0; drag.id = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (drag.on) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX; drag.y = e.clientY;
    if (crOnly) {
      scrubTo(e);
    } else {
      orbitYaw -= dx * 0.0060;
      orbitPitch = clamp(orbitPitch + dy * 0.0040, -0.85, 0.85);
      orbiting = 2.5;                       // hold the visitor's angle briefly
    }
    return;
  }
  const c = e.pointerType === 'mouse' && canFollow() ? pickCyl(e) : -1;
  if (c !== hoverCyl) { hoverCyl = c; canvas.style.cursor = c >= 0 ? 'pointer' : 'grab'; }
});
function endDrag(e) {
  if (!drag.on) return;
  drag.on = false;
  // A tap, not a drag: follow a cylinder. Only where the cam card is on screen to
  // name it: on a phone or in the small frame a tap (easily made by accident) faded
  // the headline and showed nothing in its place.
  if (drag.moved < 7 && canFollow()) {
    const c = pickCyl(e);
    focusCyl = c === focusCyl ? -1 : c;
    if (focusCyl >= 0) cancelDemo();
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => { drag.on = false; });
canvas.addEventListener('dblclick', () => { focusCyl = -1; orbitYaw = 0; orbitPitch = 0; });
canvas.style.cursor = 'grab';

function scrubTo(e) {
  const r = canvas.getBoundingClientRect();
  eng.crank = clamp((e.clientX - r.left) / r.width, 0, 0.9999) * 720;
}

// Throttle as a pedal you hold, not a slider you drag. Holding space does the
// same thing for anyone not on a pointer device. The pedal is analog: it opens
// over about a second and a third, so a tap is a light throttle and a long hold
// is full throttle. A pedal that could only be 0 or 100 gave no slower than
// full, which is not how a throttle works.
const pedal = $('#pedal');
// Held and ramping are different states and have to be tracked separately. With a
// single flag, releasing once the ramp had already reached full open hit an early
// return, the throttle was never cleared, and the engine sat at full throttle and
// pinned the limiter with the pedal visibly up.
let pedalHeld = false, pedalRamp = false;
const paintPedal = () => {
  $('#r-throttle').value = String(eng.throttle.toFixed(2));
  $('#v-throttle').textContent = Math.round(eng.throttle * 100);
  pedal.classList.toggle('down', pedalHeld);
};
const setPedal = v => {
  if (pedalHeld === v) return;
  pedalHeld = v;
  if (v) { crOnly = false; $('#btn-run').textContent = 'Freeze'; eng.throttle = Math.max(eng.throttle, 0.05); pedalRamp = true; }
  else { pedalRamp = false; eng.throttle = 0; }
  paintPedal();
};
// pointerdown only: opening on pointerenter revved the engine when the mouse merely crossed it
pedal.addEventListener('pointerdown', () => { cancelDemo(); setPedal(true); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => pedal.addEventListener(t, () => setPedal(false)));
addEventListener('pointerup', () => setPedal(false));

addEventListener('keydown', e => {
  // A focused slider, button or link owns its keys: arrows move the slider, Space
  // presses the button. Only the page itself (or the pedal) maps Space and arrows.
  if (e.target instanceof Element && e.target.closest('input, select, textarea, a, button:not(#pedal)')) return;
  // Space anywhere, or Enter on the focused pedal: held down, the throttle opens
  if ((e.code === 'Space' || (e.key === 'Enter' && e.target === pedal)) && !e.repeat) { e.preventDefault(); cancelDemo(); crOnly = false; setPedal(true); return; }
  if (e.key === 'Enter' && e.target === pedal) { e.preventDefault(); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); eng.crank = wrap720(eng.crank + (e.shiftKey ? 5 : 1)); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); eng.crank = wrap720(eng.crank - (e.shiftKey ? 5 : 1)); }
  if (e.key === 'Escape') { focusCyl = -1; }
});
addEventListener('keyup', e => { if (e.code === 'Space' || e.key === 'Enter') setPedal(false); });

// The skip link moves focus to the readout itself. Following the fragment moved
// nothing (the readout could not take focus) and pushed a history entry, so inside
// the Realm site's frame the host's Back button first undid the fragment.
$('.skip').addEventListener('click', e => { e.preventDefault(); $('#readout').focus({ preventScroll: true }); });

// Framed on the Realm site, the mark still says whose demo this is and still goes
// to realmsystems.net, but in a new tab: sending the whole host page home lost the
// visitor's place in the exhibit.
if (EMBED) {
  const m = $('.mark');
  m.target = '_blank'; m.rel = 'noopener';
  m.setAttribute('aria-label', 'Realm Systems, 3D demo (opens realmsystems.net in a new tab)');
  // "3D product sites" goes to the page that sells them, in the host window. Framed
  // on that page itself it would only reload it, so it is shown only where the host
  // is another Realm page (same origin, so its path can be read; elsewhere, hidden).
  let host = '';
  try { host = window.top.location.pathname; } catch (e) { /* another origin */ }
  if (host && !/^\/3d(\.html)?\/?$/.test(host)) document.documentElement.classList.add('link3d');
}

// ---------------------------------------------------------------- loop
let last = performance.now(), running = true, uiT = 0, drawn = false;
let heatLoad = 0;
const orbit = { az: 0, el: 0, target: new THREE.Vector3() };
const OFF = new THREE.Vector3();
const SPH = new THREE.Spherical();

// The self-running demo. A piece like this should show itself: if nobody touches
// it, it walks its own story and works the throttle. Any input hands control back.
const demo = { on: !reduceMotion, y: 0, idle: 0, phase: 0, hold: 0 };
const FRAMED = document.documentElement.classList.contains('framed');
// Taking over from the demo lets go of the throttle it was working, unless the
// visitor is actually holding the pedal: a wheel notch during the demo's rev used
// to leave the engine at 85% with the pedal drawn up and nothing on screen saying
// the throttle was open. (A slider or pedal that caused the take-over sets its
// own throttle straight after this.)
function cancelDemo() {
  if (demo.on) {
    demo.on = false;
    if (!pedalHeld) { eng.throttle = 0; pedalRamp = false; paintPedal(); }
  }
  demo.idle = 0;
}
// The loop from 04 back to 00 happens in the dark (style.css, html.dip), once the
// canvas has actually reached the ground colour (or after 0.6 s whatever): scrolled
// back in the light, the section closed in reverse over half a second, with the
// accessories coming back see-through, cut paint on the rails, no headline and two
// chapters lit in the nav. The page dips, this puts it back to 00 with the casting
// closed and the camera on its station, and it fades up on the whole engine.
let loopT = 0;
function loopBack() {
  loopT = 0;
  demo.y = 0; demo.hold = 0; demo.idle = 0; demo.phase = 0;
  scrollTo({ top: 0, behavior: 'instant' });
  readScroll();
  cutK = 0;                                   // closed at once, not swept back
  // the 00 copy is simply up when the lights come back: no hand-over, no fade
  lastNamed = 0;
  const chs = document.querySelectorAll('.chapter');
  chs.forEach(el => { el.style.transitionDelay = '0s'; el.style.transitionDuration = '0s'; });
  applyChapter();
  camPos.copy(aimPos); camLook.copy(aimLook);
  orbitYaw = 0; orbitPitch = 0;
  requestAnimationFrame(() => chs.forEach(el => { el.style.transitionDuration = ''; }));
  document.documentElement.classList.remove('dip');
}
['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach(t =>
  addEventListener(t, cancelDemo, { passive: true }));

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // The first frame is drawn even if the frame starts off screen on the host page:
  // it compiles every shader, and paying that at load beats freezing the host page
  // for seconds at the moment the visitor scrolls to the exhibit.
  if (!running && drawn) return;
  // under prefers-reduced-motion the atmosphere and the grain hold still too
  const t = reduceMotion ? 0 : now / 1000;

  readScroll();
  applyChapter();

  if (pedalRamp && eng.throttle < 1) {
    eng.throttle = Math.min(1, eng.throttle + dt / 1.3);
    paintPedal();
    if (eng.throttle >= 1) pedalRamp = false;
  }

  // ---- the self-running demo
  // (the loop's dip: back to 00 once the canvas is dark, or let go at once if the
  // visitor took over mid-dip, so the canvas is never left dark)
  if (loopT && (!demo.on || now - loopT > 600 || (now - loopT > 200 && +getComputedStyle(canvas).opacity < 0.01))) {
    if (demo.on) loopBack();
    else { loopT = 0; document.documentElement.classList.remove('dip'); }
  }
  if (demo.on && !loopT) {
    // the hold on the closed engine counts from its first full frame, not from while
    // its shaders were still compiling behind the curtain
    if (post.ready) demo.idle += dt;
    // If the page has ended up somewhere the demo did not put it, something else
    // owns the scroll now: a deep link, a restored scroll position, the visitor
    // dragging the scrollbar. Hand control back rather than fighting over it.
    if (Math.abs(scrollY - demo.y) > 0.02 * innerHeight) { demo.on = false; demo.idle = 0; }
    // Framed on the Realm site a visitor judges it in the first seconds, so it holds
    // the closed engine, whole and lit, for two and a half, then goes straight to
    // the cut rather than strolling there. Standalone it walks the whole story at
    // one slow pace. Either way the cut itself takes a third of a second (CUT_S).
    if (demo.on && demo.idle > (FRAMED ? 2.5 : 2.2)) {
      const pace = FRAMED && chapter === 0 ? 0.9 : 0.085;   // screens per second
      demo.y += dt * pace * innerHeight;
      // The last chapter starts at the very end of the scroll. The walk stops there,
      // on it, with its copy up, and holds before it loops back to the top (and
      // holds the closed engine again). It used to stop a pixel short, which read
      // as the tail of chapter 03, so chapter 04 never showed.
      const end = document.documentElement.scrollHeight - innerHeight;
      if (demo.y >= end) {
        demo.y = end; demo.hold += dt;
        if (demo.hold > 8) { loopT = now; document.documentElement.classList.add('dip'); }
      }
      scrollTo({ top: demo.y, behavior: 'instant' });
      readScroll();
      applyChapter();
      // work the throttle while the mechanism is on screen
      demo.phase += dt;
      // (a light throttle for the proof, so its figures are the engine pulling, not
      // coasting down from the rev in chapter 02 on a closed throttle)
      const want = chapter === 2 ? 0.85 : chapter === 3 ? 0.45 : chapter === 4 ? 0.25 : 0;
      eng.throttle += (want - eng.throttle) * Math.min(1, dt * 0.9);
      $('#r-throttle').value = String(eng.throttle.toFixed(2));
      $('#v-throttle').textContent = Math.round(eng.throttle * 100);
    }
  } else {
    // A held pedal (one pointerdown, or Space without auto-repeat), an open
    // throttle the visitor set, or a drag in progress is someone still driving:
    // the demo does not come back and take the throttle out of their hand.
    demo.idle = pedalHeld || eng.throttle > 0.001 || drag.on ? 0 : demo.idle + dt;
    if (demo.idle > 26 && !reduceMotion) {                // pick the story back up
      demo.on = true; demo.y = scrollY; demo.idle = 0; demo.phase = 0;
      focusCyl = -1;                                      // and lets go of a followed piston, so the copy comes back
    }
  }

  if (crOnly) {
    // the crank only moves when the visitor moves it
  } else {
    // Presented in slow motion. At a true 866 rpm the crank turns 14 times a
    // second, which is correct and completely unreadable — you cannot see a
    // slider-crank at that rate. The whole plant runs at SLOWMO: the crank, and
    // with it how fast the speed climbs and falls. The figures are the true values
    // of the state on screen; they change at the same slowed rate.
    // The rev limiter is a fuel cut, applied here because Engine.step does not act
    // on its own `firing` flag: above the redline the throttle is closed for the
    // step, sim.js's overrun branch then cuts the fuel (load 0), and the visitor's
    // throttle is handed back once the speed is under the redline again. Without it
    // a held throttle sat 260 rpm over the redline, above the stated peak power.
    let acc = dt * SLOWMO;
    while (acc > 0) {
      const held = eng.throttle, cut = eng.rpm > SPEC.redline;
      if (cut) eng.throttle = 0;
      eng.step(Math.min(1 / 240, acc));
      if (cut) eng.throttle = held;
      acc -= 1 / 240;
    }
  }

  updateEngine(E, eng.crank);

  // camera: the scroll sets the station, the pointer adds a small offset on top so
  // the visitor can still lean around the machine without losing the narrative.
  // The time constant is deliberately long (~0.8 s) so a fast flick of the wheel
  // becomes a glide instead of a whip-pan.
  // The station is smoothed on its own, with no orbit mixed in. Applying the
  // orbit to the lerped position fed it back into the next frame's lerp, and the
  // two settled at a point that was neither the station nor its rotation — which
  // put the camera inside the crankcase.
  // (under prefers-reduced-motion the camera cuts to the station instead of gliding)
  const glide = reduceMotion ? 1 : 1 - Math.pow(0.30, dt);
  camPos.lerp(aimPos, glide);
  camLook.lerp(aimLook, glide);
  focusAmt = reduceMotion ? (focusCyl >= 0 ? 1 : 0) : focusAmt + ((focusCyl >= 0 ? 1 : 0) - focusAmt) * Math.min(1, dt * 4);
  fitStage();

  if (orbiting > 0) orbiting -= dt;
  else if (!drag.on) {                                   // ease back to the framing
    orbitYaw *= Math.pow(0.55, dt);
    orbitPitch *= Math.pow(0.55, dt);
  }
  OFF.copy(camPos).sub(camLook);
  SPH.setFromVector3(OFF);
  SPH.theta += orbitYaw;
  SPH.phi = clamp(SPH.phi - orbitPitch, 0.25, Math.PI * 0.86);
  // following a piston, the camera moves in toward its cylinder with the copy's
  // fade rather than jumping there on the click (and back out the same way)
  if (focusCyl >= 0) lastFocus = focusCyl;
  const fk = lastFocus >= 0 ? focusAmt : 0;
  SPH.radius *= 1 - 0.2 * fk;
  camera.position.copy(camLook).add(OFF.setFromSpherical(SPH));
  if (fk > 0.001) camera.position.lerp(V(E.CYL_X[lastFocus], E.DECK - 0.045, 0.02), 0.18 * fk);
  camera.lookAt(camLook);
  holdInStage();

  // the light in the chamber that is firing right now
  let best = 0, bestD = 1e9;
  for (let c = 0; c < SPEC.rods; c++) {
    const phi = wrap720(eng.crank - FIRE_ANGLE[c]);
    const d = Math.min(phi, 720 - phi);
    if (d < bestD) { bestD = d; best = c; }
  }
  const phiB = wrap720(eng.crank - FIRE_ANGLE[best]);
  const since = ((phiB - SPEC.spark) % 720 + 720) % 720;
  const win = SPEC.burnTail + SPEC.sparkBTDC;
  const burning = since < win ? Math.pow(Math.sin(Math.PI * (since / win)), 0.6) : 0;
  fire.position.set(E.CYL_X[best], E.DECK + 0.012, 0);
  // the light is inside the chamber: it only reaches the room once the casting is cut
  fire.intensity = (0.25 + 2.6 * burning) * (0.35 + 0.65 * heat) * eng.firing * (0.08 + 0.92 * Math.min(1, section / 0.5));

  // Worked hard, the exhaust header gets hot. The glow is tied to load and to how
  // long it has been worked, strongest at the head flange, so opening the throttle
  // visibly heats the primaries and they cool back down. The payoff for the pedal.
  heatLoad += ((eng.load * (0.35 + 0.65 * heat)) - heatLoad) * Math.min(1, dt * (eng.load > heatLoad ? 0.55 : 0.16));
  const glowK = Math.max(0, heatLoad - 0.10) * 0.85;
  E.setHeat(glowK);

  // atmosphere
  embers.material.uniforms.uTime.value = t;
  embers.material.uniforms.uHeat.value = heat * (0.3 + 0.7 * eng.load);
  embers.material.uniforms.uPixel.value = renderer.getSize(new THREE.Vector2()).y * 0.0016;
  dust.material.uniforms.uTime.value = t;
  dust.material.uniforms.uPixel.value = renderer.getSize(new THREE.Vector2()).y * 0.0016;
  shaft.material.uniforms.uTime.value = t;
  shaft.material.uniforms.uStrength.value = shaftAmt;
  glow.material.uniforms.uTime.value = t;
  glow.material.uniforms.uStrength.value = glowAmt;
  glow.object.lookAt(camera.position);

  post.bloomStrength = 0.70 + 0.55 * heat;
  post.render(scene, camera, t);
  drawn = true;

  if (now - uiT > 55) {
    uiT = now;
    paintReadout(eng.crank);
    drawDiagram(eng.crank);
    drawChart(eng.rpm);
    paintFocus(eng.crank);
  }
}
// Framed on the Realm site, the page kept rendering after the visitor scrolled the
// host page past it. Inside an iframe this observer reports against the top-level
// viewport, so it pauses exactly when the frame is off screen.
let onScreen = true;
document.addEventListener('visibilitychange', () => { running = !document.hidden && onScreen; last = performance.now(); });
if ('IntersectionObserver' in window) new IntersectionObserver(([en]) => {
  onScreen = en.isIntersecting; running = onScreen && !document.hidden; last = performance.now();
}).observe(canvas);

// ---------------------------------------------------------------- boot
sizeCanvases();
readScroll();
{
  const pt = peakTorque(), pp = peakPower();
  $('#v-pkt').textContent = fmt(pt.nm);
  $('#v-pkp').textContent = fmt(pp.kw, 1);
  $('#v-pkq').textContent = fmt(pp.rpm);
}
// One empty frame first, so the headline and the instruments paint before the
// engine's first render, which compiles every shader and takes seconds on a cold
// GPU. Otherwise nothing at all painted for 3.4-3.7 s, framed or not.
applyChapter();
requestAnimationFrame(() => requestAnimationFrame(frame));
{
  // The curtain stays over the canvas, saying what is happening, until the first
  // full engine frame is on screen (the shaders compile in the background first),
  // instead of lifting onto an empty stage. Its line sits in the middle of the
  // engine's own stage, clear of the copy, and it lifts regardless after 12 s.
  const b = $('#boot'), s = STAGES[0], t0 = performance.now();
  if (s) {
    b.style.setProperty('--bx', `${Math.round((s.x0 + s.x1) / 2)}px`);
    b.style.setProperty('--by', `${Math.round((s.y0 + s.y1) / 2)}px`);
    b.style.setProperty('--bw', `${Math.round(s.x1 - s.x0)}px`);
  }
  const lift = () => {
    if (!post.ready && performance.now() - t0 < 12000) { setTimeout(lift, 50); return; }
    b.classList.add('gone');
    setTimeout(() => b.remove(), 700);
  };
  lift();
}
window.__ready = true;
// test hooks for framing work: stations can be tried live, then reframed
window.__chapters = CHAPTERS; window.__st = st; window.__reframe = () => { cropsDirty = true; };
window.__crop = () => CROP.map(c => c && [c.x0, c.y0, c.x1, c.y1, c.align].map(n => +n.toFixed(3)));
// test hook: the section is scroll-driven now, so the suite needs to read it
window.__section = () => section;
// test hook: hold the timed first cut part of the way (0..1), or let it go (null),
// so the suite can measure the scene mid-cut
window.__cut = k => { cutPin = k; };
window.__chapter = () => chapter;
window.__E = E;
window.__camera = camera;
window.__stages = () => STAGES.map(s => [s.x0, s.y0, s.x1, s.y1].map(Math.round));
window.__free = () => FREE.map(s => [s.x0, s.y0, s.x1, s.y1].map(Math.round));
window.__focus = () => ({ amt: +focusAmt.toFixed(2), cyl: focusCyl, aside: ASIDE.map(a => +a.toFixed(2)) });
window.__obst = i => OBST[i].slice(0, -3).map(b => [b.left, b.top, b.right, b.bottom].map(Math.round));
window.__cam = () => ({ pos: camPos.toArray().map(n => +n.toFixed(3)), look: camLook.toArray().map(n => +n.toFixed(3)), yaw: +orbitYaw.toFixed(3), pitch: +orbitPitch.toFixed(3), focus: focusCyl, MID: MID.toArray().map(n => +n.toFixed(3)), REACH: +REACH.toFixed(3) });
console.log('[SITE] imep', (imep() / 1e5).toFixed(2), 'bar | peak', peakTorque().nm.toFixed(0),
  'Nm at', peakTorque().rpm, '| power', peakPower().kw.toFixed(1), 'kW at', peakPower().rpm);
