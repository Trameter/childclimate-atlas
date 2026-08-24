"""Emit a compact per-country dot-preview binary next to each lite GeoJSON.

Why this exists: the Atlas's first paint was gated on downloading + parsing the
active country's lite GeoJSON (~6 MB gzipped, ~50 MB of JSON for Nigeria).
Measured cold on the live site, dots did not appear for ~29 seconds. For most
of that the page looks broken.

The map's first paint only needs three numbers per facility: longitude,
latitude, and risk_score (the dot colour is a `step` expression on
risk_score). That is 9 bytes per facility instead of a JSON object, so the
whole of Nigeria fits in ~1.4 MB and decodes with zero parsing.

The frontend paints these as a throwaway preview layer within a second or two,
then swaps in the real GeoJSON for names, filters, and clicks. See
paintPreviewDots() in web/assets/app.js.

Format (little-endian, no header beyond the count):
    [count uint32][lon float32 * count][lat float32 * count][score uint8 * count]

Run after a build:  python3 scripts/make_dot_previews.py
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

WEB_DATA = Path(__file__).resolve().parent.parent / "web" / "data"
ISOS = ["NGA", "BGD", "GTM", "KEN", "PHL"]


def build_one(iso3: str) -> str:
    src = WEB_DATA / f"{iso3}.lite.geojson"
    if not src.exists():
        return f"{iso3}: no lite geojson, skipped"

    with src.open() as fh:
        features = json.load(fh)["features"]

    lons: list[float] = []
    lats: list[float] = []
    scores: list[int] = []
    for f in features:
        coords = (f.get("geometry") or {}).get("coordinates")
        if not coords:
            continue
        score = f["properties"].get("risk_score")
        if score is None:
            continue
        lons.append(float(coords[0]))
        lats.append(float(coords[1]))
        # risk_score is 0-100, so it fits a byte. Clamped rather than trusted:
        # a stray out-of-range score would silently corrupt every later offset.
        scores.append(max(0, min(255, int(round(float(score))))))

    n = len(lons)
    out = WEB_DATA / f"{iso3}.dots.bin"
    with out.open("wb") as fh:
        fh.write(struct.pack("<I", n))
        fh.write(struct.pack(f"<{n}f", *lons))
        fh.write(struct.pack(f"<{n}f", *lats))
        fh.write(bytes(scores))

    kb = out.stat().st_size / 1024
    return f"{iso3}: {n:,} dots -> {out.name} ({kb:,.0f} KB)"


def main() -> None:
    for iso in ISOS:
        print(" ", build_one(iso), flush=True)


if __name__ == "__main__":
    main()
