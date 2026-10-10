"""Digital-only modular deck and joint mating; no printed strength claim."""


import cadquery as cq
import pytest

from cad.models import bridge
from cad.service.generate import generate_part
from cad.service.verify_mesh import bounds


PROFILE = {"deck_width": 30, "deck_thickness": 6, "rail_gauge": 16,
           "rail_interface_width": 2, "rail_height": 2,
           "joint_width": 8, "joint_depth": 6, "joint_height": 2,
           "joint_clearance": 0.2}


def request(family, parameters):
    return {"version": 1, "units": "mm", "family": family, "parameters": parameters,
            "printer_envelope": {"x": 200, "y": 100, "z": 100},
            "part_revision": "synthetic-bridge", "layout_revision": "synthetic-layout"}


def test_decks_joint_connect_at_ports_without_solid_collision(tmp_path):
    deck_params = {"run": 90, **PROFILE}
    joint_params = {"joint_length": 12, **PROFILE}
    deck = generate_part(request("bridge_deck", deck_params), tmp_path)
    joint = generate_part(request("bridge_joint", joint_params), tmp_path)
    assert deck["ports"][1]["position"] == [90, 0, 0]
    assert joint["ports"][0]["position"] == [0, 0, 0]
    assert joint["ports"][1]["position"] == [12, 0, 0]
    assert joint["bounds"]["min"][0] == pytest.approx(-6)
    left = bridge.deck(deck_params)
    middle = bridge.joint(joint_params).translate((90, 0, 0))
    right = bridge.deck(deck_params).translate((102, 0, 0))
    assert left.intersect(middle).Volume() == pytest.approx(0, abs=1e-5)
    assert right.intersect(middle).Volume() == pytest.approx(0, abs=1e-5)
    # Tongue occupies each female pocket within the declared clearance.
    assert left.BoundingBox().xmax == pytest.approx(90)
    assert middle.BoundingBox().xmin == pytest.approx(84)
    assert middle.BoundingBox().xmax == pytest.approx(108)
    assert right.BoundingBox().xmin == pytest.approx(102)
    # Heading π/2 transforms the rail port and the asymmetric joint extent,
    # unlike simply copying an untranslated part mesh into world coordinates.
    transformed = bridge.joint(joint_params).rotate((0, 0, 0), (0, 0, 1), 90).translate((70, 40, 20))
    assert bounds(transformed)["min"] == pytest.approx([55, 34, 20])
    assert bounds(transformed)["max"] == pytest.approx([85, 58, 28])


def test_rejects_shallow_or_overlapping_sockets_and_oversized_deck(tmp_path):
    bad = request("bridge_deck", {"run": 90, **PROFILE})
    bad["parameters"]["joint_height"] = 6
    with pytest.raises(ValueError):
        generate_part(bad, tmp_path)
    bad["parameters"]["joint_height"] = 2
    bad["parameters"]["joint_depth"] = 46
    with pytest.raises(ValueError):
        generate_part(bad, tmp_path)
    bad["parameters"]["joint_depth"] = 6
    bad["printer_envelope"]["x"] = 80
    with pytest.raises(ValueError):
        generate_part(bad, tmp_path)
    assert not list(tmp_path.iterdir())


def test_rejects_disconnected_model_before_export(tmp_path, monkeypatch):
    import cad.service.generate as generator

    def disconnected(_parameters):
        return cq.Solid.makeBox(10, 10, 2).fuse(cq.Solid.makeBox(10, 10, 2, cq.Vector(20, 0, 0)))

    required, _, module = generator._FAMILIES["bridge_deck"]
    monkeypatch.setitem(generator._FAMILIES, "bridge_deck", (required, disconnected, module))
    with pytest.raises(ValueError, match="one valid solid"):
        generate_part(request("bridge_deck", {"run": 90, **PROFILE}), tmp_path)
    assert not list(tmp_path.iterdir())
