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
#
# Two query templates — one per OSM tag namespace. OSM evolved two parallel
# schemas for health facilities:
#   * the older `amenity=clinic|hospital|doctors|pharmacy` schema
#   * the newer `healthcare=*` schema (clinic, hospital, doctor, dispensary,
#     health_post, midwife, pharmacy, alternative, nurse, …)
# Many facilities are tagged in only ONE schema, so we have to query both.
# We batch all values of a single tag into one regex-OR query per tag (vs
# 14 separate queries per tile) — Overpass handles regex matching natively
# and a single query is dramatically faster + politer than the alternative.
OVERPASS_AMENITY_TEMPLATE = """
[out:json][timeout:{timeout}];
(
  node["amenity"~"^({values})$"]({south},{west},{north},{east});
  way["amenity"~"^({values})$"]({south},{west},{north},{east});
);
out center tags;
"""

OVERPASS_HEALTHCARE_TEMPLATE = """
[out:json][timeout:{timeout}];
(
  node["healthcare"~"^({values})$"]({south},{west},{north},{east});
  way["healthcare"~"^({values})$"]({south},{west},{north},{east});
);
out center tags;
"""

# Values per tag namespace. School-adjacent amenities (kindergarten, childcare)
# count as schools for our purposes because they serve children with formal
# care/education programming — heat stress, air pollution, and flood
# exposure threaten them the same way they threaten a primary school.
AMENITY_VALUES = ["clinic", "hospital", "doctors", "school", "kindergarten", "childcare"]
HEALTHCARE_VALUES = [
    "clinic", "hospital", "doctor", "dispensary", "health_post",
    "midwife", "nurse", "pharmacy", "alternative",
]


def _overpass_query(bbox: List[float], tag_key: str, values: List[str]) -> dict:
    """Run a single regex-OR Overpass query for all values of one tag key."""
    west, south, east, north = bbox
    template = (OVERPASS_AMENITY_TEMPLATE if tag_key == "amenity"
                else OVERPASS_HEALTHCARE_TEMPLATE)
    query = template.format(
        timeout=REQUEST_TIMEOUT - 10,
        values="|".join(values),
        south=south, west=west, north=north, east=east,
    )
    # Overpass can be rate-limited; retry with exponential backoff.
    # Overpass now 406s requests with the default 'python-requests/...' UA
    # (anti-scraping measure added in 2025/26). A descriptive UA identifies
    # the project + gives the operators a way to contact us if our load
    # ever becomes a problem — also it's the Overpass etiquette norm.
    headers = {
        "User-Agent": "ChildClimate-Atlas/0.4 (https://climate-atlas.trameter.com)",
    }
    for attempt in range(5):
        try:
            resp = requests.post(
                OVERPASS_URL, data={"data": query},
                headers=headers, timeout=REQUEST_TIMEOUT,
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
    raise RuntimeError(f"Overpass query failed for tag={tag_key}")


# Map raw OSM tag values to our three internal facility_type categories.
# School-adjacent amenities (kindergarten, childcare) become "school" because
# the climate-risk model treats them identically — children in the building
# for hours per day, same heat/air/flood exposure profile. Pharmacies +
# alternative practitioners are categorized as "clinic" because they're
# primary-care touchpoints in countries with thin formal health systems.
TAG_VALUE_TO_FTYPE = {
    # amenity=*
    ("amenity", "clinic"): "clinic",
    ("amenity", "hospital"): "hospital",
    ("amenity", "doctors"): "clinic",
    ("amenity", "school"): "school",
    ("amenity", "kindergarten"): "school",
    ("amenity", "childcare"): "school",
    # healthcare=* (newer OSM schema)
    ("healthcare", "clinic"): "clinic",
    ("healthcare", "hospital"): "hospital",
    ("healthcare", "doctor"): "clinic",
    ("healthcare", "dispensary"): "clinic",
    ("healthcare", "health_post"): "clinic",
    ("healthcare", "midwife"): "clinic",
    ("healthcare", "nurse"): "clinic",
    ("healthcare", "pharmacy"): "clinic",
    ("healthcare", "alternative"): "clinic",
}


def _infer_ftype(tags: Dict) -> str:
    """Pick the facility_type from an element's tags. Prefers `amenity` over
    `healthcare` when both are set (the older tag is usually more specific
    and reliable; the newer schema sometimes over-tags pharmacies as
    'hospital' which would distort our hospital count)."""
    for key in ("amenity", "healthcare"):
        v = tags.get(key)
        if v and (key, v) in TAG_VALUE_TO_FTYPE:
            return TAG_VALUE_TO_FTYPE[(key, v)]
    return "clinic"  # fallback — shouldn't fire since we only fetch matching tags


def _normalize(elements: List[dict]) -> List[Dict]:
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
        facility_type = _infer_ftype(tags)
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
        cached = json.loads(cache_path.read_text())
        # Don't honor an empty list as a valid cached value — that's almost
        # always a poisoned cache from a previous Overpass failure (every
        # tile threw, target_list stayed empty, the wrap got persisted).
        # Treat empty as cache-miss so the next run actually re-fetches.
        if cached:
            return cached
        print(f"  [facilities] cache at {cache_path} is empty (likely a previous "
              f"Overpass failure) — ignoring + re-fetching", flush=True)

    bbox = config.focus_bbox
    # Split large bboxes into tiles
    tiles = _split_bbox(bbox)
    print(f"  [facilities] querying {len(tiles)} tile(s) for bbox {bbox}", flush=True)

    # Collect raw elements across all tiles + both tag schemas. Dedupe
    # happens after normalization (an element tagged both amenity=clinic
    # and healthcare=clinic appears in BOTH queries — same OSM id either
    # way, so dedupe-by-id collapses the duplicate).
    elements_all: List[dict] = []

    for i, tile in enumerate(tiles):
        print(f"  [facilities] tile {i+1}/{len(tiles)}: {tile}", flush=True)
        for tag_key, values in [("amenity", AMENITY_VALUES),
                                ("healthcare", HEALTHCARE_VALUES)]:
            try:
                result = _overpass_query(tile, tag_key, values)
                elements_all.extend(result.get("elements", []))
                print(f"    {tag_key}: {len(result.get('elements', []))} found", flush=True)
            except Exception as e:
                print(f"    {tag_key}: FAILED ({e})", flush=True)
            time.sleep(1)  # be polite to Overpass between queries

    normalized = _normalize(elements_all)

    # Dedupe by id. An element tagged in both `amenity` and `healthcare`
    # schemas (common for newer OSM contributions) is returned by both
    # queries with the same OSM id; we keep one copy. _infer_ftype prefers
    # `amenity` over `healthcare` so dedupe-by-id is order-stable.
    seen = set()
    facilities: List[Dict] = []
    for f in normalized:
        if f["id"] in seen:
            continue
        seen.add(f["id"])
        facilities.append(f)

    by_type: Dict[str, int] = {}
    for f in facilities:
        by_type[f["type"]] = by_type.get(f["type"], 0) + 1
    summary = ", ".join(f"{v} {k}s" for k, v in sorted(by_type.items()))
    print(f"  [facilities] {len(facilities)} unique facilities after dedupe ({summary})",
          flush=True)

    cache_path.write_text(json.dumps(facilities, indent=2))
    return facilities
