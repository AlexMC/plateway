"""Point-blade junction framework and turnout families; digital geometry only, never physical fit."""
import math

import numpy as np
import pytest

from cad.models import turnout as T

SHAPES = [("turnout_radius", {"radius": r, "hand": h}) for r in (40, 56, 104, 148) for h in (1, -1)] + \
         [("turnout_curved", {"radius": r, "sweep": s, "hand": h}) for r in (40, 56) for s in (45, 90) for h in (1, -1)] + \
         [("turnout_wye", {}), ("turnout_three_way", {})]


def params(shape, **extra):
    return {"connector_version": 1, "fit_adjustment": 0, "switch_state": 0, "sprung": 0, **shape, **extra}


@pytest.mark.parametrize("family,shape", SHAPES)
def test_every_turnout_plans_bed_sized_keyed_tiles_and_clear_points(family, shape):
    spec = T.spec(family, params(shape))
    lay = T.layout(spec)
    for part in T._parts(lay.region - T._union_cs([T.ta._section(T.ta._segment_quad(a, b, .1)) for a, b in lay.seams])):
        x0, y0, x1, y1 = part.bounds()
        assert max(x1 - x0, y1 - y0) <= T.PLAN_BED + 1e-6
    for points in T.points_of(spec):
        # The tie bar sits past both blade tips and the heel blocks end before the routes cross.
        assert points.bar > max(blade.tip for blade in points.blades) >= T.MIN_TIP
        assert not T.ta._overlaps(points.swept(), T._union_cs(
            [T.manifold3d.CrossSection.circle(T.FROG_CLEAR, 16).translate(tuple(p)) for p in lay.crossings]))


@pytest.mark.parametrize("radius,length", [(104, 640.), (148, 768.)])
def test_parallel_radius_family_returns_sixteen_studs_over(radius, length):
    rows = {row["id"]: row for row in T.ports("turnout_radius", params({"radius": radius, "hand": 1}))}
    assert rows["out"]["position"][:2] == pytest.approx([length, 0])
    assert rows["branch"]["position"][:2] == pytest.approx([length, 128], abs=1e-9)
    assert math.cos(rows["branch"]["heading"]) == pytest.approx(1)


def test_states_open_exactly_the_set_route():
    p = params({})
    assert T.route_pairs("turnout_three_way", {**p, "switch_state": 0}) == {
        frozenset(("in", "out")): True, frozenset(("in", "left")): False, frozenset(("in", "right")): False}
    assert T.route_pairs("turnout_three_way", {**p, "switch_state": 2})[frozenset(("in", "right"))]
    assert not T.route_pairs("turnout_three_way", {**p, "switch_state": 1})[frozenset(("in", "out"))]
    with pytest.raises(ValueError, match="switch_state"):
        T.validate("turnout_wye", {**p, "switch_state": 2})
    with pytest.raises(ValueError, match="radius"):
        T.validate("turnout_radius", params({"radius": 72, "hand": 1}))


def test_manual_points_carry_a_spacer_and_sprung_points_print_at_the_default():
    shape = {"radius": 40, "hand": 1}
    manual = [role for role, _ in T._meshes("turnout_radius", params(shape, lite=1))]
    sprung = [role for role, _ in T._meshes("turnout_radius", params(shape, sprung=1, lite=1))]
    assert "selector-lock-1" in manual and "selector-lock-1" not in sprung
    assert set(manual) - {"selector-lock-1"} == set(sprung)
    # Manual points are the same print in either state; sprung points are printed at the chosen default.
    blades = lambda **extra: dict(T._meshes("turnout_radius", params(shape, lite=1, **extra)))["selector-points-1"]
    assert np.allclose(blades(switch_state=0).bounds, blades(switch_state=1).bounds)
    assert not np.allclose(blades(sprung=1, switch_state=0).bounds, blades(sprung=1, switch_state=1).bounds)


def test_a_switch_may_share_its_routes_far_port():
    """Trailing points (crossovers, slips): the routes meet at their end port and are reversed internally."""
    forward = T.spec("turnout_radius", params({"radius": 40, "hand": 1}))
    reverse = lambda points: tuple((x, y, h + math.pi) for x, y, h in reversed(points))
    main, branch = forward.routes
    spec = T.Spec(
        ports=tuple(T.Port(p.id, p.x, p.y, p.heading) for p in forward.ports),
        routes=(T.Route("main", "out", "in", reverse(main.points)), T.Route("branch", "branch", "in", reverse(branch.points))),
        switches=(T.Switch("main", "branch", "in"),), states=forward.states)
    a, b = T.points_of(forward)[0], T.points_of(spec)[0]
    assert b.bar == pytest.approx(a.bar, abs=.6)
    assert [blade.side for blade in b.blades] == [-blade.side for blade in a.blades]
    assert T.layout(spec).rails and T.spec_route_pairs(spec, 1) == {frozenset(("out", "in")): False, frozenset(("branch", "in")): True}


def test_envelope_matches_the_ts_rule_and_contains_every_moving_part():
    spec = T.spec("turnout_wye", params({}))
    assert T.probe_operating_envelopes(spec, sprung=False)["outsideVolumeMm3"] <= .01


def test_a_rejoined_offcut_leaves_every_base_tile_one_sound_solid():
    # R56 90° left: an offcut rejoined across its kerf kept coincident faces that a later key cut split off as
    # zero-volume shells beside the seam.
    spec = T.spec("turnout_curved", params({"radius": 56, "sweep": 90, "hand": 1}))
    for i, tile in enumerate(T._base_pieces(spec, 0., True)):
        T.check_mesh(f"keyed-base-{i+1:02d}", tile)


@pytest.mark.parametrize("family,shape,sprung,lite", [
    ("turnout_radius", {"radius": 40, "hand": 1}, 0, False),
    ("turnout_wye", {}, 1, True),
])
def test_points_move_lock_retain_and_leave_every_selected_route_clear(family, shape, sprung, lite):
    p = params(shape, sprung=sprung, **({"lite": 1} if lite else {}))
    for role, mesh in T._meshes(family, p):
        T.check_mesh(role, mesh)
    report = T.probes(family, p)
    assert report["motion"]["maximumInterferenceMm3"] <= .01
    assert {row["stop"] for row in report["retention"]} == {"keeper-uplift", "points-travel-stop"}
    assert all(row["flangeObstructionMm3"] <= .01 and row["maximumUnsupportedSpanMm"] <= 4 for row in report["running"])
    assert report["joints"]["components"] == len([r for r, _ in T._meshes(family, p) if r.startswith("keyed-base")])
    if not sprung:
        assert {(row["position"], row["direction"]) for row in report["locks"]} == {(0, -1), (0, 1), (1, -1), (1, 1)}
