"""Composite track (family ``composite_track``): any plain track path.

Numbers-only parameters (see ``validate``):
- ``segments`` N (1..8); ``s{i}_len`` plan-view centreline length (mm),
  ``s{i}_k0``/``s{i}_k1`` signed curvature (1/mm, + = left) at its start/end:
  equal = arc, 0 = straight, different = clothoid (linear curvature).
- ``z0``/``z1`` port heights (mm, piece frame), ``grade0``/``grade1`` port grades
  (rise/run). z(s) is the cubic Hermite over plan station s (as ramps); its grade
  never exceeds 6 % and its vertical radius never falls below ``vcurve`` (mm, 0 =
  unchecked).
- ``cant0``/``cant1`` signed roll (degrees, + raises the right rail, banking a
  left turn), linear in s, at most 4 degrees and zero at every connector end.
- ``ends`` bitmask: 1 start, 2 end brick connector; a clear bit is a plain
  vertical cut end with a solid half tie (for keyed assemblies).
- Options, omitted = 0: ``ballast``, ``guard_rail``, ``street`` (0/1),
  ``marker`` (colour-sensor colour id 1..10) at plan station ``marker_s``; ``lite``
  (present = 1) is the fast-print style; ``socket`` (0/1) with ``socket_s``,
  ``socket_side`` (+1 left / -1 right of travel) and ``socket_offset`` (mm,
  centreline to column axis) is a helix column lug.
- ``gauge`` (omitted = standard): 1 narrow (24 mm, 6-stud sleepers), 2 dual
  (standard plus centred narrow rails); experimental, see gauge.py.
- ``metal`` 1 code 250 nickel-silver 9V rail inserts (``metal_base`` foot width,
  mm) or 2 copper-tape 9V rails; ``led`` 1/2 an 8/10 mm LED strip channel under
  the deck; standard gauge only; experimental, see track_power.py.

Everything physical comes unchanged from brick_end (production ends, rail
section, tie clutch, stud lands, rail channel, tie layout) and lite (gauge
braces). Ties are rigid tie frames at ``tie_intervals`` stations along the plan
centreline, residual confined to the middle; only a single level R320 22.5
degree arc uses the official equal-angle stations. A single straight or arc is
therefore printed_straight / printed_curve.

Two constructions:
- Level (z0 = z1, zero grades and cant): brick_end's own OCC sweep along a wire
  of 5.8 mm rigid ends, Bezier blends to 23.2 mm, exact lines/arcs and
  interpolated clothoids.
- Wedge (any grade or cant): prints flat, supported only at connector ends. One
  ring sweep of vertical sections normal to the plan path carries the rails and
  deck on the profile and a solid base down to one flat underside at the lowest
  point (profile or connector contacts). Every full tie keeps the standard flat
  underside clutch there, so the piece seats on a baseplate or riser; tie
  openings run through the base, leaving rail stringers and ties as walls. The
  body starts on each connector's pitched contact face and turns vertical within
  2 mm. A connector end above the underside keeps its exact contacts and half
  tie and floats; plates.py paints that half tie's underside for support.
  Measured on the X1C (0.20 mm Standard), 128 mm rising 4 mm: flat wedge 596 mm
  of support filament and 67 min, versus 7044 mm and 108 min for the same
  profile printed ramp-style side-on-bed (which also only works on straights).
- Cant rolls the running surface about the inner rail: the inner rail stays on
  the grade line, the outer rail is lifted by gauge*tan(cant), the deck between
  them and outside the outer rail becomes the rolled plane, the underside stays
  flat. Studs on the rolled deck are perpendicular to it.

Options (off by default):
- ballast: 8 mm shoulders outside both body edges, port to port, top at deck
  level with a chamfered toe; their underside carries a baseplate stud channel
  on the y = +/-36 stud rows like the rail stringers.
- guard_rail: 64022 guard ridges (13.4..14.8 mm from the centreline, rail-top
  high) inside both rails, i.e. the official 4 mm flangeway; between end ties.
  They bridge the tie gaps at 2 mm (clear of baseplate studs); +/-12 tie-top
  studs are omitted where the ridge stands.
- street: road surface flush with the rail tops between the end ties, with
  64022-style 4 mm flangeway grooves floored at 6.4 mm; tie gaps stay open
  underneath (bridged roofs), tie-top studs are covered.
- marker: the full tie nearest ``marker_s`` loses its two central studs and
  carries a 1.6 mm rim around a 12.4 mm square recess. The colour is a
  separately printed ``marker_insert`` (12 x 12 x 1.6 mm) pressed into it: one
  single-material solid per part, so any printer or AMS slot prints it, rather
  than a multi-body 3MF whose per-object filament mapping the Bambu CLI slicing
  path cannot verify.
- socket: the full tie nearest ``socket_s`` reaches sideways into a flat lug on the
  underside plane (3.2 mm thick, a 20 mm ring around a 10 mm bore at
  ``socket_offset``); a stack of helix_column tubes passes through the bores of
  the lugs at the same plan position on every turn. It prints on the bed.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import tempfile

import cadquery as cq
import manifold3d
import numpy as np
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
from OCP.Standard import Standard_Failure
from OCP.StlAPI import StlAPI_Reader
from OCP.TopoDS import TopoDS, TopoDS_Shape
import trimesh

from . import brick_end as end_
from . import lite as lite_
from .brick_end import PROFILE

FAMILY = "composite_track"
INSERT_FAMILY = "marker_insert"
MAX_SEGMENTS = 8
MAX_CURVATURE = 1 / 176
MAX_TURN = math.pi
MAX_LENGTH = 2000.
MAX_HEIGHT = 1000.
MAX_GRADE = .06
MAX_CANT = 4.
MAX_MARKER = 10
SHARED = frozenset({"connector_version", "fit_adjustment", "body_width", "base_thickness",
                    "rail_gauge", "rail_interface_width", "rail_height"})
CORE = frozenset({"segments", "z0", "z1", "grade0", "grade1", "vcurve", "cant0", "cant1", "ends"})
OPTIONS = frozenset({"ballast", "guard_rail", "street", "marker", "marker_s",
                     "socket", "socket_s", "socket_side", "socket_offset", "gauge", "metal", "metal_base", "led",
                     "rack", "rack_pitch", "rack_phase", "rack_in", "rack_out"})

WIDTH, BASE = PROFILE["bodyWidth"], PROFILE["baseThickness"]
DEPTH, END_TIE = PROFILE["endLength"], PROFILE["endTieWidth"]
RAIL = PROFILE["railGauge"] / 2
STRINGER = PROFILE["baseStringerWidth"] / 2
ATTACH = PROFILE["brickAttachment"]
# Plates paints elevated connector ends out to their half tie's inner wall.
ELEVATION_TOLERANCE = .05
# 64022 guard ridges and flangeway (track_assembly's flex link carries the same).
GUARD = (13.4, 14.8)
GUARD_FLOOR = 2.
FLANGEWAY = (14.8, RAIL - PROFILE["railInterfaceWidth"] / 2)
FLANGE_FLOOR = end_.RAIL_TOP - 3.2
STREET_FLOOR = BASE - .2
# Ballast shoulder: inner wall, stud channel on the y=36 stud row, toe.
BALLAST = (WIDTH / 2 + 1.4, WIDTH / 2 + 6.8, WIDTH / 2 + 8.)
BALLAST_ROOF = ATTACH["railChannel"]["lowerCeiling"]
MARKER_RIM, MARKER_POCKET, MARKER_INSERT, MARKER_HEIGHT = 15.8, 12.4, 12., 1.6
# Helix column lug (helix_column.BORE/RING): flat on the underside, base-thick.
LUG_THICKNESS, LUG_BORE, LUG_RING = BASE, 10., 20.
LUG_OFFSET = (WIDTH / 2 + LUG_RING / 2 + 2, 120.)
# Mask lateral reach: beyond every void band, well inside the minimum radius.
REACH = WIDTH / 2 + 10
MESH_STEP = .5


def _integer(p, key, low, high):
    value = p.get(key, 0)
    if isinstance(value, bool) or value != int(value) or not low <= value <= high:
        raise ValueError(f"{key} must be an integer from {low} to {high}")
    return int(value)


def parameter_keys(p: dict) -> set[str]:
    """Exact parameter names of a composite request (options may be omitted)."""
    count = p.get("segments")
    if (isinstance(count, bool) or not isinstance(count, (int, float)) or not math.isfinite(count)
            or count != int(count) or not 1 <= count <= MAX_SEGMENTS):
        raise ValueError(f"segments must be an integer from 1 to {MAX_SEGMENTS}")
    segments = {f"s{i}_{key}" for i in range(int(count)) for key in ("len", "k0", "k1")}
    return set(SHARED | CORE | segments | (OPTIONS & set(p)))


def straight(p: dict, length: float, ends: int = 3) -> dict:
    """Request for a level straight of ``length`` carrying p's shared profile keys (and lite)."""
    request = {key: p[key] for key in SHARED}
    request.update(segments=1, s0_len=float(length), s0_k0=0., s0_k1=0., z0=0., z1=0., grade0=0., grade1=0.,
                   vcurve=0., cant0=0., cant1=0., ends=ends)
    if "lite" in p:
        request["lite"] = p["lite"]
    return request


@dataclass(frozen=True)
class Spec:
    segments: tuple[tuple[float, float, float], ...]
    length: float
    z0: float
    rise: float
    grade0: float
    grade1: float
    vcurve: float
    cant0: float
    cant1: float
    ends: int
    ballast: bool
    guard: bool
    street: bool
    marker: int
    marker_s: float
    lite: bool
    adjustment: float
    socket: int = 0
    socket_s: float = 0.
    socket_side: int = 1
    socket_offset: float = 0.
    gauge: int = 0
    # 9V rails (1 code 250 nickel-silver, 2 copper tape), its foot width, LED channel (1 8 mm, 2 10 mm strip): track_power.py.
    metal: int = 0
    metal_base: float = 5.
    led: int = 0
    # Rack railway (rack.py): 0/1, 3D tooth spacing and first-tooth distance, remaining entry taper at each end (mm).
    rack: int = 0
    rack_pitch: float = 0.
    rack_phase: float = 0.
    rack_in: float = 0.
    rack_out: float = 0.

    @property
    def rack_options(self) -> dict:
        return {"rack": self.rack, "rack_pitch": self.rack_pitch, "rack_phase": self.rack_phase,
                "rack_in": self.rack_in, "rack_out": self.rack_out}

    @property
    def level(self) -> bool:
        return not (self.rise or self.grade0 or self.grade1 or self.cant0 or self.cant1)

    @property
    def rigid(self) -> bool:
        """The official R40 (53400) arc: rigid ties at equal angles."""
        official = PROFILE["officialCurve"]
        if len(self.segments) != 1 or not self.level:
            return False
        length, k0, k1 = self.segments[0]
        return (k0 == k1 and math.isclose(abs(k0) * official["radius"], 1, abs_tol=1e-9)
                and math.isclose(length, official["radius"] * math.radians(official["sweepDegrees"]),
                                 abs_tol=1e-6))

    def z(self, s):
        t = np.asarray(s, dtype=float) / self.length
        run = self.length
        return ((t**3 - 2*t*t + t) * run * self.grade0 + (-2*t**3 + 3*t*t) * self.rise
                + (t**3 - t*t) * run * self.grade1)

    def dz(self, s):
        t = np.asarray(s, dtype=float) / self.length
        return ((3*t*t - 4*t + 1) * self.grade0 + (-6*t*t + 6*t) * self.rise / self.length
                + (3*t*t - 2*t) * self.grade1)

    def d2z(self, s):
        t = np.asarray(s, dtype=float) / self.length
        return ((6*t - 4) * self.grade0 + (-12*t + 6) * self.rise / self.length
                + (6*t - 2) * self.grade1) / self.length

    def height(self, s: float) -> float:
        """Datum height (relative to z0), linear beyond the ports."""
        if s < 0:
            return self.grade0 * s
        if s > self.length:
            return self.rise + self.grade1 * (s - self.length)
        return float(self.z(s))

    def slope(self, s: float) -> float:
        return self.grade0 if s < 0 else self.grade1 if s > self.length else float(self.dz(s))

    def cant(self, s: float) -> float:
        t = min(max(s / self.length, 0), 1)
        return self.cant0 + (self.cant1 - self.cant0) * t

    @property
    def base(self) -> float:
        """Flat underside height (relative to z0): the lowest point of the profile
        and of the pitched connector contacts (tongues 3.7 mm past the port face,
        coupon underside to 5.85 mm inside it)."""
        samples = self.z(np.linspace(0, self.length, 401))
        low = min(float(samples.min()), 0., self.rise)
        for bit, z, grade in ((1, 0., self.grade0), (2, self.rise, -self.grade1)):
            if self.ends & bit:
                pitch = math.atan(grade)
                low = min(low, z - 3.7 * math.sin(pitch), z + (DEPTH + .05) * math.sin(pitch))
        return low


def validate(p: dict) -> Spec:
    """Numbers-only parameter validation; geometry checks happen while building."""
    if p.get("gauge") == 1:
        return _gauge().narrow_validate(p)
    keys = parameter_keys(p)
    if set(p) - {"lite"} != keys:
        raise ValueError(f"composite_track requires exactly {sorted(keys)}")
    for key, value in p.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"parameters.{key} must be a finite number")
    end_.validate(p)
    fast = "lite" in p
    if fast:
        lite_.validate(p)
    segments = []
    turning = 0.
    for index in range(int(p["segments"])):
        length, k0, k1 = (p[f"s{index}_{key}"] for key in ("len", "k0", "k1"))
        if not 0 < length <= MAX_LENGTH:
            raise ValueError(f"s{index}_len must be positive and at most {MAX_LENGTH:g} mm")
        if max(abs(k0), abs(k1)) > MAX_CURVATURE + 1e-12:
            raise ValueError("segment curvature must not exceed 1/176 per mm (R176)")
        if k0 * k1 >= 0:
            turning += (abs(k0) + abs(k1)) / 2 * length
        else:
            turning += length * (k0 * k0 + k1 * k1) / (2 * (abs(k0) + abs(k1)))
        segments.append((float(length), float(k0), float(k1)))
    total = sum(length for length, _, _ in segments)
    if not PROFILE["minimumLength"] <= total <= MAX_LENGTH:
        raise ValueError(f"composite length must be from 24 to {MAX_LENGTH:g} mm")
    if turning > MAX_TURN + 1e-9:
        raise ValueError("composite track may turn through at most 180 degrees")
    for key in ("z0", "z1"):
        if abs(p[key]) > MAX_HEIGHT:
            raise ValueError(f"{key} must be within +/-{MAX_HEIGHT:g} mm")
    # Rack track (rack.py) climbs up to 20 % for cog trains.
    max_grade = _rack().MAX_GRADE if p.get("rack") == 1 else MAX_GRADE
    for key in ("grade0", "grade1"):
        if abs(p[key]) > max_grade + 1e-12:
            raise ValueError(f"{key} must not exceed {max_grade * 100:g} %")
    for key in ("cant0", "cant1"):
        if abs(p[key]) > MAX_CANT + 1e-12:
            raise ValueError(f"{key} must not exceed {MAX_CANT:g} degrees")
    if p["vcurve"] < 0:
        raise ValueError("vcurve must not be negative")
    ends = _integer(p, "ends", 0, 3)
    for bit, key in ((1, "cant0"), (2, "cant1")):
        if ends & bit and p[key]:
            raise ValueError(f"{key} must be 0 at a brick track connector end")
    options = {key: _integer(p, key, 0, 1) for key in ("ballast", "guard_rail", "street")}
    if options["guard_rail"] and options["street"]:
        raise ValueError("street track already has flangeway grooves; omit guard_rail")
    marker = _integer(p, "marker", 0, MAX_MARKER)
    marker_s = float(p.get("marker_s", 0))
    if not 0 <= marker_s <= total:
        raise ValueError("marker_s must lie on the piece")
    socket = _integer(p, "socket", 0, 1)
    socket_s, socket_side, socket_offset = (float(p.get(key, 0)) for key in ("socket_s", "socket_side", "socket_offset"))
    if socket:
        if not 0 <= socket_s <= total:
            raise ValueError("socket_s must lie on the piece")
        if socket_side not in (-1, 1):
            raise ValueError("socket_side must be 1 (left) or -1 (right)")
        if not LUG_OFFSET[0] <= socket_offset <= LUG_OFFSET[1]:
            raise ValueError(f"socket_offset must be {LUG_OFFSET[0]:g} to {LUG_OFFSET[1]:g} mm")
    gauge = _integer(p, "gauge", 0, 2)
    metal, led = _integer(p, "metal", 0, 2), _integer(p, "led", 0, 2)
    if (metal or led) and (gauge or RAIL != 20):
        raise ValueError("Metal 9 V rails and LED channels are standard gauge only")
    rack = _rack().validate_options(p, total, (p["cant0"], p["cant1"]), {**options, "marker": marker})
    if rack["rack"] and (gauge or RAIL != 20):
        raise ValueError("rack track is standard gauge only")
    spec = Spec(tuple(segments), total, float(p["z0"]), float(p["z1"] - p["z0"]),
                float(p["grade0"]), float(p["grade1"]), float(p["vcurve"]),
                math.radians(p["cant0"]), math.radians(p["cant1"]), ends,
                bool(options["ballast"]), bool(options["guard_rail"]), bool(options["street"]),
                marker, marker_s, fast, float(p["fit_adjustment"]),
                socket, socket_s, int(socket_side) if socket else 1, socket_offset, gauge,
                metal, float(p.get("metal_base", 5.)), led, **rack)
    if gauge:
        _gauge().validate_dual(spec)
    if metal or led:
        _power().validate(spec)
    t = np.linspace(0, total, 2001)
    if np.abs(spec.dz(t)).max() > max_grade + 1e-9:
        raise ValueError(f"vertical profile grade exceeds {max_grade * 100:g} % between the ports")
    curvature = np.abs(spec.d2z(t)) / (1 + spec.dz(t) ** 2) ** 1.5
    if spec.vcurve and curvature.max() * spec.vcurve > 1 + 1e-9:
        raise ValueError(f"vertical curve radius {1 / curvature.max():.0f} mm is below vcurve")
    if marker and len(_ties(spec)) < 3:
        raise ValueError("a colour marker needs at least one full tie (64 mm)")
    if socket and len(_ties(spec)) < 3:
        raise ValueError("a column lug needs at least one full tie (64 mm)")
    return spec


def _ties(spec: Spec) -> list[tuple[float, float]]:
    return end_.tie_intervals(spec.length, equal_pitch=spec.rigid)


class Plan:
    """Ideal plan-view centreline: straights, arcs and clothoids from (0, 0, heading 0)."""

    _NODES, _WEIGHTS = np.polynomial.legendre.leggauss(12)

    def __init__(self, segments):
        self.segments = segments
        self.starts = []
        x = y = heading = station = 0.
        for length, k0, k1 in segments:
            self.starts.append((station, x, y, heading))
            x, y, heading = self._advance(x, y, heading, length, k0, k1, length)
            station += length
        self.length = station
        self.final = (x, y, heading)
        self._stations = np.linspace(0, station, max(2, int(math.ceil(station)) + 1))
        self._points = np.array([self.state(s)[:2] for s in self._stations])

    @classmethod
    def _advance(cls, x, y, heading, length, k0, k1, t):
        if k0 == k1:
            if k0 == 0:
                return x + t * math.cos(heading), y + t * math.sin(heading), heading
            return (x + (math.sin(heading + k0 * t) - math.sin(heading)) / k0,
                    y - (math.cos(heading + k0 * t) - math.cos(heading)) / k0, heading + k0 * t)
        rate = (k1 - k0) / length
        pieces = max(1, int(math.ceil(t / 4)))
        dx = dy = 0.
        for index in range(pieces):
            low, high = t * index / pieces, t * (index + 1) / pieces
            u = (high - low) / 2 * cls._NODES + (high + low) / 2
            angle = heading + k0 * u + rate * u * u / 2
            dx += (high - low) / 2 * float(np.dot(cls._WEIGHTS, np.cos(angle)))
            dy += (high - low) / 2 * float(np.dot(cls._WEIGHTS, np.sin(angle)))
        return x + dx, y + dy, heading + k0 * t + rate * t * t / 2

    def _segment(self, s):
        index = 0
        while index + 1 < len(self.starts) and s >= self.starts[index + 1][0]:
            index += 1
        return index

    def state(self, s: float) -> tuple[float, float, float, float]:
        """(x, y, heading, curvature); linear tangent extension beyond both ports."""
        if s <= 0:
            return s, 0., 0., (0. if s < 0 else self.segments[0][1])
        if s >= self.length:
            x, y, heading = self.final
            over = s - self.length
            curvature = 0. if over > 0 else self.segments[-1][2]
            return x + over * math.cos(heading), y + over * math.sin(heading), heading, curvature
        index = self._segment(s)
        start, x, y, heading = self.starts[index]
        length, k0, k1 = self.segments[index]
        t = s - start
        x, y, heading = self._advance(x, y, heading, length, k0, k1, t)
        return x, y, heading, k0 + (k1 - k0) * t / length

    def project(self, point) -> tuple[float, float]:
        """(station, left lateral offset) of a plan point."""
        point = np.asarray(point[:2], dtype=float)
        s = float(self._stations[np.argmin(np.linalg.norm(self._points - point, axis=1))])
        # Beyond the ports the extension is straight.
        for _ in range(30):
            x, y, heading, curvature = self.state(s)
            tangent = np.array([math.cos(heading), math.sin(heading)])
            normal = np.array([-tangent[1], tangent[0]])
            offset = point - (x, y)
            step = float(offset @ tangent) / max(1 - curvature * float(offset @ normal), 1e-6)
            s += step
            if abs(step) < 1e-12:
                break
        x, y, heading, _ = self.state(s)
        return s, float((point - (x, y)) @ np.array([-math.sin(heading), math.cos(heading)]))


class Piece:
    """One stretch of the actual centre path, parameter u in [0, 1]."""

    def point(self, u):
        raise NotImplementedError

    def tangent(self, u):
        raise NotImplementedError


class Line(Piece):
    def __init__(self, a, b):
        self.a, self.b = np.asarray(a, float), np.asarray(b, float)
        self.kind = "line"

    def point(self, u):
        return self.a + u * (self.b - self.a)

    def tangent(self, u):
        return self.b - self.a

    def edge(self):
        return cq.Edge.makeLine(cq.Vector(*self.a), cq.Vector(*self.b))


class Bezier(Piece):
    def __init__(self, points, straight: bool):
        self.points = np.asarray(points, float)
        self.kind = "line" if straight else "bezier"

    def point(self, u):
        return end_._split(self.points, u)[0][-1]

    def tangent(self, u):
        return 3 * end_._split(np.diff(self.points, axis=0), u)[0][-1]

    def edge(self):
        if self.kind == "line":
            return cq.Edge.makeLine(cq.Vector(*self.points[0]), cq.Vector(*self.points[-1]))
        return end_._bezier(self.points)


class Ideal(Piece):
    """The ideal path between two stations inside one segment."""

    def __init__(self, route, low, high, kind):
        self.route, self.low, self.high, self.kind = route, low, high, kind

    def station(self, u):
        return self.low + u * (self.high - self.low)

    def point(self, u):
        return self.route.ideal(self.station(u))

    def tangent(self, u):
        return self.route.ideal_tangent(self.station(u))

    def edge(self):
        low, high = self.point(0), self.point(1)
        if self.kind == "line":
            return cq.Edge.makeLine(cq.Vector(*low), cq.Vector(*high))
        if self.kind == "arc":
            return cq.Edge.makeThreePointArc(cq.Vector(*low), cq.Vector(*self.point(.5)), cq.Vector(*high))
        count = max(4, int(math.ceil((self.high - self.low) / 2)) + 1)
        while True:
            u = np.linspace(0, 1, count)
            edge = cq.Edge.makeSpline([cq.Vector(*self.point(v)) for v in u],
                                      tangents=[cq.Vector(*self.tangent(0)), cq.Vector(*self.tangent(1))],
                                      scale=True)
            # Interpolation error, measured by projection on the ideal path.
            deviation = 0.
            for v in np.linspace(0, 1, 4 * count):
                position = edge.positionAt(float(v))
                _, lateral = self.route.plan.project((position.x, position.y))
                deviation = max(deviation, abs(lateral))
            if deviation < 2e-3 or count > 4096:
                return edge
            count *= 2


class Route:
    """Ports, actual centre path (rigid ends + blends + ideal path) and frames."""

    def __init__(self, spec: Spec):
        self.spec = spec
        plan = self.plan = Plan(spec.segments)
        length = spec.length
        x, y, heading = plan.final
        self.start = end_._frame((0, 0, 0), 0, spec.grade0)
        self.end = end_._frame((x, y, spec.rise), heading, spec.grade1)
        self.connectors = (bool(spec.ends & 1), bool(spec.ends & 2))
        self.base = spec.base
        blend = min(4 * DEPTH, (length - .8) / 2)
        pieces = []
        low, high = 0., length
        if self.connectors[0]:
            a = self.start[:3, 3] + DEPTH * self.start[:3, 0]
            pieces.append(self._blend(a, 0., blend, forward=True))
            low = blend
        else:
            a = self.ideal(0)
        if self.connectors[1]:
            b = self.end[:3, 3] - DEPTH * self.end[:3, 0]
            high = length - blend
        else:
            b = self.ideal(length)
        if np.dot(b - a, self.start[:3, 0]) <= 0 or np.dot(b - a, self.end[:3, 0]) <= 0:
            raise ValueError("rigid connector ends leave no forward centre web")
        cuts = sorted({low, high, *(start for start, *_ in plan.starts if low < start < high)})
        for left, right in zip(cuts, cuts[1:]):
            if right - left > 1e-9:
                pieces.append(Ideal(self, left, right, self._kind(left, right)))
        if self.connectors[1]:
            pieces.append(self._blend(b, length, length - blend, forward=False))
        self.a, self.b, self.pieces = a, b, pieces
        rigid = []
        if self.connectors[0]:
            rigid.append(Line(self.start[:3, 3], a))
        full = rigid + pieces
        if self.connectors[1]:
            full.append(Line(b, self.end[:3, 3]))
        self.full = full
        self._ranges = [(self.coordinate(piece.point(0)), self.coordinate(piece.point(1))) for piece in full]
        for piece in pieces:
            if isinstance(piece, Bezier):
                self._check_blend(piece)

    def ideal(self, s: float) -> np.ndarray:
        x, y, _, _ = self.plan.state(s)
        return np.array([x, y, self.spec.height(s)])

    def ideal_tangent(self, s: float) -> np.ndarray:
        _, _, heading, _ = self.plan.state(s)
        return np.array([math.cos(heading), math.sin(heading), self.spec.slope(s)])

    def _kind(self, low, high):
        index = self.plan._segment((low + high) / 2)
        _, k0, k1 = self.spec.segments[index]
        if not self.spec.level:
            return "sampled"
        return "line" if k0 == k1 == 0 else "arc" if k0 == k1 else "clothoid"

    def _single_curvature(self, low, high):
        """Curvature if [low, high] lies in one constant-curvature level segment."""
        index = self.plan._segment(min(max(low, 0), self.spec.length - 1e-9))
        start = self.plan.starts[index][0]
        length, k0, k1 = self.spec.segments[index]
        inside = start - 1e-9 <= min(low, high) and max(low, high) <= start + length + 1e-9
        return k0 if inside and k0 == k1 and self.spec.level else None

    def _blend(self, rigid, port_station, station, forward):
        """brick_end's cubic blend from the rigid contact end to the ideal path."""
        target, tangent = self.ideal(station), self.ideal_tangent(station)
        port_tangent = self.ideal_tangent(port_station)
        span = abs(station - port_station) - DEPTH
        curvature = self._single_curvature(port_station, station)
        if curvature is None:
            handle = np.linalg.norm(target - rigid) / 3
        elif curvature == 0:
            handle = span / 3
        else:
            radius = 1 / abs(curvature)
            handle = 4 * radius / 3 * math.tan(span / radius / 4)
        straight = curvature == 0 and self.spec.level
        if forward:
            points = [rigid, rigid + handle * port_tangent, target - handle * tangent, target]
        else:
            points = [target, target + handle * tangent, rigid - handle * port_tangent, rigid]
        return Bezier(points, straight)

    def _check_blend(self, piece):
        worst = 0.
        for u in np.linspace(0, 1, 41):
            point = piece.point(u)
            station, lateral = self.plan.project(point)
            worst = max(worst, abs(lateral), abs(point[2] - self.spec.height(station)))
        if worst > .5:
            raise ValueError("path bends too sharply next to a brick track connector end")

    def coordinate(self, point) -> float:
        return self.plan.project(point)[0]

    def locate(self, station: float):
        """(point, tangent) on the actual path at an ideal station (projection)."""
        for piece, (low, high) in zip(self.full, self._ranges):
            if low - 1e-8 <= station <= high + 1e-8:
                if isinstance(piece, Ideal):
                    u = (station - piece.low) / (piece.high - piece.low)
                    return piece.point(u), piece.tangent(u)
                lo, hi = 0., 1.
                for _ in range(40):
                    middle = (lo + hi) / 2
                    if self.coordinate(piece.point(middle)) < station:
                        lo = middle
                    else:
                        hi = middle
                u = (lo + hi) / 2
                return piece.point(u), piece.tangent(u)
        # Plain ends: straight extension past the port.
        return self.ideal(station), self.ideal_tangent(station)

    def frame(self, station: float) -> np.ndarray:
        """Tie frame on the actual path (brick_end._tie_frame)."""
        point, tangent = self.locate(station)
        return end_._frame(point, math.atan2(tangent[1], tangent[0]),
                           tangent[2] / math.hypot(tangent[0], tangent[1]))

    def bed_frame(self, station: float) -> np.ndarray:
        """Level frame on the flat underside below the tie."""
        point, tangent = self.locate(station)
        return end_._frame((point[0], point[1], self.base), math.atan2(tangent[1], tangent[0]), 0)

    def stations(self, low: float, high: float, extra=()) -> list[float]:
        """Ring stations covering [low, high] of the ideal station range."""
        marks = {low, high, *(mark for mark in extra if low < mark < high)}
        for piece, (a, b) in zip(self.full, self._ranges):
            for mark in (a, b):
                if low < mark < high:
                    marks.add(mark)
        marks = sorted(marks)
        out = []
        for left, right in zip(marks, marks[1:]):
            count = max(1, int(math.ceil((right - left) / MESH_STEP)))
            out.extend(left + (right - left) * k / count for k in range(count))
        out.append(high)
        return out

    def wire(self):
        """OCC centre wire (level pieces), collinear lines merged as in brick_end."""
        edges = []
        run = None
        for piece in self.pieces:
            if piece.kind == "line":
                a, b = piece.point(0), piece.point(1)
                if run is not None and np.linalg.norm(np.cross(run[1] - run[0], b - a)) < 1e-9 * max(
                        1, np.linalg.norm(b - a) * np.linalg.norm(run[1] - run[0])):
                    run = (run[0], b)
                    continue
                if run is not None:
                    edges.append(Line(*run).edge())
                run = (a, b)
                continue
            if run is not None:
                edges.append(Line(*run).edge())
                run = None
            edges.append(piece.edge())
        if run is not None:
            edges.append(Line(*run).edge())
        return cq.Wire.assembleEdges(edges)


def _to_trimesh(manifold: manifold3d.Manifold) -> trimesh.Trimesh:
    mesh = manifold.to_mesh()
    return trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=True)


def side_prism(profile, y0: float, y1: float) -> trimesh.Trimesh:
    """A side profile [(x, z), ...] (counter-clockwise) extruded across the lateral band y0..y1."""
    section = manifold3d.CrossSection([np.asarray(profile, dtype=float)])
    return _to_trimesh(section.extrude(y1 - y0).rotate((90, 0, 0)).translate((0, y1, 0)))


def _tube(frames, sections) -> trimesh.Trimesh:
    """Closed ring mesh: section polygon (y, z) placed in each 4x4 frame."""
    sections = [np.asarray(section, float) for section in sections]
    first = sections[0]
    area = np.sum(first[:, 0] * np.roll(first[:, 1], -1) - np.roll(first[:, 0], -1) * first[:, 1])
    if area < 0:
        sections = [section[::-1] for section in sections]
    count, rings = len(sections[0]), len(frames)
    vertices = np.vstack([
        (frame[:3, :3] @ np.column_stack([np.zeros(count), section]).T).T + frame[:3, 3]
        for frame, section in zip(frames, sections)])
    faces = []
    for ring in range(rings - 1):
        a, b = ring * count, (ring + 1) * count
        for j in range(count):
            k = (j + 1) % count
            faces += [(a + j, b + k, a + k), (a + j, b + j, b + k)]
    cap = np.asarray(manifold3d.triangulate([sections[0]]), dtype=np.int64)
    last = np.asarray(manifold3d.triangulate([sections[-1]]), dtype=np.int64)
    faces = np.vstack([np.asarray(faces), cap, last[:, ::-1] + (rings - 1) * count])
    mesh = trimesh.Trimesh(vertices, faces, process=True)
    if not mesh.is_winding_consistent:
        faces[len(faces) - len(cap) - len(last):] = faces[len(faces) - len(cap) - len(last):, ::-1]
        mesh = trimesh.Trimesh(vertices, faces, process=True)
    if mesh.volume < 0:
        mesh.invert()
    if not mesh.is_watertight:
        raise ValueError("composite ring mesh is not closed")
    return mesh


def _union(meshes):
    meshes = [mesh for mesh in meshes if len(mesh.faces)]
    if len(meshes) == 1:
        return meshes[0]
    return trimesh.boolean.union(meshes, engine="manifold")


def _rise(phi: float):
    """Deck lift (y) of a canted section: rolled plane from the inner rail outward."""
    if not phi:
        return lambda y: 0.
    inner, slope = math.copysign(RAIL, phi), math.tan(phi)
    return lambda y: max(0., (inner - y) * slope)


def _body_section(phi: float, bottom: float = 0.):
    """brick_end's exterior contour; cant lifts the outer rail and rolls the deck.
    ``bottom`` lowers the underside (the wedge's solid base)."""
    rise = _rise(phi)
    section = [(-WIDTH / 2, bottom), (WIDTH / 2, bottom), (WIDTH / 2, BASE + rise(WIDTH / 2))]
    for lateral in (RAIL, -RAIL):
        for y, z in reversed(PROFILE["railSection"]):
            section.append((y + lateral, BASE + rise(y + lateral) if z == BASE else z + rise(lateral)))
    section.append((-WIDTH / 2, BASE + rise(-WIDTH / 2)))
    return section


def _bands():
    return [(-WIDTH / 2 - 1, -RAIL - STRINGER), (-RAIL + STRINGER, RAIL - STRINGER),
            (RAIL + STRINGER, WIDTH / 2 + 1)]


def _roll(phi: float, column: float) -> np.ndarray:
    """Tie-local roll of a stud column standing on the canted deck."""
    if not phi or (math.copysign(RAIL, phi) - column) * phi <= 0:
        return np.eye(4)
    inner = math.copysign(RAIL, phi)
    c, s = math.cos(-phi), math.sin(-phi)
    rotation = np.array([[1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]])
    shift = np.eye(4)
    shift[1:3, 3] = (inner, BASE)
    back = np.eye(4)
    back[1:3, 3] = (-inner, -BASE)
    return shift @ rotation @ back


class Builder:
    def __init__(self, spec: Spec):
        self.spec = spec
        self.route = Route(spec)
        self.length = spec.length
        self.ties = _ties(spec)
        start = self.route.start
        self.plane = cq.Plane(origin=cq.Vector(*self.route.a), xDir=cq.Vector(*start[:3, 1]),
                              normal=cq.Vector(*start[:3, 0]))
        self._wire = None

    # ------------------------------------------------------------------ sweeps
    @property
    def wire(self):
        if self._wire is None:
            self._wire = self.route.wire()
        return self._wire

    def _occ(self, section):
        return end_._mesh(cq.Workplane(self.plane).polyline(section).close().sweep(
            cq.Workplane().newObject([self.wire]), isFrenet=False).val())

    def _pitch_weight(self, station: float) -> float:
        """1 at a connector's rigid contact face (its pitched plane), 0 from 2 mm on."""
        weight = 0.
        if self.route.connectors[0]:
            weight = max(weight, 1 - (station - DEPTH) / 2)
        if self.route.connectors[1]:
            weight = max(weight, 1 - (self.length - DEPTH - station) / 2)
        return min(max(weight, 0.), 1.)

    def floating(self, station: float) -> float:
        """0 under a connector's end half tie (it floats with its contacts), 1 where
        the solid base reaches the flat underside; a 0.05 mm step at the tie wall."""
        ramp = .05
        if self.route.connectors[0] and station < END_TIE:
            return min(max((station - END_TIE + ramp) / ramp, 0.), 1.)
        if self.route.connectors[1] and station > self.length - END_TIE:
            return min(max((self.length - END_TIE + ramp - station) / ramp, 0.), 1.)
        return 1.

    def rings(self, section_of, low, high, *, body=False, bed=False):
        """Wedge ring sweep: vertical sections normal to the plan path.

        section_of(station, lift) gives the (y, z) section, z relative to the ring
        origin; lift is the actual path's height above the flat underside. Rings sit
        on the path (datum) or, with ``bed``, on the underside. The running body
        (``body``) starts on each connector's pitched rigid contact face and turns
        vertical over 2 mm."""
        route, frames, sections = self.route, [], []
        extra = (DEPTH + 2, END_TIE - .05, END_TIE, self.length - END_TIE, self.length - END_TIE + .05,
                 self.length - DEPTH - 2) if body else ()
        for station in route.stations(low, high, extra):
            if body and route.connectors[0] and station <= DEPTH + 1e-9:
                point, tangent = route.a, route.start[:3, 0]
            elif body and route.connectors[1] and station >= self.length - DEPTH - 1e-9:
                point, tangent = route.b, route.end[:3, 0]
            else:
                point, tangent = route.locate(station)
            grade = tangent[2] / math.hypot(tangent[0], tangent[1])
            weight = self._pitch_weight(station) if body else 0.
            origin = (point[0], point[1], route.base if bed else point[2])
            frames.append(end_._frame(origin, math.atan2(tangent[1], tangent[0]), grade * weight))
            sections.append(section_of(station, point[2] - route.base))
        return _tube(frames, sections)

    def _span(self):
        """Running-body station range: between the rigid contacts, or port to port."""
        return (DEPTH if self.route.connectors[0] else 0.,
                self.length - DEPTH if self.route.connectors[1] else self.length)

    # ------------------------------------------------------------------ masks
    def mask(self, low, high, low_z, high_z):
        """Volume between the ideal path's normal planes at two stations."""
        count = max(2, int(math.ceil((high - low) / 2)) + 1)
        stations = np.linspace(low, high, count)
        left, right = [], []
        for station in stations:
            x, y, heading, _ = self.route.plan.state(station)
            normal = np.array([-math.sin(heading), math.cos(heading)])
            left.append(np.array([x, y]) + REACH * normal)
            right.append(np.array([x, y]) - REACH * normal)
        polygon = np.array(right + left[::-1])
        area = np.sum(polygon[:, 0] * np.roll(polygon[:, 1], -1) - np.roll(polygon[:, 0], -1) * polygon[:, 1])
        if area < 0:
            polygon = polygon[::-1]
        prism = manifold3d.CrossSection([polygon]).extrude(high_z - low_z).translate((0, 0, low_z))
        return _to_trimesh(prism)

    def interior(self, low_z, high_z):
        """Volume between the two end-tie inner walls (brick_end._interior_mask)."""
        if not self.spec.rigid:
            return self.mask(END_TIE, self.length - END_TIE, low_z, high_z)
        reach = 2 * self.length + WIDTH
        halves = []
        for frame in (self.route.start, self.route.end @ np.diag([-1, -1, 1, 1])):
            half = end_._box((END_TIE, -reach, low_z), (reach, reach, high_z))
            half.apply_transform(frame)
            halves.append(half)
        return trimesh.boolean.intersection(halves, engine="manifold")

    # ------------------------------------------------------------------ body
    def centre(self):
        spec = self.spec
        if spec.level:
            return self._occ(_body_section(0.))
        return self.rings(lambda s, lift: _body_section(spec.cant(s), -lift * self.floating(s)),
                          *self._span(), body=True)

    def voids(self):
        """Tie-gap void per lateral band, through the base (and the wedge to its underside)."""
        voids = []
        for low, high in _bands():
            if self.spec.level:
                section = [(low, -1), (high, -1), (high, BASE + .1), (low, BASE + .1)]
                voids.append(self._occ(section))
                continue

            def section(s, lift, low=low, high=high):
                rise = _rise(self.spec.cant(s))
                return [(low, -lift - 1), (high, -lift - 1), (high, BASE + rise(high) + .1),
                        (low, BASE + rise(low) + .1)]
            voids.append(self.rings(section, *self._span()))
        return voids

    def open_gaps(self, centre):
        """brick_end._open_tie_gaps (full detail) or lite._open_between_braces."""
        spec = self.spec
        voids = self.voids()
        low_z, high_z = centre.bounds[0, 2] - 1, centre.bounds[1, 2] + 1
        if spec.lite:
            braces = [(station - lite_.BRACE_WIDTH / 2, station + lite_.BRACE_WIDTH / 2)
                      for station in self.tie_centres()]
            if spec.rigid:
                openings = trimesh.boolean.intersection(
                    [_union(voids), self.interior(low_z, high_z)], engine="manifold")
                slabs = []
                for low, high in braces:
                    span = lite_.RAIL_BAND[0] + lite_.BRACE_OVERLAP
                    slab = end_._box((-(high - low) / 2, -span, 0), ((high - low) / 2, span, BASE))
                    slab.apply_transform(self.route.frame((low + high) / 2))
                    slabs.append(slab)
                opened = trimesh.boolean.difference([centre, openings], engine="manifold")
                return trimesh.boolean.union([opened, *slabs], engine="manifold")
            marker = self.marker_tie()
            openings = []
            for index, band in enumerate(voids):
                kept = [self.ties[0], *(braces if index == 1 else []), self.ties[-1]]
                if index == 1 and marker is not None:
                    kept.append(marker)
                kept = sorted(kept)
                masks = [self.mask(left[1], right[0], low_z, high_z)
                         for left, right in zip(kept, kept[1:]) if right[0] - left[1] > 1e-6]
                openings.append(trimesh.boolean.intersection([band, _union(masks)], engine="manifold"))
            return trimesh.boolean.difference([centre, *openings], engine="manifold")
        void = _union(voids)
        if spec.rigid:
            masks = [self.interior(low_z, high_z)]
        else:
            masks = [self.mask(left[1], right[0], low_z, high_z)
                     for left, right in zip(self.ties, self.ties[1:])]
        openings = trimesh.boolean.intersection([void, _union(masks)], engine="manifold")
        opened = trimesh.boolean.difference([centre, openings], engine="manifold")
        if not spec.rigid:
            return opened
        slabs = []
        for low, high in self.ties[1:-1]:
            slab = end_._box((-PROFILE["tieWidth"] / 2, -WIDTH / 2, 0), (PROFILE["tieWidth"] / 2, WIDTH / 2, BASE))
            slab.apply_transform(self.route.frame((low + high) / 2))
            slabs.append(slab)
        return trimesh.boolean.union([opened, *slabs], engine="manifold")

    def tie_centres(self):
        return [(low + high) / 2 for low, high in self.ties[1:-1]]

    def marker_tie(self):
        if not self.spec.marker:
            return None
        full = self.ties[1:-1]
        return min(full, key=lambda tie: (abs((tie[0] + tie[1]) / 2 - self.spec.marker_s), tie[0]))

    # ------------------------------------------------------------------ options
    def options(self):
        spec, meshes = self.spec, []
        if spec.ballast:
            meshes.append(self.ballast())
        if spec.guard:
            meshes.append(self.guard())
        if spec.street:
            meshes.append(self.street())
        if spec.socket:
            meshes.append(self.lug())
        if spec.rack:
            meshes.extend(_rack().rack_meshes(self))
        return meshes

    def lug(self):
        """Helix column lug on the full tie nearest socket_s: an arm from inside the rail line out to a ring
        round the column bore, on the underside plane."""
        spec, full = self.spec, self.ties[1:-1]
        low, high = min(full, key=lambda tie: (abs((tie[0] + tie[1]) / 2 - spec.socket_s), tie[0]))
        side, offset, half = spec.socket_side, spec.socket_offset, (high - low) / 2 - .3
        y0, y1 = sorted((side * (RAIL - 1), side * offset))
        arm = manifold3d.Manifold.cube((2 * half, y1 - y0, LUG_THICKNESS)).translate((-half, y0, 0))
        ring = manifold3d.Manifold.cylinder(LUG_THICKNESS, LUG_RING / 2, LUG_RING / 2, 96).translate((0, side * offset, 0))
        bore = manifold3d.Manifold.cylinder(LUG_THICKNESS + 2, LUG_BORE / 2, LUG_BORE / 2, 96).translate((0, side * offset, -1))
        lug = _to_trimesh((arm + ring) - bore)
        lug.apply_transform(self.route.bed_frame((low + high) / 2))
        return lug

    def _inner(self):
        return (END_TIE, self.length - END_TIE)

    def ballast(self):
        shoulders = []
        for side in (1, -1):
            def section(s, lift, side=side):
                edge = lift + BASE + _rise(self.spec.cant(s))(side * WIDTH / 2)
                inner, groove, toe = BALLAST
                points = [(WIDTH / 2 - .3, 0), (inner, 0), (inner, BALLAST_ROOF), (groove, BALLAST_ROOF),
                          (groove, 0), (toe, 0), (toe, edge - 1.4), (groove, edge - .2), (WIDTH / 2 - .3, edge)]
                return [(side * y, z) for y, z in points]
            shoulders.append(self.rings(section, 0., self.length, bed=True))
        return _union(shoulders)

    def guard(self):
        ridges = []
        for side in (1, -1):
            low, high = sorted((side * GUARD[0], side * GUARD[1]))

            def section(s, lift, low=low, high=high):
                # Fast print has no baseplate clutch: the ridge stands on the underside.
                floor = -lift if self.spec.lite else GUARD_FLOOR
                rise = _rise(self.spec.cant(s))
                return [(low, floor), (high, floor), (high, end_.RAIL_TOP + rise(high)),
                        (low, end_.RAIL_TOP + rise(low))]
            ridges.append(self.rings(section, *self._inner()))
        return _union(ridges)

    def street(self):
        top, groove = end_.RAIL_TOP, FLANGE_FLOOR
        # The groove's outer wall is the rail's own gauge face: end the road inside the rail.
        inner, outer = FLANGEWAY[0], FLANGEWAY[1] + .1

        def section(s, lift):
            floor = -lift if self.spec.lite else STREET_FLOOR
            rise = _rise(self.spec.cant(s))
            return [(-WIDTH / 2, floor), (WIDTH / 2, floor), (WIDTH / 2, top + rise(WIDTH / 2)),
                    (outer, top + rise(outer)), (outer, groove + rise(outer)),
                    (inner, groove + rise(inner)), (inner, top + rise(inner)),
                    (-inner, top + rise(-inner)), (-inner, groove + rise(-inner)),
                    (-outer, groove + rise(-outer)), (-outer, top + rise(-outer)),
                    (-WIDTH / 2, top + rise(-WIDTH / 2))]
        return self.rings(section, *self._inner())

    # ------------------------------------------------------------------ attachments
    def attachments(self, mesh):
        """brick_end._brick_attachments (lite: the two end half ties only)."""
        spec = self.spec
        cutters, additions, webs = [], [], []
        marker = self.marker_tie()
        for index, (low, high) in enumerate(self.ties):
            half = index in (0, len(self.ties) - 1)
            if spec.lite and not half:
                continue
            station = (low + high) / 2
            connector = half and self.route.connectors[0 if index == 0 else 1]
            if half:
                port = self.route.start if index == 0 else self.route.end @ np.diag([-1, -1, 1, 1])
                top = port
                if connector or spec.level:
                    under = port
                else:
                    heading = math.atan2(port[1, 0], port[0, 0])
                    under = end_._frame((port[0, 3], port[1, 3], self.route.base), heading, 0)
                pocket = (ATTACH["halfTieCavityStart"], ATTACH["halfTieCavityEnd"])
                # The end half tie's frame is reversed: its local roll is opposite.
                phi = spec.cant(0) if index == 0 else -spec.cant(self.length)
            else:
                top = self.route.frame(station)
                under = top if spec.level else self.route.bed_frame(station)
                webs.append(under)
                pocket = (-ATTACH["cavityHalfLength"], ATTACH["cavityHalfLength"])
                phi = spec.cant(station)
            if not spec.rigid:
                self._check_tie(under, low, high, pocket, half)
            columns = self.tie_columns((low, high), half)
            seat_low = .1 if half else -PROFILE["tieWidth"] / 2
            seat_high = END_TIE if half else PROFILE["tieWidth"] / 2
            trim_low = PROFILE["endLength"] + .05 if half else seat_low
            if under is top:
                trim = end_._box((trim_low, -WIDTH / 2, -end_.RAIL_TOP), (seat_high, WIDTH / 2, 0))
                trim.apply_transform(under)
                cutters.append(trim)
            for column in columns:
                frame = top @ _roll(phi, column)
                for land in end_.stud_lands([column], half=half):
                    land.apply_transform(frame)
                    cutters.append(land)
            clutch_cuts, local_additions = end_.tie_clutch(half=half)
            for shape in clutch_cuts:
                shape.apply_transform(under)
                cutters.append(shape)
            for shape in local_additions:
                if shape.bounds[0, 2] > 2:
                    column = float(np.mean(shape.bounds[:, 1]))
                    if not any(math.isclose(column, c, abs_tol=.01) for c in columns):
                        continue
                    shape.apply_transform(top @ _roll(phi, column))
                else:
                    shape.apply_transform(under)
                additions.append(shape)
            if (low, high) == marker:
                additions.append(self._marker_rim(top))
        if not spec.lite:
            low_z, high_z = mesh.bounds[0, 2] - 1, mesh.bounds[1, 2] + 1
            cutters.append(self.channel(webs, low_z, high_z))
        elif marker is not None:
            additions.append(self._marker_rim(self.route.frame((marker[0] + marker[1]) / 2)))
        opened = trimesh.boolean.difference([mesh, *cutters], engine="manifold")
        return trimesh.boolean.union([opened, *additions], engine="manifold")

    def _marker_rim(self, frame):
        outer, inner = MARKER_RIM / 2, MARKER_POCKET / 2
        z0, z1 = BASE - .05, BASE + MARKER_HEIGHT
        rim = trimesh.boolean.difference([end_._box((-outer, -outer, z0), (outer, outer, z1)),
                                          end_._box((-inner, -inner, BASE), (inner, inner, z1 + 1))],
                                         engine="manifold")
        rim.apply_transform(frame)
        return rim

    def tie_columns(self, tie, half):
        """Tie-top stud columns a tie keeps under the options (families extend this)."""
        spec, columns = self.spec, list(ATTACH["studLateralOffsets"])
        if spec.rack:
            # The rack bar covers the centre studs, end half ties included.
            columns = [c for c in columns if abs(c) != 4]
        if half:
            return columns
        if spec.street:
            return []
        if spec.guard:
            columns = [c for c in columns if abs(c) != 12]
        if tie == self.marker_tie():
            columns = [c for c in columns if abs(c) != 4]
        return columns

    def _check_tie(self, frame, low, high, pocket, half):
        bays = ATTACH["cavityLateralIntervals"]
        for x in pocket:
            if half and x <= PROFILE["endLength"] + .05:
                continue
            for y in (bays[0][0], bays[-1][1]):
                point = frame @ np.array([x, y, 0, 1])
                station, lateral = self.route.plan.project(point)
                if not low < station < high or abs(lateral) >= WIDTH / 2:
                    raise ValueError("rigid brick cavity would break through a curved tie wall")

    def channel(self, webs, low_z, high_z):
        """brick_end._rail_channel: level sweep, or on the flat underside."""
        sections = {}
        for lateral, width, z0, z1 in end_.rail_channel_bands():
            sections.setdefault(lateral, []).append((width, z0, z1))
        cutters = []
        for lateral, ((lower, bottom, ledge), (upper, _, ceiling)) in sections.items():
            # A metal rail's foot stands on the stringer: it stays solid above the lower band.
            section = [(lateral - lower, bottom), (lateral + lower, bottom), (lateral + lower, ledge), (lateral - lower, ledge)] \
                if self.spec.metal == 1 else \
                [(lateral - lower, bottom), (lateral + lower, bottom), (lateral + lower, ledge),
                 (lateral + upper, ledge), (lateral + upper, ceiling),
                 (lateral - upper, ceiling), (lateral - upper, ledge), (lateral - lower, ledge)]
            if self.spec.level:
                cutters.append(self._occ(section))
            else:
                cutters.append(self.rings(lambda s, lift, section=section: section, *self._span(), bed=True))
        channel = trimesh.boolean.intersection([_union(cutters), self.interior(low_z, high_z)],
                                               engine="manifold")
        placed = []
        for frame in webs:
            web = end_.channel_web()
            web.apply_transform(frame)
            placed.append(web)
        return trimesh.boolean.difference([channel, *placed], engine="manifold") if placed else channel

    # ------------------------------------------------------------------ assembly
    def mesh(self) -> trimesh.Trimesh:
        spec, route = self.spec, self.route
        centre = self.open_gaps(self.centre())
        parts = [centre]
        ends = []
        if route.connectors[0]:
            first = end_._production_end(spec.adjustment)
            first.apply_transform(route.start)
            ends.append(first)
        if route.connectors[1]:
            last = end_._production_end(spec.adjustment, opposite=True)
            last.apply_transform(route.end @ np.diag([-1, -1, 1, 1]))
            ends.append(last)
        if len(ends) == 2:
            collision = trimesh.boolean.intersection(ends, engine="manifold")
            if len(collision.faces) and collision.volume > .001:
                raise ValueError("rigid connector ends overlap")
        mesh = trimesh.boolean.union([*ends, *parts, *self.options()], engine="manifold")
        mesh = self.attachments(mesh)
        return _power().apply(self, mesh) if spec.metal or spec.led else mesh


def _gauge():
    """Narrow and dual gauge (gauge.py), imported on use: it loads a narrow copy of this module."""
    from . import gauge
    return gauge


def _power():
    """9V metal rails and the LED channel (track_power.py), imported on use: it imports this module."""
    from . import track_power
    return track_power


def _rack():
    """Rack railway teeth (rack.py), imported on use: it imports this module."""
    from . import rack
    return rack


def track_mesh(p: dict, builder=Builder) -> trimesh.Trimesh:
    if p.get("gauge") == 1:
        return _gauge().narrow_track_mesh(p)
    spec = validate(p)
    if spec.gauge and builder is Builder:
        builder = _gauge().DualBuilder
    mesh = builder(spec).mesh()
    mesh.apply_translation((0, 0, spec.z0))
    return mesh


# Seam retriangulation tolerances (mm), all well below the 0.02 mm export tolerance.
# brick_end.track's 0.00001 comes first. Ring-swept wedges and booleans can leave
# sliver triangles that OCC's 0.001 mm sewing collapses into an invalid solid, or
# that its STL export drops; those are merged at the next coarser step.
SEAM_TOLERANCES = (1e-5, 1e-4, 3e-4, 1e-3, 3e-3)


def _exports_closed(shape: cq.Shape) -> bool:
    """The STL generate.py writes (0.02 mm, 0.1 rad) is closed and consistently wound."""
    with tempfile.TemporaryDirectory(prefix="composite-check-") as directory:
        path = Path(directory) / "shape.stl"
        cq.exporters.export(shape, str(path), exportType="STL", tolerance=.02, angularTolerance=.1)
        mesh = trimesh.load_mesh(path, file_type="stl", process=True)
        return mesh.is_watertight and mesh.is_winding_consistent


def _unmerged_solid(mesh: trimesh.Trimesh) -> cq.Shape:
    """brick_end._solid without its coplanar-face merge: some graded curve wedges sew into
    a valid solid that the merge then invalidates; they keep their triangle faces."""
    if not mesh.is_watertight or len(mesh.split(only_watertight=False)) != 1:
        raise ValueError("composite track geometry must remain one watertight solid")
    with tempfile.TemporaryDirectory(prefix="composite-solid-") as directory:
        path = Path(directory) / "shape.stl"
        mesh.export(path)
        imported = TopoDS_Shape()
        if not StlAPI_Reader().Read(imported, str(path)):
            raise ValueError("cannot read composite track mesh")
        sewing = BRepBuilderAPI_Sewing(0.001)
        sewing.Add(imported)
        sewing.Perform()
        shells = cq.Shape(sewing.SewedShape()).Shells()
        if len(shells) != 1:
            raise ValueError("composite track geometry must retain one exterior shell")
        shape = cq.Shape(BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(shells[0].wrapped)).Solid())
        if not shape.isValid() or len(shape.Solids()) != 1 or shape.Volume() <= 0:
            raise ValueError("composite track geometry must retain one valid CAD solid")
        return shape


def build(p: dict, builder=Builder) -> cq.Shape:
    """One closed solid; ``builder`` is Builder or a family's subclass adding its own options."""
    if p.get("gauge") == 1:
        return _gauge().narrow_build(p)
    mesh = track_mesh(p, builder)
    if not mesh.is_watertight or mesh.body_count != 1:
        raise ValueError("composite track geometry must remain one watertight solid")
    joined = manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))
    for solid in (end_._solid, _unmerged_solid):
        for tolerance in SEAM_TOLERANCES:
            joined_mesh = joined.simplify(tolerance).to_mesh()
            try:
                shape = solid(trimesh.Trimesh(joined_mesh.vert_properties[:, :3], joined_mesh.tri_verts, process=True))
            except (ValueError, Standard_Failure):
                continue
            if _exports_closed(shape):
                return shape
    raise ValueError("composite track does not export as one closed solid")


def ports(p: dict) -> list[dict]:
    """Start and end ports in generate._ports' format."""
    if p.get("gauge") == 1:
        return _gauge().narrow_ports(p)
    spec = validate(p)
    x, y, heading = Plan(spec.segments).final
    rows = []
    for name, position, yaw, grade in (("start", (0., 0., spec.z0), 0., spec.grade0),
                                       ("end", (x, y, spec.z0 + spec.rise), heading, spec.grade1)):
        norm = math.hypot(1, grade)
        rows.append({"id": name, "position": list(position),
                     "tangent": [math.cos(yaw) / norm, math.sin(yaw) / norm, grade / norm],
                     "heading": yaw, "pitch": math.atan(grade),
                     "rail_gauge": p["rail_gauge"], "rail_interface_width": p["rail_interface_width"]})
    return rows


def connector_ends(p: dict) -> list[dict]:
    """Brick connector port faces for support painting: position, inward heading,
    underside plane (z at the port and inward slope) and whether it floats above
    the flat underside."""
    if p.get("gauge") == 1:
        return _gauge().narrow_connector_ends(p)
    spec = validate(p)
    route_ports = ports(p)
    base = spec.z0 + spec.base
    rows = []
    for index, port in enumerate(route_ports):
        if not spec.ends & (1 << index):
            continue
        grade = spec.grade0 if index == 0 else -spec.grade1
        heading = port["heading"] + (math.pi if index else 0)
        z = port["position"][2]
        lift = z - base + END_TIE * max(0., grade)
        rows.append({"index": index, "x": port["position"][0], "y": port["position"][1], "heading": heading,
                     "z": z, "slope": grade, "elevated": lift > ELEVATION_TOLERANCE})
    return rows


def validate_insert(p: dict) -> None:
    if set(p) != {"marker"}:
        raise ValueError("marker_insert requires exactly ['marker']")
    value = p["marker"]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value) or not 1 <= value <= MAX_MARKER:
        raise ValueError(f"marker must be an integer from 1 to {MAX_MARKER}")


def marker_insert(p: dict) -> cq.Shape:
    """The coloured pad pressed into a marker tie's recess (0.2 mm clearance)."""
    validate_insert(p)
    return cq.Solid.makeBox(MARKER_INSERT, MARKER_INSERT, MARKER_HEIGHT,
                            cq.Vector(-MARKER_INSERT / 2, -MARKER_INSERT / 2, 0))
