/**
 * Athens Real Estate & Urban Analytics v1.0 - Frontend Controller (Layered Architecture)
 * Connects to REST API v1 endpoints:
 *  - GET  /api/v1/properties/evaluate
 *  - GET  /api/v1/neighborhoods/analytics
 *  - GET  /api/v1/macro/urban-audit?city=EL300
 *  - GET  /api/v1/gis/geocode?q=...
 *  - GET  /api/v1/gis/layers
 *  - GET  /api/v1/scenarios & POST /api/v1/scenarios
 *  - POST /api/v1/admin/sync
 */

const API_BASE =
  window.location.protocol === "file:"
    ? "http://127.0.0.1:8000/api/v1"
    : `${window.location.origin}/api/v1`;

let map = null;
let selectedMarker = null;
let radiusCircle = null;

// Layer groups
let heatmapLayerGroup = L.layerGroup();
let airbnbLayerGroup = L.layerGroup();
let gisLayerGroup = L.layerGroup();
let hazardLayerGroup = L.layerGroup();

// Cached state
let lastEvaluationResult = null;
let cachedGisLayers = null;
let cachedNeighborhoodAnalytics = null;
let cachedTopRecommendations = null;
let eurostatChartInstance = null;
let neighborhoodChartInstance = null;
let euBenchmarkChartInstance = null;
let poiDistributionChartInstance = null;

document.addEventListener("DOMContentLoaded", async () => {
  initLeafletMap();
  await Promise.all([
    loadMapLayersAndNeighborhoods(),
    loadTopRecommendations(),
    loadEurostatDashboard(),
    loadSavedScenarios(),
    runEvaluation(),
  ]);
});

function initLeafletMap() {
  map = L.map("athensMap", {
    center: [37.9755, 23.7325],
    zoom: 13,
    zoomControl: true,
    doubleClickZoom: false,
    preferCanvas: true,
  });

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Inside Airbnb &amp; Athens GIS',
    maxZoom: 19,
    className: "osm-dark-tiles",
  }).addTo(map);

  heatmapLayerGroup.addTo(map);
  hazardLayerGroup.addTo(map);
  airbnbLayerGroup.addTo(map);
  gisLayerGroup.addTo(map);

  map.on("click", selectMapPoint);
  map.on("dblclick", selectMapPoint);
  setTimeout(() => { if (map) map.invalidateSize(); }, 200);
}

function selectMapPoint(ev) {
  if (!ev || !ev.latlng) return;
  const lat = ev.latlng.lat.toFixed(4);
  const lon = ev.latlng.lng.toFixed(4);
  document.getElementById("inputLat").value = lat;
  document.getElementById("inputLon").value = lon;
  runEvaluation();
}

function normalizeGreek(str) {
  return (str || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function selectPreset(lat, lon, label) {
  document.getElementById("inputLat").value = Number(lat).toFixed(4);
  document.getElementById("inputLon").value = Number(lon).toFixed(4);
  document.getElementById("scenarioTitleInput").value = `Σενάριο: ${label}`;
  const dropdown = document.getElementById("geocodeDropdown");
  if (dropdown) dropdown.classList.add("hidden");
  const areaDropdown = document.getElementById("areaSearchDropdown");
  if (areaDropdown) areaDropdown.classList.add("hidden");
  map.flyTo([lat, lon], 15, { duration: 0.7 });
  runEvaluation();
}

function populateNeighborhoodDropdown(neighborhoods) {
  const sel = document.getElementById("neighborhoodSelect");
  if (!sel || !neighborhoods) return;
  const sorted = [...neighborhoods].sort((a, b) => a.name.localeCompare(b.name, "el"));
  sel.innerHTML = `<option value="">-- Επιλογή από τις 44 Γειτονιές Αθήνας (${sorted.length}) --</option>`;
  sorted.forEach((nb) => {
    if (nb.center_lat && nb.center_lon) {
      const opt = document.createElement("option");
      opt.value = `${nb.center_lat},${nb.center_lon},${nb.name}`;
      opt.textContent = `${nb.name} (${nb.total_airbnb_listings} Airbnb • €${nb.avg_purchase_price_sqm}/m² • ADR €${nb.avg_adr_eur})`;
      sel.appendChild(opt);
    }
  });
}

function onSelectNeighborhoodDropdown(val) {
  if (!val) return;
  const parts = val.split(",");
  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);
  const name = parts.slice(2).join(",");
  if (!isNaN(lat) && !isNaN(lon)) {
    selectPreset(lat, lon, name);
  }
}

let lastFilteredAreaMatches = [];

async function handleAreaSearchInput(rawVal) {
  const dropdown = document.getElementById("areaSearchDropdown");
  if (!dropdown) return;
  const q = normalizeGreek(rawVal);
  if (!q) {
    dropdown.classList.add("hidden");
    lastFilteredAreaMatches = [];
    return;
  }

  const matches = [];
  // 1. Instant client-side search across all 44 neighborhoods
  (cachedNeighborhoodAnalytics || []).forEach((nb) => {
    if (
      normalizeGreek(nb.name).includes(q) ||
      normalizeGreek(nb.name_en).includes(q)
    ) {
      matches.push({
        name: nb.name,
        subtitle: `Γειτονιά Αθήνας • ${nb.total_airbnb_listings} Airbnb • €${nb.avg_purchase_price_sqm}/m² • ADR €${nb.avg_adr_eur}`,
        badge: "Γειτονιά",
        lat: nb.center_lat,
        lon: nb.center_lon,
      });
    }
  });

  // 2. Instant search across 66 POIs (Museums, Restaurants, Metro, Landmarks)
  (cachedGisLayers?.athens_gis_pois?.features || []).forEach((feat) => {
    const p = feat.properties;
    const coords = feat.geometry.coordinates;
    if (normalizeGreek(p.name).includes(q) || normalizeGreek(p.name_en).includes(q)) {
      matches.push({
        name: p.name,
        subtitle: `Athens GIS POI (${p.subtype || p.category})`,
        badge: p.category.toUpperCase(),
        lat: coords[1],
        lon: coords[0],
      });
    }
  });

  lastFilteredAreaMatches = matches;
  dropdown.innerHTML = "";

  if (matches.length === 0) {
    dropdown.innerHTML = `<div class="p-2.5 text-slate-400">Αναζήτηση "${rawVal}" μέσω Geocoding API...</div>`;
    dropdown.classList.remove("hidden");
    try {
      const resp = await fetch(`${API_BASE}/gis/geocode?q=${encodeURIComponent(rawVal)}`);
      const data = await resp.json();
      const apiResults = data.results || [];
      dropdown.innerHTML = "";
      if (apiResults.length === 0) {
        dropdown.innerHTML = `<div class="p-2.5 text-slate-400">Δεν βρέθηκε περιοχή για "${rawVal}"</div>`;
      } else {
        lastFilteredAreaMatches = apiResults;
        apiResults.forEach((item) => {
          const row = document.createElement("div");
          row.className = "p-2.5 hover:bg-slate-800 cursor-pointer transition flex items-center justify-between";
          row.onclick = () => selectPreset(item.lat, item.lon, item.name);
          row.innerHTML = `
            <div>
              <div class="font-bold text-white">${item.name}</div>
              <div class="text-[10px] text-slate-400">${item.source}</div>
            </div>
            <span class="text-[10px] px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300">${item.type}</span>
          `;
          dropdown.appendChild(row);
        });
      }
    } catch (e) {
      console.error(e);
    }
    return;
  }

  matches.slice(0, 10).forEach((m) => {
    const row = document.createElement("div");
    row.className = "p-2.5 hover:bg-slate-800 cursor-pointer transition flex items-center justify-between";
    row.onclick = () => {
      document.getElementById("areaSearchInput").value = m.name;
      selectPreset(m.lat, m.lon, m.name);
    };
    row.innerHTML = `
      <div>
        <div class="font-bold text-white">${m.name}</div>
        <div class="text-[10px] text-slate-400">${m.subtitle}</div>
      </div>
      <span class="text-[10px] px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-semibold">${m.badge}</span>
    `;
    dropdown.appendChild(row);
  });
  dropdown.classList.remove("hidden");
}

function triggerFirstAreaMatch() {
  if (lastFilteredAreaMatches && lastFilteredAreaMatches.length > 0) {
    const first = lastFilteredAreaMatches[0];
    selectPreset(first.lat, first.lon, first.name);
  }
}

async function runGeocodeSearch() {
  const input = document.getElementById("geocodeInput");
  const dropdown = document.getElementById("geocodeDropdown");
  if (!input || !dropdown) return;
  const q = input.value.trim();
  if (!q) {
    dropdown.classList.add("hidden");
    return;
  }

  try {
    const resp = await fetch(`${API_BASE}/gis/geocode?q=${encodeURIComponent(q)}`);
    const data = await resp.json();
    const results = data.results || [];
    dropdown.innerHTML = "";

    if (results.length === 0) {
      dropdown.innerHTML = `<div class="p-2.5 text-slate-400">Δεν βρέθηκαν αποτελέσματα για "${q}"</div>`;
    } else {
      results.forEach((item) => {
        const row = document.createElement("div");
        row.className = "p-2.5 hover:bg-slate-800 cursor-pointer transition flex items-center justify-between";
        row.onclick = () => selectPreset(item.lat, item.lon, item.name);
        row.innerHTML = `
          <div>
            <div class="font-bold text-white">${item.name}</div>
            <div class="text-[10px] text-slate-400">${item.source}</div>
          </div>
          <span class="text-[10px] px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300">${item.type}</span>
        `;
        dropdown.appendChild(row);
      });
    }
    dropdown.classList.remove("hidden");
  } catch (err) {
    console.error("Geocode error:", err);
  }
}

async function loadMapLayersAndNeighborhoods() {
  try {
    const [layersResp, nbResp] = await Promise.all([
      fetch(`${API_BASE}/gis/layers`),
      fetch(`${API_BASE}/neighborhoods/analytics`),
    ]);
    const layersJson = await layersResp.json();
    const nbJson = await nbResp.json();

    cachedGisLayers = layersJson.layers;
    cachedNeighborhoodAnalytics = nbJson.neighborhoods || [];

    populateNeighborhoodDropdown(cachedNeighborhoodAnalytics);
    renderMapGeoJSONLayers();
    renderNeighborhoodComparisonChart(cachedNeighborhoodAnalytics);
  } catch (err) {
    console.error("Failed loading GIS layers:", err);
  }
}

function renderMapGeoJSONLayers() {
  heatmapLayerGroup.clearLayers();
  airbnbLayerGroup.clearLayers();
  gisLayerGroup.clearLayers();
  hazardLayerGroup.clearLayers();

  if (!cachedGisLayers) return;

  // 1. Gentrification & Saturation Heatmap Polygons (44 Official Athens Neighborhoods)
  if (cachedNeighborhoodAnalytics && cachedNeighborhoodAnalytics.length > 0) {
    cachedNeighborhoodAnalytics.forEach((nb) => {
      if (!nb.geometry) return;
      const geoLayer = L.geoJSON(
        { type: "Feature", properties: nb, geometry: nb.geometry },
        {
          style: {
            color: nb.heatmap_color,
            weight: 1.5,
            fillColor: nb.heatmap_color,
            fillOpacity: 0.17,
          },
        }
      );
      // Hover tooltip shows neighborhood stats; single or double click selects the exact point!
      geoLayer.bindTooltip(
        `<div class="text-xs"><b>${nb.name}</b><br/>Κορεσμός: ${nb.listings_per_1000_residents}/1k κατ. | ADR: €${nb.avg_adr_eur} | Αγορά: €${nb.avg_purchase_price_sqm}/m²<br/><span style="color:#38bdf8">Κλικ/Διπλό Κλικ για επιλογή σημείου</span></div>`,
        { sticky: true }
      );
      geoLayer.on("click", selectMapPoint);
      geoLayer.on("dblclick", selectMapPoint);
      heatmapLayerGroup.addLayer(geoLayer);
    });
  }

  // 2. Natural Hazards Polygons (Flood Zones & Urban Heat Island)
  const hazards = cachedGisLayers.athens_gis_hazards?.features || [];
  hazards.forEach((feat) => {
    const props = feat.properties;
    const isFlood = props.hazard_type === "flood_zone";
    const color = isFlood ? "#f43f5e" : "#f59e0b";
    const layer = L.geoJSON(feat, {
      style: {
        color: color,
        weight: 2,
        dashArray: "6, 4",
        fillColor: color,
        fillOpacity: 0.28,
      },
    });
    layer.bindTooltip(
      `<div class="text-xs"><b>⚠️ ${props.name}</b> (${props.severity}, -${props.penalty_points} pts)<br/>${props.recommendation}</div>`,
      { sticky: true }
    );
    layer.on("click", selectMapPoint);
    layer.on("dblclick", selectMapPoint);
    hazardLayerGroup.addLayer(layer);
  });

  // 3. Inside Airbnb Real Listings Pins (1,895 stratified across Athens from 14,171 census)
  renderAirbnbMarkersOnMap();

  // 4. Athens GIS POIs (66 Metro Stations, Museums, Restaurant Hubs, Landmarks & Parks)
  const pois = cachedGisLayers.athens_gis_pois?.features || [];
  const poiStyleMap = {
    metro: { color: "#38bdf8", radius: 7, badge: "🚇 Σταθμός Μετρό/ΗΣΑΠ", textClass: "text-sky-400" },
    museum: { color: "#c084fc", radius: 6.5, badge: "🏛️ Μουσείο / Αρχαιολογικός Χώρος", textClass: "text-purple-400" },
    restaurant: { color: "#fbbf24", radius: 6.5, badge: "🍽️ Εστιατόρια & Γαστρονομία", textClass: "text-amber-400" },
    landmark: { color: "#34d399", radius: 6, badge: "🌿 Αξιοθέατο / Πάρκο / Θέα", textClass: "text-emerald-400" },
  };
  pois.forEach((feat) => {
    const coords = feat.geometry.coordinates;
    const p = feat.properties;
    const cfg = poiStyleMap[p.category] || poiStyleMap.landmark;
    const isTransit = p.category === "metro";
    const transitBadge =
      p.transit_mode === "tram"
        ? "🚊 Στάση Τραμ"
        : p.transit_mode === "isap"
        ? "🚆 Σταθμός ΗΣΑΠ (Ηλεκτρικός)"
        : p.transit_mode === "interchange"
        ? "🔁 Σταθμός Μετεπιβίβασης"
        : cfg.badge;
    const marker = L.circleMarker([coords[1], coords[0]], {
      radius: isTransit && p.transit_mode === "tram" ? 5.5 : cfg.radius,
      fillColor: (isTransit && p.line_color) || cfg.color,
      color: p.transit_mode === "interchange" ? "#ffffff" : "#0f172a",
      weight: 2,
      fillOpacity: 0.95,
    });
    marker.bindPopup(`
      <div class="text-xs space-y-1 p-1">
        <div class="text-[10px] uppercase font-bold ${cfg.textClass}">${isTransit ? transitBadge : cfg.badge}</div>
        <div class="font-bold text-white">${p.name}</div>
        ${p.subtype ? `<div class="text-slate-300">Κατηγορία: <b>${p.subtype}</b></div>` : ""}
        ${p.venue_count ? `<div class="text-amber-300">Χώροι Εστίασης/Μπαρ: <b>~${p.venue_count} καταστήματα</b></div>` : ""}
        ${p.cuisine_profile ? `<div class="text-slate-400 italic">${p.cuisine_profile}</div>` : ""}
        ${p.lines ? `<div>Γραμμές: <b>${p.lines.join(", ")}</b></div>` : ""}
      </div>
    `);
    gisLayerGroup.addLayer(marker);
  });

  updateMapLayers();
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000.0;
  const toRad = (d) => (d * Math.PI) / 180.0;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function renderAirbnbMarkersOnMap() {
  airbnbLayerGroup.clearLayers();
  if (!cachedGisLayers) return;

  const allListings = cachedGisLayers.airbnb_listings?.features || [];
  if (!allListings.length) return;

  const userLat = parseFloat(document.getElementById("inputLat")?.value) || 37.9648;
  const userLon = parseFloat(document.getElementById("inputLon")?.value) || 23.7265;
  const userRadius = parseFloat(document.getElementById("inputRadius")?.value) || 600;
  const userRooms = parseInt(document.getElementById("inputRooms")?.value || "2", 10);

  const roomFilter = document.getElementById("airbnbRoomFilter")?.value || "similar";
  const sortFilter = document.getElementById("airbnbSortFilter")?.value || "top_rated";
  const limitVal = parseInt(document.getElementById("airbnbLimitFilter")?.value || "800", 10);

  const enriched = allListings.map((feat) => {
    const coords = feat.geometry.coordinates;
    const p = feat.properties;
    const distM = Math.round(haversineMeters(userLat, userLon, coords[1], coords[0]));
    const inRadius = distM <= userRadius;
    const sameRooms = userRooms >= 3 ? p.rooms >= 3 : p.rooms === userRooms;
    const annualRev = p.estimated_annual_revenue || Math.round(p.price * 365 * p.occupancy_rate);
    return { feat, coords, p, distM, inRadius, sameRooms, annualRev };
  });

  // 1. Apply Room / Similarity / Radius Filter
  let filtered = enriched.filter((it) => {
    if (roomFilter === "similar") return it.sameRooms;
    if (roomFilter === "similar_radius") return it.sameRooms && it.inRadius;
    if (roomFilter === "in_radius") return it.inRadius;
    if (roomFilter === "1") return it.p.rooms === 1;
    if (roomFilter === "2") return it.p.rooms === 2;
    if (roomFilter === "3") return it.p.rooms >= 3;
    return true;
  });

  // Fallback if radius has 0 matches (e.g. out-of-bounds click)
  if (filtered.length === 0) {
    filtered = enriched.filter((it) => (roomFilter.includes("similar") ? it.sameRooms : true));
  }

  // 2. Apply Quality / Review / Price Segment Filter
  let qualFiltered = filtered.filter((it) => {
    const p = it.p;
    if (sortFilter === "top_rated") return p.review_scores_rating >= 4.80 && p.number_of_reviews >= 15;
    if (sortFilter === "most_reviewed") return p.number_of_reviews >= 80;
    if (sortFilter === "superhost") return Boolean(p.host_is_superhost);
    if (sortFilter === "high_roi") return p.occupancy_rate >= 0.55 || it.annualRev >= 22000;
    if (sortFilter === "budget") return p.price <= 85;
    if (sortFilter === "luxury") return p.price >= 150;
    return true;
  });

  if (qualFiltered.length === 0) {
    qualFiltered = filtered;
  }

  // 3. Sort so direct competitors in radius & highest quality appear first
  qualFiltered.sort((a, b) => {
    const aDirect = a.inRadius && a.sameRooms ? 1 : 0;
    const bDirect = b.inRadius && b.sameRooms ? 1 : 0;
    if (aDirect !== bDirect) return bDirect - aDirect;

    if (sortFilter === "top_rated" || sortFilter === "superhost") {
      return (
        b.p.review_scores_rating * 120 +
        Math.min(250, b.p.number_of_reviews) -
        (a.p.review_scores_rating * 120 + Math.min(250, a.p.number_of_reviews))
      );
    }
    if (sortFilter === "most_reviewed") return b.p.number_of_reviews - a.p.number_of_reviews;
    if (sortFilter === "high_roi") return b.annualRev - a.annualRev;
    if (sortFilter === "budget") return a.p.price - b.p.price;
    if (sortFilter === "luxury") return b.p.price - a.p.price;
    return b.p.number_of_reviews - a.p.number_of_reviews;
  });

  const displayed = qualFiltered.slice(0, limitVal);
  let directCompetitorsCount = 0;

  displayed.forEach((it) => {
    const { coords, p, distM, inRadius, sameRooms, annualRev } = it;
    const isDirectCompetitor = inRadius && sameRooms;
    if (isDirectCompetitor) directCompetitorsCount += 1;

    const marker = L.circleMarker([coords[1], coords[0]], {
      radius: isDirectCompetitor ? 6.2 : p.review_scores_rating >= 4.9 ? 4.8 : 4.0,
      fillColor: isDirectCompetitor ? "#facc15" : p.host_is_superhost ? "#06b6d4" : "#38bdf8",
      color: isDirectCompetitor ? "#713f12" : "#083344",
      weight: isDirectCompetitor ? 2 : 1,
      fillOpacity: isDirectCompetitor ? 0.96 : 0.82,
    });

    marker.bindPopup(`
      <div class="text-xs space-y-1 p-1 min-w-[210px]">
        <div class="flex items-center justify-between gap-1">
          <span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${
            isDirectCompetitor
              ? "bg-amber-500/25 text-amber-300 border border-amber-500/40"
              : "bg-cyan-500/20 text-cyan-300"
          }">
            ${isDirectCompetitor ? "🎯 Άμεσος Ανταγωνιστής" : `🏠 ${p.rooms} ΥΔ • ${p.neighbourhood}`}
          </span>
          ${p.host_is_superhost ? `<span class="text-[10px] font-bold text-emerald-300">🏅 Superhost</span>` : ""}
        </div>
        <div class="font-bold text-white leading-snug">${p.name}</div>
        <div class="text-slate-300">Γειτονιά: <b>${p.neighbourhood}</b> • <b>${p.rooms} ΥΔ</b> (${p.accommodates || p.rooms * 2} άτομα)</div>
        <div>Τιμή: <b class="text-cyan-300">€${p.price}/βραδιά</b> • Πληρότητα: <b class="text-emerald-300">${(p.occupancy_rate * 100).toFixed(0)}%</b></div>
        <div>Εκτ. Έσοδο: <b class="text-amber-300">€${annualRev.toLocaleString("el-GR")}/έτος</b> • Απόσταση: <b>${distM}m</b></div>
        <div>Κριτικές: ⭐ <b>${p.review_scores_rating}</b> (${p.number_of_reviews} reviews)</div>
        <button onclick="selectPreset(${coords[1]}, ${coords[0]}, '${(p.neighbourhood || "Αθήνα").replace(/'/g, "\\'")}')" class="mt-1 w-full py-1 px-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[10px] transition">
          📍 Αξιολόγηση αυτού του σημείου
        </button>
      </div>
    `);
    airbnbLayerGroup.addLayer(marker);
  });

  const badgeEl = document.getElementById("airbnbFilterSummaryBadge");
  if (badgeEl) {
    badgeEl.innerHTML = `Εμφανίζονται <b>${displayed.length}</b> / ${allListings.length} δείγματα (Απογραφή: <b>14.171</b>) &bull; <span class="text-amber-300">🎯 ${directCompetitorsCount} άμεσοι ανταγωνιστές (${userRooms}ΥΔ εντός ${userRadius}m)</span>`;
  }
  const toggleLabelEl = document.getElementById("toggleAirbnbLabel");
  if (toggleLabelEl) {
    toggleLabelEl.textContent = `Airbnb (${displayed.length} / 14.171)`;
  }
}

function updateMapLayers() {
  toggleLayer(heatmapLayerGroup, document.getElementById("toggleHeatmap").checked);
  toggleLayer(airbnbLayerGroup, document.getElementById("toggleAirbnb").checked);
  toggleLayer(gisLayerGroup, document.getElementById("toggleGIS").checked);
  toggleLayer(hazardLayerGroup, document.getElementById("toggleHazards").checked);
}

function toggleLayer(group, visible) {
  if (visible) {
    if (!map.hasLayer(group)) map.addLayer(group);
  } else {
    if (map.hasLayer(group)) map.removeLayer(group);
  }
}

async function runEvaluation() {
  const lat = parseFloat(document.getElementById("inputLat").value) || 37.9648;
  const lon = parseFloat(document.getElementById("inputLon").value) || 23.7265;
  const radius = parseFloat(document.getElementById("inputRadius").value) || 600;
  const rooms = parseInt(document.getElementById("inputRooms").value, 10) || 2;
  const costVal = document.getElementById("inputCost")?.value;

  updateSelectedPinOnMap(lat, lon, radius);
  renderAirbnbMarkersOnMap();

  try {
    let url = `${API_BASE}/properties/evaluate?lat=${lat}&lon=${lon}&radius=${radius}&rooms=${rooms}`;
    if (costVal && parseFloat(costVal) > 0) {
      url += `&acquisition_cost=${parseFloat(costVal)}`;
    }
    const resp = await fetch(url);
    const data = await resp.json();
    lastEvaluationResult = data;
    renderEvaluationSidePanel(data);
  } catch (err) {
    console.error("Error evaluating property:", err);
  }
}

function updateSelectedPinOnMap(lat, lon, radius) {
  if (selectedMarker) map.removeLayer(selectedMarker);
  if (radiusCircle) map.removeLayer(radiusCircle);

  selectedMarker = L.marker([lat, lon]).addTo(map);
  selectedMarker
    .bindPopup(
      `<div class="text-xs font-bold text-indigo-300">📍 Επιλεγμένο Ακίνητο<br/>(${lat.toFixed(4)}, ${lon.toFixed(4)})</div>`
    )
    .openPopup();

  radiusCircle = L.circle([lat, lon], {
    radius: radius,
    color: "#6366f1",
    weight: 2,
    fillColor: "#6366f1",
    fillOpacity: 0.14,
  }).addTo(map);
}

function renderEvaluationSidePanel(data) {
  if (!data || data.status !== "success") return;

  const loc = data.location_context;
  const rating = data.investment_rating;
  const roi = data.airbnb_roi_metrics;
  const gis = data.gis_spatial_analysis;

  document.getElementById("evalNeighborhoodBadge").textContent = `${loc.neighbourhood} (${loc.neighbourhood_total_listings || 0} Airbnb)`;
  document.getElementById(
    "evalLocationTitle"
  ).textContent = `${loc.neighbourhood} (${data.query.lat.toFixed(4)}, ${data.query.lon.toFixed(4)})`;
  document.getElementById(
    "evalGentrificationTrend"
  ).textContent = `Τάση: ${loc.gentrification_trend} • Σ.Δ.: ${loc.zone_building_factor} • Αγορά: €${loc.avg_purchase_price_sqm}/m²`;

  const scoreEl = document.getElementById("evalScoreValue");
  scoreEl.textContent = rating.score.toFixed(1);
  scoreEl.className =
    rating.score >= 80
      ? "text-3xl font-extrabold text-emerald-400"
      : rating.score >= 65
      ? "text-3xl font-extrabold text-amber-400"
      : "text-3xl font-extrabold text-rose-400";

  document.getElementById("evalGradeText").textContent = rating.grade;

  const b = rating.breakdown;
  document.getElementById("scoreTransit").textContent = `${b.transit_accessibility_score} / 30`;
  document.getElementById("scoreYield").textContent = `${b.airbnb_yield_score} / 35`;
  document.getElementById("scoreAmenity").textContent = `${b.urban_amenities_score} / 20`;
  if (document.getElementById("scoreMacro")) {
    document.getElementById("scoreMacro").textContent = `${b.macro_resilience_score} / 15`;
  }

  const hazEl = document.getElementById("scoreHazardPenalty");
  if (b.natural_hazard_penalty < 0) {
    hazEl.textContent = `${b.natural_hazard_penalty} pts`;
    hazEl.className = "font-bold text-rose-400 mt-0.5";
  } else {
    hazEl.textContent = "0 Ποινή";
    hazEl.className = "font-bold text-emerald-400 mt-0.5";
  }

  const eqEl = document.getElementById("scoreLiveEquation");
  if (eqEl) {
    const penAbs = Math.abs(b.natural_hazard_penalty || 0);
    eqEl.textContent = `${b.transit_accessibility_score} + ${b.airbnb_yield_score} + ${b.urban_amenities_score} + ${b.macro_resilience_score} - ${penAbs} = ${rating.score.toFixed(1)} / 100`;
  }

  // Update Dynamic Per-Neighborhood Index Chart (Chart 1)
  if (loc.neighborhood_index_series) {
    renderDynamicNeighborhoodIndexChart(loc.neighborhood_index_series, loc);
  }

  document.getElementById("evalCompetitorCount").textContent = loc.is_out_of_zone
    ? "0 ανταγωνιστές (Εκτός Ζώνης)"
    : roi.used_nearest_fallback
    ? `Κοντινότερα ${roi.sample_size_used} καταλύματα Αθήνας`
    : `${roi.competitors_in_radius} ανταγωνιστές εντός ${data.query.radius_m}m`;

  document.getElementById(
    "kpiAnnualRevenue"
  ).textContent = `€${roi.estimated_annual_gross_revenue_eur.toLocaleString("el-GR")}`;
  document.getElementById(
    "kpiNetIncome"
  ).textContent = `Καθαρό: €${roi.estimated_annual_net_income_eur.toLocaleString("el-GR")}/έτος`;
  document.getElementById("kpiAdr").textContent = `€${roi.average_daily_rate_eur.toFixed(2)}`;
  document.getElementById(
    "kpiOccupancy"
  ).textContent = `Πληρότητα: ${roi.occupancy_rate_pct}% (${roi.occupied_nights_per_year} νύχτες)`;
  document.getElementById("kpiGrossRoi").textContent = `${roi.gross_roi_yield_pct}% Gross ROI`;
  document.getElementById(
    "kpiPayback"
  ).textContent = `Net ROI: ${roi.net_roi_yield_pct}% (~${roi.payback_period_years} έτη)`;

  document.getElementById(
    "kpiLongTermRent"
  ).textContent = `€${roi.long_term_annual_rent_eur.toLocaleString("el-GR")}/έτος (Κτήση: €${roi.estimated_acquisition_cost_eur.toLocaleString("el-GR")})`;
  const sign = roi.str_vs_long_term_premium_pct >= 0 ? "+" : "";
  document.getElementById(
    "kpiStrPremium"
  ).textContent = `${sign}${roi.str_vs_long_term_premium_pct}% vs Μακροχρόνια`;

  // 1. Nearest Metro, Museum, Restaurant Hub, Landmark
  if (gis.nearest_metro && document.getElementById("gisNearestMetroName")) {
    document.getElementById("gisNearestMetroName").textContent = gis.nearest_metro.name;
    document.getElementById(
      "gisNearestMetroDist"
    ).textContent = `${gis.nearest_metro.distance_m} m (~${gis.nearest_metro.walking_minutes} λεπτά περπάτημα)`;
  }
  if (gis.nearest_museum && document.getElementById("gisNearestMuseumName")) {
    document.getElementById("gisNearestMuseumName").textContent = gis.nearest_museum.name;
    document.getElementById(
      "gisNearestMuseumDist"
    ).textContent = `${gis.nearest_museum.distance_m} m (~${gis.nearest_museum.walking_minutes} λεπτά περπάτημα)`;
  }
  if (gis.nearest_restaurant_hub && document.getElementById("gisNearestRestaurantName")) {
    document.getElementById("gisNearestRestaurantName").textContent =
      gis.nearest_restaurant_hub.name;
    const venues = gis.nearest_restaurant_hub.venue_count || 35;
    document.getElementById(
      "gisNearestRestaurantDist"
    ).textContent = `${gis.nearest_restaurant_hub.distance_m} m (~${gis.nearest_restaurant_hub.walking_minutes}') • ~${venues} χώροι εστίασης`;
  }
  if (gis.nearest_landmark && document.getElementById("gisNearestLandmarkName")) {
    document.getElementById("gisNearestLandmarkName").textContent = gis.nearest_landmark.name;
    document.getElementById(
      "gisNearestLandmarkDist"
    ).textContent = `${gis.nearest_landmark.distance_m} m (~${gis.nearest_landmark.walking_minutes} λεπτά περπάτημα)`;
  }

  // 2. POI Distribution (Restaurants, Museums, Landmarks, Metro)
  const dist = gis.poi_distribution;
  if (dist) {
    const catchmentEl = document.getElementById("poiCatchmentBadge");
    if (catchmentEl) {
      catchmentEl.textContent = `Ακτίνα ${dist.catchment_radius_m}m (${dist.total_pois_in_catchment} POIs)`;
    }
    const diningEl = document.getElementById("poiDiningVenuesBadge");
    if (diningEl) {
      diningEl.textContent = `🍽️ ~${dist.estimated_dining_venues_count} Εστιατόρια/Μπαρ`;
    }

    const statsContainer = document.getElementById("poiDistributionStats");
    if (statsContainer) {
      const total = Math.max(1, dist.total_pois_in_catchment);
      const rows = [
        {
          label: "🍽️ Πιάτσες Εστίασης",
          count: `${dist.restaurant_hubs_count} ζώνες (~${dist.estimated_dining_venues_count} μαγαζιά)`,
          pct: Math.min(100, Math.round((dist.restaurant_hubs_count / total) * 100)),
          barClass: "bg-amber-400",
        },
        {
          label: "🏛️ Μουσεία & Αρχ. Χώροι",
          count: `${dist.museums_count} μουσεία`,
          pct: Math.min(100, Math.round((dist.museums_count / total) * 100)),
          barClass: "bg-purple-400",
        },
        {
          label: "🌿 Αξιοθέατα & Πάρκα",
          count: `${dist.landmarks_count} σημεία`,
          pct: Math.min(100, Math.round((dist.landmarks_count / total) * 100)),
          barClass: "bg-emerald-400",
        },
        {
          label: "🚇 Σταθμοί Μετρό/ΗΣΑΠ",
          count: `${dist.metro_stations_count} σταθμοί`,
          pct: Math.min(100, Math.round((dist.metro_stations_count / total) * 100)),
          barClass: "bg-sky-400",
        },
      ];
      statsContainer.innerHTML = rows
        .map(
          (r) => `
          <div>
            <div class="flex justify-between text-[11px]">
              <span class="text-slate-300 font-medium">${r.label}</span>
              <span class="font-bold text-white">${r.count}</span>
            </div>
            <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mt-0.5">
              <div class="${r.barClass} h-full rounded-full" style="width:${r.pct > 0 ? Math.max(8, r.pct) : 0}%"></div>
            </div>
          </div>
        `
        )
        .join("");
    }

    const poiCanvas = document.getElementById("poiDistributionChart");
    if (poiCanvas) {
      const ctxPoi = poiCanvas.getContext("2d");
      if (poiDistributionChartInstance) poiDistributionChartInstance.destroy();
      const counts = dist.chart_hub_counts || [
        dist.restaurant_hubs_count,
        dist.museums_count,
        dist.landmarks_count,
        dist.metro_stations_count,
      ];
      poiDistributionChartInstance = new Chart(ctxPoi, {
        type: "doughnut",
        data: {
          labels: ["Εστιατόρια", "Μουσεία", "Αξιοθέατα", "Μετρό"],
          datasets: [
            {
              data: counts.every((v) => v === 0) ? [1, 1, 1, 1] : counts,
              backgroundColor: ["#fbbf24", "#c084fc", "#34d399", "#38bdf8"],
              borderColor: "#0f172a",
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "62%",
          plugins: {
            legend: { display: false },
          },
        },
      });
    }
  }

  // 3. Top Closest Places of Interest Pills
  const nearbyListEl = document.getElementById("nearbyPoisList");
  if (nearbyListEl) {
    const iconMap = {
      museum: "🏛️",
      restaurant: "🍽️",
      landmark: "🌿",
      metro: "🚇",
    };
    const nearbyPois = gis.nearby_places_of_interest || [];
    nearbyListEl.innerHTML = nearbyPois
      .map(
        (p) => `
        <span class="text-[11px] px-2 py-1 rounded-lg bg-slate-800/90 border border-slate-700 text-slate-200 flex items-center gap-1">
          <span>${iconMap[p.category] || "📍"}</span>
          <span class="font-medium">${p.name}</span>
          <span class="text-cyan-300 font-bold">${p.distance_m}m</span>
        </span>
      `
      )
      .join("");
  }

  // 4. Eurostat Quality of Life (urb_percep EL001C) Neighborhood Assessment
  const qol = data.quality_of_life_metrics || loc.quality_of_life;
  if (qol) {
    const qolBadge = document.getElementById("qolCompositeBadge");
    if (qolBadge) qolBadge.textContent = `${qol.composite_qol_score}%`;

    const qolDiff = document.getElementById("qolDiffBadge");
    if (qolDiff) {
      const d = Number(qol.vs_athens_average_diff || 0);
      const sign = d >= 0 ? "+" : "";
      qolDiff.textContent = `${sign}${d.toFixed(1)}% vs Αθήνα (${qol.athens_eurostat_baseline_pct}%)`;
      qolDiff.className = `text-[10px] font-bold ${
        d >= 0 ? "text-emerald-300" : "text-amber-300"
      }`;
    }

    const qolGrade = document.getElementById("qolGradeLabel");
    if (qolGrade) {
      qolGrade.textContent = `${qol.qol_grade} • Πηγή: ${qol.source_dataset}`;
    }

    const qolList = document.getElementById("qolDimensionsList");
    if (qolList && Array.isArray(qol.dimensions)) {
      qolList.innerHTML = qol.dimensions
        .map((dim) => {
          const val = Number(dim.neighborhood_score_pct || 0);
          const base = Number(dim.eurostat_athens_pct || 50);
          const diff = val - base;
          const barColor =
            val >= 70
              ? "bg-emerald-400"
              : val >= 50
              ? "bg-cyan-400"
              : "bg-amber-400";
          return `
            <div class="space-y-0.5">
              <div class="flex items-center justify-between text-[11px]">
                <span class="text-slate-200 font-medium">${dim.label} <span class="text-[9px] text-slate-500 font-mono">(${dim.code})</span></span>
                <span class="font-bold text-white">
                  ${val.toFixed(1)}%
                  <span class="text-[10px] font-normal ${
                    diff >= 0 ? "text-emerald-400" : "text-amber-400"
                  }">(Αθήνα EL001C: ${base}%)</span>
                </span>
              </div>
              <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden relative">
                <div class="${barColor} h-full rounded-full transition-all duration-300" style="width:${Math.min(
            100,
            Math.max(10, val)
          )}%"></div>
              </div>
            </div>
          `;
        })
        .join("");
    }
  }

  const alertBox = document.getElementById("hazardAlertBox");
  const alertIcon = document.getElementById("hazardAlertIcon");
  const alertTitle = document.getElementById("hazardAlertTitle");
  const alertDesc = document.getElementById("hazardAlertDesc");

  if (gis.is_in_hazard_zone && gis.natural_hazards_detected.length > 0) {
    const hz = gis.natural_hazards_detected[0];
    alertBox.className =
      "p-3 rounded-xl bg-rose-950/60 border border-rose-500/60 text-xs flex items-start gap-3";
    alertIcon.textContent = "🚨";
    alertTitle.className = "font-bold text-rose-300";
    alertTitle.textContent = `ΠΡΟΕΙΔΟΠΟΙΗΣΗ: ${hz.name} (${hz.severity})`;
    alertDesc.textContent = hz.recommendation;
  } else {
    alertBox.className =
      "p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/40 text-xs flex items-start gap-3";
    alertIcon.textContent = "✅";
    alertTitle.className = "font-bold text-emerald-300";
    alertTitle.textContent = "Εκτός Ζώνης Φυσικών Κινδύνων (Athens GIS)";
    alertDesc.textContent =
      "Το επιλεγμένο σημείο δεν εμπίπτει σε καταγεγραμμένη ζώνη πλημμυρικού κινδύνου ή έντονης θερμικής νησίδας.";
  }

  const tbody = document.getElementById("competitorsTableBody");
  tbody.innerHTML = "";
  (roi.nearby_competitors || []).slice(0, 7).forEach((comp) => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-slate-800/40 transition";
    tr.innerHTML = `
      <td class="py-2 pr-3 font-medium text-white">${comp.name}</td>
      <td class="py-2 px-2 text-slate-300">${comp.neighbourhood}</td>
      <td class="py-2 px-2">${comp.rooms} ΥΔ</td>
      <td class="py-2 px-2 font-bold text-cyan-300">€${comp.price}</td>
      <td class="py-2 px-2 text-emerald-300">${(comp.occupancy_rate * 100).toFixed(1)}%</td>
      <td class="py-2 pl-2 text-right text-slate-400">${comp.distance_m} m</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderDynamicNeighborhoodIndexChart(series, loc) {
  if (!series || !document.getElementById("eurostatChart")) return;
  const nbName = series.neighborhood_name || loc.neighbourhood || "Επιλεγμένη Περιοχή";
  const titleEl = document.getElementById("eurostatChartTitle");
  if (titleEl) {
    titleEl.textContent = `📈 Δείκτης Τιμών Κατοικιών & ADR: ${nbName}`;
  }
  const subEl = document.getElementById("eurostatChartSubtitle");
  if (subEl) {
    const idx2025 = series.neighborhood_price_index_2015_100[series.neighborhood_price_index_2015_100.length - 1];
    const adr2025 = series.neighborhood_adr_eur[series.neighborhood_adr_eur.length - 1];
    subEl.innerHTML = `Δείκτης 2025: <b class="text-emerald-300">${idx2025}</b> (Αθήνα: 191.8) &bull; Αγορά: <b>€${loc.avg_purchase_price_sqm}/m²</b> &bull; ADR: <b class="text-cyan-300">€${adr2025}</b>`;
  }

  const ctx = document.getElementById("eurostatChart").getContext("2d");
  if (eurostatChartInstance) eurostatChartInstance.destroy();

  eurostatChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: series.years,
      datasets: [
        {
          label: `Δείκτης Τιμών: ${nbName} (2015=100)`,
          data: series.neighborhood_price_index_2015_100,
          borderColor: "#10b981",
          backgroundColor: "rgba(16, 185, 129, 0.14)",
          borderWidth: 2.8,
          tension: 0.35,
          fill: true,
          yAxisID: "y",
        },
        {
          label: "Μ.Ο. Αθήνας Eurostat (EL001C)",
          data: series.athens_baseline_price_index_2015_100,
          borderColor: "#818cf8",
          borderDash: [5, 4],
          borderWidth: 2,
          tension: 0.35,
          fill: false,
          yAxisID: "y",
        },
        {
          label: `Μέσο ADR Περιοχής (€/βραδιά)`,
          data: series.neighborhood_adr_eur,
          borderColor: "#22d3ee",
          backgroundColor: "rgba(34, 211, 238, 0.1)",
          borderWidth: 2.4,
          tension: 0.35,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#cbd5e1", font: { size: 10 } } },
      },
      scales: {
        x: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(51,65,85,0.3)" } },
        y: {
          type: "linear",
          position: "left",
          title: { display: true, text: "Δείκτης Τιμών (2015=100)", color: "#10b981", font: { size: 9 } },
          ticks: { color: "#10b981" },
          grid: { color: "rgba(51,65,85,0.3)" },
        },
        y1: {
          type: "linear",
          position: "right",
          title: { display: true, text: "ADR (€/βραδιά)", color: "#22d3ee", font: { size: 9 } },
          ticks: { color: "#22d3ee" },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

async function loadEurostatDashboard() {
  try {
    const resp = await fetch(`${API_BASE}/macro/urban-audit?city=EL300`);
    const data = await resp.json();

    const badge = document.getElementById("eurostatBadge");
    if (badge && data.connection) {
      badge.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        <span>Eurostat (EL001C): ${data.connection.mode}</span>
      `;
    }

    if (!lastEvaluationResult?.location_context?.neighborhood_index_series) {
      const ts = data.city_analytics?.time_series;
      if (ts) {
        renderDynamicNeighborhoodIndexChart(
          {
            years: ts.years,
            neighborhood_name: "Αθήνα (EL001C)",
            neighborhood_price_index_2015_100: ts.residential_price_index_2015_100,
            athens_baseline_price_index_2015_100: ts.residential_price_index_2015_100,
            neighborhood_adr_eur: [85, 68, 79, 94, 105, 114, 122],
          },
          { neighbourhood: "Αθήνα", avg_purchase_price_sqm: 3250 }
        );
      }
    }

    // Render EU Mediterranean Benchmark Chart
    const bench = data.eu_mediterranean_benchmark || [];
    if (bench.length > 0 && document.getElementById("euBenchmarkChart")) {
      const ctxBench = document.getElementById("euBenchmarkChart").getContext("2d");
      if (euBenchmarkChartInstance) euBenchmarkChartInstance.destroy();

      euBenchmarkChartInstance = new Chart(ctxBench, {
        type: "bar",
        data: {
          labels: bench.map((b) => b.city),
          datasets: [
            {
              label: "Gross Rental Yield (%)",
              data: bench.map((b) => b.gross_str_yield_pct),
              backgroundColor: "rgba(16, 185, 129, 0.75)",
              borderColor: "#10b981",
              borderWidth: 1,
              borderRadius: 6,
              yAxisID: "y",
            },
            {
              label: "Μέση Τιμή Αγοράς (€/m²)",
              data: bench.map((b) => b.avg_price_sqm_eur),
              type: "line",
              borderColor: "#38bdf8",
              backgroundColor: "#38bdf8",
              borderWidth: 2.5,
              tension: 0.3,
              yAxisID: "y1",
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: "#cbd5e1", font: { size: 10 } } },
          },
          scales: {
            x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,0.3)" } },
            y: {
              type: "linear",
              position: "left",
              ticks: { color: "#34d399" },
              grid: { color: "rgba(51,65,85,0.3)" },
            },
            y1: {
              type: "linear",
              position: "right",
              ticks: { color: "#38bdf8" },
              grid: { drawOnChartArea: false },
            },
          },
        },
      });
    }
  } catch (err) {
    console.error("Failed loading Eurostat Urban Audit:", err);
  }
}

function renderNeighborhoodComparisonChart(neighborhoods) {
  if (!neighborhoods || !neighborhoods.length) return;
  const top10 = neighborhoods.slice(0, 10);
  const ctx = document.getElementById("neighborhoodChart").getContext("2d");
  if (neighborhoodChartInstance) neighborhoodChartInstance.destroy();

  const labels = top10.map((n) => (n.name.length > 16 ? n.name.slice(0, 15) + "…" : n.name));
  const revenues = top10.map((n) => n.estimated_avg_annual_revenue_eur);
  const saturations = top10.map((n) => n.listings_per_1000_residents);

  neighborhoodChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Μέσο Ετήσιο Έσοδο (€)",
          data: revenues,
          backgroundColor: "rgba(99, 102, 241, 0.75)",
          borderColor: "#6366f1",
          borderWidth: 1,
          borderRadius: 5,
          yAxisID: "y",
        },
        {
          label: "Airbnb / 1.000 κατ.",
          data: saturations,
          type: "line",
          borderColor: "#f97316",
          backgroundColor: "#f97316",
          borderWidth: 2.5,
          tension: 0.3,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#cbd5e1", font: { size: 10 } } },
      },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 9 } }, grid: { color: "rgba(51,65,85,0.3)" } },
        y: {
          type: "linear",
          position: "left",
          ticks: { color: "#a5b4fc" },
          grid: { color: "rgba(51,65,85,0.3)" },
        },
        y1: {
          type: "linear",
          position: "right",
          ticks: { color: "#fb923c" },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

async function loadSavedScenarios() {
  try {
    const resp = await fetch(`${API_BASE}/scenarios`);
    const data = await resp.json();
    const container = document.getElementById("scenariosList");
    container.innerHTML = "";

    (data.scenarios || []).forEach((s) => {
      const card = document.createElement("div");
      card.className =
        "p-3 rounded-xl bg-slate-900/90 border border-slate-800 hover:border-indigo-500/40 transition flex items-center justify-between gap-2 cursor-pointer";
      card.onclick = () => selectPreset(s.lat, s.lon, s.title);
      card.innerHTML = `
        <div>
          <div class="text-xs font-bold text-white">${s.title}</div>
          <div class="text-[11px] text-slate-400">
            ${s.neighbourhood} &bull; ${s.rooms} ΥΔ &bull; Έσοδο: <b class="text-emerald-400">€${Number(
        s.estimated_annual_revenue_eur
      ).toLocaleString("el-GR")}/έτος</b>
          </div>
        </div>
        <div class="text-right shrink-0">
          <div class="text-sm font-extrabold text-indigo-400">${s.investment_score}</div>
          <div class="text-[10px] text-slate-400">ROI ${s.estimated_gross_roi_pct}%</div>
        </div>
      `;
      container.appendChild(card);
    });
  } catch (err) {
    console.error("Failed loading scenarios:", err);
  }
}

async function saveCurrentScenario() {
  if (!lastEvaluationResult) return;
  const titleInput = document.getElementById("scenarioTitleInput");
  const title =
    titleInput.value.trim() ||
    `Επένδυση ${lastEvaluationResult.location_context.neighbourhood} (${lastEvaluationResult.query.rooms} ΥΔ)`;

  const payload = {
    title,
    lat: lastEvaluationResult.query.lat,
    lon: lastEvaluationResult.query.lon,
    radius: lastEvaluationResult.query.radius_m,
    rooms: lastEvaluationResult.query.rooms,
    acquisition_cost_eur:
      lastEvaluationResult.airbnb_roi_metrics.estimated_acquisition_cost_eur,
    investment_score: lastEvaluationResult.investment_rating.score,
    estimated_annual_revenue_eur:
      lastEvaluationResult.airbnb_roi_metrics.estimated_annual_gross_revenue_eur,
    estimated_gross_roi_pct:
      lastEvaluationResult.airbnb_roi_metrics.gross_roi_yield_pct,
    neighbourhood: lastEvaluationResult.location_context.neighbourhood,
  };

  try {
    const resp = await fetch(`${API_BASE}/scenarios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      titleInput.value = "";
      await loadSavedScenarios();
    }
  } catch (err) {
    console.error("Failed saving scenario:", err);
  }
}

async function syncAllDataSources() {
  const btn = document.getElementById("btnSyncData");
  const icon = document.getElementById("btnSyncIcon");
  const label = document.getElementById("btnSyncLabel");
  const badge = document.getElementById("syncStatusBadge");

  // 1. Enter Loading / Active State
  if (btn) {
    btn.disabled = true;
    btn.classList.add("cursor-wait", "opacity-90", "bg-indigo-900/60", "border-indigo-500/60");
    btn.classList.remove("bg-slate-800", "hover:bg-slate-700", "border-slate-700");
  }
  if (icon) {
    icon.classList.add("animate-spin", "text-indigo-300");
    icon.innerHTML = "&#x21bb;";
  }
  if (label) {
    label.textContent = "Συγχρονισμός...";
  } else if (btn) {
    btn.textContent = "Συγχρονισμός...";
  }

  if (badge) {
    badge.textContent = "⏳ Ανανέωση πηγών...";
    badge.classList.remove("hidden");
    badge.className =
      "text-[10px] font-bold px-2 py-1 rounded-md bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 whitespace-nowrap";
  }

  try {
    // 2. Call POST /api/v1/admin/sync
    const syncResp = await fetch(`${API_BASE}/admin/sync`, { method: "POST" });
    const syncData = await syncResp.json().catch(() => ({}));

    // 3. Re-fetch all dynamic views and re-render everything
    await Promise.all([
      loadMapLayersAndNeighborhoods(),
      loadTopRecommendations(),
      loadEurostatDashboard(),
      runEvaluation(),
      typeof loadSavedScenarios === "function" ? loadSavedScenarios() : Promise.resolve(),
    ]);

    // 4. Enter Success State
    if (btn) {
      btn.classList.remove("cursor-wait", "opacity-90", "bg-indigo-900/60", "border-indigo-500/60");
      btn.classList.add("bg-emerald-600", "border-emerald-400", "text-white", "shadow-emerald-950/50");
    }
    if (icon) {
      icon.classList.remove("animate-spin", "text-indigo-300");
      icon.textContent = "✓";
    }
    const counts = syncData.datasets_reloaded || {};
    const nbs = counts.neighborhoods || 44;
    const bnb = counts.airbnb_listings || 1895;
    if (label) {
      label.textContent = `Synced! (${nbs}Γ, ${bnb} Airbnb)`;
    }

    const timeStr = new Date().toLocaleTimeString("el-GR");
    if (badge) {
      badge.textContent = `✓ Live Sync: ${timeStr} (100% Up to Date)`;
      badge.className =
        "text-[10px] font-bold px-2 py-1 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 whitespace-nowrap";
    }

    // 5. Revert button to idle after 3 seconds, keeping the badge showing the timestamp
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.className =
          "text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition flex items-center gap-1.5 shadow-sm active:scale-95";
      }
      if (icon) {
        icon.className = "inline-block transition-transform duration-300";
        icon.innerHTML = "&#x21bb;";
      }
      if (label) {
        label.textContent = "Sync APIs";
      }
    }, 3000);
  } catch (err) {
    console.error("Sync error:", err);
    if (btn) {
      btn.disabled = false;
      btn.className =
        "text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-rose-900/80 text-rose-200 border border-rose-600 transition flex items-center gap-1.5";
    }
    if (icon) {
      icon.classList.remove("animate-spin");
      icon.textContent = "⚠️";
    }
    if (label) {
      label.textContent = "Σφάλμα Sync";
    }
    if (badge) {
      badge.textContent = "Σφάλμα σύνδεσης";
      badge.className =
        "text-[10px] font-bold px-2 py-1 rounded-md bg-rose-500/20 text-rose-300 border border-rose-500/30 whitespace-nowrap";
    }
    setTimeout(() => {
      if (btn) {
        btn.className =
          "text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition flex items-center gap-1.5 shadow-sm active:scale-95";
      }
      if (icon) icon.innerHTML = "&#x21bb;";
      if (label) label.textContent = "Sync APIs";
    }, 3000);
  }
}

async function loadTopRecommendations() {
  try {
    const strategy = document.getElementById("optStrategySelect")?.value || "score";
    const rooms = document.getElementById("optRoomsSelect")?.value || "auto";
    const budget = document.getElementById("optBudgetSelect")?.value || "0";
    const radius = document.getElementById("inputRadius")?.value || "800";

    const resp = await fetch(
      `${API_BASE}/properties/top-recommendations?strategy=${encodeURIComponent(
        strategy
      )}&rooms=${encodeURIComponent(rooms)}&budget=${encodeURIComponent(
        budget
      )}&radius=${encodeURIComponent(radius)}`
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    cachedTopRecommendations = data;
    renderTopRecommendationsUI(data);
  } catch (err) {
    console.error("Failed loading top recommendations:", err);
  }
}

function applyRecommendationChoice(lat, lon, rooms, label) {
  const latEl = document.getElementById("inputLat");
  const lonEl = document.getElementById("inputLon");
  const roomsEl = document.getElementById("inputRooms");
  const titleEl = document.getElementById("scenarioTitleInput");

  if (latEl) latEl.value = Number(lat).toFixed(4);
  if (lonEl) lonEl.value = Number(lon).toFixed(4);
  if (roomsEl && rooms) roomsEl.value = String(rooms);
  if (titleEl && label) titleEl.value = `Βέλτιστη Επιλογή: ${label} (${rooms} ΥΔ)`;

  if (map) {
    map.flyTo([Number(lat), Number(lon)], 15, { duration: 0.7 });
  }
  runEvaluation();
}

function selectTopOverallRecommendation() {
  const top = cachedTopRecommendations?.top_overall_pick;
  if (!top) {
    loadTopRecommendations().then(() => {
      const retryTop = cachedTopRecommendations?.top_overall_pick;
      if (retryTop) {
        applyRecommendationChoice(
          retryTop.lat,
          retryTop.lon,
          retryTop.best_rooms,
          retryTop.neighbourhood
        );
      }
    });
    return;
  }
  applyRecommendationChoice(top.lat, top.lon, top.best_rooms, top.neighbourhood);
}

function renderTopRecommendationsUI(data) {
  const badgeEl = document.getElementById("optTotalEvaluatedBadge");
  if (badgeEl && data.total_neighborhoods_evaluated) {
    badgeEl.textContent = `${data.total_neighborhoods_evaluated} Γειτονιές • ${data.total_combinations_evaluated} Συνδυασμοί`;
  }

  const winnerCard = document.getElementById("topWinnerCard");
  const top = data.top_overall_pick;
  if (winnerCard) {
    if (!top) {
      winnerCard.innerHTML = `<div class="text-xs text-rose-300">Δεν βρέθηκε ακίνητο εντός του επιλεγμένου προϋπολογισμού. Δοκιμάστε μεγαλύτερο budget.</div>`;
    } else {
      const roomComparisonHtml = (top.room_options_comparison || [])
        .map((opt) => {
          const isBest = opt.rooms === top.best_rooms;
          return `
            <div onclick="event.stopPropagation(); applyRecommendationChoice(${top.lat}, ${top.lon}, ${opt.rooms}, '${top.neighbourhood}')"
              class="p-2 rounded-lg border cursor-pointer transition ${
                isBest
                  ? "bg-amber-500/20 border-amber-400 text-white shadow-sm"
                  : "bg-slate-900/80 border-slate-800 text-slate-300 hover:border-slate-600"
              }">
              <div class="flex items-center justify-between text-[10px]">
                <span class="font-bold ${isBest ? "text-amber-300" : "text-slate-300"}">
                  ${isBest ? "★ " : ""}${opt.rooms} ΥΔ (${opt.estimated_sqm}m²)
                </span>
                <span class="px-1.5 py-0.5 rounded font-extrabold ${
                  isBest ? "bg-amber-400 text-slate-950" : "bg-slate-800 text-indigo-300"
                }">
                  Score ${opt.score}
                </span>
              </div>
              <div class="mt-1 flex justify-between text-[10px] text-slate-300">
                <span>ROI: <b class="text-emerald-400">${opt.gross_roi_pct}%</b></span>
                <span>Καθαρό: <b class="text-white">€${Number(opt.annual_net_income_eur).toLocaleString("el-GR")}/έτ.</b></span>
              </div>
              <div class="text-[9px] text-slate-400 mt-0.5">
                Κόστος Κτήσης: €${Number(opt.acquisition_cost_eur).toLocaleString("el-GR")} • ADR €${opt.adr_eur}
              </div>
            </div>
          `;
        })
        .join("");

      winnerCard.innerHTML = `
        <div class="cursor-pointer" onclick="applyRecommendationChoice(${top.lat}, ${top.lon}, ${top.best_rooms}, '${top.neighbourhood}')">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div class="flex items-center gap-1.5">
                <span class="px-2 py-0.5 rounded-md bg-amber-400 text-slate-950 text-[10px] font-black uppercase tracking-wider">
                  #1 ΚΟΡΥΦΑΙΑ ΕΠΙΛΟΓΗ
                </span>
                <span class="text-[11px] font-semibold text-amber-200/90">
                  ${top.municipality}
                </span>
              </div>
              <h4 class="text-base font-extrabold text-white mt-1 flex items-center gap-2">
                <span>📍 ${top.neighbourhood}</span>
                <span class="text-xs font-bold px-2 py-0.5 rounded-lg bg-indigo-500/30 border border-indigo-400/50 text-indigo-200">
                  Βέλτιστο: ${top.best_room_label}
                </span>
              </h4>
              <p class="text-[11px] text-slate-300 mt-0.5">
                Συντεταγμένες: <span class="font-mono text-cyan-300">${top.lat}, ${top.lon}</span> •
                Μετρό: <b>${top.nearest_metro_name}</b> (${top.nearest_metro_dist_m}m) •
                🍽️ ~${top.dining_venues_in_catchment} χώροι εστίασης
              </p>
            </div>
            <div class="text-right bg-slate-950/80 border border-amber-500/40 rounded-xl px-3 py-1.5">
              <div class="text-[10px] uppercase tracking-wider text-amber-300 font-bold">Investment Score</div>
              <div class="text-2xl font-black text-white">${top.investment_score}<span class="text-xs text-amber-300 font-normal">/100 (${top.grade})</span></div>
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2.5 pt-2.5 border-t border-amber-500/20 text-[11px]">
            <div class="bg-slate-950/60 rounded-lg p-2 border border-slate-800">
              <div class="text-slate-400 text-[10px]">Gross / Net ROI</div>
              <div class="font-extrabold text-emerald-400 text-sm">${top.gross_roi_pct}% <span class="text-[10px] text-slate-300 font-normal">(Net ${top.net_roi_pct}%)</span></div>
            </div>
            <div class="bg-slate-950/60 rounded-lg p-2 border border-slate-800">
              <div class="text-slate-400 text-[10px]">Καθαρό Ετήσιο Κέρδος</div>
              <div class="font-extrabold text-white text-sm">€${Number(top.annual_net_income_eur).toLocaleString("el-GR")}</div>
            </div>
            <div class="bg-slate-950/60 rounded-lg p-2 border border-slate-800">
              <div class="text-slate-400 text-[10px]">Κόστος Κτήσης (${top.best_sqm}m²)</div>
              <div class="font-extrabold text-cyan-300 text-sm">€${Number(top.acquisition_cost_eur).toLocaleString("el-GR")}</div>
            </div>
            <div class="bg-slate-950/60 rounded-lg p-2 border border-slate-800">
              <div class="text-slate-400 text-[10px]">Απόσβεση & ADR</div>
              <div class="font-extrabold text-amber-300 text-sm">${top.payback_years} έτη <span class="text-[10px] text-slate-300 font-normal">(€${top.adr_eur}/βρ.)</span></div>
            </div>
          </div>
        </div>

        <div class="mt-2.5">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-amber-200/80 mb-1.5">
            Συγκριτική Ανάλυση Διαμερισμάτων στην Κορυφαία Περιοχή (${top.neighbourhood}) — Κλικ για Επιλογή:
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            ${roomComparisonHtml}
          </div>
        </div>
      `;
    }
  }

  const gridEl = document.getElementById("topLocationsGrid");
  if (gridEl) {
    const list = (data.top_recommendations || []).slice(0, 6);
    gridEl.innerHTML = list
      .map(
        (item) => `
        <div onclick="applyRecommendationChoice(${item.lat}, ${item.lon}, ${item.best_rooms}, '${item.neighbourhood}')"
          class="p-2.5 rounded-xl bg-slate-950/90 hover:bg-slate-800/80 border ${
            item.rank === 1 ? "border-amber-400/60" : "border-slate-800 hover:border-indigo-500/50"
          } cursor-pointer transition flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="w-5 h-5 rounded-full ${
                item.rank === 1
                  ? "bg-amber-400 text-slate-950"
                  : item.rank <= 3
                  ? "bg-indigo-500/30 text-indigo-200 border border-indigo-400/40"
                  : "bg-slate-800 text-slate-300"
              } text-[10px] font-extrabold flex items-center justify-center shrink-0">
                #${item.rank}
              </span>
              <span class="text-xs font-bold text-white truncate">${item.neighbourhood}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-950/90 border border-indigo-700/50 text-indigo-300 font-semibold shrink-0">
                ${item.best_rooms} ΥΔ (${item.best_sqm}m²)
              </span>
            </div>
            <div class="text-[10px] text-slate-400 mt-1 flex flex-wrap items-center gap-x-2">
              <span>Κτήση: <b class="text-slate-200">€${Math.round(item.acquisition_cost_eur / 1000)}k</b></span>
              <span>•</span>
              <span>Καθαρό: <b class="text-emerald-400">€${Number(item.annual_net_income_eur).toLocaleString("el-GR")}/έτ.</b></span>
              <span>•</span>
              <span>ROI: <b class="text-cyan-300">${item.gross_roi_pct}%</b></span>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-sm font-black ${
              item.rank === 1 ? "text-amber-300" : "text-indigo-400"
            }">${item.investment_score}</div>
            <div class="text-[9px] text-slate-400">Grade ${item.grade}</div>
          </div>
        </div>
      `
      )
      .join("");
  }
}

