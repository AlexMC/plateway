"""Open-bottom joiner sockets in the rail datum frame; fit remains a physical trial."""

from __future__ import annotations

import math
import cadquery as cq


def socket(body: cq.Shape, p: dict[str, float], origin: cq.Vector,
           *, start: bool, heading: float = 0, grade: float = 0) -> cq.Shape:
    depth, clearance = p['joint_depth'], p['joint_clearance']
    width = p['joint_width'] + 2 * clearance
    height = p['joint_height'] + 2 * clearance
    tool = cq.Solid.makeBox(depth + 1, width, height,
                            cq.Vector(-1 if start else -depth, -width / 2, 0))
    if grade:
        tool = tool.rotate((0, 0, 0), (0, 1, 0), -math.degrees(math.atan(grade)))
    if heading:
        tool = tool.rotate((0, 0, 0), (0, 0, 1), math.degrees(heading))
    return body.cut(tool.translate(origin))


def joiner(p: dict[str, float]) -> cq.Shape:
    length = 2 * (p['joint_depth'] - p['joint_clearance'])
    return cq.Solid.makeBox(length, p['joint_width'], p['joint_height'],
                            cq.Vector(0, -p['joint_width'] / 2, 0))
