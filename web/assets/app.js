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
  KEN: { center: [37.9, 0.2], zoom: 5.8 },     // full Kenya
  PHL: { center: [122.5, 12.0], zoom: 5.2 },   // full Philippines archipelago
};

// Display name for each country so we can update the UI synchronously on
// country switch (before the async GeoJSON fetch completes).
const COUNTRY_NAMES = {
  NGA: "Nigeria",
  BGD: "Bangladesh",
  GTM: "Guatemala",
  KEN: "Kenya",
  PHL: "Philippines",
};

// Country aura tint — a soft, wide, blurred glow drawn under the dots on
// the globe, colored by the country's dominant climate hazard so the user
// can FEEL the difference between countries before reading a single number.
// Picked to harmonize with the design tokens (--ember, --mod) rather than
// invent new hues:
//   Nigeria (NGA)     — heat + dust + drought          → warm ember
//   Bangladesh (BGD)  — flood + monsoon humidity       → cool desaturated cyan
//   Guatemala (GTM)   — storms + landslides + mixed    → warm amber
//   Kenya (KEN)       — drought + arid lands           → dry savanna gold
//   Philippines (PHL) — typhoons + sea + monsoon       → ocean teal
// Subtle by design: opacity tapers to zero as the user zooms in, so the
// effect lives at globe-view altitudes and never competes with dots at the
// facility level.
const COUNTRY_AURA_COLORS = {
  NGA: "#D87B4F",  // ember — heat-dominant
  BGD: "#5FA5C7",  // cool cyan — flood-dominant
  GTM: "#D9A655",  // amber — storm-dominant
  KEN: "#C99548",  // dry savanna gold — drought-dominant
  PHL: "#4F9BA8",  // ocean teal — typhoon + monsoon dominant
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

// --- Multi-country mode (3D only) ---
// On /3d we load ALL three countries and show them simultaneously so the
// global pattern is visible at once. The ACTIVE country renders at full
// opacity; the other two dim to 30%. State + search filters only apply
// to the active country (other countries stay visible as context).
//
// On /2d we keep the single-country flow to avoid scattering dots across
// the world on a flat map (visually meaningless).
const ALL_ISOS = ["NGA", "BGD", "GTM", "KEN", "PHL"];
const countryDataByIso = {};   // iso -> raw geojson data
let allCountriesLoaded = false;

function tagFeaturesIso(features, iso) {
  for (const f of features) { f.properties._iso3 = iso; }
  return features;
}

// Promote nested climate.* and air.* values to top-level feature properties
// so MapLibre expressions (heatmap weight, paint case, etc.) can read them
// via ["get", "heat_index_days"] without needing nested-property access
// (which MapLibre doesn't support cleanly). Idempotent — running twice is
// fine. Handles both object and JSON-string forms of climate/air.
function flattenClimateAir(features) {
  for (const f of features) {
    const p = f.properties;
    const c = typeof p.climate === "string" ? (function(){ try { return JSON.parse(p.climate); } catch { return {}; } })() : (p.climate || {});
    const a = typeof p.air === "string" ? (function(){ try { return JSON.parse(p.air); } catch { return {}; } })() : (p.air || {});
    if (c.heat_index_days != null) p.heat_index_days = c.heat_index_days;
    if (c.heavy_precip_days != null) p.heavy_precip_days = c.heavy_precip_days;
    if (c.longest_dry_run_days != null) p.longest_dry_run_days = c.longest_dry_run_days;
    if (a.pm25_avg_ugm3 != null) p.pm25_avg_ugm3 = a.pm25_avg_ugm3;
  }
}

// Re-build allFeatures from every cached country (in 3D mode). Used after
// background country loads land so they get merged into the active view.
function mergeAllCountriesIntoAllFeatures() {
  // Collect each country's tagged features as separate arrays, then flatten
  // ONCE. The previous `combined.push(...features)` spread each country's
  // feature array as function ARGUMENTS — and Nigeria alone (~159k features)
  // blows past V8's argument-count limit, throwing "RangeError: Maximum call
  // stack size exceeded" the moment a large country got merged in 3D (the
  // 3D-only country-switch "stuck loading" bug). flat() iterates internally
  // with no such limit.
  const parts = [];
  for (const iso of ALL_ISOS) {
    const data = countryDataByIso[iso];
    if (!data) continue;
    parts.push(tagFeaturesIso(data.features || [], iso));
  }
  allFeatures = parts.flat();
}

// Paint expression for "1.0 for active, 0.3 for context" on a circle layer's
// opacity. Rebuilt + reapplied whenever the active country changes.
function buildActiveOpacityExpr(activeIso, baseOpacity) {
  return ["case",
    ["==", ["get", "_iso3"], activeIso], baseOpacity,
    baseOpacity * 0.30,
  ];
}
function applyActiveCountryOpacity(activeIso) {
  if (!IS_3D) return;
  // Reading the module-scoped `map`, NOT window.map — browsers auto-expose
  // <div id="map"> as window.map, which threw TypeError on .getLayer and
  // killed the rest of updateMap (including the click + hover handler
  // bindings further down). Layer ids fixed: "hovered-halo" not
  // "facilities-hovered".
  if (typeof map === "undefined" || !map.getLayer) return;
  const bases = {
    "facilities-glow":   0.50,
    "facilities":        1.00,
    "hovered-halo":      0.95,
    "selected-ring":     1.00,
  };
  for (const [layerId, base] of Object.entries(bases)) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, "circle-opacity", buildActiveOpacityExpr(activeIso, base));
  }
}

// ---- data loading ----
// In-memory cache + browser HTTP cache + background prefetch.
// Also: stream the response body so the user sees live progress instead of
// staring at a frozen "Loading…" label for Bangladesh's 20 MB file.
// Two-tier cache (v0.6.5):
//   liteCache holds map-render data (id/coords/score/type/state + the 4
//     heatmap numeric inputs) — fetched immediately on country switch.
//   dataCache holds the full per-facility detail (tags, risk_components,
//     recommendations, climate, air) — fetched lazily on first facility
//     click in each country, then cached for the rest of the session.
// Both share the same inflight Map keyed by `${iso3}::${variant}` so
// rapid double-switches don't double-fetch.
const dataCache = new Map();
const liteCache = new Map();
const inflight = new Map();

// Cache-bust query appended to every /data/*.geojson fetch. Bump this
// whenever the geojson SCHEMA changes (e.g. fields added/removed from
// metadata or properties) — separate from the asset bust on CSS/JS in
// the HTML so we don't have to re-deploy the JS bundle just because a
// nightly data refresh ran.
const DATA_VERSION = "1783060000";

// Ballpark uncompressed sizes (used only when the server sends a compressed
// Content-Length, which reports the COMPRESSED byte count and would make
// %-progress overshoot). These are approximate; off-by-10% is fine because
// the progress bar gets clamped to 100%.
const APPROX_UNCOMPRESSED_BYTES = {
  NGA: 11_000_000,
  BGD: 20_000_000,
  GTM:  2_700_000,
};
// Approx uncompressed sizes of the .lite.geojson files — much smaller
// because they drop the heavy nested properties (tags, recommendations,
// risk_components, full climate/air objects).
const APPROX_UNCOMPRESSED_LITE_BYTES = {
  NGA: 30_000_000,
  BGD:  3_500_000,
  GTM:  6_000_000,
  KEN:  8_000_000,
  PHL: 14_000_000,
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

async function loadAtlas(iso3, { showProgress = false, lite = false } = {}) {
  const cache = lite ? liteCache : dataCache;
  if (cache.has(iso3)) return cache.get(iso3);
  const key = `${iso3}::${lite ? "lite" : "full"}`;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      // Absolute path so the same module works from /3d/ (where ./ would
      // resolve to /3d/data/X.geojson and 404). The ?v= query forces a
      // cache-bust when the geojson schema changes (v0.7.1 added
      // scoring_weights to lite metadata — without busting, returning
      // visitors would still get the old lite from CloudFlare/disk cache
      // and the detail panel would render with empty Score Breakdown).
      const url = lite
        ? `/data/${iso3}.lite.geojson?v=${DATA_VERSION}`
        : `/data/${iso3}.geojson?v=${DATA_VERSION}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);

      // If the server is sending gzipped content, the Content-Length header
      // reports compressed size while the reader yields decompressed bytes.
      // Detect that case and use our approximate uncompressed size instead.
      const encoded = (r.headers.get("content-encoding") || "").toLowerCase();
      const clHeader = Number(r.headers.get("content-length")) || 0;
      const sizeMap = lite ? APPROX_UNCOMPRESSED_LITE_BYTES : APPROX_UNCOMPRESSED_BYTES;
      const total = (encoded && (encoded.includes("gzip") || encoded.includes("br") || encoded.includes("deflate")))
        ? (sizeMap[iso3] || 0)
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

      cache.set(iso3, data);
      return data;
    } catch {
      // Per-caller clone so each failed country mutates its OWN copy.
      // Returning the shared FALLBACK by reference let two failed countries
      // alias the same object; tagFeaturesIso then cross-contaminated _iso3
      // and the merge pushed the same sample features twice under the last
      // failing iso. Stamp iso3 so labels stay coherent. Not cached, so a
      // later switch retries.
      const fb = (typeof structuredClone === "function")
        ? structuredClone(FALLBACK)
        : JSON.parse(JSON.stringify(FALLBACK));
      if (fb.metadata) fb.metadata.iso3 = iso3;
      return fb;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

// Look up the full version of a feature for the detail panel. If the
// full data for this country is cached, return the matching feature.
// Otherwise kick off the full fetch and return null — caller renders
// a partial detail panel + sets up a re-render when full data lands.
function getFullFeature(iso3, facilityId) {
  const fullData = dataCache.get(iso3);
  if (!fullData) return null;
  return (fullData.features || []).find(f => f.properties && f.properties.id === facilityId) || null;
}

// Trigger the full-data fetch for a country (idempotent — no-op if
// already cached or in-flight). Used by both background prefetch and
// on-demand fetch when a detail panel needs full data that isn't loaded yet.
function ensureFullDataLoading(iso3) {
  return loadAtlas(iso3, { showProgress: false, lite: false });
}

// After the first country loads, kick off background prefetches of the
// other countries' LITE data so subsequent switches paint dots instantly.
// Full data only gets fetched on demand (first detail-panel click for a
// given country) to keep memory + bandwidth reasonable.
let prefetchedOthers = false;
function prefetchOtherCountries(currentIso3) {
  if (prefetchedOthers) return;
  prefetchedOthers = true;
  ALL_ISOS.forEach(iso3 => {
    if (iso3 === currentIso3 || liteCache.has(iso3)) return;
    // Silent background prefetch (lite only) — no UI progress updates.
    loadAtlas(iso3, { showProgress: false, lite: true }).catch(() => {});
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
    0,  0.70,  // signature bright halo at space zoom — the "wow" framing
    4,  0.60,  // still strong at globe-survey altitudes
    7,  0.45,  // halo STAYS visible at working country zoom (was the bug)
    10, 0.20,  // gentle rim at sub-country zoom
    14, 0,     // fade only once user is at street-level detail
  ],
};
_baseStyle.projection = { type: IS_3D ? "globe" : "mercator" };
const map = new maplibregl.Map({
  container: "map",
  style: _baseStyle,
  center: IS_3D ? [9.5, 5.0] : VIEWS.NGA.center,
  zoom: IS_3D ? 3.4 : VIEWS.NGA.zoom,
  pitch: IS_3D ? 45 : 0,
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
    pitch: isFacilityDive ? 65 : 45,
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
let _prevCountryCenter = null;     // [lng, lat] of the previously-loaded
                             // country, used to draw the great-circle arc
                             // on the next country switch.
let _countryTrailTimer = null;     // setTimeout handle for clearing the trail.
let _currentCountryIso = "NGA";    // tracked separately from activeFilters
                             // since the data load is async; updated at the
                             // very top of switchCountry so the aura repaint
                             // can use the new tint immediately.
let _selectedFacilityKey = null; // `${iso}::${id}` of the open detail panel;
                             // guards the deferred full-data re-render from
                             // clobbering a newer selection.
let _sunInterval = null;     // 3D sun-marker refresh timer handle (idempotent).
let _searchTimer = null;     // debounce handle for the live search filter.

// ---- Great-circle path helpers (country-trail arc on switchCountry) ----
//
// Given two [lng, lat] points on the globe, return N points along the
// great-circle (shortest path on a sphere) between them. We draw this as a
// LineString in MapLibre; when the map projection is globe, the line
// renders ON the sphere surface and follows the curvature naturally —
// it appears as a glowing arc sweeping from one country to the other.
function greatCirclePath(start, end, steps = 64) {
  const [lng1, lat1] = start;
  const [lng2, lat2] = end;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const lambda1 = lng1 * Math.PI / 180;
  const lambda2 = lng2 * Math.PI / 180;

  const d = Math.acos(
    Math.max(-1, Math.min(1,
      Math.sin(phi1) * Math.sin(phi2) +
      Math.cos(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1)
    ))
  );
  // Degenerate case: same point.
  if (d < 1e-9) return [start, end];

  const points = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(phi1) * Math.cos(lambda1) + B * Math.cos(phi2) * Math.cos(lambda2);
    const y = A * Math.cos(phi1) * Math.sin(lambda1) + B * Math.cos(phi2) * Math.sin(lambda2);
    const z = A * Math.sin(phi1) + B * Math.sin(phi2);
    const phi = Math.atan2(z, Math.sqrt(x * x + y * y));
    const lambda = Math.atan2(y, x);
    points.push([lambda * 180 / Math.PI, phi * 180 / Math.PI]);
  }
  return points;
}

// Compute the subsolar point (where the sun is directly overhead) for the
// current UTC time. Uses simplified astronomical formulas — accurate to
// ~0.5° which is plenty at globe scale. Returns [longitude, latitude].
function computeSubsolarPoint() {
  const now = new Date();
  const utcMs = now.getTime();
  const julianDay = utcMs / 86400000 + 2440587.5;
  const n = julianDay - 2451545.0;
  const L = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;
  const g = (((357.528 + 0.9856003 * n) % 360 + 360) % 360) * Math.PI / 180;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180;
  const epsilon = 23.439 * Math.PI / 180;
  const declination = Math.asin(Math.sin(epsilon) * Math.sin(lambda)) * 180 / Math.PI;
  const eqOfTimeMin = 4 * (L - 0.0057183 - Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda)) * 180 / Math.PI);
  const hourUtc = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  let lng = -((hourUtc - 12) * 15) - (eqOfTimeMin / 4);
  lng = ((lng + 540) % 360) - 180;
  return [lng, declination];
}

function addSunMarker() {
  if (map.getSource("sun-marker")) return;
  if (!map.isStyleLoaded()) {
    map.once("idle", addSunMarker);
    return;
  }
  map.addSource("sun-marker", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // Outer halo — soft and wide.
  map.addLayer({
    id: "sun-glow",
    type: "circle",
    source: "sun-marker",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 28, 3, 60, 6, 100],
      "circle-color": "#FFD27A",
      "circle-opacity": 0.30,
      "circle-blur": 1.0,
    },
  });
  // Inner core — bright.
  map.addLayer({
    id: "sun-core",
    type: "circle",
    source: "sun-marker",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 8, 3, 14, 6, 22],
      "circle-color": "#FFE9B0",
      "circle-opacity": 0.95,
      "circle-blur": 0.25,
    },
  });
  updateSunMarker();
  // Refresh once a minute — the sun moves ~0.25° of longitude per minute.
  // Stored + idempotent so re-entering 3D doesn't stack duplicate timers.
  if (_sunInterval === null) _sunInterval = setInterval(updateSunMarker, 60000);
}

function updateSunMarker() {
  // No-op in 2D — the sun marker is a 3D-only globe feature. Without this
  // the minute timer keeps doing pointless setData after a 3D→2D toggle.
  if (!IS_3D) return;
  const src = map.getSource("sun-marker");
  if (!src) return;
  const [lng, lat] = computeSubsolarPoint();
  src.setData({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: { kind: "sun" },
    }],
  });
}

// Set (or refresh) the country aura — a single Point feature at the country's
// center, tinted by the country's dominant climate hazard. The actual circle
// rendering (radius, blur, opacity-by-zoom) is configured once in updateMap;
// this helper just feeds the source new coordinates + color whenever the
// active country changes. 2D and uninitialized states are no-ops.
function setCountryAura(iso3) {
  if (!IS_3D) return;
  const src = map.getSource("country-aura");
  if (!src) return;
  const v = VIEWS[iso3] || VIEWS.NGA;
  const color = COUNTRY_AURA_COLORS[iso3] || COUNTRY_AURA_COLORS.NGA;
  src.setData({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: v.center },
      properties: { color },
    }],
  });
}

// Spherical (great-circle) angular distance between two [lng, lat] points
// in radians. Used to measure how far the camera has travelled along the
// from→to arc so the line's head can be planted under it each frame.
function sphericalDistance(a, b) {
  const phi1 = a[1] * Math.PI / 180;
  const phi2 = b[1] * Math.PI / 180;
  const lambda1 = a[0] * Math.PI / 180;
  const lambda2 = b[0] * Math.PI / 180;
  return Math.acos(
    Math.max(-1, Math.min(1,
      Math.sin(phi1) * Math.sin(phi2) +
      Math.cos(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1)
    ))
  );
}

// Draw the arc as a glowing LineString from `from` to `to` on the globe,
// drawn INSTANTLY end-to-end and held for `holdMs` before clearing. We
// tried a camera-following version (commit 262d939) where the line head
// tracked map.getCenter() via move events — looked great in theory, but
// in practice the heavy 50K-dot setData when switching FROM Nigeria
// stalled the main thread and starved the move handler, so the line
// froze mid-flight and snapped at the end. Instant draw is guaranteed
// smooth because there's no animation to interrupt.
//
// Only meaningful in 3D — in 2D the arc would be a flat chord across a
// flat map. A new country switch cancels any pending clear timer.
function showCountryTrail(from, to, holdMs = 12000) {
  if (!IS_3D) return;
  const src = map.getSource("country-trail");
  if (!src) return;
  src.setData({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: greatCirclePath(from, to) },
      properties: {},
    }],
  });
  if (_countryTrailTimer !== null) clearTimeout(_countryTrailTimer);
  _countryTrailTimer = setTimeout(() => {
    map.getSource("country-trail")?.setData({ type: "FeatureCollection", features: [] });
    _countryTrailTimer = null;
  }, holdMs);
}

// ---- Loading overlay (centered "Loading the globe…" badge on the map) ----
function showMapLoading() {
  document.getElementById("map-loading")?.classList.remove("hidden");
}
function hideMapLoading() {
  document.getElementById("map-loading")?.classList.add("hidden");
}

// Hide the loading overlay only once the map has actually committed the
// facility source to a render frame — not at the moment dataReady flips.
// Previously we hid the overlay immediately after applyFilters, but the
// MapLibre render pipeline has 1–2 async frames between setData() and
// pixels-on-screen, so the user briefly saw an empty map between the
// overlay disappearing and the dots painting.
//
// 'idle' fires when all loading + rendering is settled. Fallback timeout
// guards against a stuck overlay if for some reason idle never fires
// (e.g., an animation is started before the map settles).
function hideMapLoadingWhenRendered() {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    hideMapLoading();
  };
  map.once("idle", finish);
  setTimeout(finish, 4000);
}

function buildSpotlightQueue() {
  // Pull from the CURRENT filtered set so the spotlight always reflects
  // whatever the user is looking at (country switch, state filter, etc.).
  if (!filteredFeatures || filteredFeatures.length === 0) return [];

  // Spotlight respects the active country. If the user picked Nigeria on
  // the left, the tour stays in Nigeria — bouncing to Bangladesh would
  // ignore that choice. Filter filteredFeatures to active-country only
  // before picking the top-N.
  const scoped = IS_3D
    ? filteredFeatures.filter(f => !f.properties._iso3 || f.properties._iso3 === _currentCountryIso)
    : filteredFeatures;
  const sorted = [...scoped].sort(
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

// Switch the active country WITHOUT reloading data or kicking off the
// full switchCountry pipeline. Used during the spotlight when the next
// stop belongs to a different country than the currently-active one —
// just want the aura tint + opacity emphasis + meta line to follow.
function setActiveCountryQuietly(iso3) {
  if (!iso3 || iso3 === _currentCountryIso) return;
  _currentCountryIso = iso3;
  // Sync the country dropdown so the UI reflects the change.
  const sel = document.getElementById("country");
  if (sel && sel.value !== iso3) sel.value = iso3;
  // Sync the chip text + HUD line.
  const newName = COUNTRY_NAMES[iso3] || iso3;
  const chipText = document.getElementById("facility-chip-text");
  if (chipText) chipText.textContent = `${newName} · ${(countryDataByIso[iso3]?.features?.length || 0).toLocaleString()} facilities`;
  const hudC = document.getElementById("hud-country");
  if (hudC) hudC.textContent = `${newName} · ${(countryDataByIso[iso3]?.features?.length || 0).toLocaleString()} facilities`;
  // Aura + opacity emphasis follow the new active country.
  setCountryAura(iso3);
  applyActiveCountryOpacity(iso3);
  setUrlParam("country", iso3);
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
      pitch: 45,
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
      pitch: 45,
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

  // STEP 6 — swap hero-pane copy + page title for the new mode. Without
  // this, the eyebrow / h1 / blurb stay frozen at whichever HTML file
  // loaded first (the SPA toggle hops projections + URL but doesn't
  // re-render the server-rendered hero block). Symptom: load /3d, click
  // 2D — toggle button flips active but the "Spin the globe" hero still
  // shows, and vice versa.
  applyHeroForMode(want3D);
}

// Source of truth for the hero pane content per mode. Mirrors what's
// server-rendered in the two HTML files so a first paint from /index.html
// or /3d/index.html still shows the right thing, and applyHeroForMode()
// swaps to the other set on toggle. Keep these strings in sync with the
// HTML files — both should match on first paint.
const HERO_CONTENT = {
  mode2d: {
    title: "ChildClimate Risk Atlas — Trameter",
    eyebrow: "Trameter · Nigeria · MIT",
    h1: 'Which clinic should we <em>harden first?</em>',
    p: "A 0–100 climate-risk score for every school and clinic in a country. Built on open data, published under MIT, auditable to source.",
  },
  mode3d: {
    title: "ChildClimate Atlas — Immersive 3D · Trameter",
    eyebrow: "Trameter · Immersive view · MIT",
    h1: 'Spin the globe. <em>See the risk.</em>',
    p: "Every school and clinic, scored 0–100 for climate risk, on a 3D globe. Click any dot to dive in. Same data, different way to feel it.",
  },
};

function applyHeroForMode(want3D) {
  const c = want3D ? HERO_CONTENT.mode3d : HERO_CONTENT.mode2d;
  const hero = document.querySelector(".hero-pane");
  if (!hero) return;
  const eyebrowMono = hero.querySelector(".eyebrow .mono");
  if (eyebrowMono) eyebrowMono.textContent = c.eyebrow;
  const h1 = hero.querySelector("h1");
  if (h1) h1.innerHTML = c.h1;
  const p = hero.querySelector("p");
  if (p) p.textContent = c.p;
  document.title = c.title;
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
let pulseEnabled = true;          // default ON; user can toggle via HUD chip
let _pulseMoveHooked = false;     // movestart/moveend pause hooks added once

// Public toggle — flips pulseEnabled, adds or removes the layer + animation
// and updates the HUD button's text. Plain text 'ON' / 'OFF' inside the chip;
// no color or background change, just the word flips.
function togglePulseLayer() {
  pulseEnabled = !pulseEnabled;
  if (pulseEnabled) {
    setupPulseLayer();
  } else {
    teardownPulseLayer();
  }
  const btn = document.getElementById("hud-pulse-toggle");
  if (btn) btn.textContent = pulseEnabled ? "ON" : "OFF";
}

function setupPulseLayer() {
  if (!pulseEnabled) return;                       // user has turned it off
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
  // Pause the pulse while the camera is moving (country fly-to, user pan/zoom)
  // so its per-frame full repaints don't compete with the movement — the main
  // cause of country-switch lag. Resume once motion settles. Registered once
  // for the map's lifetime.
  if (!_pulseMoveHooked) {
    _pulseMoveHooked = true;
    map.on("movestart", stopPulseAnimation);
    map.on("moveend", () => {
      if (pulseEnabled && map.getLayer(PULSE_LAYER_ID)) startPulseAnimation();
    });
  }
}

function teardownPulseLayer() {
  stopPulseAnimation();
  if (map.getLayer(PULSE_LAYER_ID)) map.removeLayer(PULSE_LAYER_ID);
}

function startPulseAnimation() {
  if (pulseRafId !== null) return;
  const t0 = performance.now();
  let lastDraw = 0;
  function frame() {
    if (!map.getLayer(PULSE_LAYER_ID)) { pulseRafId = null; return; }
    const now = performance.now();
    // Throttle paint updates to ~20fps. Each setPaintProperty forces a FULL
    // map repaint — re-culling/positioning the whole multi-country scene (up
    // to 311k features on the 3D globe). At 60fps that pinned the main thread
    // and made country switches janky; a 2.4s breath reads identically at
    // 20fps. (The pulse also pauses entirely during camera movement — see the
    // movestart/moveend hooks in setupPulseLayer.)
    if (now - lastDraw >= 50) {
      lastDraw = now;
      const t = (now - t0) / 1000;
      const phase = (Math.sin((t / PULSE_PERIOD_SEC) * Math.PI * 2) + 1) / 2; // 0..1
      // Opacity fades out as the ring expands — the classic “radar ping” feel.
      map.setPaintProperty(PULSE_LAYER_ID, "circle-stroke-opacity", 0.85 * (1 - phase * 0.9));
      map.setPaintProperty(PULSE_LAYER_ID, "circle-stroke-width", 1.2 + phase * 5.5);
    }
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
      // Only intercept the 2D/3D in-place toggle. Other targets in the
      // toggle group (e.g. /vr) are separate pages — let the browser do
      // a normal navigation instead of hijacking the click.
      if (href !== "/" && href !== "/3d") return;
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

const _stateNameCache = new Map();
function normalizeStateName(raw, iso3) {
  if (!raw || raw === "Untagged Region") return "Untagged Region";
  // Memoize: getState calls this once PER FEATURE, so a country switch ran it
  // across the whole feature set. There are only dozens of distinct
  // (iso3, raw) state strings, so caching collapses 10^5 calls to a handful
  // of real regex runs.
  const key = iso3 + "|" + raw;
  const hit = _stateNameCache.get(key);
  if (hit !== undefined) return hit;
  const fixes = STATE_FIXES[iso3] || {};
  let result;
  if (fixes[raw]) {
    result = fixes[raw];
  } else {
    // Title case: "adamawa" -> "Adamawa", "yobe" -> "Yobe"
    result = raw.replace(/\b\w/g, c => c.toUpperCase())
                .replace(/\bState\b/i, "").trim(); // remove trailing "State"
  }
  _stateNameCache.set(key, result);
  return result;
}

function getState(feature) {
  // v0.6.5 two-tier data: lite features carry a flat state_name string
  // (pre-extracted at build time); full features carry the original tags
  // object with admin1 / addr:state inside. Prefer the lite field — when
  // both are present they should agree because lite was extracted from
  // the same tags object. Fallback chain handles every loaded state.
  const iso3 = currentData?.metadata?.iso3 || "";
  const liteState = feature.properties.state_name;
  if (liteState) return normalizeStateName(liteState, iso3);

  const tags = feature.properties.tags;
  if (!tags) return "Untagged Region";
  const parsed = typeof tags === "string" ? JSON.parse(tags) : tags;
  // Prefer admin1 (from reverse geocoding) over addr:state (from OSM)
  const raw = parsed["admin1"] || parsed["addr:state"];
  if (!raw) return "Untagged Region";
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
  allOpt.setAttribute("role", "option");
  allOpt.setAttribute("aria-selected", "true");
  allOpt.innerHTML = 'All states / regions';
  panel.appendChild(allOpt);

  states.forEach(([s, c]) => {
    const opt = document.createElement("div");
    opt.className = "state-opt";
    opt.dataset.value = s;
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", "false");
    opt.innerHTML = `<span>${escapeHtml(s)}</span><span class="cnt">${c}</span>`;
    panel.appendChild(opt);
  });

  // Wire clicks on each option
  panel.querySelectorAll(".state-opt").forEach(opt => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const val = opt.dataset.value;
      activeFilters.state = val;
      const sBtn = document.getElementById("state-btn");
      sBtn.textContent = val || "All states / regions";
      sBtn.setAttribute("aria-expanded", "false");
      panel.querySelectorAll(".state-opt").forEach(o => {
        o.classList.remove("sel");
        o.setAttribute("aria-selected", "false");
      });
      opt.classList.add("sel");
      opt.setAttribute("aria-selected", "true");
      panel.classList.remove("open");
      // URL mirrors state filter so a Bangladesh-state-of-Dhaka share link
      // lands the recipient on the same filtered view. Empty val clears.
      setUrlParam("state", val);
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
    input?.removeAttribute("aria-activedescendant");
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
    return `<div class="search-result${i === 0 ? " hl" : ""}" id="sr-opt-${i}" role="option" aria-selected="${i === 0 ? "true" : "false"}" data-id="${escapeHtml(p.id)}" data-idx="${i}">
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
  // Point the combobox input at the active option so screen readers announce
  // arrow-key navigation (WAI-ARIA combobox pattern).
  input?.setAttribute("aria-activedescendant", results.length ? "sr-opt-0" : "");

  panel.querySelectorAll(".search-result").forEach(el => {
    el.addEventListener("click", () => selectSearchResult(parseInt(el.dataset.idx, 10)));
    el.addEventListener("mouseenter", () => {
      const idx = parseInt(el.dataset.idx, 10);
      panel.querySelectorAll(".search-result").forEach(r => {
        r.classList.remove("hl");
        r.setAttribute("aria-selected", "false");
      });
      el.classList.add("hl");
      el.setAttribute("aria-selected", "true");
      searchHighlightIdx = idx;
      input?.setAttribute("aria-activedescendant", "sr-opt-" + idx);
    });
  });
}

function closeSearchResults() {
  const panel = document.getElementById("search-results");
  const input = document.getElementById("search");
  if (panel) { panel.classList.remove("open"); panel.innerHTML = ""; }
  input?.setAttribute("aria-expanded", "false");
  input?.removeAttribute("aria-activedescendant");
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
    const on = i === searchHighlightIdx;
    el.classList.toggle("hl", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
    if (on) el.scrollIntoView({ block: "nearest" });
  });
  document.getElementById("search")?.setAttribute("aria-activedescendant", "sr-opt-" + searchHighlightIdx);
}

// ---- filtering ----
function applyFilters() {
  const s = activeFilters.search.toLowerCase();
  filteredFeatures = allFeatures.filter(f => {
    const p = f.properties;
    if (!activeFilters.types.has(p.facility_type)) return false;
    if (!activeFilters.bands.has(band(p.risk_score))) return false;
    // State + search filters only apply to the ACTIVE country in 3D
    // multi-country mode. Other countries stay visible as dimmed context
    // so the global pattern is preserved. In 2D mode everything is the
    // active country (we only load one) so these always apply.
    const isActive = !IS_3D || p._iso3 === _currentCountryIso || !p._iso3;
    if (isActive) {
      if (activeFilters.state && getState(f) !== activeFilters.state) return false;
      const dname = displayName(f).toLowerCase();
      if (s && !dname.includes(s)) return false;
    }
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
// Fingerprint of the last filteredFeatures array passed to setData. Used
// to skip the expensive MapLibre re-index when country-switching between
// already-loaded countries (same data, different country tint). See
// updateMap() for the sig format.
let _lastSetDataSig = null;

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
  if (src) {
    // v0.6.6: skip setData when the underlying features haven't actually
    // changed — country-switch between two already-loaded countries was
    // calling setData with the same 311K features and triggering MapLibre's
    // tile re-index (5-30s on the active country switch in 3D), even though
    // only the country tint was different. Tint update is a paint-property
    // change that's nearly free; setData is the expensive part.
    //
    // Signature uses first+last facility id + total count — cheap to
    // compute and uniquely fingerprints a stable filteredFeatures array
    // for our purposes (filter changes always change count or end-of-array
    // ordering; country prefetch landing changes count).
    const n = filteredFeatures.length;
    const sig = n === 0
      ? "empty"
      : `${n}::${filteredFeatures[0].properties.id}::${filteredFeatures[n - 1].properties.id}`;
    if (sig !== _lastSetDataSig) {
      _lastSetDataSig = sig;
      src.setData(geojson);
    }
    // Re-tint the aura on country switch even though we early-return before
    // re-adding any layers — the aura source already exists, only its color
    // + center need updating. ALWAYS runs regardless of setData skip
    // because country tint is what makes the switch visually obvious.
    setCountryAura(_currentCountryIso);
    // Multi-country: keep paint opacity in sync with the active country.
    applyActiveCountryOpacity(_currentCountryIso);
    return;
  }

  // Risk-band colour stops shared by all three layers (glow, dot, selection ring)
  const RISK_STOPS = ["step", ["get", "risk_score"],
    "#6FA774",  // low
    30, "#D9B653",  // moderate
    55, "#D9894F",  // high
    75, "#C35248"]; // severe

  map.addSource("facilities", { type: "geojson", data: geojson });
  // Note on opacity below: each layer paints with a static base value, but
  // immediately after addLayer we call applyActiveCountryOpacity() which
  // replaces it with a case-expression so non-active countries dim to 30%
  // in 3D mode. In 2D mode allActiveCountryOpacity is a no-op and the
  // base values stick.
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
  // Selected facility highlight — band-colored ring at a slightly larger
  // radius than the dot, so the outer edge reads as a halo against the
  // dark map. The earlier paper-white experiment was too loud against
  // the design system; the band-color halo is the original, intended look.
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

  // Country-aura — a wide blurred glow under the dots, colored by the
  // country's dominant climate hazard (see COUNTRY_AURA_COLORS). Lives below
  // facilities-glow so the dots always overlay it. Opacity tapers to zero
  // as the user zooms in — this is a globe-altitude storytelling cue, not a
  // facility-level decoration. Source starts empty; populated by
  // setCountryAura on initial load + each country switch.
  map.addSource("country-aura", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "country-aura-glow",
    type: "circle",
    source: "country-aura",
    paint: {
      // Radius grows aggressively with zoom so the aura keeps roughly the
      // same on-screen footprint over the country regardless of altitude.
      "circle-radius": [
        "interpolate", ["linear"], ["zoom"],
        2, 100,
        4, 180,
        5, 260,
        7, 380,
        9, 600,
      ],
      "circle-color": ["get", "color"],
      // Visible at globe altitudes, fades out by the time the user zooms
      // into facility-level detail.
      "circle-opacity": [
        "interpolate", ["linear"], ["zoom"],
        2, 0.20,
        4, 0.22,
        5, 0.18,
        7, 0.10,
        9, 0.04,
        11, 0,
      ],
      "circle-blur": 1.1,
    },
  }, "facilities-glow");
  // Initial population for the very first load — subsequent country switches
  // hit the updateMap early-return branch which calls setCountryAura there.
  setCountryAura(_currentCountryIso);
  // Multi-country mode: apply active-country opacity case expressions now
  // that the layers exist (no-op in 2D).
  applyActiveCountryOpacity(_currentCountryIso);

  // Sun marker — a golden glow at the subsolar point (where the sun is
  // currently directly overhead). Visible only in 3D; on a Mercator map
  // it has no useful spatial meaning. Refreshes every minute as Earth
  // rotates. Adds a subtle 'time is real, climate is real, this is now'
  // beat without competing with the data layers.
  if (IS_3D) addSunMarker();

  // Country-trail — a glowing great-circle line on the globe drawn between
  // the previous country's center and the new country's center whenever
  // the user switches countries in 3D. Renders as a wide blurred ember
  // glow underneath a thinner brighter line, same two-layer pattern as
  // facilities-glow + facilities. Source stays empty until showCountryTrail
  // populates it; cleared after the camera arrives.
  map.addSource("country-trail", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "country-trail-glow",
    type: "line",
    source: "country-trail",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#D87B4F",  // var(--ember)
      "line-width": 10,
      "line-blur": 6,
      "line-opacity": 0.45,
    },
  });
  map.addLayer({
    id: "country-trail-line",
    type: "line",
    source: "country-trail",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#FAF8F4",  // var(--paper) — bright crisp core
      "line-width": 2,
      "line-opacity": 0.95,
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
  // In multi-country (3D) mode filteredFeatures includes all loaded
  // countries; the sidebar stats + HUD chip should reflect only the
  // ACTIVE country since that's what the user is "looking at." 2D mode
  // only has one country in allFeatures so the filter is a no-op.
  const activeFiltered = IS_3D
    ? filteredFeatures.filter(f => !f.properties._iso3 || f.properties._iso3 === _currentCountryIso)
    : filteredFeatures;
  const n = activeFiltered.length;
  const scores = activeFiltered.map(f => f.properties.risk_score);
  const avg = n ? Math.round(scores.reduce((a, b) => a + b, 0) / n) : 0;
  const severe = scores.filter(s => s >= 75).length;
  const high = scores.filter(s => s >= 55 && s < 75).length;
  const mid = scores.filter(s => s >= 30 && s < 55).length;
  const low = scores.filter(s => s < 30).length;
  const schools = activeFiltered.filter(f => f.properties.facility_type === "school").length;
  const clinics = activeFiltered.filter(f => f.properties.facility_type === "clinic").length;
  const hospitals = activeFiltered.filter(f => f.properties.facility_type === "hospital").length;

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
  // Don't gate on isStyleLoaded — setData on a known source is safe even
  // during transient style states. The previous gating sometimes bailed
  // during cinematic flyTo and the ring never set, so a URL-opened
  // facility would have the detail panel but no ring on the map.
  if (!map.getSource("selected")) {
    // Source not yet added (first frames before updateMap runs). Retry
    // once the map settles so a fast URL-driven open doesn't drop the
    // highlight request.
    if (feature) map.once("idle", () => highlightFacility(feature));
    return;
  }
  // Reflect the selection in the URL so the current view is shareable.
  // Null/clear is handled separately by closeDetail() so we don't strip
  // the param every time the selection is just being moved.
  if (feature) setUrlParam("facility", feature.properties.id);
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

// Map each driver (sub-score key) to the recommendation category that
// addresses it. Used by reorderRecsByDrivers so the Recommended-actions
// list visually mirrors the Top-drivers list whenever possible. Drivers
// without an entry here (child_density) have no facility-level fix —
// the panel copy explains this.
const DRIVER_TO_REC_CATEGORY = {
  heat_exposure:      "Heat Resilience",
  air_pollution:      "Air Quality",
  flood_risk:         "Flood Resilience",
  drought_risk:       "Water Security",
  facility_fragility: "Facility Strengthening",
  // child_density: intentionally absent — no facility-level fix.
};

// Reorder recs so they line up with the driver priority shown above.
// Recs whose category matches the top driver come first; recs without
// a driver match keep their original rule-priority order at the tail.
function reorderRecsByDrivers(recs, drivers) {
  const driverCats = drivers
    .map(d => DRIVER_TO_REC_CATEGORY[d.key])
    .filter(Boolean);
  const idxOf = (cat) => {
    const i = driverCats.indexOf(cat);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  // Stable sort: Array.prototype.sort is stable per spec, so ties preserve
  // the original rule-priority order from the pipeline.
  return [...recs].sort((a, b) => idxOf(a.category) - idxOf(b.category));
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

// Tracks the active MicroScene instance so we can dispose it on re-render
// or panel close. Without this, every facility click leaks a WebGL context
// and we'd hit the 16-context browser cap after ~16 facility opens.
let _activeMicroScene = null;

// Single MapLibre instance reused across facility opens for the detail
// panel's neighbourhood mini-map. Created lazily on first detail open;
// subsequent opens just flyTo() the new facility's coordinates and
// re-position the marker. Disposed when the detail panel closes via
// disposeDetailMinimap() so the WebGL context is released.
let _detailMinimap = null;
let _detailMinimapMarker = null;

// Inject (or refresh) a static ESRI satellite-export image that sits
// behind the MapLibre canvas as an instant placeholder. Single HTTP
// request, ~500ms even on cold cache — so the user sees the actual
// location within one round-trip instead of staring at a grey rectangle
// while WMS tiles + map style + first paint warm up. The placeholder
// is faded out once MapLibre reaches 'idle' (its own tiles are ready).
// If MapLibre never reaches idle (CDN/CSP/network flake), the placeholder
// stays visible — so the worst case is now 'static image, no zoom controls'
// rather than 'nothing rendered at all'.
function ensureMinimapPlaceholder(lng, lat) {
  const wrap = document.querySelector(".detail-minimap-wrap");
  if (!wrap) return;
  const PAD = 0.0015;
  const w = lng - PAD, e = lng + PAD, s = lat - PAD, n = lat + PAD;
  const url = `https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${w},${s},${e},${n}&size=480,440&format=jpg&bboxSR=4326&imageSR=3857&f=image`;
  let img = wrap.querySelector(".detail-minimap-placeholder");
  if (!img) {
    img = document.createElement("img");
    img.className = "detail-minimap-placeholder";
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    // Prepend so it renders behind the MapLibre canvas (canvas is later
    // in DOM order and gets z-index:1 via .detail-minimap CSS).
    wrap.insertBefore(img, wrap.firstChild);
  }
  // Reset the fade state from any previous open, then point at the new
  // facility's bbox. The browser swaps the displayed image when the new
  // src finishes downloading; until then the previous image stays put,
  // which avoids a flash of empty grey between facility opens.
  img.classList.remove("faded");
  img.src = url;
}

function fadeMinimapPlaceholder() {
  const img = document.querySelector(".detail-minimap-placeholder");
  if (img) img.classList.add("faded");
}

// Only fade the placeholder once MapLibre has (a) been sized to a real
// viewport AND (b) loaded tiles for that viewport. The first 'idle' event
// often fires within milliseconds of map creation while the container is
// still 0×0 (the detail panel is still sliding in, our 320/720ms resize
// passes haven't run yet). At 0×0 there are no tiles to load, so 'idle'
// trivially fires — and if we faded on that we'd reveal an empty dark
// canvas with no tiles in it, which is exactly the "light comes on then
// dims back to dark" bug.
function maybeFadeMinimapPlaceholder() {
  if (!_detailMinimap) return;
  const canvas = _detailMinimap.getCanvas();
  if (!canvas || canvas.width < 100 || canvas.height < 100) return;
  if (!_detailMinimap.areTilesLoaded || !_detailMinimap.areTilesLoaded()) return;
  fadeMinimapPlaceholder();
}

function setupDetailMinimap(feature) {
  const container = document.getElementById("detail-minimap");
  if (!container) return;
  const [lng, lat] = feature.geometry.coordinates;
  const link = document.getElementById("detail-map-link");
  if (link) link.href = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

  // renderDetail rewrites #detail's innerHTML on every facility click,
  // which destroys the old .detail-minimap-wrap (including the old
  // #detail-minimap div). If our cached _detailMinimap is still bound to
  // that detached node, its flyTo() runs against a ghost — the new live
  // #detail-minimap div in the DOM stays empty, and worse, the old map's
  // eventual 'idle' fires and fades the new placeholder. Net symptom:
  // "the light comes on then dims back to dark" on every reopen. Tear
  // down the stale instance so the create-fresh branch below kicks in.
  if (_detailMinimap && _detailMinimap.getContainer() !== container) {
    _detailMinimap.remove();
    _detailMinimap = null;
    _detailMinimapMarker = null;
  }

  // Paint the static placeholder first so the user sees something within
  // one HTTP round-trip — see ensureMinimapPlaceholder() docstring.
  ensureMinimapPlaceholder(lng, lat);

  if (!_detailMinimap) {
    _detailMinimap = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {
          // Satellite base — ESRI World_Imagery, free for embedding with
          // attribution. Gives the 'Google Maps satellite view' feel:
          // you see the actual building, roof, courtyard, road network.
          "esri-sat": {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            maxzoom: 19,
            attribution: "© Esri · Maxar · Earthstar Geographics",
          },
          // Reference labels overlay (transparent background; just place
          // names + admin boundaries). Layered on top of satellite to
          // match the 'hybrid' style of Google Maps satellite view.
          "esri-labels": {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            maxzoom: 19,
          },
        },
        layers: [
          { id: "sat-base",    type: "raster", source: "esri-sat" },
          { id: "sat-labels",  type: "raster", source: "esri-labels" },
        ],
      },
      center: [lng, lat],
      // Zoom 16 = building-block scale, ~1-4 tiles for first paint
      // (vs ~4-9 at z17). User can pinch/scroll/+button to zoom tighter
      // for individual buildings if they want.
      zoom: 16,
      attributionControl: false,
      cooperativeGestures: false,
    });
    _detailMinimap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    _detailMinimapMarker = new maplibregl.Marker({ color: "#D87B4F" })
      .setLngLat([lng, lat])
      .addTo(_detailMinimap);
    // The map container is inside a hidden panel during instantiation;
    // force a resize once the panel slides in so MapLibre uses the
    // correct dimensions instead of the initial 0×00 placeholder.
    // Two passes — 320ms catches the sidebar animation, 720ms is the
    // safety-net for slower devices where layout hasn't settled yet.
    setTimeout(() => _detailMinimap?.resize(), 320);
    setTimeout(() => _detailMinimap?.resize(), 720);

    // Every successful tile-paint fades the placeholder, gated by
    // maybeFadeMinimapPlaceholder() so the spurious 0×0-canvas idle that
    // fires before our resize() pass doesn't trigger a premature fade.
    // 'on' (not 'once') so re-opens that flyTo() to a new facility also
    // clear the placeholder once their new tiles load.
    _detailMinimap.on("idle", maybeFadeMinimapPlaceholder);
    _detailMinimap.on("error", (e) => console.warn("[minimap] tile error", e));
  } else {
    _detailMinimap.flyTo({ center: [lng, lat], zoom: 16, duration: 600 });
    _detailMinimapMarker?.setLngLat([lng, lat]);
    // Placeholder was just refreshed for the new lat/lng above; the
    // existing 'idle' handler will fade it out once tiles arrive.
  }
}

function disposeDetailMinimap() {
  if (_detailMinimap) {
    _detailMinimap.remove();
    _detailMinimap = null;
    _detailMinimapMarker = null;
  }
  // Drop the placeholder img so the next open creates a fresh one
  // pointed at the next facility's bbox (no flash of a stale location).
  document.querySelector(".detail-minimap-placeholder")?.remove();
}

function renderDetail(feature) {
  // v0.6.5 two-tier data: the feature passed in (from a map click) only
  // has the LITE properties (id/name/score/type/state + heatmap numerics).
  // The detail panel needs the FULL properties (tags, risk_components,
  // top_drivers, recommendations, climate, air). Upgrade to the full
  // feature if it's cached; if not, kick off the full fetch and re-render
  // when it lands. The lite-only render path below still shows score +
  // name + band so the user gets immediate feedback while waiting.
  const lite = feature;
  const liteId = lite.properties && lite.properties.id;
  const iso = (lite.properties && lite.properties._iso3) || _currentCountryIso;
  let p = lite.properties;
  // Record which facility's panel is open, so the deferred full-data
  // re-render below bails if the user clicks another facility first.
  _selectedFacilityKey = liteId ? `${iso}::${liteId}` : null;
  const full = liteId ? getFullFeature(iso, liteId) : null;
  // hasFull gates the Score breakdown, Top drivers, and Recommended actions
  // sections — they all need risk_components / top_drivers / recommendations
  // which only live on the full feature. Without this gate the lite-only
  // render would briefly paint 6 zero-pts breakdown rows + an empty drivers
  // list + a "No recommendations" placeholder, all of which get replaced a
  // beat later when the full fetch lands. Cleaner to hide-then-show than
  // to flash wrong-looking content.
  const hasFull = !!full;
  if (full) {
    feature = full;
    p = full.properties;
  } else if (iso) {
    // Trigger full fetch + re-render this exact facility when it lands — but
    // only if it's still the open one. Rapid clicks otherwise let a
    // late-resolving fetch for facility A clobber the panel now showing B.
    const wantKey = `${iso}::${liteId}`;
    ensureFullDataLoading(iso).then(() => {
      if (_selectedFacilityKey !== wantKey) return;
      const upgraded = getFullFeature(iso, liteId);
      if (upgraded) renderDetail(upgraded);
    }).catch(() => {});
  }
  const s = p.risk_score;
  const b = band(s);
  // Use the CLICKED facility's own country weights — in 3D all countries'
  // dots are clickable, and per-country weights differ materially. Falls
  // back to the active country, then empty. Fixes the Score Breakdown
  // maxima, Top Drivers order, and the micro-scene's dominant-stress pick
  // for cross-country clicks (MicroScene.create reuses this same `weights`).
  const weights = (countryDataByIso[iso] && countryDataByIso[iso].metadata && countryDataByIso[iso].metadata.scoring_weights)
    || (currentData && currentData.metadata && currentData.metadata.scoring_weights)
    || {};
  // Tear down any prior micro-scene (different facility just got clicked).
  if (_activeMicroScene) {
    _activeMicroScene.dispose();
    _activeMicroScene = null;
  }
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

  // Area electrification (HREA night-lights, settlement-level). The field
  // rides in the LITE tier only, so when the panel has upgraded to the full
  // feature (which doesn't carry it) we look it up by id from the lite data
  // so the line doesn't vanish after the full-data re-render. Null when the
  // country has no HREA coverage — block omitted entirely in that case.
  const _aeIso = p._iso3 || _currentCountryIso;
  let _ae = p.area_electrification;
  if (_ae == null) {
    const _liteSrc = (countryDataByIso[_aeIso] && countryDataByIso[_aeIso].features)
      || (currentData && currentData.features) || [];
    const _lf = _liteSrc.find(ff => ff.properties.id === p.id);
    if (_lf) _ae = _lf.properties.area_electrification;
  }
  const electrificationHtml = (_ae == null) ? "" : `
    <div class="detail-section">
      <h4>Area electrification · ${_ae >= 0.66 ? "Likely" : _ae >= 0.33 ? "Partly" : "Unlikely"}</h4>
      <p class="section-note">Settlement-level estimate (HREA night-lights). Reflects the area's grid coverage, not whether this school itself is wired.</p>
    </div>`;

  // Recommendations — reordered to mirror the Top-drivers list so the user
  // reads top driver → top recommendation, second driver → second rec, etc.
  // Recs without a corresponding driver (e.g. fragility) keep their
  // original rule-priority order at the tail.
  const orderedRecs = reorderRecsByDrivers(recs, drivers);
  const recHtml = orderedRecs.length ? orderedRecs.map((r, i) => `
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

  // Rank within country — computed live from this country's features only
  // (in multi-country mode allFeatures includes all 3 countries; we want a
  // per-country rank). Smart precision so a #1-of-10,927 facility doesn't
  // misleadingly round to "Top 0.0%".
  const featureIso = p._iso3 || _currentCountryIso;
  const countryFeats = allFeatures.filter(f => !f.properties._iso3 || f.properties._iso3 === featureIso);
  const total = countryFeats.length;
  const rank = countryFeats.filter(f => f.properties.risk_score > s).length + 1;
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

    <!-- Interactive mini-map of the facility's neighbourhood. MapLibre
         instance loaded lazily on detail open, disposed on close. Tiles
         from CARTO Voyager (already CSP-whitelisted) which gives roads,
         place labels, building outlines — the 'show me the actual place'
         richness a static satellite tile couldn't. The Google Maps link
         lets the user dive into a full street-view / satellite experience
         if the minimap piques their interest. -->
    <div class="detail-minimap-wrap">
      <div class="detail-minimap" id="detail-minimap"></div>
      <a id="detail-map-link" class="detail-satellite-link" target="_blank" rel="noopener" title="Open this location in Google Maps">View on Google Maps →</a>
      <div class="detail-satellite-attr mono">© Esri · Maxar</div>
    </div>

    <!-- Micro-scene: a small Three.js vignette that procedurally visualises
         the facility's dominant climate stressor (heat / drought / flood /
         PM2.5). Built by MicroScene.create() right after this innerHTML
         settles into the DOM. -->
    <div class="microscene">
      <canvas class="microscene-canvas" id="microscene-canvas"></canvas>
      <div class="microscene-label" id="microscene-label"></div>
    </div>

    ${hasFull ? `
    <div class="detail-section">
      <h4>Score breakdown</h4>
      ${breakdown}
    </div>` : ""}

    ${hasFull ? `
    <div class="detail-section">
      <h4>Top drivers</h4>
      ${driversHtml}
    </div>` : ""}

    <div class="detail-section">
      <h4>Raw inputs</h4>
      ${inputsHtml}
    </div>

    ${electrificationHtml}

    ${hasFull ? `
    <div class="detail-section">
      <h4>Recommended actions · ranked</h4>
      <p class="section-note">Only drivers with a facility-level fix produce a recommendation.</p>
      ${recHtml}
    </div>` : ""}
  `;

  // Open right panel
  document.body.classList.add("has-detail");
  document.querySelector(".detail-wrap")?.setAttribute("aria-hidden", "false");
  // Trigger map resize so MapLibre recalculates center/zoom for the narrower canvas
  setTimeout(() => map.resize(), 260);

  // Wire the interactive neighbourhood mini-map. Lazily creates a
  // MapLibre instance the first time it's needed and reuses it across
  // facility opens (flyTo + marker move instead of rebuild) for speed
  // and WebGL-context economy.
  setupDetailMinimap(feature);

  // Spin up the micro-scene now that the canvas is in the DOM with its
  // final dimensions. Guarded for the case where the global isn't loaded
  // (script-load failure) — the rest of the panel still works.
  if (typeof MicroScene !== "undefined" && MicroScene.create) {
    const canvas = document.getElementById("microscene-canvas");
    const label  = document.getElementById("microscene-label");
    const wrap   = canvas?.closest(".microscene");
    if (canvas) {
      _activeMicroScene = MicroScene.create(canvas, p, weights);
      if (_activeMicroScene && label) {
        label.textContent = _activeMicroScene.label;
        // .ready triggers the CSS opacity fade-in. rAF defer so the class
        // change is on a fresh frame, not batched with the initial style.
        if (wrap) requestAnimationFrame(() => wrap.classList.add("ready"));
      } else if (wrap) {
        // No dominant stress (all components zero / missing). Hide the
        // whole microscene block so it doesn't sit there empty.
        wrap.style.display = "none";
      }
    }
  }
}

// Close/hide the right panel
function closeDetail() {
  document.body.classList.remove("has-detail");
  document.querySelector(".detail-wrap")?.setAttribute("aria-hidden", "true");
  _selectedFacilityKey = null;
  // Dispose the micro-scene's WebGL resources — critical to avoid
  // exhausting the 16-context browser limit after many facility opens.
  if (_activeMicroScene) {
    _activeMicroScene.dispose();
    _activeMicroScene = null;
  }
  // Same for the detail-panel minimap (another WebGL/canvas context).
  disposeDetailMinimap();
  // Clear the selected-facility highlight ring
  highlightFacility(null);
  // Drop the ?facility= param so a shared URL after close doesn't reopen
  // a closed panel on reload.
  setUrlParam("facility", null);
  // Update map size after CSS transition
  setTimeout(() => map.resize(), 260);
}

// ---- Shareable URLs: country + state + facility ----
//
// The URL bar mirrors the current view, three params deep:
//   ?country=NGA               → atlas of Nigeria, no filter
//   ?country=BGD&state=Dhaka   → Bangladesh, Dhaka state filter
//   ?country=NGA&facility=grid3-clinic-XYZ  → specific facility opened
//
// Any in-app state change (country switch, state filter, facility click,
// detail close) calls setUrlParam to keep the URL bar honest. On initial
// page load, parseInitialUrlState() reads the URL once and the app
// dispatches accordingly: switches country, applies state filter, opens
// facility. Subsequent navigation is user-driven — URL just reflects the
// current view, doesn't drive it.
function setUrlParam(key, value) {
  const url = new URL(window.location.href);
  if (value === null || value === undefined || value === "") {
    url.searchParams.delete(key);
  } else {
    url.searchParams.set(key, value);
  }
  history.replaceState(null, "", url.toString());
}

// Captured ONCE at module init so country + state + facility from the
// landing URL can be applied in sequence as data becomes available
// (country needs to switch first, state filter waits for data, facility
// waits for state). Cleared after the initial load completes; subsequent
// switches don't re-read these.
//
// Hard-refresh handling: if this load was triggered by an explicit reload
// (cmd-R, F5, refresh button), treat it as a fresh visit — drop the
// ?facility= deep-link so the detail panel doesn't auto-open. URLs pasted
// into a new tab or clicked from elsewhere still deep-link normally. We
// also replaceState to scrub the param so subsequent reloads of the same
// tab also land clean.
const _initialUrl = (() => {
  const params = new URL(window.location.href).searchParams;
  const navType = (typeof performance !== "undefined"
    && performance.getEntriesByType
    && performance.getEntriesByType("navigation")[0]?.type) || "navigate";
  const isReload = navType === "reload";
  if (isReload && params.has("facility")) {
    const u = new URL(window.location.href);
    u.searchParams.delete("facility");
    history.replaceState(null, "", u.toString());
    return { country: params.get("country"), state: params.get("state"), facility: null };
  }
  return {
    country: params.get("country"),
    state: params.get("state"),
    facility: params.get("facility"),
  };
})();
let _initialUrlConsumed = false;

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
  if (!f) {
    // Helpful when an old shared URL points at a facility that fell out
    // of the dataset after a pipeline rebuild (different dedup, etc.).
    console.warn("[atlas] URL ?facility=" + wantedId + " not found in current data");
    return false;
  }
  // Open the detail panel + set the selection ring IMMEDIATELY — these
  // don't depend on the camera being settled. The cinematicFlyTo runs
  // concurrently. Doing highlight + render up front (rather than inside
  // a setTimeout) means the ring is set on the source even while the
  // camera is still arriving, instead of waiting an extra 300ms and
  // racing the user's first interaction.
  highlightFacility(f);
  renderDetail(f);
  cinematicFlyTo({ center: f.geometry.coordinates, zoom: 13 });
  // Belt-and-braces: re-apply the highlight once the map settles, in
  // case the source's first setData missed a render frame during the
  // flyTo (very narrow race seen in the deferred-data-apply path).
  map.once("idle", () => {
    if (document.body.classList.contains("has-detail")) {
      highlightFacility(f);
    }
  });
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
  let anyMissingFull = false;
  tbody.innerHTML = rendered.map((f, i) => {
    const liteP = f.properties;
    const featIso = liteP._iso3 || _currentCountryIso;
    // Top Driver + Action live only on the FULL feature (lite drops them).
    const full = getFullFeature(featIso, liteP.id);
    // Only flag the ACTIVE country's missing rows for re-fetch. In 3D the
    // table also shows context-country rows whose full data is never loaded
    // here (only on click) — flagging those would make the recovery branch
    // below loop forever, since ensureFullDataLoading only fetches the
    // active country. Context rows keep the … placeholder until clicked.
    if (!full && featIso === _currentCountryIso) anyMissingFull = true;
    const p = full ? full.properties : liteP;
    const s = liteP.risk_score;
    const drivers = full ? (typeof p.top_drivers === "string" ? JSON.parse(p.top_drivers) : (p.top_drivers || [])) : null;
    const recs = full ? (typeof p.recommendations === "string" ? JSON.parse(p.recommendations) : (p.recommendations || [])) : null;
    const driverCell = full ? escapeHtml((drivers[0] || "").replace(/_/g, " ")) : '<span style="color:var(--paper-mute)">…</span>';
    const actionCell = full ? (recs.length ? escapeHtml(recs[0].title) : "—") : '<span style="color:var(--paper-mute)">…</span>';
    return `<tr data-id="${escapeHtml(liteP.id)}">
      <td>${i + 1}</td>
      <td class="name-cell" title="${escapeHtml(displayName(f))}">${typeIcon(liteP.facility_type)} ${escapeHtml(displayName(f))}</td>
      <td>${escapeHtml(liteP.facility_type)}</td>
      <td><span class="table-badge ${band(s)}">${s.toFixed(0)}</span></td>
      <td>${driverCell}</td>
      <td>${actionCell}</td>
    </tr>`;
  }).join("");
  // If any row lacked full data, fetch it for the active country and
  // re-render once it lands (self-terminates: next pass has full data).
  if (anyMissingFull && _currentCountryIso) {
    ensureFullDataLoading(_currentCountryIso).then(() => {
      if (document.body.contains(overlay)) updateTableContents(overlay);
    }).catch(() => {});
  }

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
function csvCell(v) {
  // RFC-4180 quoting + spreadsheet formula-injection guard. Facility names
  // come from OpenStreetMap (publicly editable), so a name like `="evil"` or
  // `5" Clinic` must not break the row or execute as a formula in Excel/Sheets.
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// Active-country subset of the current view. In 3D, filteredFeatures keeps
// other countries as dimmed context; exports must not silently include them
// under the active country's filename + metadata.
function activeCountryFeatures() {
  return IS_3D
    ? filteredFeatures.filter(f => !f.properties._iso3 || f.properties._iso3 === _currentCountryIso)
    : filteredFeatures;
}

async function exportCSV() {
  const exportFeats = activeCountryFeatures();
  if (!exportFeats.length) return;
  // filteredFeatures are LITE — upgrade each to its FULL feature so the
  // component scores, no2, and recommendation columns are real rather than
  // all-zero. Ensure full data is loaded first.
  const isos = [...new Set(exportFeats.map(f => f.properties._iso3 || currentData.metadata.iso3))];
  await Promise.all(isos.map(iso => ensureFullDataLoading(iso).catch(() => {})));
  const weights = currentData.metadata.scoring_weights || {};
  const compKeys = Object.keys(weights);
  const header = ["name", "type", "lat", "lon", "risk_score", "risk_band", ...compKeys,
    "heat_days", "flood_days", "dry_streak", "pm25", "no2", "top_rec"];
  const rows = exportFeats.map(f => {
    const iso = f.properties._iso3 || currentData.metadata.iso3;
    const full = getFullFeature(iso, f.properties.id) || f;
    const p = full.properties;
    const comps = typeof p.risk_components === "string" ? JSON.parse(p.risk_components) : (p.risk_components || {});
    const clim = typeof p.climate === "string" ? JSON.parse(p.climate) : (p.climate || {});
    const air = typeof p.air === "string" ? JSON.parse(p.air) : (p.air || {});
    const recs = typeof p.recommendations === "string" ? JSON.parse(p.recommendations) : (p.recommendations || []);
    return [
      csvCell(displayName(full)), csvCell(p.facility_type),
      csvCell(full.geometry.coordinates[1]), csvCell(full.geometry.coordinates[0]),
      csvCell(p.risk_score), csvCell(bandLabel(p.risk_score)),
      ...compKeys.map(k => csvCell((comps[k] || 0).toFixed(3))),
      csvCell(p.heat_index_days ?? clim.heat_index_days ?? 0),
      csvCell(p.heavy_precip_days ?? clim.heavy_precip_days ?? 0),
      csvCell(p.longest_dry_run_days ?? clim.longest_dry_run_days ?? 0),
      csvCell(p.pm25_avg_ugm3 ?? air.pm25_avg_ugm3 ?? 0),
      csvCell(air.no2_avg_ugm3 ?? 0),
      csvCell(recs.length ? recs[0].title : "None"),
    ].join(",");
  });
  const csv = [header.map(csvCell).join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `childclimate-atlas-${currentData.metadata.iso3}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportGeoJSON() {
  const exportFeats = activeCountryFeatures();
  if (!exportFeats.length) return;
  // Upgrade to full features so the exported GeoJSON carries risk_components,
  // recommendations, climate + air (the lite render tier drops them).
  const isos = [...new Set(exportFeats.map(f => f.properties._iso3 || currentData.metadata.iso3))];
  await Promise.all(isos.map(iso => ensureFullDataLoading(iso).catch(() => {})));
  const feats = exportFeats.map(f =>
    getFullFeature(f.properties._iso3 || currentData.metadata.iso3, f.properties.id) || f);
  const out = { type: "FeatureCollection", metadata: currentData.metadata, features: feats };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `childclimate-atlas-${currentData.metadata.iso3}.geojson`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---- main switch ----
async function switchCountry(iso3) {
  // Record the new ISO immediately so the aura repaint (called inside the
  // updateMap early-return branch a few moments from now) uses the new tint
  // rather than the previous country's.
  _currentCountryIso = iso3;

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
  // URL mirrors the country switch immediately, even before data loads.
  // State is cleared because the new country has its own state set.
  setUrlParam("country", iso3);
  // On user-driven switches, drop stale state/facility from the URL
  // (they don't apply to the new country). On the initial load we DON'T
  // touch them yet — _initialUrl below applies them after data lands.
  if (_initialUrlConsumed) {
    setUrlParam("state", null);
    setUrlParam("facility", null);
  }

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

  // Country-switch trail (3D only): a great-circle arc drawn on the globe
  // surface from the previous country's center (or actual camera position
  // if user panned) to this one. The line's head follows the camera as it
  // flies. Skip on initial load (no previous center) and same-country
  // reselect (no journey to draw). Capturing the condition into a const so
  // the same gate also drives the post-flight data-apply below.
  const willAnimateTrail = IS_3D && _prevCountryCenter !== null
    && (_prevCountryCenter[0] !== v.center[0] || _prevCountryCenter[1] !== v.center[1]);

  if (willAnimateTrail) {
    // Use the actual current camera position as the trail's start — if the
    // user panned away from the previous country's nominal center, the line
    // should start where the camera ACTUALLY is so it tracks the flight.
    const c = map.getCenter();
    showCountryTrail([c.lng, c.lat], v.center);
  }
  _prevCountryCenter = v.center;

  cinematicFlyTo({
    center: v.center,
    zoom: IS_3D ? Math.max(v.zoom - 1.5, 3) : v.zoom,
  });

  // At 311K facilities the loadAtlas + setData pipeline stalls the main
  // thread for several seconds when switching countries — long enough that
  // a synchronously-set trail can get queued behind the stall and miss its
  // first paint window entirely. Yielding to the browser for two RAF cycles
  // guarantees the trail's setData commits to a real render frame BEFORE
  // the heavy data work starts, so the user actually sees the arc draw.
  if (willAnimateTrail) {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  // --- 2. ASYNC DATA FETCH (with streaming progress) ---------------------
  // v0.6.5 two-tier: await the LITE variant for the map render (small,
  // fast — ~30 MB raw for NGA, sub-second JSON.parse), then kick the
  // FULL variant off in the background for detail-panel hydration. Lite
  // has everything the map needs to render dots + heatmap + filter +
  // tooltip. Full has tags / risk_components / recommendations etc that
  // the detail panel needs on facility click.
  const data = await loadAtlas(iso3, { showProgress: true, lite: true });
  // Background-fetch the full data so detail-panel clicks 5-30s from now
  // are instant. Fire-and-forget; no await.
  ensureFullDataLoading(iso3).catch(() => {});
  currentData = data;
  // In 3D mode, tag this country's features with _iso3 and cache them.
  // Other countries stream in as background loads via loadOtherCountries()
  // below — by the time the user notices, all three are visible.
  countryDataByIso[iso3] = data;
  tagFeaturesIso(data.features || [], iso3);
  flattenClimateAir(data.features || []);
  if (IS_3D) {
    mergeAllCountriesIntoAllFeatures();
  } else {
    allFeatures = data.features || [];
  }

  // --- 3. RE-RENDER with real data ---------------------------------------
  // Scope to the ACTIVE country's features only. In 3D, allFeatures is the
  // merged ~311k across all five countries, but the state dropdown only needs
  // the active country — iterating the full merge here (getState per feature)
  // was a chunk of the country-switch jank. `data` is the active country just
  // loaded above.
  populateStates(data.features || []);
  updateSearchPlaceholder();
  applyFilters();

  // Defensive: ensure the facility layers are visible after a country
  // switch. If the user had heatmap on while on the previous country
  // (which hides the dot layers), or any other path left layers hidden,
  // this restores them so the new country actually shows its dots.
  if (!heatmapVisible) {
    setFacilityLayersVisible(true);
  }

  // Data + map source are now populated. Flip the ready flag, hide the
  // loading overlay, and if a pre-load Spotlight click is pending, fire
  // it now (with a brief grace period so the freshly-rendered dots have
  // a beat to appear before the intro spin starts arcing across them).
  dataReady = true;
  // Hide the overlay only once the map has actually painted the dots,
  // not the moment dataReady flips. Prevents the brief empty-map flash.
  hideMapLoadingWhenRendered();

  // If the landing URL specified a state, apply it now that the state
  // panel has been populated (populateStates above). Programmatic click
  // on the matching .state-opt fires the existing handler which sets
  // activeFilters.state + URL + button label + .sel class + filter run.
  if (!_initialUrlConsumed && _initialUrl.state) {
    const wantedState = _initialUrl.state;
    const opt = document.querySelector(`.state-opt[data-value="${CSS.escape(wantedState)}"]`);
    if (opt) opt.click();
  }
  _initialUrlConsumed = true;

  // If the URL has ?facility=X, open it now that we know X is loadable.
  openFacilityFromUrl();
  if (pendingSpotlightStart) {
    pendingSpotlightStart = false;
    setTimeout(() => startSpotlight(), 500);
  }

  // Multi-country (3D only): kick off background loads of the OTHER
  // countries so they fade in as dimmed context. The active country is
  // already painted; this just streams in the rest of the world.
  if (IS_3D && !allCountriesLoaded) {
    loadOtherCountries(iso3);
  }
}

// Load every non-active country (cached on hit) and merge their features
// into allFeatures + re-render. Each landing triggers a single applyFilters
// pass so the new dots fade in (well, snap in — fade is a polish layer for
// another session). Fire-and-forget: errors logged, not thrown, so a slow
// connection doesn't block the active country.
async function loadOtherCountries(activeIso) {
  for (const iso of ALL_ISOS) {
    if (iso === activeIso) continue;
    if (countryDataByIso[iso]) continue;
    try {
      // Lite for the multi-country merged 3D view — the map only needs
      // the render-essentials of context countries. Full data for those
      // gets fetched if and when the user clicks one of their facilities.
      const data = await loadAtlas(iso, { showProgress: false, lite: true });
      countryDataByIso[iso] = data;
      tagFeaturesIso(data.features || [], iso);
      flattenClimateAir(data.features || []);
      mergeAllCountriesIntoAllFeatures();
      applyFilters();
    } catch (e) {
      console.warn(`[atlas] background load failed for ${iso}:`, e);
    }
  }
  allCountriesLoaded = true;
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
    // Mobile: close the drawer so the camera-flight to the new country is
    // immediately visible. No-op on desktop (class is never set).
    document.body.classList.remove("mobile-menu-open");
    switchCountry(e.target.value);
    // Also blur on change so the browser focus ring drops immediately,
    // before the async switchCountry's animation kicks in.
    e.target.blur();
  });
  // State dropdown toggle
  document.getElementById("state-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = document.getElementById("state-panel").classList.toggle("open");
    e.currentTarget.setAttribute("aria-expanded", open ? "true" : "false");
  });
  // Search: autocomplete dropdown + live map filter
  const searchInput = document.getElementById("search");
  searchInput.addEventListener("input", e => {
    const v = e.target.value;
    activeFilters.search = v;
    // Debounce the heavy work: applyFilters scans up to ~311k features and
    // re-indexes the MapLibre source, and renderSearchResults rescans them —
    // running both per keystroke janks large countries. Coalesce a burst.
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      applyFilters();            // also filter the map dots
      renderSearchResults(v);    // and show a dropdown of matches
    }, 180);
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

  // ---- Mobile drawer (hamburger) wiring ----
  // The hamburger button and backdrop live in the HTML on both pages but are
  // only visible at the mobile breakpoint via CSS. Toggle body.mobile-menu-open
  // to slide the left sidebar in as a drawer; clicking the backdrop or
  // pressing Escape closes it. Picking a country also closes the drawer so
  // the user immediately sees the map fly to the new region.
  const mobileMenuBtn = document.getElementById("btn-mobile-menu");
  const mobileBackdrop = document.getElementById("mobile-backdrop");
  function setMobileMenuOpen(open) {
    document.body.classList.toggle("mobile-menu-open", open);
    mobileMenuBtn?.setAttribute("aria-expanded", open ? "true" : "false");
    mobileBackdrop?.setAttribute("aria-hidden", open ? "false" : "true");
  }
  mobileMenuBtn?.addEventListener("click", () => {
    setMobileMenuOpen(!document.body.classList.contains("mobile-menu-open"));
  });
  mobileBackdrop?.addEventListener("click", () => setMobileMenuOpen(false));

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
      // Mobile drawer takes priority over detail panel — if both are open,
      // a single Escape closes the most recently opened (the drawer).
      if (document.body.classList.contains("mobile-menu-open")) {
        setMobileMenuOpen(false);
        return;
      }
      // Close detail panel on Escape — also resume spotlight if paused.
      if (document.body.classList.contains("has-detail")) {
        closeDetail();
        if (tourActive && spotlightPaused) resumeSpotlight();
      }
    }
  });

  // About nav — routes to /about (real page). No JS handler needed: the
  // anchor's href does the navigation. Kept here as a marker for future
  // SPA-style intercept if we ever want to load /about without a reload.
});

// ---- hazard overlay toggle ----
// The previous "Heatmap" button showed an aggregate risk-density layer
// that duplicated what the colored dots already say. Replaced with a
// "Hazards" toggle that paints FOUR distinct climate-input heatmaps
// simultaneously — heat (red), drought (brown), flood (blue), and
// PM2.5 (warm grey). Each is weighted by the actual underlying climate
// value, so the user sees WHERE on the planet each hazard is hot, not
// just where high-risk facilities cluster.
let heatmapVisible = false;

// Hazard layer definitions. Each entry maps a layer id to:
//   prop      — the feature property the heatmap weights by
//   max       — the value at which weight saturates to 1.0
//   color     — the gradient stops [opacity, color] from low to high density
//   radius    — px per density unit at zoom 14 (smaller = tighter clusters)
// Year projection multipliers — approximate IPCC SSP2-4.5 (middle-of-the-
// road) scaling factors vs 2024 baseline. Used to visualise what current
// hazard hotspots will intensify into. Not a downscaled climate model,
// just defensible regional approximations; the about/methodology page
// notes this.
// IPCC AR6 SSP3-7.0 regional approximations vs 2024 baseline. SSP3-7.0
// is closer to current emissions trajectories than SSP2-4.5 (which the
// previous values reflected, but at multipliers too subtle to read
// visually). NOT downscaled climate model output — applied uniformly
// to all facilities, honest about being v0.2 visualisation rather than
// peer-reviewed projection. Methodology on the About page.
const YEAR_MULTIPLIERS = {
  2024: { heat: 1.00, drought: 1.00, flood: 1.00, pm25: 1.00 },
  2030: { heat: 1.30, drought: 1.20, flood: 1.10, pm25: 1.00 },
  2050: { heat: 1.75, drought: 1.50, flood: 1.30, pm25: 1.00 },
};
let currentProjectionYear = 2024;

const HAZARD_LAYERS = [
  {
    id: "haz-heat",
    key: "heat",
    prop: "heat_index_days",
    max: 240,
    radiusZ14: 36,
    stops: [
      [0,   "rgba(0,0,0,0)"],
      [0.20, "rgba(216, 123, 79, 0.20)"],
      [0.40, "rgba(216, 123, 79, 0.45)"],
      [0.60, "rgba(195,  82, 72, 0.62)"],
      [0.80, "rgba(195,  82, 72, 0.80)"],
      [1.00, "rgba(166,  61, 52, 0.90)"],
    ],
  },
  {
    id: "haz-drought",
    key: "drought",
    prop: "longest_dry_run_days",
    max: 90,
    radiusZ14: 28,
    stops: [
      [0,   "rgba(0,0,0,0)"],
      [0.20, "rgba(168, 138,  82, 0.16)"],
      [0.45, "rgba(140, 108,  62, 0.45)"],
      [0.70, "rgba(102,  78,  44, 0.65)"],
      [1.00, "rgba( 72,  52,  28, 0.82)"],
    ],
  },
  {
    id: "haz-flood",
    key: "flood",
    prop: "heavy_precip_days",
    max: 30,
    radiusZ14: 24,
    stops: [
      [0,   "rgba(0,0,0,0)"],
      [0.20, "rgba( 95, 165, 199, 0.18)"],
      [0.45, "rgba( 70, 130, 175, 0.45)"],
      [0.70, "rgba( 46,  98, 152, 0.65)"],
      [1.00, "rgba( 24,  62, 120, 0.82)"],
    ],
  },
  {
    id: "haz-pm25",
    key: "pm25",
    prop: "pm25_avg_ugm3",
    max: 50,
    radiusZ14: 26,
    stops: [
      [0,   "rgba(0,0,0,0)"],
      [0.20, "rgba(217, 182,  83, 0.18)"],
      [0.45, "rgba(180, 150,  72, 0.42)"],
      [0.70, "rgba(140, 116,  60, 0.62)"],
      [1.00, "rgba(110,  90,  48, 0.78)"],
    ],
  },
];

// Facility-related layers that get hidden while the heatmap is on, so the
// heatmap reads as a distinct REGIONAL view (concentration of risk by area)
// instead of an extra wash painted on top of the per-facility dots. Includes
// glow, dots, selection ring, and hover ring — everything tied to individual
// facilities. The aura + country-trail stay (they're globe storytelling, not
// per-facility decoration).
const FACILITY_LAYER_IDS = [
  "facilities-glow",
  "facilities",
  "selected-ring",  // actual layer id (not "facilities-selected-ring")
  "hovered-halo",   // actual layer id (not "facilities-hovered")
];
function setFacilityLayersVisible(visible) {
  const vis = visible ? "visible" : "none";
  FACILITY_LAYER_IDS.forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
  });
}

function ensureHazardLayers() {
  // Guard against the style not being fully loaded — addLayer throws
  // 'Style is not done loading' otherwise. If we're early, defer to
  // map.once('idle') so the user's click eventually takes effect.
  if (!map.isStyleLoaded()) {
    map.once("idle", () => { if (heatmapVisible) ensureHazardLayers(); });
    return;
  }
  for (const h of HAZARD_LAYERS) {
    if (map.getLayer(h.id)) continue;
    const colorExpr = ["interpolate", ["linear"], ["heatmap-density"]];
    for (const [stop, color] of h.stops) { colorExpr.push(stop, color); }
    map.addLayer({
      id: h.id,
      type: "heatmap",
      source: "facilities",
      maxzoom: 12,
      paint: {
        // Weight: the feature's actual climate value normalized to 0-1.
        // Features missing this value contribute 0.
        "heatmap-weight": [
          "interpolate", ["linear"],
          ["coalesce", ["get", h.prop], 0],
          0, 0, h.max, 1,
        ],
        // Density renders larger as the user zooms in to country level.
        "heatmap-intensity": [
          "interpolate", ["linear"], ["zoom"], 0, 0.4, 10, 1.4, 12, 2.0,
        ],
        "heatmap-color": colorExpr,
        "heatmap-radius": [
          "interpolate", ["linear"], ["zoom"], 0, 6, 8, 18, 14, h.radiusZ14,
        ],
        "heatmap-opacity": [
          "interpolate", ["linear"], ["zoom"], 0, 0.85, 12, 0.55,
        ],
      },
    }, "facilities-glow");
  }
}

function toggleHeatmap() {
  heatmapVisible = !heatmapVisible;
  // Body class lets the CSS dim the year-chip row when hazards is off
  // (the chips don't have any visual effect without hazards on, so we
  // signal that visually rather than disabling them outright).
  document.body.classList.toggle("hazards-on", heatmapVisible);
  const btn = document.getElementById("btn-heatmap");
  const hud = document.getElementById("hud-heatmap");
  if (heatmapVisible) {
    ensureHazardLayers();
    updateHazardWeights();
    for (const h of HAZARD_LAYERS) {
      if (map.getLayer(h.id)) map.setLayoutProperty(h.id, "visibility", "visible");
    }
    setFacilityLayersVisible(false);
    btn?.classList.add("active");
    if (hud) hud.textContent = `Hazards · on (${currentProjectionYear === 2024 ? "Today" : currentProjectionYear})`;
    if (btn) btn.textContent = "Hide hazards";
  } else {
    for (const h of HAZARD_LAYERS) {
      if (map.getLayer(h.id)) map.setLayoutProperty(h.id, "visibility", "none");
    }
    setFacilityLayersVisible(true);
    btn?.classList.remove("active");
    if (hud) hud.textContent = "Hazards · off";
    if (btn) btn.textContent = "Hazards";
  }
}

// Re-render the hazard heatmap weight expressions using the current year's
// projection multiplier. Divides the saturation max by the multiplier so
// the same raw climate value contributes proportionally MORE — visually
// the hazard zones expand and brighten as the user steps forward in time.
function updateHazardWeights() {
  const m = YEAR_MULTIPLIERS[currentProjectionYear] || YEAR_MULTIPLIERS[2024];
  for (const h of HAZARD_LAYERS) {
    if (!map.getLayer(h.id)) continue;
    const mult = (m[h.key] || 1);
    const projectedMax = h.max / mult;  // smaller max = same value reaches density 1 sooner
    map.setPaintProperty(h.id, "heatmap-weight", [
      "interpolate", ["linear"],
      ["coalesce", ["get", h.prop], 0],
      0, 0, projectedMax, 1,
    ]);
    // Lowering the weight cap alone shows NOTHING for high-baseline
    // countries: Nigeria's heat_index_days already exceed h.max, so every
    // facility is pinned at weight 1.0 even in 2024 and the year chips
    // looked identical. Also scale heatmap-intensity by the multiplier so
    // already-saturated zones still visibly intensify as the years advance.
    map.setPaintProperty(h.id, "heatmap-intensity", [
      "interpolate", ["linear"], ["zoom"],
      0, 0.4 * mult, 10, 1.4 * mult, 12, 2.0 * mult,
    ]);
    // Also grow the radius so the hazard zone visibly EXPANDS (not just
    // brightens) as the years advance — makes the 2024→2030→2050 step
    // read more clearly. Up to ~45% larger at 2050 heat (mult 1.75).
    const rGrow = 1 + (mult - 1) * 0.6;
    map.setPaintProperty(h.id, "heatmap-radius", [
      "interpolate", ["linear"], ["zoom"],
      0, 6 * rGrow, 8, 18 * rGrow, 14, h.radiusZ14 * rGrow,
    ]);
  }
}

function setProjectionYear(year) {
  currentProjectionYear = year;
  document.querySelectorAll(".year-chip").forEach(el => {
    el.classList.toggle("active", parseInt(el.dataset.year, 10) === year);
  });
  // Year chips only affect the visualization WHEN hazards are on. We used
  // to auto-enable hazards on year click, but that meant the user picked
  // a year and the app silently turned a feature on without asking. Now:
  // if hazards are on, the projection multipliers re-render. If hazards
  // are off, the year is recorded but nothing flips on visually.
  if (heatmapVisible) {
    updateHazardWeights();
    const hud = document.getElementById("hud-heatmap");
    if (hud) hud.textContent = `Hazards · on (${year === 2024 ? "Today" : year})`;
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
        const liteP = f.properties;
        // Top Driver + Action live only on the FULL feature (lite drops them).
        // switchCountry pre-fetches full in the background, so it's usually
        // cached by now; fall back to a lite-derived driver if not.
        const fIso = liteP._iso3 || (m && m.iso3) || _currentCountryIso;
        const full = getFullFeature(fIso, liteP.id);
        const p = full ? full.properties : liteP;
        const recs = full ? (typeof p.recommendations === "string" ? JSON.parse(p.recommendations) : (p.recommendations || [])) : [];
        const drivers = full ? (typeof p.top_drivers === "string" ? JSON.parse(p.top_drivers) : (p.top_drivers || [])) : [];
        let topDriver = drivers[0] ? drivers[0].replace(/_/g, " ") : "";
        if (!topDriver) {
          const cand = [
            ["heat exposure", liteP.heat_index_days || 0],
            ["air pollution", liteP.pm25_avg_ugm3 || 0],
            ["drought risk", liteP.longest_dry_run_days || 0],
            ["flood risk", liteP.heavy_precip_days || 0],
          ].sort((a, b) => b[1] - a[1]);
          topDriver = cand[0][1] > 0 ? cand[0][0] : "";
        }
        return `<tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(displayName(f))}</td>
          <td>${escapeHtml(liteP.facility_type)}</td>
          <td><span class="badge ${band(liteP.risk_score)}">${liteP.risk_score}</span></td>
          <td>${escapeHtml(topDriver)}</td>
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
  // Top-HUD 'Pulse · ON' chip — the ON/OFF text inside is the only
  // clickable part. Toggles the severe-band breathing-ring layer
  // without touching the hazards/year state at all. Independent feature.
  const pulseToggle = document.getElementById("hud-pulse-toggle");
  if (pulseToggle) pulseToggle.addEventListener("click", () => togglePulseLayer());
  document.querySelectorAll(".year-chip").forEach(el => {
    el.addEventListener("click", () => setProjectionYear(parseInt(el.dataset.year, 10)));
  });
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

// Load data immediately — don't wait for map tiles. The country is taken
// from the landing URL if present + valid, otherwise NGA. The country
// <select> is set to match so the dropdown reflects what's loading.
(() => {
  const validCountries = Object.keys(VIEWS);  // NGA, BGD, GTM, KEN, PHL
  const fromUrl = _initialUrl.country;
  const iso = fromUrl && validCountries.includes(fromUrl) ? fromUrl : "NGA";
  const sel = document.getElementById("country");
  if (sel) sel.value = iso;
  switchCountry(iso);
})();
