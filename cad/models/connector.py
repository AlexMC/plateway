"""Connector coupon; caller supplies explicit dimensions, nominal for trials or measured for production."""

from __future__ import annotations

import cadquery as cq
from cad.models import mating


def build(parameters: dict[str, float]) -> cq.Shape:
    length = parameters["body_length"]
    width = parameters["body_width"]
    thickness = parameters["base_thickness"]
    gauge = parameters["rail_gauge"]
    rail_width = parameters["rail_width"]
    rail_height = parameters["rail_height"]
    tongue_length = parameters["tongue_length"]
    tongue_width = parameters["tongue_width"]
    tongue_height = parameters["tongue_height"]
    clearance = parameters["socket_clearance"]
    socket_depth = parameters["socket_depth"]
    tongue_z = 0  # The entire cantilever contacts the bed in the flat print pose.

    # These rails are shaped from the supplied coupon profile; a nominal profile
    # tests printed-to-printed mating only and cannot certify a brick connection.
    body = cq.Solid.makeBox(length, width, thickness, cq.Vector(0, -width / 2, 0))
    for side in (-1, 1):
        rail = cq.Solid.makeBox(
            length, rail_width, rail_height,
            cq.Vector(0, side * gauge / 2 - rail_width / 2, thickness),
        )
        body = body.fuse(rail)
    tongue = cq.Solid.makeBox(
        tongue_length, tongue_width, tongue_height,
        cq.Vector(length, -tongue_width / 2, tongue_z),
    )
    body = body.fuse(tongue)
    joint = {"joint_depth": socket_depth, "joint_width": tongue_width,
             "joint_height": tongue_height, "joint_clearance": clearance}
    return mating.socket(body, joint, cq.Vector(0, 0, 0), start=True).clean()
