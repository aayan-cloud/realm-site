// post.js — the lens and the film stock.
//
// three r149 has no EffectComposer in the vendored set, so the chain is built here:
//   scene (MSAA, depth + stencil)  ->  ambient occlusion from the resolved depth
//   -> bright pass -> two-scale blur -> composite: bloom, exposure, vignette,
//   the sRGB encode, then grain and a lift in the blacks.
//
// Two things matter more than they sound. The scene target is linear: three tone-
// maps into it but only encodes to sRGB when drawing to the canvas, so the encode
// has to happen here or every midtone is crushed. And the occlusion reads the
// depth the scene actually drew, clipping and section caps included, so the half
// of the casting that has been cut away never darkens the half that is left.

import * as THREE from 'three';
import { prewarm } from './warm.js';
import { BIAS } from './caps.js';

const QUAD = new THREE.PlaneGeometry(2, 2);
const QUAD_CAM = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function fsMaterial(fragment, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: `
      in vec3 position; in vec2 uv; out vec2 vUv;
      void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }`,
    fragmentShader: `
      precision highp float;
      in vec2 vUv; out vec4 fragColor;
      uniform sampler2D tDiffuse;
      ${fragment}`,
    depthTest: false, depthWrite: false,
  });
}

const DEPTH_FN = /* glsl */`
  uniform sampler2D tDepth;
  uniform mat4 uProjInv;
  vec3 viewPos(vec2 uv){
    float d = textureLod(tDepth, uv, 0.0).x;
    vec4 p = uProjInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
  }`;

export class Post {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.bloomStrength = opts.bloom ?? 0.85;
    this.grain = opts.grain ?? 0.03;
    this.vignette = opts.vignette ?? 0.62;
    this.aberration = opts.aberration ?? 0.0016;
    this.exposure = 1.0;
    this.enabled = true;
    this.aoEnabled = opts.ao ?? true;
    this.sceneInfo = { calls: 0, triangles: 0 };
    this.ready = false;             // true once a full engine frame has been drawn
    this.renderScale = 1;
    this.quality = 'full';

    const coarse = matchMedia('(pointer: coarse)').matches;
    this.coarse = coarse;
    this.samples = renderer.capabilities.isWebGL2 ? ((devicePixelRatio > 1.5 || coarse) ? 2 : 4) : 0;

    this.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedInt248Type);
    this.depthTexture.format = THREE.DepthStencilFormat;
    this.rtScene = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: true,
      samples: this.samples, depthTexture: this.depthTexture,
    });
    const half = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType, depthBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(1, 1, half);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, half);
    this.rtAO = new THREE.WebGLRenderTarget(1, 1, half);
    this.rtAO2 = new THREE.WebGLRenderTarget(1, 1, half);

    // ---- scalable ambient obscurance, from resolved depth. 12 spiral taps with a
    // world-space radius, so the contact shadow is the same size at every zoom.
    this.aoMat = fsMaterial(`
      ${DEPTH_FN}
      uniform vec2 uTexel;
      uniform float uRadius, uBias, uIntensity, uPower, uProjScale;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){
        float d = texture(tDepth, vUv).x;
        if (d >= 1.0) { fragColor = vec4(1.0); return; }
        vec3 P = viewPos(vUv);
        vec3 N = normalize(cross(dFdx(P), dFdy(P)));
        float rPx = uRadius * uProjScale / -P.z;          // radius in pixels
        rPx = min(rPx, 90.0);
        float rot = hash(gl_FragCoord.xy) * 6.2831853;
        float occ = 0.0;
        const int TAPS = 12;
        for (int i = 0; i < TAPS; i++) {
          float a = (float(i) + 0.5) / float(TAPS);
          float ang = a * 7.0 * 6.2831853 + rot;
          vec2 off = vec2(cos(ang), sin(ang)) * a * rPx * uTexel;
          vec3 Q = viewPos(vUv + off);
          vec3 v = Q - P;
          float vv = dot(v, v);
          float vn = dot(v, N);
          float f = max(uRadius * uRadius - vv, 0.0) / (uRadius * uRadius);
          occ += f * f * f * max((vn - uBias) / (0.01 * uRadius + vv), 0.0) * uRadius;
        }
        occ = max(0.0, 1.0 - uIntensity * occ * (5.0 / float(TAPS)));
        fragColor = vec4(vec3(pow(occ, uPower)), 1.0);
      }`, {
      tDepth: { value: this.depthTexture }, uProjInv: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() }, uRadius: { value: 0.025 }, uBias: { value: 0.002 },
      uIntensity: { value: 0.9 }, uPower: { value: 1.4 }, uProjScale: { value: 500 },
      tDiffuse: { value: null },
    });
    // depth-aware blur, so occlusion does not bleed across silhouettes
    this.aoBlurMat = fsMaterial(`
      ${DEPTH_FN}
      uniform vec2 uDir;
      void main(){
        float z0 = viewPos(vUv).z;
        float sum = 0.0, wsum = 0.0;
        for (int i = -2; i <= 2; i++) {
          vec2 uv = vUv + uDir * float(i);
          float z = viewPos(uv).z;
          float w = (3.0 - abs(float(i))) * exp(-abs(z - z0) * 180.0);
          sum += textureLod(tDiffuse, uv, 0.0).r * w; wsum += w;
        }
        fragColor = vec4(vec3(sum / max(wsum, 1e-4)), 1.0);
      }`, { tDiffuse: { value: null }, tDepth: { value: this.depthTexture }, uProjInv: { value: new THREE.Matrix4() }, uDir: { value: new THREE.Vector2() } });

    this.brightMat = fsMaterial(`
      uniform sampler2D tAO;
      uniform float uThreshold, uSoft, uUseAO;
      void main(){
        vec3 c = texture(tDiffuse, vUv).rgb * mix(1.0, texture(tAO, vUv).r, uUseAO);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // soft knee, so the bloom does not pop on as things cross the threshold
        float k = smoothstep(uThreshold, uThreshold + uSoft, l);
        fragColor = vec4(c * k, 1.0);
      }`, {
      tDiffuse: { value: null }, tAO: { value: null }, uUseAO: { value: 1 },
      uThreshold: { value: opts.threshold ?? 0.8 },
      uSoft: { value: 0.3 },
    });

    this.blurMat = fsMaterial(`
      uniform vec2 uDir;
      void main(){
        // 9-tap gaussian, linear-sampled to 5 fetches
        vec3 s = texture(tDiffuse, vUv).rgb * 0.2270270270;
        vec2 o1 = uDir * 1.3846153846;
        vec2 o2 = uDir * 3.2307692308;
        s += (texture(tDiffuse, vUv + o1).rgb + texture(tDiffuse, vUv - o1).rgb) * 0.3162162162;
        s += (texture(tDiffuse, vUv + o2).rgb + texture(tDiffuse, vUv - o2).rgb) * 0.0702702703;
        fragColor = vec4(s, 1.0);
      }`, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } });

    this.compMat = fsMaterial(`
      uniform sampler2D tBloom, tAO;
      uniform float uBloom, uGrain, uVignette, uAberr, uTime, uExposure, uUseAO;
      uniform vec3 uLift;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
      void main(){
        vec2 uv = vUv;
        vec2 d = uv - 0.5;
        float r2 = dot(d, d);
        // chromatic aberration, scaled by distance from centre like a real lens
        vec2 off = d * uAberr * (0.35 + r2 * 3.0);
        vec3 col;
        col.r = texture(tDiffuse, uv + off).r;
        col.g = texture(tDiffuse, uv).g;
        col.b = texture(tDiffuse, uv - off).b;
        col *= mix(1.0, texture(tAO, uv).r, uUseAO);
        col += texture(tBloom, uv).rgb * uBloom;
        col *= uExposure;
        col *= 1.0 - uVignette * smoothstep(0.18, 0.78, r2);
        // linear -> sRGB, the exact curve
        col = clamp(col, 0.0, 1.0);
        col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));
        // film grain after the encode, weighted to the midtones the way stock is
        float g = hash(uv * vec2(1024.0, 768.0) + fract(uTime) * 91.7) - 0.5;
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col += g * uGrain * (0.35 + 2.6 * lum * (1.0 - lum));
        // a lift in the blacks, so shadows read as air rather than holes
        col = max(col, uLift);
        fragColor = vec4(col, 1.0);
      }`, {
      tDiffuse: { value: null }, tBloom: { value: null }, tAO: { value: null }, uUseAO: { value: 1 },
      uBloom: { value: this.bloomStrength },
      uGrain: { value: this.grain },
      uVignette: { value: this.vignette },
      uAberr: { value: this.aberration },
      uTime: { value: 0 },
      uExposure: { value: 1.0 },
      uLift: { value: new THREE.Vector3(0.022, 0.022, 0.027) },
    });

    this.quad = new THREE.Mesh(QUAD, this.brightMat);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.white.needsUpdate = true;
  }

  // A governor for slow devices. If frames run long for a sustained stretch, it
  // steps quality down once per stretch, in the order that costs the picture
  // least: occlusion off, then the scene pass drawn at 80 %, then at 65 %, with
  // the composite scaling it back up. It never steps back up, so it cannot hunt.
  // Hidden tabs and hitches are ignored: only intervals under 250 ms count.
  _govern(now) {
    const dt = this._last ? now - this._last : 0;
    this._last = now;
    if (!(dt > 0 && dt < 250)) return;
    this._ema = this._ema ? this._ema * 0.95 + dt * 0.05 : dt;
    this._since = (this._since || 0) + dt;
    if (this._since < 2000 || this._ema < 24) return;            // under ~42 fps for 2 s
    this._since = 0;
    if (this.aoActive) { this.aoEnabled = false; this.aoActive = false; this.quality = 'no-ao'; return; }
    const next = this.renderScale > 0.9 ? 0.8 : this.renderScale > 0.7 ? 0.65 : 0;
    if (next && this._size) { this.renderScale = next; this.quality = 'scale-' + next; this.setSize(...this._size); }
  }

  setSize(w, h, dpr) {
    this._size = [w, h, dpr];
    const s = this.renderScale;
    const W = Math.max(1, Math.floor(w * dpr * s)), H = Math.max(1, Math.floor(h * dpr * s));
    this.rtScene.setSize(W, H);
    this.depthTexture.image.width = W; this.depthTexture.image.height = H;
    const bw = Math.max(1, Math.floor(W / 4)), bh = Math.max(1, Math.floor(H / 4));
    this.rtA.setSize(bw, bh);
    this.rtB.setSize(bw, bh);
    this._bw = bw; this._bh = bh;
    const aw = Math.max(1, Math.floor(W / 2)), ah = Math.max(1, Math.floor(H / 2));
    this.rtAO.setSize(aw, ah); this.rtAO2.setSize(aw, ah);
    this._aw = aw; this._ah = ah;
    // occlusion is skipped on short frames and on touch devices
    this.aoActive = this.aoEnabled && !this.coarse && h >= 420;
  }

  _draw(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, QUAD_CAM);
  }

  render(scene, camera, time) {
    const r = this.renderer;
    // Until every shader has compiled in the background (warm.js), draw only the
    // ground colour: the first full frame then costs cache hits, not a freeze.
    if (!this.ready) {
      if (!this._warm) this._warm = prewarm(r, scene, camera, [this.aoMat, this.aoBlurMat, this.brightMat, this.blurMat, this.compMat]);
      if (!this._warm.done) {
        r.setRenderTarget(null);
        if (scene.background && scene.background.isColor) r.setClearColor(scene.background, 1);
        r.clear();
        return;
      }
    }
    this._govern(performance.now());
    if (!this.enabled) {
      r.setRenderTarget(null);
      r.state.buffers.stencil.setClear(BIAS);
      r.render(scene, camera);
      return;
    }
    r.setRenderTarget(this.rtScene);
    // the section's stencil count starts from a bias, so a cavity can go below it
    r.state.buffers.stencil.setClear(BIAS);
    r.clear();
    r.render(scene, camera);
    this.sceneInfo.calls = r.info.render.calls;
    this.sceneInfo.triangles = r.info.render.triangles;

    let ao = this.white;
    if (this.aoActive) {
      const u = this.aoMat.uniforms;
      u.uProjInv.value.copy(camera.projectionMatrixInverse);
      u.uTexel.value.set(1 / this._aw, 1 / this._ah);
      // pixels per metre at unit depth, at the occlusion target's resolution
      // (read off the projection, which the page may have scaled to fit the stage)
      u.uProjScale.value = camera.projectionMatrix.elements[5] * this._ah / 2;
      this._draw(this.aoMat, this.rtAO);
      const b = this.aoBlurMat.uniforms;
      b.uProjInv.value.copy(camera.projectionMatrixInverse);
      b.tDiffuse.value = this.rtAO.texture; b.uDir.value.set(1 / this._aw, 0);
      this._draw(this.aoBlurMat, this.rtAO2);
      b.tDiffuse.value = this.rtAO2.texture; b.uDir.value.set(0, 1 / this._ah);
      this._draw(this.aoBlurMat, this.rtAO);
      ao = this.rtAO.texture;
    }

    this.brightMat.uniforms.tDiffuse.value = this.rtScene.texture;
    this.brightMat.uniforms.tAO.value = ao;
    this._draw(this.brightMat, this.rtA);

    this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
    this.blurMat.uniforms.uDir.value.set(1 / this._bw, 0);
    this._draw(this.blurMat, this.rtB);
    this.blurMat.uniforms.tDiffuse.value = this.rtB.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1 / this._bh);
    this._draw(this.blurMat, this.rtA);
    // second, wider pass so the glow has a long tail rather than a tight halo
    this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
    this.blurMat.uniforms.uDir.value.set(2.4 / this._bw, 0);
    this._draw(this.blurMat, this.rtB);
    this.blurMat.uniforms.tDiffuse.value = this.rtB.texture;
    this.blurMat.uniforms.uDir.value.set(0, 2.4 / this._bh);
    this._draw(this.blurMat, this.rtA);

    const c = this.compMat.uniforms;
    c.tDiffuse.value = this.rtScene.texture;
    c.tBloom.value = this.rtA.texture;
    c.tAO.value = ao;
    c.uTime.value = time;
    c.uBloom.value = this.bloomStrength;
    c.uGrain.value = this.grain;
    c.uVignette.value = this.vignette;
    c.uExposure.value = this.exposure;
    this._draw(this.compMat, null);
    if (!this.ready) { this.ready = true; this.readyAt = Math.round(performance.now()); }
  }
}
