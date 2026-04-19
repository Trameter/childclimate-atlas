"""Climate hazard layers via Open-Meteo (ERA5 archive + forecast).

Open-Meteo gives us temperature, precipitation, and derived climatology
for any lat/lon on Earth, free, no API key. We pull a compact summary
for each facility's coordinates.

Variables we care about:
  - heat_index_days: days/year with apparent temperature >= 35°C
  - heavy_precip_days: days/year with precip >= 50mm (flash flood proxy)
  - drought_pdsi_proxy: rolling dry-day streak as a coarse drought proxy
"""
from __future__ import annotations

import json
import time
from typing import Dict, List

import requests

OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
REQUEST_TIMEOUT = 20

# Use a recent full year so we have complete data.
START_DATE = "2024-01-01"
END_DATE = "2024-12-31"


def _fetch_point(lat: float, lon: float) -> Dict[str, float]:
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": START_DATE,
        "end_date": END_DATE,
        "daily": ",".join([
            "temperature_2m_max",
            "apparent_temperature_max",
            "precipitation_sum",
        ]),
        "timezone": "UTC",
    }
    for attempt in range(3):
        try:
            resp = requests.get(OPEN_METEO_ARCHIVE, params=params, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                return resp.json()
            time.sleep(1 + attempt)
        except requests.RequestException:
            time.sleep(1 + attempt)
    raise RuntimeError(f"Open-Meteo failed at {lat},{lon}")


def _summarize(daily: Dict) -> Dict[str, float]:
    """Compute our summary metrics from daily arrays."""
    app_tmax = daily.get("apparent_temperature_max") or []
    precip = daily.get("precipitation_sum") or []

    heat_index_days = sum(1 for t in app_tmax if t is not None and t >= 35.0)
    heavy_precip_days = sum(1 for p in precip if p is not None and p >= 50.0)

    # Drought proxy: longest run of days with precip < 1mm.
    longest_dry_run, current_run = 0, 0
    for p in precip:
        if p is None or p < 1.0:
            current_run += 1
            longest_dry_run = max(longest_dry_run, current_run)
        else:
            current_run = 0

    return {
        "heat_index_days": heat_index_days,
        "heavy_precip_days": heavy_precip_days,
        "longest_dry_run_days": longest_dry_run,
    }


def fetch_for_facilities(facilities: List[Dict], sample_stride: int = 5) -> Dict[str, Dict]:
    """Return {facility_id: climate_summary} for a list of facilities.

    To keep the prototype fast, we sample every `sample_stride`-th facility and
    interpolate the rest by nearest-neighbor (climate varies slowly over short
    distances so this is a reasonable approximation at prototype scale).
    """
    if not facilities:
        return {}

    summaries: Dict[str, Dict] = {}
    sampled_points: List[Dict] = []

    for i, f in enumerate(facilities):
        if i % sample_stride == 0:
            try:
                data = _fetch_point(f["lat"], f["lon"])
                summary = _summarize(data.get("daily") or {})
                summaries[f["id"]] = summary
                sampled_points.append({
                    "lat": f["lat"], "lon": f["lon"], "summary": summary,
                })
                # polite to the free API
                time.sleep(0.25)
            except Exception as e:
                print(f"  [climate] skip {f['id']}: {e}")

    # Nearest-neighbor fill for the rest
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
