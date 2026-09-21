import * as THREE from 'three';
import { GLTFLoader } from 'three/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/environments/RoomEnvironment.js';

(() => {
  'use strict';
  const stage = document.getElementById('pc-scroll');
  const canvas = document.getElementById('pc-glb');
  const media = document.querySelector('.pc-media');
  const slider = document.getElementById('pc-scrub');
  const label = document.getElementById('pc-view-label');
  const phaseEl = document.getElementById('pc-phase');
  const progressEl = document.getElementById('pc-progress');
  if (!stage || !canvas || !slider || !label) return;

  // Scene setup
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b0c0e');     // the renders are shot on a dark studio floor
  // the render camera: 50 mm lens on a 36 mm sensor, square frame -> 39.6 degrees
  const camera = new THREE.PerspectiveCamera(39.6, 1, 0.01, 20);
  // scene.py cameras, converted from Blender (x, y, z) to glTF (x, z, -y)
  const HERO = { pos: new THREE.Vector3(0.8664, 0.4337, 0.6769), target: new THREE.Vector3(0, 0.22, 0) };      // orbit(38, 11, 1.12)
  const EXPL = { pos: new THREE.Vector3(1.0835, 0.7106, 1.4884), target: new THREE.Vector3(0.03, 0.22, 0.14) }; // orbit(52, 16, 1.78)
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.enableZoom = false;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI * 0.53;

  const aim = cam => {
    camera.position.copy(cam.pos);
    controls.target.copy(cam.target);
    controls.update();
  };
  const home = () => aim(HERO);
  let modelRoot = null;
  home();

  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x0a0b0d, 0.2));
  function light(pos, intensity, size) {
    const l = new THREE.DirectionalLight(0xffffff, intensity);
    l.position.set(...pos);
    l.castShadow = true;
    l.shadow.mapSize.set(2048, 2048);
    Object.assign(l.shadow.camera, { left: -size, right: size, top: size, bottom: -size, far: 30 });
    l.shadow.normalBias = 0.035;
    scene.add(l);
  }
  light([-3, 8, 5], 0.9, 3);
  light([5, 6, -3], 0.5, 3);

  const grid = document.createElement('canvas');
  grid.width = grid.height = 128;
  const g2 = grid.getContext('2d');
  g2.fillStyle = '#0a0b0e'; g2.fillRect(0, 0, 128, 128);
  g2.fillStyle = '#1b1e24'; g2.fillRect(0, 0, 128, 3); g2.fillRect(0, 0, 3, 128);
  const gridTex = new THREE.CanvasTexture(grid);
  gridTex.wrapS = gridTex.wrapT = THREE.RepeatWrapping;
  gridTex.repeat.set(8 / 0.12, 8 / 0.12);
  gridTex.encoding = THREE.sRGBEncoding;
  gridTex.anisotropy = 8;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.4, metalness: 0, envMapIntensity: 0.25 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.025;
  ground.receiveShadow = true;
  scene.add(ground);

  // Load GLB: the explode is baked as animation, frame 1 assembled to frame 61 apart
  let mixer = null, clipLength = 1;
  let ready = false;

  const loader = new GLTFLoader();
  const draco = new DRACOLoader();      // draco-compressed export from the render scene
  draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.149.0/examples/jsm/libs/draco/');
  loader.setDRACOLoader(draco);
  loader.load('./assets/build.glb', gltf => {
    const model = gltf.scene;
    scene.add(model);
    // the RGB parts carry their hue as vertex colour; unlit basic material = the glow of the renders
    const PASTEL = new Set(['rgb_x', 'rgb_y', 'rgb_z', 'rgb_ring', 'glow_blade']);
    const GLOW = new Set(['rgb_x', 'rgb_y', 'rgb_z', 'rgb_ring', 'glow_blade', 'cool_digits', 'bar_rgb', 'lcd_grad', 'screen_txt', 'screen_cyan']);
    model.traverse(obj => {
      if (!obj.isMesh) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      const wasArray = Array.isArray(obj.material);        // a single-material mesh must stay single: an
      const mats = wasArray ? obj.material : [obj.material];  // array with no geometry groups draws nothing
      const next = mats.map(m => {
        if (!GLOW.has(m.name)) {          // only the RGB parts use the baked colour layer
          m.vertexColors = false;
          return m;
        }
        const lit = new THREE.MeshBasicMaterial({ name: m.name, vertexColors: true, toneMapped: false });
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
    // scene.py perforated(): hole every `pitch` on two object axes (Blender XZ -> glTF xy, XY -> xz)
    const PERF = { perf_white_xz: [0.004, 'xy', 0.33], perf_white_xy: [0.005, 'xz', 0.33], perf_grille_xz: [0.0045, 'xy', 0.36] };
    model.traverse(obj => {
      if (!obj.isMesh) return;
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(m => {
        const p = PERF[m.name];
        if (!p) return;
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
      });
    });
    mixer = new THREE.AnimationMixer(model);
    gltf.animations.forEach(clip => {
      clipLength = Math.max(clipLength, clip.duration);
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);     // without this the last frame wraps back to assembled
      action.clampWhenFinished = true;
      action.play();
    });
    mixer.setTime(0);
    modelRoot = model;
    const box = new THREE.Box3().setFromObject(model);
    ground.position.y = box.min.y - 0.001;
    home();
    ready = true;
    label.textContent = 'THE BUILD / ' + gltf.animations.length + ' MOVING PARTS';
    resize();
    update();
  }, undefined, err => {
    label.textContent = 'Model load failed - ' + err.message;
    console.error(err);
  });

  function render() { renderer.render(scene, camera); }
  function resize() {
    // size to the canvas's own box, not the tall scroll section, or the model renders off-frame
    const w = media.clientWidth || canvas.clientWidth;
    const h = media.clientHeight || Math.round(w * 0.75);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    render();
  }
  addEventListener('resize', resize);
  resize();
  controls.addEventListener('change', render);

  // Animation loop for orbit damping
  let animating = false;
  function animate() {
    if (!animating) return;
    controls.update();
    render();
    requestAnimationFrame(animate);
  }
  function startAnim() { if (!animating) { animating = true; animate(); } }
  function stopAnim() { animating = false; }

  // Hover-only wheel scrubbing
  let wheelPosition = 0;
  stage.classList.add('pc-hover-scroll');

  stage.addEventListener('wheel', e => {
    if (e.ctrlKey || !e.deltaY) return;
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1);
    const next = THREE.MathUtils.clamp(wheelPosition + delta / 18, 0, 119);
    if (next === wheelPosition) return;
    e.preventDefault();
    wheelPosition = next;
    slider.value = wheelPosition;
    update();
  }, { passive: false });

  // Slider and reset
  function update() {
    const v = THREE.MathUtils.clamp(Math.round(Number(slider.value)), 0, 119);
    wheelPosition = v;
    // same split as the render frames: 72 turntable steps, then 48 explode steps from the explode camera
    const turning = v < 72;
    if (modelRoot) modelRoot.rotation.y = turning ? (v / 72) * Math.PI * 2 : 0;
    if (mixer) mixer.setTime(Math.min(turning ? 1 / 30 : (1 + 60 * (v - 72) / 47) / 30, clipLength - 0.0005));
    aim(turning ? HERO : EXPL);
    label.textContent = v < 72 ? 'Rotation' : 'Exploded view';
    phaseEl.textContent = v < 72 ? '01' : '02';
    progressEl.textContent = String(v + 1).padStart(3, '0') + ' / 120';
    render();
  }
  slider.addEventListener('input', update);
  document.getElementById('pc-reset').addEventListener('click', () => {
    slider.value = 0;
    update();
    home();
  });

  // Keyboard controls
  stage.addEventListener('keydown', e => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      let v = Number(slider.value);
      if (e.key === 'ArrowLeft') v = Math.max(0, v - 1);
      else if (e.key === 'ArrowRight') v = Math.min(119, v + 1);
      else if (e.key === 'Home') v = 0;
      else if (e.key === 'End') v = 119;
      slider.value = v;
      update();
    }
  });

  // Touch/mouse enter/exit to start/stop orbit damping loop
  stage.addEventListener('mouseenter', startAnim);
  stage.addEventListener('mouseleave', stopAnim);
  stage.addEventListener('touchstart', startAnim, { passive: true });

  // Preload
  let preloaded = false;
  const observer = new IntersectionObserver(entries => {
    if (preloaded || !entries.some(e => e.isIntersecting)) return;
    preloaded = true;
    // GLB already loaded, nothing more to preload
    observer.disconnect();
  }, { rootMargin: '700px' });
  observer.observe(stage);

  update();
})();