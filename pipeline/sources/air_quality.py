"""Air quality via Open-Meteo's free Air Quality API (uses Copernicus CAMS).

We pull PM2.5 and NO2 because they're the two pollutants most strongly linked
to child respiratory illness and school absenteeism in WHO literature.

Uses the same caching + 429-aware retry pattern as climate.py —
see that module for the full rationale.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Dict, List

import requests

from ..config import RAW_DIR
from .climate import RateLimited  # shared so the circuit-breaker logic matches

AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
REQUEST_TIMEOUT = 30

# Per-point cache — shared across countries for the same reason as climate.
_CACHE_DIR = RAW_DIR / "air_quality"


def _cache_path(lat: float, lon: float) -> Path:
    return _CACHE_DIR / f"{lat:.2f}_{lon:.2f}.json"


def _fetch_point(lat: float, lon: float) -> Dict:
    cache = _cache_path(lat, lon)
    if cache.exists():
        try:
            return json.loads(cache.read_text())
        except (json.JSONDecodeError, OSError):
            try:
                cache.unlink()
            except OSError:
                pass

    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": "pm2_5,nitrogen_dioxide",
        "past_days": 30,
        "timezone": "UTC",
    }

    last_err = "no attempts made"
    for attempt in range(3):
        try:
            resp = requests.get(AQ_URL, params=params, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                payload = resp.json()
                _CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps(payload))
                return payload
            if resp.status_code == 429:
                # Same reasoning as climate: 429 is a global condition,
                # surface it as RateLimited so the loop-level circuit
                # breaker pauses sampling once instead of per-point.
                raise RateLimited()
            last_err = f"HTTP {resp.status_code}"
            time.sleep(1 + attempt)
        except requests.RequestException as e:
            last_err = f"{type(e).__name__}: {e}"
            time.sleep(1 + attempt)
    # Non-429 failure. Historical behavior returned an empty dict so the
    # caller's _summarize could fall through cleanly. Preserve that.
    print(f"  [air] fetch failed at {lat},{lon}: {last_err}")
    return {}


def _summarize(hourly: Dict) -> Dict[str, float]:
    pm = [v for v in (hourly.get("pm2_5") or []) if v is not None]
    no2 = [v for v in (hourly.get("nitrogen_dioxide") or []) if v is not None]

    def avg(xs):
        return sum(xs) / len(xs) if xs else 0.0

    pm_avg = avg(pm)
    no2_avg = avg(no2)

    # WHO 2021 guideline PM2.5 annual: 5 µg/m³.
    # Days where 24h rolling mean exceeds 15 µg/m³ (interim target 4).
    pm_exceed_hours = sum(1 for v in pm if v > 15.0)

    return {
        "pm25_avg_ugm3": round(pm_avg, 2),
        "no2_avg_ugm3": round(no2_avg, 2),
        "pm25_exceed_hours_30d": pm_exceed_hours,
    }


def fetch_for_facilities(facilities: List[Dict], sample_stride: int = 5) -> Dict[str, Dict]:
    """Same nearest-neighbor trick as climate.py — sample + fill.

    Progress logged every 50 points; cache hits are counted separately
    and don't incur the polite-pacing sleep.
    """
    if not facilities:
        return {}

    summaries: Dict[str, Dict] = {}
    sampled_points: List[Dict] = []

    to_sample = [(i, f) for i, f in enumerate(facilities) if i % sample_stride == 0]
    total = len(to_sample)
    print(f"  [air] sampling {total} points (stride {sample_stride})", flush=True)

    hits = net = skips = rate_limited = 0
    rl_cooldown_s = 120
    t0 = time.time()
    idx = 0
    queue = list(to_sample)
    while queue:
        i, f = queue.pop(0)
        idx += 1
        cache_hit = _cache_path(f["lat"], f["lon"]).exists()
        try:
            data = _fetch_point(f["lat"], f["lon"])
            summary = _summarize(data.get("hourly") or {})
            summaries[f["id"]] = summary
            sampled_points.append({
                "lat": f["lat"], "lon": f["lon"], "summary": summary,
            })
            if cache_hit:
                hits += 1
            else:
                net += 1
                time.sleep(0.25)
        except RateLimited:
            rate_limited += 1
            queue.insert(0, (i, f))
            idx -= 1
            print(f"  [air] rate limited after {idx} points — pausing {rl_cooldown_s}s, {len(queue)} remaining", flush=True)
            time.sleep(rl_cooldown_s)
            rl_cooldown_s = min(rl_cooldown_s * 2, 600)
        except Exception as e:
            skips += 1
            print(f"  [air] skip {f['id']}: {e}", flush=True)

        if idx % 50 == 0 or idx == total or not queue:
            elapsed = time.time() - t0
            pct = 100 * idx / total
            print(f"  [air] {idx}/{total} ({pct:.0f}%) — cache hits {hits}, network {net}, skips {skips}, rate-limit pauses {rate_limited}, elapsed {elapsed:.0f}s", flush=True)

    if not sampled_points:
        return summaries

    def dist2(a_lat, a_lon, b_lat, b_lon):
        return (a_lat - b_lat) ** 2 + (a_lon - b_lon) ** 2

    for f in facilities:
        if f["id"] in summaries:
            continue
        nearest = min(
            sampled_points,
            key=lambda p: dist2(f["lat"], f["lon"], p["lat"], p["lon"]),
        )
        summaries[f["id"]] = dict(nearest["summary"])

    return summaries
