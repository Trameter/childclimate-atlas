"""Facility-level action recommendations.

For each scored facility, generate 2-3 specific, actionable interventions
ranked by urgency. These map directly to UNICEF's climate adaptation toolkit
categories so country officers see familiar language.

The recommendations are rule-based (not LLM) for reproducibility and auditability.
"""
from __future__ import annotations

from typing import Dict, List, Tuple


# Each recommendation = (condition_fn, priority 1-5, category, title, description, est_cost_usd)
# Priority: 1 = most urgent
RECOMMENDATION_RULES: List[Tuple] = []


def _rule(fn, priority, category, title, desc, cost):
    RECOMMENDATION_RULES.append((fn, priority, category, title, desc, cost))


# ---- Heat rules ----
_rule(
    lambda c, a, f: c.get("heat_index_days", 0) >= 120 and f["type"] in ("clinic", "hospital"),
    1, "Heat Resilience",
    "Install solar-powered cooling",
    "This facility experiences extreme heat ({heat_days} days/year above 35°C). Solar-powered fans or evaporative coolers protect patients and maintain vaccine cold-chain integrity.",
    "2,000–5,000",
)
_rule(
    lambda c, a, f: c.get("heat_index_days", 0) >= 120 and f["type"] == "school",
    1, "Heat Resilience",
    "Install classroom cooling + hydration stations",
    "Students endure dangerously hot classrooms {heat_days} days/year. Solar fans, reflective roofing, and water stations reduce heat illness and absenteeism.",
    "1,500–4,000",
)
_rule(
    lambda c, a, f: 60 <= c.get("heat_index_days", 0) < 120,
    3, "Heat Resilience",
    "Add reflective roof coating + shade structures",
    "Moderate heat stress ({heat_days} days/year above 35°C). Low-cost reflective coatings can reduce indoor temperatures by 5-8°C. Shade trees in schoolyards add protection.",
    "500–1,500",
)

# ---- Air quality rules ----
_rule(
    lambda c, a, f: a.get("pm25_avg_ugm3", 0) >= 50,
    1, "Air Quality",
    "Deploy air quality monitors + indoor filtration",
    "PM2.5 averages {pm25} µg/m³ ({pm25_x_who}× the WHO 2021 annual guideline of 5 µg/m³). Children here face severe respiratory risk. HEPA filtration in patient wards and classrooms, plus a real-time AQ monitor to trigger alerts.",
    "1,000–3,000",
)
_rule(
    lambda c, a, f: 25 <= a.get("pm25_avg_ugm3", 0) < 50,
    2, "Air Quality",
    "Install basic air filtration + plant green barriers",
    "PM2.5 averages {pm25} µg/m³ ({pm25_x_who}× the WHO 2021 annual guideline of 5 µg/m³). Basic filtration in enclosed areas plus tree/hedge barriers to reduce roadside pollution.",
    "500–1,500",
)
# Lower-tier PM2.5 rec for the 12–25 µg/m³ range (still 2-5x the WHO 2021
# annual guideline of 5 µg/m³). The previous floor of 25 left a real gap:
# facilities with PM2.5 around 18 µg/m³ were getting flagged as "PM2.5 is
# a top driver" in plain English but receiving zero air-quality rec.
_rule(
    lambda c, a, f: 10 <= a.get("pm25_avg_ugm3", 0) < 25,
    3, "Air Quality",
    "Add HEPA filters in patient/learning areas",
    "PM2.5 averages {pm25} µg/m³ ({pm25_x_who}× the WHO 2021 annual guideline of 5 µg/m³). Even moderate exposure compounds pediatric respiratory load over years. Affordable HEPA units in the most-occupied rooms is the cheapest intervention with measurable impact.",
    "300–800",
)
_rule(
    lambda c, a, f: a.get("pm25_avg_ugm3", 0) >= 35 and f["type"] == "school",
    1, "Air Quality",
    "Establish clean-air classrooms + AQ alert protocol",
    "Children spend 6+ hours daily breathing air at {pm25} µg/m³ ({pm25_x_who}× WHO guideline). Designate at least one filtered classroom as a clean-air refuge. Train staff on AQ alert days to keep children indoors.",
    "800–2,000",
)

# ---- Flood rules ----
_rule(
    lambda c, a, f: c.get("heavy_precip_days", 0) >= 10,
    1, "Flood Resilience",
    "Raise critical infrastructure + install drainage",
    "This area experiences frequent flash flooding (10+ extreme-rain days/year). Raise medical supply storage, install perimeter drainage, and waterproof essential records.",
    "3,000–8,000",
)
_rule(
    lambda c, a, f: 3 <= c.get("heavy_precip_days", 0) < 10,
    3, "Flood Resilience",
    "Develop flood preparedness plan + supply pre-positioning",
    "Moderate flood risk. Create an evacuation plan, pre-position emergency medical supplies above flood line, and establish communication protocols with regional health office.",
    "200–500",
)

# ---- Drought rules ----
_rule(
    lambda c, a, f: c.get("longest_dry_run_days", 0) >= 90,
    2, "Water Security",
    "Install rainwater harvesting + water storage",
    "Extended drought (90+ consecutive dry days). Rainwater collection during wet season plus sealed storage tanks ensures the facility can maintain WASH services year-round.",
    "1,500–4,000",
)
_rule(
    lambda c, a, f: c.get("longest_dry_run_days", 0) >= 60 and f["type"] in ("clinic", "hospital"),
    2, "Water Security",
    "Add borehole or water purification system",
    "{dry_days}-day longest dry run this year. Clinics require reliable water for hygiene, sterilization, and patient care. A solar-powered borehole or UV purification unit provides drought-resilient supply.",
    "3,000–8,000",
)

# ---- Fragility rules ----
_rule(
    lambda c, a, f: f["type"] == "clinic" and not f.get("tags", {}).get("operator"),
    3, "Facility Strengthening",
    "Conduct facility vulnerability audit",
    "This clinic has no recorded operator and limited structural data. A physical audit (power, water, structure, staffing) would unlock targeted upgrades and accurate risk modeling.",
    "100–300",
)
_rule(
    lambda c, a, f: f["type"] == "school",
    4, "Early Warning",
    "Install school-based early warning system",
    "Connect to national meteorological service for SMS/radio alerts. Train teachers on heat, flood, and air quality response protocols. Designate safe assembly points.",
    "200–500",
)


def _format_desc(desc: str, climate: Dict, air: Dict) -> str:
    """Interpolate facility-specific numbers into rec description strings.

    Descriptions use named placeholders ({heat_days}, {pm25}, etc.) so each
    rec speaks to THIS facility's actual values, not a generic rule
    threshold. Missing keys fall back to safe defaults so a description
    without any placeholders still works.
    """
    pm25 = air.get("pm25_avg_ugm3", 0) or 0
    no2 = air.get("no2_avg_ugm3", 0) or 0
    return desc.format(
        heat_days=climate.get("heat_index_days", "—"),
        precip_days=climate.get("heavy_precip_days", "—"),
        dry_days=climate.get("longest_dry_run_days", "—"),
        pm25=f"{pm25:.1f}" if pm25 else "—",
        pm25_x_who=f"{pm25 / 5:.1f}" if pm25 else "—",
        no2=f"{no2:.1f}" if no2 else "—",
        pm25_hours=air.get("pm25_exceed_hours_30d", "—"),
    )


def recommend(facility: Dict, climate: Dict, air: Dict, max_recs: int = 3) -> List[Dict]:
    """Return up to `max_recs` recommendations for this facility, ranked by priority."""
    matches = []
    for fn, priority, category, title, desc, cost in RECOMMENDATION_RULES:
        try:
            if fn(climate, air, facility):
                matches.append({
                    "priority": priority,
                    "category": category,
                    "title": title,
                    "description": _format_desc(desc, climate, air),
                    "estimated_cost_usd": cost,
                })
        except Exception:
            continue

    # Sort by priority (lowest = most urgent), deduplicate by category
    matches.sort(key=lambda r: r["priority"])
    seen_categories = set()
    unique = []
    for r in matches:
        if r["category"] not in seen_categories:
            unique.append(r)
            seen_categories.add(r["category"])
        if len(unique) >= max_recs:
            break
    return unique
