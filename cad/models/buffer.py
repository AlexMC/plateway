"""Buffer stop (family ``buffer_stop``): end of track with one brick connector.

Parameters: the shared brick profile keys, ``run`` (32 or 64 mm, port
to the buffer's back face) and optionally ``lite``. The piece is a level
composite straight whose start carries the production connector and whose far
end is a plain cut with a solid half tie; a stop block closes it.

The block's beam is centred at the magnet-coupler height of brick trains:
8 plates (25.6 mm) above the baseplate, i.e. 16 mm above the rail tops, for the
sealed magnet coupler 64422 and for the 4022 buffer beam alike (L-Gauge
coupler dimensions, https://l-gauge.org/wiki/index.php?title=Couplers). The
beam band 19.2..32 mm (two plates either side) spans the full 63.8 mm track
width, so couplers and side buffers of any brick train meet it. The front face
stands ``BLOCK`` mm before the far end: the coupling plane sits 20.5..21 mm
ahead of the first wheel holder, so the leading wheels stop well before the
block, on rail. The beam overhangs its lower face by 2 mm over a 45 degree
chamfer and the back slopes down to the far end, so it prints flat without
support. Tie-top studs under the block are left off.
"""

from __future__ import annotations

import cadquery as cq
import trimesh

from . import composite

FAMILY = "buffer_stop"
RUNS = (32., 64.)
# Stop block depth from its face to the far end, and beam band (mm above the underside).
BLOCK = 20.
COUPLER = 25.6
BEAM = (COUPLER - 6.4, COUPLER + 6.4)
LIP = 2.
TOP = 6.
PARAMETERS = frozenset(composite.SHARED | {"run"})


def validate(p: dict) -> None:
    if set(p) - {"lite"} != PARAMETERS:
        raise ValueError(f"buffer_stop requires exactly {sorted(PARAMETERS)}")
    if p["run"] not in RUNS:
        raise ValueError("buffer stop run must be 32 or 64 mm")
    composite.validate(request(p))


def request(p: dict) -> dict:
    return composite.straight(p, p["run"], ends=1)


def face(run: float) -> float:
    """Station of the stop face (where a train's coupler meets the beam)."""
    return run - BLOCK


class Builder(composite.Builder):
    def block(self):
        run, front = self.length, face(self.length)
        floor = 0. if self.spec.lite else composite.STREET_FLOOR
        low, high = BEAM
        profile = [(front, floor), (run, floor), (run, composite.end_.RAIL_TOP), (front - LIP + TOP, high),
                   (front - LIP, high), (front - LIP, low), (front, low - LIP)]
        return composite.side_prism(profile, -composite.WIDTH / 2, composite.WIDTH / 2)

    def options(self):
        return [*super().options(), self.block()]

    def tie_columns(self, tie, half):
        if tie[1] > face(self.length) - LIP:
            return []
        return super().tie_columns(tie, half)


def mesh(p: dict) -> trimesh.Trimesh:
    validate(p)
    return composite.track_mesh(request(p), Builder)


def build(p: dict) -> cq.Shape:
    validate(p)
    return composite.build(request(p), Builder)


def ports(p: dict) -> list[dict]:
    """Route ends as for any rail; only the start carries a connector (see connector_ends)."""
    return composite.ports(request(p))


def connector_ends(p: dict) -> list[dict]:
    return composite.connector_ends(request(p))
