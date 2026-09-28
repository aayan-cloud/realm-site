// caps.js — cut faces that read as solid metal.
//
// A clipping plane on its own leaves hollow shells: you look through the cut into
// lit interior surfaces. A museum cutaway paints the cut face instead. This does
// the same with a stencil count: for every closed shell, back faces behind the
// plane add one and front faces behind the plane take one away, so a pixel on the
// plane ends up counting how many solids it is inside. One painted quad on the
// plane is then drawn where that count is positive, and it resets the stencil as
// it goes.
//
// The count starts at BIAS (128), not zero, so it can go negative without
// wrapping into paint. That is what makes a cavity simple: a cored port or a water
// jacket is a closed solid counted with weight -3, so wherever it is (inside one,
// two or three overlapping castings, or out in the air) the count there is at or
// below the bias and the cavity shows as a pocket, never as paint.
//
// Render order: mechanism (0) -> stencil passes (1) -> cap (1.1) -> shells (2).

import * as THREE from 'three';
import { coverageClip } from './materials.js';

export const BIAS = 128;
const _c = new THREE.Vector3();

export class Capper {
  constructor(paintMaterial, size = 1.4) {
    this.plane = null;
    this.shells = [];
    this.cavities = [];
    this.helpers = [];
    this.on = false;
    const cm = paintMaterial;
    // one clipping plane parked far away, so the paint shares the engine's program
    if (!cm.clippingPlanes) cm.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 50)];
    cm.stencilWrite = true;
    cm.stencilRef = BIAS;
    cm.stencilFunc = THREE.LessStencilFunc;          // passes where BIAS < count
    cm.stencilFail = THREE.ReplaceStencilOp;
    cm.stencilZFail = THREE.ReplaceStencilOp;
    cm.stencilZPass = THREE.ReplaceStencilOp;
    // Drawn a hair toward the camera: inner faces of overlapping castings (a liner
    // inside its barrel, a deck under a gasket) meet the plane inside the metal,
    // and at exactly the plane's depth they won the depth test on alternate pixels
    // and showed through the paint as dashed grey seams.
    cm.polygonOffset = true;
    cm.polygonOffsetFactor = -2;
    cm.polygonOffsetUnits = -4;
    this.cap = new THREE.Mesh(new THREE.PlaneGeometry(size, size), cm);
    this.cap.name = 'section_cap';
    this.cap.renderOrder = 1.1;
    this.cap.castShadow = false;
    this.cap.receiveShadow = true;
    this.cap.visible = false;
    this.back = this._mat(THREE.BackSide, THREE.IncrementWrapStencilOp);
    this.front = this._mat(THREE.FrontSide, THREE.DecrementWrapStencilOp);
    // a cavity counts the other way round
    this.cBack = this._mat(THREE.BackSide, THREE.DecrementWrapStencilOp);
    this.cFront = this._mat(THREE.FrontSide, THREE.IncrementWrapStencilOp);
  }

  // The count passes clip with coverage, not a hard discard, so under MSAA the
  // outline of the cut face is antialiased like every other edge (a discard kills
  // the whole pixel and left the section outline stair-stepped).
  _mat(side, op) {
    return coverageClip(new THREE.MeshBasicMaterial({
      side, colorWrite: false, depthWrite: false, depthTest: false,
      stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
      stencilFail: op, stencilZFail: op, stencilZPass: op,
      clipShadows: false,
    }));
  }

  _helpers(parent, geometry, name, n = 1, swap = false, inst = null) {
    const out = [];
    for (let k = 0; k < n; k++) for (const m of [this.back, this.front]) {
      const mat = swap ? (m === this.back ? this.cBack : this.cFront) : m;
      const h = inst ? new THREE.InstancedMesh(geometry, mat, inst.count) : new THREE.Mesh(geometry, mat);
      if (inst) { h.instanceMatrix = inst.instanceMatrix; h.frustumCulled = false; }
      h.renderOrder = 1;
      h.castShadow = false; h.receiveShadow = false;
      h.visible = false;
      h.name = name + (m === this.back ? '_sb' : '_sf');
      h.userData.helper = true;
      parent.add(h);
      this.helpers.push(h);
      out.push(h);
    }
    return out;
  }

  // A closed shell mesh: it will be clipped and its cut face painted.
  add(mesh) {
    mesh.renderOrder = 2;
    this.shells.push(mesh);
    this._helpers(mesh, mesh.geometry, mesh.name, 1, false, mesh.isInstancedMesh ? mesh : null);
    return mesh;
  }

  // A cavity: a closed solid (outward normals) that is empty space. It draws
  // nothing itself; the walls you see inside it belong to the castings round it.
  addCavity(parent, geometry, name, weight = 3) {
    geometry.computeBoundingBox();
    const hs = this._helpers(parent, geometry, name, weight, true);
    this.cavities.push({ geometry, helpers: hs, parent });
  }

  setPlane(plane) {
    if (plane === this.plane) return;
    this.plane = plane;
    for (const m of [this.back, this.front, this.cBack, this.cFront]) { m.clippingPlanes = [plane]; m.needsUpdate = true; }
  }

  _span(bb, matrixWorld) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) {
      _c.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(matrixWorld);
      const d = this.plane.distanceToPoint(_c);
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
    return [lo, hi];
  }

  // centre the cap quad on the part of the plane the engine occupies
  update(on, centre) {
    if (on !== this.on) {
      this.on = on;
      this.cap.visible = on;
      if (!on) for (const m of this.shells) m.visible = true;
    }
    // A shell wholly on the cut-away side draws nothing, and one wholly on the kept
    // side has no cut face; only a shell the plane passes through needs the count.
    if (on && this.plane) {
      for (const m of this.shells) {
        const bb = m.geometry.boundingBox || (m.geometry.computeBoundingBox(), m.geometry.boundingBox);
        const [lo, hi] = this._span(bb, m.matrixWorld);
        m.visible = hi > 0;
        const cut = lo < 0 && hi > 0;
        for (const h of m.children) if (h.userData.helper) h.visible = cut;
      }
      for (const c of this.cavities) {
        const [lo, hi] = this._span(c.geometry.boundingBox, c.parent.matrixWorld);
        for (const h of c.helpers) h.visible = lo < 0 && hi > 0;
      }
    } else for (const h of this.helpers) h.visible = false;
    if (on && this.plane) {
      const n = this.plane.normal;
      const p = this.plane.projectPoint(centre, new THREE.Vector3());
      this.cap.position.copy(p);
      this.cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n.clone().negate());
    }
  }
}
