#!/usr/bin/env python3
"""
Download ERA5 daily statistics for 2024 (dewpoint + precipitation only).

This complements scripts/download_era5_2025.py and the already-downloaded
2024 T_max file (from the original CDS web-UI form submission). Together
they give us 2024 + 2025 multi-year coverage, which lets era5_bulk.py
average across years and dampen single-year climate variability (e.g.
2025's La Niña understated drought in tropical Pacific countries).

Variables:
  - 2m_dewpoint_temperature  (daily_mean) -> era5_2024_d2m_mean.nc
  - total_precipitation      (daily_sum)  -> era5_2024_tp_sum.nc

NOTE: 2024 T_max is intentionally NOT in this script — you should
already have it at data/raw/era5_2024/era5_2024_t2m_max.nc from the
Chrome-extension's first form submission (the 733 MB green-Download file
on https://cds.climate.copernicus.eu/requests?tab=all). Move/rename it
to that exact path before running this script. If for any reason that
file is missing, add 't2m_max' to the JOBS list below or re-download
via the CDS web UI.

Prerequisites: same as download_era5_2025.py — see that script's header.

Output: ~1.5 GB total. Lands in data/raw/era5_2024/.
"""

from pathlib import Path
import cdsapi

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "raw" / "era5_2024"
OUT_DIR.mkdir(parents=True, exist_ok=True)

DATASET = "derived-era5-single-levels-daily-statistics"

MONTHS = [f"{m:02d}" for m in range(1, 13)]
DAYS = [f"{d:02d}" for d in range(1, 32)]

COMMON = {
    "product_type": "reanalysis",
    "year": "2024",
    "month": MONTHS,
    "day": DAYS,
    "time_zone": "utc+00:00",
    "frequency": "1_hourly",
    "data_format": "netcdf",
}

JOBS = [
    {
        "filename": "era5_2024_d2m_mean.nc",
        "request": {**COMMON, "variable": ["2m_dewpoint_temperature"], "daily_statistic": "daily_mean"},
    },
    {
        "filename": "era5_2024_tp_sum.nc",
        "request": {**COMMON, "variable": ["total_precipitation"],     "daily_statistic": "daily_sum"},
    },
]


def main():
    client = cdsapi.Client()
    print(f"[2024-era5] writing to {OUT_DIR}")
    for job in JOBS:
        target = OUT_DIR / job["filename"]
        if target.exists() and target.stat().st_size > 100_000_000:
            print(f"\n>>> Skipping {target.name} — already on disk ({target.stat().st_size / 1024**2:.0f} MB)")
            continue
        print(f"\n>>> Submitting {target.name} ...")
        client.retrieve(DATASET, job["request"], str(target))
        print(f"    Saved: {target.resolve()}  ({target.stat().st_size / 1024**2:.0f} MB)")
    print("\nAll done. Verify 2024 T_max also lives at data/raw/era5_2024/era5_2024_t2m_max.nc,")
    print("then re-run `python3 -m pipeline.build --country PHL --full` (or any other ISO).")


if __name__ == "__main__":
    main()
