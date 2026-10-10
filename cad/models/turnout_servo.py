"""SG90 servo drive for point-blade junctions (turnout.py with `servo` = 1); millimetres.

Per switch, a printed throw rod runs square to the tie bar on the spec's servo side (turnout.servo_side:
away from the branch; the editor mirrors the rule). The rod's pin rises into a hole in
the tie bar, which is raised above the rod; the rod runs under the blade on that side (a notch in its
underside) and under the stock rail (a window through the rail foot and stringer, the rail head bridging
it), then along a channel in the servo housing beside the track to a fork. An SG90 lying on its side in
the housing's cradle drives the fork through an M2 pin in its horn. A flat clamp screwed to the tie
beside the window and to the housing's ledge holds the housing to the track and roofs the rod.
The servo holds either position, so no spacer is fitted; servo points are never sprung.

Local plan coordinates of a rod line: `a` along the servo shaft (roughly along the track), `b` along the
rod, outwards from the tie bar's centre at mid-throw.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import math

import manifold3d
import numpy as np
import trimesh

from . import drives
from . import hardware as hw
from . import brick_end as end
from . import track_assembly as ta

HALF = end.PROFILE["bodyWidth"]/2
BASE = end.PROFILE["baseThickness"]
RAIL = end.PROFILE["railGauge"]/2
STRINGER_OUT = RAIL + end.PROFILE["baseStringerWidth"]/2 + .2   # 24.1: tie top clear of the stringer
GAP = .4                       # plan clearance around moving rod parts
ROD_W, ROD_LOW, ROD_HIGH = 3., 1.6, 3.
PIN, PIN_TOP = 2.2, 4.6        # rod pin (square) into the tie bar
HOLE_B, HOLE_A = 2.4, 2.6      # its hole in the bar: 0.1 mm backlash each way along the rod
BAR = (3.4, 5.)                # raised tie bar, above the rod
KNOB = (4.9, 6.2)
WINDOW_TOP = PIN_TOP + .3      # the rod goes in from outside, pin first: the rail head (from 5.0) bridges the window
EDGE = HALF + .4               # housing's inner face
LEDGE_OUT = 41.3               # ledge (clamp seat) outer edge
# Cradle block across the servo frame's y (towards the track = +y when the case lies away from it).
CRADLE_Y = (drives.SG90_SHAFT_INSET - drives.SG90_CASE[0]/2 - drives.SG90_EAR_SPAN/2 - drives.WALL,
            drives.SG90_SHAFT_INSET - drives.SG90_CASE[0]/2 + drives.SG90_EAR_SPAN/2 + drives.WALL)
ROD_A = 4.3                    # rod centre line in the servo frame: 0.4 mm clear of the horn's disc (x <= 2.4)
FORK_A = (2.8, 5.2)            # the rod's slotted fork plate, in the servo frame
FORK_HALF = 4.                 # fork plate either side of the horn pin, along the rod
PIN_RADIUS = 10.               # horn hole used
HORN_PIN = 2.                  # M2 screw through the horn and the fork slot
SLOT = HORN_PIN + .2
FORK_TOP = drives.SG90_SHAFT_Z + PIN_RADIUS + 2.6
HEIGHT = max(FORK_TOP, drives.SG90_HEIGHT, drives.SG90_SHAFT_Z + drives.SG90_HORN_REACH + 1.)   # tallest servo part
GUIDE_WALL = 2.
CLAMP = (BASE, BASE + 2.)
POST_PILOT, SCREW_CLEAR = 1.3, 1.65
HORN_ANGLE = math.radians(20)


def _t():
    from . import turnout
    return turnout


@dataclass(frozen=True)
class RodLine:
    switch: int
    u: tuple          # unit, outwards along the rod
    a: tuple          # unit, along the servo shaft
    centre: tuple     # b = 0: the rod line level with the outer route's centre line at the tie bar
    mid: tuple        # tie bar centre at mid-throw (the rod moves with it)
    blade: int        # the blade the rod passes under
    hole: float       # b of the bar hole
    tip: float        # b of the rod's inner end
    fork: float       # b of the horn pin (servo shaft line)
    away: bool        # servo case lies away from the track (else towards it)
    frame: tuple      # servo frame (4x4, rows)

    def world(self, a, b):
        """Piece-frame plan points of local (a, b) rows."""
        a, b = np.atleast_1d(a), np.atleast_1d(b)
        return np.asarray(self.centre) + np.outer(a, self.a) + np.outer(b, self.u)

    def rect(self, a0, a1, b0, b1):
        return ta._section(self.world([a0, a1, a1, a0], [b0, b0, b1, b1]))

    def prism(self, a0, a1, b0, b1, z0, z1):
        return _t()._prism(self.rect(a0, a1, b0, b1), z0, z1)

    @property
    def servo_frame(self):
        return np.asarray(self.frame)


def _fork(away: bool) -> float:
    """Horn pin distance: the cradle's track-side face clears the ledge by 0.5 mm."""
    return LEDGE_OUT + .5 + (CRADLE_Y[1] if away else -CRADLE_Y[0])


def _frame(centre, u, a, fork, away):
    """Servo frame: origin on the table under the horn pin's line, +x along the shaft (= local a)."""
    origin = np.asarray(centre) + np.asarray(u)*fork - np.asarray(a)*ROD_A
    frame = np.eye(4)
    frame[:2, 0], frame[:2, 1], frame[:2, 3] = a, (-1 if away else 1)*np.asarray(u), origin
    return frame


def cradle_inner(line) -> float:
    """b of the cradle block's track-side face."""
    return line.fork - (CRADLE_Y[1] if line.away else -CRADLE_Y[0])


def _footprint(spec) -> manifold3d.CrossSection:
    """The junction's body grown by the housing clearance."""
    t = _t()
    return t._union_cs([ta._band(t.route_path(spec, r.id), EDGE) for r in spec.routes])


def _guide(spec, line: RodLine, end: float) -> manifold3d.CrossSection:
    """The rod guide's plan from the body edge (which may curve away from the rod line) to `end`."""
    wall = ROD_W/2 + GAP + GUIDE_WALL
    return max(_t()._parts(line.rect(-wall, wall, EDGE - 3., end) - _footprint(spec)), key=lambda part: part.area())


def _housing_plan(spec, line: RodLine) -> manifold3d.CrossSection:
    """Plan of the cradle, rod guide and the plate joining them (the ledge follows the body edge later)."""
    cradle = drives.sg90_cradle(line.servo_frame, pin_radius=PIN_RADIUS, angle=HORN_ANGLE).keepout
    wall = ROD_W/2 + GAP + GUIDE_WALL
    return cradle + _guide(spec, line, line.fork + FORK_HALF + 2) + \
        line.rect(-ROD_A - drives.SG90_HORN_PLANE - 1, wall, cradle_inner(line) - .5, line.fork)


def _room(spec, plan) -> str | None:
    t = _t()
    for route in spec.routes:
        if ta._overlaps(plan, ta._band(t.route_path(spec, route.id), HALF)):
            return f"route {route.id}"
    for port in spec.ports:
        normal = np.array([math.cos(port.heading), math.sin(port.heading)])
        if np.max((t._vertices(plan) - (port.x, port.y)) @ normal) > -1.:
            return f"port {port.id}"
    return None


def rod_line(spec, pts) -> RodLine:
    """The rod line of one switch on the spec's servo side; the servo case away from the track if it has room there."""
    t = _t()
    mid = np.asarray(pts.knob(.5), float)
    routes = [t._at(blade.path, pts.bar)[0, :2] for blade in pts.blades]
    blocked = []
    u = np.asarray(pts.direction, float)/np.linalg.norm(pts.direction)
    if u[1]*spec.servo < 0:
        u = -u
    for away in (True, False):
        # Local a follows the servo shaft: a right-handed servo frame with z up and y = -u (case away) or +u.
        a = np.array([-u[1], u[0]])*(1 if away else -1)
        # b = 0 on the outer of the two routes' centre lines at the tie bar, so the body edge is at b = HALF.
        centre = mid + u*max(float((point - mid) @ u) for point in routes)
        bar = pts.bar_outline(.5)
        reach = float(np.max((bar - centre) @ u))
        blade = max((0, 1), key=lambda i: float(np.mean((pts.blade_outline(i, .5) - centre) @ u)))
        hole, fork = reach - 3.6, _fork(away)
        line = RodLine(pts.index, tuple(u), tuple(a), tuple(centre), tuple(mid), blade, hole, hole - PIN/2 - 1.5,
                       fork, away, tuple(map(tuple, _frame(centre, u, a, fork, away))))
        problem = _room(spec, _housing_plan(spec, line))
        if problem is None:
            return line
        blocked.append(problem)
    raise ValueError(f"switch {pts.index+1}: no room for its servo housing beside the track ({' / '.join(blocked)})")


# ------------------------------------------------------------------ mount on the fixed base
@dataclass(frozen=True)
class Mount:
    line: RodLine
    pad: object           # CrossSection: tie top under the clamp
    clamp: object         # CrossSection
    ledge: object         # CrossSection
    pad_screws: tuple
    ledge_screws: tuple
    corridor: object      # CrossSection: window and trench through the base


PAD = (1.4, 13.4)     # clamp pad along the track, from the window's edge (a beyond the channel)
PAD_SCREWS = (4.4, 10.4)


def _pad(lay, line: RodLine):
    """A solid pad of the base beside the window, between the stringer and the body edge, on the side away from the
    toe if it has room (clear of every stringer and the points floor), with its two clamp-screw pilots."""
    t = _t()
    spec, channel = lay.spec, ROD_W/2 + GAP
    keep_off = t._union_cs([ta._band(t.route_path(spec, r.id), STRINGER_OUT) for r in spec.routes] +
                           [lay.floor.offset(.5, manifold3d.JoinType.Round)])
    body = t._union_cs([ta._band(t.route_path(spec, r.id), HALF) for r in spec.routes])
    port = next(p for p in spec.ports if p.id == spec.switches[line.switch].port)
    heel = 1. if (np.asarray(line.centre) - (port.x, port.y)) @ np.asarray(line.a) >= 0 else -1.
    for side in (heel, -heel):
        a0, a1 = sorted((side*(channel + PAD[0]), side*(channel + PAD[1])))
        parts = t._parts((line.rect(a0, a1, STRINGER_OUT - 3., HALF + 1.) ^ body) - keep_off)
        if not parts:
            continue
        pad = max(parts, key=lambda part: part.area())
        screws = tuple(tuple(line.world(side*(channel + x), (STRINGER_OUT + HALF)/2)[0]) for x in PAD_SCREWS)
        seat = pad.offset(-POST_PILOT - 1., manifold3d.JoinType.Round)
        if all(ta._overlaps(seat, manifold3d.CrossSection.circle(.05, 8).translate(xy)) for xy in screws):
            return pad, screws
    raise ValueError(f"switch {line.switch+1}: no room beside the servo window for the clamp's pad")


def build_mounts(lay) -> tuple:
    """Every switch's mount, from a layout whose ties are placed (Layout keeps them as `servo_mounts`)."""
    t = _t()
    spec = lay.spec
    rows = []
    for pts in t.points_of(spec):
        line = pts.rod
        pad, pad_screws = _pad(lay, line)
        along = t._vertices(pad) - line.centre
        a0, a1 = float(np.min(along @ line.a)), float(np.max(along @ line.a))
        channel = ROD_W/2 + GAP
        a0, a1 = min(a0, -channel - 9.), max(a1, channel + 9.)
        # The ledge follows the body edge where the track curves away from the rod line.
        ledge = max(t._parts(line.rect(a0, a1, EDGE - 3., LEDGE_OUT) - _footprint(spec)), key=lambda part: part.area())
        keep_off = t._union_cs([ta._band(t.route_path(spec, r.id), STRINGER_OUT) for r in spec.routes])
        clamp = max(t._parts(manifold3d.CrossSection.batch_hull([pad, ledge]) - keep_off), key=lambda part: part.area())
        # Ledge screws beside the channel, towards both ends of the ledge, 2.6 mm inside it.
        seat = ledge.offset(-2.6, manifold3d.JoinType.Round)
        ledge_screws = []
        for start, step in ((a0 + 4., 1.), (a1 - 4., -1.)):
            x = start
            while not ta._overlaps(seat, manifold3d.CrossSection.circle(.05, 8).translate(tuple(line.world(x, (EDGE + LEDGE_OUT)/2)[0]))):
                x += step
                if abs(x) < channel + SCREW_CLEAR + 1.:
                    raise ValueError(f"switch {line.switch+1}: no room on the servo housing's ledge for its clamp screws")
            ledge_screws.append(tuple(line.world(x, (EDGE + LEDGE_OUT)/2)[0]))
        corridor = line.rect(-channel, channel, line.tip - 1.4 - GAP, EDGE + 3.)
        problem = _room(spec, ledge.offset(-.05, manifold3d.JoinType.Miter) + _housing_plan(spec, line))
        if problem:
            raise ValueError(f"switch {line.switch+1}: the servo housing meets {problem}")
        rows.append(Mount(line, pad, clamp, ledge, pad_screws, tuple(ledge_screws), corridor))
    return tuple(rows)


def mounts(spec) -> tuple:
    return _t().layout(spec).servo_mounts


def mechanism_zones(mounts) -> manifold3d.CrossSection:
    """Plan zones seams and clutch keep off: the windows, clamps and tie pads."""
    return _t()._union_cs([zone for mount in mounts for zone in (mount.corridor, mount.clamp, mount.pad)])


def base_fill(spec) -> list:
    """Solid tie pads and window floors (fills hollow stringers and clutch-free pads; lite has no outer ties)."""
    t = _t()
    # The pad stands 0.2 mm clear of the stringer band; grown 0.6 mm it joins the stringer (fast print has no outer ties).
    body = t._union_cs([ta._band(t.route_path(spec, r.id), HALF) for r in spec.routes])
    return [t._prism((mount.pad.offset(.6, manifold3d.JoinType.Miter) ^ body) + (mount.corridor - t.layout(spec).slot), 0., BASE)
            for mount in mounts(spec)]


def drop_slivers(body: trimesh.Trimesh) -> trimesh.Trimesh:
    """The window may leave a hairline sliver between its edge and the points slot over a clutch roof (a wye's tilted
    rod line); slivers under 1 mm\u00b3 are dropped so every base tile stays one solid."""
    parts = body.split(only_watertight=False)
    kept = [part for part in parts if abs(part.volume) >= 1.]
    return body if len(kept) == len(parts) else ta._union(kept)


def base_cuts(spec) -> list:
    t = _t()
    cuts = []
    for mount in mounts(spec):
        outer = mount.clamp - t._union_cs([ta._band(t.route_path(spec, r.id), STRINGER_OUT - .2) for r in spec.routes])
        cuts += [t._prism(mount.corridor, t.FLOOR, WINDOW_TOP), t._prism(outer, BASE, BASE + 4.)]
        cuts += [end._cylinder(POST_PILOT, -.1, BASE + .1, *xy) for xy in mount.pad_screws]
    return cuts


# ------------------------------------------------------------------ moving parts
def bar_mesh(pts, position):
    """The raised tie bar and knob, with the rod pin's hole."""
    t = _t()
    line = pts.rod
    bar = t._prism(t._section(pts.bar_outline(position)), *BAR)
    knob = end._cylinder(2., *KNOB, *pts.knob(position))
    shift = np.asarray(pts.knob(position)) - np.asarray(line.mid)
    hole = line.prism(-HOLE_A/2, HOLE_A/2, line.hole - HOLE_B/2, line.hole + HOLE_B/2, BAR[0] - .1, KNOB[1] + .1)
    hole.apply_translation((*shift, 0))
    return ta._difference(ta._union([bar, knob]), [hole])


def notch(pts, position):
    """The rod's room under the blade it passes, moving with the bar."""
    line = pts.rod
    cut = line.prism(-ROD_W/2 - .3, ROD_W/2 + .3, line.tip - .3, EDGE, _t().MOVE_LOW - .1, ROD_HIGH + .35)
    cut.apply_translation((*(np.asarray(pts.knob(position)) - np.asarray(line.mid)), 0))
    return cut


def rod_mesh(pts, position) -> trimesh.Trimesh:
    """The throw rod (printed on its underside) where the bar holds it at `position`; it goes in from outside, pin
    first, under the stock rail, so its fork stays outside."""
    line = pts.rod
    body = line.prism(-ROD_W/2, ROD_W/2, line.tip, line.fork + FORK_HALF, ROD_LOW, ROD_HIGH)
    pin = line.prism(-PIN/2, PIN/2, line.hole - PIN/2, line.hole + PIN/2, ROD_HIGH - .1, PIN_TOP)
    a0, a1 = FORK_A[0] - ROD_A, FORK_A[1] - ROD_A
    fork = line.prism(a0, a1, line.fork - FORK_HALF, line.fork + FORK_HALF, ROD_LOW, FORK_TOP)
    pin_z = drives.SG90_SHAFT_Z + PIN_RADIUS
    slot = line.prism(a0 - .1, a1 + .1, line.fork - SLOT/2, line.fork + SLOT/2, pin_z - 1.8, pin_z + 1.8)
    rod = ta._difference(ta._union([body, pin, fork]), [slot])
    return rod.apply_translation((*(np.asarray(pts.knob(position)) - np.asarray(line.mid)), 0))


# ------------------------------------------------------------------ housing and clamp
@lru_cache(maxsize=16)
def housing_mesh(spec, switch: int) -> trimesh.Trimesh:
    t = _t()
    mount = mounts(spec)[switch]
    line = mount.line
    cradle = drives.sg90_cradle(line.servo_frame, pin_radius=PIN_RADIUS, angle=HORN_ANGLE)
    channel = ROD_W/2 + GAP
    guide_end = line.fork - FORK_HALF - 1.2 - .8
    wall = channel + GUIDE_WALL
    # The cradle's inner face (frame y max) back from the fork.
    inner = cradle_inner(line)
    a_back = -ROD_A - drives.SG90_HORN_PLANE      # the cradle's front face, in local a
    solids = [t._prism(mount.ledge, 0., BASE), t._prism(_guide(spec, line, guide_end), 0., BASE),
              line.prism(a_back - 1., wall, inner - .5, guide_end, 0., drives.FLOOR), *cradle.additions]
    cuts = [line.prism(-channel, channel, EDGE - 1., guide_end + 1., t.FLOOR, 40.), *cradle.cuts]
    cuts += [end._cylinder(POST_PILOT, -.1, BASE + .1, *xy) for xy in mount.ledge_screws]
    return ta._difference(ta._union(solids), cuts)


@lru_cache(maxsize=16)
def clamp_mesh(spec, switch: int) -> trimesh.Trimesh:
    t = _t()
    mount = mounts(spec)[switch]
    holes = [end._cylinder(SCREW_CLEAR, CLAMP[0] - .1, CLAMP[1] + .1, *xy) for xy in (*mount.pad_screws, *mount.ledge_screws)]
    return ta._difference(t._prism(mount.clamp, *CLAMP), holes)


def components(spec) -> list:
    """(role, mesh) rows of every switch's servo parts (the rod printed at mid-throw)."""
    rows = []
    for pts in _t().points_of(spec):
        i = pts.index
        # `mechanism-` roles print with the detailed process even on fast junctions (plates.MECHANISM_ROLE).
        rows += [(f"mechanism-servo-rod-{i+1}", rod_mesh(pts, .5)), (f"mechanism-servo-housing-{i+1}", housing_mesh(spec, i)),
                 (f"mechanism-servo-clamp-{i+1}", clamp_mesh(spec, i))]
    return rows


def moving(pts, position) -> list:
    """The servo's moving parts where the bar holds them."""
    return [rod_mesh(pts, position)]


def stationary(spec, switch: int) -> list:
    """Housing, clamp and the clamp's four M3 x 4 screws (shank and head) as fitted."""
    mount = mounts(spec)[switch]
    screws = [ta._union([end._cylinder(1.5, CLAMP[1] - 4., CLAMP[1], *xy), end._cylinder(2.8, CLAMP[1], CLAMP[1] + 1.7, *xy)])
              for xy in (*mount.pad_screws, *mount.ledge_screws)]
    return [housing_mesh(spec, switch), clamp_mesh(spec, switch), *screws]


def envelope(spec, switch: int) -> np.ndarray:
    """Convex plan envelope of the switch's servo, housing, clamp and rod travel."""
    t = _t()
    pts = t.points_of(spec)[switch]
    mount = mounts(spec)[switch]
    cradle = drives.sg90_cradle(mount.line.servo_frame, pin_radius=PIN_RADIUS, angle=HORN_ANGLE).keepout
    meshes = [*stationary(spec, switch), *moving(pts, 0.), *moving(pts, 1.)]
    points = np.vstack([t._vertices(cradle), *[mesh.vertices[:, :2] for mesh in meshes]])
    return t._hull(points)


def editor_zone(spec, switch: int) -> manifold3d.CrossSection:
    """The editor's servo zone (TS servoZone): along the position-0 route from 32 mm before to 44 mm past the first
    1 mm parting, out to 82 mm on the servo side, clipped at the toe."""
    pts = _t().points_of(spec)[switch]
    a, b = (blade.path for blade in pts.blades)
    n = min(len(a), len(b))
    parted = np.flatnonzero(np.linalg.norm(a[:n, :2] - b[:n, :2], axis=1) >= 1.)
    x, y, h = a[parted[0] if len(parted) else n - 1]
    t, normal = np.array([math.cos(h), math.sin(h)]), np.array([-math.sin(h), math.cos(h)])*spec.servo
    rect = [np.array([x, y]) + t*along + normal*lateral for along, lateral in ((-32, 0), (44, 0), (44, 82), (-32, 82))]
    zone = manifold3d.CrossSection.hull_points([tuple(p) for p in rect])
    toe, inward = a[0, :2], np.array([math.cos(a[0, 2]), math.sin(a[0, 2])])
    keep = manifold3d.CrossSection.square((400., 400.)).translate((0., -200.))
    angle = math.degrees(math.atan2(inward[1], inward[0]))
    return zone ^ keep.rotate(angle).translate(tuple(toe))


# ------------------------------------------------------------------ notes, hardware, probes
def hardware(spec) -> list:
    n = len(spec.switches)
    return [hw.row(hw.SERVO, n, hw.ELECTRONICS),
            hw.row(hw.M2_HORN_PIN, n, hw.FASTENERS),
            hw.m3_screw(4, 4*n)]


def notes(spec) -> list:
    angle = math.degrees(servo_angle(spec)[0])
    return ["Servo: before fitting the points, slide each throw rod in from outside, pin up and first, through the "
            "window under the stock rail; lower the points so the rod's pin enters the hole in the tie bar.",
            "Centre each SG90 (90°) and fit its single-arm horn pointing straight up; lay the servo on its side in the "
            "housing's cradle, ears in their slots and cable out through the back wall, and fix both ears with the "
            "servo's own M2 screws.",
            f"Lower the housing beside the track with the rod in its channel, put an M2 x 8 screw through the horn's "
            f"{PIN_RADIUS:g} mm hole and the rod's fork slot, nut behind, and screw the clamp over the tie and the "
            "housing's ledge with four M3 x 4 self-tapping screws.",
            f"Drive each servo about ±{angle:.0f}° either side of centre; trim each end in the servo controller's "
            "software until the closed blade just touches its stock rail. The servo holds the set position, so no "
            "spacer is used."]


def servo_angle(spec) -> list:
    """Horn angle either side of centre for each switch: the bar's travel plus the pin backlash."""
    out = []
    for pts in _t().points_of(spec):
        travel = abs(float((np.asarray(pts.knob(1.)) - np.asarray(pts.knob(0.))) @ np.asarray(pts.rod.u)))
        backlash = (HOLE_B - PIN)/2 + (SLOT - HORN_PIN)/2
        out.append(drives.sg90_angle_for(travel/2 + backlash, PIN_RADIUS))
    return out


def _overlap(a, b):
    return abs(trimesh.boolean.intersection([a, b], engine="manifold").volume)


def probes(spec, adjustment: float = 0., lite: bool = False) -> list:
    """Servo drive evidence per switch: motion, coupling, retention, cradle fit, horn travel and alignment."""
    t = _t()
    fixed = t._fixed_mesh(spec, adjustment, lite)
    report = []
    for pts, angle in zip(t.points_of(spec), servo_angle(spec)):
        i, line = pts.index, pts.rod
        housing, clamp, *screws = stationary(spec, i)
        frame = line.servo_frame
        case = ta._union(drives.sg90_case(frame))
        horn = drives.sg90_horn_sweep(frame, PIN_RADIUS, angle)
        keepers = [t.keeper_mesh(pts, 0), t.keeper_mesh(pts, 1)]
        fitted = ta._union([fixed, housing, clamp, *screws, *keepers])
        motion = max(_overlap(ta._union([t.points_mesh(pts, p), *moving(pts, p)]), fitted) for p in np.linspace(0, 1, 7))
        rod_clear = max(_overlap(rod_mesh(pts, p), t.points_mesh(pts, p)) for p in (0., .5, 1.))
        # Assembly: the rod slides in from outside, pin first, under the stock rail before the points go in.
        travel = EDGE + 3. - line.tip + 1.
        insertion = max(_overlap(rod_mesh(pts, .5).apply_translation((*(np.asarray(line.u)*d), 0)), fixed)
                        for d in np.linspace(0., travel, 12))
        lifted = rod_mesh(pts, .5).apply_translation((0, 0, .6))
        uplift = _overlap(lifted, ta._union([fixed, clamp, t.points_mesh(pts, .5)]))
        # Pin engagement: the pin's length inside the bar's thickness, and its clearance to the hole walls.
        engaged = PIN_TOP - BAR[0]
        cradle = _overlap(case, housing)
        horn_clear = max(_overlap(horn, ta._union([housing, clamp, fixed, *moving(pts, p)])) for p in (0., 1.))
        # Horn pin position at each end vs the slot centre, with the backlash taken up.
        ends = []
        for position in (0., 1.):
            slot_b = line.fork + float((np.asarray(pts.knob(position)) - np.asarray(line.mid)) @ np.asarray(line.u))
            y, dz = drives.sg90_pin_travel(PIN_RADIUS, angle)
            pin_b = line.fork + math.copysign(y, slot_b - line.fork)
            ends.append({"position": int(position), "slotB": round(slot_b, 3), "pinB": round(pin_b, 3),
                         "seatedBacklashMm": round(abs(pin_b - slot_b), 3), "pinDropMm": round(-dz, 3)})
        if motion > .01 or rod_clear > .01 or horn_clear > .01 or cradle > .01 or insertion > .01:
            raise ValueError(f"switch {i+1}: servo drive interferes (motion {motion:.4f}, rod {rod_clear:.4f}, "
                             f"horn {horn_clear:.4f}, cradle {cradle:.4f}, insertion {insertion:.4f} mm^3)")
        if uplift < .01:
            raise ValueError(f"switch {i+1}: the throw rod can lift out")
        if any(row["seatedBacklashMm"] > (HOLE_B - PIN)/2 + (SLOT - HORN_PIN)/2 + .01 for row in ends):
            raise ValueError(f"switch {i+1}: horn travel does not reach both blade positions")
        outside = (manifold3d.CrossSection.hull_points([tuple(p) for p in envelope(spec, i)]) - editor_zone(spec, i)).area()
        if outside > .01:
            raise ValueError(f"switch {i+1}: the servo leaves the editor's servo zone by {outside:.3f} mm^2")
        report.append({"switch": i+1, "side": "left" if spec.servo > 0 else "right", "case": "away" if line.away else "towards",
                       "outsideEditorZoneMm2": outside,
                       "hornAngleDeg": round(math.degrees(angle), 2), "motionInterferenceMm3": motion,
                       "rodToPointsMm3": rod_clear, "hornSweepMm3": horn_clear, "caseInCradleMm3": cradle,
                       "rodInsertionMm3": insertion,
                       "rodUpliftBlockedMm3": round(uplift, 3), "pinEngagementMm": round(engaged, 3), "ends": ends,
                       "physicalFit": "not_checked"})
    return report
