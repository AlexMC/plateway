"""Funicular: digital geometry and clearance probes only, never motor torque, magnet hold or line wear."""
import math

import pytest

from cad.models import funicular as F
from cad.service import assemblies
from cad.service.generate import _validate
from cad.service.plates import _end_frames, plate_style

FAMILY = F.FAMILIES[0]


def params(length=256, grade=35, motor=0, side=1, **extra):
    return {"connector_version": 1, "fit_adjustment": 0, "length": length, "grade": grade, "motor": motor, "side": side, **extra}


def _instance(p, dz=0.):
    pose = {"x": 300., "y": -50., "z": 0., "heading": .7, "pitch": 0.}
    c, s = math.cos(pose["heading"]), math.sin(pose["heading"])
    return {
        "id": "f1", "family": FAMILY, "source": "printed", "parameters": p, "pose": pose,
        "interfaceKind": "track-assembly", "part_revision": "r1", "layout_revision": "l1",
        "ports": [{"id": port["id"], "profile": "brick", "railGauge": 40., "interfaceWidth": 2.4,
                   "pose": {"x": pose["x"] + port["position"][0]*c - port["position"][1]*s,
                            "y": pose["y"] + port["position"][0]*s + port["position"][1]*c, "z": port["position"][2] + dz,
                            "heading": pose["heading"] + port["heading"], "pitch": port["pitch"]}} for port in F.ports(FAMILY, p)],
        "paths": [{"id": "main", "from": "in", "to": "out", "enabled": True}],
    }


@pytest.mark.parametrize("p", [params(), params(grade=60, motor=1, side=-1, lite=1)])
def test_line_guides_hitch_and_winch_clear_the_train_and_each_other(p):
    report = F.probes(FAMILY, p)
    string, running, drum, motor, plank = (report[key] for key in ("string", "running", "drum", "motor", "plank"))
    # The taut line stays above the saddles and inside the station slot for every car position.
    assert string["insideSlot"] and string["lineOverSaddlesMm"] > 1
    # Saddles stay under the wheels' reach between the rails; the hitch passes over every track without touching it.
    assert running["saddleTopMm"] <= F.GUIDE_LIMIT and running["saddleInCorridorsMm3"] == 0
    assert running["saddleAboveLimitMm3"] == 0 and running["saddleHalfWidthMm"] < running["flangeCorridorMm"]
    assert running["hitchTrackOverlapMm3"] == 0 and running["hitchOverTrackMm"] > .5
    # The drum turns freely on the axle between the plate and the cheek and holds the whole line.
    assert drum["drumStationOverlapMm3"] == 0 and drum["drumAxisOffsetMm"] < .01 and drum["capacityMm"] > drum["neededMm"]
    low, high = drum["drumSpanYMm"]
    assert -F.PLATE_FACE < low and high < F.PLATE_FACE
    # The plank seats on both feet; nothing printed cuts into it (coplanar contact leaves < 0.1 mm^3 of boolean noise).
    assert all(row["overlapMm3"] <= .1 and row["seatedMm3"] > 50 for row in plank["feet"].values())
    assert plank["partsOnPlankOverlapMm3"] <= .1
    assert all(max(row["sizeMm"][:2]) <= F.BED for row in report["parts"])


def test_ports_follow_the_slope_and_the_service_validates_them():
    p = params(length=384, grade=45)
    rise = (2*F.BUFFER_RUN + 384)*math.sin(math.atan(.45))
    ports = {port["id"]: port for port in F.ports(FAMILY, p)}
    assert ports["out"]["position"][2] - ports["in"]["position"][2] == pytest.approx(rise)
    assert ports["in"]["position"][2] == pytest.approx(F.FOOT_MIN + F.PLANK_T*math.cos(math.atan(.45)))
    assert [ports["in"]["pitch"], ports["out"]["pitch"]] == pytest.approx([-math.atan(.45), math.atan(.45)])
    assemblies.validate_assembly(_instance(p))
    with pytest.raises(ValueError, match="port differs"):
        assemblies.validate_assembly(_instance(p, dz=1.))
    rows = assemblies.expand_components([_instance(p)])
    assert [row["componentRole"] for row in rows] == ["track-1", "track-2", "track-3", "buffer-bottom", "station-top",
                                                      "foot-bottom", "foot-top", "mechanism-drum", "mechanism-hitch"]
    for row in rows:
        _validate({"version": 1, "units": "mm", "family": row["family"], "parameters": row["parameters"],
                   "printer_envelope": {"x": 180, "y": 180, "z": 180}, "part_revision": "r1", "layout_revision": "l1"})
        part = {"family": row["family"], "parameters": {**row["parameters"], "lite": 1}, "componentRole": row["componentRole"]}
        mechanism = row["componentRole"].startswith("mechanism-")
        # The drum and hitch print detailed even on a fast layout; track connector tongues get painted supports.
        assert plate_style(part) == ("detailed" if mechanism else "fast")
        connectors = 2 if row["componentRole"].startswith("track-") else 1 if row["componentRole"] in ("buffer-bottom", "station-top") else 0
        assert len(_end_frames(part)) == connectors


def test_settings_outside_the_buildable_range_are_rejected():
    for bad in ({"length": 300}, {"length": 1152}, {"grade": 19}, {"grade": 35.5}, {"motor": 2}, {"side": 0}, {"lite": 0},
                {"state": 0}):
        with pytest.raises(ValueError):
            F.validate(FAMILY, {**params(), **bad})


def test_fast_print_swaps_the_track_decks_and_keeps_the_winch_parts():
    detailed, lite = params(), params(lite=1)
    assert F.roles(detailed) == F.roles(lite)
    for role in F.roles(detailed):
        a, b = F.part_mesh(detailed, role), F.part_mesh(lite, role)
        if role.startswith("track-"):
            assert b.volume < a.volume
        elif role.startswith(("buffer-", "station-")):
            # buffer.py's fast stop block stands on the plate instead of the street floor.
            assert b is not a and abs(b.volume - a.volume) > 100
        else:
            assert a is b


def test_hardware_and_notes_carry_the_cut_plank_line_and_support_height():
    p = params(length=512, grade=35, motor=1)
    names = [row["name"] for row in F.hardware(FAMILY, p)]
    assert any("88008" in name for name in names) and any("cut to 688 mm" in name for name in names)
    assert any(f"{F.string_length(p):.0f} mm" in name for name in names)
    notes = " ".join(F.assembly_notes(FAMILY, p))
    assert f"{F.support_height(p):.0f} mm high" in notes and "35 %" in notes
