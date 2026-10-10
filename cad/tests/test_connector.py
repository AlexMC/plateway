"""Geometric tests with synthetic/unverified measurements, not a brick fit claim."""

import copy
import hashlib
from pathlib import Path

import numpy as np
import pytest
import trimesh

from cad.service.generate import generate_part


def test_coupon_has_one_closed_printable_mesh_with_measured_parameter_bounds(tmp_path, connector_request):
    result = generate_part(connector_request, tmp_path)
    mesh = trimesh.load_mesh(result["mesh"], process=True)
    assert mesh.is_watertight and mesh.is_winding_consistent and mesh.volume > 0
    assert np.allclose(mesh.extents, [44.5, 24, 6], atol=0.03)
    assert np.allclose(mesh.bounds[0], [0, -12, 0], atol=0.03)
    assert result["bounds"]["size"] == pytest.approx([44.5, 24, 6], abs=1e-5)
    assert result["digest"] == hashlib.sha256(Path(result["mesh"]).read_bytes()).hexdigest()
    assert Path(result["step"]).stat().st_size > 0
    assert result["ports"][0]["position"] == [0, 0, 0]
    assert result["ports"][1]["position"] == [40, 0, 0]
    # Sample actual STL vertices: mating tongue and rail rib width/gauge.
    tip = mesh.vertices[np.isclose(mesh.vertices[:, 0], 44.5, atol=0.03)]
    assert tip[:, 1].min() == pytest.approx(-3, abs=0.03)
    assert tip[:, 1].max() == pytest.approx(3, abs=0.03)
    rail_tops = mesh.vertices[np.isclose(mesh.vertices[:, 2], 6, atol=0.03)]
    for side in (-1, 1):
        assert np.any(np.isclose(rail_tops[:, 1], side * 7, atol=0.03))
        assert np.any(np.isclose(rail_tops[:, 1], side * 9, atol=0.03))


def test_clearance_changes_socket_mesh_not_rails_or_tongue(tmp_path, connector_request):
    before = generate_part(connector_request, tmp_path / "before")
    changed = copy.deepcopy(connector_request)
    changed["parameters"]["socket_clearance"] = 0.5
    after = generate_part(changed, tmp_path / "after")
    a = trimesh.load_mesh(before["mesh"], process=True)
    b = trimesh.load_mesh(after["mesh"], process=True)
    assert b.volume < a.volume
    assert a.extents == pytest.approx(b.extents, abs=0.03)
    assert before["ports"] == after["ports"]
    assert before["digest"] != after["digest"]
    for mesh, opening in ((a, 3.2), (b, 3.5)):
        mouth = mesh.vertices[np.isclose(mesh.vertices[:, 0], 0, atol=0.03)]
        assert np.any(np.isclose(mouth[:, 1], opening, atol=0.03))
        assert np.any(np.isclose(mouth[:, 1], -opening, atol=0.03))


def test_connector_rejects_uncuttable_socket(tmp_path, connector_request):
    connector_request["parameters"]["socket_clearance"] = 2
    with pytest.raises(ValueError):
        generate_part(connector_request, tmp_path)
    assert not list(tmp_path.iterdir())
