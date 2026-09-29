// geo.js — the solids the engine is built from, all in code.
//
// Everything the section plane can cut has to be a CLOSED solid. The cut faces
// are drawn with a stencil count (back faces minus front faces behind the plane),
// and that count only means "inside the metal" if every shell is watertight. So
// the helpers here build closed lathes, closed pipes and closed extrusions, and
// never an open tube or a single-sided cylinder.

import * as THREE from 'three';
import { mergeBufferGeometries } from '../vendor/BufferGeometryUtils.js';

const V2 = THREE.Vector2, V3 = THREE.Vector3;

// ---------------------------------------------------------------- rounded box
// A box with rounded edges. A highlight along a small radius is most of what
// tells the eye an edge was machined rather than drawn.
export function roundedBox(w, h, d, r, seg = 2) {
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const g = new THREE.BoxGeometry(w, h, d, seg + 1, seg + 1, seg + 1);
  const p = g.attributes.position;
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  const v = new V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const cx = Math.max(-hx, Math.min(hx, v.x));
    const cy = Math.max(-hy, Math.min(hy, v.y));
    const cz = Math.max(-hz, Math.min(hz, v.z));
    const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) { const s = r / len; p.setXYZ(i, cx + dx * s, cy + dy * s, cz + dz * s); }
  }
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- lathe
// A closed (r, y) profile turned about Y. The profile's direction is fixed here
// so the normals always face out, and corners sharper than `crease` degrees get
// split normals, so a machined shoulder reads as a shoulder and not as a blur.
// x = r sin(phi), z = r cos(phi), the same convention as three's own lathe.
export function lathe(profile, segs = 48, { crease = 32, phiStart = 0, phiLength = Math.PI * 2 } = {}) {
  let pts = profile.map(p => new V2(p[0], p[1]));
  pts = pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 1e-7);
  if (pts.length > 2 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-7) pts.pop();
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a.x * b.y - b.x * a.y; }
  if (area < 0) pts.reverse();                     // counter-clockwise: solid on the left
  const n = pts.length;
  const edgeN = [];                                 // outward normal of each edge, (dy, -dr)
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    edgeN.push(new V2(b.y - a.y, -(b.x - a.x)).normalize());
  }
  const cosC = Math.cos((crease * Math.PI) / 180);
  let edges = 0;
  for (let i = 0; i < n; i++) if (!(pts[i].x < 1e-7 && pts[(i + 1) % n].x < 1e-7)) edges++;
  const pos = new Float32Array(edges * segs * 18), nor = new Float32Array(edges * segs * 18), uv = new Float32Array(edges * segs * 12);
  const sn = new Float32Array(segs + 1), cs = new Float32Array(segs + 1);
  for (let j = 0; j <= segs; j++) { const ph = phiStart + (phiLength * j) / segs; sn[j] = Math.sin(ph); cs[j] = Math.cos(ph); }
  let o = 0, q = 0;
  const put = (r, y, j, nx, ny) => {
    pos[o] = r * sn[j]; pos[o + 1] = y; pos[o + 2] = r * cs[j];
    nor[o] = nx * sn[j]; nor[o + 1] = ny; nor[o + 2] = nx * cs[j];
    o += 3;
  };
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (a.x < 1e-7 && b.x < 1e-7) continue;          // lies on the axis
    const prev = edgeN[(i - 1 + n) % n], cur = edgeN[i], next = edgeN[(i + 1) % n];
    const na = prev.dot(cur) > cosC ? prev.clone().add(cur).normalize() : cur;
    const nb = next.dot(cur) > cosC ? next.clone().add(cur).normalize() : cur;
    const va = i / n, vb = (i + 1) / n;
    for (let j = 0; j < segs; j++) {
      const u0 = j / segs, u1 = (j + 1) / segs;
      put(a.x, a.y, j, na.x, na.y); put(a.x, a.y, j + 1, na.x, na.y); put(b.x, b.y, j, nb.x, nb.y);
      put(b.x, b.y, j, nb.x, nb.y); put(a.x, a.y, j + 1, na.x, na.y); put(b.x, b.y, j + 1, nb.x, nb.y);
      uv.set([u0, va, u1, va, u0, vb, u0, vb, u1, va, u1, vb], q); q += 12;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// closed annulus about Y: a turned ring, sleeve, bush or spacer
export const annulus = (rIn, rOut, h, segs = 48, y0 = -h / 2) =>
  lathe([[rIn, y0], [rOut, y0], [rOut, y0 + h], [rIn, y0 + h]], segs);

// closed disc about Y (a solid cylinder with crisp edges)
export const disc = (r, h, segs = 48, y0 = -h / 2) =>
  lathe([[0, y0], [r, y0], [r, y0 + h], [0, y0 + h]], segs);

// ---------------------------------------------------------------- winding
export function flip(g) {
  g = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name], s = a.itemSize;
    for (let t = 0; t < a.count; t += 3) {
      for (let k = 0; k < s; k++) {
        const v1 = a.array[(t + 1) * s + k];
        a.array[(t + 1) * s + k] = a.array[(t + 2) * s + k];
        a.array[(t + 2) * s + k] = v1;
      }
    }
  }
  const n = g.attributes.normal;
  if (n) for (let i = 0; i < n.array.length; i++) n.array[i] = -n.array[i];
  return g;
}

// ---------------------------------------------------------------- pipe
// A pipe with a wall: outer tube, inner tube turned inside out, and two end
// rings stitched from the tubes' own end vertices, so it is exactly closed.
export function pipeSolid(curve, rOut, rIn, tubSeg = 48, radSeg = 20) {
  const outer = new THREE.TubeGeometry(curve, tubSeg, rOut, radSeg, false);
  const inner = new THREE.TubeGeometry(curve, tubSeg, rIn, radSeg, false);
  const ends = [];
  const ring = (tube, k) => {
    const p = tube.attributes.position, out = [];
    for (let j = 0; j <= radSeg; j++) out.push(new V3().fromBufferAttribute(p, k * (radSeg + 1) + j));
    return out;
  };
  for (const [k, t, sign] of [[0, 0, -1], [tubSeg, 1, 1]]) {
    const o = ring(outer, k), i = ring(inner, k);
    const want = curve.getTangentAt(t).multiplyScalar(sign);
    const pos = [];
    for (let j = 0; j < radSeg; j++) {
      const tri = [[o[j], o[j + 1], i[j]], [i[j], o[j + 1], i[j + 1]]];
      for (const [a, b, c] of tri) {
        const nrm = new V3().subVectors(b, a).cross(new V3().subVectors(c, a));
        if (nrm.dot(want) < 0) pos.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
        else pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const nn = [];
    for (let q = 0; q < pos.length / 3; q++) nn.push(want.x, want.y, want.z);
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nn, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
    ends.push(g);
  }
  return merge([outer, flip(inner), ...ends]);
}

// a solid rod along a curve with flat end caps, fanned from the tube's own end
// vertices so it is exactly closed
export function rodSolid(curve, r, tubSeg = 32, radSeg = 14) {
  const g = new THREE.TubeGeometry(curve, tubSeg, r, radSeg, false);
  const p = g.attributes.position, caps = [];
  for (const [k, t, sign] of [[0, 0, -1], [tubSeg, 1, 1]]) {
    const c = curve.getPointAt(t), want = curve.getTangentAt(t).multiplyScalar(sign);
    const ring = [];
    for (let j = 0; j <= radSeg; j++) ring.push(new V3().fromBufferAttribute(p, k * (radSeg + 1) + j));
    const pos = [];
    for (let j = 0; j < radSeg; j++) {
      const a = ring[j], b2 = ring[j + 1];
      const nrm = new V3().subVectors(b2, a).cross(new V3().subVectors(c, a));
      if (nrm.dot(want) >= 0) pos.push(a.x, a.y, a.z, b2.x, b2.y, b2.z, c.x, c.y, c.z);
      else pos.push(a.x, a.y, a.z, c.x, c.y, c.z, b2.x, b2.y, b2.z);
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    cg.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(0).flatMap(() => [want.x, want.y, want.z]), 3));
    caps.push(cg);
  }
  return merge([g, ...caps]);
}

// ---------------------------------------------------------------- extrusions
// Shapes are drawn in the plane of the section they describe, then turned so the
// extrusion runs along the named axis. No mirroring, so the winding survives.
// three only re-orients the holes when the outline itself needed reversing, so a
// mirrored plan (outline and holes both clockwise) came out with inside-out hole
// walls. Orientation is forced here: outline counter-clockwise, holes clockwise.
function orient(shape) {
  const ex = shape.extractPoints(16);
  let o = ex.shape;
  if (THREE.ShapeUtils.isClockWise(o)) o = o.slice().reverse();
  const s = new THREE.Shape(o);
  s.holes = ex.holes.map(h => new THREE.Path(THREE.ShapeUtils.isClockWise(h) ? h : h.slice().reverse()));
  return s;
}
const EXT = (shape, depth, bevel) => {
  const b = bevel || 0;
  shape = orient(shape);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-5, depth - 2 * b), curveSegments: 16, steps: 1,
    bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: b > 0 ? 1 : 0,
  });
  g.translate(0, 0, -(depth - 2 * b) / 2);
  return creased(g);
};

// Smooth normals across shallow angles and split them at real corners, so a curved
// flank shades smooth and a machined edge stays crisp. Positions are matched at
// 1 micron (three's own helper hashes at 1 cm, which merges half this engine).
// Coincident vertices are found by sorting their quantised positions, not by
// string keys in a map: this runs over every solid in the engine at load, and the
// string version was the largest single cost of building it.
export function creased(g, angle = 34) {
  if (g.index) g = g.toNonIndexed();
  const P = g.attributes.position.array, n = P.length / 3, nt = n / 3;
  const fn = new Float32Array(nt * 3), fa = new Float32Array(nt);
  for (let t = 0; t < nt; t++) {
    const i = t * 9;
    const bx = P[i + 3], by = P[i + 4], bz = P[i + 5];
    const ux = P[i + 6] - bx, uy = P[i + 7] - by, uz = P[i + 8] - bz;       // c - b
    const vx = P[i] - bx, vy = P[i + 1] - by, vz = P[i + 2] - bz;           // a - b
    let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const area = Math.hypot(cx, cy, cz);
    if (area > 0) { cx /= area; cy /= area; cz /= area; }
    fn[t * 3] = cx; fn[t * 3 + 1] = cy; fn[t * 3 + 2] = cz; fa[t] = Math.max(area, 1e-12);
  }
  const qx = new Int32Array(n), qy = new Int32Array(n), qz = new Int32Array(n);
  for (let v = 0; v < n; v++) { qx[v] = Math.round(P[v * 3] * 1e6); qy[v] = Math.round(P[v * 3 + 1] * 1e6); qz[v] = Math.round(P[v * 3 + 2] * 1e6); }
  const order = new Uint32Array(n);
  for (let v = 0; v < n; v++) order[v] = v;
  order.sort((a, b) => (qx[a] - qx[b]) || (qy[a] - qy[b]) || (qz[a] - qz[b]));
  const cosA = Math.cos((angle * Math.PI) / 180);
  const out = new Float32Array(n * 3);
  for (let s0 = 0; s0 < n;) {
    let s1 = s0 + 1;
    const r = order[s0];
    while (s1 < n && qx[order[s1]] === qx[r] && qy[order[s1]] === qy[r] && qz[order[s1]] === qz[r]) s1++;
    for (let k = s0; k < s1; k++) {
      const v = order[k], f = (v / 3) | 0;
      const fx = fn[f * 3], fy = fn[f * 3 + 1], fz = fn[f * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      for (let m = s0; m < s1; m++) {
        const o = (order[m] / 3) | 0;
        const ox = fn[o * 3], oy = fn[o * 3 + 1], oz = fn[o * 3 + 2];
        if (ox * fx + oy * fy + oz * fz > cosA) { sx += ox * fa[o]; sy += oy * fa[o]; sz += oz * fa[o]; }
      }
      let l = Math.hypot(sx, sy, sz);
      if (l < 1e-30) { sx = fx; sy = fy; sz = fz; l = Math.hypot(sx, sy, sz) || 1; }
      out[v * 3] = sx / l; out[v * 3 + 1] = sy / l; out[v * 3 + 2] = sz / l;
    }
    s0 = s1;
  }
  g.setAttribute('normal', new THREE.Float32BufferAttribute(out, 3));
  return g;
}

// ---------------------------------------------------------------- skin
// A closed slab whose outer face is the height field z = sz * f(x, y), sampled on
// the grid xs by ys, with its inner face t behind it: a cast wall that follows
// what it encloses (a water jacket over the barrels). Each triangle is wound
// against a known outward direction (+-z on the faces, +-x or +-y on the rims),
// which for a height field is exact, so the solid is closed and counts correctly
// in the section stencil however steep the fillets get.
export function skinSolid(xs, ys, f, t, sz = 1) {
  const nx = xs.length, ny = ys.length, O = [], I = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const z = f(xs[i], ys[j]);
    O.push([xs[i], ys[j], sz * z]); I.push([xs[i], ys[j], sz * (z - t)]);
  }
  const at = (A, i, j) => A[i * ny + j], pos = [];
  const tri = (a, b, c, o) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const d = (uy * vz - uz * vy) * o[0] + (uz * vx - ux * vz) * o[1] + (ux * vy - uy * vx) * o[2];
    if (d >= 0) pos.push(...a, ...b, ...c); else pos.push(...a, ...c, ...b);
  };
  const quad = (a, b, c, d, o) => { tri(a, b, c, o); tri(a, c, d, o); };
  for (let i = 0; i < nx - 1; i++) for (let j = 0; j < ny - 1; j++) {
    quad(at(O, i, j), at(O, i + 1, j), at(O, i + 1, j + 1), at(O, i, j + 1), [0, 0, sz]);
    quad(at(I, i, j), at(I, i + 1, j), at(I, i + 1, j + 1), at(I, i, j + 1), [0, 0, -sz]);
  }
  for (let i = 0; i < nx - 1; i++) {
    quad(at(O, i, 0), at(O, i + 1, 0), at(I, i + 1, 0), at(I, i, 0), [0, -1, 0]);
    quad(at(O, i, ny - 1), at(O, i + 1, ny - 1), at(I, i + 1, ny - 1), at(I, i, ny - 1), [0, 1, 0]);
  }
  for (let j = 0; j < ny - 1; j++) {
    quad(at(O, 0, j), at(O, 0, j + 1), at(I, 0, j + 1), at(I, 0, j), [-1, 0, 0]);
    quad(at(O, nx - 1, j), at(O, nx - 1, j + 1), at(I, nx - 1, j + 1), at(I, nx - 1, j), [1, 0, 0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return creased(g, 40);
}
// A triangle soup for a closed solid built by hand: each triangle is wound to
// face the outward hint given with it, then normals are creased as usual.
export class Tris {
  constructor() { this.pos = []; }
  tri(a, b, c, o) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const d = (uy * vz - uz * vy) * o[0] + (uz * vx - ux * vz) * o[1] + (ux * vy - uy * vx) * o[2];
    if (d >= 0) this.pos.push(...a, ...b, ...c); else this.pos.push(...a, ...c, ...b);
  }
  quad(a, b, c, d, o) { this.tri(a, b, c, o); this.tri(a, c, d, o); }
  build(angle = 40) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((this.pos.length / 3) * 2), 2));
    return creased(g, angle);
  }
}

// sample points from a to b, n steps, bunched toward both ends when k > 0
export const span = (a, b, n, k = 0) => Array.from({ length: n + 1 }, (_, i) => {
  const u = i / n, w = u - k * Math.sin(2 * Math.PI * u) / (2 * Math.PI);
  return a + (b - a) * w;
});

// a hexagon prism about Y with flat faces (bolt heads, nuts)
export function hexPrism(r, h, y0 = -h / 2) {
  const g = new THREE.CylinderGeometry(r, r, h, 6, 1, false).toNonIndexed();
  g.translate(0, y0 + h / 2, 0);
  g.computeVertexNormals();
  return g;
}
// shape (u, v) = (z, y); extrusion along X, centred on x = 0
export function extrudeX(shape, depth, bevel = 0) {
  const g = EXT(shape, depth, bevel);
  g.rotateY(-Math.PI / 2);                   // local z -> -x, local x -> +z
  return g;
}
// shape (u, v) = (x, y); extrusion along Z, centred on z = 0
export function extrudeZ(shape, depth, bevel = 0) { return EXT(shape, depth, bevel); }
// shape (u, v) = (x, -z) internally; call with plan points as (x, z). Along Y from y0.
export function extrudeY(shape, y0, y1, bevel = 0) {
  const g = EXT(shape, y1 - y0, bevel);
  g.rotateX(-Math.PI / 2);                   // local z -> +y, local y -> -z
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}

// ---------------------------------------------------------------- 2d shapes
// polygon from [x, y] points; `flipV` negates the second coordinate (plan views)
export function poly(points, flipV = false) {
  const s = new THREE.Shape();
  points.forEach(([u, v], i) => (i ? s.lineTo(u, flipV ? -v : v) : s.moveTo(u, flipV ? -v : v)));
  s.closePath();
  return s;
}
export function pathOf(points, flipV = false) {
  const s = new THREE.Path();
  points.forEach(([u, v], i) => (i ? s.lineTo(u, flipV ? -v : v) : s.moveTo(u, flipV ? -v : v)));
  s.closePath();
  return s;
}
export const circlePts = (cx, cy, r, n = 40, a0 = 0, a1 = Math.PI * 2) => {
  const out = [];
  const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
  const m = full ? n : n + 1;
  for (let i = 0; i < m; i++) { const a = a0 + ((a1 - a0) * i) / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
};
export const rectPts = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// Round every corner of a closed polygon by radius r (skipping near-straight
// vertices). Casting corners are never sharp; this is what makes a plate read
// as cast rather than cut from sheet.
export function fillet(points, r, steps = 4) {
  const n = points.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = new V2(...points[i]);
    const a = new V2(...points[(i - 1 + n) % n]), b = new V2(...points[(i + 1) % n]);
    const da = a.clone().sub(p), db = b.clone().sub(p);
    const la = da.length(), lb = db.length();
    da.normalize(); db.normalize();
    const cosT = da.dot(db);
    const half = Math.acos(Math.max(-1, Math.min(1, cosT))) / 2;
    // leave near-straight vertices alone (arc samples, long polylines)
    if (half > Math.PI / 2 - 0.1 || la < 1e-6 || lb < 1e-6) { out.push([p.x, p.y]); continue; }
    let d = r / Math.tan(half);
    d = Math.min(d, la * 0.45, lb * 0.45);
    const rr = d * Math.tan(half);
    const p0 = p.clone().add(da.clone().multiplyScalar(d));
    const p1 = p.clone().add(db.clone().multiplyScalar(d));
    const bis = da.clone().add(db).normalize();
    const c = p.clone().add(bis.multiplyScalar(rr / Math.sin(half)));
    let s0 = Math.atan2(p0.y - c.y, p0.x - c.x), s1 = Math.atan2(p1.y - c.y, p1.x - c.x);
    let ds = s1 - s0;
    while (ds > Math.PI) ds -= Math.PI * 2;
    while (ds < -Math.PI) ds += Math.PI * 2;
    for (let k = 0; k <= steps; k++) { const s = s0 + (ds * k) / steps; out.push([c.x + rr * Math.cos(s), c.y + rr * Math.sin(s)]); }
  }
  return out;
}

// offset a closed CCW-or-CW polygon outward (positive d) along vertex normals
export function offsetPts(points, d) {
  let area = 0;
  for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const s = area > 0 ? 1 : -1;
  const n = points.length;
  return points.map((p, i) => {
    const a = points[(i - 1 + n) % n], b = points[(i + 1) % n];
    const e0 = new V2(p[0] - a[0], p[1] - a[1]).normalize(), e1 = new V2(b[0] - p[0], b[1] - p[1]).normalize();
    const n0 = new V2(e0.y, -e0.x).multiplyScalar(s), n1 = new V2(e1.y, -e1.x).multiplyScalar(s);
    const m = n0.clone().add(n1);
    const k = m.lengthSq() > 1e-9 ? m.normalize().multiplyScalar(d / Math.max(0.35, m.dot(n0))) : n0.multiplyScalar(d);
    return [p[0] + k.x, p[1] + k.y];
  });
}

// stadium (a slot): segment from (x0,y) to (x1,y) grown by r
export const stadiumPts = (x0, x1, y, r, n = 16) => [
  ...circlePts(x1, y, r, n, -Math.PI / 2, Math.PI / 2),
  ...circlePts(x0, y, r, n, Math.PI / 2, Math.PI * 1.5),
];

// toothed outline (sprocket, ring gear), tooth centred on angle 0
export function toothPts(teeth, rRoot, rTip, topFrac = 0.34, rootFrac = 0.40, a0 = 0) {
  const out = [];
  for (let i = 0; i < teeth; i++) {
    const c = a0 + (i / teeth) * Math.PI * 2, w = (Math.PI * 2) / teeth;
    const rf = w * rootFrac / 2, tf = w * topFrac / 2, flank = (w / 2 - rf);
    out.push([Math.cos(c - w / 2 + 0.0001) * rRoot, Math.sin(c - w / 2 + 0.0001) * rRoot]);
    out.push([Math.cos(c - flank) * rRoot, Math.sin(c - flank) * rRoot]);
    out.push([Math.cos(c - tf) * rTip, Math.sin(c - tf) * rTip]);
    out.push([Math.cos(c + tf) * rTip, Math.sin(c + tf) * rTip]);
    out.push([Math.cos(c + flank) * rRoot, Math.sin(c + flank) * rRoot]);
  }
  return out;
}

// ---------------------------------------------------------------- merge
// Everything becomes plain triangles with position / normal / uv, so any mix of
// three's geometries and these helpers can be merged into one draw.
export function merge(list) {
  const KEEP = ['position', 'normal', 'uv', 'color', 'aGlow', 'aArc'];
  const clean = list.filter(Boolean).map(g => {
    // a plain non-indexed geometry that already carries what a merge needs is used
    // as it is; only the rest are copied and trimmed
    const plain = !g.index && g.attributes.normal && g.attributes.uv && !g.morphAttributes.position && Object.keys(g.attributes).every(k => KEEP.includes(k));
    if (plain) return g;
    let h = g.index ? g.toNonIndexed() : g.clone();
    for (const k of Object.keys(h.attributes)) if (!KEEP.includes(k)) h.deleteAttribute(k);
    if (!h.attributes.normal) h.computeVertexNormals();
    if (!h.attributes.uv) h.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(h.attributes.position.count * 2), 2));
    h.clearGroups();
    h.morphAttributes = {};
    return h;
  });
  const keys = new Set();
  clean.forEach(h => Object.keys(h.attributes).forEach(k => keys.add(k)));
  for (const h of clean) {
    for (const k of keys) {
      if (h.attributes[k]) continue;
      const size = k === 'color' ? 3 : 1;
      const fill = new Float32Array(h.attributes.position.count * size);
      if (k === 'color') fill.fill(1);
      h.setAttribute(k, new THREE.Float32BufferAttribute(fill, size));
    }
  }
  const out = mergeBufferGeometries(clean, false);
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

// transform a geometry in place and return it
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new V3(), _p = new V3();
export function xf(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) {
  _q.setFromEuler(_e.set(rx, ry, rz));
  if (typeof s === 'number') _s.set(s, s, s); else _s.set(...s);
  _m.compose(_p.set(x, y, z), _q, _s);
  g.applyMatrix4(_m);
  return g;
}

// a pie of vertex colours down a geometry, by a function of position
export function paint(g, fn) {
  const p = g.attributes.position, c = new Float32Array(p.count * 3), v = new V3(), col = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    fn(v, col);
    c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  return g;
}

// ---------------------------------------------------------------- tapered tube
// A tube along a curve whose radius changes along it, r(u) for u in 0..1 by arc
// length: a cast runner that narrows toward its port. Open ended (its ends are
// buried in a flange and a plenum), so it is only for parts that are never cut.
export function taperTube(curve, r, tubSeg = 32, radSeg = 16) {
  const g = new THREE.TubeGeometry(curve, tubSeg, 1, radSeg, false);
  const p = g.attributes.position, P = new V3(), v = new V3();
  for (let i = 0; i <= tubSeg; i++) {
    curve.getPointAt(i / tubSeg, P);
    const k = r(i / tubSeg);
    for (let j = 0; j <= radSeg; j++) {
      const n = i * (radSeg + 1) + j;
      v.fromBufferAttribute(p, n).sub(P).multiplyScalar(k).add(P);
      p.setXYZ(n, v.x, v.y, v.z);
    }
  }
  return g;
}
