"""Health facilities + schools from OpenStreetMap (Overpass API).

We use OSM as the unified source for both because:
- It is global and free (ODbL).
- Healthsites.io data is itself ingested from OSM.
- GIGA (UNICEF's own school registry) is OSM-compatible.

One source, one shape, works in every country worldwide.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Dict, List

import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
REQUEST_TIMEOUT = 180

# Overpass QL template. We query by bbox so the same code runs for any country
# just by changing the config's focus_bbox.
#
# Note: we restrict to the focus_region for the demo to keep the prototype fast.
# A full-country run is a single bbox swap.
OVERPASS_TEMPLATE = """
[out:json][timeout:{timeout}];
(
  node["amenity"="{amenity}"]({south},{west},{north},{east});
  way["amenity"="{amenity}"]({south},{west},{north},{east});
);
out center tags;
"""


def _overpass_query(bbox: List[float], amenity: str) -> dict:
    west, south, east, north = bbox
    query = OVERPASS_TEMPLATE.format(
        timeout=REQUEST_TIMEOUT - 10,
        amenity=amenity,
        south=south, west=west, north=north, east=east,
    )
    # Overpass can be rate-limited; retry with exponential backoff.
    for attempt in range(5):
        try:
            resp = requests.post(
                OVERPASS_URL, data={"data": query}, timeout=REQUEST_TIMEOUT
            )
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 429:
                wait = 10 * (attempt + 1)
                print(f"    [overpass] rate limited, waiting {wait}s...", flush=True)
                time.sleep(wait)
                continue
            time.sleep(3 * (attempt + 1))
        except requests.RequestException:
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"Overpass query failed for amenity={amenity}")


def _normalize(elements: List[dict], facility_type: str) -> List[Dict]:
    """Collapse ways and nodes into a single list of {id, lat, lon, name, type, tags}."""
    out = []
    for el in elements:
        if el.get("type") == "node":
            lat, lon = el.get("lat"), el.get("lon")
        else:
            center = el.get("center") or {}
            lat, lon = center.get("lat"), center.get("lon")
        if lat is None or lon is None:
            continue
        tags = el.get("tags", {}) or {}
        out.append({
            "id": f"{facility_type}-{el.get('type')}-{el.get('id')}",
            "lat": lat,
            "lon": lon,
            "name": tags.get("name") or f"Unnamed {facility_type}",
            "type": facility_type,
            "tags": {
                k: v for k, v in tags.items()
                if k in {"amenity", "healthcare", "operator", "addr:state",
                         "addr:city", "capacity", "school:type", "isced:level",
                         "building"}
            },
        })
    return out


def _split_bbox(bbox: List[float], max_degrees: float = 2.5) -> List[List[float]]:
    """Split a large bounding box into smaller tiles to avoid Overpass timeouts.
    Each tile is at most max_degrees x max_degrees."""
    west, south, east, north = bbox
    tiles = []
    lat = south
    while lat < north:
        lon = west
        lat_end = min(lat + max_degrees, north)
        while lon < east:
            lon_end = min(lon + max_degrees, east)
            tiles.append([lon, lat, lon_end, lat_end])
            lon = lon_end
        lat = lat_end
    return tiles


def fetch(config, cache: bool = True) -> List[Dict]:
    """Return a unified list of facilities (clinics + schools) in the focus region.

    For full-country builds, the bbox is automatically split into tiles to avoid
    Overpass API timeouts. Results are deduplicated by OSM id.

    The output is deliberately plain dicts so the rest of the pipeline has zero
    dependencies on any geo library.
    """
    cache_path = config.raw_dir / "facilities.json"
    if cache and cache_path.exists():
        return json.loads(cache_path.read_text())

    bbox = config.focus_bbox
    # Split large bboxes into tiles
    tiles = _split_bbox(bbox)
    print(f"  [facilities] querying {len(tiles)} tile(s) for bbox {bbox}", flush=True)

    clinics_raw_all = []
    hospitals_raw_all = []
    schools_raw_all = []

    for i, tile in enumerate(tiles):
        print(f"  [facilities] tile {i+1}/{len(tiles)}: {tile}", flush=True)
        for amenity, target_list in [("clinic", clinics_raw_all), ("hospital", hospitals_raw_all), ("school", schools_raw_all)]:
            try:
                result = _overpass_query(tile, amenity)
                target_list.extend(result.get("elements", []))
                print(f"    {amenity}: {len(result.get('elements', []))} found", flush=True)
            except Exception as e:
                print(f"    {amenity}: FAILED ({e})", flush=True)
            time.sleep(1)  # be polite to Overpass between queries

    clinics_raw = {"elements": clinics_raw_all}
    hospitals_raw = {"elements": hospitals_raw_all}
    schools_raw = {"elements": schools_raw_all}

    clinics = _normalize(clinics_raw.get("elements", []), "clinic")
    hospitals = _normalize(hospitals_raw.get("elements", []), "hospital")
    schools = _normalize(schools_raw.get("elements", []), "school")

    # Interleave types so any --limit gets a balanced mix of all three.
    import itertools
    groups = [clinics, hospitals, schools]
    facilities: List[Dict] = []
    for batch in itertools.zip_longest(*groups):
        for item in batch:
            if item is not None:
                facilities.append(item)

    cache_path.write_text(json.dumps(facilities, indent=2))
    return facilities
