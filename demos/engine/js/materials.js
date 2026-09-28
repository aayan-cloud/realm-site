// materials.js — what each part is made of.
//
// No image files. The surface detail that separates a sand casting from a ground
// journal (speckle, pitting, turning marks, honing, wrinkle paint, forging scale)
// is evaluated in the shader from 3D value noise in the part's own space, so it
// sticks to the part as it moves and it costs no download. Detail below about two
// pixels is faded out by its own screen footprint rather than left to shimmer.
//
// ONE shader program for every metal, paint and plastic. Which finish a material
// has is a uniform, not a #define, so the whole engine compiles to one program
// (one more for the instanced valvetrain and bolts, one for the see-through
// accessories while they are being taken off). With a define per finish it was
// twenty-odd programs, and on a cold GPU that was a three-second freeze before the
// first frame. The branches are on uniforms, so they cost next to nothing.
//
// The same shader does the cut. Clipping here is not a hard discard: the pixels
// the plane crosses get a coverage value, and with alpha-to-coverage the MSAA
// target resolves the cut outline as smoothly as any other edge. And where a
// casting's skin meets the cut it shows a thin bright line, the edge a saw or a
// mill leaves on a real sectioned part.
//
// Colours are sRGB hex with colour management on, so the lighting maths runs in
// linear and a hex value means what it looks like.

import * as THREE from 'three';

export const KIND = {
  plain: 0, cast: 1, turned: 2, wrinkle: 3, hone: 4, belt: 5, paint: 6, exhaust: 7,
  valve: 8, forged: 9, crown: 10,
};

// The ports are cored out of the head. A casting that is modelled as several
// overlapping solids leaves their inner faces (a deck top, a core floor) running
// across a port; in the section they showed as floors inside the port. A casting
// marked `cored` drops any fragment inside a port core, given here as a chain of
// capsules per port. Only the head's castings pay for the test.
export const NV = 32;
export const VOIDS = {
  uRhVA: { value: Array.from({ length: NV }, () => new THREE.Vector4(0, -9, 0, 0)) },
  uRhVB: { value: Array.from({ length: NV }, () => new THREE.Vector4(0, -9, 0, 0)) },
};
const VOID = /* glsl */`
  if (uRhVoid > 0.5) {
    for (int i = 0; i < ${NV}; i++) {
      vec3 va = uRhVA[i].xyz, vb = uRhVB[i].xyz, ab = vb - va, ap = vRhP - va;
      float vt = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-10), 0.0, 1.0);
      if (length(ap - ab * vt) < uRhVA[i].w) discard;
    }
  }`;

const PARS = /* glsl */`
uniform float uRhVoid;      // 1: this casting is cored by the ports (see VOIDS)
uniform vec4 uRhVA[${NV}];  // port cores as capsules: end a (xyz) and radius (w)
uniform vec4 uRhVB[${NV}];  // and end b
varying vec3 vRhP;
varying vec3 vRhW;
varying vec2 vRhUv;
uniform float uRhKind;
uniform vec4 uRhA;          // cell (m), roughness amplitude, bump amplitude (m), speckle amount
uniform vec4 uRhB;          // per-finish extras (see each branch)
uniform vec3 uRhSpeck;      // speckle colour (linear)
uniform vec3 uRhAxis;       // turning axis, object space
uniform float uRhTime;      // belt travel (m)
uniform vec3 uRhGlow;       // exhaust heat
uniform float uRhEdge;      // strength of the bright line where the skin meets the cut
float rhHash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float rhNoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rhHash(i), rhHash(i + vec3(1,0,0)), f.x), mix(rhHash(i + vec3(0,1,0)), rhHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rhHash(i + vec3(0,0,1)), rhHash(i + vec3(1,0,1)), f.x), mix(rhHash(i + vec3(0,1,1)), rhHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// fade an octave of period c out once it is under about two pixels
float rhVis(float c, float fw){ return smoothstep(1.2, 3.0, c / fw); }
vec3 rhPerturb(vec3 pos, vec3 n, float h, float fd){
  vec3 sx = dFdx(pos), sy = dFdy(pos);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * fd;
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - grad);
}
// heat tint of a stainless primary by distance from the port (m): straw, gold,
// bronze, the blue band, then back to grey
vec3 rhHeat(float s){
  vec3 c = vec3(0.110, 0.099, 0.087);
  c = mix(c, vec3(0.376, 0.254, 0.107), smoothstep(0.000, 0.018, s));
  c = mix(c, vec3(0.584, 0.356, 0.102), smoothstep(0.018, 0.040, s));
  c = mix(c, vec3(0.330, 0.141, 0.045), smoothstep(0.040, 0.068, s));
  c = mix(c, vec3(0.047, 0.078, 0.195), smoothstep(0.068, 0.098, s));
  c = mix(c, vec3(0.159, 0.171, 0.216), smoothstep(0.098, 0.128, s));
  c = mix(c, vec3(0.275, 0.254, 0.235), smoothstep(0.128, 0.150, s));
  return c;
}
`;

const MAIN = /* glsl */`
  // Every finish draws on the same few octaves of noise, evaluated once, and every
  // screen-space derivative is taken here, outside the branches. Written as one
  // noise call per finish inside an if-chain, the D3D shader compiler behind
  // Chrome on Windows flattened the chain and spent a second on this one program,
  // and the first frame waited for it.
  int rhK = int(uRhKind + 0.5);
  bool rhOnCut = rhK == 6;
  // the section paint is a quad that moves with the plane: its grain is fixed to
  // the engine (world space) instead, so it does not slide as the cut sweeps
  vec3 rhP = rhOnCut ? vRhW : vRhP;
  float rhC = uRhA.x;
  float rhFw = max(length(fwidth(rhP)), 1e-7);
  vec3 rhNo = normalize(cross(dFdx(vRhP), dFdy(vRhP)));
  float rhUw = fwidth(vRhUv.x);
  float rhQ = (vRhW.x + vRhW.y) * 0.70710678;
  float rhQw = fwidth(rhQ);
  float n0 = rhNoise(rhP / (6.0 * rhC)) - 0.5;
  float n1 = rhNoise(rhP / (2.2 * rhC) + 7.13) - 0.5;
  float n2 = rhNoise(rhP / rhC + 13.7) - 0.5;
  float nS = rhNoise(rhP / (1.7 * rhC) + 31.0);
  float nM = rhNoise(rhP / 0.035 + 3.0) - 0.5;          // mottling, survives at any distance
  float nA = rhNoise(vec3(rhP.x / 0.0007, rhP.y / 0.009, rhP.z / 0.009) + 5.0) - 0.5;   // streaks along X
  float f0 = rhVis(6.0 * rhC, rhFw), f1 = rhVis(2.2 * rhC, rhFw), f2 = rhVis(rhC, rhFw);
  float rhH = 0.0, rhR = 0.0, rhS = 0.0, rhD = 0.0;
  vec3 rhTint = vec3(1.0);
  vec3 rhE = vec3(0.0);
  if (rhK == 1 || rhK == 3 || rhK == 9) {
    // cast: three octaves of value noise, plus sparse darker speckle cells
    rhH = n0 * f0 * 0.3 + n1 * f1 * 0.35 + n2 * f2 * 0.25;
    rhR = uRhA.y * (n0 * 0.9 + n1 * 0.55 * f1 + n2 * 0.35 * f2);
    // speckle only where it resolves; below that it is noise, not texture
    rhS = uRhA.w * smoothstep(0.80, 0.90, nS) * f1;
    rhD = nM * 0.05;
    if (rhK == 9) {
      // forging: scale laid in streaks along the grain, read in the highlight
      float fs = rhVis(0.0007, rhFw);
      rhR += uRhB.x * nA * fs;
      rhD += uRhB.y * nA * fs;
    }
  } else if (rhK == 2 || rhK == 10) {
    // turned: rings round the part axis. On a cylinder they run round it; on a
    // face they run in circles. Roughness only, like a fine lathe finish.
    float ax = dot(rhP, uRhAxis);
    float rr = length(rhP - ax * uRhAxis);
    float t = mix(ax, rr, smoothstep(0.55, 0.85, abs(dot(rhNo, uRhAxis))));
    float g1 = rhVis(0.0016, rhFw), g2 = rhVis(0.0055, rhFw);
    rhR = uRhA.y * (0.55 * sin(t * 3927.0) * g1 + 0.45 * sin(t * 1142.0 + n1 * 2.0) * g2);
    rhD = nM * 0.02;
    if (rhK == 10) {
      // piston crown: faint turning, and carbon laid down toward the middle of the
      // top, where the flame front has been
      float top = smoothstep(uRhB.y - 0.0008, uRhB.y, rhP.y);
      float carbon = (1.0 - smoothstep(0.004, 0.036, rr)) * top;
      rhTint *= mix(vec3(1.0), vec3(0.36, 0.33, 0.30), uRhB.x * carbon);
      rhR += 0.22 * carbon * uRhB.x;
      rhR *= 1.0 - 0.75 * top;
    }
  } else if (rhK == 4) {
    // plateau-honed bore: a +/-28 degree cross-hatch in the roughness and a little in value
    float u = rhP.x + rhP.z;
    float a1 = sin((u * 0.8829 + rhP.y * 0.4695) * 2513.0);
    float a2 = sin((u * 0.8829 - rhP.y * 0.4695) * 2513.0);
    float g = rhVis(0.0025, rhFw);
    float hatch = max(a1, a2);
    rhR = uRhA.y * hatch * 0.6 * g;
    rhD = nM * 0.06 - 0.05 * hatch * g;
  } else if (rhK == 5) {
    // belt: teeth (or ribs) at the pitch in uRhB.x, carried round by the crank.
    // The pitch-line arc length rides in uv.x.
    float pitch = uRhB.x;
    float ph = fract((vRhUv.x - uRhTime) / pitch);
    float w = rhUw / pitch;
    float tooth = smoothstep(0.45 - w, 0.45 + w, ph) - smoothstep(0.95 - w, 0.95 + w, ph);
    tooth = mix(tooth, 0.5, smoothstep(0.25, 0.6, w));
    rhD = -0.14 * tooth;
    rhR = -0.12 * tooth;
    rhH = n2 * f2;
  } else if (rhK == 6) {
    // section paint: a 45 degree hatch just readable at 1x (a soft band, so it
    // fades out cleanly instead of aliasing when it gets too fine), casting
    // porosity in the value and the sheen, and a soft top-to-bottom falloff, so
    // the cut face reads as a lit, sawn plane rather than a vector fill
    float pitch = uRhB.z;
    float hv = 1.0 - smoothstep(0.30 * pitch, 0.5 * pitch, rhQw);
    float band = cos(6.2831853 * rhQ / pitch) * hv;
    float pit = smoothstep(0.84, 0.94, nS) * rhVis(1.7 * rhC, rhFw);
    rhD = uRhB.w * band + 0.07 * n0 + 0.035 * n1 * f1 - 0.20 * pit;
    rhR = 0.10 * n0 - 0.05 * band + 0.2 * pit;
    rhH = (n0 * 0.6 + n1 * 0.4 * f1) * 0.8;
    rhD += clamp((vRhW.y - uRhB.x) * uRhB.y, -0.16, 0.10);
  } else if (rhK == 7) {
    // stainless primaries: the heat tint and the glow both run by distance from
    // the port, which the geometry carries in uv.x
    float s = vRhUv.x;
    rhTint = rhHeat(s) / max(diffuseColor.rgb, vec3(1e-3));
    rhE = uRhGlow * pow(max(0.0, 1.0 - s / 0.12), 1.6);
  } else if (rhK == 8) {
    // valve: ground stem, dark seat face; an exhaust valve's head runs at 700-800 C
    // flat out, so its head (not its stem) glows with the header
    float head = 1.0 - smoothstep(0.0095, 0.0105, rhP.y);
    rhTint = mix(vec3(1.0), uRhSpeck / max(diffuseColor.rgb, vec3(1e-3)), head);
    rhE = uRhGlow * (1.0 - smoothstep(0.003, 0.011, rhP.y));
    rhR = head * uRhB.x;
  } else {
    rhD = nM * 0.02;
  }
  // the bright line where a casting's skin meets the cut
  float rhEdgeK = uRhEdge * (1.0 - smoothstep(0.00025, 0.00025 + 1.5 * rhClipW, rhClipD));
`;

const VERT_PARS = /* glsl */`
varying vec3 vRhP;
varying vec3 vRhW;
varying vec2 vRhUv;`;

const VERT_MAIN = /* glsl */`
vRhP = transformed;
vec4 rhWp = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
rhWp = instanceMatrix * rhWp;
#endif
vRhW = (modelMatrix * rhWp).xyz;
vRhUv = uv;`;

// Clipping with coverage instead of a hard discard (see the note at the top).
const CLIP = /* glsl */`
#if NUM_CLIPPING_PLANES > 0
  float rhClipD = clippingPlanes[ 0 ].w - dot( vClipPosition, clippingPlanes[ 0 ].xyz );
  float rhClipW = max( fwidth( rhClipD ), 1e-7 );
  float rhCov = clamp( rhClipD / rhClipW + 0.5, 0.0, 1.0 );
  if ( rhCov <= 0.0 ) discard;
#else
  float rhClipD = 1e3, rhClipW = 1.0, rhCov = 1.0;
#endif`;

// the same coverage for anything else that is cut (the stencil passes)
export function coverageClip(mat) {
  mat.alphaToCoverage = true;
  mat.customProgramCacheKey = () => 'rhClipCov';
  mat.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <clipping_planes_fragment>', CLIP)
      .replace('#include <output_fragment>', '#include <output_fragment>\ngl_FragColor.a = rhCov;');
  };
  return mat;
}

function uber(mat, kind, o = {}) {
  const uniforms = {
    uRhKind: { value: KIND[kind] },
    uRhA: { value: new THREE.Vector4(o.cell ?? 0.0012, o.rough ?? 0.08, o.bump ?? 0.0006, o.speck ?? 0.5) },
    uRhB: { value: new THREE.Vector4(...(o.b ?? [0, 0, 0, 0])) },
    uRhSpeck: { value: new THREE.Color(o.speckColor ?? 0x6f7378) },
    uRhAxis: { value: (o.axis ?? new THREE.Vector3(1, 0, 0)).clone().normalize() },
    uRhTime: { value: 0 },
    uRhGlow: { value: new THREE.Color(0, 0, 0) },
    uRhEdge: { value: o.edge ?? 0 },
    uRhVoid: { value: o.cored ? 1 : 0 },
    ...VOIDS,
  };
  mat.userData.rh = uniforms;
  mat.customProgramCacheKey = () => 'rhU';
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <clipping_planes_fragment>', CLIP + VOID)
      .replace('#include <logdepthbuf_fragment>', '#include <logdepthbuf_fragment>\n' + MAIN)
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= rhTint;
diffuseColor.rgb = mix(diffuseColor.rgb, uRhSpeck, clamp(rhS, 0.0, 1.0));
diffuseColor.rgb *= 1.0 + rhD;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.81, 0.82), rhEdgeK);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + rhR - 0.3 * rhEdgeK, 0.04, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 1.0, rhEdgeK);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (uRhA.z > 0.0) normal = rhPerturb(-vViewPosition, normal, rhH * uRhA.z, faceDirection);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += rhE;`)
      .replace('#include <output_fragment>', '#include <output_fragment>\ngl_FragColor.a *= rhCov;');
  };
  return mat;
}

function std(name, hex, metal, rough, env = 1, extra = {}) {
  return new THREE.MeshStandardMaterial({ name, color: hex, metalness: metal, roughness: rough, envMapIntensity: env, ...extra });
}

// ---------------------------------------------------------------- the palette
export function makeMaterials() {
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
  const M = {
    // sand-cast aluminium: rough, speckled, slightly warm grey
    cast: uber(std('cast_alloy', 0xa19f9b, 0.9, 0.46, 0.95), 'cast', { cell: 0.0012, rough: 0.06, bump: 0.0002, speck: 0.22, speckColor: 0x77756f }),
    // the same alloy on the floor of a cored cavity: darker, rougher, never polished
    // the intake manifold: a rougher, duller sand casting than the machined block
    castIn: uber(std('cast_manifold', 0x8e8b86, 0.75, 0.6, 0.85), 'cast', { cell: 0.0015, rough: 0.08, bump: 0.00035, speck: 0.3, speckColor: 0x73706a }),
    // the head: the same alloy, cored by the ports
    headCast: uber(std('cast_alloy', 0xa19f9b, 0.9, 0.46, 0.95), 'cast', { cell: 0.0012, rough: 0.06, bump: 0.0002, speck: 0.22, speckColor: 0x77756f, cored: true }),
    castCore: uber(std('cast_core', 0x6d6c69, 0.75, 0.72, 0.7), 'cast', { cell: 0.0012, rough: 0.07, bump: 0.0002, speck: 0.3, speckColor: 0x4d4c49, cored: true }),
    // machined aluminium faces: deck, flanges, bearing bores
    machined: uber(std('machined_alloy', 0xaeb2b7, 0.9, 0.38, 1.0), 'turned', { rough: 0.06, axis: Y }),
    // plateau-honed iron liners photograph mid-grey, not black
    liner: uber(std('honed_liner', 0x8a8d91, 0.5, 0.42, 1.0), 'hone', { rough: 0.05 }),
    gasket: uber(std('mls_gasket', 0x2c2e31, 0.7, 0.42, 0.9), 'plain'),
    // forged crank webs: dark scale, rough, streaked along the grain
    forged: uber(std('forged_web', 0x3c3f43, 1.0, 0.45, 1.1), 'forged', { cell: 0.0016, rough: 0.07, bump: 0.0005, speck: 0.3, speckColor: 0x2c2e31, b: [0.12, 0.10, 0, 0] }),
    // the turned counterweight rims and the ground thrust faces beside each journal
    webTurned: uber(std('turned_web', 0x9ca0a5, 1.0, 0.26, 1.2), 'turned', { rough: 0.07, axis: X }),
    journal: uber(std('ground_journal', 0xd0d3d6, 1.0, 0.2, 1.2), 'turned', { rough: 0.05, axis: X }),
    rod: uber(std('shot_peened_rod', 0x6f7378, 1.0, 0.44, 1.15), 'forged', { cell: 0.0006, rough: 0.06, bump: 0.00025, speck: 0.2, speckColor: 0x55585c, b: [0.05, 0.04, 0, 0] }),
    piston: uber(std('piston_alloy', 0xc3c6c9, 0.85, 0.35, 1.1), 'crown', { rough: 0.035, axis: Y, b: [0.85, 0.0283, 0, 0] }),
    skirt: uber(std('skirt_coating', 0x3d3f42, 0.2, 0.7, 0.8), 'plain'),
    ring: uber(std('nitrided_ring', 0x6d7176, 1.0, 0.3, 1.1), 'plain'),
    pin: uber(std('wrist_pin', 0xd7dadd, 1.0, 0.12, 1.2), 'plain'),
    lobe: uber(std('ground_lobe', 0xc7cace, 1.0, 0.26, 1.2), 'turned', { rough: 0.05, axis: X }),
    camCast: uber(std('cam_casting', 0x6a6e73, 0.9, 0.55, 1.0), 'cast', { cell: 0.0012, rough: 0.06, bump: 0.0004, speck: 0.3 }),
    valve: uber(std('valve', 0xd9dcdf, 1.0, 0.22, 1.2), 'valve', { speckColor: 0xc6c9cc, b: [0.1, 0, 0, 0] }),
    valveHot: uber(std('exhaust_valve', 0xd9dcdf, 1.0, 0.22, 1.2), 'valve', { speckColor: 0x5a534c, b: [0.25, 0, 0, 0] }),
    spring: uber(std('black_oxide_spring', 0x33363a, 0.9, 0.35, 1.1), 'plain'),
    bucket: uber(std('bucket', 0xb8bcc0, 1.0, 0.25, 1.15), 'turned', { rough: 0.05, axis: Y }),
    bronze: uber(std('copper_lead_bearing', 0xb07a52, 1.0, 0.32, 1.1), 'plain'),
    bolt: uber(std('zinc_bolt', 0xb5b8bb, 1.0, 0.35, 1.1), 'plain'),
    // cam cover: dark satin wrinkle paint
    cover: uber(std('wrinkle_paint', 0x1b1c1f, 0.15, 0.5, 0.75), 'wrinkle', { rough: 0.12, bump: 0.00035, speck: 0.35, speckColor: 0x2c2d31 }),
    belt: uber(std('epdm_belt', 0x121314, 0, 0.85, 0.6), 'belt', { bump: 0.0002, b: [0.008, 0, 0, 0] }),
    vbelt: uber(std('poly_v_belt', 0x141516, 0, 0.8, 0.6), 'belt', { bump: 0.0002, b: [0.0036, 0, 0, 0] }),
    // moulded glass-filled nylon: satin, so the timing cover's form reads
    plastic: uber(std('pa66_moulding', 0x1c1d20, 0.0, 0.42, 0.9), 'cast', { cell: 0.0009, rough: 0.05, bump: 0.00008, speck: 0 }),
    ceramic: uber(std('plug_ceramic', 0xefece6, 0, 0.25, 0.7), 'plain'),
    exhaust: uber(std('stainless_header', 0x8f8a85, 1.0, 0.35, 1.1), 'exhaust', { bump: 0 }),
    // satin black paint on a pressed-steel sump: lifted enough to hold its form
    pan: uber(std('satin_pan', 0x35383c, 0.2, 0.44, 1.0), 'cast', { cell: 0.002, rough: 0.05, bump: 0.0002, speck: 0 }),
    // oil filter: dark automotive blue, painted can
    filter: uber(std('oil_filter', 0x1f2c40, 0.3, 0.38, 0.9), 'plain'),
    handle: uber(std('dipstick_handle', 0xd6961c, 0, 0.5, 0.6), 'plain'),
    copper: uber(std('copper_badge', 0xa8683a, 1.0, 0.44, 0.9), 'turned', { rough: 0.05, axis: new THREE.Vector3(0, 1, 0) }),
    ironCast: uber(std('cast_iron', 0x4a4d51, 0.8, 0.55, 1.0), 'cast', { cell: 0.0014, rough: 0.07, bump: 0.0004, speck: 0.3, speckColor: 0x3a3c3f }),
    // flywheel friction face: turned steel, not bronze
    friction: uber(std('friction_face', 0x8e9296, 1.0, 0.3, 1.15), 'turned', { rough: 0.07, axis: X }),
    steel: uber(std('machined_steel', 0x9da1a6, 1.0, 0.3, 1.1), 'turned', { rough: 0.05, axis: X }),
    darkSteel: uber(std('dark_steel', 0x4b4e52, 0.9, 0.4, 1.0), 'plain'),
    rubber: uber(std('rubber', 0x151617, 0, 0.8, 0.5), 'plain'),
    // section paint: signal red leaning to the brand's ember orange
    paint: uber(std('section_paint', 0xd0461e, 0, 0.52, 0.5), 'paint', { bump: 0.00012, b: [0.1, 0.35, 0.005, 0.04] }),
    flame: new THREE.MeshBasicMaterial({ name: 'flame', color: 0xffb066, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  };
  return M;
}

export { uber as detail };
