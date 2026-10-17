"""
Presentation / REST API Layer - Layered Architecture
Exposes the RESTful API v1 endpoints for the Athens Real Estate & Urban Analytics Platform
and serves the responsive Frontend Dashboard.
"""

from datetime import datetime, timezone
from pathlib import Path
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
import uvicorn

from data_access import DataRepository
from eurostat_connector import EurostatConnector
from spatial_service import SpatialAnalyticsService

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

# Initialize Layered Architecture components (DAL -> BLL -> API)
repository = DataRepository()
eurostat_connector = EurostatConnector(repository)
analytics_service = SpatialAnalyticsService(repository)


async def health_check(request: Request) -> JSONResponse:
    """GET /api/v1/health - System status and active data sources."""
    return JSONResponse(
        {
            "status": "healthy",
            "version": "1.0.0",
            "architecture": "Layered (Presentation / Business Logic / Data Access)",
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "datasets_loaded": {
                "neighborhoods": len(repository.get_neighborhood_features()),
                "airbnb_listings_sample": len(repository.get_airbnb_features()),
                "athens_gis_pois": len(repository.get_gis_poi_features()),
                "athens_gis_hazards": len(repository.get_gis_hazard_features()),
            },
            "data_sources": [
                "Inside Airbnb Official Athens Dataset (Category 9 - 14,171 Listings & 44 Neighborhood Polygons)",
                "Athens GIS Repository & Open-Meteo Geocoding API (Category 7 - GeoJSON Layers)",
                "Eurostat Urban Audit SDMX/JSON-stat API (Category 6 - EL001C / urb_*)",
            ],
        }
    )


async def evaluate_property(request: Request) -> JSONResponse:
    """
    GET /api/v1/properties/evaluate?lat={lat}&lon={lon}&radius={m}&rooms={n}&acquisition_cost={eur}
    Evaluates a micro-location in Athens combining Athens GIS & Inside Airbnb.
    """
    try:
        lat = float(request.query_params.get("lat", 37.9648))
        lon = float(request.query_params.get("lon", 23.7265))
        radius = float(request.query_params.get("radius", 600))
        rooms = int(request.query_params.get("rooms", 2))
        cost_param = request.query_params.get("acquisition_cost")
        acquisition_cost = float(cost_param) if cost_param else None
    except ValueError as exc:
        return JSONResponse(
            {"status": "error", "message": f"Invalid query parameters: {exc}"},
            status_code=400,
        )

    result = analytics_service.evaluate_property(
        lat=lat,
        lon=lon,
        radius_m=radius,
        rooms=rooms,
        acquisition_cost_eur=acquisition_cost,
    )
    return JSONResponse(result)


async def top_recommendations(request: Request) -> JSONResponse:
    """
    GET /api/v1/properties/top-recommendations?rooms={auto|1|2|3}&budget={eur}&strategy={score|roi|revenue}
    Scans all 44 neighborhoods of Athens and all apartment sizes (1BR, 2BR, 3BR)
    to find the #1 Top Micro-Location and Optimal Apartment Configuration.
    """
    rooms_raw = request.query_params.get("rooms", "auto")
    target_rooms = int(rooms_raw) if rooms_raw in ("1", "2", "3") else None
    budget_raw = request.query_params.get("budget")
    max_budget = float(budget_raw) if budget_raw and float(budget_raw) > 0 else None
    strategy = request.query_params.get("strategy", "score")
    radius = float(request.query_params.get("radius", 600))

    result = analytics_service.get_top_investment_recommendations(
        target_rooms=target_rooms,
        max_budget_eur=max_budget,
        strategy=strategy,
        radius_m=radius,
    )
    return JSONResponse(result)


async def neighborhoods_analytics(request: Request) -> JSONResponse:
    """
    GET /api/v1/neighborhoods/analytics
    Returns gentrification, Airbnb saturation per 1,000 residents, ADR, and polygons per neighborhood.
    """
    result = analytics_service.get_neighborhoods_analytics()
    return JSONResponse(result)


async def macro_urban_audit(request: Request) -> JSONResponse:
    """
    GET /api/v1/macro/urban-audit?city=EL300
    Fetches macroeconomic and quality-of-life time series from Eurostat Urban Audit (with cache fallback).
    """
    city = request.query_params.get("city", "EL300")
    live_flag = request.query_params.get("live", "true").lower() != "false"
    result = eurostat_connector.get_urban_audit_data(city_code=city, attempt_live=live_flag)
    return JSONResponse(result)


async def geocode_place(request: Request) -> JSONResponse:
    """
    GET /api/v1/gis/geocode?q={query}
    Searches Athens neighborhoods, GIS POIs, and Open-Meteo Geocoding API.
    """
    q = request.query_params.get("q", "Κουκάκι")
    result = analytics_service.geocode_athens_query(q)
    return JSONResponse(result)


async def handle_scenarios(request: Request) -> JSONResponse:
    """
    GET /api/v1/scenarios & POST /api/v1/scenarios
    Lists saved investment scenarios or persists a new evaluated scenario.
    """
    if request.method == "GET":
        scenarios = repository.get_scenarios()
        return JSONResponse(
            {
                "status": "success",
                "count": len(scenarios),
                "scenarios": scenarios,
            }
        )

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            {"status": "error", "message": "Invalid JSON body"}, status_code=400
        )

    saved = repository.save_scenario(body)
    return JSONResponse(
        {
            "status": "created",
            "scenario": saved,
        },
        status_code=201,
    )


async def admin_sync(request: Request) -> JSONResponse:
    """
    POST /api/v1/admin/sync
    Reloads local Inside Airbnb & Athens GIS datasets and synchronizes Eurostat Urban Audit indicators.
    """
    counts = repository.reload_all()
    eurostat_status = eurostat_connector.get_urban_audit_data("EL300", attempt_live=True)
    return JSONResponse(
        {
            "status": "synchronized",
            "synced_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "datasets_reloaded": counts,
            "eurostat_connection": eurostat_status.get("connection"),
        }
    )


async def gis_layers(request: Request) -> JSONResponse:
    """
    GET /api/v1/gis/layers
    Returns all GeoJSON layers (Inside Airbnb listings, Athens GIS POIs, Flood/Heat Hazards, Neighborhoods)
    for interactive map rendering.
    """
    return JSONResponse(
        {
            "status": "success",
            "layers": repository.get_all_geojson_layers(),
        }
    )


async def serve_index(request: Request):
    """Serves the responsive Frontend Dashboard index.html."""
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return JSONResponse({"message": "Athens Real Estate & Urban Analytics API v1.0 running."})


async def serve_frontend_asset(request: Request):
    """Serves frontend JS assets at root path for GitHub Pages / relative script compatibility."""
    filename = f"{request.path_params.get('filename', '')}.js"
    target = FRONTEND_DIR / filename
    if target.exists() and target.is_file():
        return FileResponse(target)
    return JSONResponse({"error": "Not found"}, status_code=404)


routes = [
    Route("/api/v1/health", health_check, methods=["GET"]),
    Route("/api/v1/properties/evaluate", evaluate_property, methods=["GET"]),
    Route("/api/v1/properties/top-recommendations", top_recommendations, methods=["GET"]),
    Route("/api/v1/neighborhoods/analytics", neighborhoods_analytics, methods=["GET"]),
    Route("/api/v1/macro/urban-audit", macro_urban_audit, methods=["GET"]),
    Route("/api/v1/gis/geocode", geocode_place, methods=["GET"]),
    Route("/api/v1/scenarios", handle_scenarios, methods=["GET", "POST"]),
    Route("/api/v1/admin/sync", admin_sync, methods=["POST"]),
    Route("/api/v1/gis/layers", gis_layers, methods=["GET"]),
    Route("/", serve_index, methods=["GET"]),
    Route("/{filename:str}.js", serve_frontend_asset, methods=["GET"]),
]

if FRONTEND_DIR.exists():
    routes.append(Mount("/assets", app=StaticFiles(directory=str(FRONTEND_DIR)), name="assets"))

middleware = [
    Middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
]

app = Starlette(debug=True, routes=routes, middleware=middleware)

if __name__ == "__main__":
    print("==========================================================================")
    print(" Athens Real Estate & Urban Analytics v1.0 (Layered Architecture)         ")
    print(" -> Responsive Web Dashboard : http://127.0.0.1:8000                      ")
    print(" -> REST API v1 Evaluate     : http://127.0.0.1:8000/api/v1/properties/evaluate ")
    print("==========================================================================")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
