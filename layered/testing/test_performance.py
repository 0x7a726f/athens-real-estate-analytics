#!/usr/bin/env python3
"""
Performance Benchmark Suite - Layered Architecture (`layered/testing/test_performance.py`)
Measures execution latency (mean, p50, p95, p99 in milliseconds) and throughput (ops/sec)
for spatial micro-location evaluation (across 44 polygons + 345 Airbnb points + 28 GIS POIs)
and city-wide neighborhood saturation calculation.
"""

import statistics
import sys
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from data_access import DataRepository  # noqa: E402
from spatial_service import SpatialAnalyticsService  # noqa: E402


def run_performance_benchmark(iterations: int = 200) -> None:
    print(f"=== [LAYERED] PERFORMANCE BENCHMARK ({iterations} iterations) ===")
    repo = DataRepository()
    service = SpatialAnalyticsService(repo)

    coords = [
        (37.9648, 23.7265),  # Koukaki
        (37.9722, 23.7305),  # Plaka
        (37.9862, 23.7368),  # Exarcheia
        (38.0012, 23.7385),  # Kypseli
        (37.9675, 23.7445),  # Pangrati
    ]

    latencies_ms = []
    t_start = time.perf_counter()
    for i in range(iterations):
        lat, lon = coords[i % len(coords)]
        t0 = time.perf_counter()
        service.evaluate_property(lat=lat, lon=lon, radius_m=600, rooms=2)
        latencies_ms.append((time.perf_counter() - t0) * 1000.0)
    total_sec = time.perf_counter() - t_start

    latencies_ms.sort()
    mean_ms = statistics.mean(latencies_ms)
    p50_ms = latencies_ms[int(0.50 * iterations)]
    p95_ms = latencies_ms[int(0.95 * iterations)]
    p99_ms = latencies_ms[int(0.99 * iterations)]
    ops_per_sec = iterations / max(1e-6, total_sec)

    print(f"  Mean Latency : {mean_ms:.3f} ms")
    print(f"  p50 Latency  : {p50_ms:.3f} ms")
    print(f"  p95 Latency  : {p95_ms:.3f} ms")
    print(f"  p99 Latency  : {p99_ms:.3f} ms")
    print(f"  Throughput   : {ops_per_sec:,.1f} evaluations/sec")

    assert p95_ms < 50.0, f"p95 latency exceeded 50ms threshold: {p95_ms:.2f}ms"
    print("[PASS] Performance SLA verified (p95 < 50ms)\n")


if __name__ == "__main__":
    run_performance_benchmark()
