/* ChildClimate Risk Atlas — v2 frontend
   Full-featured: search, filters, legend, recommendations, export, charts. */

const VIEWS = {
  NGA: { center: [8.7, 9.1], zoom: 5.8 },     // full Nigeria
  BGD: { center: [90.3, 23.7], zoom: 6.8 },    // full Bangladesh
  GTM: { center: [-90.2, 15.8], zoom: 7.2 },   // full Guatemala
};

// ---- helpers ----
function band(s) { return s < 30 ? "low" : s < 55 ? "mid" : s < 75 ? "high" : "severe"; }
function bandLabel(s) { return s < 30 ? "Low" : s < 55 ? "Moderate" : s < 75 ? "High" : "Severe"; }
function bandColor(s) {
  const m = { low: "#2ecc71", mid: "#f1c40f", high: "#f0932b", severe: "#ff3333" };
  return m[band(s)];
}
function typeIcon(t) { return t === "hospital" ? "\u{1F3E5}" : t === "clinic" ? "\u{1FA7A}" : "\u{1F3EB}"; }
function displayName(f) {
  const p = f.properties || f;
  const name = p.name || "";
  // If facility has a real name, return it as-is (CSS handles truncation)
  if (name && !name.startsWith("Unnamed")) return name;
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
async function loadAtlas(iso3) {
  try {
    const r = await fetch(`./data/${iso3}.geojson`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch { return FALLBACK; }
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
  allOpt.innerHTML = 'All States / Regions';
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
      document.getElementById("state-btn").textContent = val || "All States / Regions";
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
  map.addSource("facilities", { type: "geojson", data: geojson });
  map.addLayer({
    id: "facilities-glow", type: "circle", source: "facilities",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 6, 10, 12, 14, 18],
      "circle-color": ["step", ["get", "risk_score"], "#2ecc71", 30, "#f1c40f", 55, "#f0932b", 75, "#ff3333"],
      "circle-blur": 0.8, "circle-opacity": 0.35,
    },
  });
  map.addLayer({
    id: "facilities", type: "circle", source: "facilities",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3, 10, 6, 14, 10],
      "circle-color": ["step", ["get", "risk_score"], "#2ecc71", 30, "#f1c40f", 55, "#f0932b", 75, "#ff3333"],
      "circle-stroke-color": "rgba(10,15,30,0.7)", "circle-stroke-width": 1.2,
    },
  });
  // Selected facility highlight — single ring, same color palette as the dots
  map.addSource("selected", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "selected-ring", type: "circle", source: "selected",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 12, 10, 18, 14, 24],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": [
        "step", ["get", "risk_score"],
        "#2ecc71", 30, "#f1c40f", 55, "#f0932b", 75, "#ff3333"
      ],
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
    <div class="stat"><div class="label">Total</div><div class="value">${n}</div></div>
    <div class="stat"><div class="label">Avg Risk</div><div class="value ${band(avg)}">${avg}</div></div>
    <div class="stat"><div class="label">High</div><div class="value high">${high}</div></div>
    <div class="stat"><div class="label">Severe</div><div class="value severe">${severe}</div></div>
  `;

  // distribution bar
  const pcts = { low: n ? low / n * 100 : 0, mid: n ? mid / n * 100 : 0, high: n ? high / n * 100 : 0, severe: n ? severe / n * 100 : 0 };
  document.getElementById("dist").innerHTML = `
    <div class="dist-bar">
      <div class="seg" style="width:${pcts.low}%;background:var(--low)"></div>
      <div class="seg" style="width:${pcts.mid}%;background:var(--mid)"></div>
      <div class="seg" style="width:${pcts.high}%;background:var(--high)"></div>
      <div class="seg" style="width:${pcts.severe}%;background:var(--severe)"></div>
    </div>
    <div class="dist-legend">
      <span>${low} low</span><span>${mid} mod</span><span>${high} high</span><span>${severe} severe</span>
    </div>
    <div style="font-size:10px;color:var(--muted);margin-top:8px">
      ${typeIcon("hospital")} ${hospitals} hospitals &nbsp; ${typeIcon("clinic")} ${clinics} clinics &nbsp; ${typeIcon("school")} ${schools} schools
    </div>
  `;
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
function renderDetail(feature) {
  const p = feature.properties;
  const s = p.risk_score;
  const b = band(s);
  const weights = currentData.metadata.scoring_weights || {};
  const comps = typeof p.risk_components === "string" ? JSON.parse(p.risk_components) : (p.risk_components || {});
  const climate = typeof p.climate === "string" ? JSON.parse(p.climate) : (p.climate || {});
  const air = typeof p.air === "string" ? JSON.parse(p.air) : (p.air || {});
  const recs = typeof p.recommendations === "string" ? JSON.parse(p.recommendations) : (p.recommendations || []);
  const coords = feature.geometry.coordinates;

  const barRows = Object.keys(weights).map(k => {
    const sub = comps[k] || 0;
    const pts = (100 * (weights[k] || 0) * sub).toFixed(1);
    return `<div class="bar-row">
      <div class="name">${k.replace(/_/g, " ")}</div>
      <div class="track"><div class="fill" style="width:${(sub*100).toFixed(0)}%;background:${bandColor(s)}"></div></div>
      <div class="pts">${pts}</div>
    </div>`;
  }).join("");

  const recHtml = recs.length ? recs.map(r => `
    <div class="rec">
      <div class="rec-head">
        <span class="rec-cat">${r.category}</span>
        <span class="rec-cost">\u2248 $${r.estimated_cost_usd}</span>
      </div>
      <div class="rec-title">${r.title}</div>
      <div class="rec-desc">${r.description}</div>
    </div>
  `).join("") : '<div style="color:var(--muted);font-size:11px">No specific recommendations at this risk level.</div>';

  document.getElementById("detail").className = "detail";
  document.getElementById("detail").innerHTML = `
    <h2>${typeIcon(p.facility_type)} ${displayName(feature)}</h2>
    <span class="ftype">${p.facility_type}</span>
    <div class="coords">${coords[1].toFixed(4)}\u00b0N, ${coords[0].toFixed(4)}\u00b0E</div>
    <div class="score-chip ${b}">
      <span class="num">${s.toFixed(0)}</span>
      <span class="lbl">${bandLabel(s)} Risk</span>
    </div>

    <div class="section-title">Risk Breakdown</div>
    <div class="bars">${barRows}</div>

    <div class="section-title">Climate &amp; Air Data</div>
    <div class="data-grid">
      <div class="item"><span class="k">Heat days</span><span class="v">${climate.heat_index_days ?? "\u2014"}/yr</span></div>
      <div class="item"><span class="k">Flood days</span><span class="v">${climate.heavy_precip_days ?? "\u2014"}/yr</span></div>
      <div class="item"><span class="k">Dry streak</span><span class="v">${climate.longest_dry_run_days ?? "\u2014"} days</span></div>
      <div class="item"><span class="k">PM2.5</span><span class="v">${air.pm25_avg_ugm3 ?? "\u2014"} \u00b5g/m\u00b3</span></div>
      <div class="item"><span class="k">NO\u2082</span><span class="v">${air.no2_avg_ugm3 ?? "\u2014"} \u00b5g/m\u00b3</span></div>
      <div class="item"><span class="k">PM2.5 exceed</span><span class="v">${air.pm25_exceed_hours_30d ?? "\u2014"}h/30d</span></div>
    </div>

    <div class="section-title">Recommended Actions</div>
    ${recHtml}
  `;
}

// ---- sidebar: top list ----
function renderTopList() {
  // Prioritize named facilities — they're actionable. Unnamed ones go to the bottom.
  const sorted = [...filteredFeatures].sort((a, b) => {
    const aName = a.properties.name || "";
    const bName = b.properties.name || "";
    const aUnnamed = !aName || aName.startsWith("Unnamed");
    const bUnnamed = !bName || bName.startsWith("Unnamed");
    if (aUnnamed !== bUnnamed) return aUnnamed ? 1 : -1; // named first
    return b.properties.risk_score - a.properties.risk_score;  // then by score
  }).slice(0, 10);
  if (!sorted.length) { document.getElementById("top-list").innerHTML = ""; return; }
  document.getElementById("top-list").innerHTML = `
    <h3>Most Critical Facilities</h3>
    ${sorted.map(f => {
      const p = f.properties; const s = p.risk_score;
      return `<div class="top-item" data-id="${p.id}">
        <div class="badge" style="background:${bandColor(s)}18;color:${bandColor(s)}">${s.toFixed(0)}</div>
        <div class="meta">
          <div class="name">${typeIcon(p.facility_type)} ${displayName(f)}</div>
          <div class="sub">${p.facility_type} \u00b7 ${bandLabel(s)}</div>
        </div>
      </div>`;
    }).join("")}
    <button class="btn primary" id="btn-view-all" style="width:100%;margin-top:12px">
      View All ${filteredFeatures.length} Facilities
    </button>
  `;
  document.querySelectorAll(".top-item").forEach(el => {
    el.addEventListener("click", () => {
      const f = filteredFeatures.find(ff => ff.properties.id === el.dataset.id);
      if (f) { map.flyTo({ center: f.geometry.coordinates, zoom: 13 }); highlightFacility(f); renderDetail(f); }
    });
  });
  const viewAllBtn = document.getElementById("btn-view-all");
  if (viewAllBtn) viewAllBtn.addEventListener("click", openDataTable);
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

  // show loading
  document.getElementById("detail").className = "detail empty";
  document.getElementById("detail").innerHTML = '<div class="loading"><div class="spinner"></div>Loading atlas\u2026</div>';

  map.flyTo({ center: v.center, zoom: v.zoom });
  const data = await loadAtlas(iso3);
  currentData = data;
  allFeatures = data.features || [];

  // Reset state filter and populate dropdown
  activeFilters.state = "";
  document.getElementById("state-btn").textContent = "All States / Regions";
  populateStates(allFeatures);
  updateSearchPlaceholder();

  applyFilters();

  document.getElementById("detail").innerHTML = '<span class="icon">\u{1f30d}</span>Click a facility on the map to see its full risk profile and recommended actions.';
}

// ---- event wiring ----
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("country").addEventListener("change", e => switchCountry(e.target.value));
  // State dropdown toggle
  document.getElementById("state-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("state-panel").classList.toggle("open");
  });
  document.getElementById("search").addEventListener("input", e => { activeFilters.search = e.target.value; applyFilters(); });

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
});

// ---- heatmap layer toggle ----
let heatmapVisible = false;

function toggleHeatmap() {
  heatmapVisible = !heatmapVisible;
  const btn = document.getElementById("btn-heatmap");
  if (heatmapVisible) {
    btn.classList.add("primary");
    if (!map.getLayer("heatmap")) {
      map.addLayer({
        id: "heatmap", type: "heatmap", source: "facilities",
        maxzoom: 14,
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "risk_score"], 0, 0, 100, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 14, 2],
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(0,0,0,0)", 0.2, "#2ecc71", 0.4, "#f1c40f", 0.6, "#f0932b", 0.8, "#ff3333", 1, "#c0392b"
          ],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 8, 14, 30],
          "heatmap-opacity": 0.7,
        },
      }, "facilities-glow");
    }
    map.setLayoutProperty("heatmap", "visibility", "visible");
  } else {
    btn.classList.remove("primary");
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
    <style>body{font-family:system-ui;max-width:800px;margin:40px auto;color:#1a1a2e;line-height:1.5}
    h1{font-size:22px;border-bottom:2px solid #4fb3ff;padding-bottom:8px}
    table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px}
    th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eee}
    th{background:#f7f8fa;font-weight:600}
    .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-weight:700;font-size:12px}
    .high{background:#fef0e2;color:#f0932b}.severe{background:#fde8e7;color:#ff3333}
    .mid{background:#fef9e2;color:#b8860b}.low{background:#e8f8f0;color:#2ecc71}
    .footer{margin-top:32px;font-size:11px;color:#888;border-top:1px solid #eee;padding-top:12px}
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
