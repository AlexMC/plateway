"""Crossovers and slips on the point-blade framework; digital geometry only, never physical fit."""
import math

import cadquery as cq
import pytest

from cad.models import crossover_slip as cs
from cad.models import brick_end as end
from cad.models import turnout as T

R40_TURN = math.atan2(3, 4)
CROSSOVER = {"spacing": 128., "length": 384., "radius": 320., "angle": R40_TURN, "middle": 0.}
SLIP = {"angle": math.pi/4, "length": 376., "radius": 188/math.tan(math.pi/8)}
SHAPES = [("crossover_single", CROSSOVER), ("crossover_scissors", CROSSOVER),
          ("slip_single", SLIP), ("slip_double", SLIP)]


def params(shape, **extra):
    return {"connector_version": 1, "fit_adjustment": 0, "switch_state": 0, **shape, **extra}


@pytest.mark.parametrize("family,shape", SHAPES)
def test_every_piece_plans_bed_sized_tiles_with_points_clear_of_every_frog(family, shape):
    spec = cs._spec(family, params(shape))
    lay = T.layout(spec)
    for part in T._parts(lay.region - T._union_cs([T.ta._section(T.ta._segment_quad(a, b, .1)) for a, b in lay.seams])):
        x0, y0, x1, y1 = part.bounds()
        assert max(x1 - x0, y1 - y0) <= T.PLAN_BED + 1e-6
    for points in T.points_of(spec):
        assert not T.ta._overlaps(points.swept(), T._union_cs(
            [T.manifold3d.CrossSection.circle(T.FROG_CLEAR, 16).translate(tuple(p)) for p in lay.crossings]))


def test_tight_scissors_splits_into_keyed_solid_tiles_without_offcuts():
    # At 16 studs the lanes run bare beside the diamond: a seam plan on the deck outline chopped their rails into
    # offcuts that neither rejoined nor keyed.
    spec = cs._spec("crossover_scissors", params(CROSSOVER))
    tiles = T._base_pieces(spec, 0., True)
    assert all(len(tile.split(only_watertight=False)) == 1 and tile.volume >= T.FRAGMENT for tile in tiles)
    assert T.probe_base_joints(spec, 0., True)["components"] == len(tiles)


def scissors(spacing, length, hand=1):
    """A scissors whose diagonals are plain S-bends (no middle straight), as crossover.ts solves them."""
    angle = 2*math.atan2(spacing, length)
    return {"spacing": hand*spacing, "length": length, "radius": length/2/math.sin(angle), "angle": angle, "middle": 0.}


@pytest.mark.parametrize("shape", [
    scissors(176, 448),           # a seam ending on the hole beside the diamond: the deck edge bridged two tiles past the kerf
    scissors(128, 464, hand=-1),  # a refilled kerf left a stringer wedge apart from every neighbour, with no key
    scissors(168, 440),           # bridged too, and the recut's rejoined lane offcut held on only by coincident faces
], ids=["22-studs-R40", "16-studs-R56-right", "21-studs-R40"])
def test_scissors_whose_first_cut_fails_are_recut_into_sound_keyed_tiles(shape):
    spec = cs._spec("crossover_scissors", params(shape))
    tiles = T._base_pieces(spec, 0., True)
    for i, tile in enumerate(tiles):
        T.check_mesh(f"keyed-base-{i+1:02d}", tile)
    assert T.probe_base_joints(spec, 0., True)["components"] == len(tiles)


def test_a_tile_cut_down_to_needle_triangles_still_exports_as_one_valid_solid(tmp_path):
    # 24 studs R72: the kerf cuts left keyed-base-15 with sub-micron needle triangles. Its sewn solid was valid until the
    # STL export tessellated it, so the part could not be published.
    row = cs.components("crossover_scissors", params(scissors(192, 640)))[14]
    assert row["role"] == "keyed-base-15"
    shape = cs.build_component(row["parameters"])
    cq.exporters.export(shape, str(tmp_path / "tile.stl"), exportType="STL", tolerance=end.STL_TOLERANCE,
                        angularTolerance=end.STL_ANGULAR_TOLERANCE)
    assert shape.isValid() and len(shape.Solids()) == 1 and shape.Volume() > 0


def test_states_open_exactly_their_routes():
    def open_pairs(family, shape, state):
        return {tuple(sorted(pair)) for pair, enabled in cs.route_pairs(family, params(shape, switch_state=state)).items() if enabled}
    assert open_pairs("slip_double", SLIP, 0) == {("in", "out"), ("cross-in", "cross-out")}
    assert open_pairs("slip_double", SLIP, 1) == {("cross-out", "in")}
    assert open_pairs("slip_double", SLIP, 2) == {("cross-in", "out")}
    assert open_pairs("slip_double", SLIP, 3) == {("cross-out", "in"), ("cross-in", "out")}
    assert open_pairs("crossover_scissors", CROSSOVER, 1) == {("in", "parallel-out"), ("out", "parallel-in")}


def test_ports_sit_on_the_tracks_the_editor_draws():
    ports = {row["id"]: row for row in cs.ports("slip_single", params(SLIP))}
    half = 188.
    assert ports["cross-out"]["position"][:2] == pytest.approx([half + half*math.cos(math.pi/4), half*math.sin(math.pi/4)])
    assert ports["cross-in"]["heading"] == pytest.approx(math.pi/4 + math.pi)
    scissors = {row["id"]: row for row in cs.ports("crossover_scissors", params(CROSSOVER))}
    assert scissors["parallel-out"]["position"][:2] == pytest.approx([384., 128.])


@pytest.mark.parametrize("family,shape,change", [
    ("crossover_scissors", CROSSOVER, {"spacing": 256.}),           # diamond no longer splits to the bed
    ("crossover_scissors", CROSSOVER, {"spacing": 136.}),           # diagonal no longer joins the tracks
    ("crossover_single", CROSSOVER, {"radius": 300., "length": 360.}),
    ("slip_double", SLIP, {"radius": SLIP["radius"] + 1}),           # curve not tangent at both ports
    ("slip_single", SLIP, {"angle": math.radians(10)}),
])
def test_rejects_geometry_the_editor_never_makes(family, shape, change):
    with pytest.raises(ValueError):
        cs.validate(family, params({**shape, **change}))


def test_slip_components_are_bed_sized_solids_and_its_points_work_in_every_state():
    p = params(SLIP, lite=1)
    for row in cs.components("slip_single", p):
        shape = cs.build_component(row["parameters"])
        box = shape.BoundingBox()
        assert shape.isValid() and max(box.xlen, box.ylen) <= T.BED + 1e-3
    report = cs.probes("slip_single", p)
    assert report["motion"]["maximumInterferenceMm3"] == 0
    assert all(stop["blockedVolumeMm3"] > 1 for stop in report["retention"])
    assert all(lock["blockedVolumeMm3"] > 1 for lock in report["locks"])
    assert len(report["running"]) == 2
