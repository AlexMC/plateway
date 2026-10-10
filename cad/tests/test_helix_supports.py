"""Helix column lugs (composite ``socket``), stackable helix column tubes and wall/shelf track brackets:
digital geometry only, never load ratings."""

import math

import numpy as np
import pytest
import trimesh

from cad.models import composite, helix_column, brick_end, track_bracket
from cad.service.generate import generate_part
from cad.tests.test_composite import parameters, request

R72, SECTOR = 576, math.radians(11.25)
LENGTH, GRADE = R72 * SECTOR, .0398


def helix(**changes):
    return parameters([(LENGTH, 1 / R72, 1 / R72)], z1=LENGTH * GRADE, grade0=GRADE, grade1=GRADE, **changes)


def lug(side=1, offset=56., **changes):
    return helix(socket=1, socket_s=LENGTH / 2, socket_side=side, socket_offset=offset, **changes)


def column_axis(spec, side, offset):
    """Plan position of the bore the CAD puts on the full tie nearest socket_s."""
    full = composite._ties(spec)[1:-1]
    low, high = min(full, key=lambda tie: abs((tie[0] + tie[1]) / 2 - spec.socket_s))
    frame = composite.Route(spec).bed_frame((low + high) / 2)
    return (frame @ np.array([0, side * offset, 0, 1]))[:2], frame[2, 3]


@pytest.mark.parametrize("lite", [False, True])
@pytest.mark.parametrize("side", [1, -1])
def test_lug_is_one_solid_on_the_underside_with_an_open_bore_at_the_offset(lite, side):
    p = lug(side, **({"lite": 1} if lite else {}))
    mesh, spec = composite.track_mesh(p), composite.validate(p)
    plain = composite.track_mesh(helix(**({"lite": 1} if lite else {})))
    assert mesh.is_watertight and mesh.body_count == 1
    assert mesh.volume > plain.volume
    (x, y), floor = column_axis(spec, side, 56)
    # The lug lies on the flat underside: nothing hangs below it, and the bore goes right through.
    assert mesh.bounds[0, 2] == pytest.approx(plain.bounds[0, 2], abs=1e-6)
    assert floor == pytest.approx(spec.base, abs=1e-9)
    radius = np.hypot(mesh.triangles_center[:, 0] - x, mesh.triangles_center[:, 1] - y)
    assert not (radius < composite.LUG_BORE / 2 - .3).any()
    top = np.isclose(mesh.triangles_center[:, 2], floor + composite.LUG_THICKNESS, atol=1e-3)
    assert (top & (radius > composite.LUG_BORE / 2) & (radius < composite.LUG_RING / 2)).any()


def test_no_socket_keys_leave_the_track_unchanged():
    base = composite.track_mesh(helix())
    off = composite.track_mesh(helix(socket=0, socket_s=0, socket_side=1, socket_offset=0))
    assert off.volume == pytest.approx(base.volume, abs=1e-9)
    assert np.allclose(off.bounds, base.bounds)


@pytest.mark.parametrize("changes,message", [
    ({"socket_side": 0}, "socket_side"), ({"socket_offset": 30}, "socket_offset"), ({"socket_s": -1}, "socket_s"),
])
def test_lug_parameters_are_checked(changes, message):
    with pytest.raises(ValueError, match=message):
        composite.validate({**lug(), **changes})


def test_column_tubes_stack_through_a_lug():
    # Spigot passes the lug bore with clearance and reaches the next tube's socket; the shoulder is wider than the bore.
    assert helix_column.SPIGOT < composite.LUG_BORE < helix_column.DIAMETER < composite.LUG_RING
    assert helix_column.LUG == composite.LUG_THICKNESS
    assert helix_column.SOCKET_DEPTH > helix_column.ENGAGE and helix_column.SOCKET > helix_column.SPIGOT
    tube = helix_column.build({"height": 134.4, "foot": 0, "spigot": helix_column.ENGAGE + helix_column.LUG})
    box = tube.BoundingBox()
    assert (box.zmin, box.zmax) == pytest.approx((0, 134.4 + helix_column.ENGAGE + helix_column.LUG))
    assert len(tube.Solids()) == 1 and tube.isValid()


@pytest.mark.parametrize("changes,message", [
    ({"height": 10, "foot": 0}, "column height"), ({"foot": 2}, "foot"), ({"spigot": 4}, "spigot"), ({"height": 300}, "column height"),
])
def test_column_parameters_are_checked(changes, message):
    with pytest.raises(ValueError, match=message):
        helix_column.validate({"height": 40, "foot": 1, "spigot": 11.2, **changes})


def _mesh(shape, tmp_path, name):
    path = tmp_path / f"{name}.stl"
    import cadquery as cq
    cq.exporters.export(shape, str(path), exportType="STL", tolerance=.02, angularTolerance=.1)
    return trimesh.load_mesh(path)


@pytest.mark.parametrize("mount,reach,height", [(1, 48, 0), (1, 72, 0), (1, 150, 0), (2, 72, 10), (2, 150, 120)])
def test_brackets_print_as_installed_without_support(tmp_path, mount, reach, height):
    shape = track_bracket.build({"mount": mount, "reach": reach, "height": height})
    assert shape.isValid() and len(shape.Solids()) == 1
    mesh = _mesh(shape, tmp_path, f"bracket-{mount}-{reach}")
    assert mesh.is_watertight
    # Studs on top at the eight baseplate positions under a sleeper; the seat top at z = 0.
    a = brick_end.PROFILE["brickAttachment"]
    assert mesh.bounds[1, 2] == pytest.approx(a["studHeight"])
    centres = mesh.triangles_center
    for x, y in track_bracket.STUDS:
        on_top = np.isclose(centres[:, 2], a["studHeight"], atol=1e-3) & (np.hypot(centres[:, 0] - x, centres[:, 1] - y) < a["studDiameter"] / 2)
        assert on_top.any()
    # Every downward face either sits on the bed or leans at 45 degrees or steeper (no painted support needed).
    low = mesh.bounds[0, 2]
    normals, centres = mesh.face_normals, mesh.triangles_center
    hanging = (normals[:, 2] < -math.cos(math.radians(45)) - 1e-6) & (centres[:, 2] > low + .05)
    # The seat flange's own underside under the studs is the only flat roof; it rests on the knee/pedestal (no area).
    assert mesh.area_faces[hanging].sum() < 1.


def test_wall_bracket_reaches_the_wall_and_holds_the_track_clear_of_it():
    shape = track_bracket.build({"mount": 1, "reach": 72, "height": 0})
    box = shape.BoundingBox()
    assert box.ymax == pytest.approx(72) and box.zmin == pytest.approx(-track_bracket.knee_height(72))
    assert box.xmax - box.xmin == pytest.approx(track_bracket.THICK)


@pytest.mark.parametrize("family,p", [
    ("helix_column", {"height": 40, "foot": 1, "spigot": 11.2}),
    ("helix_column", {"height": 134.4, "foot": 0, "spigot": 11.2}),
    ("track_bracket", {"mount": 1, "reach": 72, "height": 0}),
    ("track_bracket", {"mount": 2, "reach": 96, "height": 24}),
])
def test_generate_part_checks_the_new_families(tmp_path, family, p):
    result = generate_part(request(family, p), tmp_path)
    assert result["ports"] == [] and result["mounting_interface"] is None
    assert trimesh.load_mesh(result["mesh"]).is_watertight


def test_lugged_helix_section_generates_as_a_checked_part(tmp_path):
    result = generate_part(request(composite.FAMILY, lug(-1)), tmp_path)
    mesh = trimesh.load_mesh(result["mesh"])
    assert mesh.is_watertight and mesh.body_count == 1
