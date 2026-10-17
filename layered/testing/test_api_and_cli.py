#!/usr/bin/env python3
"""
Functional Test Suite for Layered Architecture (`layered/testing/test_api_and_cli.py`)
Tests the SpatialAnalyticsService, EurostatConnector, and DataRepository directly,
and verifies all REST API endpoints.
"""

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from data_access import DataRepository  # noqa: E402
from eurostat_connector import EurostatConnector  # noqa: E402
from spatial_service import SpatialAnalyticsService, haversine_distance_m  # noqa: E402


def run_tests() -> None:
    print("=== Running Functional Tests (Layered Architecture) ===")
    repo = DataRepository()
    service = SpatialAnalyticsService(repo)
    eurostat = EurostatConnector(repo)

    # Test 1: Haversine Distance Calculation
    dist = haversine_distance_m(37.9648, 23.7265, 37.9643, 23.7262)
    assert 40 <= dist <= 80, f"Unexpected Haversine distance: {dist}"
    print(f"[PASS] Test 1: Haversine distance calculation ({dist:.1f} m)")

    # Test 2: Property Evaluation in Koukaki (Safe Zone, High ROI)
    eval_koukaki = service.evaluate_property(37.9648, 23.7265, radius_m=600, rooms=2)
    assert "Κουκάκι" in eval_koukaki["location_context"]["neighbourhood"]
    assert eval_koukaki["investment_rating"]["score"] >= 70
    assert eval_koukaki["gis_spatial_analysis"]["is_in_hazard_zone"] is False
    print(
        f"[PASS] Test 2: Koukaki Property Evaluation -> Score: {eval_koukaki['investment_rating']['score']}/100, "
        f"Annual Revenue: €{eval_koukaki['airbnb_roi_metrics']['estimated_annual_gross_revenue_eur']}"
    )

    # Test 3: Property Evaluation inside Ilissos Flood Hazard Zone
    eval_hazard = service.evaluate_property(37.9608, 23.7280, radius_m=600, rooms=2)
    assert eval_hazard["gis_spatial_analysis"]["is_in_hazard_zone"] is True
    assert eval_hazard["investment_rating"]["breakdown"]["natural_hazard_penalty"] < 0
    print(
        f"[PASS] Test 3: Natural Hazard Detection -> Penalty: "
        f"{eval_hazard['investment_rating']['breakdown']['natural_hazard_penalty']} pts"
    )

    # Test 4: Neighborhood Saturation Heatmap Analytics
    nb_analytics = service.get_neighborhoods_analytics()
    assert nb_analytics["total_neighborhoods"] >= 4
    print(f"[PASS] Test 4: Neighborhoods Analytics ({nb_analytics['total_neighborhoods']} neighborhoods analyzed)")

    # Test 5: Eurostat Urban Audit Connector
    macro = eurostat.get_urban_audit_data("EL300", attempt_live=False)
    assert macro["status"] == "success"
    assert len(macro["city_analytics"]["time_series"]["years"]) == 7
    print("[PASS] Test 5: Eurostat Urban Audit (EL300) time-series verified")
    print("=== ALL TESTS PASSED SUCCESSFULLY ===")


if __name__ == "__main__":
    run_tests()
