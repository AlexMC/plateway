"""Rotary dumper: rails lined up upright, a 6-wide train through, a clear 150° sweep, stops and wagon retention,
published plan, printable end-on components and the assembly-service contract."""
import math

import numpy as np
import pytest

from cad.models import rotary_dumper as rd
from cad.service.assemblies import expand_components, validate_assembly
from cad.service.generate import generate_part
from cad.service.plates import _end_on, plate_style

FAMILY = "rotary_dumper"


def parameters(span=128, drive=0, state=0, lite=False):
    return {"connector_version": 1, "fit_adjustment": 0., "state": state, "span": span, "drive": drive,
            **({"lite": 1} if lite else {})}


SHAPES = [(128, 0), (160, 1), (128, 2)]


@pytest.mark.parametrize("span, drive", SHAPES)
def test_upright_rails_meet_both_landings_within_tolerance(span, drive):
    for row in rd.probe_alignment(FAMILY, parameters(span, drive)):
        assert row["worstLateralMm"] <= .3 and row["worstVerticalMm"] <= .3


@pytest.mark.parametrize("span, drive", SHAPES)
def test_a_six_wide_train_runs_through_the_upright_cradle(span, drive):
    report = rd.probe_running(FAMILY, parameters(span, drive))
    assert report["body"]["overlapMm3"] <= .01 and report["body"]["minGapMm"] >= .9
    assert report["flange corridors"]["overlapMm3"] <= .01
    assert report["deckUnderFlangeMm"] >= .5


@pytest.mark.parametrize("span, drive", SHAPES)
def test_the_cradle_sweeps_to_150_degrees_clear_of_stands_bearings_pinion_and_table(span, drive):
    report = rd.probe_motion(FAMILY, parameters(span, drive))
    assert report["travel"] == [0., 150.] and report["maxOverlapMm3"] <= .01 and report["lowestMm"] >= 1.


def test_the_cradle_turns_about_its_axis_without_leaving_the_ring_circle():
    """Every cradle point stays inside the ring radius, so no pose reaches lower than the ring's own bottom."""
    g = rd.geometry_of(FAMILY, parameters())
    cradle = rd._trimesh(rd._cradle(g))
    radius = np.hypot(cradle.vertices[:, 1], cradle.vertices[:, 2] - rd.AXIS_Z)
    assert radius.max() <= rd.R_MAX + 1e-4
    assert rd.AXIS_Z - rd.R_MAX >= 2.


@pytest.mark.parametrize("span, drive", SHAPES)
def test_stops_hold_both_positions_and_the_wagon_cannot_fall_out_at_any_angle(span, drive):
    report = rd.probe_retention(FAMILY, parameters(span, drive))
    assert all(row["held"] for row in report["stops"])
    assert {row["push"] for row in report["stops"]} >= {"back past the stop (-1°)", "past the stop (+1°)", "+x", "-x"}
    assert [row["angleDeg"] for row in report["wagon"]][-1] == 150.
    assert report["worstFallMm"] <= 2. and math.isfinite(report["cagedEveryDirectionWithinMm"])


def test_the_wagon_leans_on_the_ledges_past_90_degrees():
    """Tipped past vertical, gravity lifts the wagon off its wheels onto the rim ledges, 1 mm above it."""
    g = rd.geometry_of(FAMILY, parameters())
    cradle, load = rd._cradle(g), rd.wagon(g)
    assert rd._free_travel(load, cradle, (0., 0., 1.)) == pytest.approx(rd.LG_TOP - rd.WAGON_TOP, abs=.06)


@pytest.mark.parametrize("span, drive", SHAPES)
def test_moving_and_fixed_parts_stay_inside_the_published_plan(span, drive):
    report = rd.probe_envelopes(FAMILY, parameters(span, drive))
    assert report["outsideAreaMm2"] <= .5 and report["fixedOutsideOutlineMm2"] <= .5


@pytest.mark.parametrize("span, drive", SHAPES)
@pytest.mark.parametrize("lite", [False, True])
def test_every_component_is_one_watertight_solid_within_the_mini_build_volume(span, drive, lite):
    p = parameters(span, drive, lite=lite)
    rows = rd.components(FAMILY, p)
    roles = [row["role"] for row in rows]
    assert roles[:2] == ["landing-in", "landing-out"] and roles[-2:] == ["mechanism-cradle", "mechanism-ring-out"]
    assert ("mechanism-crank" in roles) == (drive == 0)
    for row in rows:
        role, solid = rd._rows(rd._logical(row["parameters"]))[row["parameters"]["component_index"]]
        rd.check_mesh(role, rd._trimesh(solid), rd.end_on(row["parameters"]))
        assert rd.end_on(row["parameters"]) == role.startswith("mechanism-")


@pytest.mark.parametrize("changes, message", [
    ({"span": 120}, "from 128"), ({"span": 132}, "multiple of 8"), ({"span": 168}, "to 160"),
    ({"drive": 3}, "drive"), ({"state": 2}, "state"),
])
def test_invalid_parameters_are_rejected(changes, message):
    with pytest.raises(ValueError, match=message):
        rd.validate(FAMILY, {**parameters(), **changes})


def test_only_upright_opens_the_route():
    assert rd.route_pairs(FAMILY, parameters(state=0)) == {frozenset(("in", "out")): True}
    assert rd.route_pairs(FAMILY, parameters(state=1)) == {frozenset(("in", "out")): False}
    ends = {row["id"]: row["position"][0] for row in rd.ports(FAMILY, parameters(span=160))}
    assert ends == {"in": 0., "out": 256.}


def _instance(p):
    pairs = rd.route_pairs(FAMILY, p)
    return {"id": "dumper-1", "family": FAMILY, "source": "printed", "parameters": p, "interfaceKind": "track-assembly",
            "pose": {"x": 0, "y": 0, "z": 0, "heading": 0, "pitch": 0},
            "ports": [{"id": r["id"], "pose": {"x": r["position"][0], "y": 0, "z": 0, "heading": r["heading"], "pitch": 0.},
                       "profile": "brick", "railGauge": 40, "interfaceWidth": 2.4} for r in rd.ports(FAMILY, p)],
            "paths": [{"id": "main", "from": "in", "to": "out", "enabled": on} for _, on in pairs.items()],
            "part_revision": "test", "layout_revision": "test"}


def test_the_assembly_service_prints_the_same_parts_upright_and_tipped(tmp_path):
    upright, tipped = parameters(lite=True), parameters(state=1, lite=True)
    for p in (upright, tipped):
        validate_assembly(_instance(p))
    rows = expand_components([_instance(upright)])
    assert [row["parameters"] for row in rows] == [row["parameters"] for row in expand_components([_instance(tipped)])]
    styles = {row["componentRole"]: plate_style(row) for row in rows}
    assert styles["landing-in"] == "fast" and styles["mechanism-cradle"] == "detailed"
    ring = next(row for row in rows if row["componentRole"] == "mechanism-ring-out")
    assert _end_on(ring)
    result = generate_part({"version": 1, "units": "mm", "family": ring["family"], "parameters": ring["parameters"],
                            "printer_envelope": {"x": 180, "y": 180, "z": 180}, "part_revision": "t", "layout_revision": "t"},
                           tmp_path)
    assert result["bounds"]["size"][0] < 20 and max(result["bounds"]["size"][1:]) <= rd.BED


def test_hardware_lists_the_bought_parts():
    hand = " ".join(row["name"] for row in rd.hardware(FAMILY, parameters(drive=0)))
    motor = " ".join(row["name"] for row in rd.hardware(FAMILY, parameters(drive=1)))
    ir = " ".join(row["name"] for row in rd.hardware(FAMILY, parameters(drive=2)))
    assert "608" in hand and "16 tooth" in hand and "magnet" in hand and "motor" not in hand
    assert "88013" in motor
    assert "88003" in ir and "88013" not in ir and "16 tooth" in ir
    assert rd.assembly_notes(FAMILY, parameters())


@pytest.mark.parametrize("drive", [1, 2])
def test_the_motor_sits_clear_on_its_plate_and_drives_the_pinion_axle(drive):
    report = rd.probe_motor(FAMILY, parameters(160, drive))
    # The LDraw case (and its keep-out box) misses both stands, the bearings, the pinion and the cradle at every angle.
    assert report["caseOverlapMm3"] == 0 and report["keepoutOverlapMm3"] == 0
    assert report["pinsOnPlateGrid"] and report["pinHoleMaterialMm3"] == 0 and report["bearingMaterialMm3"] == 0
    assert report["output"] == {"pinionAxleOffsetMm": 0., "alongPinionAxle": True}
    # 16T pinion on the module-1 ring gear: pitch centres plus the backlash, each tip clear of the other's root.
    mesh = report["mesh"]
    assert mesh["centresMm"] == pytest.approx(mesh["pitchCentresMm"] + mesh["backlashMm"], abs=1e-6)
    assert mesh["pinionTipToRingRootMm"] > 0 and mesh["ringTipToPinionRootMm"] > 0
    # Same plan as the Bluetooth drive: the published outline (TS dumperOutline) serves both motors.
    assert rd.outline(FAMILY, parameters(160, 2)) == rd.outline(FAMILY, parameters(160, 1))
