"""Synthetic digital fixtures; no dimensions here assert brick fit or train traction."""

import copy
import math
from pathlib import Path

import pytest
import trimesh

from cad.service.generate import generate_part


def request(family, parameters):
    return {"version": 1, "units": "mm", "family": family, "parameters": parameters,
            "printer_envelope": {"x": 200, "y": 200, "z": 100},
            "part_revision": "synthetic-rail", "layout_revision": "synthetic-layout"}


def profile():
    return {"body_width": 24, "base_thickness": 4, "rail_gauge": 16,
            "rail_interface_width": 2, "rail_height": 2,
            "joint_width": 6, "joint_depth": 5, "joint_height": 2, "joint_clearance": .2}


def test_printed_straight_exact_ports_gauge_mesh_and_step(tmp_path):
    result = generate_part(request("printed_straight", {"run": 73, **profile()}), tmp_path)
    mesh = trimesh.load_mesh(result["mesh"])
    assert mesh.is_watertight and mesh.volume > 0
    assert Path(result["step"]).is_file() and Path(result["source"]).is_file()
    assert result["bounds"]["size"] == pytest.approx([73, 24, 6])
    assert result["ports"][0]["position"] == [0, 0, 0]
    assert result["ports"][1]["position"] == [73, 0, 0]
    assert all(port["rail_gauge"] == 16 for port in result["ports"])
    assert result["bounds"]["min"] == pytest.approx([0, -12, 0])


@pytest.mark.parametrize("sweep", [math.pi / 3, -math.pi / 3])
def test_curve_exact_end_pose_both_turns(tmp_path, sweep):
    params = {"radius": 90, "sweep": sweep, **profile()}
    result = generate_part(request("printed_curve", params), tmp_path)
    end = result["ports"][1]
    assert end["position"] == pytest.approx([90 * math.sin(abs(sweep)),
                                               math.copysign(90 * (1-math.cos(sweep)), sweep), 0])
    assert end["heading"] == pytest.approx(sweep)
    assert end["tangent"] == pytest.approx([math.cos(sweep), math.sin(sweep), 0])
    assert result["ports"][0]["rail_gauge"] == 16
    assert result["bounds"]["size"][2] == pytest.approx(6)


def test_distinct_geometry_and_strict_curve_contract(tmp_path):
    first = request("printed_curve", {"radius": 90, "sweep": 0.4, **profile()})
    second = copy.deepcopy(first)
    second["parameters"]["radius"] = 100
    a, b = generate_part(first, tmp_path), generate_part(second, tmp_path)
    assert a["request_digest"] != b["request_digest"]
    assert a["digest"] != b["digest"]
    bad = copy.deepcopy(first)
    bad["parameters"]["run"] = 10
    with pytest.raises(ValueError):
        generate_part(bad, tmp_path)
    bad["parameters"].pop("run")
    bad["parameters"]["sweep"] = 0
    with pytest.raises(ValueError):
        generate_part(bad, tmp_path)


def test_rejects_out_of_envelope_without_publishing(tmp_path):
    candidate = request("printed_curve", {"radius": 90, "sweep": 0.5, **profile()})
    candidate["printer_envelope"]["x"] = 20
    with pytest.raises(ValueError):
        generate_part(candidate, tmp_path)
    assert not list(tmp_path.iterdir())
