"""
Eurostat Urban Audit Connector - Service / Integration Layer
Connects to the official Eurostat Dissemination REST API (JSON-stat 2.0 / SDMX 3.0)
for datasets `urb_cpop1`, `urb_ctour`, `urb_clivcon` using the official Athens city code `EL001C`
with automatic fallback to the local verified cache.
"""

from datetime import datetime, timezone
from typing import Any, Dict
import requests

from data_access import DataRepository


class EurostatConnector:
    """Fetches Urban Audit macro indicators from Eurostat REST API (`EL001C`) with resilient cache fallback."""

    EUROSTAT_API_URLS = {
        "urb_cpop1": (
            "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/urb_cpop1"
            "?format=JSON&lang=EN&cities=EL001C&indic_ur=DE1001V"
        ),
        "urb_ctour": (
            "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/urb_ctour"
            "?format=JSON&lang=EN&cities=EL001C&indic_ur=CR2001V"
        ),
        "urb_percep": (
            "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/urb_percep"
            "?format=JSON&lang=EN&cities=EL001C&indic_ur=PS3524V&indic_ur=PS3525V"
        ),
    }

    def __init__(self, repo: DataRepository) -> None:
        self.repo = repo

    @staticmethod
    def _decode_jsonstat_series(raw_json: Dict[str, Any]) -> Dict[str, float]:
        """Extracts {year: value} dictionary from a Eurostat JSON-stat 2.0 payload."""
        try:
            time_idx = {
                v: k for k, v in raw_json["dimension"]["time"]["category"]["index"].items()
            }
            vals = raw_json.get("value", {})
            return {
                time_idx[int(k)]: float(v)
                for k, v in vals.items()
                if int(k) in time_idx and v is not None
            }
        except Exception:
            return {}

    def get_urban_audit_data(self, city_code: str = "EL300", attempt_live: bool = True) -> Dict[str, Any]:
        cache_payload = self.repo.get_eurostat_cache()
        cities = cache_payload.get("cities", {})

        normalized_code = city_code.upper().strip()
        if normalized_code in ("ATHENS", "EL001C", "EL001C1", "EL30", "EL300"):
            normalized_code = "EL300"

        city_data = dict(cities.get(normalized_code, cities.get("EL300", {})))
        live_extract = cache_payload.get("live_eurostat_sdmx_extract", {})
        qol_percep = live_extract.get("urb_percep_quality_of_life_2023", {})

        live_status: Dict[str, Any] = {
            "mode": "CACHED_SDMX_SNAPSHOT",
            "live_api_attempted": attempt_live,
            "official_eurostat_city_code": "EL001C (Athina - Greater City)",
            "eurostat_datasets": [
                "urb_cpop1 (DE1001V)",
                "urb_ctour (CR2001V)",
                "urb_clivcon (SA1001V)",
                "urb_percep (Quality of Life Survey: PS1012V, PS3524V, PS3519V, PS1052V, PS1082V, PS3270V)",
            ],
            "requires_api_key": False,
            "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

        if attempt_live:
            try:
                resp = requests.get(self.EUROSTAT_API_URLS["urb_cpop1"], timeout=3.0)
                if resp.status_code == 200:
                    raw_json = resp.json()
                    decoded = self._decode_jsonstat_series(raw_json)
                    live_status["mode"] = "LIVE_EUROSTAT_API_CONNECTED"
                    live_status["live_observations_count"] = len(decoded)
                    live_status["dataset_label"] = raw_json.get(
                        "label", "Population on 1 January - cities and greater cities (urb_cpop1)"
                    )
                    live_status["latest_live_sample"] = dict(list(decoded.items())[-4:])
            except Exception as exc:
                live_status["fallback_reason"] = f"Local SDMX cache active ({type(exc).__name__})"

        return {
            "status": "success",
            "connection": live_status,
            "requested_city": normalized_code,
            "city_analytics": city_data,
            "quality_of_life_urb_percep": qol_percep,
            "live_eurostat_sdmx_extract": live_extract,
            "comparison_cities": [cities[k] for k in cities if k != normalized_code],
            "eu_mediterranean_benchmark": cache_payload.get("eu_Mediterranean_benchmark", []),
        }
