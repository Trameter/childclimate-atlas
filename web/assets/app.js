/* ChildClimate Risk Atlas — v2 frontend
   Full-featured: search, filters, legend, recommendations, export, charts. */

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
// In-memory cache keyed by ISO3 so a country is fetched at most once per
// session. Combined with the browser's HTTP cache (we no longer set
// cache:"no-store"), switching BACK to a country you've already viewed is
// instant and cold country-switches only pay the download cost the first
// time they happen.
const dataCache = new Map();
const inflight = new Map(); // dedupe concurrent requests for the same country

async function loadAtlas(iso3) {
  if (dataCache.has(iso3)) return dataCache.get(iso3);
  if (inflight.has(iso3)) return inflight.get(iso3);
  const p = (async () => {
    try {
      const r = await fetch(`./data/${iso3}.geojson`);
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
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
    // Fire-and-forget; ignore errors, don't block UI.
    loadAtlas(iso3).catch(() => {});
  });
}

// ---- map init ----
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: { carto: { type: "raster", tiles: [
      "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
      "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
    ], tileSize: 256, attribution: "\u00a9 OSM \u00a9 CARTO" } },
    layers: [{ id: "carto", type: "raster", source: "carto" }],
  },
  center: VIEWS.NGA.center,
  zoom: VIEWS.NGA.zoom,
  maxZoom: 17,
});
map.addControl(new maplibregl.NavigationControl(), "top-right");

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
    opt.innerHTML = `<span>${s}</span><span class="cnt">${c}</span>`;
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
    return `<div class="search-result${i === 0 ? " hl" : ""}" role="option" data-id="${p.id}" data-idx="${i}">
      <span class="d" style="background:${bandColor(s)}"></span>
      <div class="meta">
        <span class="t">${name}</span>
        ${subText ? `<span class="sub">${subText}</span>` : ""}
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
  map.flyTo({ center: f.geometry.coordinates, zoom: 13 });
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
    map.flyTo({ center: v.center, zoom: v.zoom });
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
  // switches. If so, self-schedule a retry on the next idle event. We guard
  // with `mapUpdateQueued` so rapid updates don't stack multiple listeners.
  if (!map.isStyleLoaded()) {
    if (!mapUpdateQueued) {
      mapUpdateQueued = true;
      map.once("idle", () => {
        mapUpdateQueued = false;
        updateMap();
      });
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
    const p = e.features[0].properties;
    popup.setLngLat(e.lngLat)
      .setHTML(`<b>${displayName(e.features[0])}</b><br/>${typeIcon(p.facility_type)} ${p.facility_type} &middot; <span style="color:${bandColor(p.risk_score)};font-weight:700">${p.risk_score}</span>`)
      .addTo(map);
  });
  map.on("mouseleave", "facilities", () => { map.getCanvas().style.cursor = ""; popup.remove(); });
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
        <span class="ftype">${ftype}${osmId ? " · ID " + osmId : ""}</span>
        <span class="coords">${latStr} · ${lonStr}</span>
      </div>
      <h2>${displayName(feature)}</h2>
      <div class="loc">${stateName && stateName !== "Untagged Region" ? stateName + ", " : ""}${country}</div>

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
  // Update map size after CSS transition
  setTimeout(() => map.resize(), 260);
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

  host.innerHTML = sorted.map(f => {
    const p = f.properties; const s = p.risk_score;
    return `<div class="crit-row" data-id="${p.id}">
      <span class="d" style="background:${bandColor(s)}"></span>
      <span class="n" title="${displayName(f).replace(/"/g, '&quot;')}">${displayName(f)}</span>
      <span class="s">${s.toFixed(0)}</span>
    </div>`;
  }).join("");

  host.querySelectorAll(".crit-row").forEach(el => {
    el.addEventListener("click", () => {
      const f = filteredFeatures.find(ff => ff.properties.id === el.dataset.id);
      if (!f) return;
      host.querySelectorAll(".crit-row").forEach(r => r.classList.remove("active"));
      el.classList.add("active");
      map.flyTo({ center: f.geometry.coordinates, zoom: 13 });
      highlightFacility(f);
      renderDetail(f);
    });
  });
}

// ---- full-screen data table ----
let tableSortKey = "risk_score";
let tableSortAsc = false;
let tableSearchText = "";

function openDataTable() {
  const overlay = document.createElement("div");
  overlay.id = "data-overlay";
  overlay.innerHTML = buildTableHTML();
  document.body.appendChild(overlay);
  wireTableEvents(overlay);
}

function closeDataTable() {
  const el = document.getElementById("data-overlay");
  if (el) el.remove();
}

function buildTableHTML() {
  const features = getTableFeatures();
  const country = currentData?.metadata?.country || "";
  const state = activeFilters.state || "All Regions";
  return `
    <div class="overlay-backdrop"></div>
    <div class="overlay-panel">
      <div class="overlay-header">
        <div>
          <h2>All Facilities — ${country} ${state !== "All Regions" ? "/ " + state : ""}</h2>
          <p class="overlay-subtitle">${features.length} facilities | Sorted by ${tableSortKey.replace(/_/g, " ")} ${tableSortAsc ? "\u2191" : "\u2193"}</p>
        </div>
        <div class="overlay-controls">
          <input type="text" id="table-search" placeholder="Search table\u2026" value="${tableSearchText}" />
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
          <tbody>
            ${features.map((f, i) => {
              const p = f.properties;
              const s = p.risk_score;
              const drivers = typeof p.top_drivers === "string" ? JSON.parse(p.top_drivers) : (p.top_drivers || []);
              const recs = typeof p.recommendations === "string" ? JSON.parse(p.recommendations) : (p.recommendations || []);
              return `<tr data-id="${p.id}">
                <td>${i + 1}</td>
                <td class="name-cell" title="${displayName(f)}">${typeIcon(p.facility_type)} ${displayName(f)}</td>
                <td>${p.facility_type}</td>
                <td><span class="table-badge ${band(s)}">${s.toFixed(0)}</span></td>
                <td>${(drivers[0] || "").replace(/_/g, " ")}</td>
                <td>${recs.length ? recs[0].title : "\u2014"}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
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

function wireTableEvents(overlay) {
  overlay.querySelector("#btn-close-overlay").addEventListener("click", closeDataTable);
  overlay.querySelector(".overlay-backdrop").addEventListener("click", closeDataTable);
  overlay.querySelector("#table-search").addEventListener("input", e => {
    tableSearchText = e.target.value;
    refreshTable();
  });
  overlay.querySelectorAll("th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (tableSortKey === key) tableSortAsc = !tableSortAsc;
      else { tableSortKey = key; tableSortAsc = key === "name"; }
      refreshTable();
    });
  });
  overlay.querySelectorAll("tr[data-id]").forEach(tr => {
    tr.addEventListener("click", () => {
      const f = filteredFeatures.find(ff => ff.properties.id === tr.dataset.id);
      if (f) {
        closeDataTable();
        map.flyTo({ center: f.geometry.coordinates, zoom: 13 });
        highlightFacility(f);
        renderDetail(f);
      }
    });
  });
}

function refreshTable() {
  const overlay = document.getElementById("data-overlay");
  if (!overlay) return;
  overlay.innerHTML = buildTableHTML();
  wireTableEvents(overlay);
  overlay.querySelector("#table-search").focus();
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

  // Start the map fly animation immediately
  map.flyTo({ center: v.center, zoom: v.zoom });

  // --- 2. ASYNC DATA FETCH -----------------------------------------------
  const data = await loadAtlas(iso3);
  currentData = data;
  allFeatures = data.features || [];

  // --- 3. RE-RENDER with real data ---------------------------------------
  populateStates(allFeatures);
  updateSearchPlaceholder();
  applyFilters();

  // --- 4. BACKGROUND PREFETCH (first load only) --------------------------
  // Warm the cache so switching to the other two countries is instant.
  prefetchOtherCountries(iso3);
}

// ---- event wiring ----
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("country").addEventListener("change", e => switchCountry(e.target.value));
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

  // detail-panel close button
  const closeBtn = document.getElementById("btn-close-detail");
  if (closeBtn) closeBtn.addEventListener("click", closeDetail);

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
      // Close detail panel on Escape
      if (document.body.classList.contains("has-detail")) closeDetail();
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
  win.document.write(`<!doctype html><html><head><title>ChildClimate Atlas Report — ${m.country}</title>
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
    <h1>ChildClimate Risk Atlas — ${m.country}</h1>
    <p><b>Region:</b> ${m.focus_region} | <b>Facilities analyzed:</b> ${n} | <b>Average risk:</b> ${avg}/100</p>
    <p><b>Generated:</b> ${new Date().toLocaleDateString()} | <b>Pipeline v${m.pipeline_version || "0.1.0"}</b></p>

    <h2>Top 10 Most Critical Facilities</h2>
    <table>
      <tr><th>#</th><th>Facility</th><th>Type</th><th>Score</th><th>Top Driver</th><th>Priority Action</th></tr>
      ${top10.map((f, i) => {
        const p = f.properties;
        const recs = typeof p.recommendations === "string" ? JSON.parse(p.recommendations) : (p.recommendations || []);
        const drivers = typeof p.top_drivers === "string" ? JSON.parse(p.top_drivers) : (p.top_drivers || []);
        return `<tr>
          <td>${i + 1}</td>
          <td>${displayName(f)}</td>
          <td>${p.facility_type}</td>
          <td><span class="badge ${band(p.risk_score)}">${p.risk_score}</span></td>
          <td>${(drivers[0] || "").replace(/_/g, " ")}</td>
          <td>${recs.length ? recs[0].title : "\u2014"}</td>
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
