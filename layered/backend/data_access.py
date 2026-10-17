"""
Data Access Layer (DAL) - Layered Architecture
Handles reading/writing geospatial datasets (Inside Airbnb, Athens GIS, Eurostat Cache, Scenarios)
with support for MongoDB/PostGIS or local GeoJSON/JSON storage.
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class DataRepository:
    """Repository providing structured access to the 3 primary data sources."""

    def __init__(self, data_dir: Path = DATA_DIR) -> None:
        self.data_dir = data_dir
        self._cache: Dict[str, Any] = {}
        self.reload_all()

    def reload_all(self) -> Dict[str, int]:
        """Loads or refreshes all datasets from disk into memory."""
        self._cache["airbnb"] = self._read_json("airbnb_listings.geojson")
        self._cache["neighborhoods"] = self._read_json("neighborhoods.geojson")
        self._cache["gis_pois"] = self._read_json("athens_gis_pois.geojson")
        self._cache["gis_hazards"] = self._read_json("athens_gis_hazards.geojson")
        self._cache["eurostat"] = self._read_json("eurostat_urban_audit_cache.json")
        self._cache["scenarios"] = self._read_json("scenarios.json")
        return {
            "airbnb_listings": len(self._cache["airbnb"].get("features", [])),
            "neighborhoods": len(self._cache["neighborhoods"].get("features", [])),
            "gis_pois": len(self._cache["gis_pois"].get("features", [])),
            "gis_hazards": len(self._cache["gis_hazards"].get("features", [])),
            "eurostat_cities": len(self._cache["eurostat"].get("cities", {})),
            "saved_scenarios": len(self._cache["scenarios"]),
        }

    def _read_json(self, filename: str) -> Any:
        file_path = self.data_dir / filename
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _write_json(self, filename: str, payload: Any) -> None:
        file_path = self.data_dir / filename
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

    def get_airbnb_features(self) -> List[Dict[str, Any]]:
        return self._cache["airbnb"].get("features", [])

    def get_neighborhood_features(self) -> List[Dict[str, Any]]:
        return self._cache["neighborhoods"].get("features", [])

    def get_gis_poi_features(self) -> List[Dict[str, Any]]:
        return self._cache["gis_pois"].get("features", [])

    def get_gis_hazard_features(self) -> List[Dict[str, Any]]:
        return self._cache["gis_hazards"].get("features", [])

    def get_all_geojson_layers(self) -> Dict[str, Any]:
        return {
            "airbnb_listings": self._cache["airbnb"],
            "neighborhoods": self._cache["neighborhoods"],
            "athens_gis_pois": self._cache["gis_pois"],
            "athens_gis_hazards": self._cache["gis_hazards"],
        }

    def get_eurostat_cache(self) -> Dict[str, Any]:
        return self._cache["eurostat"]

    def get_scenarios(self) -> List[Dict[str, Any]]:
        return list(self._cache["scenarios"])

    def save_scenario(self, scenario_data: Dict[str, Any]) -> Dict[str, Any]:
        scenarios = self.get_scenarios()
        new_scenario = {
            "scenario_id": f"scen-{uuid.uuid4().hex[:6]}",
            "title": scenario_data.get("title", "Επενδυτικό Σενάριο Αθήνας"),
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "lat": float(scenario_data.get("lat", 37.9648)),
            "lon": float(scenario_data.get("lon", 23.7265)),
            "radius": int(scenario_data.get("radius", 500)),
            "rooms": int(scenario_data.get("rooms", 2)),
            "acquisition_cost_eur": float(scenario_data.get("acquisition_cost_eur", 220000)),
            "investment_score": float(scenario_data.get("investment_score", 0.0)),
            "estimated_annual_revenue_eur": float(scenario_data.get("estimated_annual_revenue_eur", 0.0)),
            "estimated_gross_roi_pct": float(scenario_data.get("estimated_gross_roi_pct", 0.0)),
            "neighbourhood": scenario_data.get("neighbourhood", "Αθήνα"),
        }
        scenarios.insert(0, new_scenario)
        self._cache["scenarios"] = scenarios
        self._write_json("scenarios.json", scenarios)
        return new_scenario
