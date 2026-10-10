"""Measured two-rail profile in the +x forward, +y left, +z up assembly frame."""

from __future__ import annotations

import math
import cadquery as cq
from cad.models import brick_end, mating


def straight(p: dict[str, float]) -> cq.Shape:
    if "connector_version" in p:
        return brick_end.track(p, "printed_straight")
    run, width, base = p["run"], p["body_width"], p["base_thickness"]
    gauge, rail_width, rail_height = p["rail_gauge"], p["rail_interface_width"], p["rail_height"]
    part = cq.Solid.makeBox(run, width, base, cq.Vector(0, -width / 2, 0))
    for y in (-gauge / 2, gauge / 2):
        part = part.fuse(cq.Solid.makeBox(run, rail_width, rail_height,
                                         cq.Vector(0, y - rail_width / 2, base)))
    part = mating.socket(part, p, cq.Vector(0, 0, 0), start=True)
    return mating.socket(part, p, cq.Vector(run, 0, 0), start=False).clean()


def _sector(radius: float, sweep: float, width: float, bottom: float, height: float) -> cq.Shape:
    """Exact circular annular extrusion; the inner and outer radii share a centre."""
    side = 1 if sweep > 0 else -1
    angle = abs(sweep)

    def at(r: float, t: float) -> cq.Vector:
        return cq.Vector(r * math.sin(t), side * (radius - r * math.cos(t)), bottom)

    inner, outer = radius - width / 2, radius + width / 2
    wire = cq.Wire.assembleEdges([
        cq.Edge.makeLine(at(inner, 0), at(outer, 0)),
        cq.Edge.makeThreePointArc(at(outer, 0), at(outer, angle / 2), at(outer, angle)),
        cq.Edge.makeLine(at(outer, angle), at(inner, angle)),
        cq.Edge.makeThreePointArc(at(inner, angle), at(inner, angle / 2), at(inner, 0)),
    ])
    return cq.Solid.extrudeLinear(wire, [], cq.Vector(0, 0, height))


def curve(p: dict[str, float]) -> cq.Shape:
    if "connector_version" in p:
        return brick_end.track(p, "printed_curve")
    radius, sweep = p["radius"], p["sweep"]
    base, gauge = p["base_thickness"], p["rail_gauge"]
    rail_width, rail_height = p["rail_interface_width"], p["rail_height"]
    part = _sector(radius, sweep, p["body_width"], 0, base)
    for y in (-gauge / 2, gauge / 2):
        # The rail centre at initial y has signed radius R - sign(sweep)*y.
        rail_radius = radius - (1 if sweep > 0 else -1) * y
        part = part.fuse(_sector(rail_radius, sweep, rail_width, base, rail_height))
    part = mating.socket(part, p, cq.Vector(0, 0, 0), start=True)
    end = cq.Vector(radius * math.sin(abs(sweep)),
                    math.copysign(radius * (1 - math.cos(sweep)), sweep), 0)
    return mating.socket(part, p, end, start=False, heading=sweep).clean()
