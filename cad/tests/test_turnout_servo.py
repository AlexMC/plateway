"""SG90 servo drive on point-blade turnouts (turnout_servo.py); digital geometry only, never physical fit."""
import pytest

from cad.models import hardware as hw
from cad.models import turnout as T
from cad.models import turnout_servo as S

SHAPES = [("turnout_radius", {"radius": r, "hand": h}) for r in (40, 56, 104, 148) for h in (1, -1)] + \
         [("turnout_curved", {"radius": r, "sweep": s, "hand": h}) for r in (40, 56) for s in (45, 90) for h in (1, -1)] + \
         [("turnout_wye", {}), ("turnout_three_way", {})]


def params(shape, **extra):
    return {"connector_version": 1, "fit_adjustment": 0, "switch_state": 0, "sprung": 0, **shape, **extra}


@pytest.mark.parametrize("family,shape", SHAPES)
def test_every_turnout_has_room_for_its_servos_inside_the_editor_zone(family, shape):
    spec = T.spec(family, params(shape, servo=1))
    assert spec.servo == T.servo_side(family, params(shape))
    for i, mount in enumerate(S.mounts(spec)):
        # The rod line points to the servo side; the housing clears the junction's body and its ports (build_mounts).
        assert mount.line.u[1]*spec.servo > 0
        envelope = T.manifold3d.CrossSection.hull_points([tuple(p) for p in S.envelope(spec, i)])
        assert (envelope - S.editor_zone(spec, i)).area() < .01


def test_servo_is_an_option_of_manual_points_only_and_absent_by_default():
    shape = {"radius": 40, "hand": 1}
    with pytest.raises(ValueError, match="manual"):
        T.validate("turnout_radius", params(shape, sprung=1, servo=1))
    with pytest.raises(ValueError, match="servo must be 1"):
        T.validate("turnout_radius", params(shape, servo=0))
    plain = T.components("turnout_radius", params(shape))
    assert T.spec("turnout_radius", params(shape)).servo == 0
    assert not any("servo" in row["role"] or "servo" in row["parameters"] for row in plain)
    roles = [row["role"] for row in T.components("turnout_three_way", params({}, servo=1))]
    assert not any(role.startswith("selector-lock") for role in roles)
    for i in (1, 2):
        assert {f"mechanism-servo-rod-{i}", f"mechanism-servo-housing-{i}", f"mechanism-servo-clamp-{i}"} <= set(roles)
    hardware = {row["name"]: row["quantity"] for row in T.hardware("turnout_three_way", params({}, servo=1))}
    assert hardware[hw.SERVO] == 2
    assert hardware[hw.M3_ST.format(length=4)] == 8 + 8  # keepers and servo clamps, one line


@pytest.mark.parametrize("family,shape,lite", [("turnout_radius", {"radius": 40, "hand": 1}, False),
                                               ("turnout_wye", {}, True)])
def test_servo_throws_the_points_both_ways_and_keeps_every_route_clear(family, shape, lite):
    p = params(shape, servo=1, **({"lite": 1} if lite else {}))
    for row in T.components(family, p):
        role, mesh = T._meshes(family, row["parameters"])[row["parameters"]["component_index"]]
        T.check_mesh(role, mesh)
    report = T.probes(family, p)
    assert report["motion"]["maximumInterferenceMm3"] <= .01
    assert report["envelopes"]["outsideVolumeMm3"] <= .01
    assert all(row["flangeObstructionMm3"] <= .01 and row["maximumUnsupportedSpanMm"] <= 4 for row in report["running"])
    assert all(row["lostMm3"] < .005 and row["addedMm3"] < .005 for row in report["contacts"])
    for row in report["servo"]:
        assert row["motionInterferenceMm3"] <= .01 and row["rodInsertionMm3"] <= .01 and row["hornSweepMm3"] <= .01
        assert row["caseInCradleMm3"] <= .01 and row["rodUpliftBlockedMm3"] > .01
        assert 0 < row["hornAngleDeg"] < 20
        # At each end the horn pin has taken up the backlash and pushed the bar to that position.
        for end in row["ends"]:
            assert end["seatedBacklashMm"] == pytest.approx((S.HOLE_B - S.PIN)/2 + (S.SLOT - S.HORN_PIN)/2, abs=1e-3)
