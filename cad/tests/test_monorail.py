import math

import numpy as np
import pytest

from cad.models import monorail as M
from cad.service import assemblies

BASE = {"connector_version": 1, "fit_adjustment": 0., "slot_width": M.SLOT_WIDTH, "slot_depth": M.SLOT_DEPTH}
CASES = [("monorail_straight", {"length": 256.}), ("monorail_straight", {"length": 32.}),
         ("monorail_curve", {"angle": 90., "hand": 1.}), ("monorail_curve", {"angle": 45., "hand": -1.}),
         ("monorail_curve", {"angle": 30., "hand": 1.}),
         ("monorail_ramp", {"part": 0., "climb": 1.}), ("monorail_ramp", {"part": 1., "climb": -1.}),
         ("monorail_switch", {"hand": 1., "switch_state": 0.}), ("monorail_switch", {"hand": -1., "switch_state": 1.})]


def params(shape, **extra):
    return {**BASE, **shape, **extra}


@pytest.mark.parametrize("family,shape", CASES)
@pytest.mark.parametrize("lite", [False, True])
def test_every_part_is_one_watertight_solid_on_the_mini_bed(family, shape, lite):
    p = params(shape, **({"lite": 1} if lite else {}))
    rows = M.probe_parts(family, p)
    assert rows and all(max(row["printPlanMm"]) <= M.PLAN + M.KEY_DEPTH + .1 for row in rows)
    for component in M.components(family, p):
        M.validate_component(component["parameters"])
    # Every end meets a plain straight's end flush (running surface, groove and rod).
    assert all(row["xorMm2"] < .05 for row in M.probe_ends(family, p).values())


@pytest.mark.parametrize("length,teeth", [(256., 163), (128., 82), (64., 41), (32., 20)])
def test_straight_rack_tooth_count(length, teeth):
    p = params({"length": length})
    counts = M.probe_teeth(M.assembled("monorail_straight", p), M.route_of("monorail_straight", p), M.SLOT_DEPTH)
    assert counts == {"left": teeth, "right": teeth}


def test_quarter_curve_has_three_more_teeth_outside():
    p = params({"angle": 90., "hand": 1.})
    counts = M.probe_teeth(M.assembled("monorail_curve", p), M.route_of("monorail_curve", p), M.SLOT_DEPTH)
    assert counts == {"left": 223, "right": 226}


def _port(rows, ident):
    return next(row for row in rows if row["id"] == ident)


def test_ports_match_the_editor_geometry():
    out = _port(M.ports("monorail_curve", params({"angle": 45., "hand": -1.})), "out")
    assert out["position"] == pytest.approx([224*math.sin(math.pi/4), -224*(1 - math.cos(math.pi/4)), 0.], abs=1e-6)
    assert out["heading"] == pytest.approx(-math.pi/4)
    lower = M.ports("monorail_ramp", params({"part": 0., "climb": 1.}))
    assert _port(lower, "out")["position"] == pytest.approx([256., 0., 48.], abs=1e-3)
    assert _port(lower, "out")["pitch"] == pytest.approx(math.atan(.375), abs=1e-4)
    assert _port(lower, "in")["pitch"] == pytest.approx(0., abs=1e-9)
    upper = M.ports("monorail_ramp", params({"part": 1., "climb": 1.}))
    assert _port(upper, "in")["pitch"] == pytest.approx(-math.atan(.375), abs=1e-4)
    branch = _port(M.ports("monorail_switch", params({"hand": -1., "switch_state": 0.})), "branch")
    assert branch["position"] == pytest.approx([256., -448*(1 - math.cos(math.pi/6)), 0.], abs=1e-6)
    assert branch["heading"] == pytest.approx(-math.pi/6)


def test_switch_routes_follow_its_state_and_validate_as_an_assembly():
    for state in (0, 1):
        p = params({"hand": 1., "switch_state": float(state)})
        pairs = M.route_pairs("monorail_switch", p)
        assert pairs == {frozenset(("in", "out")): state == 0, frozenset(("in", "branch")): state == 1}
        assemblies.validate_assembly({
            "family": "monorail_switch", "source": "printed", "parameters": p,
            "pose": {"x": 10., "y": 20., "z": 30., "heading": .3, "pitch": 0.},
            "ports": [{"id": row["id"], "profile": "brick", "railGauge": 40, "interfaceWidth": 2.4,
                       "pose": {"x": 10. + row["position"][0]*math.cos(.3) - row["position"][1]*math.sin(.3),
                                "y": 20. + row["position"][0]*math.sin(.3) + row["position"][1]*math.cos(.3),
                                "z": 30. + row["position"][2], "heading": .3 + row["heading"], "pitch": row["pitch"]}}
                      for row in M.ports("monorail_switch", p)],
            "paths": [{"id": "main", "from": "in", "to": "out", "enabled": state == 0},
                      {"id": "branch", "from": "in", "to": "branch", "enabled": state == 1}]})


def test_gear_runs_the_whole_quarter_curve_engaged_and_clear():
    p = params({"angle": 90., "hand": -1.})
    route = M.route_of("monorail_curve", p)
    report = M.probe_gear(M.assembled("monorail_curve", p), route, M.phases(route, M.SLOT_DEPTH), 1., route.length - 1.,
                          M.SLOT_DEPTH, step=1.)
    for side in report.values():
        assert side["maxInterferenceMm2"] < .01 and side["engagedFraction"] == 1. and side["minWallClearanceMm"] > .7


@pytest.mark.parametrize("hand", [1., -1.])
def test_switch_slide_lines_up_and_runs_clear_in_both_states(hand):
    p = params({"hand": hand, "switch_state": 0.})
    slide = M.probe_slide(p)
    assert slide["maxInterferenceMm3"] < 1e-6
    assert max(slide["grooveWallStepMm"].values()) < .01
    lay = M.SwitchLayout(M.SLOT_WIDTH, M.SLOT_DEPTH)
    for state, (route, phase) in enumerate(M.switch_phases(lay, int(hand))):
        meshes = M.assembled("monorail_switch", p, state)
        gear = M.probe_gear(meshes, route, phase, 1., route.length - 1., M.SLOT_DEPTH, step=1.)
        assert all(side["maxInterferenceMm2"] < .01 and side["engagedFraction"] == 1. for side in gear.values())
        running = M.probe_running(meshes, route, .5, route.length - .5)
        assert running["maxSurfaceDeviationMm"] < .01 and running["longestMissMm"] <= .5


def test_switch_parts_convert_to_cad_solids():
    p = params({"hand": 1., "switch_state": 0.})
    for component in M.components("monorail_switch", p):
        assert M.build_component(component["parameters"]).isValid()


def test_ramp_running_surface_is_continuous_across_its_seam():
    p = params({"part": 0., "climb": 1.})
    route = M.route_of("monorail_ramp", p)
    running = M.probe_running(M.assembled("monorail_ramp", p), route, .5, route.length - .5)
    assert running["maxSurfaceDeviationMm"] < .01 and running["longestMissMm"] == 0.


def test_only_raised_ramp_undersides_carry_painted_support():
    for family, shape, painted in (("monorail_ramp", {"part": 1., "climb": 1.}, True), ("monorail_straight", {"length": 256.}, False)):
        for component in M.components(family, params(shape)):
            mesh = M.component_meshes(family, params(shape))[component["parameters"]["component_index"]][1]
            centroids, normals = mesh.triangles_center, mesh.face_normals
            mask = M.support_faces(component["parameters"], centroids, normals, centroids[:, 2] - mesh.bounds[0, 2])
            assert mask.any() == painted
            # Never the running surface, groove or rack: only faces pointing down near the underside.
            assert np.all(normals[mask, 2] < -.5)
            if painted:
                route = M.route_of(family, params(shape))
                assert np.all(centroids[mask, 2] - np.interp(centroids[mask, 0], route.x, route.z) <= M.SOCKET_DEPTH + .3)


@pytest.mark.parametrize("change", [{"length": 100.}, {"slot_width": 15.}, {"slot_depth": 7.5}, {"fit_adjustment": .5}])
def test_rejects_unbuildable_parameters(change):
    with pytest.raises(ValueError):
        M.validate("monorail_straight", params({"length": 64.}, **change))
