"""Climate hazard layers via Open-Meteo (ERA5 archive + forecast).

Open-Meteo gives us temperature, precipitation, and derived climatology
for any lat/lon on Earth, free, no API key. We pull a compact summary
for each facility's coordinates.

Variables we care about:
  - heat_index_days: days/year with apparent temperature >= 35°C
  - heavy_precip_days: days/year with precip >= 50mm (flash flood proxy)
  - drought_pdsi_proxy: rolling dry-day streak as a coarse drought proxy

Rate-limit + caching notes
--------------------------
Open-Meteo's free tier rate-limits at ~600 calls / rolling hour and
10,000 / day per IP. We do two things to cope at scale:

1. Per-point disk cache keyed by rounded (lat, lon). Climate varies on
   kilometre scales, so a 2-decimal-place key (~1 km precision) is a
   reasonable resolution for ERA5 re-analysis data. Once fetched, a
   (lat, lon) pair never re-hits the network — subsequent country
   rebuilds, retries after a failure, and multi-country runs all benefit.
   Cache lives at ``data/raw/climate/`` so it's shared across countries.

2. 429-aware retry. Before this, a burst of 429s meant 1-2-3s short
   backoffs that all failed, wasting ~6s per point on pointless retries
   while the rate-limit window had to decay. Now a 429 triggers a 60s
   cooldown sleep + one retry, which matches Open-Meteo's recovery
   cadence. Genuinely unrecoverable responses bubble up as a RuntimeError
   that the caller handles with a ``skip`` log line.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Dict, List

import requests

from ..config import RAW_DIR

OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
REQUEST_TIMEOUT = 30

# Use a recent full year so we have complete data.
START_DATE = "2024-01-01"
END_DATE = "2024-12-31"

# Per-point cache — shared across countries because climate data is
# location-keyed, not country-keyed. One (lat, lon) maps to one ERA5
# re-analysis summary regardless of which country's rebuild triggered it.
_CACHE_DIR = RAW_DIR / "climate"


def _cache_path(lat: float, lon: float) -> Path:
    """Stable file path for a (lat, lon) at 2-decimal (~1km) precision."""
    return _CACHE_DIR / f"{lat:.2f}_{lon:.2f}.json"


class RateLimited(Exception):
    """Open-Meteo returned 429. Signals the caller to pause sampling
    rather than retry this individual point — rate limits are global."""
    pass


def _fetch_point(lat: float, lon: float) -> Dict:
    """Fetch raw Open-Meteo archive response for one point, with cache + 429 retry.

    Returns the raw API JSON. Raises RuntimeError if all retries exhaust.
    """
    cache = _cache_path(lat, lon)
    if cache.exists():
        try:
            return json.loads(cache.read_text())
        except (json.JSONDecodeError, OSError):
            # Corrupted cache — re-fetch.
            try:
                cache.unlink()
            except OSError:
                pass

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

    last_err: str = "no attempts made"
    for attempt in range(3):
        try:
            resp = requests.get(OPEN_METEO_ARCHIVE, params=params, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                payload = resp.json()
                _CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps(payload))
                return payload
            if resp.status_code == 429:
                # Rate-limited. Don't retry within this point — the limit
                # is a global (per-IP, rolling-hour) condition, not a
                # per-request condition. Looping here just burns minutes
                # per point when the caller could instead pause the
                # whole sampling loop once and cover all points.
                # fetch_for_facilities has the circuit-breaker logic.
                raise RateLimited()
            last_err = f"HTTP {resp.status_code}"
            time.sleep(1 + attempt)
        except requests.RequestException as e:
            last_err = f"{type(e).__name__}: {e}"
            time.sleep(1 + attempt)
    raise RuntimeError(f"Open-Meteo failed at {lat},{lon}: {last_err}")


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

    Progress is logged every 50 fetches so long runs aren't opaque.
    Cache hits are also counted — they dominate on re-runs and need no
    polite-pacing sleep.
    """
    if not facilities:
        return {}

    summaries: Dict[str, Dict] = {}
    sampled_points: List[Dict] = []

    to_sample = [(i, f) for i, f in enumerate(facilities) if i % sample_stride == 0]
    total = len(to_sample)
    print(f"  [climate] sampling {total} points (stride {sample_stride})", flush=True)

    hits = net = skips = rate_limited = 0
    rl_cooldown_s = 120  # first cooldown; doubles on repeat to cap at 10 min
    t0 = time.time()
    idx = 0
    queue = list(to_sample)
    while queue:
        i, f = queue.pop(0)
        idx += 1
        cache_hit = _cache_path(f["lat"], f["lon"]).exists()
        try:
            data = _fetch_point(f["lat"], f["lon"])
            summary = _summarize(data.get("daily") or {})
            summaries[f["id"]] = summary
            sampled_points.append({
                "lat": f["lat"], "lon": f["lon"], "summary": summary,
            })
            if cache_hit:
                hits += 1
            else:
                net += 1
                # Polite pacing only on real network calls.
                time.sleep(0.25)
        except RateLimited:
            # Global endpoint cooldown. Re-queue this point for retry
            # after the pause, then sleep — one cooldown covers all
            # subsequent points instead of each burning 120s individually.
            rate_limited += 1
            queue.insert(0, (i, f))
            idx -= 1
            print(f"  [climate] rate limited after {idx} points — pausing {rl_cooldown_s}s, {len(queue)} remaining", flush=True)
            time.sleep(rl_cooldown_s)
            rl_cooldown_s = min(rl_cooldown_s * 2, 600)
        except Exception as e:
            skips += 1
            print(f"  [climate] skip {f['id']}: {e}", flush=True)

        if idx % 50 == 0 or idx == total or not queue:
            elapsed = time.time() - t0
            pct = 100 * idx / total
            print(f"  [climate] {idx}/{total} ({pct:.0f}%) — cache hits {hits}, network {net}, skips {skips}, rate-limit pauses {rate_limited}, elapsed {elapsed:.0f}s", flush=True)

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
