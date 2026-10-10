"""Layout riser block: plate-multiple heights, tie-matched top studs, full-grid underside sockets."""

import cadquery as cq
import pytest
import trimesh

from cad.models import riser
from cad.service.generate import generate_part


def request(parameters):
    return {"version": 1, "units": "mm", "family": "layout_riser", "parameters": parameters,
            "printer_envelope": {"x": 180, "y": 180, "z": 180},
            "part_revision": "riser", "layout_revision": "synthetic-layout"}


GRID_Y = (-28, -20, -12, -4, 4, 12, 20, 28)


def section(shape, z):
    """Faces of a horizontal cut through the CAD solid."""
    return cq.Workplane("XY").add(shape).section(z).faces().vals()


def centres(items):
    return sorted((round(item.Center().x, 6), round(item.Center().y, 6)) for item in items)


@pytest.mark.parametrize("height", [3.2, 3 * 3.2, 32.0])
def test_block_is_one_watertight_solid_with_studs_above_its_height(tmp_path, height):
    result = generate_part(request({"height": height, "fit_adjustment": 0}), tmp_path)
    mesh = trimesh.load_mesh(result["mesh"])
    assert mesh.is_watertight and len(mesh.split(only_watertight=False)) == 1
    assert result["bounds"]["min"] == pytest.approx([-15.9, -31.9, 0])
    assert result["bounds"]["size"] == pytest.approx([31.8, 63.8, height + 1.6])
    assert result["mounting_interface"] == {"position": [0, 0, height]}
    assert result["ports"] == []
    assert result["step"] is not None


def test_top_carries_sixteen_studs_only_where_a_full_tie_clutches():
    shape = riser.build({"height": 6.4, "fit_adjustment": 0})
    studs = section(shape, 6.4 + .8)
    assert centres(studs) == sorted((x, y) for x in (-4, 4) for y in GRID_Y)
    for stud in studs:
        assert not stud.innerWires()
        assert stud.Area() == pytest.approx(3.14159265 * 2.4 ** 2, rel=1e-6)
    assert shape.BoundingBox().zmax == pytest.approx(6.4 + 1.6)


@pytest.mark.parametrize("adjustment", [-.15, 0, .15])
def test_underside_has_a_socket_at_all_32_grid_positions_sized_by_fit_adjustment(adjustment):
    shape = riser.build({"height": 3.2, "fit_adjustment": adjustment})
    side = 4.8 + 2 * adjustment
    [bottom] = section(shape, .9)
    sockets = bottom.innerWires()
    assert centres(sockets) == sorted((x, y) for x in (-12, -4, 4, 12) for y in GRID_Y)
    for socket in sockets:
        box = socket.BoundingBox()
        assert (box.xlen, box.ylen) == pytest.approx((side, side), abs=1e-6)
    assert bottom.Area() == pytest.approx(31.8 * 63.8 - 32 * side ** 2, rel=1e-9)
    # Sockets are at least one stud height plus 0.2 mm deep, then roofed solid.
    assert len(section(shape, 1.79)[0].innerWires()) == 32
    assert not section(shape, 1.81)[0].innerWires()


def test_risers_stack_stud_into_socket_and_a_tighter_fit_grips():
    def interference(adjustment):
        lower = riser.build({"height": 9.6, "fit_adjustment": 0})
        upper = riser.build({"height": 9.6, "fit_adjustment": adjustment}).translate(cq.Vector(0, 0, 9.6))
        return lower.intersect(upper).Volume()
    assert interference(0) == pytest.approx(0, abs=1e-3)
    assert interference(-.15) > 1


@pytest.mark.parametrize("parameters", [
    {"height": 4.0, "fit_adjustment": 0},
    {"height": 3.2 + 1e-4, "fit_adjustment": 0},
    {"height": 1.6, "fit_adjustment": 0},
    {"height": 0, "fit_adjustment": 0},
    {"height": 35.2, "fit_adjustment": 0},
    {"height": 6.4, "fit_adjustment": .151},
    {"height": 6.4, "fit_adjustment": -.151},
    {"height": 6.4},
    {"height": 6.4, "fit_adjustment": 0, "connector_version": 1},
    {"height": True, "fit_adjustment": 0},
])
def test_rejects_unprintable_or_off_profile_requests_without_artifacts(tmp_path, parameters):
    with pytest.raises(ValueError):
        generate_part(request(parameters), tmp_path)
    with pytest.raises(ValueError):
        riser.validate(parameters)
    assert not list(tmp_path.iterdir())
