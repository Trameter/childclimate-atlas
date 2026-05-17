/* ============================================================================
   MICRO-SCENE — per-facility climate-stress 3D vignettes

   When a facility is opened in the detail panel, this module renders a small
   Three.js scene into a canvas inside the panel that procedurally visualises
   the facility's DOMINANT climate stressor. The point is sensory, not
   analytical: turn the spreadsheet of sub-scores into something you can FEEL.

   How dominance is picked: we look at the facility's risk_components, weight
   each by the country's scoring weights (so a high heat_exposure in a heat-
   weighted country dominates a similarly-high flood signal in a flood-
   weighted country), pick the top one, and route to the matching scene.

   Scenes:
     heat       — vertical heat-shimmer columns rising from a warm-glowing
                  ground plane; intensity scales column density + brightness
     drought    — desaturated cracked-earth plane with horizontal dust motes
                  drifting across; intensity scales mote density
     flood      — rain streaks falling against a dark wet ground plane;
                  intensity scales rain density
     pm25       — layered semi-transparent haze planes with grey city
                  silhouette behind; intensity scales haze opacity

   Lifecycle: openDetail() calls MicroScene.create(canvas, properties), which
   builds the scene + starts the rAF loop. closeDetail() or a new facility
   open calls instance.dispose() to release all GPU resources.

   The scene is intentionally subtle. It runs at ~30fps to keep the panel
   feeling alive without burning battery on mobile.
   ========================================================================== */

(function (global) {
  "use strict";

  // Map each scoring component to the scene type that best visualises it.
  // Anything not in this map is ignored when picking the dominant stress
  // (we don't have scenes for child_density or facility_fragility — those
  // aren't sensory in the same way).
  const COMPONENT_TO_SCENE = {
    heat_exposure: "heat",
    air_pollution: "pm25",
    flood_risk:    "flood",
    drought_risk:  "drought",
  };

  // Pick the dominant climate stress for this facility by computing each
  // visualisable component's WEIGHTED contribution (raw score × country
  // weight) and taking the maximum. Returns { scene, intensity } where
  // intensity is the un-weighted sub-score 0–1, used as the visual dial.
  function pickDominantStress(properties, weights) {
    const comps = typeof properties.risk_components === "string"
      ? JSON.parse(properties.risk_components)
      : (properties.risk_components || {});
    let bestKey = null;
    let bestWeighted = -Infinity;
    for (const key of Object.keys(COMPONENT_TO_SCENE)) {
      const raw = Number(comps[key]) || 0;
      const w   = Number(weights?.[key]) || 0;
      const weighted = raw * w;
      if (weighted > bestWeighted) {
        bestWeighted = weighted;
        bestKey = key;
      }
    }
    if (!bestKey) return null;
    return {
      scene: COMPONENT_TO_SCENE[bestKey],
      intensity: Math.max(0, Math.min(1, Number(comps[bestKey]) || 0)),
      component: bestKey,
    };
  }

  // -------------------------------------------------------------------------
  // Shared base scene
  // -------------------------------------------------------------------------
  // Every variant uses the same renderer / camera / ground footprint and
  // differs only in which particle system + colour palette it draws on top.
  // This keeps mount + dispose simple and the cross-scene look coherent.
  function buildBase(canvas) {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "low-power",   // mobile-friendly
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const w = canvas.clientWidth  || 360;
    const h = canvas.clientHeight || 160;
    renderer.setSize(w, h, false);

    const scene = new THREE.Scene();

    // Shallow perspective camera angled down toward a ground plane. Same
    // framing across scenes so the panel feels like one continuous world.
    const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    camera.position.set(0, 1.4, 3.6);
    camera.lookAt(0, 0, 0);

    return { renderer, scene, camera, width: w, height: h };
  }

  // -------------------------------------------------------------------------
  // HEAT scene — vertical shimmer columns rising from a warm ground
  // -------------------------------------------------------------------------
  function makeHeatScene(canvas, intensity) {
    const ctx = buildBase(canvas);
    const { scene } = ctx;

    // Warm ground plane.
    const groundGeom = new THREE.PlaneGeometry(8, 4, 1, 1);
    const groundMat  = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(0.04, 0.65, 0.18 + 0.10 * intensity),
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    scene.add(ground);

    // Backplane (the "horizon" haze).
    const backGeom = new THREE.PlaneGeometry(8, 2);
    const backMat  = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(0.05, 0.55, 0.08),
      transparent: true,
      opacity: 0.7,
    });
    const back = new THREE.Mesh(backGeom, backMat);
    back.position.set(0, 0.9, -1.6);
    scene.add(back);

    // Shimmer columns — a THREE.Points particle system rising from y=-0.05
    // upward, with horizontal sin-wave jitter for the "heat haze" feel.
    const N = Math.floor(80 + 220 * intensity);
    const positions = new Float32Array(N * 3);
    const seeds     = new Float32Array(N);     // per-particle phase
    const baseX     = new Float32Array(N);
    const baseZ     = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      baseX[i] = (Math.random() - 0.5) * 4.5;
      baseZ[i] = (Math.random() - 0.5) * 1.8 - 0.3;
      positions[i * 3]     = baseX[i];
      positions[i * 3 + 1] = -0.05 + Math.random() * 1.8;
      positions[i * 3 + 2] = baseZ[i];
      seeds[i] = Math.random() * Math.PI * 2;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color().setHSL(0.07, 0.95, 0.55),
      size: 0.05 + 0.04 * intensity,
      transparent: true,
      opacity: 0.55 + 0.30 * intensity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geom, mat);
    scene.add(points);

    const tick = (t) => {
      const arr = geom.attributes.position.array;
      const rise = 0.0006 + 0.0010 * intensity;
      for (let i = 0; i < N; i++) {
        arr[i * 3 + 1] += rise;
        if (arr[i * 3 + 1] > 1.8) {
          arr[i * 3 + 1] = -0.05;
        }
        // horizontal jitter so columns waver
        arr[i * 3]     = baseX[i] + Math.sin(t * 0.002 + seeds[i]) * 0.06;
        arr[i * 3 + 2] = baseZ[i] + Math.cos(t * 0.0017 + seeds[i]) * 0.04;
      }
      geom.attributes.position.needsUpdate = true;
    };

    return { ctx, tick, geoms: [groundGeom, backGeom, geom], mats: [groundMat, backMat, mat] };
  }

  // -------------------------------------------------------------------------
  // DROUGHT scene — desaturated cracked ground with drifting dust
  // -------------------------------------------------------------------------
  function makeDroughtScene(canvas, intensity) {
    const ctx = buildBase(canvas);
    const { scene } = ctx;

    // Sandy desaturated ground.
    const groundGeom = new THREE.PlaneGeometry(8, 4);
    const groundMat  = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(0.09, 0.20 - 0.15 * intensity, 0.30 - 0.10 * intensity),
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    scene.add(ground);

    // Crack overlay — short dark line segments scattered on the ground.
    // We draw them as a single LineSegments object for cheap rendering.
    const cracks = [];
    const crackCount = Math.floor(8 + 24 * intensity);
    for (let i = 0; i < crackCount; i++) {
      const x  = (Math.random() - 0.5) * 6;
      const z  = (Math.random() - 0.5) * 2.6 - 0.2;
      const a  = Math.random() * Math.PI * 2;
      const len = 0.15 + Math.random() * 0.35;
      cracks.push(x, -0.04, z);
      cracks.push(x + Math.cos(a) * len, -0.04, z + Math.sin(a) * len);
    }
    const crackGeom = new THREE.BufferGeometry();
    crackGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cracks), 3));
    const crackMat  = new THREE.LineBasicMaterial({
      color: 0x2a1f15, transparent: true, opacity: 0.55,
    });
    const crackMesh = new THREE.LineSegments(crackGeom, crackMat);
    scene.add(crackMesh);

    // Dust motes drifting horizontally.
    const N = Math.floor(50 + 180 * intensity);
    const positions = new Float32Array(N * 3);
    const speeds    = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 6;
      positions[i * 3 + 1] = 0.05 + Math.random() * 1.4;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 2 - 0.2;
      speeds[i] = 0.003 + Math.random() * 0.006;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color().setHSL(0.10, 0.30, 0.65),
      size: 0.04,
      transparent: true,
      opacity: 0.45 + 0.30 * intensity,
      depthWrite: false,
    });
    const points = new THREE.Points(geom, mat);
    scene.add(points);

    const tick = () => {
      const arr = geom.attributes.position.array;
      for (let i = 0; i < N; i++) {
        arr[i * 3] += speeds[i] * (1 + intensity);
        if (arr[i * 3] > 3.2) arr[i * 3] = -3.2;
      }
      geom.attributes.position.needsUpdate = true;
    };

    return { ctx, tick, geoms: [groundGeom, crackGeom, geom], mats: [groundMat, crackMat, mat] };
  }

  // -------------------------------------------------------------------------
  // FLOOD scene — rain streaks falling against a dark wet ground
  // -------------------------------------------------------------------------
  function makeFloodScene(canvas, intensity) {
    const ctx = buildBase(canvas);
    const { scene } = ctx;

    // Wet dark ground, slight blue tint.
    const groundGeom = new THREE.PlaneGeometry(8, 4);
    const groundMat  = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(0.55, 0.40, 0.10 + 0.05 * intensity),
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    scene.add(ground);

    // Reflective sheen layer — a slightly lighter translucent plane to fake
    // wet-surface reflectivity without doing an actual reflection pass.
    const sheenMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(0.55, 0.30, 0.25),
      transparent: true,
      opacity: 0.20,
    });
    const sheen = new THREE.Mesh(groundGeom.clone(), sheenMat);
    sheen.rotation.x = -Math.PI / 2;
    sheen.position.y = -0.04;
    scene.add(sheen);

    // Rain streaks — thin elongated line segments falling.
    const N = Math.floor(60 + 240 * intensity);
    const positions = new Float32Array(N * 6);  // 2 vertices per streak
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * 6;
      const y = Math.random() * 2.4;
      const z = (Math.random() - 0.5) * 1.8 - 0.2;
      positions[i * 6]     = x;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = z;
      positions[i * 6 + 3] = x;
      positions[i * 6 + 4] = y - 0.12;
      positions[i * 6 + 5] = z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color().setHSL(0.58, 0.30, 0.75),
      transparent: true,
      opacity: 0.50 + 0.30 * intensity,
    });
    const rain = new THREE.LineSegments(geom, mat);
    scene.add(rain);

    const tick = () => {
      const arr = geom.attributes.position.array;
      const speed = 0.04 + 0.05 * intensity;
      for (let i = 0; i < N; i++) {
        arr[i * 6 + 1] -= speed;
        arr[i * 6 + 4] -= speed;
        if (arr[i * 6 + 4] < -0.1) {
          arr[i * 6 + 1] = 2.4;
          arr[i * 6 + 4] = 2.28;
        }
      }
      geom.attributes.position.needsUpdate = true;
    };

    return {
      ctx, tick,
      geoms: [groundGeom, sheen.geometry, geom],
      mats:  [groundMat, sheenMat, mat],
    };
  }

  // -------------------------------------------------------------------------
  // PM2.5 scene — layered haze planes with grey city silhouette behind
  // -------------------------------------------------------------------------
  function makePm25Scene(canvas, intensity) {
    const ctx = buildBase(canvas);
    const { scene } = ctx;

    // Sky gradient — warm grey-orange smog tone.
    const skyGeom = new THREE.PlaneGeometry(8, 3);
    const skyMat  = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(0.06, 0.35 + 0.20 * intensity, 0.30 - 0.10 * intensity),
    });
    const sky = new THREE.Mesh(skyGeom, skyMat);
    sky.position.set(0, 0.9, -1.8);
    scene.add(sky);

    // City silhouette — a few rectangular blocks at varying heights.
    const cityMat = new THREE.MeshBasicMaterial({ color: 0x131722 });
    const cityGeoms = [];
    let nextX = -2.4;
    while (nextX < 2.6) {
      const w = 0.30 + Math.random() * 0.40;
      const h = 0.40 + Math.random() * 0.85;
      const g = new THREE.BoxGeometry(w, h, 0.20);
      const m = new THREE.Mesh(g, cityMat);
      m.position.set(nextX + w / 2, h / 2 - 0.05, -0.9);
      scene.add(m);
      cityGeoms.push(g);
      nextX += w + 0.04 + Math.random() * 0.10;
    }

    // Ground (foreground street).
    const groundGeom = new THREE.PlaneGeometry(8, 2);
    const groundMat  = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(0.08, 0.10, 0.12),
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.position.z = 0.3;
    scene.add(ground);

    // Haze layers — three semi-transparent planes between camera and city,
    // with opacity scaling by intensity so a sub-WHO-guideline facility has
    // a hint of haze and a 10×-WHO facility has thick smog.
    const hazeMats = [];
    const hazeMeshes = [];
    const hazeGeom = new THREE.PlaneGeometry(7, 2.4);
    for (let i = 0; i < 4; i++) {
      const hm = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL(0.08, 0.20, 0.55),
        transparent: true,
        opacity: (0.06 + 0.08 * intensity) * (1 - i * 0.15),
        depthWrite: false,
      });
      const hmesh = new THREE.Mesh(hazeGeom, hm);
      hmesh.position.set(0, 0.7, -0.6 + i * 0.25);
      scene.add(hmesh);
      hazeMats.push(hm);
      hazeMeshes.push(hmesh);
    }

    const tick = (t) => {
      // Gentle haze drift so it never feels frozen.
      for (let i = 0; i < hazeMeshes.length; i++) {
        hazeMeshes[i].position.x = Math.sin(t * 0.0003 + i) * 0.20;
      }
    };

    return {
      ctx, tick,
      geoms: [skyGeom, groundGeom, hazeGeom, ...cityGeoms],
      mats:  [skyMat, groundMat, cityMat, ...hazeMats],
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  const SCENE_BUILDERS = {
    heat:    makeHeatScene,
    drought: makeDroughtScene,
    flood:   makeFloodScene,
    pm25:    makePm25Scene,
  };

  // Display name for the picked stress, shown as the scene's caption.
  const STRESS_LABEL = {
    heat:    "Heat shimmer",
    drought: "Drought drift",
    flood:   "Flood pulse",
    pm25:    "PM2.5 haze",
  };

  function create(canvas, properties, weights) {
    if (typeof THREE === "undefined") {
      // Three.js failed to load — silently bail. The detail panel stays
      // useful without the vignette.
      return null;
    }
    const pick = pickDominantStress(properties, weights || {});
    if (!pick) return null;
    const builder = SCENE_BUILDERS[pick.scene];
    if (!builder) return null;

    const built = builder(canvas, pick.intensity);
    const { renderer, scene, camera } = built.ctx;

    let rafId = null;
    let last = 0;
    // Cap at ~30fps to keep mobile batteries happy. The detail panel is a
    // contemplative beat — it doesn't need 60fps to feel alive.
    const minFrameMs = 1000 / 30;
    function loop(now) {
      rafId = requestAnimationFrame(loop);
      if (now - last < minFrameMs) return;
      last = now;
      built.tick(now);
      renderer.render(scene, camera);
    }
    rafId = requestAnimationFrame(loop);

    function dispose() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      // Free GPU resources — critical because the detail panel can be
      // opened/closed many times in a session and webgl contexts leak.
      (built.geoms || []).forEach(g => g.dispose && g.dispose());
      (built.mats  || []).forEach(m => m.dispose && m.dispose());
      renderer.dispose();
      // Free the context itself; some browsers won't recycle WebGL contexts
      // otherwise and we'll hit the 16-context limit fast.
      const gl = renderer.getContext && renderer.getContext();
      const lose = gl && gl.getExtension && gl.getExtension("WEBGL_lose_context");
      lose && lose.loseContext && lose.loseContext();
    }

    return {
      dispose,
      scene: pick.scene,
      component: pick.component,
      intensity: pick.intensity,
      label: STRESS_LABEL[pick.scene],
    };
  }

  global.MicroScene = { create };
})(window);
