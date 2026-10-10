"""Rerailer (family ``rerailer``): a straight that puts derailed wheels back on.

Parameters: the shared brick profile keys, ``run`` (64 or 128 mm) and
optionally ``lite``. A level composite straight with connectors at both ends
carries, symmetric about its middle so it works in both directions:

- outside each rail, a ramp from the tie tops up to ``PLATEAU`` (0.2 mm below
  the rail tops, flush with the rail head) that lifts a wheel riding on its
  flange outside the rail until it can slide back over the rail head;
- inside the gauge, a ramp up to the flangeway floor (3.2 mm below the rail tops,
  where 64022 and street track floor their flangeways);
- bow-tie guides: a ridge per side from the centreline near each end, rising to
  rail-top height where it meets a 64022-style guard ridge (13.4..14.8 mm from
  the centreline) in the middle, pushing a wheel that dropped inside the gauge
  back out towards its rail.

The layout follows the supplied rerailer reference (cad/models/reference/
rerailer_straight_full.stl, 128 mm): 45 mm outside ramps rising 3.2 -> 9.6 mm,
a rail-top plateau, 6.4 mm inner ramps and bow-tie guides from |y| = 1 to the
guard. Normal running never touches any of it: the flangeway (14.8..18.8 mm
from the centreline) stays clear from 6.4 mm up and nothing rises above the
rail tops. Tie-top studs are left off the full ties the ramps cover.
"""

from __future__ import annotations

import cadquery as cq
import trimesh

from . import composite

FAMILY = "rerailer"
RUNS = (64., 128.)
RAMP = 40.
PLATEAU = composite.end_.RAIL_TOP - .2
HEAD = composite.RAIL + composite.PROFILE["railInterfaceWidth"] / 2
HEAD_INNER = composite.FLANGEWAY[1]
INNER = 9.
# Bow-tie ridge: centre offset where it starts (the pair overlap on the centreline) and
# its half width (the guard ridge's).
RIDGE_START = .2
RIDGE = (composite.GUARD[1] - composite.GUARD[0]) / 2
PARAMETERS = frozenset(composite.SHARED | {"run"})


def validate(p: dict) -> None:
    if set(p) - {"lite"} != PARAMETERS:
        raise ValueError(f"rerailer requires exactly {sorted(PARAMETERS)}")
    if p["run"] not in RUNS:
        raise ValueError("rerailer run must be 64 or 128 mm")
    composite.validate(request(p))


def request(p: dict) -> dict:
    return composite.straight(p, p["run"])


def stations(run: float) -> tuple[float, float, float, float]:
    """Ramp foot, ramp top, far ramp top, far ramp foot."""
    foot = composite.END_TIE
    top = foot + min(RAMP, (run - 2 * foot - 8) / 2)
    return foot, top, run - top, run - foot


class Builder(composite.Builder):
    def guides(self):
        spec, run = self.spec, self.length
        floor = 0. if spec.lite else composite.STREET_FLOOR
        foot, top, far_top, far_foot = stations(run)
        base, flange, rail = composite.BASE, composite.FLANGE_FLOOR, composite.end_.RAIL_TOP

        def ramp(height):
            return [(foot, floor), (far_foot, floor), (far_foot, base), (far_top, height), (top, height), (foot, base)]

        low, high = composite.GUARD
        meshes = []
        for side in (1, -1):
            for y0, y1, profile in ((HEAD, composite.WIDTH / 2, ramp(PLATEAU)), (INNER, HEAD_INNER, ramp(flange)),
                                    (low, high, [(top, floor), (far_top, floor), (far_top, rail), (top, rail)])):
                y0, y1 = sorted((side * y0, side * y1))
                meshes.append(composite.side_prism(profile, y0, y1))
            centre = (low + high) / 2
            for start, end in ((foot + 2, top), (far_foot - 2, far_top)):
                corners = []
                for x, offset, height in ((start, RIDGE_START, flange), (end, centre, rail)):
                    for lateral in (offset - RIDGE, offset + RIDGE):
                        corners += [(x, side * lateral, floor), (x, side * lateral, height)]
                meshes.append(trimesh.convex.convex_hull(corners))
        return composite._union(meshes)

    def options(self):
        return [*super().options(), self.guides()]

    def tie_columns(self, tie, half):
        return super().tie_columns(tie, half) if half else []


def mesh(p: dict) -> trimesh.Trimesh:
    validate(p)
    return composite.track_mesh(request(p), Builder)


def build(p: dict) -> cq.Shape:
    validate(p)
    return composite.build(request(p), Builder)


def ports(p: dict) -> list[dict]:
    return composite.ports(request(p))


def connector_ends(p: dict) -> list[dict]:
    return composite.connector_ends(request(p))
