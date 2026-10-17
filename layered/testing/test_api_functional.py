#!/usr/bin/env python3
"""
API Functional Test Suite - Layered Architecture (`layered/testing/test_api_functional.py`)
Verifies all REST API v1 endpoints via direct ASGI invocation (zero external test dependencies),
44 real Athens neighborhoods, 14,171 Inside Airbnb census statistics, Athens GIS hazards,
Eurostat Urban Audit (`EL001C`), and Open-Meteo Geocoding integration.
"""

import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Dict, Tuple
from urllib.parse import quote, urlsplit

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from app import app  # noqa: E402


async def asgi_request(
    asgi_app: Any,
    method: str,
    path: str,
    body_dict: Dict[str, Any] | None = None,
    headers: Dict[str, str] | None = None,
) -> Tuple[int, str, Any]:
    """Zero-dependency ASGI HTTP request runner for functional testing."""
    parsed = urlsplit(path)
    raw_body = json.dumps(body_dict).encode("utf-8") if body_dict is not None else b""
    req_headers = [(b"host", b"127.0.0.1:8000")]
    if body_dict is not None:
        req_headers.append((b"content-type", b"application/json"))
    if headers:
        for k, v in headers.items():
            req_headers.append((k.lower().encode("utf-8"), v.encode("utf-8")))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method.upper(),
        "scheme": "http",
        "path": parsed.path,
        "query_string": quote(parsed.query, safe="=&").encode("ascii"),
        "headers": req_headers,
    }

    response_status = 500
    response_chunks = []

    async def receive():
        return {"type": "http.request", "body": raw_body, "more_body": False}

    async def send(message):
        nonlocal response_status
        if message["type"] == "http.response.start":
            response_status = message["status"]
        elif message["type"] == "http.response.body":
            response_chunks.append(message.get("body", b""))

    await asgi_app(scope, receive, send)
    text = b"".join(response_chunks).decode("utf-8", errors="replace")
    try:
        parsed_json = json.loads(text)
    except Exception:
        parsed_json = None
    return response_status, text, parsed_json


async def run_api_functional_tests() -> None:
    print("=== [LAYERED] API FUNCTIONAL TEST SUITE ===")

    # 1. GET /api/v1/health
    status, _, h_json = await asgi_request(app, "GET", "/api/v1/health")
    assert status == 200
    assert h_json["status"] == "healthy"
    assert h_json["datasets_loaded"]["neighborhoods"] >= 40
    print(f"[PASS] 1. GET /api/v1/health -> {h_json['datasets_loaded']}")

    # 2. GET /api/v1/properties/evaluate (Safe High-Yield Point in Koukaki)
    status, _, ev = await asgi_request(
        app,
        "GET",
        "/api/v1/properties/evaluate?lat=37.9648&lon=23.7265&radius=600&rooms=2",
    )
    assert status == 200
    assert ev["status"] == "success"
    assert "Κουκάκι" in ev["location_context"]["neighbourhood"]
    assert ev["investment_rating"]["score"] >= 70.0
    assert ev["gis_spatial_analysis"]["is_in_hazard_zone"] is False
    assert ev["gis_spatial_analysis"]["nearest_museum"] is not None
    assert ev["gis_spatial_analysis"]["nearest_restaurant_hub"] is not None
    assert ev["gis_spatial_analysis"]["nearest_landmark"] is not None
    assert ev["gis_spatial_analysis"]["poi_distribution"]["estimated_dining_venues_count"] > 0
    assert ev["airbnb_roi_metrics"]["estimated_annual_gross_revenue_eur"] > 15000
    print(
        f"[PASS] 2. GET /api/v1/properties/evaluate (Koukaki) -> "
        f"Score={ev['investment_rating']['score']}, ADR=€{ev['airbnb_roi_metrics']['average_daily_rate_eur']}, "
        f"DiningVenues=~{ev['gis_spatial_analysis']['poi_distribution']['estimated_dining_venues_count']}"
    )

    # 3. GET /api/v1/properties/evaluate (Natural Hazard Point in Ilissos Flood Zone)
    status, _, hz = await asgi_request(
        app,
        "GET",
        "/api/v1/properties/evaluate?lat=37.9608&lon=23.7280&radius=600&rooms=2",
    )
    assert status == 200
    assert hz["gis_spatial_analysis"]["is_in_hazard_zone"] is True
    assert hz["investment_rating"]["breakdown"]["natural_hazard_penalty"] < 0
    print(
        f"[PASS] 3. GET /api/v1/properties/evaluate (Flood Hazard Zone) -> "
        f"Penalty={hz['investment_rating']['breakdown']['natural_hazard_penalty']} pts"
    )

    # 4. GET /api/v1/neighborhoods/analytics (All 44 Official Athens Neighborhoods)
    status, _, nb = await asgi_request(app, "GET", "/api/v1/neighborhoods/analytics")
    assert status == 200
    assert nb["total_neighborhoods"] >= 40
    assert nb["total_city_airbnb_listings"] > 10000
    print(
        f"[PASS] 4. GET /api/v1/neighborhoods/analytics -> "
        f"{nb['total_neighborhoods']} neighborhoods, {nb['total_city_airbnb_listings']:,d} city listings"
    )

    # 5. GET /api/v1/macro/urban-audit?city=EL300
    status, _, macro = await asgi_request(
        app, "GET", "/api/v1/macro/urban-audit?city=EL300&live=false"
    )
    assert status == 200
    assert macro["status"] == "success"
    assert len(macro["city_analytics"]["time_series"]["years"]) == 7
    print("[PASS] 5. GET /api/v1/macro/urban-audit -> Eurostat time-series & benchmark verified")

    # 6. GET /api/v1/gis/geocode?q=Κολωνάκι
    status, _, geo = await asgi_request(app, "GET", "/api/v1/gis/geocode?q=Κολωνάκι")
    assert status == 200
    assert geo["count"] >= 1
    print(f"[PASS] 6. GET /api/v1/gis/geocode -> Found '{geo['results'][0]['name']}'")

    # 7. POST & GET /api/v1/scenarios
    status, _, _ = await asgi_request(
        app,
        "POST",
        "/api/v1/scenarios",
        body_dict={
            "title": "Automated Functional Test Scenario",
            "lat": 37.9722,
            "lon": 23.7305,
            "radius": 500,
            "rooms": 2,
            "acquisition_cost_eur": 310000,
            "investment_score": 89.2,
            "estimated_annual_revenue_eur": 39500,
            "estimated_gross_roi_pct": 12.74,
            "neighbourhood": "Εμπορικό Τρίγωνο - Πλάκα",
        },
    )
    assert status == 201
    status, _, sc_list = await asgi_request(app, "GET", "/api/v1/scenarios")
    assert status == 200
    assert sc_list["count"] >= 1
    print("[PASS] 7. POST & GET /api/v1/scenarios -> Scenario persisted & retrieved")

    # 8. POST /api/v1/admin/sync
    status, _, sync_res = await asgi_request(app, "POST", "/api/v1/admin/sync")
    assert status == 200
    assert sync_res["status"] == "synchronized"
    print("[PASS] 8. POST /api/v1/admin/sync -> Datasets synchronized")

    # 9. GET /api/v1/properties/top-recommendations
    status, _, top_rec = await asgi_request(
        app, "GET", "/api/v1/properties/top-recommendations?strategy=score&rooms=auto&budget=0"
    )
    assert status == 200
    assert top_rec["status"] == "success"
    assert top_rec["total_neighborhoods_evaluated"] >= 40
    assert top_rec["top_overall_pick"] is not None
    top_pick = top_rec["top_overall_pick"]
    print(
        f"[PASS] 9. GET /api/v1/properties/top-recommendations -> "
        f"#1 {top_pick['neighbourhood']} ({top_pick['best_room_label']}) "
        f"Score={top_pick['investment_score']}, ROI={top_pick['gross_roi_pct']}%"
    )
    print("=== ALL 9 LAYERED API FUNCTIONAL TESTS PASSED ===\n")


if __name__ == "__main__":
    asyncio.run(run_api_functional_tests())
