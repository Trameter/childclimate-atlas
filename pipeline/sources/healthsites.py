"""Healthsites.io — supplementary health-facility source.

Healthsites.io is a global, curated facility registry maintained by Kartoza
in partnership with the Global Healthsites Mapping Project. It ingests OSM
data and accepts manual contributions from health workers, hospital
administrators, and NGOs. The result: a slightly larger and more curated
set than raw OSM Overpass for many countries.

This module fetches the country's full facility list, normalizes it to the
same shape used by pipeline.sources.facilities, and is intended to be merged
with the Overpass results upstream (dedupe-by-id catches the overlap; the
unique-to-Healthsites facilities become net additions).

Requires:
  HEALTHSITES_API_KEY in environment (or .env at the project root).
  Get a key by creating an account at https://healthsites.io/ — the key
  appears in your profile page under 'API Access'. The free tier is fine
  for our pull volume.
"""
from __future__ import annotations

import json
import os
import time
from typing import Dict, List, Optional

import requests
from dotenv import load_dotenv

from ..config import RAW_DIR

# Load .env once at import time. The project root is the cwd when build.py
# runs, so this resolves correctly without needing an explicit path.
load_dotenv()

API_BASE = "https://healthsites.io/api/v3/facilities/"
USER_AGENT = "ChildClimate-Atlas/0.5 (https://climate-atlas.trameter.com)"
PAGE_SIZE_HINT = 100  # Healthsites paginates ~100/page (their default)
REQUEST_TIMEOUT = 60
MAX_PAGES = 500     # safety cap — at 100/page that's 50k facilities/country

# Country-name lookup. The Healthsites API filters by country NAME, not ISO
# code, so we map our atlas's ISO3 codes to the names the API expects. Names
# match the country-list returned by their /api/v3/countries/ endpoint.
ISO3_TO_HEALTHSITES_NAME = {
    "NGA": "Nigeria",
    "BGD": "Bangladesh",
    "GTM": "Guatemala",
    "KEN": "Kenya",
    "PHL": "Philippines",
}

# Map raw Healthsites tag values to our three internal facility_type categories.
# Healthsites uses the same OSM `amenity` and `healthcare` schemas (the data
# is OSM-derived after all), so we re-use the same vocabulary. Kept here as a
# standalone constant rather than importing from facilities.py so this module
# can stand alone for testing.
TAG_VALUE_TO_FTYPE = {
    "clinic": "clinic",
    "hospital": "hospital",
    "doctor": "clinic",
    "doctors": "clinic",
    "dispensary": "clinic",
    "health_post": "clinic",
    "midwife": "clinic",
    "nurse": "clinic",
    "pharmacy": "clinic",
    "alternative": "clinic",
}


def _api_key() -> Optional[str]:
    """Look up the API key from env, including a freshly-loaded .env."""
    return os.environ.get("HEALTHSITES_API_KEY")


def _infer_ftype(attrs: Dict) -> str:
    """Pick facility_type from Healthsites attributes (mirrors OSM schema).
    Preference: amenity > healthcare. Default 'clinic' since Healthsites
    is a health-facility registry — anything they return is health-coded.
    """
    for key in ("amenity", "healthcare"):
        v = (attrs or {}).get(key)
        if v in TAG_VALUE_TO_FTYPE:
            return TAG_VALUE_TO_FTYPE[v]
    return "clinic"


def _normalize(records: List[Dict]) -> List[Dict]:
    """Convert Healthsites response records to our standard facility dict.

    Skips records with missing coordinates or missing OSM type/id (we use
    those for stable cross-source IDs).
    """
    out: List[Dict] = []
    for r in records:
        # The API gives us a `centroid` GeoJSON point — coordinates are [lon, lat].
        centroid = r.get("centroid") or {}
        coords = centroid.get("coordinates") if isinstance(centroid, dict) else None
        if not coords or len(coords) < 2:
            continue
        lon, lat = coords[0], coords[1]
        if lat is None or lon is None:
            continue

        osm_type = r.get("osm_type")
        osm_id = r.get("osm_id")
        if not osm_type or osm_id is None:
            continue

        attrs = r.get("attributes") or {}
        ftype = _infer_ftype(attrs)
        # ID matches the format used by pipeline.sources.facilities so
        # dedupe-by-id collapses any overlap between the two sources.
        fid = f"{ftype}-{osm_type}-{osm_id}"
        out.append({
            "id": fid,
            "lat": lat,
            "lon": lon,
            "name": attrs.get("name") or r.get("name") or f"Unnamed {ftype}",
            "type": ftype,
            "tags": {
                k: v for k, v in attrs.items()
                if k in {"amenity", "healthcare", "operator", "addr:state",
                         "addr:city", "capacity", "building", "source"}
            },
        })
    return out


class KeyNotActive(Exception):
    """Healthsites returned 401/403 with an auth/approval problem — key is
    invalid or awaiting admin approval. Signals the caller to abort the
    whole fetch and DISCARD partial data (there is no partial data — we
    failed on page 1)."""


class DailyCapExhausted(Exception):
    """Healthsites returned 403 with a 'too many requests today' message.
    Distinct from KeyNotActive because the key IS valid and we may have
    already accumulated many pages of data — the caller should KEEP those,
    just stop paginating. Resets the next calendar day per Healthsites."""


def _request_page(country_name: str, page: int, api_key: str) -> List[Dict]:
    """Hit one page of /api/v3/facilities/ with retry on transient errors."""
    params = {
        "country": country_name,
        "api-key": api_key,
        "page": page,
    }
    headers = {"User-Agent": USER_AGENT}
    for attempt in range(4):
        try:
            r = requests.get(API_BASE, params=params, headers=headers,
                             timeout=REQUEST_TIMEOUT)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                # Past last page — Healthsites returns 404 for empty pages.
                return []
            if r.status_code in (401, 403):
                # 403 from Healthsites covers THREE different conditions
                # and we have to peek at the body to know which:
                #   1. Key invalid              → abort, no partial data
                #   2. Awaiting admin approval  → abort, no partial data
                #   3. Daily request cap hit    → STOP, but caller keeps
                #                                 whatever pages already
                #                                 accumulated. If we
                #                                 discard them, that's
                #                                 4,000 NGA records gone
                #                                 (the actual outage from
                #                                 the v0.5 first run).
                detail = ""
                try:
                    detail = r.json().get("detail", "")
                except Exception:
                    detail = r.text[:200]
                lowered = (detail or "").lower()
                if ("limit" in lowered and ("per day" in lowered or "today" in lowered)) \
                        or "daily" in lowered:
                    raise DailyCapExhausted(detail or f"HTTP {r.status_code}")
                raise KeyNotActive(detail or f"HTTP {r.status_code}")
            if r.status_code == 429:
                wait = 10 * (attempt + 1)
                print(f"    [healthsites] rate limited on page {page}, waiting {wait}s...", flush=True)
                time.sleep(wait)
                continue
            # Other non-200 — back off + retry
            time.sleep(3 * (attempt + 1))
        except requests.RequestException as e:
            print(f"    [healthsites] page {page} attempt {attempt+1}: {e}", flush=True)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"Healthsites page {page} failed after retries")


def fetch(config, cache: bool = True) -> List[Dict]:
    """Return the full Healthsites facility list for `config.iso3`.

    Cache at data/raw/{ISO}/healthsites.json. Empty-list cached value is
    treated as a miss (mirrors the facilities.py poisoned-cache fix). If no
    API key is configured, returns [] silently so the rest of the pipeline
    keeps working without Healthsites enrichment.
    """
    cache_path = config.raw_dir / "healthsites.json"
    if cache and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text())
            if cached:
                return cached
        except (json.JSONDecodeError, OSError):
            pass

    api_key = _api_key()
    if not api_key:
        print("  [healthsites] no HEALTHSITES_API_KEY in env — skipping (set "
              "it in .env to enrich with Healthsites.io)", flush=True)
        return []

    country_name = ISO3_TO_HEALTHSITES_NAME.get(config.iso3.upper())
    if not country_name:
        print(f"  [healthsites] no country-name mapping for ISO3 {config.iso3} "
              "— skipping", flush=True)
        return []

    print(f"  [healthsites] fetching pages for {country_name}...", flush=True)
    all_records: List[Dict] = []
    quota_exhausted_mid_pull = False
    for page in range(1, MAX_PAGES + 1):
        try:
            records = _request_page(country_name, page, api_key)
        except DailyCapExhausted as e:
            # Daily request cap hit mid-pagination (Healthsites free tier is
            # 50/day). KEEP the pages already accumulated — they get
            # normalized + cached + returned below. Without this branch,
            # the NGA pull on 2026-05-22 would discard 4,000 records.
            print(f"  [healthsites] daily cap hit on page {page} — keeping {len(all_records)} records collected so far ({e})", flush=True)
            quota_exhausted_mid_pull = True
            break
        except KeyNotActive as e:
            # Key never approved or invalid — no records collected yet.
            # Return [] and skip caching so the next build can retry once
            # admin approval lands.
            print(f"  [healthsites] key not active — skipping Healthsites enrichment ({e})", flush=True)
            return []
        except RuntimeError as e:
            # Network retries exhausted on a specific page. Better to keep
            # the pages we did collect than throw the whole pull away.
            print(f"  [healthsites] {e} — stopping pagination, keeping {len(all_records)} records", flush=True)
            break
        if not records:
            # Empty page = past the end (Healthsites returns [] OR 404 there).
            break
        all_records.extend(records)
        if page == 1 or page % 10 == 0:
            print(f"    [healthsites] page {page}: +{len(records)} (running total {len(all_records)})",
                  flush=True)
        # Polite pacing — Healthsites is generous but no need to hammer.
        time.sleep(0.2)
    else:
        print(f"  [healthsites] hit MAX_PAGES={MAX_PAGES} safety cap", flush=True)

    normalized = _normalize(all_records)
    print(f"  [healthsites] {len(all_records)} raw records → {len(normalized)} normalized facilities", flush=True)

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(normalized, indent=2))
    return normalized
