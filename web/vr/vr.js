/* ===========================================================================
   /vr — WebXR Atlas (Category 4)

   Floating tilted globe at chest height. All three countries' facility
   beacons load in parallel and render simultaneously on the globe; the
   active country is full opacity, the others dim to 30% so the global
   pattern stays visible while the active one foregrounds.

   Severe-band facilities (75+) get an expanding ring + scale/opacity
   pulse so they scream out in peripheral vision. Country labels overlay
   the visible hemisphere via screen projection. Soft ambient drone can
   be toggled for an immersive audio mood (off by default; needs a user
   gesture before AudioContext will start).

   Browser support:
     - Non-VR preview: any WebGL2 browser. Orbit drag, scroll zoom,
       hover tooltip, click for detail, country picker, sound toggle.
     - Immersive VR: navigator.xr + 'immersive-vr' (Quest, Vision Pro,
       desktop Chrome via WebXR emulator extension).
     - Immersive AR: navigator.xr + 'immersive-ar' (Android Chrome,
       Quest passthrough).
   =========================================================================== */

(() => {
  const $ = (id) => document.getElementById(id);

  const COUNTRY_CENTER = {
    NGA: { lat: 9.1,  lng: 8.7,   name: "Nigeria"    },
    BGD: { lat: 23.7, lng: 90.3,  name: "Bangladesh" },
    GTM: { lat: 15.8, lng: -90.2, name: "Guatemala"  },
  };
  const ISOS = Object.keys(COUNTRY_CENTER);

  const RISK_STOPS = [
    [0,  0x6FA774],
    [30, 0xD9B653],
    [55, 0xD9894F],
    [75, 0xC35248],
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

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 200);
  const CAM_HOME = new THREE.Vector3(0, 1.6, 2.4);
  const CAM_INTRO = new THREE.Vector3(0, 1.8, 6.5);
  camera.position.copy(CAM_INTRO);
  camera.lookAt(0, 1.0, 0);

  // AudioListener attaches to camera for spatial-aware listening pose.
  const listener = new THREE.AudioListener();
  camera.add(listener);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xfff2dd, 0.85);
  key.position.set(2.5, 3, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x6FA8C9, 0.25);
  fill.position.set(-2, 1, -2);
  scene.add(fill);

  // --- Star field ---
  function buildStarField() {
    const N = 1500;
    const positions = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 80 + Math.random() * 20;
      positions[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      positions[i*3+1] = Math.abs(r * Math.cos(phi)) * 0.6 + 0.5;
      positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xFAF8F4, size: 0.20, sizeAttenuation: true,
      transparent: true, opacity: 0.65, depthWrite: false,
    });
    return new THREE.Points(geom, mat);
  }
  scene.add(buildStarField());

  // --- Globe ---
  const GLOBE_RADIUS = 0.42;
  const globeGroup = new THREE.Group();
  globeGroup.position.set(0, 1.35, 0);
  globeGroup.rotation.z = THREE.MathUtils.degToRad(23.4);
  scene.add(globeGroup);

  const globeGeom = new THREE.SphereGeometry(GLOBE_RADIUS, 64, 48);
  const globeMat = new THREE.MeshStandardMaterial({
    color: 0x10162A, roughness: 0.85, metalness: 0.06,
  });
  globeGroup.add(new THREE.Mesh(globeGeom, globeMat));

  const haloGeom = new THREE.SphereGeometry(GLOBE_RADIUS * 1.08, 64, 48);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x6FA8C9, transparent: true, opacity: 0.14, side: THREE.BackSide,
  });
  globeGroup.add(new THREE.Mesh(haloGeom, haloMat));

  // --- Graticule (lat/lng grid) ---
  function buildGraticule() {
    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({
      color: 0xFAF8F4, transparent: true, opacity: 0.10,
    });
    const segs = 96;
    for (const lat of [-60, -30, 0, 30, 60]) {
      const pts = [];
      for (let i = 0; i <= segs; i++) {
        pts.push(latLngToVec3(lat, -180 + (360 * i / segs), GLOBE_RADIUS * 1.001));
      }
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const m = mat.clone();
      if (lat === 0) m.opacity = 0.18;
      group.add(new THREE.Line(g, m));
    }
    for (const lng of [-150, -90, -30, 30, 90, 150]) {
      const pts = [];
      for (let i = 0; i <= segs / 2; i++) {
        pts.push(latLngToVec3(-90 + (180 * i / (segs / 2)), lng, GLOBE_RADIUS * 1.001));
      }
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      group.add(new THREE.Line(g, mat.clone()));
    }
    return group;
  }
  globeGroup.add(buildGraticule());

  // --- Per-country beacon groups (loaded in parallel on startup) ---
  // Each country gets its own Group containing beacons + severe rings.
  // The Group's children's materials carry a `currentOpacity` we tween
  // toward `targetOpacity` each frame for smooth dimming on country swap.
  const beaconsGroups = {};      // iso -> THREE.Group
  const countryData = {};        // iso -> features array
  const pulsingBeacons = [];     // [{mesh, baseOpacity, baseScale, iso}]
  const pulsingRings = [];       // [{mesh, basePos, phase, iso}]
  let currentIso = "BGD";

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
  // Country loading
  // ---------------------------------------------------------------------
  const VR_BEACON_CAP = 1500;

  async function loadOneCountry(iso) {
    if (countryData[iso]) return;
    try {
      const r = await fetch(`/data/${iso}.geojson`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      const features = json.features || [];
      countryData[iso] = features;
      const group = buildBeaconsGroup(features, iso);
      beaconsGroups[iso] = group;
      globeGroup.add(group);
      applyCountryOpacities();
    } catch (e) {
      console.warn(`[vr] couldn't load ${iso}:`, e);
    }
  }

  async function init() {
    setStatus("Loading the atlas…", "loading");
    // Active country first so beacons appear ASAP, others stream in.
    await loadOneCountry(currentIso);
    setStatus(`${COUNTRY_CENTER[currentIso].name} loaded · ${countryData[currentIso].length.toLocaleString()} facilities`, "ready");
    updateMeta();
    // Centre the globe on the active country so its beacons face the
    // camera, instead of defaulting to the prime-meridian default.
    animateGlobeToCountry(currentIso);
    for (const iso of ISOS) {
      if (iso !== currentIso) loadOneCountry(iso);  // fire-and-forget
    }
  }

  function buildBeaconsGroup(features, iso) {
    const group = new THREE.Group();
    group.userData.iso = iso;
    group.userData.currentOpacity = (iso === currentIso) ? 1.0 : 0.30;
    group.userData.targetOpacity = group.userData.currentOpacity;

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
        color: colorFor(score), transparent: true, opacity: 0,
      });
      const m = new THREE.Mesh(beaconGeom, mat);
      m.position.copy(beaconPos);
      m.userData.feature = f;
      m.userData.baseOpacity = baseOpacity;
      m.userData.baseScale = 1 + (band === 3 ? 0.6 : 0);
      m.userData.band = band;
      m.userData.iso = iso;
      m.scale.setScalar(m.userData.baseScale);
      group.add(m);

      if (band === 3) pulsingBeacons.push(m);

      if (stalkHeight > 0.025) {
        const stalkGeom = new THREE.BufferGeometry().setFromPoints([surfacePos, beaconPos]);
        const stalkMat = new THREE.LineBasicMaterial({
          color: colorFor(score), transparent: true, opacity: 0,
        });
        const stalk = new THREE.Line(stalkGeom, stalkMat);
        stalk.userData.baseOpacity = baseOpacity * 0.50;
        stalk.userData.iso = iso;
        group.add(stalk);
      }
    }

    // Severe-band expanding rings. One ring per severe beacon, oriented
    // tangent to the sphere surface (face outward). Per-frame scales +
    // fades to create an expanding-pulse loop.
    const ringGeom = new THREE.RingGeometry(0.012, 0.018, 32);
    const severeFeats = top.filter(f => (f.properties.risk_score || 0) >= 75);
    for (const f of severeFeats) {
      const [lng, lat] = f.geometry.coordinates;
      const surfacePos = latLngToVec3(lat, lng, GLOBE_RADIUS * 1.006);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xC35248, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeom, ringMat);
      ring.position.copy(surfacePos);
      // Face OUTWARD from globe center (RingGeometry's +Z normal aligns
      // with the radial direction).
      ring.lookAt(globeGroup.position);
      ring.userData.basePos = surfacePos.clone();
      ring.userData.phase = Math.random() * 2;  // [0,2) random offset in the loop
      ring.userData.iso = iso;
      group.add(ring);
      pulsingRings.push(ring);
    }

    // Fade-in over 700ms.
    const start = performance.now();
    function fadeFrame(now) {
      const t = Math.min((now - start) / 700, 1);
      group.userData.currentOpacity = group.userData.targetOpacity * t;
      applyGroupOpacity(group, group.userData.currentOpacity);
      if (t < 1) requestAnimationFrame(fadeFrame);
    }
    requestAnimationFrame(fadeFrame);

    return group;
  }

  function applyGroupOpacity(group, baseFactor) {
    for (const c of group.children) {
      if (!c.material) continue;
      const base = c.userData.baseOpacity != null ? c.userData.baseOpacity : 1;
      c.material.opacity = base * baseFactor;
    }
  }

  function applyCountryOpacities() {
    for (const iso of ISOS) {
      const g = beaconsGroups[iso];
      if (!g) continue;
      g.userData.targetOpacity = (iso === currentIso) ? 1.0 : 0.30;
    }
  }

  function setActiveCountry(iso) {
    if (iso === currentIso) return;
    currentIso = iso;
    document.querySelectorAll(".vr-country").forEach(b => {
      b.classList.toggle("active", b.dataset.iso === iso);
    });
    applyCountryOpacities();
    animateGlobeToCountry(iso);
    updateMeta();
    setStatus(`${COUNTRY_CENTER[iso].name} · ${(countryData[iso]?.length || 0).toLocaleString()} facilities`, "ready");
  }

  function animateGlobeToCountry(iso) {
    const c = COUNTRY_CENTER[iso];
    // Targets so that the country centre faces the camera (+Z).
    const targetYaw = -c.lng * Math.PI / 180;
    const targetPitch = c.lat * Math.PI / 180 * 0.5;

    const startYaw = globeGroup.rotation.y;
    const startPitch = globeGroup.rotation.x;
    const start = performance.now();
    const DURATION = 1100;

    function frame(now) {
      const t = Math.min((now - start) / DURATION, 1);
      const eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      globeGroup.rotation.y = startYaw + (targetYaw - startYaw) * eased;
      globeGroup.rotation.x = startPitch + (targetPitch - startPitch) * eased;
      lastInteract = performance.now();  // suppress auto-rotate during animation
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function updateMeta() {
    const feats = countryData[currentIso] || [];
    const severe = feats.filter(f => (f.properties.risk_score || 0) >= 75).length;
    $("vr-meta-line").textContent = `${feats.length.toLocaleString()} facilities · ${severe.toLocaleString()} severe`;
  }

  // ---------------------------------------------------------------------
  // Country labels (DOM overlay)
  // ---------------------------------------------------------------------
  const COUNTRY_LABEL_ANCHORS = {};
  function setupCountryLabels() {
    const container = $("vr-country-labels");
    if (!container) return;
    container.innerHTML = "";
    for (const iso of ISOS) {
      const c = COUNTRY_CENTER[iso];
      COUNTRY_LABEL_ANCHORS[iso] = latLngToVec3(c.lat, c.lng, GLOBE_RADIUS * 1.18);
      const el = document.createElement("div");
      el.className = "vr-country-label";
      el.dataset.iso = iso;
      el.textContent = c.name;
      container.appendChild(el);
    }
  }
  setupCountryLabels();

  function updateCountryLabels() {
    if (xrSession) return;
    const container = $("vr-country-labels");
    if (!container) return;
    const cameraWorld = camera.getWorldPosition(new THREE.Vector3());
    const globeWorld = globeGroup.getWorldPosition(new THREE.Vector3());
    const camToGlobe = new THREE.Vector3().subVectors(cameraWorld, globeWorld).normalize();
    for (const el of container.children) {
      const iso = el.dataset.iso;
      const anchor = COUNTRY_LABEL_ANCHORS[iso];
      if (!anchor) continue;
      const world = anchor.clone().applyMatrix4(globeGroup.matrixWorld);
      const dirFromCenter = new THREE.Vector3().subVectors(world, globeWorld).normalize();
      const facing = dirFromCenter.dot(camToGlobe);
      if (facing < 0.05) { el.style.opacity = "0"; continue; }
      const projected = world.clone().project(camera);
      const x = (projected.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-projected.y * 0.5 + 0.5) * window.innerHeight;
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.opacity = String(Math.min(1, facing * 1.6));
      el.classList.toggle("active", iso === currentIso);
      el.classList.toggle("dim", iso !== currentIso);
    }
  }

  // ---------------------------------------------------------------------
  // WebXR — VR + AR session entry
  // ---------------------------------------------------------------------
  function setStatus(text, klass) {
    const el = $("vr-status");
    el.querySelector(".vr-status-text").textContent = text;
    el.classList.remove("ready", "loading", "unavailable");
    if (klass) el.classList.add(klass);
  }

  async function setupXrButton() {
    const vrBtn = $("vr-enter-btn");
    const arBtn = $("vr-ar-btn");
    if (!navigator.xr) {
      vrBtn.disabled = true;
      vrBtn.title = "WebXR not available. Open in a Quest browser, Android Chrome, or use a WebXR emulator on desktop Chrome.";
      vrBtn.querySelector(".vr-enter-label").textContent = "VR not supported";
      arBtn.disabled = true;
      arBtn.title = "WebXR not available.";
      arBtn.querySelector(".vr-enter-label").textContent = "AR not supported";
      return;
    }
    try {
      const vrOk = await navigator.xr.isSessionSupported("immersive-vr");
      if (vrOk) {
        vrBtn.disabled = false;
        vrBtn.title = "Enter the immersive VR session";
        vrBtn.addEventListener("click", () => enterXr("immersive-vr"));
      } else {
        vrBtn.title = "No immersive-vr support in this browser.";
        vrBtn.querySelector(".vr-enter-label").textContent = "VR not supported";
      }
    } catch (e) { vrBtn.title = `WebXR error: ${e.message}`; }
    try {
      const arOk = await navigator.xr.isSessionSupported("immersive-ar");
      if (arOk) {
        arBtn.disabled = false;
        arBtn.title = "Drop the globe into your physical room (AR passthrough)";
        arBtn.addEventListener("click", () => enterXr("immersive-ar"));
      } else {
        arBtn.title = "No immersive-ar support in this browser.";
        arBtn.querySelector(".vr-enter-label").textContent = "AR not supported";
      }
    } catch (e) { arBtn.title = `WebXR AR error: ${e.message}`; }
  }

  // --- VR controller pointer + trigger pick ---
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
  let xrSessionType = null;
  async function enterXr(sessionType) {
    if (xrSession) return;
    try {
      const opts = sessionType === "immersive-ar"
        ? { requiredFeatures: ["local-floor"], optionalFeatures: ["hit-test", "dom-overlay", "hand-tracking"], domOverlay: { root: document.body } }
        : { optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"] };
      xrSession = await navigator.xr.requestSession(sessionType, opts);
      xrSessionType = sessionType;
      document.body.classList.add("in-xr");
      document.body.classList.toggle("in-xr-ar", sessionType === "immersive-ar");
      await renderer.xr.setSession(xrSession);
      controllers = [attachController(0), attachController(1)];
      if (sessionType === "immersive-ar") scene.background = null;
      xrSession.addEventListener("end", () => {
        document.body.classList.remove("in-xr", "in-xr-ar");
        xrSession = null; xrSessionType = null;
        controllers.forEach(c => scene.remove(c));
        controllers = [];
        $("vr-enter-btn").querySelector(".vr-enter-label").textContent = "Enter VR";
        $("vr-ar-btn").querySelector(".vr-enter-label").textContent = "Enter AR";
      });
      $("vr-enter-btn").querySelector(".vr-enter-label").textContent = sessionType === "immersive-vr" ? "Exit VR" : "Enter VR";
      $("vr-ar-btn").querySelector(".vr-enter-label").textContent = sessionType === "immersive-ar" ? "Exit AR" : "Enter AR";
    } catch (e) {
      setStatus(`Couldn't start ${sessionType === "immersive-ar" ? "AR" : "VR"}: ${e.message}`, "unavailable");
    }
  }

  const xrRaycaster = new THREE.Raycaster();
  const xrTmpMat = new THREE.Matrix4();
  function xrPick(controller) {
    xrTmpMat.identity().extractRotation(controller.matrixWorld);
    xrRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    xrRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(xrTmpMat);
    // Intersect across all country beacon groups.
    const candidates = [];
    for (const iso of ISOS) {
      const g = beaconsGroups[iso];
      if (g) for (const c of g.children) if (c.userData.feature) candidates.push(c);
    }
    const hits = xrRaycaster.intersectObjects(candidates, false);
    const hit = hits[0];
    if (hit) showDetail(hit.object.userData.feature);
  }

  // ---------------------------------------------------------------------
  // Ambient audio drone (opt-in via toggle)
  // ---------------------------------------------------------------------
  // Two-oscillator pad (root + perfect-fifth, slightly detuned) at low
  // volume. Volume modulates with how many severe beacons are visible from
  // the camera's POV — looking AT the worst region swells the drone, looking
  // away quietens it. Subtle but adds emotional weight when on.
  let audioContext = null;
  let audioGain = null;
  let audioEnabled = false;
  function toggleAudio() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioGain = audioContext.createGain();
      audioGain.gain.value = 0;
      audioGain.connect(audioContext.destination);
      const oscA = audioContext.createOscillator();
      oscA.type = "sine"; oscA.frequency.value = 110;          // A2
      const oscB = audioContext.createOscillator();
      oscB.type = "sine"; oscB.frequency.value = 110 * 1.498;  // P5 with slight detune for warmth
      const oscC = audioContext.createOscillator();
      oscC.type = "triangle"; oscC.frequency.value = 55;       // sub-octave for body
      const subGain = audioContext.createGain();
      subGain.gain.value = 0.3;
      oscC.connect(subGain);
      oscA.connect(audioGain); oscB.connect(audioGain); subGain.connect(audioGain);
      oscA.start(); oscB.start(); oscC.start();
    }
    audioEnabled = !audioEnabled;
    const target = audioEnabled ? 0.04 : 0;
    audioGain.gain.cancelScheduledValues(audioContext.currentTime);
    audioGain.gain.linearRampToValueAtTime(target, audioContext.currentTime + 0.6);
    $("vr-audio-btn")?.classList.toggle("active", audioEnabled);
    $("vr-audio-btn").querySelector(".vr-audio-label").textContent = audioEnabled ? "Sound on" : "Sound off";
  }
  $("vr-audio-btn")?.addEventListener("click", toggleAudio);

  function updateAudioVolume() {
    if (!audioEnabled || !audioGain) return;
    // Count severe beacons of active country on the visible hemisphere.
    const cameraWorld = camera.getWorldPosition(new THREE.Vector3());
    const globeWorld = globeGroup.getWorldPosition(new THREE.Vector3());
    const camToGlobe = new THREE.Vector3().subVectors(cameraWorld, globeWorld).normalize();
    let visibleSevere = 0;
    const group = beaconsGroups[currentIso];
    if (group) {
      for (const c of group.children) {
        if (c.userData.band !== 3) continue;
        const world = c.position.clone().applyMatrix4(group.matrixWorld);
        const dir = new THREE.Vector3().subVectors(world, globeWorld).normalize();
        if (dir.dot(camToGlobe) > 0.1) visibleSevere++;
      }
    }
    // 0–60 visible severe → 0.02-0.06 gain. Smooth ramp so it doesn't pump.
    const target = 0.02 + Math.min(0.04, visibleSevere * 0.0010);
    audioGain.gain.linearRampToValueAtTime(target, audioContext.currentTime + 0.3);
  }

  // ---------------------------------------------------------------------
  // Non-VR preview controls
  // ---------------------------------------------------------------------
  let isDragging = false, lastX = 0, lastY = 0;
  let userInteracting = false;
  let lastInteract = 0;
  const AUTO_ROTATE_RESUME_MS = 5000;
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

  const tooltip = document.createElement("div");
  tooltip.className = "vr-tooltip";
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function visibleBeaconCandidates() {
    const arr = [];
    for (const iso of ISOS) {
      const g = beaconsGroups[iso];
      if (!g) continue;
      for (const c of g.children) if (c.userData.feature) arr.push(c);
    }
    return arr;
  }
  function updateHover(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(visibleBeaconCandidates(), false);
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
    const hits = raycaster.intersectObjects(visibleBeaconCandidates(), false);
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

  document.querySelectorAll(".vr-country").forEach(b => {
    b.addEventListener("click", async () => {
      // Country might not be loaded yet — load on demand.
      if (!beaconsGroups[b.dataset.iso]) {
        setStatus(`Loading ${COUNTRY_CENTER[b.dataset.iso].name}…`, "loading");
        await loadOneCountry(b.dataset.iso);
      }
      setActiveCountry(b.dataset.iso);
      lastInteract = performance.now();
    });
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // ---------------------------------------------------------------------
  // Camera intro
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
  let lastAudioUpdate = 0;
  renderer.setAnimationLoop((time, frame) => {
    if (runIntro(performance.now())) { /* intro running */ }

    if (!userInteracting || (performance.now() - lastInteract > AUTO_ROTATE_RESUME_MS)) {
      userInteracting = false;
      globeGroup.rotation.y += AUTO_ROTATE_SPEED;
    }

    // Smooth-tween each country group's opacity toward its target. ~3s
    // ease so the country swap reads as a graceful dim, not a snap.
    for (const iso of ISOS) {
      const g = beaconsGroups[iso];
      if (!g) continue;
      const cur = g.userData.currentOpacity;
      const tgt = g.userData.targetOpacity;
      if (Math.abs(cur - tgt) > 0.005) {
        const next = cur + (tgt - cur) * 0.04;
        g.userData.currentOpacity = next;
        applyGroupOpacity(g, next);
      }
    }

    // Severe-band beacon pulse (size + opacity throb).
    const tNow = performance.now() * 0.001;
    for (const m of pulsingBeacons) {
      const groupOp = beaconsGroups[m.userData.iso]?.userData.currentOpacity ?? 1;
      const pulse = 0.85 + 0.15 * Math.sin(tNow * 2.2);
      m.scale.setScalar(m.userData.baseScale * pulse);
      m.material.opacity = m.userData.baseOpacity * (0.75 + 0.25 * Math.sin(tNow * 2.2)) * groupOp;
    }

    // Severe-band expanding rings — each ring loops over 2 seconds with
    // its own phase offset so rings don't pulse in lockstep.
    for (const ring of pulsingRings) {
      const groupOp = beaconsGroups[ring.userData.iso]?.userData.currentOpacity ?? 1;
      const phase = ((tNow * 0.6) + ring.userData.phase) % 2;
      const scale = 1 + phase * 1.6;
      ring.scale.setScalar(scale);
      ring.material.opacity = (1 - phase / 2) * 0.55 * groupOp;
    }

    // Audio gain modulation — throttled to 100ms to avoid AudioParam spam.
    if (audioEnabled && performance.now() - lastAudioUpdate > 100) {
      lastAudioUpdate = performance.now();
      updateAudioVolume();
    }

    updateCountryLabels();
    renderer.render(scene, camera);
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  setupXrButton();
  init();
})();
