import math

import pytest

from cad.models import brick_end as end
from cad.models import tables as T
from cad.service.assemblies import module_for

CONNECTOR = {"connector_version": 1, "fit_adjustment": 0}
CONFIGS = [
    ("turntable", {"bridge": 256, "index": 22.5, "left": 3, "right": 2, "drive": 0}),
    ("turntable", {"bridge": 384, "index": 15, "left": 2, "right": 0, "drive": 1}),
    ("turntable", {"bridge": 256, "index": 22.5, "left": 2, "right": 0, "drive": 2}),
    ("turntable", {"bridge": 512, "index": 11.25, "left": 2, "right": 1, "drive": 0}),
    ("transfer_table", {"deck": 256, "lanes": 2, "hand": -1}),
    ("transfer_table", {"deck": 384, "lanes": 4, "hand": 1}),
    ("sector_plate", {"deck": 384, "tracks": 2}),
    ("sector_plate", {"deck": 640, "tracks": 3}),
]


def params(shape, state=0):
    return {**shape, **CONNECTOR, "switch_state": state}


@pytest.mark.parametrize("family,shape", CONFIGS)
def test_every_part_is_one_bed_sized_cad_solid(family, shape):
    for role, mesh, yaw in T.parts(family, params(shape)):
        assert max(T.plan_size(mesh, yaw)) <= T.BED, role
        assert end._solid(T.check_mesh(role, mesh, yaw)).isValid(), role


@pytest.mark.parametrize("family,shape", CONFIGS)
def test_rail_ends_line_up_at_every_position_and_the_deck_never_touches(family, shape):
    p = params(shape)
    rows = T.probe_alignment(family, p)
    assert rows and not any(row.get("missing") for row in rows)
    assert max(row["lateral"] for row in rows) <= .3
    assert max(row["angle"] for row in rows) <= .5
    # Every joint keeps the 1 mm rail gap (measured on 0.25 mm sections).
    assert all(.75 <= row["gap"] <= 1.5 for row in rows)
    assert T.probe_play(family, p)["lateral"] <= .3
    assert T.probe_motion(family, p, steps=12)["worst_overlap_mm3"] < 1e-3
    assert T.probe_envelopes(family, p)["outside_mm2"] < 1e-3


def test_states_open_exactly_the_lined_up_position_and_ports_follow_the_ts_shape():
    p = params({"bridge": 256, "index": 22.5, "left": 2, "right": 0, "drive": 0}, state=1)
    pairs = T.route_pairs("turntable", p)
    assert [sorted(pair) for pair, enabled in pairs.items() if enabled] == [["free-1", "l1"]]
    ports = {port["id"]: port for port in T.ports("turntable", p)}
    shape = T.turntable_shape(p)
    # The pit centre sits one port radius ahead of `in`; stalls are on that circle, 22.5° apart.
    assert ports["in"]["position"][:2] == pytest.approx([0, 0], abs=1e-9)
    assert ports["out"]["position"][0] == pytest.approx(2*shape["port"])
    assert math.atan2(ports["l2"]["position"][1], ports["l2"]["position"][0] - shape["port"]) == pytest.approx(math.radians(45))
    # Free bridge ends are route ends only, never printed connectors.
    assert all(not port["id"].startswith("free-") for port in T.component_ports({**p, "shape_code": 0, "component_index": 0}))
    assert module_for("turntable") is T


def test_rejects_stalls_whose_rails_touch_at_the_pit_edge():
    with pytest.raises(ValueError, match="longer bridge"):
        T.validate("turntable", params({"bridge": 384, "index": 11.25, "left": 2, "right": 0, "drive": 0}))


@pytest.mark.parametrize("drive, motor, other", [(1, "Bluetooth L motor (88013)", "Infrared"),
                                                 (2, "Infrared L motor (88003)", "Bluetooth")])
def test_the_motor_turntable_worm_meshes_the_24t_gear_and_the_motor_clears_everything(drive, motor, other):
    p = params({"bridge": 384, "index": 15, "left": 2, "right": 0, "drive": drive})
    report = T.probe_drive("turntable", p)
    # The LDraw case (and its keep-out box) misses every printed part, the bridge turned through a full circle;
    # the motor's four face pin holes and the bearing are open.
    assert report["caseOverlapMm3"] == 0 and report["keepoutOverlapMm3"] == 0
    assert report["pinsOnPlateGrid"] and report["pinHoleMaterialMm3"] == 0 and report["bearingMaterialMm3"] == 0
    # Worm 4716 on the motor axle and 24T 3648 on the vertical axle: crossed square, two modules apart, tips clear of
    # roots (the motor mount once put the motor axle through the vertical axle: centres 0).
    mesh = report["mesh"]
    assert mesh["wormToGearCentresMm"] == pytest.approx(16., abs=.01) and mesh["crossingDeg"] == pytest.approx(90.)
    assert mesh["gearTipToWormRootMm"] > 0 and mesh["wormTipToGearRootMm"] > 0
    assert mesh["gearsInPrintedMm3"] == 0 and mesh["gearsInMotorMm3"] == 0
    names = [row["name"] for row in T.hardware("turntable", p)]
    assert motor in names and not any(other in name for name in names)
    with pytest.raises(ValueError, match="drive"):
        T.validate("turntable", {**p, "drive": 3})
