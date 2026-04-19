"""Child Climate Risk Score (0-100).

Methodology (v0.1):
  1. Each hazard indicator is normalized to a 0-1 sub-score using a country-tuned
     piecewise-linear curve anchored on WHO / IPCC / UNICEF CCRI thresholds.
  2. Facility fragility is a structural prior based on facility type & tags.
  3. Child-population weight is a fixed multiplier (country-level under-18 share
     — will be replaced with WorldPop per-pixel density in the next iteration).
  4. Final score = 100 * sum(weight_i * subscore_i), clamped to [0, 100].

The model is deliberately transparent and hand-auditable — no black-box ML.
Any reviewer can trace every point in every score back to a source.
"""
from __future__ import annotations

from typing import Dict, List, Tuple


# -------- sub-score curves (normalized to 0..1) --------

def _piecewise(value: float, stops: List[Tuple[float, float]]) -> float:
    """Piecewise linear: stops = [(x0, y0), (x1, y1), ...], monotonic in x."""
    if value <= stops[0][0]:
        return stops[0][1]
    if value >= stops[-1][0]:
        return stops[-1][1]
    for (x0, y0), (x1, y1) in zip(stops, stops[1:]):
        if x0 <= value <= x1:
            if x1 == x0:
                return y1
            t = (value - x0) / (x1 - x0)
            return y0 + t * (y1 - y0)
    return stops[-1][1]


def heat_subscore(heat_index_days: float) -> float:
    # Anchors: 0 days = 0, 30 days = 0.5, 90 days = 0.9, 180+ = 1.0.
    return _piecewise(heat_index_days, [(0, 0), (30, 0.5), (90, 0.9), (180, 1.0)])


def flood_subscore(heavy_precip_days: float) -> float:
    # Anchors: 0 = 0, 5 = 0.4, 15 = 0.8, 30+ = 1.0.
    return _piecewise(heavy_precip_days, [(0, 0), (5, 0.4), (15, 0.8), (30, 1.0)])


def drought_subscore(longest_dry_run_days: float) -> float:
    # Anchors: 15 = 0, 45 = 0.4, 90 = 0.8, 150+ = 1.0.
    return _piecewise(longest_dry_run_days, [(15, 0), (45, 0.4), (90, 0.8), (150, 1.0)])


def pm25_subscore(pm25_avg: float) -> float:
    # WHO 2021 guideline: 5 µg/m³ annual. IT-1 interim: 35.
    # Anchors: 5 = 0, 15 = 0.4, 35 = 0.8, 75+ = 1.0.
    return _piecewise(pm25_avg, [(5, 0), (15, 0.4), (35, 0.8), (75, 1.0)])


def no2_subscore(no2_avg: float) -> float:
    # WHO 2021 annual NO2: 10 µg/m³.
    return _piecewise(no2_avg, [(10, 0), (25, 0.4), (40, 0.8), (80, 1.0)])


def air_pollution_subscore(pm25_avg: float, no2_avg: float) -> float:
    # Blend 70/30 PM2.5/NO2 — PM2.5 has stronger child mortality association.
    return 0.7 * pm25_subscore(pm25_avg) + 0.3 * no2_subscore(no2_avg)


def facility_fragility_subscore(facility: Dict) -> float:
    """Structural vulnerability prior based on facility type & tags.

    Until we wire a facility-audit dataset, we use a heuristic:
      - Hospitals tend to be more resilient than clinics.
      - Schools are structurally fragile for child services.
      - Unknown operator = higher fragility prior.
    """
    ftype = facility.get("type", "")
    tags = facility.get("tags", {}) or {}
    base = {
        "hospital": 0.20,
        "clinic": 0.55,
        "school": 0.60,
    }.get(ftype, 0.5)

    if tags.get("operator"):
        base -= 0.05
    if tags.get("building") in {"yes", "school", "hospital"}:
        base -= 0.05
    return max(0.0, min(1.0, base))


def child_density_subscore(under_18_share: float) -> float:
    """Country-level child share as a proxy until WorldPop is wired.
    Nigeria ~0.47 -> ~0.94, Bangladesh ~0.33 -> ~0.66, Guatemala ~0.41 -> ~0.82.
    """
    return min(1.0, under_18_share * 2)


# -------- top-level scorer --------

def score_facility(
    facility: Dict,
    climate: Dict,
    air: Dict,
    under_18_share: float,
    weights: Dict[str, float],
) -> Dict:
    """Return a dict with the final score and full breakdown for one facility."""
    heat = heat_subscore(climate.get("heat_index_days", 0))
    flood = flood_subscore(climate.get("heavy_precip_days", 0))
    drought = drought_subscore(climate.get("longest_dry_run_days", 0))
    air_sc = air_pollution_subscore(
        air.get("pm25_avg_ugm3", 0),
        air.get("no2_avg_ugm3", 0),
    )
    fragility = facility_fragility_subscore(facility)
    child = child_density_subscore(under_18_share)

    components = {
        "heat_exposure": heat,
        "air_pollution": air_sc,
        "flood_risk": flood,
        "drought_risk": drought,
        "child_density": child,
        "facility_fragility": fragility,
    }

    raw = sum(weights[k] * components[k] for k in weights)
    score = round(max(0.0, min(100.0, 100.0 * raw)), 1)

    # Top 3 contributing components (for the "why" explanation in the UI).
    contributions = sorted(
        (
            (k, round(100.0 * weights[k] * components[k], 1))
            for k in weights
        ),
        key=lambda kv: kv[1],
        reverse=True,
    )

    return {
        "score": score,
        "components": {k: round(v, 3) for k, v in components.items()},
        "contributions": contributions,
        "top_drivers": [k for k, _ in contributions[:3]],
    }


def score_all(
    facilities: List[Dict],
    climate_by_id: Dict[str, Dict],
    air_by_id: Dict[str, Dict],
    under_18_share: float,
    weights: Dict[str, float],
) -> List[Dict]:
    """Return the facilities list with `risk` attached to each."""
    from .recommendations import recommend

    out = []
    for f in facilities:
        climate = climate_by_id.get(f["id"], {})
        air = air_by_id.get(f["id"], {})
        risk = score_facility(f, climate, air, under_18_share, weights)
        recs = recommend(f, climate, air)
        enriched = dict(f)
        enriched["risk"] = risk
        enriched["risk"]["recommendations"] = recs
        enriched["climate"] = climate
        enriched["air"] = air
        out.append(enriched)
    return out
