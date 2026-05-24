#!/usr/bin/env python3
"""
Download WorldPop 100m total-population rasters for each atlas country.

Pattern matches the Healthsites / ERA5 bulk download approach: pull
each country's GeoTIFF once into data/raw/worldpop/, then a pipeline
ingest module computes per-facility catchment numbers locally — no
server hits at build time.

Why "constrained / Maxar-v1": this WorldPop variant uses Maxar building
footprints to constrain population to actually-built areas. Much more
accurate than the unconstrained interpolation, especially for urban
facilities where 100m of un-built buffer can otherwise inflate the
catchment.

Output: data/raw/worldpop/{ISO}_pop_2020.tif (gitignored). ~310 MB total.

Why all-ages instead of age-banded: WorldPop's age+sex breakdowns are
36 files per country (2 sexes × 18 age bands), ~5-50 MB each — ~1-2 GB
to download per country for the under-18 slice. Within-country age share
is roughly flat (it's a national demographic), so multiplying the
all-ages raster by the country under_18_share from config/{ISO}.yaml
gives a defensible under-18 catchment with much less data.

Run:
  python3 scripts/download_worldpop.py
"""
from __future__ import annotations

import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "raw" / "worldpop"
OUT_DIR.mkdir(parents=True, exist_ok=True)

BASE = "https://data.worldpop.org/GIS/Population/Global_2000_2020_Constrained/2020"

# WorldPop publishes per-country at one of two processing tiers:
#   maxar_v1: uses Maxar Open Buildings footprints (most accurate where
#             coverage exists — Africa, Asia subset)
#   BSGM:     Building Settlement Growth Model, used where Maxar footprint
#             coverage isn't available
# Each country uses exactly ONE; the other URL 404s. We probed per-country
# during v0.7 wiring.
JOBS = [
    # (ISO3, lowercase, variant, approx MB for progress display)
    ("NGA", "nga", "maxar_v1", 120),
    ("BGD", "bgd", "BSGM",      30),
    ("GTM", "gtm", "BSGM",      30),
    ("KEN", "ken", "maxar_v1",  70),
    ("PHL", "phl", "BSGM",      60),
]


def _download(url: str, target: Path, approx_mb: int) -> None:
    """Stream-download with simple progress. Skips if file already on disk."""
    if target.exists() and target.stat().st_size > 1_000_000:
        size_mb = target.stat().st_size / 1024 / 1024
        print(f"  skip  {target.name} — already on disk ({size_mb:.0f} MB)")
        return

    print(f"  fetch {target.name}  (~{approx_mb} MB expected)")
    tmp = target.with_suffix(target.suffix + ".part")
    t0 = time.time()

    req = urllib.request.Request(url, headers={
        "User-Agent": "ChildClimate-Atlas/0.7 (https://climate-atlas.trameter.com)",
    })
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        received = 0
        last_pct = -1
        while True:
            chunk = resp.read(64 * 1024)
            if not chunk:
                break
            f.write(chunk)
            received += len(chunk)
            if total:
                pct = int(100 * received / total)
                if pct != last_pct and pct % 10 == 0:
                    print(f"    {pct:>3}%  ({received/1024/1024:.1f} / {total/1024/1024:.0f} MB)")
                    last_pct = pct
    tmp.rename(target)
    elapsed = time.time() - t0
    final_mb = target.stat().st_size / 1024 / 1024
    print(f"  done  {target.name} ({final_mb:.1f} MB, {elapsed:.0f}s)")


def main():
    print(f"[worldpop] writing to {OUT_DIR}")
    for iso3, iso3_lower, variant, approx_mb in JOBS:
        url = f"{BASE}/{variant}/{iso3}/{iso3_lower}_ppp_2020_UNadj_constrained.tif"
        target = OUT_DIR / f"{iso3}_pop_2020.tif"
        try:
            _download(url, target, approx_mb)
        except Exception as e:
            print(f"  FAIL  {iso3}: {e}", file=sys.stderr)
            sys.exit(1)
    print("\n[worldpop] all done. Next: re-run any pipeline build and the")
    print("worldpop ingest will populate catchment_under18_500m per facility.")


if __name__ == "__main__":
    main()
