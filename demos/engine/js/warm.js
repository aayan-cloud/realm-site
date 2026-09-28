// warm.js — every shader compiled before the first frame, without freezing the page.
//
// three r149 compiles a program the first time it draws with it, and it asks the
// driver for the result straight away, so the page's main thread waits for each
// compile in turn. On a cold GPU cache under Windows' D3D11 backend that was
// ~2.9 s in one frame for this scene, and inside a same-origin iframe it froze the
// host page for as long.
//
// Browsers can compile in the background (KHR_parallel_shader_compile); the page
// only waits if it asks too early. So before the first frame, a throwaway renderer
// sharing the same WebGL context works out the exact source three will build for
// every material in the scene, and starts each link without waiting for it. It is
// stopped right after the link call (it throws), so it never asks. When the links
// report complete, the real renderer builds the same programs, and the driver's
// program cache hands them back in a few milliseconds each.
//
// If the extension is missing, nothing changes: the first frame compiles as before.

import * as THREE from 'three';

const STOP = { warm: 'stop' };

export function prewarm(renderer, scene, camera, extra = []) {
  const gl = renderer.getContext();
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  const job = { done: false, programs: 0, ms: 0 };
  if (!ext || !renderer.capabilities.isWebGL2) { job.done = true; return job; }
  const t0 = performance.now();

  // ---- the throwaway renderer: same context, same settings
  const W = new THREE.WebGLRenderer({ canvas: renderer.domElement, context: gl });
  W.outputEncoding = renderer.outputEncoding;
  W.toneMapping = renderer.toneMapping;
  W.toneMappingExposure = renderer.toneMappingExposure;
  W.physicallyCorrectLights = renderer.physicallyCorrectLights;
  W.localClippingEnabled = renderer.localClippingEnabled;
  W.shadowMap.enabled = renderer.shadowMap.enabled;
  W.shadowMap.type = renderer.shadowMap.type;
  W.debug.checkShaderErrors = false;
  const rt = new THREE.WebGLRenderTarget(1, 1);   // the scene is drawn into a target, so linear output

  // ---- a scene with the same lights and environment, and one stand-in object
  // per distinct program. A one-triangle geometry is enough: none of these
  // programs depend on the geometry beyond position, normal and uv.
  const mini = new THREE.Scene();
  mini.environment = scene.environment;
  const lights = [];
  scene.traverseVisible(o => { if (o.isLight) { const c = o.clone(); if (c.shadow) c.shadow.mapSize.set(1, 1); lights.push(c); mini.add(c); } });
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  tri.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));

  const seen = new Set(), stand = [];
  const sig = (o, m) => [o.isInstancedMesh, o.isPoints, m.type, m.customProgramCacheKey(), m.clippingPlanes ? m.clippingPlanes.length : 0,
    m.side, m.transparent, m.vertexColors, m.toneMapped, m.isShaderMaterial ? m.vertexShader.length + ':' + m.fragmentShader.length : '',
    o.castShadow && m.clipShadows].join('|');
  const add = (o, m) => {
    const k = sig(o, m);
    if (seen.has(k)) return;
    seen.add(k);
    const p = o.isInstancedMesh ? new THREE.InstancedMesh(tri, m, 1) : o.isPoints ? new THREE.Points(tri, m) : new THREE.Mesh(tri, m);
    p.frustumCulled = false;
    stand.push({ p, shadow: !!o.castShadow });
  };
  scene.traverse(o => { if (o.material) for (const m of [].concat(o.material)) add(o, m); });
  for (const m of extra) add(new THREE.Mesh(), m);

  // ---- stop each build right after its link call, and start the link only once
  const pending = new Map();
  let vs = '', fs = '';
  const src = gl.shaderSource, link = gl.linkProgram;
  gl.shaderSource = function (sh, s) { if (gl.getShaderParameter(sh, gl.SHADER_TYPE) === gl.VERTEX_SHADER) vs = s; else fs = s; return src.call(gl, sh, s); };
  gl.linkProgram = function (p) {
    const key = vs + '\u0000' + fs;
    if (!pending.has(key)) { link.call(gl, p); pending.set(key, p); } else gl.deleteProgram(p);
    throw STOP;
  };
  const tryRender = () => {
    try { W.setRenderTarget(rt); W.render(mini, camera); return false; } catch (e) { if (e !== STOP) throw e; return true; }
  };
  // Each stand-in is drawn until it builds nothing new: first its shadow (depth)
  // program if it casts one, then its own. A few per tick, so no task runs long.
  const queue = stand.slice();
  const restore = () => { gl.shaderSource = src; gl.linkProgram = link; };
  const tick = () => {
    const t = performance.now();
    try {
      while (queue.length && performance.now() - t < 12) {
        const { p, shadow } = queue.shift();
        mini.add(p);
        if (shadow) { p.castShadow = true; tryRender(); p.castShadow = false; }
        tryRender();
        mini.remove(p);
      }
    } catch (e) {
      // anything unexpected: put the context back and let the first frame compile
      restore();
      renderer.resetState();
      job.done = true;
      console.warn('[warm] skipped:', e && e.message);
      return;
    }
    renderer.resetState();
    if (queue.length) setTimeout(tick, 0);
    else { restore(); job.programs = pending.size; poll(); }
  };
  const finish = () => {
    for (const p of pending.values()) {
      gl.getProgramParameter(p, gl.LINK_STATUS);      // resolves the link, so the driver keeps the binary
      for (const s of gl.getAttachedShaders(p) || []) gl.deleteShader(s);
      gl.deleteProgram(p);
    }
    rt.dispose();
    for (const l of lights) if (l.shadow && l.shadow.map) l.shadow.map.dispose();
    tri.dispose();
    W.dispose();
    renderer.resetState();
    job.ms = Math.round(performance.now() - t0);
    job.done = true;
  };
  // setTimeout, not requestAnimationFrame: a frame that starts off screen on the
  // host page gets no animation frames, and the warm-up should still finish
  const poll = () => {
    let all = true;
    for (const p of pending.values()) if (!gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR)) { all = false; break; }
    if (all || performance.now() - t0 > 8000) finish(); else setTimeout(poll, 16);
  };
  tick();
  return job;
}
