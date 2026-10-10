"""9V metal-rail inserts and the LED light channel (composite_track options, track_power.py)."""

import math

import manifold3d
import numpy as np
import pytest
from matplotlib.path import Path as MPath

from cad.models import composite, track_power
from cad.service.plates import CLEAR_MATERIAL, plate_process, plate_style, select_presets

PROFILE = {"connector_version": 1, "fit_adjustment": 0., "body_width": 63.8, "base_thickness": 3.2,
           "rail_gauge": 40, "rail_interface_width": 2.4, "rail_height": 6.4}
X1C = {"name": "X1 Carbon", "material": "Bambu PLA Basic", "profile": "0.20mm Standard @BBL X1C", "nozzleMm": .4,
       "orientation": "flat", "envelope": {"x": 256, "y": 256, "z": 250}}


def request(length=128., **options):
    p = composite.straight(PROFILE, length)
    p.update(options)
    return p


def solid_at(mesh, points):
    """Whether each (x, y, z) lies inside the mesh, by horizontal slices."""
    body = manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))
    result = []
    for x, y, z in points:
        inside = 0
        for polygon in body.slice(z).to_polygons():
            inside ^= int(MPath(np.asarray(polygon)).contains_point((x, y)))
        result.append(bool(inside))
    return result


@pytest.fixture(scope="module")
def metal():
    return composite.track_mesh(request(metal=1))


def test_metal_rail_replaces_printed_rail_between_the_laps(metal):
    rail = composite.RAIL
    # Mid-piece: no printed web or head (the metal rail goes there); the deck it stands on stays solid.
    assert solid_at(metal, [(64, rail, 6.), (64, rail, 9.), (64, -rail, 6.)]) == [False, False, False]
    assert solid_at(metal, [(64, rail, 2.7), (64, -rail, 2.7)]) == [True, True]
    # The accepted lap blades at both ports stay printed to the rail top; the full-width rail behind them goes.
    assert solid_at(metal, [(1., rail + .6, 9.), (127., -rail - .6, 9.)]) == [True, True]
    assert solid_at(metal, [(5., rail, 8.), (123., -rail, 8.)]) == [False, False]


def test_metal_rail_foot_walls_clear_the_foot_and_the_flanges(metal):
    rail, (thickness, clearance, wall) = composite.RAIL, track_power.FOOT
    gap = track_power.DEFAULT_BASE / 2 + clearance
    walls = [(64, rail + gap + wall / 2, 3.6), (64, rail - gap - wall / 2, 3.6)]
    assert solid_at(metal, walls) == [True, True]
    # The foot (5.0 mm) seats between them, and nothing printed stands above wall height where wheel flanges run (z >= 6.4).
    assert solid_at(metal, [(64, rail + 2.5 - .05, 3.6), (64, rail - 2.5 + .05, 3.6)]) == [False, False]
    assert composite.BASE + thickness < composite.FLANGE_FLOOR
    # Code 250 rail on the deck: its head is 0.05 mm under the printed laps.
    assert composite.BASE + track_power.CODE_250 == pytest.approx(9.55)


def test_copper_tape_recesses_the_whole_running_head():
    mesh = composite.track_mesh(request(metal=2))
    rail, top = composite.RAIL, composite.end_.RAIL_TOP
    assert solid_at(mesh, [(64, rail, top - .05), (64, rail, top - .15), (1., rail + .6, top - .05)]) == [False, True, False]


def test_led_channel_runs_under_the_deck_with_a_thin_skin():
    mesh = composite.track_mesh(request(led=2))
    half = track_power.LED_STRIPS[2] / 2
    ceiling = composite.BASE - track_power.LED_SKIN
    # Under the middle full tie (centre 64): open channel up to its ceiling, deck above it.
    assert solid_at(mesh, [(64, 0, .5), (64, half, ceiling - .1), (64, -half, ceiling - .1)]) == [False, False, False]
    assert solid_at(mesh, [(64, 0, ceiling + .3)]) == [True]
    # It reaches both end walls so the strip's leads pass the joints.
    assert solid_at(mesh, [(1., 0, .5), (127., 0, .5)]) == [False, False]


@pytest.mark.parametrize("options, message", [
    ({"metal": 1, "street": 1}, "street"),
    ({"metal": 1, "metal_base": 7.}, "metal_base"),
    ({"led": 1, "gauge": 2}, "standard gauge"),
    ({"metal": 3}, "metal"),
])
def test_rejects_unbuildable_options(options, message):
    with pytest.raises(ValueError, match=message):
        composite.validate(request(**options))


def test_hardware_rail_lengths_follow_the_curve():
    angle = math.pi / 8
    p = request(320 * angle, metal=1)
    p.update(s0_k0=1 / 320, s0_k1=1 / 320)
    rail = next(row["name"] for row in track_power.hardware(p) if "code 250" in row["name"])
    inner = 320 * angle - 2 * track_power.LAP - composite.RAIL * angle
    outer = 320 * angle - 2 * track_power.LAP + composite.RAIL * angle
    assert f"{inner:.1f} mm (left)" in rail and f"{outer:.1f} mm (right)" in rail


def test_led_track_prints_on_clear_plates():
    part = {"family": composite.FAMILY, "parameters": request(led=1)}
    assert plate_style(part) == "clear"
    assert plate_style({**part, "parameters": {**part["parameters"], "lite": 1}}) == "clear-fast"
    assert plate_process("clear-fast") == "fast"
    assert plate_style({"family": composite.FAMILY, "parameters": request()}) == "detailed"
    assert select_presets({**X1C, "material": CLEAR_MATERIAL})["filamentName"] == "Bambu PLA Translucent @BBL X1C"


@pytest.mark.parametrize("options", [{"metal": 1, "led": 2}, {"metal": 1, "metal_base": 6.}, {"metal": 2, "lite": 1}])
def test_running_probes_on_an_r40_curve(options):
    p = request(320 * math.pi / 8, **options)
    p.update(s0_k0=1 / 320, s0_k1=1 / 320)
    probes = track_power.probes(p)
    assert probes["ok"], probes
    if options.get("metal") == 1:
        # The metal head sits within 0.1 mm of the printed laps; wheel flanges pass 2.4 mm over the foot walls.
        assert probes["step"] == pytest.approx(.05, abs=.03)
        assert probes["flange_clearance"] > 2
