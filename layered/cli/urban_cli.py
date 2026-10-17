#!/usr/bin/env python3
"""
Command Line Interface (CLI) - Layered Architecture (`layered/cli/urban_cli.py`)
Communicates exclusively with the REST API v1 endpoints to perform:
  1. Property Micro-Location & Airbnb ROI Evaluation (`evaluate`)
  2. Neighborhood Saturation & Gentrification Report (`neighborhoods`)
  3. Eurostat Urban Audit Macroeconomic Summary (`macro`)
  4. Data Synchronization Trigger (`sync`)
"""

import argparse
import sys
import requests

# Ensure UTF-8 output on Windows PowerShell/CMD terminals
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

DEFAULT_API_URL = "http://127.0.0.1:8000/api/v1"


def print_banner() -> None:
    print("=" * 78)
    print("  ATHENS REAL ESTATE & URBAN ANALYTICS PLATFORM - CLI (Layered REST Client)  ")
    print("  ΕΜΠ - Τεχνολογία Λογισμικού 2026-2027                                      ")
    print("=" * 78)


def cmd_evaluate(api_base: str, lat: float, lon: float, radius: float, rooms: int) -> int:
    url = f"{api_base}/properties/evaluate"
    params = {"lat": lat, "lon": lon, "radius": radius, "rooms": rooms}
    resp = requests.get(url, params=params, timeout=5)
    resp.raise_for_status()
    data = resp.json()

    loc = data["location_context"]
    rating = data["investment_rating"]
    b = rating["breakdown"]
    roi = data["airbnb_roi_metrics"]
    gis = data["gis_spatial_analysis"]

    print(f"\n[1] ΕΠΙΣΚΟΠΗΣΗ ΣΗΜΕΙΟΥ & INVESTMENT SCORE")
    print("-" * 78)
    print(f"  Συντεταγμένες        : ({data['query']['lat']}, {data['query']['lon']}) | Ακτίνα: {int(radius)}m | {rooms} ΥΔ (~{data['query']['estimated_sqm']} m²)")
    print(f"  Γειτονιά (InsideAirbnb): {loc['neighbourhood']} ({loc['neighbourhood_en']})")
    print(f"  Τάση Γειτονιάς       : {loc['gentrification_trend']}")
    print(f"  INVESTMENT SCORE     : {rating['score']} / 100  -->  {rating['grade']}")
    print("-" * 78)
    print(f"  + Προσβασιμότητα Μετρό : {b['transit_accessibility_score']:>5.1f} / 30.0")
    print(f"  + Απόδοση Airbnb (ROI) : {b['airbnb_yield_score']:>5.1f} / 35.0")
    print(f"  + Αστικές Υποδομές/ΑΕΙ : {b['urban_amenities_score']:>5.1f} / 20.0")
    print(f"  + Ανθεκτικότητα Αγοράς : {b['macro_resilience_score']:>5.1f} / 15.0")
    print(f"  - Ποινή Φυσ. Κινδύνων  : {b['natural_hazard_penalty']:>5d} pts")

    print(f"\n[2] AIRBNB ROI & ΑΝΤΑΓΩΝΙΣΜΟΣ (Inside Airbnb)")
    print("-" * 78)
    print(f"  Ανταγωνιστικά Airbnb   : {roi['competitors_in_radius']} εντός ακτίνας (Δείγμα: {roi['sample_size_used']})")
    print(f"  Μέση Ημερήσια Τιμή ADR : €{roi['average_daily_rate_eur']:.2f} / διανυκτέρευση")
    print(f"  Μέση Πληρότητα         : {roi['occupancy_rate_pct']:.1f}% ({roi['occupied_nights_per_year']} ημέρες/έτος)")
    print(f"  Ετήσιο Ακαθάριστο Έσοδο: €{roi['estimated_annual_gross_revenue_eur']:,.2f}")
    print(f"  Ετήσιο Καθαρό Έσοδο    : €{roi['estimated_annual_net_income_eur']:,.2f} (μετά από 28% λειτουργικά)")
    print(f"  Εκτιμ. Κόστος Κτήσης   : €{roi['estimated_acquisition_cost_eur']:,.2f}")
    print(f"  Gross ROI / Net ROI    : {roi['gross_roi_yield_pct']:.2f}%  /  {roi['net_roi_yield_pct']:.2f}% (Απόσβεση: {roi['payback_period_years']} έτη)")
    print(f"  Υπεραπόδοση vs Μακροχρ.: +{roi['str_vs_long_term_premium_pct']:.1f}% (Μακροχρόνια: €{roi['long_term_annual_rent_eur']:,.0f}/έτος)")

    print(f"\n[3] ΚΟΝΤΙΝΟΤΕΡΑ PLACES OF INTEREST & ΚΑΤΑΝΟΜΗ (Athens GIS)")
    print("-" * 78)
    if gis.get("nearest_metro"):
        m = gis["nearest_metro"]
        print(f"  🚇 Κοντινότερο Μετρό      : {m['name']} ({m['distance_m']} m / ~{m['walking_minutes']} λεπτά)")
    if gis.get("nearest_museum"):
        mu = gis["nearest_museum"]
        print(f"  🏛️ Κοντινότερο Μουσείο    : {mu['name']} ({mu['distance_m']} m / ~{mu['walking_minutes']} λεπτά)")
    if gis.get("nearest_restaurant_hub"):
        rh = gis["nearest_restaurant_hub"]
        print(f"  🍽️ Πιάτσα Εστιατορίων    : {rh['name']} ({rh['distance_m']} m • ~{rh.get('venue_count', 35)} χώροι εστίασης)")
    if gis.get("nearest_landmark"):
        lm = gis["nearest_landmark"]
        print(f"  🌿 Αξιοθέατο / Πάρκο     : {lm['name']} ({lm['distance_m']} m / ~{lm['walking_minutes']} λεπτά)")

    dist = gis.get("poi_distribution")
    if dist:
        print(
            f"  📊 Κατανομή εντός {dist['catchment_radius_m']}m : "
            f"{dist['restaurant_hubs_count']} Πιάτσες Εστίασης (~{dist['estimated_dining_venues_count']} εστιατόρια/μπαρ) | "
            f"{dist['museums_count']} Μουσεία | {dist['landmarks_count']} Αξιοθέατα | {dist['metro_stations_count']} Μετρό"
        )

    if gis["is_in_hazard_zone"]:
        for hz in gis["natural_hazards_detected"]:
            print(f"  [!] ΠΡΟΕΙΔΟΠΟΙΗΣΗ GIS  : {hz['name']} [{hz['severity']}]")
            print(f"      Σύσταση Μηχανικού  : {hz['recommendation']}")
    else:
        print("  [OK] Φυσικοί Κίνδυνοι  : Ασφαλής Ζώνη (Εκτός ζωνών πλημμύρας/θερμικής νησίδας)")

    print(f"\n[4] ΚΟΝΤΙΝΟΤΕΡΑ ΑΝΤΑΓΩΝΙΣΤΙΚΑ ΚΑΤΑΛΥΜΑΤΑ AIRBNB")
    print("-" * 78)
    print(f"  {'ID':<10} {'Όνομα Καταλύματος':<36} {'ΥΔ':<4} {'ADR (€)':<9} {'Πληρ.%':<8} {'Απόστ.'}")
    print("  " + "-" * 74)
    for c in roi.get("nearby_competitors", [])[:5]:
        name_trunc = (c["name"][:33] + "...") if len(c["name"]) > 36 else c["name"]
        occ_str = f"{c['occupancy_rate']*100:.1f}%"
        print(f"  {c['id']:<10} {name_trunc:<36} {c['rooms']:<4} €{c['price']:<8.1f} {occ_str:<8} {c['distance_m']}m")
    print("=" * 78)
    return 0


def cmd_neighborhoods(api_base: str) -> int:
    resp = requests.get(f"{api_base}/neighborhoods/analytics", timeout=5)
    resp.raise_for_status()
    data = resp.json()

    print("\n[GENTRIFICATION & SATURATION HEATMAP - ΓΕΙΤΟΝΙΕΣ ΑΘΗΝΑΣ]")
    print("-" * 78)
    print(f"  {'Γειτονιά':<22} {'Πληθυσμός':<10} {'Airbnb':<8} {'Ανά 1k Κατ.':<12} {'ADR (€)':<9} {'Ετήσιο Έσοδο'}")
    print("  " + "-" * 74)
    for nb in data.get("neighborhoods", []):
        print(
            f"  {nb['name']:<22} {nb['population']:<10,d} {nb['total_airbnb_listings']:<8d} "
            f"{nb['listings_per_1000_residents']:<12.1f} €{nb['avg_adr_eur']:<8.2f} "
            f"€{nb['estimated_avg_annual_revenue_eur']:,.0f}"
        )
    print("=" * 78)
    return 0


def cmd_macro(api_base: str, city: str) -> int:
    resp = requests.get(f"{api_base}/macro/urban-audit", params={"city": city}, timeout=6)
    resp.raise_for_status()
    data = resp.json()
    city_info = data.get("city_analytics", {})
    kpis = city_info.get("summary_kpis", {})
    ts = city_info.get("time_series", {})

    print(f"\n[EUROSTAT URBAN AUDIT MACRO INDICATORS - {city_info.get('name', city)}]")
    print(f"  Κατάσταση Σύνδεσης : {data['connection']['mode']} ({data['connection']['eurostat_dataset']})")
    print("-" * 78)
    print(f"  Πληθυσμός Δήμου          : {kpis.get('population_latest', 0):,d}")
    print(f"  ΑΕΠ ανά Κάτοικο (PPS)    : €{kpis.get('gdp_per_capita_pps', 0):,d}")
    print(f"  Διανυκτερεύσεις Τουριστών: {kpis.get('tourism_nights_spent_millions', 0)} εκατ. (+{kpis.get('yoy_tourism_growth_pct', 0)}% YoY)")
    print(f"  Μακροοικονομική Προοπτική: {kpis.get('macro_investment_outlook', 'N/A')}")
    if ts and "years" in ts:
        print("\n  Χρονοσειρά Eurostat (2019 - 2025):")
        print(f"  {'Έτος':<8} {'Τουρ. Διανυκτ. (Εκατ.)':<24} {'Δείκτης Τιμών Κατοικιών':<26} {'Μερίδιο Κλινών STR (%)'}")
        print("  " + "-" * 74)
        for i, yr in enumerate(ts["years"]):
            print(
                f"  {yr:<8} {ts['tourist_nights_millions'][i]:<24.1f} "
                f"{ts['residential_price_index_2015_100'][i]:<26.1f} "
                f"{ts['short_term_rental_bed_share_pct'][i]:.1f}%"
            )
    print("=" * 78)
    return 0


def cmd_sync(api_base: str) -> int:
    resp = requests.post(f"{api_base}/admin/sync", timeout=8)
    resp.raise_for_status()
    data = resp.json()
    print("\n[ADMIN SYNC COMPLETE]")
    print(f"  Timestamp : {data['synced_at']}")
    for k, v in data.get("datasets_reloaded", {}).items():
        print(f"  - {k:<22}: {v} εγγραφές")
    print("=" * 78)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="CLI Εργαλείο Αξιολόγησης Ακινήτων & Αστικής Ανάλυσης Αθήνας (Layered REST Client)"
    )
    parser.add_argument(
        "--api-url",
        default=DEFAULT_API_URL,
        help=f"Βασικό URL του REST API (default: {DEFAULT_API_URL})",
    )
    subparsers = parser.add_subparsers(dest="command")

    eval_p = subparsers.add_parser("evaluate", help="Χωρική αξιολόγηση ακινήτου & υπολογισμός ROI")
    eval_p.add_argument("--lat", type=float, default=37.9648, help="Γεωγραφικό πλάτος (default: 37.9648 Κουκάκι)")
    eval_p.add_argument("--lon", type=float, default=23.7265, help="Γεωγραφικό μήκος (default: 23.7265 Κουκάκι)")
    eval_p.add_argument("--radius", type=float, default=600.0, help="Ακτίνα αναζήτησης σε μέτρα (default: 600)")
    eval_p.add_argument("--rooms", type=int, default=2, help="Αριθμός υπνοδωματίων (default: 2)")

    subparsers.add_parser("neighborhoods", help="Πίνακας κορεσμού Airbnb & αποδόσεων ανά γειτονιά")

    macro_p = subparsers.add_parser("macro", help="Μακροοικονομικοί δείκτες Eurostat Urban Audit")
    macro_p.add_argument("--city", default="EL300", help="Κωδικός πόλης Eurostat (default: EL300 Αθήνα)")

    subparsers.add_parser("sync", help="Συγχρονισμός όλων των πηγών δεδομένων μέσω του REST API")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    print_banner()

    try:
        if args.command == "evaluate":
            return cmd_evaluate(args.api_url, args.lat, args.lon, args.radius, args.rooms)
        elif args.command == "neighborhoods":
            return cmd_neighborhoods(args.api_url)
        elif args.command == "macro":
            return cmd_macro(args.api_url, args.city)
        elif args.command == "sync":
            return cmd_sync(args.api_url)
        else:
            # Default full demo output when executed without subcommands
            cmd_evaluate(args.api_url, 37.9648, 23.7265, 600.0, 2)
            cmd_neighborhoods(args.api_url)
            return 0
    except requests.exceptions.ConnectionError:
        print(
            "\n[ΣΦΑΛΜΑ ΣΥΝΔΕΣΗΣ] Δεν βρέθηκε ενεργός ο REST API Server στο "
            f"{args.api_url}.\nΒεβαιωθείτε ότι τρέχει το backend: python layered/backend/app.py",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
