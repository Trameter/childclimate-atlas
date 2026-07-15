/* Hero prototype — Nigeria as an extruded slab with every school dotted on it.
 *
 * Standalone: lives at /hero, linked from nothing, touches no Atlas code. Uses
 * the Three.js already vendored for the detail-panel microscenes (r149 UMD).
 *
 * Data:
 *   nga-adm1.min.geojson  37 states, Douglas-Peucker simplified (120 KB)
 *   nga-dots.bin          [count u32][lon f32*n][lat f32*n][band u8*n] (1.4 MB)
 * Deliberately NOT the 63 MB lite geojson — this page should open fast.
 */
(function () {
  var canvas = document.getElementById("c");
  var loadingEl = document.getElementById("loading");

  // Risk-band palette, matching the Atlas dots.
  var BANDS = [0x6fa774, 0xd9b653, 0xd9894f, 0xc35248]; // low, mid, high, severe

  // Equirectangular about Nigeria's centre. At this scale the cos(lat)
  // correction is all we need; 1 unit == 1 degree of latitude.
  var LON0 = 8.631, LAT0 = 9.078;
  var KX = Math.cos((LAT0 * Math.PI) / 180);
  var DEPTH = 0.42; // slab thickness, in the same units

  function proj(lon, lat) { return [(lon - LON0) * KX, lat - LAT0]; }

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e18);
  scene.fog = new THREE.Fog(0x0a0e18, 24, 52);

  var camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 240);
  camera.position.set(0.6, 9.4, 12.6);
  camera.lookAt(0, 0, 0);

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);

  scene.add(new THREE.AmbientLight(0x93a3c4, 0.55));
  var key = new THREE.DirectionalLight(0xffd9ae, 1.15);
  key.position.set(-6, 12, 8);
  scene.add(key);
  var rim = new THREE.DirectionalLight(0x5b7bd6, 0.5);
  rim.position.set(8, 4, -9);
  scene.add(rim);

  // spin (world Y) > map (laid flat) > slab + dots
  var spin = new THREE.Group();
  var map = new THREE.Group();
  map.rotation.x = -Math.PI / 2;
  spin.add(map);
  scene.add(spin);

  (function starfield() {
    var N = 1400, pos = new Float32Array(N * 3);
    for (var i = 0; i < N; i++) {
      var r = 42 + Math.random() * 46;
      var t = Math.random() * Math.PI * 2;
      var p = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(p) * Math.cos(t);
      pos[i * 3 + 1] = r * Math.cos(p) * 0.5 + 7;
      pos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x9fb0d0, size: 0.11, sizeAttenuation: true,
      transparent: true, opacity: 0.8, depthWrite: false,
    })));
  })();

  // ExtrudeGeometry emits material group 0 for the caps, 1 for the walls, so a
  // darker wall material makes the slab's thickness read.
  var capMat = new THREE.MeshStandardMaterial({ color: 0x2e3648, roughness: 0.82, metalness: 0.06 });
  var wallMat = new THREE.MeshStandardMaterial({ color: 0x161c2a, roughness: 0.9, metalness: 0.04 });

  function ringPts(ring) {
    var out = [];
    for (var i = 0; i < ring.length; i++) out.push(proj(ring[i][0], ring[i][1]));
    return out;
  }
  function centroid(pts) {
    var x = 0, y = 0;
    for (var i = 0; i < pts.length; i++) { x += pts[i][0]; y += pts[i][1]; }
    return [x / pts.length, y / pts.length];
  }
  // Shrink each state a hair toward its own centroid. Adjacent states would
  // otherwise extrude coincident walls along shared borders and z-fight; the
  // resulting hairline gaps read as etched state borders instead.
  function inset(pts, c, k) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      out.push([c[0] + (pts[i][0] - c[0]) * k, c[1] + (pts[i][1] - c[1]) * k]);
    }
    return out;
  }
  function toVec2(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) out.push(new THREE.Vector2(pts[i][0], pts[i][1]));
    return out;
  }

  Promise.all([
    fetch("./nga-adm1.min.geojson").then(function (r) { return r.json(); }),
    fetch("./nga-dots.bin").then(function (r) { return r.arrayBuffer(); }),
  ]).then(function (res) {
    var geo = res[0], buf = res[1];

    geo.features.forEach(function (f) {
      var rings = f.geometry.coordinates.map(ringPts);
      var c = centroid(rings[0]);
      var shape = new THREE.Shape(toVec2(inset(rings[0], c, 0.994)));
      for (var i = 1; i < rings.length; i++) {
        shape.holes.push(new THREE.Path(toVec2(inset(rings[i], c, 0.994))));
      }
      var g = new THREE.ExtrudeGeometry(shape, { depth: DEPTH, bevelEnabled: false });
      map.add(new THREE.Mesh(g, [capMat, wallMat]));
    });

    var dv = new DataView(buf);
    var n = dv.getUint32(0, true);
    var lons = new Float32Array(buf, 4, n);
    var lats = new Float32Array(buf, 4 + n * 4, n);
    var bands = new Uint8Array(buf, 4 + n * 8, n);

    var pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    var tmp = new THREE.Color();
    for (var i = 0; i < n; i++) {
      var p = proj(lons[i], lats[i]);
      pos[i * 3] = p[0];
      pos[i * 3 + 1] = p[1];
      pos[i * 3 + 2] = DEPTH + 0.012; // sit just proud of the cap
      tmp.setHex(BANDS[bands[i]] === undefined ? BANDS[2] : BANDS[bands[i]]);
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    var dg = new THREE.BufferGeometry();
    dg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    dg.setAttribute("color", new THREE.BufferAttribute(col, 3));
    map.add(new THREE.Points(dg, new THREE.PointsMaterial({
      size: 0.028, vertexColors: true, sizeAttenuation: true,
      transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })));

    if (loadingEl) loadingEl.remove();
  }).catch(function (e) {
    if (loadingEl) loadingEl.textContent = "load failed: " + e.message;
    console.error(e);
  });

  addEventListener("resize", function () {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  (function loop() {
    requestAnimationFrame(loop);
    spin.rotation.y += 0.0016;
    renderer.render(scene, camera);
  })();
})();
