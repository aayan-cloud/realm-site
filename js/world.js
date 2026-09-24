/* Realm / precision process installation. Three.js r149, no dependencies.
 * One transparent scissored renderer for stage-local scenes. The original
 * PC image sequence is deliberately not owned or rendered here.
 */
(function () {
  'use strict';
  var api = window.Realm3D = { ready: false };
  var names = ['BUSINESS', 'DISCOVERY', 'LEADS', 'WEBSITE', 'CUSTOMER'];
  var mq = matchMedia('(prefers-reduced-motion: reduce)');
  var reduced = mq.matches, stages = [], services = [], packets = [], raf = 0;
  var elapsed = 0, last = 0, frames = 0, pointer = { x: 0, y: 0 };
  var canvas = document.getElementById('gl');
  function fallback() {
    ['hero-stage', 'close-stage'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var text = document.createElement('div');
      text.className = 'realm3d-fallback';
      text.textContent = id === 'hero-stage' ? names.join(' → ') : 'R / REALM SYSTEMS';
      text.style.cssText = 'padding:48px 24px;color:#20252a;font:600 16px/2 system-ui;white-space:normal;background:#faf9f6;border:1px solid #ddd9d2;border-radius:20px;';
      el.appendChild(text);
    });
    api.error = 'WebGL unavailable; readable process fallback shown';
  }
  if (!window.THREE || !canvas) { fallback(); return; }
  var T = THREE, renderer;
  try { renderer = new T.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true }); }
  catch (_) { fallback(); return; }
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:2;pointer-events:none;';
  canvas.setAttribute('aria-hidden', 'true');
  function setupRenderer(r, shadowSize) {
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    r.outputEncoding = T.sRGBEncoding;
    // r149 does not automatically convert numeric material colours to linear.
    // Explicit conversion + neutral LinearToneMapping preserves orange hue.
    r.toneMapping = T.LinearToneMapping;
    r.toneMappingExposure = 0.96;
    r.setClearColor(0xffffff, 0);
    r.shadowMap.enabled = true;
    r.shadowMap.type = T.PCFSoftShadowMap;
    r.autoClear = false;
  }
  setupRenderer(renderer);
  function color(hex) { return new T.Color(hex).convertSRGBToLinear(); }
  function material(hex, rough, metal) {
    return new T.MeshStandardMaterial({ color: color(hex), roughness: rough || 0.55, metalness: metal || 0 });
  }
  var M = {
    white: material('#faf9f6', 0.38, 0.04), ceramic: material('#e8e6e0', 0.52, 0.03),
    edge: material('#d4d3ce', 0.46, 0.15), ink: material('#303539', 0.5, 0.12),
    metal: material('#a5aaa9', 0.35, 0.48), orange: material('#ee641f', 0.45, 0),
    pale: material('#f4d4c0', 0.6, 0), screen: material('#e9edeb', 0.65, 0),
    packet: new T.MeshBasicMaterial({ color: color('#fff5e8') })
  };
  var cache = {};
  function rounded(w, h, d, bevel) {
    var key = [w, h, d, bevel].join(',');
    if (cache[key]) return cache[key];
    var b = Math.min(bevel || 0.04, w / 4, h / 4, d / 4);
    var s = new T.Shape();
    s.moveTo(-w / 2 + b, -h / 2 + b);
    s.lineTo(w / 2 - b, -h / 2 + b); s.lineTo(w / 2 - b, h / 2 - b);
    s.lineTo(-w / 2 + b, h / 2 - b); s.closePath();
    var geo = new T.ExtrudeGeometry(s, { depth: d - b * 2, bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: 3, steps: 1 });
    geo.translate(0, 0, -d / 2 + b);
    cache[key] = geo;
    return geo;
  }
  function mesh(parent, geo, mat, x, y, z) {
    var m = new T.Mesh(geo, mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
  }
  function box(p, w, h, d, mat, x, y, z, bevel) { return mesh(p, rounded(w, h, d, bevel), mat, x, y, z); }
  function cylinder(p, radius, h, mat, x, y, z) { return mesh(p, new T.CylinderGeometry(radius, radius, h, 24), mat, x, y, z); }
  function ball(p, radius, mat, x, y, z) { return mesh(p, new T.SphereGeometry(radius, 16, 12), mat, x, y, z); }
  function group(p, x, y, z) { var g = new T.Group(); g.position.set(x || 0, y || 0, z || 0); p.add(g); return g; }
  function lineTube(p, points, radius, mat) {
    var curve = new T.CatmullRomCurve3(points.map(function (v) { return new T.Vector3(v[0], v[1], v[2]); }), false, 'centripetal');
    var tube = mesh(p, new T.TubeGeometry(curve, 48, radius, 8, false), mat);
    return { curve: curve, mesh: tube };
  }
  // Soft, locally grounded occlusion supplements the studio shadow map.
  var shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 128;
  var ctx = shadowCanvas.getContext('2d');
  var gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 63);
  gradient.addColorStop(0, 'rgba(40,35,27,0.3)'); gradient.addColorStop(0.5, 'rgba(40,35,27,0.13)'); gradient.addColorStop(1, 'rgba(40,35,27,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
  var shadowTex = new T.CanvasTexture(shadowCanvas); shadowTex.encoding = T.sRGBEncoding;
  function contact(p, w, d, x, y, z) {
    var mat = new T.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
    var m = mesh(p, new T.PlaneGeometry(w, d), mat, x, y, z);
    m.rotation.x = -Math.PI / 2; m.castShadow = false; m.receiveShadow = false;
    return m;
  }
  function studio(el, kind) {
    var sc = new T.Scene(), g = group(sc);
    sc.add(new T.HemisphereLight(0xffffff, 0xd2cfc8, 0.82));
    var key = new T.DirectionalLight(0xfff9ef, 1.12); key.position.set(-4, 12, 8);
    key.castShadow = true; key.shadow.mapSize.set(kind === 'service' ? 512 : 1536, kind === 'service' ? 512 : 1536);
    key.shadow.camera.left = -12; key.shadow.camera.right = 12; key.shadow.camera.top = 12; key.shadow.camera.bottom = -12;
    key.shadow.camera.near = 0.5; key.shadow.camera.far = 40; key.shadow.normalBias = 0.035; key.shadow.bias = -0.00015; key.shadow.radius = 3;
    sc.add(key);
    var fill = new T.DirectionalLight(0xffffff, 0.35); fill.position.set(7, 5, -5); sc.add(fill);
    var camera = new T.OrthographicCamera(-8, 8, 8, -8, 0.1, 80);
    camera.position.set(kind === 'closing' ? 8 : 10, kind === 'closing' ? 6 : 13, 18);
    camera.lookAt(0, 1, 0); camera.updateMatrixWorld();
    var st = { el: el, kind: kind, scene: sc, group: g, camera: camera, labels: [], visible: false, time: 0, hot: false, draws: 0, projected: null };
    return st;
  }
  function feet(p, w, d) {
    [-1, 1].forEach(function (x) { [-1, 1].forEach(function (z) { cylinder(p, 0.24, 0.18, M.ink, x * w, 0.12, z * d); }); });
  }
  function screw(p, x, y, z) {
    cylinder(p, 0.055, 0.023, M.metal, x, y, z);
    box(p, 0.07, 0.025, 0.013, M.ink, x, y + 0.015, z, 0.002);
  }
  function browser(p, scale) {
    var g = group(p); if (scale) g.scale.setScalar(scale);
    box(g, 0.8, 0.1, 0.6, M.metal, 0, 0.05, 0);
    box(g, 0.16, 0.48, 0.15, M.metal, 0, 0.3, -0.12);
    box(g, 1.95, 1.3, 0.18, M.white, 0, 1.15, -0.12);
    box(g, 1.76, 1.1, 0.028, M.screen, 0, 1.15, -0.012, 0.008);
    box(g, 1.72, 0.17, 0.032, M.ceramic, 0, 1.59, 0.01, 0.005);
    [0, 1, 2].forEach(function (i) { ball(g, 0.029, i === 0 ? M.orange : M.metal, -0.72 + i * 0.105, 1.59, 0.035); });
    box(g, 0.58, 0.5, 0.04, M.pale, -0.46, 1.12, 0.015);
    box(g, 0.59, 0.06, 0.045, M.ink, 0.29, 1.32, 0.019, 0.007);
    box(g, 0.42, 0.04, 0.045, M.metal, 0.21, 1.17, 0.019, 0.006);
    box(g, 0.54, 0.04, 0.045, M.metal, 0.27, 1.04, 0.019, 0.006);
    box(g, 0.44, 0.15, 0.05, M.orange, 0.23, 0.84, 0.023, 0.012);
    return g;
  }
  function shop(p) {
    var g = group(p);
    box(g, 1.96, 1.16, 1.27, M.white, 0, 0.58, 0);
    box(g, 2.08, 0.16, 1.4, M.ceramic, 0, 1.22, 0);
    box(g, 0.52, 0.87, 0.04, M.ink, -0.55, 0.46, 0.657);
    box(g, 0.42, 0.64, 0.035, M.screen, -0.55, 0.57, 0.684);
    box(g, 0.86, 0.69, 0.05, M.metal, 0.36, 0.61, 0.66);
    box(g, 0.74, 0.56, 0.032, M.screen, 0.36, 0.61, 0.69);
    box(g, 0.04, 0.57, 0.038, M.white, 0.36, 0.61, 0.716);
    for (var i = 0; i < 7; i++) {
      var awn = box(g, 0.292, 0.09, 0.6, i % 2 ? M.white : M.orange, -0.88 + i * 0.294, 1.12, 0.89);
      awn.rotation.x = 0.22;
      box(g, 0.293, 0.14, 0.075, i % 2 ? M.white : M.orange, -0.88 + i * 0.294, 1.01, 1.17);
    }
    box(g, 0.87, 0.21, 0.07, M.ink, 0, 1.43, 0);
    box(g, 0.55, 0.035, 0.04, M.white, 0, 1.44, 0.049, 0.004);
    return g;
  }
  function discovery(p) {
    var g = group(p);
    box(g, 1.85, 0.1, 1.5, M.screen, 0, 0.08, 0);
    [-0.52, 0.02, 0.55].forEach(function (x) { box(g, 0.13, 0.027, 1.43, M.white, x, 0.15, 0); });
    [-0.42, 0.28].forEach(function (z) { box(g, 1.8, 0.029, 0.13, M.white, 0, 0.15, z); });
    [[-0.59, -0.28], [0.48, 0.4], [0.47, -0.46]].forEach(function (v) {
      box(g, 0.31, 0.18, 0.28, M.ceramic, v[0], 0.25, v[1]);
    });
    // A physical map pin, extruded with a round counter.
    var s = new T.Shape(); s.moveTo(0, 0); s.bezierCurveTo(-0.24, 0.3, -0.54, 0.58, -0.54, 0.91);
    s.absarc(0, 0.91, 0.54, Math.PI, 0, true); s.bezierCurveTo(0.54, 0.58, 0.24, 0.3, 0, 0);
    var hole = new T.Path(); hole.absarc(0, 0.91, 0.22, 0, Math.PI * 2, false); s.holes.push(hole);
    var pin = mesh(g, new T.ExtrudeGeometry(s, { depth: 0.17, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 3, curveSegments: 20 }), M.orange, 0, 0.19, -0.05);
    pin.rotation.y = 0.1;
    return g;
  }
  function documents(p) {
    var g = group(p);
    box(g, 1.78, 0.21, 1.35, M.metal, 0, 0.12, 0);
    box(g, 1.65, 0.1, 1.25, M.white, 0, 0.27, 0);
    for (var i = 0; i < 3; i++) {
      var card = group(g, -0.11 + i * 0.09, 0.38 + i * 0.105, -0.02 - i * 0.13);
      box(card, 1.35, 0.065, 0.91, M.white, 0, 0, 0);
      box(card, 0.22, 0.025, 0.23, M.orange, -0.44, 0.045, -0.13);
      for (var j = 0; j < 3; j++) box(card, 0.68 - j * 0.13, 0.025, 0.035, M.metal, 0.15, 0.045, -0.19 + j * 0.15, 0.003);
    }
    var upright = group(g, 0, 1.12, -0.29); upright.rotation.x = -0.14;
    box(upright, 1.22, 1.12, 0.07, M.white, 0, 0, 0);
    box(upright, 0.76, 0.07, 0.029, M.ink, -0.04, 0.32, 0.05, 0.006);
    for (var k = 0; k < 3; k++) {
      box(upright, 0.09, 0.09, 0.03, M.orange, -0.43, 0.06 - k * 0.19, 0.05, 0.004);
      box(upright, 0.56, 0.04, 0.03, M.metal, 0.02, 0.06 - k * 0.19, 0.05, 0.004);
    }
    return g;
  }
  function customer(p) {
    var g = group(p);
    cylinder(g, 0.83, 0.11, M.ceramic, 0, 0.08, 0);
    mesh(g, new T.CylinderGeometry(0.35, 0.54, 0.67, 28), M.white, 0, 0.48, 0);
    ball(g, 0.31, M.orange, 0, 1.12, 0);
    // Completed order tile rests on the customer's base.
    var tile = group(g, 0.54, 0.44, 0.36);
    box(tile, 0.48, 0.5, 0.1, M.white, 0, 0, 0);
    var tick1 = box(tile, 0.16, 0.065, 0.04, M.orange, -0.09, -0.03, 0.071, 0.005); tick1.rotation.z = -0.8;
    var tick2 = box(tile, 0.3, 0.065, 0.04, M.orange, 0.04, 0.03, 0.071, 0.005); tick2.rotation.z = 0.85;
    return g;
  }
  function addLabel(st, index, anchor) {
    var el = document.createElement('span');
    el.className = 'realm3d-label'; el.textContent = names[index];
    el.style.cssText = 'position:absolute;z-index:3;pointer-events:none;white-space:nowrap;font:600 clamp(10px,0.88vw,12px)/1.2 "Geist",system-ui,sans-serif;letter-spacing:.075em;color:#383b3b;padding:5px 7px;background:rgba(250,249,246,.94);border:1px solid rgba(125,120,111,.19);border-radius:4px;transform:translate(-50%,-50%);';
    el.setAttribute('data-module', String(index + 1));
    st.el.appendChild(el); st.labels.push({ el: el, point: new T.Vector3(anchor[0], anchor[1], anchor[2]), name: names[index] });
  }
  function buildHero(el) {
    var st = studio(el, 'hero'); stages.push(st);
    var g = st.group;
    el.style.position = 'relative'; el.style.overflow = 'hidden';
    el.setAttribute('role', 'img'); el.setAttribute('aria-label', 'Illustrative Realm infrastructure: business, discovery, leads, website, customer. Five connected physical modules.');
    feet(g, 4.8, 3.1);
    contact(g, 14.2, 11, 0, 0.014, 0);
    box(g, 11.35, 0.39, 8.05, M.edge, 0, 0.37, 0, 0.11);
    box(g, 11.18, 0.42, 7.9, M.white, 0, 0.72, 0, 0.12);
    box(g, 10.9, 0.035, 7.61, M.ceramic, 0, 0.95, 0, 0.008);
    // Inset cover panels, seams, vents, captive fasteners and one data port.
    [-3.42, 0, 3.42].forEach(function (x) {
      box(g, 3.27, 0.035, 7.33, M.white, x, 0.981, 0);
      [-3.36, 3.36].forEach(function (z) { screw(g, x - 1.36, 1.007, z); screw(g, x + 1.36, 1.007, z); });
    });
    for (var v = 0; v < 12; v++) box(g, 0.045, 0.105, 0.022, M.ink, -4.55 + v * 0.17, 0.72, 3.962, 0.003);
    box(g, 0.56, 0.15, 0.027, M.ink, 4.31, 0.69, 3.967, 0.005);
    box(g, 0.16, 0.055, 0.034, M.orange, 4.31, 0.69, 3.985, 0.005);
    // A clear serpentine process: three back modules, two front modules.
    var locations = [[-3.55, -1.95], [0, -1.95], [3.55, -1.95], [2.38, 1.63], [-2.15, 1.63]];
    var builders = [shop, discovery, documents, browser, customer];
    locations.forEach(function (pos, i) {
      var x = pos[0], z = pos[1];
      contact(g, 3.5, 3.0, x, 1.011, z);
      box(g, 2.87, 0.1, 2.47, M.metal, x, 1.08, z);
      box(g, 2.77, 0.48, 2.37, M.ceramic, x, 1.35, z);
      box(g, 2.84, 0.15, 2.45, M.white, x, 1.665, z);
      box(g, 0.23, 0.095, 0.03, M.orange, x - 1.01, 1.37, z + 1.195);
      for (var j = 0; j < 4; j++) box(g, 0.37, 0.025, 0.03, M.metal, x + 0.7, 1.44 - j * 0.065, z + 1.195, 0.003);
      var m = builders[i](g); m.position.set(x, 1.75, z);
      // Back-row labels sit above their instruments, not over the
      // front-row customer/browser silhouettes. Front labels mark fascias.
      addLabel(st, i, i < 3 ? [x, 3.95, z] : [x, 1.3, z + 1.33]);
    });
    var routes = [
      [[-2.1,1.29,-1.95],[-1.9,1.16,-1.95],[-1.76,1.12,-1.4],[-1.6,1.16,-1.95],[-1.42,1.29,-1.95]],
      [[1.42,1.29,-1.95],[1.6,1.16,-1.95],[1.76,1.12,-1.4],[1.94,1.16,-1.95],[2.1,1.29,-1.95]],
      [[4.96,1.28,-1.95],[5.16,1.12,-1.6],[5.16,1.12,0.0],[4.5,1.12,1.63],[3.8,1.28,1.63]],
      [[0.97,1.28,1.63],[0.7,1.12,1.63],[0.5,1.12,2.22],[-0.4,1.12,2.22],[-0.74,1.28,1.63]]
    ];
    routes.forEach(function (pts, i) {
      // A dark recessed channel grounds the orange rubber tube.
      var tube = lineTube(g, pts, 0.067, M.orange);
      [pts[0], pts[pts.length - 1]].forEach(function (p) { cylinder(g, 0.12, 0.07, M.metal, p[0], p[1], p[2]); });
      for (var n = 0; n < 2; n++) {
        var packet = ball(g, 0.09, M.packet);
        packet.position.copy(tube.curve.getPointAt((n * 0.5 + i * 0.11) % 1));
        packets.push({ st: st, mesh: packet, curve: tube.curve, phase: n * 0.5 + i * 0.11 });
      }
    });
    st.modelBounds = new T.Box3(new T.Vector3(-6.6, -0.1, -4.7), new T.Vector3(6.6, 3.9, 4.7));
    return st;
  }
  function buildClosing(el) {
    var st = studio(el, 'closing'); stages.push(st);
    var g = st.group; el.style.overflow = 'hidden';
    contact(g, 8, 6, 0, 0.008, 0);
    feet(g, 2.2, 1.35);
    box(g, 5.5, 0.36, 3.9, M.ceramic, 0, 0.31, 0, 0.12);
    box(g, 5.38, 0.18, 3.76, M.white, 0, 0.58, 0, 0.08);
    // The Realm Systems mark (2026-09-23 logo): the letter body, traced from the logo,
    // and the separate wedge under the bowl. Extrude and ShapeGeometry both take the array.
    var s = [];
    var o0 = new T.Shape(); o0.moveTo(-0.716, 3.500); o0.lineTo(-2.082, 3.495); o0.lineTo(-2.088, 3.484); o0.lineTo(-2.066, 3.457); o0.lineTo(-1.364, 2.684); o0.lineTo(0.581, 2.690); o0.lineTo(0.694, 2.668); o0.lineTo(0.791, 2.614); o0.lineTo(0.851, 2.544); o0.lineTo(0.894, 2.447); o0.lineTo(0.894, 2.285); o0.lineTo(0.861, 2.209); o0.lineTo(0.818, 2.150); o0.lineTo(0.705, 2.074); o0.lineTo(0.575, 2.052); o0.lineTo(-0.629, 2.052); o0.lineTo(-0.667, 2.047); o0.lineTo(-0.667, 2.031); o0.lineTo(-0.122, 1.421); o0.lineTo(1.094, 0.005); o0.lineTo(2.088, 0.000); o0.lineTo(2.088, 0.022); o0.lineTo(1.866, 0.265); o0.lineTo(1.585, 0.605); o0.lineTo(0.948, 1.318); o0.lineTo(1.115, 1.383); o0.lineTo(1.207, 1.437); o0.lineTo(1.407, 1.610); o0.lineTo(1.547, 1.804); o0.lineTo(1.639, 2.020); o0.lineTo(1.672, 2.160); o0.lineTo(1.688, 2.317); o0.lineTo(1.682, 2.479); o0.lineTo(1.661, 2.614); o0.lineTo(1.596, 2.819); o0.lineTo(1.520, 2.965); o0.lineTo(1.423, 3.100); o0.lineTo(1.256, 3.262); o0.lineTo(1.088, 3.370); o0.lineTo(0.943, 3.435); o0.lineTo(0.732, 3.489); o0.lineTo(0.656, 3.500); o0.closePath();
    s.push(o0);
    var o1 = new T.Shape(); o1.moveTo(-1.466, 2.252); o1.lineTo(-1.466, 0.000); o1.lineTo(-1.456, 0.000); o1.lineTo(-1.191, 0.205); o1.lineTo(-0.824, 0.519); o1.lineTo(-0.791, 0.562); o1.lineTo(-0.316, 0.999); o1.lineTo(-0.240, 1.075); o1.lineTo(-0.240, 1.091); o1.lineTo(-0.926, 1.880); o1.lineTo(-1.218, 2.096); o1.lineTo(-1.423, 2.236); o1.closePath();
    s.push(o1);
    var geo = new T.ExtrudeGeometry(s, { depth: 0.84, bevelEnabled: true, bevelSize: 0.055, bevelThickness: 0.055, bevelSegments: 4, curveSegments: 24 });
    mesh(g, geo, [M.white, M.edge], 0, 0.72, -0.44);
    // Orange recessed architectural reveal follows the R's front face.
    var faceGeo = new T.ShapeGeometry(s, 24);
    mesh(g, faceGeo, M.orange, 0, 0.72, 0.457);
    [-2.27, 2.27].forEach(function (x) { [-1.43, 1.43].forEach(function (z) { screw(g, x, 0.685, z); }); });
    st.modelBounds = new T.Box3(new T.Vector3(-3.8, -0.05, -2.9), new T.Vector3(3.8, 4.8, 2.9));
    return st;
  }
  function buildService(el) {
    var st = studio(el, 'service'), key = el.dataset.obj, g = st.group;
    st.key = key; services.push(st);
    var r;
    try { r = new T.WebGLRenderer({ antialias: true, alpha: true }); } catch (_) { return; }
    setupRenderer(r); st.renderer = r;
    r.domElement.setAttribute('aria-hidden', 'true');
    r.domElement.style.cssText = 'display:block;width:100%;height:100%;'; el.appendChild(r.domElement);
    contact(g, 4.4, 4.2, 0, 0.008, 0);
    box(g, 3.0, 0.17, 2.6, M.ceramic, 0, 0.16, 0, 0.05);
    if (key === 'website') {
      var b = browser(g, 1.12); b.position.set(-0.28,0.26,-0.3);
      var keyboard=group(g,-0.25,0.3,0.85);
      box(keyboard,1.45,0.08,0.52,M.metal,0,0,0);
      for(var ky=0;ky<3;ky++)for(var kx=0;kx<11;kx++)box(keyboard,0.085,0.025,0.075,M.white,-0.6+kx*0.118,0.06,-0.15+ky*0.12,0.008);
      box(g,0.4,0.05,0.35,M.white,0.89,0.32,0.9);
      var phone=group(g,1.0,0.93,-0.04);phone.rotation.y=-0.2;
      box(phone,0.49,1.04,0.08,M.ink,0,0,0,0.05);
      box(phone,0.43,0.9,0.014,M.screen,0,0,0.054,0.035);
      box(phone,0.32,0.28,0.02,M.pale,0,0.18,0.07);
      for(var ph=0;ph<3;ph++)box(phone,0.28-ph*0.04,0.025,0.02,M.metal,0,-0.04-ph*0.09,0.075);
      box(phone,0.2,0.075,0.02,M.orange,0,-0.32,0.08);
      box(g,0.64,0.08,0.36,M.metal,1.0,0.3,-0.04);
    }
    if (key === 'leads') {
      var hubB=box(g,0.66,0.46,0.66,M.metal,0,0.55,0,0.05);
      box(g,0.5,0.09,0.5,M.orange,0,0.83,0);
      for(var vent=0;vent<4;vent++)box(g,0.42,0.02,0.06,M.ink,0,0.34,-0.16+vent*0.105);
      var shops=[[-1.05,0.75,0.35,0.12],[1.05,0.75,-0.35,-0.3],[-0.85,-0.72,0.12,0.3],[1.0,-0.6,-0.12,-0.35]];
      shops.forEach(function(v,si){
        lineTube(g,[[0,0.36,0],[v[0]*0.55,0.36,v[1]*0.45],[v[0],0.36,v[1]]],0.035,M.orange);
        var shop=group(g,v[0],0.4,v[1]);shop.rotation.y=v[2]*0.28;
        box(shop,0.62,0.72,0.58,M.white,0,0.36,0,0.04);
        box(shop,0.66,0.14,0.64,M.orange,0,0.79,0,0.03);
        for(var win=0;win<3;win++)box(shop,0.13,0.2,0.02,M.screen,-0.19+win*0.19,0.5,0.3);
        box(shop,0.2,0.3,0.02,M.ink,0.12,0.19,0.3,0.02);
        box(shop,0.34,0.07,0.03,M.pale,0,0.66,0.31);
        contact(shop,0.9,0.9,0,0.006,0);
      });
      contact(g,2.9,2.4,0,0.01,0);
    }
    if (key === 'automation') {
      for (var a = 0; a < 3; a++) box(g, 1.7, 0.18, 1.6, a === 1 ? M.metal : M.white, 0, 0.39 + a * 0.25, 0);
      box(g, 0.93, 0.12, 0.9, M.ink, 0, 1.04, 0);
      box(g, 0.51, 0.04, 0.5, M.orange, 0, 1.13, 0);
      for (var pin = 0; pin < 5; pin++) [-1,1].forEach(function (side) {
        box(g, 0.2, 0.05, 0.07, M.orange, side * 1.03, 0.66, -0.55 + pin * 0.27);
      });
    }
    if (key === 'receptionist') {
      // A phone face-up on the plate: an incoming-call dot, two message lines, an answer key.
      box(g, 1.1, 0.12, 2.2, M.ink, 0, 0.3, 0, 0.08);
      box(g, 0.98, 0.03, 2.05, M.screen, 0, 0.375, 0, 0.01);
      ball(g, 0.11, M.orange, 0, 0.44, -0.62);
      box(g, 0.6, 0.035, 0.09, M.metal, 0, 0.4, -0.18, 0.01);
      box(g, 0.44, 0.035, 0.09, M.metal, -0.08, 0.4, 0.04, 0.01);
      box(g, 0.7, 0.14, 0.34, M.orange, 0, 0.45, 0.72, 0.05);
    }
    if (key === '3d') {
      cylinder(g, 0.94, 0.12, M.metal, 0, 0.32, 0);
      var product = group(g, 0, 0.41, 0);
      var headband = group(product, 0, 1.02, 0);
      var bandPts = []; for (var ba = -80; ba <= 80; ba += 8) { var rad = ba * Math.PI / 180; bandPts.push([Math.sin(rad) * 0.98, 1.02 - (1 - Math.cos(rad)) * 0.34, 0]); }
      lineTube(headband, bandPts, 0.075, M.white);
      var cups = [];
      [[-1,0],[1,0]].forEach(function (side) {
        var cup = group(product, side[0] * 0.99, 0.62, 0);
        cylinder(cup, 0.44, 0.3, M.white, 0, 0, 0).rotation.z = Math.PI / 2;
        var pad = cylinder(cup, 0.38, 0.12, M.ink, side[0] * 0.2, 0, 0); pad.rotation.z = Math.PI / 2;
        cylinder(cup, 0.3, 0.05, M.orange, side[0] * 0.27, 0, 0).rotation.z = Math.PI / 2;
        cylinder(cup, 0.13, 0.34, M.metal, 0, 0, 0);
        box(cup, 0.06, 0.3, 0.06, M.metal, side[0] * 0.18, 0.44, 0);
        cups.push(cup);
      });
      box(product, 0.3, 0.14, 0.2, M.orange, 0, 0.62, 0.44);
      st.product = product; st.explode = cups;
    }
    st.modelBounds = new T.Box3(new T.Vector3(-2,0,-1.8), new T.Vector3(2,2.65,1.8));
    var row = el.closest('.svc__row') || el.parentElement;
    ['pointerenter','focusin'].forEach(function (event) { row.addEventListener(event, function () { st.hot = true; request(); }); });
    ['pointerleave','focusout'].forEach(function (event) { row.addEventListener(event, function () { st.hot = row.matches(':hover,:focus-within'); request(); }); });
  }
  var hero = document.getElementById('hero-stage'); if (hero) buildHero(hero);
  var closing = document.getElementById('close-stage'); if (closing) buildClosing(closing);
  document.querySelectorAll('.svc__obj[data-obj]').forEach(buildService);
  var all = stages.concat(services), v = new T.Vector3();
  // Fit the model's fixed local bounds in camera coordinates. DOM position
  // NEVER changes world position or scale, preventing scroll/viewport drift.
  function fit(st, width, height) {
    var c = st.camera, bounds = st.modelBounds;
    c.updateMatrixWorld();
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    [bounds.min.x, bounds.max.x].forEach(function (x) { [bounds.min.y, bounds.max.y].forEach(function (y) { [bounds.min.z, bounds.max.z].forEach(function (z) {
      v.set(x, y, z).applyMatrix4(c.matrixWorldInverse);
      minX = Math.min(minX,v.x); maxX = Math.max(maxX,v.x); minY = Math.min(minY,v.y); maxY = Math.max(maxY,v.y);
    }); }); });
    var aspect = width / height, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    var h = Math.max(maxY - minY, (maxX - minX) / aspect) * (st.kind === 'service' ? 0.96 : 1.015);
    c.left = cx - h * aspect / 2; c.right = cx + h * aspect / 2; c.top = cy + h / 2; c.bottom = cy - h / 2;
    c.updateProjectionMatrix();
  }
  function labels(st, r) {
    st.group.updateMatrixWorld(true);
    st.labels.forEach(function (l) {
      v.copy(l.point).applyMatrix4(st.group.matrixWorld).project(st.camera);
      var x = (v.x + 1) * r.width / 2, y = (1 - v.y) * r.height / 2;
      var half = l.el.offsetWidth / 2 + 2;
      x = Math.max(half, Math.min(r.width - half, x));
      y = Math.max(13, Math.min(r.height - 13, y));
      l.el.style.left = x.toFixed(1) + 'px'; l.el.style.top = y.toFixed(1) + 'px';
    });
  }
  function sizeAll() {
    renderer.setSize(innerWidth, innerHeight, false);
    services.forEach(function (st) { if (!st.renderer) return; var r = st.el.getBoundingClientRect(); st.renderer.setSize(Math.max(1,r.width),Math.max(1,r.height),false); });
    request();
  }
  function visible(r) { return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; }
  function request() { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0; if (document.hidden) return;
    var dt = last ? Math.min((now-last)/1000,0.04) : 0; last = now;
    var active = false; frames++;
    renderer.setScissorTest(false); renderer.clear(true,true,true);
    all.forEach(function (st) {
      var r = st.el.getBoundingClientRect(); st.visible = visible(r); st.rect = r;
      if (!st.visible) return;
      if (!reduced) st.time += dt;
      if (st.kind !== 'service' || st.hot) active = true;
      st.group.rotation.y = reduced ? 0 : (st.kind === 'service' ? Math.sin(st.time * 1.7) * (st.hot ? 0.2 : 0) : pointer.x * 0.024);
      if (st.product && !reduced && st.hot) {
        st.product.rotation.y += dt * 0.6;
        if (st.explode) { var gap = 0.14; st.explode.forEach(function (cup, ci) { var s = ci ? 1 : -1; cup.position.x += ((s * (0.99 + gap)) - cup.position.x) * 0.14; }); }
      } else if (st.explode) { st.explode.forEach(function (cup, ci) { var s = ci ? 1 : -1; cup.position.x += (s * 0.99 - cup.position.x) * 0.14; }); }
      fit(st,r.width,r.height);
      if (st.kind === 'hero') {
        packets.forEach(function (p) { p.mesh.position.copy(p.curve.getPointAt((p.phase + (reduced ? 0 : st.time * 0.18)) % 1)); });
        labels(st,r);
      }
      if (st.kind === 'service') {
        if (!st.renderer) return;
        st.renderer.clear(); st.renderer.render(st.scene,st.camera);
      } else {
        // Viewport remains stage-local even when partially scrolled out.
        // Scissor is clipped to the viewport so no pixels can hit a headline.
        var left = Math.max(0,r.left), right = Math.min(innerWidth,r.right);
        var top = Math.max(0,r.top), bottom = Math.min(innerHeight,r.bottom);
        renderer.setViewport(r.left,innerHeight-r.bottom,r.width,r.height);
        renderer.setScissor(left,innerHeight-bottom,right-left,bottom-top);
        renderer.setScissorTest(true); renderer.clearDepth(); renderer.render(st.scene,st.camera);
      }
      st.draws++;
    });
    elapsed += dt;
    if (active && !reduced) request();
  }
  window.addEventListener('resize',sizeAll,{passive:true});
  window.addEventListener('scroll',request,{passive:true});
  window.addEventListener('pointermove',function(e) { if (reduced) return; pointer.x = e.clientX/innerWidth*2-1; pointer.y = e.clientY/innerHeight*2-1; request(); },{passive:true});
  document.addEventListener('visibilitychange',function() { if (document.hidden && raf) { cancelAnimationFrame(raf); raf=0; } last=0; if (!document.hidden) request(); });
  mq.addEventListener('change',function(e) { reduced=e.matches; request(); });
  if (window.ResizeObserver) { var resizeObserver = new ResizeObserver(sizeAll); all.forEach(function(st) { resizeObserver.observe(st.el); }); }
  if (window.IntersectionObserver) { var observer = new IntersectionObserver(request); all.forEach(function(st) { observer.observe(st.el); }); }
  canvas.addEventListener('webglcontextlost',function(e) { e.preventDefault(); api.ready=false; if(raf) cancelAnimationFrame(raf); raf=0; });
  canvas.addEventListener('webglcontextrestored',function() { api.ready=true; sizeAll(); });
  function rectData(r) { return r ? {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height} : null; }
  function finite() {
    var ok = true;
    all.forEach(function(st) { st.scene.traverse(function(o) {
      ['position','scale','rotation'].forEach(function(k) { var a=o[k]; if(a && ![a.x,a.y,a.z].every(Number.isFinite)) ok=false; });
      if(o.geometry && o.geometry.attributes.position) { var a=o.geometry.attributes.position.array; for(var i=0;i<a.length;i++) if(!Number.isFinite(a[i])) ok=false; }
    }); }); return ok;
  }
  api.ready = true;
  api.sizeAll = sizeAll;
  api.setPCDrag = function() {}; // compatibility only; no PC scene exists.
  api.diagnostics = function() {
    var hs = stages.filter(function(s){return s.kind==='hero';})[0];
    var headline = document.querySelector('.hero h1'), hr=headline && headline.getBoundingClientRect();
    var r=hs && hs.el.getBoundingClientRect();
    var clear = !hr || !r || r.left>=hr.right || r.right<=hr.left || r.top>=hr.bottom || r.bottom<=hr.top;
    return {ready:api.ready,finite:finite(),labels:names.slice(),scissor:true,heroClearOfHeadline:clear,
      heroRect:rectData(r),headlineRect:rectData(hr),reducedMotion:reduced,frames:frames,
      paused:document.hidden || !raf,packets:packets.length,toneMapping:'LinearToneMapping',outputEncoding:'sRGB; explicit linear material inputs',transparent:renderer.getClearAlpha()===0,
      labelBounds:hs ? hs.labels.map(function(l){return {text:l.name,font:getComputedStyle(l.el).fontSize,rect:rectData(l.el.getBoundingClientRect())};}) : [],
      stages:all.map(function(s){return {kind:s.kind,key:s.key||s.el.id,visible:s.visible,draws:s.draws,hot:s.hot,rect:rectData(s.el.getBoundingClientRect())};})};
  };
  sizeAll();
})();
