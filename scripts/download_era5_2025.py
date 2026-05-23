#!/usr/bin/env python3
"""
Download ERA5 daily statistics for 2025, global coverage, NetCDF-4.

Why this script exists:
  Our Open-Meteo archive-api integration kept hitting daily-quota AND
  long-window TCP throttles, making per-facility climate fetches
  unreliable. Same play we used for Healthsites: download the bulk
  dataset once, query locally forever.

Variables:
  - 2m_temperature           (daily_maximum) -> era5_2025_t2m_max.nc
  - 2m_dewpoint_temperature  (daily_mean)    -> era5_2025_d2m_mean.nc
  - total_precipitation      (daily_sum)     -> era5_2025_tp_sum.nc

Prerequisites:
  1. Free CDS account at https://cds.climate.copernicus.eu/
  2. ~/.cdsapirc file with your API key. Get the key from your CDS
     profile page (https://cds.climate.copernicus.eu/profile) and
     write the file as:
       url: https://cds.climate.copernicus.eu/api
       key: <YOUR-API-KEY>
  3. pip install cdsapi  (already in requirements.txt)

Output: ~700MB-1GB per file, ~2.5GB total. Lands in data/raw/era5_2025/
        which is gitignored (data/raw/* is in .gitignore).

Bonus: Request 1 (2024 t_max, global) is already queued from the
       Chrome-extension form session — grab it manually from
       https://cds.climate.copernicus.eu/requests?tab=all when you're
       at the CDS web UI. Save it as data/raw/era5_2024/era5_2024_t2m_max.nc
       and the ingestion module will pick it up automatically alongside
       the 2025 data.
"""

from pathlib import Path
import cdsapi

# Project-root-relative path so this works whether run as
# `python3 scripts/download_era5_2025.py` from root OR as
# `python3 download_era5_2025.py` from inside scripts/.
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "raw" / "era5_2025"
OUT_DIR.mkdir(parents=True, exist_ok=True)

DATASET = "derived-era5-single-levels-daily-statistics"

MONTHS = [f"{m:02d}" for m in range(1, 13)]
DAYS = [f"{d:02d}" for d in range(1, 32)]

COMMON = {
    "product_type": "reanalysis",
    "year": "2025",
    "month": MONTHS,
    "day": DAYS,
    "time_zone": "utc+00:00",
    "frequency": "1_hourly",
    "data_format": "netcdf",
}

JOBS = [
    {
        "filename": "era5_2025_t2m_max.nc",
        "request": {**COMMON, "variable": ["2m_temperature"],          "daily_statistic": "daily_maximum"},
    },
    {
        "filename": "era5_2025_d2m_mean.nc",
        "request": {**COMMON, "variable": ["2m_dewpoint_temperature"], "daily_statistic": "daily_mean"},
    },
    {
        "filename": "era5_2025_tp_sum.nc",
        "request": {**COMMON, "variable": ["total_precipitation"],     "daily_statistic": "daily_sum"},
    },
]


def main():
    client = cdsapi.Client()
    for job in JOBS:
        target = OUT_DIR / job["filename"]
        if target.exists() and target.stat().st_size > 100_000_000:
            print(f"\n>>> Skipping {target.name} — already on disk ({target.stat().st_size / 1024**2:.0f} MB)")
            continue
        print(f"\n>>> Submitting {target.name} ...")
        client.retrieve(DATASET, job["request"], str(target))
        print(f"    Saved: {target.resolve()}  ({target.stat().st_size / 1024**2:.0f} MB)")
    print("\nAll done. Next: re-run `python3 -m pipeline.build --country PHL --full`")
    print("The climate.py module will auto-detect the local ERA5 cache and skip Open-Meteo.")


if __name__ == "__main__":
    main()
