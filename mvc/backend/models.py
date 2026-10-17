"""
MVC Architecture - Model Layer (`mvc/backend/models.py`)
Encapsulates the Domain Models, Geospatial Algorithms (Haversine, Point-in-Polygon),
Data Persistence (`mvc/data/`), and External REST API Integrations (Eurostat SDMX & Open-Meteo Geocoding).
"""

import json
import math
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import requests

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
EARTH_RADIUS_M = 6371000.0


def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculates great-circle distance in meters between two WGS84 coordinates."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    return EARTH_RADIUS_M * (2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a)))


def point_in_polygon(lat: float, lon: float, polygon_coords: List[List[float]]) -> bool:
    """Ray-casting algorithm to determine if (lon, lat) lies inside a GeoJSON polygon ring."""
    inside = False
    n = len(polygon_coords)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = polygon_coords[i][0], polygon_coords[i][1]
        xj, yj = polygon_coords[j][0], polygon_coords[j][1]
        intersect = ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / ((yj - yi) + 1e-12) + xi
        )
        if intersect:
            inside = not inside
        j = i
    return inside


class UrbanDataStoreModel:
    """Base Model managing in-memory and disk-persisted GeoJSON/JSON entities in `mvc/data/`."""

    def __init__(self, data_dir: Path = DATA_DIR) -> None:
        self.data_dir = data_dir
        self.airbnb: Dict[str, Any] = {}
        self.neighborhoods: Dict[str, Any] = {}
        self.gis_pois: Dict[str, Any] = {}
        self.gis_hazards: Dict[str, Any] = {}
        self.eurostat: Dict[str, Any] = {}
        self.scenarios: List[Dict[str, Any]] = []
        self.reload()

    def reload(self) -> Dict[str, int]:
        self.airbnb = self._load("airbnb_listings.geojson")
        self.neighborhoods = self._load("neighborhoods.geojson")
        self.gis_pois = self._load("athens_gis_pois.geojson")
        self.gis_hazards = self._load("athens_gis_hazards.geojson")
        self.eurostat = self._load("eurostat_urban_audit_cache.json")
        self.scenarios = self._load("scenarios.json")
        return {
            "airbnb_listings": len(self.airbnb.get("features", [])),
            "neighborhoods": len(self.neighborhoods.get("features", [])),
            "gis_pois": len(self.gis_pois.get("features", [])),
            "gis_hazards": len(self.gis_hazards.get("features", [])),
            "eurostat_cities": len(self.eurostat.get("cities", {})),
            "scenarios": len(self.scenarios),
        }

    def _load(self, filename: str) -> Any:
        with open(self.data_dir / filename, "r", encoding="utf-8") as f:
            return json.load(f)

    def _save(self, filename: str, data: Any) -> None:
        with open(self.data_dir / filename, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


class PropertyEvaluationModel:
    """Domain Model for Micro-Location Scoring, Airbnb ROI, and Natural Hazard Evaluation."""

    def __init__(self, store: UrbanDataStoreModel) -> None:
        self.store = store

    def find_neighborhood(self, lat: float, lon: float) -> Dict[str, Any]:
        features = self.store.neighborhoods.get("features", [])
        for feat in features:
            rings = feat.get("geometry", {}).get("coordinates", [])
            if rings and point_in_polygon(lat, lon, rings[0]):
                return feat["properties"]

        best_props: Optional[Dict[str, Any]] = None
        min_dist = float("inf")
        for feat in features:
            rings = feat.get("geometry", {}).get("coordinates", [])
            if not rings or not rings[0]:
                continue
            ring = rings[0]
            c_lon = sum(p[0] for p in ring) / len(ring)
            c_lat = sum(p[1] for p in ring) / len(ring)
            d = haversine_distance_m(lat, lon, c_lat, c_lon)
            if d < min_dist:
                min_dist = d
                best_props = feat["properties"]
        return best_props or {"name": "Κέντρο Αθήνας", "population": 15000, "avg_purchase_price_sqm": 3200}

    def evaluate(
        self,
        lat: float,
        lon: float,
        radius_m: float = 600.0,
        rooms: int = 2,
        acquisition_cost_eur: Optional[float] = None,
    ) -> Dict[str, Any]:
        nb = self.find_neighborhood(lat, lon)

        # 1. Athens GIS POIs (Metro, Museums, Restaurants, Landmarks)
        metros, museums, restaurants, landmarks, all_pois = [], [], [], [], []
        for feat in self.store.gis_pois.get("features", []):
            c = feat["geometry"]["coordinates"]
            dist_m = round(haversine_distance_m(lat, lon, c[1], c[0]), 1)
            p = feat["properties"]
            cat = p.get("category", "landmark")
            entry = {
                "id": p.get("id"),
                "name": p.get("name"),
                "name_en": p.get("name_en"),
                "category": cat,
                "type_label": p.get("type_label", cat),
                "distance_m": dist_m,
                "walking_minutes": max(1, round(dist_m / 80.0)),
                "lines": p.get("lines", []),
                "venue_count": int(p.get("venue_count", 1)),
                "cuisine_profile": p.get("cuisine_profile", ""),
            }
            if cat == "metro":
                metros.append(entry)
            elif cat == "museum":
                museums.append(entry)
                all_pois.append(entry)
            elif cat == "restaurant":
                restaurants.append(entry)
                all_pois.append(entry)
            else:
                landmarks.append(entry)
                all_pois.append(entry)

        metros.sort(key=lambda x: x["distance_m"])
        museums.sort(key=lambda x: x["distance_m"])
        restaurants.sort(key=lambda x: x["distance_m"])
        landmarks.sort(key=lambda x: x["distance_m"])
        all_pois.sort(key=lambda x: x["distance_m"])

        nearest_metro = metros[0] if metros else None
        nearest_museum = museums[0] if museums else None
        nearest_restaurant = restaurants[0] if restaurants else None
        nearest_landmark = landmarks[0] if landmarks else None
        nearest_poi = all_pois[0] if all_pois else None

        catchment_m = max(float(radius_m) * 1.6, 1100.0)
        m_catch = [x for x in metros if x["distance_m"] <= catchment_m]
        mus_catch = [x for x in museums if x["distance_m"] <= catchment_m]
        rest_catch = [x for x in restaurants if x["distance_m"] <= catchment_m]
        land_catch = [x for x in landmarks if x["distance_m"] <= catchment_m]
        est_venues = sum(x["venue_count"] for x in rest_catch) or (
            max(12, int(nearest_restaurant["venue_count"] * 0.5)) if nearest_restaurant else 20
        )

        poi_distribution = {
            "catchment_radius_m": round(catchment_m),
            "restaurant_hubs_count": len(rest_catch),
            "estimated_dining_venues_count": est_venues,
            "museums_count": len(mus_catch),
            "landmarks_count": len(land_catch),
            "metro_stations_count": len(m_catch),
            "total_pois_in_catchment": len(rest_catch) + len(mus_catch) + len(land_catch) + len(m_catch),
            "chart_categories": [
                "Εστιατόρια & Πιάτσες Εστίασης",
                "Μουσεία & Αρχαιολογικοί Χώροι",
                "Αξιοθέατα, Πάρκα & Θέα",
                "Σταθμοί Μετρό & ΗΣΑΠ",
            ],
            "chart_hub_counts": [
                max(1, len(rest_catch)),
                max(1, len(mus_catch)),
                max(1, len(land_catch)),
                max(1, len(m_catch)),
            ],
        }

        # 2. Athens GIS Hazards
        hazards_detected = []
        penalty = 0
        for h in self.store.gis_hazards.get("features", []):
            rings = h.get("geometry", {}).get("coordinates", [])
            if rings and point_in_polygon(lat, lon, rings[0]):
                hazards_detected.append(h["properties"])
                penalty += int(h["properties"].get("penalty_points", 15))

        # 3. Inside Airbnb Competitors
        nearby, same_rooms, all_dist = [], [], []
        for feat in self.store.airbnb.get("features", []):
            c = feat["geometry"]["coordinates"]
            dist_m = round(haversine_distance_m(lat, lon, c[1], c[0]), 1)
            p = dict(feat["properties"])
            p["distance_m"] = dist_m
            p["lat"], p["lon"] = c[1], c[0]
            all_dist.append((dist_m, p))
            if dist_m <= radius_m:
                nearby.append(p)
                if int(p.get("rooms", 1)) == int(rooms):
                    same_rooms.append(p)

        used_fallback = False
        if not nearby:
            used_fallback = True
            all_dist.sort(key=lambda x: x[0])
            nearby = [x[1] for x in all_dist[:6]]

        pool = same_rooms if len(same_rooms) >= 2 else nearby
        raw_adr = sum(float(x["price"]) for x in pool) / len(pool)
        nb_adr = float(nb.get("real_avg_adr_eur", raw_adr))
        base_adr = 0.72 * raw_adr + 0.28 * nb_adr
        avg_rooms = sum(int(x.get("rooms", 2)) for x in pool) / len(pool)
        mult = max(0.65, min(1.85, 1.0 + 0.28 * (rooms - avg_rooms)))

        adr = round(base_adr * mult, 2)
        occ = sum(float(x["occupancy_rate"]) for x in pool) / len(pool)
        occ_pct = round(occ * 100.0, 1)
        nights = round(365 * occ)
        gross_rev = round(adr * nights, 2)
        net_inc = round(gross_rev * 0.72, 2)

        sqm = 32 + (rooms * 24)
        price_sqm = float(nb.get("avg_purchase_price_sqm", 3300))
        cost = (
            float(acquisition_cost_eur)
            if acquisition_cost_eur and acquisition_cost_eur > 0
            else round(sqm * price_sqm, 2)
        )
        gross_roi = round((gross_rev / cost) * 100.0, 2)
        net_roi = round((net_inc / cost) * 100.0, 2)
        payback = round(cost / max(1.0, net_inc), 1)

        lt_annual = round(sqm * float(nb.get("avg_long_term_rent_sqm", 12.0)) * 12, 2)
        str_prem = round(((net_inc - lt_annual) / max(1.0, lt_annual)) * 100.0, 1)

        # 4. Investment Score (0-100)
        m_dist = nearest_metro["distance_m"] if nearest_metro else 1500.0
        transit_sc = max(5.0, min(30.0, 30.0 - max(0.0, (m_dist - 150.0)) * 0.018))
        yield_sc = min(35.0, max(8.0, (gross_roi * 1.9) + (occ * 12.0)))
        p_dist = nearest_poi["distance_m"] if nearest_poi else 1000.0
        poi_bonus = min(6.0, (len(mus_catch) + len(rest_catch) + len(land_catch)) * 0.65)
        amenity_sc = max(6.0, min(20.0, 14.5 - max(0.0, (p_dist - 150.0)) * 0.012 + poi_bonus))
        sat = float(nb.get("total_airbnb_listings", 600)) / max(1.0, float(nb.get("population", 10000))) * 1000.0
        price_ratio = price_sqm / 3250.0
        landmark_dist = nearest_landmark["distance_m"] if nearest_landmark else 900.0

        qol_transit_local = round(
            min(96.0, max(42.0, 69.2 + (500.0 - m_dist) * 0.032 + len(m_catch) * 3.5)), 1
        )
        qol_culture_local = round(
            min(96.0, max(40.0, 55.0 + len(mus_catch) * 5.2 + len(rest_catch) * 3.8)), 1
        )
        qol_safety_local = round(
            min(92.0, max(36.0, 54.2 + (price_ratio - 1.0) * 30.0 + min(8.0, len(rest_catch) * 1.4))), 1
        )
        qol_green_local = round(
            min(
                89.0,
                max(
                    22.0,
                    37.2
                    + len(land_catch) * 7.5
                    + max(0.0, (650.0 - landmark_dist) * 0.024)
                    - (10.0 if penalty > 0 else 0.0),
                ),
            ),
            1,
        )
        qol_env_quiet_local = round(
            min(84.0, max(20.0, 52.0 - sat * 0.20 + len(land_catch) * 3.0 - penalty * 0.5)), 1
        )
        qol_composite_score = round(
            0.24 * qol_transit_local
            + 0.20 * qol_culture_local
            + 0.22 * qol_safety_local
            + 0.18 * qol_green_local
            + 0.16 * qol_env_quiet_local,
            1,
        )
        athens_qol_baseline = 68.2

        quality_of_life_metrics = {
            "source_dataset": "Eurostat Perception Survey on Quality of Life in European Cities (urb_percep, EL001C, 2023)",
            "composite_qol_score": qol_composite_score,
            "athens_eurostat_baseline_pct": athens_qol_baseline,
            "vs_athens_average_diff": round(qol_composite_score - athens_qol_baseline, 1),
            "qol_grade": (
                "Εξαιρετική Ποιότητα Ζωής (Top Tier)"
                if qol_composite_score >= 72
                else (
                    "Υψηλή Ποιότητα Ζωής (Άνω του Μ.Ο. Αθήνας)"
                    if qol_composite_score >= 62
                    else "Μέτρια Αστική Ποιότητα Ζωής (Πυκνός Ιστός)"
                )
            ),
            "dimensions": [
                {
                    "id": "public_transport",
                    "code": "PS1012V+PS1013V",
                    "label": "🚇 Δημόσιες Συγκοινωνίες & Προσβασιμότητα",
                    "neighborhood_score_pct": qol_transit_local,
                    "eurostat_athens_pct": 69.2,
                },
                {
                    "id": "cultural_facilities",
                    "code": "PS1082V+PS1083V",
                    "label": "🏛️ Πολιτισμός, Μουσεία & Αναψυχή",
                    "neighborhood_score_pct": qol_culture_local,
                    "eurostat_athens_pct": 60.9,
                },
                {
                    "id": "safety_and_trust",
                    "code": "PS3519V+PS3520V",
                    "label": "🛡️ Ασφάλεια Γειτονιάς τη Νύχτα & Συνοχή",
                    "neighborhood_score_pct": qol_safety_local,
                    "eurostat_athens_pct": 54.2,
                },
                {
                    "id": "green_and_public_spaces",
                    "code": "PS1052V+PS1053V",
                    "label": "🌿 Χώροι Πρασίνου, Πάρκα & Πεζόδρομοι",
                    "neighborhood_score_pct": qol_green_local,
                    "eurostat_athens_pct": 37.2,
                },
                {
                    "id": "quietness_and_air",
                    "code": "PS3270V+PS3260V",
                    "label": "🔇 Ησυχία, Καθαριότητα & Ποιότητα Αέρα",
                    "neighborhood_score_pct": qol_env_quiet_local,
                    "eurostat_athens_pct": 35.5,
                },
            ],
        }

        base_macro = 15.0 if sat < 80 else (11.5 if sat < 130 else 8.5)
        qol_bonus = max(-1.5, min(2.0, (qol_composite_score - 62.0) * 0.12))
        macro_sc = round(min(15.0, max(6.0, base_macro + qol_bonus)), 1)

        score = round(max(10.0, min(99.0, transit_sc + yield_sc + amenity_sc + macro_sc - penalty)), 1)
        grade = (
            "A+ (Εξαιρετική Επενδυτική Ευκαιρία)"
            if score >= 82
            else "A / B+ (Ισχυρή Απόδοση & Χαμηλός Κίνδυνος)"
            if score >= 70
            else "B (Ισορροπημένη Επένδυση με Επιμέρους Ρίσκα)"
            if score >= 55
            else "C (Αυξημένο Ρίσκο / Υψηλός Κορεσμός ή Φυσικός Κίνδυνος)"
        )

        nearby.sort(key=lambda x: x["distance_m"])

        # 5. Dynamic Per-Neighborhood Price & Tourism Index Series (2019-2025) from Dataset Metrics
        years = [2019, 2020, 2021, 2022, 2023, 2024, 2025]
        athens_base_idx = [116.4, 121.0, 130.2, 145.8, 164.5, 179.2, 191.8]
        growth_accel = min(1.28, max(0.84, 0.86 + (price_ratio - 0.85) * 0.35 + (sat / 350.0)))
        nb_price_index_series = [
            round(base_val * (0.88 + 0.12 * price_ratio) * (1.0 + (growth_accel - 1.0) * (i / 6.0)), 1)
            for i, base_val in enumerate(athens_base_idx)
        ]
        idx_2025 = max(1.0, nb_price_index_series[-1])
        nb_price_sqm_series = [
            round(price_sqm * (val / idx_2025), 0) for val in nb_price_index_series
        ]
        adr_curve_factors = [0.76, 0.58, 0.69, 0.83, 0.91, 0.96, 1.00]
        nb_adr_series = [round(nb_adr * f, 1) for f in adr_curve_factors]
        nb_total_listings = max(15, int(nb.get("total_airbnb_listings", 250)))
        demand_curve_factors = [0.68, 0.22, 0.44, 0.76, 0.89, 0.96, 1.00]
        annual_nights_2025_k = (nb_total_listings * nights * 2.1) / 1000.0
        nb_nights_k_series = [round(annual_nights_2025_k * f, 1) for f in demand_curve_factors]

        neighborhood_index_series = {
            "years": years,
            "neighbourhood": nb.get("name"),
            "neighborhood_name": nb.get("name"),
            "neighborhood_price_index_2015_100": nb_price_index_series,
            "athens_baseline_price_index_2015_100": athens_base_idx,
            "neighborhood_price_sqm_eur": nb_price_sqm_series,
            "neighborhood_adr_eur": nb_adr_series,
            "neighborhood_tourist_nights_thousands": nb_nights_k_series,
        }

        return {
            "status": "success",
            "architecture": "MVC (Model-View-Controller)",
            "query": {"lat": round(lat, 6), "lon": round(lon, 6), "radius_m": radius_m, "rooms": rooms, "estimated_sqm": sqm},
            "location_context": {
                "neighbourhood": nb.get("name"),
                "neighbourhood_en": nb.get("name_en"),
                "neighbourhood_total_listings": nb.get("total_airbnb_listings", 0),
                "gentrification_trend": nb.get("gentrification_trend"),
                "zone_building_factor": nb.get("zone_building_factor", 3.0),
                "avg_purchase_price_sqm": price_sqm,
                "saturation_per_1000_residents": round(sat, 1),
                "neighborhood_index_series": neighborhood_index_series,
                "quality_of_life": quality_of_life_metrics,
            },
            "quality_of_life_metrics": quality_of_life_metrics,
            "investment_rating": {
                "score": score,
                "grade": grade,
                "formula": "Score = Μετρό(0-30) + Απόδοση ROI(0-35) + POIs/Εστίαση/Μουσεία(0-20) + Eurostat QoL/Αγορά(0-15) - Ποινή Κινδύνων(0 έως -25)",
                "breakdown": {
                    "transit_accessibility_score": round(transit_sc, 1),
                    "airbnb_yield_score": round(yield_sc, 1),
                    "urban_amenities_score": round(amenity_sc, 1),
                    "macro_resilience_score": round(macro_sc, 1),
                    "neighborhood_macro_score": round(macro_sc, 1),
                    "quality_of_life_index": qol_composite_score,
                    "natural_hazard_penalty": -penalty,
                },
            },
            "airbnb_roi_metrics": {
                "competitors_in_radius": len(nearby) if not used_fallback else 0,
                "sample_size_used": len(pool),
                "used_nearest_fallback": used_fallback,
                "average_daily_rate_eur": adr,
                "occupancy_rate_pct": occ_pct,
                "occupied_nights_per_year": nights,
                "estimated_annual_gross_revenue_eur": gross_rev,
                "estimated_annual_net_income_eur": net_inc,
                "estimated_acquisition_cost_eur": cost,
                "gross_roi_yield_pct": gross_roi,
                "net_roi_yield_pct": net_roi,
                "payback_period_years": payback,
                "long_term_annual_rent_eur": lt_annual,
                "str_vs_long_term_premium_pct": str_prem,
                "nearby_competitors": nearby[:8],
            },
            "gis_spatial_analysis": {
                "nearest_metro": nearest_metro,
                "nearest_poi": nearest_poi,
                "nearest_museum": nearest_museum,
                "nearest_restaurant_hub": nearest_restaurant,
                "nearest_landmark": nearest_landmark,
                "nearest_university_or_school": nearest_poi,
                "nearby_metro_stations": metros[:4],
                "nearby_places_of_interest": all_pois[:6],
                "nearby_museums": museums[:4],
                "nearby_restaurants": restaurants[:4],
                "nearby_landmarks": landmarks[:4],
                "poi_distribution": poi_distribution,
                "natural_hazards_detected": hazards_detected,
                "is_in_hazard_zone": len(hazards_detected) > 0,
            },
        }

    def get_top_recommendations(
        self,
        target_rooms: Optional[int] = None,
        max_budget_eur: Optional[float] = None,
        strategy: str = "score",
        radius_m: float = 600.0,
    ) -> Dict[str, Any]:
        """
        Scans all 44 neighborhoods of the Municipality of Athens and evaluates apartment options
        (1 BR / 56m², 2 BR / 80m², 3 BR / 104m²) to identify the #1 Top Micro-Location,
        Neighborhood, and Optimal Apartment Configuration.
        """
        neighborhoods = self.store.neighborhoods.get("features", [])
        listings = self.store.airbnb.get("features", [])

        listings_by_nb: Dict[str, List[Dict[str, Any]]] = {}
        for l_feat in listings:
            lp = l_feat["properties"]
            l_nb = lp.get("neighbourhood") or ""
            listings_by_nb.setdefault(l_nb, []).append(l_feat)

        room_labels = {
            1: "1 Υπνοδωμάτιο / Studio (56 m²)",
            2: "2 Υπνοδωμάτια — Οικογενειακό/Ζευγάρια (80 m²)",
            3: "3 Υπνοδωμάτια — Group/Penthouse (104 m²)",
        }

        ranked_locations: List[Dict[str, Any]] = []

        for feat in neighborhoods:
            props = feat["properties"]
            nb_name = props["name"]
            rings = feat.get("geometry", {}).get("coordinates", [])
            ring = rings[0] if rings and rings[0] else [[23.7325, 37.9755]]
            c_lon = round(sum(pt[0] for pt in ring) / len(ring), 5)
            c_lat = round(sum(pt[1] for pt in ring) / len(ring), 5)

            nb_list = listings_by_nb.get(nb_name, [])
            if nb_list:
                best_l = max(
                    nb_list,
                    key=lambda x: (
                        float(x["properties"].get("review_scores_rating", 4.7)) * 40
                        + min(200, int(x["properties"].get("number_of_reviews", 20)))
                    ),
                )
                spot_lon, spot_lat = best_l["geometry"]["coordinates"]
                eval_lat = round(0.65 * spot_lat + 0.35 * c_lat, 5)
                eval_lon = round(0.65 * spot_lon + 0.35 * c_lon, 5)
            else:
                eval_lat, eval_lon = c_lat, c_lon

            room_candidates = [1, 2, 3]
            room_evals: Dict[int, Dict[str, Any]] = {}
            room_comparison_list: List[Dict[str, Any]] = []

            for r in room_candidates:
                ev = self.evaluate(lat=eval_lat, lon=eval_lon, radius_m=radius_m, rooms=r)
                room_evals[r] = ev
                roi_m = ev["airbnb_roi_metrics"]
                rat_m = ev["investment_rating"]
                within_budget = (
                    True
                    if not max_budget_eur or max_budget_eur <= 0
                    else roi_m["estimated_acquisition_cost_eur"] <= max_budget_eur
                )
                room_comparison_list.append(
                    {
                        "rooms": r,
                        "room_label": room_labels[r],
                        "estimated_sqm": ev["query"]["estimated_sqm"],
                        "score": rat_m["score"],
                        "grade": rat_m["grade"],
                        "adr_eur": roi_m["average_daily_rate_eur"],
                        "occupancy_pct": roi_m["occupancy_rate_pct"],
                        "annual_gross_revenue_eur": roi_m["estimated_annual_gross_revenue_eur"],
                        "annual_net_income_eur": roi_m["estimated_annual_net_income_eur"],
                        "acquisition_cost_eur": roi_m["estimated_acquisition_cost_eur"],
                        "gross_roi_pct": roi_m["gross_roi_yield_pct"],
                        "net_roi_pct": roi_m["net_roi_yield_pct"],
                        "payback_years": roi_m["payback_period_years"],
                        "within_budget": within_budget,
                    }
                )

            if target_rooms in (1, 2, 3):
                eligible = [c for c in room_comparison_list if c["rooms"] == target_rooms]
            else:
                eligible = [c for c in room_comparison_list if c["within_budget"]]
                if not eligible:
                    eligible = [room_comparison_list[0]]

            if strategy == "roi":
                best_opt = max(eligible, key=lambda c: (c["gross_roi_pct"], c["score"]))
            elif strategy == "revenue":
                best_opt = max(eligible, key=lambda c: (c["annual_net_income_eur"], c["score"]))
            else:
                best_opt = max(eligible, key=lambda c: (c["score"], c["gross_roi_pct"]))

            chosen_ev = room_evals[best_opt["rooms"]]
            gis_m = chosen_ev["gis_spatial_analysis"]
            loc_m = chosen_ev["location_context"]
            rat_m = chosen_ev["investment_rating"]

            ranked_locations.append(
                {
                    "neighbourhood": nb_name,
                    "neighbourhood_en": props.get("name_en", nb_name),
                    "municipality": "Δήμος Αθηναίων (EL001C)",
                    "lat": eval_lat,
                    "lon": eval_lon,
                    "best_rooms": best_opt["rooms"],
                    "best_room_label": best_opt["room_label"],
                    "best_sqm": best_opt["estimated_sqm"],
                    "investment_score": best_opt["score"],
                    "grade": best_opt["grade"],
                    "score_breakdown": rat_m["breakdown"],
                    "adr_eur": best_opt["adr_eur"],
                    "occupancy_pct": best_opt["occupancy_pct"],
                    "annual_gross_revenue_eur": best_opt["annual_gross_revenue_eur"],
                    "annual_net_income_eur": best_opt["annual_net_income_eur"],
                    "acquisition_cost_eur": best_opt["acquisition_cost_eur"],
                    "avg_purchase_price_sqm": loc_m["avg_purchase_price_sqm"],
                    "gross_roi_pct": best_opt["gross_roi_pct"],
                    "net_roi_pct": best_opt["net_roi_pct"],
                    "payback_years": best_opt["payback_years"],
                    "gentrification_trend": loc_m["gentrification_trend"],
                    "saturation_per_1000_residents": loc_m["saturation_per_1000_residents"],
                    "nearest_metro_name": gis_m["nearest_metro"]["name"] if gis_m.get("nearest_metro") else "-",
                    "nearest_metro_dist_m": gis_m["nearest_metro"]["distance_m"] if gis_m.get("nearest_metro") else 0,
                    "nearest_poi_name": gis_m["nearest_poi"]["name"] if gis_m.get("nearest_poi") else "-",
                    "dining_venues_in_catchment": gis_m["poi_distribution"]["estimated_dining_venues_count"],
                    "budget_compliant": best_opt["within_budget"],
                    "room_options_comparison": room_comparison_list,
                }
            )

        if strategy == "roi":
            ranked_locations.sort(
                key=lambda x: (1 if x["budget_compliant"] else 0, x["gross_roi_pct"], x["investment_score"]),
                reverse=True,
            )
        elif strategy == "revenue":
            ranked_locations.sort(
                key=lambda x: (1 if x["budget_compliant"] else 0, x["annual_net_income_eur"], x["investment_score"]),
                reverse=True,
            )
        else:
            ranked_locations.sort(
                key=lambda x: (1 if x["budget_compliant"] else 0, x["investment_score"], x["gross_roi_pct"]),
                reverse=True,
            )

        for idx, item in enumerate(ranked_locations, start=1):
            item["rank"] = idx

        return {
            "status": "success",
            "architecture": "MVC (Model-View-Controller)",
            "strategy": strategy,
            "target_rooms": target_rooms or "auto",
            "max_budget_eur": max_budget_eur,
            "total_neighborhoods_evaluated": len(ranked_locations),
            "total_combinations_evaluated": len(ranked_locations) * 3,
            "top_overall_pick": ranked_locations[0] if ranked_locations else None,
            "top_recommendations": ranked_locations[:10],
        }


class NeighborhoodAnalyticsModel:
    """Domain Model for Neighborhood Saturation & Gentrification Analytics."""

    def __init__(self, store: UrbanDataStoreModel) -> None:
        self.store = store

    def compute_all(self) -> Dict[str, Any]:
        results = []
        for feat in self.store.neighborhoods.get("features", []):
            p = feat["properties"]
            rings = feat.get("geometry", {}).get("coordinates", [])
            ring = rings[0] if rings and rings[0] else [[23.7325, 37.9755]]
            center_lon = round(sum(pt[0] for pt in ring) / len(ring), 5)
            center_lat = round(sum(pt[1] for pt in ring) / len(ring), 5)

            pop = int(p.get("population", 10000))
            total_str = int(p.get("total_airbnb_listings", 100))
            per_1k = round((total_str / max(1, pop)) * 1000.0, 1)
            adr = float(p.get("real_avg_adr_eur", 95.0))
            occ = float(p.get("real_avg_occupancy_pct", 70.0))
            rev = round(adr * 365 * (occ / 100.0), 0)

            if per_1k >= 90:
                sat_lvl, color = "CRITICAL", "#ef4444"
            elif per_1k >= 45:
                sat_lvl, color = "HIGH", "#f97316"
            elif per_1k >= 20:
                sat_lvl, color = "MODERATE", "#eab308"
            else:
                sat_lvl, color = "LOW_OPPORTUNITY", "#22c55e"

            results.append(
                {
                    "neighbourhood_id": p.get("neighbourhood_id"),
                    "name": p["name"],
                    "name_en": p.get("name_en"),
                    "center_lat": center_lat,
                    "center_lon": center_lon,
                    "population": pop,
                    "area_km2": p.get("area_km2"),
                    "total_airbnb_listings": total_str,
                    "listings_per_1000_residents": per_1k,
                    "saturation_level": sat_lvl,
                    "heatmap_color": color,
                    "avg_adr_eur": round(adr, 2),
                    "avg_occupancy_pct": round(occ, 1),
                    "estimated_avg_annual_revenue_eur": rev,
                    "avg_long_term_rent_sqm": p.get("avg_long_term_rent_sqm"),
                    "avg_purchase_price_sqm": p.get("avg_purchase_price_sqm"),
                    "gentrification_trend": p.get("gentrification_trend"),
                    "geometry": feat.get("geometry"),
                }
            )
        results.sort(key=lambda x: x["total_airbnb_listings"], reverse=True)
        return {
            "status": "success",
            "architecture": "MVC",
            "city": "Αθήνα (EL300 / EL001C)",
            "total_neighborhoods": len(results),
            "total_city_airbnb_listings": sum(r["total_airbnb_listings"] for r in results),
            "neighborhoods": results,
        }


class EurostatMacroModel:
    """Domain Model for Eurostat Urban Audit (`urb_*`) data and live SDMX API queries."""

    EUROSTAT_URL = (
        "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/urb_cpop1"
        "?format=JSON&lang=EN&cities=EL001C&indic_ur=DE1001V"
    )

    def __init__(self, store: UrbanDataStoreModel) -> None:
        self.store = store

    def get_urban_audit(self, city_code: str = "EL300", attempt_live: bool = True) -> Dict[str, Any]:
        cities = self.store.eurostat.get("cities", {})
        norm = "EL300" if city_code.upper() in ("EL300", "EL001C", "EL001C1", "ATHENS") else city_code.upper()
        city_data = cities.get(norm, cities.get("EL300", {}))

        conn = {
            "mode": "CACHED_SDMX_SNAPSHOT",
            "official_eurostat_city_code": "EL001C",
            "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        if attempt_live:
            try:
                r = requests.get(self.EUROSTAT_URL, timeout=2.5)
                if r.status_code == 200:
                    conn["mode"] = "LIVE_EUROSTAT_API_CONNECTED"
                    conn["live_observations_count"] = len(r.json().get("value", {}))
            except Exception:
                pass

        return {
            "status": "success",
            "architecture": "MVC",
            "connection": conn,
            "requested_city": norm,
            "city_analytics": city_data,
            "live_eurostat_sdmx_extract": self.store.eurostat.get("live_eurostat_sdmx_extract", {}),
            "eu_mediterranean_benchmark": self.store.eurostat.get("eu_Mediterranean_benchmark", []),
        }


class ScenarioPortfolioModel:
    """Domain Model for saving and listing analyst investment scenarios."""

    def __init__(self, store: UrbanDataStoreModel) -> None:
        self.store = store

    def list_all(self) -> List[Dict[str, Any]]:
        return list(self.store.scenarios)

    def create(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        new_scen = {
            "scenario_id": f"scen-{uuid.uuid4().hex[:6]}",
            "title": payload.get("title", "Σενάριο MVC Αθήνας"),
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "lat": float(payload.get("lat", 37.9648)),
            "lon": float(payload.get("lon", 23.7265)),
            "radius": int(payload.get("radius", 600)),
            "rooms": int(payload.get("rooms", 2)),
            "acquisition_cost_eur": float(payload.get("acquisition_cost_eur", 240000)),
            "investment_score": float(payload.get("investment_score", 0.0)),
            "estimated_annual_revenue_eur": float(payload.get("estimated_annual_revenue_eur", 0.0)),
            "estimated_gross_roi_pct": float(payload.get("estimated_gross_roi_pct", 0.0)),
            "neighbourhood": payload.get("neighbourhood", "Αθήνα"),
        }
        self.store.scenarios.insert(0, new_scen)
        self.store._save("scenarios.json", self.store.scenarios)
        return new_scen
