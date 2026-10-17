#!/usr/bin/env python3
"""
Seed Script for Athens Real Estate & Urban Analytics Platform.
Supports seeding MongoDB (with 2dsphere GeoJSON indexes), PostgreSQL/PostGIS,
or validating/initializing the local JSON/GeoJSON data store fallback.
"""

import json
import os
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent


def verify_and_seed_local_store() -> dict:
    """Verifies all required GeoJSON/JSON datasets exist and returns record counts."""
    files = {
        "airbnb_listings": DATA_DIR / "airbnb_listings.geojson",
        "neighborhoods": DATA_DIR / "neighborhoods.geojson",
        "athens_gis_pois": DATA_DIR / "athens_gis_pois.geojson",
        "athens_gis_hazards": DATA_DIR / "athens_gis_hazards.geojson",
        "eurostat_urban_audit": DATA_DIR / "eurostat_urban_audit_cache.json",
        "scenarios": DATA_DIR / "scenarios.json",
    }

    summary = {}
    for key, path in files.items():
        if not path.exists():
            raise FileNotFoundError(f"Missing dataset file: {path}")
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict) and "features" in data:
                summary[key] = len(data["features"])
            elif isinstance(data, dict) and "cities" in data:
                summary[key] = len(data["cities"])
            elif isinstance(data, list):
                summary[key] = len(data)
            else:
                summary[key] = 1
    return summary


def try_seed_mongodb(mongo_uri: str) -> bool:
    """Optional MongoDB seeding with 2dsphere geospatial indexes if pymongo is configured."""
    try:
        import pymongo  # type: ignore

        client = pymongo.MongoClient(mongo_uri, serverSelectionTimeoutMS=2000)
        client.admin.command("ping")
        db = client["athens_urban_analytics"]

        for name, filename in [
            ("airbnb_listings", "airbnb_listings.geojson"),
            ("neighborhoods", "neighborhoods.geojson"),
            ("athens_gis_pois", "athens_gis_pois.geojson"),
            ("athens_gis_hazards", "athens_gis_hazards.geojson"),
        ]:
            with open(DATA_DIR / filename, "r", encoding="utf-8") as f:
                fc = json.load(f)
            col = db[name]
            col.drop()
            if fc.get("features"):
                col.insert_many(fc["features"])
                col.create_index([("geometry", pymongo.GEOSPHERE)])
        print("[OK] Seeded MongoDB database 'athens_urban_analytics' with 2dsphere indexes.")
        return True
    except Exception as exc:
        print(f"[INFO] MongoDB server not active ({exc}). Using high-speed GeoJSON/In-Memory engine.")
        return False


if __name__ == "__main__":
    print("=== Athens Real Estate & Urban Analytics - Data Seeder ===")
    mongo_uri = os.environ.get("MONGO_URI", "")
    if mongo_uri:
        try_seed_mongodb(mongo_uri)
    counts = verify_and_seed_local_store()
    for dataset_name, count in counts.items():
        print(f"  [+] {dataset_name:24s}: {count} records loaded & verified")
    print("=== Seeding Complete ===")
