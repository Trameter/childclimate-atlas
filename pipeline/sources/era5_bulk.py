"""ERA5 bulk climate cache — local NetCDF lookup, no API hits.

Reads daily-aggregated ERA5 NetCDF files (downloaded once via
scripts/download_era5_2025.py from Copernicus CDS) and computes per-
facility climate summaries via nearest-grid-cell lookup.

Drop-in replacement for the per-point API path in climate.py when the
bulk files are present on disk — same summary shape so downstream
scoring code is unchanged.

File layout expected (from the download script):
    data/raw/era5_2025/era5_2025_t2m_max.nc        # 2m_temperature daily_maximum, K
    data/raw/era5_2025/era5_2025_d2m_mean.nc       # 2m_dewpoint_temperature daily_mean, K
    data/raw/era5_2025/era5_2025_tp_sum.nc         # total_precipitation daily_sum, m

ALSO supported as fallback / bonus:
    data/raw/era5_2024/era5_2024_t2m_max.nc        # if you grabbed the Request 1 file from CDS

Methodology:
  - Heat index computed from T + RH (RH derived from T + dewpoint via
    Magnus-Tetens), then NOAA Rothfusz formula. Mirrors Open-Meteo's
    apparent_temperature_max output so heat_index_days threshold (35°C)
    means the same thing.
  - Heavy precip days, longest dry run: identical thresholds to climate.py.
"""
from __future__ import annotations

import time
from typing import Dict, List, Optional, Tuple

import numpy as np

try:
    import xarray as xr
    _XARRAY_AVAILABLE = True
except ImportError:
    _XARRAY_AVAILABLE = False

from ..config import RAW_DIR

# Years we look for. We load ALL years that have a complete file set
# (t2m_max + d2m_mean + tp_sum) and average summary stats across them
# at facility-summarize time. Multi-year averaging dampens single-year
# climate variability — e.g. 2025's La Niña understated drought in the
# tropical Pacific countries, and a 2024+2025 average is more
# representative of the chronic exposure children actually face.
#
# A facility's summary becomes the mean of per-year counts (heat days,
# heavy-precip days) and the mean of per-year longest-dry-runs. Years
# missing any of the 3 variables are skipped entirely (no half-year
# blending into the average).
ERA5_YEARS_TO_TRY = [2024, 2025]

# Threshold constants.
#
# HEAT_INDEX_THRESHOLD_C = 30 (NOT 35) because we compute INDOOR heat
# index from T_2m + dewpoint via NOAA Rothfusz — no solar-radiation term.
# Open-Meteo's apparent_temperature_max DOES include solar radiation, so
# the same atmospheric conditions read 5-10°C higher in their outdoor
# "feels like in the sun" formulation. Setting our threshold at 30°C
# indoor heat index ≈ Open-Meteo's 35°C outdoor apparent temp, and is
# arguably more relevant for child welfare (kids spend most of the day
# in classrooms, not direct sun).
HEAT_INDEX_THRESHOLD_C = 30.0
HEAVY_PRECIP_THRESHOLD_MM = 50.0
DRY_DAY_THRESHOLD_MM = 1.0


def _rh_from_t_dewpoint(t_c, td_c):
    """Magnus-Tetens approximation of RH from T + dewpoint, both in °C.
    Returns RH in %. Operates on numpy arrays or scalars."""
    a, b = 17.625, 243.04
    # Saturation vapor pressure ratio = e_t / e_s
    e_s = np.exp((a * t_c) / (b + t_c))
    e_t = np.exp((a * td_c) / (b + td_c))
    return 100.0 * e_t / e_s


def _heat_index_c(t_c, rh):
    """NOAA Rothfusz heat index. Input T in °C, RH in %. Output in °C.

    The Rothfusz formula is valid for T_f >= 80°F (~27°C). Below that we
    use the simpler linear approximation. Both produce results in °F
    internally, then we convert back to °C for our scoring threshold.
    """
    t_f = t_c * 9.0 / 5.0 + 32.0
    hi_simple = 0.5 * (t_f + 61.0 + ((t_f - 68.0) * 1.2) + (rh * 0.094))
    hi_full = (
        -42.379
        + 2.04901523 * t_f
        + 10.14333127 * rh
        - 0.22475541 * t_f * rh
        - 0.00683783 * t_f * t_f
        - 0.05481717 * rh * rh
        + 0.00122874 * t_f * t_f * rh
        + 0.00085282 * t_f * rh * rh
        - 0.00000199 * t_f * t_f * rh * rh
    )
    hi_f = np.where(t_f < 80.0, hi_simple, hi_full)
    return (hi_f - 32.0) * 5.0 / 9.0


def _longest_run_below(values, threshold):
    """Longest run of consecutive entries strictly below threshold."""
    longest = current = 0
    for v in values:
        if v < threshold:
            current += 1
            if current > longest:
                longest = current
        else:
            current = 0
    return longest


class _ERA5YearData:
    """One year's worth of T_max + dewpoint_mean + precipitation_sum
    arrays, eager-loaded into numpy for fast per-facility indexing."""

    def __init__(self, year: int, t_max_arr, d_mean_arr, tp_sum_arr,
                 lats, lons, lon_is_0_360: bool):
        self.year = year
        self.t_max_arr = t_max_arr      # shape (time, lat, lon), Kelvin
        self.d_mean_arr = d_mean_arr    # Kelvin
        self.tp_sum_arr = tp_sum_arr    # meters
        self.lats = lats
        self.lons = lons
        self.lon_is_0_360 = lon_is_0_360

    def nearest(self, lat: float, lon: float) -> Tuple[int, int]:
        if self.lon_is_0_360 and lon < 0:
            lon = lon + 360.0
        return (int(np.abs(self.lats - lat).argmin()),
                int(np.abs(self.lons - lon).argmin()))

    def summary_for_point(self, lat: float, lon: float) -> Optional[Dict[str, int]]:
        """Per-year per-cell summary in the same shape as climate.py's
        _summarize. Returns None if the cell has no valid days (rare —
        only for pure-ocean cells at very high latitudes)."""
        i, j = self.nearest(lat, lon)
        t_K = self.t_max_arr[:, i, j]
        d_K = self.d_mean_arr[:, i, j]
        tp_m = self.tp_sum_arr[:, i, j]
        valid = ~(np.isnan(t_K) | np.isnan(d_K) | np.isnan(tp_m))
        t_K, d_K, tp_m = t_K[valid], d_K[valid], tp_m[valid]
        if t_K.size == 0:
            return None
        t_c = t_K - 273.15
        d_c = d_K - 273.15
        tp_mm = tp_m * 1000.0
        rh = _rh_from_t_dewpoint(t_c, d_c)
        apparent_c = _heat_index_c(t_c, rh)
        return {
            "heat_index_days": int(np.sum(apparent_c >= HEAT_INDEX_THRESHOLD_C)),
            "heavy_precip_days": int(np.sum(tp_mm >= HEAVY_PRECIP_THRESHOLD_MM)),
            "longest_dry_run_days": int(_longest_run_below(tp_mm, DRY_DAY_THRESHOLD_MM)),
        }


class _ERA5Cache:
    """Lazy-loaded singleton — opens NetCDFs for ALL years that have a
    complete file set (t2m_max + d2m_mean + tp_sum), then averages summary
    stats across years when summarizing a facility. Multi-year averaging
    dampens single-year climate variability (La Niña, El Niño, one-off
    heatwaves) and produces a more representative chronic-exposure score
    than any single year."""

    def __init__(self):
        self._loaded = False
        self.years: List[_ERA5YearData] = []

    def load(self) -> bool:
        if self._loaded:
            return True
        if not _XARRAY_AVAILABLE:
            return False
        for year in ERA5_YEARS_TO_TRY:
            d = RAW_DIR / f"era5_{year}"
            paths = {
                "t_max": d / f"era5_{year}_t2m_max.nc",
                "d_mean": d / f"era5_{year}_d2m_mean.nc",
                "tp_sum": d / f"era5_{year}_tp_sum.nc",
            }
            if not all(p.exists() for p in paths.values()):
                continue
            t0 = time.time()
            print(f"  [era5] loading {year} cache: "
                  f"{sum(p.stat().st_size for p in paths.values()) / 1024**2:.0f} MB total", flush=True)
            t_ds = xr.open_dataset(paths["t_max"])
            d_ds = xr.open_dataset(paths["d_mean"])
            tp_ds = xr.open_dataset(paths["tp_sum"])
            t_var = list(t_ds.data_vars)[0]
            d_var = list(d_ds.data_vars)[0]
            tp_var = list(tp_ds.data_vars)[0]
            t_arr = t_ds[t_var].values
            d_arr = d_ds[d_var].values
            tp_arr = tp_ds[tp_var].values
            lat_name = "latitude" if "latitude" in t_ds.coords else "lat"
            lon_name = "longitude" if "longitude" in t_ds.coords else "lon"
            lats = t_ds[lat_name].values
            lons = t_ds[lon_name].values
            lon_is_0_360 = (lons.min() >= 0 and lons.max() > 180)
            self.years.append(_ERA5YearData(year, t_arr, d_arr, tp_arr,
                                            lats, lons, lon_is_0_360))
            print(f"  [era5]   loaded {year} in {time.time() - t0:.1f}s; "
                  f"grid {len(lats)} × {len(lons)}; {t_arr.shape[0]} days", flush=True)
        if not self.years:
            return False
        self._loaded = True
        loaded_years = ", ".join(str(y.year) for y in self.years)
        avg_note = " (averaged across years)" if len(self.years) > 1 else ""
        print(f"  [era5] active years: {loaded_years}{avg_note}", flush=True)
        return True

    def summarize_for_point(self, lat: float, lon: float) -> Dict[str, int]:
        """Mean of per-year summaries. Counts (heat-index days, heavy
        precip days) average across years cleanly. longest_dry_run_days
        averages too — it's a real-valued severity metric of "longest
        seasonal dry stretch", so averaging two years' max-runs gives
        an honest "typical worst dry spell" value rather than picking
        the more-extreme year arbitrarily."""
        per_year = [y.summary_for_point(lat, lon) for y in self.years]
        per_year = [s for s in per_year if s is not None]
        if not per_year:
            return {"heat_index_days": 0, "heavy_precip_days": 0, "longest_dry_run_days": 0}
        n = len(per_year)
        return {
            "heat_index_days": int(round(sum(s["heat_index_days"] for s in per_year) / n)),
            "heavy_precip_days": int(round(sum(s["heavy_precip_days"] for s in per_year) / n)),
            "longest_dry_run_days": int(round(sum(s["longest_dry_run_days"] for s in per_year) / n)),
        }

    # Back-compat property: callers that read `cache.year` for logging
    # now see a comma-joined list (e.g. "2024+2025") instead of one int.
    @property
    def year(self) -> str:
        return "+".join(str(y.year) for y in self.years) if self.years else "none"


_cache_singleton: Optional[_ERA5Cache] = None


def get_cache() -> Optional[_ERA5Cache]:
    """Try to load the ERA5 bulk cache. Returns None if files aren't on
    disk — caller falls back to the Open-Meteo API path."""
    global _cache_singleton
    if _cache_singleton is None:
        c = _ERA5Cache()
        if c.load():
            _cache_singleton = c
        else:
            return None
    return _cache_singleton


def fetch_for_facilities(facilities: List[Dict]) -> Dict[str, Dict]:
    """Return climate summaries for every facility from the local ERA5
    bulk NetCDF cache. No stride sampling — at ~5µs per nearest-cell
    lookup we can score every facility directly (50K facilities in <1s).

    Returns {} if the bulk cache isn't available; the caller should fall
    back to climate.py's API-based fetch in that case.
    """
    cache = get_cache()
    if cache is None:
        return {}
    summaries: Dict[str, Dict] = {}
    t0 = time.time()
    for f in facilities:
        summaries[f["id"]] = cache.summarize_for_point(f["lat"], f["lon"])
    print(f"  [era5] summarized {len(summaries):,} facilities from local ERA5 {cache.year} cache "
          f"in {time.time() - t0:.1f}s (no network calls)", flush=True)
    return summaries
