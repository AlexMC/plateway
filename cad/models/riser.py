"""Printable brick layout riser block: stacks, seats on baseplates, lifts track.

Frame: centred on the origin in x/y, bottom face z=0, top face z=height (studs
above it). x runs along the track it carries, y across. The 4 × 8 stud footprint
sits centred under one full tie: the 16 top studs at x=±4 are exactly the ones a
track's underside tie clutch accepts (none at x=±12, which would land in the tie
gaps). The underside has a square stud socket at every one of the 32 grid
positions, so a riser stacks on another riser or seats on any brick baseplate.

A square socket holds a stud on four tangent lines, like the tie clutch's ribs.
Fit adjustment follows the shared connector convention: positive removes
material from every contact face (looser), negative adds it (tighter); the top
studs stay nominal. Socket roofs bridge 4.8 mm, so the block prints upright
without support.
"""

from __future__ import annotations

import math

import cadquery as cq

from cad.models.brick_end import PROFILE

FAMILY = "layout_riser"
PARAMETERS = {"height", "fit_adjustment"}

_A = PROFILE["brickAttachment"]
PLATE = 3.2
MIN_PLATES, MAX_PLATES = 1, 10
PITCH = PROFILE["studPitch"]
LENGTH = 4 * PITCH - .2   # along x
WIDTH = 8 * PITCH - .2    # across y
TOP_X = (-_A["studRowOffset"], _A["studRowOffset"])
GRID_X = (-12, -4, 4, 12)
GRID_Y = (-28, -20, -12, -4, 4, 12, 20, 28)
SOCKET_DEPTH = _A["studHeight"] + .2


def validate(p: dict[str, float]) -> None:
    if not isinstance(p, dict) or set(p) != PARAMETERS:
        raise ValueError(f"layout riser requires exactly {sorted(PARAMETERS)}")
    for key, value in p.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"parameters.{key} must be a finite number")
    plates = round(p["height"] / PLATE)
    if abs(p["height"] - plates * PLATE) > 1e-6 or not MIN_PLATES <= plates <= MAX_PLATES:
        raise ValueError("riser height must be a whole number of 3.2 mm plates from 3.2 to 32 mm")
    if not PROFILE["fitAdjustmentMin"] <= p["fit_adjustment"] <= PROFILE["fitAdjustmentMax"]:
        raise ValueError("fit adjustment must be between -0.15 and 0.15 mm")


def build(p: dict[str, float]) -> cq.Shape:
    validate(p)
    height = p["height"]
    side = _A["studDiameter"] + 2 * p["fit_adjustment"]
    block = cq.Workplane("XY").box(LENGTH, WIDTH, height, centered=(True, True, False))
    # Start below the bottom face so the socket mouths have no coincident faces.
    sockets = (cq.Workplane("XY").workplane(offset=-.1)
               .pushPoints([(x, y) for x in GRID_X for y in GRID_Y])
               .rect(side, side).extrude(SOCKET_DEPTH + .1))
    # Overlap the block's top face so the stud roots fuse without coincident faces.
    studs = (cq.Workplane("XY").workplane(offset=height - .1)
             .pushPoints([(x, y) for x in TOP_X for y in GRID_Y])
             .circle(_A["studDiameter"] / 2).extrude(_A["studHeight"] + .1))
    return block.cut(sockets).union(studs).val().clean()
