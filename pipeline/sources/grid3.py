"""GRID3 Nigeria Health Facilities v2.0 — supplementary source for NGA.

OSM coverage of Nigerian health infrastructure is uneven: many urban PHCs
are simply not tagged (confirmed real gaps include most facilities in
Tarauni LGA, Kano metro). GRID3 Nigeria Health Facilities v2.0 fills
these holes with:

- 51,022 facilities (vs our ~4K OSM health entries)
- 100% valid coordinates, GPS-validated by GRID3 against the 2024 NHFR
- Stable facility UIDs from the Nigeria Health Facility Registry
- LGA + ward already attached — no reverse-geocoding required

Source:  GRID3 / CIESIN Columbia University
License: CC BY 4.0  (https://creativecommons.org/licenses/by/4.0/)
Cite:    CIESIN, Columbia University 2024. GRID3 NGA - Health Facilities
         v2.0. https://doi.org/10.7916/kv1n-0743

Only active for iso3 == "NGA" and when sources.grid3 is true in the
country config. Other countries fall through to OSM-only as before.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

# ArcGIS Feature Service URL published by GRID3 / CIESIN.
FEATURE_SERVICE = (
    "https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/"
    "GRID3_NGA_health_facilities_v2_0/FeatureServer/0/query"
)
PAGE_SIZE = 2000          # ArcGIS hosted services cap at 2000 per request
REQUEST_TIMEOUT = 90

# GRID3's `facility_level_option` taxonomy → our two-bucket facility_type.
# PHCs / clinics / posts are mapped to "clinic" because that's the shape
# the scorer already understands. Higher-tier facilities become "hospital".
# Anything else (Unknown, etc.) is dropped rather than guessed — we don't
# want to score a facility whose type we can't justify.
_LEVEL_TO_TYPE: Dict[str, str] = {
    "Primary Health Center": "clinic",
    "Primary Health Clinic": "clinic",
    "Health Post": "clinic",
    "General Hospital": "hospital",
    "Teaching/Tertiary\xa0Hospital": "hospital",  # note: data ships with nbsp
    "Teaching/Tertiary Hospital": "hospital",
    "Specialized Hospital": "hospital",
}


# ----------------------------------------------------------------------------
# Download
# ----------------------------------------------------------------------------
def _fetch_page(offset: int) -> dict:
    """Fetch one page of the Feature Service as GeoJSON."""
    params = {
        "where": "1=1",
        "outFields": "*",
        "f": "geojson",
        "resultOffset": offset,
        "resultRecordCount": PAGE_SIZE,
        "returnGeometry": "true",
        "orderByFields": "OBJECTID",
    }
    url = f"{FEATURE_SERVICE}?{urllib.parse.urlencode(params)}"
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=REQUEST_TIMEOUT) as r:
                return json.loads(r.read())
        except Exception as e:  # pragma: no cover — network variability
            last_err = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f"GRID3 page fetch failed at offset {offset}: {last_err}")


def _download_all(cache_path: Path) -> List[dict]:
    """Page through the Feature Service and return all GeoJSON features.

    On-disk cache: a single consolidated GeoJSON. If it already exists we
    skip the network entirely. Delete the file to force a refresh.
    """
    if cache_path.exists():
        data = json.loads(cache_path.read_text())
        return data.get("features", [])

    features: List[dict] = []
    offset = 0
    while True:
        page = _fetch_page(offset)
        batch = page.get("features", [])
        features.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        time.sleep(0.3)  # polite pacing

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(
        {"type": "FeatureCollection", "features": features}
    ))
    return features


# ----------------------------------------------------------------------------
# Normalization to the internal facility shape
# ----------------------------------------------------------------------------
def _normalize(features: Iterable[dict]) -> List[Dict]:
    """Convert GRID3 records into the pipeline's canonical facility dict.

    The pipeline's scorer doesn't care where a facility came from — it only
    reads ``id``, ``lat``, ``lon``, ``name``, ``type`` and ``tags``. We map
    GRID3 fields into exactly that shape and encode the country admin
    hierarchy (state/LGA/ward) using OSM-style ``addr:*`` keys so the rest
    of the pipeline (state assignment, UI filters) reads them as if they
    came from OSM.
    """
    out: List[Dict] = []
    for f in features:
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if len(coords) != 2:
            continue
        lon, lat = coords
        if not (2.5 <= lon <= 14.8 and 4.0 <= lat <= 14.0):
            # Outside Nigeria's bbox — bad record, skip.
            continue

        p = f.get("properties") or {}
        level_opt = p.get("facility_level_option")
        ftype = _LEVEL_TO_TYPE.get(level_opt)
        if ftype is None:
            # Unknown tier — skip rather than guess. We'd rather undercount
            # than score a facility whose category is uncertain.
            continue

        name = (p.get("facility_name") or "").strip()
        if not name:
            name = f"Unnamed {ftype}"

        nhfr_uid = p.get("nhfr_uid")
        facility_code = p.get("nhfr_facility_code") or ""
        # Stable id across rebuilds: prefer the official UID, fall back to
        # the GRID3 globalid if missing, then OBJECTID as last resort.
        stable = (
            str(nhfr_uid) if nhfr_uid
            else (p.get("globalid") or str(p.get("OBJECTID") or ""))
        )
        fid = f"grid3-{ftype}-{stable}"

        tags = {
            "source": "grid3",
            "amenity": "clinic" if ftype == "clinic" else "hospital",
            "addr:state": p.get("state") or "",
            "addr:city": p.get("lga") or "",  # LGA fits the UI's "city" slot
            "ward": p.get("ward") or "",
            "facility_level": p.get("facility_level_option") or "",
            "ownership": p.get("ownership") or "",
            "ownership_type": p.get("ownership_type") or "",
            "coord_source": p.get("geocoordinates_source") or "",
            "nhfr_uid": str(nhfr_uid) if nhfr_uid else "",
            "nhfr_facility_code": facility_code,
        }
        # Drop empty-string tags so we don't pollute the output with noise
        tags = {k: v for k, v in tags.items() if v}

        out.append({
            "id": fid,
            "lat": lat,
            "lon": lon,
            "name": name,
            "type": ftype,
            "tags": tags,
        })
    return out


# ----------------------------------------------------------------------------
# Dedup vs a list of OSM-origin facilities
# ----------------------------------------------------------------------------
def _haversine_m(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    """Great-circle distance in metres between (lon, lat) pairs."""
    R = 6_371_000.0
    la1, la2 = radians(a[1]), radians(b[1])
    dla = la2 - la1
    dlo = radians(b[0] - a[0])
    h = sin(dla / 2) ** 2 + cos(la1) * cos(la2) * sin(dlo / 2) ** 2
    return 2 * R * asin(sqrt(h))


def dedup_against_osm(grid3: List[Dict], osm: List[Dict],
                      proximity_m: float = 150.0) -> List[Dict]:
    """Drop GRID3 facilities that duplicate an existing OSM entry.

    Spatial-grid indexing keeps this O(n) for N facilities. We use a 200m
    grid cell and check the facility's own cell plus 8 neighbors, which
    guarantees no false negatives for a 150m proximity test.

    Only health facilities in OSM are candidates — schools can't dedupe
    against GRID3, which is health-only.

    Name matching is intentionally NOT used. Many OSM entries are
    "Unnamed clinic" so the name would false-negative; GRID3 names often
    differ from OSM community tags even for the same facility. Spatial
    proximity is a stricter, more reliable signal.
    """
    # Spatial index: grid key -> list of (lon, lat) from OSM
    cell = 0.002  # ~220m at equator
    from collections import defaultdict
    index: Dict[Tuple[int, int], List[Tuple[float, float]]] = defaultdict(list)
    for o in osm:
        if o.get("type") not in ("clinic", "hospital"):
            continue
        lon, lat = o["lon"], o["lat"]
        index[(int(lon / cell), int(lat / cell))].append((lon, lat))

    kept: List[Dict] = []
    for g in grid3:
        lon, lat = g["lon"], g["lat"]
        kx, ky = int(lon / cell), int(lat / cell)
        duplicate = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for olon, olat in index.get((kx + dx, ky + dy), ()):
                    if _haversine_m((lon, lat), (olon, olat)) < proximity_m:
                        duplicate = True
                        break
                if duplicate:
                    break
            if duplicate:
                break
        if not duplicate:
            kept.append(g)
    return kept


# ----------------------------------------------------------------------------
# Public entrypoint
# ----------------------------------------------------------------------------
def fetch(config, cache: bool = True) -> List[Dict]:
    """Return the normalized, Nigeria-scoped GRID3 facility list.

    Returns an empty list for countries other than NGA, so callers can blindly
    concatenate without a guard.
    """
    if config.iso3.upper() != "NGA":
        return []
    cache_path = config.raw_dir / "grid3_nga_health_facilities_v2.geojson"
    raw = _download_all(cache_path)
    return _normalize(raw)
