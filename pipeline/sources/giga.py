"""GIGA UNICEF — supplementary school registry source.

GIGA (Connecting Every School) is a UNICEF + ITU initiative that maintains
a global registry of schools with connectivity, location, and operational
status data. Coverage skews heavily toward developing countries — the
exact gap our atlas focuses on. For countries like Bangladesh where OSM
has under-coverage, GIGA can add tens of thousands of schools.

This module mirrors the structure of pipeline.sources.healthsites:
  - Reads GIGA_API_KEY from .env via python-dotenv
  - Paginates the country-schools endpoint, normalises to our facility
    schema, caches at data/raw/{ISO}/giga.json
  - Graceful skip on missing key / auth failure / network failure
  - build.py merges + dedupes by lat/lon proximity (150m) against the
    existing OSM + Healthsites facility set

Get a free API key at https://giga.global/ (request via the contact form —
turnaround was same-day for the Healthsites equivalent). Drop it in .env as:
    GIGA_API_KEY=your_key_here

When the file is unsupplied or invalid, the build continues with OSM +
Healthsites only — the integration is opt-in, never blocking.
"""
from __future__ import annotations

import csv
import json
import os
import time
from pathlib import Path
from typing import Dict, List, Optional

import requests
from dotenv import load_dotenv

from ..config import RAW_DIR

load_dotenv()

# Bulk CSV ingestion lives next to the API path. Drop GIGA's UI download
# files (e.g. School_report_page_N_out_of_M_dated_*.csv) into this dir and
# they'll be picked up automatically by build.py via fetch_bulk_csvs(),
# preferred over the API. Same play as data/raw/healthsites/World.zip.
BULK_CSV_DIR = RAW_DIR / "giga"

# GIGA's modern API is served from this Azure-hosted backend. The
# canonical "api.giga.global" hostname has been intermittent in our probes;
# the Azure host is what the Swagger UI documents.
API_BASE = "https://uni-ooi-giga-maps-service.azurewebsites.net/api/v1"
USER_AGENT = "ChildClimate-Atlas/0.6 (https://climate-atlas.trameter.com)"
PAGE_SIZE = 1000   # GIGA caps at ~1000/page in our probes
REQUEST_TIMEOUT = 60
MAX_PAGES = 500    # safety cap — 500K schools per country

# GIGA filters by ISO3 directly — no name lookup needed.
SUPPORTED_ISOS = {"NGA", "BGD", "GTM", "KEN", "PHL"}


class KeyNotActive(Exception):
    """GIGA returned 401/403 — key invalid or awaiting approval. Same
    semantics as the Healthsites KeyNotActive — caller should bail with
    no partial data (since we'd fail on page 1 anyway)."""


def _api_key() -> Optional[str]:
    return os.environ.get("GIGA_API_KEY")


def _request_page(iso3: str, page: int, api_key: str) -> List[Dict]:
    """Hit one page of /api/v1/schools_location/country/{ISO3}."""
    url = f"{API_BASE}/schools_location/country/{iso3}"
    params = {"page": page, "size": PAGE_SIZE}
    headers = {
        "User-Agent": USER_AGENT,
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }
    for attempt in range(4):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=REQUEST_TIMEOUT)
            if r.status_code == 200:
                data = r.json()
                # GIGA returns either a list directly or {data: [...]}.
                if isinstance(data, list):
                    return data
                if isinstance(data, dict):
                    return data.get("data") or data.get("results") or []
                return []
            if r.status_code == 404:
                return []
            if r.status_code in (401, 403):
                detail = ""
                try:
                    detail = r.json().get("message") or r.json().get("detail") or ""
                except Exception:
                    detail = r.text[:200]
                raise KeyNotActive(detail or f"HTTP {r.status_code}")
            if r.status_code == 429:
                wait = 10 * (attempt + 1)
                print(f"    [giga] rate limited on page {page}, waiting {wait}s...", flush=True)
                time.sleep(wait)
                continue
            time.sleep(3 * (attempt + 1))
        except requests.RequestException as e:
            print(f"    [giga] page {page} attempt {attempt+1}: {e}", flush=True)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"GIGA page {page} failed after retries")


def _normalize(records: List[Dict]) -> List[Dict]:
    """Convert GIGA records to our standard facility dict.

    GIGA's school record fields vary by source country, but consistently
    include: school_id (or id), name, latitude, longitude, education_level.
    """
    out: List[Dict] = []
    for r in records:
        lat = r.get("latitude") or r.get("lat")
        lon = r.get("longitude") or r.get("lon") or r.get("lng")
        if lat is None or lon is None:
            continue
        try:
            lat = float(lat)
            lon = float(lon)
        except (ValueError, TypeError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        school_id = r.get("school_id") or r.get("id") or r.get("giga_id")
        if school_id is None:
            continue
        out.append({
            "id": f"school-giga-{school_id}",
            "lat": lat,
            "lon": lon,
            "name": r.get("name") or r.get("school_name") or f"Unnamed school",
            "type": "school",
            "tags": {
                "amenity": "school",
                "education_level": r.get("education_level") or "",
                "operator": r.get("operator") or r.get("admin_authority") or "",
                "source": "giga",
            },
        })
    return out


def fetch(config, cache: bool = True) -> List[Dict]:
    """Return the GIGA school list for `config.iso3`.

    Cached at data/raw/{ISO}/giga.json. Empty-list cached value is treated
    as a miss (mirrors the same pattern as facilities.py + healthsites.py).
    Silent skip if no API key or unsupported ISO3.
    """
    cache_path = config.raw_dir / "giga.json"
    if cache and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text())
            if cached:
                return cached
        except (json.JSONDecodeError, OSError):
            pass

    api_key = _api_key()
    if not api_key:
        print("  [giga] no GIGA_API_KEY in env — skipping (set it in .env to enrich "
              "with the GIGA school registry)", flush=True)
        return []

    iso3 = config.iso3.upper()
    if iso3 not in SUPPORTED_ISOS:
        print(f"  [giga] ISO3 {iso3} not in SUPPORTED_ISOS — skipping", flush=True)
        return []

    print(f"  [giga] fetching pages for {iso3}...", flush=True)
    all_records: List[Dict] = []
    for page in range(1, MAX_PAGES + 1):
        try:
            records = _request_page(iso3, page, api_key)
        except KeyNotActive as e:
            print(f"  [giga] key not active — skipping GIGA enrichment ({e})", flush=True)
            return []
        except RuntimeError as e:
            print(f"  [giga] {e} — stopping pagination, keeping {len(all_records)} records", flush=True)
            break
        if not records:
            break
        all_records.extend(records)
        if page == 1 or page % 5 == 0:
            print(f"    [giga] page {page}: +{len(records)} (running total {len(all_records)})", flush=True)
        time.sleep(0.2)
    else:
        print(f"  [giga] hit MAX_PAGES={MAX_PAGES} safety cap", flush=True)

    normalized = _normalize(all_records)
    print(f"  [giga] {len(all_records)} raw records → {len(normalized)} normalized schools", flush=True)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(normalized, indent=2))
    return normalized


def fetch_bulk_csvs(config) -> List[Dict]:
    """Read all CSVs in data/raw/giga/ and return facility records matching
    `config.iso3`. The directory may hold multiple countries' files
    side-by-side; the per-row "Country ISO3 Code" column is the filter.

    GIGA's UI bulk-download produces files like:
        School_report_page_1_out_of_6_dated_23052026_193813.csv
    Multiple pages per country; we glob all of them, dedupe by Giga UUID
    (the same school can appear in two pages if the user re-downloaded),
    and emit facility dicts in our standard shape.

    Returns [] if no CSVs are present or no rows match the requested ISO3
    — caller should fall through to the API path in fetch().

    Expected schema (case-sensitive headers, what the GIGA UI exports):
      School Giga ID, School Name, Longitude, Latitude,
      Education Level, Country ISO3 Code, Country Name, School Data Source
    """
    if not BULK_CSV_DIR.exists():
        return []
    target_iso = config.iso3.upper()
    seen_ids: set = set()
    facilities: List[Dict] = []
    csv_files = sorted(p for p in BULK_CSV_DIR.glob("*.csv") if not p.name.startswith("."))
    if not csv_files:
        return []
    for csv_path in csv_files:
        try:
            # newline='' is correct for csv.DictReader on macOS — handles
            # any line-ending convention without splitting embedded newlines
            # in quoted fields.
            with open(csv_path, "r", encoding="utf-8", newline="") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    if (row.get("Country ISO3 Code") or "").strip().upper() != target_iso:
                        continue
                    giga_id = (row.get("School Giga ID") or "").strip()
                    if not giga_id or giga_id in seen_ids:
                        continue
                    seen_ids.add(giga_id)
                    try:
                        lat = float((row.get("Latitude") or "").strip())
                        lon = float((row.get("Longitude") or "").strip())
                    except ValueError:
                        continue
                    # Reject 0,0 (often a missing-data sentinel in school
                    # registries) and any nonsensical coords.
                    if abs(lat) < 1e-6 and abs(lon) < 1e-6:
                        continue
                    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                        continue
                    name = (row.get("School Name") or "").strip() or "Unnamed school"
                    edu_level = (row.get("Education Level") or "").strip().lower()
                    source_label = (row.get("School Data Source") or "").strip() or "GIGA UNICEF"
                    tags: Dict[str, str] = {
                        "amenity": "school",
                        "source": source_label,
                    }
                    if edu_level:
                        # Map GIGA's "Primary" / "Pre-Primary" / "Secondary"
                        # to OSM-style isced:level for downstream filters.
                        tags["isced:level"] = edu_level
                    facilities.append({
                        # "school-giga-" prefix mirrors "school-node-N" / "clinic-way-N"
                        # so the dedupe-by-id pass in build.py handles GIGA-vs-OSM
                        # collisions even when the same school shows up in both.
                        # In practice OSM IDs and GIGA UUIDs never collide so this
                        # is purely for shape consistency; spatial dedup is the
                        # real overlap filter (dedup_against_existing).
                        "id": f"school-giga-{giga_id}",
                        "lat": lat,
                        "lon": lon,
                        "name": name,
                        "type": "school",
                        "tags": tags,
                    })
        except (OSError, csv.Error) as e:
            print(f"  [giga] failed to read {csv_path.name}: {e}", flush=True)
            continue
    if facilities:
        print(f"  [giga] bulk CSV: {len(csv_files)} file(s) → {len(facilities):,} {target_iso} schools (deduped by Giga UUID)", flush=True)
    return facilities


def dedup_against_existing(giga_facilities: List[Dict], existing: List[Dict],
                           proximity_m: float = 150.0) -> List[Dict]:
    """Drop GIGA records that sit within `proximity_m` of an existing
    facility (OSM, Healthsites, GRID3). Same logic GRID3 uses for NGA.

    Implementation: simple O(N*M) for now — atlas-scale facility counts
    (<100k per country) make this fine. Switch to a spatial index if
    perf becomes an issue.
    """
    import math
    METERS_PER_DEG_LAT = 111_320.0
    deg_tol_sq = (proximity_m / METERS_PER_DEG_LAT) ** 2  # degrees², approx

    kept = []
    for g in giga_facilities:
        glat, glon = g["lat"], g["lon"]
        meters_per_deg_lon = METERS_PER_DEG_LAT * math.cos(math.radians(glat))
        if meters_per_deg_lon < 1:  # near the poles
            meters_per_deg_lon = 1
        deg_tol_lon_sq = (proximity_m / meters_per_deg_lon) ** 2
        clash = False
        for e in existing:
            if e.get("type") != "school":
                continue  # GIGA is school-only, dedup against schools only
            elat, elon = e["lat"], e["lon"]
            if (elat - glat) ** 2 > deg_tol_sq:
                continue
            if (elon - glon) ** 2 > deg_tol_lon_sq:
                continue
            clash = True
            break
        if not clash:
            kept.append(g)
    return kept
