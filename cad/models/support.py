"""Unrated freestanding column and site-dependent anchored bracket geometry.

The column seat centre is (0,0,height). The wall bracket seat centre is
(reach,0,height); the mounting plate spans x=0..plate_thickness. The two
through-holes accept separately selected non-printed fasteners, not a rated load.

A column stands under the track's underside at its exact height: a printed
wedge part's flat underside (seat level), or a sloped underside, which the
optional ``seat_pitch`` (radians, + rising along +x, the track's heading)
matches with a tilted seat top through (0,0,height). A column lower than its
foot is a flat packer under the whole seat.
"""

from __future__ import annotations

import math

import cadquery as cq

from . import hardware as hw

# Wood screw gauges (mm) a site can usually source; the bracket takes the largest that clears its holes by 0.5 mm.
SCREW_GAUGES = (3., 3.5, 4., 4.5, 5., 6.)
# Screw length: through the plate plus 25 mm into a wall plug or timber, in 5 mm steps.
SCREW_GRIP = 25.


def reversible(p: dict[str, float]) -> cq.Shape:
    height, pitch = p["height"], p.get("seat_pitch", 0.)
    # Built up to the tilted seat's high edge, then cut to the seat plane.
    top = height + p["seat_depth"] / 2 * abs(math.tan(pitch))
    if height < p["foot_thickness"]:
        packer = cq.Solid.makeBox(p["seat_depth"], p["seat_width"], top,
                                  cq.Vector(-p["seat_depth"] / 2, -p["seat_width"] / 2, 0))
        return _seat_plane(packer, height, pitch)
    foot = cq.Solid.makeBox(p["foot_length"], p["foot_width"], p["foot_thickness"],
                            cq.Vector(-p["foot_length"] / 2, -p["foot_width"] / 2, 0))
    flare = 1.4 * max((p["seat_depth"] - p["stem_depth"]) / 2,
                      (p["seat_width"] - p["stem_width"]) / 2)
    if top <= p["foot_thickness"] + p["seat_thickness"] + flare:
        # A low riser cannot contain a self-supporting tapered column; make a
        # solid, bed-backed plinth beneath the entire seat instead.
        plinth = cq.Solid.makeBox(p["seat_depth"], p["seat_width"], top,
                                  cq.Vector(-p["seat_depth"] / 2, -p["seat_width"] / 2, 0))
        return _seat_plane(foot.fuse(plinth).clean(), height, pitch)
    stem = cq.Solid.makeBox(p["stem_depth"], p["stem_width"],
                            top - p["foot_thickness"],
                            cq.Vector(-p["stem_depth"] / 2, -p["stem_width"] / 2,
                                      p["foot_thickness"]))
    # The seat plate is seat_thickness thick at its low edge.
    seat_base = top - p["seat_thickness"] - p["seat_depth"] * abs(math.tan(pitch))
    gusset = (cq.Workplane("XY").workplane(offset=seat_base - flare)
              .rect(p["stem_depth"], p["stem_width"])
              .workplane(offset=flare).rect(p["seat_depth"], p["seat_width"])
              .loft(combine=True).val()) if flare > 0 else stem
    seat = cq.Solid.makeBox(p["seat_depth"], p["seat_width"], top - seat_base,
                            cq.Vector(-p["seat_depth"] / 2, -p["seat_width"] / 2,
                                      seat_base))
    return _seat_plane(foot.fuse(stem).fuse(gusset).fuse(seat).clean(), height, pitch)


def _seat_plane(shape: cq.Shape, height: float, pitch: float) -> cq.Shape:
    """Cut the column's top to the seat plane through (0,0,height) rising tan(pitch) per mm along +x."""
    if abs(pitch) < 1e-9:
        return shape
    size = 4000.
    cutter = (cq.Solid.makeBox(size, size, size, cq.Vector(-size / 2, -size / 2, 0))
              .rotate(cq.Vector(0, 0, 0), cq.Vector(0, 1, 0), -math.degrees(pitch))
              .translate(cq.Vector(0, 0, height)))
    return shape.cut(cutter).clean()


def anchored(p: dict[str, float]) -> cq.Shape:
    height, reach = p["height"], p["reach"]
    plate = cq.Solid.makeBox(p["plate_thickness"], p["plate_width"], height,
                             cq.Vector(0, -p["plate_width"] / 2, 0))
    for z in ((height - p["hole_spacing"]) / 2, (height + p["hole_spacing"]) / 2):
        drill = cq.Solid.makeCylinder(p["hole_diameter"] / 2, p["plate_thickness"] + 2,
                                      cq.Vector(-1, 0, z), cq.Vector(1, 0, 0))
        plate = plate.cut(drill)
    arm = cq.Solid.makeBox(reach - p["plate_thickness"], p["arm_width"],
                           p["arm_thickness"],
                           cq.Vector(p["plate_thickness"], -p["arm_width"] / 2,
                                     height - p["arm_thickness"]))
    seat = cq.Solid.makeBox(p["seat_depth"], p["seat_width"], p["seat_thickness"],
                            cq.Vector(reach - p["seat_depth"] / 2,
                                      -p["seat_width"] / 2, height - p["seat_thickness"]))
    return plate.fuse(arm).fuse(seat).clean()


def anchored_hardware(p: dict[str, float]) -> list[dict]:
    """One wood screw per through-hole of an anchored bracket (two), sized to the hole and the plate."""
    gauges = [g for g in SCREW_GAUGES if g <= p["hole_diameter"] - .5]
    if not gauges:
        raise ValueError("anchored bracket holes are too small for a wood screw")
    length = math.ceil((p["plate_thickness"] + SCREW_GRIP) / 5.) * 5.
    return [hw.wood_screw(f"{gauges[-1]:g} x {length:g}", 2)]
