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
    # Anchors recalibrated in v0.6.1 for the indoor heat-index methodology
    # (NOAA Rothfusz from T + dewpoint, no solar term — see era5_bulk.py
    # HEAT_INDEX_THRESHOLD_C docstring). At threshold 30°C indoor:
    #   - 0 days   = 0      (highland temperate climates)
    #   - 60 days  = 0.40   (seasonal hot spell)
    #   - 180 days = 0.70   (half-year tropical)
    #   - 300+     = 1.00   (Sahel, ASAL, near-year-round tropical)
    # Old anchors (0/30/90/180) were calibrated for Open-Meteo's outdoor
    # apparent_temperature_max with solar — at the new indoor methodology
    # those would saturate every tropical lowland at 1.0 and lose all
    # differentiation between "hot" and "extreme".
    return _piecewise(heat_index_days, [(0, 0), (60, 0.4), (180, 0.7), (300, 1.0)])


def flood_subscore(heavy_precip_days: float) -> float:
    # Anchors recalibrated in v0.6.2 — the original (30 days = 1.0) anchor
    # was over-conservative: nowhere in our 5 countries actually hits 30
    # heavy-precip days/yr in the multi-year ERA5 average. The result was
    # that flood-dominant Bangladesh's worst facility (PDB high school, 19
    # heavy days/yr) capped its flood subscore at 0.85, leaving its risk
    # score at 74.2 — one point under SEVERE — even with the concentration
    # bonus stacked on top. 25-day max is defensible: it's the actual upper
    # bound of observed extreme flood frequency, and past that the
    # marginal child-welfare risk plateaus (a facility that's already
    # perpetually inundated doesn't get linearly worse with more rain).
    # New anchors: 0=0, 5=0.4, 15=0.85, 25+=1.0.
    return _piecewise(heavy_precip_days, [(0, 0), (5, 0.4), (15, 0.85), (25, 1.0)])


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

    # Concentration bonus (v0.6) — surfaces facilities where ONE hazard is
    # extreme even if the others aren't. Without this, the pure additive
    # model misses monospecific extreme sites: KEN's Marsabit / Garissa /
    # Wajir schools post heat-index days >= 270/yr (heat subscore = 1.0)
    # and 90+ day dry runs (drought subscore = 0.81) but have negligible
    # flood + air pollution. The additive sum tops out around 70 — they
    # never reach SEVERE despite being unmistakably extreme on the two
    # hazards that actually apply to them.
    #
    # Formula: bonus = 0.10 * max_hazard * (max_hazard - mean_hazard)
    # - Big when ONE hazard dominates (KEN ASAL: 1.0 * (1.0 - 0.45) = 0.55)
    # - Small when hazards are evenly high (broadly-high site, near zero)
    # - Zero when no hazard is elevated
    # Only the 4 environmental hazards count, not vulnerability multipliers
    # (child_density, facility_fragility don't make a place "worse" — they
    # amplify exposure to actual hazards).
    HAZARD_KEYS = ("heat_exposure", "air_pollution", "flood_risk", "drought_risk")
    haz = [components[k] for k in HAZARD_KEYS]
    max_haz = max(haz)
    mean_haz = sum(haz) / len(haz)
    concentration_bonus = 0.10 * max_haz * (max_haz - mean_haz)
    raw_with_bonus = raw + concentration_bonus

    score = round(max(0.0, min(100.0, 100.0 * raw_with_bonus)), 1)

    # Top 3 contributing components (for the "why" explanation in the UI).
    # Concentration bonus listed separately so the UI can flag "this site
    # is severe because of a single extreme hazard" vs "stacked hazards".
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
        "concentration_bonus": round(100.0 * concentration_bonus, 2),
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
