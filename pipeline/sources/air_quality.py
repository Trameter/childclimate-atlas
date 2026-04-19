"""Air quality via Open-Meteo's free Air Quality API (uses Copernicus CAMS).

We pull PM2.5 and NO2 because they're the two pollutants most strongly linked
to child respiratory illness and school absenteeism in WHO literature.
"""
from __future__ import annotations

import time
from typing import Dict, List

import requests

AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
REQUEST_TIMEOUT = 20


def _fetch_point(lat: float, lon: float) -> Dict:
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": "pm2_5,nitrogen_dioxide",
        "past_days": 30,
        "timezone": "UTC",
    }
    for attempt in range(3):
        try:
            resp = requests.get(AQ_URL, params=params, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                return resp.json()
            time.sleep(1 + attempt)
        except requests.RequestException:
            time.sleep(1 + attempt)
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
    """Same nearest-neighbor trick as climate.py — sample + fill."""
    if not facilities:
        return {}

    summaries: Dict[str, Dict] = {}
    sampled_points: List[Dict] = []

    for i, f in enumerate(facilities):
        if i % sample_stride == 0:
            try:
                data = _fetch_point(f["lat"], f["lon"])
                summary = _summarize(data.get("hourly") or {})
                summaries[f["id"]] = summary
                sampled_points.append({
                    "lat": f["lat"], "lon": f["lon"], "summary": summary,
                })
                time.sleep(0.25)
            except Exception as e:
                print(f"  [air] skip {f['id']}: {e}")

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
