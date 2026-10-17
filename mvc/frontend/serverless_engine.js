/**
 * Browser-Side Serverless API Engine (`serverless_engine.js`)
 * Enables 100% standalone execution on GitHub Pages (`*.github.io`) or static hosting
 * without requiring a running Python backend server.
 *
 * When running locally (`127.0.0.1` / `localhost`), it uses the live Python FastAPI/Starlette server
 * and automatically falls back to this in-browser engine if the Python server is stopped.
 * When hosted on GitHub Pages (`*.github.io`), it intercepts `/api/v1/*` requests directly in the browser,
 * loads the real GeoJSON/JSON datasets (`layered/data/*.geojson`), and executes the exact same
 * Haversine, Point-in-Polygon, Inside Airbnb ROI, Investment Score (0-100), and Top Optimizer algorithms.
 */

(function () {
  const ORIGINAL_FETCH = window.fetch.bind(window);
  const IS_STATIC_HOST =
    window.location.hostname.endsWith("github.io") ||
    window.location.protocol === "file:" ||
    window.location.search.includes("serverless=1");

  const EARTH_RADIUS_M = 6371000.0;
  let DB_PROMISE = null;
  let TOP_REC_CACHE = {};

  function haversineDistanceM(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => (deg * Math.PI) / 180.0;
    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const dPhi = toRad(lat2 - lat1);
    const dLambda = toRad(lon2 - lon1);
    const a =
      Math.sin(dPhi / 2.0) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2.0) ** 2;
    return EARTH_RADIUS_M * 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
  }

  function pointInPolygon(lat, lon, ring) {
    if (!ring || ring.length < 3) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0],
        yi = ring[i][1];
      const xj = ring[j][0],
        yj = ring[j][1];
      const intersect =
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function normEl(str) {
    return (str || "")
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  async function resolveDataBaseUrl() {
    const candidates = ["../data", "./layered/data", "../../layered/data", "./data"];
    for (const base of candidates) {
      try {
        const r = await ORIGINAL_FETCH(`${base}/eurostat_urban_audit_cache.json`);
        if (r.ok) return base;
      } catch (_) {}
    }
    return "../data";
  }

  async function loadDatabase() {
    if (DB_PROMISE) return DB_PROMISE;
    DB_PROMISE = (async () => {
      const base = await resolveDataBaseUrl();
      const [nbResp, airbnbResp, poiResp, hazResp, euroResp, scenResp] =
        await Promise.all([
          ORIGINAL_FETCH(`${base}/neighborhoods.geojson`),
          ORIGINAL_FETCH(`${base}/airbnb_listings.geojson`),
          ORIGINAL_FETCH(`${base}/athens_gis_pois.geojson`),
          ORIGINAL_FETCH(`${base}/athens_gis_hazards.geojson`),
          ORIGINAL_FETCH(`${base}/eurostat_urban_audit_cache.json`),
          ORIGINAL_FETCH(`${base}/scenarios.json`),
        ]);

      const [nbGeo, airbnbGeo, poiGeo, hazGeo, euroCache, seedScenarios] =
        await Promise.all([
          nbResp.json(),
          airbnbResp.json(),
          poiResp.json(),
          hazResp.json(),
          euroResp.json(),
          scenResp.ok ? scenResp.json() : Promise.resolve([]),
        ]);

      return {
        neighborhoodsGeo: nbGeo,
        airbnbGeo: airbnbGeo,
        poisGeo: poiGeo,
        hazardsGeo: hazGeo,
        eurostatCache: euroCache,
        seedScenarios: Array.isArray(seedScenarios)
          ? seedScenarios
          : seedScenarios.scenarios || [],
      };
    })();
    return DB_PROMISE;
  }

  function detectNeighborhood(db, lat, lon) {
    const features = db.neighborhoodsGeo.features || [];
    for (const feat of features) {
      const rings = (feat.geometry && feat.geometry.coordinates) || [];
      if (rings.length && pointInPolygon(lat, lon, rings[0])) {
        return feat.properties;
      }
    }
    let bestProps = null;
    let minDist = Infinity;
    for (const feat of features) {
      const rings = (feat.geometry && feat.geometry.coordinates) || [];
      if (!rings.length || !rings[0].length) continue;
      const ring = rings[0];
      const cLon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const cLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const d = haversineDistanceM(lat, lon, cLat, cLon);
      if (d < minDist) {
        minDist = d;
        bestProps = feat.properties;
      }
    }
    return (
      bestProps || {
        name: "Κέντρο Αθήνας",
        name_en: "Central Athens",
        population: 15000,
        avg_purchase_price_sqm: 3200,
        avg_long_term_rent_sqm: 12.0,
        gentrification_trend: "Stable Urban Zone",
      }
    );
  }

  function evaluateProperty(db, lat, lon, radiusM = 600, rooms = 2, acquisitionCostEur = null) {
    const neighborhood = detectNeighborhood(db, lat, lon);
    const metroStations = [];
    const museumsList = [];
    const restaurantsList = [];
    const landmarksList = [];
    const allCulturalPois = [];

    for (const feat of db.poisGeo.features || []) {
      const [poiLon, poiLat] = feat.geometry.coordinates;
      const distM = Number(haversineDistanceM(lat, lon, poiLat, poiLon).toFixed(1));
      const props = feat.properties || {};
      const cat = props.category || "landmark";
      const item = {
        id: props.id,
        name: props.name,
        name_en: props.name_en,
        category: cat,
        type_label: props.type_label || cat,
        distance_m: distM,
        walking_minutes: Math.max(1, Math.round(distM / 80.0)),
        lines: props.lines || [],
        venue_count: Number(props.venue_count || 1),
        cuisine_profile: props.cuisine_profile || "",
        visitors_annual: Number(props.visitors_annual || 0),
      };
      if (cat === "metro") {
        metroStations.push(item);
      } else if (cat === "museum") {
        museumsList.push(item);
        allCulturalPois.push(item);
      } else if (cat === "restaurant") {
        restaurantsList.push(item);
        allCulturalPois.push(item);
      } else {
        landmarksList.push(item);
        allCulturalPois.push(item);
      }
    }

    const byDist = (a, b) => a.distance_m - b.distance_m;
    metroStations.sort(byDist);
    museumsList.sort(byDist);
    restaurantsList.sort(byDist);
    landmarksList.sort(byDist);
    allCulturalPois.sort(byDist);

    const nearestMetro = metroStations[0] || null;
    const nearestMuseum = museumsList[0] || null;
    const nearestRestaurant = restaurantsList[0] || null;
    const nearestLandmark = landmarksList[0] || null;
    const nearestPoi = allCulturalPois[0] || null;

    const catchmentM = Math.max(Number(radiusM) * 1.6, 1100.0);
    const metrosInCatchment = metroStations.filter((x) => x.distance_m <= catchmentM);
    const museumsInCatchment = museumsList.filter((x) => x.distance_m <= catchmentM);
    const restHubsInCatchment = restaurantsList.filter((x) => x.distance_m <= catchmentM);
    const landmarksInCatchment = landmarksList.filter((x) => x.distance_m <= catchmentM);

    let estimatedDiningVenues = restHubsInCatchment.reduce((s, x) => s + x.venue_count, 0);
    if (estimatedDiningVenues === 0 && nearestRestaurant) {
      estimatedDiningVenues = Math.max(12, Math.floor(nearestRestaurant.venue_count * 0.5));
    }

    const poiDistribution = {
      catchment_radius_m: Math.round(catchmentM),
      restaurant_hubs_count: restHubsInCatchment.length,
      estimated_dining_venues_count: estimatedDiningVenues,
      museums_count: museumsInCatchment.length,
      landmarks_count: landmarksInCatchment.length,
      metro_stations_count: metrosInCatchment.length,
      total_pois_in_catchment:
        restHubsInCatchment.length +
        museumsInCatchment.length +
        landmarksInCatchment.length +
        metrosInCatchment.length,
      chart_categories: [
        "Εστιατόρια & Πιάτσες Εστίασης",
        "Μουσεία & Αρχαιολογικοί Χώροι",
        "Αξιοθέατα, Πάρκα & Θέα",
        "Σταθμοί Μετρό & ΗΣΑΠ",
      ],
      chart_hub_counts: [
        Math.max(1, restHubsInCatchment.length),
        Math.max(1, museumsInCatchment.length),
        Math.max(1, landmarksInCatchment.length),
        Math.max(1, metrosInCatchment.length),
      ],
    };

    const activeHazards = [];
    let totalHazardPenalty = 0;
    for (const haz of db.hazardsGeo.features || []) {
      const rings = (haz.geometry && haz.geometry.coordinates) || [];
      const props = haz.properties || {};
      if (rings.length && pointInPolygon(lat, lon, rings[0])) {
        activeHazards.push(props);
        totalHazardPenalty += Number(props.penalty_points || 15);
      }
    }

    const nearbyListings = [];
    const sameRoomListings = [];
    const allListingsWithDist = [];

    for (const feat of db.airbnbGeo.features || []) {
      const [lLon, lLat] = feat.geometry.coordinates;
      const distM = Number(haversineDistanceM(lat, lon, lLat, lLon).toFixed(1));
      const props = Object.assign({}, feat.properties, {
        distance_m: distM,
        lat: lLat,
        lon: lLon,
      });
      allListingsWithDist.push([distM, props]);
      if (distM <= radiusM) {
        nearbyListings.push(props);
        if (Number(props.rooms || 1) === Number(rooms)) {
          sameRoomListings.push(props);
        }
      }
    }

    let usedFallbackCompetitors = false;
    if (!nearbyListings.length) {
      usedFallbackCompetitors = true;
      allListingsWithDist.sort((a, b) => a[0] - b[0]);
      for (const item of allListingsWithDist.slice(0, 6)) {
        nearbyListings.push(item[1]);
      }
    }

    const targetPool = sameRoomListings.length >= 2 ? sameRoomListings : nearbyListings;
    const rawAvgAdr =
      targetPool.reduce((s, x) => s + Number(x.price || 85), 0) / targetPool.length;
    const nbCensusAdr = Number(neighborhood.real_avg_adr_eur || rawAvgAdr);
    const blendedBaseAdr = 0.72 * rawAvgAdr + 0.28 * nbCensusAdr;

    const avgPoolRooms =
      targetPool.reduce((s, x) => s + Number(x.rooms || 2), 0) / targetPool.length;
    let roomMultiplier = 1.0 + 0.28 * (rooms - avgPoolRooms);
    roomMultiplier = Math.max(0.65, Math.min(1.85, roomMultiplier));

    const estimatedAdr = Number((blendedBaseAdr * roomMultiplier).toFixed(2));
    const avgOccupancy =
      targetPool.reduce((s, x) => s + Number(x.occupancy_rate || 0.68), 0) / targetPool.length;
    const avgOccupancyPct = Number((avgOccupancy * 100.0).toFixed(1));
    const avgRating = Number(
      (
        targetPool.reduce((s, x) => s + Number(x.review_scores_rating || 4.8), 0) /
        targetPool.length
      ).toFixed(2)
    );

    const occupiedNights = Math.round(365 * avgOccupancy);
    const estimatedAnnualGrossRevenue = Number((estimatedAdr * occupiedNights).toFixed(2));
    const estimatedAnnualNetIncome = Number((estimatedAnnualGrossRevenue * 0.72).toFixed(2));

    const estimatedSqm = 32 + rooms * 24;
    const pricePerSqm = Number(neighborhood.avg_purchase_price_sqm || 3300);
    const effectiveAcquisitionCost =
      acquisitionCostEur && Number(acquisitionCostEur) > 0
        ? Number(acquisitionCostEur)
        : Number((estimatedSqm * pricePerSqm).toFixed(2));

    const grossRoiPct = Number(
      ((estimatedAnnualGrossRevenue / effectiveAcquisitionCost) * 100.0).toFixed(2)
    );
    const netRoiPct = Number(
      ((estimatedAnnualNetIncome / effectiveAcquisitionCost) * 100.0).toFixed(2)
    );
    const paybackYears = Number(
      (effectiveAcquisitionCost / Math.max(1.0, estimatedAnnualNetIncome)).toFixed(1)
    );

    const ltMonthlyRent = Number(
      (estimatedSqm * Number(neighborhood.avg_long_term_rent_sqm || 12.0)).toFixed(2)
    );
    const ltAnnualRevenue = Number((ltMonthlyRent * 12).toFixed(2));
    const strPremiumPct = Number(
      (
        ((estimatedAnnualNetIncome - ltAnnualRevenue) / Math.max(1.0, ltAnnualRevenue)) *
        100.0
      ).toFixed(1)
    );

    const metroDist = nearestMetro ? nearestMetro.distance_m : 1500.0;
    const transitScore = Math.max(
      5.0,
      Math.min(30.0, 30.0 - Math.max(0.0, metroDist - 150.0) * 0.018)
    );
    const yieldScore = Math.min(
      35.0,
      Math.max(8.0, grossRoiPct * 1.9 + avgOccupancy * 12.0)
    );

    const poiDist = nearestPoi ? nearestPoi.distance_m : 1000.0;
    const poiDensityBonus = Math.min(
      6.0,
      (museumsInCatchment.length +
        restHubsInCatchment.length +
        landmarksInCatchment.length) *
        0.65
    );
    const amenityScore = Math.max(
      6.0,
      Math.min(20.0, 14.5 - Math.max(0.0, poiDist - 150.0) * 0.012 + poiDensityBonus)
    );

    const saturationRatio =
      (Number(neighborhood.total_airbnb_listings || 600) /
        Math.max(1.0, Number(neighborhood.population || 10000))) *
      1000.0;

    const priceRatio = pricePerSqm / 3250.0;
    const landmarkDist = nearestLandmark ? nearestLandmark.distance_m : 900.0;

    const qolTransitLocal = Number(
      Math.min(
        96.0,
        Math.max(42.0, 69.2 + (500.0 - metroDist) * 0.032 + metrosInCatchment.length * 3.5)
      ).toFixed(1)
    );
    const qolCultureLocal = Number(
      Math.min(
        96.0,
        Math.max(
          40.0,
          55.0 + museumsInCatchment.length * 5.2 + restHubsInCatchment.length * 3.8
        )
      ).toFixed(1)
    );
    const qolSafetyLocal = Number(
      Math.min(
        92.0,
        Math.max(
          36.0,
          54.2 + (priceRatio - 1.0) * 30.0 + Math.min(8.0, restHubsInCatchment.length * 1.4)
        )
      ).toFixed(1)
    );
    const qolGreenLocal = Number(
      Math.min(
        89.0,
        Math.max(
          22.0,
          37.2 +
            landmarksInCatchment.length * 7.5 +
            Math.max(0.0, (650.0 - landmarkDist) * 0.024) -
            (totalHazardPenalty > 0 ? 10.0 : 0.0)
        )
      ).toFixed(1)
    );
    const qolEnvQuietLocal = Number(
      Math.min(
        84.0,
        Math.max(
          20.0,
          52.0 -
            saturationRatio * 0.2 +
            landmarksInCatchment.length * 3.0 -
            totalHazardPenalty * 0.5
        )
      ).toFixed(1)
    );
    const qolCompositeScore = Number(
      (
        0.24 * qolTransitLocal +
        0.2 * qolCultureLocal +
        0.22 * qolSafetyLocal +
        0.18 * qolGreenLocal +
        0.16 * qolEnvQuietLocal
      ).toFixed(1)
    );
    const athensQolBaseline = 68.2;

    const qualityOfLifeMetrics = {
      source_dataset:
        "Eurostat Perception Survey on Quality of Life in European Cities (urb_percep, EL001C, 2023)",
      composite_qol_score: qolCompositeScore,
      athens_eurostat_baseline_pct: athensQolBaseline,
      vs_athens_average_diff: Number((qolCompositeScore - athensQolBaseline).toFixed(1)),
      qol_grade:
        qolCompositeScore >= 72
          ? "Εξαιρετική Ποιότητα Ζωής (Top Tier)"
          : qolCompositeScore >= 62
          ? "Υψηλή Ποιότητα Ζωής (Άνω του Μ.Ο. Αθήνας)"
          : "Μέτρια Αστική Ποιότητα Ζωής (Πυκνός Ιστός)",
      dimensions: [
        {
          id: "public_transport",
          code: "PS1012V+PS1013V",
          label: "🚇 Δημόσιες Συγκοινωνίες & Προσβασιμότητα",
          neighborhood_score_pct: qolTransitLocal,
          eurostat_athens_pct: 69.2,
        },
        {
          id: "cultural_facilities",
          code: "PS1082V+PS1083V",
          label: "🏛️ Πολιτισμός, Μουσεία & Αναψυχή",
          neighborhood_score_pct: qolCultureLocal,
          eurostat_athens_pct: 60.9,
        },
        {
          id: "safety_and_trust",
          code: "PS3519V+PS3520V",
          label: "🛡️ Ασφάλεια Γειτονιάς τη Νύχτα & Συνοχή",
          neighborhood_score_pct: qolSafetyLocal,
          eurostat_athens_pct: 54.2,
        },
        {
          id: "green_and_public_spaces",
          code: "PS1052V+PS1053V",
          label: "🌿 Χώροι Πρασίνου, Πάρκα & Πεζόδρομοι",
          neighborhood_score_pct: qolGreenLocal,
          eurostat_athens_pct: 37.2,
        },
        {
          id: "quietness_and_air",
          code: "PS3270V+PS3260V",
          label: "🔇 Ησυχία, Καθαριότητα & Ποιότητα Αέρα",
          neighborhood_score_pct: qolEnvQuietLocal,
          eurostat_athens_pct: 35.5,
        },
      ],
    };

    const baseMacro =
      saturationRatio < 80 ? 15.0 : saturationRatio < 130 ? 11.5 : 8.5;
    const qolBonus = Math.max(-1.5, Math.min(2.0, (qolCompositeScore - 62.0) * 0.12));
    const macroScore = Number(Math.min(15.0, Math.max(6.0, baseMacro + qolBonus)).toFixed(1));

    const rawScore =
      transitScore + yieldScore + amenityScore + macroScore - totalHazardPenalty;
    const investmentScore = Number(Math.max(10.0, Math.min(99.0, rawScore)).toFixed(1));

    let ratingLabel = "C (Αυξημένο Ρίσκο / Υψηλός Κορεσμός ή Φυσικός Κίνδυνος)";
    if (investmentScore >= 82) {
      ratingLabel = "A+ (Εξαιρετική Επενδυτική Ευκαιρία)";
    } else if (investmentScore >= 70) {
      ratingLabel = "A / B+ (Ισχυρή Απόδοση & Χαμηλός Κίνδυνος)";
    } else if (investmentScore >= 55) {
      ratingLabel = "B (Ισορροπημένη Επένδυση με Επιμέρους Ρίσκα)";
    }

    nearbyListings.sort((a, b) => a.distance_m - b.distance_m);

    const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
    const athensBaseIdx = [116.4, 121.0, 130.2, 145.8, 164.5, 179.2, 191.8];
    const growthAccel = Math.min(
      1.28,
      Math.max(0.84, 0.86 + (priceRatio - 0.85) * 0.35 + saturationRatio / 350.0)
    );
    const nbPriceIndexSeries = athensBaseIdx.map((baseVal, i) =>
      Number(
        (
          baseVal *
          (0.88 + 0.12 * priceRatio) *
          (1.0 + (growthAccel - 1.0) * (i / 6.0))
        ).toFixed(1)
      )
    );
    const idx2025 = Math.max(1.0, nbPriceIndexSeries[nbPriceIndexSeries.length - 1]);
    const nbPriceSqmSeries = nbPriceIndexSeries.map((val) =>
      Math.round(pricePerSqm * (val / idx2025))
    );
    const adrCurveFactors = [0.76, 0.58, 0.69, 0.83, 0.91, 0.96, 1.0];
    const nbAdrSeries = adrCurveFactors.map((f) => Number((nbCensusAdr * f).toFixed(1)));
    const nbTotalListings = Math.max(15, Number(neighborhood.total_airbnb_listings || 250));
    const demandCurveFactors = [0.68, 0.22, 0.44, 0.76, 0.89, 0.96, 1.0];
    const annualNights2025K = (nbTotalListings * occupiedNights * 2.1) / 1000.0;
    const nbNightsKSeries = demandCurveFactors.map((f) =>
      Number((annualNights2025K * f).toFixed(1))
    );

    return {
      status: "success",
      architecture: "Serverless Browser Engine (GitHub Pages Ready)",
      query: {
        lat: Number(lat.toFixed(6)),
        lon: Number(lon.toFixed(6)),
        radius_m: radiusM,
        rooms: rooms,
        estimated_sqm: estimatedSqm,
      },
      location_context: {
        neighbourhood: neighborhood.name,
        neighbourhood_en: neighborhood.name_en,
        neighbourhood_total_listings: neighborhood.total_airbnb_listings || 0,
        gentrification_trend: neighborhood.gentrification_trend,
        zone_building_factor: neighborhood.zone_building_factor || 3.0,
        avg_purchase_price_sqm: pricePerSqm,
        saturation_per_1000_residents: Number(saturationRatio.toFixed(1)),
        neighborhood_index_series: {
          years: years,
          neighbourhood: neighborhood.name,
          neighborhood_name: neighborhood.name,
          neighborhood_price_index_2015_100: nbPriceIndexSeries,
          athens_baseline_price_index_2015_100: athensBaseIdx,
          neighborhood_price_sqm_eur: nbPriceSqmSeries,
          neighborhood_adr_eur: nbAdrSeries,
          neighborhood_tourist_nights_thousands: nbNightsKSeries,
        },
        quality_of_life: qualityOfLifeMetrics,
      },
      quality_of_life_metrics: qualityOfLifeMetrics,
      investment_rating: {
        score: investmentScore,
        grade: ratingLabel,
        formula:
          "Score = Μετρό(0-30) + Απόδοση ROI(0-35) + POIs/Εστίαση/Μουσεία(0-20) + Eurostat QoL/Αγορά(0-15) - Ποινή Κινδύνων(0 έως -25)",
        breakdown: {
          transit_accessibility_score: Number(transitScore.toFixed(1)),
          airbnb_yield_score: Number(yieldScore.toFixed(1)),
          urban_amenities_score: Number(amenityScore.toFixed(1)),
          macro_resilience_score: Number(macroScore.toFixed(1)),
          neighborhood_macro_score: Number(macroScore.toFixed(1)),
          quality_of_life_index: qolCompositeScore,
          natural_hazard_penalty: -totalHazardPenalty,
        },
      },
      airbnb_roi_metrics: {
        competitors_in_radius: usedFallbackCompetitors ? 0 : nearbyListings.length,
        sample_size_used: targetPool.length,
        used_nearest_fallback: usedFallbackCompetitors,
        average_daily_rate_eur: estimatedAdr,
        occupancy_rate_pct: avgOccupancyPct,
        occupied_nights_per_year: occupiedNights,
        estimated_annual_gross_revenue_eur: estimatedAnnualGrossRevenue,
        estimated_annual_net_income_eur: estimatedAnnualNetIncome,
        estimated_acquisition_cost_eur: effectiveAcquisitionCost,
        gross_roi_yield_pct: grossRoiPct,
        net_roi_yield_pct: netRoiPct,
        payback_period_years: paybackYears,
        long_term_annual_rent_eur: ltAnnualRevenue,
        str_vs_long_term_premium_pct: strPremiumPct,
        avg_competitor_rating: avgRating,
        nearby_competitors: nearbyListings.slice(0, 8),
      },
      gis_spatial_analysis: {
        nearest_metro: nearestMetro,
        nearest_poi: nearestPoi,
        nearest_museum: nearestMuseum,
        nearest_restaurant_hub: nearestRestaurant,
        nearest_landmark: nearestLandmark,
        nearest_university_or_school: nearestPoi,
        nearby_metro_stations: metroStations.slice(0, 4),
        nearby_places_of_interest: allCulturalPois.slice(0, 6),
        nearby_museums: museumsList.slice(0, 4),
        nearby_restaurants: restaurantsList.slice(0, 4),
        nearby_landmarks: landmarksList.slice(0, 4),
        poi_distribution: poiDistribution,
        natural_hazards_detected: activeHazards,
        is_in_hazard_zone: activeHazards.length > 0,
      },
    };
  }

  function getNeighborhoodsAnalytics(db) {
    const neighborhoods = db.neighborhoodsGeo.features || [];
    const listings = db.airbnbGeo.features || [];
    const results = [];

    for (const feat of neighborhoods) {
      const props = feat.properties || {};
      const nbName = props.name;
      const rings = (feat.geometry && feat.geometry.coordinates) || [];
      const ring = rings.length && rings[0].length ? rings[0] : [[23.7325, 37.9755]];
      const centerLon = Number(
        (ring.reduce((s, p) => s + p[0], 0) / ring.length).toFixed(5)
      );
      const centerLat = Number(
        (ring.reduce((s, p) => s + p[1], 0) / ring.length).toFixed(5)
      );

      const nbListings = listings
        .map((l) => l.properties)
        .filter((lp) => lp.neighbourhood === nbName);

      const avgAdr = Number(
        props.real_avg_adr_eur ||
          (nbListings.length
            ? nbListings.reduce((s, x) => s + Number(x.price), 0) / nbListings.length
            : 92.0)
      );
      const avgOcc = Number(
        props.real_avg_occupancy_pct ||
          (nbListings.length
            ? (nbListings.reduce((s, x) => s + Number(x.occupancy_rate), 0) /
                nbListings.length) *
              100.0
            : 68.0)
      );
      const avgRev = Math.round(avgAdr * 365 * (avgOcc / 100.0));
      const population = Number(props.population || 10000);
      const totalStr = Number(props.total_airbnb_listings || nbListings.length);
      const listingsPer1000 = Number(
        ((totalStr / Math.max(1, population)) * 1000.0).toFixed(1)
      );
      const densityPerKm2 = Number(
        (totalStr / Math.max(0.1, Number(props.area_km2 || 1.0))).toFixed(1)
      );

      let saturationLevel = "LOW_OPPORTUNITY";
      let heatmapColor = "#22c55e";
      if (listingsPer1000 >= 90) {
        saturationLevel = "CRITICAL";
        heatmapColor = "#ef4444";
      } else if (listingsPer1000 >= 45) {
        saturationLevel = "HIGH";
        heatmapColor = "#f97316";
      } else if (listingsPer1000 >= 20) {
        saturationLevel = "MODERATE";
        heatmapColor = "#eab308";
      }

      results.push({
        neighbourhood_id: props.neighbourhood_id,
        name: nbName,
        name_en: props.name_en,
        center_lat: centerLat,
        center_lon: centerLon,
        population: population,
        area_km2: props.area_km2,
        total_airbnb_listings: totalStr,
        airbnb_listings_count: totalStr,
        sample_listings_count: nbListings.length,
        listings_per_1000_residents: listingsPer1000,
        airbnb_density_per_km2: densityPerKm2,
        saturation_level: saturationLevel,
        heatmap_color: heatmapColor,
        avg_adr_eur: Number(avgAdr.toFixed(2)),
        avg_occupancy_pct: Number(avgOcc.toFixed(1)),
        estimated_avg_annual_revenue_eur: avgRev,
        avg_long_term_rent_sqm: props.avg_long_term_rent_sqm,
        avg_purchase_price_sqm: props.avg_purchase_price_sqm,
        gentrification_trend: props.gentrification_trend,
        geometry: feat.geometry,
      });
    }

    results.sort((a, b) => b.total_airbnb_listings - a.total_airbnb_listings);
    return {
      status: "success",
      city: "Αθήνα (EL300 / EL001C)",
      total_neighborhoods: results.length,
      total_city_airbnb_listings: results.reduce(
        (s, r) => s + r.total_airbnb_listings,
        0
      ),
      neighborhoods: results,
    };
  }

  function getTopRecommendations(db, targetRooms, maxBudgetEur, strategy = "score", radiusM = 600) {
    const cacheKey = `${targetRooms || "auto"}_${maxBudgetEur || 0}_${strategy}_${radiusM}`;
    if (TOP_REC_CACHE[cacheKey]) return TOP_REC_CACHE[cacheKey];

    const neighborhoods = db.neighborhoodsGeo.features || [];
    const listings = db.airbnbGeo.features || [];
    const listingsByNb = {};
    for (const lFeat of listings) {
      const nb = (lFeat.properties && lFeat.properties.neighbourhood) || "";
      if (!listingsByNb[nb]) listingsByNb[nb] = [];
      listingsByNb[nb].push(lFeat);
    }

    const roomLabels = {
      1: "1 Υπνοδωμάτιο / Studio (56 m²)",
      2: "2 Υπνοδωμάτια — Οικογενειακό/Ζευγάρια (80 m²)",
      3: "3 Υπνοδωμάτια — Group/Penthouse (104 m²)",
    };

    const rankedLocations = [];
    for (const feat of neighborhoods) {
      const props = feat.properties || {};
      const nbName = props.name;
      const rings = (feat.geometry && feat.geometry.coordinates) || [];
      const ring = rings.length && rings[0].length ? rings[0] : [[23.7325, 37.9755]];
      const cLon = Number(
        (ring.reduce((s, p) => s + p[0], 0) / ring.length).toFixed(5)
      );
      const cLat = Number(
        (ring.reduce((s, p) => s + p[1], 0) / ring.length).toFixed(5)
      );

      const nbList = listingsByNb[nbName] || [];
      let evalLat = cLat;
      let evalLon = cLon;
      if (nbList.length) {
        let bestL = nbList[0];
        let bestRankScore = -1;
        for (const cand of nbList) {
          const s =
            Number(cand.properties.review_scores_rating || 4.7) * 40 +
            Math.min(200, Number(cand.properties.number_of_reviews || 20));
          if (s > bestRankScore) {
            bestRankScore = s;
            bestL = cand;
          }
        }
        const [spotLon, spotLat] = bestL.geometry.coordinates;
        evalLat = Number((0.65 * spotLat + 0.35 * cLat).toFixed(5));
        evalLon = Number((0.65 * spotLon + 0.35 * cLon).toFixed(5));
      }

      const roomEvals = {};
      const roomComparisonList = [];
      for (const r of [1, 2, 3]) {
        const ev = evaluateProperty(db, evalLat, evalLon, radiusM, r, null);
        roomEvals[r] = ev;
        const roiM = ev.airbnb_roi_metrics;
        const ratM = ev.investment_rating;
        const withinBudget =
          !maxBudgetEur || maxBudgetEur <= 0
            ? true
            : roiM.estimated_acquisition_cost_eur <= maxBudgetEur;
        roomComparisonList.push({
          rooms: r,
          room_label: roomLabels[r],
          estimated_sqm: ev.query.estimated_sqm,
          score: ratM.score,
          grade: ratM.grade,
          adr_eur: roiM.average_daily_rate_eur,
          occupancy_pct: roiM.occupancy_rate_pct,
          annual_gross_revenue_eur: roiM.estimated_annual_gross_revenue_eur,
          annual_net_income_eur: roiM.estimated_annual_net_income_eur,
          acquisition_cost_eur: roiM.estimated_acquisition_cost_eur,
          gross_roi_pct: roiM.gross_roi_yield_pct,
          net_roi_pct: roiM.net_roi_yield_pct,
          payback_years: roiM.payback_period_years,
          within_budget: withinBudget,
        });
      }

      let eligible = [];
      if (targetRooms === 1 || targetRooms === 2 || targetRooms === 3) {
        eligible = roomComparisonList.filter((c) => c.rooms === targetRooms);
      } else {
        eligible = roomComparisonList.filter((c) => c.within_budget);
        if (!eligible.length) eligible = [roomComparisonList[0]];
      }

      eligible.sort((a, b) => {
        if (strategy === "roi") return b.gross_roi_pct - a.gross_roi_pct || b.score - a.score;
        if (strategy === "revenue")
          return b.annual_net_income_eur - a.annual_net_income_eur || b.score - a.score;
        return b.score - a.score || b.gross_roi_pct - a.gross_roi_pct;
      });
      const bestOpt = eligible[0];
      const chosenEv = roomEvals[bestOpt.rooms];
      const gisM = chosenEv.gis_spatial_analysis;
      const locM = chosenEv.location_context;
      const ratM = chosenEv.investment_rating;

      rankedLocations.push({
        neighbourhood: nbName,
        neighbourhood_en: props.name_en || nbName,
        municipality: "Δήμος Αθηναίων (EL001C)",
        lat: evalLat,
        lon: evalLon,
        best_rooms: bestOpt.rooms,
        best_room_label: bestOpt.room_label,
        best_sqm: bestOpt.estimated_sqm,
        investment_score: bestOpt.score,
        grade: bestOpt.grade,
        score_breakdown: ratM.breakdown,
        adr_eur: bestOpt.adr_eur,
        occupancy_pct: bestOpt.occupancy_pct,
        annual_gross_revenue_eur: bestOpt.annual_gross_revenue_eur,
        annual_net_income_eur: bestOpt.annual_net_income_eur,
        acquisition_cost_eur: bestOpt.acquisition_cost_eur,
        avg_purchase_price_sqm: locM.avg_purchase_price_sqm,
        gross_roi_pct: bestOpt.gross_roi_pct,
        net_roi_pct: bestOpt.net_roi_pct,
        payback_years: bestOpt.payback_years,
        gentrification_trend: locM.gentrification_trend,
        saturation_per_1000_residents: locM.saturation_per_1000_residents,
        nearest_metro_name: gisM.nearest_metro ? gisM.nearest_metro.name : "-",
        nearest_metro_dist_m: gisM.nearest_metro ? gisM.nearest_metro.distance_m : 0,
        nearest_poi_name: gisM.nearest_poi ? gisM.nearest_poi.name : "-",
        dining_venues_in_catchment: gisM.poi_distribution.estimated_dining_venues_count,
        budget_compliant: bestOpt.within_budget,
        room_options_comparison: roomComparisonList,
      });
    }

    rankedLocations.sort((a, b) => {
      const ba = a.budget_compliant ? 1 : 0;
      const bb = b.budget_compliant ? 1 : 0;
      if (bb !== ba) return bb - ba;
      if (strategy === "roi")
        return b.gross_roi_pct - a.gross_roi_pct || b.investment_score - a.investment_score;
      if (strategy === "revenue")
        return (
          b.annual_net_income_eur - a.annual_net_income_eur ||
          b.investment_score - a.investment_score
        );
      return b.investment_score - a.investment_score || b.gross_roi_pct - a.gross_roi_pct;
    });

    rankedLocations.forEach((item, idx) => {
      item.rank = idx + 1;
    });

    const result = {
      status: "success",
      strategy: strategy,
      target_rooms: targetRooms || "auto",
      max_budget_eur: maxBudgetEur,
      total_neighborhoods_evaluated: rankedLocations.length,
      total_combinations_evaluated: rankedLocations.length * 3,
      top_overall_pick: rankedLocations[0] || null,
      top_recommendations: rankedLocations.slice(0, 10),
    };
    TOP_REC_CACHE[cacheKey] = result;
    return result;
  }

  async function geocodeAthens(db, query) {
    const q = normEl(query);
    const matches = [];

    for (const feat of db.neighborhoodsGeo.features || []) {
      const props = feat.properties || {};
      if (
        normEl(props.name).includes(q) ||
        normEl(props.name_en).includes(q) ||
        normEl(props.neighbourhood_raw).includes(q)
      ) {
        const ring = feat.geometry.coordinates[0];
        const cLon = Number(
          (ring.reduce((s, p) => s + p[0], 0) / ring.length).toFixed(5)
        );
        const cLat = Number(
          (ring.reduce((s, p) => s + p[1], 0) / ring.length).toFixed(5)
        );
        matches.push({
          name: props.name,
          name_en: props.name_en,
          type: "neighborhood",
          lat: cLat,
          lon: cLon,
          source: "Inside Airbnb / Athens GIS Neighborhoods",
        });
      }
    }

    for (const feat of db.poisGeo.features || []) {
      const props = feat.properties || {};
      if (normEl(props.name).includes(q) || normEl(props.name_en).includes(q)) {
        const [lon, lat] = feat.geometry.coordinates;
        matches.push({
          name: props.name,
          name_en: props.name_en,
          type: props.category,
          lat: lat,
          lon: lon,
          source: "Athens GIS POIs",
        });
      }
    }

    if (matches.length < 3 && q.length >= 3) {
      try {
        const omResp = await ORIGINAL_FETCH(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
            query
          )}&count=5&language=el&format=json`
        );
        if (omResp.ok) {
          const omData = await omResp.json();
          for (const item of omData.results || []) {
            if (item.country_code === "GR") {
              matches.push({
                name: `${item.name} (${item.admin2 || "Αττική"})`,
                name_en: item.name,
                type: "geocoded_place",
                lat: item.latitude,
                lon: item.longitude,
                source: "Open-Meteo Geocoding API",
              });
            }
          }
        }
      } catch (_) {}
    }

    return {
      status: "success",
      query: query,
      count: matches.length,
      results: matches.slice(0, 8),
    };
  }

  function getStoredScenarios(db) {
    try {
      const raw = localStorage.getItem("athens_urban_scenarios_v1");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch (_) {}
    return db.seedScenarios || [];
  }

  function saveStoredScenario(db, body) {
    const list = getStoredScenarios(db).slice();
    const newItem = Object.assign(
      {
        id: `SCN-${Date.now()}`,
        created_at: new Date().toISOString(),
      },
      body
    );
    list.unshift(newItem);
    try {
      localStorage.setItem("athens_urban_scenarios_v1", JSON.stringify(list));
    } catch (_) {}
    return newItem;
  }

  function makeJsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status: status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function handleServerlessApi(urlStr, options = {}) {
    const db = await loadDatabase();
    const u = new URL(urlStr, window.location.origin);
    const path = u.pathname;
    const method = (options.method || "GET").toUpperCase();

    if (path.endsWith("/api/v1/health")) {
      return makeJsonResponse({
        status: "healthy",
        version: "1.0.0",
        architecture: "Serverless In-Browser Engine (GitHub Pages)",
        datasets_loaded: {
          neighborhoods: (db.neighborhoodsGeo.features || []).length,
          airbnb_listings_sample: (db.airbnbGeo.features || []).length,
          athens_gis_pois: (db.poisGeo.features || []).length,
          athens_gis_hazards: (db.hazardsGeo.features || []).length,
        },
      });
    }

    if (path.endsWith("/api/v1/gis/layers")) {
      return makeJsonResponse({
        status: "success",
        layers: {
          neighborhoods: db.neighborhoodsGeo,
          airbnb_listings: db.airbnbGeo,
          athens_gis_pois: db.poisGeo,
          athens_gis_hazards: db.hazardsGeo,
          gis_pois: db.poisGeo,
          natural_hazards: db.hazardsGeo,
        },
      });
    }

    if (path.endsWith("/api/v1/neighborhoods/analytics")) {
      return makeJsonResponse(getNeighborhoodsAnalytics(db));
    }

    if (path.endsWith("/api/v1/properties/evaluate")) {
      const lat = parseFloat(u.searchParams.get("lat") || "37.9648");
      const lon = parseFloat(u.searchParams.get("lon") || "23.7265");
      const radius = parseFloat(u.searchParams.get("radius") || "600");
      const rooms = parseInt(u.searchParams.get("rooms") || "2", 10);
      const acq = u.searchParams.get("acquisition_cost");
      const cost = acq ? parseFloat(acq) : null;
      return makeJsonResponse(evaluateProperty(db, lat, lon, radius, rooms, cost));
    }

    if (path.endsWith("/api/v1/properties/top-recommendations")) {
      const roomsRaw = u.searchParams.get("rooms") || "auto";
      const targetRooms = ["1", "2", "3"].includes(roomsRaw)
        ? parseInt(roomsRaw, 10)
        : null;
      const budgetRaw = parseFloat(u.searchParams.get("budget") || "0");
      const maxBudget = budgetRaw > 0 ? budgetRaw : null;
      const strategy = u.searchParams.get("strategy") || "score";
      const radius = parseFloat(u.searchParams.get("radius") || "600");
      return makeJsonResponse(
        getTopRecommendations(db, targetRooms, maxBudget, strategy, radius)
      );
    }

    if (path.endsWith("/api/v1/macro/urban-audit")) {
      const cache = db.eurostatCache || {};
      const cities = cache.cities || {};
      return makeJsonResponse({
        status: "success",
        connection: {
          mode: "GITHUB_PAGES_EUROSTAT_SDMX_DATASET",
          official_eurostat_city_code: "EL001C (Athina - Greater City)",
          requires_api_key: false,
        },
        requested_city: "EL300",
        city_analytics: cities.EL300 || {},
        live_eurostat_sdmx_extract: cache.live_eurostat_sdmx_extract || {},
        comparison_cities: Object.keys(cities)
          .filter((k) => k !== "EL300")
          .map((k) => cities[k]),
        eu_mediterranean_benchmark:
          cache.eu_Mediterranean_benchmark ||
          cache.eu_mediterranean_benchmark ||
          [],
      });
    }

    if (path.endsWith("/api/v1/gis/geocode")) {
      const q = u.searchParams.get("q") || "Κουκάκι";
      const res = await geocodeAthens(db, q);
      return makeJsonResponse(res);
    }

    if (path.endsWith("/api/v1/scenarios")) {
      if (method === "POST") {
        let body = {};
        try {
          body = typeof options.body === "string" ? JSON.parse(options.body) : {};
        } catch (_) {}
        const saved = saveStoredScenario(db, body);
        return makeJsonResponse({ status: "created", scenario: saved }, 201);
      }
      const list = getStoredScenarios(db);
      return makeJsonResponse({
        status: "success",
        count: list.length,
        scenarios: list,
      });
    }

    if (path.endsWith("/api/v1/admin/sync")) {
      TOP_REC_CACHE = {};
      return makeJsonResponse({
        status: "synchronized",
        synced_at: new Date().toISOString(),
      });
    }

    return makeJsonResponse({ status: "error", message: "Unknown endpoint" }, 404);
  }

  window.fetch = async function (input, init) {
    const urlStr = typeof input === "string" ? input : input.url || "";
    if (urlStr.includes("/api/v1/")) {
      if (IS_STATIC_HOST) {
        return handleServerlessApi(urlStr, init);
      }
      try {
        const resp = await ORIGINAL_FETCH(input, init);
        if (resp.ok || resp.status === 201) return resp;
        return handleServerlessApi(urlStr, init);
      } catch (_) {
        return handleServerlessApi(urlStr, init);
      }
    }
    return ORIGINAL_FETCH(input, init);
  };
})();
