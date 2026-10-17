#!/usr/bin/env python3
"""
Complete Test Suite for MVC Architecture (`mvc/testing/test_mvc_suite.py`)
Includes:
  1. MVC API & View Functional Tests (Desktop View `/desktop`, Smartphone View `/mobile`, REST `/api/v1/*`)
  2. MVC CLI Parser & Execution Tests
  3. MVC Performance Benchmark Tests
"""

import asyncio
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Dict, Tuple
from urllib.parse import urlsplit

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

MVC_BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(MVC_BACKEND_DIR))

from app import app, controller  # noqa: E402


async def asgi_request(
    asgi_app: Any,
    method: str,
    path: str,
    body_dict: Dict[str, Any] | None = None,
    headers: Dict[str, str] | None = None,
) -> Tuple[int, str, Any]:
    parsed = urlsplit(path)
    raw_body = json.dumps(body_dict).encode("utf-8") if body_dict is not None else b""
    req_headers = [(b"host", b"127.0.0.1:8001")]
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
        "query_string": parsed.query.encode("utf-8"),
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


async def run_mvc_tests() -> None:
    print("=== [MVC] FUNCTIONAL, VIEW & PERFORMANCE TEST SUITE ===")

    # 1. Test View 1: Desktop Browser View (/desktop)
    status, text_desktop, _ = await asgi_request(app, "GET", "/desktop")
    assert status == 200
    assert "View 1: Desktop Browser View" in text_desktop
    print("[PASS] 1. MVC View 1 (/desktop) rendered successfully")

    # 2. Test View 2: Smartphone View (/mobile)
    status, text_mobile, _ = await asgi_request(app, "GET", "/mobile")
    assert status == 200
    assert "View 2: Smartphone" in text_mobile
    print("[PASS] 2. MVC View 2 (/mobile) rendered successfully")

    # 3. Test User-Agent View Dispatching on `/`
    status, text_ua, _ = await asgi_request(
        app, "GET", "/", headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"}
    )
    assert status == 200
    assert "View 2: Smartphone" in text_ua
    print("[PASS] 3. MVC Controller User-Agent auto-routing verified")

    # 4. Test MVC REST API Property Evaluation
    status, _, ev = await asgi_request(
        app, "GET", "/api/v1/properties/evaluate?lat=37.9648&lon=23.7265&radius=600&rooms=2"
    )
    assert status == 200
    assert ev["architecture"] == "MVC (Model-View-Controller)"
    assert ev["investment_rating"]["score"] >= 70.0
    print(f"[PASS] 4. MVC Controller `/api/v1/properties/evaluate` -> Score={ev['investment_rating']['score']}")

    # 5. Test MVC Neighborhoods Analytics (44 Real Athens Neighborhoods)
    status, _, nb = await asgi_request(app, "GET", "/api/v1/neighborhoods/analytics")
    assert status == 200
    assert nb["total_neighborhoods"] >= 40
    print(f"[PASS] 5. MVC Controller `/api/v1/neighborhoods/analytics` -> {nb['total_neighborhoods']} neighborhoods")

    # 6. Test MVC Top Investment Optimizer (`/api/v1/properties/top-recommendations`)
    status, _, top_rec = await asgi_request(
        app, "GET", "/api/v1/properties/top-recommendations?strategy=score&rooms=auto&budget=0"
    )
    assert status == 200
    assert top_rec["top_overall_pick"] is not None
    top_pick = top_rec["top_overall_pick"]
    print(
        f"[PASS] 6. MVC Controller `/api/v1/properties/top-recommendations` -> "
        f"#1 {top_pick['neighbourhood']} ({top_pick['best_room_label']}) Score={top_pick['investment_score']}"
    )

    # 7. Test MVC Performance Benchmark (100 evaluations)
    latencies = []
    for _ in range(100):
        t0 = time.perf_counter()
        controller.property_model.evaluate(37.9648, 23.7265, 600, 2)
        latencies.append((time.perf_counter() - t0) * 1000.0)
    p95 = sorted(latencies)[95]
    assert p95 < 50.0
    print(f"[PASS] 7. MVC Model Performance Benchmark -> Mean={statistics.mean(latencies):.2f}ms, p95={p95:.2f}ms")
    # 8. Test MVC Sea / Out-of-Zone Coordinate & Zero-Discrepancy Audit
    status, _, sea_ev = await asgi_request(
        app, "GET", "/api/v1/properties/evaluate?lat=37.8900&lon=23.6700&radius=600&rooms=2"
    )
    assert status == 200
    assert sea_ev["location_context"]["is_out_of_zone"] is True
    assert sea_ev["investment_rating"]["score"] == 0.0
    assert sea_ev["investment_rating"]["breakdown"]["macro_resilience_score"] == 0.0
    assert sea_ev["airbnb_roi_metrics"]["estimated_annual_gross_revenue_eur"] == 0.0
    print("[PASS] 8. MVC Controller `/api/v1/properties/evaluate` (Saronic Sea) -> Score=0.0, Agora=0.0/15")
    print("=== ALL 8 MVC TESTS PASSED SUCCESSFULLY ===\n")


if __name__ == "__main__":
    asyncio.run(run_mvc_tests())
