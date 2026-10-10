"""Wall and shelf brackets for track (family ``track_bracket``).

A bracket holds plain printed track at one full sleeper: its seat carries the
eight central baseplate studs (x = +/-4, y = +/-4 and +/-12 under the tie) that
the sleeper's underside clutch grips, exactly as on a baseplate.

Parameters (numbers only):
- ``mount``: 1 = wall bracket (screwed to the wall), 2 = shelf bracket (screwed
  down on a shelf);
- ``reach``: wall face to the track centreline (mm), 48..160;
- ``height``: shelf bracket: track underside above the shelf (mm), 10..120;
  wall bracket: 0 (its knee is as tall as it must be to print without support).

Frame: the seat top under the track centreline at the origin, +x along the
track, the wall at +y = reach, +z up; printed as installed. The wall bracket is
one 15.2 mm thick profile: seat arm on top, wall plate down the wall, a 45-degree
(or steeper) knee between them with a triangular lightening window whose upper
edges are also 45 degrees, so nothing needs support; two 4.5 mm teardrop screw
holes through the wall plate open into that window for the screwdriver. The shelf
bracket is a pedestal under the seat on a base plate with two vertical 4.5 mm
screw holes near the wall.
"""

from __future__ import annotations

import math

import cadquery as cq

from . import hardware as hw
from . import brick_end

FAMILY = "track_bracket"
PARAMETERS = frozenset({"mount", "reach", "height"})
WALL, SHELF = 1, 2
THICK = brick_end.PROFILE["tieWidth"] - .6
HALF_SEAT = 16.
ARM, PLATE, FRAME, BASE_PLATE = 8., 5., 6., 4.
SCREW = 4.5
REACH = (48., 150.)
SHELF_HEIGHT = (10., 120.)
_A = brick_end.PROFILE["brickAttachment"]
STUDS = [(x, y) for x in (-_A["studRowOffset"], _A["studRowOffset"]) for y in (-12., -4., 4., 12.)]


def knee_height(reach: float) -> float:
    """Wall plate height below the seat: the knee's underside rises at 45 degrees or steeper."""
    return reach - PLATE + HALF_SEAT + ARM + 2.


def validate(p: dict) -> None:
    if set(p) != PARAMETERS:
        raise ValueError(f"track_bracket requires exactly {sorted(PARAMETERS)}")
    if p["mount"] not in (WALL, SHELF):
        raise ValueError("mount must be 1 (wall) or 2 (shelf)")
    if not REACH[0] <= p["reach"] <= REACH[1]:
        raise ValueError(f"reach must be {REACH[0]:g} to {REACH[1]:g} mm")
    if p["mount"] == WALL and p["height"] != 0:
        raise ValueError("a wall bracket's height is set by its reach; pass 0")
    if p["mount"] == SHELF and not SHELF_HEIGHT[0] <= p["height"] <= SHELF_HEIGHT[1]:
        raise ValueError(f"shelf bracket height must be {SHELF_HEIGHT[0]:g} to {SHELF_HEIGHT[1]:g} mm")


def _profile(points) -> cq.Shape:
    """A (y, z) polygon extruded THICK along x, centred on x = 0."""
    wire = cq.Workplane("YZ").polyline(points).close()
    return wire.extrude(THICK).translate((-THICK / 2, 0, 0)).val()


def _teardrop(radius: float, length: float) -> cq.Shape:
    """A horizontal screw hole along -y from the origin, pointed at the top so its roof prints at 45 degrees."""
    tip = radius * math.sqrt(2)
    sketch = (cq.Workplane("XY").circle(radius).extrude(length)
              .union(cq.Workplane("XY").polyline([(-radius / math.sqrt(2), radius / math.sqrt(2)), (0, tip),
                                                  (radius / math.sqrt(2), radius / math.sqrt(2)), (0, 0)]).close().extrude(length)))
    return sketch.val().rotate(cq.Vector(0, 0, 0), cq.Vector(1, 0, 0), 90)


def _wall_layout(reach: float) -> tuple[float, tuple | None, tuple]:
    """A wall bracket's plate height, lightening window (or None) and screw-hole heights."""
    height = knee_height(reach)
    # Window: vertical edge inside the plate, upper edge falling leftwards at 45 degrees, lower edge FRAME
    # above the knee and parallel to it; the screw holes open into it.
    slope = (height - ARM) / (reach - PLATE + HALF_SEAT)
    lift = FRAME * (1 + slope * slope) ** .5
    inner, top = reach - PLATE - FRAME, -ARM - FRAME
    bottom = -ARM - slope * (inner + HALF_SEAT) + lift
    left = (inner + FRAME - slope * HALF_SEAT + lift) / (1 + slope)
    if inner - left > 2 * FRAME and top - bottom > 4 * SCREW:
        return height, (inner, top, left, bottom), (top - 2 * SCREW, bottom + 2 * SCREW)
    return height, None, (-ARM - 2 * SCREW,)


def build(p: dict) -> cq.Shape:
    validate(p)
    reach = float(p["reach"])
    if p["mount"] == WALL:
        height, window, holes = _wall_layout(reach)
        body = _profile([(-HALF_SEAT, 0), (reach, 0), (reach, -height), (reach - PLATE, -height), (-HALF_SEAT, -ARM)])
        if window:
            inner, top, left, bottom = window
            body = body.cut(_profile([(inner, top), (left, top - (inner - left)), (inner, bottom)]))
        for z in holes:
            body = body.cut(_teardrop(SCREW / 2, PLATE + 2).translate(cq.Vector(0, reach + 1, z)))
    else:
        height = float(p["height"])
        body = cq.Solid.makeBox(THICK, reach + HALF_SEAT, BASE_PLATE, cq.Vector(-THICK / 2, -HALF_SEAT, -height))
        body = body.fuse(cq.Solid.makeBox(THICK, 2 * HALF_SEAT, height - BASE_PLATE, cq.Vector(-THICK / 2, -HALF_SEAT, -height + BASE_PLATE)))
        for y in (HALF_SEAT + (reach - HALF_SEAT) / 2, reach - 2 * SCREW):
            body = body.cut(cq.Solid.makeCylinder(SCREW / 2, BASE_PLATE + 2, cq.Vector(0, y, -height - 1)))
    for x, y in STUDS:
        body = body.fuse(cq.Solid.makeCylinder(_A["studDiameter"] / 2, _A["studHeight"], cq.Vector(x, y, 0)))
    return body.clean()


def hardware(p: dict) -> list[dict]:
    """One screw per hole: 4 x 30 mm into a wall plug through the 5 mm wall plate, 4 x 16 mm down into a shelf."""
    validate(p)
    if p["mount"] == WALL:
        return [hw.wood_screw("4 x 30", len(_wall_layout(float(p["reach"]))[2]))]
    return [hw.wood_screw("4 x 16", 2)]
