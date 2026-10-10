"""Measured-parameter cubic vertical rail transition with declared endpoint grades."""

from __future__ import annotations

import cadquery as cq
from cad.models import brick_end, mating


def _extruded_profile(run: float, rise: float, start_grade: float, end_grade: float,
                      bottom: float, height: float, y_min: float, width: float) -> cq.Shape:
    def curve(z_offset: float) -> cq.Edge:
        # Cubic Hermite in Bezier form, with x(t)=run*t. Its endpoint slopes
        # dz/dx are exactly start_grade and end_grade.
        return cq.Edge.makeBezier([
            cq.Vector(0, y_min, z_offset),
            cq.Vector(run / 3, y_min, z_offset + start_grade * run / 3),
            cq.Vector(2 * run / 3, y_min, z_offset + rise - end_grade * run / 3),
            cq.Vector(run, y_min, z_offset + rise),
        ])

    low = curve(bottom)
    high = curve(bottom + height)
    wire = cq.Wire.assembleEdges([
        low,
        cq.Edge.makeLine(cq.Vector(run, y_min, bottom + rise),
                         cq.Vector(run, y_min, bottom + height + rise)),
        high,
        cq.Edge.makeLine(cq.Vector(0, y_min, bottom + height),
                         cq.Vector(0, y_min, bottom)),
    ])
    return cq.Solid.extrudeLinear(wire, [], cq.Vector(0, width, 0))


def build(parameters: dict[str, float]) -> cq.Shape:
    if "connector_version" in parameters:
        return brick_end.track(parameters, "vertical_transition")
    run = parameters["run"]
    rise = parameters["rise"]
    start_grade = parameters["start_grade"]
    end_grade = parameters["end_grade"]
    width = parameters["body_width"]
    thickness = parameters["base_thickness"]
    gauge = parameters["rail_gauge"]
    rail_width = parameters["rail_interface_width"]
    rail_height = parameters["rail_height"]
    part = _extruded_profile(run, rise, start_grade, end_grade,
                             0, thickness, -width / 2, width)
    for side in (-1, 1):
        rail = _extruded_profile(run, rise, start_grade, end_grade,
                                 thickness, rail_height,
                                 side * gauge / 2 - rail_width / 2, rail_width)
        part = part.fuse(rail)
    part = mating.socket(part, parameters, cq.Vector(0, 0, 0),
                         start=True, grade=start_grade)
    return mating.socket(part, parameters, cq.Vector(run, 0, rise),
                         start=False, grade=end_grade).clean()
