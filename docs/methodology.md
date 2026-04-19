# Methodology — ChildClimate Risk Score v0.1

## Goal

Produce a transparent, auditable, reproducible 0–100 vulnerability score for every
health facility and school in a target country that reflects **how dangerous the
local climate is becoming for the children who depend on that facility**.

## Design principles

1. **Transparent over clever.** Every point in every score can be traced to a
   named input and a documented transformation. No black-box ML until we can
   justify it with labeled data.
2. **Global by default.** The same pipeline runs in any country by swapping the
   config. No country-specific manual work.
3. **Openly licensed inputs.** Current inputs are openly licensed so the model
   is reproducible by any ministry, NGO, or researcher.
4. **Explainable at the facility level.** The UI surfaces the top drivers for
   every facility so decision-makers understand *why* a site scored high.

## Inputs

| Indicator | Source | Resolution | License |
|---|---|---|---|
| Facility registry (clinics, hospitals, schools) | OSM via Overpass | Point | ODbL |
| Heat-stress days (apparent T ≥ 35 °C) | Open-Meteo / ERA5 | ~25 km | CC-BY |
| Heavy precipitation days (≥ 50 mm) | Open-Meteo / ERA5 | ~25 km | CC-BY |
| Longest dry streak (< 1 mm) | Open-Meteo / ERA5 | ~25 km | CC-BY |
| PM2.5 30-day mean | Copernicus CAMS | ~10 km | Open |
| NO₂ 30-day mean | Copernicus CAMS | ~10 km | Open |
| Child population share | UN DESA country-level (v0.1) → WorldPop (v0.2) | Country → 100 m | CC-BY |
| Facility fragility prior | Heuristic on OSM tags (v0.1) → facility audits (v0.2) | — | — |

## Scoring pipeline

### Step 1 — per-indicator sub-scores (0..1)

Each raw indicator is passed through a piecewise-linear curve anchored on
published health thresholds:

| Indicator | Anchor points (value → sub-score) | Rationale |
|---|---|---|
| Heat-stress days | 0→0, 30→0.5, 90→0.9, 180→1.0 | IPCC AR6 projections + child heat-illness literature |
| Heavy precip days | 0→0, 5→0.4, 15→0.8, 30→1.0 | Flash flood & WASH disruption thresholds |
| Longest dry run | 15→0, 45→0.4, 90→0.8, 150→1.0 | Meteorological drought classifications |
| PM2.5 | 5→0, 15→0.4, 35→0.8, 75→1.0 | WHO 2021 AQG + interim targets |
| NO₂ | 10→0, 25→0.4, 40→0.8, 80→1.0 | WHO 2021 AQG |
| Child density (share of U-18) | `min(1, share × 2)` | UN DESA country share as prior |
| Facility fragility | Type prior minus tag bonuses | Hospital 0.20, clinic 0.55, school 0.60 baseline |

Air pollution combines PM2.5 and NO₂ sub-scores in a 70/30 blend — PM2.5 has a
stronger established association with child respiratory mortality.

### Step 2 — weighted sum

```
score = 100 × Σ (w_i × subscore_i)
```

Weights are country-tuned and live in each country config file. They sum to 1.0.
Default Nigeria weights (Kano focus):

```yaml
heat_exposure:        0.25
air_pollution:        0.25
flood_risk:           0.15
drought_risk:         0.10
child_density:        0.15
facility_fragility:   0.10
```

These weights express a judgement: for Kano, heat and PM2.5 are the dominant
child-health threats, and flood is secondary. A Bangladesh config inverts this
(flood 0.30, heat 0.20) to match that country's dominant hazard.

### Step 3 — explanation

For each facility we also store:
- Every sub-score (for the breakdown bars in the UI)
- Every weighted contribution in points (so users can see *which* driver accounts for *how many* of the 0–100 points)
- The top 3 drivers (for a one-line summary)

## What's deliberately v0.1

We chose simple, defensible methods over sophistication that we can't yet justify.
The following are explicit roadmap items for upcoming releases:

1. **WorldPop child-population density** replacing UN DESA country shares.
   This moves child-density from a constant per country to a real per-pixel signal.
2. **Facility audit integration** — WHO SARA, UNICEF EMIS — replacing the
   OSM-tag fragility heuristic with real audit data on power, water, and structure.
3. **Flood exposure from JRC Global Flood Hazard maps** replacing heavy-precip
   days as a flood proxy.
4. **Calibration against historical events** — validate the score against
   documented child-health incidents (e.g. 2023 Kano heatwave mortality).
5. **Anticipatory action layer** — integrate ECMWF subseasonal forecasts so the
   score becomes a *leading* indicator, not just a climatology.

## Reproducibility

Every step is a small, typed Python function. Run:

```
python3 -m pipeline.build --country NGA
```

...and you get a byte-identical GeoJSON on any machine with the same cached
inputs, because there is no stochastic component in v0.1. This is deliberate:
reviewers and partners can audit the model end-to-end.
