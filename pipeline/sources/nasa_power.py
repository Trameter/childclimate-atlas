"""NASA POWER — alternative climate-history source for when Open-Meteo blocks us.

POWER (Prediction Of Worldwide Energy Resources) is NASA's free climate data
API, derived from MERRA-2 reanalysis. Same kind of data as Open-Meteo's ERA5
archive (daily temperature, precipitation, humidity) at a comparable
resolution (~0.5° vs ERA5's 0.25°). No registration, no rate-limit fight
with our other countries' fetches.

Mirrors pipeline.sources.climate's public interface — fetch_for_facilities()
returns the same `{facility_id: {heat_index_days, heavy_precip_days,
longest_dry_run_days}}` shape — so the rest of the pipeline doesn't care
which source produced it.

Key methodological differences vs climate.py / Open-Meteo:
  1. POWER doesn't have a direct apparent_temperature_max. We compute it
     ourselves via the NOAA Rothfusz heat-index formula from T2M_MAX + RH2M
     (mean RH, since POWER doesn't expose daily-max RH).
  2. POWER uses -999 as sentinel for missing values; we filter those out.
  3. Date format is YYYYMMDD (no dashes), unlike Open-Meteo's YYYY-MM-DD.

Use via build CLI flag: `--climate-source nasa-power`.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Dict, List

import requests

from ..config import RAW_DIR
from .climate import RateLimited, DailyQuotaExhausted  # share the circuit-breaker types

POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
START_DATE = "20240101"
END_DATE = "20241231"
PARAMETERS = "T2M_MAX,RH2M,PRECTOTCORR"
COMMUNITY = "AG"
REQUEST_TIMEOUT = 60

# Separate cache directory from Open-Meteo's so each provider's payload
# stays isolated (different response shapes; one re-parser would have to
# branch on provider). Reads of the OTHER provider's cache for
# nearest-neighbor fallback are handled at the summary-level (both
# providers produce the same summary shape).
_CACHE_DIR = RAW_DIR / "climate_power"
USER_AGENT = "ChildClimate-Atlas/0.6 (https://climate-atlas.trameter.com)"


def _cache_path(lat: float, lon: float) -> Path:
    return _CACHE_DIR / f"{lat:.2f}_{lon:.2f}.json"


# ---- heat-index computation (NOAA Rothfusz formula) ----

def _heat_index_celsius(t_c: float, rh: float) -> float:
    """Apparent temperature in Celsius from air temp (°C) and RH (%).

    Uses the NOAA Rothfusz polynomial regression for T >= 80°F (26.7°C),
    falling back to the simpler linear blend for cooler conditions.
    Source: https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
    """
    if t_c is None or rh is None:
        return None
    t_f = t_c * 9.0 / 5.0 + 32.0
    if t_f < 80.0:
        # Simple linear blend (used by NWS for T < 80°F).
        hi_f = 0.5 * (t_f + 61.0 + ((t_f - 68.0) * 1.2) + (rh * 0.094))
    else:
        # Rothfusz regression — the canonical heat-index formula.
        hi_f = (-42.379 + 2.04901523 * t_f + 10.14333127 * rh
                - 0.22475541 * t_f * rh - 0.00683783 * t_f * t_f
                - 0.05481717 * rh * rh + 0.00122874 * t_f * t_f * rh
                + 0.00085282 * t_f * rh * rh
                - 0.00000199 * t_f * t_f * rh * rh)
        # Rothfusz adjustment for low-humidity hot conditions.
        if rh < 13 and 80 <= t_f <= 112:
            adj = ((13 - rh) / 4.0) * math.sqrt((17 - abs(t_f - 95)) / 17.0)
            hi_f -= adj
        # Adjustment for high-humidity warm conditions.
        elif rh > 85 and 80 <= t_f <= 87:
            adj = ((rh - 85) / 10.0) * ((87 - t_f) / 5.0)
            hi_f += adj
    return (hi_f - 32.0) * 5.0 / 9.0


def _fetch_point(lat: float, lon: float) -> Dict:
    """Fetch full-year daily data for one point, with disk cache + retry."""
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
        "start": START_DATE,
        "end": END_DATE,
        "latitude": lat,
        "longitude": lon,
        "community": COMMUNITY,
        "parameters": PARAMETERS,
        "format": "JSON",
    }
    headers = {"User-Agent": USER_AGENT}

    last_err = "no attempts made"
    for attempt in range(3):
        try:
            resp = requests.get(POWER_URL, params=params, headers=headers,
                                timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                payload = resp.json()
                # POWER returns 200 with an error message body for bad
                # params. Sanity-check that the expected structure exists.
                if not (payload.get("properties") or {}).get("parameter"):
                    last_err = f"POWER bad payload: {payload.get('messages')}"
                    time.sleep(1 + attempt)
                    continue
                _CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps(payload))
                return payload
            if resp.status_code == 429:
                # POWER's rate limit is generous (~30 req/min); treat like
                # Open-Meteo's burst limit — pause once, drain the queue.
                raise RateLimited()
            last_err = f"HTTP {resp.status_code}"
            time.sleep(2 + attempt)
        except requests.RequestException as e:
            last_err = f"{type(e).__name__}: {e}"
            time.sleep(2 + attempt)
    raise RuntimeError(f"NASA POWER failed at {lat},{lon}: {last_err}")


def _summarize(properties: Dict) -> Dict[str, float]:
    """Compute our 3 summary metrics from a POWER response's daily series.

    Same output shape as pipeline.sources.climate._summarize() so the
    downstream scoring code is provider-agnostic.
    """
    parameter = (properties or {}).get("parameter") or {}
    t_max = parameter.get("T2M_MAX") or {}
    rh = parameter.get("RH2M") or {}
    precip = parameter.get("PRECTOTCORR") or {}

    # Heat-index days: count where computed apparent_temp >= 35°C.
    # POWER uses -999 as missing-value sentinel.
    heat_index_days = 0
    for date_str, t_c in t_max.items():
        if t_c is None or t_c == -999.0:
            continue
        rh_v = rh.get(date_str)
        if rh_v is None or rh_v == -999.0:
            continue
        apparent = _heat_index_celsius(t_c, rh_v)
        if apparent is not None and apparent >= 35.0:
            heat_index_days += 1

    # Heavy precip: days with precip >= 50mm (matches climate.py threshold).
    heavy_precip_days = sum(
        1 for p in precip.values()
        if p is not None and p != -999.0 and p >= 50.0
    )

    # Longest dry run: consecutive days with precip < 1mm. Iterate by sorted
    # date to ensure monotonic ordering (POWER returns dict-keyed YYYYMMDD).
    longest_dry = current = 0
    for date_str in sorted(precip.keys()):
        p = precip[date_str]
        if p is None or p == -999.0 or p < 1.0:
            current += 1
            longest_dry = max(longest_dry, current)
        else:
            current = 0

    return {
        "heat_index_days": heat_index_days,
        "heavy_precip_days": heavy_precip_days,
        "longest_dry_run_days": longest_dry,
    }


def fetch_for_facilities(facilities: List[Dict], sample_stride: int = 100) -> Dict[str, Dict]:
    """Drop-in replacement for pipeline.sources.climate.fetch_for_facilities.

    Same sampling + nearest-neighbor-fill strategy. POWER's free tier is
    generous so we don't need the daily-quota detection layer.
    """
    if not facilities:
        return {}

    # Stable sort matches climate.py behavior — same sample points across
    # rebuilds, so scores are reproducible.
    facilities = sorted(facilities, key=lambda f: f["id"])

    summaries: Dict[str, Dict] = {}
    sampled_points: List[Dict] = []

    to_sample = [(i, f) for i, f in enumerate(facilities) if i % sample_stride == 0]
    total = len(to_sample)
    print(f"  [climate/POWER] sampling {total} points (stride {sample_stride})", flush=True)

    hits = net = skips = rate_limited = 0
    rl_cooldown_s = 60
    t0 = time.time()
    idx = 0
    queue = list(to_sample)
    while queue:
        i, f = queue.pop(0)
        idx += 1
        cache_hit = _cache_path(f["lat"], f["lon"]).exists()
        try:
            payload = _fetch_point(f["lat"], f["lon"])
            summary = _summarize(payload.get("properties") or {})
            summaries[f["id"]] = summary
            sampled_points.append({"lat": f["lat"], "lon": f["lon"], "summary": summary})
            if cache_hit:
                hits += 1
            else:
                net += 1
                time.sleep(0.2)  # polite pacing on real network calls
        except RateLimited:
            rate_limited += 1
            queue.insert(0, (i, f))
            idx -= 1
            print(f"  [climate/POWER] rate limited after {idx} points — pausing {rl_cooldown_s}s, {len(queue)} remaining", flush=True)
            time.sleep(rl_cooldown_s)
            rl_cooldown_s = min(rl_cooldown_s * 2, 300)
        except Exception as e:
            skips += 1
            print(f"  [climate/POWER] skip {f['id']}: {e}", flush=True)

        if idx % 50 == 0 or idx == total or not queue:
            elapsed = time.time() - t0
            pct = 100 * idx / max(total, 1)
            print(f"  [climate/POWER] {idx}/{total} ({pct:.0f}%) — cache hits {hits}, network {net}, skips {skips}, rate-limit pauses {rate_limited}, elapsed {elapsed:.0f}s", flush=True)

    # Try-cache-first fill for non-sampled facilities (their OWN location).
    own_cache_hits = 0
    for f in facilities:
        if f["id"] in summaries:
            continue
        cp = _cache_path(f["lat"], f["lon"])
        if cp.exists():
            try:
                summaries[f["id"]] = _summarize((json.loads(cp.read_text()).get("properties")) or {})
                own_cache_hits += 1
            except (json.JSONDecodeError, OSError):
                pass
    if own_cache_hits:
        print(f"  [climate/POWER] reused own-location cache for {own_cache_hits} additional facilities", flush=True)

    # Nearest-neighbor fill from the full disk cache (POWER's own dir).
    # Note: cross-source NN (using Open-Meteo cache points) is NOT done —
    # the apparent-temperature methodology is different enough that mixing
    # would introduce systematic bias. If POWER cache is sparse we
    # tolerate that and ship the best available.
    cache_points = list(sampled_points)
    cache_seen = {(round(p["lat"], 2), round(p["lon"], 2)) for p in cache_points}
    if _CACHE_DIR.exists():
        for cache_file in _CACHE_DIR.glob("*.json"):
            stem = cache_file.stem
            try:
                lat_str, lon_str = stem.rsplit("_", 1)
                lat_v, lon_v = float(lat_str), float(lon_str)
            except (ValueError, IndexError):
                continue
            key = (round(lat_v, 2), round(lon_v, 2))
            if key in cache_seen:
                continue
            try:
                payload = json.loads(cache_file.read_text())
                summary = _summarize(payload.get("properties") or {})
                cache_points.append({"lat": lat_v, "lon": lon_v, "summary": summary})
                cache_seen.add(key)
            except (json.JSONDecodeError, OSError):
                continue
    print(f"  [climate/POWER] nearest-neighbor pool: {len(cache_points)} cached points", flush=True)

    if not cache_points:
        return summaries

    def dist2(a_lat, a_lon, b_lat, b_lon):
        return (a_lat - b_lat) ** 2 + (a_lon - b_lon) ** 2

    for f in facilities:
        if f["id"] in summaries:
            continue
        nearest = min(
            cache_points,
            key=lambda p: dist2(f["lat"], f["lon"], p["lat"], p["lon"]),
        )
        summaries[f["id"]] = dict(nearest["summary"])

    return summaries
