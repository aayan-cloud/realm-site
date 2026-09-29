// atmos.js — what makes the scene breathe.
//
// Kage's scene is never still: leaves drift, grass moves, cloud scrolls. A single
// turning crank is not enough. These three systems give the engine a life of its
// own without costing anything: embers off the combustion, dust in the light
// shaft, and the shaft itself.

import * as THREE from 'three';

// ---------------------------------------------------------------- embers
// Thrown off the combustion event. They are the only warm light in the scene
// besides the flash itself, which is why the palette can stay almost black.
export function makeEmbers(SPEC, DECK, CYL_X, count = 420) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const spd = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const cyl = CYL_X[i % 4];
    pos[i * 3] = cyl + (Math.random() - 0.5) * 0.075;
    pos[i * 3 + 1] = DECK - 0.01 + Math.random() * 0.02;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 0.07;
    seed[i] = Math.random();
    spd[i] = 0.055 + Math.random() * 0.10;         // m/s, rising
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(spd, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uRise: { value: 0.42 },                       // how far they travel before respawning
      uHeat: { value: 1 },                         // 0 at idle, 1 flat out
      uPixel: { value: 1 },
    },
    vertexShader: `
      attribute float aSeed, aSpeed;
      uniform float uTime, uRise, uHeat, uPixel;
      varying float vLife; varying float vSeed;
      void main(){
        vSeed = aSeed;
        float t = mod(uTime * aSpeed * (0.5 + uHeat) + aSeed * 3.1, uRise);
        vLife = 1.0 - t / uRise;                    // 1 at birth, 0 at death
        vec3 p = position;
        p.y += t;
        // lazy spiral, so they read as hot gas rather than as a rising grid
        p.x += sin(uTime * 0.9 + aSeed * 31.0) * 0.016 * t;
        p.z += cos(uTime * 0.7 + aSeed * 17.0) * 0.013 * t;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // clamp the on-screen size: an ember drifting past the near plane would
        // otherwise divide by a near-zero depth and blow up into a white disc
        gl_PointSize = clamp((1.6 + aSeed * 2.6) * uPixel * (0.4 + 0.6 * uHeat) / max(0.05, -mv.z), 0.0, 9.0);
      }`,
    fragmentShader: `
      precision highp float;
      varying float vLife; varying float vSeed;
      uniform float uHeat;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.02, length(d));
        // hot white at birth, cooling to deep ember as it rises
        vec3 hot = vec3(1.0, 0.86, 0.62);
        vec3 cool = vec3(0.95, 0.28, 0.07);
        vec3 c = mix(hot, cool, pow(1.0 - vLife, 0.55));
        float flick = 0.65 + 0.35 * sin(vSeed * 90.0 + vLife * 40.0);
        // only while the engine is being worked; idling in the dark it throws nothing
        float gate = smoothstep(0.12, 0.22, uHeat);
        gl_FragColor = vec4(c, a * vLife * vLife * flick * (0.25 + 0.75 * uHeat) * gate);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  // Retired: sparks rising off an engine on a stand read as game effects, and they
  // undercut the one claim that matters, that this is a real object. The glow in
  // the chamber and the heat in the header carry the combustion on their own.
  points.visible = false;
  return { object: points, material: mat };
}

// ---------------------------------------------------------------- dust
// Slow, cool, and only visible where the light catches it. This is the shot's
// cheapest depth cue: without it a dark scene has no air in it.
// A few dozen motes, not a field of them: lit points on black read as stars. They
// are drawn as a lens sees dust out of its plane of focus, large, soft and faint,
// so they read as air in a studio rather than as something in the scene.
export function makeDust(count = 900, extent = 1.1) {
  count = Math.min(count, 60);
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * extent * 2;
    pos[i * 3 + 1] = (Math.random() - 0.5) * extent;
    pos[i * 3 + 2] = (Math.random() - 0.5) * extent;
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPixel: { value: 1 } },
    vertexShader: `
      attribute float aSeed;
      uniform float uTime, uPixel;
      varying float vA;
      void main(){
        vec3 p = position;
        p.y += sin(uTime * 0.10 + aSeed * 40.0) * 0.05;
        p.x += cos(uTime * 0.07 + aSeed * 23.0) * 0.04;
        p.z += sin(uTime * 0.05 + aSeed * 61.0) * 0.03;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // out of focus: the disc grows with distance from the engine's plane
        float blur = abs(-mv.z - 1.1) * 18.0 + 6.0;
        float ps = clamp((0.6 + aSeed * 0.8) * blur * uPixel / max(0.05, -mv.z), 3.0, 46.0 * uPixel);
        gl_PointSize = ps;
        // brightest in the middle of the volume, where the shaft is
        // Only near the key light's volume, and faint: after the sRGB encode a full
        // field of motes read as a starfield.
        float rad = length(p.xz) / ${extent.toFixed(2)};
        vA = 0.35 * (1.0 - smoothstep(0.15, 0.7, rad)) * (0.4 + 0.6 * aSeed);
        // and fainter the larger the disc: the same light spread over more of it
        vA *= 6.0 / max(6.0, ps / max(uPixel, 0.1));
      }`,
    fragmentShader: `
      precision highp float;
      varying float vA;
      void main(){
        // a soft disc with a faintly brighter rim, the way defocused highlights draw
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float a = (1.0 - smoothstep(0.75, 1.0, r)) * (0.55 + 0.45 * smoothstep(0.3, 0.95, r));
        gl_FragColor = vec4(vec3(0.62, 0.68, 0.76), a * vA * 0.10);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { object: points, material: mat };
}

// ---------------------------------------------------------------- light shaft
// Light coming down through the opened section. Additive and depth-tested, so the
// engine correctly occludes it and the shaft only exists in the air in front.
export function makeShaft(top, bottom, radius = 0.34) {
  const h = Math.max(0.05, top - bottom);
  const geo = new THREE.CylinderGeometry(radius * 0.55, radius, h, 40, 24, true);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0xffc98a) },
      uStrength: { value: 0.5 },
    },
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main(){
        vUv = uv;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      precision mediump float;
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      uniform float uTime, uStrength; uniform vec3 uColor;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 24634.6345); }
      float noise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
      }
      void main(){
        // fade out toward the floor, and at the very top where the source is
        float v = pow(1.0 - vUv.y, 1.5);
        // grazing angles are where a light shaft actually reads
        float graze = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 1.6);
        // slow drifting motes of density so it is not a clean cone
        float n = noise(vec2(vUv.x * 7.0, vUv.y * 2.2 - uTime * 0.06)) * 0.55 + 0.55;
        // the bottom third fades to nothing, so there is no hard ellipse on the floor
        float a = v * graze * n * uStrength * 0.5 * smoothstep(0.0, 0.35, vUv.y);
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = (top + bottom) / 2;
  mesh.renderOrder = 2;
  // Retired: once the image was encoded properly the cone read as a solid shape
  // with hard edges. The key light's pool on the floor now carries the idea.
  mesh.visible = false;
  return { object: mesh, material: mat };
}

// ---------------------------------------------------------------- glow
// A wide, soft additive card sitting behind the engine. Kage's lantern reads
// because there is a visible source of warmth in the frame; this is the same
// move at a scale that suits a machine.
export function makeGlow(radius = 1.0) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      // a dark, desaturated ember; at the old red it became a backdrop once encoded
      uColor: { value: new THREE.Color(0x3a1208) },
      uStrength: { value: 0.85 },
      uTime: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
      precision mediump float;
      varying vec2 vUv; uniform vec3 uColor; uniform float uStrength, uTime;
      void main(){
        float d = length(vUv - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - d), 2.6);
        a *= 0.85 + 0.15 * sin(uTime * 0.5);
        gl_FragColor = vec4(uColor * a * uStrength * 0.5, a * uStrength * 0.5);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), mat);
  mesh.renderOrder = -1;
  return { object: mesh, material: mat };
}
