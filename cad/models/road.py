"""Level-crossing road tiles (family ``road_tile``): loose tiles that carry a road
over the track flush with the rail tops.

The track itself is street track (composite ``street``): road surface flush with
the rail tops between the rails and out to the body edges, with 4 mm flangeway
grooves. These tiles fill the baseplate beside it, in the level-crossing
piece's frame (+x along the track from its start, +y left, z = 0 on the
baseplate top), for a road of 60304 road plates: 16 studs (128 mm) wide
and two plates (6.4 mm) high on the baseplate, crossing at ``angle`` degrees
(90, or 45/135 for a skew crossing either way) with its axis through the piece's middle.

Parameters (numbers only):
- ``run``: the crossing track's length (mm), which places the road axis;
- ``angle``: 45, 90 or 135; ``side``: 1 = left of the track, -1 = right;
- ``kind``: 0 = apron (road side: flat at rail-top height beside the track, then
  a 20 % ramp down to the road plates' 6.4 mm surface over its last 16 mm,
  ending square to the road on the 60304 plate edge), 1 = filler (the half of
  the 8-stud gap between two tracks at a 16-stud spacing on this side, flat at
  rail-top height; the other track's filler meets it on the midline);
- ``half``: 0 whole, 1/-1 only the part left/right of the road axis (bed-sized
  pieces for skew crossings).

Why tiles rather than a wider track variant: the road width and angle vary per
crossing while the street track stays a standard bed-sized composite part, and
double track at the standard spacing needs filler between two tracks that a
single-track part cannot own. Each tile is a hollow shell (2 mm roof, 1.5 mm
walls) with ribs on every second stud line pinching the baseplate studs from
either side (0.1 mm clearance), and a 2.45 mm pocket over every stud it covers,
so it locates on the baseplate at any angle and prints flat, roof up.
"""

from __future__ import annotations

import math

import cadquery as cq
import manifold3d
import numpy as np
import trimesh

from . import composite, brick_end

FAMILY = "road_tile"
PARAMETERS = frozenset({"run", "angle", "side", "kind", "half"})
ROAD_WIDTH = 128.
ROAD_TOP = 6.4
SURFACE = brick_end.RAIL_TOP
TRACK_EDGE = 32.
APRON = 32.
RAMP = 16.
FILLER = 32.
ROOF, WALL = 2., 1.5
STUD = brick_end.PROFILE["studPitch"]
RIB, RIB_PITCH = 3., 16.
POCKET_RADIUS = brick_end.PROFILE["brickAttachment"]["studDiameter"] / 2 + .05
POCKET_HEIGHT = brick_end.PROFILE["brickAttachment"]["studHeight"] + .2
POCKET_FACETS = 48
FAR = 2000.


def validate(p: dict) -> None:
    if set(p) != PARAMETERS:
        raise ValueError(f"road_tile requires exactly {sorted(PARAMETERS)}")
    for key, value in p.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"parameters.{key} must be a finite number")
    if p["angle"] not in (45, 90, 135):
        raise ValueError("road crossing angle must be 45, 90 or 135 degrees")
    if p["side"] not in (1, -1) or p["kind"] not in (0, 1) or p["half"] not in (0, 1, -1):
        raise ValueError("side must be 1 or -1, kind 0 or 1 and half 0, 1 or -1")
    if not 64 <= p["run"] <= 512 or p["run"] % STUD:
        raise ValueError("run must be whole studs from 64 to 512 mm")


def ramp_end(angle: float) -> float:
    """Apron end along the road axis: 32 mm beyond the farthest track-edge point in the road."""
    theta = math.radians(angle)
    return TRACK_EDGE / math.sin(theta) + ROAD_WIDTH / 2 / abs(math.tan(theta)) + APRON


def _rect(x0, y0, x1, y1) -> manifold3d.CrossSection:
    return manifold3d.CrossSection.square((x1 - x0, y1 - y0)).translate((x0, y0))


def _prism(section: manifold3d.CrossSection, low: float, high: float) -> manifold3d.Manifold:
    return section.extrude(high - low).translate((0, 0, low))


class Tile:
    def __init__(self, p: dict):
        validate(p)
        self.p = p
        self.theta = math.radians(p["angle"])
        self.centre = (p["run"] / 2, 0.)

    def road_frame(self, shape):
        """Place a shape given in road coordinates (u along the road axis, v across it; left = +v)."""
        return shape.rotate((0, 0, math.degrees(self.theta))).translate((*self.centre, 0)) \
            if isinstance(shape, manifold3d.Manifold) else \
            shape.rotate(math.degrees(self.theta)).translate(self.centre)

    def turn(self, shape):
        """Half a turn about the crossing centre."""
        cx, cy = self.centre
        if isinstance(shape, manifold3d.Manifold):
            return shape.translate((-cx, -cy, 0)).rotate((0, 0, 180)).translate((cx, cy, 0))
        return shape.translate((-cx, -cy)).rotate(180).translate((cx, cy))

    def plan(self) -> manifold3d.CrossSection:
        p, side = self.p, self.p["side"]
        low = -ROAD_WIDTH / 2 if p["half"] <= 0 else 0.
        high = ROAD_WIDTH / 2 if p["half"] >= 0 else 0.
        # Built for the left side; the road continues through the crossing centre, so the right
        # side is the same region turned half a turn about it.
        band = self.road_frame(_rect(-FAR, low, FAR, high))
        reach = FILLER if p["kind"] else FAR
        strip = _rect(-FAR, TRACK_EDGE, FAR, TRACK_EDGE + reach)
        region = band ^ strip
        if not p["kind"]:
            region = region ^ self.road_frame(_rect(-FAR, -FAR, ramp_end(self.p["angle"]), FAR))
        return self.turn(region) if side < 0 else region

    def ramp(self, drop: float = 0.) -> manifold3d.Manifold:
        """Volume above the apron's ramp surface (lowered by ``drop``), in the piece frame."""
        end = ramp_end(self.p["angle"])
        slope = (SURFACE - ROAD_TOP) / RAMP
        start = end - RAMP
        profile = [(start, SURFACE - drop), (start + 100, SURFACE - drop - 100 * slope),
                   (start + 100, 100.), (start, 100.)]
        wedge = manifold3d.CrossSection([np.asarray(profile)]).extrude(2 * FAR) \
            .rotate((90, 0, 0)).translate((0, FAR, 0))
        wedge = self.road_frame(wedge)
        return self.turn(wedge) if self.p["side"] < 0 else wedge

    def studs(self, plan: manifold3d.CrossSection) -> list[tuple[float, float]]:
        x0, y0, x1, y1 = plan.bounds()
        xs = np.arange(math.floor(x0 / STUD) * STUD + STUD / 2, x1 + STUD, STUD)
        ys = np.arange(math.floor(y0 / STUD) * STUD + STUD / 2, y1 + STUD, STUD)
        return [(x, y) for x in xs for y in ys]

    def mesh(self) -> trimesh.Trimesh:
        plan = self.plan()
        if plan.is_empty() or plan.area() < 1:
            raise ValueError("road tile is empty for these parameters")
        solid = _prism(plan, 0., SURFACE)
        interior = _prism(plan.offset(-WALL, manifold3d.JoinType.Miter), -1., SURFACE - ROOF)
        if not self.p["kind"]:
            solid = solid - self.ramp()
            interior = interior - self.ramp(ROOF)
        x0, y0, x1, y1 = plan.bounds()
        ribs = []
        for x in np.arange(math.ceil(x0 / RIB_PITCH) * RIB_PITCH, x1, RIB_PITCH):
            ribs.append(_rect(x - RIB / 2, y0 - 1, x + RIB / 2, y1 + 1))
        for y in np.arange(math.ceil(y0 / RIB_PITCH) * RIB_PITCH, y1, RIB_PITCH):
            ribs.append(_rect(x0 - 1, y - RIB / 2, x1 + 1, y + RIB / 2))
        if ribs:
            interior = interior - _prism(manifold3d.CrossSection.batch_boolean(ribs, manifold3d.OpType.Add), -2, 100)
        # Half a facet turned, so no pocket vertex lies on a 45 degree edge through its stud.
        pocket = manifold3d.Manifold.cylinder(POCKET_HEIGHT + 1, POCKET_RADIUS, POCKET_RADIUS, POCKET_FACETS) \
            .rotate((0, 0, 180 / POCKET_FACETS))
        pockets = [pocket.translate((x, y, -1)) for x, y in self.studs(plan)]
        shell = solid - interior
        if pockets:
            shell = shell - manifold3d.Manifold.batch_boolean(pockets, manifold3d.OpType.Add)
        mesh = composite._to_trimesh(shell)
        if not mesh.is_watertight or len(mesh.split(only_watertight=False)) != 1:
            raise ValueError("road tile must be one watertight solid")
        return mesh


def mesh(p: dict) -> trimesh.Trimesh:
    return Tile(p).mesh()


def build(p: dict) -> cq.Shape:
    return brick_end._solid(mesh(p))
