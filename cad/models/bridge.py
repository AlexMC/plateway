"""Rail-bearing bridge modules with female deck sockets and a mating double-ended joint.

Local rail ports lie at x=0 and x=run (or joint_length). The joint tongues
extend behind/ahead of its ports; deck pockets open at the deck ends. Neither
part certifies deflection or the strength of a printed crossing.
"""

from __future__ import annotations

import cadquery as cq
from cad.models import brick_end, mating


def _rails(body: cq.Shape, run: float, p: dict[str, float], x: float = 0) -> cq.Shape:
    for y in (-p["rail_gauge"] / 2, p["rail_gauge"] / 2):
        body = body.fuse(cq.Solid.makeBox(run, p["rail_interface_width"], p["rail_height"],
                                        cq.Vector(x, y - p["rail_interface_width"] / 2,
                                                  p["deck_thickness"])))
    return body.clean()


def deck(p: dict[str, float]) -> cq.Shape:
    if "connector_version" in p:
        return brick_end.track(p, "bridge_deck")
    run, width, thickness = p["run"], p["deck_width"], p["deck_thickness"]
    body = cq.Solid.makeBox(run, width, thickness, cq.Vector(0, -width / 2, 0))
    body = mating.socket(body, p, cq.Vector(0, 0, 0), start=True)
    body = mating.socket(body, p, cq.Vector(run, 0, 0), start=False)
    return _rails(body, run, p)


def joint(p: dict[str, float]) -> cq.Shape:
    if "connector_version" in p:
        return brick_end.track(p, "bridge_joint")
    run, width, thickness = p["joint_length"], p["deck_width"], p["deck_thickness"]
    body = cq.Solid.makeBox(run, width, thickness, cq.Vector(0, -width / 2, 0))
    tongue_z = 0  # Both tongues touch the build plate in the flat orientation.
    for x in (-p["joint_depth"], run):
        tongue = cq.Solid.makeBox(p["joint_depth"], p["joint_width"], p["joint_height"],
                                  cq.Vector(x, -p["joint_width"] / 2, tongue_z))
        body = body.fuse(tongue)
    return _rails(body, run, p)
