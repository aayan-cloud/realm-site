import * as THREE from 'three';
import { GLTFLoader } from 'three/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/environments/RoomEnvironment.js';

/* The white build as a full-bleed stage. Scrolling through the section turns the PC, then pulls
   it apart (the explode is baked into the GLB as an animation), then holds it open. There are no
   controls: the page's own scroll is the scrubber and the mouse only tilts the view a little. */
(() => {
  'use strict';
  const stage = document.getElementById('pc-stage');
  const pin = document.getElementById('pc-pin');
  const canvas = document.getElementById('pc-glb');
  if (!stage || !pin || !canvas) return;
  const readout = document.getElementById('pc-readout');
  const parts = [...document.querySelectorAll('.pc-parts li')];
  const loadBar = document.getElementById('pc-load');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(hover: none)').matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (_) { pin.classList.add('is-nogl'); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.5 : 1.75));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const BG = 0x07080a;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 2.4, 6);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 30);
  // the render scene's two cameras, Blender (x, y, z) -> glTF (x, z, -y)
  const HERO = { pos: new THREE.Vector3(0.8664, 0.4337, 0.6769), target: new THREE.Vector3(0, 0.22, 0) };
  const EXPL = { pos: new THREE.Vector3(1.0835, 0.7106, 1.4884), target: new THREE.Vector3(0.03, 0.22, 0.14) };

  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x0a0b0d, 0.25));
  const light = (pos, intensity, size) => {
    const l = new THREE.DirectionalLight(0xffffff, intensity);
    l.position.set(...pos);
    l.castShadow = true;
    l.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
    Object.assign(l.shadow.camera, { left: -size, right: size, top: size, bottom: -size, far: 30 });
    l.shadow.normalBias = 0.035;
    scene.add(l);
  };
  light([-3, 8, 5], 0.9, 3);
  light([5, 6, -3], 0.5, 3);

  // Floor: a faint grid the fog swallows, and a pool of light under the build.
  const grid = document.createElement('canvas');
  grid.width = grid.height = 128;
  const g2 = grid.getContext('2d');
  g2.fillStyle = '#07080a'; g2.fillRect(0, 0, 128, 128);
  g2.fillStyle = '#15171c'; g2.fillRect(0, 0, 128, 3); g2.fillRect(0, 0, 3, 128);
  const gridTex = new THREE.CanvasTexture(grid);
  gridTex.wrapS = gridTex.wrapT = THREE.RepeatWrapping;
  gridTex.repeat.set(12 / 0.12, 12 / 0.12);
  gridTex.encoding = THREE.sRGBEncoding;
  gridTex.anisotropy = 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.5, metalness: 0, envMapIntensity: 0.2 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const pool = document.createElement('canvas');
  pool.width = pool.height = 256;
  const p2 = pool.getContext('2d');
  const rg = p2.createRadialGradient(128, 128, 0, 128, 128, 128);
  rg.addColorStop(0, 'rgba(255,255,255,0.2)'); rg.addColorStop(0.5, 'rgba(255,255,255,0.05)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
  p2.fillStyle = rg; p2.fillRect(0, 0, 256, 256);
  const poolMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(pool), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  poolMesh.rotation.x = -Math.PI / 2;
  scene.add(poolMesh);

  // Load the GLB. The explode is baked as an animation: frame 1 assembled, frame 61 apart.
  let model = null, mixer = null, clipLength = 1;
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.149.0/examples/jsm/libs/draco/');
  loader.setDRACOLoader(draco);
  loader.load('./assets/build.glb', gltf => {
    model = gltf.scene;
    // the RGB parts carry their hue as vertex colour; unlit basic material = the glow of the renders
    const PASTEL = new Set(['rgb_x', 'rgb_y', 'rgb_z', 'rgb_ring', 'glow_blade']);
    const GLOW = new Set(['rgb_x', 'rgb_y', 'rgb_z', 'rgb_ring', 'glow_blade', 'cool_digits', 'bar_rgb', 'lcd_grad', 'screen_txt', 'screen_cyan']);
    // scene.py perforated(): hole every `pitch` on two object axes (Blender XZ -> glTF xy, XY -> xz)
    const PERF = { perf_white_xz: [0.004, 'xy', 0.33], perf_white_xy: [0.005, 'xz', 0.33], perf_grille_xz: [0.0045, 'xy', 0.36] };
    model.traverse(obj => {
      if (!obj.isMesh) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      const wasArray = Array.isArray(obj.material);        // a single-material mesh must stay single: an
      const mats = wasArray ? obj.material : [obj.material];  // array with no geometry groups draws nothing
      const next = mats.map(m => {
        const p = PERF[m.name];
        if (p) {
          m.side = THREE.DoubleSide;
          m.onBeforeCompile = sh => {
            sh.vertexShader = sh.vertexShader
              .replace('#include <common>', '#include <common>\nvarying vec3 vObj;')
              .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position;');
            sh.fragmentShader = sh.fragmentShader
              .replace('#include <common>', '#include <common>\nvarying vec3 vObj;')
              .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
                vec2 cell = fract(vObj.${p[1]} / ${p[0].toFixed(5)}) - 0.5;
                if (dot(cell, cell) < ${(p[2] * p[2]).toFixed(4)}) discard;`);
          };
          m.needsUpdate = true;
        }
        if (!GLOW.has(m.name)) {          // only the RGB parts use the baked colour layer
          m.vertexColors = false;
          return m;
        }
        const lit = new THREE.MeshBasicMaterial({ name: m.name, vertexColors: true, toneMapped: false, fog: false });
        if (PASTEL.has(m.name)) {       // the renders' AgX look washes bright RGB toward white
          lit.onBeforeCompile = sh => {
            sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>',
              '#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), 0.38);');
          };
        }
        if (m.name === 'screen_txt' || m.name === 'screen_cyan') {
          lit.vertexColors = false;
          lit.color.copy(m.emissive && m.emissive.getHex() ? m.emissive : m.color);
        }
        return lit;
      });
      obj.material = wasArray ? next : next[0];
    });
    mixer = new THREE.AnimationMixer(model);
    gltf.animations.forEach(clip => {
      clipLength = Math.max(clipLength, clip.duration);
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);     // without this the last frame wraps back to assembled
      action.clampWhenFinished = true;
      action.play();
    });
    mixer.setTime(1 / 30);
    scene.add(model);
    const box = new THREE.Box3().setFromObject(model);
    ground.position.y = box.min.y - 0.001;
    poolMesh.position.y = box.min.y;
    pin.classList.add('is-ready');
    resize();
    if (!running) start();
  }, xhr => {
    if (loadBar && xhr.total) loadBar.style.transform = `scaleX(${(xhr.loaded / xhr.total).toFixed(3)})`;
  }, err => {
    pin.classList.add('is-nogl');
    console.error(err);
  });

  // Scroll progress 0..1 across the tall section, smoothed so the model glides instead of stepping.
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const ease = t => 1 - Math.pow(1 - t, 3);
  const UP = new THREE.Vector3(0, 1, 0);
  const camPos = new THREE.Vector3(), camTarget = new THREE.Vector3(), off = new THREE.Vector3();
  let target = 0, cur = reduced ? 0.8 : 0, mx = 0, my = 0, px = 0, py = 0, fit = 1, running = false, visible = false, lastLabel = '';

  function progress() {
    const r = stage.getBoundingClientRect();
    target = clamp(-r.top / Math.max(1, r.height - innerHeight), 0, 1);
    if (reduced) target = 0.8;
  }
  function apply(t) {
    const p = cur;
    const turn = ease(smooth(0, 0.42, p));
    const open = smooth(0.42, 0.9, p);
    const cam = ease(smooth(0.34, 0.66, p));
    if (model) model.rotation.y = turn * Math.PI * 2 + (coarse || reduced ? 0 : Math.sin(t * 0.45) * 0.02) + px * 0.03;
    if (mixer) mixer.setTime(clamp((1 + 60 * open) / 30, 1 / 30, clipLength - 0.0005));
    camTarget.lerpVectors(HERO.target, EXPL.target, cam);
    camPos.lerpVectors(HERO.pos, EXPL.pos, cam);
    off.subVectors(camPos, camTarget).multiplyScalar(fit);   // back off on tall screens so the build stays in frame
    off.applyAxisAngle(UP, -px * 0.025);                      // a hint of tilt from the mouse, no more
    off.y += py * 0.015 * off.length();
    camera.position.addVectors(camTarget, off);
    camera.lookAt(camTarget);
    const label = p < 0.4 ? 'Turning' : p < 0.9 ? 'Coming apart' : 'Every part, modelled';
    if (readout && label !== lastLabel) { readout.textContent = label; lastLabel = label; pin.classList.toggle('is-end', p >= 0.9); }
    parts.forEach(li => li.classList.toggle('is-on', p >= +li.dataset.at));
  }
  function tick(now) {
    if (!visible) { running = false; return; }
    progress();
    cur += (target - cur) * 0.11;
    px += (mx - px) * 0.06;
    py += (my - py) * 0.06;
    apply(now * 0.001);
    renderer.render(scene, camera);
    if (reduced) { running = false; return; }
    requestAnimationFrame(tick);
  }
  function start() { running = true; requestAnimationFrame(tick); }

  function resize() {
    const w = pin.clientWidth, h = pin.clientHeight, aspect = w / h;
    // the renders framed the build in a square at 39.6 degrees; keep that horizontal reach on any shape
    const want = Math.tan(THREE.MathUtils.degToRad(39.6 / 2));
    const fov = aspect < 1 ? Math.min(58, THREE.MathUtils.radToDeg(2 * Math.atan(want / aspect))) : 36;
    const half = Math.tan(THREE.MathUtils.degToRad(fov / 2)) * aspect;
    fit = Math.max(1, want / half);
    camera.fov = fov;
    camera.aspect = aspect;
    // the build sits right of the headline on wide screens and below it on phones
    camera.setViewOffset(w, h, aspect >= 1.05 ? -w * 0.16 : 0, aspect >= 1.05 ? 0 : -h * 0.07, w, h);
    const nav = document.getElementById('nav');
    if (nav) pin.style.setProperty('--nav-h', nav.offsetHeight + 'px');   // the sticky header sits over the stage
    camera.updateProjectionMatrix();
    scene.fog.near = 2.4 * fit;
    scene.fog.far = 6 * fit;
    renderer.setSize(w, h, false);
    progress();
    if (reduced || !running) { cur = target; apply(0); renderer.render(scene, camera); }
  }
  addEventListener('resize', resize);
  resize();

  pin.addEventListener('pointermove', e => {
    if (coarse) return;
    mx = (e.clientX / pin.clientWidth - 0.5) * 2;
    my = (e.clientY / pin.clientHeight - 0.5) * 2;
  });
  pin.addEventListener('pointerleave', () => { mx = 0; my = 0; });

  new IntersectionObserver(entries => {
    visible = entries.some(e => e.isIntersecting);
    if (visible && !running) start();
  }, { rootMargin: '60%' }).observe(stage);
})();
