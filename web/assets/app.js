/* ChildClimate Risk Atlas — v2 frontend
   Full-featured: search, filters, legend, recommendations, export, charts.

   The same script powers two entry points:
     /             → 2D map (Mercator, top-down, working tool)
     /3d           → 3D globe (atmosphere, tilted camera, cinematic flyTo)
   Branched on IS_3D below — every other code path is shared. Map init,
   camera animation, and a couple of perf tweaks are the only deltas. */

// Mutable because the 2D ↔ 3D toggle flips it in-place (no page reload).
let IS_3D = window.location.pathname.startsWith("/3d");

const VIEWS = {
  NGA: { center: [8.7, 9.1], zoom: 5.8 },     // full Nigeria
  BGD: { center: [90.3, 23.7], zoom: 6.8 },    // full Bangladesh
  GTM: { center: [-90.2, 15.8], zoom: 7.2 },   // full Guatemala
};

// Display name for each country so we can update the UI synchronously on
// country switch (before the async GeoJSON fetch completes).
const COUNTRY_NAMES = {
  NGA: "Nigeria",
  BGD: "Bangladesh",
  GTM: "Guatemala",
};

// ---- helpers ----
// Risk-band colours match the CSS design-system tokens exactly:
//   low #6FA774 · mod #D9B653 · high #D9894F · severe #C35248
function band(s) { return s < 30 ? "low" : s < 55 ? "mid" : s < 75 ? "high" : "severe"; }
function bandLabel(s) { return s < 30 ? "Low" : s < 55 ? "Moderate" : s < 75 ? "High" : "Severe"; }
function bandColor(s) {
  const m = { low: "#6FA774", mid: "#D9B653", high: "#D9894F", severe: "#C35248" };
  return m[band(s)];
}
// human-readable label for sub-score keys
function prettyKey(k) {
  const M = {
    heat_exposure: "Heat exposure",
    air_pollution: "Air pollution",
    flood_risk: "Flood risk",
    drought_risk: "Drought risk",
    child_density: "Child-population density",
    facility_fragility: "Facility fragility",
  };
  return M[k] || k.replace(/_/g, " ");
}
function typeIcon(t) { return t === "hospital" ? "\u{1F3E5}" : t === "clinic" ? "\u{1FA7A}" : "\u{1F3EB}"; }
// HTML escape for any string interpolated into innerHTML / setHTML / document.write.
// Required because much of our data comes from OpenStreetMap, which is
// publicly editable — a contributor could put `<img src=x onerror=...>` in
// a facility name tag and it would execute when the atlas renders it.
// Always call this on facility names, admin-level strings, and any
// downstream property derived from them before string-interpolation into
// markup. CSP in .htaccess is the second line of defense.
function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"'`]/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;", "`": "&#96;",
  })[c]);
}
// Normalize display-casing for OSM names that are entered in ALL CAPS.
// A string is "shouty" if >=70% of its letters are uppercase AND it's long
// enough for that to be meaningful (<=4-char strings like "NHS" pass through).
function displayCase(s) {
  if (!s) return s;
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length < 5) return s;
  const ups = letters.replace(/[^A-Z]/g, "").length;
  if (ups / letters.length < 0.7) return s; // already mixed case — trust it
  // Title-case each word, keep short connector words lowercase
  const small = new Set(["of","the","and","for","a","an","in","on","at","to","de","la","le","du","des","von","van"]);
  return s.toLowerCase().split(/(\s+|-)/).map((word, i, arr) => {
    if (!word.trim()) return word;
    if (i > 0 && small.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join("");
}
function displayName(f) {
  const p = f.properties || f;
  const name = p.name || "";
  // If facility has a real name, return it with display-casing normalization
  // (so ALL-CAPS OSM entries render as "Hotoro Maradi Special Primary School"
  // rather than "HOTORO MARADI SPECIAL PRIMARY SCHOOL").
  if (name && !name.startsWith("Unnamed")) return displayCase(name);
  // For unnamed facilities, build a useful label from available metadata
  const type = (p.facility_type || "facility");
  const typeCap = type.charAt(0).toUpperCase() + type.slice(1);
  const tags = typeof p.tags === "string" ? JSON.parse(p.tags || "{}") : (p.tags || {});
  if (tags["addr:city"]) return `${typeCap} near ${tags["addr:city"]}`;
  if (tags["admin1"]) return `${typeCap} in ${tags["admin1"]}`;
  if (tags["addr:state"]) return `${typeCap} in ${tags["addr:state"]}`;
  return name || `${typeCap} (unregistered)`;
}

// ---- sample fallback ----
function mkSample(name, type, lon, lat, score, heat, pm, flood, dry) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      id: `${type}-${Math.random().toString(36).slice(2, 8)}`, name, facility_type: type,
      risk_score: score,
      risk_components: { heat_exposure: heat/200, air_pollution: pm/80*0.7, flood_risk: flood/20, drought_risk: dry/150, child_density: 0.94, facility_fragility: type === "hospital" ? 0.2 : 0.55 },
      top_drivers: ["heat_exposure", "air_pollution", "child_density"],
      recommendations: [
        { priority: 1, category: "Heat Resilience", title: "Install solar-powered cooling", description: "Extreme heat 120+ days/year. Solar fans protect patients and vaccine storage.", estimated_cost_usd: "2,000\u20135,000" },
        { priority: 1, category: "Air Quality", title: "Deploy air filtration", description: "PM2.5 exceeds WHO guideline 10x. HEPA filters in patient areas.", estimated_cost_usd: "1,000\u20133,000" },
      ],
      climate: { heat_index_days: heat, heavy_precip_days: flood, longest_dry_run_days: dry },
      air: { pm25_avg_ugm3: pm, no2_avg_ugm3: 8.2, pm25_exceed_hours_30d: 720 },
    },
  };
}

const FALLBACK = {
  type: "FeatureCollection",
  metadata: { country: "Nigeria (sample)", iso3: "NGA", focus_region: "Kano State", facility_count: 8,
    scoring_weights: { heat_exposure: 0.25, air_pollution: 0.25, flood_risk: 0.15, drought_risk: 0.10, child_density: 0.15, facility_fragility: 0.10 } },
  features: [
    mkSample("Murtala Muhammad Specialist Hospital", "hospital", 8.519, 12.002, 68.4, 189, 65, 1, 149),
    mkSample("PHC Fagge", "clinic", 8.506, 12.014, 81.7, 195, 72, 2, 155),
    mkSample("Government Girls Secondary School", "school", 8.546, 11.998, 74.1, 188, 60, 1, 148),
    mkSample("Nassarawa Clinic", "clinic", 8.488, 11.965, 69.2, 178, 58, 3, 140),
    mkSample("Bayero University Health Centre", "hospital", 8.632, 11.87, 52.9, 160, 42, 2, 130),
    mkSample("Wudil General Hospital", "hospital", 8.842, 11.808, 55.3, 165, 45, 1, 135),
    mkSample("Kura Primary School", "school", 8.422, 11.779, 77.3, 192, 68, 2, 152),
    mkSample("Dawakin Tofa PHC", "clinic", 8.332, 11.952, 73.0, 186, 63, 1, 146),
  ],
};

// ---- state ----
let currentData = null;
let allFeatures = [];
let filteredFeatures = [];
let activeFilters = { types: new Set(["clinic", "hospital", "school"]), bands: new Set(["low", "mid", "high", "severe"]), search: "", state: "", searchType: "" };

// ---- data loading ----
// In-memory cache + browser HTTP cache + background prefetch.
// Also: stream the response body so the user sees live progress instead of
// staring at a frozen "Loading…" label for Bangladesh's 20 MB file.
const dataCache = new Map();
const inflight = new Map();

// Ballpark uncompressed sizes (used only when the server sends a compressed
// Content-Length, which reports the COMPRESSED byte count and would make
// %-progress overshoot). These are approximate; off-by-10% is fine because
// the progress bar gets clamped to 100%.
const APPROX_UNCOMPRESSED_BYTES = {
  NGA: 11_000_000,
  BGD: 20_000_000,
  GTM:  2_700_000,
};

function onLoadProgress(iso3, received, total) {
  const name = COUNTRY_NAMES[iso3] || iso3;
  const chipText = document.getElementById("facility-chip-text");
  const hudC = document.getElementById("hud-country");
  if (received === 0 && total === 0) return; // finished / reset
  const mb = (received / 1024 / 1024).toFixed(1);
  let msg;
  if (total) {
    const pct = Math.min(100, Math.round((received / total) * 100));
    msg = `${name} · loading ${pct}%`;
  } else {
    msg = `${name} · loading ${mb} MB`;
  }
  if (chipText) chipText.textContent = msg;
  if (hudC) hudC.textContent = msg;
}

async function loadAtlas(iso3, { showProgress = false } = {}) {
  if (dataCache.has(iso3)) return dataCache.get(iso3);
  if (inflight.has(iso3)) return inflight.get(iso3);

  const p = (async () => {
    try {
      // Absolute path so the same module works from /3d/ (where ./ would
      // resolve to /3d/data/X.geojson and 404).
      const r = await fetch(`/data/${iso3}.geojson`);
      if (!r.ok) throw new Error(r.status);

      // If the server is sending gzipped content, the Content-Length header
      // reports compressed size while the reader yields decompressed bytes.
      // Detect that case and use our approximate uncompressed size instead.
      const encoded = (r.headers.get("content-encoding") || "").toLowerCase();
      const clHeader = Number(r.headers.get("content-length")) || 0;
      const total = (encoded && (encoded.includes("gzip") || encoded.includes("br") || encoded.includes("deflate")))
        ? (APPROX_UNCOMPRESSED_BYTES[iso3] || 0)
        : clHeader;

      // Stream to drive the progress indicator.
      const reader = r.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (showProgress) onLoadProgress(iso3, received, total);
      }

      // Reassemble and parse.
      const blob = new Uint8Array(received);
      let pos = 0;
      for (const c of chunks) { blob.set(c, pos); pos += c.length; }
      const text = new TextDecoder("utf-8").decode(blob);
      const data = JSON.parse(text);

      dataCache.set(iso3, data);
      return data;
    } catch {
      return FALLBACK;
    } finally {
      inflight.delete(iso3);
    }
  })();

  inflight.set(iso3, p);
  return p;
}

// After the first country loads, kick off background prefetches of the
// other two so subsequent switches are instant. Invoked once from
// switchCountry on the initial load.
let prefetchedOthers = false;
function prefetchOtherCountries(currentIso3) {
  if (prefetchedOthers) return;
  prefetchedOthers = true;
  ["NGA", "BGD", "GTM"].forEach(iso3 => {
    if (iso3 === currentIso3 || dataCache.has(iso3)) return;
    // Silent background prefetch — no UI progress updates.
    loadAtlas(iso3, { showProgress: false }).catch(() => {});
  });
}

// ---- map init ----
// Base style is shared between 2D + 3D. The 3D path additionally:
//   1. Wraps the world on a sphere via projection: { type: "globe" }
//   2. Adds a `sky` layer for the soft atmospheric glow at the horizon
//   3. Lands the user at a tilted, slightly zoomed-out camera so the
//      curvature is immediately visible (zoom 3.5, pitch 55).
const _baseStyle = {
  version: 8,
  sources: {
    carto: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
      ],
      tileSize: 256,
      attribution: "© OSM © CARTO",
    },
  },
  layers: [{ id: "carto", type: "raster", source: "carto" }],
};
// MapLibre v5 sky/atmosphere at the top level of the style. Atmosphere
// only renders when the projection is globe; in mercator it's a no-op.
// We include it unconditionally so toggling to globe via setProjection()
// later doesn't require re-loading the style.
//
// Intensity tuned DOWN from the MapLibre default because at high pitch
// (camera tilted up toward the horizon) the default atmosphere renders
// as a bright white-ish wash at the top of the map area, which reads as
// a glaring strip during cinematic camera moves. Quarter-intensity at
// space zoom + faster fade-out keeps the subtle horizon glow that sells
// the curvature without the distracting brightness.
_baseStyle.sky = {
  "atmosphere-blend": [
    "interpolate", ["linear"], ["zoom"],
    0, 0.35,  // gentle haze at space zoom (was 1.0 — too bright)
    4, 0.2,   // dimmer at country zoom
    7, 0,     // gone by sub-country zoom
  ],
};
_baseStyle.projection = { type: IS_3D ? "globe" : "mercator" };
const map = new maplibregl.Map({
  container: "map",
  style: _baseStyle,
  center: IS_3D ? [9.5, 5.0] : VIEWS.NGA.center,
  zoom: IS_3D ? 3.4 : VIEWS.NGA.zoom,
  pitch: IS_3D ? 55 : 0,
  bearing: 0,
  maxZoom: 17,
  maxPitch: IS_3D ? 75 : 0,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: IS_3D }), "top-right");

// Cinematic camera helper. 2D path falls straight through to map.flyTo so
// the working tool stays predictable. 3D path adds pitch + bearing so the
// camera arcs across the globe + dives into the target facility, which is
// the whole point of the immersive view.
//
// Two pacing profiles in 3D:
//   * facility dive  (zoom ≥ 11) — quick + sharp, 2.4s, bearing jitter
//   * country/state move (zoom < 11) — long + intentional, 4.5s with high
//     curve, so that switching countries reads as a deliberate camera
//     swing across the globe to the new region. Anything faster makes
//     cross-continent jumps (Nigeria ↔ Bangladesh) feel rushed.
function cinematicFlyTo(opts) {
  if (!IS_3D) {
    map.flyTo(opts);
    return;
  }
  const targetZoom = opts.zoom ?? map.getZoom();
  const isFacilityDive = targetZoom >= 11;
  const bearing = isFacilityDive
    ? (map.getBearing() + (Math.random() * 30 - 15))
    : 0;
  map.flyTo({
    center: opts.center,
    zoom: targetZoom,
    pitch: isFacilityDive ? 65 : 55,
    bearing,
    duration: isFacilityDive ? 2400 : 4500,
    curve: isFacilityDive ? 1.5 : 2.5,
    speed: isFacilityDive ? 0.7 : 0.4,
    essential: true,
  });
}

// ---- 3D-only floating UI: Spotlight (cinematic flyover of critical sites) ----
//
// On click, the camera flies through the top-N most-critical facilities in
// the current filtered view + one contrasting low-risk site. Each stop
// shows a custom popup with the facility name, score band, score, top
// driver, and location. Cancellable mid-flight by ANY user interaction
// with the map (mousedown/wheel/touchstart); the next click resumes from
// where the user paused rather than restarting from the top.
//
// Why "Spotlight critical sites" instead of "Take the tour": the verb
// promises something specific (a curated highlight reel) instead of
// implying the platform needs to be explained.
//
// Storytelling pacing — the reel is composed of three movements:
//   1. INTRO  — globe spin for ~3s to set the scene before the first dive.
//                Only on a fresh run; resumes skip the intro.
//   2. ARC    — between every two stops, a high-curve flyTo that pulls the
//                camera out into space, rotates it, then dives back down.
//                The high curve (>2) is what gives MapLibre's flyTo the
//                pronounced parabolic-through-low-zoom-space feel; without
//                it transitions feel like 2D snaps even on the globe.
//   3. DWELL  — popup hold at each facility, kept short (3s) so the reel
//                stays propulsive rather than tutorial-paced.
const SPOTLIGHT_TOP_N = 5;
const SPOTLIGHT_CONTRAST_LOW_N = 1;
// Pacing knobs. The whole reel is paced for storytelling — the user clicked
// a button asking to be shown something, so we take the time to actually
// show it rather than rush through.
//
// Walking-pace metaphor (Pere's framing): a parent walking with a young
// child shouldn't stride so fast the child has to run to keep up. Slower
// motion lets the eye follow what's happening, lets the brain register the
// info in each popup, and stops the whole thing feeling dizzy.
const SPOTLIGHT_INTRO_MS = 10000;        // opening globe spin — “scanning” beat
const SPOTLIGHT_INTRO_BEARING = 70;      // degree magnitude (subtracted at use
                                         // site = clockwise = right-spinning)
const SPOTLIGHT_FLY_MS = 6500;           // NEAR arc duration — dives have weight
const SPOTLIGHT_FLY_MS_FAR = 11000;      // FAR arc duration — enough time for the
                                         // camera to climb out to globe view
                                         // and dive back down, not snap
const SPOTLIGHT_FLY_CURVE = 2.5;         // near-arc curve
const SPOTLIGHT_FLY_CURVE_FAR = 4.5;     // far-arc curve — dramatic pullback
const SPOTLIGHT_FLY_SPEED_NEAR = 0.32;   // lower = slower apparent motion
const SPOTLIGHT_FLY_SPEED_FAR = 0.25;    // lower still for far arcs
const SPOTLIGHT_FAR_THRESHOLD_DEG = 2.0; // degree distance threshold for
                                         // far-vs-near pacing branch
const SPOTLIGHT_FLY_BEARING_SPREAD = 60; // bearing jitter per arc, in degrees
const SPOTLIGHT_DWELL_MS = 4000;         // popup dwell per facility (read time)
const SPOTLIGHT_OUTRO_PULLBACK_MS = 4500; // phase 1 of close: pull to globe + spin
const SPOTLIGHT_OUTRO_SETTLE_MS = 4800;   // phase 2 of close: settle to country
const SPOTLIGHT_OUTRO_BEARING = 75;       // bearing sweep during pullback
let tourActive = false;
let spotlightPaused = false; // true when user clicked into a popup; resume
                             // continues from the next stop. Distinct from
                             // tourActive=false (full stop) — paused keeps
                             // the queue + index so resume picks back up.
let spotlightQueue = [];     // ordered array of facility features to visit
let spotlightIdx = 0;        // index of the NEXT stop to visit (resume token)
let spotlightTimer = null;   // setTimeout handle for the schedule chain
let spotlightPopup = null;   // active maplibregl.Popup instance
let spotlightIsFreshRun = true; // false when resuming mid-reel after stop
let dataReady = false;       // flips true once the active country's GeoJSON
                             // has been fetched, parsed, filtered, and the
                             // map source has been populated. Spotlight
                             // gates on this so clicks during data load
                             // don't trigger a no-op run over an empty map.
let pendingSpotlightStart = false; // a Spotlight click that arrived before
                             // dataReady; auto-fires when data is ready.

// ---- Loading overlay (centered "Loading the globe…" badge on the map) ----
function showMapLoading() {
  document.getElementById("map-loading")?.classList.remove("hidden");
}
function hideMapLoading() {
  document.getElementById("map-loading")?.classList.add("hidden");
}

function buildSpotlightQueue() {
  // Pull from the CURRENT filtered set so the spotlight always reflects
  // whatever the user is looking at (country switch, state filter, etc.).
  if (!filteredFeatures || filteredFeatures.length === 0) return [];
  const sorted = [...filteredFeatures].sort(
    (a, b) => b.properties.risk_score - a.properties.risk_score
  );
  const top = sorted.slice(0, SPOTLIGHT_TOP_N);
  // Contrast site: ONLY include if the filtered set actually contains a
  // genuinely low-band (green) facility. The narrative “here are the worst
  // — and here is one that's actually safe” only lands if the contrast is
  // visibly green. If the lowest-risk facility in view is still a yellow
  // “moderate”, ending the reel on it muddles the message; better to end
  // on the last critical site than to misrepresent moderate as safe.
  //
  // Current data: NGA's lowest score is ~32.5 (mid band), so the contrast
  // site is skipped for full-Nigeria filters but kicks in for narrower
  // states or for BGD/GTM where genuine green facilities exist.
  const lowBand = sorted.filter(f => band(f.properties.risk_score) === "low");
  const contrast = lowBand.slice(-SPOTLIGHT_CONTRAST_LOW_N).reverse();
  return [...top, ...contrast];
}

function invalidateSpotlightQueue() {
  // Called when filters / country change so a resumed spotlight doesn't
  // visit stale facilities. Also stops any active run — the user's filter
  // change is the more recent intent.
  spotlightQueue = [];
  spotlightIdx = 0;
  if (tourActive) stopSpotlight();
}

// Three button states:
//   idle     — “▶ Spotlight critical sites”  (no reel active)
//   running  — “■ Stop spotlight”           (reel playing, click to halt)
//   paused   — “▶ Resume spotlight”          (user clicked a popup, drilled
//                                              into detail; click to continue)
function setTourButtonState() {
  const btn = document.getElementById("btn-tour");
  if (!btn) return;
  const isRunning = tourActive && !spotlightPaused;
  const isPaused = tourActive && spotlightPaused;
  btn.classList.toggle("active", isRunning);
  btn.classList.toggle("paused", isPaused);
  const icon = btn.querySelector(".tour-icon");
  const label = btn.querySelector(".tour-label");
  if (icon) icon.textContent = isRunning ? "■" : "▶";
  if (label) {
    label.textContent = isPaused
      ? "Resume spotlight"
      : (isRunning ? "Stop spotlight" : "Spotlight critical sites");
  }
}

function startSpotlight() {
  if (!IS_3D || tourActive) return;

  // If the user clicks Spotlight before the data has finished loading, queue
  // the request and auto-fire it once data is ready. Otherwise the click
  // silently does nothing (buildSpotlightQueue returns [] for empty
  // filteredFeatures), which felt like the button was broken. The deferred
  // start also gives a beat for the freshly-rendered dots to appear before
  // the camera starts arcing through them.
  if (!dataReady) {
    pendingSpotlightStart = true;
    return;
  }

  // Rebuild the queue if it's empty (first run, or after a country/filter
  // change). Keep the existing queue if we're resuming — spotlightIdx points
  // at the next unvisited stop and we want to continue from there. The
  // intro spin only plays on a fresh run; resumes skip it and dive into
  // the next site directly, which matches the pause/play model.
  if (spotlightQueue.length === 0 || spotlightIdx >= spotlightQueue.length) {
    spotlightQueue = buildSpotlightQueue();
    spotlightIdx = 0;
    spotlightIsFreshRun = true;
  } else {
    spotlightIsFreshRun = false;
  }
  if (spotlightQueue.length === 0) return;
  tourActive = true;
  spotlightPaused = false;
  setTourButtonState();

  if (spotlightIsFreshRun) {
    playSpotlightIntro();
  } else {
    visitNextSpotlightStop();
  }
}

// Soft pause: user clicked a popup so they could drill into the detail
// panel. Keep the queue + index, halt the dwell timer + the camera, and
// flip the button to “Resume spotlight”. The next click on the button
// (or closing the detail panel) calls resumeSpotlight() to continue.
function pauseSpotlight() {
  if (!tourActive || spotlightPaused) return;
  spotlightPaused = true;
  setTourButtonState();
  if (spotlightTimer !== null) {
    clearTimeout(spotlightTimer);
    spotlightTimer = null;
  }
  // Keep the popup visible alongside the detail panel — Pere wants the
  // user's context-anchor on the map to stay put rather than disappear
  // the moment the side panel opens. The popup auto-clears on the next
  // visitNextSpotlightStop (which calls hideSpotlightPopup before
  // showing the new one), so no manual cleanup needed here.
  map.stop();           // halt any in-flight camera animation
}

function resumeSpotlight() {
  if (!tourActive || !spotlightPaused) return;
  spotlightPaused = false;
  setTourButtonState();
  // Auto-close the right detail panel when resuming — the spotlight needs
  // the map area unobstructed for its cinematic moves, and the panel is
  // tied to the now-paused drill-down. Both directions automate cleanly:
  // closing the panel resumes the spotlight (handled in the close-button
  // wiring); clicking Resume closes the panel (handled here).
  if (document.body.classList.contains("has-detail")) {
    closeDetail();
  }
  // Clear the paused-state popup before the next arc fires — otherwise it
  // hangs around at the previous facility's location for the full 5s of
  // travel, visually persisting on screen during the cinematic move and
  // also blocking the next popup from mounting cleanly at its new spot.
  hideSpotlightPopup();
  // Advance past the stop the user just drilled into — they've already
  // seen that one in full detail, no need to re-visit. The brief setTimeout
  // gives the close-detail animation a beat to start.
  spotlightIdx++;
  spotlightTimer = setTimeout(visitNextSpotlightStop, 350);
}

// 3-second world-spin that opens a fresh spotlight reel. Pulls the camera
// back to the country overview at a tilted pitch and sweeps the bearing by
// SPOTLIGHT_INTRO_BEARING degrees — enough to read as motion but not so
// much it feels rushed. Storytelling beat: “here is the country, here is
// what we are about to show you.” Then we flyTo the first critical site.
function playSpotlightIntro() {
  const iso = currentData?.metadata?.iso3 || "NGA";
  const v = VIEWS[iso] || VIEWS.NGA;
  const startBearing = map.getBearing();
  // SUBTRACT bearing — in MapLibre's compass-based bearing model, decreasing
  // bearing produces a clockwise rotation from the user's perspective
  // (“spinning to the right”), which matches the original tour direction.
  map.easeTo({
    center: v.center,
    zoom: Math.max(v.zoom - 1.0, 3.5),
    pitch: 60,
    bearing: startBearing - SPOTLIGHT_INTRO_BEARING,
    duration: SPOTLIGHT_INTRO_MS,
  });
  // Start the first dive 250ms BEFORE the intro easeTo completes. flyTo
  // cleanly interrupts an in-flight easeTo without any settling pause,
  // which is what map.once("moveend") + visitNext gave us: a perceptible
  // beat where the camera sat still between the intro ending and the
  // first arc beginning. Overlapping eliminates that gap.
  spotlightTimer = setTimeout(() => {
    if (!tourActive || spotlightPaused) return;
    visitNextSpotlightStop();
  }, SPOTLIGHT_INTRO_MS - 250);
}

function visitNextSpotlightStop() {
  if (!tourActive) return;
  if (spotlightIdx >= spotlightQueue.length) {
    finishSpotlight();
    return;
  }
  // Belt-and-braces popup hide before every flight — the dwell-advance
  // path already hides, and resumeSpotlight hides too, but a hide here
  // means no path through the state machine can ever leave a stale popup
  // anchored at the previous facility while the camera arcs to the next.
  hideSpotlightPopup();
  const f = spotlightQueue[spotlightIdx];
  const [lng, lat] = f.geometry.coordinates;

  // Distance-aware pacing. Squared degree distance between current camera
  // center and the target. Cheap enough to compute per stop, no need for
  // proper haversine — we just want a near/far decision threshold. When
  // the next site is in the same neighborhood the existing curve reads
  // fine; when it's across the country, we need a longer duration + higher
  // curve so the camera has time to climb and come back down. Without
  // this, far jumps look exactly like 2D snaps.
  const cur = map.getCenter();
  const dSq = (cur.lng - lng) ** 2 + (cur.lat - lat) ** 2;
  const isFar = dSq > SPOTLIGHT_FAR_THRESHOLD_DEG ** 2;
  const flyMs = isFar ? SPOTLIGHT_FLY_MS_FAR : SPOTLIGHT_FLY_MS;
  const flyCurve = isFar ? SPOTLIGHT_FLY_CURVE_FAR : SPOTLIGHT_FLY_CURVE;
  const flySpeed = isFar ? SPOTLIGHT_FLY_SPEED_FAR : SPOTLIGHT_FLY_SPEED_NEAR;

  // Bearing jitter (±SPOTLIGHT_FLY_BEARING_SPREAD/2) ensures consecutive
  // arcs don't look identical. We don't bias direction — random across
  // both sides feels more organic than always clockwise.
  const bearingDelta = (Math.random() - 0.5) * SPOTLIGHT_FLY_BEARING_SPREAD;
  // Closer end-zoom (12) keeps the “landing”-feel approach without the
  // higher pitch (72) that was tilting the camera enough to expose
  // MapLibre's atmospheric halo as a bright strip at the top of the
  // viewport. Pitch 65 was the original — same 3D arc feel, no white
  // bar. The high arc curve still gives the camera the climb-and-dive
  // motion that reads as 3D rather than 2D zoom.
  map.flyTo({
    center: [lng, lat],
    zoom: 12,
    pitch: 65,
    bearing: map.getBearing() + bearingDelta,
    duration: flyMs,
    curve: flyCurve,
    speed: flySpeed,
    essential: true,
  });

  // After the fly completes, show the popup and dwell. Then advance.
  // Schedule against the actual flight duration (which differs near vs far).
  spotlightTimer = setTimeout(() => {
    if (!tourActive) return;
    showSpotlightPopup(f);
    spotlightTimer = setTimeout(() => {
      if (!tourActive) return;
      hideSpotlightPopup();
      spotlightIdx++;
      // Tiny gap so the popup fade-out reads cleanly before the next arc.
      spotlightTimer = setTimeout(visitNextSpotlightStop, 220);
    }, SPOTLIGHT_DWELL_MS);
  }, flyMs + 150);
}

function showSpotlightPopup(f) {
  const p = f.properties;
  const s = p.risk_score;
  const tier = bandLabel(s);
  const tierClass = band(s);
  const drivers = typeof p.top_drivers === "string" ? JSON.parse(p.top_drivers) : (p.top_drivers || []);
  const topDriver = drivers[0] ? drivers[0].replace(/_/g, " ") : "";
  const tags = typeof p.tags === "string" ? JSON.parse(p.tags || "{}") : (p.tags || {});
  const state = tags["admin1"] || tags["addr:state"] || "";
  const lga = tags["addr:city"] || "";
  const loc = [lga, state].filter(Boolean).join(" · ");

  hideSpotlightPopup();
  spotlightPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 22,
    className: "spotlight-popup",
  })
    .setLngLat(f.geometry.coordinates)
    .setHTML(`
      <div class="spotlight-pop">
        <span class="tier ${tierClass}">${escapeHtml(tier)} risk</span>
        <div class="name">${escapeHtml(displayName(f))}</div>
        <div class="meta">
          <span class="score" style="color:${bandColor(s)}">${s.toFixed(0)}</span>
          ${topDriver ? `<span class="driver">${escapeHtml(topDriver)}</span>` : ""}
        </div>
        ${loc ? `<div class="location">${escapeHtml(loc)}</div>` : ""}
      </div>
    `)
    .addTo(map);

  // Click the popup to open the full detail panel + pause the spotlight.
  // Handler is attached to the popup's outer element so any click within
  // its bounds triggers it. stopPropagation prevents the click from also
  // hitting the map's mousedown cancellation path (which would fully stop
  // the spotlight instead of pausing it).
  const popupEl = spotlightPopup.getElement();
  if (popupEl) {
    popupEl.style.cursor = "pointer";
    popupEl.addEventListener("mousedown", e => e.stopPropagation());
    popupEl.addEventListener("click", e => {
      e.stopPropagation();
      pauseSpotlight();
      highlightFacility(f);
      renderDetail(f);
    });
  }
}

function hideSpotlightPopup() {
  if (spotlightPopup) {
    spotlightPopup.remove();
    spotlightPopup = null;
  }
}

function finishSpotlight() {
  // Two-phase cinematic close — “drone returning home”:
  //   1. Pull WAY back to a near-space view + sweep bearing (3.2s).
  //   2. Settle into the canonical north-up country overview (3.5s).
  // The combined ~7s gives the reel a real finale instead of a flat zoom-out.
  //
  // We tear down spotlight state up front (button flips, queue resets) so
  // a user clicking Spotlight again mid-outro starts a fresh run cleanly;
  // their new intro spin overrides our settling easeTo, which is fine.
  // Passing haltCamera=false to stopSpotlight prevents it from calling
  // map.stop() and killing our just-issued easeTo.
  const iso = currentData?.metadata?.iso3 || "NGA";
  const v = VIEWS[iso] || VIEWS.NGA;
  const startBearing = map.getBearing();
  stopSpotlight(false);
  spotlightIdx = 0;
  spotlightQueue = [];

  // Phase 1: pull back to space view + spin a bit. High pitch + low zoom
  // = the camera is high above the planet, drifting.
  map.easeTo({
    zoom: 2.4,
    pitch: 68,
    bearing: startBearing + SPOTLIGHT_OUTRO_BEARING,
    duration: SPOTLIGHT_OUTRO_PULLBACK_MS,
  });

  // Phase 2: ease down to the country overview at canonical bearing 0.
  // Scheduled directly with setTimeout (NOT spotlightTimer) because the
  // spotlight state is already torn down — this animation is purely the
  // outro and runs independently.
  setTimeout(() => {
    map.easeTo({
      center: v.center,
      zoom: Math.max(v.zoom - 1.0, 3.5),
      pitch: 55,
      bearing: 0,
      duration: SPOTLIGHT_OUTRO_SETTLE_MS,
    });
  }, SPOTLIGHT_OUTRO_PULLBACK_MS + 100);
}

function stopSpotlight(haltCamera = true) {
  if (!tourActive) return;
  tourActive = false;
  spotlightPaused = false;
  setTourButtonState();
  hideSpotlightPopup();
  if (spotlightTimer !== null) {
    clearTimeout(spotlightTimer);
    spotlightTimer = null;
  }
  // Halt any in-flight flyTo unless the caller is finishSpotlight, which
  // is about to issue its own multi-phase camera animation and DOES want
  // continuity rather than a hard stop.
  if (haltCamera) map.stop();
  // INTENTIONALLY don't reset spotlightIdx / spotlightQueue — next click
  // resumes from where the user paused. invalidateSpotlightQueue() is the
  // one that wipes them, called on filter/country change.
}

// Kept as a stable alias so applyMode() and the click handler can read the
// same name; both “stop tour” and “stop spotlight” converge on this.
const stopTour = stopSpotlight;
const startTour = startSpotlight;

// ---- 2D ↔ 3D in-place swap (no page reload) ----
//
// Flips the map between mercator + flat (2D) and globe + tilted (3D).
// Preserves: data, filters, selected facility, scroll position. Updates:
// projection, pitch/bearing, body class, toggle .active, URL via
// History API. Listeners for back/forward (popstate) below.
//
// The two HTML files (/index.html, /3d/index.html) still exist for
// distinct OG share cards on first paint — first load picks the right
// initial state from the pathname, and the toggle from then on never
// reloads the page.
function applyMode(want3D) {
  if (want3D === IS_3D) return;
  IS_3D = want3D;

  // STEP 1 — tear down anything that calls map.stop() FIRST.
  // stopSpotlight calls map.stop() which would otherwise cancel the easeTo
  // we issue below. Doing this first means the eventual easeTo runs without
  // interruption and lands at the canonical natural-state framing for the
  // new mode. This was the root cause of the 2D-shows-tilted-perspective
  // bug — the spotlight's map.stop() was killing the reset animation.
  if (!want3D && tourActive) stopSpotlight();
  if (want3D) setupPulseLayer();
  else teardownPulseLayer();

  // STEP 2 — update maxPitch so user-interaction respects the mode.
  // maxPitch was set at map-init based on the initial IS_3D and never
  // updated on toggle, so 2D->3D was clamping the camera's pitch at 0
  // (the 2D mode init value) even when easeTo tried to set 55. This is
  // the root cause of the 2D->3D-still-feels-flat bug.
  map.setMaxPitch(want3D ? 75 : 0);

  // STEP 3 — switch projection. Instantaneous; the easeTo below carries
  // the camera into the natural framing for the new projection.
  map.setProjection({ type: want3D ? "globe" : "mercator" });

  // STEP 4 — ease to the canonical landing state for the new mode. ALWAYS
  // resets center + zoom + pitch + bearing so the toggle reliably lands at
  // the SAME natural framing every time, regardless of where the camera
  // happened to be (deep dive, mid-rotation, etc.) when the toggle fired.
  const iso = currentData?.metadata?.iso3 || "NGA";
  const v = VIEWS[iso] || VIEWS.NGA;
  if (want3D) {
    map.easeTo({
      center: v.center,
      zoom: Math.max(v.zoom - 1.5, 3.5),
      pitch: 55,
      bearing: 0,
      duration: 1500,
    });
  } else {
    map.easeTo({
      center: v.center,
      zoom: v.zoom,
      pitch: 0,
      bearing: 0,
      duration: 1500,
    });
  }

  // STEP 5 — reflect mode in the DOM (body class for CSS gating, .vt-btn
  //          active class for the toggle).
  document.body.classList.toggle("is-3d", want3D);
  document.querySelectorAll(".view-toggle .vt-btn").forEach(btn => {
    const href = btn.getAttribute("href");
    btn.classList.toggle("active", href === (want3D ? "/3d" : "/"));
  });
}

// ---- 3D pulse animation on the most-critical facilities ----
//
// Renders a second, separately-styled circle layer that only matches
// facilities scoring >= 73 (current top-of-distribution; will tighten to
// 75 SEVERE band once the pipeline re-runs with finer climate stride).
// circle-stroke-width and circle-stroke-opacity are tweened on every
// requestAnimationFrame frame, producing a soft expanding ring — the
// kind of visual cue you can read from globe zoom-out.
//
// Performance: filter expression is evaluated GPU-side per dot. At the
// current top-of-distribution threshold ~few hundred dots qualify, so
// the pulse layer renders cheaply even on the full 50k-facility country.
const PULSE_LAYER_ID = "facilities-pulse";
const PULSE_THRESHOLD = 73;       // risk_score threshold; raise to 75 post-rerun
const PULSE_PERIOD_SEC = 2.4;     // one full breath in/out
let pulseRafId = null;

function setupPulseLayer() {
  if (!map.getSource("facilities")) return;        // data hasn't loaded yet
  if (map.getLayer(PULSE_LAYER_ID)) return;        // already added
  map.addLayer({
    id: PULSE_LAYER_ID,
    type: "circle",
    source: "facilities",
    filter: [">=", ["get", "risk_score"], PULSE_THRESHOLD],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 10, 10, 18, 14, 28],
      "circle-color": "rgba(0,0,0,0)",            // ring only, no fill
      "circle-stroke-color": "#C35248",           // severe red, brand var(--sev)
      "circle-stroke-width": 1.5,
      "circle-stroke-opacity": 0.8,
    },
  });
  startPulseAnimation();
}

function teardownPulseLayer() {
  stopPulseAnimation();
  if (map.getLayer(PULSE_LAYER_ID)) map.removeLayer(PULSE_LAYER_ID);
}

function startPulseAnimation() {
  if (pulseRafId !== null) return;
  const t0 = performance.now();
  function frame() {
    if (!map.getLayer(PULSE_LAYER_ID)) { pulseRafId = null; return; }
    const t = (performance.now() - t0) / 1000;
    const phase = (Math.sin((t / PULSE_PERIOD_SEC) * Math.PI * 2) + 1) / 2; // 0..1
    // Opacity fades out as the ring expands — the classic “radar ping” feel.
    map.setPaintProperty(PULSE_LAYER_ID, "circle-stroke-opacity", 0.85 * (1 - phase * 0.9));
    map.setPaintProperty(PULSE_LAYER_ID, "circle-stroke-width", 1.2 + phase * 5.5);
    pulseRafId = requestAnimationFrame(frame);
  }
  pulseRafId = requestAnimationFrame(frame);
}

function stopPulseAnimation() {
  if (pulseRafId !== null) {
    cancelAnimationFrame(pulseRafId);
    pulseRafId = null;
  }
}

// Intercept toggle clicks: prevent the native navigation, swap in place,
// push the URL via History API so back/forward + share-link work as if
// the page had actually navigated.
function wireViewToggle() {
  document.querySelectorAll(".view-toggle .vt-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      // Allow modifier-key opens (cmd+click etc.) to behave normally.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const href = btn.getAttribute("href");
      const want3D = href === "/3d";
      if (want3D === IS_3D) { e.preventDefault(); return; }
      e.preventDefault();
      applyMode(want3D);
      // pushState reflects the navigation in the URL bar without reloading.
      history.pushState({ mode: want3D ? "3d" : "2d" }, "", want3D ? "/3d" : "/");
    });
  });

  // Back/forward should swap modes the same way.
  window.addEventListener("popstate", () => {
    const want3D = window.location.pathname.startsWith("/3d");
    if (want3D !== IS_3D) applyMode(want3D);
  });
}

let popup = new maplibregl.Popup({ closeOnClick: true, closeButton: false, maxWidth: "220px" });

// ---- state helpers ----

// Known abbreviation expansions + typo fixes per country
const STATE_FIXES = {
  NGA: { "KN": "Kano", "ogun state": "Ogun", "FC": "FCT Abuja", "LA": "Lagos" },
  BGD: { "Chittagoang": "Chittagong", "WB": "West Bengal" },
  GTM: {},
};

function normalizeStateName(raw, iso3) {
  if (!raw || raw === "Untagged Region") return "Untagged Region";
  // Apply known fixes
  const fixes = STATE_FIXES[iso3] || {};
  if (fixes[raw]) return fixes[raw];
  // Title case: "adamawa" -> "Adamawa", "yobe" -> "Yobe"
  const titled = raw.replace(/\b\w/g, c => c.toUpperCase())
                     .replace(/\bState\b/i, "").trim(); // remove trailing "State"
  return titled;
}

function getState(feature) {
  const tags = feature.properties.tags;
  if (!tags) return "Untagged Region";
  const parsed = typeof tags === "string" ? JSON.parse(tags) : tags;
  // Prefer admin1 (from reverse geocoding) over addr:state (from OSM)
  const raw = parsed["admin1"] || parsed["addr:state"];
  if (!raw) return "Untagged Region";
  const iso3 = currentData?.metadata?.iso3 || "";
  return normalizeStateName(raw, iso3);
}

function populateStates(features) {
  const stateMap = new Map();
  features.forEach(f => {
    const s = getState(f);
    stateMap.set(s, (stateMap.get(s) || 0) + 1);
  });
  const states = [...stateMap.entries()].sort((a, b) => {
    if (a[0] === "Untagged Region") return 1;
    if (b[0] === "Untagged Region") return -1;
    return a[0].localeCompare(b[0]);
  });

  const panel = document.getElementById("state-panel");
  panel.innerHTML = "";

  // "All" option
  const allOpt = document.createElement("div");
  allOpt.className = "state-opt sel";
  allOpt.dataset.value = "";
  allOpt.innerHTML = 'All states / regions';
  panel.appendChild(allOpt);

  states.forEach(([s, c]) => {
    const opt = document.createElement("div");
    opt.className = "state-opt";
    opt.dataset.value = s;
    opt.innerHTML = `<span>${escapeHtml(s)}</span><span class="cnt">${c}</span>`;
    panel.appendChild(opt);
  });

  // Wire clicks on each option
  panel.querySelectorAll(".state-opt").forEach(opt => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const val = opt.dataset.value;
      activeFilters.state = val;
      document.getElementById("state-btn").textContent = val || "All states / regions";
      panel.querySelectorAll(".state-opt").forEach(o => o.classList.remove("sel"));
      opt.classList.add("sel");
      panel.classList.remove("open");
      updateSearchPlaceholder();
      applyFilters();
      zoomToFiltered();
    });
  });
}

function updateSearchPlaceholder() {
  const search = document.getElementById("search");
  if (activeFilters.state) {
    search.placeholder = `Search in ${activeFilters.state}…`;
  } else {
    const name = currentData?.metadata?.country || "all";
    search.placeholder = `Search all of ${name}…`;
  }
}

// ========================================================================
// SEARCH AUTOCOMPLETE
// Renders a dropdown of matching facilities as the user types. Keyboard
// support: ↑/↓ to navigate, Enter to select, Esc to close.
// ========================================================================
let searchHighlightIdx = -1;
let searchResultFeatures = [];

function renderSearchResults(query) {
  const panel = document.getElementById("search-results");
  const input = document.getElementById("search");
  if (!panel) return;

  const q = (query || "").toLowerCase().trim();
  if (!q) {
    closeSearchResults();
    return;
  }

  // Score matches: prefer startsWith, then word-start, then contains.
  const scored = [];
  for (const f of allFeatures) {
    // Scope to selected state if any
    if (activeFilters.state && getState(f) !== activeFilters.state) continue;
    const name = displayName(f).toLowerCase();
    if (!name.includes(q)) continue;
    let rank;
    if (name.startsWith(q)) rank = 0;
    else if (new RegExp("\\b" + q.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")).test(name)) rank = 1;
    else rank = 2;
    scored.push({ f, rank, score: f.properties.risk_score });
  }
  scored.sort((a, b) => a.rank - b.rank || b.score - a.score);

  const results = scored.slice(0, 12).map(x => x.f);
  searchResultFeatures = results;
  searchHighlightIdx = results.length ? 0 : -1;

  if (!results.length) {
    panel.innerHTML = '<div class="search-empty">No matching facilities.</div>';
    panel.classList.add("open");
    input?.setAttribute("aria-expanded", "true");
    return;
  }

  panel.innerHTML = results.map((f, i) => {
    const p = f.properties;
    const s = p.risk_score;
    const stateLabel = getState(f);
    const state = stateLabel && stateLabel !== "Untagged Region" ? stateLabel : "";
    const type = p.facility_type || "";
    // If the facility name already ends with the type word, don't duplicate
    // (e.g. name = "Hassan Gwarzo School" → type="school" is redundant).
    const name = displayName(f);
    const nameLower = name.toLowerCase();
    const typeCap = type ? type.charAt(0).toUpperCase() + type.slice(1) : "";
    const typeInName = type && nameLower.endsWith(type);
    // Build a compact subtitle: "type · state" or just the one that's useful
    const subParts = [];
    if (typeCap && !typeInName) subParts.push(typeCap);
    if (state) subParts.push(state);
    const subText = subParts.join(" · ");
    return `<div class="search-result${i === 0 ? " hl" : ""}" role="option" data-id="${escapeHtml(p.id)}" data-idx="${i}">
      <span class="d" style="background:${bandColor(s)}"></span>
      <div class="meta">
        <span class="t">${escapeHtml(name)}</span>
        ${subText ? `<span class="sub">${escapeHtml(subText)}</span>` : ""}
      </div>
      <span class="s">${s.toFixed(0)}</span>
    </div>`;
  }).join("");
  panel.classList.add("open");
  input?.setAttribute("aria-expanded", "true");

  panel.querySelectorAll(".search-result").forEach(el => {
    el.addEventListener("click", () => selectSearchResult(parseInt(el.dataset.idx, 10)));
    el.addEventListener("mouseenter", () => {
      panel.querySelectorAll(".search-result").forEach(r => r.classList.remove("hl"));
      el.classList.add("hl");
      searchHighlightIdx = parseInt(el.dataset.idx, 10);
    });
  });
}

function closeSearchResults() {
  const panel = document.getElementById("search-results");
  const input = document.getElementById("search");
  if (panel) { panel.classList.remove("open"); panel.innerHTML = ""; }
  input?.setAttribute("aria-expanded", "false");
  searchResultFeatures = [];
  searchHighlightIdx = -1;
}

function selectSearchResult(idx) {
  const f = searchResultFeatures[idx];
  if (!f) return;
  cinematicFlyTo({ center: f.geometry.coordinates, zoom: 13 });
  highlightFacility(f);
  renderDetail(f);
  const input = document.getElementById("search");
  if (input) input.value = displayName(f);
  closeSearchResults();
}

function moveSearchHighlight(delta) {
  if (!searchResultFeatures.length) return;
  searchHighlightIdx = (searchHighlightIdx + delta + searchResultFeatures.length) % searchResultFeatures.length;
  const panel = document.getElementById("search-results");
  panel?.querySelectorAll(".search-result").forEach(el => {
    const i = parseInt(el.dataset.idx, 10);
    el.classList.toggle("hl", i === searchHighlightIdx);
    if (i === searchHighlightIdx) el.scrollIntoView({ block: "nearest" });
  });
}

// ---- filtering ----
function applyFilters() {
  const s = activeFilters.search.toLowerCase();
  filteredFeatures = allFeatures.filter(f => {
    const p = f.properties;
    if (!activeFilters.types.has(p.facility_type)) return false;
    if (!activeFilters.bands.has(band(p.risk_score))) return false;
    if (activeFilters.state && getState(f) !== activeFilters.state) return false;
    const dname = displayName(f).toLowerCase();
    if (s && !dname.includes(s)) return false;
    return true;
  });
  // The spotlight reel is derived from filteredFeatures, so a filter change
  // means the cached queue is stale. Drop it; the next Spotlight click
  // rebuilds against the new view.
  invalidateSpotlightQueue();
  updateMap();
  renderStats();
  renderTopList();
}

function zoomToFiltered() {
  if (!filteredFeatures.length) return;
  if (!activeFilters.state) {
    // Zoom to full country
    const iso = currentData?.metadata?.iso3 || "NGA";
    const v = VIEWS[iso] || VIEWS.NGA;
    cinematicFlyTo({ center: v.center, zoom: IS_3D ? Math.max(v.zoom - 1.5, 3) : v.zoom });
    return;
  }
  // Compute bounds of filtered features
  let minLng = 999, maxLng = -999, minLat = 999, maxLat = -999;
  filteredFeatures.forEach(f => {
    const [lng, lat] = f.geometry.coordinates;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  });
  // Add small padding
  const pad = 0.05;
  map.fitBounds(
    [[minLng - pad, minLat - pad], [maxLng + pad, maxLat + pad]],
    { padding: 40, maxZoom: 14 }
  );
}

// ---- map layer ----
let mapUpdateQueued = false;

function updateMap() {
  const geojson = { type: "FeatureCollection", features: filteredFeatures };

  // Style can briefly become "not loaded" during flyTo animations or country
  // switches. Self-schedule a retry, but DON'T rely solely on map.once("idle")
  // — if a spotlight is animating non-stop, idle never fires and the update
  // is locked out forever. Belt-and-braces: also schedule a setTimeout
  // fallback. Whichever fires first wins; the mapUpdateQueued flag prevents
  // the loser from double-running.
  if (!map.isStyleLoaded()) {
    if (!mapUpdateQueued) {
      mapUpdateQueued = true;
      const retry = () => {
        if (!mapUpdateQueued) return; // other path already fired
        mapUpdateQueued = false;
        updateMap();
      };
      map.once("idle", retry);
      setTimeout(retry, 600);
    }
    return;
  }

  const src = map.getSource("facilities");
  if (src) { src.setData(geojson); return; }

  // Risk-band colour stops shared by all three layers (glow, dot, selection ring)
  const RISK_STOPS = ["step", ["get", "risk_score"],
    "#6FA774",  // low
    30, "#D9B653",  // moderate
    55, "#D9894F",  // high
    75, "#C35248"]; // severe

  map.addSource("facilities", { type: "geojson", data: geojson });
  map.addLayer({
    id: "facilities-glow", type: "circle", source: "facilities",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 6, 10, 12, 14, 18],
      "circle-color": RISK_STOPS,
      "circle-blur": 0.8, "circle-opacity": 0.32,
    },
  });
  map.addLayer({
    id: "facilities", type: "circle", source: "facilities",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3, 10, 6, 14, 10],
      "circle-color": RISK_STOPS,
      "circle-stroke-color": "rgba(30,36,51,0.85)",  // var(--ink) at 85%
      "circle-stroke-width": 1.2,
    },
  });

  // 3D-only: pulse ring around the top-critical facilities so the eye is
  // drawn to the worst from anywhere on the globe. Setup-once here; the
  // 2D ↔ 3D toggle uses setupPulseLayer/teardownPulseLayer below to
  // add or strip the layer on the fly without re-adding the source.
  if (IS_3D) setupPulseLayer();
  // Selected facility highlight — single ring, same palette as the dots
  map.addSource("selected", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "selected-ring", type: "circle", source: "selected",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 12, 10, 18, 14, 24],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": RISK_STOPS,
      "circle-stroke-width": 3,
    },
  });

  // Hover halo — a separate source + layer that holds AT MOST one feature
  // (the one currently under the cursor). Decoupled from the main facility
  // layer so any future paint changes can't affect base rendering. This is
  // the safer pattern after the feature-state approach silently broke the
  // dot render in commit 8eec11e.
  map.addSource("hovered", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "hovered-halo",
    type: "circle",
    source: "hovered",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 9, 10, 16, 14, 22],
      "circle-color": RISK_STOPS,
      "circle-opacity": 0.4,
      "circle-stroke-color": "rgba(250, 248, 244, 0.7)",  // paper at 70%
      "circle-stroke-width": 1.5,
    },
  });

  map.on("click", "facilities", e => {
    if (!e.features.length) return;
    const f = e.features[0];
    // Find full feature with recommendations
    const full = filteredFeatures.find(ff => ff.properties.id === f.properties.id) || f;
    highlightFacility(full);
    renderDetail(full);
  });
  map.on("mouseenter", "facilities", e => {
    map.getCanvas().style.cursor = "pointer";
    if (!e.features.length) return;
    const f = e.features[0];
    const p = f.properties;
    // Populate the hover-halo source with this single feature — the
    // hovered-halo layer renders it as a larger glowing ring around the dot.
    map.getSource("hovered")?.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: f.geometry,
        properties: { risk_score: p.risk_score },
      }],
    });
    popup.setLngLat(e.lngLat)
      .setHTML(`<b>${escapeHtml(displayName(f))}</b><br/>${typeIcon(p.facility_type)} ${escapeHtml(p.facility_type)} &middot; <span style="color:${bandColor(p.risk_score)};font-weight:700">${p.risk_score}</span>`)
      .addTo(map);
  });
  map.on("mouseleave", "facilities", () => {
    map.getCanvas().style.cursor = "";
    // Clear the hover halo by emptying the source's feature list.
    map.getSource("hovered")?.setData({ type: "FeatureCollection", features: [] });
    popup.remove();
  });
}

// ---- sidebar: stats ----
function renderStats() {
  const n = filteredFeatures.length;
  const scores = filteredFeatures.map(f => f.properties.risk_score);
  const avg = n ? Math.round(scores.reduce((a, b) => a + b, 0) / n) : 0;
  const severe = scores.filter(s => s >= 75).length;
  const high = scores.filter(s => s >= 55 && s < 75).length;
  const mid = scores.filter(s => s >= 30 && s < 55).length;
  const low = scores.filter(s => s < 30).length;
  const schools = filteredFeatures.filter(f => f.properties.facility_type === "school").length;
  const clinics = filteredFeatures.filter(f => f.properties.facility_type === "clinic").length;
  const hospitals = filteredFeatures.filter(f => f.properties.facility_type === "hospital").length;

  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="label">Total</div><div class="value">${n.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Avg</div><div class="value ${band(avg)}">${avg}</div></div>
    <div class="stat"><div class="label">High</div><div class="value high">${high}</div></div>
    <div class="stat"><div class="label">Severe</div><div class="value severe">${severe}</div></div>
  `;

  // distribution bar
  const pcts = { low: n ? low / n * 100 : 0, mid: n ? mid / n * 100 : 0, high: n ? high / n * 100 : 0, severe: n ? severe / n * 100 : 0 };
  document.getElementById("dist").innerHTML = `
    <div class="dist-bar">
      <div class="seg" style="width:${pcts.low}%;background:var(--low)"></div>
      <div class="seg" style="width:${pcts.mid}%;background:var(--mod)"></div>
      <div class="seg" style="width:${pcts.high}%;background:var(--high)"></div>
      <div class="seg" style="width:${pcts.severe}%;background:var(--sev)"></div>
    </div>
    <div class="dist-legend">
      <span>${low} low</span><span>${mid} mod</span><span>${high} high</span><span>${severe} severe</span>
    </div>
  `;

  // update top-bar facility chip with filtered count
  const chipText = document.getElementById("facility-chip-text");
  if (chipText) {
    const cname = currentData?.metadata?.country || "";
    chipText.textContent = `${cname} · ${n.toLocaleString()} facilities`;
  }

  // update map HUD country line
  const hudC = document.getElementById("hud-country");
  if (hudC) {
    const cname = currentData?.metadata?.country || "—";
    hudC.textContent = `${cname} · ${n.toLocaleString()} facilities`;
  }
}

// ---- highlight selected facility ----
function highlightFacility(feature) {
  if (!map.isStyleLoaded() || !map.getSource("selected")) return;
  // Reflect the selection in the URL so the current view is shareable.
  // Null/clear is handled separately by closeDetail() so we don't strip
  // the param every time the selection is just being moved.
  if (feature) setFacilityUrlParam(feature.properties.id);
  const geojson = {
    type: "FeatureCollection",
    features: feature ? [{
      type: "Feature",
      geometry: feature.geometry,
      properties: { risk_score: feature.properties.risk_score },
    }] : [],
  };
  map.getSource("selected").setData(geojson);
}

// ---- sidebar: detail panel ----
// Build a human-readable "top drivers" list from the risk components + underlying inputs.
function computeDrivers(comps, weights, climate, air) {
  const contribs = Object.keys(weights)
    .map(k => ({
      key: k,
      weight: weights[k] || 0,
      sub: comps[k] || 0,
      points: (100 * (weights[k] || 0) * (comps[k] || 0))
    }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 3);

  return contribs.map(c => {
    const k = c.key;
    if (k === "heat_exposure") {
      const d = climate.heat_index_days;
      return {
        title: d != null ? `${d} days above 35°C apparent temperature in 2024` : "Heat exposure is a top contributor",
        desc: "Heat-stress days drive cooling demand, outdoor-work risk, and pediatric vulnerability in this catchment.",
      };
    }
    if (k === "air_pollution") {
      const p = air.pm25_avg_ugm3;
      const mult = p != null ? (p / 5).toFixed(1) : null; // WHO 2021 annual guideline = 5 µg/m³
      return {
        title: p != null ? `PM2.5 averaged ${p} µg/m³ over the last 30 days` : "Air pollution is a top contributor",
        desc: mult ? `${mult}× the WHO 2021 annual guideline (5 µg/m³). Respiratory presentations, especially in children, climb with sustained exposure.` : "PM2.5 and NO₂ averages exceed WHO thresholds.",
      };
    }
    if (k === "flood_risk") {
      const d = climate.heavy_precip_days;
      return {
        title: d != null ? `${d} heavy-precipitation days (≥50 mm) per year` : "Flood risk is a top contributor",
        desc: "Heavy-precip days serve as a flash-flood proxy at this prototype stage; upgrades planned against JRC global flood maps.",
      };
    }
    if (k === "drought_risk") {
      const d = climate.longest_dry_run_days;
      return {
        title: d != null ? `Longest dry streak: ${d} consecutive days under 1 mm precip` : "Drought risk is a top contributor",
        desc: "Extended dry runs stress water supply and sanitation infrastructure, amplifying disease-transmission risk.",
      };
    }
    if (k === "child_density") {
      return {
        title: "High child-population catchment density",
        desc: "The child-population multiplier is at or near maximum for this country — disruption here cascades across many dependents.",
      };
    }
    if (k === "facility_fragility") {
      return {
        title: "Structural fragility elevated",
        desc: "OSM-derived fragility heuristic suggests this facility has limited backup power / water redundancy. v0.2 will swap this for WHO SARA audit data.",
      };
    }
    return { title: prettyKey(k), desc: "Contributes meaningfully to the composite risk score." };
  });
}

function renderDetail(feature) {
  const p = feature.properties;
  const s = p.risk_score;
  const b = band(s);
  const weights = currentData.metadata.scoring_weights || {};
  const comps = typeof p.risk_components === "string" ? JSON.parse(p.risk_components) : (p.risk_components || {});
  const climate = typeof p.climate === "string" ? JSON.parse(p.climate) : (p.climate || {});
  const air = typeof p.air === "string" ? JSON.parse(p.air) : (p.air || {});
  const recs = typeof p.recommendations === "string" ? JSON.parse(p.recommendations) : (p.recommendations || []);
  const tags = typeof p.tags === "string" ? JSON.parse(p.tags || "{}") : (p.tags || {});
  const coords = feature.geometry.coordinates;
  const stateName = getState(feature);
  const country = currentData?.metadata?.country || "";

  // Breakdown rows — sorted by contribution (points) descending so the
  // top rows visually correspond to the "Top drivers" list below.
  const breakdownData = Object.keys(weights).map(k => {
    const sub = comps[k] || 0;
    const max = 100 * (weights[k] || 0);
    const pts = max * sub;
    return { key: k, sub, max, pts };
  }).sort((a, b) => b.pts - a.pts);
  const breakdown = breakdownData.map(r => {
    const pct = Math.min(100, Math.max(0, r.sub * 100));
    return `<div class="break-row">
      <span class="n">${prettyKey(r.key)}</span>
      <span class="b"><i style="width:${pct.toFixed(0)}%"></i></span>
      <span class="p">${r.pts.toFixed(1)}&nbsp;/&nbsp;${r.max.toFixed(0)}</span>
    </div>`;
  }).join("");

  // Top drivers
  const drivers = computeDrivers(comps, weights, climate, air);
  const driversHtml = drivers.map((d, i) => `
    <div class="driver">
      <span class="idx">${String(i + 1).padStart(2, "0")}</span>
      <div><div class="t">${d.title}</div><div class="d">${d.desc}</div></div>
    </div>`).join("");

  // Raw inputs table
  const rawInputs = [
    ["Heat-index days (≥35°C app. T)", climate.heat_index_days != null ? `${climate.heat_index_days} / yr` : "—"],
    ["Heavy precip days (≥50 mm)", climate.heavy_precip_days != null ? `${climate.heavy_precip_days} / yr` : "—"],
    ["Longest dry run", climate.longest_dry_run_days != null ? `${climate.longest_dry_run_days} d` : "—"],
    ["PM2.5 · 30-day mean", air.pm25_avg_ugm3 != null ? `${air.pm25_avg_ugm3} µg/m³` : "—"],
    ["NO₂ · 30-day mean", air.no2_avg_ugm3 != null ? `${air.no2_avg_ugm3} µg/m³` : "—"],
    ["Hours PM2.5 > 15 µg/m³", air.pm25_exceed_hours_30d != null ? `${air.pm25_exceed_hours_30d} / 720` : "—"],
  ];
  const inputsHtml = rawInputs.map(([k, v]) => `
    <div class="break-row compact">
      <span class="n">${k}</span>
      <span class="p">${v}</span>
    </div>`).join("");

  // Recommendations
  const recHtml = recs.length ? recs.map((r, i) => `
    <div class="rec-card">
      <div class="top">
        <span class="pri">Priority ${String(i + 1).padStart(2, "0")}${r.category ? " · " + r.category : ""}</span>
        <span class="cost">$${r.estimated_cost_usd}</span>
      </div>
      <span class="t">${r.title}</span>
      <span class="d">${r.description}</span>
    </div>`).join("") : '<div style="color:var(--paper-mute);font-size:12px">No specific recommendations at this risk level.</div>';

  // Facility type + ID for kicker
  const ftype = (p.facility_type || "facility").charAt(0).toUpperCase() + (p.facility_type || "facility").slice(1);
  const osmId = p.id || "";

  // Coord formatting: N/S, E/W
  const latStr = `${Math.abs(coords[1]).toFixed(3)}° ${coords[1] >= 0 ? "N" : "S"}`;
  const lonStr = `${Math.abs(coords[0]).toFixed(3)}° ${coords[0] >= 0 ? "E" : "W"}`;

  // Rank within country — computed live from allFeatures.
  // Smart precision so a #1-of-10,927 facility doesn't misleadingly round
  // to "Top 0.0%".
  const total = allFeatures.length;
  const rank = allFeatures.filter(f => f.properties.risk_score > s).length + 1;
  const pct = total ? ((rank / total) * 100) : 0;
  let pctStr;
  if (pct < 0.1) pctStr = pct.toFixed(2);
  else if (pct < 1) pctStr = pct.toFixed(1);
  else pctStr = String(Math.round(pct));
  const rankLine = total > 0
    ? `Rank ${rank.toLocaleString()} of ${total.toLocaleString()} in ${country} — top ${pctStr}% by composite child-climate exposure.`
    : "";

  document.getElementById("detail").innerHTML = `
    <div class="head">
      <div class="kicker">
        <span class="ftype">${escapeHtml(ftype)}${osmId ? " · ID " + escapeHtml(String(osmId)) : ""}</span>
        <span class="coords">${latStr} · ${lonStr}</span>
      </div>
      <h2>${escapeHtml(displayName(feature))}</h2>
      <div class="loc">${stateName && stateName !== "Untagged Region" ? escapeHtml(stateName) + ", " : ""}${escapeHtml(country)}</div>
      <a class="detail-cross-link" href="${IS_3D ? "/" : "/3d"}?country=${encodeURIComponent(currentData?.metadata?.iso3 || "NGA")}&facility=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">
        ${IS_3D ? "Open in 2D dashboard" : "Open in 3D globe"} ↗
      </a>

      <div class="score-block ${b}">
        <div class="score-num">${s.toFixed(0)}</div>
        <div class="score-meta">
          <span class="score-band ${b}"><span class="ddot"></span>${bandLabel(s)}</span>
          ${rankLine ? `<span class="sub">${rankLine}</span>` : ""}
        </div>
      </div>

      <div class="gauge">
        <div class="track">
          <div class="fill" style="width:${Math.min(100, s).toFixed(1)}%"></div>
          <div class="marker" style="left:${Math.min(100, s).toFixed(1)}%"></div>
        </div>
        <div class="ticks"><span>0</span><span>30</span><span>55</span><span>75</span><span>100</span></div>
      </div>
    </div>

    <div class="detail-section">
      <h4>Score breakdown</h4>
      ${breakdown}
    </div>

    <div class="detail-section">
      <h4>Top drivers · plain English</h4>
      ${driversHtml}
    </div>

    <div class="detail-section">
      <h4>Raw inputs</h4>
      ${inputsHtml}
    </div>

    <div class="detail-section">
      <h4>Recommended actions · ranked</h4>
      ${recHtml}
    </div>
  `;

  // Open right panel
  document.body.classList.add("has-detail");
  document.querySelector(".detail-wrap")?.setAttribute("aria-hidden", "false");
  // Trigger map resize so MapLibre recalculates center/zoom for the narrower canvas
  setTimeout(() => map.resize(), 260);
}

// Close/hide the right panel
function closeDetail() {
  document.body.classList.remove("has-detail");
  document.querySelector(".detail-wrap")?.setAttribute("aria-hidden", "true");
  // Clear the selected-facility highlight ring
  highlightFacility(null);
  // Drop the ?facility= param so a shared URL after close doesn't reopen
  // a closed panel on reload.
  setFacilityUrlParam(null);
  // Update map size after CSS transition
  setTimeout(() => map.resize(), 260);
}

// ---- Shareable facility URLs ----
//
// `/3d/?country=NGA&facility=grid3-clinic-XYZ` (or `/?country=...&facility=...`
// for 2D) opens straight to that facility: detail panel rendered, camera
// flown to the dot, highlight ring set. Country is explicit because IDs
// don't always encode it. Any in-app facility selection updates the URL
// via history.replaceState so the URL bar always reflects what's on screen
// — share at any moment and the recipient lands on the same view.
function setFacilityUrlParam(id) {
  const url = new URL(window.location.href);
  if (id) {
    url.searchParams.set("country", currentData?.metadata?.iso3 || "NGA");
    url.searchParams.set("facility", id);
  } else {
    url.searchParams.delete("facility");
    // Keep country in URL for shareability of the country view.
  }
  history.replaceState(null, "", url.toString());
}

// Read ?facility= from the current URL after data is ready, find the
// matching feature in the loaded set, and open it. Returns true if a
// facility was successfully opened so the caller can skip default view
// reset behavior.
function openFacilityFromUrl() {
  const params = new URL(window.location.href).searchParams;
  const wantedId = params.get("facility");
  if (!wantedId) return false;
  // Search allFeatures (not just filtered) — the URL is authoritative,
  // filter chip state shouldn't hide a directly-linked facility.
  const f = allFeatures.find(ff => ff.properties.id === wantedId);
  if (!f) return false;
  // Small delay so the data + map are settled before the cinematic fly.
  setTimeout(() => {
    cinematicFlyTo({ center: f.geometry.coordinates, zoom: 13 });
    highlightFacility(f);
    renderDetail(f);
  }, 300);
  return true;
}

// ---- sidebar: top list (design: 6 rows, .crit-row grid) ----
function renderTopList() {
  // Prioritise named facilities, then by score
  const sorted = [...filteredFeatures].sort((a, b) => {
    const aName = a.properties.name || "";
    const bName = b.properties.name || "";
    const aUnnamed = !aName || aName.startsWith("Unnamed");
    const bUnnamed = !bName || bName.startsWith("Unnamed");
    if (aUnnamed !== bUnnamed) return aUnnamed ? 1 : -1;
    return b.properties.risk_score - a.properties.risk_score;
  }).slice(0, 6);

  // Update the kicker with country + count
  const kicker = document.getElementById("top-list-kicker");
  if (kicker) {
    const country = currentData?.metadata?.country || "";
    kicker.textContent = country ? `${country} · top ${sorted.length}` : `top ${sorted.length}`;
  }

  const host = document.getElementById("top-list");
  if (!sorted.length) { host.innerHTML = '<div style="color:var(--paper-soft);font-size:12px;padding:6px 0">No facilities match the current filters.</div>'; return; }

  const totalCount = filteredFeatures.length;
  const moreCount = Math.max(0, totalCount - sorted.length);

  host.innerHTML = `
    ${sorted.map(f => {
      const p = f.properties; const s = p.risk_score;
      return `<div class="crit-row" data-id="${escapeHtml(p.id)}">
        <span class="d" style="background:${bandColor(s)}"></span>
        <span class="n" title="${escapeHtml(displayName(f))}">${escapeHtml(displayName(f))}</span>
        <span class="s">${s.toFixed(0)}</span>
      </div>`;
    }).join("")}
    ${moreCount > 0 ? `
      <button type="button" class="view-all" id="btn-view-all">
        View all ${totalCount.toLocaleString()} facilities
        <span class="chev" aria-hidden="true">→</span>
      </button>
    ` : ""}
  `;

  host.querySelectorAll(".crit-row").forEach(el => {
    el.addEventListener("click", () => {
      const f = filteredFeatures.find(ff => ff.properties.id === el.dataset.id);
      if (!f) return;
      host.querySelectorAll(".crit-row").forEach(r => r.classList.remove("active"));
      el.classList.add("active");
      cinematicFlyTo({ center: f.geometry.coordinates, zoom: 13 });
      highlightFacility(f);
      renderDetail(f);
    });
  });

  const viewAllBtn = host.querySelector("#btn-view-all");
  if (viewAllBtn) viewAllBtn.addEventListener("click", openDataTable);
}

// ---- full-screen data table ----
let tableSortKey = "risk_score";
let tableSortAsc = false;
let tableSearchText = "";

// The overlay shell (header + empty table skeleton) is built once on open.
// Every subsequent search keystroke / sort click only rewrites the tbody
// and the subtitle — the <input> stays mounted, so the cursor and
// selection are preserved, and there's no flicker.
function openDataTable() {
  const overlay = document.createElement("div");
  overlay.id = "data-overlay";
  overlay.innerHTML = buildOverlayShell();
  document.body.appendChild(overlay);
  wireOverlayShellEvents(overlay);
  updateTableContents(overlay);
  // Focus the search input on open (safe — it's a fresh mount, not a re-render)
  overlay.querySelector("#table-search").focus();
}

function closeDataTable() {
  const el = document.getElementById("data-overlay");
  if (el) el.remove();
}

function buildOverlayShell() {
  const country = currentData?.metadata?.country || "";
  const state = activeFilters.state || "All Regions";
  return `
    <div class="overlay-backdrop"></div>
    <div class="overlay-panel">
      <div class="overlay-header">
        <div>
          <h2>All Facilities — ${escapeHtml(country)}${state !== "All Regions" ? " / " + escapeHtml(state) : ""}</h2>
          <p class="overlay-subtitle"></p>
        </div>
        <div class="overlay-controls">
          <input type="text" id="table-search" placeholder="Search table\u2026" autocomplete="off" />
          <button class="btn" id="btn-close-overlay">\u2715 Close</button>
        </div>
      </div>
      <div class="overlay-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th data-sort="risk_score" class="sortable">#</th>
              <th data-sort="name" class="sortable">Facility</th>
              <th data-sort="facility_type" class="sortable">Type</th>
              <th data-sort="risk_score" class="sortable">Score</th>
              <th>Top Driver</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `;
}

// Surgically update only the rows + subtitle + sort indicators.
// Does NOT touch the search input or the header — preserves cursor & focus.
const TABLE_MAX_ROWS = 1000;  // Cap DOM nodes so 50k-facility countries stay snappy.

function updateTableContents(overlay) {
  const features = getTableFeatures();
  // Cap the rendered rows — at full Nigeria scale (~50k facilities) dropping
  // all rows into the DOM causes 2-5s jank on every search keystroke. The
  // features are already sorted by the active key, so the truncated slice
  // is always "the most relevant N for the current sort direction."
  const truncated = features.length > TABLE_MAX_ROWS;
  const rendered = truncated ? features.slice(0, TABLE_MAX_ROWS) : features;

  // 1. Subtitle — "N facilities · Sorted by risk score ↓"
  const sub = overlay.querySelector(".overlay-subtitle");
  if (sub) {
    const dirArrow = tableSortAsc ? "\u2191" : "\u2193";
    const shownNote = truncated
      ? ` \u00b7 showing top ${TABLE_MAX_ROWS.toLocaleString()} of ${features.length.toLocaleString()}`
      : "";
    sub.textContent = `${features.length.toLocaleString()} facilities \u00b7 Sorted by ${tableSortKey.replace(/_/g, " ")} ${dirArrow}${shownNote}`;
  }

  // 2. Visible sort indicator on the column headers
  overlay.querySelectorAll("th.sortable").forEach(th => {
    th.classList.toggle("sorted", th.dataset.sort === tableSortKey);
    th.classList.toggle("asc", th.dataset.sort === tableSortKey && tableSortAsc);
  });

  // 3. Table body — the only big DOM mutation per update
  const tbody = overlay.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = rendered.map((f, i) => {
    const p = f.properties;
    const s = p.risk_score;
    const drivers = typeof p.top_drivers === "string" ? JSON.parse(p.top_drivers) : (p.top_drivers || []);
    const recs = typeof p.recommendations === "string" ? JSON.parse(p.recommendations) : (p.recommendations || []);
    return `<tr data-id="${escapeHtml(p.id)}">
      <td>${i + 1}</td>
      <td class="name-cell" title="${escapeHtml(displayName(f))}">${typeIcon(p.facility_type)} ${escapeHtml(displayName(f))}</td>
      <td>${escapeHtml(p.facility_type)}</td>
      <td><span class="table-badge ${band(s)}">${s.toFixed(0)}</span></td>
      <td>${escapeHtml((drivers[0] || "").replace(/_/g, " "))}</td>
      <td>${recs.length ? escapeHtml(recs[0].title) : "—"}</td>
    </tr>`;
  }).join("");

  // 4. Re-wire row click listeners (rows are freshly minted each update)
  tbody.querySelectorAll("tr[data-id]").forEach(tr => {
    tr.addEventListener("click", () => {
      const f = filteredFeatures.find(ff => ff.properties.id === tr.dataset.id);
      if (!f) return;
      closeDataTable();
      cinematicFlyTo({ center: f.geometry.coordinates, zoom: 13 });
      highlightFacility(f);
      renderDetail(f);
    });
  });
}

function getTableFeatures() {
  let feats = [...filteredFeatures];
  if (tableSearchText) {
    const s = tableSearchText.toLowerCase();
    feats = feats.filter(f => displayName(f).toLowerCase().includes(s) || f.properties.facility_type.includes(s));
  }
  feats.sort((a, b) => {
    let aVal, bVal;
    if (tableSortKey === "name") {
      aVal = displayName(a).toLowerCase();
      bVal = displayName(b).toLowerCase();
    } else if (tableSortKey === "facility_type") {
      aVal = a.properties.facility_type;
      bVal = b.properties.facility_type;
    } else {
      aVal = a.properties.risk_score;
      bVal = b.properties.risk_score;
    }
    if (aVal < bVal) return tableSortAsc ? -1 : 1;
    if (aVal > bVal) return tableSortAsc ? 1 : -1;
    return 0;
  });
  return feats;
}

// Wire events that belong to the SHELL — the permanent elements that stay
// mounted across updates (input, close button, backdrop, sort headers).
// These handlers are attached once on open, so cursor state isn't affected
// by updates.
function wireOverlayShellEvents(overlay) {
  overlay.querySelector("#btn-close-overlay").addEventListener("click", closeDataTable);
  overlay.querySelector(".overlay-backdrop").addEventListener("click", closeDataTable);

  const input = overlay.querySelector("#table-search");
  input.addEventListener("input", (e) => {
    tableSearchText = e.target.value;
    updateTableContents(overlay);  // only rewrites tbody; input stays focused
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDataTable();
  });

  overlay.querySelectorAll("th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (tableSortKey === key) tableSortAsc = !tableSortAsc;
      else { tableSortKey = key; tableSortAsc = key === "name"; }
      updateTableContents(overlay);  // tbody + subtitle + sort-indicator classes
    });
  });
}

// ---- export ----
function exportCSV() {
  if (!filteredFeatures.length) return;
  const weights = currentData.metadata.scoring_weights || {};
  const compKeys = Object.keys(weights);
  const header = ["name", "type", "lat", "lon", "risk_score", "risk_band", ...compKeys,
    "heat_days", "flood_days", "dry_streak", "pm25", "no2", "top_rec"];
  const rows = filteredFeatures.map(f => {
    const p = f.properties;
    const comps = typeof p.risk_components === "string" ? JSON.parse(p.risk_components) : (p.risk_components || {});
    const clim = typeof p.climate === "string" ? JSON.parse(p.climate) : (p.climate || {});
    const air = typeof p.air === "string" ? JSON.parse(p.air) : (p.air || {});
    const recs = typeof p.recommendations === "string" ? JSON.parse(p.recommendations) : (p.recommendations || []);
    return [
      `"${displayName(f)}"`, p.facility_type,
      f.geometry.coordinates[1], f.geometry.coordinates[0],
      p.risk_score, bandLabel(p.risk_score),
      ...compKeys.map(k => (comps[k] || 0).toFixed(3)),
      clim.heat_index_days || 0, clim.heavy_precip_days || 0, clim.longest_dry_run_days || 0,
      air.pm25_avg_ugm3 || 0, air.no2_avg_ugm3 || 0,
      `"${recs.length ? recs[0].title : 'None'}"`,
    ].join(",");
  });
  const csv = [header.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `childclimate-atlas-${currentData.metadata.iso3}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportGeoJSON() {
  const out = { type: "FeatureCollection", metadata: currentData.metadata, features: filteredFeatures };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `childclimate-atlas-${currentData.metadata.iso3}.geojson`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---- main switch ----
async function switchCountry(iso3) {
  const v = VIEWS[iso3] || VIEWS.NGA;
  const newName = COUNTRY_NAMES[iso3] || iso3;

  // Drop any cached spotlight queue + halt an active spotlight — the user's
  // country switch is the more recent intent and a resumed spotlight would
  // otherwise fly to facilities from the previous country.
  invalidateSpotlightQueue();
  // Reset data-ready flag for the new country; any pending click waits
  // for the new country's data instead of firing against a stale queue.
  dataReady = false;
  pendingSpotlightStart = false;
  showMapLoading();

  // --- 1. SYNCHRONOUS UI RESET (runs immediately, no await) --------------
  // Update every piece of text that references the country name NOW so the
  // UI isn't showing stale country info during the async fetch below.
  const chipText = document.getElementById("facility-chip-text");
  if (chipText) chipText.textContent = `${newName} · loading…`;

  const hudC = document.getElementById("hud-country");
  if (hudC) hudC.textContent = `${newName} · loading…`;

  const kicker = document.getElementById("top-list-kicker");
  if (kicker) kicker.textContent = `${newName} · loading`;

  // Reset state filter + dropdown label + panel contents immediately
  activeFilters.state = "";
  const stateBtn = document.getElementById("state-btn");
  if (stateBtn) stateBtn.textContent = "All states / regions";
  const statePanel = document.getElementById("state-panel");
  if (statePanel) { statePanel.innerHTML = ""; statePanel.classList.remove("open"); }

  // Reset search
  const searchInput = document.getElementById("search");
  if (searchInput) searchInput.value = "";
  activeFilters.search = "";
  closeSearchResults();

  // Clear current view stats + top list while data loads
  const statsEl = document.getElementById("stats");
  if (statsEl) statsEl.innerHTML = '<div class="stats-loading">Loading…</div>';
  const distEl = document.getElementById("dist");
  if (distEl) distEl.innerHTML = "";
  const topListEl = document.getElementById("top-list");
  if (topListEl) topListEl.innerHTML = '<div style="color:var(--paper-soft);font-size:12px;padding:6px 0">Loading facilities…</div>';

  // Hide facility drill-down panel
  document.body.classList.remove("has-detail");
  document.querySelector(".detail-wrap")?.setAttribute("aria-hidden", "true");

  // Start the map fly animation immediately. In 3D, ease out to a slightly
  // wider pitched view so country switching feels like swinging across the
  // globe rather than warping to a new flat patch.
  cinematicFlyTo({
    center: v.center,
    zoom: IS_3D ? Math.max(v.zoom - 1.5, 3) : v.zoom,
  });

  // --- 2. ASYNC DATA FETCH (with streaming progress) ---------------------
  const data = await loadAtlas(iso3, { showProgress: true });
  currentData = data;
  allFeatures = data.features || [];

  // --- 3. RE-RENDER with real data ---------------------------------------
  populateStates(allFeatures);
  updateSearchPlaceholder();
  applyFilters();

  // Data + map source are now populated. Flip the ready flag, hide the
  // loading overlay, and if a pre-load Spotlight click is pending, fire
  // it now (with a brief grace period so the freshly-rendered dots have
  // a beat to appear before the intro spin starts arcing across them).
  dataReady = true;
  hideMapLoading();
  // If the URL has ?facility=X, open it now that we know X is loadable.
  openFacilityFromUrl();
  if (pendingSpotlightStart) {
    pendingSpotlightStart = false;
    setTimeout(() => startSpotlight(), 500);
  }

  // --- 4. BACKGROUND PREFETCH (first load only) --------------------------
  // Warm the cache so switching to the other two countries is instant.
  prefetchOtherCountries(iso3);
}

// ---- event wiring ----
document.addEventListener("DOMContentLoaded", () => {
  wireViewToggle();

  // 3D floating-UI wiring. Button lives in the HTML of both pages so the
  // in-place toggle reaches it; we just wire its handler once here.
  const tourBtn = document.getElementById("btn-tour");
  if (tourBtn) tourBtn.addEventListener("click", () => {
    // Three-way: paused -> resume, running -> stop, idle -> start.
    if (tourActive && spotlightPaused) resumeSpotlight();
    else if (tourActive) stopSpotlight();
    else startSpotlight();
  });

  // User interaction with the map cancels the spotlight. We listen at the
  // raw map-event layer (mousedown / wheel / touchstart) rather than
  // "dragstart" because dragstart can be unreliable when our own
  // setBearing/easeTo is running — the user mousedown is the earliest,
  // most reliable signal of “they want to take over.” Filter out events
  // that originated on the spotlight popup so clicking inside the popup
  // doesn't cancel.
  function cancelOnUser(e) {
    if (tourActive) stopSpotlight();
  }
  map.on("mousedown", cancelOnUser);
  map.on("wheel", cancelOnUser);
  map.on("touchstart", cancelOnUser);

  document.getElementById("country").addEventListener("change", e => {
    switchCountry(e.target.value);
    // Also blur on change so the browser focus ring drops immediately,
    // before the async switchCountry's animation kicks in.
    e.target.blur();
  });
  // State dropdown toggle
  document.getElementById("state-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("state-panel").classList.toggle("open");
  });
  // Search: autocomplete dropdown + live map filter
  const searchInput = document.getElementById("search");
  searchInput.addEventListener("input", e => {
    const v = e.target.value;
    activeFilters.search = v;
    applyFilters();            // also filter the map dots
    renderSearchResults(v);    // and show a dropdown of matches
  });
  searchInput.addEventListener("focus", e => {
    // Re-show last results on re-focus if input still has text
    if (e.target.value) renderSearchResults(e.target.value);
  });
  searchInput.addEventListener("keydown", e => {
    const panel = document.getElementById("search-results");
    const open = panel?.classList.contains("open");
    if (e.key === "ArrowDown") { if (open) { e.preventDefault(); moveSearchHighlight(1); } }
    else if (e.key === "ArrowUp") { if (open) { e.preventDefault(); moveSearchHighlight(-1); } }
    else if (e.key === "Enter") {
      if (open && searchHighlightIdx >= 0) { e.preventDefault(); selectSearchResult(searchHighlightIdx); }
    }
    else if (e.key === "Escape") {
      if (open) { e.preventDefault(); e.stopPropagation(); closeSearchResults(); }
    }
  });
  // Click outside = close dropdown
  document.addEventListener("click", (e) => {
    const search = document.querySelector(".search");
    if (search && !search.contains(e.target)) closeSearchResults();
  });

  // type chips
  document.querySelectorAll(".chip[data-type]").forEach(el => {
    el.addEventListener("click", () => {
      const t = el.dataset.type;
      el.classList.toggle("active");
      if (activeFilters.types.has(t)) activeFilters.types.delete(t); else activeFilters.types.add(t);
      applyFilters();
    });
  });

  // band chips
  document.querySelectorAll(".chip[data-band]").forEach(el => {
    el.addEventListener("click", () => {
      const b = el.dataset.band;
      el.classList.toggle("active");
      if (activeFilters.bands.has(b)) activeFilters.bands.delete(b); else activeFilters.bands.add(b);
      applyFilters();
    });
  });

  // export buttons
  document.getElementById("btn-csv").addEventListener("click", exportCSV);
  document.getElementById("btn-geojson").addEventListener("click", exportGeoJSON);

  // detail-panel close button — also auto-resumes the spotlight if the user
  // had paused it by clicking into a popup. Same behavior if Escape is used
  // (the Escape handler below calls closeDetail directly).
  const closeBtn = document.getElementById("btn-close-detail");
  if (closeBtn) closeBtn.addEventListener("click", () => {
    closeDetail();
    if (tourActive && spotlightPaused) resumeSpotlight();
  });

  // "/" keyboard shortcut → focus search input
  document.addEventListener("keydown", (e) => {
    // Don't hijack when user is already typing in a field
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (e.key === "/" && !typing) {
      e.preventDefault();
      document.getElementById("search")?.focus();
    }
    if (e.key === "Escape") {
      // Close detail panel on Escape — also resume spotlight if paused.
      if (document.body.classList.contains("has-detail")) {
        closeDetail();
        if (tourActive && spotlightPaused) resumeSpotlight();
      }
    }
  });

  // About nav — placeholder anchor for now; will route to real /about page later
  const aboutNav = document.getElementById("nav-about");
  if (aboutNav) {
    aboutNav.addEventListener("click", (e) => {
      e.preventDefault();
      // Lightweight "coming soon" note for now
      alert("The About page is coming soon. For now, the project README (linked via the GitHub button) has the full methodology and data sources.");
    });
  }
});

// ---- heatmap layer toggle ----
let heatmapVisible = false;

function toggleHeatmap() {
  heatmapVisible = !heatmapVisible;
  const btn = document.getElementById("btn-heatmap");
  const hud = document.getElementById("hud-heatmap");
  if (heatmapVisible) {
    btn?.classList.add("active");
    if (hud) hud.textContent = "Heatmap · on";
    if (!map.getLayer("heatmap")) {
      map.addLayer({
        id: "heatmap", type: "heatmap", source: "facilities",
        maxzoom: 14,
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "risk_score"], 0, 0, 100, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 14, 2],
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(0,0,0,0)",
            0.2, "#6FA774",   // low
            0.4, "#D9B653",   // mod
            0.6, "#D9894F",   // high
            0.8, "#C35248",   // severe
            1,   "#A63D34"    // extreme deepening
          ],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 8, 14, 30],
          "heatmap-opacity": 0.75,
        },
      }, "facilities-glow");
    }
    map.setLayoutProperty("heatmap", "visibility", "visible");
  } else {
    btn?.classList.remove("active");
    if (hud) hud.textContent = "Heatmap · off";
    if (map.getLayer("heatmap")) map.setLayoutProperty("heatmap", "visibility", "none");
  }
}

// ---- print-friendly summary ----
function printSummary() {
  const m = currentData.metadata;
  const n = filteredFeatures.length;
  const scores = filteredFeatures.map(f => f.properties.risk_score);
  const avg = n ? (scores.reduce((a, b) => a + b, 0) / n).toFixed(1) : 0;
  const top10 = [...filteredFeatures].sort((a, b) => b.properties.risk_score - a.properties.risk_score).slice(0, 10);

  const win = window.open("", "_blank");
  win.document.write(`<!doctype html><html><head><title>ChildClimate Atlas Report — ${escapeHtml(m.country)}</title>
    <style>body{font-family:-apple-system,system-ui,sans-serif;max-width:820px;margin:40px auto;color:#1E2433;line-height:1.55}
    h1{font-size:22px;border-bottom:2px solid #C96A3F;padding-bottom:8px;letter-spacing:-0.01em}
    h2{font-size:15px;letter-spacing:0.04em;text-transform:uppercase;color:#6B7289;margin-top:24px}
    table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px}
    th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #EDEAE2}
    th{background:#FAF8F4;font-weight:600}
    .badge{display:inline-block;padding:2px 8px;border-radius:2px;font-weight:600;font-size:11px;letter-spacing:0.04em;text-transform:uppercase}
    .low{background:rgba(111,167,116,0.14);color:#3E7B49}
    .mid{background:rgba(217,182,83,0.18);color:#8A6F13}
    .high{background:rgba(217,137,79,0.18);color:#A24F1B}
    .severe{background:rgba(195,82,72,0.16);color:#8C2B24}
    .footer{margin-top:32px;font-size:11px;color:#9AA0B3;border-top:1px solid #EDEAE2;padding-top:12px}
    </style></head><body>
    <h1>ChildClimate Risk Atlas — ${escapeHtml(m.country)}</h1>
    <p><b>Region:</b> ${escapeHtml(m.focus_region)} | <b>Facilities analyzed:</b> ${n} | <b>Average risk:</b> ${avg}/100</p>
    <p><b>Generated:</b> ${new Date().toLocaleDateString()} | <b>Pipeline v${escapeHtml(m.pipeline_version || "0.1.0")}</b></p>

    <h2>Top 10 Most Critical Facilities</h2>
    <table>
      <tr><th>#</th><th>Facility</th><th>Type</th><th>Score</th><th>Top Driver</th><th>Priority Action</th></tr>
      ${top10.map((f, i) => {
        const p = f.properties;
        const recs = typeof p.recommendations === "string" ? JSON.parse(p.recommendations) : (p.recommendations || []);
        const drivers = typeof p.top_drivers === "string" ? JSON.parse(p.top_drivers) : (p.top_drivers || []);
        return `<tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(displayName(f))}</td>
          <td>${escapeHtml(p.facility_type)}</td>
          <td><span class="badge ${band(p.risk_score)}">${p.risk_score}</span></td>
          <td>${escapeHtml((drivers[0] || "").replace(/_/g, " "))}</td>
          <td>${recs.length ? escapeHtml(recs[0].title) : "—"}</td>
        </tr>`;
      }).join("")}
    </table>

    <h2>Scoring Weights</h2>
    <table>
      <tr><th>Component</th><th>Weight</th></tr>
      ${Object.entries(m.scoring_weights || {}).map(([k, v]) =>
        `<tr><td>${k.replace(/_/g, " ")}</td><td>${(v * 100).toFixed(0)}%</td></tr>`
      ).join("")}
    </table>

    <h2>Data Sources</h2>
    <ul>
      <li>Facilities: OpenStreetMap via Overpass API (ODbL)</li>
      <li>Climate: Open-Meteo / ERA5 reanalysis (CC-BY)</li>
      <li>Air quality: Copernicus CAMS (Open)</li>
      <li>Methodology: <a href="https://github.com/Trameter/childclimate-atlas">github.com/Trameter/childclimate-atlas</a></li>
    </ul>

    <div class="footer">
      <p>ChildClimate Risk Atlas v0.1.0 &middot; A Trameter Nigeria Ltd open-source project</p>
      <p>This report is auto-generated. Scores are based on satellite-derived indicators and should be validated with on-ground facility audits.</p>
    </div>
    </body></html>`);
  win.document.close();
  win.print();
}

// ---- wire new buttons ----
document.addEventListener("DOMContentLoaded", () => {
  const heatBtn = document.getElementById("btn-heatmap");
  if (heatBtn) heatBtn.addEventListener("click", toggleHeatmap);
  const printBtn = document.getElementById("btn-print");
  if (printBtn) printBtn.addEventListener("click", printSummary);
});

// Close state panel on outside click
document.addEventListener("click", (e) => {
  const wrap = document.getElementById("state-wrap");
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById("state-panel").classList.remove("open");
  }
});

// Load data immediately — don't wait for map tiles.
switchCountry("NGA");
