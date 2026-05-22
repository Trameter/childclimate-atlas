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
    KEN: { lat: 0.2,  lng: 37.9,  name: "Kenya"      },
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
  // Non-VR camera positions account for the globe being at z = -1.5.
  // CAM_HOME sits ~2.4m back from the globe along the same viewing axis we
  // had before; CAM_INTRO is far back for the cinematic fly-in.
  const CAM_HOME = new THREE.Vector3(0, 1.6, 0.9);
  const CAM_INTRO = new THREE.Vector3(0, 1.8, 5.0);
  const CAM_LOOK = new THREE.Vector3(0, 1.0, -1.5);
  camera.position.copy(CAM_INTRO);
  camera.lookAt(CAM_LOOK);

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
  // Globe sits in front of the user (VR room origin is roughly where the
  // user is standing; -Z is forward). Chest height = 1.35m. 1.5m forward
  // puts the globe at comfortable look distance without being in your face.
  globeGroup.position.set(0, 1.35, -1.5);
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

  // --- Country borders ---
  // Natural Earth 1:50m outlines for NGA / BGD / GTM, vendored via
  // borders.js (loaded before this script). Each country's outer ring(s)
  // are rendered as a glowing LineLoop on the globe surface, in the
  // country's aura colour. Subtle (low opacity) so they orient the
  // viewer without competing with beacons for attention.
  const BORDER_COLOR_BY_ISO = {
    NGA: 0xD87B4F,   // ember          — heat-dominant
    BGD: 0x5FA5C7,   // cool cyan      — flood-dominant
    GTM: 0xD9A655,   // amber          — heat + drought
    KEN: 0xC99548,   // dry savanna    — drought-dominant
  };
  function buildCountryBorders() {
    const data = (typeof window !== "undefined") ? window.COUNTRY_BORDERS : null;
    if (!data) return;
    for (const iso of ISOS) {
      const rings = data[iso];
      if (!rings) continue;
      const color = BORDER_COLOR_BY_ISO[iso] || 0xD87B4F;
      for (const ring of rings) {
        // Convert each [lng, lat] ring point to a Vec3 on the sphere
        // surface (slightly above the surface so the line isn't z-fighting
        // with the globe mesh).
        const pts = ring.map(([lng, lat]) => latLngToVec3(lat, lng, GLOBE_RADIUS * 1.003));
        // Close the loop if it isn't already.
        if (pts.length > 0 && !pts[0].equals(pts[pts.length-1])) pts.push(pts[0].clone());
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({
          color, transparent: true, opacity: 0.55,
        });
        globeGroup.add(new THREE.Line(geom, mat));
      }
    }
  }
  buildCountryBorders();

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
  // Standard right-handed cartographic convention: Greenwich (lng 0) sits
  // at +Z (facing the camera by default), east is +X (to the right), north
  // is +Y (up). Previous formula had east/west mirrored — Nigeria appeared
  // to the EAST of Bangladesh on the globe when it's actually west.
  function latLngToVec3(lat, lng, radius = GLOBE_RADIUS) {
    const latRad = lat * Math.PI / 180;
    const lngRad = lng * Math.PI / 180;
    const cosLat = Math.cos(latRad);
    return new THREE.Vector3(
      radius * cosLat * Math.sin(lngRad),   // X — east is +X
      radius * Math.sin(latRad),             // Y — north is +Y
      radius * cosLat * Math.cos(lngRad),   // Z — Greenwich is +Z
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

  // Quaternion-based globe centering. The previous Euler-angle version had
  // the wrong pitch sign + an arbitrary 0.5 factor, so the country ended
  // up on the LOWER hemisphere of the visible disc instead of dead center.
  // Quaternion math (Quaternion.setFromUnitVectors) handles this exactly:
  // it computes the single rotation that brings the country's natural
  // lat/lng position vector to the camera-to-globe-center direction (the
  // visually-centered point on the globe disc), and we slerp toward it.
  function animateGlobeToCountry(iso) {
    const c = COUNTRY_CENTER[iso];

    // The country's natural position on a unit sphere (no rotation applied).
    const countryNaturalPos = latLngToVec3(c.lat, c.lng, 1).normalize();

    // The point on the globe surface that visually sits at the center of
    // the disc (closest point to the camera). This is what we want the
    // country to align with after rotation.
    const cameraWorld = camera.getWorldPosition(new THREE.Vector3());
    const globeWorld = globeGroup.getWorldPosition(new THREE.Vector3());
    const viewCenter = cameraWorld.clone().sub(globeWorld).normalize();

    // Rotation that takes countryNaturalPos to viewCenter, then compose
    // with the axial-tilt so the globe keeps its decorative 23.4° lean.
    const center = new THREE.Quaternion().setFromUnitVectors(countryNaturalPos, viewCenter);
    const axialTilt = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(23.4)
    );
    const finalQuaternion = new THREE.Quaternion().multiplyQuaternions(axialTilt, center);

    const startQuaternion = globeGroup.quaternion.clone();
    const start = performance.now();
    const DURATION = 1100;

    function frame(now) {
      const t = Math.min((now - start) / DURATION, 1);
      const eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      const slerped = new THREE.Quaternion().slerpQuaternions(startQuaternion, finalQuaternion, eased);
      globeGroup.setRotationFromQuaternion(slerped);
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
  //
  // Originally rendered the beam as THREE.Line. WebGL ignores linewidth
  // (always 1px) so the beam was invisible in VR. Replaced with a thin
  // CylinderGeometry so the beam has actual thickness, plus small
  // spheres at the controller origin (so the user can see where the
  // controller IS in space) and at the beam tip (so they can see WHERE
  // the beam is pointing).
  const POINTER_LENGTH = 3;          // 3m beam — comfortably reaches the globe
  const POINTER_RADIUS = 0.006;      // thin but visible
  const pointerGeom = new THREE.CylinderGeometry(POINTER_RADIUS, POINTER_RADIUS, POINTER_LENGTH, 8);
  // Cylinder default axis is +Y; we want the beam to point along -Z (the
  // controller's forward direction). Rotate -90° around X, then translate
  // so the cylinder STARTS at the origin (instead of being centred there).
  pointerGeom.rotateX(-Math.PI / 2);
  pointerGeom.translate(0, 0, -POINTER_LENGTH / 2);
  const pointerMat = new THREE.MeshBasicMaterial({
    color: 0xD87B4F, transparent: true, opacity: 0.65,
  });
  const originGeom = new THREE.SphereGeometry(0.018, 16, 12);
  const originMat = new THREE.MeshBasicMaterial({ color: 0xD87B4F });
  const tipGeom = new THREE.SphereGeometry(0.014, 16, 12);
  const tipMat = new THREE.MeshBasicMaterial({ color: 0xFAF8F4 });
  function attachController(idx) {
    const c = renderer.xr.getController(idx);
    c.add(new THREE.Mesh(originGeom.clone(), originMat.clone()));
    c.add(new THREE.Mesh(pointerGeom.clone(), pointerMat.clone()));
    const tip = new THREE.Mesh(tipGeom.clone(), tipMat.clone());
    tip.position.set(0, 0, -POINTER_LENGTH);
    c.add(tip);
    // select fires for BOTH controller trigger AND hand pinch — WebXR
    // routes hand input through the same input-source slot.
    c.addEventListener("select", () => xrPick(c));
    scene.add(c);
    return c;
  }
  let controllers = [];

  // Hand-tracking fingertip markers — a small paper-white sphere at each
  // of the 5 fingertips per hand. Attaches on the hand's 'connected'
  // event (fires when Quest detects hands — typically when controllers
  // are set down) and removes on disconnect.
  const FINGERTIP_JOINTS = ["thumb-tip", "index-finger-tip", "middle-finger-tip", "ring-finger-tip", "pinky-finger-tip"];
  const fingertipSpheres = [];
  function attachHandFingertips(idx) {
    const hand = renderer.xr.getHand(idx);
    hand.addEventListener("connected", () => {
      for (const jointName of FINGERTIP_JOINTS) {
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(0.008, 12, 8),
          new THREE.MeshBasicMaterial({ color: 0xFAF8F4 })
        );
        sphere.visible = false;
        hand.add(sphere);
        fingertipSpheres.push({ hand, jointName, sphere });
      }
    });
    hand.addEventListener("disconnected", () => {
      for (let i = fingertipSpheres.length - 1; i >= 0; i--) {
        if (fingertipSpheres[i].hand === hand) {
          hand.remove(fingertipSpheres[i].sphere);
          fingertipSpheres.splice(i, 1);
        }
      }
    });
    scene.add(hand);
    return hand;
  }
  function updateHandFingertips() {
    for (const item of fingertipSpheres) {
      const joint = item.hand.joints?.[item.jointName];
      if (joint && joint.visible !== false) {
        item.sphere.visible = true;
        item.sphere.position.copy(joint.position);
      } else {
        item.sphere.visible = false;
      }
    }
  }

  // ---- AR hit-test ----
  // Per-frame raycast against detected real-world surfaces. Reticle
  // tracks the surface under the user's view; pulling the trigger (or
  // pinching) places the globe at that point with its bottom on the
  // surface — so it drops onto a real table / floor / wall.
  let arHitTestSource = null;
  let arHitTestReticle = null;
  let arRefSpace = null;
  async function setupArHitTest() {
    if (xrSessionType !== "immersive-ar" || !xrSession) return;
    if (!arHitTestReticle) {
      const geom = new THREE.RingGeometry(0.06, 0.07, 32);
      geom.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xD87B4F, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      });
      arHitTestReticle = new THREE.Mesh(geom, mat);
      arHitTestReticle.matrixAutoUpdate = false;
      arHitTestReticle.visible = false;
      scene.add(arHitTestReticle);
    }
    try {
      const viewerSpace = await xrSession.requestReferenceSpace("viewer");
      arHitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
      arRefSpace = renderer.xr.getReferenceSpace();
    } catch (e) {
      console.warn("[ar] hit-test setup failed:", e);
    }
  }
  function updateArHitTest(frame) {
    if (!arHitTestSource || !frame || !arHitTestReticle) return;
    if (!arRefSpace) arRefSpace = renderer.xr.getReferenceSpace();
    if (!arRefSpace) return;
    const results = frame.getHitTestResults(arHitTestSource);
    if (results.length) {
      const pose = results[0].getPose(arRefSpace);
      if (pose) {
        arHitTestReticle.visible = true;
        arHitTestReticle.matrix.fromArray(pose.transform.matrix);
      }
    } else {
      arHitTestReticle.visible = false;
    }
  }
  function teardownArHitTest() {
    if (arHitTestSource) {
      try { arHitTestSource.cancel(); } catch (e) {}
      arHitTestSource = null;
    }
    if (arHitTestReticle) {
      scene.remove(arHitTestReticle);
      arHitTestReticle.geometry?.dispose();
      arHitTestReticle.material?.dispose();
      arHitTestReticle = null;
    }
    arRefSpace = null;
  }
  function placeGlobeAtReticle() {
    if (!arHitTestReticle?.visible) return false;
    const pos = new THREE.Vector3().setFromMatrixPosition(arHitTestReticle.matrix);
    globeGroup.position.set(pos.x, pos.y + GLOBE_RADIUS + 0.05, pos.z);
    return true;
  }

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
      // Force-hide any DOM tooltip/detail overlays that were visible
      // pre-session, so they don't leak through the immersive view.
      tooltip.hidden = true;
      $("vr-detail").hidden = true;
      await renderer.xr.setSession(xrSession);
      controllers = [attachController(0), attachController(1)];
      attachHandFingertips(0); attachHandFingertips(1);
      if (sessionType === "immersive-ar") {
        scene.background = null;
        await setupArHitTest();
      }
      xrSession.addEventListener("end", () => {
        document.body.classList.remove("in-xr", "in-xr-ar");
        xrSession = null; xrSessionType = null;
        controllers.forEach(c => scene.remove(c));
        controllers = [];
        teardownArHitTest();
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
    // 1. Try beacon pick first.
    const candidates = [];
    for (const iso of ISOS) {
      const g = beaconsGroups[iso];
      if (g) for (const c of g.children) if (c.userData.feature) candidates.push(c);
    }
    const hits = xrRaycaster.intersectObjects(candidates, false);
    if (hits[0]) { showDetail(hits[0].object.userData.feature); return; }
    // 2. AR fallback: if no beacon hit + the reticle is on a detected
    //    surface, drop the globe there.
    if (xrSessionType === "immersive-ar") placeGlobeAtReticle();
  }

  // ---------------------------------------------------------------------
  // Per-beacon spatial audio
  // ---------------------------------------------------------------------
  // The top N severe beacons each get a PositionalAudio with a sine
  // oscillator whose pitch tracks the beacon's risk score (110-180 Hz
  // mapped from 75-100). PannerNodes give 3D directionality so turning
  // your head spatially locates the worst sites. Capped low-volume so
  // ~12 tones + the global drone don't pile up into noise.
  let positionalSounds = [];
  const SPATIAL_AUDIO_TOP_N = 12;
  function setupSpatialAudio() {
    if (!audioContext) return;
    teardownSpatialAudio();
    const all = [];
    for (const iso of ISOS) {
      const g = beaconsGroups[iso];
      if (!g) continue;
      for (const c of g.children) {
        if (c.userData?.band === 3 && c.userData.feature) all.push(c);
      }
    }
    all.sort((a, b) =>
      (b.userData.feature.properties.risk_score || 0) -
      (a.userData.feature.properties.risk_score || 0)
    );
    for (const beacon of all.slice(0, SPATIAL_AUDIO_TOP_N)) {
      const score = beacon.userData.feature.properties.risk_score || 75;
      const freq = 110 + Math.max(0, score - 75) * 2.8;
      const sound = new THREE.PositionalAudio(listener);
      const osc = audioContext.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      sound.setNodeSource(osc);
      sound.setRefDistance(0.15);
      sound.setMaxDistance(2.5);
      sound.setRolloffFactor(2);
      sound.setVolume(0.025);
      try { osc.start(); } catch (e) {}
      beacon.add(sound);
      positionalSounds.push({ beacon, sound, osc });
    }
  }
  function teardownSpatialAudio() {
    for (const item of positionalSounds) {
      try { item.osc.stop(); } catch (e) {}
      try { item.sound.disconnect(); } catch (e) {}
      try { item.beacon.remove(item.sound); } catch (e) {}
    }
    positionalSounds = [];
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
    if (audioEnabled) setupSpatialAudio();
    else teardownSpatialAudio();
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
    // In an active XR session the desktop tooltip just leaks through as
    // a stuck DOM overlay (the emulator composites DOM on top of the
    // canvas). Skip entirely so it can't show. Same for Spotlight tour —
    // the auto-cycle is the foreground; a competing hover tooltip is
    // noise. Force-hide in case it was visible when either started.
    if (xrSession || tourActive) {
      tooltip.hidden = true;
      return;
    }
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
    // In an XR session, mouse clicks don't make sense (user is in the
    // headset). All beacon-picking goes through the controller trigger.
    if (xrSession) return;
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
  // Camera intro (non-VR only)
  //
  // Previously this ran EVERY frame and lerped camera.position to CAM_HOME
  // even after the intro completed — which silently overrode wheel-zoom
  // AND the XR session's headset pose (so rotating the emulated headset
  // looked like nothing happened). Now: run only until t hits 1, then
  // stop touching the camera. Also skipped entirely while an XR session
  // is active — Three.js's xr.session controls the camera in that case.
  // ---------------------------------------------------------------------
  const INTRO_MS = 2200;
  const introStart = performance.now();
  let introDone = false;
  function runIntro(now) {
    if (introDone || xrSession) return;
    const t = Math.min((now - introStart) / INTRO_MS, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(CAM_INTRO, CAM_HOME, eased);
    camera.lookAt(CAM_LOOK);
    if (t >= 1) introDone = true;
  }

  // ---------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------
  let lastAudioUpdate = 0;
  renderer.setAnimationLoop((time, frame) => {
    if (xrSessionType === "immersive-ar") updateArHitTest(frame);
    updateHandFingertips();
    runIntro(performance.now());

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
  // ---------------------------------------------------------------------
  // Spotlight tour — auto-cycle through the worst facilities across all
  // three countries. The camera/user stays put (comfortable for VR);
  // each stop rotates the globe to centre that facility, pops a panel
  // with name + score + top driver, dwells, then advances.
  // ---------------------------------------------------------------------
  let tourActive = false;
  let tourIdx = 0;
  let tourQueue = [];
  let tourTimer = null;
  let tourPopup = null;

  const TOUR_STOPS_PER_COUNTRY = 3;
  const TOUR_DWELL_MS = 5500;          // time the popup is up at each stop
  const TOUR_TRAVEL_MS = 1300;         // globe-rotation time to reach the stop
  const TOUR_OUTRO_MS = 3000;          // time to settle back to default view after

  function buildTourQueue() {
    // Take the top N severe facilities from each country, interleave so
    // the tour bounces between countries instead of dwelling on one.
    const perCountry = {};
    for (const iso of ISOS) {
      const feats = countryData[iso] || [];
      const sorted = [...feats].sort((a, b) =>
        (b.properties.risk_score || 0) - (a.properties.risk_score || 0)
      );
      perCountry[iso] = sorted.slice(0, TOUR_STOPS_PER_COUNTRY);
    }
    // Interleave: BGD-NGA-GTM-KEN round-robin. BGD first because its
    // severe band is best-populated proportionally, sets the bar high
    // for the rest. KEN slotted last in the rotation because its severe
    // tier is the newest and we want the warm-up to land on Bangladesh.
    const order = ["BGD", "NGA", "GTM", "KEN"];
    const stops = [];
    for (let i = 0; i < TOUR_STOPS_PER_COUNTRY; i++) {
      for (const iso of order) {
        const list = perCountry[iso];
        if (list && list[i]) stops.push({ iso, feature: list[i] });
      }
    }
    return stops;
  }

  // Rotate the globe to put a specific facility (not just a country
  // centre) at the camera's view-centre. Same quaternion math as
  // animateGlobeToCountry, parameterised by an arbitrary lat/lng.
  function animateGlobeToFeature(lat, lng, durationMs) {
    const featureNaturalPos = latLngToVec3(lat, lng, 1).normalize();
    const cameraWorld = camera.getWorldPosition(new THREE.Vector3());
    const globeWorld = globeGroup.getWorldPosition(new THREE.Vector3());
    const viewCenter = cameraWorld.clone().sub(globeWorld).normalize();
    const center = new THREE.Quaternion().setFromUnitVectors(featureNaturalPos, viewCenter);
    const axialTilt = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(23.4)
    );
    const finalQuaternion = new THREE.Quaternion().multiplyQuaternions(axialTilt, center);
    const startQuaternion = globeGroup.quaternion.clone();
    const start = performance.now();
    return new Promise(resolve => {
      function frame(now) {
        const t = Math.min((now - start) / durationMs, 1);
        const eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
        const slerped = new THREE.Quaternion().slerpQuaternions(startQuaternion, finalQuaternion, eased);
        globeGroup.setRotationFromQuaternion(slerped);
        lastInteract = performance.now();
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  // Build a plain-English driver line for the spotlight popup from the
  // facility's actual climate + air data. Mirrors the /3d detail panel's
  // 'Top drivers · plain English' section — same data, same phrasing —
  // so the user sees the SPECIFIC condition (e.g. '239 days above 35°C
  // apparent temperature in 2024') instead of the generic key 'heat
  // exposure'.
  function plainEnglishDriver(f) {
    const p = f.properties;
    const climate = typeof p.climate === "string" ? JSON.parse(p.climate) : (p.climate || {});
    const air = typeof p.air === "string" ? JSON.parse(p.air) : (p.air || {});
    const drivers = typeof p.top_drivers === "string" ? JSON.parse(p.top_drivers) : (p.top_drivers || []);
    const top = drivers[0];
    if (top === "heat_exposure" && climate.heat_index_days != null) {
      return `${climate.heat_index_days} days above 35°C apparent temperature.`;
    }
    if (top === "air_pollution" && air.pm25_avg_ugm3 != null) {
      const mult = (air.pm25_avg_ugm3 / 5).toFixed(1);
      return `PM2.5 averaged ${air.pm25_avg_ugm3} µg/m³ — ${mult}× the WHO 2021 guideline.`;
    }
    if (top === "flood_risk" && climate.heavy_precip_days != null) {
      return `${climate.heavy_precip_days} heavy-precipitation days (≥50 mm) per year.`;
    }
    if (top === "drought_risk" && climate.longest_dry_run_days != null) {
      return `${climate.longest_dry_run_days}-day longest consecutive dry run.`;
    }
    if (top === "child_density") {
      return "Child-population catchment density at or near the country maximum.";
    }
    if (top === "facility_fragility") {
      return "Facility fragility (power / water / structure) flagged from OSM tags.";
    }
    return (top || "").replace(/_/g, " ");
  }

  function showSpotPopup(stop) {
    hideSpotPopup();
    const f = stop.feature;
    const p = f.properties;
    const s = p.risk_score || 0;
    const band = RISK_LABELS[bandFor(s)];
    const bandClass = band === "mid" ? "mid" : band;
    const driverLine = plainEnglishDriver(f);
    const recs = typeof p.recommendations === "string" ? JSON.parse(p.recommendations) : (p.recommendations || []);
    const topRec = recs[0];
    const popup = document.createElement("div");
    popup.className = "vr-spot-popup";
    popup.innerHTML = `
      <div class="vr-spot-stage">Stop ${tourIdx + 1} of ${tourQueue.length} · ${COUNTRY_CENTER[stop.iso].name}</div>
      <div class="vr-spot-name">${escapeHtml(p.name || "Unnamed facility")}</div>
      <div class="vr-spot-loc">${escapeHtml(p.facility_type || "")} · ${f.geometry.coordinates[1].toFixed(2)}°, ${f.geometry.coordinates[0].toFixed(2)}°</div>
      <div class="vr-spot-score-row">
        <span class="vr-spot-score">${s.toFixed(0)}</span>
        <span class="vr-spot-band ${bandClass}">${band === "mid" ? "moderate" : band}</span>
      </div>
      ${driverLine ? `<div class="vr-spot-driver">${escapeHtml(driverLine)}</div>` : ""}
      ${topRec ? `
        <div class="vr-spot-rec">
          <div class="vr-spot-rec-head">
            <span class="vr-spot-rec-pri">Priority ${String(topRec.priority).padStart(2, "0")} · ${escapeHtml(topRec.category || "")}</span>
            <span class="vr-spot-rec-cost">$${escapeHtml(topRec.estimated_cost_usd || "")}</span>
          </div>
          <div class="vr-spot-rec-title">${escapeHtml(topRec.title || "")}</div>
        </div>
      ` : ""}
    `;
    document.body.appendChild(popup);
    tourPopup = popup;
  }
  function hideSpotPopup() {
    if (tourPopup) { tourPopup.remove(); tourPopup = null; }
  }

  async function visitNextTourStop() {
    if (!tourActive) return;
    if (tourIdx >= tourQueue.length) { finishTour(); return; }
    const stop = tourQueue[tourIdx];
    // Switch active country if needed (so the active-emphasis pulls in
    // the right beacon group's opacity).
    if (stop.iso !== currentIso) {
      currentIso = stop.iso;
      document.querySelectorAll(".vr-country").forEach(b => {
        b.classList.toggle("active", b.dataset.iso === stop.iso);
      });
      applyCountryOpacities();
      updateMeta();
    }
    const [lng, lat] = stop.feature.geometry.coordinates;
    await animateGlobeToFeature(lat, lng, TOUR_TRAVEL_MS);
    if (!tourActive) return;
    showSpotPopup(stop);
    tourTimer = setTimeout(() => {
      tourIdx++;
      visitNextTourStop();
    }, TOUR_DWELL_MS);
  }

  function startTour() {
    if (tourActive) { stopTour(); return; }
    tourQueue = buildTourQueue();
    if (!tourQueue.length) {
      setStatus("No facilities loaded yet", "unavailable");
      return;
    }
    tourActive = true;
    tourIdx = 0;
    // Clear any pre-existing hover tooltip + detail bubble so they don't
    // sit behind the spotlight popup during the cycle.
    tooltip.hidden = true;
    $("vr-detail").hidden = true;
    $("vr-tour-btn").classList.add("active");
    $("vr-tour-btn").querySelector(".vr-tour-btn .vr-enter-label, .vr-enter-label").textContent = "Stop tour";
    $("vr-tour-btn").querySelector(".vr-enter-icon").textContent = "■";
    visitNextTourStop();
  }

  function stopTour() {
    tourActive = false;
    tourIdx = 0;
    tourQueue = [];
    if (tourTimer) { clearTimeout(tourTimer); tourTimer = null; }
    hideSpotPopup();
    $("vr-tour-btn").classList.remove("active");
    $("vr-tour-btn").querySelector(".vr-enter-label").textContent = "Spotlight tour";
    $("vr-tour-btn").querySelector(".vr-enter-icon").textContent = "▶";
  }

  function finishTour() {
    // Settle back to the previously-active country's centre.
    tourActive = false;
    hideSpotPopup();
    animateGlobeToCountry(currentIso);
    if (tourTimer) { clearTimeout(tourTimer); tourTimer = null; }
    $("vr-tour-btn").classList.remove("active");
    $("vr-tour-btn").querySelector(".vr-enter-label").textContent = "Spotlight tour";
    $("vr-tour-btn").querySelector(".vr-enter-icon").textContent = "▶";
  }

  $("vr-tour-btn")?.addEventListener("click", startTour);

  setupXrButton();
  init();
})();
