"""Flexible TPU-spine track: digital geometry and probes only, never TPU fatigue or physical hold-down."""
import math

import pytest
import trimesh

from cad.models import flex_track as F
from cad.service.generate import generate_part
from cad.service.plates import export_plates, plate_process, plate_style

BASE = {"connector_version": 1, "fit_adjustment": 0., "body_width": 63.8, "base_thickness": 3.2, "rail_gauge": 40,
        "rail_interface_width": 2.4, "rail_height": 6.4}


def strip(*segments, lite=False, **extra):
    """A level strip of (length, curvature) arcs."""
    p = {**BASE, "segments": len(segments), "z0": 0., "z1": 0., "grade0": 0., "grade1": 0., "vcurve": 0.,
         "cant0": 0., "cant1": 0., "ends": 3, **extra}
    for index, (length, k) in enumerate(segments):
        p.update({f"s{index}_len": float(length), f"s{index}_k0": k, f"s{index}_k1": k})
    return {**p, "lite": 1} if lite else p


def test_minimum_radius_comes_from_gauge_pitch_and_kerf():
    assert F.RMIN == F.RAIL * F.PITCH / F.KERF == 320


@pytest.mark.parametrize("p, message", [
    (strip((128, 1 / 300)), "no tighter than R320"),
    (strip((100, 0)), "whole number of 32 mm"),
    (strip((128, 0), ends=1), "connectors at both ends"),
    (strip((128, 0), z1=4., grade1=.0), "level"),
    (strip((128, 0), ballast=1), "no composite_track options"),
])
def test_rejects_strips_it_cannot_print_or_bend(p, message):
    with pytest.raises(ValueError, match=message):
        F.validate(p)


def test_installed_ports_follow_the_bent_shape_while_the_print_is_straight():
    p = strip((96, 1 / 320), (64, -1 / 640))
    start, end = F.ports(p)
    assert end["heading"] == pytest.approx(96 / 320 - 64 / 640)
    near, far = F.connector_ends(p)
    assert (far["x"], far["y"]) == pytest.approx((160, 0))
    assert far["heading"] == pytest.approx(math.pi) and near["heading"] == pytest.approx(0)
    rigid, spine, union, _ = F.parts(p)
    assert union.bounds[1, 0] - union.bounds[0, 0] < 160 + 8 and abs(union.bounds[:, 1]).max() < 32


@pytest.mark.parametrize("lite", [False, True])
def test_two_materials_are_watertight_disjoint_and_one_solid_together(lite):
    p = strip((128, 1 / 480), lite=lite)
    report = F.probe_materials(p)
    assert report["segments"] == report["expectedSegments"] == 5
    assert report["segmentsWatertight"] and report["spineWatertight"] and report["unionWatertight"]
    assert report["spineBodies"] == 1 and report["unionBodies"] == 1
    assert report["overlapMm3"] <= .001
    assert report["connectorEndChangeMm3"] == [0., 0.]
    roles = F.materials(p)
    assert [(role, slot) for role, slot, _ in roles] == [("rigid", 1), ("spine", 2)]


@pytest.mark.parametrize("lite", [False, True])
def test_probes_rails_kerfs_wheels_strain_and_keys(lite):
    p = strip((160, 1 / 320), lite=lite)
    assert F.probe_alignment(p)["maximumHeadOffsetMm"] <= .01
    kerfs = F.probe_kerfs(p)
    assert kerfs["straightRailKerfMm"] == pytest.approx(2., abs=.01)
    assert kerfs["innerMinMm"] >= -1e-3
    assert kerfs["outerRailMaxMm"] == pytest.approx(4., abs=.01)
    wheel = F.probe_wheel(p)
    assert wheel["railLineDipMm"] == pytest.approx(8.3 - math.sqrt(8.3 ** 2 - 4), abs=.01)
    strain = F.probe_strain(p)
    assert strain["peakStrain"] <= F.STRAIN_LIMIT
    assert min(F.probe_keys(p)["rivetsPerSegment"]) >= 2


def test_inner_rail_collides_below_the_minimum_radius():
    with pytest.raises(ValueError, match="kerfs at R300"):
        F.probe_kerfs(strip((96, 0)), radius=300)


def test_spine_stays_clear_of_the_baseplate_studs_under_every_tie():
    """Seated straight on a baseplate: studs (4.8 mm, 1.8 mm tall) at the +/-4 and +/-12 columns, 8 mm rows."""
    p = strip((128, 0))
    spine = F.parts(p)[1]
    studs = [trimesh.creation.cylinder(radius=2.4, height=1.8, sections=48,
                                       transform=trimesh.transformations.translation_matrix((x, y, .9)))
             for x in range(4, 128, 8) for y in (-12, -4, 4, 12)]
    hit = trimesh.boolean.intersection([spine, trimesh.boolean.union(studs, engine="manifold")], engine="manifold")
    assert not len(hit.faces) or hit.volume < 1e-6


def test_flex_parts_print_on_their_own_multi_material_plates():
    part = {"family": F.FAMILY, "parameters": strip((64, 0)), "materials": [{}, {}]}
    assert plate_style(part) == "flex" and plate_process("flex") == "detailed"
    assert plate_style({**part, "parameters": strip((64, 0), lite=True)}) == "flex-fast"
    assert plate_process("flex-fast") == "fast"
    assert plate_style({"family": "composite_track", "parameters": strip((64, 0))}) == "detailed"


def test_a1_mini_slices_a_strip_in_pla_and_tpu_without_warnings(tmp_path):
    printer = {"name": "A1 mini", "material": "Bambu PLA Basic", "profile": "0.20mm Standard @BBL A1M", "nozzleMm": .4,
               "orientation": "flat", "envelope": {"x": 180, "y": 180, "z": 180}}
    p = strip((64, 1 / 320), lite=True)
    made = generate_part({"version": 1, "units": "mm", "family": F.FAMILY, "parameters": p, "printer_envelope": printer["envelope"],
                          "part_revision": "t", "layout_revision": "t"}, tmp_path / "cad")
    part = {"instanceId": "flex-1", "code": "1", "name": "Flexible strip", "family": F.FAMILY, "parameters": p, "meshPath": made["mesh"], "bounds": made["bounds"],
            "ports": made["ports"], "materials": [{"role": m["role"], "filament": m["filament"], "meshPath": m["mesh"]}
                                                  for m in made["materials"]]}
    (tmp_path / "plates").mkdir()
    (plate,) = export_plates([part], printer, tmp_path / "plates")
    assert plate["filaments"] == ["Bambu PLA Basic @BBL A1M", "Bambu TPU for AMS @BBL A1M"]
    assert not plate["slice"].get("warning_message")
    assert all(row["total_used_g"] > 0 for row in plate["slice"]["filaments"])
    assert len(plate["objects"]) == 1 and len(plate["objects"][0]["materialLabels"]) == 2
