"""WorldPop catchment — per-facility under-18 population in a 500m radius.

Adds a `catchment_under18_500m` integer to every facility, computed from
the local WorldPop 100m population raster downloaded via
scripts/download_worldpop.py. Approach:

  1. Open the country's WorldPop GeoTIFF once per build (lazy-loaded
     singleton; ~30-120 MB raster mmap'd via rasterio).
  2. For each facility, find the raster cells within a 500m circle
     around its lat/lon, sum the population values.
  3. Multiply by the country's under_18_share (from config/{ISO}.yaml)
     to get the under-18 catchment.

The raster is total-population (all ages). Multiplying by the country
under-18 share is a defensible approximation — within-country age
structure is roughly flat at neighborhood scale. If we later want
per-pixel age structure, swap to WorldPop's age+sex rasters (36 files
per country, ~1-2 GB per country — overkill for what we get).

Graceful skip:
  - Missing raster file → returns None for that facility, build continues
  - Missing rasterio import → logs once, returns None for all facilities
  - Facility outside raster bounds (rare; reverse-geocode usually catches
    these) → returns None for that facility, build continues
"""
from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Dict, List, Optional

try:
    import rasterio
    from rasterio.windows import Window
    import numpy as np
    _RASTERIO_AVAILABLE = True
except ImportError:
    _RASTERIO_AVAILABLE = False

from ..config import RAW_DIR

WORLDPOP_DIR = RAW_DIR / "worldpop"
CATCHMENT_RADIUS_M = 500.0  # half-kilometre — typical primary-school walking distance


class _CountryRaster:
    """Lazy-open one country's WorldPop raster. Reused across all
    summarize() calls in a build for that country."""

    def __init__(self, iso3: str):
        self.iso3 = iso3
        self.path = WORLDPOP_DIR / f"{iso3.upper()}_pop_2020.tif"
        self.ds = None
        self.transform = None
        self.crs = None
        self.nodata = None
        self.width = None
        self.height = None
        self.pixel_size_m_lat = None  # latitude-aware pixel size in metres
        self.pixel_size_m_lon = None

    def open(self) -> bool:
        if not _RASTERIO_AVAILABLE:
            return False
        if not self.path.exists():
            return False
        if self.ds is not None:
            return True
        try:
            self.ds = rasterio.open(self.path)
        except Exception as e:
            print(f"  [worldpop] failed to open {self.path}: {e}", flush=True)
            return False
        self.transform = self.ds.transform
        self.crs = self.ds.crs
        self.nodata = self.ds.nodata
        self.width = self.ds.width
        self.height = self.ds.height
        # Pixel size in degrees → metres. lat is constant (~111,320 m / deg).
        # lon varies with cos(latitude); we compute per-facility below.
        self.pixel_size_deg_lat = abs(self.transform.e)
        self.pixel_size_deg_lon = abs(self.transform.a)
        self.pixel_size_m_lat = self.pixel_size_deg_lat * 111_320.0
        return True

    def close(self) -> None:
        if self.ds is not None:
            self.ds.close()
            self.ds = None

    def catchment_for_point(self, lat: float, lon: float, radius_m: float) -> Optional[float]:
        """Sum WorldPop pixel values within `radius_m` of (lat, lon).
        Returns None if facility is outside the raster bounds. Returns
        the SUM of all-ages population — caller multiplies by under-18
        share at the country level."""
        if self.ds is None:
            return None
        # Convert lat/lon to raster row/col.
        try:
            row_centre, col_centre = self.ds.index(lon, lat)
        except Exception:
            return None
        if not (0 <= row_centre < self.height and 0 <= col_centre < self.width):
            return None

        # Pixel-size in metres for THIS latitude (lon spacing shrinks toward poles).
        m_per_deg_lon = 111_320.0 * math.cos(math.radians(lat))
        if m_per_deg_lon < 1:
            m_per_deg_lon = 1
        pixel_size_m_lon = self.pixel_size_deg_lon * m_per_deg_lon

        # Half-window in pixels (round up so we don't miss edge cells).
        half_rows = max(1, int(math.ceil(radius_m / self.pixel_size_m_lat)))
        half_cols = max(1, int(math.ceil(radius_m / pixel_size_m_lon)))

        r0 = max(0, row_centre - half_rows)
        r1 = min(self.height, row_centre + half_rows + 1)
        c0 = max(0, col_centre - half_cols)
        c1 = min(self.width, col_centre + half_cols + 1)
        if r1 <= r0 or c1 <= c0:
            return None

        window = Window(c0, r0, c1 - c0, r1 - r0)
        block = self.ds.read(1, window=window)
        if block.size == 0:
            return None

        # Build a circular mask: only count pixels whose centre is within
        # radius_m of the facility. Without this we'd include the corners
        # of the bounding box (over-count by ~27% — π/4).
        rr = np.arange(r0, r1)
        cc = np.arange(c0, c1)
        row_offsets_m = (rr - row_centre) * self.pixel_size_m_lat
        col_offsets_m = (cc - col_centre) * pixel_size_m_lon
        ROW, COL = np.meshgrid(row_offsets_m, col_offsets_m, indexing="ij")
        dist_m = np.sqrt(ROW * ROW + COL * COL)
        mask = dist_m <= radius_m

        # Strip nodata before summing. WorldPop uses -99999 or 0 for nodata
        # depending on the variant — handle both.
        valid = block.copy()
        if self.nodata is not None:
            valid[valid == self.nodata] = 0
        valid[valid < 0] = 0  # belt-and-braces

        return float(valid[mask].sum())


# Singleton cache: one _CountryRaster per ISO loaded so far in this process.
_country_rasters: Dict[str, _CountryRaster] = {}


def get_raster(iso3: str) -> Optional[_CountryRaster]:
    iso3 = iso3.upper()
    r = _country_rasters.get(iso3)
    if r is None:
        r = _CountryRaster(iso3)
        if not r.open():
            return None
        _country_rasters[iso3] = r
    return r


def enrich_facilities(facilities: List[Dict], iso3: str, under_18_share: float) -> int:
    """Add catchment_under18_500m to every facility in-place. Returns the
    number of facilities for which a catchment was computed (some may be
    outside the raster bounds and stay None)."""
    raster = get_raster(iso3)
    if raster is None:
        if not _RASTERIO_AVAILABLE:
            print(f"  [worldpop] rasterio not installed — skipping catchment", flush=True)
        else:
            print(f"  [worldpop] no raster at {WORLDPOP_DIR / (iso3.upper() + '_pop_2020.tif')} — skipping", flush=True)
        for f in facilities:
            f.setdefault("catchment_under18_500m", None)
        return 0

    t0 = time.time()
    computed = 0
    for f in facilities:
        # WorldPop catchment is computed at facility lat/lon. The facility
        # dicts at this pipeline stage are pre-scoring, so lat/lon keys
        # live at the top level (not in geometry yet).
        lat = f.get("lat")
        lon = f.get("lon")
        if lat is None or lon is None:
            f["catchment_under18_500m"] = None
            continue
        total_pop = raster.catchment_for_point(lat, lon, CATCHMENT_RADIUS_M)
        if total_pop is None:
            f["catchment_under18_500m"] = None
            continue
        # Country under-18 share applied uniformly within country. Within-
        # country age-structure variation is small compared to the population
        # density signal we care about.
        under_18 = int(round(total_pop * under_18_share))
        f["catchment_under18_500m"] = under_18
        computed += 1

    elapsed = time.time() - t0
    print(f"  [worldpop] computed catchment for {computed:,}/{len(facilities):,} "
          f"facilities in {elapsed:.1f}s (radius {CATCHMENT_RADIUS_M:.0f}m, "
          f"under_18_share={under_18_share:.2f})", flush=True)
    return computed
