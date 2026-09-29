// engine.js — every piece of geometry, built in code from the numbers in sim.js.
//
// No downloaded models and no image textures. Bore, stroke, rod length, firing
// order, valve lift and cam timing all come from the simulation, so the moving
// parts cannot disagree with the numbers on the page: the piston rides the exact
// slider-crank, the rod is solved from its two ends, and every cam lobe is turned
// from the same lift function that moves its valve.
//
// Axes: +X along the cylinder row (cylinder 1 at the front, +X), +Y up the bores,
// +Z to the intake side. The crank axis runs along X at y = 0, z = 0. Timing belt
// and accessories at the front (+X); flywheel at the rear (-X).

import * as THREE from 'three';
import { SPEC, wristHeight, FIRE_ANGLE, valveLift, TDC_Y } from './sim.js';
import {
  roundedBox, lathe, annulus, disc, pipeSolid, rodSolid, extrudeX, extrudeY, extrudeZ,
  poly, pathOf, circlePts, rectPts, fillet, stadiumPts, toothPts, merge, xf, hexPrism, flip, creased, taperTube,
  skinSolid, span, Tris,
} from './geo.js';
import { makeMaterials, VOIDS, NV, detail } from './materials.js';

// satin dark paint on the display stand's welded square tube: a fine orange peel
const uber_stand = () => detail(new THREE.MeshStandardMaterial({ name: 'stand_paint', color: 0x1e2023, metalness: 0.2, roughness: 0.56, envMapIntensity: 0.7 }), 'cast', { cell: 0.0008, rough: 0.04, bump: 0.00003, speck: 0 });
import { Capper } from './caps.js';

export { roundedBox };

// how far the display stand lifts the engine's lowest point off the floor (m)
// 0 since 2026-09-29: the stand is off (its feet and posts ran into the page text and controls in
// the framed sizes), so the engine sits on its sump on the floor again.
export const STAND_DROP = 0;

// Hex values below are sRGB. With colour management on they mean what they look like.
THREE.ColorManagement.legacyMode = false;

const DEG = Math.PI / 180;
const PITCH = 0.0965;                                   // bore pitch
const CYL_X = [1.5, 0.5, -0.5, -1.5].map(m => m * PITCH); // cylinder 1 at the front
const MAIN_X = [2, 1, 0, -1, -2].map(m => m * PITCH);   // five main bearings
const PIN_A = [0, Math.PI, Math.PI, 0];                  // 1 and 4 up together, 2 and 3 down
const DECK = TDC_Y + 0.030;                             // crown flush with the deck at TDC
const CR = SPEC.crankRadius;
const BORE_R = SPEC.bore / 2;
const BLOCK_L = 4 * PITCH + 0.052, HL = BLOCK_L / 2;    // 26 mm end walls
const BW = 0.084;                                       // block half-width at the deck
const HW = 0.092;                                       // head half-width

// ---- valvetrain layout. Four valves a cylinder, 33 degrees included.
const TILT = 16.5 * DEG;
const VALVE_DX = 0.0185;                                // valve pair either side of the bore axis
const SEAT_Z = 0.018;
const RIDGE = DECK + 0.0012 + 0.0135;                   // pent-roof ridge, above the gasket
const roofY = z => RIDGE - Math.abs(z) * Math.tan(TILT);
const SEAT_Y = roofY(SEAT_Z);
// stack along each valve axis, from the valve face (closed)
const S_SPRING = 0.050, SPRING_H = 0.037, S_TIP = 0.102, S_BUCKET = 0.105, CAM_BASE = 0.0185;
const S_CAM = S_BUCKET + CAM_BASE;
const CAM_Y = SEAT_Y + S_CAM * Math.cos(TILT);          // cam centres sit on the valve axes
const CAM_Z = SEAT_Z + S_CAM * Math.sin(TILT);
const HEAD_TOP = CAM_Y;                                 // cam caps split on the centreline

// ---- timing drive. 2:1 is the four-stroke: the cam turns once per 720 degrees.
const BELT_PITCH = 0.008;                               // HTD 8M
const CRANK_TEETH = 18, CAM_TEETH = 2 * CRANK_TEETH;
const R_CRANK_SPR = (CRANK_TEETH * BELT_PITCH) / (2 * Math.PI);
const R_CAM_SPR = (CAM_TEETH * BELT_PITCH) / (2 * Math.PI);
const XT = HL + 0.024;                                  // belt plane
const X_ACC = HL + 0.060;                               // accessory belt plane

// ---- valve lift. The valves are moved by sim.js's own valveLift(), the function
// every lobe is turned from, with the crank angle measured either side of the
// event centre. (sim.js's intakeLiftAt/exhaustLiftAt wrap that angle into 0..720,
// which drops the opening flank: lift stays at zero until the centre and then
// jumps to full. The lobe cannot do that, so the valve follows the lobe.)
const IN_CENTRE = (SPEC.intakeOpen + SPEC.intakeClose) / 2, EX_CENTRE = (SPEC.exhaustOpen + SPEC.exhaustClose) / 2;
const aroundCentre = a => ((((a + 360) % 720) + 720) % 720) - 360;          // (-360, 360]
export const intakeLift = phi => valveLift(aroundCentre(phi - IN_CENTRE), SPEC.intakeClose - SPEC.intakeOpen, SPEC.intakeLift);
export const exhaustLift = phi => valveLift(aroundCentre(phi - EX_CENTRE), SPEC.exhaustClose - SPEC.exhaustOpen, SPEC.exhaustLift);

// ---- the water-jacket wall of the block: |z| of its outer face at (x, y). Base
// 77.5 mm off the bore row, a 4 mm bulge over each barrel fading out toward the
// deck and the skirt, a concave fillet up into the deck (stopping 1.5 mm inside
// its edge, so the machined deck still shows as a lip) and one down into the
// crankcase skirt, and the vertical corners at the two ends rounded off.
const JK_Y0 = 0.066, JK_Y1 = DECK - 0.0095, JK_ZB = 0.0775;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function jacketZ(x, y) {
  let b = 0;
  for (const cx of CYL_X) { const d = Math.abs(x - cx) / 0.050; if (d < 1) b = Math.max(b, 0.5 * (1 + Math.cos(Math.PI * d))); }
  const g = sstep(JK_Y0 + 0.004, JK_Y0 + 0.026, y) * (1 - sstep(JK_Y1 - 0.024, JK_Y1 - 0.003, y));
  let z = JK_ZB + 0.0058 * b * g;
  const cove = (s, h) => (s > 0 ? h * (1 - Math.sqrt(Math.max(0, 1 - Math.min(1, s) ** 2))) : 0);
  z += cove((y - (JK_Y1 - 0.0070)) / 0.0070, BW - 0.0015 - JK_ZB);          // into the deck
  z += cove(((JK_Y0 + 0.0085) - y) / 0.0085, 0.0838 - JK_ZB);               // into the skirt
  const e = Math.abs(x) - (HL - 0.007);
  if (e > 0) z -= 0.0035 * (1 - Math.sqrt(Math.max(0, 1 - (e / 0.007) ** 2)));
  return z;
}
// ---- the crankcase skirt's outer face: |z| at (x, y), from the pan rail up the
// flare to the foot of the jacket. The plain skirt (skirtBase) is 102 mm off the
// crank axis, flaring in to 84 mm under the jacket; over it each bay between two
// bulkheads bulges 2.2 mm at mid-height, the main oil gallery runs along the
// flare as a rounded 4.5 mm ridge, and within a centimetre of each rib the wall
// rises 3 mm into it through a concave fillet.
const skirtBase = y => (y > -0.010 ? 0.102 - (y + 0.010) * (0.018 / 0.062) : 0.102);
function skirtZ(x, y) {
  let z = skirtBase(y), dr = 1;
  for (const m of [2, 1, 0, -1, -2]) dr = Math.min(dr, Math.abs(x - m * PITCH));
  const bay = Math.min(1, dr / (PITCH / 2));
  const env = sstep(-0.068, -0.052, y) * (1 - sstep(0.030, 0.050, y));
  z += 0.0022 * env * (0.5 - 0.5 * Math.cos(Math.PI * bay));
  const fd = Math.max(0, 1 - Math.max(0, dr - 0.0065) / 0.010);
  z += 0.0030 * fd * fd * sstep(-0.070, -0.060, y) * (1 - sstep(0.040, 0.056, y));
  const gd = (y - 0.018) / 0.012;
  if (Math.abs(gd) < 1) z += 0.0045 * (0.5 + 0.5 * Math.cos(Math.PI * gd)) * (1 - sstep(HL - 0.030, HL - 0.004, Math.abs(x)));
  const e = Math.abs(x) - (HL - 0.006);
  if (e > 0) z -= 0.004 * (1 - Math.sqrt(Math.max(0, 1 - (e / 0.006) ** 2)));
  return z;
}
const SK_XS = (() => {
  const xs = new Set([-HL, HL]);
  for (const m of [2, 1, 0, -1, -2]) for (const d of [0, 0.0065, 0.0095, 0.013, 0.018, 0.026, 0.037]) for (const s of [-1, 1]) xs.add(+(m * PITCH + s * d).toFixed(6));
  for (const e of [0.002, 0.004, 0.006]) { xs.add(+(HL - e).toFixed(6)); xs.add(+(e - HL).toFixed(6)); }
  return [...xs].filter(x => Math.abs(x) <= HL).sort((a, b) => a - b);
})();
const SK_YS = [...new Set([...span(-0.0690, -0.0100, 6), ...span(-0.0100, 0.0060, 3), ...span(0.0060, 0.0300, 8), ...span(0.0300, 0.0540, 4)].map(v => +v.toFixed(6)))].sort((a, b) => a - b);

const JK_YS = [...new Set([...span(JK_Y0, JK_Y0 + 0.0085, 5), ...span(JK_Y0 + 0.0085, JK_Y1 - 0.007, 11), ...span(JK_Y1 - 0.007, JK_Y1, 5)].map(v => +v.toFixed(6)))].sort((a, b) => a - b);

// ---------------------------------------------------------------- small helpers
const latheX = (profile, segs = 48, opt) => xf(lathe(profile, segs, opt), 0, 0, 0, 0, 0, -Math.PI / 2);
const ringX = (rIn, rOut, x0, x1, segs = 48) => latheX([[rIn, x0], [rOut, x0], [rOut, x1], [rIn, x1]], segs);
const discX = (r, x0, x1, segs = 48) => latheX([[0, x0], [r, x0], [r, x1], [0, x1]], segs);
const hexX = (r, x0, x1) => xf(hexPrism(r, x1 - x0, x0), 0, 0, 0, 0, 0, -Math.PI / 2);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const curve = pts => new THREE.CatmullRomCurve3(pts.map(p => V3(...p)), false, 'centripetal');

function mesh(parent, geo, mat, name = '', shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.castShadow = shadow; m.receiveShadow = true;
  parent.add(m);
  return m;
}

// Bucket of geometries per material, merged into one draw at the end.
class Parts {
  constructor() { this.m = new Map(); }
  add(key, ...g) { if (!this.m.has(key)) this.m.set(key, []); this.m.get(key).push(...g.filter(Boolean)); }
  build(parent, mats, onEach) {
    for (const [key, list] of this.m) {
      const m = mesh(parent, merge(list), mats[key], key);
      if (onEach) onEach(m, key);
    }
  }
}

// ---------------------------------------------------------------- cam lobe
// The lobe is turned from the same lift function that moves its valve. The cam
// runs at half crank speed, so a lobe angle `a` is crank angle 2a: the lobe is the
// lift curve laid round the base circle in polar form. Built as a polar radius
// function so it never self-intersects, laid out in ZY with the axis along X and
// the nose pointing down (-Y) at zero rotation.
export function camLobeGeometry(maxLift, durationDeg, baseR, width) {
  const N = 96;
  const shape = new THREE.Shape();
  for (let i = 0; i <= N; i++) {
    const a = (360 * i) / N;                                  // cam degrees, 0 = nose
    const camA = a > 180 ? a - 360 : a;
    const r = baseR + valveLift(2 * camA, durationDeg, maxLift);
    const th = a * DEG;
    const y = -Math.cos(th) * r, z = Math.sin(th) * r;
    if (i === 0) shape.moveTo(z, y); else shape.lineTo(z, y);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - 0.001, bevelEnabled: true, bevelThickness: 0.0005,
    bevelSize: 0.0005, bevelOffset: -0.0005, bevelSegments: 1, curveSegments: 4,
  });
  g.translate(0, 0, -(width - 0.001) / 2);
  g.rotateY(-Math.PI / 2);                                    // extrusion along X, z stays z
  // smooth round the ground flank, crisp at the chamfers: the highlight runs
  // unbroken over the nose instead of stepping facet by facet
  return creased(g, 40);
}

// ---------------------------------------------------------------- belt loop
// A belt round a set of pulleys, all on the inside of the loop, listed counter-
// clockwise in (z, y). Returns the pitch line densely sampled with its outward
// normal and running arc length, which the belt shader uses to move the teeth.
function beltLoop(pulleys, step = 0.002, run = 0.01) {
  const n = pulleys.length, tan = [];
  for (let i = 0; i < n; i++) {
    const A = pulleys[i], B = pulleys[(i + 1) % n];
    const dx = B.c[0] - A.c[0], dy = B.c[1] - A.c[1], L = Math.hypot(dx, dy);
    const d = [dx / L, dy / L], rt = [d[1], -d[0]];
    const k = (A.r - B.r) / L, s = Math.sqrt(1 - k * k);
    const nn = [k * d[0] + s * rt[0], k * d[1] + s * rt[1]];
    tan.push({ a: [A.c[0] + A.r * nn[0], A.c[1] + A.r * nn[1]], b: [B.c[0] + B.r * nn[0], B.c[1] + B.r * nn[1]], n: nn });
  }
  const pts = [], nrm = [], arc = [];
  let s = 0;
  const push = (p, nv) => {
    if (pts.length) s += Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]);
    pts.push(p); nrm.push(nv); arc.push(s);
  };
  for (let i = 0; i < n; i++) {
    const P = pulleys[i], tin = tan[(i - 1 + n) % n], tout = tan[i];
    const a0 = Math.atan2(tin.n[1], tin.n[0]);
    let a1 = Math.atan2(tout.n[1], tout.n[0]);
    while (a1 <= a0) a1 += Math.PI * 2;
    const m = Math.max(2, Math.ceil(((a1 - a0) * P.r) / step));
    for (let k = 0; k <= m; k++) {
      const a = a0 + ((a1 - a0) * k) / m;
      push([P.c[0] + P.r * Math.cos(a), P.c[1] + P.r * Math.sin(a)], [Math.cos(a), Math.sin(a)]);
    }
    // straight run to the next pulley, sampled so the teeth attribute is smooth
    const q = Math.max(1, Math.ceil(Math.hypot(tout.b[0] - tout.a[0], tout.b[1] - tout.a[1]) / run));
    for (let k = 1; k < q; k++) push([tout.a[0] + ((tout.b[0] - tout.a[0]) * k) / q, tout.a[1] + ((tout.b[1] - tout.a[1]) * k) / q], tout.n);
  }
  return { pts, nrm, arc, length: s };
}

function beltSolid(loop, outer, inner, x, width) {
  const O = loop.pts.map((p, i) => [p[0] + loop.nrm[i][0] * outer, p[1] + loop.nrm[i][1] * outer]);
  const I = loop.pts.map((p, i) => [p[0] - loop.nrm[i][0] * inner, p[1] - loop.nrm[i][1] * inner]);
  const shape = poly(O);
  shape.holes.push(pathOf(I));
  const g = xf(extrudeX(shape, width, 0.0006), x, 0, 0);
  // arc length for each vertex, from the nearest pitch-line sample (looked up in a
  // coarse grid of the samples: a search of every sample for every vertex was a
  // tenth of the engine's build time)
  const p = g.attributes.position, a = new Float32Array(p.count);
  const cell = 0.012, grid = new Map(), ck = (i, j) => i * 65536 + j;
  loop.pts.forEach(([z, y], k) => {
    const key = ck(Math.floor(z / cell), Math.floor(y / cell));
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(k);
  });
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i), y = p.getY(i), gi = Math.floor(z / cell), gj = Math.floor(y / cell);
    let best = 1e9, bi = -1;
    for (let r = 1; bi < 0 && r < 64; r++) {
      for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
        const list = grid.get(ck(gi + di, gj + dj));
        if (list) for (const k of list) {
          const d = (loop.pts[k][0] - z) ** 2 + (loop.pts[k][1] - y) ** 2;
          if (d < best) { best = d; bi = k; }
        }
      }
    }
    a[i] = loop.arc[Math.max(0, bi)];
  }
  // the arc rides in uv.x, so the belt shares the engine's one shader program
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) uv[i * 2] = a[i];
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

// ---------------------------------------------------------------- crank web
// A forged web: the pin boss over the top, a waist either side of the main
// journal, and a pear-shaped counterweight opposite the pin whose rim is turned
// on a lathe. Laid out in (z, y) with the pin up; turned to each throw's angle.
const WEB_RC = 0.0745, WEB_SPAN = 62 * DEG;
function webShape() {
  const Rp = 0.0295, P = [];
  const arc = (cx, cy, r, a0, a1, n) => { for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  arc(0, 0, WEB_RC, 1.5 * Math.PI - WEB_SPAN, 1.5 * Math.PI + WEB_SPAN, 34);   // counterweight rim
  // right flank: a concave waist from the rim up to the pin boss
  const flank = [[0.0555, -0.0205], [0.0455, -0.0040], [0.0385, 0.0140], [0.0325, 0.0290]];
  P.push(...flank);
  arc(0, CR, Rp, -0.30, Math.PI + 0.30, 26);                                     // pin boss, over the top
  P.push(...flank.map(([z, y]) => [-z, y]).reverse());
  return poly(fillet(P, 0.007, 5));
}
// An extrusion along X with rounded (not chamfered) long edges, the way a forging
// or a casting comes out of its die.
function roundExtrudeX(shape, depth, r = 0.0025, segs = 3) {
  const ex = shape.extractPoints(24);
  const s = new THREE.Shape(ex.shape);
  // holes wound counter-clockwise: three flips them consistently with the outline
  s.holes = ex.holes.map(h => new THREE.Path(THREE.ShapeUtils.isClockWise(h) ? h.slice().reverse() : h));
  const g = new THREE.ExtrudeGeometry(s, {
    depth: depth - 2 * r, curveSegments: 24, steps: 1,
    bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelOffset: -r, bevelSegments: segs,
  });
  g.translate(0, 0, -(depth - 2 * r) / 2);
  g.rotateY(-Math.PI / 2);
  return creased(g, 38);
}
// Split a geometry's triangles by a test on each triangle's centroid and normal.
function splitTris(g, test) {
  g = g.index ? g.toNonIndexed() : g;
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  const out = [{ p: [], n: [], uv: [] }, { p: [], n: [], uv: [] }];
  const c = new THREE.Vector3(), fn = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  for (let t = 0; t < p.count; t += 3) {
    a.fromBufferAttribute(p, t); b.fromBufferAttribute(p, t + 1); d.fromBufferAttribute(p, t + 2);
    c.copy(a).add(b).add(d).multiplyScalar(1 / 3);
    fn.subVectors(d, b).cross(a.clone().sub(b)).normalize();
    const o = out[test(c, fn) ? 1 : 0];
    for (let k = 0; k < 3; k++) {
      o.p.push(p.getX(t + k), p.getY(t + k), p.getZ(t + k));
      o.n.push(n.getX(t + k), n.getY(t + k), n.getZ(t + k));
      o.uv.push(uv ? uv.getX(t + k) : 0, uv ? uv.getY(t + k) : 0);
    }
  }
  return out.map(o => {
    const h = new THREE.BufferGeometry();
    h.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3));
    h.setAttribute('normal', new THREE.Float32BufferAttribute(o.n, 3));
    h.setAttribute('uv', new THREE.Float32BufferAttribute(o.uv, 2));
    return h;
  });
}

// ---------------------------------------------------------------- assembly
export function buildEngine() {
  const M = makeMaterials();         // mechanism and anything left whole
  const C = makeMaterials();         // castings: these get the clipping plane
  const root = new THREE.Group();
  root.name = 'engine';
  const statics = new THREE.Group(); statics.name = 'statics'; root.add(statics);
  const shells = new Parts();         // clipped, capped
  const whole = new Parts();          // static, never clipped
  const boltsClip = [], boltsMech = [];
  const bolt = (list, x, y, z, dir = [0, 1, 0], s = 1) => list.push({ p: V3(x, y, z), d: V3(...dir).normalize(), s });
  const cores = [];                   // cavities: cored passages, counted out of the section
  // Accessories: the bolted-on parts a museum cutaway strips before the engine is
  // sawn open. They are never cut (a sectioned alternator or filter can reads as a
  // flat sticker); each group is taken off, fading and drawing away from the
  // block, as the section plane comes to it. See setSection.
  const acc = new Map();
  const A = (group, key, ...g) => { if (!acc.has(group)) acc.set(group, { parts: new Parts(), bolts: [] }); acc.get(group).parts.add(key, ...g); };
  const accBolt = (group, x, y, z, dir = [0, 1, 0], s = 1) => { if (!acc.has(group)) acc.set(group, { parts: new Parts(), bolts: [] }); bolt(acc.get(group).bolts, x, y, z, dir, s); };

  // ================================================================ block
  const blockPlan = fillet(rectPts(-HL, -BW, HL, BW), 0.008, 3);
  {
    // Upper block: one closed water jacket round the bore row. Its outer wall is a
    // sand casting that follows the barrels inside it with a few millimetres of
    // relief, a shallow bulge over each bore, and runs out into the deck above and
    // the crankcase below through concave fillets, so no light gets between the
    // barrels and the wall reads as one casting, not a frame round four cans.
    // (The inner core wall, a stadium round the bores, is the solid under it.)
    const s = poly(fillet(rectPts(-HL, -0.0745, HL, 0.0745), 0.002, 2), true);
    s.holes.push(pathOf(stadiumPts(CYL_X[3], CYL_X[0], 0, 0.0635, 24), true));
    shells.add('cast', extrudeY(s, 0.060, DECK - 0.010, 0.0015));
    for (const sz of [1, -1]) shells.add('cast', skinSolid(span(-HL, HL, 44), JK_YS, jacketZ, 0.006, sz));
    // closed deck, machined, with the liners passing through it
    const d = poly(blockPlan, true);
    CYL_X.forEach(x => d.holes.push(pathOf(circlePts(x, 0, 0.0462, 48), true)));
    shells.add('machined', extrudeY(d, DECK - 0.0102, DECK, 0.001));
    // siamesed barrels and iron liners
    CYL_X.forEach(x => {
      shells.add('cast', xf(annulus(0.0462, 0.0525, DECK - 0.009 - 0.080, 48, 0), x, 0.080, 0));
      shells.add('liner', xf(annulus(BORE_R, 0.0465, DECK - 0.078, 64, 0), x, 0.078, 0));
    });
    // floor of the water jacket
    const f = poly(fillet(rectPts(-HL + 0.002, -BW + 0.002, HL - 0.002, BW - 0.002), 0.006, 3), true);
    CYL_X.forEach(x => f.holes.push(pathOf(circlePts(x, 0, 0.0435, 48), true)));
    shells.add('cast', extrudeY(f, 0.066, 0.080));
  }
  // crankcase skirts: flare out to clear the throws, then drop to the bedplate rail
  const skirtPts = [[0.076, 0.070], [0.084, 0.070], [0.084, 0.052], [0.102, -0.010], [0.102, -0.070],
    [0.108, -0.072], [0.108, -0.084], [0.094, -0.084], [0.094, -0.012], [0.076, 0.050]];
  for (const sz of [1, -1]) {
    const pts = skirtPts.map(([z, y]) => [z * sz, y]);
    shells.add('cast', extrudeX(poly(fillet(sz > 0 ? pts : pts.reverse(), 0.003, 3)), BLOCK_L, 0.0015));
  }
  // end walls of the crankcase, with the crank passing through
  const endPts = [[-0.084, 0.070], [0.084, 0.070], [0.084, 0.052], [0.102, -0.010], [0.102, -0.070], [0.108, -0.072],
    [0.108, -0.084], [-0.108, -0.084], [-0.108, -0.072], [-0.102, -0.070], [-0.102, -0.010], [-0.084, 0.052]];
  for (const sx of [1, -1]) {
    const s = poly(fillet(endPts, 0.003, 3));
    s.holes.push(pathOf(circlePts(0, 0, 0.034, 40)));
    shells.add('cast', xf(extrudeX(s, 0.026, 0.0015), sx * (HL - 0.013), 0, 0));
  }
  // bulkheads and main caps at every main bearing
  const notchUp = [[-0.093, 0], ...circlePts(0, 0, 0.0275, 24, Math.PI, 0), [0.093, 0], [0.078, 0.066], [-0.078, 0.066]];
  const capPts = [[-0.046, 0], ...circlePts(0, 0, 0.0275, 24, Math.PI, 2 * Math.PI), [0.046, 0], [0.046, -0.040], [0.030, -0.048], [-0.030, -0.048], [-0.046, -0.040]];
  MAIN_X.forEach((x, k) => {
    if (k > 0 && k < 4) shells.add('cast', xf(extrudeX(poly(fillet(notchUp, 0.004, 3)), 0.018, 0.0015), x, 0, 0));
    shells.add('cast', xf(extrudeX(poly(fillet(capPts.map(p => [p[0], p[1] - 0.0003]), 0.003, 3)), 0.018, 0.0015), x, 0, 0));
    for (const sz of [1, -1]) bolt(boltsClip, x, -0.0483, sz * 0.036, [0, -1, 0], 1.1);
    whole.add('bronze', ringX(0.026, 0.0274, x - 0.009, x + 0.009, 40));
  });
  // Exterior casting detail on the crankcase. The skirt's outer face is a height
  // field laid over the plain skirt (skirtZ): each bay between the bulkheads
  // bulges a couple of millimetres, the main oil gallery runs along the flare as a
  // rounded ridge, and the wall rises into every rib through a concave fillet, so
  // the ribs grow out of the casting instead of being strips laid on a panel.
  // The ribs themselves stand 11 mm proud and carry draft: 15 mm thick at the
  // root, 8 mm at the crest, as a rib comes out of a sand mould.
  for (const sz of [1, -1]) shells.add('cast', skinSolid(SK_XS, SK_YS, skirtZ, 0.006, sz));
  const ribPts = [[0.0995, -0.0705], [0.1125, -0.0690], [0.1130, -0.0060], [0.0975, 0.0440], [0.0885, 0.0650], [0.0830, 0.0780], [0.0785, 0.0805], [0.0740, 0.0800], [0.0740, 0.0620], [0.0860, 0.0500], [0.0990, -0.0100]];
  const draftRib = (g, x0) => {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const d = Math.min(1, Math.max(0, (Math.abs(p.getZ(i)) - skirtBase(p.getY(i))) / 0.011));
      p.setX(i, x0 + (p.getX(i) - x0) * (1.5 - 0.7 * d));
    }
    return creased(g, 34);
  };
  for (const sz of [1, -1]) {
    const pts = ribPts.map(([z, y]) => [z * sz, y]);
    MAIN_X.forEach(x => shells.add('cast', draftRib(xf(extrudeX(poly(fillet(sz > 0 ? pts : pts.reverse(), 0.0025, 2)), 0.010, 0.0025), x, 0, 0), x)));
    // the belt rib where the water jacket stands on the crankcase: a chamfered
    // ledge, not a bar laid across it
    const ledge = [[0.0740, 0.0580], [0.0870, 0.0580], [0.0905, 0.0620], [0.0880, 0.0665], [0.0740, 0.0680]].map(([z, y]) => [z * sz, y]);
    shells.add('cast', extrudeX(poly(fillet(sz > 0 ? ledge : ledge.reverse(), 0.0015, 2)), BLOCK_L - 0.010, 0.0012));
  }
  // A raised casting-number pad on the intake side of the jacket, between
  // cylinders 3 and 4 above the mount, with the part number raised on it in a
  // pattern-maker's block letters (the page's own model number, not a maker's).
  {
    const px = -0.0965, py = 0.176, pz = jacketZ(px, py);
    shells.add('cast', xf(roundedBox(0.082, 0.021, 0.008, 0.0025), px, py, pz + 0.0003));
    const SEG = { a: [0, 1, 1, 0], b: [1, 1, 1, 0.5], c: [1, 0.5, 1, 0], d: [0, 0, 1, 0], e: [0, 0.5, 0, 0], f: [0, 1, 0, 0.5], g: [0, 0.5, 1, 0.5] };
    const GLYPH = { A: 'abcefg', 0: 'abcdef', 2: 'abged', 1: 'bc', '-': 'g', F: 'aefg', S: 'afgcd' };
    const W = 0.0056, H = 0.0110, T = 0.0021, text = 'A0021-FS';
    [...text].forEach((ch, k) => {
      const cx = px - (text.length - 1) * 0.0045 + k * 0.0090 - W / 2, cy = py - H / 2;
      for (const s of GLYPH[ch]) {
        const [x0, y0, x1, y1] = SEG[s];
        const w = Math.abs(x1 - x0) * W + T, h = Math.abs(y1 - y0) * H + T;
        shells.add('cast', xf(roundedBox(w, h, 0.0024, 0.0006, 1), cx + (x0 + x1) / 2 * W, cy + (y0 + y1) / 2 * H, pz + 0.0043));
      }
    });
  }
  // blanking plugs: two threaded bosses low on each skirt, a hex-socket plug in
  // each, and the gallery's end plugs in bosses on both end walls
  for (const sz of [1, -1]) for (const x of [0.048, -0.048]) {
    const y = -0.046, z = skirtZ(x, y) - 0.001;
    const q = sz > 0 ? 0 : Math.PI;
    shells.add('cast', xf(lathe([[0, -0.004], [0.0125, -0.004], [0.0135, 0.0022], [0.0115, 0.0042], [0, 0.0042]], 32, { crease: 50 }), x, y, sz * z, Math.PI / 2, q, 0));
    shells.add('steel', xf(lathe([[0, 0.0040], [0.0082, 0.0040], [0.0082, 0.0062], [0.0074, 0.0070], [0.0030, 0.0070], [0.0030, 0.0058], [0, 0.0058]], 6, { crease: 20 }), x, y, sz * z, Math.PI / 2, q, 0));
  }
  for (const sx of [1, -1]) {
    shells.add('cast', xf(lathe([[0, -0.004], [0.0115, -0.004], [0.0125, 0.0020], [0.0105, 0.0038], [0, 0.0038]], 28, { crease: 50 }), sx * HL, 0.018, 0.070, 0, 0, -sx * Math.PI / 2));
    shells.add('steel', xf(lathe([[0, 0.0036], [0.0072, 0.0036], [0.0072, 0.0056], [0.0064, 0.0064], [0, 0.0064]], 6, { crease: 20 }), sx * HL, 0.018, 0.070, 0, 0, -sx * Math.PI / 2));
  }
  // core plugs on the exhaust side, oil-filter boss and engine mounts on the intake side
  // A knock sensor on a machined boss low between cylinders 2 and 3 on the intake
  // side, where a knock sensor lives: the puck, its centre bolt and the plug
  // lead's moulded exit (bolted on, so it comes off with the accessories). And a
  // drain plug low in the jacket at the rear, in its own boss.
  {
    const kx = 0.028, ky = 0.106, kz = jacketZ(kx, ky);
    shells.add('cast', xf(lathe([[0, -0.004], [0.0155, -0.004], [0.0165, 0.0010], [0.0150, 0.0024], [0, 0.0024]], 36, { crease: 50 }), kx, ky, kz, Math.PI / 2, 0, 0));
    A('sensors', 'plastic', xf(lathe([[0.0045, 0.0024], [0.0135, 0.0024], [0.0142, 0.0045], [0.0142, 0.0118], [0.0125, 0.0135], [0.0045, 0.0135]], 36, { crease: 40 }), kx, ky, kz, Math.PI / 2, 0, 0));
    A('sensors', 'steel', xf(lathe([[0, 0.0024], [0.0050, 0.0024], [0.0050, 0.0150], [0, 0.0150]], 16), kx, ky, kz, Math.PI / 2, 0, 0));
    A('sensors', 'bolt', xf(hexPrism(0.0068, 0.0045, 0.0138), kx, ky, kz, Math.PI / 2, 0, 0));
    A('sensors', 'plastic', xf(roundedBox(0.012, 0.010, 0.008, 0.002), kx + 0.016, ky - 0.004, kz + 0.008));
    A('sensors', 'rubber', rodSolid(curve([[kx + 0.020, ky - 0.004, kz + 0.008], [kx + 0.022, ky + 0.014, kz + 0.009], [kx - 0.006, ky + 0.024, kz + 0.006], [kx - 0.040, ky + 0.022, kz + 0.004]]), 0.0024, 12, 8));
    const dx = -0.150, dy = 0.082, dz = -jacketZ(dx, dy);
    shells.add('cast', xf(lathe([[0, -0.004], [0.0105, -0.004], [0.0112, 0.0012], [0.0100, 0.0030], [0, 0.0030]], 28, { crease: 50 }), dx, dy, dz, -Math.PI / 2, 0, 0));
    shells.add('bolt', xf(hexPrism(0.0072, 0.0050, 0.0030), dx, dy, dz, -Math.PI / 2, 0, 0));
  }
  // (pressed into shallow bosses on the jacket wall, so they sit on it, not off it)
  [[-0.10, 0.135, -1], [0, 0.135, -1], [0.10, 0.135, -1], [0.0965, 0.150, 1]].forEach(([x, y, s]) => {
    const z = jacketZ(x, y);
    shells.add('cast', xf(lathe([[0.0165, -0.004], [0.0205, -0.004], [0.0215, 0.0005], [0.0205, 0.0022], [0.0165, 0.0022]], 36), x, y, s * z, s * Math.PI / 2, 0, 0));
    shells.add('steel', xf(lathe([[0, -0.003], [0.0158, -0.003], [0.0158, 0.0012], [0.0150, 0.0018], [0, 0.0018]], 36), x, y, s * z, s * Math.PI / 2, 0, 0));
  });
  for (const sz of [1, -1]) {
    shells.add('cast', xf(roundedBox(0.074, 0.056, 0.016, 0.003), -0.045, 0.118, sz * 0.0855));
    [[-0.07, 0.132], [-0.02, 0.132], [-0.045, 0.104]].forEach(([x, y]) => bolt(boltsClip, x, y, sz * 0.0935, [0, 0, sz], 1));
  }

  // ================================================================ oil pan
  {
    // A cast-alloy upper sump bolted to the block rail, and under it a pressed
    // steel pan in satin black: a flanged lip, sides drawn in toward the bottom,
    // two swage beads to stiffen them, a deep well at the rear with the drain plug
    // and the pickup in it.
    const YU = -0.084, YP = -0.116;                      // upper sump from the rail down to the pan
    const up = poly(fillet(rectPts(-HL, -0.108, HL, 0.108), 0.008, 3), true);
    up.holes.push(pathOf(fillet(rectPts(-HL + 0.010, -0.096, HL - 0.010, 0.096), 0.006, 3), true));
    shells.add('cast', extrudeY(up, YP, YU + 0.0004, 0.0012));
    for (const sz of [1, -1]) MAIN_X.forEach(x => shells.add('cast', xf(roundedBox(0.008, YU - YP - 0.006, 0.006, 0.0025), x, (YU + YP) / 2 - 0.001, sz * 0.109)));
    for (const sx of [1, -1]) shells.add('cast', xf(roundedBox(0.006, YU - YP - 0.006, 0.150, 0.0025), sx * (HL + 0.0015), (YU + YP) / 2 - 0.001, 0));
    // the pan: its sides are drawn in toward the bottom (a pressing has draft),
    // done by narrowing z with depth, which keeps every solid closed
    const draft = g => {
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < YP) p.setZ(i, p.getZ(i) * (1 - 0.55 * (YP - y))); }
      return creased(g, 34);
    };
    const XW = HL - 0.40 * BLOCK_L;                      // sump well: rear 60 %
    const W = 0.0042;                                    // wall
    const out = [[HL - 0.004, YP + 0.0003], [HL - 0.004, -0.150], [XW, -0.150], [XW - 0.030, -0.205], [-HL + 0.004, -0.205], [-HL + 0.004, YP + 0.0003]];
    const inn = [[-HL + 0.004 + W, YP + 0.0003], [-HL + 0.004 + W, -0.205 + W], [XW - 0.030 - W * 0.4, -0.205 + W], [XW - W * 0.6, -0.150 + W], [HL - 0.004 - W, -0.150 + W], [HL - 0.004 - W, YP + 0.0003]];
    const band = fillet([...out, ...inn], 0.011, 5);
    shells.add('pan', draft(extrudeZ(poly(band), 0.196, 0.0018)));
    for (const sz of [1, -1]) shells.add('pan', draft(xf(extrudeZ(poly(fillet(out, 0.011, 5)), W, 0.0012), 0, 0, sz * (0.098 - W / 2))));
    // the flanged lip the pan is bolted up by
    const lip = poly(fillet(rectPts(-HL - 0.002, -0.106, HL + 0.002, 0.106), 0.008, 3), true);
    lip.holes.push(pathOf(fillet(rectPts(-HL + 0.004 + W, -0.098 + W, HL - 0.004 - W, 0.098 - W), 0.006, 3), true));
    shells.add('pan', extrudeY(lip, YP - 0.0035, YP + 0.0003, 0.0008));
    for (let x = -0.18; x <= 0.181; x += 0.06) for (const sz of [1, -1]) bolt(boltsClip, x, YP - 0.0035, sz * 0.102, [0, -1, 0], 0.9);
    for (const sx of [1, -1]) for (const z of [-0.05, 0.05]) bolt(boltsClip, sx * (HL - 0.0005), YP - 0.0035, z, [0, -1, 0], 0.9);
    // Pressed into both sides: a flat swage along the top, and a raised panel on
    // the flank of the well, both with the soft shoulders a press die leaves, so
    // they read as part of the sheet (a round bar along it read as a rod laid on
    // the pan)
    for (const sz of [1, -1]) {
      shells.add('pan', draft(xf(roundedBox(2 * HL - 0.040, 0.008, 0.005, 0.0022), 0, -0.1335, sz * 0.0968)));
      shells.add('pan', draft(xf(roundedBox(0.112, 0.030, 0.006, 0.0027), -0.066, -0.1775, sz * 0.0967)));
    }
    // drain plug in a welded boss low on the well, and a second on the floor
    const zs = y => 0.098 * (1 - 0.55 * (YP - y));
    shells.add('pan', xf(lathe([[0, -0.002], [0.0135, -0.002], [0.0146, 0.0012], [0.0126, 0.0046], [0, 0.0046]], 32, { crease: 50 }), -0.150, -0.188, zs(-0.188) - 0.0015, Math.PI / 2, 0, 0));
    bolt(boltsClip, -0.150, -0.188, zs(-0.188) + 0.0031, [0, 0, 1], 1.6);
    bolt(boltsClip, -0.15, -0.205, 0.03, [0, -1, 0], 1.6);
    // Oil pickup, visible through the cut: a two-bolt flange on the underside of
    // the centre main cap, the tube down into the sump well, the strainer on its
    // end, and a strap from the tube to a stud on the next cap, so it is carried
    // at both ends instead of hanging under the crank.
    {
      const fl = poly(stadiumPts(-0.025, 0.001, 0, 0.0085, 10).map(([a, b]) => [b, a]), true);
      shells.add('steel', extrudeY(fl, -0.0530, -0.0484, 0.0006));
      for (const z of [-0.025, 0.001]) bolt(boltsClip, 0, -0.0530, z, [0, -1, 0], 0.7);
      const tube = curve([[0, -0.0525, -0.012], [0, -0.068, -0.013], [-0.018, -0.106, -0.022], [-0.050, -0.150, -0.029], [-0.068, -0.176, -0.030], [-0.070, -0.187, -0.030]]);
      shells.add('steel', pipeSolid(tube, 0.0068, 0.0054, 40, 14));
      shells.add('steel', xf(lathe([[0, -0.003], [0.0085, -0.003], [0.0085, 0.003], [0, 0.003]], 20), 0, -0.0555, -0.012));
      shells.add('pan', xf(disc(0.026, 0.008, 32), -0.07, -0.192, -0.030));      // strainer, painted: bare, it mirrored the softbox white
      shells.add('steel', xf(lathe([[0, -0.0015], [0.0105, -0.0015], [0.0105, 0.0015], [0, 0.0015]], 20), -0.07, -0.1865, -0.030));
      // support strap: a clamp band round the tube, the strap up to the cap stud, a nut
      const A0 = tube.getPointAt(0.66).add(V3(0, 0, -0.0085)), A1 = V3(-0.0965, -0.0525, -0.036), mid = A0.clone().add(A1).multiplyScalar(0.5), d = A1.clone().sub(A0);
      const sq = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), d.clone().normalize());
      shells.add('darkSteel', roundedBox(0.010, d.length(), 0.0022, 0.0008).applyQuaternion(sq).translate(mid.x, mid.y, mid.z));
      const cp = tube.getPointAt(0.66), cq = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), tube.getTangentAt(0.66));
      shells.add('darkSteel', annulus(0.0068, 0.0086, 0.009, 20).applyQuaternion(cq).translate(cp.x, cp.y, cp.z));
      bolt(boltsClip, -0.0965, -0.0530, -0.036, [0, -1, 0], 0.8);
    }
  }

  // ================================================================ head
  {
    const gasket = poly(blockPlan, true);
    CYL_X.forEach(x => gasket.holes.push(pathOf(circlePts(x, 0, BORE_R + 0.0004, 48), true)));   // the fire ring sits at the bore
    // Every stacked joint overlaps by 0.2 mm. Where two shells met on one shared
    // face, the section count along that line was decided by float noise between
    // two coincident faces, and it showed as a dashed seam through the paint.
    shells.add('gasket', extrudeY(gasket, DECK - 0.0002, DECK + 0.0014));
    const headPlan = fillet(rectPts(-HL, -HW, HL, HW), 0.006, 3);
    // fire deck: a machined band at the joint, then the casting
    const band = poly(headPlan, true), deck = poly(headPlan, true);
    CYL_X.forEach(x => { band.holes.push(pathOf(circlePts(x, 0, BORE_R, 48), true)); deck.holes.push(pathOf(circlePts(x, 0, BORE_R, 48), true)); });
    shells.add('machined', extrudeY(band, DECK + 0.0012, DECK + 0.0072, 0.0008));
    shells.add('headCast', extrudeY(deck, DECK + 0.007, DECK + 0.0242, 0.0015));
    // Pent-roof chambers, recessed into the head: the two roof flanks sit square
    // to the valve axes, so each valve face lies flush in its flank, and toward
    // the ends of the chamber (along the crank) the roof turns down in a steep
    // curved wall to the squish land at the bore edge. Cut across, each chamber
    // shows as an arch in the paint, not as a slot over the bore. The solid is the
    // metal between the roof and the deck casting above it.
    CYL_X.forEach(x => {
      const Rc = BORE_R + 0.0006, D0 = DECK + 0.0012, TOP = DECK + 0.024, NR = 7, NA = 40;
      const end = u => { const t = Math.min(1, Math.max(0, (u - 0.0345) / (Rc - 0.0345))); return 1 - 0.92 * (1 - Math.cos(Math.PI * t / 2)) ** 0.8; };
      const roof = (lx, lz) => D0 + 0.0003 + (roofY(lz) - D0 - 0.0003) * end(Math.abs(lx));
      const T = new Tris(), Rf = new Tris(), B = [];
      const ring = r => Array.from({ length: NA }, (_, j) => { const a = (j / NA) * Math.PI * 2; return [r * Math.cos(a), r * Math.sin(a)]; });
      for (let i = 0; i <= NR; i++) B.push(ring(Rc * (i / NR) ** 0.8).map(([lx, lz]) => [x + lx, roof(lx, lz), lz]));
      for (let j = 0; j < NA; j++) {
        const k = (j + 1) % NA;
        for (let i = 0; i < NR; i++) Rf.quad(B[i][j], B[i + 1][j], B[i + 1][k], B[i][k], [0, -1, 0]);
        const a = B[NR][j], b = B[NR][k];
        T.quad(a, b, [b[0], TOP, b[2]], [a[0], TOP, a[2]], [a[0] + b[0] - 2 * x, 0, a[2] + b[2]]);
        T.tri([x, TOP, 0], [a[0], TOP, a[2]], [b[0], TOP, b[2]], [0, 1, 0]);
      }
      // the roof under a film of carbon, the rest of the solid bare alloy (one closed
      // solid in two draws: the stencil count sums over both)
      shells.add('chamber', Rf.build(30));
      shells.add('headCast', T.build(30));
    });
    // side walls carrying the ports
    const wall = (sz, y0, y1) => {
      const s = poly(fillet(rectPts(-HL, y0, HL, y1), 0.004, 2));
      CYL_X.forEach(x => {
        if (sz > 0) s.holes.push(pathOf(fillet(rectPts(x - 0.024, DECK + 0.034, x + 0.024, DECK + 0.066), 0.008, 3)));
        else s.holes.push(pathOf(circlePts(x, DECK + 0.045, 0.0175, 32)));
      });
      return xf(extrudeZ(s, 0.009, 0.0015), 0, 0, sz * (HW - 0.0045));
    };
    shells.add('cast', wall(1, DECK + 0.024, HEAD_TOP + 0.0002), wall(-1, DECK + 0.024, HEAD_TOP + 0.0002));
    // end walls, notched for the camshafts
    const endW = [[-HW, DECK + 0.024], [HW, DECK + 0.024], [HW, HEAD_TOP + 0.0002],
      ...circlePts(CAM_Z, HEAD_TOP, 0.0158, 12, 0, -Math.PI).map(([z, y]) => [z, y]),
      ...circlePts(-CAM_Z, HEAD_TOP, 0.0158, 12, 0, -Math.PI), [-HW, HEAD_TOP + 0.0002]];
    for (const sx of [1, -1]) shells.add('cast', xf(extrudeX(poly(endW), 0.009, 0.0015), sx * (HL - 0.0045), 0, 0));
    // The flywheel end of the head: a lifting eye bolted up at the exhaust corner,
    // two pressed core plugs with their chamfered rims, and a boss carrying the
    // cam position sensor behind the intake cam.
    {
      const eye = poly(fillet([[-0.017, DECK + 0.070], [0.017, DECK + 0.070], [0.017, HEAD_TOP + 0.030], ...circlePts(0, HEAD_TOP + 0.030, 0.017, 16, 0, Math.PI), [-0.017, HEAD_TOP + 0.030]], 0.004, 3));
      eye.holes.push(pathOf(circlePts(0, HEAD_TOP + 0.030, 0.0085, 24)));
      whole.add('darkSteel', xf(extrudeX(eye, 0.005, 0.0012), -HL - 0.0045, 0, -0.058));
      whole.add('bolt', xf(hexPrism(0.0065, 0.005, 0), -HL - 0.007, DECK + 0.082, -0.058, 0, 0, Math.PI / 2), xf(hexPrism(0.0065, 0.005, 0), -HL - 0.007, DECK + 0.104, -0.058, 0, 0, Math.PI / 2));
      for (const z of [0.030, -0.018]) {
        shells.add('steel', latheX([[0, -HL - 0.0012], [0.0105, -HL - 0.0012], [0.0118, -HL + 0.0004], [0.0118, -HL + 0.003], [0, -HL + 0.003]], 36).translate(0, DECK + 0.046, z));
        shells.add('cast', latheX([[0.0118, -HL - 0.0016], [0.0150, -HL - 0.0016], [0.0165, -HL + 0.001], [0.0118, -HL + 0.001]], 36).translate(0, DECK + 0.046, z));
      }
      shells.add('cast', latheX([[0, -HL - 0.010], [0.0165, -HL - 0.010], [0.0185, -HL - 0.006], [0.0185, -HL + 0.002], [0, -HL + 0.002]], 32).translate(0, CAM_Y - 0.004, CAM_Z));
      shells.add('plastic', latheX([[0, -HL - 0.026], [0.0110, -HL - 0.026], [0.0120, -HL - 0.022], [0.0120, -HL - 0.010], [0, -HL - 0.010]], 24).translate(0, CAM_Y - 0.004, CAM_Z));
      shells.add('plastic', xf(roundedBox(0.012, 0.018, 0.014, 0.003), -HL - 0.020, CAM_Y + 0.010, CAM_Z));
      bolt(boltsClip, -HL - 0.010, CAM_Y - 0.004 - 0.022, CAM_Z, [-1, 0, 0], 0.6);
    }
    // cam carrier with tilted tappet bores and spark-plug tubes
    const carrier = poly(fillet(rectPts(-HL + 0.004, -HW + 0.004, HL - 0.004, HW - 0.004), 0.004, 2), true);
    const yMid = DECK + 0.089, sMid = (yMid - SEAT_Y) / Math.cos(TILT);
    const zMid = SEAT_Z + sMid * Math.sin(TILT), dz = 0.011 * Math.tan(TILT);
    CYL_X.forEach(x => {
      for (const vx of [x - VALVE_DX, x + VALVE_DX]) for (const sz of [1, -1]) {
        const r = sz > 0 ? 0.0154 : 0.0149;
        const pts = circlePts(0, 0, r, 20).map(([a, b]) => [vx + a, sz * zMid + b]);
        // elongate across z so the tilted bucket clears the plate top to bottom
        carrier.holes.push(pathOf(pts.map(([a, b]) => [a, b + Math.sign(b - sz * zMid) * dz]), true));
      }
      carrier.holes.push(pathOf(circlePts(x, 0, 0.0152, 20), true));
    });
    shells.add('cast', extrudeY(carrier, DECK + 0.078, DECK + 0.100));
    // ten head bolts, outboard of the cam saddles at every main bulkhead, on bosses
    // cast into the carrier; they pull the head down onto the block
    for (const sz of [1, -1]) MAIN_X.forEach(x => {
      shells.add('cast', xf(disc(0.0115, 0.006, 20), x, DECK + 0.103, sz * 0.079));
      bolt(boltsClip, x, DECK + 0.106, sz * 0.079, [0, 1, 0], 1.5);
    });
    // saddles under each cam journal
    for (const sz of [1, -1]) {
      const cz = sz * CAM_Z;
      const sad = [[cz - 0.023, DECK + 0.098], [cz + 0.023, DECK + 0.098], [cz + 0.023, CAM_Y],
        ...circlePts(cz, CAM_Y, 0.0142, 16, 0, -Math.PI), [cz - 0.023, CAM_Y]];
      MAIN_X.forEach(x => shells.add('cast', xf(extrudeX(poly(fillet(sad, 0.002, 2)), 0.022, 0.0012), x, 0, 0)));
    }
    CYL_X.forEach(x => shells.add('cast', xf(annulus(0.0125, 0.0155, HEAD_TOP + 0.010 - (DECK + 0.020), 40, 0), x, DECK + 0.020, 0)));
    // Ports: two throats per side, from the valve seat up the valve axis, then
    // swept out to the flange. The walls are cast; the space inside an intake port
    // is a core (a cavity in the section count), and the head castings it runs
    // through are cored by the same shape, so a section through an intake valve
    // shows its port as a pocket sweeping down to the seat.
    let nv = 0;
    CYL_X.forEach(x => {
      for (const sz of [1, -1]) {
        const intake = sz > 0;
        const rO = intake ? 0.0150 : 0.0132, rI = intake ? 0.0122 : 0.0106;
        for (const sx of [-1, 1]) {
          const vx = x + sx * VALVE_DX;
          const ax = [0, Math.cos(TILT), sz * Math.sin(TILT)];
          const at = t => [vx, SEAT_Y + t * ax[1], sz * SEAT_Z + t * ax[2]];
          const yOut = intake ? DECK + 0.050 : DECK + 0.045;
          const ex = intake ? 1 : 0.55;
          const pts = [at(0.0015), at(0.020), [x + sx * 0.012 * ex, yOut - 0.004, sz * 0.058], [x + sx * 0.008 * ex, yOut, sz * (HW - 0.012)], [x + sx * 0.007 * ex, yOut, sz * (HW + 0.001)]];
          const crv = curve(pts);
          shells.add('cast', pipeSolid(crv, rO, rI, 16, 10));
          if (!intake) continue;
          // the core runs on past both ends, into the chamber and out into the air
          cores.push(rodSolid(curve([at(-0.006), ...pts.slice(0, 4), [x + sx * 0.007 * ex, yOut, sz * (HW + 0.012)]]), rI * 0.93, 12, 10));
          const u = [0, 0.18, 0.42, 0.68, 1];
          const P = u.map(t => crv.getPointAt(t));
          P[0] = V3(...at(-0.004));
          for (let k = 0; k < 4 && nv < NV; k++, nv++) {
            VOIDS.uRhVA.value[nv].set(P[k].x, P[k].y, P[k].z, rI * Math.cos(Math.PI / 10) - 0.0002);
            VOIDS.uRhVB.value[nv].set(P[k + 1].x, P[k + 1].y, P[k + 1].z, 0);
          }
        }
      }
    });
    // Cut on its centreline a real head is mostly metal: the fire deck over the
    // chambers, a water jacket threaded round the spark-plug tubes and split by a
    // web between cylinders, the oil deck the springs sit on, and a tower round
    // every spring and bucket. Without them the head read as an empty box with
    // valves hanging in it. Overlapping solids are fine for the capping: the count
    // only asks whether a point is inside any metal.
    // The jacket is modelled as what it is, a cavity in the casting: an inside-out
    // closed solid counts -1 in the stencil, so where it sits inside the head core
    // the cut shows a dark pocket with lit walls instead of paint. Each pocket
    // stays inside metal on the plane (clear of the plug wells), or it would count
    // -1 in the open and paint the air.
    const JK0 = DECK + 0.022, OD1 = DECK + 0.054;
    const core = poly(fillet(rectPts(-HL + 0.004, -0.064, HL - 0.004, 0.064), 0.004, 2), true);
    CYL_X.forEach(x => core.holes.push(pathOf(circlePts(x, 0, 0.0127, 24), true)));
    shells.add('headCast', extrudeY(core, JK0, OD1, 0.001));
    // Each pocket is a cored passage, not a milled slot: an outline that swells and
    // pinches like sand core (a lumpy ellipse, different for every one), so the
    // cut reveals casting-like shapes.
    CYL_X.forEach((x, i) => {
      for (const s of [-1, 1]) {
        const cx = x + s * 0.0290, cy = DECK + 0.0360, ph = 1.7 * i + (s > 0 ? 0.6 : 2.9), ps = 2.3 * i + (s > 0 ? 4.1 : 1.3);
        const pts = [];
        for (let k = 0; k < 40; k++) {
          const a = (k / 40) * Math.PI * 2;
          const w = 1 + 0.10 * Math.sin(2 * a + ph) + 0.055 * Math.sin(3 * a + ps) + 0.03 * Math.sin(5 * a + ph * 2);
          // a flatter floor toward the fire deck, fuller toward the ports
          const ry = 0.0098 * (Math.sin(a) < 0 ? 0.92 : 1.04);
          pts.push([cx + Math.cos(a) * 0.0114 * w, cy + Math.sin(a) * ry * w]);
        }
        shells.add('castCore', flip(extrudeZ(poly(pts), 0.100, 0.004)));
      }
    });
  }

  // ================================================================ valvetrain frames
  // Every valve, spring, retainer and bucket lives on its own tilted axis. The
  // frame is the valve face at rest; lift moves the valve down that axis.
  const valves = [];
  CYL_X.forEach((x, i) => {
    for (const kind of ['intake', 'exhaust']) {
      const sz = kind === 'intake' ? 1 : -1;
      for (const sx of [-1, 1]) {
        const q = new THREE.Quaternion().setFromAxisAngle(V3(1, 0, 0), sz * TILT);
        const p = V3(x + sx * VALVE_DX, SEAT_Y, sz * SEAT_Z);
        valves.push({ cyl: i, kind, p, q, axis: V3(0, 1, 0).applyQuaternion(q), x: p.x });
      }
    }
  });
  // guides and spring seats are part of the head
  for (const v of valves) {
    const m = new THREE.Matrix4().compose(v.p, v.q, V3(1, 1, 1));
    shells.add('liner', annulus(0.0029, 0.0060, 0.020, 12, 0.030).applyMatrix4(m));
    // hardened seat insert under the valve face
    const rh = v.kind === 'intake' ? 0.0165 : 0.0140;
    shells.add('darkSteel', annulus(rh - 0.0012, rh + 0.0026, 0.0045, 20, -0.0012).applyMatrix4(m));
    shells.add('cast', annulus(0.0060, 0.0138, 0.004, 20, S_SPRING - 0.004).applyMatrix4(m));
    // the guide boss rising from the port roof through the jacket to the oil deck
    shells.add('cast', annulus(0.0060, 0.0092, 0.022, 16, 0.024).applyMatrix4(m));
    // the tower round the spring and bucket, from the oil deck into the carrier;
    // wide enough that the bucket clears it at full lift
    const rIn = v.kind === 'intake' ? 0.0157 : 0.0152;
    shells.add('cast', annulus(rIn, rIn + 0.0038, 0.040, 32, 0.041).applyMatrix4(m));
  }

  // ================================================================ cam cover
  {
    const H0 = HEAD_TOP;
    const ribs = [0.073, 0.062, 0.051, 0.040];
    const outR = [[0.098, 0], [0.098, 0.006], [0.090, 0.006], [0.090, 0.034], [0.080, 0.044]];
    ribs.forEach(z => outR.push([z + 0.0016, 0.044], [z + 0.0012, 0.047], [z - 0.0012, 0.047], [z - 0.0016, 0.044]));
    outR.push([0.032, 0.044], [0.026, 0.056], [0.022, 0.060]);
    const outL = outR.map(([z, y]) => [-z, y]).reverse();
    const inner = [[-0.086, 0], [-0.086, 0.032], [-0.078, 0.040], [-0.030, 0.040], [-0.023, 0.052], [-0.020, 0.056],
      [0.020, 0.056], [0.023, 0.052], [0.030, 0.040], [0.078, 0.040], [0.086, 0.032], [0.086, 0]];
    const prof = [...outR, ...outL, ...inner].map(([z, y]) => [z, H0 + y]);
    const L = BLOCK_L + 0.002;
    // Painted outside, bare casting inside: cut open, the inside of the cover is
    // raw alloy that catches the light from the open side, so it reads as the
    // cavity over the cams. (Painted dark inside too, it was a band of black void
    // between the camshaft and the cut outline.) One closed solid in two draws;
    // the stencil count sums over both.
    const inside = (c, n) => c.y > H0 + 0.002 && Math.abs(c.z) < 0.0868 && (n.y < -0.3 || (Math.abs(n.z) > 0.5 && n.z * c.z < 0 && Math.abs(c.z) > 0.084));
    const [cOut, cIn] = splitTris(extrudeX(poly(prof), L, 0.001), inside);
    shells.add('cover', cOut); shells.add('coverIn', cIn);
    const endPlate = poly([...outR, ...outL].map(([z, y]) => [z, H0 + y]));
    // the end plates stand 3 mm proud of the head at each end, edges rounded, so
    // the cover reads as a separate moulding sitting on the head
    for (const sx of [1, -1]) {
      const [pOut, pIn] = splitTris(xf(roundExtrudeX(endPlate, 0.007, 0.0022, 2), sx * (L / 2 + 0.0005), 0, 0), (c, n) => n.x * sx < -0.5);
      shells.add('cover', pOut); shells.add('coverIn', pIn);
    }
    // the fins' crests are machined through the paint to bright metal, rounded, so
    // each catches the light as one clean line along the cover
    for (const sz of [1, -1]) ribs.forEach(z => shells.add('lobe', rodSolid(curve([[-(L / 2 - 0.010), H0 + 0.0463, sz * z], [L / 2 - 0.010, H0 + 0.0463, sz * z]]), 0.00125, 2, 10)));
    for (const x of [-0.18, -0.108, -0.036, 0.036, 0.108, 0.18]) for (const sz of [1, -1]) bolt(boltsClip, x, H0 + 0.006, sz * 0.094, [0, 1, 0], 0.8);
    for (const sx of [1, -1]) bolt(boltsClip, sx * (HL - 0.010), H0 + 0.060, -0.012, [0, 1, 0], 0.8);
    // Oil filler: a boss moulded into the cover and a round black cap on it, 12 mm
    // tall with a ribbed grip and a bar across its crown. It comes off with the
    // accessories rather than being sawn through.
    const FX = HL - 0.060, FZ = 0.058, FY = H0 + 0.044;
    // (an open neck: a moulded collar round a dark hole, so with the cap off it
    // reads as a way into the cover, not as a disc laid on it)
    shells.add('cover', lathe([[0.0165, -0.002], [0.027, -0.002], [0.027, 0.002], [0.024, 0.006], [0.0165, 0.006]], 40, { crease: 40 }).translate(FX, FY, FZ));
    shells.add('coverIn', lathe([[0.0148, -0.004], [0.0168, -0.004], [0.0168, 0.0058], [0.0148, 0.0058]], 32).translate(FX, FY, FZ));
    shells.add('rubber', lathe([[0, -0.0015], [0.0149, -0.0015], [0.0149, 0.0004], [0, 0.0004]], 32).translate(FX, FY, FZ));
    A('filler', 'plastic', lathe([[0, 0.006], [0.0205, 0.006], [0.0215, 0.008], [0.0215, 0.0155], [0.0195, 0.018], [0.012, 0.0188], [0, 0.0190]], 48, { crease: 40 }).translate(FX, FY, FZ));
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2;
      A('filler', 'plastic', xf(roundedBox(0.0026, 0.0078, 0.0030, 0.0009), FX + Math.cos(a) * 0.0218, FY + 0.0118, FZ + Math.sin(a) * 0.0218, 0, -a, 0));
    }
    A('filler', 'plastic', xf(roundedBox(0.030, 0.0055, 0.0060, 0.0022), FX, FY + 0.0205, FZ));
    shells.add('cast', rodSolid(curve([[-HL + 0.05, H0 + 0.045, -0.058], [-HL + 0.05, H0 + 0.062, -0.060], [-HL + 0.03, H0 + 0.070, -0.060]]), 0.005, 16, 12));
    // The Realm plate, on the spine between cylinders 2 and 3, set to the exhaust
    // side of the centreline so the cut leaves it whole: a cast plate with a dark,
    // patinated field, and a polished copper rim, ring-and-cross and name standing
    // up out of it, the way a cast name plate is finished. (A flat copper plate
    // with the turning rings of a lathe on it read as wood grain.)
    {
      const BZ = -0.0094, BY = H0 + 0.0600, T = 0.0021;
      shells.add('badge', xf(roundedBox(0.058, 0.0026, 0.0172, 0.0008), 0, BY + 0.0004, BZ));
      for (const s of [-1, 1]) {
        shells.add('copper', xf(roundedBox(0.0574, 0.0014, 0.0013, 0.0005), 0, BY + T, BZ + s * 0.0079));
        shells.add('copper', xf(roundedBox(0.0013, 0.0014, 0.0171, 0.0005), s * 0.0281, BY + T, BZ));
      }
      shells.add('copper', xf(new THREE.TorusGeometry(0.0047, 0.00068, 6, 32), -0.0185, BY + T, BZ, Math.PI / 2, 0, 0));
      shells.add('copper', xf(roundedBox(0.0120, 0.0012, 0.0011, 0.0004), -0.0185, BY + T, BZ), xf(roundedBox(0.0011, 0.0012, 0.0120, 0.0004), -0.0185, BY + T, BZ));
      // R E A L M in block letters, 6.4 mm tall: strokes as (x0, z0, x1, z1) in a
      // 1 x 1 cell, read from the exhaust side
      const STROKE = {
        R: [[0, 0, 0, 1], [0, 1, 0.8, 1], [0.8, 1, 0.8, 0.5], [0, 0.5, 0.8, 0.5], [0.3, 0.5, 0.9, 0]],
        E: [[0, 0, 0, 1], [0, 1, 0.85, 1], [0, 0.5, 0.7, 0.5], [0, 0, 0.85, 0]],
        A: [[0, 0, 0, 1], [0.85, 0, 0.85, 1], [0, 1, 0.85, 1], [0, 0.5, 0.85, 0.5]],
        L: [[0, 0, 0, 1], [0, 0, 0.8, 0]],
        M: [[0, 0, 0, 1], [1, 0, 1, 1], [0, 1, 0.5, 0.45], [0.5, 0.45, 1, 1]],
      };
      const GH = 0.0064, GW = 0.0044, gw = 0.0009;
      [...'REALM'].forEach((ch, k) => {
        const x0 = -0.0100 + k * 0.0072, z0 = BZ - GH / 2;
        for (const [a, b, c, d] of STROKE[ch]) {
          // seen from the intake side, where the page's cameras stand, the name runs
          // left to right along +x with the tops of the letters away from the lens (-z)
          const ax = x0 + a * GW, az = z0 + (1 - b) * GH, bx = x0 + c * GW, bz = z0 + (1 - d) * GH;
          const len = Math.hypot(bx - ax, bz - az) + gw, ang = Math.atan2(bz - az, bx - ax);
          shells.add('copper', xf(new THREE.BoxGeometry(len, 0.0010, gw), (ax + bx) / 2, BY + T - 0.0001, (az + bz) / 2, 0, -ang, 0));
        }
      });
      for (const s of [-1, 1]) shells.add('copper', xf(lathe([[0, 0], [0.0011, 0], [0.0010, 0.0005], [0.0005, 0.0009], [0, 0.0010]], 12), s * 0.0247, BY + 0.0017, BZ));
    }
  }

  // ================================================================ intake (+Z)
  {
    // A cast manifold: a flat four-port flange held on studs and nuts, runners
    // that narrow from the plenum down to the port and bend up through about a
    // right angle, and a boxy plenum with ribs, a bolted end cover and the
    // throttle body on its front end.
    const PY = DECK + 0.142, PZ = 0.180, PX0 = -0.198, PX1 = 0.150;
    const PW = 0.072, PH = 0.070;                    // plenum section, z by y
    const latheZ = (prof, segs = 24) => xf(lathe(prof, segs), 0, 0, 0, Math.PI / 2, 0, 0);
    const fl = poly(fillet(rectPts(-HL + 0.010, DECK + 0.024, HL - 0.010, DECK + 0.076), 0.008, 3));
    CYL_X.forEach(x => fl.holes.push(pathOf(fillet(rectPts(x - 0.024, DECK + 0.034, x + 0.024, DECK + 0.066), 0.008, 3))));
    A('intake', 'castIn', xf(extrudeZ(fl, 0.012, 0.0015), 0, 0, HW + 0.006));
    // studs, washers and nuts along both edges of the flange
    [-HL + 0.020, (CYL_X[0] + CYL_X[1]) / 2, 0, (CYL_X[2] + CYL_X[3]) / 2, HL - 0.020].forEach(x => [-1, 1].forEach(s => {
      const y = DECK + 0.050 + s * 0.0195, z0 = HW + 0.012;
      A('intake', 'steel', latheZ([[0, 0], [0.0068, 0], [0.0068, 0.0012], [0, 0.0012]]).translate(x, y, z0));
      A('intake', 'bolt', xf(hexPrism(0.0060, 0.0055, 0.0012), x, y, z0, Math.PI / 2, 0, 0));
      A('intake', 'steel', latheZ([[0, 0.0067], [0.0036, 0.0067], [0.0036, 0.0105], [0.0028, 0.0112], [0, 0.0112]], 12).translate(x, y, z0));
    }));
    // runners: tapered, from the flange out and up into the plenum floor, each
    // with a cast boss at the flange and a flared collar where it meets the plenum
    CYL_X.forEach(x => {
      const pts = [[x, DECK + 0.050, HW + 0.006], [x, DECK + 0.051, 0.124], [x, DECK + 0.064, 0.155], [x, DECK + 0.090, 0.172],
        [x, PY - PH / 2 + 0.004, PZ], [x, PY - 0.010, PZ]];
      A('intake', 'castIn', taperTube(curve(pts), u => 0.0186 + 0.0042 * u, 40, 20));
      A('intake', 'castIn', xf(roundedBox(0.048, 0.046, 0.014, 0.006), x, DECK + 0.050, HW + 0.018));
      A('intake', 'castIn', lathe([[0.0226, -0.010], [0.0240, -0.010], [0.0305, -0.0015], [0.0315, 0.0006], [0.0226, 0.0006]], 32, { crease: 50 }).translate(x, PY - PH / 2, PZ));
    });
    // plenum: a sand casting that swells toward the throttle end (it narrows and
    // drops by about a sixth toward the closed end, as a plenum fed from one end
    // is cast), its floor level where the runners join it, a parting-line bead
    // along both flanks and cast bosses on the top: lofted, not a ribbed box.
    const secAt = x => {
      const u = (x - PX0) / (PX1 - PX0), k = 0.86 + 0.14 * u * u * (3 - 2 * u);
      const f = (1 - k) / 0.14, w = PW * (1 - 0.13 * f), top = PY + PH / 2 - 0.011 * f, bot = PY - PH / 2;
      return { w, top, bot, pts: fillet(rectPts(PZ - w / 2, bot, PZ + w / 2, top), 0.019, 5) };
    };
    {
      const T = new Tris(), S = 18, rings = [];
      for (let i = 0; i <= S; i++) { const x = PX0 + (PX1 - PX0) * (i / S); rings.push(secAt(x).pts.map(([z, y]) => [x, y, z])); }
      const n = rings[0].length;
      for (let i = 0; i < S; i++) for (let j = 0; j < n; j++) {
        const a = rings[i][j], b = rings[i][(j + 1) % n], c = rings[i + 1][(j + 1) % n], d = rings[i + 1][j];
        T.quad(a, b, c, d, [0, a[1] + b[1] - 2 * PY, a[2] + b[2] - 2 * PZ]);
      }
      A('intake', 'castIn', T.build(50));
      // the closed end and the throttle end, where the throttle bore looks in
      const s1 = secAt(PX1);
      A('intake', 'castIn', xf(extrudeX(poly(s1.pts), 0.004, 0.0008), PX1 - 0.002, 0, 0));
      // The plenum is cast in two halves and bolted along a parting flange at mid
      // height on both flanks: a flat lip 3 mm proud, with a bolt boss every
      // 70 mm. Stiffening ribs run up the outboard flank between the runners.
      // (Two halves joined by a scribed line read as a plain tube.)
      for (const sz of [1, -1]) {
        const Fl = new Tris(), SS = 14, R = [];
        for (let i = 0; i <= SS; i++) {
          const x = PX0 + 0.002 + (PX1 - PX0 - 0.004) * (i / SS), s = secAt(x), ym = (s.top + s.bot) / 2 - 0.004;
          const zi = PZ + sz * (s.w / 2 - 0.002), zo = PZ + sz * (s.w / 2 + 0.0030);
          R.push([[x, ym - 0.0024, zi], [x, ym - 0.0024, zo], [x, ym + 0.0024, zo], [x, ym + 0.0024, zi]]);
        }
        for (let i = 0; i < SS; i++) for (let k = 0; k < 4; k++) {
          const a = R[i][k], b = R[i][(k + 1) % 4], c = R[i + 1][(k + 1) % 4], d = R[i + 1][k];
          Fl.quad(a, b, c, d, [0, [-1, 0, 1, 0][k], [0, sz, 0, -sz][k]]);
        }
        for (const [ring, ox] of [[R[0], -1], [R[SS], 1]]) Fl.quad(ring[0], ring[1], ring[2], ring[3], [ox, 0, 0]);
        A('intake', 'castIn', Fl.build(30));
        for (let x = PX0 + 0.030; x < PX1 - 0.010; x += 0.070) {
          const s = secAt(x), ym = (s.top + s.bot) / 2 - 0.004, zb = PZ + sz * (s.w / 2 + 0.0032);
          A('intake', 'castIn', lathe([[0, -0.009], [0.0052, -0.009], [0.0056, -0.006], [0.0056, 0.006], [0.0052, 0.009], [0, 0.009]], 16, { crease: 40 }).translate(x, ym, zb));
          accBolt('intake', x, ym + 0.009, zb, [0, 1, 0], 0.5);
        }
        if (sz > 0) for (const x of [-0.0965, 0, 0.0965]) {
          const s = secAt(x), ym = (s.top + s.bot) / 2;
          A('intake', 'castIn', xf(roundedBox(0.0055, (s.top - ym) - 0.010, 0.006, 0.0022), x, (s.top + ym) / 2 - 0.002, PZ + s.w / 2 - 0.0008));
        }
      }
    }
    // bolted end cover, machined face, six screws
    const sE = secAt(PX0), secE = (g = 0) => poly(fillet(rectPts(PZ - sE.w / 2 - g, sE.bot - g, PZ + sE.w / 2 + g, sE.top + g), 0.019 + g, 5));
    A('intake', 'machined', xf(extrudeX(secE(0.004), 0.006, 0.0012), PX0 - 0.003, 0, 0));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6, cy = (sE.top + sE.bot) / 2, hh = (sE.top - sE.bot) / 2;
      accBolt('intake', PX0 - 0.006, cy + Math.sin(a) * (hh - 0.006), PZ + Math.cos(a) * (sE.w / 2 - 0.006), [-1, 0, 0], 0.7);
    }
    // two cast bosses on the top, between the runners, each carrying a stay of flat
    // bar that runs down over the inboard shoulder of the plenum to the side of the
    // head and steadies the plenum on its runners
    for (const x of [-0.0965, 0.0]) {
      const t = secAt(x).top;
      A('intake', 'castIn', xf(lathe([[0, -0.006], [0.0095, -0.006], [0.0095, 0.002], [0.0080, 0.0035], [0, 0.0035]], 24, { crease: 50 }), x, t, PZ - 0.016));
      A('intake', 'darkSteel', xf(extrudeX(poly(fillet([[PZ - 0.004, t + 0.0035], [PZ - 0.004, t + 0.0065], [PZ - 0.031, t + 0.0065], [HW + 0.003, HEAD_TOP - 0.009], [HW + 0.003, HEAD_TOP - 0.028], [HW, HEAD_TOP - 0.028], [HW, HEAD_TOP - 0.010], [PZ - 0.032, t + 0.0035]], 0.0012, 2)), 0.014, 0.0005), x, 0, 0));
      accBolt('intake', x, t + 0.0065, PZ - 0.016, [0, 1, 0], 0.75);
      accBolt('intake', x, HEAD_TOP - 0.019, HW + 0.003, [0, 0, 1], 0.7);
    }
    // a pressure sensor on a boss on top, and the crankcase breather spigot
    const tS = secAt(-0.060).top - PH / 2 - PY, tB = secAt(0.080).top - PH / 2 - PY;
    A('intake', 'castIn', xf(roundedBox(0.030, 0.010, 0.026, 0.003), -0.060, PY + PH / 2 + tS + 0.002, PZ));
    A('intake', 'plastic', xf(roundedBox(0.024, 0.014, 0.020, 0.004), -0.060, PY + PH / 2 + tS + 0.012, PZ));
    A('intake', 'plastic', xf(roundedBox(0.010, 0.010, 0.014, 0.002), -0.074, PY + PH / 2 + tS + 0.014, PZ));
    A('intake', 'castIn', lathe([[0, 0], [0.009, 0], [0.009, 0.004], [0.0055, 0.006], [0.0055, 0.020], [0.0065, 0.022], [0.0065, 0.025], [0, 0.025]], 20).translate(0.080, PY + PH / 2 + tB - 0.002, PZ));
    // Throttle body: a squared casting round a machined bore on a round flange,
    // the butterfly cracked 12 degrees on its spindle and screwed to it, a cable
    // quadrant with its return spring and idle stop on the outboard end of the
    // spindle, the position sensor on the inboard end, and an open bellmouth
    // where the duct to the air box came off.
    const tb0 = PX1, tb1 = PX1 + 0.050, tbm = (tb0 + tb1) / 2;
    const atTB = (prof, segs = 48) => latheX(prof, segs).translate(0, PY, PZ);
    A('intake', 'castIn', atTB([[0.0315, tb0 - 0.004], [0.046, tb0 - 0.004], [0.046, tb0 + 0.008], [0.0315, tb0 + 0.008]]));
    const tbS = poly(fillet(rectPts(-0.040, -0.044, 0.040, 0.041), 0.013, 4));
    tbS.holes.push(pathOf(circlePts(0, 0, 0.0318, 40)));
    A('intake', 'castIn', xf(extrudeX(tbS, tb1 - tb0 - 0.012, 0.0025), tbm + 0.004, PY, PZ));
    // the bore, machined bright, and a rolled bellmouth lip
    A('intake', 'bore', atTB([[0.0300, tb0 - 0.003], [0.0317, tb0 - 0.003], [0.0317, tb1 + 0.012], [0.0300, tb1 + 0.012]], 56));
    A('intake', 'castIn', atTB([[0.0305, tb1 - 0.004], [0.0368, tb1 - 0.004], [0.0368, tb1 + 0.010], [0.0392, tb1 + 0.016], [0.0395, tb1 + 0.020], [0.0372, tb1 + 0.022], [0.0340, tb1 + 0.019], [0.0305, tb1 + 0.012]], 56));
    [0, 1, 2, 3].forEach(k => { const a = Math.PI / 4 + (k * Math.PI) / 2; accBolt('intake', tb0 + 0.008, PY + Math.cos(a) * 0.040, PZ + Math.sin(a) * 0.040, [1, 0, 0], 0.7); });
    // butterfly on its spindle, two screws through the plate
    const bf = 12 * DEG;
    A('intake', 'brass', xf(lathe([[0, -0.0009], [0.0296, -0.0009], [0.0300, 0], [0.0296, 0.0009], [0, 0.0009]], 48), tbm, PY, PZ, 0, 0, Math.PI / 2 - bf));
    A('intake', 'steel', xf(disc(0.0034, 0.094, 14), tbm, PY, PZ, Math.PI / 2, 0, 0));
    for (const s of [-1, 1]) A('intake', 'bolt', xf(disc(0.0028, 0.0022, 10), tbm - Math.sin(bf) * 0.0012, PY + Math.cos(bf) * 0.0012, PZ + s * 0.012, 0, 0, -bf));
    // outboard: spring cup and return spring, quadrant with its cable groove, the
    // stop lever and the idle stop screw in its boss
    const QZ = PZ + 0.046;
    A('intake', 'castIn', xf(lathe([[0.004, -0.006], [0.013, -0.006], [0.013, 0.002], [0.004, 0.002]], 32), tbm, PY, PZ + 0.041, Math.PI / 2, 0, 0));
    // a torsion return spring round the spindle, its tang hooked over a post on
    // the body
    const helix = [];
    for (let k = 0; k <= 72; k++) { const a = k / 72 * Math.PI * 2 * 3.5; helix.push(V3(tbm + Math.cos(a) * 0.0108, PY + Math.sin(a) * 0.0108, PZ + 0.0385 + k / 72 * 0.0060)); }
    helix.push(V3(tbm + 0.0108 + 0.004, PY - 0.004, PZ + 0.0450), V3(tbm + 0.017, PY - 0.012, PZ + 0.0460));
    A('intake', 'darkSteel', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helix), 90, 0.00125, 6, false));
    A('intake', 'steel', xf(disc(0.0022, 0.008, 10), tbm + 0.017, PY - 0.013, PZ + 0.041, Math.PI / 2, 0, 0));
    // the quadrant: a hub, a web with a lightening hole, and a deep-grooved arc the
    // cable wraps, with the cable's nipple seated in a slot at its end
    const A0 = -0.35, A1 = 1.95, QR = 0.031;
    const web = poly(fillet([[0, 0], ...circlePts(0, 0, QR - 0.004, 18, A0, A1)], 0.003, 3));
    web.holes.push(pathOf(circlePts(0, 0, 0.0036, 12)), pathOf(fillet([...circlePts(0, 0, 0.022, 10, A0 + 0.45, A1 - 0.45), ...circlePts(0, 0, 0.012, 6, A1 - 0.45, A0 + 0.45)], 0.002, 2)));
    A('intake', 'darkSteel', xf(extrudeZ(web, 0.0025, 0.0005), tbm, PY, QZ));
    A('intake', 'darkSteel', xf(lathe([[0.0036, -0.004], [0.0085, -0.004], [0.0085, 0.003], [0.0036, 0.003]], 24), tbm, PY, QZ, Math.PI / 2, 0, 0));
    for (const dz of [-0.0026, 0.0026]) A('intake', 'darkSteel', xf(lathe([[QR - 0.0065, -0.0008], [QR, -0.0008], [QR, 0.0008], [QR - 0.0065, 0.0008]], 36, { phiStart: Math.PI / 2 - A1, phiLength: A1 - A0 }), tbm, PY, QZ + dz, Math.PI / 2, 0, 0));
    A('intake', 'darkSteel', xf(lathe([[QR - 0.0065, -0.0019], [QR - 0.0032, -0.0019], [QR - 0.0032, 0.0019], [QR - 0.0065, 0.0019]], 36, { phiStart: Math.PI / 2 - A1, phiLength: A1 - A0 }), tbm, PY, QZ, Math.PI / 2, 0, 0));
    A('intake', 'steel', xf(disc(0.0026, 0.0050, 12), tbm + Math.cos(A1) * (QR - 0.0038), PY + Math.sin(A1) * (QR - 0.0038), QZ, Math.PI / 2, 0, 0));
    // the inner cable leaves the groove at A0 on its tangent to an adjuster in a
    // bracket under the body; the outer cable runs on from it and is cut short
    {
      const P = V3(tbm + Math.cos(A0) * (QR - 0.0035), PY + Math.sin(A0) * (QR - 0.0035), QZ);
      const T = V3(Math.sin(A0), -Math.cos(A0), 0);
      const B = P.clone().addScaledVector(T, 0.034);
      A('intake', 'steel', rodSolid(curve([P.toArray(), B.toArray()]), 0.0007, 2, 6));
      const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), T);
      A('intake', 'steel', lathe([[0, 0], [0.0026, 0], [0.0026, 0.016], [0, 0.016]], 12).applyQuaternion(q).translate(B.x, B.y, B.z));
      for (const s of [0.004, 0.011]) { const n = B.clone().addScaledVector(T, s); A('intake', 'bolt', hexPrism(0.0042, 0.0028).applyQuaternion(q).translate(n.x, n.y, n.z)); }
      const Bk = B.clone().addScaledVector(T, 0.0075);
      A('intake', 'darkSteel', roundedBox(0.020, 0.0022, 0.016, 0.0006).applyQuaternion(q).translate(Bk.x, Bk.y, Bk.z - 0.004));
      const C0 = B.clone().addScaledVector(T, 0.016), C1 = C0.clone().addScaledVector(T, 0.030), C2 = C1.clone().add(V3(-0.030, -0.010, 0.002));
      A('intake', 'rubber', rodSolid(curve([C0.toArray(), C1.toArray(), C2.toArray()]), 0.0030, 16, 8));
    }
    A('intake', 'steel', xf(roundedBox(0.026, 0.006, 0.0032, 0.0012), tbm + 0.010, PY - 0.010, QZ + 0.0035, 0, 0, -0.7));
    A('intake', 'castIn', xf(roundedBox(0.010, 0.010, 0.012, 0.0025), tbm + 0.026, PY - 0.036, PZ + 0.043));
    A('intake', 'bolt', xf(disc(0.0022, 0.016, 10), tbm + 0.026, PY - 0.029, PZ + 0.045));
    A('intake', 'bolt', xf(hexPrism(0.0042, 0.003), tbm + 0.026, PY - 0.022, PZ + 0.045));
    A('intake', 'bolt', xf(hexPrism(0.0058, 0.004), tbm, PY, QZ + 0.0036, Math.PI / 2, 0, 0));
    // inboard: the throttle position sensor, two screws and its plug
    A('intake', 'plastic', xf(roundedBox(0.034, 0.040, 0.012, 0.004), tbm, PY + 0.002, PZ - 0.046));
    A('intake', 'plastic', xf(roundedBox(0.018, 0.014, 0.016, 0.003), tbm + 0.004, PY + 0.026, PZ - 0.046));
    [-1, 1].forEach(s => accBolt('intake', tbm + s * 0.013, PY - 0.012, PZ - 0.0525, [0, 0, -1], 0.5));
    // fuel rail and four injectors, aimed down each runner at the port
    A('intake', 'steel', rodSolid(curve([[-0.205, DECK + 0.084, 0.126], [0.205, DECK + 0.084, 0.126]]), 0.0075, 8, 14));
    for (const sx of [1, -1]) A('intake', 'steel', xf(roundedBox(0.012, 0.016, 0.018, 0.003), sx * 0.212, DECK + 0.084, 0.126));
    CYL_X.forEach(x => {
      const inj = curve([[x + 0.024, DECK + 0.084, 0.126], [x + 0.024, DECK + 0.062, 0.121], [x + 0.022, DECK + 0.048, 0.116]]);
      A('intake', 'plastic', rodSolid(inj, 0.0062, 8, 12));
      A('intake', 'steel', xf(annulus(0.0062, 0.0072, 0.004, 16, -0.002), x + 0.024, DECK + 0.070, 0.124));
    });
  }

  // ================================================================ exhaust (-Z)
  {
    // The heat tint and the glow are both functions of the distance from the port,
    // so each primary carries that distance in uv.x and the shader does the rest
    // (materials.js, rhHeat): straw, gold, bronze, the blue band, then grey.
    const ex = [];
    // (the primaries and secondaries are open tubes: both ends are buried in the
    // flange or a collector, and a part that is never cut need not be closed; the
    // downpipe, whose end is seen, keeps its wall)
    const tinted = (crv, rO, rI, glowLen = 0.12, s0 = 0, rs = 16, ts = 24, seed = 0.5, open = true) => {
      const g = open ? new THREE.TubeGeometry(crv, ts, rO, rs, false) : pipeSolid(crv, rO, rI, ts, rs);
      const samp = crv.getSpacedPoints(120), len = crv.getLength();
      const p = g.attributes.position, uv = new Float32Array(p.count * 2), v = V3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        let best = 1e9, bi = 0;
        for (let k = 0; k < samp.length; k++) { const d = samp[k].distanceToSquared(v); if (d < best) { best = d; bi = k; } }
        uv[i * 2] = s0 + (bi / (samp.length - 1)) * len;
        uv[i * 2 + 1] = seed;
      }
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      return g;
    };
    const plain = g => { g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2).fill(0.3), 2)); return g; };
    // header flange plate
    const fp = poly(fillet(rectPts(-HL + 0.012, DECK + 0.020, HL - 0.012, DECK + 0.070), 0.006, 3));
    CYL_X.forEach(x => fp.holes.push(pathOf(circlePts(x, DECK + 0.045, 0.0172, 32))));
    ex.push(plain(xf(extrudeZ(fp, 0.010, 0.0015), 0, 0, -HW - 0.005)));
    CYL_X.forEach(x => [-1, 1].forEach(s => bolt(boltsClip, x + s * 0.030, DECK + 0.045 + s * 0.012, -HW - 0.010, [0, 0, -1], 1)));
    // 4-2-1: cylinders 1 and 4 pair up, 2 and 3 pair up, then one collector
    const Y0 = DECK + 0.045, Z0 = -HW + 0.004;
    const merges = { 0: [0.020, 0.080, -0.175], 3: [0.020, 0.080, -0.175], 1: [-0.050, 0.095, -0.160], 2: [-0.050, 0.095, -0.160] };
    CYL_X.forEach((x, i) => {
      const m = merges[i];
      const pts = [[x, Y0, Z0], [x, Y0, -0.122], [x * 0.92, Y0 - 0.030, -0.150], [x * 0.55 + m[0] * 0.45, 0.180, -0.168], [m[0] + Math.sign(x - m[0]) * 0.010, m[1] + 0.022, m[2]], [m[0], m[1], m[2]]];
      ex.push(tinted(curve(pts), 0.0190, 0.0172, 0.12, 0, 16, 24, [0.15, 0.85, 0.45, 0.62][i]));
    });
    ex.push(tinted(curve([[0.020, 0.090, -0.175], [0.010, 0.040, -0.176], [-0.030, 0.000, -0.172], [-0.045, -0.020, -0.168]]), 0.0235, 0.0215, 0.12, 0.25));
    ex.push(tinted(curve([[-0.050, 0.105, -0.160], [-0.052, 0.050, -0.163], [-0.050, 0.000, -0.166], [-0.047, -0.025, -0.168]]), 0.0235, 0.0215, 0.12, 0.25));
    // the downpipe turns back along the sump and stops above its floor, so the
    // engine can stand on its sump
    ex.push(tinted(curve([[-0.046, 0.010, -0.168], [-0.047, -0.040, -0.168], [-0.062, -0.108, -0.162], [-0.112, -0.140, -0.152], [-0.190, -0.150, -0.146]]), 0.0300, 0.0280, 0.12, 0.35, 28, 28, 0.5, false));
    whole.add('exhaust', ...ex);
    // heat shield bracket stays dull; no shield, so the header shows
  }

  // ================================================================ timing drive (front)
  const tPulleys = {
    crank: { c: [0, 0], r: R_CRANK_SPR },
    inCam: { c: [CAM_Z, CAM_Y], r: R_CAM_SPR },
    exCam: { c: [-CAM_Z, CAM_Y], r: R_CAM_SPR },
    tens: { c: [-0.080, DECK + 0.004], r: 0.030 },
    pump: { c: [-0.072, 0.100], r: 0.030 },
  };
  const tList = [tPulleys.crank, tPulleys.inCam, tPulleys.exCam, tPulleys.tens, tPulleys.pump];
  const tLoop = beltLoop(tList);
  const beltT = mesh(root, beltSolid(tLoop, 0.0022, 0.0030, XT, 0.025), M.belt, 'timing_belt');
  {
    // idler and water-pump pulleys (static hubs; smooth faces, so their turning is not shown)
    for (const P of [tPulleys.tens, tPulleys.pump]) {
      whole.add('steel', latheX([[0, -0.0145], [P.r - 0.0022, -0.0145], [P.r - 0.0022, -0.0135], [P.r - 0.004, -0.0125], [P.r - 0.004, 0.0125], [P.r - 0.0022, 0.0135], [P.r - 0.0022, 0.0145], [0, 0.0145]], 56).translate(XT, P.c[1], P.c[0]));
      whole.add('darkSteel', discX(0.012, XT + 0.0145, XT + 0.022, 32).translate(0, P.c[1], P.c[0]));
    }
    whole.add('darkSteel', xf(roundedBox(0.010, 0.060, 0.020, 0.003), HL + 0.004, tPulleys.tens.c[1] - 0.030, tPulleys.tens.c[0] + 0.012));
    // cover: black plastic, a closed shell round the drive, cut with the castings
    const O1 = beltLoop(tList.map(p => ({ c: p.c, r: p.r + 0.012 })), 0.009, 1).pts;
    const O2 = beltLoop(tList.map(p => ({ c: p.c, r: p.r + 0.009 })), 0.009, 1).pts;
    const rim = poly(O1); rim.holes.push(pathOf(O2));
    shells.add('plastic', xf(extrudeX(rim, XT + 0.021 - HL + 0.0003, 0.001), (HL - 0.0003 + XT + 0.021) / 2, 0, 0));
    const face = poly(O1); face.holes.push(pathOf(circlePts(0, 0, 0.024, 32)));
    shells.add('plastic', xf(extrudeX(face, 0.003, 0.001), XT + 0.0195, 0, 0));
    // moulded bead round the face and a boss round the crank nose
    const B1 = beltLoop(tList.map(p => ({ c: p.c, r: p.r + 0.0095 })), 0.009, 1).pts, B2 = beltLoop(tList.map(p => ({ c: p.c, r: p.r + 0.006 })), 0.009, 1).pts;
    const bead = poly(B1); bead.holes.push(pathOf(B2));
    shells.add('plastic', xf(extrudeX(bead, 0.0025, 0.0008), XT + 0.0222, 0, 0));
    // a raised moulded panel inside the bead, stiffened by straight ribs across it
    // (a moulder's ribs run straight, wall to wall, between the bosses), a seal
    // boss round each cam nose, and a bolt boss under every screw round the rim
    const P1 = beltLoop(tList.map(p => ({ c: p.c, r: Math.max(0.012, p.r - 0.004) })), 0.009, 1).pts;
    const panel = poly(P1); panel.holes.push(pathOf(circlePts(0, 0, 0.036, 32)));
    shells.add('plastic', xf(extrudeX(panel, 0.0024, 0.0009), XT + 0.0215, 0, 0));
    for (const cz of [CAM_Z, -CAM_Z]) shells.add('plastic', xf(new THREE.TorusGeometry(0.020, 0.0022, 6, 28), XT + 0.0228, CAM_Y, cz, 0, Math.PI / 2, 0));
    {
      // where a line crosses the panel outline, less a margin at each wall
      const cross = (p, d) => {
        const hits = [];
        for (let i = 0; i < P1.length; i++) {
          const a = P1[i], b = P1[(i + 1) % P1.length], e = [b[0] - a[0], b[1] - a[1]];
          const den = d[0] * e[1] - d[1] * e[0];
          if (Math.abs(den) < 1e-12) continue;
          const t = ((a[0] - p[0]) * e[1] - (a[1] - p[1]) * e[0]) / den, u = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den;
          if (u >= 0 && u <= 1) hits.push(t);
        }
        hits.sort((m, n) => m - n);
        return [hits[0], hits[hits.length - 1]];
      };
      const rib = (p, ang, t0 = null, t1 = null, shrink = 0.007) => {
        const d = [Math.cos(ang), Math.sin(ang)];
        let [a, b] = cross(p, d);
        if (t0 !== null) a = t0; if (t1 !== null) b = t1;
        a += shrink; b -= shrink;
        const L = b - a, m = (a + b) / 2;
        shells.add('plastic', xf(roundedBox(0.0042, L, 0.0034, 0.0014), XT + 0.0243, p[1] + d[1] * m, p[0] + d[0] * m, Math.PI / 2 - ang, 0, 0));
      };
      // three horizontal ribs between the cam bosses and the crank, and a spine
      rib([0, CAM_Y - 0.052], 0);
      rib([0, CAM_Y - 0.125], 0);
      rib([0, 0.075], 0);
      rib([-0.004, 0.2], Math.PI / 2, 0.036 - 0.2 + 0.004, CAM_Y - 0.2 - 0.024, 0.004);
      rib([0, CAM_Y], 0, -CAM_Z + 0.024, CAM_Z - 0.024, 0.002);
    }
    shells.add('plastic', ringX(0.024, 0.032, XT + 0.0200, XT + 0.026, 40));
    // split line between the upper and lower covers
    shells.add('darkSteel', xf(new THREE.BoxGeometry(0.0012, 0.0012, 0.19), XT + 0.0212, DECK - 0.006, -0.015));
    for (const [z, y] of [[0.075, 0.10], [0.070, 0.25], [-0.100, 0.30], [0.030, 0.405], [-0.030, 0.405], [-0.095, 0.12]]) {
      shells.add('plastic', ringX(0, 0.0072, XT + 0.018, XT + 0.0232, 20).translate(0, y, z));
      bolt(boltsClip, XT + 0.0232, y, z, [1, 0, 0], 0.75);
    }
  }

  // ================================================================ accessories
  // Front accessory drive: a six-rib serpentine belt from the crank damper round
  // the alternator, the water pump and a tensioner idler, listed counter-clockwise
  // in (z, y). All of them are driven by the damper at the pulley ratio.
  const aDamper = { c: [0, 0], r: 0.070 }, aAlt = { c: [0.152, 0.158], r: 0.028 };
  const aPump = { c: [-0.070, 0.162], r: 0.036 }, aTens = { c: [-0.078, 0.046], r: 0.024 };
  const sLoop = beltLoop([aDamper, aAlt, aPump, aTens], 0.004);
  A('front', 'vbelt', beltSolid(sLoop, 0.0020, 0.0025, X_ACC + 0.0153, 0.021));
  const spinners = [];
  const spinner = (parent, P, name) => {
    const g = new THREE.Group(); g.name = name; g.position.set(0, P.c[1], P.c[0]);
    parent.add(g); spinners.push({ g, ratio: aDamper.r / P.r });
    return g;
  };
  // a poly-V pulley face in local coordinates (axis X, centre at the origin)
  const polyV = (r, x0, ribs = 6) => {
    const pv = [[0.012, x0], [r - 0.003, x0], [r, x0 + 0.003]];
    for (let k = 0; k < ribs; k++) { const a = x0 + 0.0045 + k * 0.0036; pv.push([r, a], [r - 0.0022, a + 0.0018]); }
    pv.push([r, x0 + 0.0045 + ribs * 0.0036], [r, x0 + 0.030 - 0.003], [r - 0.003, x0 + 0.030], [0.012, x0 + 0.030]);
    return latheX(pv, 72, { crease: 40 });
  };
  const accSpin = [];                                  // (group, pulley, parts, name), built with the groups
  {
    // Alternator: a die-cast drive-end housing and slip-ring-end housing clamped
    // to the stator by four through-bolts, the laminated stator showing as a band
    // at the joint. Vent windows round both housings show the copper windings
    // inside; spokes on each end face show the dark interior between them. A cooling
    // fan turns behind the pulley. It hangs on a long pivot bolt through a lug on
    // each housing into a bracket on the block, and is set by a slotted strap to
    // an ear on the drive-end housing. B+ stud and nut, and the regulator's
    // connector, on the back.
    const [az, ay] = aAlt.c, R = 0.058;
    const x0 = X_ACC - 0.011, x1 = x0 - 0.108, xs = x1 + 0.058;     // front face, back face, stator
    const at = prof => latheX(prof, 56, { crease: 30 }).translate(0, ay, az);
    const polar = (a, r) => [az + Math.cos(a) * r, ay + Math.sin(a) * r];    // (z, y)
    const bars = (n, xa, xb, r, frac, a0 = 0) => {                         // a ring of cast bars: the vent windows are the gaps
      for (let k = 0; k < n; k++) {
        const a = a0 + (k / n) * Math.PI * 2, [pz, py] = polar(a, r - 0.002);
        A('front', 'castAlt', xf(roundedBox(xb - xa, 0.0045, 2 * Math.PI * r / n * frac, 0.0012), (xa + xb) / 2, py, pz, Math.PI / 2 - a, 0, 0));
      }
    };
    // windings and the dark interior, seen through the windows and between the spokes
    A('front', 'winding', at([[0, x1 + 0.007], [R - 0.0045, x1 + 0.007], [R - 0.0045, x0 - 0.012], [0, x0 - 0.012]]));
    A('front', 'rubber', at([[0, x1 + 0.0035], [R - 0.006, x1 + 0.0035], [R - 0.006, x1 + 0.0072], [0, x1 + 0.0072]]));
    A('front', 'rubber', at([[0, x0 - 0.0115], [R - 0.006, x0 - 0.0115], [R - 0.006, x0 - 0.0075], [0, x0 - 0.0075]]));
    // slip-ring-end housing: rimmed back face, hub, ten spokes; vent band; solid band
    A('front', 'castAlt', at([[R - 0.0075, x1], [R - 0.004, x1], [R - 0.0005, x1 + 0.0035], [R, x1 + 0.009], [R - 0.0075, x1 + 0.009]]));
    A('front', 'castAlt', at([[0, x1 - 0.005], [0.0165, x1 - 0.005], [0.0195, x1 - 0.002], [0.0200, x1 + 0.006], [0, x1 + 0.006]]));
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 + 0.2, r = (0.019 + R - 0.007) / 2, [pz, py] = polar(a, r);
      A('front', 'castAlt', xf(roundedBox(0.0045, R - 0.026, 0.0052, 0.0014), x1 + 0.0022, py, pz, Math.PI / 2 - a, 0, 0));
    }
    bars(16, x1 + 0.009, x1 + 0.030, R, 0.52, 0.1);
    A('front', 'castAlt', at([[R - 0.0075, x1 + 0.0295], [R, x1 + 0.0295], [R, xs - 0.0085], [R + 0.0012, xs - 0.0072], [R - 0.0075, xs - 0.0072]]));
    // stator: a stack of laminations, standing a hair proud, 1.8 mm pitch
    const lam = [[R - 0.006, xs - 0.0072]];
    for (let k = 0; k < 8; k++) { const u = xs - 0.0072 + k * 0.0018; lam.push([R + 0.0016, u + 0.0002], [R + 0.0016, u + 0.0014], [R + 0.0009, u + 0.0018]); }
    lam.push([R - 0.006, xs + 0.0072]);
    A('front', 'darkSteel', latheX(lam, 72, { crease: 20 }).translate(0, ay, az));
    // drive-end housing: solid band, a vent band just behind the fan, a rolled rim,
    // hub and five spokes on the front face
    A('front', 'castAlt', at([[R - 0.0075, xs + 0.0072], [R + 0.0012, xs + 0.0072], [R, xs + 0.0085], [R, xs + 0.024], [R - 0.0075, xs + 0.024]]));
    bars(14, xs + 0.024, x0 - 0.010, R, 0.46, 0.05);
    A('front', 'castAlt', at([[R - 0.0075, x0 - 0.0105], [R, x0 - 0.0105], [R - 0.0015, x0 - 0.005], [R - 0.0065, x0 - 0.0015], [R - 0.012, x0 - 0.0015], [R - 0.012, x0 - 0.0075], [R - 0.0075, x0 - 0.0075]]));
    A('front', 'castAlt', at([[0, x0 - 0.009], [0.0205, x0 - 0.009], [0.0215, x0 - 0.002], [0.0185, x0 + 0.001], [0, x0 + 0.001]]));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + 0.5, r = (0.020 + R - 0.012) / 2, [pz, py] = polar(a, r);
      A('front', 'castAlt', xf(roundedBox(0.0055, R - 0.030, 0.0085, 0.0018), x0 - 0.0045, py, pz, Math.PI / 2 - a, 0, 0));
    }
    // four through-bolts in shallow channels, heads on the back face
    for (const a of [0.35, 2.25, 3.35, 5.25]) {
      const [pz, py] = polar(a, R + 0.0006);
      A('front', 'steel', xf(disc(0.0021, xs + 0.020 - x1, 10), (x1 + xs + 0.020) / 2, py, pz, 0, 0, Math.PI / 2));
      A('front', 'bolt', xf(hexPrism(0.0042, 0.0032), x1 - 0.0010, py, pz, 0, 0, Math.PI / 2));
      for (const xe of [x1 + 0.0045, xs + 0.017]) A('front', 'castAlt', xf(roundedBox(0.009, 0.0065, 0.0085, 0.002), xe, ...polar(a, R + 0.0002).reverse(), Math.PI / 2 - a, 0, 0));
    }
    // pivot: a lug on each housing, the long bolt through both, into a bracket on
    // the block between them
    const aP = 4.18, [ppz, ppy] = polar(aP, R + 0.013);
    const lug = (xa, xb) => {
      A('front', 'castAlt', xf(roundedBox(xb - xa, 0.020, 0.018, 0.004), (xa + xb) / 2, ...polar(aP, R + 0.003).reverse(), Math.PI / 2 - aP, 0, 0));
      A('front', 'castAlt', ringX(0.0045, 0.0105, xa, xb, 32).translate(0, ppy, ppz));
    };
    lug(x1 + 0.003, x1 + 0.020); lug(x0 - 0.032, x0 - 0.013);
    A('front', 'steel', ringX(0, 0.0042, x1 - 0.006, x0 - 0.009, 20).translate(0, ppy, ppz));
    A('front', 'bolt', hexX(0.0072, x0 - 0.013, x0 - 0.006).translate(0, ppy, ppz));
    A('front', 'bolt', hexX(0.0072, x1 - 0.004, x1 + 0.003).translate(0, ppy, ppz));
    A('front', 'cast', ringX(0.0045, 0.0115, x1 + 0.021, x0 - 0.033, 32).translate(0, ppy, ppz));
    A('front', 'cast', xf(roundedBox(x0 - x1 - 0.058, 0.020, ppz - 0.080 + 0.004, 0.004), (x1 + x0) / 2 - 0.006, ppy - 0.002, (ppz + 0.080) / 2 - 0.002));
    A('front', 'cast', xf(roundedBox(0.040, 0.052, 0.012, 0.003), HL - 0.022, ppy, 0.084));
    for (const y of [ppy - 0.017, ppy + 0.017]) accBolt('front', HL - 0.030, y, 0.090, [0, 0, 1], 0.8);
    // adjuster: an ear on the drive-end housing and a slotted strap to a boss on
    // the block, the bolt through the slot
    const aE = 1.35, [epz, epy] = polar(aE, R + 0.012), XE = xs + 0.013;
    A('front', 'castAlt', xf(roundedBox(0.010, 0.020, 0.016, 0.004), XE, ...polar(aE, R + 0.003).reverse(), Math.PI / 2 - aE, 0, 0));
    A('front', 'castAlt', ringX(0.0040, 0.0090, XE - 0.005, XE + 0.005, 28).translate(0, epy, epz));
    const anc = [0.094, 0.196];
    A('front', 'cast', xf(roundedBox(0.022, 0.018, 0.020, 0.004), XE - 0.006, anc[1], anc[0]));
    {
      const d = [epz - anc[0], epy - anc[1]], L = Math.hypot(...d), u = [d[0] / L, d[1] / L], w = 0.0075;
      const strap = poly(fillet([[anc[0] - u[1] * w - u[0] * w, anc[1] + u[0] * w - u[1] * w], [epz - u[1] * w + u[0] * w, epy + u[0] * w + u[1] * w],
        [epz + u[1] * w + u[0] * w, epy - u[0] * w + u[1] * w], [anc[0] + u[1] * w - u[0] * w, anc[1] - u[0] * w - u[1] * w]], 0.0065, 5));
      strap.holes.push(pathOf(stadiumPts(0.012 - L / 2, L / 2 - 0.004, 0, 0.0034, 8).map(([p, q]) => [(anc[0] + epz) / 2 + u[0] * p - u[1] * q, (anc[1] + epy) / 2 + u[1] * p + u[0] * q])));
      A('front', 'darkSteel', xf(extrudeX(strap, 0.0035, 0.0006), XE + 0.0068, 0, 0));
      A('front', 'bolt', hexX(0.0062, XE + 0.0085, XE + 0.0135).translate(0, epy - u[1] * 0.006, epz - u[0] * 0.006));
      A('front', 'bolt', hexX(0.0062, XE + 0.0085, XE + 0.0135).translate(0, anc[1], anc[0]));
    }
    // back: B+ stud on an insulating boss with its nut, and the regulator plug
    {
      const [bz, by] = polar(0.55, 0.030), [cz, cy] = polar(3.7, 0.028);
      A('front', 'plastic', latheX([[0, x1 - 0.010], [0.0072, x1 - 0.010], [0.0082, x1 - 0.004], [0.0082, x1 + 0.002], [0, x1 + 0.002]], 24).translate(0, by, bz));
      A('front', 'steel', ringX(0, 0.0026, x1 - 0.026, x1 - 0.009, 12).translate(0, by, bz));
      A('front', 'bolt', hexX(0.0062, x1 - 0.018, x1 - 0.012).translate(0, by, bz));
      A('front', 'copper', ringX(0.0028, 0.0075, x1 - 0.012, x1 - 0.0105, 20).translate(0, by, bz));
      A('front', 'plastic', xf(roundedBox(0.012, 0.024, 0.020, 0.003), x1 - 0.005, cy, cz));
      A('front', 'plastic', xf(roundedBox(0.012, 0.012, 0.014, 0.002), x1 - 0.015, cy + 0.003, cz));
    }
    // the pulley, the fan behind it and the nut turn with the belt (built about the
    // pulley centre): a pressed fan, eleven blades raked 30 degrees
    const sp = new Parts();
    sp.add('steel', latheX([[0.012, x0 + 0.0015], [0.052, x0 + 0.0015], [0.052, x0 + 0.0030], [0.012, x0 + 0.0030]], 56));
    for (let k = 0; k < 11; k++) {
      const a = (k / 11) * Math.PI * 2;
      sp.add('steel', xf(roundedBox(0.0100, 0.030, 0.0014, 0.0005), x0 + 0.0082, Math.cos(a) * 0.036, Math.sin(a) * 0.036, a, 0.52, 0));
    }
    sp.add('darkSteel', latheX([[0.006, x0 + 0.001], [0.016, x0 + 0.001], [0.016, X_ACC + 0.004], [0.006, X_ACC + 0.004]], 32));
    sp.add('steel', latheX([[0, X_ACC + 0.004], [aAlt.r - 0.003, X_ACC + 0.004], [aAlt.r, X_ACC + 0.008], [aAlt.r, X_ACC + 0.030], [aAlt.r - 0.003, X_ACC + 0.033], [0, X_ACC + 0.033]], 40));
    sp.add('bolt', hexX(0.0085, X_ACC + 0.033, X_ACC + 0.041));
    accSpin.push(['front', aAlt, sp, 'alternator_pulley']);

    // Oil filter: a cast filter head bolted to the block (its pad, two bolts, and
    // the oil-pressure switch screwed into its side), the threaded boss and the
    // machined seat, and on it a spin-on can: a rolled, crimped seam round the base
    // plate, a matte printed can with a lighter label band, and a domed end with
    // wrench flutes. Tipped down 30 degrees, as filters are hung to drain.
    const fq = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), V3(0, -Math.sin(30 * DEG), Math.cos(30 * DEG)));
    const FO = V3(HL - 0.070, 0.030, 0.093), fm = new THREE.Matrix4().compose(FO, fq, V3(1, 1, 1));
    A('filter', 'cast', xf(roundedBox(0.074, 0.070, 0.016, 0.005), FO.x, FO.y + 0.008, 0.090));
    for (const [dx, dy] of [[-0.028, 0.030], [0.028, -0.014]]) accBolt('filter', FO.x + dx, FO.y + dy, 0.098, [0, 0, 1], 0.9);
    A('filter', 'cast', lathe([[0, -0.016], [0.036, -0.016], [0.040, -0.010], [0.040, 0.002], [0.037, 0.004], [0, 0.004]], 56, { crease: 40 }).applyMatrix4(fm));
    A('filter', 'machined', lathe([[0.024, 0.0038], [0.0355, 0.0038], [0.0355, 0.0052], [0.024, 0.0052]], 48).applyMatrix4(fm));
    A('filter', 'steel', lathe([[0, 0.004], [0.011, 0.004], [0.011, 0.012], [0, 0.012]], 24).applyMatrix4(fm));
    // the pressure switch on the side of the head
    {
      const pq = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), V3(1, 0, 0)), pm = new THREE.Matrix4().compose(V3(FO.x + 0.036, FO.y + 0.006, 0.100), pq, V3(1, 1, 1));
      A('filter', 'bolt', hexPrism(0.0085, 0.006, 0).applyMatrix4(pm));
      A('filter', 'plastic', lathe([[0, 0.006], [0.0078, 0.006], [0.0078, 0.018], [0.0055, 0.021], [0.0035, 0.021], [0.0035, 0.026], [0, 0.026]], 20).applyMatrix4(pm));
    }
    const can = [[0, 0.0065], [0.0305, 0.0065], [0.0385, 0.0080], [0.0395, 0.0105], [0.0392, 0.0130], [0.0378, 0.0142], [0.0380, 0.0160],
      [0.0380, 0.0860], [0.0372, 0.0935], [0.0340, 0.0985], [0.0200, 0.1015], [0, 0.1020]];
    A('filter', 'filter', lathe(can, 64, { crease: 40 }).applyMatrix4(fm));
    A('filter', 'filterPrint', lathe([[0.0381, 0.050], [0.03815, 0.050], [0.03815, 0.058], [0.0381, 0.058]], 64).applyMatrix4(fm));
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      A('filter', 'filter', xf(roundedBox(0.0032, 0.010, 0.0018, 0.0008), Math.sin(a) * 0.0378, 0.090, Math.cos(a) * 0.0378, 0, a, 0).applyMatrix4(fm));
    }
    // dipstick with its yellow loop
    const dip = curve([[-0.196, 0.030, 0.092], [-0.196, 0.090, 0.104], [-0.196, 0.200, 0.110], [-0.196, DECK + 0.100, 0.112]]);
    A('dip', 'steel', rodSolid(dip, 0.0042, 40, 12));
    A('dip', 'handle', xf(new THREE.TorusGeometry(0.012, 0.0032, 10, 36), -0.196, DECK + 0.114, 0.112));
    A('dip', 'handle', xf(disc(0.0065, 0.010, 20), -0.196, DECK + 0.100, 0.112));
    // the dipstick tube is held to the block by a strap and bolt halfway up
    {
      const p = dip.getPointAt(0.55), wz = jacketZ(-0.196, p.y);
      A('dip', 'darkSteel', xf(new THREE.TorusGeometry(0.0058, 0.0012, 6, 20), p.x, p.y, p.z, Math.PI / 2, 0, 0));
      A('dip', 'darkSteel', xf(roundedBox(0.009, 0.0018, p.z - wz - 0.004, 0.0006), p.x, p.y, (p.z + wz) / 2 - 0.002));
      accBolt('dip', p.x, p.y + 0.0009, wz + 0.004, [0, 0, 1], 0.55);
    }

    // A strap of flat bar in the plane (z, y), `w` wide along X: the polyline
    // offset half the thickness each way and extruded
    const strap = (pts, t, w, x) => {
      const L = pts.map(([z, y], i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const dz = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dz, dy);
        return [z - (dy / l) * t / 2, y + (dz / l) * t / 2, z + (dy / l) * t / 2, y - (dz / l) * t / 2];
      });
      return xf(extrudeX(poly([...L.map(q => [q[0], q[1]]), ...L.map(q => [q[2], q[3]]).reverse()]), w, 0.0005), x, 0, 0);
    };

    // The engine harness on the intake side: a corrugated loom along the top of
    // the block under the manifold flange, held off the jacket by three P-clips
    // bolted to it, with a branch down to the knock sensor's lead and one forward
    // to the alternator's regulator plug. Bolted on, so it comes off with the
    // accessories.
    {
      const LY = 0.197, LZ = 0.0935;
      const trunk = curve([[-0.186, LY + 0.012, LZ - 0.004], [-0.160, LY, LZ], [0.060, LY, LZ], [0.112, LY - 0.002, LZ + 0.002]]);
      A('harness', 'rubber', rodSolid(trunk, 0.0046, 48, 10));
      A('harness', 'rubber', rodSolid(curve([[0.112, LY - 0.002, LZ + 0.002], [0.132, LY - 0.012, LZ + 0.012], [0.146, 0.165, 0.121], [0.151, 0.150, 0.125]]), 0.0034, 16, 8));
      A('harness', 'plastic', xf(roundedBox(0.012, 0.016, 0.012, 0.002), 0.152, 0.146, 0.127));
      A('harness', 'rubber', rodSolid(curve([[-0.030, LY, LZ], [-0.024, LY - 0.030, LZ + 0.002], [-0.016, 0.140, 0.0905], [-0.012, 0.130, 0.0885]]), 0.0026, 16, 8));
      A('harness', 'plastic', xf(roundedBox(0.010, 0.012, 0.010, 0.002), -0.012, 0.128, 0.0875));
      // corrugation: raised rings every 9 mm along the trunk
      for (let u = 0.03; u < 0.98; u += 0.021) {
        const p = trunk.getPointAt(u), q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), trunk.getTangentAt(u));
        A('harness', 'rubber', annulus(0.0044, 0.0051, 0.0026, 12).applyQuaternion(q).translate(p.x, p.y, p.z));
      }
      for (const x of [-0.140, -0.045, 0.050]) {
        const wz = jacketZ(x, LY);
        A('harness', 'darkSteel', xf(new THREE.TorusGeometry(0.0056, 0.0011, 6, 18), x, LY, LZ, 0, Math.PI / 2, 0));
        A('harness', 'darkSteel', strap([[LZ - 0.0052, LY + 0.004], [LZ - 0.006, LY + 0.001], [wz + 0.002, LY - 0.006]], 0.0013, 0.009, x));
        accBolt('harness', x, LY - 0.0065, wz + 0.0035, [0, 0, 1], 0.5);
      }
    }

    // Coolant: the thermostat housing on the flywheel end of the head, intake side,
    // with the outlet hose and the heater hose cut short where the engine came out
    // of the car, each on a spigot with a worm clamp; and the water pump's inlet
    // hose stub at the front, on the exhaust side. The cut ends show the hose wall.
    {
      const TX = -HL, TY = DECK + 0.034, TZ = 0.066;
      A('coolant', 'castIn', xf(roundedBox(0.005, 0.046, 0.040, 0.0015), TX - 0.0022, TY, TZ));
      A('coolant', 'castIn', xf(roundedBox(0.020, 0.036, 0.030, 0.006), TX - 0.012, TY, TZ));
      for (const s of [-1, 1]) accBolt('coolant', TX - 0.0046, TY + s * 0.018, TZ + s * 0.013, [-1, 0, 0], 0.6);
      const hose = (pts, rO, rI) => {
        const c = curve(pts);
        A('coolant', 'rubber', pipeSolid(c, rO, rI, 24, 20));
        // worm clamp: band, and the screw housing on it
        const p = c.getPointAt(0.10), q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), c.getTangentAt(0.10));
        A('coolant', 'steel', annulus(rO - 0.0004, rO + 0.0009, 0.009, 28).applyQuaternion(q).translate(p.x, p.y, p.z));
        const side = V3(0, 0, 1).applyQuaternion(q).multiplyScalar(rO + 0.0025).add(p);
        A('coolant', 'steel', roundedBox(0.010, 0.008, 0.005, 0.0012).applyQuaternion(q).translate(side.x, side.y, side.z));
        return c;
      };
      // spigots: a turned tube with a bead the hose is pushed over
      const spigot = (at, dir, r, len) => {
        const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), V3(...dir).normalize());
        A('coolant', 'castIn', lathe([[r - 0.003, 0], [r, 0], [r, len - 0.004], [r + 0.0012, len - 0.002], [r, len], [r - 0.003, len]], 24, { crease: 40 }).applyQuaternion(q).translate(...at));
      };
      // (the outlet turns up, and both hoses stay inside the flywheel's plane, so
      // the engine's bounds, and so the page's framing, are what they were)
      spigot([TX - 0.012, TY + 0.016, TZ], [-0.15, 1, 0], 0.0125, 0.014);
      hose([[TX - 0.013, TY + 0.026, TZ], [TX - 0.014, TY + 0.048, TZ + 0.006], [TX - 0.015, TY + 0.068, TZ + 0.018]], 0.0155, 0.0118);
      spigot([TX - 0.012, TY - 0.010, TZ + 0.015], [0, -0.3, 1], 0.0085, 0.013);
      hose([[TX - 0.012, TY - 0.014, TZ + 0.024], [TX - 0.013, TY - 0.022, TZ + 0.040], [TX - 0.016, TY - 0.034, TZ + 0.052]], 0.0110, 0.0080);
      // the water pump's inlet: a cast elbow off the pump body under the timing
      // cover's edge, and a stub of the lower radiator hose
      const [pz0, py0] = aPump.c;
      spigot([HL + 0.012, py0 - 0.045, pz0 - 0.064], [0, -0.35, -1], 0.0145, 0.020);
      A('coolant', 'castIn', xf(roundedBox(0.022, 0.034, 0.030, 0.006), HL + 0.012, py0 - 0.042, pz0 - 0.058));
      hose([[HL + 0.012, py0 - 0.052, pz0 - 0.080], [HL + 0.013, py0 - 0.062, pz0 - 0.098], [HL + 0.010, py0 - 0.082, pz0 - 0.112]], 0.0175, 0.0138);
    }

    // water pump: the pulley on a cast snout through the timing cover, four bolts
    // on its face, turning with the belt
    const [pz, py] = aPump.c;
    whole.add('cast', latheX([[0.010, XT + 0.0205], [0.030, XT + 0.0205], [0.030, XT + 0.022], [0.021, XT + 0.028], [0.017, X_ACC - 0.002], [0.010, X_ACC - 0.002]], 40).translate(0, py, pz));
    const wp = new Parts();
    wp.add('steel', polyV(aPump.r, X_ACC));
    wp.add('steel', latheX([[0.006, X_ACC + 0.030], [0.022, X_ACC + 0.030], [0.022, X_ACC + 0.034], [0.006, X_ACC + 0.034]], 40));
    for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + 0.4; wp.add('bolt', hexX(0.0042, X_ACC + 0.034, X_ACC + 0.038).translate(0, Math.cos(a) * 0.014, Math.sin(a) * 0.014)); }
    wp.build(spinner(statics, aPump, 'water_pump_pulley'), M);
    // tensioner: a smooth idler on a sprung arm pivoting from a boss on the block
    const [tz, ty] = aTens.c;
    const tp = new Parts();
    tp.add('steel', latheX([[0.010, X_ACC + 0.0035], [aTens.r - 0.002, X_ACC + 0.0035], [aTens.r, X_ACC + 0.0055], [aTens.r, X_ACC + 0.0255], [aTens.r - 0.002, X_ACC + 0.0275], [0.010, X_ACC + 0.0275]], 56));
    tp.add('darkSteel', latheX([[0.006, X_ACC + 0.006], [0.016, X_ACC + 0.006], [0.016, X_ACC + 0.029], [0.006, X_ACC + 0.029]], 32));
    for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; tp.add('darkSteel', xf(new THREE.CylinderGeometry(0.0022, 0.0022, 0.004, 10), X_ACC + 0.028, Math.cos(a) * 0.011, Math.sin(a) * 0.011, 0, 0, Math.PI / 2)); }
    tp.build(spinner(statics, aTens, 'tensioner_idler'), M);
    whole.add('bolt', hexX(0.0062, X_ACC + 0.029, X_ACC + 0.035).translate(0, ty, tz));
    const pivot = [-0.098, 0.010];
    const arm = poly(fillet([...circlePts(tz, ty, 0.017, 16, -Math.PI / 2 + 0.6, Math.PI / 2 + 0.6), ...circlePts(pivot[0], pivot[1], 0.014, 16, Math.PI / 2 + 0.6, Math.PI * 1.5 + 0.6)], 0.003, 2));
    whole.add('darkSteel', xf(extrudeX(arm, 0.007, 0.0008), X_ACC - 0.0005, 0, 0));
    whole.add('cast', latheX([[0, XT + 0.0205], [0.020, XT + 0.0205], [0.020, X_ACC - 0.004], [0, X_ACC - 0.004]], 32).translate(0, pivot[1], pivot[0]));
    whole.add('bolt', hexX(0.0065, X_ACC - 0.004, X_ACC + 0.003).translate(0, pivot[1], pivot[0]));

    // Engine back plate: the sheet between block and flywheel that a starter and a
    // gearbox bolt to, with an ear on the intake side carrying the starter.
    const SA = [0.150, -0.052];                          // starter axis (z, y)
    const RP = 0.141 + 0.0178;                           // ring-gear tips to pinion centre
    {
      const k = RP / Math.hypot(SA[0], SA[1]);
      SA[0] *= k; SA[1] *= k;                            // pinion meshes the ring gear
    }
    const plate = poly(fillet([[-0.110, -0.088], [0.104, -0.088], [0.150, -0.096], [0.186, -0.074], [0.190, -0.036], [0.168, -0.010],
      [0.112, 0.004], [0.112, DECK - 0.006], [-0.112, DECK - 0.006], [-0.112, -0.088]], 0.010, 3));
    plate.holes.push(pathOf(circlePts(0, 0, 0.046, 40)));
    plate.holes.push(pathOf(circlePts(SA[0], SA[1], 0.021, 24)));
    shells.add('pan', xf(extrudeX(plate, 0.003, 0.0005), -HL - 0.0025, 0, 0));
    // The bellhousing flange round the rear face: cast bosses on the corners of
    // the block, each with a bolt through the plate, and two hollow dowels that
    // locate the gearbox, so the back of the engine is not a blank sheet.
    for (const [z, y] of [[0.0805, 0.186], [-0.0805, 0.186], [0.0805, 0.110], [-0.0805, 0.110], [0.095, 0.020], [-0.095, 0.020], [0.103, -0.066], [-0.103, -0.066]]) {
      shells.add('cast', latheX([[0, -HL - 0.0008], [0.0072, -HL - 0.0008], [0.0092, -HL + 0.004], [0.0092, -HL + 0.012], [0.0060, -HL + 0.021], [0, -HL + 0.024]], 24, { crease: 50 }).translate(0, y, z));
      bolt(boltsClip, -HL - 0.004, y, z, [-1, 0, 0], 0.95);
    }
    for (const [z, y] of [[0.086, -0.040], [-0.086, 0.150]]) shells.add('steel', ringX(0.0032, 0.0052, -HL - 0.010, -HL + 0.002, 20).translate(0, y, z));
    // Starter: pinion in mesh with the ring gear behind the plate, nose casting
    // bolted to the plate, black motor can, solenoid riding on top.
    const sq = prof => latheX(prof, 48).translate(0, SA[1], SA[0]);
    const pin = poly(toothPts(11, 0.0142, 0.0178, 0.34, 0.40, 0.1));
    pin.holes.push(pathOf(circlePts(0, 0, 0.006, 16)));
    A('starter', 'steel', xf(extrudeX(pin, 0.011, 0.0004), -HL - 0.013, SA[1], SA[0]));
    A('starter', 'steel', sq([[0, -HL - 0.008], [0.0075, -HL - 0.008], [0.0075, -HL + 0.004], [0, -HL + 0.004]]));
    A('starter', 'cast', sq([[0.012, -HL + 0.001], [0.026, -HL + 0.001], [0.030, -HL + 0.010], [0.036, -HL + 0.030], [0.036, -HL + 0.040], [0.012, -HL + 0.040]]));
    A('starter', 'cast', xf(roundedBox(0.012, 0.070, 0.036, 0.004), -HL + 0.006, SA[1] + 0.004, SA[0] - 0.004));
    [-1, 1].forEach(s => accBolt('starter', -HL + 0.013, SA[1] + s * 0.028, SA[0] - 0.004, [1, 0, 0], 0.8));
    const can0 = -HL + 0.040, can1 = -HL + 0.140;
    A('starter', 'pan', sq([[0, can0], [0.0355, can0], [0.0355, can1], [0.0330, can1 + 0.003], [0, can1 + 0.003]]));
    A('starter', 'cast', sq([[0, can1 + 0.002], [0.034, can1 + 0.002], [0.031, can1 + 0.014], [0.020, can1 + 0.020], [0, can1 + 0.021]]));
    for (const a of [0.8, 0.8 + Math.PI]) A('starter', 'steel', xf(disc(0.0022, can1 - can0 + 0.020, 8), (can0 + can1) / 2 + 0.010, SA[1] + Math.sin(a) * 0.0368, SA[0] + Math.cos(a) * 0.0368, 0, 0, Math.PI / 2));
    const SO = [SA[0] - 0.006, SA[1] + 0.0545];
    A('starter', 'steel', latheX([[0, -HL + 0.012], [0.0185, -HL + 0.012], [0.0195, -HL + 0.016], [0.0195, -HL + 0.078], [0.0170, -HL + 0.082], [0, -HL + 0.082]], 40).translate(0, SO[1], SO[0]));
    A('starter', 'plastic', latheX([[0, -HL + 0.082], [0.0150, -HL + 0.082], [0.0150, -HL + 0.090], [0.0120, -HL + 0.094], [0, -HL + 0.094]], 32).translate(0, SO[1], SO[0]));
    A('starter', 'steel', xf(hexPrism(0.0052, 0.008), -HL + 0.098, SO[1] + 0.006, SO[0], 0, 0, -Math.PI / 2));
    A('starter', 'steel', xf(hexPrism(0.0040, 0.006), -HL + 0.098, SO[1] - 0.008, SO[0], 0, 0, -Math.PI / 2));
  }

  // ================================================================ crank (rotates about X)
  const crank = new THREE.Group(); crank.name = 'crank'; root.add(crank);
  {
    const cp = new Parts();
    // one web, split into its forged faces and the turned rim of its counterweight
    const [webF, webT] = splitTris(roundExtrudeX(webShape(), 0.022, 0.0028, 2), (c, n) => {
      const r = Math.hypot(c.y, c.z), a = Math.atan2(c.y, c.z);
      return Math.abs(n.x) < 0.35 && r > WEB_RC - 0.004 && Math.abs(a + Math.PI / 2) < WEB_SPAN - 0.02;
    });
    // balance drillings in the rim of the end counterweights
    const drill = merge([-0.35, 0.35].map(a => xf(disc(0.0042, 0.003, 16, -0.0015), 0, -Math.cos(a) * (WEB_RC - 0.0008), Math.sin(a) * (WEB_RC - 0.0008), -a, 0, 0)));
    CYL_X.forEach((x, i) => {
      for (const s of [-1, 1]) {
        cp.add('forged', xf(webF.clone(), x + s * 0.022, 0, 0, PIN_A[i], 0, 0));
        cp.add('webTurned', xf(webT.clone(), x + s * 0.022, 0, 0, PIN_A[i], 0, 0));
        if ((i === 0 && s > 0) || (i === 3 && s < 0)) cp.add('darkSteel', xf(drill.clone(), x + s * 0.022, 0, 0, PIN_A[i], 0, 0));
        // ground thrust faces round the journals, standing proud of the forging
        cp.add('webTurned', ringX(0.0236, 0.0266, x + s * 0.0106, x + s * 0.0116, 40).translate(0, CR * Math.cos(PIN_A[i]), CR * Math.sin(PIN_A[i])));
        cp.add('webTurned', ringX(0.0262, 0.0325, x + s * 0.0328, x + s * 0.0338, 40));
      }
      const py = CR * Math.cos(PIN_A[i]), pz = CR * Math.sin(PIN_A[i]);
      cp.add('journal', ringX(0, 0.0235, x - 0.0112, x + 0.0112, 40).translate(0, py, pz));
      for (const s of [-1, 1]) cp.add('journal', xf(new THREE.TorusGeometry(0.0235, 0.0015, 4, 28), x + s * 0.011, py, pz, 0, Math.PI / 2, 0));
      cp.add('darkSteel', xf(disc(0.0026, 0.0012, 12), x, py + Math.cos(PIN_A[i] + 0.6) * 0.0233, pz + Math.sin(PIN_A[i] + 0.6) * 0.0233, PIN_A[i] + 0.6, 0, 0));
    });
    MAIN_X.forEach(x => {
      cp.add('journal', ringX(0, 0.026, x - 0.0155, x + 0.0155, 40));
      for (const s of [-1, 1]) cp.add('journal', xf(new THREE.TorusGeometry(0.026, 0.0015, 4, 28), x + s * 0.0153, 0, 0, 0, Math.PI / 2, 0));
      cp.add('darkSteel', xf(disc(0.0026, 0.0012, 12), x, 0.0258, 0));
    });
    // nose through the sprocket and damper; seal land and flywheel flange at the rear
    cp.add('journal', ringX(0, 0.020, MAIN_X[0] + 0.015, X_ACC + 0.036, 40));
    cp.add('journal', ringX(0, 0.030, -HL - 0.003, MAIN_X[4] - 0.015, 48));
    cp.add('journal', ringX(0, 0.040, -HL - 0.013, -HL - 0.003, 56));
    // crank sprocket, 18 teeth
    const spr = poly(toothPts(CRANK_TEETH, R_CRANK_SPR - 0.0028, R_CRANK_SPR + 0.0008, 0.42, 0.34));
    spr.holes.push(pathOf(circlePts(0, 0, 0.0195, 24)));
    cp.add('steel', xf(extrudeX(spr, 0.027, 0.0006), XT, 0, 0));
    cp.add('steel', ringX(0.0195, R_CRANK_SPR + 0.003, XT - 0.0150, XT - 0.0135, 40), ringX(0.0195, R_CRANK_SPR + 0.003, XT + 0.0135, XT + 0.0150, 40));
    // torsional damper with a six-rib poly-V face
    const dx0 = X_ACC, dx1 = X_ACC + 0.030, R = 0.070;
    const pv = [[0.046, dx0], [R - 0.003, dx0], [R, dx0 + 0.003]];
    for (let k = 0; k < 6; k++) { const a = dx0 + 0.0045 + k * 0.0036; pv.push([R, a], [R - 0.0022, a + 0.0018]); }
    pv.push([R, dx0 + 0.0045 + 6 * 0.0036], [R, dx1 - 0.003], [R - 0.003, dx1], [0.046, dx1]);
    cp.add('darkSteel', latheX(pv, 96, { crease: 40 }));
    cp.add('rubber', ringX(0.040, 0.0465, dx0 + 0.004, dx1 - 0.004, 64));
    cp.add('steel', latheX([[0.018, dx0 - 0.004], [0.041, dx0 - 0.004], [0.041, dx1 - 0.006], [0.036, dx1 - 0.002], [0.018, dx1 - 0.002]], 64));
    cp.add('bolt', hexX(0.012, dx1 - 0.002, dx1 + 0.010), ringX(0, 0.016, dx1 - 0.002, dx1 + 0.001, 32));
    // flywheel: ring gear, web, turned friction face, six bolts on the flange
    const fx = -HL - 0.013;
    const fly = [[0.040, fx], [0.118, fx], [0.121, fx + 0.007], [0.132, fx + 0.007], [0.132, fx - 0.017], [0.120, fx - 0.017], [0.075, fx - 0.017], [0.075, fx - 0.012], [0.040, fx - 0.012]];
    cp.add('ironCast', latheX(fly, 96));
    cp.add('friction', ringX(0.076, 0.1195, fx - 0.0176, fx - 0.0170, 96));
    const ring = poly(toothPts(132, 0.1372, 0.1410, 0.40, 0.36));
    ring.holes.push(pathOf(circlePts(0, 0, 0.1310, 132)));
    cp.add('steel', xf(extrudeX(ring, 0.013, 0.0005), fx + 0.0005, 0, 0));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.26;
      cp.add('bolt', hexX(0.0068, fx - 0.018, fx - 0.012).translate(0, Math.cos(a) * 0.030, Math.sin(a) * 0.030));
    }
    cp.build(crank, M);
    crank.children.forEach(m => { m.castShadow = true; });
  }

  // ================================================================ camshafts (half speed)
  const lobes = [];
  const cams = {};
  for (const kind of ['intake', 'exhaust']) {
    const sz = kind === 'intake' ? 1 : -1;
    const g = new THREE.Group(); g.name = kind + '_cam';
    g.position.set(0, CAM_Y, sz * CAM_Z);
    root.add(g);
    const cp = new Parts();
    cp.add('camCast', ringX(0, 0.0125, -HL + 0.006, XT - 0.010, 32));
    MAIN_X.forEach(x => cp.add('lobe', ringX(0, 0.0140, x - 0.011, x + 0.011, 40)));
    CYL_X.forEach(x => cp.add('camCast', hexX(0.0158, x - 0.0095, x + 0.0095)));
    cp.add('lobe', ringX(0, 0.0185, HL - 0.020, HL - 0.015, 40));
    // cam sprocket, twice the crank's teeth, with lightening holes
    const spr = poly(toothPts(CAM_TEETH, R_CAM_SPR - 0.0028, R_CAM_SPR + 0.0008, 0.42, 0.34));
    spr.holes.push(pathOf(circlePts(0, 0, 0.0125, 20)));
    for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; spr.holes.push(pathOf(circlePts(Math.cos(a) * 0.029, Math.sin(a) * 0.029, 0.0085, 20))); }
    cp.add('steel', xf(extrudeX(spr, 0.027, 0.0006), XT, 0, 0));
    cp.add('steel', ringX(0.0125, R_CAM_SPR - 0.0035, XT - 0.0150, XT - 0.0135, 48), ringX(0.0125, R_CAM_SPR - 0.0035, XT + 0.0135, XT + 0.0150, 48));
    cp.add('steel', ringX(0.0125, 0.020, HL - 0.004, XT - 0.013, 40));
    cp.add('bolt', hexX(0.0085, XT + 0.0150, XT + 0.0215));
    cp.build(g, M);
    // lobes: phased from the cam card and the firing order, and tipped by the valve
    // tilt so the nose meets its bucket square
    const maxLift = kind === 'intake' ? SPEC.intakeLift : SPEC.exhaustLift;
    const dur = kind === 'intake' ? SPEC.intakeClose - SPEC.intakeOpen : SPEC.exhaustClose - SPEC.exhaustOpen;
    const centre = kind === 'intake' ? IN_CENTRE : EX_CENTRE;
    const lobeGeo = camLobeGeometry(maxLift, dur, CAM_BASE, 0.015);
    CYL_X.forEach((x, i) => {
      for (const sx of [-1, 1]) {
        const l = mesh(g, lobeGeo, M.lobe, `lobe_${kind}_${i + 1}`);
        l.position.x = x + sx * VALVE_DX;
        l.rotation.x = ((centre + FIRE_ANGLE[i]) / 2) * DEG + sz * TILT;
        lobes.push({ cyl: i, kind, mesh: l });
      }
    });
    cams[kind] = g;
  }

  // cam caps: mechanism, left whole, so each shaft is visibly carried. Cast alloy
  // like the head they are line-bored with: machined bright, their flat tops
  // mirrored the overhead softbox as a row of white squares.
  {
    const capPts = [[-0.023, 0], ...circlePts(0, 0, 0.0142, 16, Math.PI, 0), [0.023, 0], [0.023, 0.012], [0.017, 0.018], [-0.017, 0.018], [-0.023, 0.012]];
    for (const sz of [1, -1]) MAIN_X.forEach(x => {
      whole.add('cast', xf(extrudeX(poly(fillet(capPts, 0.002, 2)), 0.022, 0.0012), x, CAM_Y + 0.0003, sz * CAM_Z));
      for (const s of [-1, 1]) bolt(boltsMech, x, CAM_Y + 0.018, sz * CAM_Z + s * 0.0185, [0, 1, 0], 0.85);
    });
    // The intake camshaft stands in front of the final cut, and with the head's
    // saddles sawn away its caps were bolted to air. A cutaway maker leaves the
    // bearing webs standing: at every journal the lower half-saddle is kept, on a
    // strip of the cam carrier sawn round on three sides back to the section, the
    // saw cuts painted like the rest of the section. So the shaft is carried, and
    // seen from above it sits on five pillars of the head.
    MAIN_X.forEach(x => {
      const cz = CAM_Z;
      const sad = [[cz - 0.023, DECK + 0.0985], [cz + 0.023, DECK + 0.0985], [cz + 0.023, CAM_Y], ...circlePts(cz, CAM_Y, 0.0142, 16, 0, -Math.PI), [cz - 0.023, CAM_Y]];
      whole.add('cast', xf(extrudeX(poly(fillet(sad, 0.002, 2)), 0.021, 0.0012), x, 0, 0));
      const strip = xf(new THREE.BoxGeometry(0.024, 0.022, cz + 0.023 + 0.0015), x, DECK + 0.089, (cz + 0.023 - 0.0015) / 2);
      const [raw, sawn] = splitTris(strip, (c, n) => Math.abs(n.x) > 0.5 || n.z > 0.5);
      whole.add('cast', raw); whole.add('paint', sawn);
    });
  }

  // ================================================================ spark plugs and coils
  // Coil-on-plug: the stalk runs down the plug tube onto the plug, a rubber boot
  // collar seals it where it enters the cover, and the coil head sits low on the
  // spine: a satin moulding with a raised label boss, a three-pin connector with
  // its latch on the intake side, and a tab bolted to the cover on the other.
  // They and the harness that fed them are bolted on, so they are taken off with
  // the accessories before the cut, and the section shows the plugs in their wells.
  const H0c = HEAD_TOP;
  CYL_X.forEach(x => {
    whole.add('steel', xf(disc(0.0070, 0.019, 24), x, RIDGE + 0.0095 - 0.002, 0));
    whole.add('steel', xf(hexPrism(0.0095, 0.010), x, DECK + 0.036, 0));
    whole.add('ceramic', xf(lathe([[0, 0], [0.0062, 0], [0.0062, 0.006], [0.0055, 0.010], [0.0055, 0.040], [0.0035, 0.044], [0, 0.044]], 24), x, DECK + 0.041, 0));
    A('coils', 'plastic', xf(lathe([[0, 0], [0.0098, 0], [0.0108, 0.010], [0.0108, H0c + 0.058 - (DECK + 0.080)], [0, H0c + 0.058 - (DECK + 0.080)]], 24), x, DECK + 0.080, 0));
    A('coils', 'rubber', xf(lathe([[0.0100, 0], [0.0132, 0], [0.0140, 0.003], [0.0135, 0.0065], [0.0100, 0.0070]], 28, { crease: 50 }), x, H0c + 0.0565, 0));
    A('coils', 'plastic', xf(roundedBox(0.021, 0.021, 0.038, 0.0045, 3), x, H0c + 0.0735, 0.003));
    A('coils', 'plastic', xf(roundedBox(0.012, 0.0012, 0.020, 0.0005), x, H0c + 0.0843, 0.001));
    A('coils', 'plastic', xf(roundedBox(0.015, 0.013, 0.012, 0.0022), x, H0c + 0.0715, 0.027));
    A('coils', 'plastic', xf(roundedBox(0.006, 0.0022, 0.008, 0.0008), x, H0c + 0.0786, 0.028));
    A('coils', 'rubber', xf(roundedBox(0.011, 0.009, 0.0012, 0.0004), x, H0c + 0.0715, 0.0333));
    A('coils', 'plastic', xf(roundedBox(0.013, 0.0032, 0.014, 0.0012), x, H0c + 0.0636, -0.021));
    A('coils', 'bolt', xf(hexPrism(0.0036, 0.0032), x, H0c + 0.0668, -0.023));
  });
  // the harness: a corrugated loom along the intake edge of the cover, a branch to
  // each coil's plug (an accessory: it comes off before the cut)
  {
    const LZ = 0.044, LY = H0c + 0.066;
    A('loom', 'rubber', rodSolid(curve([[-0.214, LY - 0.004, LZ + 0.004], [-0.15, LY, LZ], [0.10, LY, LZ], [0.19, LY - 0.002, LZ + 0.004], [0.236, LY - 0.030, LZ + 0.030]]), 0.0055, 60, 10));
    CYL_X.forEach(x => {
      A('loom', 'rubber', rodSolid(curve([[x + 0.020, LY, LZ], [x + 0.010, LY + 0.004, LZ - 0.004], [x, H0c + 0.0715, 0.036]]), 0.0026, 12, 8));
      A('loom', 'plastic', xf(roundedBox(0.017, 0.015, 0.008, 0.002), x, H0c + 0.0715, 0.0365));
    });
    for (let k = 0; k < 7; k++) A('loom', 'plastic', xf(lathe([[0.0056, -0.002], [0.0068, -0.002], [0.0068, 0.002], [0.0056, 0.002]], 16), -0.18 + k * 0.06, LY, LZ, 0, 0, Math.PI / 2));
  }

  // ================================================================ pistons and rods
  const units = [];
  const pistonGeo = (() => {
    // Crown and ring lands turned; the crown top is its own surface so it can carry
    // four shallow valve reliefs, one under each valve head, as a four-valve
    // piston does. The lathe's own top sits 2 mm down, under that surface.
    const TOP = 0.030;
    const prof = [[0, TOP - 0.002], [0.0405, TOP - 0.002], [0.0405, TOP], [0.04295, 0.0292], [0.04295, 0.0248], [0.0395, 0.0248], [0.0395, 0.0236],
      [0.04295, 0.0236], [0.04295, 0.0186], [0.0395, 0.0186], [0.0395, 0.0174], [0.04295, 0.0174], [0.04295, 0.0126],
      [0.0390, 0.0126], [0.0390, 0.0101], [0.04295, 0.0101], [0.04295, 0.006], [0.036, 0.006], [0.036, 0.024], [0, 0.024]];
    const crown = lathe(prof, 44);
    const NR = 10, NA = 44, RC = 0.0405, pos = [], idx = [];
    const reliefs = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) reliefs.push([sx * VALVE_DX, sz * SEAT_Z, sz > 0 ? 0.0178 : 0.0154]);
    const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    for (let i = 0; i <= NR; i++) for (let j = 0; j < NA; j++) {
      const r = (RC * i) / NR, a = (j / NA) * Math.PI * 2, x = r * Math.cos(a), z = r * Math.sin(a);
      let d = 0;
      for (const [cx, cz, rr] of reliefs) d = Math.max(d, 0.0016 * (1 - sm(rr - 0.0022, rr, Math.hypot(x - cx, z - cz))));
      d *= 1 - sm(0.0372, 0.0400, r);                 // the reliefs run out before the edge
      pos.push(x, TOP - d, z);
    }
    for (let i = 0; i < NR; i++) for (let j = 0; j < NA; j++) {
      const a = i * NA + j, b = i * NA + (j + 1) % NA, c = (i + 1) * NA + j, d = (i + 1) * NA + (j + 1) % NA;
      idx.push(a, b, c, b, d, c);
    }
    const top = new THREE.BufferGeometry();
    top.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    top.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
    top.setIndex(idx);
    top.computeVertexNormals();
    const bosses = [];
    for (const s of [-1, 1]) {
      bosses.push(xf(ringX(0.0105, 0.0165, 0.012, 0.040, 32), 0, 0, 0, 0, s > 0 ? 0 : Math.PI, 0));
      bosses.push(xf(roundedBox(0.024, 0.020, 0.012, 0.002), s * 0.024, 0.014, 0));
    }
    const skirt = [];
    for (const sz of [1, -1]) {
      const h = 0.975, out = [], inn = [];
      for (let i = 0; i <= 24; i++) {
        const a = -h + (2 * h * i) / 24;
        out.push([0.0429 * Math.sin(a), sz * 0.0429 * Math.cos(a)]);
        inn.push([0.0405 * Math.sin(a), sz * 0.0405 * Math.cos(a)]);
      }
      skirt.push(extrudeY(poly(fillet([...out, ...inn.reverse()], 0.0015, 2), true), -0.022, 0.0065, 0.0006));
    }
    const rings = [
      annulus(0.0396, 0.04298, 0.0012, 56, 0.0236), annulus(0.0396, 0.04298, 0.0012, 56, 0.0174),
      annulus(0.0391, 0.04298, 0.0005, 56, 0.0120), annulus(0.0391, 0.04298, 0.0005, 56, 0.0102),
    ];
    return {
      crown: merge([crown, top, ...bosses]), skirt: merge(skirt), rings: merge(rings),
      expander: annulus(0.0390, 0.0424, 0.0012, 48, 0.0107),
      pin: ringX(0.0065, 0.0105, -0.031, 0.031, 32),
    };
  })();
  const rodGeo = (() => {
    // One forging: the big-end half, an I-beam that tapers toward the small end,
    // and the small-end eye, with the beam's recess on both faces. The cap is a
    // rounded boss on two lugs, held by round-headed bolts and nuts.
    const L = SPEC.rodLength;
    const side = [[0.0450, 0.0002], [0.0450, 0.0110], [0.0338, 0.0110], [0.0312, 0.0142], [0.0268, 0.0212], [0.0214, 0.0292],
      [0.0176, 0.0380], [0.0160, 0.0470], [0.0110, L - 0.028], [0.0118, L - 0.019]];
    const eye = circlePts(0, L, 0.0165, 36, -0.95, Math.PI + 0.95);
    const outline = [...side, ...eye, ...side.map(([z, y]) => [-z, y]).reverse(),
      [-0.024, 0.0002], ...circlePts(0, 0, 0.024, 32, Math.PI, 0), [0.024, 0.0002]];
    const shape = poly(fillet(outline, 0.0025, 3));
    const pocketPts = [...circlePts(0, 0.0545, 0.0105, 16, Math.PI, 2 * Math.PI), ...circlePts(0, L - 0.037, 0.0060, 16, 0, Math.PI)];
    shape.holes.push(pathOf(circlePts(0, L, 0.0107, 32)), pathOf(pocketPts));
    const cap = [[0.0450, -0.0002], [0.0450, -0.0120], [0.0338, -0.0120], ...circlePts(0, 0, 0.0348, 30, -0.36, -Math.PI + 0.36),
      [-0.0338, -0.0120], [-0.0450, -0.0120], [-0.0450, -0.0002], [-0.024, -0.0002], ...circlePts(0, 0, 0.024, 32, Math.PI, 2 * Math.PI), [0.024, -0.0002]];
    const steel = merge([
      roundExtrudeX(shape, 0.020, 0.0012, 1),
      extrudeX(poly(pocketPts), 0.0056, 0.0008),
      roundExtrudeX(poly(fillet(cap, 0.0025, 3)), 0.020, 0.0012, 1),
    ]);
    const bronze = merge([ringX(0.0235, 0.0240, -0.0095, 0.0095, 48), ringX(0.0105, 0.0107, -0.0092, 0.0092, 32).translate(0, L, 0)]);
    const bolts = merge([-1, 1].flatMap(s => [
      lathe([[0, 0.0110], [0.0056, 0.0110], [0.0056, 0.0142], [0.0049, 0.0160], [0.0032, 0.0168], [0, 0.0169]], 24, { crease: 50 }).translate(0, 0, s * 0.03925),
      lathe([[0, -0.0120], [0.0060, -0.0120], [0.0060, -0.0128], [0, -0.0128]], 24).translate(0, 0, s * 0.03925),
      xf(hexPrism(0.0062, 0.0060, -0.0188), 0, 0, s * 0.03925),
      lathe([[0, -0.0188], [0.0040, -0.0188], [0.0040, -0.0200], [0.0030, -0.0207], [0, -0.0208]], 16, { crease: 50 }).translate(0, 0, s * 0.03925),
    ]));
    return { steel, bronze, bolts };
  })();

  CYL_X.forEach((x, i) => {
    const unit = { index: i, x, fire: FIRE_ANGLE[i], pinA: PIN_A[i] };
    const piston = new THREE.Group(); piston.name = `piston_${i + 1}`; root.add(piston);
    mesh(piston, pistonGeo.crown, M.piston, 'piston_crown');
    mesh(piston, pistonGeo.skirt, M.skirt, 'piston_skirt');
    mesh(piston, pistonGeo.rings, M.ring, 'piston_rings', false);
    mesh(piston, pistonGeo.expander, M.darkSteel, 'oil_expander', false);
    mesh(piston, pistonGeo.pin, M.pin, 'wrist_pin', false);
    unit.piston = piston;
    const rod = new THREE.Group(); rod.name = `rod_${i + 1}`; root.add(rod);
    mesh(rod, rodGeo.steel, M.rod, 'rod');
    mesh(rod, rodGeo.bronze, M.bronze, 'rod_bearings', false);
    mesh(rod, rodGeo.bolts, M.steel, 'rod_bolts', false);
    unit.rod = rod;
    // combustion flash in the chamber, one material each so each can burn alone
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 12), M.flame.clone());
    flash.position.set(x, DECK + 0.006, 0);
    flash.scale.y = 0.55;
    flash.visible = false;
    flash.renderOrder = 3;
    root.add(flash);
    unit.flash = flash;
    unit.lobes = lobes.filter(l => l.cyl === i).map(l => l.mesh);
    units.push(unit);
  });

  // ================================================================ valve instances
  const valveGeo = (rHead, dark) => {
    const prof = [[0, 0], [rHead, 0], [rHead, 0.0014], [rHead - 0.0016, 0.0034], [rHead * 0.62, 0.0068], [0.0055, 0.0110], [0.0032, 0.0170],
      [0.00275, 0.024], [0.00275, 0.093], [0.0022, 0.0935], [0.0022, 0.0956], [0.00275, 0.0961], [0.00275, 0.1010], [0.0024, S_TIP], [0, S_TIP]];
    // stem and head colours are the valve material's, split in the shader at 10 mm
    return lathe(prof, 16, { crease: 40 });
  };
  const springGeo = (() => {
    const pts = [], turns = 6.5, wire = 0.0019, Rm = 0.0110;
    const N = Math.round(turns * 8);
    for (let k = 0; k <= N; k++) {
      const n = (k / N) * turns;
      const sm = t => t * t * (3 - 2 * t);
      let y;
      if (n < 0.9) y = wire + 2 * wire * sm(n / 0.9) * 0.5;
      else if (n > turns - 0.9) y = SPRING_H - wire - 2 * wire * sm((turns - n) / 0.9) * 0.5;
      else y = wire + wire + (SPRING_H - 4 * wire) * ((n - 0.9) / (turns - 1.8));
      const a = n * Math.PI * 2;
      pts.push(V3(Math.cos(a) * Rm, y, Math.sin(a) * Rm));
    }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), N, wire, 4, false);
  })();
  const retGeo = merge([
    lathe([[0.0040, S_SPRING + SPRING_H], [0.0125, S_SPRING + SPRING_H], [0.0125, S_SPRING + SPRING_H + 0.0015], [0.0080, S_SPRING + SPRING_H + 0.0042], [0.0040, S_SPRING + SPRING_H + 0.0042]], 14),
    lathe([[0.0023, S_SPRING + SPRING_H + 0.0012], [0.0046, S_SPRING + SPRING_H + 0.0012], [0.0038, S_SPRING + SPRING_H + 0.0068], [0.0023, S_SPRING + SPRING_H + 0.0068]], 12),
  ]);
  const bucketGeo = r => lathe([[0, S_BUCKET], [r - 0.0006, S_BUCKET], [r, S_BUCKET - 0.0006], [r, S_BUCKET - 0.024], [r - 0.0013, S_BUCKET - 0.024], [r - 0.0013, S_TIP], [0, S_TIP]], 28);
  // springs cast no shadow: inside the towers it is never seen, and it was 19k
  // triangles in the shadow pass
  const inst = (geo, mat, n, name, shadow = true) => {
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.name = name; m.frustumCulled = false; m.castShadow = shadow; m.receiveShadow = true;
    root.add(m);
    return m;
  };
  const vIn = valves.filter(v => v.kind === 'intake'), vEx = valves.filter(v => v.kind === 'exhaust');
  const VT = {
    vIn, vEx,
    valveIn: inst(valveGeo(0.0165, false), M.valve, 8, 'intake_valves'),
    valveEx: inst(valveGeo(0.0140, true), M.valveHot, 8, 'exhaust_valves'),
    springs: inst(springGeo, M.spring, 16, 'valve_springs', false),
    rets: inst(retGeo, M.steel, 16, 'retainers'),
    bucketIn: inst(bucketGeo(0.0150), M.bucket, 8, 'intake_buckets'),
    bucketEx: inst(bucketGeo(0.0145), M.bucket, 8, 'exhaust_buckets'),
  };

  // ================================================================ bolts
  const boltGeo = merge([
    hexPrism(0.0058, 0.0055, 0.0009, true),
    xf(new THREE.CylinderGeometry(0.0078, 0.0078, 0.0009, 12), 0, 0.00045, 0),
  ]);
  const boltMesh = (list, mat, name) => {
    const m = new THREE.InstancedMesh(boltGeo, mat, list.length);
    const o = new THREE.Object3D();
    list.forEach((b, k) => {
      o.position.copy(b.p);
      o.quaternion.setFromUnitVectors(V3(0, 1, 0), b.d);
      o.scale.setScalar(b.s);
      o.updateMatrix();
      m.setMatrixAt(k, o.matrix);
    });
    m.name = name; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true;
    return m;
  };

  // ================================================================ build the draws
  M.coil = M.plastic;
  whole.build(statics, M);
  const capper = new Capper(C.paint);
  // The cap quad is 1.4 m square, so it is not part of the engine: it joins the
  // scene beside it (see setSection) and never enters the engine's bounding box.
  capper.cap.frustumCulled = false;
  const clipMats = new Set();
  // Split every shell by which side of the full cut it lies on. A part wholly in
  // front of the plane is cut away and drops out of the draw entirely once the
  // section is open; a part wholly behind is never cut, so it needs no stencil
  // count. Only the parts the plane passes through pay for the capping. The parts
  // the final cut passes through are split once more, by how far out they reach:
  // while the plane sweeps in through the outer skin, the deep ones (head core,
  // barrels, liners, bulkheads) are wholly behind it and need no count yet. That
  // took the sweep from 390k triangles to under the 350k budget.
  for (const [key, list] of [...shells.m]) {
    // (parts in front are banded by how far forward they start, so at the 01
    // cut, 20 mm in front of the bore axes, the ones wholly ahead of it drop out,
    // and at the final cut, 2 mm in front, so do the intake ports and towers)
    const sides = { '': [], _w: [], _h: [], _g: [], _f: [], _b: [] };
    for (const g of list) {
      g.computeBoundingBox();
      const b = g.boundingBox;
      sides[b.min.z > 0.040 ? '_f' : b.min.z > 0.017 ? '_g' : b.min.z > 0.0025 ? '_h' : b.max.z < -0.003 ? '_b' : b.max.z > 0.070 ? '_w' : ''].push(g);
    }
    shells.m.delete(key);
    for (const [suffix, l] of Object.entries(sides)) if (l.length) { shells.m.set(key + suffix, l); C[key + suffix] = C[key]; }
  }
  shells.build(statics, C, m => { capper.add(m); clipMats.add(m.material); });
  if (cores.length) capper.addCavity(statics, merge(cores), 'port_cores');
  // exterior bolts are cut with the casting they hold, but not capped: too small to read
  const bc = boltMesh(boltsClip, C.bolt, 'bolts_clipped');
  statics.add(bc); clipMats.add(C.bolt);
  root.add(boltMesh(boltsMech, M.bolt, 'bolts'));
  // Cut castings antialias their cut outline by coverage, and show the bright
  // line where the skin meets the cut.
  for (const m of clipMats) { m.alphaToCoverage = true; if (m.userData.rh) m.userData.rh.uRhEdge.value = 0.85; }

  // Accessory groups (see setSection). Their materials are their own, so the belt
  // in the front group can run at the damper's speed.
  const accGroups = [];
  for (const [name, { parts, bolts }] of acc) {
    const g = new THREE.Group(); g.name = 'acc_' + name;
    statics.add(g);
    const mats = makeMaterials();
    for (const [k, m] of Object.entries(mats)) if (k !== 'flame') m.clippingPlanes = [PARKED];
    if (bolts.length) parts.add('bolt', ...bolts.map(b => boltGeo.clone().applyMatrix4(new THREE.Matrix4().compose(b.p, new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), b.d), V3(b.s, b.s, b.s)))));
    parts.build(g, mats);
    for (const [gn, P, sp, spName] of accSpin) if (gn === name) sp.build(spinner(g, P, spName), mats);
    g.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(g);
    accGroups.push({ name, g, mats: Object.values(mats), bb, on: true });
  }
  // A weak fill from the open side of the cut, off while the casting is closed.
  // The interior of a sectioned block sits in the key light's shadow and the
  // metal reflects a dark room, so it fell to near black; a museum cutaway is lit
  // from the viewer's side and its cast interior photographs as lit metal.
  const fillIn = new THREE.DirectionalLight(0xe4e8ee, 0);
  fillIn.name = 'section_fill';
  fillIn.position.set(0.25, 0.55, 1.0);
  root.add(fillIn);

  const box = new THREE.Box3().setFromObject(statics);

  // ================================================================ display stand
  // A museum engine is displayed, not set down: it stands on a welded stand of
  // square tube in satin dark paint, a frame on four levelling feet and a post at
  // each corner of the sump rail with a pad bolted up under it, which lifts the
  // sump STAND_DROP clear of the floor. (Resting on its oil pan, the engine read
  // as put down rather than shown.) It is not part of the engine: it joins the
  // scene beside it (setSection), so the page's framing and bounds are the
  // engine's own; stage.js lays the floor STAND_DROP lower to meet its feet.
  // The stand is sectioned with the engine, as a cutaway is sawn on its stand:
  // the posts on the cut side go with the half of the sump rail they held, and the
  // cross members show their painted cut ends. (Left whole, the front posts held
  // their pads up under a rail that had been cut away.)
  const stand = new THREE.Group(); stand.name = 'stand';
  const standMat = uber_stand();
  {
    const yF = new THREE.Box3().setFromObject(root).min.y - STAND_DROP;
    const st = new Parts(), PX = HL - 0.012, RZ = 0.122, FT = 0.012, TB = 0.030;
    const yT = yF + FT + TB, yP = -0.116 - 0.0035 - 0.006;
    // an H: a cross member under each end and one spine between them, set back
    // behind the cut, so the saw crosses only the cross members and the two front
    // posts, not a rail the length of the engine
    // Square tube with a 2.5 mm wall and welded end caps, so where the saw crosses
    // a member the section shows a thin painted square round a hollow (cut solid,
    // a tube read as a block of paint on the floor)
    const sqTube = (len, w) => {
      const out = poly(fillet(rectPts(-w / 2, -w / 2, w / 2, w / 2), 0.003, 2));
      const ring = poly(fillet(rectPts(-w / 2, -w / 2, w / 2, w / 2), 0.003, 2));
      ring.holes.push(pathOf(fillet(rectPts(-w / 2 + 0.0025, -w / 2 + 0.0025, w / 2 - 0.0025, w / 2 - 0.0025), 0.0012, 2)));
      return merge([extrudeX(ring, len - 0.004), ...[-1, 1].map(s => xf(extrudeX(out, 0.002), s * (len / 2 - 0.001), 0, 0))]);
    };
    for (const s of [-1, 1]) st.add('stand', xf(sqTube(2 * RZ + TB, TB), s * 0.232, yF + FT + TB / 2, 0, 0, Math.PI / 2, 0));
    st.add('stand', xf(sqTube(0.464 - TB + 0.002, TB), 0, yF + FT + TB / 2, -0.030));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      // the post, its welded foot plate, and the pad that reaches in under the rail
      st.add('stand', xf(sqTube(yP - yT + 0.002, 0.026), sx * PX, (yT + yP) / 2, sz * RZ, 0, 0, Math.PI / 2));
      st.add('stand', xf(roundedBox(0.040, 0.004, 0.040, 0.0012), sx * PX, yT + 0.002, sz * RZ));
      st.add('stand', xf(roundedBox(0.044, 0.006, 0.046, 0.0015), sx * PX, yP + 0.003, sz * (RZ - 0.012)));
      for (const dx of [-0.012, 0.012]) st.add('bolt', boltGeo.clone().applyMatrix4(new THREE.Matrix4().compose(V3(sx * PX + dx, yP, sz * (RZ - 0.016)), new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), V3(0, -1, 0)), V3(0.8, 0.8, 0.8))));
      // levelling foot: a rubber pad on the floor, the threaded stud and lock nut
      const fx = sx * 0.232, fz = sz * RZ;
      st.add('rubber', xf(lathe([[0, 0], [0.016, 0], [0.017, 0.002], [0.016, 0.005], [0, 0.005]], 28, { crease: 50 }), fx, yF, fz));
      st.add('steel', xf(disc(0.0055, FT, 14, 0), fx, yF + 0.004, fz));
      st.add('bolt', xf(hexPrism(0.009, 0.005, 0), fx, yF + FT - 0.004, fz));
    }
    standMat.alphaToCoverage = true;
    standMat.userData.rh.uRhEdge.value = 0.85;
    st.build(stand, { stand: standMat, rubber: C.rubber, steel: C.steel, bolt: C.bolt }, m => { if (m.material === standMat) capper.add(m); });
    stand.traverse(o => { if (o.isMesh && !o.userData.helper) { o.castShadow = true; o.receiveShadow = true; } });
  }
  const E = {
    root, materials: M, shellMaterials: C, units, crank, statics, cams, lobes, valves, VT, capper,
    // cutMats are cut by the section; clipMats also holds the accessories, which the
    // section takes away rather than cuts (the page frames a sectioned chapter on
    // what is left, so it needs to know both)
    cutMats: [...new Set([...clipMats, standMat, C.rubber, C.steel, C.bolt])], clipMats: [...clipMats, ...accGroups.flatMap(a => a.mats)], beltT, sLoop, tLoop, accGroups, spinners, fillIn,
    CYL_X, MAIN_X, DECK, PITCH, CAM_Y, CAM_Z, HL,
    capCentre: box.getCenter(new THREE.Vector3()),
    stand,
    innerParts: [...units.flatMap(u => [u.piston, u.rod]), ...Object.values(VT).filter(o => o && o.isInstancedMesh), cams.intake, cams.exhaust, beltT],
    _inner: null,
    valveX: valves.map(v => v.x),
    _secOn: null, _plane: null,
    // worked hard, the header glows dull red, strongest at the flange, and so do the
    // exhaust valve heads, which is what shows through the cut
    setHeat(k) {
      M.exhaust.userData.rh.uRhGlow.value.setRGB(0.95 * k, 0.16 * k, 0.03 * k);
      M.valveHot.userData.rh.uRhGlow.value.setRGB(0.80 * k, 0.12 * k, 0.02 * k);
    },
  };
  updateEngine(E, 0);
  return E;
}

// ---------------------------------------------------------------- section cut
// Only the castings are cut. Pistons, rods, crank, valves, springs, cams, cam caps
// and the timing belt stay whole inside a cut-open casting, which is how an
// engineering cutaway is made. The cut faces are painted, not left hollow.
export function setSection(E, openness, plane) {
  const on = openness > 0.001;
  const host = E.root.parent;
  if (host && E.capper.cap.parent !== host) host.add(E.capper.cap);
  // the display stand is built but not shown (see STAND_DROP)
  E.capper.setPlane(plane);
  if (on !== E._secOn || plane !== E._plane) {
    E._secOn = on; E._plane = plane;
    for (const m of E.cutMats) {
      m.clippingPlanes = on ? [plane] : null;
      m.clipShadows = true;
      m.needsUpdate = true;
    }
  }
  E.capper.update(on, E.capCentre);

  // How far the plane has gone into the engine (m); negative while it is clear.
  const depth = on ? -minDist(plane, CORE) : -1;
  // Accessories are never sawn (a sectioned alternator or filter can reads as a
  // flat sticker), and never faded (faded, they hung over the block for a moment as
  // translucent ghosts: an X-ray, not a strip-down). Each is simply gone, whole,
  // the moment the saw reaches the front of it, so the change is hidden in the
  // sweep of the plane: the manifold, alternator, filter and starter stand
  // furthest out and go with the first frame of the cut, the harness, hoses and
  // dipstick as the plane reaches the block, the coils last. This is the page's
  // own rule for framing (a group is on while the plane has not reached it), and
  // it depends only on where the plane is, so a jump straight to a chapter or a
  // scroll back agrees with a slow sweep.
  const reach = plane.normal.z < -0.999 ? plane.constant : (depth > 0 ? -Infinity : Infinity);
  for (const a of E.accGroups) {
    const on = reach >= a.bb.max.z;
    if (on !== a.on) { a.on = on; a.g.visible = on; }
  }
  // While the casting is closed nothing inside it can be seen: the pistons, rods,
  // valvetrain, camshafts and timing belt are sealed in by the block, the head,
  // the cam cover and the timing cover. They leave the camera's layer until the
  // plane reaches the outermost skin (the crankcase ribs), so the closed engine
  // spends its triangles on the outside. (Layers, not visibility: the page still
  // frames every chapter on the whole mechanism.)
  const inner = depth > -0.006;
  if (inner !== E._inner) {
    E._inner = inner;
    for (const o of E.innerParts) o.traverse(m => { if (m.isMesh || m.isInstancedMesh) m.layers.set(inner ? 0 : 1); });
  }
  // the fill from the open side comes up over the first 80 mm of the cut
  E.fillIn.intensity = 0.85 * smoothstep(0, 0.08, depth);
  // and so does the warm lamp in the crankcase (site.js): it casts no shadow, so
  // with the casting closed it lit the outside of the engine from within
  if (E.guts) { E.gutsMax ??= E.guts.intensity; E.guts.intensity = E.gutsMax * smoothstep(0, 0.08, depth); }
  return E;
}

// how far through the first cut a plane at z = c is: 0 where it starts, just
// clear of the casting (C0), 1 at the 01 section (C1) and anything deeper
const C0 = 0.12, C1 = 0.0197;
const sweepOf = c => c > C0 + 1e-4 ? 0 : Math.min(1, Math.max(0, (C0 - c) / (C0 - C1)));
const PARKED = new THREE.Plane(new THREE.Vector3(0, 0, -1), 50);    // cuts nothing; keeps one program
const CORE = new THREE.Box3(new THREE.Vector3(-0.21, -0.21, -0.11), new THREE.Vector3(0.21, 0.45, 0.11));
const _bc = new THREE.Vector3();
function minDist(plane, bb) {
  let lo = Infinity;
  for (let i = 0; i < 8; i++) {
    _bc.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
    lo = Math.min(lo, plane.distanceToPoint(_bc));
  }
  return lo;
}
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- animation
// One entry point the render loop calls each frame. Everything is derived from the
// crank angle; nothing runs on its own clock.
const _o = new THREE.Object3D(), _q = new THREE.Quaternion(), _v = new THREE.Vector3();
export function updateEngine(E, crankDeg) {
  const th = crankDeg * DEG;
  // turning clockwise seen from the timing end, as a real engine does
  E.crank.rotation.x = -th;
  E.cams.intake.rotation.x = -th / 2;
  E.cams.exhaust.rotation.x = -th / 2;

  for (const u of E.units) {
    // cylinder phase: 0 is TDC of that cylinder's own power stroke
    const phi = ((crankDeg - u.fire) % 720 + 720) % 720;
    const y = wristHeight(phi);
    u.piston.position.set(u.x, y, 0);
    // big end on the crankpin, small end on the wrist pin: both ends solved, so
    // the rod is exactly rodLength long at every angle
    const a = u.pinA - th;
    const pinY = CR * Math.cos(a), pinZ = CR * Math.sin(a);
    u.rod.position.set(u.x, pinY, pinZ);
    u.rod.rotation.x = Math.atan2(-pinZ, y - pinY);

    // combustion flash, on the power stroke only, decaying like a real burn
    const sinceSpark = ((phi - SPEC.spark) % 720 + 720) % 720;
    const burnWindow = SPEC.burnTail + SPEC.sparkBTDC;
    if (sinceSpark < burnWindow) {
      const t = sinceSpark / burnWindow;
      const k = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.04)), 0.65);
      u.flash.visible = true;
      u.flash.material.opacity = 0.36 * k;
      u.flash.scale.set(0.6 + 0.4 * k, 0.4 + 0.2 * k, 0.6 + 0.4 * k);
    } else u.flash.visible = false;
  }

  // valvetrain: lift straight from sim.js, along each valve's own axis
  const VT = E.VT;
  const place = (list, valveMesh, bucketMesh, lift, off) => {
    list.forEach((v, k) => {
      const phi = ((crankDeg - FIRE_ANGLE[v.cyl]) % 720 + 720) % 720;
      const l = lift(phi);
      _v.copy(v.axis).multiplyScalar(-l).add(v.p);
      _o.position.copy(_v); _o.quaternion.copy(v.q); _o.scale.set(1, 1, 1); _o.updateMatrix();
      valveMesh.setMatrixAt(k, _o.matrix);
      bucketMesh.setMatrixAt(k, _o.matrix);
      VT.rets.setMatrixAt(off + k, _o.matrix);
      // the spring is held at its seat and squeezed by the retainer
      _o.position.copy(v.axis).multiplyScalar(S_SPRING).add(v.p);
      _o.scale.set(1, (SPRING_H - l) / SPRING_H, 1); _o.updateMatrix();
      VT.springs.setMatrixAt(off + k, _o.matrix);
    });
    valveMesh.instanceMatrix.needsUpdate = true;
    bucketMesh.instanceMatrix.needsUpdate = true;
  };
  place(VT.vIn, VT.valveIn, VT.bucketIn, intakeLift, 0);
  place(VT.vEx, VT.valveEx, VT.bucketEx, exhaustLift, 8);
  VT.rets.instanceMatrix.needsUpdate = true;
  VT.springs.instanceMatrix.needsUpdate = true;

  // belt teeth travel at the sprocket's pitch-line speed
  E.materials.belt.userData.rh.uRhTime.value = th * R_CRANK_SPR;
  // the serpentine at the damper's pitch-line speed, and every pulley on it
  for (const a of E.accGroups) for (const m of a.mats) if (m.name === 'poly_v_belt') m.userData.rh.uRhTime.value = th * 0.070;
  for (const sp of E.spinners) sp.g.rotation.x = -th * sp.ratio;
  return E;
}

export const LAYOUT = { PITCH, CYL_X, MAIN_X, DECK, CAM_Y, CAM_Z, TILT, CAM_BASE, S_BUCKET, R_CRANK_SPR, R_CAM_SPR, CRANK_TEETH, CAM_TEETH };
