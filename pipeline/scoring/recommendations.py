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
    "This facility experiences extreme heat (120+ days/year above 35°C). Solar-powered fans or evaporative coolers protect patients and maintain vaccine cold-chain integrity.",
    "2,000–5,000",
)
_rule(
    lambda c, a, f: c.get("heat_index_days", 0) >= 120 and f["type"] == "school",
    1, "Heat Resilience",
    "Install classroom cooling + hydration stations",
    "Students endure dangerously hot classrooms 120+ days/year. Solar fans, reflective roofing, and water stations reduce heat illness and absenteeism.",
    "1,500–4,000",
)
_rule(
    lambda c, a, f: 60 <= c.get("heat_index_days", 0) < 120,
    3, "Heat Resilience",
    "Add reflective roof coating + shade structures",
    "Moderate heat stress. Low-cost reflective coatings can reduce indoor temperatures by 5-8°C. Shade trees in schoolyards add protection.",
    "500–1,500",
)

# ---- Air quality rules ----
_rule(
    lambda c, a, f: a.get("pm25_avg_ugm3", 0) >= 50,
    1, "Air Quality",
    "Deploy air quality monitors + indoor filtration",
    "PM2.5 levels exceed 50 µg/m³ (10x WHO guideline). Children here face severe respiratory risk. HEPA filtration in patient wards and classrooms, plus a real-time AQ monitor to trigger alerts.",
    "1,000–3,000",
)
_rule(
    lambda c, a, f: 25 <= a.get("pm25_avg_ugm3", 0) < 50,
    2, "Air Quality",
    "Install basic air filtration + plant green barriers",
    "PM2.5 is 5-10x WHO guideline. Basic filtration in enclosed areas plus tree/hedge barriers to reduce roadside pollution.",
    "500–1,500",
)
_rule(
    lambda c, a, f: a.get("pm25_avg_ugm3", 0) >= 35 and f["type"] == "school",
    1, "Air Quality",
    "Establish clean-air classrooms + AQ alert protocol",
    "Children spend 6+ hours daily breathing unsafe air. Designate at least one filtered classroom as a clean-air refuge. Train staff on AQ alert days to keep children indoors.",
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
    "Clinics require reliable water for hygiene, sterilization, and patient care. A solar-powered borehole or UV purification unit provides drought-resilient supply.",
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
                    "description": desc,
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
