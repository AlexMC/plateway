"""Parametric point-blade junctions (turnouts, wyes, three-ways, crossovers, slips); millimetres.

A junction is described by a spec: ports, route centrelines in the piece frame, and
switches. A switch is two routes sharing a port that part from each other; its moving
part ("points") is derived from the two routes' rails, so any radius, curve or wye works.

Points: two flexure blades joined by a tie bar, one printed part standing on its flat
underside. Each blade is the parting route's rail from the tip (where the stock rail has
moved 1.2 mm away) to its heel block; the heel blocks sit in sockets on a 1.4 mm floor
and are held down by two screwed keepers. The blades bend between the tie bar and the
heel blocks as guided cantilevers, so the points rest where they were printed.
Manual points print in position 0 and a removable spacer in the open blade's gap holds
either position; sprung points print in the default position and spring back to it,
so a train can trail through them from the other route (it pushes the blades over).

Everything else follows track_assembly's conventions: rigid source contacts at every
port, rails on hollow stringers, rigid ties with dropped conflicting clutch groups,
flangeway gaps wherever rails cross, and base tiles split through tie gaps with keyed
dovetails where a seam crosses a rail. Fast print keeps every mechanism, seam and key
and swaps ties, clutch and channels for solid stringers and gauge braces.
Blade fatigue, spring force and wheel acceptance are physical trial gates.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from functools import lru_cache
import math
from pathlib import Path

import cadquery as cq
import manifold3d
import numpy as np
import trimesh

from . import crossing_any as ca
from . import hardware as hw
from . import brick_end as end
from . import lite as fast
from . import track_assembly as ta
from . import turnout_servo as servo

# ------------------------------------------------------------------ constants
RAIL = end.PROFILE["railGauge"] / 2                    # 20: rail centre line
HEAD = end.PROFILE["railInterfaceWidth"] / 2           # 1.2: half rail head
FACE = RAIL - HEAD                                     # 18.8: guiding face
FLANGE = ta.FLANGE_CLEARANCE                           # 2.2 flange corridor
HALF = end.PROFILE["bodyWidth"] / 2                    # 31.9
BASE = end.PROFILE["baseThickness"]                    # 3.2
TOP = end.RAIL_TOP                                     # 9.6
END_TIE = end.PROFILE["endTieWidth"]                   # 7.9
CLEAR = .4            # moving-to-fixed clearance, every direction in plan
FACE_INSET = .02      # authored guiding faces sit this far behind the probe corridor (no coincident faces)
FLOOR = 1.4           # floor under the points
MOVE_LOW = 1.7        # underside of the points (0.3 mm above the floor)
BAR_TOP = 2.9         # tie bar and heel block top (keeper underside is 3.2)
KEEPER = (3.2, 5.2)   # keeper plate, below every flange corridor (6.4)
BLADE = 1.6           # blade width behind its guiding face
TIP = .8              # thinnest printed blade tip
THROW = 2.4           # tie-bar travel between the two positions
HEEL = 10.            # heel block length (rigid, held by the keeper)
FLEX = 48.            # default flexing length, tie bar to heel block
TIE_BAR = 4.          # tie bar width along the route
MIN_TIP = 16.         # blade tip distance from the shared port (end tie + contact)
POST = 3.2            # keeper screw post radius; pilot 1.3, clearance 1.65
KEEPER_REACH = 9.     # keeper overhang beyond each end of the heel block
ENVELOPE_REACH = 32.  # envelope length past (first 1 mm parting + flex)
SPACER_TOP = 5.4
FRAGMENT = 1500.      # mm^3: smaller seam offcuts rejoin a neighbouring tile
EMPTY_SHELL = 1e-3   # mm^3: a tile shell below this is a boolean artefact (coincident faces), not material
SEAM_REACH = .15     # mm: extra kerf past a seam end where the deck edge bridges it (<= .15 stays inside a crossed kerf)
KERF_OVERLAP = .05   # mm: a keyless fragment's kerf patch reaches this far into both tiles it joins
SLIVER = 1.          # mm^3: a keyless offcut this small that no patch rejoins is dropped (as turnout_servo.drop_slivers)
PLAN_BED = 158.       # base tiles plan to this; dovetail keys add 4 mm
PLAN_BRANCHES, PLAN_BUDGET, SOLID_BUDGET = 3, 80, 240   # seam search: chords tried per tile, cuts tried in all
                                                        # (on the outline, then on the solid deck)
PLAN_STEP, PLAN_TURN = 1., math.pi/12   # fallback chords: spacing of parallel chords (mm) and direction step
MIN_STUB = 8.     # mm: a plan whose seams cross a bare rail (no tie, plate or floor under it) closer than this
MIN_STICK = 24.   # is replanned on the solid deck, where seams cross any rail at least this far apart
DECK_CLOSE, DECK_MARGIN = 9., 3.   # mm: the solid deck to plan on is closed across tie gaps (16.2 mm), then
                                   # grown past the stringer plugs (2.5 mm wider than a stringer)
BED = 166.
TIE_MARGIN = 2.  # stringer plugs fill only the stringer (never a clutch bay); keep them off tie edges
FROG_CLEAR = 6.
PLATE_GROW = 40.   # crossing plate reach past the overlap of two crossing decks
END_ZONE = (-5., 14.)
MIN_SEAM_ANGLE = math.radians(30)
SAMPLE = 1.
SOURCE_DEPENDENCIES = [Path(ta.__file__), Path(fast.__file__), Path(end.__file__), Path(ca.__file__),
                       Path(servo.__file__), Path(servo.drives.__file__)]


# ------------------------------------------------------------------ spec
@dataclass(frozen=True)
class Port:
    id: str
    x: float
    y: float
    heading: float          # outward


@dataclass(frozen=True)
class Route:
    id: str
    start: str
    end: str
    points: tuple           # ((x, y, heading), ...) piece frame, start to end


@dataclass(frozen=True)
class Switch:
    a: str                  # position 0 route
    b: str                  # position 1 route
    port: str               # the shared port (the routes' start or end)
    flex: float = FLEX


@dataclass(frozen=True)
class State:
    id: str
    positions: tuple        # one 0/1 per switch


@dataclass(frozen=True)
class Spec:
    ports: tuple
    routes: tuple
    switches: tuple
    states: tuple
    seams: tuple | None = None   # ((x0, y0), (x1, y1)) segments; None = planned
    servo: int = 0               # SG90 drive on every switch, on this side of the piece: 1 left, -1 right (turnout_servo)


def route_path(spec: Spec, route_id: str) -> np.ndarray:
    return _dense(np.asarray(next(r for r in spec.routes if r.id == route_id).points, float))


def enabled_routes(spec: Spec, state: int) -> set[str]:
    """Routes every switch they belong to is set for."""
    positions = spec.states[state].positions
    return {route.id for route in spec.routes
            if all(route.id not in (sw.a, sw.b) or route.id == (sw.a, sw.b)[positions[i]]
                   for i, sw in enumerate(spec.switches))}


def spec_route_pairs(spec: Spec, state: int) -> dict[frozenset, bool]:
    enabled = enabled_routes(spec, state)
    return {frozenset((route.start, route.end)): route.id in enabled for route in spec.routes}


def port_rows(spec: Spec) -> list[dict]:
    return [{"id": port.id, "position": [port.x, port.y, 0.], "heading": port.heading, "pitch": 0.,
             "rail_gauge": 2*RAIL, "rail_interface_width": 2*HEAD} for port in spec.ports]


# ------------------------------------------------------------------ path helpers
def arc(points: list, radius: float, sweep: float, step: float = 1.5) -> None:
    """Append a circular arc (sweep > 0 turns left), sampled every ~`step` mm."""
    x, y, h = points[-1]
    sign, count = math.copysign(1, sweep), max(1, math.ceil(abs(sweep)*radius/step))
    for i in range(1, count+1):
        heading = h + sweep*i/count
        points.append((x + sign*radius*(math.sin(heading) - math.sin(h)),
                       y + sign*radius*(math.cos(h) - math.cos(heading)), heading))


def line(points: list, length: float) -> None:
    x, y, h = points[-1]
    points.append((x + length*math.cos(h), y + length*math.sin(h), h))


def _dense(path: np.ndarray, step: float = SAMPLE) -> np.ndarray:
    lengths = np.r_[0., np.cumsum(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1))]
    stations = np.unique(np.r_[np.arange(0., lengths[-1], step), lengths[-1]])
    return np.column_stack([np.interp(stations, lengths, path[:, axis]) for axis in range(3)])


def _stations(path):
    return np.r_[0., np.cumsum(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1))]


def _at(path, s):
    lengths = _stations(path)
    s = np.atleast_1d(s)
    return np.column_stack([np.interp(s, lengths, path[:, axis]) for axis in range(3)])


def _normal(heading):
    heading = np.asarray(heading)
    return np.column_stack((-np.sin(heading), np.cos(heading)))


def _offset(path, lateral):
    return path[:, :2] + _normal(path[:, 2])*lateral


def _reverse(path):
    out = path[::-1].copy()
    out[:, 2] += math.pi
    return out


def _normal_hit(point, normal, polyline):
    """Signed distance t along `normal` from `point` to the nearest crossing of `polyline` (None if none)."""
    p, r = polyline[:-1], polyline[1:] - polyline[:-1]
    cross = r[:, 0]*normal[1] - r[:, 1]*normal[0]
    qp = point - p
    with np.errstate(divide="ignore", invalid="ignore"):
        u = (qp[:, 0]*normal[1] - qp[:, 1]*normal[0]) / cross
        t = (qp[:, 0]*r[:, 1] - qp[:, 1]*r[:, 0]) / cross
    ok = (np.abs(cross) > 1e-12) & (u >= -1e-9) & (u <= 1+1e-9)
    if not ok.any():
        return None
    candidates = t[ok]
    return float(candidates[np.argmin(np.abs(candidates))])


def _near(points, polyline, tol):
    """Mask of `points` within `tol` of `polyline`."""
    a, d = polyline[:-1], polyline[1:] - polyline[:-1]
    length2 = np.maximum(np.einsum("ij,ij->i", d, d), 1e-12)
    mask = np.zeros(len(points), bool)
    for start in range(0, len(points), 256):
        q = points[start:start+256, None, :]
        t = np.clip(np.einsum("pij,ij->pi", q - a, d)/length2, 0, 1)
        distance = np.linalg.norm(q - (a + t[..., None]*d), axis=2).min(axis=1)
        mask[start:start+256] = distance < tol
    return mask


def _runs(mask, stations):
    """(start, end) station of every True run."""
    edges = np.flatnonzero(np.diff(np.r_[0, mask.astype(int), 0]))
    return [(stations[i], stations[j-1]) for i, j in zip(edges[::2], edges[1::2])]


def _section(points):
    return manifold3d.CrossSection([np.asarray(points, dtype=float).tolist()], manifold3d.FillRule.EvenOdd)


def _union_cs(sections):
    out = manifold3d.CrossSection()
    for section in sections:
        out += section
    return out


def _parts(section):
    return [part for part in section.decompose() if not part.is_empty() and part.area() > 1e-6]


def _vertices(section):
    return np.vstack([np.asarray(polygon) for polygon in section.to_polygons() if len(polygon)])


def _prism(section, low, high):
    if section.is_empty():
        return trimesh.Trimesh()
    # Manifold's own mesh is already closed; trimesh's vertex merge would weld near-coincident corners.
    mesh = section.simplify(1e-3).extrude(high-low).translate((0, 0, low)).to_mesh()
    return trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=False)


def _inward_frame(port):
    return end._frame((port.x, port.y, 0), port.heading + math.pi, 0)


# ------------------------------------------------------------------ switch geometry
@dataclass(frozen=True)
class Blade:
    route: str
    reversed: bool
    side: int               # +1 left of the route as authored in the spec, -1 right
    tip: float              # stations along the oriented route (from the shared port)
    root: float
    heel: float
    path: np.ndarray        # oriented route
    stock: np.ndarray       # stock rail line (xy) of the other route
    lateral: int            # side in the oriented frame


def _oriented(spec, route_id, port):
    """The route from `port`, resampled every SAMPLE mm from that port (TS switchEnvelope does the same)."""
    route = next(r for r in spec.routes if r.id == route_id)
    raw = np.asarray(route.points, float)
    if route.start == port:
        return _dense(raw), False
    if route.end == port:
        return _dense(_reverse(raw)), True
    raise ValueError(f"switch port {port} is not an end of route {route_id}")


class Points:
    """One switch's derived blades, tie bar, heel blocks, keepers and throw."""

    def __init__(self, spec: Spec, index: int):
        sw = spec.switches[index]
        self.index, self.switch = index, sw
        a, ra = _oriented(spec, sw.a, sw.port)
        b, rb = _oriented(spec, sw.b, sw.port)
        n = min(len(a), len(b))
        offsets = np.einsum("ij,ij->i", b[:n, :2] - a[:n, :2], _normal(a[:n, 2]))
        parted = np.flatnonzero(np.abs(offsets) > 3.)
        if not len(parted):
            raise ValueError(f"switch {index+1}: routes {sw.a} and {sw.b} never part")
        sigma = int(np.sign(offsets[parted[0]]))
        self.sigma = sigma
        tip_a, width_a = self._widths(a, _offset(b, sigma*RAIL), sigma)
        tip_b, width_b = self._widths(b, _offset(a, -sigma*RAIL), -sigma)
        tip = max(tip_a, tip_b)
        if tip < MIN_TIP:
            raise ValueError(f"switch {index+1}: routes part within {MIN_TIP} mm of port {sw.port}")
        self.bar = tip + .5 + TIE_BAR/2
        root = self.bar + sw.flex
        heel = root + HEEL
        if heel > min(_stations(a)[-1], _stations(b)[-1]) - 20:
            raise ValueError(f"switch {index+1}: routes are too short for their points")
        self.blades = (
            Blade(sw.a, ra, sigma*(-1 if ra else 1), tip_a, root, heel, a, _offset(b, sigma*RAIL), sigma),
            Blade(sw.b, rb, -sigma*(-1 if rb else 1), tip_b, root, heel, b, _offset(a, -sigma*RAIL), -sigma))
        self.widths = (width_a, width_b)
        # One rigid throw direction: from position 0 towards position 1.
        bar = _at(a, self.bar)[0]
        self.direction = -sigma*_normal(bar[2])[0]
        self._check_throw()
        self.outer = [False, False]
        self._choose_keeper_sides(spec)
        self.rod = servo.rod_line(spec, self) if spec.servo else None

    def _choose_keeper_sides(self, spec):
        """Heel blocks and keepers sit inside the gauge unless another route's rail or the partner
        blade's keeper is there (wyes: the two blades converge), then outside the blade."""
        own = [_offset(blade.path, side*RAIL) for blade in self.blades for side in (-1, 1)]
        feet = manifold3d.CrossSection()
        for route in spec.routes:
            if route.id in (self.switch.a, self.switch.b):
                continue
            path = route_path(spec, route.id)
            for side in (-1, 1):
                line = _offset(path, side*RAIL)
                shared = np.zeros(len(line), bool)
                for ref in own:
                    shared |= _near(line, ref, .5)
                for s0, s1 in _runs(~shared, _stations(path)):
                    if s1 - s0 > 1:
                        feet += ta._band(_side_path(path, side, s0, s1), 3.3)
        others = [(blade.path, -blade.lateral) for blade in self.blades]   # the partner routes' far rails
        feet += _union_cs([ta._band(np.column_stack([_offset(path, side*RAIL), path[:, 2]]), 3.3)
                           for (path, side) in others])
        taken = manifold3d.CrossSection()
        for blade in (0, 1):
            for outer in (False, True):
                self.outer[blade] = outer
                zone = _section(self.keeper_layout(blade)[0]) + _section(self.heel_outline(blade))
                if not ta._overlaps(zone, feet) and not ta._overlaps(zone, taken):
                    break
            else:
                raise ValueError(f"switch {self.index+1}: no room for the heel keeper of blade {blade+1}")
            taken += zone

    @staticmethod
    def _widths(path, stock, lateral):
        """Blade tip station and room behind the guiding face: stock guiding face - CLEAR - FACE."""
        lengths = _stations(path)
        rows = []
        for s, (x, y, h) in zip(lengths, path):
            normal = _normal(h)[0]*lateral
            t = _normal_hit(np.array([x, y]), normal, stock)
            rows.append((s, min((t if t is not None else 99.) - HEAD - CLEAR - FACE, 50.)))
        rows = np.asarray(rows)
        wide = np.flatnonzero(rows[:, 1] >= TIP - 1e-9)
        if not len(wide):
            raise ValueError("the stock rail never parts from the blade line")
        return float(rows[wide[0], 0]), rows

    def room(self, blade, s):
        rows = self.widths[blade]
        return np.interp(s, rows[:, 0], rows[:, 1])

    def width(self, blade, s):
        return np.minimum(self.room(blade, s), BLADE)

    def stock_face(self, blade, s):
        """The stock rail's guiding face, measured outward from the blade route's centre line."""
        return self.room(blade, s) + CLEAR + FACE

    def shape(self, s):
        """Guided-cantilever deflection factor: 1 at the tie bar, 0 at the heel block."""
        u = np.clip((self.blades[0].root - np.asarray(s)) / (self.blades[0].root - self.bar), 0, 1)
        return 3*u**2 - 2*u**3

    def _check_throw(self):
        """The open blade must clear the other route's flange corridor at every station."""
        for blade, other in ((0, 1), (1, 0)):
            b = self.blades[blade]
            s = np.arange(b.tip, b.root, .5)
            need = FACE + self.width(blade, s) - self.stock_face(blade, s) + FLANGE + .1
            have = THROW*self.shape(s)
            if np.any(have + 1e-6 < need):
                worst = s[np.argmax(need - have)]
                raise ValueError(f"switch {self.index+1}: blade throw too small at station {worst:.1f}; "
                                 "lengthen the flex or part the routes faster")

    # -- plan shapes
    def blade_outline(self, blade, position):
        b = self.blades[blade]
        s = np.unique(np.r_[np.arange(b.tip, b.heel, .5), b.heel])
        pts = _at(b.path, s)
        normal = _normal(pts[:, 2])*b.lateral
        width = self.width(blade, s)
        inner = pts[:, :2] + normal*(FACE + FACE_INSET)
        outer = pts[:, :2] + normal*(FACE + width[:, None])
        shift = self._shift(blade, s, position)
        return np.vstack([inner + shift, (outer + shift)[::-1]])

    def _shift(self, blade, s, position):
        # Blade a is closed in position 0, blade b in position 1.
        amount = THROW*(position - (0 if blade == 0 else 1))*self.shape(s)
        return np.outer(amount, self.direction)

    def heel_outline(self, blade):
        b = self.blades[blade]
        s = np.linspace(b.root, b.heel, 11)
        pts = _at(b.path, s)
        normal = _normal(pts[:, 2])*b.lateral
        low, high = (FACE, FACE + BLADE + 8.) if self.outer[blade] else (FACE - 8., FACE + self.width(blade, s)[:, None])
        return np.vstack([pts[:, :2] + normal*low, (pts[:, :2] + normal*high)[::-1]])

    def bar_outline(self, position):
        rows = []
        for blade in (0, 1):
            b = self.blades[blade]
            s = np.array([self.bar - TIE_BAR/2, self.bar + TIE_BAR/2])
            pts = _at(b.path, s)
            face = pts[:, :2] + _normal(pts[:, 2])*b.lateral*(FACE + .4)
            rows.append(face + self._shift(blade, s, position))
        return np.vstack([rows[0], rows[1][::-1]])

    def knob(self, position):
        centre = self.bar_outline(position).mean(axis=0)
        return centre

    def keeper_layout(self, blade):
        """(outline, screw points) of the keeper over a heel block."""
        b = self.blades[blade]
        s = np.linspace(b.root - KEEPER_REACH, b.heel + KEEPER_REACH, 15)
        pts = _at(b.path, s)
        normal = _normal(pts[:, 2])*b.lateral
        # Laterals from the standard guiding face (18.8): a narrow-gauge profile (gauge.py) shifts them with its face.
        low, high, screw = (x + (FACE - 18.8) for x in ((23.5, 29.8, 26.6) if self.outer[blade] else (9.6, 16.5, 13.)))
        outline = np.vstack([pts[:, :2] + normal*low, (pts[:, :2] + normal*high)[::-1]])
        # Screws stand beyond both ends of the heel block, clear of its socket and the blade's travel.
        screws = _at(b.path, np.array([b.root - KEEPER_REACH + 4, b.heel + KEEPER_REACH - 4]))
        screws = screws[:, :2] + _normal(screws[:, 2])*b.lateral*screw
        return outline, screws

    def spacer_outline(self, position):
        """The open blade's gap at the tie bar, less 0.15 mm each side."""
        blade = 1 if position == 0 else 0
        b = self.blades[blade]
        s = np.linspace(b.tip + 1.5, b.tip + 8.5, 8)
        pts = _at(b.path, s)
        normal = _normal(pts[:, 2])*b.lateral
        stock_face = self.stock_face(blade, s)
        open_outer = FACE + self.width(blade, s) - THROW*self.shape(s)
        inner = pts[:, :2] + normal*(open_outer + .15)[:, None]
        outer = pts[:, :2] + normal*(np.minimum(stock_face, stock_face.min()) - .15)[:, None]
        return np.vstack([inner, outer[::-1]])

    def swept(self):
        """Plan area swept by the points through their travel, plus the heel blocks."""
        sections = [_section(self.heel_outline(0)), _section(self.heel_outline(1))]
        for position in np.linspace(0, 1, 9):
            sections += [_section(self.blade_outline(0, position)), _section(self.blade_outline(1, position)),
                         _section(self.bar_outline(position)),
                         manifold3d.CrossSection.circle(2., 32).translate(tuple(self.knob(position)))]
        return _union_cs(sections)

    def envelope(self):
        """Conservative convex operating envelope (same rule as the TS switchEnvelope)."""
        a, b = (blade.path for blade in self.blades)
        n = min(len(a), len(b))
        gap = np.linalg.norm(a[:n, :2] - b[:n, :2], axis=1)
        parted = _stations(a)[np.flatnonzero(gap >= 1.)[0]]
        reach = parted + self.switch.flex + ENVELOPE_REACH
        points = []
        for path in (a, b):
            keep = path[_stations(path) <= reach]
            points += [keep[:, :2] + _normal(keep[:, 2])*HALF, keep[:, :2] - _normal(keep[:, 2])*HALF]
        return _hull(np.vstack(points))


def _hull(points):
    hull = manifold3d.CrossSection.hull_points(np.asarray(points, float).tolist())
    return _vertices(hull)


@lru_cache(maxsize=32)
def points_of(spec: Spec) -> tuple:
    return tuple(Points(spec, index) for index in range(len(spec.switches)))


def envelopes(spec: Spec) -> list[np.ndarray]:
    return [points.envelope() for points in points_of(spec)] + \
        ([servo.envelope(spec, index) for index in range(len(spec.switches))] if spec.servo else [])


# ------------------------------------------------------------------ moving meshes
def points_mesh(points: Points, position: float) -> trimesh.Trimesh:
    blades = [_prism(_section(points.blade_outline(i, position)), MOVE_LOW, TOP) for i in (0, 1)]
    heels = [_section(points.heel_outline(0)), _section(points.heel_outline(1))]
    if points.rod is not None:
        # Servo: the tie bar rides above the throw rod, which passes under the blade on its side.
        mesh = ta._union([*blades, _prism(_union_cs(heels), MOVE_LOW, BAR_TOP), servo.bar_mesh(points, position)])
        return ta._difference(mesh, [servo.notch(points, position)])
    low = _union_cs([_section(points.bar_outline(position)), *heels])
    knob = end._cylinder(2., BAR_TOP - .1, KEEPER[1] - .2, *points.knob(position))
    return ta._union([*blades, _prism(low, MOVE_LOW, BAR_TOP), knob])


def keeper_mesh(points: Points, blade: int) -> trimesh.Trimesh:
    outline, screws = points.keeper_layout(blade)
    plate = _prism(_section(outline), *KEEPER)
    return ta._difference(plate, [end._cylinder(1.65, KEEPER[0]-.1, KEEPER[1]+.1, *xy) for xy in screws])


def spacer_mesh(points: Points, position: int) -> trimesh.Trimesh:
    return _prism(_section(points.spacer_outline(position)), MOVE_LOW, SPACER_TOP)


def _positions(spec: Spec, state: int):
    return spec.states[state].positions


# ------------------------------------------------------------------ fixed layout
class Layout:
    """Everything the fixed base needs, derived once per spec."""

    def __init__(self, spec: Spec):
        self.spec = spec
        self.paths = [route_path(spec, route.id) for route in spec.routes]
        self.index = {route.id: i for i, route in enumerate(spec.routes)}
        self.points = points_of(spec)
        self.ports = spec.ports
        starts = {route.start for route in spec.routes}
        self.far = {port.id: port.id not in starts for port in spec.ports}
        # Fixed rail spans (route, lateral, s0, s1) outside every blade.
        cuts = {}
        for pts in self.points:
            for blade in pts.blades:
                length = _stations(route_path(spec, blade.route))[-1]
                s0, s1 = blade.tip - 1., blade.heel + CLEAR
                if blade.reversed:
                    s0, s1 = length - s1, length - s0
                cuts.setdefault((self.index[blade.route], blade.side), []).append((s0, s1))
        # Other routes running on a blade's rail line lose that stretch too (three-ways, ladders).
        blade_lines = []
        for pts in self.points:
            for blade in pts.blades:
                part = ta._station_path(blade.path, blade.tip - 1., blade.heel + CLEAR)
                blade_lines.append((self.index[blade.route], blade.side, _offset(part, blade.lateral*RAIL)))
        for route, path in enumerate(self.paths):
            stations = _stations(path)
            for side in (-1, 1):
                line = _offset(path, side*RAIL)
                for owner, owner_side, ref in blade_lines:
                    if (owner, owner_side) == (route, side):
                        continue
                    for s0, s1 in _runs(_near(line, ref, .3), stations):
                        cuts.setdefault((route, side), []).append((max(0., s0 - 1.), min(stations[-1], s1 + 1.)))
        self.rails = []
        for route, path in enumerate(self.paths):
            length = _stations(path)[-1]
            for side in (-1, 1):
                start = 0.
                for s0, s1 in _merge(cuts.get((route, side), [])):
                    if s0 - start > .5:
                        self.rails.append((route, side, start, s0))
                    start = max(start, s1)
                if length - start > .5:
                    self.rails.append((route, side, start, length))
        self.swept = _union_cs([pts.swept() for pts in self.points])
        heads = _union_cs([ta._band(_side_path(self.paths[route], side, s0, s1), HEAD)
                           for route, side, s0, s1 in self.rails])
        self.slot = self.swept.offset(CLEAR, manifold3d.JoinType.Round) - heads
        self.floor = self.slot.offset(2.5, manifold3d.JoinType.Round)
        self.keepers = [(pts, blade, *pts.keeper_layout(blade)) for pts in self.points for blade in (0, 1)]
        self.mechanism = _union_cs([self.floor, *[_section(outline) for *_, outline, _ in self.keepers],
                                    *[manifold3d.CrossSection.circle(POST, 32).translate(tuple(xy))
                                      for *_, screws in self.keepers for xy in screws]])
        self._check_mechanism()
        # Where routes that share no port cross, their decks merge into one solid studless plate. It runs
        # PLATE_GROW past the overlap along both decks, so a seam can pass beside the acute frogs inside it.
        bands = [ta._band(path, HALF) for path in self.paths]
        ends = [{route.start, route.end} for route in spec.routes]
        self.plate = _union_cs([(bands[i] ^ bands[j]).offset(PLATE_GROW, manifold3d.JoinType.Round) ^ (bands[i] + bands[j])
                                for i in range(len(bands)) for j in range(i+1, len(bands))
                                if not ends[i] & ends[j] and ta._overlaps(bands[i], bands[j])]) - self.floor.offset(1., manifold3d.JoinType.Round)
        self.ties = self._bearers()
        if spec.servo:
            self.servo_mounts = servo.build_mounts(self)
            self.mechanism = self.mechanism + servo.mechanism_zones(self.servo_mounts)
        self.lines = self._rail_lines()
        self.crossings = self._crossings()
        self.solid_stringers = self._diverging_stringers()
        # Check rails opposite every guiding-face gap over 4 mm (crossing_any's rule), except inside the
        # points, where the closed blade guides the wheel.
        self.rows = [(route.id, route.start, route.end, path) for route, path in zip(spec.routes, self.paths)]
        keep_out = self.mechanism.offset(3., manifold3d.JoinType.Round)
        self.checks = [check for check in _check_rails(self.rows)
                       if not ta._overlaps(self._check_zone(check), keep_out)]
        self.footprint = _union_cs([ta._band(path, HALF) for path in self.paths] + [self.floor])
        self.region = self.footprint     # the outline the seams split into bed-sized tiles (_plan may plan on the solid deck)
        self.seams = [tuple(map(np.asarray, seam)) for seam in spec.seams] if spec.seams is not None else self._plan()
        self.sites = self._sites()

    def _bearers(self):
        """(route, station, frame, low, high): rigid ties, lateral extent in the tie frame.

        Where decks overlap, the earlier route's ties become long bearers square to it that
        carry the later routes too (so seams cross the whole throat in one tie gap); a later
        route's own ties start only once they clear every earlier deck."""
        bands = [ta._band(path, HALF) for path in self.paths]
        ties = []
        for route, path in enumerate(self.paths):
            for low, high in end.tie_intervals(_stations(path)[-1])[1:-1]:
                station = (low + high)/2
                frame = ta._path_frame(path, station)
                rect = ta._rect(frame, -7.9, 7.9, -HALF, HALF)
                if ta._overlaps(rect, self.plate) or \
                        any(ta._overlaps(rect, ta._rect(f, -7.9, 7.9, l, h)) for _, _, f, l, h in ties):
                    continue
                lo, hi = -HALF, HALF
                centre, normal = frame[:2, 3], frame[:2, 1]
                for other in range(route + 1, len(self.paths)):
                    if not ta._overlaps(rect, bands[other]):
                        continue
                    t = _normal_hit(centre, normal, self.paths[other][:, :2])
                    if t is None or abs(t) > 2*HALF - 8:
                        continue       # decks barely touch: each keeps its own ties
                    k = int(np.argmin(np.linalg.norm(self.paths[other][:, :2] - (centre + normal*t), axis=1)))
                    phi = abs(math.atan2(math.sin(self.paths[other][k, 2] - math.atan2(frame[1, 0], frame[0, 0])),
                                         math.cos(self.paths[other][k, 2] - math.atan2(frame[1, 0], frame[0, 0]))))
                    reach = HALF/math.cos(phi) + 7.9*math.tan(phi)
                    if not ta._overlaps(ta._rect(frame, -7.9, 7.9, min(lo, t - reach), max(hi, t + reach)), self.plate):
                        lo, hi = min(lo, t - reach), max(hi, t + reach)
                ties.append((route, station, frame, lo, hi))
        return ties

    def _diverging_stringers(self):
        """Where two routes' stringers overlap without coinciding (a route leaving another outside
        any points floor), the hollow channels would leave a tapering, cantilevered ceiling between
        them: those stretches print solid."""
        zones = []
        lines = [(route, side, path, _offset(path, side*RAIL)) for route, path in enumerate(self.paths) for side in (-1, 1)]
        for i, (ra, sa, pa, la) in enumerate(lines):
            stations = _stations(pa)
            for rb, sb, pb, lb in lines:
                if rb == ra:
                    continue
                partial = _near(la, lb, 2*end.PROFILE["baseStringerWidth"]/2 + .5) & ~_near(la, lb, .02)
                for s0, s1 in _runs(partial, stations):
                    zones.append(ta._band(_side_path(pa, sa, max(0., s0 - 2), min(stations[-1], s1 + 2)), 4.5))
        return _union_cs(zones)

    def _check_mechanism(self):
        """Keepers clear every fixed rail and its foot; screw posts clear the points slot."""
        feet = _union_cs([ta._band(_side_path(self.paths[route], side, s0, s1), 3.3)
                          for route, side, s0, s1 in self.rails])
        for pts, blade, outline, screws in self.keepers:
            posts = _union_cs([manifold3d.CrossSection.circle(POST, 32).translate(tuple(xy)) for xy in screws])
            if ta._overlaps(_section(outline) + posts, feet) or ta._overlaps(posts, self.slot):
                raise ValueError(f"switch {pts.index+1}: its heel keeper would sit on a rail; lengthen the flex")

    def _rail_lines(self):
        return [(_offset(path, side*RAIL), path[:, 2]) for route, path in enumerate(self.paths) for side in (-1, 1)]

    def _crossings(self):
        points = []
        lines = [(_side_line(self.paths[route], side, s0, s1), route) for route, side, s0, s1 in self.rails]
        for i, (a, ra) in enumerate(lines):
            for b, rb in lines[i+1:]:
                if ra == rb:
                    continue
                for point in _polyline_crossings(a, b):
                    points.append(point)
        return points

    # -- seam planning (tiles within the bed; cuts in tie gaps only)
    def _forbidden(self):
        # Seams keep 0.6 mm off every tie; where they cross a rail, the stringer plug needs TIE_MARGIN.
        zones = [ta._rect(frame, -8.5, 8.5, lo-1, hi+1) for _, _, frame, lo, hi in self.ties]
        self.plug_zone = _union_cs([ta._rect(frame, -7.9-TIE_MARGIN, 7.9+TIE_MARGIN, lo-1, hi+1)
                                    for _, _, frame, lo, hi in self.ties])
        zones += [ta._rect(_inward_frame(port), *END_ZONE, -HALF-1, HALF+1) for port in self.ports]
        zones += [manifold3d.CrossSection.circle(FROG_CLEAR, 32).translate(tuple(point)) for point in self.crossings]
        zones.append(self.mechanism.offset(3., manifold3d.JoinType.Round))
        zones += [self._check_zone(check) for check in self.checks]
        return _union_cs(zones)

    def _check_zone(self, check):
        points = _at(self.paths[check["route"]], np.linspace(check["s0"] - 2, check["s1"] + 2, 40))
        normal = _normal(points[:, 2])*check["rail"]
        return _section(np.vstack([points[:, :2] + normal*(ca.BACK - ca.CHECK_WIDTH - 3), (points[:, :2] + normal*(RAIL + 4))[::-1]]))

    def _crossings_of(self, a, b):
        hits = []
        for line, headings in self.lines:
            for point, index in _segment_hits(a, b, line):
                hits.append((point, float(headings[index])))
        return hits

    def _segments(self, component, point, direction):
        reach = 4000.
        a, b = point - direction*reach, point + direction*reach
        segments = []
        for piece in _parts(component ^ ta._section(ta._segment_quad(a, b, .1))):
            along = (_vertices(piece) - point) @ direction
            lo, hi = along.min() + .1, along.max() - .1
            if hi - lo > 1:
                segments.append((point + direction*lo, point + direction*hi))
        return segments

    def _valid(self, segments, forbidden):
        for a, b in segments:
            if (ta._section(ta._segment_quad(a, b, .4)) ^ forbidden).area() > 1e-6:
                return False
            heading = math.atan2(*(b - a)[::-1])
            hits = self._crossings_of(a, b)
            if any(abs(math.sin(heading - h)) < math.sin(MIN_SEAM_ANGLE) for _, h in hits):
                return False
            outside = [point for point, _ in hits if not self._in_plate(point)]
            if not outside and not self._plate_sites(a, b):
                return False
            if any(ta._overlaps(manifold3d.CrossSection.circle(.5, 12).translate(tuple(point)), self.plug_zone)
                   for point in outside):
                return False
        return True

    def _plan(self):
        """Recursive bisection: each cut is one straight chord across a tile, square to some route
        at one of its tie gaps; the chord that leaves the most area on bed-sized tiles wins. When a
        tile left by earlier cuts cannot be split, the latest cuts are revisited with their next-best
        chords (depth first, PLAN_BRANCHES per tile, PLAN_BUDGET cuts in all), and once a tile's
        square chords are exhausted, chords in any direction through the crossing plate (the only way
        between the tracks of a diamond or slip). The greedy plan is kept whenever it works.

        Tiles are the deck's outline, which joins tracks through bare deck that prints as nothing.
        Where a plan leaves a rail stub shorter than MIN_STUB with no tie, plate or floor under it
        (a scissors' lanes run bare beside a tight diamond), the junction is replanned on the solid
        deck itself: there a bare rail is its own stick tile, keyed at both ends, and no two seams
        cross one rail closer than MIN_STICK (nor meet in a wedge on it)."""
        forbidden = self._forbidden()
        support = _union_cs([ta._rect(frame, -7.9, 7.9, lo, hi) for _, _, frame, lo, hi in self.ties] +
                            [ta._rect(_inward_frame(port), 0, END_TIE, -HALF, HALF) for port in self.ports] + [self.floor, self.plate])
        arcs = [np.r_[0., np.cumsum(np.linalg.norm(np.diff(line, axis=0), axis=1))] for line, _ in self.lines]
        hits = {}

        def rail_hits(segment):
            """(rail line, arc length) of every rail the chord crosses."""
            key = tuple(np.concatenate(segment))
            if key not in hits:
                hits[key] = [(index, arcs[index][j] + np.linalg.norm(point - line[j]))
                             for index, (line, _) in enumerate(self.lines) for point, j in _segment_hits(*segment, line)]
            return hits[key]

        def stub(segment, seams, shortest, bare=True):
            """Do this chord and an earlier seam cross one rail closer than `shortest` (with nothing under it
            between, when `bare`)?"""
            for index, s in rail_hits(segment):
                for other in seams:
                    for j, t in rail_hits(other):
                        if j != index or abs(s - t) >= shortest:
                            continue
                        if not bare:
                            return True
                        line, middle = self.lines[index][0], (s + t)/2
                        point = (np.interp(middle, arcs[index], line[:, 0]), np.interp(middle, arcs[index], line[:, 1]))
                        if (support ^ manifold3d.CrossSection.square((.2, .2), True).translate(point)).area() <= 0:
                            return True
            return False

        def wedge(segment, seams):
            """Does the chord end on an earlier seam inside a stringer, cutting off a wedge of it?"""
            if not seams:
                return False
            reach = end.PROFILE["baseStringerWidth"]/2 + .5
            starts = np.array([a for a, _ in seams])
            spans = np.array([b for _, b in seams]) - starts
            for point in segment:
                t = np.clip(np.einsum("ij,ij->i", point - starts, spans)/np.einsum("ij,ij->i", spans, spans), 0, 1)
                if np.min(np.linalg.norm(point - starts - t[:, None]*spans, axis=1)) < .5 and \
                        any(np.min(np.linalg.norm(line - point, axis=1)) < reach for line, _ in self.lines):
                    return True
            return False

        gaps = []
        for path in self.paths:
            intervals = end.tie_intervals(_stations(path)[-1])
            for (_, high), (low, _) in zip(intervals[:-1], intervals[1:]):
                x, y, h = _at(path, (high + low)/2)[0]
                gaps.append((np.array([x, y]), _normal(h)[0]))

        def search(region, shortest, cuts):
            """(plan or None, first tile no chord could split) over the parts of `region`, trying at most `cuts` cuts."""
            budget, dead = [cuts], []

            def evaluate(component, lines, seams):
                rows, seen = [], set()
                for point, direction in lines:
                    for segment in self._segments(component, point, direction):
                        key = tuple(np.round(np.concatenate(segment), 1))
                        if key in seen or (shortest and (stub(segment, seams, shortest, bare=False) or wedge(segment, seams))) \
                                or not self._valid([segment], forbidden):
                            continue
                        seen.add(key)
                        parts = _parts(component - ta._section(ta._segment_quad(*segment, .1)))
                        if len(parts) < 2 or any(part.area() < 600 for part in parts):
                            continue
                        extents = [max(bx1 - bx0, by1 - by0) for bx0, by0, bx1, by1 in (part.bounds() for part in parts)]
                        fitting = sum(part.area() for part, extent in zip(parts, extents) if extent <= PLAN_BED)
                        rows.append(((round(fitting), -max(extents)), segment, parts))
                # Stable: among equal scores the first chord found leads, as in the greedy plan.
                return sorted(rows, key=lambda row: row[0], reverse=True)[:PLAN_BRANCHES]

            def free_chords(component, seams):
                """Parallel chords every PLAN_STEP mm in each PLAN_TURN direction, across the part of the tile in the
                crossing plate (ties never block a cut there, and valid chords run in narrow bands between frogs),
                else across the whole tile."""
                region = component ^ self.plate
                vertices = _vertices(region if region.area() > 1. else component)
                lines = []
                for a in np.arange(0, math.pi, PLAN_TURN):
                    direction = np.array([math.cos(a), math.sin(a)])
                    normal = np.array([-direction[1], direction[0]])
                    offsets = vertices @ normal
                    lines += [(normal*offset, direction) for offset in np.arange(offsets.min() + PLAN_STEP/2, offsets.max(), PLAN_STEP)]
                return evaluate(component, lines, seams)

            def split(pending, seams):
                pending = list(pending)
                while pending:
                    x0, y0, x1, y1 = pending[-1].bounds()
                    if max(x1 - x0, y1 - y0) > PLAN_BED:
                        break
                    pending.pop()
                if not pending:
                    return seams
                component = pending.pop()
                tried = False
                for options in (lambda: evaluate(component, gaps, seams), lambda: free_chords(component, seams)):
                    for _, segment, parts in options():
                        tried = True
                        if budget[0] <= 0:
                            return None
                        budget[0] -= 1
                        plan = split(pending + parts, [*seams, segment])
                        if plan is not None:
                            return plan
                if not tried and not dead:
                    dead.append((component, seams))
                return None

            return split(_parts(region), []), dead

        plan, dead = search(self.footprint, 0., PLAN_BUDGET)
        if plan is None or any(stub(seam, plan[:k], MIN_STUB) for k, seam in enumerate(plan)):
            # The solid deck: ties, end ties, plate, floor and stringers, closed across the tie gaps.
            stringers = [ta._band(np.column_stack([_offset(path, side*RAIL), path[:, 2]]), end.PROFILE["baseStringerWidth"]/2)
                         for path in self.paths for side in (-1, 1)]
            deck = _union_cs([support, *stringers]).offset(DECK_CLOSE, manifold3d.JoinType.Round) \
                .offset(DECK_MARGIN - DECK_CLOSE, manifold3d.JoinType.Round) ^ self.footprint
            solid, solid_dead = search(deck, MIN_STICK, SOLID_BUDGET)
            if solid is not None:
                self.region = deck
                return solid
            dead = dead or solid_dead
        if plan is None:
            self.unsplit, self.partial = dead[0] if dead else (None, [])
            raise ValueError("no seam between ties splits this junction to the bed; change its size")
        return plan

    def _in_plate(self, point):
        return (self.plate ^ manifold3d.CrossSection.square((.2, .2), True).translate(tuple(point))).area() > .039

    def _plate_sites(self, a, b, step=8.):
        direction = (b - a)/np.linalg.norm(b - a)
        normal = np.array([direction[1], -direction[0]])
        # Stations every 8 mm outwards from the seam's middle, so a short seam between two others
        # still gets a key clear of both.
        length = np.linalg.norm(b - a)
        offsets = np.arange(0., length/2 - 3.9, step)
        stations = sorted({round(length/2 + sign*t, 6) for t in offsets for sign in (-1, 1)})
        return [a + direction*t for t in stations
                if all(self._in_plate(a + direction*t + normal*k) for k in (-6, 6))]

    def _sites(self):
        """Key sites: plugged stringers where a seam crosses a rail outside the plate, and plate stations.
        Every seam first gets one key (seams with the fewest candidates choose first), then the rest fill in."""
        per_seam = []
        for a, b in self.seams:
            direction = (b - a)/np.linalg.norm(b - a)
            normal = np.array([direction[1], -direction[0]])
            per_seam.append([(point, normal, True) for point, _ in self._crossings_of(a, b) if not self._in_plate(point)] +
                            [(point, normal, False) for point in self._plate_sites(a, b)])

        sites = []

        def accept(point):
            others = [_segment_distance(point, a, b) for a, b in self.seams if _segment_distance(point, a, b) > 1e-6]
            return not any(np.linalg.norm(point-other) < 6.5 for other, _, _ in sites) and min(others, default=99) >= 5.5

        for index in sorted(range(len(per_seam)), key=lambda i: len(per_seam[i])):
            a, b = self.seams[index]
            normal = np.array([(b - a)[1], -(b - a)[0]])/np.linalg.norm(b - a)
            # Short plate seams: fall back to every 1 mm station if no regular one is clear.
            for candidate in per_seam[index] + [(point, normal, False) for point in self._plate_sites(a, b, 1.)]:
                if accept(candidate[0]):
                    sites.append(candidate)
                    break
        for candidates in per_seam:
            for candidate in candidates:
                if not any(candidate[0] is site[0] for site in sites) and accept(candidate[0]):
                    sites.append(candidate)
        return sites


def _check_rails(rows) -> list[dict]:
    """crossing_any.check_rails, except that a route sharing this rail (the stretch before a toe, or a
    three-way's routes on the main line) does not interrupt its guiding face."""
    dense = [ca._dense(path) for *_, path in rows]
    specs = []
    for index, (s, points, _) in enumerate(dense):
        for rail in (-1, 1):
            face = points[:, :2] + ca._normals(points)*rail*FACE
            cut = np.zeros(len(s), dtype=bool)
            for other, (_, others, _) in enumerate(dense):
                if other != index:
                    lateral, beside = ca._project(face, others)
                    cut |= beside & (np.abs(lateral) >= ca.BACK - 1e-6) & (np.abs(lateral) <= FACE - .3)
            for s0, s1 in ca._runs(cut, s):
                if s1 - s0 <= ca.GUIDE_LIMIT:
                    continue
                lo, hi = max(s0 - ca.CHECK_LEAD, ca.END_ZONE[1]), min(s1 + ca.CHECK_LEAD, s[-1] - ca.END_ZONE[1])
                if hi - lo < 2*ca.CHECK_FLARE[0]:
                    continue
                spec = {"route": index, "rail": -rail, "s0": lo, "s1": hi}
                for other in specs:
                    if (other["route"], other["rail"]) == (index, -rail) and lo <= other["s1"] and other["s0"] <= hi:
                        other["s0"], other["s1"] = min(other["s0"], lo), max(other["s1"], hi)
                        break
                else:
                    specs.append(spec)
    return specs


def _merge(spans):
    merged = []
    for s0, s1 in sorted(spans):
        if merged and s0 <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], s1))
        else:
            merged.append((s0, s1))
    return merged


def _side_path(path, side, s0, s1):
    part = ta._station_path(path, s0, s1)
    # A span ending a hair past a sample would give a degenerate loft segment.
    keep = np.r_[np.linalg.norm(np.diff(part[:, :2], axis=0), axis=1) > 1e-3, True]
    keep[-1], keep[-2] = True, keep[-2] and np.linalg.norm(part[-1, :2] - part[-2, :2]) > 1e-3
    part = part[keep]
    return np.column_stack([_offset(part, side*RAIL), part[:, 2]])


def _side_line(path, side, s0, s1):
    return _offset(ta._station_path(path, s0, s1), side*RAIL)


def _lengthened(a, b, extra):
    direction = (b - a)/np.linalg.norm(b - a)
    return a - direction*extra, b + direction*extra


def _segment_distance(point, a, b):
    t = np.clip(np.dot(point-a, b-a)/np.dot(b-a, b-a), 0, 1)
    return np.linalg.norm(point-a-t*(b-a))


def _segment_hits(a, b, line):
    p, r = line[:-1], line[1:] - line[:-1]
    d = b - a
    cross = r[:, 0]*d[1] - r[:, 1]*d[0]
    qp = a - p
    with np.errstate(divide="ignore", invalid="ignore"):
        u = (qp[:, 0]*d[1] - qp[:, 1]*d[0]) / cross
        v = (qp[:, 0]*r[:, 1] - qp[:, 1]*r[:, 0]) / cross
    return [(p[j] + u[j]*r[j], j) for j in np.flatnonzero((np.abs(cross) > 1e-12) & (u >= 0) & (u < 1) & (v >= 0) & (v <= 1))]


def _polyline_crossings(a, b, minimum=math.radians(2)):
    """Points where two polylines cross at more than `minimum` (coincident toes are not crossings)."""
    points = []
    for i in range(len(a) - 1):
        da = a[i+1] - a[i]
        for point, j in _segment_hits(a[i], a[i+1], b):
            db = b[j+1] - b[j]
            if abs(da[0]*db[1] - da[1]*db[0]) > math.sin(minimum)*np.linalg.norm(da)*np.linalg.norm(db):
                points.append(point)
    return points


@lru_cache(maxsize=16)
def layout(spec: Spec) -> Layout:
    return Layout(spec)


def _clutch_plan(lay: Layout):
    """One rigid clutch per full tie; a column group is dropped whole if it would reach another
    route's rail or stringer, another tie's clutch, a seam, the points floor or a keeper."""
    others = [_union_cs([ta._band(np.column_stack([_offset(path, side*RAIL), path[:, 2]]), 4.3) for side in (-1, 1)])
              for path in lay.paths]
    blocked = _union_cs([lay.mechanism.offset(.5, manifold3d.JoinType.Round), lay.plate,
                         *[ta._section(ta._segment_quad(a, b, .9)) for a, b in lay.seams]])
    accepted = _union_cs([ta._rect(_inward_frame(port), 0, END_TIE, -HALF, HALF) for port in lay.ports])
    plan = []
    for route, station, frame, _, _ in lay.ties:
        columns, footprints = [], []
        for low, high, group in ta.CLUTCH_GROUPS:
            footprint = ta._rect(frame, -7.9, 7.9, low, high)
            if any(ta._overlaps(footprint, band) for other, band in enumerate(others) if other != route):
                continue
            if ta._overlaps(footprint, blocked) or ta._overlaps(footprint, accepted):
                continue
            columns += group
            footprints.append(footprint)
        for footprint in footprints:
            accepted += footprint
        plan.append((route, station, frame, tuple(sorted(columns))))
    return plan


def _flangeways(paths):
    """track_assembly's flange corridors, reaching FACE_INSET into the guiding faces."""
    channels = []
    low, high = TOP - ta.FLANGE_DEPTH, TOP + .1
    half = (FLANGE + FACE_INSET)/2
    for path in paths:
        for sign in (-1, 1):
            channels.append(ta._ribbon(path, sign*(FACE + FACE_INSET - half), half, low, high))
    return channels


def _rail(path):
    """One rail on its own centre line, the shared versioned profile (track_assembly._rails, one side)."""
    profile = np.array(end.PROFILE["railSection"])
    if np.sum(profile[:, 0]*np.roll(profile[:, 1], -1)-np.roll(profile[:, 0], -1)*profile[:, 1]) < 0:
        profile = profile[::-1]
    n, vertices, faces = len(profile), [], []
    for x, y, h in path:
        for lateral, z in profile:
            vertices.append((x - math.sin(h)*lateral, y + math.cos(h)*lateral, z))
    for j in range(len(path) - 1):
        for k in range(n):
            a, b = j*n + k, j*n + (k+1) % n
            faces.extend([(a, b, b+n), (a, b+n, a+n)])
    cap = manifold3d.CrossSection([profile.tolist()], manifold3d.FillRule.EvenOdd).extrude(.01).to_mesh()
    for j, reverse in ((0, True), (len(path)-1, False)):
        for face in cap.tri_verts:
            coords = cap.vert_properties[face, :3]
            if not np.all(np.abs(coords[:, 2]) < 1e-7):
                continue
            indices = [j*n + int(np.argmin(np.linalg.norm(profile - v[:2], axis=1))) for v in coords]
            faces.append(tuple(indices[::-1] if not reverse else indices))
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=True)
    if not mesh.is_volume:
        raise ValueError("rail loft must be a closed volume")
    return mesh


@lru_cache(maxsize=8)
def _fixed_mesh(spec: Spec, adjustment: float, lite: bool = False) -> trimesh.Trimesh:
    lay = layout(spec)
    width = end.PROFILE["bodyWidth"]/2
    bases = [ta._ribbon(path, y, end.PROFILE["baseStringerWidth"]/2, 0, BASE) for path in lay.paths for y in (-RAIL, RAIL)]
    inner = HALF - fast.RAIL_BAND[1] - fast.BRACE_OVERLAP     # outer deck edge to the inner stringer face
    for _, _, frame, lo, hi in lay.ties:
        if lite:
            box = end._box((-fast.BRACE_WIDTH/2, lo + inner if lo < -HALF else -fast.RAIL_BAND[0] - fast.BRACE_OVERLAP, 0),
                           (fast.BRACE_WIDTH/2, hi - inner if hi > HALF else fast.RAIL_BAND[0] + fast.BRACE_OVERLAP, BASE))
        else:
            box = end._box((-7.9, lo, 0), (7.9, hi, BASE))
        bases += ta._placed([box], frame)
    for port in lay.ports:
        bases += ta._placed([end._box((0, -width, 0), (END_TIE, width, BASE))], _inward_frame(port))
    bases.append(_prism(lay.floor, 0, FLOOR))
    if not lay.plate.is_empty():
        bases.append(_prism(lay.plate, 0, BASE))
    deck = ta._union([mesh for mesh in bases if len(mesh.faces)])
    zones = [_prism(zone, -2, 4) for zone in (lay.floor, lay.plate, lay.solid_stringers) if not zone.is_empty()]
    ends = [ta._placed([end._box((-4, -34, -2), (END_TIE, 34, 4))], _inward_frame(port))[0] for port in lay.ports]
    if not lite:
        cuts, additions = [], []
        webs = {route: [] for route in range(len(lay.paths))}
        for route, _, frame, _, _ in lay.ties:
            webs[route].append(frame)
        for _, _, frame, columns in _clutch_plan(lay):
            if columns:
                tie_cuts, tie_additions = end.tie_clutch(columns)
                cuts += ta._placed(tie_cuts, frame)
                additions += ta._placed(tie_additions, frame)
        deck = ta._union([ta._difference(deck, [ta._channel_void(lay.paths, webs, zones + ends), *cuts]), *additions])
    if spec.servo:
        deck = ta._union([deck, *servo.base_fill(spec)])
    rails = ta._union([_rail(_side_path(lay.paths[route], side, s0, s1)) for route, side, s0, s1 in lay.rails] +
                      ca.check_rail_mesh(lay.rows, lay.checks))
    rails = ta._difference(rails, _flangeways(lay.paths))
    body = ta._union([deck, rails])
    # Points: slot to the floor, keeper posts with pilot bores.
    if not lay.slot.is_empty():
        body = ta._difference(body, [_prism(lay.slot, FLOOR, TOP + 2)])
        posts = [end._cylinder(POST, 0, KEEPER[0], *xy) for *_, screws in lay.keepers for xy in screws]
        holes = [end._cylinder(1.3, -.1, KEEPER[0] + .1, *xy) for *_, screws in lay.keepers for xy in screws]
        body = ta._difference(ta._union([body, *posts]), holes)
    if spec.servo:
        body = servo.drop_slivers(ta._difference(body, servo.base_cuts(spec)))
    plugs = [ta._site_box(point, normal, -5.5, 5.5, -6.5, 6.5, 0, BASE) for point, normal, plugged in lay.sites if plugged]
    if plugs:
        # Stringers widened by 2.5 mm so a seam crossing a rail obliquely still gets a full key seat;
        # plugs never enter a tie (its clutch bays).
        stringers = ta._union([ta._ribbon(path, y, end.PROFILE["baseStringerWidth"]/2 + 2.5, -1, 4)
                               for path in lay.paths for y in (-RAIL, RAIL)])
        ties = [ta._placed([end._box((-8.2, lo - .3, -2), (8.2, hi + .3, 5))], frame)[0] for _, _, frame, lo, hi in lay.ties]
        plugged = [ta._difference(trimesh.boolean.intersection([plug, stringers], engine="manifold"), ties) for plug in plugs]
        body = ta._union([body, *[plug for plug in plugged if len(plug.faces)]])
    masks, contacts, cuts, additions = [], [], [], []
    for port in lay.ports:
        frame = _inward_frame(port)
        mask = end._box((-8, -34, -1), (5.8, 34, 12))
        mask.apply_transform(frame)
        masks.append(mask)
        contact = end._production_end(adjustment, opposite=lay.far[port.id])
        contact.apply_transform(frame)
        contacts.append(contact)
        c, a = ta._end_attachments({"position": (port.x, port.y, 0), "heading": port.heading})
        cuts += c
        additions += a
    body = ta._difference(body, masks)
    return ta._union([ta._difference(ta._union([body, *contacts]), cuts), *additions])


@lru_cache(maxsize=8)
def _base_pieces(spec: Spec, adjustment: float, lite: bool = False) -> list:
    lay = layout(spec)
    full = _fixed_mesh(spec, adjustment, lite)
    if not lay.seams:
        return [full]
    sites = []
    for point, normal, _ in lay.sites:
        probe = ta._site_box(point, normal, -.6, 4.4, -ta.KEY_HEAD-.4, ta.KEY_HEAD+.4, .1, 1.8)
        if trimesh.boolean.intersection([full, probe], engine="manifold").volume >= probe.volume*.995:
            sites.append((point, normal))
    # Almost every junction tiles at the first cut; where that leaves a tile unsound, too big or without a key, it is
    # cut again strictly.
    return _tiles(lay, full, sites, strict=False) or _tiles(lay, full, sites, strict=True)


def _tiles(lay, full, sites, strict):
    """`full` cut along the seams into keyed tiles. A plain cut returns None if a tile comes out unsound, too big for the
    bed or without a key. A strict cut also recuts a bridged oversize piece past the seam ends, accepts only sound rejoins
    and rejoins a keyless fragment with an overlapping patch (or drops it, under SLIVER)."""
    kerf = ta._union([ta._polygon(ta._segment_quad(a, b, .1), -1, 12) for a, b in lay.seams])
    pieces = list(ta._difference(full, [kerf]).split(only_watertight=False))
    # Where a seam ends on a hole in the deck (beside a scissors' diamond), the deck edge can stand a hair outside the
    # planned outline and bridge two tiles past the kerf's end, into one too big for the bed: such a piece is recut with
    # the kerf reaching SEAM_REACH further past every seam end (still inside the kerf of any seam it meets).
    if strict and any(np.any(piece.extents[:2] > BED) for piece in pieces):
        reach = ta._union([ta._polygon(ta._segment_quad(*_lengthened(a, b, SEAM_REACH), .1), -1, 12) for a, b in lay.seams])
        pieces = [part for piece in pieces
                  for part in (ta._difference(piece, [reach]).split(only_watertight=False) if np.any(piece.extents[:2] > BED) else [piece])]
    # Seams meeting at an acute angle can cut off a lone rail or tie corner: rejoin it, across the kerf,
    # to the neighbour it touches most.
    for fragment in sorted([piece for piece in pieces if piece.volume < FRAGMENT], key=lambda m: m.volume):
        pieces = _rejoin(lay, full, pieces, fragment, overlap=False, strict=strict) or pieces
    pieces = sorted(pieces, key=lambda m: (round(m.bounds[0, 0], 1), round(m.bounds[0, 1], 1)))
    keyed = {index for point, normal in sites for index in _key_pair(pieces, point, normal)}
    keyless = [piece for index, piece in enumerate(pieces) if piece.volume < FRAGMENT and index not in keyed]
    if keyless and not strict:
        return None
    # A refilled kerf only touches its neighbours face to face, so the union can leave them apart; a fragment no key
    # would reach is then rejoined with a patch overlapping both sides, and dropped if still apart and under SLIVER.
    for fragment in sorted(keyless, key=lambda m: m.volume):
        pieces = _rejoin(lay, full, pieces, fragment, overlap=True, strict=True) or pieces
    if keyless:
        pieces = sorted([piece for piece in pieces if piece.volume >= SLIVER or not any(piece is other for other in keyless)],
                        key=lambda m: (round(m.bounds[0, 0], 1), round(m.bounds[0, 1], 1)))
    for point, normal in sites:
        pair = _key_pair(pieces, point, normal)
        if pair:
            owner, other = pair
            pieces[owner] = ta._union([pieces[owner], ta._dovetail(point, normal)])
            pieces[other] = ta._difference(pieces[other], [ta._dovetail(point, normal, ta.JOINT_CLEARANCE)])
    tiles = [_drop_empty_shells(piece) for piece in pieces]
    return tiles if strict or all(_sound(tile) for tile in tiles) else None


def _sound(mesh) -> bool:
    try:
        check_mesh("tile", mesh)
    except ValueError:
        return False
    return True


def _key_pair(pieces, point, normal) -> tuple:
    """The two tiles a key site joins (none if it lies in one tile or off the deck)."""
    owner, other = [ta._piece_at(pieces, point+normal*k) for k in (-2., 2.)]
    return () if owner is None or other is None or owner == other else (owner, other)


def _rejoin(lay, full, pieces, fragment, overlap, strict):
    """`pieces` with `fragment` joined, across the kerf, to the neighbour it touches most (None if none joins). The kerf
    patch is the kerf itself, or with `overlap` reaches KERF_OVERLAP into both sides, only just around the fragment. A
    strict join must leave a sound tile that still plans to the bed and stays clear of every other tile."""
    rest = [piece for piece in pieces if piece is not fragment]
    box = end._box(fragment.bounds[0] - [1, 1, 1], fragment.bounds[1] + [1, 1, 1])
    near = [abs(trimesh.boolean.intersection([piece, box], engine="manifold").volume) for piece in rest]
    for host in np.argsort(near)[::-1]:
        if near[host] <= 0:
            break
        others = [piece for k, piece in enumerate(rest) if k != host and near[k] > 0]
        if overlap:
            reach = .2 + 2*KERF_OVERLAP       # a kerf's width and both overlaps
            tight = end._box(fragment.bounds[0] - [reach, reach, 1], fragment.bounds[1] + [reach, reach, 1])
            strips = [trimesh.boolean.intersection([ta._polygon(ta._segment_quad(a, b, .1 + KERF_OVERLAP), -1, 12), tight, full], engine="manifold")
                      for a, b in lay.seams]
            strips = [ta._difference(strip, others) for strip in strips if len(strip.faces)]
            patches = [strip for strip in strips if len(strip.faces) and _overlap(strip, rest[host]) > 1e-6 and _overlap(strip, fragment) > 1e-6]
        else:
            # Refill only the kerf of the seams between fragment and host, inside the fragment's box.
            patches = [strip for a, b in lay.seams
                       for strip in [trimesh.boolean.intersection([ta._polygon(ta._segment_quad(a, b, .1), -1, 12), box, full], engine="manifold")]
                       if len(strip.faces) and _overlap(strip, rest[host].convex_hull) > 0
                       and _overlap(ta._polygon(ta._segment_quad(a, b, .3), -1, 12), fragment.convex_hull) > 0]
        joined = ta._union([rest[host], fragment, *patches]) if patches else None
        if joined is None or len(joined.split(only_watertight=False)) != 1:
            continue
        if strict and (np.any(joined.extents[:2] > PLAN_BED + 4) or not _sound(joined)
                       or any(_overlap(joined, other) > 1e-4 for other in others)):
            continue
        rest[host] = joined
        return rest
    return None


def _drop_empty_shells(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """A rejoined fragment's refilled kerf can leave coincident faces that a later key boolean splits off as
    zero-volume shells (no material, but no longer one component): drop them."""
    shells = mesh.split(only_watertight=False)
    kept = [shell for shell in shells if abs(shell.volume) >= EMPTY_SHELL]
    return mesh if len(kept) == len(shells) or not kept else trimesh.util.concatenate(kept)


def rest_positions(spec: Spec, state: int, sprung: bool) -> tuple:
    """Printed (unstressed) position of every switch: the default state when sprung, else 0."""
    return tuple(_positions(spec, state)) if sprung else tuple(0 for _ in spec.switches)


@lru_cache(maxsize=16)
def component_meshes(spec: Spec, state: int, sprung: bool, adjustment: float, lite: bool = False) -> list:
    rows = [(f"keyed-base-{i+1:02d}", mesh) for i, mesh in enumerate(_base_pieces(spec, adjustment, lite))]
    rest = rest_positions(spec, state, sprung)
    for pts in points_of(spec):
        i = pts.index
        rows.append((f"selector-points-{i+1}", points_mesh(pts, rest[i])))
        rows += [(f"keeper-{i+1}-{blade+1}", keeper_mesh(pts, blade)) for blade in (0, 1)]
        if not sprung and not spec.servo:
            rows.append((f"selector-lock-{i+1}", spacer_mesh(pts, _positions(spec, state)[i])))
    if spec.servo:
        rows += servo.components(spec)
    return rows


def assembly_mesh(spec: Spec, state: int, sprung: bool, adjustment: float, lite: bool = False) -> trimesh.Trimesh:
    """Everything in place for `state` (points thrown to it, spacer fitted when manual, servo rods with the bar)."""
    rows = [mesh for role, mesh in component_meshes(spec, state, sprung, adjustment, lite)
            if not role.startswith(("selector-points", "mechanism-servo-rod"))]
    rows += [points_mesh(pts, _positions(spec, state)[pts.index]) for pts in points_of(spec)]
    if spec.servo:
        rows += [mesh for pts in points_of(spec) for mesh in servo.moving(pts, _positions(spec, state)[pts.index])]
    return ta._union(rows)


def check_mesh(role: str, mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    if not mesh.is_watertight or len(mesh.split(only_watertight=False)) != 1:
        raise ValueError(f"{role} is not a connected watertight component")
    if np.any(mesh.extents[:2] > BED + .001):
        raise ValueError(f"{role} exceeds the 166 mm usable mini bed")
    manifold = manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))
    cleaned = manifold.simplify(1e-5).to_mesh()
    result = trimesh.Trimesh(cleaned.vert_properties[:, :3], cleaned.tri_verts, process=True)
    if not result.is_volume or len(result.split(only_watertight=False)) != 1:
        raise ValueError(f"{role} lost connected volume during seam retriangulation")
    return result


# ------------------------------------------------------------------ probes
def _overlap(a, b):
    return abs(trimesh.boolean.intersection([a, b], engine="manifold").volume)


def probe_motion(spec: Spec, sprung: bool, adjustment: float = 0., lite: bool = False, steps: int = 9) -> dict:
    """Points swept through their whole travel never touch the base or keepers."""
    fixed = _fixed_mesh(spec, adjustment, lite)
    maximum, samples = 0., 0
    for pts in points_of(spec):
        stationary = ta._union([fixed, keeper_mesh(pts, 0), keeper_mesh(pts, 1)])
        for position in np.linspace(0, 1, steps):
            maximum = max(maximum, _overlap(points_mesh(pts, position), stationary))
            samples += 1
    if maximum > .01:
        raise ValueError(f"points interfere through travel: {maximum:.6f} mm^3")
    return {"samples": samples, "maximumInterferenceMm3": maximum, "physicalFit": "not_checked",
            "spring": "flexure returns to the printed position" if sprung else "spacer holds the set position"}


def probe_retention(spec: Spec, adjustment: float = 0., lite: bool = False) -> list:
    """Keepers stop the points lifting; the stock rails stop over-travel both ways."""
    fixed = _fixed_mesh(spec, adjustment, lite)
    report = []
    for pts in points_of(spec):
        keepers = ta._union([keeper_mesh(pts, 0), keeper_mesh(pts, 1)])
        lifted = points_mesh(pts, .5)
        lifted.apply_translation((0, 0, .7))
        pairs = [("keeper-uplift", lifted, keepers),
                 ("points-travel-stop", points_mesh(pts, -(CLEAR + .3)/THROW), fixed),
                 ("points-travel-stop", points_mesh(pts, 1 + (CLEAR + .3)/THROW), fixed)]
        for name, moving, stop in pairs:
            volume = _overlap(moving, stop)
            if volume < .01:
                raise ValueError(f"switch {pts.index+1}: {name} does not retain the points")
            report.append({"switch": pts.index+1, "stop": name, "blockedVolumeMm3": volume})
    return report


def probe_state_locks(spec: Spec, sprung: bool, adjustment: float = 0., lite: bool = False) -> list:
    """Manual: a fitted spacer blocks both directions in either position. Sprung: no lock, rest = set.
    Servo: the servo holds the set position (turnout_servo.probes)."""
    fixed = _fixed_mesh(spec, adjustment, lite)
    report = []
    for pts in points_of(spec):
        if sprung or spec.servo:
            report.append({"switch": pts.index+1, "lock": "servo holds the set position" if spec.servo
                           else "none (sprung; rests in the printed position)"})
            continue
        for position in (0, 1):
            spacer = spacer_mesh(pts, position)
            if _overlap(spacer, fixed) > .01 or _overlap(spacer, points_mesh(pts, position)) > .01:
                raise ValueError(f"switch {pts.index+1}: spacer does not fit position {position}")
            stationary = ta._union([fixed, spacer])
            for direction in (-1, 1):
                moved = points_mesh(pts, position + direction*1./THROW)
                blocked = _overlap(moved, stationary)
                if blocked < .01:
                    raise ValueError(f"switch {pts.index+1} position {position} is not positively locked")
                report.append({"switch": pts.index+1, "position": position, "direction": direction,
                               "blockedVolumeMm3": blocked})
    return report


def probe_operating_envelopes(spec: Spec, sprung: bool) -> dict:
    """Every moving part, keeper and spacer stays inside the published envelopes."""
    polygons = envelopes(spec)
    regions = ta._union([_prism(_section(poly), -.01, (servo.HEIGHT if spec.servo else TOP) + .01) for poly in polygons])
    maximum = 0.
    for pts in points_of(spec):
        parts = [points_mesh(pts, position) for position in np.linspace(0, 1, 5)]
        parts += [keeper_mesh(pts, 0), keeper_mesh(pts, 1)]
        if spec.servo:
            parts += [*servo.moving(pts, 0.), *servo.moving(pts, 1.), *servo.stationary(spec, pts.index)]
        elif not sprung:
            parts += [spacer_mesh(pts, 0), spacer_mesh(pts, 1)]
        for part in parts:
            maximum = max(maximum, abs(ta._difference(part, [regions]).volume))
    if maximum > .01:
        raise ValueError(f"mechanism exceeds its operating envelope: {maximum:.6f} mm^3")
    return {"regions": len(polygons), "outsideVolumeMm3": maximum}


def probe_running_clearances(spec: Spec, state: int, sprung: bool, adjustment: float = 0., lite: bool = False) -> dict:
    """Selected routes: flange corridors clear, running heads never unsupported over 4 mm (track_assembly's envelope)."""
    assembly = assembly_mesh(spec, state, sprung, adjustment, lite)
    # Source contacts (first 6 mm inside each port) are verified by probe_source_contacts; a curved
    # route's corridor ends are not square to its port, so cut those zones out of the corridor instead.
    contacts = []
    for port in spec.ports:
        box = end._box((-8, -34, -1), (6., 34, 12))
        box.apply_transform(_inward_frame(port))
        contacts.append(box)
    flange_max, gap_max = 0., 0.
    for route in spec.routes:
        if route.id not in enabled_routes(spec, state):
            continue
        path = route_path(spec, route.id)
        lengths = _stations(path)
        flange_path = ta._station_path(path, 6., lengths[-1] - 6.)
        for cutter in ta._flangeways([flange_path]):
            flange_max = max(flange_max, _overlap(assembly, ta._difference(cutter, contacts)))
        sampled = _at(path, np.arange(6., lengths[-1] - 6., .5))
        for lateral in (-RAIL, RAIL):
            gap = 0.
            for x, y, h in sampled:
                probe = end._box((-.1, lateral - HEAD, TOP - .25), (.1, lateral + HEAD, TOP - .05))
                probe.apply_transform(end._frame((x, y, 0), h, 0))
                gap = 0. if _overlap(assembly, probe) > .002 else gap + .5
                gap_max = max(gap_max, gap)
    if flange_max > .01:
        raise ValueError(f"state {spec.states[state].id}: wheel-flange corridor obstructed: {flange_max:.6f} mm^3")
    if gap_max > 4.:
        raise ValueError(f"state {spec.states[state].id}: unsupported running-head gap {gap_max:.3f} mm")
    return {"state": spec.states[state].id, "flangeObstructionMm3": flange_max, "maximumUnsupportedSpanMm": gap_max,
            "samplePitchMm": .5, "physicalWheelAcceptance": "not_checked"}


def probe_base_joints(spec: Spec, adjustment: float = 0., lite: bool = False) -> dict:
    """Every base tile joins the assembly through a real pull-out stop."""
    rows = [(f"keyed-base-{i+1:02d}", mesh) for i, mesh in enumerate(_base_pieces(spec, adjustment, lite))]
    adjacency = [set() for _ in rows]
    evidence = []
    for i, (name, mesh) in enumerate(rows):
        for j, (other_name, other) in enumerate(rows[i+1:], i+1):
            if np.any(mesh.bounds[0, :2] > other.bounds[1, :2]+1) or np.any(other.bounds[0, :2] > mesh.bounds[1, :2]+1):
                continue
            rest = _overlap(mesh, other)
            if rest > .01:
                raise ValueError(f"base joint interference: {name}/{other_name}: {rest:.6f} mm^3")
            blocked = []
            for translation in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0)):
                pulled = mesh.copy()
                pulled.apply_translation(translation)
                blocked.append(_overlap(pulled, other))
            if min(blocked) > .01:
                adjacency[i].add(j)
                adjacency[j].add(i)
                evidence.append({"from": name, "to": other_name, "blockedVolumeMm3": min(blocked)})
    reached, pending = set(), [0]
    while pending:
        node = pending.pop()
        if node not in reached:
            reached.add(node)
            pending.extend(adjacency[node] - reached)
    if len(reached) != len(rows):
        raise ValueError(f"base tiles lack retained joints: {[rows[i][0] for i in range(len(rows)) if i not in reached]}")
    return {"components": len(rows), "retainedConnections": evidence}


def probe_source_contacts(spec: Spec, state: int, sprung: bool, adjustment: float = 0., lite: bool = False) -> list:
    """The accepted connector interface is unchanged at every port after componentization."""
    assembly = ta._union([mesh for _, mesh in component_meshes(spec, state, sprung, adjustment, lite)])
    lay = layout(spec)
    columns = end.PROFILE["brickAttachment"]["studLateralOffsets"]
    report = []
    for port in spec.ports:
        local = assembly.copy()
        local.apply_transform(np.linalg.inv(_inward_frame(port)))
        region = ta._difference(end._box((-5, -23.9, -.01), (5.79, 23.9, 10)),
                                [end._box((4-2.45, y-2.45, 3.2), (4+2.45, y+2.45, 4.9)) for y in columns])
        source = end.end_mesh(adjustment, opposite=lay.far[port.id])
        expected = trimesh.boolean.intersection([source, region], engine="manifold")
        actual = trimesh.boolean.intersection([local, region], engine="manifold")
        lost, added = abs(ta._difference(expected, [actual]).volume), abs(ta._difference(actual, [expected]).volume)
        if max(lost, added) > .005:
            raise ValueError(f"source interface changed at {port.id}: lost={lost:.6f}, added={added:.6f} mm^3")
        report.append({"port": port.id, "lostMm3": lost, "addedMm3": added})
    return report


# ------------------------------------------------------------------ turnout families
R40, R56 = 320., 448.
HAND = {"key": "hand"}
FAMILIES = ("turnout_radius", "turnout_curved", "turnout_wye", "turnout_three_way")
COMPONENT_FAMILY = "turnout_component"
CONNECTOR = frozenset({"connector_version", "fit_adjustment"})
LOGICAL = frozenset({"switch_state", "sprung"})
SHAPES = {"turnout_radius": ("radius", "hand"), "turnout_curved": ("radius", "sweep", "hand"),
          "turnout_wye": (), "turnout_three_way": ()}
RADII = {40: "R40 · standard 32-stud shape", 56: "R56 oblique", 104: "R104 parallel · 80 studs", 148: "R148 parallel · 96 studs"}
THREE_WAY_STAGGER = 184.   # the right-hand toe sits just beyond the left frog


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _branch(radius_studs: int, hand: float) -> tuple[list, float]:
    """Diverging centreline from the toe and the main-line length (piece frame, straight main)."""
    points = [(0., 0., 0.)]
    if radius_studs == 40:
        turn = math.atan2(3, 4)
        arc(points, R40, hand*turn)
        arc(points, R40, -hand*(turn - math.pi/8))
        return points, 256.
    if radius_studs == 56:
        # One R56 22.5° arc and the straight after which a second R56 curve lands 16 studs over.
        arc(points, R56, hand*math.pi/8)
        line(points, (128 - 2*R56*(1 - math.cos(math.pi/8)))/math.sin(math.pi/8))
        return points, 320.
    radius, turn, length = {104: (832., math.asin(5/13), 640.), 148: (1184., math.asin(12/37), 768.)}[radius_studs]
    arc(points, radius, hand*turn)
    arc(points, radius, -hand*turn)
    return points, length


def _straight(length, y=0.):
    points = [(0., y, 0.)]
    line(points, length)
    return points


def _port(ident, point, far):
    x, y, h = point
    return Port(ident, float(x), float(y), float(h if far else h + math.pi))


def _two_way(main, branch, labels=("straight", "diverging")):
    ports = (_port("in", main[0], False), _port("out", main[-1], True), _port("branch", branch[-1], True))
    routes = (Route("main", "in", "out", tuple(main)), Route("branch", "in", "branch", tuple(branch)))
    return Spec(ports, routes, (Switch("main", "branch", "in"),),
                (State(labels[0], (0,)), State(labels[1], (1,))))


def validate(family: str, p: dict) -> None:
    if family not in FAMILIES:
        raise ValueError("unknown turnout family")
    required = CONNECTOR | LOGICAL | set(SHAPES[family])
    if set(p) - {"lite", "servo"} != required:
        raise ValueError(f"{family} requires exactly {sorted(required)}")
    if "servo" in p and (p["servo"] != 1 or p.get("sprung") != 0):
        raise ValueError("servo must be 1 when present, on manual (not sprung) points")
    if any(not _number(value) for value in p.values()):
        raise ValueError("turnout parameters must be finite numbers")
    fast.validate(p)
    end.validate(p)
    if p["sprung"] not in (0, 1):
        raise ValueError("sprung must be 0 or 1")
    states = 3 if family == "turnout_three_way" else 2
    if p["switch_state"] not in range(states):
        raise ValueError(f"switch_state must be 0..{states-1}")
    if "hand" in p and p["hand"] not in (-1, 1):
        raise ValueError("hand must be 1 (left) or -1 (right)")
    if family == "turnout_radius" and p["radius"] not in RADII:
        raise ValueError(f"radius must be one of {sorted(RADII)} studs")
    if family == "turnout_curved" and (p["radius"] not in (40, 56) or p["sweep"] not in (45, 90)):
        raise ValueError("curved turnouts are R40 or R56 over 45° or 90°")


@lru_cache(maxsize=64)
def spec_for(family: str, shape: tuple) -> Spec:
    p = dict(shape)
    if family == "turnout_radius":
        branch, length = _branch(int(p["radius"]), p["hand"])
        return _two_way(_straight(length), branch)
    if family == "turnout_curved":
        radius, sweep, hand = (R40 if p["radius"] == 40 else R56), math.radians(p["sweep"]), p["hand"]
        inner = [(0., 0., 0.)]
        arc(inner, radius, hand*sweep)
        outer = [(0., 0., 0.)]
        # The outer route's straight lands both exits parallel, 16 studs apart.
        line(outer, 128/math.sin(sweep))
        arc(outer, radius, hand*sweep)
        return _two_way(outer, inner)
    if family == "turnout_wye":
        legs = []
        for hand in (1, -1):
            leg = [(0., 0., 0.)]
            arc(leg, R40, hand*math.pi/8)
            line(leg, 32.)
            legs.append(leg)
        ports = (_port("in", legs[0][0], False), _port("left", legs[0][-1], True), _port("right", legs[1][-1], True))
        routes = (Route("left", "in", "left", tuple(legs[0])), Route("right", "in", "right", tuple(legs[1])))
        return Spec(ports, routes, (Switch("left", "right", "in"),), (State("left", (0,)), State("right", (1,))))
    # Three-way: a left brick-geometry turnout, then a right one on the main line past the left frog.
    left, main_length = _branch(40, 1)
    right, _ = _branch(40, -1)
    right = [(0., 0., 0.)] + [(x + THREE_WAY_STAGGER, y, h) for x, y, h in right]
    main = _straight(THREE_WAY_STAGGER + main_length)
    ports = (_port("in", main[0], False), _port("out", main[-1], True),
             _port("left", left[-1], True), _port("right", right[-1], True))
    routes = (Route("main", "in", "out", tuple(main)), Route("left", "in", "left", tuple(left)),
              Route("right", "in", "right", tuple(right)))
    return Spec(ports, routes, (Switch("main", "left", "in"), Switch("main", "right", "in")),
                (State("straight", (0, 0)), State("left", (1, 0)), State("right", (0, 1))))


def _shape(family, p):
    return tuple((key, float(p[key])) for key in SHAPES[family])


def servo_side(family: str, p: dict) -> int:
    """The side servos sit on (piece frame, from the toe): away from the branch; a wye's on its left, a three-way's
    on its right (both its switches have room there). The editor mirrors this rule."""
    if "hand" in SHAPES[family]:
        return -int(p["hand"])
    return 1 if family == "turnout_wye" else -1


def spec(family: str, p: dict) -> Spec:
    shape = spec_for(family, _shape(family, p))
    return replace(shape, servo=servo_side(family, p)) if p.get("servo") else shape


def ports(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return port_rows(spec(family, p))


def route_pairs(family: str, p: dict) -> dict[frozenset, bool]:
    validate(family, p)
    return spec_route_pairs(spec(family, p), int(p["switch_state"]))


def _meshes(family, p):
    return component_meshes(spec(family, p), int(p["switch_state"]), bool(p["sprung"]),
                            float(p["fit_adjustment"]), fast.enabled(p))


def components(family: str, p: dict) -> list[dict]:
    validate(family, p)
    code = FAMILIES.index(family)
    return [{"role": role, "parameters": {**p, "shape_code": code, "component_index": index}}
            for index, (role, _) in enumerate(_meshes(family, p))]


def _family_of(p) -> str:
    code = p.get("shape_code")
    if not _number(code) or code != int(code) or not 0 <= code < len(FAMILIES):
        raise ValueError("invalid shape_code")
    return FAMILIES[int(code)]


def component_keys(p: dict) -> set[str]:
    return set(CONNECTOR | LOGICAL | set(SHAPES[_family_of(p)]) | {"shape_code", "component_index"} | ({"servo"} & set(p)))


def _logical(p):
    return {key: value for key, value in p.items() if key not in ("shape_code", "component_index")}


def validate_component(p: dict) -> None:
    family = _family_of(p)
    if set(p) - {"lite"} != component_keys(p):
        raise ValueError("unexpected turnout component parameters")
    validate(family, _logical(p))
    index = p["component_index"]
    if not _number(index) or index != int(index) or index < 0:
        raise ValueError("invalid component_index")
    if index >= len(_meshes(family, p)):
        raise ValueError("component_index outside assembly")


def component_ports(p: dict) -> list[dict]:
    return ports(_family_of(p), _logical(p))


def build_component(p: dict) -> cq.Shape:
    validate_component(p)
    role, mesh = _meshes(_family_of(p), p)[int(p["component_index"])]
    return end._solid(check_mesh(role, mesh))


def spec_hardware(spec: Spec) -> list[dict]:
    """Two keepers per switch, two screws each; servo parts when driven."""
    rows = [hw.m3_screw(4, 4*len(spec.switches))] if spec.switches else []
    return hw.merged(rows + (servo.hardware(spec) if spec.servo else []))


def spec_notes(spec: Spec, sprung: bool) -> list[str]:
    """Assembly notes for any point-blade junction."""
    notes = ["Lay the keyed base pieces on a flat surface and lower the matching dovetails together.",
             "Keep the frog gaps, flangeways and the points slots free of support material."]
    if not spec.switches:
        return notes
    notes += ["Lower each set of points onto its floor with both heel blocks in their sockets, then fit the two "
              "keepers over the heel blocks with four M3 x 4 self-tapping screws. Never use a longer screw.",
              "Push the knob on the tie bar to throw the points; the blades bend between the tie bar and the heel blocks."]
    if sprung:
        notes.append("Sprung: the points rest in the printed position and spring back after a train trails through "
                     "from the other route. Do not fit a spacer.")
    elif spec.servo:
        notes += servo.notes(spec)
    else:
        notes.append("Manual: drop the printed spacer into the open blade's gap beside the tie bar to hold the set "
                     "position; lift it out before throwing the points." +
                     (" Each set of points has its own spacer." if len(spec.switches) > 1 else ""))
    return notes


def hardware(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return spec_hardware(spec(family, p))


def assembly_notes(family: str, p: dict) -> list[str]:
    validate(family, p)
    notes = spec_notes(spec(family, p), bool(p["sprung"]))
    if family == "turnout_three_way":
        notes.append("Two sets of points: throw only one of them to its branch at a time.")
    return notes


def probes(family: str, p: dict) -> dict:
    """Run every probe on one configuration (tests and evidence)."""
    validate(family, p)
    s, sprung, adj, lite = spec(family, p), bool(p["sprung"]), float(p["fit_adjustment"]), fast.enabled(p)
    return {"motion": probe_motion(s, sprung, adj, lite), "retention": probe_retention(s, adj, lite),
            "locks": probe_state_locks(s, sprung, adj, lite), "envelopes": probe_operating_envelopes(s, sprung),
            "running": [probe_running_clearances(s, state, sprung, adj, lite) for state in range(len(s.states))],
            "joints": probe_base_joints(s, adj, lite),
            "contacts": probe_source_contacts(s, int(p["switch_state"]), sprung, adj, lite),
            **({"servo": servo.probes(s, adj, lite)} if s.servo else {})}
