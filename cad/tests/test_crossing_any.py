"""Consumer-visible geometry checks for fixed junctions (diamonds, curve crossings, gauntlet track).

Expensive: every shape is built, split and probed. Run with the project's CadQuery environment.
"""
import math

import cadquery as cq
import pytest
import trimesh

from cad.models import crossing_any as model
from cad.service import assemblies
from cad.service.generate import _validate

SHAPES = {
    "diamond-45": ("track_diamond", {"angle": 45, "length": 160, "cross": 160}),
    "star-22.5": ("track_diamond", {"angle": 22.5, "length": 336, "cross": 336}),
    "square-90": ("track_diamond", {"angle": -90, "length": 128, "cross": 128}),
    "curve-r40": ("track_diamond_curve", {"angle": 45, "length": 208, "radius": 320, "sweep": 45}),
    "curve-r56": ("track_diamond_curve", {"angle": -45, "length": 192, "radius": -448, "sweep": 45}),
    "gauntlet": ("track_gauntlet", {"spacing": 128, "offset": 16, "entry": 320, "length": 128}),
}


def parameters(shape, lite=False, **changes):
    family, values = SHAPES[shape]
    return family, {"connector_version": 1, "fit_adjustment": 0., **values, **changes, **({"lite": 1} if lite else {})}


def test_legs_that_reach_the_joined_track_are_rejected():
    # At 45 degrees the other route's body reaches past a 128 mm leg's ports.
    with pytest.raises(ValueError, match="lengthen the legs"):
        model.validate(*parameters("diamond-45", length=128, cross=128))
    model.validate(*parameters("diamond-45", length=156, cross=156))


@pytest.mark.parametrize("angle", [14.5, 91])
def test_crossing_angle_is_limited_to_15_to_90_degrees(angle):
    with pytest.raises(ValueError, match="15 to 90"):
        model.validate(*parameters("diamond-45", angle=angle, length=1024, cross=1024))


def test_ports_sit_on_the_route_ends_and_face_outward():
    family, p = parameters("diamond-45")
    ports = {port["id"]: port for port in model.ports(family, p)}
    half = 80 / math.sqrt(2)
    assert ports["in"]["position"] == pytest.approx([0, 0, 0]) and ports["in"]["heading"] == pytest.approx(math.pi)
    assert ports["out"]["position"] == pytest.approx([160, 0, 0])
    assert ports["cross-in"]["position"] == pytest.approx([80 - half, -half, 0])
    assert ports["cross-out"]["position"] == pytest.approx([80 + half, half, 0])
    assert math.remainder(ports["cross-in"]["heading"] - (math.pi/4 + math.pi), 2*math.pi) == pytest.approx(0)


def test_frog_gaps_and_check_rails_follow_the_crossing_angle():
    # Guiding-face gap = flangeway / sin(angle): 3.1 mm at 45 degrees needs no check rail, 5.75 mm at 22.5 does.
    rows45 = model.routes(*parameters("diamond-45"))
    assert max(gap["length"] for gap in model.guide_gaps(rows45)) == pytest.approx(2.2/math.sin(math.pi/4), abs=.3)
    assert model.check_rails(rows45) == []
    rows22 = model.routes(*parameters("star-22.5"))
    gaps = [gap for gap in model.guide_gaps(rows22) if gap["length"] > model.GUIDE_LIMIT]
    assert len(gaps) == 8 and all(gap["length"] == pytest.approx(2.2/math.sin(math.pi/8), abs=.3) for gap in gaps)
    checks = model.check_rails(rows22)
    # Every long gap has a check rail on the opposite rail of its route, covering it with lead-in.
    for gap in gaps:
        assert any(check["route"] == gap["route"] and check["rail"] == -gap["rail"] and
                   check["s0"] <= gap["s0"] - model.CHECK_LEAD + 1e-6 and check["s1"] >= gap["s1"] + model.CHECK_LEAD - 1e-6
                   for check in checks)


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("lite", [False, True])
def test_every_part_is_one_watertight_solid_on_the_mini_bed(shape, lite, tmp_path):
    family, p = parameters(shape, lite)
    for row in model.components(family, p):
        solid = model.build_component(row["parameters"])
        box = solid.BoundingBox()
        assert solid.isValid() and len(solid.Solids()) == 1, row["role"]
        assert box.xlen <= 166.001 and box.ylen <= 166.001 and box.zmin >= -.002, row["role"]
        stl = tmp_path / f'{row["role"]}.stl'
        cq.exporters.export(solid, str(stl), exportType="STL", tolerance=.02, angularTolerance=.1)
        mesh = trimesh.load_mesh(stl, process=True)
        assert mesh.is_volume and len(mesh.split(only_watertight=False)) == 1, row["role"]


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("lite", [False, True])
def test_every_route_runs_clear_guided_and_keeps_its_source_contacts(shape, lite):
    family, p = parameters(shape, lite)
    running = model.probe_running_clearances(family, p)
    assert running["flangeObstructionMm3"] <= .01 and running["maximumUnsupportedSpanMm"] <= 4
    assert all(rail["longestUnguidedMm"] <= model.GUIDE_LIMIT for rail in model.probe_guidance(family, p)["rails"])
    for port in model.probe_source_contacts(family, p):
        assert port["lostMm3"] < .005 and port["addedMm3"] < .005, port["port"]
    joints = model.probe_base_joints(family, p)
    assert len(joints["retainedConnections"]) >= joints["components"] - 1


def test_shallow_crossings_are_guided_only_because_of_their_check_rails(monkeypatch):
    family, p = parameters("star-22.5")
    for cache in (model.layout, model._fixed_mesh, model._pieces):
        cache.cache_clear()
    monkeypatch.setattr(model, "check_rails", lambda rows, limit=model.GUIDE_LIMIT: [])
    try:
        with pytest.raises(ValueError, match="unguided"):
            model.probe_guidance(family, p)
    finally:
        for cache in (model.layout, model._fixed_mesh, model._pieces):
            cache.cache_clear()


def test_assembly_service_routes_expands_and_generates_crossing_components():
    family, p = parameters("diamond-45")
    ports = model.ports(family, p)
    pose = {"x": 100., "y": 50., "z": 0., "heading": .3, "pitch": 0.}
    c, s = math.cos(pose["heading"]), math.sin(pose["heading"])
    instance = {
        "id": "x1", "family": family, "source": "printed", "parameters": p, "pose": pose,
        "interfaceKind": "track-assembly", "part_revision": "r1", "layout_revision": "l1",
        "ports": [{"id": port["id"], "profile": "brick", "railGauge": 40., "interfaceWidth": 2.4,
                   "pose": {"x": pose["x"] + port["position"][0]*c - port["position"][1]*s,
                            "y": pose["y"] + port["position"][0]*s + port["position"][1]*c, "z": 0.,
                            "heading": pose["heading"] + port["heading"], "pitch": 0.}} for port in ports],
        "paths": [{"id": "main", "from": "in", "to": "out", "enabled": True},
                  {"id": "crossing", "from": "cross-in", "to": "cross-out", "enabled": True}],
    }
    assemblies.validate_assembly(instance)
    with pytest.raises(ValueError, match="routing"):
        assemblies.validate_assembly({**instance, "paths": [{**path, "enabled": False} for path in instance["paths"]]})
    rows = assemblies.expand_components([instance])
    assert [row["family"] for row in rows] == [model.COMPONENT_FAMILY]*len(model.components(family, p))
    request = {"version": 1, "units": "mm", "family": rows[0]["family"], "parameters": rows[0]["parameters"],
               "printer_envelope": {"x": 180, "y": 180, "z": 180}, "part_revision": "r1", "layout_revision": "l1"}
    _validate(request)
    with pytest.raises(ValueError):
        _validate({**request, "parameters": {**rows[0]["parameters"], "component_index": 99}})
