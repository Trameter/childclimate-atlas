/* ===========================================================================
   /vr — WebXR Atlas (Category 4 foundation)

   Tabletop globe at standing height. Each country can be loaded; facilities
   appear as glowing beacons positioned on the sphere by lat/lng, sized +
   coloured by their 0–100 risk score. In a WebXR session the user can walk
   around the table and look at the beacons from any angle; in the non-VR
   preview the same scene renders with mouse-orbit + scroll-zoom controls
   so anyone without a headset can see what's there.

   This is the foundation for Category 4 (Agog territory):
     - VR mode             [this file] ✓
     - AR mode             [planned — same scene, AR session type]
     - Spatial audio cues  [planned]
     - Hand-controller picks [planned]

   Browser support: any WebGL2 browser renders the preview. WebXR session
   entry requires navigator.xr (Quest, Vision Pro, Android Chrome) + the
   `immersive-vr` session type. On unsupported devices the Enter VR button
   stays disabled with a tooltip explaining why.
   =========================================================================== */

(() => {
  const $ = (id) => document.getElementById(id);
  const RISK_STOPS = [
    [0,  0x6FA774],   // low
    [30, 0xD9B653],   // moderate
    [55, 0xD9894F],   // high
    [75, 0xC35248],   // severe
  ];
  const RISK_LABELS = ["low", "mid", "high", "severe"];
  const bandFor = (s) => s < 30 ? 0 : s < 55 ? 1 : s < 75 ? 2 : 3;
  const colorFor = (s) => {
    let c = RISK_STOPS[0][1];
    for (const [stop, col] of RISK_STOPS) { if (s >= stop) c = col; }
    return c;
  };

  // ---- Three.js scene setup ----
  const canvas = $("vr-canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.xr.enabled = true;
  renderer.outputEncoding = THREE.sRGBEncoding;

  const scene = new THREE.Scene();
  scene.background = null;

  // Camera + orbit-style controls for non-VR preview.
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(0, 1.6, 2.2);  // standing height, ~2m back from globe
  camera.lookAt(0, 1.0, 0);

  // Subtle ambient + directional light so the globe has shading.
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const dir = new THREE.DirectionalLight(0xfff2dd, 0.8);
  dir.position.set(2, 3, 1.5);
  scene.add(dir);

  // The "table" plane at floor level for VR spatial reference.
  const tableGeom = new THREE.CircleGeometry(0.8, 48);
  const tableMat = new THREE.MeshBasicMaterial({
    color: 0x1E2433, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
  });
  const table = new THREE.Mesh(tableGeom, tableMat);
  table.rotation.x = -Math.PI / 2;
  table.position.y = 0;
  scene.add(table);

  // Tabletop globe — a sphere ~60 cm in diameter sitting on the table.
  const GLOBE_RADIUS = 0.32;
  const globeGroup = new THREE.Group();
  globeGroup.position.set(0, 0.32 + 0.36, 0);  // table at 0, globe centre at ~1m
  scene.add(globeGroup);

  const globeGeom = new THREE.SphereGeometry(GLOBE_RADIUS, 64, 48);
  const globeMat = new THREE.MeshStandardMaterial({
    color: 0x12182A,
    roughness: 0.85,
    metalness: 0.05,
  });
  const globe = new THREE.Mesh(globeGeom, globeMat);
  globeGroup.add(globe);

  // Subtle atmosphere ring around the globe — a slightly larger sphere with
  // back-side rendering + alpha, fakes the bright halo from the 3D page.
  const haloGeom = new THREE.SphereGeometry(GLOBE_RADIUS * 1.04, 64, 48);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x6FA8C9, transparent: true, opacity: 0.10, side: THREE.BackSide,
  });
  globeGroup.add(new THREE.Mesh(haloGeom, haloMat));

  // Beacons group — holds the per-facility instanced meshes for the current country.
  let beaconsGroup = new THREE.Group();
  globeGroup.add(beaconsGroup);

  // Slow, subtle globe rotation when no user interaction.
  let autoRotate = true;
  let lastInteract = 0;
  const AUTO_ROTATE_RESUME_MS = 4000;
  const AUTO_ROTATE_SPEED = 0.0008;  // radians per frame

  // ---- Lat/lng → cartesian on the globe ----
  function latLngToVec3(lat, lng, radius = GLOBE_RADIUS) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (lng + 180) * Math.PI / 180;
    return new THREE.Vector3(
      -radius * Math.sin(phi) * Math.cos(theta),
       radius * Math.cos(phi),
       radius * Math.sin(phi) * Math.sin(theta),
    );
  }

  // ---- Load and render a country ----
  let currentIso = "BGD";  // default — has SEVERE band populated now
  let currentFeatures = [];

  async function loadCountry(iso) {
    setStatus(`Loading ${iso}…`, "loading");
    currentIso = iso;
    document.querySelectorAll(".vr-country").forEach(b => {
      b.classList.toggle("active", b.dataset.iso === iso);
    });
    try {
      const r = await fetch(`/data/${iso}.geojson`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      currentFeatures = json.features || [];
      buildBeacons(currentFeatures);
      updateMeta();
      setStatus(`${iso} loaded · ${currentFeatures.length.toLocaleString()} facilities`, "ready");
    } catch (e) {
      setStatus(`Failed to load ${iso}: ${e.message}`, "unavailable");
    }
  }

  // ---- Beacon rendering ----
  // Top-N approach: showing 50K beacons is fine on desktop but kills VR
  // headset performance. Sample the top 1500 by risk for VR-friendly framerates.
  const VR_BEACON_CAP = 1500;
  function buildBeacons(features) {
    // Tear down previous beacons.
    while (beaconsGroup.children.length) {
      const c = beaconsGroup.children.pop();
      c.geometry?.dispose();
      c.material?.dispose();
    }

    // Top N by risk score, then sample some lower-risk for context.
    const sorted = [...features].sort((a, b) =>
      (b.properties.risk_score || 0) - (a.properties.risk_score || 0)
    );
    const top = sorted.slice(0, Math.min(VR_BEACON_CAP, sorted.length));

    // One small sphere per beacon, positioned on the globe surface, raised
    // along its surface normal proportional to risk. A high-risk facility
    // becomes a tall stalk; a low-risk one sits flat.
    const beaconGeom = new THREE.SphereGeometry(0.0024, 8, 6);
    for (const f of top) {
      const [lng, lat] = f.geometry.coordinates;
      const score = f.properties.risk_score || 0;
      const surfacePos = latLngToVec3(lat, lng, GLOBE_RADIUS);
      const stalkHeight = 0.015 + (score / 100) * 0.040;  // 1.5cm to 5.5cm
      const beaconPos = surfacePos.clone().multiplyScalar((GLOBE_RADIUS + stalkHeight) / GLOBE_RADIUS);

      const mat = new THREE.MeshBasicMaterial({ color: colorFor(score) });
      const m = new THREE.Mesh(beaconGeom, mat);
      m.position.copy(beaconPos);
      m.userData.feature = f;
      beaconsGroup.add(m);

      // Thin stalk line from surface to beacon for tall ones, so the
      // height-encodes-risk reading is clear.
      if (stalkHeight > 0.02) {
        const stalkGeom = new THREE.BufferGeometry().setFromPoints([surfacePos, beaconPos]);
        const stalkMat = new THREE.LineBasicMaterial({
          color: colorFor(score), transparent: true, opacity: 0.45,
        });
        beaconsGroup.add(new THREE.Line(stalkGeom, stalkMat));
      }
    }
  }

  function updateMeta() {
    const severe = currentFeatures.filter(f => (f.properties.risk_score || 0) >= 75).length;
    const total = currentFeatures.length;
    $("vr-meta-line").textContent = `${total.toLocaleString()} facilities · ${severe.toLocaleString()} severe`;
  }

  // ---- WebXR detection + button wiring ----
  function setStatus(text, klass) {
    const el = $("vr-status");
    el.querySelector(".vr-status-text").textContent = text;
    el.classList.remove("ready", "loading", "unavailable");
    if (klass) el.classList.add(klass);
  }

  async function setupXrButton() {
    const btn = $("vr-enter-btn");
    if (!navigator.xr) {
      btn.disabled = true;
      btn.title = "WebXR not available in this browser. Open this page in a Quest browser, Android Chrome, or use a WebXR emulator extension on desktop Chrome.";
      btn.querySelector(".vr-enter-label").textContent = "VR not supported";
      return;
    }
    try {
      const supported = await navigator.xr.isSessionSupported("immersive-vr");
      if (!supported) {
        btn.disabled = true;
        btn.title = "This browser has WebXR but no immersive-vr session type. On a desktop, try a WebXR emulator extension.";
        btn.querySelector(".vr-enter-label").textContent = "VR not supported";
        return;
      }
      btn.disabled = false;
      btn.title = "Enter the immersive VR session";
      btn.addEventListener("click", enterVr);
    } catch (e) {
      btn.disabled = true;
      btn.title = `WebXR error: ${e.message}`;
    }
  }

  let xrSession = null;
  async function enterVr() {
    if (xrSession) return;
    try {
      xrSession = await navigator.xr.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"],
      });
      document.body.classList.add("in-xr");
      await renderer.xr.setSession(xrSession);
      xrSession.addEventListener("end", () => {
        document.body.classList.remove("in-xr");
        xrSession = null;
        $("vr-enter-btn").querySelector(".vr-enter-label").textContent = "Enter VR";
      });
      $("vr-enter-btn").querySelector(".vr-enter-label").textContent = "Exit VR";
    } catch (e) {
      setStatus(`Couldn't start VR: ${e.message}`, "unavailable");
    }
  }

  // ---- Mouse-orbit controls for the non-VR preview ----
  // Lightweight inline implementation; we don't want to vendor OrbitControls
  // for just this one page. Drag rotates the globe group; scroll zooms the
  // camera along its forward axis.
  let isDragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener("mousedown", (e) => { isDragging = true; lastX = e.clientX; lastY = e.clientY; lastInteract = performance.now(); });
  window.addEventListener("mouseup", () => { isDragging = false; });
  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    globeGroup.rotation.y += dx * 0.005;
    globeGroup.rotation.x += dy * 0.005;
    globeGroup.rotation.x = Math.max(-Math.PI/2.2, Math.min(Math.PI/2.2, globeGroup.rotation.x));
    autoRotate = false;
    lastInteract = performance.now();
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.position.z = Math.max(0.8, Math.min(5, camera.position.z + e.deltaY * 0.003));
    lastInteract = performance.now();
  }, { passive: false });

  // ---- Click on beacon → show detail bubble (preview only) ----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObjects(beaconsGroup.children, false);
    const hit = intersects.find(i => i.object.userData.feature);
    if (hit) showDetail(hit.object.userData.feature);
  });

  function showDetail(feature) {
    const p = feature.properties;
    const s = p.risk_score || 0;
    const drivers = typeof p.top_drivers === "string" ? JSON.parse(p.top_drivers) : (p.top_drivers || []);
    const topDriver = (drivers[0] || "").replace(/_/g, " ");
    const band = RISK_LABELS[bandFor(s)];
    $("vr-detail-body").innerHTML = `
      <h3>${escapeHtml(p.name || "Unnamed facility")}</h3>
      <div class="vr-loc">${escapeHtml(p.facility_type || "")} · ${feature.geometry.coordinates[1].toFixed(3)}°, ${feature.geometry.coordinates[0].toFixed(3)}°</div>
      <div class="vr-score">
        <span class="vr-score-num">${s.toFixed(0)}</span>
        <span class="vr-score-band ${band}">${band === "mid" ? "moderate" : band}</span>
      </div>
      ${topDriver ? `<div class="vr-driver">Top driver · ${escapeHtml(topDriver)}</div>` : ""}
    `;
    $("vr-detail").hidden = false;
  }
  $("vr-detail-close").addEventListener("click", () => { $("vr-detail").hidden = true; });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- Country picker ----
  document.querySelectorAll(".vr-country").forEach(b => {
    b.addEventListener("click", () => loadCountry(b.dataset.iso));
  });

  // ---- Resize ----
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // ---- Render loop ----
  renderer.setAnimationLoop((time, frame) => {
    if (autoRotate || (performance.now() - lastInteract > AUTO_ROTATE_RESUME_MS)) {
      autoRotate = true;
      globeGroup.rotation.y += AUTO_ROTATE_SPEED;
    }
    renderer.render(scene, camera);
  });

  // ---- Init ----
  setupXrButton();
  loadCountry(currentIso);
})();
