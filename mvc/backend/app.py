"""
MVC Architecture - Application Entrypoint (`mvc/backend/app.py`)
wires routes to `UrbanAnalyticsController` and serves:
  - View 1 (Desktop Browser View) : http://127.0.0.1:8001/desktop
  - View 2 (Smartphone View)      : http://127.0.0.1:8001/mobile
  - REST API v1                   : http://127.0.0.1:8001/api/v1/*
"""

from pathlib import Path
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
import uvicorn

from controllers import UrbanAnalyticsController

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
controller = UrbanAnalyticsController()


async def serve_mvc_asset(request: Request):
    filename = f"{request.path_params.get('filename', '')}.js"
    target = FRONTEND_DIR / filename
    if target.exists() and target.is_file():
        return FileResponse(target)
    return JSONResponse({"error": "Not found"}, status_code=404)


routes = [
    Route("/", controller.render_root_view, methods=["GET"]),
    Route("/desktop", controller.render_desktop_view, methods=["GET"]),
    Route("/mobile", controller.render_mobile_view, methods=["GET"]),
    Route("/api/v1/health", controller.api_health, methods=["GET"]),
    Route("/api/v1/properties/evaluate", controller.api_evaluate_property, methods=["GET"]),
    Route("/api/v1/properties/top-recommendations", controller.api_top_recommendations, methods=["GET"]),
    Route("/api/v1/neighborhoods/analytics", controller.api_neighborhoods_analytics, methods=["GET"]),
    Route("/api/v1/macro/urban-audit", controller.api_macro_urban_audit, methods=["GET"]),
    Route("/api/v1/scenarios", controller.api_scenarios, methods=["GET", "POST"]),
    Route("/api/v1/admin/sync", controller.api_admin_sync, methods=["POST"]),
    Route("/api/v1/gis/layers", controller.api_gis_layers, methods=["GET"]),
    Route("/api/v1/gis/geocode", controller.api_geocode, methods=["GET"]),
    Route("/{filename:str}.js", serve_mvc_asset, methods=["GET"]),
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
    print(" Athens Real Estate & Urban Analytics v1.0 (MVC Architecture)             ")
    print(" -> View 1 (Desktop Browser View) : http://127.0.0.1:8001/desktop         ")
    print(" -> View 2 (Smartphone View)      : http://127.0.0.1:8001/mobile          ")
    print(" -> REST API v1                   : http://127.0.0.1:8001/api/v1/health   ")
    print("==========================================================================")
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")
