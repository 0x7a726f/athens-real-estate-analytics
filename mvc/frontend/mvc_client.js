/**
 * MVC View Client Script (`mvc/frontend/mvc_client.js`)
 * Binds both MVC Views (`desktop_view.html` and `mobile_view.html`) to the MVC Controller endpoints.
 */

const API_BASE =
  window.location.protocol === "file:"
    ? "http://127.0.0.1:8001/api/v1"
    : `${window.location.origin}/api/v1`;

window.map = null;
let selectedMarker = null;
let radiusCircle = null;

let heatmapLayerGroup = L.layerGroup();
let airbnbLayerGroup = L.layerGroup();
let gisLayerGroup = L.layerGroup();
let hazardLayerGroup = L.layerGroup();

let lastEvaluationResult = null;
let cachedGisLayers = null;
let cachedNeighborhoodAnalytics = null;
let cachedTopRecommendations = null;
let eurostatChartInstance = null;
let neighborhoodChartInstance = null;
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
  window.map = L.map("athensMap", {
    center: [37.9755, 23.7325],
    zoom: 13,
    doubleClickZoom: false,
    preferCanvas: true,
  });

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> | MVC Architecture',
    maxZoom: 19,
    className: "osm-dark-tiles",
  }).addTo(window.map);

  heatmapLayerGroup.addTo(window.map);
  hazardLayerGroup.addTo(window.map);
  airbnbLayerGroup.addTo(window.map);
  gisLayerGroup.addTo(window.map);

  const selectMapCoordinate = (ev) => {
    if (!ev || !ev.latlng) return;
    document.getElementById("inputLat").value = ev.latlng.lat.toFixed(4);
    document.getElementById("inputLon").value = ev.latlng.lng.toFixed(4);
    runEvaluation();
  };

  window.map.on("click", selectMapCoordinate);
  window.map.on("dblclick", selectMapCoordinate);
}

function selectPreset(lat, lon, label) {
  document.getElementById("inputLat").value = Number(lat).toFixed(4);
  document.getElementById("inputLon").value = Number(lon).toFixed(4);
  const titleEl = document.getElementById("scenarioTitleInput");
  if (titleEl) titleEl.value = `Σενάριο: ${label}`;
  window.map.flyTo([lat, lon], 15, { duration: 0.6 });
  runEvaluation();
}

async function loadMapLayersAndNeighborhoods() {
  const [layersResp, nbResp] = await Promise.all([
    fetch(`${API_BASE}/gis/layers`),
    fetch(`${API_BASE}/neighborhoods/analytics`),
  ]);
  cachedGisLayers = (await layersResp.json()).layers;
  cachedNeighborhoodAnalytics = (await nbResp.json()).neighborhoods || [];
  populateNeighborhoodDropdown(cachedNeighborhoodAnalytics);
  renderMapGeoJSONLayers();
  renderNeighborhoodComparisonChart(cachedNeighborhoodAnalytics);
}

function populateNeighborhoodDropdown(neighborhoods) {
  const sel = document.getElementById("neighborhoodSelect");
  if (!sel) return;
  const sorted = [...(neighborhoods || [])].sort((a, b) => (a.name || "").localeCompare(b.name || "", "el"));
  sel.innerHTML = `<option value="">-- Επιλογή από τις 44 Γειτονιές --</option>` +
    sorted
      .map(
        (n) =>
          `<option value="${n.center_lat || 37.9755},${n.center_lon || 23.7348},${n.name}">${n.name} (€${n.avg_adr_eur}/βραδιά • ${n.total_airbnb_listings ?? n.airbnb_listings_count ?? 0} Airbnb)</option>`
      )
      .join("");
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

function handleAreaSearchInput(query) {
  const dropdown = document.getElementById("areaSearchDropdown");
  if (!dropdown) return;
  const q = (query || "").trim().toLowerCase();
  if (!q) {
    dropdown.classList.add("hidden");
    return;
  }

  const nbMatches = (cachedNeighborhoodAnalytics || [])
    .filter((n) => (n.name || "").toLowerCase().includes(q))
    .slice(0, 8)
    .map((n) => ({
      title: `🏘️ ${n.name}`,
      subtitle: `ADR: €${n.avg_adr_eur} • Κορεσμός: ${n.listings_per_1000_residents}/1k • Αγορά: €${n.avg_purchase_price_sqm}/m²`,
      lat: n.center_lat || 37.9755,
      lon: n.center_lon || 23.7348,
      label: n.name,
    }));

  const poiMatches = ((cachedGisLayers && cachedGisLayers.athens_gis_pois?.features) || [])
    .filter((f) => {
      const p = f.properties || {};
      return (p.name || "").toLowerCase().includes(q) || (p.subtype || "").toLowerCase().includes(q);
    })
    .slice(0, 5)
    .map((f) => ({
      title: `📍 ${f.properties.name}`,
      subtitle: `${f.properties.subtype || f.properties.category}`,
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      label: f.properties.name,
    }));

  const combined = [...nbMatches, ...poiMatches];
  if (combined.length === 0) {
    dropdown.innerHTML = `<div class="px-3 py-2 text-xs text-slate-400">Δεν βρέθηκε περιοχή για "${query}"</div>`;
    dropdown.classList.remove("hidden");
    return;
  }

  dropdown.innerHTML = combined
    .map(
      (item) => `
      <div
        onclick="selectSearchAreaItem(${item.lat}, ${item.lon}, '${item.label.replace(/'/g, "\\'")}')"
        class="px-3 py-2 hover:bg-slate-800 cursor-pointer border-b border-slate-800/70 last:border-0 transition"
      >
        <div class="text-xs font-bold text-white">${item.title}</div>
        <div class="text-[10px] text-slate-400">${item.subtitle}</div>
      </div>
    `
    )
    .join("");
  dropdown.classList.remove("hidden");
}

function selectSearchAreaItem(lat, lon, label) {
  const dropdown = document.getElementById("areaSearchDropdown");
  if (dropdown) dropdown.classList.add("hidden");
  const input = document.getElementById("areaSearchInput");
  if (input) input.value = label;
  selectPreset(lat, lon, label);
}

function triggerFirstAreaMatch() {
  const input = document.getElementById("areaSearchInput");
  const q = (input?.value || "").trim().toLowerCase();
  if (!q) return;
  const match = (cachedNeighborhoodAnalytics || []).find((n) => (n.name || "").toLowerCase().includes(q));
  if (match) {
    selectSearchAreaItem(match.center_lat || 37.9755, match.center_lon || 23.7348, match.name);
  }
}

function renderMapGeoJSONLayers() {
  heatmapLayerGroup.clearLayers();
  airbnbLayerGroup.clearLayers();
  gisLayerGroup.clearLayers();
  hazardLayerGroup.clearLayers();
  if (!cachedGisLayers) return;

  cachedNeighborhoodAnalytics.forEach((nb) => {
    if (!nb.geometry) return;
    const layer = L.geoJSON(
      { type: "Feature", properties: nb, geometry: nb.geometry },
      { style: { color: nb.heatmap_color, weight: 1.5, fillColor: nb.heatmap_color, fillOpacity: 0.17 } }
    );
    layer.bindTooltip(
      `<div class="text-xs"><b>${nb.name}</b><br/>Κορεσμός: ${nb.listings_per_1000_residents}/1k κατ. • ADR: €${nb.avg_adr_eur}<br/><span class="text-emerald-300">Κάντε κλικ για επιλογή σημείου</span></div>`,
      { sticky: true }
    );
    const selectOnPolygon = (ev) => {
      if (ev && ev.latlng) {
        document.getElementById("inputLat").value = ev.latlng.lat.toFixed(4);
        document.getElementById("inputLon").value = ev.latlng.lng.toFixed(4);
        runEvaluation();
      }
    };
    layer.on("click", selectOnPolygon);
    layer.on("dblclick", selectOnPolygon);
    heatmapLayerGroup.addLayer(layer);
  });

  (cachedGisLayers.athens_gis_hazards?.features || []).forEach((feat) => {
    const p = feat.properties;
    const color = p.hazard_type === "flood_zone" ? "#f43f5e" : "#f59e0b";
    const layer = L.geoJSON(feat, { style: { color, weight: 2, dashArray: "5,4", fillColor: color, fillOpacity: 0.28 } });
    layer.bindTooltip(`<div class="text-xs"><b>⚠️ ${p.name}</b><br/>${p.recommendation}</div>`, { sticky: true });
    const selectOnHazard = (ev) => {
      if (ev && ev.latlng) {
        document.getElementById("inputLat").value = ev.latlng.lat.toFixed(4);
        document.getElementById("inputLon").value = ev.latlng.lng.toFixed(4);
        runEvaluation();
      }
    };
    layer.on("click", selectOnHazard);
    layer.on("dblclick", selectOnHazard);
    hazardLayerGroup.addLayer(layer);
  });

  renderAirbnbMarkersOnMap();

  const poiColors = {
    metro: "#38bdf8",
    museum: "#c084fc",
    restaurant: "#fbbf24",
    landmark: "#34d399",
  };
  (cachedGisLayers.athens_gis_pois?.features || []).forEach((feat) => {
    const c = feat.geometry.coordinates;
    const p = feat.properties;
    const isMetro = p.category === "metro";
    const m = L.circleMarker([c[1], c[0]], {
      radius: isMetro ? 6.5 : 5.5,
      fillColor: poiColors[p.category] || "#34d399",
      color: "#0f172a",
      weight: 2,
      fillOpacity: 0.95,
    });
    m.bindPopup(`
      <div class="text-xs space-y-0.5">
        <b>${p.name}</b>
        ${p.subtype ? `<br/><span class="text-slate-300">${p.subtype}</span>` : ""}
        ${p.venue_count ? `<br/><span class="text-amber-300">~${p.venue_count} χώροι εστίασης</span>` : ""}
      </div>
    `);
    gisLayerGroup.addLayer(m);
  });
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

  let filtered = enriched.filter((it) => {
    if (roomFilter === "similar") return it.sameRooms;
    if (roomFilter === "similar_radius") return it.sameRooms && it.inRadius;
    if (roomFilter === "in_radius") return it.inRadius;
    if (roomFilter === "1") return it.p.rooms === 1;
    if (roomFilter === "2") return it.p.rooms === 2;
    if (roomFilter === "3") return it.p.rooms >= 3;
    return true;
  });

  if (filtered.length === 0) {
    filtered = enriched.filter((it) => (roomFilter.includes("similar") ? it.sameRooms : true));
  }

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
        <button onclick="selectPreset(${coords[1]}, ${coords[0]}, '${(p.neighbourhood || "Αθήνα").replace(/'/g, "\\'")}')" class="mt-1 w-full py-1 px-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[10px] transition">
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
  const toggle = (grp, chk) => {
    if (chk) {
      if (!window.map.hasLayer(grp)) window.map.addLayer(grp);
    } else if (window.map.hasLayer(grp)) {
      window.map.removeLayer(grp);
    }
  };
  toggle(heatmapLayerGroup, document.getElementById("toggleHeatmap").checked);
  toggle(airbnbLayerGroup, document.getElementById("toggleAirbnb").checked);
  toggle(gisLayerGroup, document.getElementById("toggleGIS").checked);
  toggle(hazardLayerGroup, document.getElementById("toggleHazards").checked);
}

async function runEvaluation() {
  const lat = parseFloat(document.getElementById("inputLat").value) || 37.9648;
  const lon = parseFloat(document.getElementById("inputLon").value) || 23.7265;
  const radius = parseFloat(document.getElementById("inputRadius").value) || 600;
  const rooms = parseInt(document.getElementById("inputRooms").value, 10) || 2;

  if (selectedMarker) window.map.removeLayer(selectedMarker);
  if (radiusCircle) window.map.removeLayer(radiusCircle);
  selectedMarker = L.marker([lat, lon]).addTo(window.map);
  radiusCircle = L.circle([lat, lon], { radius, color: "#10b981", weight: 2, fillColor: "#10b981", fillOpacity: 0.14 }).addTo(window.map);

  renderAirbnbMarkersOnMap();

  const resp = await fetch(`${API_BASE}/properties/evaluate?lat=${lat}&lon=${lon}&radius=${radius}&rooms=${rooms}`);
  const data = await resp.json();
  lastEvaluationResult = data;
  renderEvaluationView(data);
}

function renderEvaluationView(data) {
  if (!data || data.status !== "success") return;
  const loc = data.location_context;
  const rating = data.investment_rating;
  const roi = data.airbnb_roi_metrics;
  const gis = data.gis_spatial_analysis;

  document.getElementById("evalNeighborhoodBadge").textContent = loc.neighbourhood;
  document.getElementById("evalLocationTitle").textContent = `${loc.neighbourhood} (${data.query.lat.toFixed(4)}, ${data.query.lon.toFixed(4)})`;
  const trendEl = document.getElementById("evalGentrificationTrend");
  if (trendEl) trendEl.textContent = `Τάση: ${loc.gentrification_trend} • Αγορά: €${loc.avg_purchase_price_sqm}/m²`;

  document.getElementById("evalScoreValue").textContent = rating.score.toFixed(1);
  document.getElementById("evalGradeText").textContent = rating.grade;

  const b = rating.breakdown;
  const macroScore = b.neighborhood_macro_score ?? b.macro_resilience_score ?? 11.5;
  document.getElementById("scoreTransit").textContent = `${b.transit_accessibility_score}/30`;
  document.getElementById("scoreYield").textContent = `${b.airbnb_yield_score}/35`;
  document.getElementById("scoreAmenity").textContent = `${b.urban_amenities_score}/20`;
  const macroEl = document.getElementById("scoreMacro");
  if (macroEl) macroEl.textContent = `${macroScore}/15`;
  document.getElementById("scoreHazardPenalty").textContent = b.natural_hazard_penalty < 0 ? `${b.natural_hazard_penalty}` : "0";
  const eqEl = document.getElementById("scoreLiveEquation");
  if (eqEl) {
    const penStr = b.natural_hazard_penalty < 0 ? ` - ${Math.abs(b.natural_hazard_penalty)}` : " - 0";
    eqEl.textContent = `${b.transit_accessibility_score} + ${b.airbnb_yield_score} + ${b.urban_amenities_score} + ${macroScore}${penStr} = ${rating.score.toFixed(1)} / 100`;
  }

  if (loc.neighborhood_index_series) {
    renderDynamicNeighborhoodIndexChart(loc.neighborhood_index_series, loc);
  }

  document.getElementById("evalCompetitorCount").textContent = `${roi.competitors_in_radius} εντός ακτίνας`;
  document.getElementById("kpiAnnualRevenue").textContent = `€${roi.estimated_annual_gross_revenue_eur.toLocaleString("el-GR")}`;
  document.getElementById("kpiNetIncome").textContent = `Καθαρό: €${roi.estimated_annual_net_income_eur.toLocaleString("el-GR")}`;
  document.getElementById("kpiAdr").textContent = `€${roi.average_daily_rate_eur.toFixed(2)}`;
  document.getElementById("kpiOccupancy").textContent = `Πληρότητα: ${roi.occupancy_rate_pct}%`;
  document.getElementById("kpiGrossRoi").textContent = `${roi.gross_roi_yield_pct}% ROI`;
  document.getElementById("kpiPayback").textContent = `Απόσβεση: ~${roi.payback_period_years} έτη`;
  document.getElementById("kpiLongTermRent").textContent = `Μακροχρόνια: €${roi.long_term_annual_rent_eur.toLocaleString("el-GR")}/έτος`;
  document.getElementById("kpiStrPremium").textContent = `+${roi.str_vs_long_term_premium_pct}% Airbnb`;

  if (gis.nearest_metro && document.getElementById("gisNearestMetroName")) {
    document.getElementById("gisNearestMetroName").textContent = gis.nearest_metro.name;
    document.getElementById("gisNearestMetroDist").textContent = `${gis.nearest_metro.distance_m} m (~${gis.nearest_metro.walking_minutes}')`;
  }
  if (gis.nearest_museum && document.getElementById("gisNearestMuseumName")) {
    document.getElementById("gisNearestMuseumName").textContent = gis.nearest_museum.name;
    document.getElementById("gisNearestMuseumDist").textContent = `${gis.nearest_museum.distance_m} m (~${gis.nearest_museum.walking_minutes}')`;
  }
  if (gis.nearest_restaurant_hub && document.getElementById("gisNearestRestaurantName")) {
    document.getElementById("gisNearestRestaurantName").textContent = gis.nearest_restaurant_hub.name;
    document.getElementById("gisNearestRestaurantDist").textContent = `${gis.nearest_restaurant_hub.distance_m} m • ~${gis.nearest_restaurant_hub.venue_count || 35} μαγαζιά`;
  }
  if (gis.nearest_landmark && document.getElementById("gisNearestLandmarkName")) {
    document.getElementById("gisNearestLandmarkName").textContent = gis.nearest_landmark.name;
    document.getElementById("gisNearestLandmarkDist").textContent = `${gis.nearest_landmark.distance_m} m (~${gis.nearest_landmark.walking_minutes}')`;
  }

  const dist = gis.poi_distribution;
  if (dist) {
    const catchmentEl = document.getElementById("poiCatchmentBadge");
    if (catchmentEl) catchmentEl.textContent = `Ακτίνα ${dist.catchment_radius_m}m (${dist.total_pois_in_catchment} POIs)`;
    const diningEl = document.getElementById("poiDiningVenuesBadge");
    if (diningEl) diningEl.textContent = `🍽️ ~${dist.estimated_dining_venues_count} χώροι εστίασης`;

    const statsEl = document.getElementById("poiDistributionStats");
    if (statsEl) {
      const total = Math.max(1, dist.total_pois_in_catchment);
      const rows = [
        { label: "🍽️ Εστιατόρια", count: `${dist.restaurant_hubs_count} ζώνες (~${dist.estimated_dining_venues_count})`, pct: Math.round((dist.restaurant_hubs_count / total) * 100), cls: "bg-amber-400" },
        { label: "🏛️ Μουσεία", count: `${dist.museums_count} μουσεία`, pct: Math.round((dist.museums_count / total) * 100), cls: "bg-purple-400" },
        { label: "🌿 Αξιοθέατα", count: `${dist.landmarks_count} σημεία`, pct: Math.round((dist.landmarks_count / total) * 100), cls: "bg-emerald-400" },
        { label: "🚇 Μετρό/ΗΣΑΠ", count: `${dist.metro_stations_count} σταθμοί`, pct: Math.round((dist.metro_stations_count / total) * 100), cls: "bg-sky-400" },
      ];
      statsEl.innerHTML = rows
        .map(
          (r) => `
        <div>
          <div class="flex justify-between text-[11px]"><span class="text-slate-300">${r.label}</span><span class="font-bold text-white">${r.count}</span></div>
          <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mt-0.5"><div class="${r.cls} h-full rounded-full" style="width:${Math.max(12, r.pct)}%"></div></div>
        </div>`
        )
        .join("");
    }

    const poiCanvas = document.getElementById("poiDistributionChart");
    if (poiCanvas) {
      const ctxPoi = poiCanvas.getContext("2d");
      if (poiDistributionChartInstance) poiDistributionChartInstance.destroy();
      const counts = dist.chart_hub_counts || [dist.restaurant_hubs_count, dist.museums_count, dist.landmarks_count, dist.metro_stations_count];
      poiDistributionChartInstance = new Chart(ctxPoi, {
        type: "doughnut",
        data: {
          labels: ["Εστιατόρια", "Μουσεία", "Αξιοθέατα", "Μετρό"],
          datasets: [{ data: counts.every((v) => v === 0) ? [1, 1, 1, 1] : counts, backgroundColor: ["#fbbf24", "#c084fc", "#34d399", "#38bdf8"], borderColor: "#0f172a", borderWidth: 2 }],
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: "62%", plugins: { legend: { display: false } } },
      });
    }
  }

  const nearbyListEl = document.getElementById("nearbyPoisList");
  if (nearbyListEl) {
    const iconMap = { museum: "🏛️", restaurant: "🍽️", landmark: "🌿", metro: "🚇" };
    nearbyListEl.innerHTML = (gis.nearby_places_of_interest || [])
      .map(
        (p) => `<span class="text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-200">${iconMap[p.category] || "📍"} ${p.name} <b class="text-cyan-300">${p.distance_m}m</b></span>`
      )
      .join("");
  }

  const alertBox = document.getElementById("hazardAlertBox");
  const alertIcon = document.getElementById("hazardAlertIcon");
  const alertTitle = document.getElementById("hazardAlertTitle");
  const alertDesc = document.getElementById("hazardAlertDesc");
  if (gis.is_in_hazard_zone && gis.natural_hazards_detected.length > 0) {
    const hz = gis.natural_hazards_detected[0];
    alertBox.className = "p-3 rounded-xl bg-rose-950/60 border border-rose-500/60 text-xs flex items-start gap-2.5";
    alertIcon.textContent = "🚨";
    alertTitle.className = "font-bold text-rose-300";
    alertTitle.textContent = `ΚΙΝΔΥΝΟΣ: ${hz.name}`;
    alertDesc.textContent = hz.recommendation;
  } else {
    alertBox.className = "p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/40 text-xs flex items-start gap-2.5";
    alertIcon.textContent = "✅";
    alertTitle.className = "font-bold text-emerald-300";
    alertTitle.textContent = "Εκτός Ζώνης Φυσικών Κινδύνων";
    alertDesc.textContent = "Ασφαλής ζώνη σύμφωνα με τα επίπεδα Athens GIS.";
  }

  const tbody = document.getElementById("competitorsTableBody");
  tbody.innerHTML = "";
  (roi.nearby_competitors || []).slice(0, 6).forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="py-1.5 pr-2 font-medium text-white">${c.name.slice(0, 32)}</td>
      <td class="py-1.5 px-1 text-slate-400">${c.neighbourhood}</td>
      <td class="py-1.5 px-1">${c.rooms}ΥΔ</td>
      <td class="py-1.5 px-1 font-bold text-cyan-300">€${c.price}</td>
      <td class="py-1.5 px-1 text-emerald-300">${(c.occupancy_rate * 100).toFixed(0)}%</td>
      <td class="py-1.5 pl-1 text-right text-slate-400">${c.distance_m}m</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderDynamicNeighborhoodIndexChart(series, loc) {
  if (!series || !series.years) return;
  const nbName = series.neighbourhood || series.neighborhood_name || loc?.neighbourhood || "Αθήνα";
  const titleEl = document.getElementById("eurostatChartTitle");
  if (titleEl) {
    titleEl.textContent = `📈 Δείκτης Τιμών & Τουρισμού: ${nbName} vs Αθήνα`;
  }
  const subEl = document.getElementById("eurostatChartSubtitle");
  if (subEl && loc) {
    subEl.textContent = `Αγορά ${nbName}: €${loc.avg_purchase_price_sqm}/m² • Διανυκτερεύσεις: ~${series.neighborhood_tourist_nights_thousands?.[6] || 150}k/έτος (Dataset + Eurostat EL001C)`;
  }

  const canvas = document.getElementById("eurostatChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (eurostatChartInstance) eurostatChartInstance.destroy();
  eurostatChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: series.years,
      datasets: [
        {
          label: `Δείκτης Τιμών ${nbName} (2015=100)`,
          data: series.neighborhood_price_index_2015_100,
          borderColor: "#10b981",
          backgroundColor: "rgba(16, 185, 129, 0.14)",
          borderWidth: 2.5,
          tension: 0.35,
          fill: true,
          yAxisID: "y",
        },
        {
          label: "Μέσος Όρος Αθήνας (Eurostat EL001C)",
          data: series.athens_baseline_price_index_2015_100,
          borderColor: "#94a3b8",
          borderDash: [5, 4],
          borderWidth: 2,
          tension: 0.35,
          fill: false,
          yAxisID: "y",
        },
        {
          label: `Μέση Τιμή Airbnb ${nbName} (€/βραδιά)`,
          data: series.neighborhood_adr_eur,
          borderColor: "#22d3ee",
          backgroundColor: "rgba(34, 211, 238, 0.1)",
          borderWidth: 2,
          tension: 0.35,
          fill: false,
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
          ticks: { color: "#10b981", font: { size: 10 } },
          grid: { color: "rgba(51,65,85,0.3)" },
        },
        y1: {
          type: "linear",
          position: "right",
          ticks: { color: "#22d3ee", font: { size: 10 }, callback: (v) => `€${v}` },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

async function loadEurostatDashboard() {
  const resp = await fetch(`${API_BASE}/macro/urban-audit?city=EL300`);
  const data = await resp.json();
  const ts = data.city_analytics?.time_series;
  if (!ts) return;
  if (lastEvaluationResult?.location_context?.neighborhood_index_series) {
    renderDynamicNeighborhoodIndexChart(
      lastEvaluationResult.location_context.neighborhood_index_series,
      lastEvaluationResult.location_context
    );
    return;
  }
  const ctx = document.getElementById("eurostatChart").getContext("2d");
  if (eurostatChartInstance) eurostatChartInstance.destroy();
  eurostatChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: ts.years,
      datasets: [
        { label: "Διανυκτερεύσεις (Εκατ.)", data: ts.tourist_nights_millions, borderColor: "#22d3ee", tension: 0.35 },
        { label: "Δείκτης Τιμών Κατοικιών", data: ts.residential_price_index_2015_100, borderColor: "#10b981", tension: 0.35 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

function renderNeighborhoodComparisonChart(neighborhoods) {
  const top8 = (neighborhoods || []).slice(0, 8);
  if (!top8.length) return;
  const ctx = document.getElementById("neighborhoodChart").getContext("2d");
  if (neighborhoodChartInstance) neighborhoodChartInstance.destroy();
  neighborhoodChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: top8.map((n) => n.name.slice(0, 12)),
      datasets: [
        { label: "Ετήσιο Έσοδο (€)", data: top8.map((n) => n.estimated_avg_annual_revenue_eur), backgroundColor: "#6366f1" },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

async function loadSavedScenarios() {
  const resp = await fetch(`${API_BASE}/scenarios`);
  const data = await resp.json();
  const container = document.getElementById("scenariosList");
  container.innerHTML = "";
  (data.scenarios || []).forEach((s) => {
    const div = document.createElement("div");
    div.className = "p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex justify-between items-center text-xs cursor-pointer";
    div.onclick = () => selectPreset(s.lat, s.lon, s.title);
    div.innerHTML = `<div><div class="font-bold text-white">${s.title}</div><div class="text-[10px] text-slate-400">${s.neighbourhood} • €${Number(s.estimated_annual_revenue_eur).toLocaleString("el-GR")}/έτος</div></div><div class="font-extrabold text-emerald-400">${s.investment_score}</div>`;
    container.appendChild(div);
  });
}

async function saveCurrentScenario() {
  if (!lastEvaluationResult) return;
  const input = document.getElementById("scenarioTitleInput");
  const title = input.value.trim() || `MVC: ${lastEvaluationResult.location_context.neighbourhood}`;
  await fetch(`${API_BASE}/scenarios`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      lat: lastEvaluationResult.query.lat,
      lon: lastEvaluationResult.query.lon,
      radius: lastEvaluationResult.query.radius_m,
      rooms: lastEvaluationResult.query.rooms,
      acquisition_cost_eur: lastEvaluationResult.airbnb_roi_metrics.estimated_acquisition_cost_eur,
      investment_score: lastEvaluationResult.investment_rating.score,
      estimated_annual_revenue_eur: lastEvaluationResult.airbnb_roi_metrics.estimated_annual_gross_revenue_eur,
      estimated_gross_roi_pct: lastEvaluationResult.airbnb_roi_metrics.gross_roi_yield_pct,
      neighbourhood: lastEvaluationResult.location_context.neighbourhood,
    }),
  });
  input.value = "";
  await loadSavedScenarios();
}

async function syncAllDataSources() {
  await fetch(`${API_BASE}/admin/sync`, { method: "POST" });
  await Promise.all([
    loadMapLayersAndNeighborhoods(),
    loadTopRecommendations(),
    loadEurostatDashboard(),
    runEvaluation(),
  ]);
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
    if (!resp.ok) return;
    const data = await resp.json();
    cachedTopRecommendations = data;
    renderTopRecommendationsUI(data);
  } catch (err) {
    console.error("MVC Top Recommendations error:", err);
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

  if (window.map) {
    window.map.flyTo([Number(lat), Number(lon)], 15, { duration: 0.6 });
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
      winnerCard.innerHTML = `<div class="text-xs text-rose-300">Δεν βρέθηκε ακίνητο εντός του επιλεγμένου προϋπολογισμού.</div>`;
    } else {
      const roomComparisonHtml = (top.room_options_comparison || [])
        .map((opt) => {
          const isBest = opt.rooms === top.best_rooms;
          return `
            <div onclick="event.stopPropagation(); applyRecommendationChoice(${top.lat}, ${top.lon}, ${opt.rooms}, '${top.neighbourhood}')"
              class="p-2 rounded-lg border cursor-pointer transition ${
                isBest
                  ? "bg-amber-500/20 border-amber-400 text-white"
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
                Κτήση: €${Number(opt.acquisition_cost_eur).toLocaleString("el-GR")} • ADR €${opt.adr_eur}
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
                <span class="px-2 py-0.5 rounded-md bg-amber-400 text-slate-950 text-[10px] font-black uppercase">
                  #1 ΚΟΡΥΦΑΙΑ ΕΠΙΛΟΓΗ
                </span>
                <span class="text-[11px] font-semibold text-amber-200/90">${top.municipality}</span>
              </div>
              <h4 class="text-base font-extrabold text-white mt-1 flex items-center gap-2">
                <span>📍 ${top.neighbourhood}</span>
                <span class="text-xs font-bold px-2 py-0.5 rounded-lg bg-indigo-500/30 border border-indigo-400/50 text-indigo-200">
                  Βέλτιστο: ${top.best_room_label}
                </span>
              </h4>
              <p class="text-[11px] text-slate-300 mt-0.5">
                Μετρό: <b>${top.nearest_metro_name}</b> (${top.nearest_metro_dist_m}m) • 🍽️ ~${top.dining_venues_in_catchment} χώροι εστίασης
              </p>
            </div>
            <div class="text-right bg-slate-950/80 border border-amber-500/40 rounded-xl px-3 py-1.5">
              <div class="text-[10px] uppercase text-amber-300 font-bold">Score</div>
              <div class="text-2xl font-black text-white">${top.investment_score}<span class="text-xs text-amber-300 font-normal">/100 (${top.grade})</span></div>
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2.5 pt-2.5 border-t border-amber-500/20 text-[11px]">
            <div class="bg-slate-950/60 rounded-lg p-2 border border-slate-800">
              <div class="text-slate-400 text-[10px]">Gross / Net ROI</div>
              <div class="font-extrabold text-emerald-400 text-sm">${top.gross_roi_pct}% <span class="text-[10px] text-slate-300 font-normal">(Net ${top.net_roi_pct}%)</span></div>
            </div>
            <div class="bg-slate-950/60 rounded-lg p-2 border border-slate-800">
              <div class="text-slate-400 text-[10px]">Καθαρό Κέρδος</div>
              <div class="font-extrabold text-white text-sm">€${Number(top.annual_net_income_eur).toLocaleString("el-GR")}/έτ.</div>
            </div>
            <div class="bg-slate-950/60 rounded-lg p-2 border border-slate-800">
              <div class="text-slate-400 text-[10px]">Κόστος Κτήσης (${top.best_sqm}m²)</div>
              <div class="font-extrabold text-cyan-300 text-sm">€${Number(top.acquisition_cost_eur).toLocaleString("el-GR")}</div>
            </div>
            <div class="bg-slate-950/60 rounded-lg p-2 border border-slate-800">
              <div class="text-slate-400 text-[10px]">Απόσβεση & ADR</div>
              <div class="font-extrabold text-amber-300 text-sm">${top.payback_years} έτη <span class="text-[10px] text-slate-300 font-normal">(€${top.adr_eur})</span></div>
            </div>
          </div>
        </div>

        <div class="mt-2.5">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-amber-200/80 mb-1.5">
            Σύγκριση Διαμερισμάτων στην Κορυφαία Περιοχή (${top.neighbourhood}):
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

