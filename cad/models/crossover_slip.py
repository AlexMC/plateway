"""Crossovers (single, scissors) at any spacing and single/double slips; millimetres.

Each piece is one assembly built by the parametric turnout framework (turnout.py):
its routes, the points where routes share a port and part, and the states as point
positions. The framework makes the flexure point blades, heel keepers, lock
spacers, the keyed base tiles (seams only in tie gaps) and every frog gap: rails of
routes that cross (a scissors' or slip's diamond, a slip curve over the straight
tracks) are cut by each other's flangeways exactly like a diamond crossing.

Geometry (matches src/domain/pieces/families/crossover.ts and slip.ts):
- Crossovers: lanes along +x, `spacing` apart (signed: + = the parallel track to the
  left). Every diagonal is one S-bend: two opposite arcs of `radius` turning
  `angle`, `middle` mm of straight between, over `length`. (A triple crossover is
  the editor's kit of two scissors in a row, src/editor/triple.ts.)
- Slips: track A in->out along +x, `length` long; track B crosses A's midpoint at
  `angle` (signed); the slip curves are single arcs of `radius`, tangent to both
  tracks at their ports.
"""
from __future__ import annotations

from functools import lru_cache
import math
from pathlib import Path

import cadquery as cq
import numpy as np

from . import brick_end as end
from . import lite as fast
from . import turnout as T

FAMILIES = ("crossover_single", "crossover_scissors", "slip_single", "slip_double")
COMPONENT_FAMILY = "crossover_slip_component"
SHAPES = {
    "crossover_single": ("spacing", "length", "radius", "angle", "middle"),
    "crossover_scissors": ("spacing", "length", "radius", "angle", "middle"),
    "slip_single": ("angle", "length", "radius"),
    "slip_double": ("angle", "length", "radius"),
}
CONNECTOR = frozenset({"connector_version", "fit_adjustment"})
SOURCE_DEPENDENCIES = [Path(T.__file__), *T.SOURCE_DEPENDENCIES]
STATES = {
    "crossover_single": ("straight", "diverging"),
    "crossover_scissors": ("straight", "diverging"),
    "slip_single": ("straight", "slip"),
    "slip_double": ("straight", "slip", "slip-back", "slip-both"),
}
GRID = 8.
MIN_RADIUS = 320.
MIN_SPACING, MAX_SPACING = 128., 512.
# Wider, a scissors' diamond no longer splits into bed-sized tiles; the editor offers only the spacing and radius
# pairs that print (crossover.ts SCISSORS_RADII).
SCISSORS_MAX_SPACING = 192.
MAX_DIAGONAL = math.pi / 4
SLIP_ANGLES = (math.radians(15), math.radians(60))
SAMPLE = 2.
TOLERANCE = 1e-6
LANES = (("main", "in", "out"), ("parallel", "parallel-in", "parallel-out"))


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _straight(x0, y0, x1, heading=0.):
    count = max(1, math.ceil(abs(x1 - x0) / SAMPLE))
    return [(x0 + (x1 - x0) * i / count, y0, heading) for i in range(count + 1)]


def _arc_from(point, radius, sweep):
    x, y, h = point
    sign, count = math.copysign(1., sweep), max(1, math.ceil(abs(sweep) * radius / SAMPLE))
    return [(x + sign*radius*(math.sin(h + sweep*i/count) - math.sin(h)),
             y + sign*radius*(math.cos(h) - math.cos(h + sweep*i/count)), h + sweep*i/count) for i in range(1, count + 1)]


def _diagonal(radius, angle, middle, run, y0, y1, lead=0., tail=0.):
    """Lead straight on y0, the S-bend over `run`, tail straight on y1 (ends heading along the tracks)."""
    sign = math.copysign(1., y1 - y0)
    points = _straight(0., y0, lead) if lead > 0 else [(0., y0, 0.)]
    points += _arc_from(points[-1], radius, sign*angle)
    x, y, h = points[-1]
    if middle > 1e-9:
        count = max(1, math.ceil(middle / SAMPLE))
        points += [(x + middle*math.cos(h)*i/count, y + middle*math.sin(h)*i/count, h) for i in range(1, count + 1)]
    points += _arc_from(points[-1], radius, -sign*angle)
    points[-1] = (lead + run, y1, 0.)
    if tail > 0:
        points += _straight(lead + run, y1, lead + run + tail)[1:]
    return np.array(points)


def routes(family: str, shape: dict) -> list[tuple[str, str, str, np.ndarray]]:
    """(route id, from port, to port, centre path [x, y, heading]) in the piece frame."""
    if family.startswith("crossover_"):
        length, spacing = shape["length"], shape["spacing"]
        diagonals = [("cross", 0, 1)] + ([("cross-back", 1, 0)] if family == "crossover_scissors" else [])
        geometry = (shape["radius"], shape["angle"], shape["middle"], length)
        # Diagonals first: the framework lays the earlier route's ties first, so their ties carry the lanes
        # where decks overlap and the seam planner can cut between the tracks.
        rows = []
        for ident, a, b in diagonals:
            rows.append((ident, LANES[a][1], LANES[b][2], _diagonal(*geometry, spacing*a, spacing*b)))
        for lane in range(2):
            ident, start, finish = LANES[lane]
            rows.append((ident, start, finish, np.array(_straight(0., spacing*lane, length))))
        return rows
    angle, length, radius = shape["angle"], shape["length"], shape["radius"]
    half, c, s = length/2, math.cos(angle), math.sin(angle)
    cross_in, cross_out = (half - half*c, -half*s), (half + half*c, half*s)
    count = max(1, math.ceil(length / SAMPLE))
    rows = [("main", "in", "out", np.array(_straight(0., 0., length)))]
    rows.append(("crossing", "cross-in", "cross-out", np.array(
        [(cross_in[0] + length*c*i/count, cross_in[1] + length*s*i/count, angle) for i in range(count + 1)])))
    slip = [(0., 0., 0.)] + _arc_from((0., 0., 0.), radius, angle)
    slip[-1] = (*cross_out, angle)
    rows.append(("slip", "in", "cross-out", np.array(slip)))
    if family == "slip_double":
        back = [(*cross_in, angle)] + _arc_from((*cross_in, angle), radius, -angle)
        back[-1] = (length, 0., 0.)
        rows.append(("slip-back", "cross-in", "out", np.array(back)))
    return rows


def _switches(family: str) -> list[tuple[str, str, str]]:
    """(route a, route b, shared port) for every set of points, in state-position order."""
    if family == "crossover_single":
        return [("main", "cross", "in"), ("parallel", "cross", "parallel-out")]
    if family == "crossover_scissors":
        return [("main", "cross", "in"), ("parallel", "cross", "parallel-out"),
                ("parallel", "cross-back", "parallel-in"), ("main", "cross-back", "out")]
    if family == "slip_single":
        return [("main", "slip", "in"), ("crossing", "slip", "cross-out")]
    return [("main", "slip", "in"), ("crossing", "slip", "cross-out"),
            ("crossing", "slip-back", "cross-in"), ("main", "slip-back", "out")]


# Point positions per state (1 = the diverging route b), in _switches order.
POSITIONS = {
    "crossover_single": {"straight": (0, 0), "diverging": (1, 1)},
    "crossover_scissors": {"straight": (0, 0, 0, 0), "diverging": (1, 1, 1, 1)},
    "slip_single": {"straight": (0, 0), "slip": (1, 1)},
    "slip_double": {"straight": (0, 0, 0, 0), "slip": (1, 1, 0, 0), "slip-back": (0, 0, 1, 1), "slip-both": (1, 1, 1, 1)},
}


def _port_rows(rows):
    """(id, x, y, outward heading) of every port."""
    found = {}
    for _, start, finish, path in rows:
        found[start] = (float(path[0, 0]), float(path[0, 1]), float(path[0, 2]) + math.pi)
        found[finish] = (float(path[-1, 0]), float(path[-1, 1]), float(path[-1, 2]))
    return [(ident, *found[ident]) for ident in found]


def _shape(family: str, p: dict) -> tuple:
    return tuple(float(p[key]) for key in SHAPES[family])


def _named(family: str, shape: tuple) -> dict:
    return dict(zip(SHAPES[family], shape))


@lru_cache(maxsize=32)
def spec(family: str, shape: tuple) -> T.Spec:
    named = _named(family, shape)
    rows = routes(family, named)
    flex = slip_flex(named["radius"]) if family.startswith("slip_") else T.FLEX
    return T.Spec(
        ports=tuple(T.Port(ident, x, y, heading) for ident, x, y, heading in _port_rows(rows)),
        routes=tuple(T.Route(ident, start, finish, tuple(tuple(float(v) for v in point) for point in path))
                     for ident, start, finish, path in rows),
        switches=tuple(T.Switch(a, b, port, flex) for a, b, port in _switches(family)),
        states=tuple(T.State(ident, POSITIONS[family][ident]) for ident in STATES[family]))


def slip_flex(radius: float) -> float:
    """Blade flex of a slip's points: wide slip curves part slowly and need a longer flex for full throw
    (src/domain/pieces/families/slip.ts sizes the slip with the same rule)."""
    return 48. if radius < 1200 else 64. if radius < 2000 else 80.


def _check_shape(family: str, named: dict) -> None:
    if family.startswith("crossover_"):
        spacing, length, radius, angle, middle = (named[key] for key in SHAPES[family])
        widest = SCISSORS_MAX_SPACING if family == "crossover_scissors" else MAX_SPACING
        if not MIN_SPACING - TOLERANCE <= abs(spacing) <= widest + TOLERANCE:
            raise ValueError(f"spacing must be 128 to {widest:g} mm either side")
        if abs(length / GRID - round(length / GRID)) > 1e-9 or radius < MIN_RADIUS - TOLERANCE:
            raise ValueError("crossover length must be whole studs and every arc at least R40")
        if not 0 < angle <= MAX_DIAGONAL + TOLERANCE or middle < 0:
            raise ValueError("diagonal must leave at most 45 degrees with a non-negative straight")
        if (abs(2*radius*(1 - math.cos(angle)) + middle*math.sin(angle) - abs(spacing)) > TOLERANCE or
                abs(2*radius*math.sin(angle) + middle*math.cos(angle) - length) > TOLERANCE):
            raise ValueError("diagonal S-bend does not join the tracks")
        return
    angle, length, radius = (named[key] for key in SHAPES[family])
    if not SLIP_ANGLES[0] - TOLERANCE <= abs(angle) <= SLIP_ANGLES[1] + TOLERANCE:
        raise ValueError("slip angle must be 15 to 60 degrees")
    if abs(length / GRID - round(length / GRID)) > 1e-9 or radius < MIN_RADIUS - TOLERANCE:
        raise ValueError("slip length must be whole studs and its curve at least R40")
    if abs(radius - length / 2 / math.tan(abs(angle) / 2)) > TOLERANCE:
        raise ValueError("slip curve is not tangent to both tracks at their ports")


def validate(family: str, p: dict) -> None:
    if family not in FAMILIES:
        raise ValueError("unknown crossover or slip family")
    if set(p) - {"lite"} != CONNECTOR | set(SHAPES[family]) | {"switch_state"}:
        raise ValueError("unexpected crossover or slip parameters")
    fast.validate(p)
    if not all(_number(value) for value in p.values()):
        raise ValueError("crossover and slip parameters must be finite numbers")
    end.validate({key: p[key] for key in CONNECTOR})
    state = p["switch_state"]
    if state != int(state) or not 0 <= state < len(STATES[family]):
        raise ValueError("switch_state is not one of this piece's states")
    _check_shape(family, dict((key, float(p[key])) for key in SHAPES[family]))


def _spec(family: str, p: dict) -> T.Spec:
    return spec(family, _shape(family, p))


def ports(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return T.port_rows(_spec(family, p))


def route_pairs(family: str, p: dict) -> dict[frozenset, bool]:
    validate(family, p)
    return T.spec_route_pairs(_spec(family, p), int(p["switch_state"]))


# ---------------------------------------------------------------- service interface

def _meshes(family: str, p: dict):
    return T.component_meshes(_spec(family, p), int(p["switch_state"]), False, float(p["fit_adjustment"]), fast.enabled(p))


def components(family: str, p: dict) -> list[dict]:
    validate(family, p)
    code = FAMILIES.index(family)
    return [{"role": role, "parameters": {**p, "shape_code": code, "component_index": index}}
            for index, (role, _) in enumerate(_meshes(family, p))]


def _family_of(p) -> str:
    code = p.get("shape_code")
    if not _number(code) or code != int(code) or not 0 <= code < len(FAMILIES):
        raise ValueError("invalid shape_code")
    return FAMILIES[int(code)]


def component_keys(p: dict) -> set[str]:
    return set(CONNECTOR | set(SHAPES[_family_of(p)]) | {"switch_state", "shape_code", "component_index"})


def _logical(p):
    return {key: value for key, value in p.items() if key not in ("shape_code", "component_index")}


def validate_component(p: dict) -> None:
    family = _family_of(p)
    if set(p) - {"lite"} != component_keys(p):
        raise ValueError("unexpected crossover or slip component parameters")
    validate(family, _logical(p))
    index = p["component_index"]
    if not _number(index) or index != int(index) or index < 0:
        raise ValueError("invalid component_index")
    if index >= len(_meshes(family, p)):
        raise ValueError("component_index outside assembly")


def component_ports(p: dict) -> list[dict]:
    return ports(_family_of(p), _logical(p))


def build_component(p: dict) -> cq.Shape:
    validate_component(p)
    role, mesh = _meshes(_family_of(p), p)[int(p["component_index"])]
    return end._solid(T.check_mesh(role, mesh))


def hardware(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return T.spec_hardware(_spec(family, p))


THROWS = {"crossover_single": "Both sets of points are one throw: set them to the same side.",
          "crossover_scissors": "All four sets of points are one throw: set them all to the same side.",
          "slip_single": "One throw: the points at in and cross-out move together.",
          "slip_double": "Two throws: the points at in and cross-out together (main → crossing), "
                         "those at cross-in and out together (crossing → main)."}


def assembly_notes(family: str, p: dict) -> list[str]:
    validate(family, p)
    return [*T.spec_notes(_spec(family, p), False), THROWS[family],
            "Change the setting only with no train on the points." if family == "crossover_single"
            else "Only one train at a time on the crossing diamond."]


def probes(family: str, p: dict) -> dict:
    """Every framework probe on one configuration, the running clearances in every state (tests and evidence)."""
    validate(family, p)
    s, adjustment, lite = _spec(family, p), float(p["fit_adjustment"]), fast.enabled(p)
    return {"motion": T.probe_motion(s, False, adjustment, lite), "retention": T.probe_retention(s, adjustment, lite),
            "locks": T.probe_state_locks(s, False, adjustment, lite), "envelopes": T.probe_operating_envelopes(s, False),
            "running": [T.probe_running_clearances(s, state, False, adjustment, lite) for state in range(len(s.states))],
            "joints": T.probe_base_joints(s, adjustment, lite),
            "contacts": T.probe_source_contacts(s, int(p["switch_state"]), False, adjustment, lite)}


def envelopes(family: str, p: dict) -> list[np.ndarray]:
    """Piece-frame polygons of every set of points' travel (the TS footprint check draws the same rule)."""
    validate(family, p)
    return T.envelopes(_spec(family, p))
