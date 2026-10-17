#!/usr/bin/env python3
"""
Command Line Interface (CLI) - MVC Architecture (`mvc/cli/urban_mvc_cli.py`)
Communicates with the MVC Controller REST API (default port 8001).
"""

import argparse
import sys
import requests

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

DEFAULT_MVC_API = "http://127.0.0.1:8001/api/v1"


def main() -> int:
    parser = argparse.ArgumentParser(description="MVC CLI Client - Athens Real Estate & Urban Analytics")
    parser.add_argument("--api-url", default=DEFAULT_MVC_API)
    sub = parser.add_subparsers(dest="command")

    ev = sub.add_parser("evaluate")
    ev.add_argument("--lat", type=float, default=37.9648)
    ev.add_argument("--lon", type=float, default=23.7265)
    ev.add_argument("--radius", type=float, default=600.0)
    ev.add_argument("--rooms", type=int, default=2)

    sub.add_parser("neighborhoods")
    sub.add_parser("macro")
    sub.add_parser("sync")

    args = parser.parse_args()
    cmd = args.command or "evaluate"

    if cmd == "evaluate":
        lat = getattr(args, "lat", 37.9648)
        lon = getattr(args, "lon", 23.7265)
        radius = getattr(args, "radius", 600.0)
        rooms = getattr(args, "rooms", 2)
        r = requests.get(f"{args.api_url}/properties/evaluate", params={"lat": lat, "lon": lon, "radius": radius, "rooms": rooms}, timeout=5)
        r.raise_for_status()
        d = r.json()
        print("=" * 74)
        print(f" [MVC CLI] Αξιολόγηση Σημείου ({lat}, {lon}) - {d['location_context']['neighbourhood']}")
        print(f" Score: {d['investment_rating']['score']}/100 ({d['investment_rating']['grade']})")
        print(f" ADR: €{d['airbnb_roi_metrics']['average_daily_rate_eur']} | Πληρότητα: {d['airbnb_roi_metrics']['occupancy_rate_pct']}%")
        print(f" Ετήσιο Έσοδο: €{d['airbnb_roi_metrics']['estimated_annual_gross_revenue_eur']:,.2f} | Gross ROI: {d['airbnb_roi_metrics']['gross_roi_yield_pct']}%")
        print("=" * 74)
    elif cmd == "neighborhoods":
        r = requests.get(f"{args.api_url}/neighborhoods/analytics", timeout=5)
        r.raise_for_status()
        d = r.json()
        print(f"[MVC CLI] Σύνολο Γειτονιών: {d['total_neighborhoods']} | Καταλύματα Πόλης: {d['total_city_airbnb_listings']:,d}")
        for nb in d["neighborhoods"][:10]:
            print(f"  - {nb['name']:<28} : {nb['total_airbnb_listings']:>4d} Airbnb | ADR €{nb['avg_adr_eur']:>6.2f} | {nb['listings_per_1000_residents']:>5.1f}/1k κατ.")
    elif cmd == "macro":
        r = requests.get(f"{args.api_url}/macro/urban-audit", params={"city": "EL300"}, timeout=5)
        r.raise_for_status()
        d = r.json()
        print(f"[MVC CLI] Eurostat Urban Audit ({d['requested_city']}): {d['connection']['mode']}")
    elif cmd == "sync":
        r = requests.post(f"{args.api_url}/admin/sync", timeout=5)
        r.raise_for_status()
        print("[MVC CLI] Synchronized:", r.json()["datasets_reloaded"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
