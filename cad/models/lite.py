"""Fast-print track: the accepted end connectors, both rails, solid rail supports
and thin gauge braces.

Follows brick_end.track step for step, from its unchanged helpers: the same
rigid end contacts, body sweep, rails and end half ties (contacts, clutch and
studs). Only the interior differs: every full tie becomes a 2.8 mm brace at
its centre, and the rail stringers stay solid (no channel, no tie clutch or
studs), so the underside no longer seats on a studded baseplate. Kept apart
from brick_end.py so fast-print changes never alter full-detail recipes.
Track mechanisms (track_assembly) reuse the brace and rail-support dimensions.
"""
from __future__ import annotations

import math

import cadquery as cq
import manifold3d
import numpy as np
import trimesh

from . import brick_end as end_
from .brick_end import PROFILE

FAMILIES = ("printed_straight", "printed_curve", "vertical_transition", "bridge_deck", "bridge_joint")
# Rail supports: the full-detail stringers, filled.
RAIL_BAND = (PROFILE["railGauge"] / 2 - PROFILE["baseStringerWidth"] / 2,
             PROFILE["railGauge"] / 2 + PROFILE["baseStringerWidth"] / 2)
END_TIE = PROFILE["endTieWidth"]
BRACE_WIDTH = 2.8
# Braces overlap the rail supports instead of butting against them.
BRACE_OVERLAP = .05
RAMP_BRACE_PITCH = 16.


def enabled(p: dict) -> bool:
    return "lite" in p


def validate(p: dict) -> None:
    value = p.get("lite", 1)
    if isinstance(value, bool) or value != 1:
        raise ValueError("lite must be 1 when present")


def route(p: dict, family: str):
    """(length, start frame, end frame, centre path, sweep plane), as brick_end.track."""
    end_.validate(p)
    sweep = p.get("sweep", 0)
    if family == "printed_curve":
        radius = p["radius"]
        length = radius * abs(sweep)
        endpoint = (radius * math.sin(abs(sweep)),
                    math.copysign(radius * (1 - math.cos(sweep)), sweep), 0)
    else:
        length = p.get("run", p.get("joint_length", 0))
        endpoint = (length, 0, p.get("rise", 0))
    if length < PROFILE["minimumLength"]:
        raise ValueError("shared connector rails require at least 24 mm between ports")
    start = end_._frame((0, 0, 0), 0, p.get("start_grade", 0))
    end = end_._frame(endpoint, sweep, p.get("end_grade", 0))
    depth = PROFILE["endLength"]
    a = start[:3, 3] + depth * start[:3, 0]
    b = end[:3, 3] - depth * end[:3, 0]
    if np.dot(b - a, start[:3, 0]) <= 0 or np.dot(b - a, end[:3, 0]) <= 0:
        raise ValueError("rigid connector ends leave no forward centre web")
    path, _ = end_._centre_path(p, family, start, end, length)
    plane = cq.Plane(origin=cq.Vector(*a), xDir=cq.Vector(*start[:3, 1]),
                     normal=cq.Vector(*start[:3, 0]))
    return length, start, end, path, plane


def brace_intervals(p: dict, family: str, length: float) -> list[tuple[float, float, bool]]:
    """(low, high, full width) station interval of every gauge brace.

    Braces sit at the full-detail tie centres (equal-angle on the official R40,
    else tie_intervals) and span between the rail supports. Ramps print lying
    on their right side: their braces run the full body width and are added
    between the tie centres, at most 16 mm apart, so every bed-facing rail
    support spans a short bridge between brace ends standing on the bed.
    """
    ties = end_.tie_intervals(length, equal_pitch=end_.is_official_curve(p, family))
    stations = [(low + high) / 2 for low, high in ties[1:-1]]
    ramp = family == "vertical_transition"
    if ramp:
        anchors = [END_TIE, *stations, length - END_TIE]
        stations = sorted(stations + [low + (high - low) * k / count
                                      for low, high in zip(anchors, anchors[1:])
                                      for count in [math.ceil((high - low) / RAMP_BRACE_PITCH - 1e-9)]
                                      for k in range(1, count)])
    return [(station - BRACE_WIDTH / 2, station + BRACE_WIDTH / 2, ramp) for station in stations]


def brace(frame, half_span: float, width: float = BRACE_WIDTH) -> trimesh.Trimesh:
    """A gauge brace box in a tie frame."""
    mesh = end_._box((-width / 2, -half_span, 0), (width / 2, half_span, PROFILE["baseThickness"]))
    mesh.apply_transform(frame)
    return mesh


def _open_between_braces(centre, plane, path, p, family, length, start, end, braces):
    """brick_end._open_tie_gaps with braces instead of ties.

    Printed-only pieces open each lateral band between the end ties and the
    braces reaching it (station masks, radial on curves), so braces are slices
    of the body sweep. The official R40 opens its whole interior and adds rigid
    rectangular braces, like its full-detail ties.
    """
    width, base = PROFILE["bodyWidth"], PROFILE["baseThickness"]
    rail, half = PROFILE["railGauge"] / 2, PROFILE["baseStringerWidth"] / 2
    bands = []
    for low, high in ((-width / 2 - 1, -rail - half),
                      (-rail + half, rail - half), (rail + half, width / 2 + 1)):
        section = [(low, -1), (high, -1), (high, base + .1), (low, base + .1)]
        bands.append(end_._mesh(cq.Workplane(plane).polyline(section).close().sweep(
            cq.Workplane().newObject([path]), isFrenet=False).val()))
    ties = end_.tie_intervals(length, equal_pitch=end_.is_official_curve(p, family))
    low_z, high_z = centre.bounds[0, 2] - 1, centre.bounds[1, 2] + 1
    if end_.is_official_curve(p, family):
        openings = trimesh.boolean.intersection(
            [trimesh.boolean.union(bands, engine="manifold"),
             end_._interior_mask(p, family, length, low_z, high_z, start, end)], engine="manifold")
        slabs = []
        for low, high, full in braces:
            span = width / 2 if full else RAIL_BAND[0] + BRACE_OVERLAP
            slab = end_._box((-(high - low) / 2, -span, 0), ((high - low) / 2, span, base))
            slab.apply_transform(end_._tie_frame(path, p, family, (low + high) / 2))
            slabs.append(slab)
        opened = trimesh.boolean.difference([centre, openings], engine="manifold")
        return trimesh.boolean.union([opened, *slabs], engine="manifold")
    openings = []
    for index, band in enumerate(bands):
        kept = [ties[0], *sorted((low, high) for low, high, full in braces if full or index == 1), ties[-1]]
        masks = [end_._station_mask(p, family, left[1], right[0], low_z, high_z)
                 for left, right in zip(kept, kept[1:])]
        openings.append(trimesh.boolean.intersection(
            [band, trimesh.boolean.union(masks, engine="manifold")], engine="manifold"))
    return trimesh.boolean.difference([centre, *openings], engine="manifold")


def _end_attachments(mesh, p, family, start, end):
    """brick_end._brick_attachments for the two end half ties only; no channel."""
    a = PROFILE["brickAttachment"]
    cutters, additions = [], []
    rigid = end_.is_official_curve(p, family)
    length = p["radius"] * abs(p["sweep"]) if family == "printed_curve" else 0
    for frame, low, high in ((start, 0, END_TIE), (end @ np.diag([-1, -1, 1, 1]), length - END_TIE, length)):
        if family == "printed_curve" and not rigid:
            # The rigid half-tie cavity must fit inside the approved radial tie.
            side, radius = math.copysign(1, p["sweep"]), p["radius"]
            for y in (a["cavityLateralIntervals"][0][0], a["cavityLateralIntervals"][-1][1]):
                point = frame @ np.array([a["halfTieCavityEnd"], y, 0, 1])
                station = radius * math.atan2(point[0], radius - side * point[1])
                lateral = radius - math.hypot(point[0], radius - side * point[1])
                if not low < station < high or abs(lateral) >= PROFILE["bodyWidth"] / 2:
                    raise ValueError("rigid brick cavity would break through a curved tie wall")
        local_cuts = [end_._box((PROFILE["endLength"] + .05, -PROFILE["bodyWidth"] / 2, -end_.RAIL_TOP),
                                (END_TIE, PROFILE["bodyWidth"] / 2, 0))]
        local_cuts += end_.stud_lands(half=True)
        clutch_cuts, local_additions = end_.tie_clutch(half=True)
        for shape in local_cuts + clutch_cuts:
            shape.apply_transform(frame)
            cutters.append(shape)
        for shape in local_additions:
            shape.apply_transform(frame)
            additions.append(shape)
    opened = trimesh.boolean.difference([mesh, *cutters], engine="manifold")
    return trimesh.boolean.union([opened, *additions], engine="manifold")


def build(p: dict, family: str) -> cq.Shape:
    if family not in FAMILIES:
        raise ValueError(f"no fast-print geometry for {family}")
    validate(p)
    p = {k: v for k, v in p.items() if k != "lite"}
    length, start, end, path, plane = route(p, family)
    width, base = PROFILE["bodyWidth"], PROFILE["baseThickness"]
    # One exterior contour, exactly as the full-detail body sweep.
    section = [(-width / 2, 0), (width / 2, 0), (width / 2, base)]
    for lateral in (20, -20):
        section.extend((y + lateral, z) for y, z in reversed(PROFILE["railSection"]))
    section.append((-width / 2, base))
    centre = end_._mesh(cq.Workplane(plane).polyline(section).close().sweep(
        cq.Workplane().newObject([path]), isFrenet=False).val())
    centre = _open_between_braces(centre, plane, path, p, family, length, start, end,
                                  brace_intervals(p, family, length))
    first = end_._production_end(p["fit_adjustment"])
    last = end_._production_end(p["fit_adjustment"], opposite=True)
    first.apply_transform(start)
    last.apply_transform(end @ np.diag([-1, -1, 1, 1]))
    collision = trimesh.boolean.intersection([first, last], engine="manifold")
    if len(collision.faces) and collision.volume > .001:
        raise ValueError("rigid connector ends overlap")
    mesh = trimesh.boolean.union([first, last, centre], engine="manifold")
    mesh = _end_attachments(mesh, p, family, start, end)
    # Same bounded seam retriangulation as the full-detail part.
    joined = manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))
    joined_mesh = joined.simplify(1e-5).to_mesh()
    return end_._solid(trimesh.Trimesh(joined_mesh.vert_properties[:, :3], joined_mesh.tri_verts, process=True))
