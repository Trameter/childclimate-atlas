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
from .sources import healthsites as healthsites_src
from .sources import era5_bulk as era5_bulk_src
from .sources import giga as giga_src
from .sources import climate as climate_src
from .sources import nasa_power as nasa_power_src
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


def build(iso3: str, limit: int | None = None, fresh: bool = False, full: bool = False, stride_override: int | None = None, climate_source: str = "open-meteo") -> Dict:
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

    # Optional: merge Healthsites.io (Kartoza + Global Healthsites Mapping
    # Project). Curated + OSM-derived; the small unique-to-Healthsites set
    # adds facilities OSM Overpass missed. Dedupe by id collapses overlap
    # (Healthsites IDs share the same OSM-id format we use). Requires
    # HEALTHSITES_API_KEY in env — silent skip if not configured.
    if config.sources.get("healthsites"):
        _log("Fetching Healthsites.io supplementary facilities...")
        hs_facilities = healthsites_src.fetch(config, cache=not fresh)
        if hs_facilities:
            existing_ids = {f["id"] for f in all_facilities}
            new_hs = [f for f in hs_facilities if f["id"] not in existing_ids]
            _log(f"  Healthsites: {len(hs_facilities)} total, {len(new_hs)} net-new after dedupe")
            all_facilities = all_facilities + new_hs

    # Optional: merge GIGA UNICEF school registry. School-only source —
    # OSM under-coverage of schools is the main gap in BGD/KEN/GTM/PHL.
    # GIGA records have their own ID space (not OSM ids), so we dedup
    # spatially (150m radius vs existing schools). Requires GIGA_API_KEY
    # in env — silent skip if not configured.
    if config.sources.get("giga"):
        _log("Fetching GIGA UNICEF supplementary schools...")
        giga_facilities = giga_src.fetch(config, cache=not fresh)
        if giga_facilities:
            before_dedup = len(giga_facilities)
            giga_facilities = giga_src.dedup_against_existing(
                giga_facilities, all_facilities, proximity_m=150.0
            )
            dropped = before_dedup - len(giga_facilities)
            _log(f"  GIGA: {before_dedup} total, dropped {dropped} within 150m of existing schools")
            _log(f"  merging {len(giga_facilities)} net-new schools")
            all_facilities = all_facilities + giga_facilities

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
    if stride_override is not None and stride_override > 0:
        stride = stride_override
        _log(f"  using OVERRIDE sample stride {stride} for {n} facilities "
             f"(~{n // stride} climate + {n // stride} air samples)")
    else:
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

    # Climate provider preference (highest priority first):
    #   1. Local ERA5 bulk cache (data/raw/era5_YEAR/*.nc) — instant,
    #      no network, no rate limits. Downloaded once via
    #      scripts/download_era5_2025.py. Same ERA5 data Open-Meteo wraps,
    #      so identical scoring semantics.
    #   2. NASA POWER API (MERRA-2) — when --climate-source nasa-power.
    #   3. Open-Meteo archive API — historic default.
    # The bulk cache check is automatic and silent if files aren't on disk,
    # so existing builds with no ERA5 cache fall through to the API path
    # transparently.
    _log("Fetching climate indicators...")
    climate_by_id = era5_bulk_src.fetch_for_facilities(all_facilities)
    if not climate_by_id:
        if climate_source == "nasa-power":
            _log("  no local ERA5 bulk cache — using NASA POWER")
            climate_by_id = nasa_power_src.fetch_for_facilities(all_facilities, sample_stride=stride)
        else:
            _log("  no local ERA5 bulk cache — using Open-Meteo")
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
    ap.add_argument("--stride", type=int, default=None,
                    help="Override the auto-computed climate/AQ sample stride. "
                         "Lower = denser grid = more accurate but slower (more API fetches). "
                         "For NGA: default 100, finer 50 populates the SEVERE band properly.")
    ap.add_argument("--climate-source", choices=["open-meteo", "nasa-power"], default="open-meteo",
                    help="Which climate-history API to use. open-meteo (ERA5, default) is "
                         "higher resolution but throttles aggressively if you hammer it. "
                         "nasa-power (MERRA-2) is a drop-in fallback that's free + generous + "
                         "doesn't share Open-Meteo's daily quota.")
    args = ap.parse_args()
    try:
        build(args.country, limit=args.limit, fresh=args.fresh, full=args.full,
              stride_override=args.stride, climate_source=args.climate_source)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
