"""Synthetic support checks cover geometry only, never allowable load or anchors."""

import copy
import math

import cadquery as cq
import pytest
import trimesh

from cad.models import support
from cad.service.generate import generate_part


COLUMN = {"height": 50, "foot_length": 36, "foot_width": 28,
          "foot_thickness": 4, "stem_width": 8, "stem_depth": 8,
          "seat_width": 24, "seat_depth": 20, "seat_thickness": 4}
BRACKET = {"height": 80, "reach": 40, "plate_width": 24,
           "plate_thickness": 5, "arm_width": 8, "arm_thickness": 8,
           "hole_diameter": 5, "hole_spacing": 35,
           "seat_width": 24, "seat_depth": 20, "seat_thickness": 5}


def request(family, parameters):
    return {"version": 1, "units": "mm", "family": family, "parameters": parameters,
            "printer_envelope": {"x": 120, "y": 100, "z": 150},
            "part_revision": "synthetic-support", "layout_revision": "synthetic-layout"}


@pytest.mark.parametrize("height", [30, 100])
def test_reversible_seat_tracks_height_and_bed_pose(tmp_path, height):
    params = {**COLUMN, "height": height}
    result = generate_part(request("reversible_column", params), tmp_path)
    assert result["bounds"]["size"] == pytest.approx([36, 28, height])
    assert result["mounting_interface"]["position"] == [0, 0, height]
    assert result["bounds"]["min"] == pytest.approx([-18, -14, 0])
    assert trimesh.load_mesh(result["mesh"]).is_watertight
    assert result["ports"] == []


@pytest.mark.parametrize("height", [5, 10])
def test_shallow_riser_has_bed_backed_full_seat_without_a_floating_cap(tmp_path, height):
    params = {**COLUMN, "height": height, "seat_width": 45}
    result = generate_part(request("reversible_column", params), tmp_path)
    assert result["mounting_interface"]["position"] == [0, 0, height]
    assert result["bounds"]["size"] == pytest.approx([36, 45, height])
    mesh = trimesh.load_mesh(result["mesh"])
    assert mesh.is_watertight
    assert mesh.bounds[0][2] == pytest.approx(0)


@pytest.mark.parametrize("height", [0.5, 1.51, 3.9])
def test_column_lower_than_its_foot_is_a_flat_packer_at_the_exact_height(tmp_path, height):
    # A climb's first graded part can sit a millimetre or two above the table: its column is a seat-sized packer.
    result = generate_part(request("reversible_column", {**COLUMN, "height": height}), tmp_path)
    assert result["mounting_interface"]["position"] == [0, 0, height]
    assert result["bounds"]["size"] == pytest.approx([20, 24, height])
    assert trimesh.load_mesh(result["mesh"]).is_watertight


@pytest.mark.parametrize("height,pitch", [(14.22, 0.05), (25.78, -0.0533), (6, 0.05), (2, 0.05)])
def test_tilted_seat_meets_a_sloped_underside_through_its_seat_centre(tmp_path, height, pitch):
    params = {**COLUMN, "height": height, "seat_pitch": pitch}
    result = generate_part(request("reversible_column", params), tmp_path)
    assert result["mounting_interface"]["position"] == [0, 0, height]
    mesh = trimesh.load_mesh(result["mesh"])
    assert mesh.is_watertight and mesh.bounds[0][2] == pytest.approx(0)
    # Every point of the top lies on the track's underside plane: z = height + x tan(pitch) over the whole seat.
    rise = math.tan(pitch)
    top = mesh.vertices[mesh.vertices[:, 2] >= height - COLUMN["seat_depth"] / 2 * abs(rise) - 1e-6]
    assert abs(top[:, 0]).max() == pytest.approx(COLUMN["seat_depth"] / 2)
    assert top[:, 2] == pytest.approx(height + top[:, 0] * rise, abs=1e-4)
    assert mesh.bounds[1][2] == pytest.approx(height + COLUMN["seat_depth"] / 2 * abs(rise), abs=1e-4)


def test_tilted_seat_must_stay_above_the_bed(tmp_path):
    with pytest.raises(ValueError, match="above the bed"):
        generate_part(request("reversible_column", {**COLUMN, "height": 0.6, "seat_pitch": 0.05}), tmp_path)
    assert not list(tmp_path.iterdir())



def test_bracket_has_two_real_mounting_holes_and_independent_hardware(tmp_path):
    result = generate_part(request("anchored_bracket", BRACKET), tmp_path)
    assert result["mounting_interface"]["position"] == [40, 0, 80]
    shape = support.anchored(BRACKET)
    plate = cq.Solid.makeBox(5, 24, 80, cq.Vector(0, -12, 0))
    assert shape.Volume() < (plate.Volume() + 35 * 8 * 8 + 20 * 24 * 5)
    for z in ((80 - 35) / 2, (80 + 35) / 2):
        bore = cq.Solid.makeCylinder(2, 7, cq.Vector(-1, 0, z), cq.Vector(1, 0, 0))
        assert shape.intersect(bore).Volume() == pytest.approx(0, abs=1e-5)
    assert result["bounds"]["min"][2] == 0


def test_rejects_invalid_holes_and_excess_height_without_artifacts(tmp_path):
    bracket = request("anchored_bracket", BRACKET)
    bracket["parameters"]["hole_spacing"] = 70
    with pytest.raises(ValueError, match="two clear holes"):
        generate_part(bracket, tmp_path)
    column = request("reversible_column", {**COLUMN, "height": 160})
    with pytest.raises(ValueError, match="too large"):
        generate_part(column, tmp_path)
    assert not list(tmp_path.iterdir())


def test_support_requests_have_distinct_revisions_when_height_changes(tmp_path):
    first = request("reversible_column", COLUMN)
    second = copy.deepcopy(first)
    second["parameters"]["height"] = 60
    a, b = generate_part(first, tmp_path), generate_part(second, tmp_path)
    assert a["request_digest"] != b["request_digest"]
    assert a["digest"] != b["digest"]
