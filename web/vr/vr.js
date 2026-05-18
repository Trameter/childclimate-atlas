/* ===========================================================================
   /vr — WebXR Atlas (Category 4)

   Floating tilted globe with facility beacons, slow rotation, severe-band
   beacons pulsing, a star field behind, and a camera intro on load. Country
   switches animate: old beacons fade out, globe rotates to centre the new
   country, new beacons fade in.

   What's wired:
     - Non-VR preview on any WebGL2 browser (orbit drag, scroll zoom,
       hover tooltip, click-for-detail, country picker)
     - WebXR detection — Enter VR button enables only when an
       immersive-vr session type is supported (Quest, Vision Pro, etc.)
     - VR controller pointer + trigger pick when an XR session is active

   What's left for future Category-4 sessions:
     - AR session type for phone passthrough
     - Spatial audio cues on severe-band beacons
     - True country borders (currently just beacons cluster the shape)
     - Smoother teleport / movement controls
   =========================================================================== */

(() => {
  const $ = (id) => document.getElementById(id);

  // --- Country centres (for camera framing + globe rotation on switch) ---
  const COUNTRY_CENTER = {
    NGA: { lat: 9.1,  lng: 8.7,   name: "Nigeria"    },
    BGD: { lat: 23.7, lng: 90.3,  name: "Bangladesh" },
    GTM: { lat: 15.8, lng: -90.2, name: "Guatemala"  },
  };

  // Risk-band colour stops (match the 2D + 3D atlas).
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

  // ---------------------------------------------------------------------
  // Three.js setup
  // ---------------------------------------------------------------------
  const canvas = $("vr-canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.xr.enabled = true;
  renderer.outputEncoding = THREE.sRGBEncoding;

  const scene = new THREE.Scene();
  scene.background = null;

  // Camera + initial position for the cinematic intro (start far, ease in).
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 200);
  const CAM_HOME = new THREE.Vector3(0, 1.6, 2.4);   // standing eye level, ~2.4m back
  const CAM_INTRO = new THREE.Vector3(0, 1.8, 6.5);  // starting far back for the swoop in
  camera.position.copy(CAM_INTRO);
  camera.lookAt(0, 1.0, 0);

  // Lights — soft ambient + a single warm key light so the globe has shading
  // without going dark on the back side.
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xfff2dd, 0.85);
  key.position.set(2.5, 3, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x6FA8C9, 0.25);  // cool fill
  fill.position.set(-2, 1, -2);
  scene.add(fill);

  // --- Star field — far sphere with point sprites for ambient sky depth ---
  function buildStarField() {
    const N = 1500;
    const positions = new Float32Array(N * 3);
    const sizes = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // Random direction, large radius. Avoid the lower hemisphere a bit so
      // the lower half of the view doesn't compete with the floor halo.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 80 + Math.random() * 20;
      positions[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      positions[i*3+1] = Math.abs(r * Math.cos(phi)) * 0.6 + 0.5;  // bias up
      positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
      sizes[i] = 0.04 + Math.random() * 0.10;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xFAF8F4,
      size: 0.20,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });
    return new THREE.Points(geom, mat);
  }
  scene.add(buildStarField());

  // --- Globe group: hovers at eye level, tilted at Earth's axial 23.4° ---
  // (Decorative — the data isn't north-up dependent — but it sells the
  // "this is a real planet" reading rather than a school globe.)
  const GLOBE_RADIUS = 0.42;
  const globeGroup = new THREE.Group();
  globeGroup.position.set(0, 1.35, 0);  // ~1.35m above floor = chest height
  globeGroup.rotation.z = THREE.MathUtils.degToRad(23.4);
  scene.add(globeGroup);

  // Inner sphere — dark base.
  const globeGeom = new THREE.SphereGeometry(GLOBE_RADIUS, 64, 48);
  const globeMat = new THREE.MeshStandardMaterial({
    color: 0x10162A, roughness: 0.85, metalness: 0.06,
  });
  const globe = new THREE.Mesh(globeGeom, globeMat);
  globeGroup.add(globe);

  // Atmosphere halo — back-side sphere with low alpha for the rim glow.
  const haloGeom = new THREE.SphereGeometry(GLOBE_RADIUS * 1.08, 64, 48);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x6FA8C9, transparent: true, opacity: 0.14, side: THREE.BackSide,
  });
  globeGroup.add(new THREE.Mesh(haloGeom, haloMat));

  // Beacons live inside a group that we rotate to centre the active country.
  // Rotation = the inverse of the country's lat/lng → globe-space mapping.
  let beaconsGroup = new THREE.Group();
  globeGroup.add(beaconsGroup);
  // Track each beacon for per-frame pulse animation.
  let pulsingBeacons = [];  // [{mesh, baseScale, baseOpacity}]

  // ---------------------------------------------------------------------
  // Lat/lng → globe-surface vector
  // ---------------------------------------------------------------------
  function latLngToVec3(lat, lng, radius = GLOBE_RADIUS) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (lng + 180) * Math.PI / 180;
    return new THREE.Vector3(
      -radius * Math.sin(phi) * Math.cos(theta),
       radius * Math.cos(phi),
       radius * Math.sin(phi) * Math.sin(theta),
    );
  }

  // ---------------------------------------------------------------------
  // Country state
  // ---------------------------------------------------------------------
  let currentIso = "BGD";
  let currentFeatures = [];

  async function loadCountry(iso) {
    setStatus(`Loading ${COUNTRY_CENTER[iso].name}…`, "loading");
    document.querySelectorAll(".vr-country").forEach(b => {
      b.classList.toggle("active", b.dataset.iso === iso);
    });
    currentIso = iso;
    try {
      const r = await fetch(`/data/${iso}.geojson`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      currentFeatures = json.features || [];
      animateCountrySwap(iso, () => {
        buildBeacons(currentFeatures);
        updateMeta();
        setStatus(`${COUNTRY_CENTER[iso].name} · ${currentFeatures.length.toLocaleString()} facilities`, "ready");
      });
    } catch (e) {
      setStatus(`Failed to load ${iso}: ${e.message}`, "unavailable");
    }
  }

  // Country swap animation — fade beacons out, rotate to centre the new
  // country, fade new beacons in. Times tuned so the fly + fade overlaps
  // and the whole transition feels like one continuous beat (~1.4s total).
  function animateCountrySwap(iso, onMidpoint) {
    const c = COUNTRY_CENTER[iso];
    // Target rotation: rotating the globe so the country's centre faces +Z
    // (toward the camera). Yaw = -lng (in radians); pitch tilts the country
    // upward to the camera's eyeline.
    const targetYaw = -c.lng * Math.PI / 180;
    const targetPitch = c.lat * Math.PI / 180 * 0.5;  // half-tilt feels right

    const startYaw = beaconsGroup.rotation.y;
    const startPitch = beaconsGroup.rotation.x;
    const start = performance.now();
    const DURATION = 900;

    function frame(now) {
      const t = Math.min((now - start) / DURATION, 1);
      const eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      beaconsGroup.rotation.y = startYaw + (targetYaw - startYaw) * eased;
      beaconsGroup.rotation.x = startPitch + (targetPitch - startPitch) * eased;
      // Globe sphere rotates to match the beacons (they're its skin).
      globe.rotation.y = beaconsGroup.rotation.y;
      // Fade out at first half, in at second half.
      const fadeOut = Math.max(0, 1 - t * 2);
      beaconsGroup.children.forEach(c => {
        if (c.material) c.material.opacity = fadeOut * (c.userData.baseOpacity || 1);
      });
      if (t >= 0.5 && !frame._fired) {
        frame._fired = true;
        onMidpoint();  // swap beacons at the midpoint
      }
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------------
  // Beacons
  // ---------------------------------------------------------------------
  const VR_BEACON_CAP = 1500;
  function buildBeacons(features) {
    while (beaconsGroup.children.length) {
      const c = beaconsGroup.children.pop();
      c.geometry?.dispose();
      c.material?.dispose();
    }
    pulsingBeacons = [];

    const sorted = [...features].sort((a, b) =>
      (b.properties.risk_score || 0) - (a.properties.risk_score || 0)
    );
    const top = sorted.slice(0, Math.min(VR_BEACON_CAP, sorted.length));

    const beaconGeom = new THREE.SphereGeometry(0.0030, 8, 6);

    for (const f of top) {
      const [lng, lat] = f.geometry.coordinates;
      const score = f.properties.risk_score || 0;
      const band = bandFor(score);
      const surfacePos = latLngToVec3(lat, lng, GLOBE_RADIUS);
      const stalkHeight = 0.018 + (score / 100) * 0.060;
      const beaconPos = surfacePos.clone().multiplyScalar((GLOBE_RADIUS + stalkHeight) / GLOBE_RADIUS);

      const baseOpacity = band === 0 ? 0.55 : band === 1 ? 0.75 : 0.95;
      const mat = new THREE.MeshBasicMaterial({
        color: colorFor(score),
        transparent: true,
        opacity: 0,  // fade-in handled below
      });
      const m = new THREE.Mesh(beaconGeom, mat);
      m.position.copy(beaconPos);
      m.userData.feature = f;
      m.userData.baseOpacity = baseOpacity;
      m.userData.baseScale = 1 + (band === 3 ? 0.6 : 0);  // severe = bigger
      m.userData.band = band;
      m.scale.setScalar(m.userData.baseScale);
      beaconsGroup.add(m);

      if (band === 3) pulsingBeacons.push(m);

      // Stalk line for the taller beacons, so the height-encodes-risk
      // reading is clear at a glance.
      if (stalkHeight > 0.025) {
        const stalkGeom = new THREE.BufferGeometry().setFromPoints([surfacePos, beaconPos]);
        const stalkMat = new THREE.LineBasicMaterial({
          color: colorFor(score),
          transparent: true,
          opacity: 0,  // fade-in handled below
        });
        const stalk = new THREE.Line(stalkGeom, stalkMat);
        stalk.userData.baseOpacity = baseOpacity * 0.50;
        beaconsGroup.add(stalk);
      }
    }

    // Fade-in over 800ms.
    const start = performance.now();
    const FADE_MS = 800;
    function fadeFrame(now) {
      const t = Math.min((now - start) / FADE_MS, 1);
      beaconsGroup.children.forEach(c => {
        if (c.material) c.material.opacity = t * (c.userData.baseOpacity || 1);
      });
      if (t < 1) requestAnimationFrame(fadeFrame);
    }
    requestAnimationFrame(fadeFrame);
  }

  function updateMeta() {
    const severe = currentFeatures.filter(f => (f.properties.risk_score || 0) >= 75).length;
    const total = currentFeatures.length;
    $("vr-meta-line").textContent = `${total.toLocaleString()} facilities · ${severe.toLocaleString()} severe`;
  }

  // ---------------------------------------------------------------------
  // WebXR detection + button + controller pointer
  // ---------------------------------------------------------------------
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
        btn.title = "This browser has WebXR but no immersive-vr session type. On desktop Chrome, try a WebXR emulator extension.";
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

  // Controllers — Three.js provides .getController(i) which returns an
  // empty group that gets its pose updated each frame. We attach a thin
  // line in front of it as a pointer; trigger ('select') casts a ray and
  // drills into the targeted beacon.
  const controllerPointerMat = new THREE.LineBasicMaterial({
    color: 0xD87B4F, transparent: true, opacity: 0.85,
  });
  const controllerPointerGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -2),
  ]);
  function attachController(idx) {
    const c = renderer.xr.getController(idx);
    const line = new THREE.Line(controllerPointerGeom.clone(), controllerPointerMat.clone());
    line.scale.z = 2;
    c.add(line);
    c.addEventListener("select", () => xrPick(c));
    scene.add(c);
    return c;
  }
  let controllers = [];

  let xrSession = null;
  async function enterVr() {
    if (xrSession) return;
    try {
      xrSession = await navigator.xr.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"],
      });
      document.body.classList.add("in-xr");
      await renderer.xr.setSession(xrSession);
      controllers = [attachController(0), attachController(1)];
      xrSession.addEventListener("end", () => {
        document.body.classList.remove("in-xr");
        xrSession = null;
        controllers.forEach(c => scene.remove(c));
        controllers = [];
        $("vr-enter-btn").querySelector(".vr-enter-label").textContent = "Enter VR";
      });
      $("vr-enter-btn").querySelector(".vr-enter-label").textContent = "Exit VR";
    } catch (e) {
      setStatus(`Couldn't start VR: ${e.message}`, "unavailable");
    }
  }

  const xrRaycaster = new THREE.Raycaster();
  const xrTmpMat = new THREE.Matrix4();
  function xrPick(controller) {
    xrTmpMat.identity().extractRotation(controller.matrixWorld);
    xrRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    xrRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(xrTmpMat);
    const hits = xrRaycaster.intersectObjects(beaconsGroup.children, false);
    const hit = hits.find(h => h.object.userData.feature);
    if (hit) showDetail(hit.object.userData.feature);
  }

  // ---------------------------------------------------------------------
  // Non-VR preview — mouse orbit, scroll zoom, hover tooltip, click detail
  // ---------------------------------------------------------------------
  let isDragging = false, lastX = 0, lastY = 0;
  let userInteracting = false;
  let lastInteract = 0;
  const AUTO_ROTATE_RESUME_MS = 3500;
  const AUTO_ROTATE_SPEED = 0.0010;

  canvas.addEventListener("mousedown", (e) => {
    isDragging = true; lastX = e.clientX; lastY = e.clientY;
    userInteracting = true; lastInteract = performance.now();
  });
  window.addEventListener("mouseup", () => { isDragging = false; });
  window.addEventListener("mousemove", (e) => {
    if (isDragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      globeGroup.rotation.y += dx * 0.005;
      globeGroup.rotation.x += dy * 0.005;
      globeGroup.rotation.x = Math.max(-Math.PI/2.2, Math.min(Math.PI/2.2, globeGroup.rotation.x));
      lastInteract = performance.now();
    }
    updateHover(e.clientX, e.clientY);
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.position.z = Math.max(0.9, Math.min(8, camera.position.z + e.deltaY * 0.003));
    lastInteract = performance.now();
  }, { passive: false });

  // Hover tooltip — DOM element that follows the cursor, shows name + score.
  const tooltip = document.createElement("div");
  tooltip.className = "vr-tooltip";
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function updateHover(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(beaconsGroup.children, false);
    const hit = hits.find(h => h.object.userData.feature);
    if (hit) {
      const f = hit.object.userData.feature;
      const s = (f.properties.risk_score || 0).toFixed(0);
      const name = f.properties.name || "Unnamed facility";
      tooltip.innerHTML = `<span class="t">${escapeHtml(name)}</span><span class="s">${s}</span>`;
      tooltip.style.left = (clientX + 14) + "px";
      tooltip.style.top = (clientY + 14) + "px";
      tooltip.hidden = false;
      canvas.style.cursor = "pointer";
    } else {
      tooltip.hidden = true;
      canvas.style.cursor = isDragging ? "grabbing" : "grab";
    }
  }
  canvas.addEventListener("mouseleave", () => { tooltip.hidden = true; });

  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(beaconsGroup.children, false);
    const hit = hits.find(h => h.object.userData.feature);
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

  // ---------------------------------------------------------------------
  // Country picker
  // ---------------------------------------------------------------------
  document.querySelectorAll(".vr-country").forEach(b => {
    b.addEventListener("click", () => loadCountry(b.dataset.iso));
  });

  // ---------------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------------
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // ---------------------------------------------------------------------
  // Camera intro animation (fly from CAM_INTRO -> CAM_HOME)
  // ---------------------------------------------------------------------
  const INTRO_MS = 2200;
  const introStart = performance.now();
  function runIntro(now) {
    const t = Math.min((now - introStart) / INTRO_MS, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(CAM_INTRO, CAM_HOME, eased);
    camera.lookAt(0, 1.0, 0);
    return t < 1;
  }

  // ---------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------
  renderer.setAnimationLoop((time, frame) => {
    // Intro
    if (introStart > 0 && runIntro(performance.now())) {
      // still running
    }

    // Auto-rotate when idle
    if (!userInteracting || (performance.now() - lastInteract > AUTO_ROTATE_RESUME_MS)) {
      userInteracting = false;
      globeGroup.rotation.y += AUTO_ROTATE_SPEED;
    }

    // Severe-band beacon pulse
    const tNow = performance.now() * 0.001;
    for (const m of pulsingBeacons) {
      const pulse = 0.85 + 0.15 * Math.sin(tNow * 2.2);
      m.scale.setScalar(m.userData.baseScale * pulse);
      m.material.opacity = m.userData.baseOpacity * (0.75 + 0.25 * Math.sin(tNow * 2.2));
    }

    renderer.render(scene, camera);
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  setupXrButton();
  loadCountry(currentIso);
})();
