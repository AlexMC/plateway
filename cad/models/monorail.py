"""Brick monorail: a 4-stud beam with a toothed centre rod, a separate gauge network; millimetres.

Beam (part 2671 class): 32 mm (4 studs) wide, 12.8 mm (4 plates) tall, centre groove `slot_width` wide and
`slot_depth` deep. A rod stands on the groove floor along the centre line carrying a module-0.5 rack on both faces
(pitch lines 1.5 mm either side of the centre line), its top 0.8 mm below the running surface. A monorail motor's
gear (12 teeth, m0.5, 7 mm tip diameter [INFERENCE: "about 7 mm", hackaday 163521]) runs in the groove beside the
rod and climbs on it, so monorail grades are set by the ramp shape (37.5 % at most), not by wheel adhesion.
Teeth: 163 per side on a 256 mm straight (brickset 25471: part 2671 has 163 teeth each side, 41 on the short
straight, 82 on the monoswitch), so the nominal pitch is 256/163 = 1.5706 mm. Every piece carries a whole number
of teeth per side (nearest count, halves up; 41 on 64 mm, 82 on 128 mm) spread evenly over that side's own length,
so each end of each side is a tooth space and the phase runs on across joints. On curves the outer side is longer:
a quarter R224 gets 226 outside and 223 inside — the official quarter curve has 3 more teeth outside than inside, which
is what puts the pitch lines 1.5 mm off the centre line (the "centrally disposed gear rod" of the original monorail
switch patent US 5087001). Groove width/depth, rod thickness and the motor gear are [INFERENCE]: they are
parameters (defaults 17.5 / 6.4 mm) and the 4-stud straight is the calibration coupon to print first.

Joints: every end, and every keyed seam inside a piece, has a 2 x 2 anti-stud socket (12.8 mm square, 1.8 mm deep,
6.4 mm centre post) under the centre line, rigid in the end frame, 1.6..14.4 mm from the joint: an owned
2 x 4 plate under the joint clutches both pieces, and that plate stacks onto brick columns as a stanchion.
Joining to original monorail track is NOT verified [INFERENCE: the original sections join the same way].
Inside a piece, seams are butt joints with two vertical dovetail keys (one each side of the groove) plus that plate.
Every printed part fits the A1 mini (plan <= 158 mm): 256 mm straights and ramps split in two, curves in 30° pieces.

Families (piece frame: +x forward from the `in` port, +y left, z up from the beam underside):
- monorail_straight: `length` 32..256 mm (4..32 studs, step 4).
- monorail_curve: R224 (28 studs) centre line, `angle` 30/45/90°, `hand` +1 left, -1 right.
- monorail_ramp: 256 mm plan, 48 mm rise, one parabolic easing (vertical radius 682.7 mm); `part` 0 lower (level
  at its bottom end, 37.5 % at its top end; part 2677) or 1 upper (2678); `climb` +1 up, -1 down from `in`.
  [INFERENCE: 48 mm rise per part from the 2677/2678 bounding boxes; the original profile is not measured.]
  Prints as laid, on painted support under its bent underside only (support_faces). The two parts together
  lift 96 mm over 512 mm.
- monorail_switch [INFERENCE: geometry chosen near the 2889/2890 bounding box, not measured]: 256 mm straight
  route and a diverging route (32 mm straight, then R448 for 30°, ending at
  (256, 60) heading 30°), `hand` +1 branch left. An original-style lateral slide (the patent's shifting device) carries a
  straight and a curved groove; pushing it by hand moves it `shift` mm between its two end stops, and magnets hold
  it there. Base: three keyed floor pieces; slide and end stop are separate printed parts.
Fast print hollows the straight and curve beams from below (side and centre cells); ramps and the switch keep their
geometry and only take the fast process (the slide and stop always print detailed).
"""
from __future__ import annotations

from functools import lru_cache
import math
from pathlib import Path

import cadquery as cq
import manifold3d
import numpy as np
import trimesh

from . import hardware as hw
from . import brick_end as end
from . import lite as fast

FAMILIES = ("monorail_straight", "monorail_curve", "monorail_ramp", "monorail_switch")
COMPONENT_FAMILY = "monorail_component"
CONNECTOR = frozenset({"connector_version", "fit_adjustment"})
COMMON = ("slot_width", "slot_depth")
SHAPES = {"monorail_straight": ("length",), "monorail_curve": ("angle", "hand"),
          "monorail_ramp": ("part", "climb"), "monorail_switch": ("hand", "switch_state")}
SOURCE_DEPENDENCIES = [Path(__file__), Path(end.__file__)]

# ------------------------------------------------------------------ beam and rack
WIDTH, HEIGHT = 32., 12.8
HALF = WIDTH/2
TEETH_256 = 163
PITCH = 256./TEETH_256                       # 1.5706 mm nominal tooth pitch
MODULE = .5
PRESSURE = math.radians(20)
ROD_PITCH = 1.5                              # rack pitch lines either side of the centre line
ADDENDUM, DEDENDUM = MODULE, 1.25*MODULE     # rack tips at 2.0, roots at 0.875
ROD_CORE = ROD_PITCH - DEDENDUM
ROD_DROP = .8                                # rod top below the running surface
SLOT_WIDTH, SLOT_DEPTH = 17.5, 6.4           # defaults [INFERENCE]
SLOT_LIMITS = {"slot_width": (16.5, 22.), "slot_depth": (4., 7.2)}   # deeper: the rod foot meets the switch slide's tongues
GEAR_TEETH = 12                              # 6 mm pitch circle, 7 mm tip circle
GEAR_PITCH_R = MODULE*GEAR_TEETH/2
GEAR_TIP_R = GEAR_PITCH_R + MODULE
GEAR_CENTRE = ROD_PITCH + GEAR_PITCH_R       # 4.5 mm off the centre line, either side
WHEEL_TRACK = 12.4                           # running-surface probe lines, |y| (between groove edge and beam side)

# 2 x 2 anti-stud socket (brick underside: 12.8 mm cavity, 6.51 mm tube; track bays are 1.8 mm deep)
SOCKET = (1.6, 14.4)                         # along the end frame, inward from the joint
SOCKET_HALF, SOCKET_DEPTH, POST_R = 6.4, 1.8, 3.2
# Seam keys: vertical dovetails, neck 3.0 at the seam, head 4.4 at 3.5 mm, 0.2 mm clearance
KEY_NECK, KEY_HEAD, KEY_DEPTH, KEY_CLEAR, KEY_Y = 3., 4.4, 3.5, .2, 12.4
SEAM_ZONE = 18.                              # lite cells stay this far from joints and seams
PLAN = 158.                                  # every printed part fits this square (A1 mini usable 166)
BED = 166.

# Geometry
STUD = 8.
CURVE_R = 224.
RAMP_RUN, RAMP_RISE = 256., 48.
SWITCH_LENGTH, SWITCH_LEAD, SWITCH_R, SWITCH_ANGLE = 256., 32., 448., math.radians(30)
FLOOR = 3.2                                  # switch pocket floor; the slide stands on it
CLEAR = .3                                   # slide clearance to its pocket
WALL = 6.                                    # head/tail stock walls
TONGUE, TONGUE_H, GROOVE_D, GROOVE_H = 1.6, 1.6, 1.9, 1.9
STOP_W, STOP_H, BOSS = 6., 7., (8., 3., 2.5)
MAGNET_R, MAGNET_D, MAGNET_SKIN = 3.15, 3.1, .2
GRIP = (30., 3., 6.)                         # finger tab on the slide: x length, y depth, height above the top

PORT_GAUGE, PORT_WIDTH = end.PROFILE["railGauge"], end.PROFILE["railInterfaceWidth"]


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _half_up(value: float) -> int:
    return int(math.floor(value + .5 + 1e-9))


# ------------------------------------------------------------------ routes (station space -> piece frame)
class PlanRoute:
    """A level route of straight (k = 0) and arc segments from the origin heading +x; station = centreline length."""

    def __init__(self, segments):
        self.segments = tuple((float(length), float(k)) for length, k in segments)
        self.length = sum(length for length, _ in self.segments)
        starts, x, y, h, s = [], 0., 0., 0., 0.
        for length, k in self.segments:
            starts.append((s, x, y, h))
            if k:
                x, y = x + (math.sin(h + k*length) - math.sin(h))/k, y + (math.cos(h) - math.cos(h + k*length))/k
                h += k*length
            else:
                x, y = x + length*math.cos(h), y + length*math.sin(h)
            s += length
        self.starts = starts

    def _segment(self, s):
        index = np.clip(np.searchsorted([row[0] for row in self.starts], s, side="right") - 1, 0, len(self.segments) - 1)
        return index

    def frames(self, s):
        s = np.atleast_1d(np.asarray(s, float))
        index = self._segment(s)
        x, y, h = np.zeros_like(s), np.zeros_like(s), np.zeros_like(s)
        for i, (s0, x0, y0, h0) in enumerate(self.starts):
            mask = index == i
            if not mask.any():
                continue
            d, k = s[mask] - s0, self.segments[i][1]
            if k:
                hh = h0 + k*d
                x[mask], y[mask], h[mask] = x0 + (np.sin(hh) - math.sin(h0))/k, y0 + (math.cos(h0) - np.cos(hh))/k, hh
            else:
                x[mask], y[mask], h[mask] = x0 + d*math.cos(h0), y0 + d*math.sin(h0), h0
        zero, one = np.zeros_like(s), np.ones_like(s)
        return (np.column_stack((x, y, zero)), np.column_stack((np.cos(h), np.sin(h), zero)),
                np.column_stack((-np.sin(h), np.cos(h), zero)), np.column_stack((zero, zero, one)))

    def curvature(self, s):
        return np.array([self.segments[i][1] for i in self._segment(np.atleast_1d(s))])

    def bend(self, s):
        return np.zeros_like(np.atleast_1d(np.asarray(s, float)))

    def heading(self, s):
        _, t, _, _ = self.frames(s)
        return np.arctan2(t[:, 1], t[:, 0])


class RampRoute:
    """A straight-in-plan route over z = f(x); station = length along the beam underside (bent, sections normal)."""

    def __init__(self, part: int, climb: int):
        x = np.linspace(0., RAMP_RUN, 20481)
        u = x/RAMP_RUN
        ease_in = (part == 0) == (climb > 0)          # zero grade at the `in` end
        f = u*u if ease_in else 1 - (1 - u)**2
        df = 2*u if ease_in else 2*(1 - u)
        z, grade = climb*RAMP_RISE*f, climb*RAMP_RISE/RAMP_RUN*df
        ds = np.hypot(np.diff(x), np.diff(z))
        self.x, self.z, self.grade = x, z, grade
        self.s = np.r_[0., np.cumsum(ds)]
        self.theta = np.arctan(grade)
        self.length = float(self.s[-1])
        self.kappa = np.gradient(self.theta, self.s)

    def frames(self, s):
        s = np.atleast_1d(np.asarray(s, float))
        x, z = np.interp(s, self.s, self.x), np.interp(s, self.s, self.z)
        th = np.interp(s, self.s, self.theta)
        beyond = np.minimum(s, 0) + np.maximum(s - self.length, 0)       # straight extension past either end
        x, z = x + beyond*np.cos(th), z + beyond*np.sin(th)
        zero, one = np.zeros_like(s), np.ones_like(s)
        return (np.column_stack((x, zero, z)), np.column_stack((np.cos(th), zero, np.sin(th))),
                np.column_stack((zero, one, zero)), np.column_stack((-np.sin(th), zero, np.cos(th))))

    def curvature(self, s):
        return np.zeros_like(np.atleast_1d(np.asarray(s, float)))

    def bend(self, s):
        return np.interp(np.atleast_1d(s), self.s, self.kappa)

    def heading(self, s):
        return np.zeros_like(np.atleast_1d(np.asarray(s, float)))

    def grade_at(self, s):
        return float(np.interp(s, self.s, self.grade))


def _warp(solid, route):
    """Station-space solid (x = station, y = left, z = height above the underside) -> piece frame."""
    if isinstance(route, PlanRoute) and all(k == 0 for _, k in route.segments):
        return solid
    def mapping(v):
        v = np.asarray(v, float)
        p, _, n, u = route.frames(v[:, 0])
        return p + n*v[:, 1:2] + u*v[:, 2:3]
    return solid.refine_to_length(2.).warp_batch(mapping)


def frame_matrix(route, s: float, inward: float) -> np.ndarray:
    """Rigid frame at station s: x along the route (times `inward`), y left, z up the beam's normal; origin underside."""
    p, t, n, u = (a[0] for a in route.frames(s))
    t, n = t*inward, n*inward
    return np.array([[t[0], n[0], u[0], p[0]], [t[1], n[1], u[1], p[1]], [t[2], n[2], u[2], p[2]], [0, 0, 0, 1]])


# ------------------------------------------------------------------ rack phase
class Phase:
    """Teeth on one side of a route: phase(s) counts teeth from the start (integer = a tooth space)."""

    def __init__(self, route, side: int, height: float, anchor=None):
        grid = np.linspace(0., route.length, max(2, int(math.ceil(route.length/.05)) + 1))
        rate = (1 - route.curvature(grid)*side*ROD_PITCH)*(1 - route.bend(grid)*height)
        along = np.r_[0., np.cumsum((rate[1:] + rate[:-1])/2*np.diff(grid))]
        if anchor is None:
            count = _half_up(along[-1]/PITCH)
            phase = along*count/along[-1]
        else:
            # A shared lead-in keeps another route's pitch; the rest spreads to a whole count at the end.
            s0, pitch = anchor
            a0 = np.interp(s0, grid, along)
            p0 = a0/pitch
            count = _half_up(p0 + (along[-1] - a0)/PITCH)
            phase = np.where(grid <= s0, along/pitch, p0 + (along - a0)*(count - p0)/(along[-1] - a0))
        self.grid, self.phase, self.count, self.side_length = grid, phase, count, float(along[-1])

    def at(self, s):
        return np.interp(s, self.grid, self.phase)

    def centres(self, s0: float, s1: float):
        """Stations of tooth centres with phase in (phase(s0), phase(s1))."""
        lo, hi = self.at(s0), self.at(s1)
        index = np.arange(math.floor(lo - .5) - 1, math.ceil(hi) + 1)
        phases = index + .5
        phases = phases[(phases > lo) & (phases < hi)]
        return np.interp(phases, self.phase, self.grid)


def _rod_height(slot_depth):
    floor = HEIGHT - slot_depth
    return floor, HEIGHT - ROD_DROP


def phases(route, slot_depth, anchors=None):
    floor, top = _rod_height(slot_depth)
    anchors = anchors or {}
    return {side: Phase(route, side, (floor + top)/2, anchors.get(side)) for side in (1, -1)}


# ------------------------------------------------------------------ station-space solids
def _box(x0, x1, y0, y1, z0, z1):
    return manifold3d.Manifold.cube((x1 - x0, y1 - y0, z1 - z0)).translate((x0, y0, z0))


def _section(points):
    return manifold3d.CrossSection([np.asarray(points, float).tolist()], manifold3d.FillRule.EvenOdd)


def _prism(section, z0, z1):
    return section.extrude(z1 - z0).translate((0, 0, z0))


def _teeth(phase: Phase, side: int, s0: float, s1: float):
    """Rack teeth on one side of the rod, centred between s0 and s1 (station space), as a plan section."""
    centres = phase.centres(s0, s1)
    if not len(centres):
        return manifold3d.CrossSection()
    local = 1/np.interp(centres, phase.grid[1:], np.diff(phase.phase)/np.diff(phase.grid))
    root, tip = ROD_CORE - .05, ROD_PITCH + ADDENDUM
    slope = math.tan(PRESSURE)
    polygons = []
    for c, p in zip(centres, local):
        w_root, w_tip = p/4 + (ROD_PITCH - root)*slope, p/4 - ADDENDUM*slope
        poly = [(c - w_root, root), (c + w_root, root), (c + w_tip, tip), (c - w_tip, tip)]
        if side < 0:
            poly = [(x, -y) for x, y in poly[::-1]]
        polygons.append(poly)
    return manifold3d.CrossSection(polygons, manifold3d.FillRule.NonZero)


def _rod(phases_, s0, s1, slot_depth):
    floor, top = _rod_height(slot_depth)
    plan = _section([(s0, -ROD_CORE), (s1, -ROD_CORE), (s1, ROD_CORE), (s0, ROD_CORE)])
    for side, phase in phases_.items():
        plan = plan + _teeth(phase, side, s0, s1)
    plan = plan ^ _section([(s0, -5), (s1, -5), (s1, 5), (s0, 5)])
    # The rod's foot sinks 0.5 mm into the groove floor: a foot flush with it leaves sliver faces at the floor line.
    return _prism(plan, floor - .5, top)


def _groove(s0, s1, slot_width, slot_depth):
    return _box(s0, s1, -slot_width/2, slot_width/2, HEIGHT - slot_depth, HEIGHT + 1)


def _beam(phases_, s0, s1, slot_width, slot_depth):
    body = _box(s0, s1, -HALF, HALF, 0, HEIGHT) - _groove(s0 - 1, s1 + 1, slot_width, slot_depth)
    return body + _rod(phases_, s0, s1, slot_depth)


def _cells(s0, s1, slot_width, slot_depth):
    """Fast-print cells open below: one each side of the groove, one under its floor."""
    side_in, side_out = slot_width/2 + 1.2, HALF - 1.6
    rows = [_box(s0, s1, side_in, side_out, -1, HEIGHT - 1.6), _box(s0, s1, -side_out, -side_in, -1, HEIGHT - 1.6)]
    centre = slot_width/2 - .8
    if HEIGHT - slot_depth - 1.6 > 1.:
        rows.append(_box(s0, s1, -centre, centre, -1, HEIGHT - slot_depth - 1.6))
    return manifold3d.Manifold.batch_boolean(rows, manifold3d.OpType.Add)


def _key_section(seam, y, clearance=0.):
    head, neck, depth = KEY_HEAD/2 + clearance, KEY_NECK/2 + clearance, KEY_DEPTH + clearance
    return _section([(seam - .5, y - neck), (seam + depth, y - head), (seam + depth, y + head), (seam - .5, y + neck)])


def _keys(seam, ys, z1, clearance=0.):
    """Vertical dovetail keys standing on the underside: the next piece lowers onto them."""
    section = manifold3d.CrossSection()
    for y in ys:
        section = section + _key_section(seam, y, clearance)
    return _prism(section, -.01 if not clearance else -1, z1 + (0 if not clearance else 1))


def _socket(matrix):
    pocket = _box(SOCKET[0], SOCKET[1], -SOCKET_HALF, SOCKET_HALF, -1, SOCKET_DEPTH)
    post = manifold3d.Manifold.cylinder(SOCKET_DEPTH + 2, POST_R, POST_R, 64).translate(((SOCKET[0] + SOCKET[1])/2, 0, -1.5))
    return (pocket - post).transform(matrix[:3, :].tolist())


def _cut_sockets(solid, frames):
    if not frames:
        return solid
    return solid - manifold3d.Manifold.batch_boolean([_socket(m) for m in frames], manifold3d.OpType.Add)


def _seams(length, pieces, phases_):
    """Seam stations splitting a beam into `pieces`: near equal, each at a tooth space of the left side."""
    phase = phases_[1]
    rows = []
    for i in range(1, pieces):
        target = phase.at(length*i/pieces)
        rows.append(float(np.interp(round(target), phase.phase, phase.grid)))
    return rows


def _beam_pieces(route, slot_width, slot_depth, lite, pieces, phases_=None):
    """Plain beam along `route` split into keyed pieces (station space, then warped); end and seam sockets cut."""
    phases_ = phases_ or phases(route, slot_depth)
    length = route.length
    seams = _seams(length, pieces, phases_)
    bounds = [0., *seams, length]
    beam = _beam(phases_, 0., length, slot_width, slot_depth)
    if lite:
        spans = [(a + SEAM_ZONE, b - SEAM_ZONE) for a, b in zip(bounds, bounds[1:]) if b - a > 2*SEAM_ZONE + 4]
        if spans:
            beam = beam - manifold3d.Manifold.batch_boolean([_cells(a, b, slot_width, slot_depth) for a, b in spans],
                                                            manifold3d.OpType.Add)
    rows = []
    for i, (a, b) in enumerate(zip(bounds, bounds[1:])):
        part = beam ^ _box(a, b, -HALF - 5, HALF + 5, -5, HEIGHT + 5)
        if i + 1 < len(bounds) - 1:
            part = part + (_keys(b, (KEY_Y, -KEY_Y), HEIGHT) ^ beam.hull())
        if i > 0:
            part = part - _keys(a, (KEY_Y, -KEY_Y), HEIGHT, KEY_CLEAR)
        part = _warp(part, route)
        frames = [frame_matrix(route, a, 1.), frame_matrix(route, b, -1.)]
        rows.append(_cut_sockets(part, frames))
    return rows, bounds, phases_


# ------------------------------------------------------------------ helpers
def _tm(solid) -> trimesh.Trimesh:
    mesh = solid.to_mesh()
    return trimesh.Trimesh(np.asarray(mesh.vert_properties)[:, :3], np.asarray(mesh.tri_verts), process=False)


def _manifold(mesh: trimesh.Trimesh):
    return manifold3d.Manifold(manifold3d.Mesh(np.asarray(mesh.vertices, np.float32), np.asarray(mesh.faces, np.uint32)))


def _mirror(solid, hand):
    return solid if hand > 0 else solid.mirror((0, 1, 0))


def _straight_route(length):
    return PlanRoute([(length, 0.)])


def _curve_route(angle_deg, hand=1):
    sweep = math.radians(angle_deg)
    return PlanRoute([(CURVE_R*sweep, hand/CURVE_R)])


def _switch_routes(hand: int = 1):
    main = PlanRoute([(SWITCH_LENGTH, 0.)])
    branch = PlanRoute([(SWITCH_LEAD, 0.), (SWITCH_R*SWITCH_ANGLE, hand/SWITCH_R)])
    return main, branch


# ------------------------------------------------------------------ switch layout
class SwitchLayout:
    """Left-hand switch geometry (the right hand is its mirror image in y)."""

    def __init__(self, slot_width, slot_depth):
        self.slot_width, self.slot_depth = slot_width, slot_depth
        self.main, self.branch = _switch_routes()
        self.x0 = SWITCH_LEAD
        # The slide ends where the idle groove has left the live beam's running surface.
        self.shift = slot_width/2 + HALF
        off = self.shift
        self.x1 = self.x0 + math.sqrt(SWITCH_R**2 - (SWITCH_R - off)**2)
        self.s1_branch = self.x0 + SWITCH_R*math.asin((self.x1 - self.x0)/SWITCH_R)
        self.ymax = off + self.shift + HALF                 # slide's far edge (slide frame)
        self.pocket = (-HALF - self.shift - CLEAR, self.ymax + CLEAR)
        self.stop_y = (self.pocket[1], self.pocket[1] + STOP_W)
        self.outer = (self.pocket[0] - 4., self.stop_y[1] + 2.)
        self.main_phase = phases(self.main, slot_depth)
        self.branch_phase = phases(self.branch, slot_depth, {side: (self.x0, PITCH) for side in (1, -1)})
        self.magnet = (self.x0 + 10., KEY_Y)                 # slide frame
        self.mid = (self.x0 + self.x1)/2
        self.seams = (88., 176.)

    def ends(self):
        p, t, _, _ = self.branch.frames(self.branch.length)
        return p[0], math.atan2(t[0, 1], t[0, 0])


def _clip_x(solid, x0=None, x1=None):
    lo, hi = -1000. if x0 is None else x0, 1000. if x1 is None else x1
    return solid ^ _box(lo, hi, -1000, 1000, -100, 100)


def _route_beam(route, phases_, s0, s1, w, d, body=True):
    """Body (or groove only, body=False), and rod, of a route between stations, warped (not clipped)."""
    solid = _box(s0, s1, -HALF, HALF, 0, HEIGHT) if body else None
    return (_warp(solid, route) if body else None, _warp(_groove(s0 - 1, s1 + 1, w, d), route),
            _warp(_rod(phases_, s0, s1, d), route))


@lru_cache(maxsize=8)
def _switch_parts(slot_width, slot_depth, hand):
    lay = SwitchLayout(slot_width, slot_depth)
    w, d = slot_width, slot_depth
    x0, x1, (py0, py1), (oy0, oy1) = lay.x0, lay.x1, lay.pocket, lay.outer
    main_body, main_groove, _ = _route_beam(lay.main, lay.main_phase, 0., SWITCH_LENGTH, w, d)
    sb0 = lay.s1_branch - 12.
    branch_body, branch_groove, branch_rod = _route_beam(lay.branch, lay.branch_phase, sb0, lay.branch.length, w, d)
    # Fixed base: lead-in, head and tail stocks, floor, far wall, exit block.
    base = manifold3d.Manifold.batch_boolean([
        main_body, branch_body, _box(x0 - WALL, x0, oy0, oy1, 0, HEIGHT), _box(x1, x1 + WALL, oy0, oy1, 0, HEIGHT),
        _box(x0 - WALL, x1 + WALL, oy0, py0, 0, HEIGHT), _box(x0, x1, oy0, oy1, 0, FLOOR)], manifold3d.OpType.Add)
    pocket = _box(x0, x1, py0, oy1 + 5, FLOOR, HEIGHT + 20)
    grooves = [_clip_x(main_groove, None, x0), _clip_x(main_groove, x1, None), _clip_x(branch_groove, x1, None),
               _box(x0 - GROOVE_D, x0 + 1, py0, oy1 + 5, FLOOR, FLOOR + GROOVE_H),
               _box(x1 - 1, x1 + GROOVE_D, py0, oy1 + 5, FLOOR, FLOOR + GROOVE_H)]
    base = base - pocket - manifold3d.Manifold.batch_boolean(grooves, manifold3d.OpType.Add)
    rods = [_rod(lay.main_phase, 0., x0, d), _rod(lay.main_phase, x1, SWITCH_LENGTH, d), _clip_x(branch_rod, x1, None)]
    base = base + manifold3d.Manifold.batch_boolean(rods, manifold3d.OpType.Add)
    # Stop bosses beyond the slide's open end; magnet pockets at both slide positions.
    bx = (lay.mid - 25., lay.mid + 25.)
    bosses = [_box(x - BOSS[0]/2, x + BOSS[0]/2, lay.stop_y[0] + 1.5, lay.stop_y[0] + 1.5 + BOSS[1], FLOOR - .01, FLOOR + BOSS[2])
              for x in bx]
    base = base + manifold3d.Manifold.batch_boolean(bosses, manifold3d.OpType.Add)
    mx, my = lay.magnet
    magnets = [manifold3d.Manifold.cylinder(FLOOR, MAGNET_R, MAGNET_R, 48).translate((mx, y, MAGNET_SKIN))
               for y in (my, my - lay.shift)]
    base = base - manifold3d.Manifold.batch_boolean(magnets, manifold3d.OpType.Add)
    # Split through the floor into three keyed pieces; sockets at every end and seam.
    key_ys = (oy0 + 8., (py0 + oy1)/2 - 4., oy1 - 10.)
    socket_ys = (-24., 40.)
    branch_end, branch_heading = lay.ends()
    ends = [frame_matrix(lay.main, 0., 1.), frame_matrix(lay.main, SWITCH_LENGTH, -1.),
            frame_matrix(lay.branch, lay.branch.length, -1.)]
    pieces = []
    bounds = (-10., *lay.seams, 400.)
    for i, (a, b) in enumerate(zip(bounds, bounds[1:])):
        part = base ^ _box(a, b, -1000, 1000, -10, 100)
        if i < 2:
            part = part + (_keys(b, key_ys, FLOOR) ^ base)
        if i > 0:
            part = part - _keys(a, key_ys, FLOOR, KEY_CLEAR)
        frames = [m for m in ends if a <= m[0, 3] <= b]
        for seam, inward in ((a, 1.), (b, -1.)):
            if seam in lay.seams:
                frames += [np.array([[inward, 0, 0, seam], [0, inward, 0, y], [0, 0, 1, 0], [0, 0, 0, 1]]) for y in socket_ys]
        pieces.append(_mirror(_cut_sockets(part, frames), hand))
    # Slide (state 'straight' position): a straight and a curved groove, side by side `shift` apart.
    sx0, sx1 = x0 + CLEAR, x1 - CLEAR
    slide = _box(sx0, sx1, -HALF, lay.ymax, FLOOR, HEIGHT)
    slide = slide + _box(sx0 - TONGUE, sx1 + TONGUE, -HALF, lay.ymax, FLOOR, FLOOR + TONGUE_H)
    _, d_groove, d_rod = _route_beam(lay.branch, lay.branch_phase, x0 - 2, lay.s1_branch + 4, w, d, body=False)
    slide = slide - _groove(x0 - 5, x1 + 5, w, d) - d_groove.translate((0, lay.shift, 0))
    rods = _rod(lay.main_phase, x0 - 2, x1 + 2, d) + d_rod.translate((0, lay.shift, 0))
    slide = slide + (rods ^ _box(sx0, sx1, -100, 200, 0, 100))
    slide = slide - manifold3d.Manifold.cylinder(MAGNET_D + .01, MAGNET_R, MAGNET_R, 48).translate((mx, my, FLOOR - .01))
    slide = slide + _box(lay.mid - GRIP[0]/2, lay.mid + GRIP[0]/2, lay.ymax - GRIP[1], lay.ymax, HEIGHT - .01, HEIGHT + GRIP[2])
    # End stop: drops over the floor bosses.
    stop = _box(lay.mid - 35., lay.mid + 35., lay.stop_y[0], lay.stop_y[1], FLOOR, FLOOR + STOP_H)
    stop = stop - manifold3d.Manifold.batch_boolean(
        [_box(x - BOSS[0]/2 - .15, x + BOSS[0]/2 + .15, lay.stop_y[0] + 1.35, lay.stop_y[0] + 1.65 + BOSS[1], FLOOR - 1, FLOOR + BOSS[2] + .3)
         for x in bx], manifold3d.OpType.Add)
    return lay, tuple(pieces), _mirror(slide, hand), _mirror(stop, hand)


def slide_offset(hand: int, state: int, shift: float) -> tuple:
    """Slide translation from its printed ('straight') position for a state."""
    return (0., -hand*shift*state, 0.)


# ------------------------------------------------------------------ registry interface
def validate(family: str, p: dict) -> None:
    if family not in FAMILIES:
        raise ValueError("unknown monorail family")
    required = CONNECTOR | set(SHAPES[family]) | set(COMMON)
    if set(p) - {"lite"} != required:
        raise ValueError(f"{family} requires exactly {sorted(required)}")
    if any(not _number(value) for value in p.values()):
        raise ValueError("monorail parameters must be finite numbers")
    fast.validate(p)
    end.validate(p)
    for key, (lo, hi) in SLOT_LIMITS.items():
        if not lo <= p[key] <= hi:
            raise ValueError(f"{key} must be between {lo} and {hi} mm")
    if p["slot_width"]/2 < GEAR_CENTRE + GEAR_TIP_R + .25:
        raise ValueError("slot too narrow for a 7 mm gear beside the rod")
    if family == "monorail_straight" and (p["length"] not in [STUD*4*n for n in range(1, 9)]):
        raise ValueError("length must be 32..256 mm in 32 mm (4-stud) steps")
    if family == "monorail_curve" and p["angle"] not in (30, 45, 90):
        raise ValueError("angle must be 30, 45 or 90 degrees")
    if "hand" in p and p["hand"] not in (1, -1):
        raise ValueError("hand must be 1 (left) or -1 (right)")
    if family == "monorail_ramp" and (p["part"] not in (0, 1) or p["climb"] not in (1, -1)):
        raise ValueError("part must be 0 (lower) or 1 (upper) and climb 1 (up) or -1 (down)")
    if family == "monorail_switch" and p["switch_state"] not in (0, 1):
        raise ValueError("switch_state must be 0 (straight) or 1 (diverging)")


def _shape(p):
    return float(p["slot_width"]), float(p["slot_depth"])


def route_of(family: str, p: dict):
    if family == "monorail_straight":
        return _straight_route(float(p["length"]))
    if family == "monorail_curve":
        return _curve_route(float(p["angle"]), int(p["hand"]))
    if family == "monorail_ramp":
        return RampRoute(int(p["part"]), int(p["climb"]))
    raise ValueError("the switch has two routes")


def _port(ident, route, s, outward):
    p, t, _, _ = (a[0] for a in route.frames(s))
    heading = math.atan2(t[1], t[0]) + (0 if outward > 0 else math.pi)
    grade = t[2]/math.hypot(t[0], t[1])
    return {"id": ident, "position": [float(p[0]), float(p[1]), float(p[2])], "heading": float(heading),
            "pitch": float(math.atan(grade*outward)), "rail_gauge": PORT_GAUGE, "rail_interface_width": PORT_WIDTH}


def ports(family: str, p: dict) -> list[dict]:
    """Outward ports; pitch is the outward slope (the `in` port of a climbing ramp points down)."""
    validate(family, p)
    if family == "monorail_switch":
        main, branch = _switch_routes(int(p["hand"]))
        return [_port("in", main, 0., -1), _port("out", main, main.length, 1), _port("branch", branch, branch.length, 1)]
    route = route_of(family, p)
    return [_port("in", route, 0., -1), _port("out", route, route.length, 1)]


def route_pairs(family: str, p: dict) -> dict[frozenset, bool]:
    validate(family, p)
    if family == "monorail_switch":
        state = int(p["switch_state"])
        return {frozenset(("in", "out")): state == 0, frozenset(("in", "branch")): state == 1}
    return {frozenset(("in", "out")): True}


def _piece_count(family, p):
    if family == "monorail_straight":
        return 1 if p["length"] <= 128 else 2
    if family == "monorail_curve":
        return {30: 1, 45: 2, 90: 3}[int(p["angle"])]
    return 2


@lru_cache(maxsize=32)
def _meshes_for(family: str, key: tuple, lite: bool) -> tuple:
    p = dict(key)
    w, d = _shape(p)
    if family == "monorail_switch":
        _, pieces, slide, stop = _switch_parts(w, d, int(p["hand"]))
        return tuple([(f"base-{i+1:02d}", _tm(piece)) for i, piece in enumerate(pieces)] +
                     [("mechanism-slide", _tm(slide)), ("mechanism-stop", _tm(stop))])
    route = route_of(family, p)
    # Ramps print on support under their bent underside: no open cells there.
    rows, _, _ = _beam_pieces(route, w, d, lite and family != "monorail_ramp", _piece_count(family, p))
    return tuple((f"beam-{i+1:02d}", _tm(row)) for i, row in enumerate(rows))


def _key(family, p):
    return tuple(sorted((k, float(v)) for k, v in p.items() if k in set(SHAPES[family]) | set(COMMON) and k != "switch_state"))


def component_meshes(family: str, p: dict) -> tuple:
    return _meshes_for(family, _key(family, p), fast.enabled(p))


def components(family: str, p: dict) -> list[dict]:
    validate(family, p)
    code = FAMILIES.index(family)
    return [{"role": role, "parameters": {**p, "shape_code": code, "component_index": index}}
            for index, (role, _) in enumerate(component_meshes(family, p))]


def _family_of(p) -> str:
    code = p.get("shape_code")
    if not _number(code) or code != int(code) or not 0 <= code < len(FAMILIES):
        raise ValueError("invalid shape_code")
    return FAMILIES[int(code)]


def component_keys(p: dict) -> set[str]:
    return set(CONNECTOR | set(SHAPES[_family_of(p)]) | set(COMMON) | {"shape_code", "component_index"})


def _logical(p):
    return {key: value for key, value in p.items() if key not in ("shape_code", "component_index")}


def validate_component(p: dict) -> None:
    family = _family_of(p)
    if set(p) - {"lite"} != component_keys(p):
        raise ValueError("unexpected monorail component parameters")
    validate(family, _logical(p))
    index = p["component_index"]
    if not _number(index) or index != int(index) or index < 0:
        raise ValueError("invalid component_index")
    if index >= len(component_meshes(family, _logical(p))):
        raise ValueError("component_index outside assembly")


def component_ports(p: dict) -> list[dict]:
    return ports(_family_of(p), _logical(p))


def support_faces(p: dict, centroids: np.ndarray, normals: np.ndarray, bed: np.ndarray) -> np.ndarray:
    """Faces a part needs painted support under (plates.enforced_faces): a ramp's bent underside, its socket roofs
    and posts, and the keys standing below it, wherever they are above the plate. Level parts need none."""
    mask = np.zeros(len(centroids), dtype=bool)
    family = _family_of(p)
    if family != "monorail_ramp":
        return mask
    route = route_of(family, _logical(p))
    under = np.interp(centroids[:, 0], route.x, route.z)
    return (normals[:, 2] < -.5) & (bed > .05) & (centroids[:, 2] - under <= SOCKET_DEPTH + .3)


def check_mesh(role: str, mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    if not mesh.is_watertight or len(mesh.split(only_watertight=False)) != 1:
        raise ValueError(f"{role} is not a connected watertight component")
    if np.any(mesh.extents[:2] > BED + .001):
        raise ValueError(f"{role} does not fit the {BED:g} mm bed")
    return mesh


def build_component(p: dict) -> cq.Shape:
    validate_component(p)
    family = _family_of(p)
    role, mesh = component_meshes(family, _logical(p))[int(p["component_index"])]
    return end._solid(check_mesh(role, mesh))


def _plates(family, p) -> int:
    """Plates this piece brings: one per seam socket pair, one for each of its far joints (out, branch)."""
    if family == "monorail_switch":
        return 2*len(SwitchLayout(*_shape(p)).seams) + 2
    return _piece_count(family, p)


def hardware(family: str, p: dict) -> list[dict]:
    validate(family, p)
    rows = [hw.row("Brick plate 2 x 4 (3020)", _plates(family, p), hw.BRICK)]
    if family == "monorail_switch":
        rows += [hw.row(hw.MAGNET, 3, hw.MAGNETS), hw.row(hw.GLUE, 1, hw.MATERIALS)]
    return rows


def assembly_notes(family: str, p: dict) -> list[str]:
    validate(family, p)
    count = len(component_meshes(family, p))
    notes = ["Experimental: the groove and rack are sized for a classic brick monorail motor's 7 mm gear [unverified]. "
             "Print the 4-stud straight first and run your motor over it; widen or deepen the groove (Slot width / depth) "
             "if it binds.",
             "Joints: press a 2 x 4 brick plate up into the sockets under each joint so it clutches both pieces; stand "
             "elevated track on brick columns under those plates. Joining to classic brick monorail track is untested."]
    if family == "monorail_switch":
        lay = SwitchLayout(*_shape(p))
        notes += ["Lay the three base pieces on a flat surface and lower the matching dovetails together; put two "
                  "2 x 4 plates under each floor seam (the sockets under it).",
                  "Glue a 6 x 3 mm magnet into each floor pocket and one into the slide's underside pocket, poles set "
                  "so the slide's magnet attracts both.",
                  "Slide the slide into its pocket from the open side, its tongues in the grooves of the head and tail "
                  "walls, then drop the end stop over the two floor bosses.",
                  f"Push the slide by its tab: against the end stop it sets the straight route, {lay.shift:.2f} mm "
                  "across against the far wall it sets the diverging route; the magnets hold it there.",
                  "Keep the grooves, rack teeth and the slide's tongues free of support material."]
    elif count > 1:
        notes += [f"{count} printed pieces: lower each onto the previous one's dovetail keys and put a 2 x 4 plate "
                  "under each seam."]
    if family == "monorail_ramp":
        notes += ["Each piece prints as laid on support under its bent underside; peel the support from the underside "
                  "and the sockets before fitting the plates.",
                  "Stand the ramp on brick columns under its joints; the joint between the lower and upper parts is at "
                  "37.5 % and needs its own column."]
    return notes


# ------------------------------------------------------------------ probes
def gear_section(angle: float, backlash: float = .05, samples: int = 8):
    """Involute 12-tooth m0.5 gear (20°), centred at the origin, tooth 0 pointing along `angle`."""
    rb, ra, rf = GEAR_PITCH_R*math.cos(PRESSURE), GEAR_TIP_R, GEAR_PITCH_R - DEDENDUM
    inv = lambda a: math.tan(a) - a
    half = math.pi/(2*GEAR_TEETH) - backlash/2/GEAR_PITCH_R + inv(PRESSURE)   # half angle at the base circle
    points = []
    for k in range(GEAR_TEETH):
        c = angle + 2*math.pi*k/GEAR_TEETH
        flank = []
        for r in np.linspace(rb, ra, samples):
            a = math.acos(rb/r)
            flank.append((r, half - inv(a)))
        left = [(rf, half + .05)] + flank
        tooth = [(r, c - t) for r, t in left] + [(r, c + t) for r, t in reversed(left)]
        points += [(r*math.cos(t), r*math.sin(t)) for r, t in tooth]
    return manifold3d.CrossSection([points], manifold3d.FillRule.Positive) + manifold3d.CrossSection.circle(rf, 48)


def _slice(meshes, z):
    return _union(meshes).slice(z)


def _union(meshes):
    return manifold3d.Manifold.batch_boolean([_manifold(m) for m in meshes], manifold3d.OpType.Add)


def _strip(points, normals, half):
    return manifold3d.CrossSection([np.vstack([points + normals*half, (points - normals*half)[::-1]]).tolist()],
                                   manifold3d.FillRule.NonZero)


def _clear_radius(section, centre, limit=8.):
    """Radius of the largest circle round `centre` that misses `section` (bisection to 0.001 mm)."""
    circle = lambda r: manifold3d.CrossSection.circle(r, 96).translate(tuple(centre))
    if (circle(limit) ^ section).area() <= 1e-8:
        return limit
    lo, hi = 0., limit
    for _ in range(13):
        mid = (lo + hi)/2
        lo, hi = (lo, mid) if (circle(mid) ^ section).area() > 1e-8 else (mid, hi)
    return lo


def probe_gear(meshes, route, phase_of, s0, s1, slot_depth, step=.25) -> dict:
    """A 12-tooth m0.5 involute gear (0.05 mm backlash) rolled along each side of the rod in a slice at mid rod height:
    its worst overlap with any solid (mm²), the share of stations where it is within 0.15 mm of a tooth flank
    (engaged), and its tip-circle clearance to the groove wall on its far side."""
    floor, top = _rod_height(slot_depth)
    section = _slice(meshes, (floor + top)/2)
    report = {}
    for side in (1, -1):
        worst, engaged, wall, samples = 0., 0, math.inf, 0
        for s in np.arange(s0, s1 + 1e-9, step):
            p, t, n, _ = (a[0, :2] for a in route.frames(s))
            centre = p + n*side*GEAR_CENTRE
            beta = math.atan2(-side*n[1], -side*n[0])
            angle = beta - side*2*math.pi*float(phase_of[side].at(s))/GEAR_TEETH
            window = section ^ manifold3d.CrossSection.square((24, 24)).translate((centre[0] - 12, centre[1] - 12))
            gear = gear_section(angle).translate(tuple(centre))
            worst = max(worst, (gear ^ window).area())
            engaged += (gear.offset(.15, manifold3d.JoinType.Round) ^ window).area() > 1e-4
            far = window ^ _section([centre + n*side*.1 + t*10, centre + n*side*.1 - t*10,
                                     centre + n*side*12 - t*10, centre + n*side*12 + t*10])
            wall = min(wall, _clear_radius(far, centre) - GEAR_TIP_R)
            samples += 1
        report["left" if side > 0 else "right"] = {"samples": samples, "maxInterferenceMm2": worst,
                                                   "engagedFraction": engaged/samples, "minWallClearanceMm": wall}
    return report


def probe_running(meshes, route, s0, s1, step=.5) -> dict:
    """Rays down the beam normal on both wheel lines (|y| = 12.4): worst deviation of the first hit from the running
    surface, and the longest stretch where either line misses (a gap at a joint or seam)."""
    solid = _union(meshes)
    worst, gap, longest = 0., 0., 0.
    for s in np.arange(s0, s1 + 1e-9, step):
        p, _, n, u = (a[0] for a in route.frames(s))
        hit = True
        for y in (WHEEL_TRACK, -WHEEL_TRACK):
            expected = p + n*y + u*HEIGHT
            hits = solid.ray_cast(tuple(expected + u*5), tuple(expected - u*5))
            if hits:
                worst = max(worst, float(np.linalg.norm(np.asarray(hits[0].position) - expected)))
            else:
                hit = False
        gap = 0. if hit else gap + step
        longest = max(longest, gap)
    return {"maxSurfaceDeviationMm": worst, "longestMissMm": longest, "samplePitchMm": step}


def probe_teeth(meshes, route, slot_depth) -> dict:
    """Teeth per side: solid crossings of each rack pitch line in a slice at mid rod height."""
    floor, top = _rod_height(slot_depth)
    section = _slice(meshes, (floor + top)/2)
    s = np.arange(0., route.length + 1e-9, .02)
    p, _, n, _ = route.frames(s)
    counts = {}
    for side in (1, -1):
        strip = _strip(p[:, :2] + n[:, :2]*side*ROD_PITCH, n[:, :2], .01)
        counts["left" if side > 0 else "right"] = len([q for q in (strip ^ section).decompose() if q.area() > 1e-6])
    return counts


_TO_FACE = np.array([[0., 1., 0., 0.], [0., 0., 1., 0.], [1., 0., 0., 0.], [0., 0., 0., 1.]])


def end_section(mesh: trimesh.Trimesh, frame: np.ndarray, inside: float):
    """The part's section 0.05 mm inside an end, in that end's route-forward frame (y left, z up the beam normal)."""
    matrix = _TO_FACE @ np.linalg.inv(frame)
    section = _manifold(mesh).transform(matrix[:3, :].tolist()).slice(inside*.05)
    return section ^ manifold3d.CrossSection.square((2*HALF + 8, HEIGHT + 20)).translate((-HALF - 4, -10))


def end_frames(family: str, p: dict) -> dict:
    """Route-forward frames at every port (x forward along the route, origin on the underside centre line)."""
    if family == "monorail_switch":
        main, branch = _switch_routes(int(p["hand"]))
        return {"in": frame_matrix(main, 0., 1.), "out": frame_matrix(main, main.length, 1.),
                "branch": frame_matrix(branch, branch.length, 1.)}
    route = route_of(family, p)
    return {"in": frame_matrix(route, 0., 1.), "out": frame_matrix(route, route.length, 1.)}


def probe_ends(family: str, p: dict) -> dict:
    """Each port's end section against a plain straight's `in` end: XOR area (mm²). Equal sections mean any two
    monorail ends meet flush: running surface, groove and rod line up, and every end is a tooth space."""
    reference_p = {**{k: p[k] for k in CONNECTOR | set(COMMON)}, "length": 64.}
    reference = end_section(component_meshes("monorail_straight", reference_p)[0][1],
                            end_frames("monorail_straight", reference_p)["in"], 1)
    meshes = assembled(family, p)
    solid = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
    report = {}
    for ident, frame in end_frames(family, p).items():
        section = end_section(solid, frame, 1 if ident == "in" else -1)
        report[ident] = {"xorMm2": (section - reference).area() + (reference - section).area(), "areaMm2": section.area()}
    return report


def probe_parts(family: str, p: dict) -> list[dict]:
    """Each printed part is one watertight solid within the 166 mm bed in its print orientation."""
    rows = []
    for role, mesh in component_meshes(family, p):
        checked = check_mesh(role, mesh)
        rows.append({"role": role, "volumeMm3": float(checked.volume), "printPlanMm": [float(v) for v in checked.extents[:2]]})
    return rows


def assembled(family: str, p: dict, state: int | None = None) -> list:
    """Every printed part in place (the switch slide moved to `state`)."""
    if family != "monorail_switch":
        return [mesh for _, mesh in component_meshes(family, p)]
    lay = SwitchLayout(*_shape(p))
    state = int(p["switch_state"]) if state is None else state
    return [mesh if role != "mechanism-slide" else mesh.copy().apply_translation(slide_offset(int(p["hand"]), state, lay.shift))
            for role, mesh in component_meshes(family, p)]


def switch_phases(lay: SwitchLayout, hand: int) -> tuple:
    main, branch = _switch_routes(hand)
    return ((main, phases(main, lay.slot_depth)),
            (branch, phases(branch, lay.slot_depth, {side: (lay.x0, PITCH) for side in (1, -1)})))


def _branch_station(lay, x):
    return x if x <= lay.x0 else lay.x0 + SWITCH_R*math.asin(min(1., (x - lay.x0)/SWITCH_R))


def _wall_distance(section, point, normal, tangent):
    """Distance from `point` along `normal` to the first solid in a plan section (the groove wall above the rod)."""
    ray = section ^ _section([point + normal*.05 + tangent*3, point + normal*.05 - tangent*3,
                              point + normal*(HALF + 6) - tangent*3, point + normal*(HALF + 6) + tangent*3])
    return _clear_radius(ray, point, HALF + 4)


def probe_slide(p: dict, steps: int = 11) -> dict:
    """The slide travels between its states without touching the base or stop (mm³), and in each state the groove
    walls line up across both slide faces: largest lateral step of either wall 1.2 mm either side of each face."""
    lay, hand = SwitchLayout(*_shape(p)), int(p["hand"])
    rows = dict(component_meshes("monorail_switch", p))
    fixed = _union([m for r, m in rows.items() if r != "mechanism-slide"])
    slide = _manifold(rows["mechanism-slide"])
    worst = max((slide.translate((0., -hand*lay.shift*t, 0.)) ^ fixed).volume() for t in np.linspace(0., 1., steps))
    routes = switch_phases(lay, hand)
    step = {}
    for state, key in enumerate(("straight", "diverging")):
        section = (slide.translate(slide_offset(hand, state, lay.shift)) + fixed).slice(HEIGHT - .3)
        route = routes[state][0]
        largest = 0.
        for face in (lay.x0, lay.x1):
            walls = []
            for x in (face - 1.2, face + 1.2):
                pt, t, n, _ = (a[0, :2] for a in route.frames(x if state == 0 else _branch_station(lay, x)))
                walls.append([_wall_distance(section, pt, n*side, t) for side in (1, -1)])
            largest = max(largest, abs(walls[0][0] - walls[1][0]), abs(walls[0][1] - walls[1][1]))
        step[key] = largest
    return {"travelMm": lay.shift, "maxInterferenceMm3": worst, "grooveWallStepMm": step}


def probes(family: str, p: dict) -> dict:
    """Every probe on one configuration (tests and evidence)."""
    validate(family, p)
    d = float(p["slot_depth"])
    report = {"parts": probe_parts(family, p), "ends": probe_ends(family, p)}
    if family == "monorail_switch":
        lay, hand = SwitchLayout(*_shape(p)), int(p["hand"])
        report["slide"] = probe_slide(p)
        for state, (route, phase) in enumerate(switch_phases(lay, hand)):
            key = ("straight", "diverging")[state]
            meshes = assembled(family, p, state)
            report[f"teeth-{key}"] = {side: phase[s].count for side, s in (("left", 1), ("right", -1))}
            report[f"gear-{key}"] = probe_gear(meshes, route, phase, 1., route.length - 1., d, step=.5)
            report[f"running-{key}"] = probe_running(meshes, route, .5, route.length - .5)
        return report
    route, meshes = route_of(family, p), assembled(family, p)
    if family == "monorail_ramp":
        report["teethPerSide"] = ramp_teeth(p)
    else:
        report["teethPerSide"] = probe_teeth(meshes, route, d)
        report["gear"] = probe_gear(meshes, route, phases(route, d), 1., route.length - 1., d)
    report["running"] = probe_running(meshes, route, .5, route.length - .5)
    return report


def ramp_teeth(p: dict) -> dict:
    """Ramp teeth per side, counted on the unbent beam (station space) the ramp is bent from."""
    route = route_of("monorail_ramp", p)
    flat = _beam(phases(route, float(p["slot_depth"])), 0., route.length, *_shape(p))
    return probe_teeth([_tm(flat)], _straight_route(route.length), float(p["slot_depth"]))

