"""Slice the Healthsites bulk World shapefile into per-country JSON caches.

The Healthsites.io API free tier is rate-limited to 50 requests/day, which
makes large-country pulls (NGA) infeasible. Healthsites also publishes the
full global dataset as a downloadable shapefile (4.2 GB zipped) which
sidesteps the rate-limit problem entirely. This script reads the zip
in-place, streams every record (~1M point + N polygon), classifies each by
country bbox, and writes per-country JSON in the same shape that
pipeline/sources/healthsites.fetch() returns.

The downstream pipeline reads data/raw/{ISO}/healthsites.json on next build
— exactly the API-derived cache slot, so nothing else needs to change.

Run:
  python3 scripts/healthsites_bulk_slice.py
  # or to slice just one country:
  python3 scripts/healthsites_bulk_slice.py --country NGA

Adds zero new countries to the atlas — that is intentional. This script
only fills slots for ISO3 codes already present in pipeline/config.py.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import shapefile  # pyshp

# Make the package importable when run from project root.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipeline.config import load_country  # noqa: E402
from pipeline.sources.healthsites import _normalize  # noqa: E402

BULK_ZIP = ROOT / "data" / "raw" / "healthsites" / "World.zip"
COUNTRY_ISOS = ["NGA", "BGD", "GTM", "KEN"]
PROGRESS_EVERY = 100_000


def _centroid_of_polygon(points: List[Tuple[float, float]]) -> Tuple[float, float]:
    """Bbox-center centroid — fine for facility-marker placement.

    Proper polygon-area centroid would be more accurate for irregular
    shapes, but bbox-center is within ~tens of metres for the
    building-scale polygons in this dataset and costs O(N) instead of
    O(N log N).
    """
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return ((min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0)


def _record_to_api_shape(rec_dict: Dict, osm_type: str, lon: float, lat: float) -> Dict:
    """Reshape a flat DBF record into the API response shape so we can
    reuse pipeline.sources.healthsites._normalize() unchanged."""
    osm_id_raw = rec_dict.get("osm_id") or ""
    # Strip the "way/123" prefix Healthsites uses for way records.
    osm_id_str = str(osm_id_raw).strip()
    if "/" in osm_id_str:
        _, osm_id_str = osm_id_str.split("/", 1)
    try:
        osm_id = int(osm_id_str) if osm_id_str else 0
    except ValueError:
        osm_id = 0

    # Pull through every non-empty attribute. _normalize() will then
    # whitelist down to the keys it cares about.
    attributes = {k: v for k, v in rec_dict.items()
                  if v not in (None, "", " ") and k != "osm_id"}
    return {
        "osm_type": osm_type,
        "osm_id": osm_id,
        "centroid": {"coordinates": [lon, lat]},
        "attributes": attributes,
    }


def _country_buckets(target_isos: List[str]) -> Dict[str, Dict]:
    """Build the per-country state: bbox + accumulator list + raw_dir."""
    out = {}
    for iso in target_isos:
        cfg = load_country(iso)
        west, south, east, north = cfg.bbox
        out[iso] = {
            "bbox": (west, south, east, north),
            "records": [],
            "raw_dir": cfg.raw_dir,
            "name": cfg.name,
        }
    return out


def _bbox_match(buckets: Dict[str, Dict], lon: float, lat: float) -> Optional[str]:
    """First-match bbox classification. Bboxes don't overlap for our 4
    current countries (they're on different continents), so first-match
    is unambiguous. Add a contains-check guard for any future overlapping
    bboxes (e.g. India + Pakistan)."""
    for iso, b in buckets.items():
        w, s, e, n = b["bbox"]
        if w <= lon <= e and s <= lat <= n:
            return iso
    return None


def _stream_layer(zf: zipfile.ZipFile, layer: str, buckets: Dict[str, Dict]) -> int:
    """Process one shapefile layer ('World-node' or 'World-way')."""
    print(f"\n[bulk] streaming layer: {layer}", flush=True)
    t0 = time.time()
    examined = matched = 0

    with zf.open(f"{layer}.shp") as shp_f, \
         zf.open(f"{layer}.shx") as shx_f, \
         zf.open(f"{layer}.dbf") as dbf_f:
        # encodingErrors='replace' so a handful of malformed bytes in the
        # 1M+ DBF records don't kill the whole scan — replaced chars are
        # cosmetic (typically in long OSM tag values, not the key fields).
        reader = shapefile.Reader(shp=shp_f, shx=shx_f, dbf=dbf_f,
                                  encoding="utf-8", encodingErrors="replace")
        total = reader.numRecords
        print(f"[bulk]   {total:,} records to scan", flush=True)

        # Use iterShapeRecords to stream without loading all at once.
        for sr in reader.iterShapeRecords():
            examined += 1
            shape = sr.shape
            pts = getattr(shape, "points", None) or []
            if not pts:
                continue
            if layer.endswith("-node"):
                lon, lat = pts[0]
            else:
                lon, lat = _centroid_of_polygon(pts)

            iso = _bbox_match(buckets, lon, lat)
            if iso is None:
                continue

            osm_type = "node" if layer.endswith("-node") else "way"
            api_shape = _record_to_api_shape(sr.record.as_dict(), osm_type, lon, lat)
            buckets[iso]["records"].append(api_shape)
            matched += 1

            if examined % PROGRESS_EVERY == 0:
                elapsed = time.time() - t0
                rate = examined / elapsed
                print(f"[bulk]   {examined:>9,}/{total:,} examined, {matched:>6,} matched "
                      f"({rate:,.0f}/s, elapsed {elapsed:.0f}s)", flush=True)

    elapsed = time.time() - t0
    print(f"[bulk]   layer done: {examined:,} examined, {matched:,} matched in {elapsed:.0f}s", flush=True)
    return matched


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", action="append", help="Limit to specific ISO3 (repeatable). Defaults to all 4.")
    args = ap.parse_args()

    if not BULK_ZIP.exists():
        sys.exit(f"[bulk] missing {BULK_ZIP} — drop the Healthsites World.zip there first")

    target = args.country or COUNTRY_ISOS
    print(f"[bulk] slicing {BULK_ZIP.name} for countries: {', '.join(target)}")
    buckets = _country_buckets(target)

    with zipfile.ZipFile(BULK_ZIP) as zf:
        layers = [n.rsplit(".", 1)[0] for n in zf.namelist() if n.endswith(".shp")]
        print(f"[bulk] layers in zip: {layers}")
        for layer in layers:
            _stream_layer(zf, layer, buckets)

    print("\n[bulk] writing per-country caches:")
    for iso, b in buckets.items():
        raw_recs = b["records"]
        normalized = _normalize(raw_recs)
        out_path = b["raw_dir"] / "healthsites.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(normalized, indent=2))
        print(f"  {iso} ({b['name']}): {len(raw_recs):,} raw → {len(normalized):,} normalized "
              f"→ {out_path} ({out_path.stat().st_size / 1024:.0f} KB)")

    print("\n[bulk] done. Next pipeline run will pick up these caches automatically.")


if __name__ == "__main__":
    main()
