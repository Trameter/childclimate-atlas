"""End-to-end pipeline orchestrator.

    python3 -m pipeline.build --country NGA

Pulls facilities + climate + air quality, scores every facility, and
exports a single GeoJSON the web frontend can render directly.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from typing import Dict, List

from .config import load_country, CountryConfig, PROCESSED_DIR
from .sources import facilities as facilities_src
from .sources import grid3 as grid3_src
from .sources import climate as climate_src
from .sources import air_quality as air_src
from .sources import geocode as geocode_src
from .scoring.score import score_all


def _log(msg: str) -> None:
    print(f"[build] {msg}", flush=True)


def _to_geojson(scored: List[Dict], country: CountryConfig) -> Dict:
    features = []
    for f in scored:
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [f["lon"], f["lat"]],
            },
            "properties": {
                "id": f["id"],
                "name": f["name"],
                "facility_type": f["type"],
                "tags": f.get("tags", {}),
                "risk_score": f["risk"]["score"],
                "risk_components": f["risk"]["components"],
                "risk_contributions": f["risk"]["contributions"],
                "top_drivers": f["risk"]["top_drivers"],
                "recommendations": f["risk"].get("recommendations", []),
                "climate": f.get("climate", {}),
                "air": f.get("air", {}),
            },
        })
    # Build the source attribution list based on which sources contributed
    # facilities — consumers (web UI, README, PDF report) can read this to
    # show proper credit. Always includes OSM; GRID3 appended when present.
    sources_used = ["OpenStreetMap (ODbL)"]
    if any(f.get("properties", {}).get("tags", {}).get("source") == "grid3"
           for f in features):
        sources_used.append(
            "GRID3 NGA Health Facilities v2.0 "
            "(CIESIN / Columbia University, CC BY 4.0, "
            "https://doi.org/10.7916/kv1n-0743)"
        )
    return {
        "type": "FeatureCollection",
        "metadata": {
            "country": country.name,
            "iso3": country.iso3,
            "focus_region": country.focus_name,
            "focus_bbox": country.focus_bbox,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "facility_count": len(features),
            "scoring_weights": country.scoring_weights,
            "pipeline_version": "0.2.0",
            "facility_sources": sources_used,
        },
        "features": features,
    }


def build(iso3: str, limit: int | None = None, fresh: bool = False, full: bool = False) -> Dict:
    config = load_country(iso3)
    if full:
        _log(f"Building FULL COUNTRY atlas for {config.name} ({config.iso3})")
        # Override focus_bbox with the full country bbox so Overpass pulls everything.
        config.focus_bbox = config.bbox
        config.focus_name = f"{config.name} (full country)"
    else:
        _log(f"Building atlas for {config.name} ({config.iso3}) — focus: {config.focus_name}")

    _log("Fetching facilities from OSM Overpass...")
    all_facilities = facilities_src.fetch(config, cache=not fresh)
    _log(f"  got {len(all_facilities)} facilities from OSM (clinics + hospitals + schools)")

    # Optional: merge GRID3 Nigeria Health Facilities v2.0 (CC BY 4.0).
    # OSM coverage of Nigerian PHCs is uneven (e.g. urban Kano gaps); the
    # NHFR 2024 + GRID3 dataset adds ~47k GPS-validated health facilities.
    # Spatial dedup drops GRID3 records that sit within 150m of an
    # existing OSM entry, so we don't double-count.
    if config.sources.get("grid3"):
        _log("Fetching GRID3 Nigeria Health Facilities v2.0 (CIESIN / CC BY 4.0)...")
        grid3_facilities = grid3_src.fetch(config, cache=not fresh)
        _log(f"  got {len(grid3_facilities)} health facilities from GRID3")
        if grid3_facilities:
            before_dedup = len(grid3_facilities)
            grid3_facilities = grid3_src.dedup_against_osm(
                grid3_facilities, all_facilities, proximity_m=150.0
            )
            dropped = before_dedup - len(grid3_facilities)
            _log(f"  deduped: dropped {dropped} GRID3 records within 150m of an OSM entry")
            _log(f"  merging {len(grid3_facilities)} net-new facilities")
            all_facilities = all_facilities + grid3_facilities
            _log(f"  combined total: {len(all_facilities)} facilities")

    if limit:
        all_facilities = all_facilities[:limit]
        _log(f"  limited to first {limit} for this run")

    if not all_facilities:
        _log("  WARNING: no facilities returned. Check bbox and Overpass availability.")
        return {"type": "FeatureCollection", "features": []}

    _log("Assigning states via reverse geocoding...")
    all_facilities = geocode_src.assign_states(all_facilities, country_iso2=config.iso2)

    # Adaptive sampling: for large facility sets, sample fewer points to keep
    # build times reasonable AND fit within Open-Meteo's free-tier hourly
    # cap (~600 calls/hour across BOTH climate + air endpoints combined).
    # Climate and AQ vary on kilometre-to-tens-of-kilometres scales, so
    # nearest-neighbor fill from a sparser grid is still accurate. The
    # per-point cache makes re-runs cheap regardless of stride.
    n = len(all_facilities)
    if n > 20000:
        stride = 100    # ~500 samples for a 50k-facility country rebuild
    elif n > 5000:
        stride = 25
    elif n > 2000:
        stride = 20
    elif n > 500:
        stride = 10
    else:
        stride = 5
    _log(f"  using sample stride {stride} for {n} facilities "
         f"(~{n // stride} climate + {n // stride} air samples)")

    _log("Fetching climate indicators via Open-Meteo...")
    climate_by_id = climate_src.fetch_for_facilities(all_facilities, sample_stride=stride)
    _log(f"  climate summaries for {len(climate_by_id)} facilities")

    _log("Fetching air quality via CAMS...")
    air_by_id = air_src.fetch_for_facilities(all_facilities, sample_stride=stride)
    _log(f"  air quality for {len(air_by_id)} facilities")

    _log("Scoring...")
    scored = score_all(
        all_facilities,
        climate_by_id,
        air_by_id,
        under_18_share=config.under_18_share,
        weights=config.scoring_weights,
    )

    # Sort descending by risk so the top-N is trivial to surface in the UI.
    scored.sort(key=lambda f: f["risk"]["score"], reverse=True)

    geojson = _to_geojson(scored, config)
    out_path = config.processed_dir / "atlas.geojson"
    out_path.write_text(json.dumps(geojson))
    _log(f"Wrote {out_path}")

    # Also drop a copy into the web folder so the static frontend can load
    # it without a server-side route.
    web_data = PROCESSED_DIR.parent.parent / "web" / "data"
    web_data.mkdir(parents=True, exist_ok=True)
    web_geojson_path = web_data / f"{config.iso3}.geojson"
    payload = json.dumps(geojson)
    web_geojson_path.write_text(payload)

    # Pre-compressed companion. LiteSpeed on Namecheap isn't reliably
    # gzipping large GeoJSONs on the fly, so we ship a .gz next to each
    # country file and let .htaccess route gzip-capable clients to it.
    # Net for Nigeria: ~80 MB → ~3 MB on the wire, no JS changes needed.
    # Doing this inside the pipeline (vs a manual post-step) means every
    # future country rebuild stays compressed without anyone remembering.
    gz_path = web_data / f"{config.iso3}.geojson.gz"
    with gzip.open(gz_path, "wb", compresslevel=9) as gz:
        gz.write(payload.encode("utf-8"))
    gz_size_mb = gz_path.stat().st_size / 1024 / 1024
    raw_size_mb = web_geojson_path.stat().st_size / 1024 / 1024
    _log(f"  wrote {web_geojson_path.name} ({raw_size_mb:.1f} MB) + "
         f"{gz_path.name} ({gz_size_mb:.2f} MB, {100*gz_size_mb/raw_size_mb:.1f}% of raw)")

    # Top 10 risk summary for the application narrative
    top = scored[:10]
    _log("Top 10 facilities by risk score:")
    for f in top:
        _log(f"  {f['risk']['score']:5.1f}  {f['type']:9}  {f['name']}")

    return geojson


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", required=True, help="ISO3 code (e.g. NGA)")
    ap.add_argument("--limit", type=int, default=None, help="Cap facilities for quick runs")
    ap.add_argument("--fresh", action="store_true", help="Bypass facility cache")
    ap.add_argument("--full", action="store_true", help="Use full country bbox instead of focus region")
    args = ap.parse_args()
    try:
        build(args.country, limit=args.limit, fresh=args.fresh, full=args.full)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
