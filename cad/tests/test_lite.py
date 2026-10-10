"""Fast-print (lite) track: unchanged end contacts and rails, solid rail supports,
thin gauge braces, and every mechanism still moving, retaining and locking.

Expensive: run with the project's CadQuery Python environment.
"""
import math

import cadquery as cq
import numpy as np
import pytest
import trimesh

from cad.models import brick_end, lite, track_assembly as model
from cad.service.generate import current_request_digest, generate_part


def request_for(family, extra, **changes):
    p = {"body_width": 63.8, "base_thickness": 3.2, "rail_gauge": 40,
         "rail_interface_width": 2.4, "rail_height": 6.4,
         "connector_version": 1, "fit_adjustment": 0, **extra, **changes}
    if family.startswith("bridge_"):
        p["deck_width"] = p.pop("body_width")
        p["deck_thickness"] = p.pop("base_thickness")
    return {"version": 1, "units": "mm", "family": family, "parameters": p,
            "printer_envelope": {"x": 256, "y": 256, "z": 256},
            "part_revision": "fast", "layout_revision": "geometry"}


def _solid(mesh, specimen):
    return abs(trimesh.boolean.intersection([mesh, specimen], engine="manifold").volume)


def _placed(mesh, frame):
    mesh.apply_transform(frame)
    return mesh


def _box(low, high, frame):
    return _placed(brick_end._box(low, high), frame)


@pytest.mark.parametrize("family,extra", [
    ("printed_straight", {"run": 128}),
    ("printed_curve", {"radius": 320, "sweep": math.pi / 8}),
    ("printed_curve", {"radius": 448, "sweep": -math.pi / 8}),
    ("vertical_transition", {"run": 80, "rise": 8, "start_grade": .05, "end_grade": .15}),
    ("bridge_deck", {"run": 80}),
])
def test_fast_track_keeps_ends_and_rails_on_solid_supports_and_braces(tmp_path, family, extra):
    request = request_for(family, extra, lite=1)
    result = generate_part(request, tmp_path)
    assert result["step"] is None
    mesh = trimesh.load_mesh(result["mesh"], process=True)
    assert mesh.is_volume and len(mesh.split(only_watertight=False)) == 1
    p = {k: v for k, v in request["parameters"].items() if k != "lite"}
    full = brick_end._mesh(brick_end.track(p, family))
    length, start, end, path, plane = lite.route(p, family)
    # End half ties (source contact, clutch and studs) are the full-detail ones;
    # only a radial channel start behind the clutch may be filled on curves.
    for frame in (start, end @ np.diag([-1, -1, 1, 1])):
        region = model._difference(brick_end._box((-5, -34, -2), (7.8, 34, 12)), [
            brick_end._box((6.45, min(side*16, side*24), -2), (8, max(side*16, side*24), 3.25)) for side in (-1, 1)])
        region.apply_transform(frame)
        kept = trimesh.boolean.intersection([mesh, region], engine="manifold")
        source = trimesh.boolean.intersection([full, region], engine="manifold")
        assert abs(model._difference(kept, [source]).volume) < .005
        assert abs(model._difference(source, [kept]).volume) < .005
    ties = brick_end.tie_intervals(length, equal_pitch=brick_end.is_official_curve(p, family))
    centres = [(low + high) / 2 for low, high in ties[1:-1]]
    gaps = [(left[1] + right[0]) / 2 for left, right in zip(ties, ties[1:])]
    assert centres, "every tested piece has at least one brace"
    ramp = family == "vertical_transition"
    for station in centres + ([] if ramp else gaps):
        frame = brick_end._tie_frame(path, p, family, station)
        for side in (-1, 1):
            rail = _box((-1, min(side*17.1, side*22.9), 3.25), (1, max(side*17.1, side*22.9), 9.55), frame)
            assert _solid(mesh, rail) == pytest.approx(_solid(full, rail), abs=.002), station
            support = _box((-1, min(side*16.2, side*23.8), .1), (1, max(side*16.2, side*23.8), 3.1), frame)
            assert _solid(mesh, support) == pytest.approx(support.volume, rel=1e-4), station
            if ramp:
                # Ramp braces are full-width sleepers (it prints on its side).
                foot = _box((-1, min(side*24.1, side*31.8), .1), (1, max(side*24.1, side*31.8), 3.1), frame)
                assert _solid(mesh, foot) == pytest.approx(foot.volume, rel=1e-4), station
            else:
                # No tie, stud or clutch outside the rail supports.
                outside = _box((-1, min(side*24.1, side*33), -1), (1, max(side*24.1, side*33), 12), frame)
                assert _solid(mesh, outside) < .002, station
        brace = _box((-1, -15.9, .1), (1, 15.9, 3.1), frame)
        filled = _solid(mesh, brace)
        if station in centres:
            assert filled == pytest.approx(brace.volume, rel=1e-4), station
            # Open beside the brace (ramp braces are vertical station slices, so stay below the deck top).
            beside = _box((-1, -15.9, .1), (1, 15.9, 3.1), frame)
            beside.apply_translation(frame[:3, 0] * (lite.BRACE_WIDTH / 2 + 2))
            assert _solid(mesh, beside) < .002, station
        else:
            assert filled < .002, station
    if ramp:
        # Lying on its right side, the rail support only bridges short spans
        # between sleeper ends standing on the bed.
        strip = brick_end._mesh(cq.Workplane(plane).polyline([(-31.5, 1), (-24.5, 1), (-24.5, 2), (-31.5, 2)])
                               .close().sweep(cq.Workplane().newObject([path]), isFrenet=False).val())
        feet = trimesh.boolean.intersection([mesh, strip], engine="manifold").split(only_watertight=False)
        spans = sorted((piece.bounds[0, 0], piece.bounds[1, 0]) for piece in feet)
        assert len(spans) > 3
        assert max(b[0] - a[1] for a, b in zip(spans, spans[1:])) <= 13.3


def test_fast_style_is_a_distinct_geometry_input_and_only_for_track():
    request = request_for("printed_straight", {"run": 80})
    fast = request_for("printed_straight", {"run": 80}, lite=1)
    assert current_request_digest(fast) != current_request_digest(request)
    for value in (0, 2, True):
        with pytest.raises(ValueError):
            current_request_digest(request_for("printed_straight", {"run": 80}, lite=value))
    coupon = {**request, "family": "brick_end_coupon",
              "parameters": {"body_length": 24, "connector_version": 1, "fit_adjustment": 0, "lite": 1}}
    with pytest.raises(ValueError, match="fast-print"):
        current_request_digest(coupon)


def parameters(**changes):
    return {"connector_version": 1, "fit_adjustment": 0., "bend": 0., "switch_state": 0., "lite": 1, **changes}


@pytest.mark.parametrize("family", model.FAMILIES)
def test_fast_assembly_components_are_connected_and_mechanisms_unchanged(family, tmp_path):
    fast = model.components(family, parameters())
    code = model.FAMILIES.index(family)
    standard = dict(model._component_meshes(code, 0., 0., 0.))
    assert [row["role"] for row in fast] == list(standard)
    for row in fast:
        assert row["parameters"]["lite"] == 1
        role, mesh = model._meshes(code, row["parameters"])[row["parameters"]["component_index"]]
        assert mesh.is_volume and len(mesh.split(only_watertight=False)) == 1, role
        assert np.all(mesh.extents[:2] <= 166.001), role
        assert mesh.bounds[0, 2] >= -.002, role
        if not role.startswith(("keyed-base", "crossing-base")):
            # Flex leaves, selectors, keepers and lock pins are the full-detail parts.
            assert mesh.volume == pytest.approx(standard[role].volume, abs=1e-6), role
    request = {"version": 1, "units": "mm", "family": "track_component", "parameters": fast[-1]["parameters"],
               "printer_envelope": {"x": 256, "y": 256, "z": 256}, "part_revision": "fast", "layout_revision": "geometry"}
    result = generate_part(request, tmp_path)
    assert result["step"] is None
    assert any(path.endswith(".lite.py") for path in result["source_dependencies"])


@pytest.mark.parametrize("family", ["printed_flex", "printed_switch_left", "printed_switch_right", "printed_double_crossover"])
def test_fast_mechanisms_move_without_interference_and_cannot_be_withdrawn(family):
    assert model.probe_motion(family, parameters(), steps=17)["maximumInterferenceMm3"] <= .01
    for stop in model.probe_retention(family, parameters()):
        assert stop["blockedVolumeMm3"] >= .01, stop["stop"]


@pytest.mark.parametrize("family,state", [(family, state) for family in model.FAMILIES
    for state in ((0, 1) if family not in ("printed_flex", "printed_crossing90") else (0,))])
def test_fast_selected_routes_have_clear_flangeways_and_short_frog_gaps(family, state):
    result = model.probe_running_clearances(family, parameters(switch_state=state))
    assert result["flangeObstructionMm3"] <= .01
    assert result["maximumUnsupportedSpanMm"] <= 4


@pytest.mark.parametrize("family", model.FAMILIES)
def test_fast_outer_source_contacts_survive_componentization(family):
    for port in model.probe_source_contacts(family, parameters()):
        assert port["lostMm3"] < .005 and port["addedMm3"] < .005, port["port"]


@pytest.mark.parametrize("family", ["printed_switch_left", "printed_switch_right", "printed_double_crossover"])
def test_fast_bases_stay_keyed_locked_and_keep_their_selector_envelopes(family):
    result = model.probe_base_joints(family, parameters())
    assert len(result["retainedConnections"]) >= result["components"] - 1
    assert all(joint["blockedVolumeMm3"] > .01 for joint in result["retainedConnections"])
    locks = model.probe_state_locks(family, parameters())
    assert {lock["state"] for lock in locks} == {0, 1} and {lock["direction"] for lock in locks} == {-1, 1}
    assert all(lock["blockedVolumeMm3"] > .01 for lock in locks)
    assert model.probe_operating_envelopes(family, parameters())["outsideVolumeMm3"] <= .01


@pytest.mark.parametrize("code", [1, 2, 3, 4])
def test_fast_bases_have_solid_supports_braces_and_no_studs_outside_end_ties(code):
    mesh = model._fixed_mesh(code, 0, True)
    # Cassette floors and the keeper screw pilot bores are mechanism, not deck.
    zones = model._floor_zones(code) + [
        _placed(brick_end._cylinder(1.35, -1, 4, x, y), model._selector_frame(origin, heading))
        for origin, heading, sign in model._selectors(code) for x in (9.5, 92.)
        for y in model._keeper_layout(x, sign)[4]]
    paths = model._fixed_paths(code)
    for path in paths:
        span = model._station_path(path, 12, model._length(path)-12)
        for lateral in (-20, 20):
            support = model._difference(model._ribbon(span, lateral, 3.8, .1, 3.1), zones)
            assert _solid(mesh, support) == pytest.approx(support.volume, rel=1e-3)
    for _, _, frame in model._tie_frames(code):
        brace = model._difference(_box((-1.3, -15.9, .1), (1.3, 15.9, 3.1), frame), zones)
        assert _solid(mesh, brace) == pytest.approx(brace.volume, rel=1e-3)
    # Above the deck only rails, end half ties and their studs remain.
    ports = model.ports(model.FAMILIES[code], parameters())
    ends = [_box((-4, -34, -1), (7.9, 34, 12), brick_end._frame(port["position"], port["heading"]+math.pi, 0))
            for port in ports]
    deck_top = brick_end._box((-200, -200, 3.3), (600, 400, 4.7))
    above = model._difference(trimesh.boolean.intersection([mesh, deck_top], engine="manifold"),
                              [*(model._rails(path) for path in paths), *ends])
    assert abs(above.volume) < .01


@pytest.mark.parametrize("code", [1, 2, 4])
def test_fast_keepers_seat_on_solid_deck_clear_of_fixed_rails(code):
    fixed = model._fixed_mesh(code, 0, True)
    for origin, heading, sign in model._selectors(code):
        frame = model._selector_frame(origin, heading)
        for x in (9.5, 92.):
            assert _solid(fixed, model._keeper(origin, heading, x, sign)) < .001, (origin, x)
        # The far keeper and its screw posts stand on solid deck, not over air.
        seat = _box((88.3, min(sign*1.2, sign*2.8), .1), (96.5, max(sign*1.2, sign*2.8), 3.1), frame)
        assert _solid(fixed, seat) == pytest.approx(seat.volume, rel=1e-4), origin
