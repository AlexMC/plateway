"""Synthetic mating checks do not establish brick fit or retained strength."""

import pytest
import trimesh

from cad.models import mating, rail
from cad.service.generate import generate_part


PROFILE = {'body_width': 30, 'base_thickness': 4, 'rail_gauge': 16,
           'rail_interface_width': 2, 'rail_height': 2,
           'joint_width': 6, 'joint_depth': 5, 'joint_height': 2, 'joint_clearance': .2}


def test_separate_joiner_enters_both_printed_sockets_without_intersecting_the_rails(tmp_path):
    p = {'run': 80, **PROFILE}
    first = rail.straight(p)
    second = rail.straight(p).translate((80, 0, 0))
    insertion = p['joint_depth'] - p['joint_clearance']
    joiner = mating.joiner(p).translate((80 - insertion, 0, 0))
    assert first.intersect(joiner).Volume() == pytest.approx(0, abs=1e-7)
    assert second.intersect(joiner).Volume() == pytest.approx(0, abs=1e-7)
    assert first.intersect(second).Volume() == pytest.approx(0, abs=1e-7)
    assert joiner.BoundingBox().xmin < 80 < joiner.BoundingBox().xmax

    receipt = generate_part({
        'version': 1, 'units': 'mm', 'family': 'connector_joiner',
        'parameters': {key: p[key] for key in ('joint_width', 'joint_depth', 'joint_height', 'joint_clearance')},
        'printer_envelope': {'x': 100, 'y': 100, 'z': 100},
        'part_revision': 'synthetic-joiner', 'layout_revision': 'synthetic-layout'
    }, tmp_path)
    mesh = trimesh.load_mesh(receipt['mesh'])
    assert mesh.is_watertight and mesh.volume > 0
    assert receipt['ports'] == []
    assert receipt['bounds']['size'] == pytest.approx([2 * insertion, 6, 2])


def test_joiner_rejects_a_socket_without_a_solid_rail_web(tmp_path):
    p = {'run': 9, **PROFILE}
    with pytest.raises(ValueError):
        generate_part({'version': 1, 'units': 'mm', 'family': 'printed_straight',
                       'parameters': p, 'printer_envelope': {'x': 100, 'y': 100, 'z': 100},
                       'part_revision': 'synthetic-rail', 'layout_revision': 'synthetic-layout'}, tmp_path)
    assert not list(tmp_path.iterdir())
