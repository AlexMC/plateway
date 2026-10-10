"""Consumer-visible geometry/retention checks for authored track mechanisms.

Deliberately not a source-text or request-forwarding test. These can be expensive:
run after sibling changes land, with the project's CadQuery Python environment.
"""
import math
import cadquery as cq

import numpy as np
import pytest
import trimesh

from cad.models import brick_end, track_assembly as model


def parameters(**changes):
    return {"connector_version": 1, "fit_adjustment": 0., "bend": 0.,
            "switch_state": 0., **changes}


@pytest.mark.parametrize("bend", [-math.pi/32, 0, math.pi/32])
def test_flex_outer_ports_follow_the_articulating_arm(bend):
    ports = model.ports("printed_flex", parameters(bend=bend))
    assert ports[0]["position"] == [0, 0, 0]
    assert ports[0]["heading"] == pytest.approx(math.pi)
    assert ports[1]["position"] == pytest.approx([16+16*math.cos(bend), 16*math.sin(bend), 0])
    assert ports[1]["heading"] == pytest.approx(bend)


@pytest.mark.parametrize("family,sign", [("printed_switch_left", 1), ("printed_switch_right", -1)])
def test_turnout_branch_closes_with_the_official_reverse_curve(family, sign):
    # LDraw right turnout 53404 maps (X,Y,Z) to CAD (X,Z,-Y): branch Y is negative.
    branch = model.ports(family, parameters())[2]
    assert branch["position"] == pytest.approx([261.5408, sign*103.6412, 0], abs=.002)
    x, y, _ = branch["position"]
    angle = math.pi/8
    # Reverse R40 22.5 degrees restores the standard parallel-track lattice.
    assert x + 320*math.sin(angle) == pytest.approx(384)
    assert y + sign*320*(1-math.cos(angle)) == pytest.approx(sign*128)


@pytest.mark.parametrize("family", model.FAMILIES)
def test_every_exported_component_is_connected_and_fits_the_usable_mini_bed(family, tmp_path):
    for row in model.components(family, parameters()):
        shape = model.build_component(row["parameters"])
        box = shape.BoundingBox()
        assert shape.isValid(), row["role"]
        assert len(shape.Solids()) == 1, row["role"]
        assert box.xlen <= 166.001 and box.ylen <= 166.001, row["role"]
        assert box.zmin >= -.002, row["role"]
        stl = tmp_path / f'{row["role"]}.stl'
        cq.exporters.export(shape, str(stl), exportType="STL", tolerance=.02, angularTolerance=.1)
        mesh = trimesh.load_mesh(stl, process=True)
        assert mesh.is_volume, row["role"]
        assert len(mesh.split(only_watertight=False)) == 1, row["role"]
        assert mesh.volume == pytest.approx(shape.Volume(), rel=1e-5), row["role"]


@pytest.mark.parametrize("family", ["printed_flex", "printed_switch_left", "printed_switch_right", "printed_double_crossover"])
def test_mechanisms_move_without_interference_and_cannot_be_withdrawn(family):
    evidence = model.probe_motion(family, parameters(), steps=17)
    assert evidence["maximumInterferenceMm3"] <= .01
    for stop in model.probe_retention(family, parameters()):
        assert stop["blockedVolumeMm3"] >= .01, stop["stop"]


@pytest.mark.parametrize("family", ["printed_switch_left", "printed_switch_right", "printed_double_crossover"])
def test_shared_operating_envelope_contains_every_selector_pose(family):
    assert model.probe_operating_envelopes(family, parameters())["outsideVolumeMm3"] <= .01


@pytest.mark.parametrize("family,state", [(family, state) for family in model.FAMILIES
    for state in ((0, 1) if family not in ("printed_flex", "printed_crossing90") else (0,))])
def test_selected_routes_have_clear_flangeways_and_short_frog_gaps(family, state):
    result = model.probe_running_clearances(family, parameters(switch_state=state))
    assert result["flangeObstructionMm3"] <= .01
    assert result["maximumUnsupportedSpanMm"] <= 4


def test_flex_hardware_sits_above_the_flat_base_and_clear_of_moving_leaf():
    hardware = model._flex_hardware_mesh()
    assert hardware.bounds[0, 2] >= 0
    assert hardware.bounds[1, 2] < 9.6
    for bend in np.linspace(-model.MAX_BEND, model.MAX_BEND, 9):
        moving = model._flex_mesh(1, bend, 0)
        overlap = trimesh.boolean.intersection([hardware, moving], engine="manifold")
        assert abs(overlap.volume) <= .01


@pytest.mark.parametrize("family", model.FAMILIES)
def test_outer_source_contacts_survive_componentization(family):
    # Only the half-tie stud envelopes standing on the source deck are exempt.
    for port in model.probe_source_contacts(family, parameters()):
        assert port["lostMm3"] < .005 and port["addedMm3"] < .005, port["port"]


@pytest.mark.parametrize("family", model.FAMILIES[1:])
def test_ordinary_spans_keep_open_gaps_and_complete_brick_clutch(family):
    evidence = model.probe_tie_attachments(family, parameters())
    assert evidence["openGap"] < .01
    assert evidence["undersideBay"] < .01


@pytest.mark.parametrize("family", [model.FAMILIES[1], model.FAMILIES[2], model.FAMILIES[4]])
def test_all_base_modules_connect_through_real_pullout_stops(family):
    result = model.probe_base_joints(family, parameters())
    assert len(result["retainedConnections"]) >= result["components"]-1
    assert all(joint["blockedVolumeMm3"] > .01 for joint in result["retainedConnections"])


@pytest.mark.parametrize("family", [model.FAMILIES[1], model.FAMILIES[2], model.FAMILIES[4]])
def test_both_selected_endpoints_are_positively_locked_in_both_directions(family):
    results = model.probe_state_locks(family, parameters())
    assert {result["state"] for result in results} == {0, 1}
    assert {result["direction"] for result in results} == {-1, 1}
    assert all(result["blockedVolumeMm3"] > .01 for result in results)


@pytest.mark.parametrize("bend", [-model.MAX_BEND, model.MAX_BEND])
def test_flex_toes_clear_the_wheel_flange_at_both_articulation_limits(bend):
    evidence = model.probe_running_clearances(model.FAMILIES[0], parameters(bend=bend))
    assert evidence["flangeObstructionMm3"] <= .01
    assert evidence["maximumUnsupportedSpanMm"] == 0


def _solid(mesh, specimen):
    return abs(trimesh.boolean.intersection([mesh, specimen], engine="manifold").volume)


def _placed(mesh, frame):
    mesh.apply_transform(frame)
    return mesh


def _planned_features(code):
    """World specimens for every planned tie clutch: studs, pins, ribs, bay interiors."""
    rows = []
    for route, station, frame, columns in model._clutch_plan(code):
        solid, void = [], []
        for v in columns:
            solid += [_placed(brick_end._cylinder(2.3, 3.3, 4.7, u, v), frame) for u in (-4, 4)]
        if any(abs(v) < 28 for v in columns):
            void.append(_placed(brick_end._box((-3, -13, .1), (3, 13, 1.7)), frame))
        for side in (-1, 1):
            if side*28 in columns:
                solid.append(_placed(brick_end._cylinder(1.5, .1, 1.7, 0, side*28), frame))
                solid += [_placed(brick_end._box((u-.75, min(side*24.05, side*25.55), .1),
                                                (u+.75, max(side*24.05, side*25.55), 1.7)), frame) for u in (-4, 4)]
                void += [_placed(brick_end._box((u0, min(side*26, side*30.2), .1),
                                               (u1, max(side*26, side*30.2), 1.7)), frame)
                         for u0, u1 in ((-6.2, -1.8), (1.8, 6.2))]
        rows.append((route, station, columns, solid, void))
    return rows


@pytest.mark.parametrize("code", [1, 2, 4])
def test_every_planned_tie_clutch_is_complete_and_open(code):
    mesh = model._fixed_mesh(code, 0)
    for route, station, columns, solid, void in _planned_features(code):
        for specimen in solid:
            assert _solid(mesh, specimen) == pytest.approx(specimen.volume, abs=.01), (route, station)
        for specimen in void:
            assert _solid(mesh, specimen) < .01, (route, station)


# LDraw 53404 (right turnout) top studs on the straight route, y = +left:
# 92/100..156/164 only +28; 188/196 +28 and the four inner columns; 220/228 all.
@pytest.mark.parametrize("code,side", [(1, 1), (2, -1)])
def test_turnout_straight_ties_follow_official_stud_layout(code, side):
    mesh = model._fixed_mesh(code, 0)
    expected = {96: {28}, 128: {28}, 160: {28}, 192: {28, -12, -4, 4, 12}, 224: {-28, -12, -4, 4, 12, 28}}
    for station, columns in expected.items():
        for v in (-28, -12, -4, 4, 12, 28):
            # A crossing rail may cover part of an absent stud, never all of it.
            present = [_solid(mesh, stud) > .99*stud.volume for x in (station-4, station+4)
                       for stud in [brick_end._cylinder(2.3, 3.3, 4.7, x, side*v)]]
            assert present == [v in columns]*2, (station, side*v)
    frames = {round(station, 3): frame for route, station, frame in model._tie_frames(code) if route == 1}
    assert set(frames) == set(model.SWITCH_DIVERGING_TIES)
    # Diverging sleepers (lateral + = left of travel). 95.365's official -28
    # column would stand in the cassette's travel, so it carries none.
    diverging = {95.365: set(), 127.339: {-28}, 159.314: {-28}, 191.289: {-28, -12, -4, 4, 12},
                 222.228: {-28, -12, -4, 4, 12, 28}, 254.202: {-28, -12, -4, 4, 12, 28}}
    for station, columns in diverging.items():
        for v in (-28, -12, -4, 4, 12, 28):
            present = [_solid(mesh, stud) > .99*stud.volume for u in (-4, 4)
                       for stud in [_placed(brick_end._cylinder(2.3, 3.3, 4.7, u, side*v), frames[station])]]
            assert present == [v in columns]*2, (station, side*v)


@pytest.mark.parametrize("code", [1, 2, 4])
def test_other_routes_keep_features_out_of_a_gauge(code):
    """No stud of one route stands between another route's rails."""
    mesh = model._fixed_mesh(code, 0)
    plan = model._clutch_plan(code)
    paths = model._fixed_paths(code)
    rails = [model._rails(path) for path in paths]
    for route, path in enumerate(paths):
        gauge = model._ribbon(model._station_path(path, 8, model._length(path)-8), 0, 16.3, 3.3, 4.7)
        own = [_placed(brick_end._cylinder(2.5, 3.2, 4.8, u, v), frame)
               for other, _, frame, columns in plan if other == route for v in columns for u in (-4, 4)]
        inside = trimesh.boolean.intersection([mesh, gauge], engine="manifold")
        assert abs(model._difference(inside, own+rails).volume) < .01, route


@pytest.mark.parametrize("code", [1, 2, 3, 4])
def test_rail_stringers_are_hollow_channels_with_intact_walls(code):
    mesh = model._fixed_mesh(code, 0)
    zones = model._floor_zones(code)
    for path in model._fixed_paths(code):
        span = model._station_path(path, 12, model._length(path)-12)
        for lateral in (-20, 20):
            walls = [model._ribbon(span, lateral+s*3.3, .55, .1, 1.7) for s in (-1, 1)]
            for wall in walls:
                wall = model._difference(wall, zones)
                assert _solid(mesh, wall) == pytest.approx(wall.volume, rel=.02)
    if code == 3:
        # Stringers between arm ties are open from below (baseplate studs at +-20).
        assert _solid(mesh, brick_end._box((12, 17.6, .1), (20, 22.4, 2.1))) < .01
        assert _solid(mesh, brick_end._box((12, 18.1, 2.3), (20, 21.9, 3.1))) < .01


@pytest.mark.parametrize("code", [1, 2, 4])
def test_base_seams_fall_in_tie_gaps(code):
    p = parameters()
    ties = [model._rect(frame, -7.9, 7.9, -31.9, 31.9) for _, _, frame in model._tie_frames(code)]
    ties += [model._rect(brick_end._frame(port["position"], port["heading"]+math.pi, 0), -4, 7.9, -31.9, 31.9)
             for port in model.ports(model.FAMILIES[code], p)]
    floors, _ = model._selector_zones(code)
    for a, b in model._seam_segments(code):
        seam = model._section(model._segment_quad(a, b, .6))
        for tie in ties:
            assert not model._overlaps(seam, tie - floors), (a, b)


def _baseplate_hits(mesh, ports):
    """Solid volume inside 1.8 mm baseplate studs on the port-aligned 8 mm grid.

    4.8 mm keeps the approved <=0.05 mm radial clutch contact of a 4.9 mm stud;
    the protected source coupons (first 5.8 mm of each port) are excluded.
    """
    low, high = mesh.bounds
    studs = model._union([brick_end._cylinder(2.4, -.2, 1.8, x, y)
                          for x in np.arange(math.floor((low[0]-4)/8)*8+4, high[0]+8, 8)
                          for y in np.arange(math.floor((low[1]-4)/8)*8+4, high[1]+8, 8)])
    coupons = [_placed(brick_end._box((-4, -34, -1), (5.8, 34, 4)),
                       brick_end._frame(port["position"], port["heading"]+math.pi, 0)) for port in ports]
    return _solid(mesh, model._difference(studs, coupons))


def test_crossing_and_flex_outer_leaf_seat_on_a_studded_baseplate():
    assert _baseplate_hits(model._fixed_mesh(3, 0), model.ports("printed_crossing90", parameters())) < .001
    assert _baseplate_hits(model._flex_mesh(1, 0, 0), model.ports("printed_flex", parameters())[1:]) < .001


def test_crossing_follows_official_32087_arms_and_centre():
    mesh = model._fixed_mesh(3, 0)
    stud = lambda x, y: _solid(mesh, brick_end._cylinder(2.3, 3.3, 4.7, x, y)) > 1
    for v in (-28, -12, -4, 4, 12, 28):
        assert stud(28, v) and stud(100, v) and stud(64+v, 36) and stud(64+v, -36)
    assert stud(36, 28) and stud(36, -28) and not stud(36, 4)
    assert not any(stud(x, y) for x in (52, 60, 68, 76) for y in (-12, -4, 4, 12))
    for x in (56, 64, 72):
        for y in (-8, 0, 8):
            assert _solid(mesh, brick_end._cylinder(2.3, .1, 1.7, x, y)) < .01
            ring = model._difference(brick_end._cylinder(3.15, .1, 1.7, x, y), [brick_end._cylinder(2.45, 0, 2, x, y)])
            assert _solid(mesh, ring) == pytest.approx(ring.volume, rel=1e-3)


@pytest.mark.parametrize("index", [0, 1])
def test_flex_half_ties_are_full_with_closed_bays_and_four_studs(index):
    leaf = model._flex_mesh(index, 0, 0)
    frame = brick_end._frame((0, 0, 0), 0, 0) if index == 0 else brick_end._frame((32, 0, 0), math.pi, 0)
    for v in (-28, 28):
        bay = _placed(brick_end._box((1.8, min(v*26/28, v*30.2/28), .1), (6.2, max(v*26/28, v*30.2/28), 1.7)), frame)
        roof = _placed(brick_end._box((1.7, min(v*24.2/28, v*30.2/28), 1.9), (7.8, max(v*24.2/28, v*30.2/28), 3.1)), frame)
        assert _solid(leaf, bay) < .01
        assert _solid(leaf, roof) == pytest.approx(roof.volume, abs=.01)
    for v, present in ((-28, True), (-12, False), (-4, True), (4, True), (12, False), (28, True)):
        stud = _placed(brick_end._cylinder(2.3, 3.3, 4.7, 4, v), frame)
        assert (_solid(leaf, stud) > 1) == present, v
        # Full-height deck behind the coupon; the pivot leaf keeps its nut
        # drop and hub-disc clearance open on the centreline.
        if index or abs(v) > 4:
            land = _placed(brick_end._box((6.6, v-3, 3.0), (7.8, v+3, 3.15)), frame)
            assert _solid(leaf, land) == pytest.approx(land.volume, abs=.01), v


@pytest.mark.parametrize("index,link", [(0, (8.5, 13.5)), (1, (16.5, 23.5))])
def test_flex_link_is_open_outside_the_rails_with_official_guard_ridges(index, link):
    leaf = model._flex_mesh(index, 0, 0)
    for sign in (-1, 1):
        outside = brick_end._box((link[0], min(sign*24.5, sign*31.5), -.1), (link[1], max(sign*24.5, sign*31.5), 9.7))
        ridge = brick_end._box((link[0], min(sign*13.5, sign*14.7), 3.3), (link[1], max(sign*13.5, sign*14.7), 9.5))
        floor = brick_end._box((link[0], min(sign*15, sign*18), 3.3), (link[1], max(sign*15, sign*18), 6.3))
        gap = brick_end._box((link[0], min(sign*15, sign*16.5), 6.5), (link[1], max(sign*15, sign*16.5), 9.7))
        assert _solid(leaf, outside) < .01
        assert _solid(leaf, ridge) == pytest.approx(ridge.volume, rel=1e-4)
        assert _solid(leaf, floor) == pytest.approx(floor.volume, rel=1e-4)
        assert _solid(leaf, gap) < .01


@pytest.mark.parametrize("code", [1, 2, 4])
def test_selector_side_end_ties_and_first_straight_tie_are_full(code):
    mesh = model._fixed_mesh(code, 0)
    for port in model.ports(model.FAMILIES[code], parameters()):
        top = _placed(brick_end._box((6.5, -31.5, 2.3), (7.8, 31.5, 3.1)),
                      brick_end._frame(port["position"], port["heading"]+math.pi, 0))
        assert _solid(mesh, top) == pytest.approx(top.volume, rel=1e-4), port["id"]
    # The cassette pocket ends before the straight tie at 88.1-103.9 (its
    # deck top reaches 88.1 across the tie, outside the rail channels).
    for origin, heading, _ in model._selectors(code):
        for low, high in ((-31.5, -23.5), (-16, 16), (23.5, 31.5)):
            tie = _placed(brick_end._box((88.1, low, 2.3), (90.5, high, 3.1)), model._selector_frame(origin, heading))
            assert _solid(mesh, tie) == pytest.approx(tie.volume, rel=1e-3), (origin, low)


@pytest.mark.parametrize("code", [1, 2, 4])
def test_keepers_seat_clear_of_fixed_rails_and_studs(code):
    fixed = model._fixed_mesh(code, 0)
    for origin, heading, sign in model._selectors(code):
        for x in (9.5, 92.):
            assert _solid(fixed, model._keeper(origin, heading, x, sign)) < .001, (origin, x)


@pytest.mark.parametrize("code", [1, 2, 4])
def test_base_pieces_have_no_sloped_facets_below_the_deck_top(code):
    """Every authored face below z=3.2 is vertical or horizontal; a sloped one
    is a boolean artefact (e.g. a missing wedge). Source coupons are exempt."""
    ports = model.ports(model.FAMILIES[code], parameters())
    frames = [np.linalg.inv(brick_end._frame(port["position"], port["heading"]+math.pi, 0)) for port in ports]
    for index, piece in enumerate(model._base_pieces(code, 0)):
        normal, centre = piece.face_normals, piece.triangles_center
        # Float slivers flat within 0.01 mm are retriangulated on export.
        rise = np.ptp(piece.triangles[:, :, 2], axis=1)
        suspect = centre[(np.abs(normal[:, 2]) > .01) & (np.abs(normal[:, 2]) < .999)
                         & (centre[:, 2] < 3.15) & (rise > .01)]
        for point in suspect:
            local = [frame @ np.array([*point, 1]) for frame in frames]
            assert any(u < 5.85 and abs(v) < 34 for u, v, _, _ in local), (index, point)
