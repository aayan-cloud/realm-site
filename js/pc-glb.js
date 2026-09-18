import * as THREE from 'three';
import { GLTFLoader } from 'three/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/controls/OrbitControls.js';

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
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f4f2ee');
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.enableZoom = false;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI * 0.53;

  // filled in once the model is measured, so the framing never depends on the export's scale
  let homePos = new THREE.Vector3(8, 5.8, 10.5), homeTarget = new THREE.Vector3(0, 2.5, 0);
  const home = () => {
    camera.position.copy(homePos);
    controls.target.copy(homeTarget);
    controls.update();
  };
  home();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x787568, 1.3));
  function light(pos, intensity, size) {
    const l = new THREE.DirectionalLight(0xffffff, intensity);
    l.position.set(...pos);
    l.castShadow = true;
    l.shadow.mapSize.set(2048, 2048);
    Object.assign(l.shadow.camera, { left: -size, right: size, top: size, bottom: -size, far: 30 });
    l.shadow.normalBias = 0.035;
    scene.add(l);
  }
  light([-3, 8, 5], 2, 9);
  light([5, 6, -3], 1.6, 9);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0xece9e3, roughness: 0.86 })
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
    model.traverse(obj => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
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
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    homeTarget = box.getCenter(new THREE.Vector3());
    const dist = (size.length() / 2) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.95;
    homePos = homeTarget.clone().add(new THREE.Vector3(0.62, 0.42, 0.82).normalize().multiplyScalar(dist));
    camera.near = dist / 200;
    camera.far = dist * 12;
    ground.position.y = box.min.y - 0.002 * size.y;
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
    if (mixer) mixer.setTime(Math.min((v / 119) * clipLength, clipLength - 0.001));
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