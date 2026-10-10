"""Helix column tube (family ``helix_column``): one stackable segment of the column
that holds a helix's turns up through the composite ``socket`` lugs.

A column stands beside the track at the same plan position on every turn. Each
tube is a 16 mm round post printed upright: its top spigot (9.6 mm, 0.2 mm radial
clearance in the 10 mm lug bore) passes up through a lug and on into the next
tube's bottom socket; the lug rests on the tube's shoulder and the next tube rests
on the lug. The lowest tube has a square foot (four 4.2 mm screw holes) on the
table or riser instead of a socket. A stack taller than the bed is split into
plain segments joined spigot-into-socket.

Parameters (numbers only):
- ``height``: body length (mm), shoulder to bottom face (foot included);
- ``foot``: 1 = foot at the bottom, 0 = bottom socket;
- ``spigot``: spigot length above the shoulder (mm): ENGAGE between two tubes,
  ENGAGE + the lug thickness through a lug.

Frame: the bottom centre at the origin, +z up, as printed (upright, no supports:
the foot's fillet cone and the chamfered spigot tip are 45 degrees).
"""

from __future__ import annotations

import cadquery as cq

FAMILY = "helix_column"
PARAMETERS = frozenset({"height", "foot", "spigot"})
DIAMETER, SPIGOT, SOCKET = 16., 9.6, 10.
ENGAGE = 8.
SOCKET_DEPTH = ENGAGE + .4
LUG = 3.2
FOOT, FOOT_THICKNESS, FOOT_HOLE = 44., 3., 4.2
MAX_HEIGHT = 240.


def validate(p: dict) -> None:
    if set(p) != PARAMETERS:
        raise ValueError(f"helix_column requires exactly {sorted(PARAMETERS)}")
    if p["foot"] not in (0, 1):
        raise ValueError("foot must be 0 or 1")
    low = FOOT_THICKNESS + 3 if p["foot"] else SOCKET_DEPTH + SOCKET / 2 + 2
    if not low <= p["height"] <= MAX_HEIGHT:
        raise ValueError(f"column height must be {low:g} to {MAX_HEIGHT:g} mm")
    if not ENGAGE - 1e-9 <= p["spigot"] <= ENGAGE + LUG + 1e-9:
        raise ValueError(f"spigot must be {ENGAGE:g} to {ENGAGE + LUG:g} mm")


def build(p: dict) -> cq.Shape:
    validate(p)
    height, spigot = float(p["height"]), float(p["spigot"])
    up = cq.Vector(0, 0, 1)
    body = cq.Solid.makeCylinder(DIAMETER / 2, height)
    body = body.fuse(cq.Solid.makeCylinder(SPIGOT / 2, spigot - .8, cq.Vector(0, 0, height)),
                     cq.Solid.makeCone(SPIGOT / 2, SPIGOT / 2 - .8, .8, cq.Vector(0, 0, height + spigot - .8), up))
    if p["foot"]:
        cone = min(height - FOOT_THICKNESS, 8.)
        body = body.fuse(cq.Solid.makeBox(FOOT, FOOT, FOOT_THICKNESS, cq.Vector(-FOOT / 2, -FOOT / 2, 0)),
                         cq.Solid.makeCone(DIAMETER / 2 + cone, DIAMETER / 2, cone, cq.Vector(0, 0, FOOT_THICKNESS), up))
        for x in (-1, 1):
            for y in (-1, 1):
                body = body.cut(cq.Solid.makeCylinder(FOOT_HOLE / 2, FOOT_THICKNESS + 2,
                                                      cq.Vector(x * (FOOT / 2 - 5), y * (FOOT / 2 - 5), -1)))
    else:
        # Entry chamfer, the socket, and a 45-degree drill-point roof (no bridged ceiling).
        body = body.cut(cq.Solid.makeCone(SOCKET / 2 + 1.1, SOCKET / 2, 1.1, cq.Vector(0, 0, -.5), up)
                        .fuse(cq.Solid.makeCylinder(SOCKET / 2, SOCKET_DEPTH + .5, cq.Vector(0, 0, -.5)),
                              cq.Solid.makeCone(SOCKET / 2, .8, SOCKET / 2 - .8, cq.Vector(0, 0, SOCKET_DEPTH), up)))
    return body.clean()
