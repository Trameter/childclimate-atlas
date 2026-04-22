"""Unit tests for the GRID3 source adapter.

These are pure-function tests — they don't hit the network or require the
cached 36 MB raw GeoJSON to be present. They synthesize small fixtures so
a future regression in _normalize or dedup_against_osm surfaces fast.

Run:
    python3 -m pytest tests/test_grid3.py -v
"""
from __future__ import annotations

import pytest

from pipeline.sources import grid3


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
def _feat(lon, lat, **props):
    """Convenience builder for a GRID3 GeoJSON feature."""
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "facility_name": "Test PHC",
            "facility_level_option": "Primary Health Center",
            "state": "Kano",
            "lga": "Tarauni",
            "ward": "Gyadi-Gyadi Arewa",
            "ownership": "Public",
            "ownership_type": "Local Government",
            "geocoordinates_source": "NHFR_2024",
            "nhfr_uid": 12345,
            "nhfr_facility_code": "08/07/1/1/1/0030",
            **props,
        },
    }


# ---------------------------------------------------------------------------
# _normalize
# ---------------------------------------------------------------------------
class TestNormalize:
    def test_primary_health_center_maps_to_clinic(self):
        out = grid3._normalize([_feat(8.54, 11.98)])
        assert len(out) == 1
        assert out[0]["type"] == "clinic"

    def test_general_hospital_maps_to_hospital(self):
        out = grid3._normalize([_feat(8.54, 11.98, facility_level_option="General Hospital")])
        assert out[0]["type"] == "hospital"

    def test_teaching_hospital_with_nbsp_still_maps(self):
        # Real data ships with a non-breaking space in the taxonomy string
        out = grid3._normalize([_feat(8.54, 11.98, facility_level_option="Teaching/Tertiary\xa0Hospital")])
        assert out[0]["type"] == "hospital"

    def test_unknown_tier_is_dropped(self):
        # We refuse to guess. Unknown tier → not in output at all.
        out = grid3._normalize([_feat(8.54, 11.98, facility_level_option="Unknown")])
        assert out == []

    def test_out_of_nigeria_bbox_is_dropped(self):
        # Ghana coords — shouldn't survive
        out = grid3._normalize([_feat(-0.5, 7.5)])
        assert out == []

    def test_missing_name_falls_back(self):
        out = grid3._normalize([_feat(8.54, 11.98, facility_name=None)])
        assert out[0]["name"] == "Unnamed clinic"

    def test_admin_hierarchy_attached_as_osm_style_tags(self):
        out = grid3._normalize([_feat(8.54, 11.98)])[0]
        tags = out["tags"]
        assert tags["addr:state"] == "Kano"
        assert tags["addr:city"] == "Tarauni"   # LGA fits the UI city slot
        assert tags["ward"] == "Gyadi-Gyadi Arewa"
        assert tags["source"] == "grid3"

    def test_stable_id_uses_nhfr_uid(self):
        out = grid3._normalize([_feat(8.54, 11.98, nhfr_uid=98765)])[0]
        assert out["id"] == "grid3-clinic-98765"

    def test_empty_tags_are_stripped(self):
        out = grid3._normalize([_feat(8.54, 11.98, ownership=None, ownership_type=None)])[0]
        assert "ownership" not in out["tags"]
        assert "ownership_type" not in out["tags"]


# ---------------------------------------------------------------------------
# dedup_against_osm
# ---------------------------------------------------------------------------
class TestDedup:
    @staticmethod
    def _grid3(lon, lat, name="A"):
        return {
            "id": f"grid3-clinic-{name}", "lat": lat, "lon": lon,
            "name": name, "type": "clinic", "tags": {},
        }

    @staticmethod
    def _osm(lon, lat, name="B", type_="clinic"):
        return {
            "id": f"osm-{name}", "lat": lat, "lon": lon,
            "name": name, "type": type_, "tags": {},
        }

    def test_collocated_facility_is_dropped(self):
        # 0.5 m apart — clearly the same facility
        out = grid3.dedup_against_osm(
            [self._grid3(8.5421, 11.9871, "a")],
            [self._osm(8.5421, 11.9871, "b")],
            proximity_m=150.0,
        )
        assert out == []

    def test_facility_200m_away_survives(self):
        # 200m+ separation → treated as distinct facility
        out = grid3.dedup_against_osm(
            [self._grid3(8.5400, 11.9900, "a")],
            [self._osm(8.5500, 11.9900, "b")],  # ~1100m east
            proximity_m=150.0,
        )
        assert len(out) == 1

    def test_schools_in_osm_never_dedup_against_grid3(self):
        # GRID3 is health-only. An OSM school 5m away from a GRID3 PHC
        # is not a duplicate — they're different facility kinds.
        out = grid3.dedup_against_osm(
            [self._grid3(8.5421, 11.9871, "phc")],
            [self._osm(8.5421, 11.9871, "school", type_="school")],
            proximity_m=150.0,
        )
        assert len(out) == 1

    def test_spatial_index_handles_cell_boundaries(self):
        # Facility at a grid-cell edge — the 3x3 neighbor sweep must still
        # find an OSM hit just across the boundary.
        # Cell width ~220m at cell=0.002; nudge by 100m in both directions.
        out = grid3.dedup_against_osm(
            [self._grid3(8.5400 + 0.0009, 11.9900 + 0.0009, "a")],
            [self._osm(8.5400, 11.9900, "b")],
            proximity_m=200.0,
        )
        assert out == []  # found despite crossing into a neighboring cell
