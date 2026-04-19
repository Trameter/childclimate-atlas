"""Reverse geocode facilities to assign admin1 (state/division/department).

Uses the reverse_geocoder library which has a built-in dataset of admin
boundaries for every country. No API calls, runs entirely offline,
handles thousands of points in seconds.
"""
from __future__ import annotations

from typing import Dict, List

import reverse_geocoder as rg


def assign_states(facilities: List[Dict], country_iso2: str = "") -> List[Dict]:
    """Add 'admin1' (state/region) to each facility's tags based on its coordinates.

    If country_iso2 is provided (e.g. "NG"), facilities that geocode to a
    different country are filtered out. This prevents border-spillover from
    neighboring countries when the OSM bbox extends beyond national borders.
    """
    if not facilities:
        return facilities

    coords = [(f["lat"], f["lon"]) for f in facilities]

    print(f"  [geocode] reverse geocoding {len(coords)} facilities...", flush=True)
    results = rg.search(coords, mode=1)

    # Assign geocode results and store country code
    for f, geo in zip(facilities, results):
        tags = f.get("tags", {}) or {}
        tags["cc"] = geo.get("cc", "")
        state = geo.get("admin1", "")
        if state:
            tags["admin1"] = state
            if not tags.get("addr:state"):
                tags["addr:state"] = state
        admin2 = geo.get("admin2", "")
        if admin2:
            tags["admin2"] = admin2
        city = geo.get("name", "")
        if city and not tags.get("addr:city"):
            tags["addr:city"] = city
        f["tags"] = tags

    # Filter out facilities in neighboring countries
    if country_iso2:
        before = len(facilities)
        facilities = [f for f in facilities if f.get("tags", {}).get("cc") == country_iso2]
        dropped = before - len(facilities)
        if dropped:
            print(f"  [geocode] filtered out {dropped} cross-border facilities (kept {len(facilities)} in {country_iso2})", flush=True)

    # Nearest-neighbor fallback for facilities where admin1 is empty
    unassigned = [f for f in facilities if not f.get("tags", {}).get("admin1")]
    assigned_list = [f for f in facilities if f.get("tags", {}).get("admin1")]
    if unassigned and assigned_list:
        print(f"  [geocode] {len(unassigned)} facilities missing admin1, assigning from nearest neighbor...", flush=True)
        for f in unassigned:
            best_dist = float("inf")
            best_state = "Unknown"
            for a in assigned_list:
                d = (f["lat"] - a["lat"])**2 + (f["lon"] - a["lon"])**2
                if d < best_dist:
                    best_dist = d
                    best_state = a["tags"]["admin1"]
            f["tags"]["admin1"] = best_state
            if not f["tags"].get("addr:state"):
                f["tags"]["addr:state"] = best_state

    assigned = sum(1 for f in facilities if f.get("tags", {}).get("admin1"))
    print(f"  [geocode] final: {assigned}/{len(facilities)} facilities with state assigned", flush=True)

    return facilities
