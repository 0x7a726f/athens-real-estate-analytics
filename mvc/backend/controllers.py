"""
MVC Architecture - Controller Layer (`mvc/backend/controllers.py`)
Handles incoming HTTP requests, coordinates Domain Models (`models.py`),
and selects/renders the appropriate View (`DesktopView` vs `SmartphoneView`) or JSON API payload.
"""

from datetime import datetime, timezone
from pathlib import Path
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse

from models import (
    EurostatMacroModel,
    NeighborhoodAnalyticsModel,
    PropertyEvaluationModel,
    ScenarioPortfolioModel,
    UrbanDataStoreModel,
)

FRONTEND_VIEWS_DIR = Path(__file__).resolve().parent.parent / "frontend"


class UrbanAnalyticsController:
    """Main MVC Controller coordinating Models and dispatching to Desktop/Smartphone Views or JSON API."""

    def __init__(self) -> None:
        self.store_model = UrbanDataStoreModel()
        self.property_model = PropertyEvaluationModel(self.store_model)
        self.neighborhood_model = NeighborhoodAnalyticsModel(self.store_model)
        self.eurostat_model = EurostatMacroModel(self.store_model)
        self.scenario_model = ScenarioPortfolioModel(self.store_model)

    async def render_root_view(self, request: Request):
        """
        Inspects User-Agent or `?view=` query parameter to dispatch to either:
          - View 1: Desktop Browser View (`desktop_view.html`)
          - View 2: Smartphone View (`mobile_view.html`)
        """
        forced_view = request.query_params.get("view", "").lower()
        user_agent = request.headers.get("user-agent", "").lower()
        is_mobile = forced_view == "mobile" or any(
            k in user_agent for k in ("iphone", "android", "mobile")
        )
        if is_mobile and forced_view != "desktop":
            return await self.render_mobile_view(request)
        return await self.render_desktop_view(request)

    async def render_desktop_view(self, request: Request):
        """GET /desktop - Renders View 1: Dedicated Desktop Browser View."""
        view_file = FRONTEND_VIEWS_DIR / "desktop_view.html"
        return FileResponse(view_file)

    async def render_mobile_view(self, request: Request):
        """GET /mobile - Renders View 2: Dedicated Smartphone View."""
        view_file = FRONTEND_VIEWS_DIR / "mobile_view.html"
        return FileResponse(view_file)

    async def api_health(self, request: Request) -> JSONResponse:
        return JSONResponse(
            {
                "status": "healthy",
                "version": "1.0.0",
                "architecture": "MVC (Model-View-Controller with Separate Desktop & Smartphone Views)",
                "views": {
                    "desktop_view_url": "/desktop",
                    "smartphone_view_url": "/mobile",
                },
                "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
        )

    async def api_evaluate_property(self, request: Request) -> JSONResponse:
        try:
            lat = float(request.query_params.get("lat", 37.9648))
            lon = float(request.query_params.get("lon", 23.7265))
            radius = float(request.query_params.get("radius", 600))
            rooms = int(request.query_params.get("rooms", 2))
            cost_p = request.query_params.get("acquisition_cost")
            cost = float(cost_p) if cost_p else None
        except ValueError as exc:
            return JSONResponse({"status": "error", "message": str(exc)}, status_code=400)

        data = self.property_model.evaluate(lat, lon, radius, rooms, cost)
        return JSONResponse(data)

    async def api_top_recommendations(self, request: Request) -> JSONResponse:
        rooms_raw = request.query_params.get("rooms", "auto")
        target_rooms = int(rooms_raw) if rooms_raw in ("1", "2", "3") else None
        budget_raw = request.query_params.get("budget")
        max_budget = float(budget_raw) if budget_raw and float(budget_raw) > 0 else None
        strategy = request.query_params.get("strategy", "score")
        radius = float(request.query_params.get("radius", 600))

        data = self.property_model.get_top_recommendations(
            target_rooms=target_rooms,
            max_budget_eur=max_budget,
            strategy=strategy,
            radius_m=radius,
        )
        return JSONResponse(data)

    async def api_neighborhoods_analytics(self, request: Request) -> JSONResponse:
        return JSONResponse(self.neighborhood_model.compute_all())

    async def api_macro_urban_audit(self, request: Request) -> JSONResponse:
        city = request.query_params.get("city", "EL300")
        live = request.query_params.get("live", "true").lower() != "false"
        return JSONResponse(self.eurostat_model.get_urban_audit(city, live))

    async def api_scenarios(self, request: Request) -> JSONResponse:
        if request.method == "GET":
            items = self.scenario_model.list_all()
            return JSONResponse({"status": "success", "count": len(items), "scenarios": items})
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"status": "error", "message": "Invalid JSON"}, status_code=400)
        created = self.scenario_model.create(body)
        return JSONResponse({"status": "created", "scenario": created}, status_code=201)

    async def api_admin_sync(self, request: Request) -> JSONResponse:
        counts = self.store_model.reload()
        return JSONResponse(
            {
                "status": "synchronized",
                "architecture": "MVC",
                "synced_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "datasets_reloaded": counts,
            }
        )

    async def api_gis_layers(self, request: Request) -> JSONResponse:
        return JSONResponse(
            {
                "status": "success",
                "layers": {
                    "airbnb_listings": self.store_model.airbnb,
                    "neighborhoods": self.store_model.neighborhoods,
                    "athens_gis_pois": self.store_model.gis_pois,
                    "athens_gis_hazards": self.store_model.gis_hazards,
                },
            }
        )

    async def api_geocode(self, request: Request) -> JSONResponse:
        import unicodedata
        import requests as req_lib

        def norm_el(s: str) -> str:
            return "".join(
                c for c in unicodedata.normalize("NFD", s.strip().lower())
                if unicodedata.category(c) != "Mn"
            )

        query = request.query_params.get("q", "").strip()
        q = norm_el(query)
        matches = []

        for feat in self.store_model.neighborhoods.get("features", []):
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
                        "type": "Γειτονιά Αθήνας",
                        "lat": c_lat,
                        "lon": c_lon,
                        "source": f"Inside Airbnb ({props.get('total_airbnb_listings', 0)} Airbnb • €{props.get('avg_purchase_price_sqm', 3200)}/m²)",
                    }
                )

        for feat in self.store_model.gis_pois.get("features", []):
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

        if len(matches) < 3 and len(q) >= 3:
            try:
                resp = req_lib.get(
                    "https://geocoding-api.open-meteo.com/v1/search",
                    params={"name": query, "count": 5, "language": "el", "format": "json"},
                    timeout=2.5,
                )
                if resp.status_code == 200:
                    for item in resp.json().get("results", []):
                        if item.get("country_code") == "GR":
                            matches.append(
                                {
                                    "name": f"{item.get('name')} ({item.get('admin2', 'Αττική')})",
                                    "name_en": item.get("name"),
                                    "type": "Τοπωνύμιο",
                                    "lat": item.get("latitude"),
                                    "lon": item.get("longitude"),
                                    "source": "Open-Meteo Geocoding API",
                                }
                            )
            except Exception:
                pass

        return JSONResponse({"status": "success", "query": query, "count": len(matches), "results": matches[:10]})

