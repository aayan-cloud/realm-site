// stage.js — what the engine stands on.
//
// A studio floor, not an invisible catcher: a matte grey sweep lit into a soft
// pool under the engine that falls away into the background with no edge, so the
// shadow has a surface to lie on. The key's shadow on it is held grey rather than
// black (a softbox never leaves a hole, the room fills it) and fades out with
// distance from the sump, as a contact shadow does; right against the sump the
// floor darkens a little more, where the two actually meet.

import * as THREE from 'three';
import { STAND_DROP } from './engine.js';

export function makeFloor(MID, BOX, REACH, bg) {
  const m = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.92, metalness: 0, envMapIntensity: 0.25 });
  const U = {
    uBg: { value: new THREE.Color(bg && bg.isColor ? bg : 0x07070a) },
    uMid: { value: MID.clone() },
    uHalf: { value: new THREE.Vector2((BOX.max.x - BOX.min.x) / 2, (BOX.max.z - BOX.min.z) / 2) },
    uR: { value: REACH * 1.2 },
    uShadow: { value: 0.72 },              // the darkest the key's shadow gets: 1 - 0.72
    uFade: { value: REACH * 0.55 },        // how far from the footprint it has faded out
  };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvFW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const lights = THREE.ShaderChunk.lights_fragment_begin.replace(
      'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )',
      'rhFloorShadow( getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) )');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vFW;
uniform vec3 uBg, uMid;
uniform vec2 uHalf;
uniform float uR, uShadow, uFade;
// distance outside the engine's footprint on the floor (0 inside it)
float rhFoot(){ vec2 q = abs(vFW.xz - uMid.xz) - uHalf; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
float rhFloorShadow(float s){
  float fade = 1.0 - smoothstep(0.0, uFade, max(rhFoot(), 0.0));
  return mix(1.0, s, uShadow * fade);
}`)
      .replace('#include <lights_fragment_begin>', lights)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
{
  // contact: a soft darkening hugging the footprint
  float cd = rhFoot();
  gl_FragColor.rgb *= 1.0 - 0.45 * (1.0 - smoothstep(-0.01, 0.045, cd));
  // the pool falls away into the background with no edge
  float fd = smoothstep(0.18 * uR, uR, length(vFW.xz - uMid.xz));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uBg, fd * fd * (3.0 - 2.0 * fd));
}`);
  };
  m.customProgramCacheKey = () => 'rhFloor';
  const f = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), m);
  f.rotation.x = -Math.PI / 2;
  // the engine stands on its display stand, whose feet lift the lowest point of
  // the engine (the drain plug) STAND_DROP clear of the floor (engine.js)
  f.position.set(MID.x, BOX.min.y - STAND_DROP - 0.0005, MID.z);
  f.receiveShadow = true;
  f.name = 'floor';
  return f;
}
