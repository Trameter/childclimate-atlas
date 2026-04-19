"""Country config loading.

Configs live in config/{ISO3}.yaml. Keeping this in one place so every
source module and the scorer read the same normalized shape.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = REPO_ROOT / "config"
DATA_DIR = REPO_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"


@dataclass
class CountryConfig:
    iso3: str
    iso2: str
    name: str
    bbox: List[float]                 # [west, south, east, north]
    focus_bbox: List[float]
    focus_name: str
    under_18_share: float
    sources: Dict[str, bool]
    scoring_weights: Dict[str, float]

    @property
    def raw_dir(self) -> Path:
        d = RAW_DIR / self.iso3
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def processed_dir(self) -> Path:
        d = PROCESSED_DIR / self.iso3
        d.mkdir(parents=True, exist_ok=True)
        return d


def load_country(iso3: str) -> CountryConfig:
    path = CONFIG_DIR / f"{iso3.upper()}.yaml"
    if not path.exists():
        raise FileNotFoundError(
            f"No config for {iso3}. Create {path} using config/NGA.yaml as a template."
        )
    raw = yaml.safe_load(path.read_text())
    weights = raw["scoring_weights"]
    total = sum(weights.values())
    if abs(total - 1.0) > 0.01:
        raise ValueError(f"{iso3} scoring_weights must sum to 1.0, got {total}")
    return CountryConfig(
        iso3=raw["country"]["iso3"],
        iso2=raw["country"]["iso2"],
        name=raw["country"]["name"],
        bbox=raw["bbox"],
        focus_bbox=raw["focus_region"]["bbox"],
        focus_name=raw["focus_region"]["name"],
        under_18_share=raw["population"]["under_18_share"],
        sources=raw["sources"],
        scoring_weights=weights,
    )
