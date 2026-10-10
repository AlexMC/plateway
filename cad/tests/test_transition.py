"""Digital tests of unverified trial transition geometry and tangent continuity."""

import copy
import math

import numpy as np
import pytest
import trimesh

from cad.models import transition
from cad.service.generate import generate_part


def _profile_edge(shape, run):
    edges = [edge for edge in shape.Edges()
             if math.isclose(edge.BoundingBox().xlen, run, abs_tol=0.001)
             and edge.geomType() == "BEZIER"]
    assert edges, "a Bezier rail/deck edge must span both ports"
    return edges[0]


@pytest.mark.parametrize("rise,start_grade,end_grade", [
    (0, 0, 0), (8, 0, 0), (8, 0.05, 0.15), (-8, -0.05, -0.15),
])
def test_transition_actual_mesh_endpoints_and_cad_tangents(tmp_path, transition_request,
                                                           rise, start_grade, end_grade):
    p = transition_request["parameters"]
    p.update(rise=rise, start_grade=start_grade, end_grade=end_grade)
    shape = transition.build(p)
    edge = _profile_edge(shape, p["run"])
    # An edge may be traversed in either direction within the shell.
    endpoints = sorted(((edge.positionAt(t).x, edge.tangentAt(t)) for t in (0, 1)),
                       key=lambda pair: pair[0])
    for (_, tangent), grade in zip(endpoints, (start_grade, end_grade)):
        assert tangent.z / tangent.x == pytest.approx(grade, abs=1e-8)
    result = generate_part(transition_request, tmp_path)
    mesh = trimesh.load_mesh(result["mesh"], process=True)
    assert mesh.is_watertight and mesh.is_winding_consistent and mesh.volume > 0
    assert mesh.extents == pytest.approx([80, 24, abs(rise) + 6], abs=0.03)
    assert result["ports"][0]["position"] == [0, 0, 0]
    assert result["ports"][1]["position"] == [80, 0, rise]
    for port, grade in zip(result["ports"], (start_grade, end_grade)):
        assert port["pitch"] == pytest.approx(math.atan(grade))
        assert port["tangent"] == pytest.approx([1 / math.hypot(1, grade), 0,
                                                  grade / math.hypot(1, grade)])
    assert np.allclose(mesh.bounds[0], [0, -12, min(0, rise)], atol=0.03)


def test_increased_rise_changes_mesh_not_gauge(tmp_path, transition_request):
    flat = generate_part(transition_request, tmp_path / "low")
    higher = copy.deepcopy(transition_request)
    higher["parameters"]["rise"] = 12
    elevated = generate_part(higher, tmp_path / "high")
    low_mesh = trimesh.load_mesh(flat["mesh"])
    high_mesh = trimesh.load_mesh(elevated["mesh"])
    assert high_mesh.extents[2] - low_mesh.extents[2] == pytest.approx(4, abs=0.03)
    assert high_mesh.extents[1] == pytest.approx(low_mesh.extents[1], abs=0.03)
    assert elevated["ports"][1]["position"][2] == 12
    assert elevated["digest"] != flat["digest"]


def test_rejects_transition_with_unintended_dip(tmp_path, transition_request):
    transition_request["parameters"].update(rise=8, start_grade=2, end_grade=2)
    with pytest.raises(ValueError, match="monotone"):
        generate_part(transition_request, tmp_path)
    assert not list(tmp_path.iterdir())
