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
} from './geo.js';
import { makeMaterials, VOIDS, NV } from './materials.js';
import { Capper } from './caps.js';

export { roundedBox };

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
  const N = 128;
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
    // Upper block: the outer wall follows the bores, bulging over each barrel and
    // dipping between them, round one water jacket that encloses the bore row.
    // The deck above stays square, so it overhangs the dips like a real deck.
    const R_B = 0.0835, Z_DIP = 0.074, sideZ = x => {
      let z = Z_DIP;
      for (const cx of CYL_X) { const d = x - cx; if (Math.abs(d) < R_B) z = Math.max(z, Math.sqrt(R_B * R_B - d * d)); }
      return z;
    };
    const wallPts = [];
    for (let k = 0; k <= 72; k++) { const x = HL - (2 * HL * k) / 72; wallPts.push([x, sideZ(x)]); }
    for (let k = 0; k <= 72; k++) { const x = -HL + (2 * HL * k) / 72; wallPts.push([x, -sideZ(x)]); }
    const s = poly(fillet(wallPts, 0.008, 3), true);
    s.holes.push(pathOf(stadiumPts(CYL_X[3], CYL_X[0], 0, 0.0635, 24), true));
    shells.add('cast', extrudeY(s, 0.060, DECK - 0.010, 0.0015));
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
  // exterior casting detail: tapered ribs at the bulkheads, a waist rib
  const ribPts = [[0.100, -0.068], [0.108, -0.066], [0.108, -0.010], [0.090, 0.054], [0.082, 0.072], [0.082, 0.186], [0.074, 0.201], [0.071, 0.201], [0.071, 0.064], [0.082, 0.052], [0.100, -0.010]];
  for (const sz of [1, -1]) {
    const pts = ribPts.map(([z, y]) => [z * sz, y]);
    MAIN_X.forEach(x => shells.add('cast', xf(extrudeX(poly(fillet(sz > 0 ? pts : pts.reverse(), 0.002, 2)), 0.010, 0.0025), x, 0, 0)));
    shells.add('cast', xf(roundedBox(BLOCK_L - 0.012, 0.008, 0.012, 0.0025), 0, 0.062, sz * 0.085));
  }
  // core plugs on the exhaust side, oil-filter boss and engine mounts on the intake side
  [-0.10, 0, 0.10].forEach(x => shells.add('steel', xf(disc(0.016, 0.004, 32), x, 0.135, -BW - 0.0005, Math.PI / 2, 0, 0)));
  for (const sz of [1, -1]) {
    shells.add('cast', xf(roundedBox(0.074, 0.056, 0.014, 0.003), -0.045, 0.118, sz * (BW + 0.005)));
    [[-0.07, 0.132], [-0.02, 0.132], [-0.045, 0.104]].forEach(([x, y]) => bolt(boltsClip, x, y, sz * (BW + 0.012), [0, 0, sz], 1));
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
    // swage beads pressed along both sides
    for (const sz of [1, -1]) {
      shells.add('pan', draft(rodSolid(curve([[HL - 0.018, -0.132, sz * 0.0985], [-HL + 0.018, -0.132, sz * 0.0985]]), 0.0024, 4, 10)));
      shells.add('pan', draft(rodSolid(curve([[XW - 0.050, -0.172, sz * 0.0985], [-HL + 0.018, -0.172, sz * 0.0985]]), 0.0024, 4, 10)));
    }
    // drain plug on a welded boss low on the well, and a second on the floor
    const zs = y => 0.098 * (1 - 0.55 * (YP - y));
    shells.add('pan', xf(disc(0.013, 0.004, 28, 0), -0.150, -0.188, zs(-0.188) - 0.001, Math.PI / 2, 0, 0));
    bolt(boltsClip, -0.150, -0.188, zs(-0.188) + 0.003, [0, 0, 1], 1.6);
    bolt(boltsClip, -0.15, -0.205, 0.03, [0, -1, 0], 1.6);
    // oil pickup, visible through the cut
    shells.add('steel', pipeSolid(curve([[0.02, -0.070, -0.030], [-0.02, -0.110, -0.030], [-0.06, -0.160, -0.030], [-0.07, -0.186, -0.030]]), 0.007, 0.0055, 32, 12));
    shells.add('pan', xf(disc(0.026, 0.008, 32), -0.07, -0.192, -0.030));      // strainer, painted: bare, it mirrored the softbox white
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
    // pent-roof chambers: the flanks sit square to the valve axes
    CYL_X.forEach(x => {
      const g = new THREE.CylinderGeometry(BORE_R + 0.0006, BORE_R + 0.0006, 1, 48, 1, false).toNonIndexed();
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) > 0 ? DECK + 0.024 : roofY(p.getZ(i)));
      g.computeVertexNormals();
      shells.add('headCast', xf(g, x, 0, 0));
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
    CYL_X.forEach(x => {
      for (const s of [-1, 1]) {
        const x0 = x + s * 0.0172, x1 = x + s * 0.0405;
        const pocket = poly(fillet(rectPts(Math.min(x0, x1), DECK + 0.026, Math.max(x0, x1), DECK + 0.046), 0.0065, 4));
        shells.add('castCore', flip(extrudeZ(pocket, 0.100, 0.004)));
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
    shells.add('cover', extrudeX(poly(prof), L, 0.001));
    const endPlate = poly([...outR, ...outL].map(([z, y]) => [z, H0 + y]));
    // the end plates stand 3 mm proud of the head at each end, edges rounded, so
    // the cover reads as a separate moulding sitting on the head
    for (const sx of [1, -1]) shells.add('cover', xf(roundExtrudeX(endPlate, 0.007, 0.0022, 2), sx * (L / 2 + 0.0005), 0, 0));
    for (const sz of [1, -1]) ribs.forEach(z => shells.add('machined', xf(new THREE.BoxGeometry(L - 0.02, 0.0008, 0.0022), 0, H0 + 0.0472, sz * z)));
    for (const x of [-0.18, -0.108, -0.036, 0.036, 0.108, 0.18]) for (const sz of [1, -1]) bolt(boltsClip, x, H0 + 0.006, sz * 0.094, [0, 1, 0], 0.8);
    for (const sx of [1, -1]) bolt(boltsClip, sx * (HL - 0.010), H0 + 0.060, -0.012, [0, 1, 0], 0.8);
    // Oil filler: a boss moulded into the cover and a round black cap on it, 12 mm
    // tall with a ribbed grip and a bar across its crown. It comes off with the
    // accessories rather than being sawn through.
    const FX = HL - 0.060, FZ = 0.058, FY = H0 + 0.044;
    shells.add('cover', lathe([[0, -0.002], [0.027, -0.002], [0.027, 0.002], [0.024, 0.006], [0, 0.006]], 40, { crease: 40 }).translate(FX, FY, FZ));
    A('filler', 'plastic', lathe([[0, 0.006], [0.0205, 0.006], [0.0215, 0.008], [0.0215, 0.0155], [0.0195, 0.018], [0.012, 0.0188], [0, 0.0190]], 48, { crease: 40 }).translate(FX, FY, FZ));
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2;
      A('filler', 'plastic', xf(roundedBox(0.0026, 0.0078, 0.0030, 0.0009), FX + Math.cos(a) * 0.0218, FY + 0.0118, FZ + Math.sin(a) * 0.0218, 0, -a, 0));
    }
    A('filler', 'plastic', xf(roundedBox(0.030, 0.0055, 0.0060, 0.0022), FX, FY + 0.0205, FZ));
    shells.add('cast', rodSolid(curve([[-HL + 0.05, H0 + 0.045, -0.058], [-HL + 0.05, H0 + 0.062, -0.060], [-HL + 0.03, H0 + 0.070, -0.060]]), 0.005, 16, 12));
    // the Realm mark: a satin copper plate let into the spine between cylinders 2
    // and 3, the ring-and-cross raised on it. Cut with the cover, not left floating.
    shells.add('copper', xf(roundedBox(0.044, 0.0022, 0.026, 0.0008), 0, H0 + 0.0606, 0));
    shells.add('copper', xf(new THREE.TorusGeometry(0.0080, 0.0010, 6, 40), 0, H0 + 0.0622, 0, Math.PI / 2, 0, 0));
    shells.add('copper', xf(roundedBox(0.018, 0.0012, 0.0016, 0.0004), 0, H0 + 0.0620, 0), xf(roundedBox(0.0016, 0.0012, 0.018, 0.0004), 0, H0 + 0.0620, 0));
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
    // plenum: a rounded box along the engine, ribbed between the runners
    const sec = (g = 0) => poly(fillet(rectPts(PZ - PW / 2 - g, PY - PH / 2 - g, PZ + PW / 2 + g, PY + PH / 2 + g), 0.019 + g, 5));
    A('intake', 'castIn', xf(extrudeX(sec(), PX1 - PX0, 0.003), (PX0 + PX1) / 2, 0, 0));
    for (const x of [PX0 + 0.030, -PITCH, 0, PITCH, PX1 - 0.030]) A('intake', 'castIn', xf(extrudeX(sec(0.0028), 0.005, 0.0012), x, 0, 0));
    // bolted end cover, machined face, six screws
    A('intake', 'machined', xf(extrudeX(sec(0.004), 0.006, 0.0012), PX0 - 0.003, 0, 0));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      accBolt('intake', PX0 - 0.006, PY + Math.sin(a) * (PH / 2 - 0.006), PZ + Math.cos(a) * (PW / 2 - 0.006), [-1, 0, 0], 0.7);
    }
    // a pressure sensor on a boss on top, and the crankcase breather spigot
    A('intake', 'castIn', xf(roundedBox(0.030, 0.008, 0.026, 0.003), -0.060, PY + PH / 2 + 0.003, PZ));
    A('intake', 'plastic', xf(roundedBox(0.024, 0.014, 0.020, 0.004), -0.060, PY + PH / 2 + 0.012, PZ));
    A('intake', 'plastic', xf(roundedBox(0.010, 0.010, 0.014, 0.002), -0.074, PY + PH / 2 + 0.014, PZ));
    A('intake', 'castIn', lathe([[0, 0], [0.009, 0], [0.009, 0.004], [0.0055, 0.006], [0.0055, 0.020], [0.0065, 0.022], [0.0065, 0.025], [0, 0.025]], 20).translate(0.080, PY + PH / 2 - 0.002, PZ));
    // Electronic throttle body: a squared casting round the bore on a round flange,
    // the butterfly cracked 10 degrees on its spindle, the motor housing moulded in
    // black on the outboard face, and a spigot carrying the inlet hose, cut short
    // with its clamp, as on an engine lifted out of its car.
    const tb0 = PX1, tb1 = PX1 + 0.050, tbm = (tb0 + tb1) / 2;
    A('intake', 'castIn', latheX([[0.0315, tb0 - 0.004], [0.046, tb0 - 0.004], [0.046, tb0 + 0.008], [0.0315, tb0 + 0.008]], 48).translate(0, PY, PZ));
    const tbS = poly(fillet(rectPts(-0.040, -0.044, 0.040, 0.041), 0.013, 4));
    tbS.holes.push(pathOf(circlePts(0, 0, 0.0318, 40)));
    A('intake', 'castIn', xf(extrudeX(tbS, tb1 - tb0 - 0.012, 0.0025), tbm + 0.004, PY, PZ));
    A('intake', 'castIn', latheX([[0.0315, tb1 - 0.004], [0.0368, tb1 - 0.004], [0.0368, tb1 + 0.016], [0.0350, tb1 + 0.019], [0.0315, tb1 + 0.019]], 48).translate(0, PY, PZ));
    [0, 1, 2, 3].forEach(k => { const a = Math.PI / 4 + (k * Math.PI) / 2; accBolt('intake', tb0 + 0.008, PY + Math.cos(a) * 0.040, PZ + Math.sin(a) * 0.040, [1, 0, 0], 0.7); });
    A('intake', 'steel', xf(disc(0.0312, 0.0015, 40), tbm, PY, PZ, 0, 0, Math.PI / 2 - 10 * DEG));
    A('intake', 'steel', xf(disc(0.0032, 0.090, 12), tbm, PY, PZ, Math.PI / 2, 0, 0));
    A('intake', 'plastic', xf(roundedBox(0.036, 0.078, 0.020, 0.006), tbm + 0.002, PY - 0.002, PZ + 0.047));
    A('intake', 'plastic', xf(roundedBox(0.016, 0.018, 0.016, 0.003), tbm + 0.004, PY + 0.042, PZ + 0.050));
    [-1, 1].forEach(s => accBolt('intake', tbm - 0.010, PY + s * 0.030, PZ + 0.057, [0, 0, 1], 0.55));
    // the inlet hose, rubber over the spigot, cut off square where the duct to the
    // air box would carry on
    A('intake', 'rubber', latheX([[0.0355, tb1 + 0.002], [0.0405, tb1 + 0.002], [0.0405, tb1 + 0.036], [0.0385, tb1 + 0.038], [0.0355, tb1 + 0.038]], 48).translate(0, PY, PZ));
    A('intake', 'steel', latheX([[0.0405, tb1 + 0.006], [0.0425, tb1 + 0.006], [0.0425, tb1 + 0.015], [0.0405, tb1 + 0.015]], 48).translate(0, PY, PZ));
    A('intake', 'steel', xf(roundedBox(0.010, 0.012, 0.012, 0.002), tb1 + 0.0105, PY + 0.044, PZ));
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
    const tinted = (crv, rO, rI, glowLen = 0.12, s0 = 0) => {
      const g = pipeSolid(crv, rO, rI, 24, 10);
      const samp = crv.getSpacedPoints(120), len = crv.getLength();
      const p = g.attributes.position, uv = new Float32Array(p.count * 2), v = V3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        let best = 1e9, bi = 0;
        for (let k = 0; k < samp.length; k++) { const d = samp[k].distanceToSquared(v); if (d < best) { best = d; bi = k; } }
        uv[i * 2] = s0 + (bi / (samp.length - 1)) * len;
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
      ex.push(tinted(curve(pts), 0.0190, 0.0172));
    });
    ex.push(tinted(curve([[0.020, 0.090, -0.175], [0.010, 0.040, -0.176], [-0.030, 0.000, -0.172], [-0.045, -0.020, -0.168]]), 0.0235, 0.0215, 0.12, 0.25));
    ex.push(tinted(curve([[-0.050, 0.105, -0.160], [-0.052, 0.050, -0.163], [-0.050, 0.000, -0.166], [-0.047, -0.025, -0.168]]), 0.0235, 0.0215, 0.12, 0.25));
    // the downpipe turns back along the sump and stops above its floor, so the
    // engine can stand on its sump
    ex.push(tinted(curve([[-0.046, 0.010, -0.168], [-0.047, -0.040, -0.168], [-0.062, -0.108, -0.162], [-0.112, -0.140, -0.152], [-0.190, -0.150, -0.146]]), 0.0300, 0.0280, 0.12, 0.35));
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
    shells.add('plastic', xf(extrudeX(rim, XT + 0.021 - HL, 0.001), (HL + XT + 0.021) / 2, 0, 0));
    const face = poly(O1); face.holes.push(pathOf(circlePts(0, 0, 0.024, 32)));
    shells.add('plastic', xf(extrudeX(face, 0.003, 0.001), XT + 0.0195, 0, 0));
    // moulded bead round the face and a boss round the crank nose
    const B1 = beltLoop(tList.map(p => ({ c: p.c, r: p.r + 0.0095 })), 0.009, 1).pts, B2 = beltLoop(tList.map(p => ({ c: p.c, r: p.r + 0.006 })), 0.009, 1).pts;
    const bead = poly(B1); bead.holes.push(pathOf(B2));
    shells.add('plastic', xf(extrudeX(bead, 0.0025, 0.0008), XT + 0.0222, 0, 0));
    // a raised moulded panel inside the bead, and stiffening ribs fanning from each
    // cam boss: without them the cover was one flat black slab in the hero shot
    const P1 = beltLoop(tList.map(p => ({ c: p.c, r: Math.max(0.012, p.r - 0.004) })), 0.009, 1).pts;
    const panel = poly(P1); panel.holes.push(pathOf(circlePts(0, 0, 0.036, 32)));
    shells.add('plastic', xf(extrudeX(panel, 0.0024, 0.0009), XT + 0.0215, 0, 0));
    for (const cz of [CAM_Z, -CAM_Z]) {
      shells.add('plastic', xf(new THREE.TorusGeometry(0.020, 0.0022, 6, 28), XT + 0.0228, CAM_Y, cz, 0, Math.PI / 2, 0));
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + 0.3, r0 = 0.022, r1 = R_CAM_SPR - 0.002;
        const c = [(r0 + r1) / 2 * Math.cos(a), (r0 + r1) / 2 * Math.sin(a)];
        shells.add('plastic', xf(roundedBox(0.004, r1 - r0, 0.0035, 0.0012), XT + 0.0232, CAM_Y + c[1], cz + c[0], Math.PI / 2 - a, 0, 0));
      }
    }
    shells.add('plastic', ringX(0.024, 0.032, XT + 0.021, XT + 0.026, 40));
    // split line between the upper and lower covers
    shells.add('darkSteel', xf(new THREE.BoxGeometry(0.0012, 0.0012, 0.19), XT + 0.0212, DECK - 0.006, -0.015));
    for (const [z, y] of [[0.075, 0.10], [0.070, 0.25], [-0.100, 0.30], [0.030, 0.405], [-0.030, 0.405], [-0.095, 0.12]]) bolt(boltsClip, XT + 0.021, y, z, [1, 0, 0], 0.75);
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
    // alternator: two cast housings split at a waist, the rear one ribbed, the
    // front one vented; bracket back to the block
    const [az, ay] = aAlt.c, x0 = X_ACC + 0.004, x1 = X_ACC - 0.112, R = 0.058;
    const xs = x1 + 0.060;
    const body = [[0, x1], [R - 0.010, x1], [R - 0.004, x1 + 0.004], [R - 0.002, x1 + 0.010],
      [R - 0.002, x1 + 0.016], [R + 0.001, x1 + 0.018], [R + 0.001, x1 + 0.022], [R - 0.002, x1 + 0.024],
      [R - 0.002, x1 + 0.032], [R + 0.001, x1 + 0.034], [R + 0.001, x1 + 0.038], [R - 0.002, x1 + 0.040],
      [R - 0.002, xs - 0.004], [R - 0.005, xs - 0.002], [R - 0.005, xs + 0.002], [R, xs + 0.004],
      [R, x0 - 0.018], [R - 0.004, x0 - 0.010], [R - 0.014, x0 - 0.005], [0.024, x0 - 0.004], [0.024, x0], [0, x0]];
    A('front', 'cast', latheX(body, 44, { crease: 28 }).translate(0, ay, az));
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      A('front', 'plastic', xf(new THREE.BoxGeometry(0.016, 0.0016, 0.0042), x0 - 0.028, ay + Math.sin(a) * (R - 0.0012), az + Math.cos(a) * (R - 0.0012), a, 0, 0));
    }
    for (const s2 of [1, -1]) A('front', 'cast', xf(roundedBox(0.020, 0.018, 0.024, 0.004), xs + 0.020, ay + s2 * (R + 0.004), az - 0.012));
    A('front', 'steel', xf(hexPrism(0.005, 0.010), x1 + 0.003, ay + 0.018, az + 0.012, 0, 0, Math.PI / 2));
    A('front', 'cast', xf(roundedBox(0.050, 0.036, 0.060, 0.004), HL - 0.018, ay - 0.050, 0.110));
    // the pulley, fan and nut turn with the belt (built about the pulley centre)
    const sp = new Parts();
    sp.add('steel', discX(0.046, x0, x0 + 0.0025, 48));
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      sp.add('steel', xf(new THREE.BoxGeometry(0.004, 0.024, 0.0016), x0 + 0.0025, Math.cos(a) * 0.033, Math.sin(a) * 0.033, -a, 0, 0));
    }
    sp.add('steel', latheX([[0, X_ACC + 0.004], [aAlt.r - 0.003, X_ACC + 0.004], [aAlt.r, X_ACC + 0.008], [aAlt.r, X_ACC + 0.030], [aAlt.r - 0.003, X_ACC + 0.033], [0, X_ACC + 0.033]], 40));
    sp.add('bolt', hexX(0.0085, X_ACC + 0.033, X_ACC + 0.041));
    accSpin.push(['front', aAlt, sp, 'alternator_pulley']);

    // oil filter on its boss, tipped down 30 degrees
    const fq = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), V3(0, -Math.sin(30 * DEG), Math.cos(30 * DEG)));
    const fm = new THREE.Matrix4().compose(V3(HL - 0.070, 0.030, 0.093), fq, V3(1, 1, 1));
    A('filter', 'cast', disc(0.030, 0.014, 40, -0.004).applyMatrix4(fm));
    const can = [[0, 0.010], [0.034, 0.010], [0.038, 0.016], [0.038, 0.086], [0.034, 0.098], [0.020, 0.100], [0, 0.100]];
    A('filter', 'filter', lathe(can, 56).applyMatrix4(fm));
    // a printed band and the wrench flats at the closed end
    A('filter', 'darkSteel', lathe([[0.0378, 0.040], [0.0384, 0.041], [0.0384, 0.060], [0.0378, 0.061]], 72).applyMatrix4(fm));
    A('filter', 'darkSteel', lathe([[0.0375, 0.078], [0.0386, 0.079], [0.0386, 0.090], [0.0375, 0.091]], 72).applyMatrix4(fm));
    // dipstick with its yellow loop
    const dip = curve([[-0.196, 0.030, 0.092], [-0.196, 0.090, 0.104], [-0.196, 0.200, 0.110], [-0.196, DECK + 0.100, 0.112]]);
    A('dip', 'steel', rodSolid(dip, 0.0042, 40, 12));
    A('dip', 'handle', xf(new THREE.TorusGeometry(0.012, 0.0032, 10, 36), -0.196, DECK + 0.114, 0.112));
    A('dip', 'handle', xf(disc(0.0065, 0.010, 20), -0.196, DECK + 0.100, 0.112));

    // water pump: the pulley on a cast snout through the timing cover, four bolts
    // on its face, turning with the belt
    const [pz, py] = aPump.c;
    whole.add('cast', latheX([[0.010, XT + 0.018], [0.030, XT + 0.018], [0.030, XT + 0.022], [0.021, XT + 0.028], [0.017, X_ACC - 0.002], [0.010, X_ACC - 0.002]], 40).translate(0, py, pz));
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
    whole.add('cast', latheX([[0, XT + 0.018], [0.020, XT + 0.018], [0.020, X_ACC - 0.004], [0, X_ACC - 0.004]], 32).translate(0, pivot[1], pivot[0]));
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
    shells.add('darkSteel', xf(extrudeX(plate, 0.003, 0.0005), -HL - 0.0025, 0, 0));
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
    const [webF, webT] = splitTris(roundExtrudeX(webShape(), 0.022, 0.0028, 3), (c, n) => {
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
  }

  // ================================================================ spark plugs and coils
  CYL_X.forEach(x => {
    whole.add('steel', xf(disc(0.0070, 0.019, 24), x, RIDGE + 0.0095 - 0.002, 0));
    whole.add('steel', xf(hexPrism(0.0095, 0.010), x, DECK + 0.036, 0));
    whole.add('ceramic', xf(lathe([[0, 0], [0.0062, 0], [0.0062, 0.006], [0.0055, 0.010], [0.0055, 0.040], [0.0035, 0.044], [0, 0.044]], 24), x, DECK + 0.041, 0));
    whole.add('coil', xf(lathe([[0, 0], [0.0105, 0], [0.0120, 0.012], [0.0120, HEAD_TOP + 0.064 - (DECK + 0.080)], [0, HEAD_TOP + 0.064 - (DECK + 0.080)]], 28), x, DECK + 0.080, 0));
    whole.add('coil', xf(roundedBox(0.024, 0.030, 0.052, 0.004), x, HEAD_TOP + 0.078, 0.004));
    whole.add('coil', xf(roundedBox(0.018, 0.016, 0.018, 0.003), x, HEAD_TOP + 0.074, 0.036));
    whole.add('bolt', xf(hexPrism(0.004, 0.004), x, HEAD_TOP + 0.094, -0.014));
  });

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
    const crown = lathe(prof, 56);
    const NR = 16, NA = 64, RC = 0.0405, pos = [], idx = [];
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
    return lathe(prof, 20, { crease: 40 });
  };
  const springGeo = (() => {
    const pts = [], turns = 6.5, wire = 0.0019, Rm = 0.0110;
    const N = Math.round(turns * 11);
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
    lathe([[0.0040, S_SPRING + SPRING_H], [0.0125, S_SPRING + SPRING_H], [0.0125, S_SPRING + SPRING_H + 0.0015], [0.0080, S_SPRING + SPRING_H + 0.0042], [0.0040, S_SPRING + SPRING_H + 0.0042]], 20),
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
    hexPrism(0.0058, 0.0055, 0.0009),
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
    // cut, 20 mm in front of the bore axes, the ones wholly ahead of it drop out)
    const sides = { '': [], _w: [], _g: [], _f: [], _b: [] };
    for (const g of list) {
      g.computeBoundingBox();
      const b = g.boundingBox;
      sides[b.min.z > 0.040 ? '_f' : b.min.z > 0.017 ? '_g' : b.max.z < -0.003 ? '_b' : b.max.z > 0.070 ? '_w' : ''].push(g);
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

  // Accessory groups. Their materials are see-through capable (one more program,
  // shared by all of them) so each group can fade as it is taken off.
  const accGroups = [];
  for (const [name, { parts, bolts }] of acc) {
    const g = new THREE.Group(); g.name = 'acc_' + name;
    statics.add(g);
    const mats = makeMaterials();
    for (const [k, m] of Object.entries(mats)) if (k !== 'flame') { m.transparent = true; m.depthWrite = true; m.clippingPlanes = [PARKED]; }
    if (bolts.length) parts.add('bolt', ...bolts.map(b => boltGeo.clone().applyMatrix4(new THREE.Matrix4().compose(b.p, new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), b.d), V3(b.s, b.s, b.s)))));
    parts.build(g, mats);
    for (const [gn, P, sp, spName] of accSpin) if (gn === name) sp.build(spinner(g, P, spName), mats);
    g.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(g);
    accGroups.push({ name, g, mats: Object.values(mats), bb, d0: null, op: 1 });
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
  const E = {
    root, materials: M, shellMaterials: C, units, crank, statics, cams, lobes, valves, VT, capper,
    // cutMats are cut by the section; clipMats also holds the accessories, which the
    // section takes away rather than cuts (the page frames a sectioned chapter on
    // what is left, so it needs to know both)
    cutMats: [...clipMats], clipMats: [...clipMats, ...accGroups.flatMap(a => a.mats)], beltT, sLoop, tLoop, accGroups, spinners, fillIn,
    CYL_X, MAIN_X, DECK, PITCH, CAM_Y, CAM_Z, HL,
    capCentre: box.getCenter(new THREE.Vector3()),
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
  // Accessories come off as the cut begins, the way a museum cutaway is stripped
  // before it is sawn: each fades and draws away from the block over the first
  // quarter of the first cut, the ones that stand furthest out first, so they are
  // gone before the plane is into the walls and never hang as ghosts over the
  // section paint. The state depends only on where the plane is, so a jump
  // straight to a chapter or a scroll back agrees with a slow sweep.
  const u = plane.normal.z < -0.999 ? sweepOf(plane.constant) : (depth > 0 ? 1 : 0);
  for (const a of E.accGroups) {
    const lag = Math.min(0.08, Math.max(0, 0.2 - a.bb.max.z));
    const op = 1 - smoothstep(lag, 0.25 + lag, u);
    if (op !== a.op) {
      a.op = op;
      for (const m of a.mats) m.opacity = op;
      a.g.visible = op > 0.01;
      a.g.position.copy(plane.normal).multiplyScalar(-(1 - op) * 0.06);
      a.g.traverse(o => { if (o.isMesh) o.castShadow = op > 0.6; });
    }
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
