"""Moving spans and the train elevator: alignment at every aligned state, clear motion, retention, envelopes,
printable components and the assembly-service contract."""
import math


import pytest

from cad.models import moving_bridge as mb
from cad.service.assemblies import expand_components, validate_assembly
from cad.service.generate import _validate
from cad.service.plates import _side_on, plate_style

SHAPES = {
    "lift-out": ("bridge_lift_out", {"span": 64}),
    "drop-leaf": ("bridge_drop_leaf", {"span": 160}),
    "drop-leaf-short": ("bridge_drop_leaf", {"span": 64}),
    "bascule": ("bridge_bascule", {"span": 96, "drive": 1}),
    "bascule-ir": ("bridge_bascule", {"span": 128, "drive": 2}),
    "swing": ("bridge_swing", {"span": 144}),
    "lift": ("bridge_lift", {"span": 160, "lift": 128, "drive": 1}),
    "elevator": ("train_elevator", {"span": 160, "levels": 4, "level_height": 160, "drive": 1}),
    "elevator-by-hand": ("train_elevator", {"span": 128, "levels": 2, "level_height": 96, "drive": 0}),
}


def parameters(shape, lite=False, state=0, **changes):
    family, values = SHAPES[shape]
    return family, {"connector_version": 1, "fit_adjustment": 0., "state": state, **values, **changes, **({"lite": 1} if lite else {})}


@pytest.mark.parametrize("shape", SHAPES)
def test_rail_ends_line_up_within_tolerance_at_every_aligned_state(shape):
    rows = mb.probe_alignment(*parameters(shape))
    states = {row["state"] for row in rows}
    assert len(states) == {"elevator": 4, "elevator-by-hand": 2}.get(shape, 1)
    for row in rows:
        assert row["lateralMm"] < .01 and row["verticalMm"] < .01
        assert row["worstLateralMm"] <= .3 and row["worstVerticalMm"] <= .3 and row["worstAngleDeg"] <= .5


@pytest.mark.parametrize("shape", SHAPES)
def test_moving_parts_clear_every_fixed_part_through_their_travel_and_stay_in_their_envelopes(shape):
    family, p = parameters(shape)
    motion = mb.probe_motion(family, p)
    assert motion["maxOverlapMm3"] <= .01
    assert mb.probe_envelopes(family, p)["outsideAreaMm2"] <= .5


@pytest.mark.parametrize("shape", SHAPES)
def test_the_closed_deck_cannot_slide_and_raised_leaves_rest_on_their_stops(shape):
    report = mb.probe_retention(*parameters(shape))
    assert all(row["held"] for row in report), report
    pushes = {row["push"] for row in report}
    if shape == "swing":
        assert "close past stop (-1°)" in pushes
    if shape in ("drop-leaf", "drop-leaf-short", "bascule"):
        assert "past the stop (+1°)" in pushes


def test_a_raised_drop_leaf_leans_back_past_vertical_so_it_stays_up():
    family, p = parameters("drop-leaf")
    g = mb.geometry_of(family, p)
    leaf = g.span - 2*mb.GAP
    # Centre of mass ~half the leaf out and 9 mm under the hinge: past vertical once it is beyond the hinge line.
    assert math.degrees(g.leaf_up) > 90 + math.degrees(math.atan2(9, leaf/2))


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("lite", [False, True])
def test_every_component_is_one_watertight_solid_on_the_mini_bed_as_printed(shape, lite):
    family, p = parameters(shape, lite)
    g = mb.geometry_of(family, p)
    for role, mesh in g.fixed + g.moving:
        checked = mb.check_mesh(role, mesh, role in g.side_on)
        assert checked.is_volume
    assert {role for role, _ in g.fixed + g.moving if role.startswith("mechanism-post")} <= g.side_on


def test_the_lead_screw_beam_spans_the_left_posts_and_clears_the_deck_at_the_top_level():
    family, p = parameters("lift")
    g = mb.geometry_of(family, p)
    beam = dict(g.fixed)["mechanism-screw-beam"]
    assert beam.extents[0] <= mb.BED and beam.bounds[0, 2] == pytest.approx(g.screw["highest"] + mb.SCREW_HEADROOM)
    deck = dict(g.moving)["mechanism-deck"]
    # The nut boss stops 2 mm under the beam with the deck at its highest level.
    assert g.screw["highest"] + deck.bounds[1, 2] == pytest.approx(beam.bounds[0, 2] - 2.)


def test_tall_posts_split_into_pinned_segments_within_the_bed():
    family, p = parameters("elevator")
    posts = [(role, mesh) for role, mesh in mb.geometry_of(family, p).fixed if role.startswith("mechanism-post")]
    assert len(posts) == 4 * 4   # 4 posts 3*160 + 28 mm tall (lead-screw beam on top), in 156 mm segments
    assert max(mesh.extents[2] for _, mesh in posts) < mb.BED


@pytest.mark.parametrize("changes, message", [
    ({"span": 100}, "multiple of 8"), ({"span": 168}, "multiple of 8"),
])
def test_spans_stay_on_the_stud_grid_and_the_bed(changes, message):
    """Spans are whole studs and short enough for every part to fit the A1 mini bed."""
    with pytest.raises(ValueError, match=message):
        mb.validate(*parameters("lift-out", **changes))


def test_swing_spans_are_long_enough_for_the_stops_to_clear_the_swing():
    with pytest.raises(ValueError, match="from 144"):
        mb.validate(*parameters("swing", span=136))


def test_elevator_states_are_its_levels():
    family, p = parameters("elevator", levels=2)
    with pytest.raises(ValueError, match="state"):
        mb.validate(family, {**p, "state": 2})
    pairs = mb.route_pairs(family, {**p, "state": 1})
    assert pairs == {frozenset(("in", "out")): False, frozenset(("in-2", "out-2")): True}
    heights = {row["id"]: row["position"][2] for row in mb.ports(family, p)}
    assert heights == {"in": 0., "out": 0., "in-2": 160., "out-2": 160.}


def _instance(family, p):
    return {"id": "bridge-1", "family": family, "source": "printed", "parameters": p, "interfaceKind": "track-assembly",
            "pose": {"x": 100., "y": 50., "z": 0., "heading": math.pi/2, "pitch": 0.},
            "ports": [{"id": row["id"], "pose": {"x": 100. - row["position"][1], "y": 50. + row["position"][0], "z": row["position"][2],
                                                 "heading": math.pi/2 + row["heading"], "pitch": 0.},
                       "profile": "brick", "railGauge": 40, "interfaceWidth": 2.4} for row in mb.ports(family, p)],
            "paths": [{"id": f"route-{i}", "from": sorted(pair)[0], "to": sorted(pair)[1], "enabled": on}
                      for i, (pair, on) in enumerate(mb.route_pairs(family, p).items())],
            "part_revision": "test", "layout_revision": "test"}


def test_the_assembly_service_checks_routing_and_prints_the_same_parts_in_every_state():
    family, closed = parameters("bascule")
    _, raised = parameters("bascule", state=1)
    validate_assembly(_instance(family, closed))
    wrong = _instance(family, raised)
    wrong["paths"][0]["enabled"] = True
    with pytest.raises(ValueError, match="selected state"):
        validate_assembly(wrong)
    rows = expand_components([_instance(family, closed)])
    assert [row["parameters"] for row in rows] == [row["parameters"] for row in expand_components([_instance(family, raised)])]
    assert {row["componentRole"] for row in rows} >= {"landing-in", "landing-out", "mechanism-leaf",
                                                       "mechanism-counterweight-left", "mechanism-counterweight-right"}
    for row in rows:
        _validate({"version": 1, "units": "mm", "family": row["family"], "parameters": row["parameters"],
                   "printer_envelope": {"x": 180, "y": 180, "z": 180}, "part_revision": "t", "layout_revision": "t"})
        part = {"family": row["family"], "parameters": {**row["parameters"], "lite": 1}, "componentRole": row["componentRole"]}
        # Guided parts print detailed even in the fast style; counterweights print on their side.
        assert plate_style(part) == ("detailed" if row["componentRole"].startswith("mechanism-") else "fast")
        assert _side_on(part) == ("counterweight" in row["componentRole"])
    with pytest.raises(ValueError, match="component_index"):
        _validate({"version": 1, "units": "mm", "family": rows[0]["family"],
                   "parameters": {**rows[0]["parameters"], "component_index": 99},
                   "printer_envelope": {"x": 180, "y": 180, "z": 180}, "part_revision": "t", "layout_revision": "t"})


def test_hardware_lists_the_bought_parts():
    names = {family: " ".join(row["name"] for row in mb.hardware(family, p))
             for family, p in (parameters(s) for s in SHAPES if s not in ("elevator-by-hand", "bascule-ir"))}
    assert "magnet" in names["bridge_lift_out"] and "M3" in names["bridge_drop_leaf"]
    assert "Cross axle 3 (4519)" in names["bridge_bascule"] and "Bluetooth" in names["bridge_bascule"]
    assert "M3" in names["train_elevator"] and "M8 threaded rod" in names["train_elevator"] and "608" in names["bridge_lift"]
    assert "M8" not in " ".join(row["name"] for row in mb.hardware(*parameters("elevator-by-hand")))
    assert all(mb.assembly_notes(*parameters(s)) for s in SHAPES)


@pytest.mark.parametrize("shape", ["bascule", "bascule-ir"])
def test_the_bascule_motor_sits_clear_on_its_plate_and_turns_the_trunnion(shape):
    report = mb.probe_motor(*parameters(shape))
    # The LDraw case (and its keep-out box) misses the towers, landings, leaf and counterweights through the lift.
    assert report["caseOverlapMm3"] == 0 and report["keepoutOverlapMm3"] == 0
    # The four front-face pin holes are on the plate grid and open; the axle bearing is open and on the trunnion axis.
    assert report["pinsOnPlateGrid"] and report["pinHoleMaterialMm3"] == 0 and report["bearingMaterialMm3"] == 0
    assert report["output"] == {"trunnionOffsetMm": 0., "alongTrunnion": True}


def test_the_infrared_bascule_lists_its_motor_and_receiver():
    names = " ".join(row["name"] for row in mb.hardware(*parameters("bascule-ir")))
    assert "Infrared L motor (88003)" in names and "Bluetooth" not in names
    assert any("IR receiver" in note for note in mb.assembly_notes(*parameters("bascule-ir")))


@pytest.mark.parametrize("shape, drive", [("bascule", 3), ("lift", 2), ("elevator", 2)])
def test_only_the_bascule_takes_the_infrared_drive(shape, drive):
    with pytest.raises(ValueError, match="drive"):
        mb.validate(*parameters(shape, drive=drive))
