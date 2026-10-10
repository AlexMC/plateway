"""Uncoupler track: digital geometry and mechanism probes only, never physical fit or coupler catch."""
import math

import pytest

from cad.models import hardware as hw
from cad.models import uncoupler as U
from cad.service import assemblies
from cad.service.generate import _validate
from cad.service.plates import _side_on, plate_style

FAMILY = U.FAMILIES[0]


def params(drive=0, state=0, **extra):
    return {"connector_version": 1, "fit_adjustment": 0, "drive": drive, "switch_state": state, **extra}


def _instance(p):
    pose = {"x": 200., "y": 80., "z": 0., "heading": -.4, "pitch": 0.}
    c, s = math.cos(pose["heading"]), math.sin(pose["heading"])
    return {
        "id": "u1", "family": FAMILY, "source": "printed", "parameters": p, "pose": pose,
        "interfaceKind": "track-assembly", "part_revision": "r1", "layout_revision": "l1",
        "ports": [{"id": port["id"], "profile": "brick", "railGauge": 40., "interfaceWidth": 2.4,
                   "pose": {"x": pose["x"] + port["position"][0]*c - port["position"][1]*s,
                            "y": pose["y"] + port["position"][0]*s + port["position"][1]*c, "z": 0.,
                            "heading": pose["heading"] + port["heading"], "pitch": 0.}} for port in U.ports(FAMILY, p)],
        "paths": [{"id": "main", "from": "in", "to": "out", "enabled": p["switch_state"] == 0}],
    }


@pytest.mark.parametrize("drive", [0, 1])
def test_flap_is_flush_lowered_stands_above_the_rails_raised_and_leaves_both_ports_untouched(drive):
    report = U.probes(FAMILY, params(drive))
    assert report["motion"]["maximumInterferenceMm3"] <= .01
    assert report["flush"]["loweredTopMm"] <= U.STUD_TOP and report["flush"]["aboveStudTopsMm3"] == 0
    assert report["flush"]["raisedAboveRailTopMm"] >= 8
    low, high = report["flush"]["raisedSpanYMm"]
    assert low < 0 < high and max(-low, high) < U.CORRIDOR
    assert [row["flangeObstructionMm3"] for row in report["running"]] == [0, 0]
    assert all(row["maximumUnsupportedSpanMm"] <= 4 for row in report["running"])
    assert all(row["blockedVolumeMm3"] > 1 for row in report["retention"])
    assert report["envelopes"]["movingOutsideMm3"] <= .01 and report["envelopes"]["fixedOutsideMm3"] <= .01
    assert all(max(row["lostMm3"], row["addedMm3"]) <= .005 for row in report["contacts"])
    assert all(max(row["planMm"]) <= U.T.BED for row in report["parts"])
    if drive == 0:
        assert [row["axisOffsetMm"] <= .5 for row in report["detents"]] == [True, True]
    else:
        servo = report["servo"]
        # Opposite horn directions for the two states, both inside the SG90's ±25° budget.
        assert servo["hornLoweredDeg"]*servo["hornRaisedDeg"] < 0
        assert max(abs(servo["hornLoweredDeg"]), abs(servo["hornRaisedDeg"])) <= 25
        assert servo["trainEnvelopeMm3"] == 0 and servo["maximumInterferenceMm3"] <= .01


def test_fast_print_keeps_the_mechanism_and_every_part_stays_one_bed_sized_solid():
    for drive in (0, 1):
        detailed, lite = U.component_meshes(drive, 0., False), U.component_meshes(drive, 0., True)
        assert [role for role, _ in lite] == [role for role, _ in detailed]
        assert all(a is b for (_, a), (_, b) in zip(lite[1:], detailed[1:]))
        assert lite[0][1].volume < detailed[0][1].volume
        U.probe_parts(drive, 0., True)
        assert U.probe_motion(drive, 0., True, steps=5)["maximumInterferenceMm3"] <= .01


def test_the_route_runs_only_while_the_flap_is_lowered():
    assert U.route_pairs(FAMILY, params(state=0)) == {frozenset(("in", "out")): True}
    assert U.route_pairs(FAMILY, params(state=1)) == {frozenset(("in", "out")): False}
    for bad in ({"drive": 2}, {"switch_state": 2}, {"lite": 0}, {"sprung": 0}):
        with pytest.raises(ValueError):
            U.validate(FAMILY, {**params(), **bad})


@pytest.mark.parametrize("drive,state", [(0, 1), (1, 0), (1, 1)])
def test_assembly_service_validates_routing_and_prints_the_same_parts_in_either_state(drive, state):
    p = params(drive, state)
    instance = _instance(p)
    assemblies.validate_assembly(instance)
    with pytest.raises(ValueError, match="routing"):
        assemblies.validate_assembly({**instance, "paths": [{**instance["paths"][0], "enabled": state == 1}]})
    rows = assemblies.expand_components([instance])
    roles = ["base", "mechanism-flap", "mechanism-rocker"] + (["mechanism-link"] if drive else [])
    assert [row["componentRole"] for row in rows] == roles
    other = assemblies.expand_components([_instance(params(drive, 1 - state))])
    assert [len(U._meshes(row["parameters"])) for row in rows] == [len(U._meshes(row["parameters"])) for row in other]
    for row in rows:
        _validate({"version": 1, "units": "mm", "family": row["family"], "parameters": row["parameters"],
                   "printer_envelope": {"x": 180, "y": 180, "z": 180}, "part_revision": "r1", "layout_revision": "l1"})
        part = {"family": row["family"], "parameters": {**row["parameters"], "lite": 1}, "componentRole": row["componentRole"]}
        # Mechanism parts print with the detailed process even on a fast plate; only the servo link prints on its side.
        assert plate_style(part) == ("fast" if row["componentRole"] == "base" else "detailed")
        assert _side_on(part) == (row["componentRole"] == "mechanism-link")


def test_hardware_and_notes_follow_the_drive():
    magnet = U.hardware(FAMILY, params(0))
    assert {"name": hw.MAGNET, "quantity": 3, "category": hw.MAGNETS} in magnet
    servo = [row["name"] for row in U.hardware(FAMILY, params(1))]
    assert any("SG90" in name for name in servo) and U.FILAMENT_PIN in servo
    notes = " ".join(U.assembly_notes(FAMILY, params(1)))
    assert "Centre" in notes and "Trim the endpoints" in notes and "physical trial" in notes
