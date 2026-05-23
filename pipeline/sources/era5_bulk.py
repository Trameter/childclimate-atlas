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

# Years we look for (newest first — we prefer 2025 data; 2024 used as
# fallback if 2025 isn't on disk yet).
ERA5_YEARS_PREFERENCE = [2025, 2024]

# Threshold constants — kept in lockstep with climate.py._summarize so the
# Open-Meteo path and the bulk path produce identical scoring semantics.
HEAT_INDEX_THRESHOLD_C = 35.0
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


class _ERA5Cache:
    """Lazy-loaded singleton — opens the three NetCDF files once, reuses
    across all facility lookups. The xarray open is fast (mmap-style); the
    cost is the per-cell .isel() which we do once per facility."""

    def __init__(self):
        self._loaded = False
        self.year = None
        self.t_max = None
        self.d_mean = None
        self.tp_sum = None
        self.t_max_arr = None     # eager-loaded numpy view for speed
        self.d_mean_arr = None
        self.tp_sum_arr = None
        self.lats = None
        self.lons = None

    def load(self) -> bool:
        """Try to open the bulk NetCDFs. Returns True on success, False
        if no year has all 3 files on disk yet (caller falls back to API)."""
        if self._loaded:
            return True
        if not _XARRAY_AVAILABLE:
            return False
        for year in ERA5_YEARS_PREFERENCE:
            d = RAW_DIR / f"era5_{year}"
            paths = {
                "t_max": d / f"era5_{year}_t2m_max.nc",
                "d_mean": d / f"era5_{year}_d2m_mean.nc",
                "tp_sum": d / f"era5_{year}_tp_sum.nc",
            }
            if not all(p.exists() for p in paths.values()):
                continue
            t0 = time.time()
            print(f"  [era5] loading bulk cache for {year}: "
                  f"{sum(p.stat().st_size for p in paths.values()) / 1024**2:.0f} MB total", flush=True)
            self.t_max = xr.open_dataset(paths["t_max"])
            self.d_mean = xr.open_dataset(paths["d_mean"])
            self.tp_sum = xr.open_dataset(paths["tp_sum"])
            # ERA5 daily-statistics NetCDFs typically have one data variable
            # per file (t2m, d2m, tp respectively). Pick the first one
            # robustly rather than hardcoding the name.
            t_var = list(self.t_max.data_vars)[0]
            d_var = list(self.d_mean.data_vars)[0]
            tp_var = list(self.tp_sum.data_vars)[0]
            # Eager-load into memory — at 0.25° resolution × 365 days × 1
            # variable, each grid is ~700K cells × 365 days = ~1GB per
            # variable. xarray will mmap; .values forces a load for fast
            # per-facility indexing.
            self.t_max_arr = self.t_max[t_var].values     # shape (time, lat, lon), Kelvin
            self.d_mean_arr = self.d_mean[d_var].values   # Kelvin
            self.tp_sum_arr = self.tp_sum[tp_var].values  # meters
            # Coordinate arrays. ERA5 usually has latitude descending
            # (90 → -90) and longitude in 0-360. We handle both conventions.
            lat_name = "latitude" if "latitude" in self.t_max.coords else "lat"
            lon_name = "longitude" if "longitude" in self.t_max.coords else "lon"
            self.lats = self.t_max[lat_name].values
            self.lons = self.t_max[lon_name].values
            # Whether longitudes are stored as [0, 360) (need wrap for
            # facilities at negative lon) or [-180, 180].
            self._lon_is_0_360 = (self.lons.min() >= 0 and self.lons.max() > 180)
            self.year = year
            self._loaded = True
            print(f"  [era5] loaded {year} cache in {time.time() - t0:.1f}s; "
                  f"grid {len(self.lats)} × {len(self.lons)} = {len(self.lats) * len(self.lons):,} cells; "
                  f"{self.t_max_arr.shape[0]} days", flush=True)
            return True
        return False

    def _nearest(self, lat: float, lon: float) -> Tuple[int, int]:
        """Nearest grid-cell indices on the 1D coord arrays."""
        if self._lon_is_0_360 and lon < 0:
            lon = lon + 360.0
        lat_idx = int(np.abs(self.lats - lat).argmin())
        lon_idx = int(np.abs(self.lons - lon).argmin())
        return lat_idx, lon_idx

    def summarize_for_point(self, lat: float, lon: float) -> Dict[str, int]:
        i, j = self._nearest(lat, lon)
        # Daily timeseries for this grid cell across the year.
        t_K = self.t_max_arr[:, i, j]
        d_K = self.d_mean_arr[:, i, j]
        tp_m = self.tp_sum_arr[:, i, j]
        # Mask out NaN / fill-value sentinels (rare on global grids but
        # ERA5 occasionally has missing days at polar / coastal edges).
        valid = ~(np.isnan(t_K) | np.isnan(d_K) | np.isnan(tp_m))
        t_K = t_K[valid]
        d_K = d_K[valid]
        tp_m = tp_m[valid]
        if t_K.size == 0:
            return {"heat_index_days": 0, "heavy_precip_days": 0, "longest_dry_run_days": 0}
        # Unit conversions.
        t_c = t_K - 273.15
        d_c = d_K - 273.15
        tp_mm = tp_m * 1000.0
        # Heat-index days.
        rh = _rh_from_t_dewpoint(t_c, d_c)
        apparent_c = _heat_index_c(t_c, rh)
        heat_index_days = int(np.sum(apparent_c >= HEAT_INDEX_THRESHOLD_C))
        heavy_precip_days = int(np.sum(tp_mm >= HEAVY_PRECIP_THRESHOLD_MM))
        longest_dry = _longest_run_below(tp_mm, DRY_DAY_THRESHOLD_MM)
        return {
            "heat_index_days": heat_index_days,
            "heavy_precip_days": heavy_precip_days,
            "longest_dry_run_days": int(longest_dry),
        }


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
