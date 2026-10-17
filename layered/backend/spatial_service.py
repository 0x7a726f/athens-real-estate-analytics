"""
Business Logic Layer (BLL) - Spatial & Real Estate Investment Analytics Service
Implements:
1. Haversine geospatial distance calculation (meters)
2. Point-in-Polygon ray-casting algorithm for 44 Official Athens Neighborhoods & Natural Hazard Zones
3. Inside Airbnb competitor filtering (345 stratified listings / 14,171 city-wide statistics),
   ADR, Occupancy Rate & Annual Gross/Net Revenue / ROI
4. Multi-factor Investment Score (0-100) computation
5. Neighborhood Gentrification & Saturation Heatmap indices
6. Open-Meteo Geocoding API & Athens GIS Toponym Search (Category 7 GIS - Keyless)
"""

import math
from typing import Any, Dict, List, Optional, Tuple
import requests
from data_access import DataRepository

EARTH_RADIUS_M = 6371000.0


def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculates great-circle distance in meters between two WGS84 coordinates."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return EARTH_RADIUS_M * c


def point_in_polygon(lat: float, lon: float, polygon_coords: List[List[float]]) -> bool:
    """
    Ray-casting algorithm to check if (lon, lat) lies inside a GeoJSON polygon ring.
    Note: GeoJSON coordinates are ordered [longitude, latitude].
    """
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


class SpatialAnalyticsService:
    """Core analytical engine combining Inside Airbnb, Athens GIS, and Eurostat indicators."""

    def __init__(self, repo: DataRepository) -> None:
        self.repo = repo

    def detect_neighborhood(self, lat: float, lon: float) -> Dict[str, Any]:
        """Finds the containing Athens neighborhood polygon or nearest neighborhood centroid."""
        features = self.repo.get_neighborhood_features()
        for feat in features:
            rings = feat.get("geometry", {}).get("coordinates", [])
            if rings and point_in_polygon(lat, lon, rings[0]):
                return feat["properties"]

        # Fallback: find closest neighborhood by polygon centroid
        best_props: Optional[Dict[str, Any]] = None
        min_dist = float("inf")
        for feat in features:
            rings = feat.get("geometry", {}).get("coordinates", [])
            if not rings or not rings[0]:
                continue
            ring = rings[0]
            c_lon = sum(pt[0] for pt in ring) / len(ring)
            c_lat = sum(pt[1] for pt in ring) / len(ring)
            dist = haversine_distance_m(lat, lon, c_lat, c_lon)
            if dist < min_dist:
                min_dist = dist
                best_props = feat["properties"]

        return best_props or {
            "name": "Κέντρο Αθήνας",
            "name_en": "Central Athens",
            "population": 15000,
            "avg_purchase_price_sqm": 3200,
            "avg_long_term_rent_sqm": 12.0,
            "gentrification_trend": "Stable Urban Zone",
        }

    def evaluate_property(
        self,
        lat: float,
        lon: float,
        radius_m: float = 600.0,
        rooms: int = 2,
        acquisition_cost_eur: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Executes Micro-Location Scoring & Airbnb ROI Calculation for a given coordinate.
        """
        neighborhood = self.detect_neighborhood(lat, lon)

        # 1. Athens GIS: Find distances to Metro stations, Museums, Restaurant Hubs, and Landmarks
        metro_stations = []
        museums_list = []
        restaurants_list = []
        landmarks_list = []
        all_cultural_pois = []

        for feat in self.repo.get_gis_poi_features():
            coords = feat["geometry"]["coordinates"]
            poi_lon, poi_lat = coords[0], coords[1]
            dist_m = round(haversine_distance_m(lat, lon, poi_lat, poi_lon), 1)
            props = feat["properties"]
            cat = props.get("category", "landmark")
            item = {
                "id": props.get("id"),
                "name": props.get("name"),
                "name_en": props.get("name_en"),
                "category": cat,
                "type_label": props.get("type_label", cat),
                "distance_m": dist_m,
                "walking_minutes": max(1, round(dist_m / 80.0)),
                "lines": props.get("lines", []),
                "venue_count": int(props.get("venue_count", 1)),
                "cuisine_profile": props.get("cuisine_profile", ""),
                "visitors_annual": int(props.get("visitors_annual", 0)),
            }
            if cat == "metro":
                metro_stations.append(item)
            elif cat == "museum":
                museums_list.append(item)
                all_cultural_pois.append(item)
            elif cat == "restaurant":
                restaurants_list.append(item)
                all_cultural_pois.append(item)
            else:
                landmarks_list.append(item)
                all_cultural_pois.append(item)

        metro_stations.sort(key=lambda x: x["distance_m"])
        museums_list.sort(key=lambda x: x["distance_m"])
        restaurants_list.sort(key=lambda x: x["distance_m"])
        landmarks_list.sort(key=lambda x: x["distance_m"])
        all_cultural_pois.sort(key=lambda x: x["distance_m"])

        nearest_metro = metro_stations[0] if metro_stations else None
        nearest_museum = museums_list[0] if museums_list else None
        nearest_restaurant = restaurants_list[0] if restaurants_list else None
        nearest_landmark = landmarks_list[0] if landmarks_list else None
        nearest_poi = all_cultural_pois[0] if all_cultural_pois else None

        # Compute POI & Restaurant/Museum/Landmark Distribution in walkable catchment (1.2 km)
        catchment_m = max(float(radius_m) * 1.6, 1100.0)
        metros_in_catchment = [x for x in metro_stations if x["distance_m"] <= catchment_m]
        museums_in_catchment = [x for x in museums_list if x["distance_m"] <= catchment_m]
        rest_hubs_in_catchment = [x for x in restaurants_list if x["distance_m"] <= catchment_m]
        landmarks_in_catchment = [x for x in landmarks_list if x["distance_m"] <= catchment_m]

        # Estimate individual restaurant/cafe/bar venues within the catchment
        estimated_dining_venues = sum(x["venue_count"] for x in rest_hubs_in_catchment)
        if estimated_dining_venues == 0 and nearest_restaurant:
            estimated_dining_venues = max(12, int(nearest_restaurant["venue_count"] * 0.5))

        poi_distribution = {
            "catchment_radius_m": round(catchment_m),
            "restaurant_hubs_count": len(rest_hubs_in_catchment),
            "estimated_dining_venues_count": estimated_dining_venues,
            "museums_count": len(museums_in_catchment),
            "landmarks_count": len(landmarks_in_catchment),
            "metro_stations_count": len(metros_in_catchment),
            "total_pois_in_catchment": (
                len(rest_hubs_in_catchment)
                + len(museums_in_catchment)
                + len(landmarks_in_catchment)
                + len(metros_in_catchment)
            ),
            "chart_categories": [
                "Εστιατόρια & Πιάτσες Εστίασης",
                "Μουσεία & Αρχαιολογικοί Χώροι",
                "Αξιοθέατα, Πάρκα & Θέα",
                "Σταθμοί Μετρό & ΗΣΑΠ",
            ],
            "chart_hub_counts": [
                max(1, len(rest_hubs_in_catchment)),
                max(1, len(museums_in_catchment)),
                max(1, len(landmarks_in_catchment)),
                max(1, len(metros_in_catchment)),
            ],
        }

        # 2. Athens GIS: Check Natural Hazard Polygons (Flood / Thermal Island)
        active_hazards = []
        total_hazard_penalty = 0
        for haz in self.repo.get_gis_hazard_features():
            rings = haz.get("geometry", {}).get("coordinates", [])
            props = haz["properties"]
            if rings and point_in_polygon(lat, lon, rings[0]):
                active_hazards.append(props)
                total_hazard_penalty += int(props.get("penalty_points", 15))

        # 3. Inside Airbnb: Filter competing listings within radius
        nearby_listings = []
        same_room_listings = []
        all_listings_with_dist: List[Tuple[float, Dict[str, Any]]] = []

        for feat in self.repo.get_airbnb_features():
            coords = feat["geometry"]["coordinates"]
            l_lon, l_lat = coords[0], coords[1]
            dist_m = round(haversine_distance_m(lat, lon, l_lat, l_lon), 1)
            props = dict(feat["properties"])
            props["distance_m"] = dist_m
            props["lat"] = l_lat
            props["lon"] = l_lon
            all_listings_with_dist.append((dist_m, props))

            if dist_m <= radius_m:
                nearby_listings.append(props)
                if int(props.get("rooms", 1)) == int(rooms):
                    same_room_listings.append(props)

        used_fallback_competitors = False
        if not nearby_listings:
            used_fallback_competitors = True
            all_listings_with_dist.sort(key=lambda x: x[0])
            nearby_listings = [item[1] for item in all_listings_with_dist[:6]]

        target_pool = same_room_listings if len(same_room_listings) >= 2 else nearby_listings
        raw_avg_adr = sum(float(x["price"]) for x in target_pool) / len(target_pool)

        nb_census_adr = float(neighborhood.get("real_avg_adr_eur", raw_avg_adr))
        blended_base_adr = 0.72 * raw_avg_adr + 0.28 * nb_census_adr

        avg_pool_rooms = sum(int(x.get("rooms", 2)) for x in target_pool) / len(target_pool)
        room_multiplier = 1.0 + 0.28 * (rooms - avg_pool_rooms)
        room_multiplier = max(0.65, min(1.85, room_multiplier))

        estimated_adr = round(blended_base_adr * room_multiplier, 2)
        avg_occupancy = sum(float(x["occupancy_rate"]) for x in target_pool) / len(target_pool)
        avg_occupancy_pct = round(avg_occupancy * 100.0, 1)
        avg_rating = round(
            sum(float(x.get("review_scores_rating", 4.8)) for x in target_pool) / len(target_pool),
            2,
        )

        # Annual Revenue & Net/Gross ROI Calculation
        occupied_nights = round(365 * avg_occupancy)
        estimated_annual_gross_revenue = round(estimated_adr * occupied_nights, 2)
        estimated_annual_net_income = round(estimated_annual_gross_revenue * 0.72, 2)

        estimated_sqm = 32 + (rooms * 24)
        price_per_sqm = float(neighborhood.get("avg_purchase_price_sqm", 3300))
        effective_acquisition_cost = (
            float(acquisition_cost_eur)
            if acquisition_cost_eur and acquisition_cost_eur > 0
            else round(estimated_sqm * price_per_sqm, 2)
        )

        gross_roi_pct = round((estimated_annual_gross_revenue / effective_acquisition_cost) * 100.0, 2)
        net_roi_pct = round((estimated_annual_net_income / effective_acquisition_cost) * 100.0, 2)
        payback_years = round(effective_acquisition_cost / max(1.0, estimated_annual_net_income), 1)

        lt_monthly_rent = round(
            estimated_sqm * float(neighborhood.get("avg_long_term_rent_sqm", 12.0)), 2
        )
        lt_annual_revenue = round(lt_monthly_rent * 12, 2)
        str_premium_pct = round(
            ((estimated_annual_net_income - lt_annual_revenue) / max(1.0, lt_annual_revenue)) * 100.0,
            1,
        )

        # 4. Compute Composite Investment Score (0 - 100)
        metro_dist = nearest_metro["distance_m"] if nearest_metro else 1500.0
        transit_score = max(5.0, min(30.0, 30.0 - max(0.0, (metro_dist - 150.0)) * 0.018))
        yield_score = min(35.0, max(8.0, (gross_roi_pct * 1.9) + (avg_occupancy * 12.0)))

        # Tourism & Gastronomy POI Score (max 20 pts): proximity to Museums, Landmarks & Restaurants
        poi_dist = nearest_poi["distance_m"] if nearest_poi else 1000.0
        poi_density_bonus = min(6.0, (len(museums_in_catchment) + len(rest_hubs_in_catchment) + len(landmarks_in_catchment)) * 0.65)
        amenity_score = max(6.0, min(20.0, 14.5 - max(0.0, (poi_dist - 150.0)) * 0.012 + poi_density_bonus))

        saturation_ratio = (
            float(neighborhood.get("total_airbnb_listings", 600))
            / max(1.0, float(neighborhood.get("population", 10000)))
            * 1000.0
        )
        macro_score = 15.0 if saturation_ratio < 80 else (11.5 if saturation_ratio < 130 else 8.5)

        raw_score = transit_score + yield_score + amenity_score + macro_score - total_hazard_penalty
        investment_score = round(max(10.0, min(99.0, raw_score)), 1)

        if investment_score >= 82:
            rating_label = "A+ (Εξαιρετική Επενδυτική Ευκαιρία)"
        elif investment_score >= 70:
            rating_label = "A / B+ (Ισχυρή Απόδοση & Χαμηλός Κίνδυνος)"
        elif investment_score >= 55:
            rating_label = "B (Ισορροπημένη Επένδυση με Επιμέρους Ρίσκα)"
        else:
            rating_label = "C (Αυξημένο Ρίσκο / Υψηλός Κορεσμός ή Φυσικός Κίνδυνος)"

        nearby_listings.sort(key=lambda x: x["distance_m"])

        # 5. Compute Dynamic Per-Neighborhood Price & Tourism Index Series (2019-2025) from Dataset Metrics
        years = [2019, 2020, 2021, 2022, 2023, 2024, 2025]
        athens_base_idx = [116.4, 121.0, 130.2, 145.8, 164.5, 179.2, 191.8]
        price_ratio = price_per_sqm / 3250.0  # Neighborhood €/m² vs Athens average
        growth_accel = min(1.28, max(0.84, 0.86 + (price_ratio - 0.85) * 0.35 + (saturation_ratio / 350.0)))
        nb_price_index_series = [
            round(base_val * (0.88 + 0.12 * price_ratio) * (1.0 + (growth_accel - 1.0) * (i / 6.0)), 1)
            for i, base_val in enumerate(athens_base_idx)
        ]
        idx_2025 = max(1.0, nb_price_index_series[-1])
        nb_price_sqm_series = [
            round(price_per_sqm * (val / idx_2025), 0) for val in nb_price_index_series
        ]
        adr_curve_factors = [0.76, 0.58, 0.69, 0.83, 0.91, 0.96, 1.00]
        nb_adr_series = [round(nb_census_adr * f, 1) for f in adr_curve_factors]
        nb_total_listings = max(15, int(neighborhood.get("total_airbnb_listings", 250)))
        demand_curve_factors = [0.68, 0.22, 0.44, 0.76, 0.89, 0.96, 1.00]
        annual_nights_2025_k = (nb_total_listings * occupied_nights * 2.1) / 1000.0
        nb_nights_k_series = [round(annual_nights_2025_k * f, 1) for f in demand_curve_factors]

        neighborhood_index_series = {
            "years": years,
            "neighbourhood": neighborhood.get("name"),
            "neighborhood_name": neighborhood.get("name"),
            "neighborhood_price_index_2015_100": nb_price_index_series,
            "athens_baseline_price_index_2015_100": athens_base_idx,
            "neighborhood_price_sqm_eur": nb_price_sqm_series,
            "neighborhood_adr_eur": nb_adr_series,
            "neighborhood_tourist_nights_thousands": nb_nights_k_series,
        }

        return {
            "status": "success",
            "query": {
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "radius_m": radius_m,
                "rooms": rooms,
                "estimated_sqm": estimated_sqm,
            },
            "location_context": {
                "neighbourhood": neighborhood.get("name"),
                "neighbourhood_en": neighborhood.get("name_en"),
                "neighbourhood_total_listings": neighborhood.get("total_airbnb_listings", 0),
                "gentrification_trend": neighborhood.get("gentrification_trend"),
                "zone_building_factor": neighborhood.get("zone_building_factor", 3.0),
                "avg_purchase_price_sqm": price_per_sqm,
                "saturation_per_1000_residents": round(saturation_ratio, 1),
                "neighborhood_index_series": neighborhood_index_series,
            },
            "investment_rating": {
                "score": investment_score,
                "grade": rating_label,
                "formula": "Score = Μετρό(0-30) + Απόδοση ROI(0-35) + POIs/Εστίαση/Μουσεία(0-20) + Αγορά/Κορεσμός(0-15) - Ποινή Κινδύνων(0 έως -25)",
                "breakdown": {
                    "transit_accessibility_score": round(transit_score, 1),
                    "airbnb_yield_score": round(yield_score, 1),
                    "urban_amenities_score": round(amenity_score, 1),
                    "macro_resilience_score": round(macro_score, 1),
                    "neighborhood_macro_score": round(macro_score, 1),
                    "natural_hazard_penalty": -total_hazard_penalty,
                },
            },
            "airbnb_roi_metrics": {
                "competitors_in_radius": len(nearby_listings) if not used_fallback_competitors else 0,
                "sample_size_used": len(target_pool),
                "used_nearest_fallback": used_fallback_competitors,
                "average_daily_rate_eur": estimated_adr,
                "occupancy_rate_pct": avg_occupancy_pct,
                "occupied_nights_per_year": occupied_nights,
                "estimated_annual_gross_revenue_eur": estimated_annual_gross_revenue,
                "estimated_annual_net_income_eur": estimated_annual_net_income,
                "estimated_acquisition_cost_eur": effective_acquisition_cost,
                "gross_roi_yield_pct": gross_roi_pct,
                "net_roi_yield_pct": net_roi_pct,
                "payback_period_years": payback_years,
                "long_term_annual_rent_eur": lt_annual_revenue,
                "str_vs_long_term_premium_pct": str_premium_pct,
                "avg_competitor_rating": avg_rating,
                "nearby_competitors": nearby_listings[:8],
            },
            "gis_spatial_analysis": {
                "nearest_metro": nearest_metro,
                "nearest_poi": nearest_poi,
                "nearest_museum": nearest_museum,
                "nearest_restaurant_hub": nearest_restaurant,
                "nearest_landmark": nearest_landmark,
                "nearest_university_or_school": nearest_poi,
                "nearby_metro_stations": metro_stations[:4],
                "nearby_places_of_interest": all_cultural_pois[:6],
                "nearby_museums": museums_list[:4],
                "nearby_restaurants": restaurants_list[:4],
                "nearby_landmarks": landmarks_list[:4],
                "poi_distribution": poi_distribution,
                "natural_hazards_detected": active_hazards,
                "is_in_hazard_zone": len(active_hazards) > 0,
            },
        }

    def get_neighborhoods_analytics(self) -> Dict[str, Any]:
        """
        Computes Gentrification & Saturation Heatmap metrics across all 44 real Athens neighborhoods.
        """
        neighborhoods = self.repo.get_neighborhood_features()
        listings = self.repo.get_airbnb_features()

        results = []
        for feat in neighborhoods:
            props = feat["properties"]
            nb_name = props["name"]
            rings = feat.get("geometry", {}).get("coordinates", [])
            ring = rings[0] if rings and rings[0] else [[23.7325, 37.9755]]
            center_lon = round(sum(pt[0] for pt in ring) / len(ring), 5)
            center_lat = round(sum(pt[1] for pt in ring) / len(ring), 5)

            nb_listings = [
                l["properties"]
                for l in listings
                if l["properties"].get("neighbourhood") == nb_name
            ]

            avg_adr = float(
                props.get("real_avg_adr_eur")
                or (
                    sum(float(x["price"]) for x in nb_listings) / len(nb_listings)
                    if nb_listings
                    else 92.0
                )
            )
            avg_occ = float(
                props.get("real_avg_occupancy_pct")
                or (
                    (sum(float(x["occupancy_rate"]) for x in nb_listings) / len(nb_listings))
                    * 100.0
                    if nb_listings
                    else 68.0
                )
            )
            avg_rev = round(avg_adr * 365 * (avg_occ / 100.0), 0)

            population = int(props.get("population", 10000))
            total_str = int(props.get("total_airbnb_listings", len(nb_listings)))
            listings_per_1000_residents = round((total_str / max(1, population)) * 1000.0, 1)
            density_per_km2 = round(total_str / max(0.1, float(props.get("area_km2", 1.0))), 1)

            if listings_per_1000_residents >= 90:
                saturation_level = "CRITICAL"
                heatmap_color = "#ef4444"  # Red
            elif listings_per_1000_residents >= 45:
                saturation_level = "HIGH"
                heatmap_color = "#f97316"  # Orange
            elif listings_per_1000_residents >= 20:
                saturation_level = "MODERATE"
                heatmap_color = "#eab308"  # Amber/Yellow
            else:
                saturation_level = "LOW_OPPORTUNITY"
                heatmap_color = "#22c55e"  # Emerald Green

            results.append(
                {
                    "neighbourhood_id": props.get("neighbourhood_id"),
                    "name": nb_name,
                    "name_en": props.get("name_en"),
                    "center_lat": center_lat,
                    "center_lon": center_lon,
                    "population": population,
                    "area_km2": props.get("area_km2"),
                    "total_airbnb_listings": total_str,
                    "sample_listings_count": len(nb_listings),
                    "listings_per_1000_residents": listings_per_1000_residents,
                    "airbnb_density_per_km2": density_per_km2,
                    "saturation_level": saturation_level,
                    "heatmap_color": heatmap_color,
                    "avg_adr_eur": round(avg_adr, 2),
                    "avg_occupancy_pct": round(avg_occ, 1),
                    "estimated_avg_annual_revenue_eur": avg_rev,
                    "avg_long_term_rent_sqm": props.get("avg_long_term_rent_sqm"),
                    "avg_purchase_price_sqm": props.get("avg_purchase_price_sqm"),
                    "gentrification_trend": props.get("gentrification_trend"),
                    "geometry": feat.get("geometry"),
                }
            )

        results.sort(key=lambda x: x["total_airbnb_listings"], reverse=True)
        return {
            "status": "success",
            "city": "Αθήνα (EL300 / EL001C)",
            "total_neighborhoods": len(results),
            "total_city_airbnb_listings": sum(r["total_airbnb_listings"] for r in results),
            "neighborhoods": results,
        }

    def geocode_athens_query(self, query: str) -> Dict[str, Any]:
        """
        Searches local Athens GIS neighborhoods & POIs first (with Greek accent normalization),
        then queries Open-Meteo Geocoding API (Category 7 GIS - Keyless).
        """
        import unicodedata

        def norm_el(s: str) -> str:
            return "".join(
                c for c in unicodedata.normalize("NFD", s.strip().lower())
                if unicodedata.category(c) != "Mn"
            )

        q = norm_el(query)
        matches = []

        # 1. Search local Athens neighborhoods (polygon centroids)
        for feat in self.repo.get_neighborhood_features():
            props = feat["properties"]
            if (
                q in norm_el(props.get("name", ""))
                or q in norm_el(props.get("name_en", ""))
                or q in norm_el(props.get("neighbourhood_raw", ""))
            ):
                ring = feat["geometry"]["coordinates"][0]
                c_lon = round(sum(pt[0] for pt in ring) / len(ring), 5)
                c_lat = round(sum(pt[1] for pt in ring) / len(ring), 5)
                matches.append(
                    {
                        "name": props["name"],
                        "name_en": props.get("name_en"),
                        "type": "neighborhood",
                        "lat": c_lat,
                        "lon": c_lon,
                        "source": "Inside Airbnb / Athens GIS Neighborhoods",
                    }
                )

        # 2. Search local Athens GIS POIs (Metro stations, Universities)
        for feat in self.repo.get_gis_poi_features():
            props = feat["properties"]
            if q in norm_el(props.get("name", "")) or q in norm_el(props.get("name_en", "")):
                coords = feat["geometry"]["coordinates"]
                matches.append(
                    {
                        "name": props["name"],
                        "name_en": props.get("name_en"),
                        "type": props.get("category"),
                        "lat": coords[1],
                        "lon": coords[0],
                        "source": "Athens GIS POIs",
                    }
                )

        # 3. Query Open-Meteo Geocoding API (Category 7 GIS) if external search needed
        if len(matches) < 3 and len(q) >= 3:
            try:
                resp = requests.get(
                    "https://geocoding-api.open-meteo.com/v1/search",
                    params={"name": query, "count": 5, "language": "el", "format": "json"},
                    timeout=3.0,
                )
                if resp.status_code == 200:
                    for item in resp.json().get("results", []):
                        if item.get("country_code") == "GR":
                            matches.append(
                                {
                                    "name": f"{item.get('name')} ({item.get('admin2', 'Αττική')})",
                                    "name_en": item.get("name"),
                                    "type": "geocoded_place",
                                    "lat": item.get("latitude"),
                                    "lon": item.get("longitude"),
                                    "source": "Open-Meteo Geocoding API (GeoNames)",
                                }
                            )
            except Exception:
                pass

        return {
            "status": "success",
            "query": query,
            "count": len(matches),
            "results": matches[:8],
        }

    def get_top_investment_recommendations(
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
        neighborhoods = self.repo.get_neighborhood_features()
        listings = self.repo.get_airbnb_features()

        # Map each neighborhood to its prime micro-location (top-performing listing cluster or centroid)
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

            # Find prime spot in neighborhood (if listings exist, use top-reviewed listing coordinate near transit)
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
                # Blend 65% prime listing spot + 35% neighborhood centroid to stay squarely inside polygon
                eval_lat = round(0.65 * spot_lat + 0.35 * c_lat, 5)
                eval_lon = round(0.65 * spot_lon + 0.35 * c_lon, 5)
            else:
                eval_lat, eval_lon = c_lat, c_lon

            # Evaluate all 3 apartment configurations (1 BR, 2 BR, 3 BR) at this micro-location
            room_candidates = [1, 2, 3]
            room_evals: Dict[int, Dict[str, Any]] = {}
            room_comparison_list: List[Dict[str, Any]] = []

            for r in room_candidates:
                ev = self.evaluate_property(lat=eval_lat, lon=eval_lon, radius_m=radius_m, rooms=r)
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

            # Filter eligible rooms by target_rooms and max_budget_eur
            if target_rooms in (1, 2, 3):
                eligible = [c for c in room_comparison_list if c["rooms"] == target_rooms]
            else:
                eligible = [c for c in room_comparison_list if c["within_budget"]]
                if not eligible:
                    eligible = [room_comparison_list[0]]  # Fallback to 1 BR if budget is tight

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

            # Skip if max_budget_eur is set and even the chosen option exceeds budget by >15%
            budget_compliant = best_opt["within_budget"]

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
                    "budget_compliant": budget_compliant,
                    "room_options_comparison": room_comparison_list,
                }
            )

        # Sort locations by budget compliance first, then by strategy metric
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

        top_pick = ranked_locations[0] if ranked_locations else None

        return {
            "status": "success",
            "strategy": strategy,
            "target_rooms": target_rooms or "auto",
            "max_budget_eur": max_budget_eur,
            "total_neighborhoods_evaluated": len(ranked_locations),
            "total_combinations_evaluated": len(ranked_locations) * 3,
            "top_overall_pick": top_pick,
            "top_recommendations": ranked_locations[:10],
        }

