"""Moving spans and the train elevator (Wave 4 mechanisms); millimetres, piece frame.

Every family is a straight assembly from port ``in`` (x = 0) to ``out`` (x = L). Two fixed
landing tiles (48 mm composite straights: brick connector outside, plain cut inside) flank a
moving deck that is ``span`` long between the landing ends, less a rail gap at each end. The
printed parts are the same in every state; ``state`` only selects which route is open
(matches src/domain/pieces/families/moving-bridges.ts).

- bridge_lift_out: the deck lifts out. Each deck corner is a saddle (two walls and a roof)
  that drops over a seat post on the landing: the walls centre it across the track, a cone
  on the post through the roof locates it along the track, a 6 x 3 mm magnet pair holds it.
- bridge_drop_leaf: hinged at ``in`` on two M3 screws above rail level (every leaf point stays
  on the deck side as it rises), saddle-seated at ``out``. A tooth on each leaf knuckle lands
  on a stop block just past vertical, so the raised leaf leans back and stays up. Hinged leaves
  (and the bascule) end in an arc about the hinge, matched by the out landing's end.
- bridge_bascule: trunnion on two cross axles in towers on the ``in`` landing; side
  arms carry the leaf, two bolt-on counterweight arms (printed on their side) hold steel
  weights; saddle-seated at ``out``. drive 1 adds a Bluetooth motor plate, drive 2 the same plate
  for an infrared L motor (drives.py).
- bridge_swing: the deck turns 90 degrees about a printed pivot pin on a two-piece keyed floor.
  Its ends and the landing ends are arcs about the pivot. Closing, its pony girders meet a
  stop block at each end; a magnet pair in each stop face holds it closed.
- bridge_lift and train_elevator: four posts at the deck corners carry the deck's shoes;
  landings are pinned to the posts by collars at every level, the deck by M3 index pins.
  The posts print on their side (``side_on``), split with pinned tenons above 156 mm. drive 1 adds an M8
  lead screw: a beam on the left posts holds its 608 bearing and crank, the deck rides on its nut.

Probes: rail-end alignment at every aligned state (measured on the meshes, plus the play the
guides allow), swept motion against every fixed part, retention (what stops each direction)
and the published plan envelopes.
"""
from __future__ import annotations

from functools import lru_cache
import math
from pathlib import Path

import cadquery as cq
import manifold3d
import numpy as np
import trimesh

from . import composite
from . import drives
from . import hardware as hw
from . import brick_end as end
from . import lite as fast
from . import track_assembly as ta

# ------------------------------------------------------------------ constants
HALF = end.PROFILE["bodyWidth"]/2            # 31.9
RAIL = end.PROFILE["railGauge"]/2            # 20
TOP = end.RAIL_TOP                           # 9.6
SLAB = 4.9                                   # deck top: tie-stud height, below every flange (6.4)
LANDING = 48.                                # landing tile length
GAP = .6                                     # rail-end gap, deck to landing
CLEAR = .25                                  # guide clearance (walls, shoes)
BED = 166.                                   # usable A1 mini bed
MAG_R, MAG_D = 3.15, 3.2                     # 6 x 3 mm magnet pocket
PIN_R, PILOT_R = 1.6, 1.25                   # M3 clearance / self-tapping pilot
# Saddle seat: post (landing) and saddle (deck), lateral offsets from the centre line.
SEAT, ROOF = 4., 3.6
P0, P1 = HALF + 3., HALF + 12.               # seat post band
WALL = 2.4
POST_REACH, ARM = 14., 10.
SADDLE = 16.
CONE_R, CONE_TIP, CONE_H = 2., .4, 3.
CONE_U, MAG_U = 4.5, 10.5                    # along the track from the landing end
CONE_CLEAR = .15
# Drop-leaf hinge.
HINGE_Z = 12.
LEAF_PLANE, KNUCKLE_PLANE = (HALF + .4, HALF + 3.5), (HALF + 3.9, HALF + 7.9)
KNUCKLE_R, TOOTH_HALF, TOOTH_TOP = 5., 2.2, 9.
# Bascule.
TRUNNION_Z = 36.
ARM_PLANE, CW_PLANE, TOWER_PLANE = (HALF + .4, HALF + 3.5), (HALF + 3.7, HALF + 6.9), (HALF + 7.3, HALF + 11.3)
TRUNNION_R, CW_LENGTH, CW_BOX = 7., 26., (16., 9.)
BASCULE_UP = math.radians(80.)
# Swing bridge.
SWING_GAP = .8
FLOOR = 2.
SWING_LOW = 2.3
GIRDER = (HALF + .4, HALF + 6.8)
PIVOT_R, PIVOT_TOP, PIVOT_CLEAR, PIVOT_PAD = 4., 4.6, .15, 12.
STOP_DEPTH, STOP_HALF, STOP_TOP, STOP_MAG_Z = 5.8, 6., 9., 6.
SEAM_OFFSET, DOVETAIL = 14., (6., 10., 6.)   # floor seam past the pivot; key neck, mouth, depth
# Vertical lift (lift bridge, elevator).
POST = (HALF + 4.1, HALF + 14.1)             # post band (10 mm square)
POST_HALF = 5.
SHOE_BACK, SHOE_OUT = 2.7, 3.
PIN_Z = 4.8
SEGMENT = 156.
TENON = (2.5, 8.)
# Lead-screw drive (lift bridge, elevator): an M8 rod hangs from a 608 bearing in a beam across the left posts'
# tops; the deck's boss rides on an M8 nut. Rod off the left posts, boss clear above the top level, socket depth.
SCREW_Y, SCREW_HEADROOM, SOCKET = HALF + 26.1, 20., 8.
BOSS = (10., 18.)                            # boss half-length along the track, height
NUT_AF, NUT_H, ROD_R = 13.2, 6.8, 4.4         # M8 nut pocket (across flats, depth), rod clearance
BEARING = (11.05, 7.)                         # 608 pocket radius, depth
BEAM_H = 10.
CRANK = (10., 40., 4., 30.)                   # hub radius, arm reach, handle radius, handle height

FAMILIES = ("bridge_lift_out", "bridge_drop_leaf", "bridge_bascule", "bridge_swing", "bridge_lift", "train_elevator")
COMPONENT_FAMILY = "moving_bridge_component"
STATES = {"bridge_lift_out": ("in", "out"), "bridge_drop_leaf": ("down", "up"), "bridge_bascule": ("down", "up"),
          "bridge_swing": ("closed", "open"), "bridge_lift": ("down", "up"),
          "train_elevator": ("level-1", "level-2", "level-3", "level-4")}
SHAPES = {"bridge_lift_out": ("span",), "bridge_drop_leaf": ("span",), "bridge_bascule": ("span", "drive"),
          "bridge_swing": ("span",), "bridge_lift": ("span", "lift", "drive"),
          "train_elevator": ("span", "levels", "level_height", "drive")}
SPANS = {"bridge_lift_out": (64, 160), "bridge_drop_leaf": (64, 160), "bridge_bascule": (96, 160),
         "bridge_swing": (144, 160), "bridge_lift": (96, 160), "train_elevator": (128, 160)}
CONNECTOR = frozenset({"connector_version", "fit_adjustment"})
LOGICAL = frozenset({"state"})
SOURCE_DEPENDENCIES = [Path(composite.__file__), Path(ta.__file__), Path(drives.__file__), Path(fast.__file__),
                       Path(end.__file__)]


# ------------------------------------------------------------------ validation
def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _integer(p, key, low, high):
    value = p[key]
    if not _number(value) or value != int(value) or not low <= value <= high:
        raise ValueError(f"{key} must be an integer from {low} to {high}")
    return int(value)


def validate(family: str, p: dict) -> None:
    if family not in FAMILIES:
        raise ValueError("unsupported moving bridge family")
    expected = CONNECTOR | LOGICAL | set(SHAPES[family])
    if set(p) - {"lite"} != expected:
        raise ValueError(f"{family} requires exactly {sorted(expected)}")
    if not all(_number(p[key]) for key in expected):
        raise ValueError("moving bridge parameters must be finite numbers")
    end.validate(p)
    if "lite" in p:
        fast.validate(p)
    low, high = SPANS[family]
    span = p["span"]
    if span != int(span) or span % 8 or not low <= span <= high:
        raise ValueError(f"span must be a multiple of 8 from {low} to {high} mm")
    if family in ("bridge_bascule", "bridge_lift", "train_elevator"):
        _integer(p, "drive", 0, 2 if family == "bridge_bascule" else 1)
    if family == "bridge_lift":
        lift = p["lift"]
        if lift % 8 or not 64 <= lift <= 128:
            raise ValueError("lift must be a multiple of 8 from 64 to 128 mm")
    levels = 1
    if family == "train_elevator":
        levels = _integer(p, "levels", 2, 4)
        height = p["level_height"]
        if height % 8 or not 96 <= height <= 160:
            raise ValueError("level_height must be a multiple of 8 from 96 to 160 mm")
    states = levels if family == "train_elevator" else len(STATES[family])
    _integer(p, "state", 0, states - 1)


def length(family: str, p: dict) -> float:
    return 2*LANDING + float(p["span"])


def levels(family: str, p: dict) -> list[float]:
    """Heights of the landing levels (elevator: every level; others: ground only)."""
    if family == "train_elevator":
        return [k*float(p["level_height"]) for k in range(int(p["levels"]))]
    return [0.]


def ports(family: str, p: dict) -> list[dict]:
    validate(family, p)
    total = length(family, p)
    rows = []
    for index, z in enumerate(levels(family, p)):
        suffix = "" if index == 0 else f"-{index+1}"
        for ident, x, heading in ((f"in{suffix}", 0., math.pi), (f"out{suffix}", total, 0.)):
            rows.append({"id": ident, "position": [x, 0., z], "heading": heading, "pitch": 0.,
                         "rail_gauge": 2*RAIL, "rail_interface_width": end.PROFILE["railInterfaceWidth"]})
    return rows


def route_pairs(family: str, p: dict) -> dict[frozenset, bool]:
    validate(family, p)
    state = int(p["state"])
    if family == "train_elevator":
        return {frozenset((f"in{'' if k == 0 else f'-{k+1}'}", f"out{'' if k == 0 else f'-{k+1}'}")): k == state
                for k in range(int(p["levels"]))}
    return {frozenset(("in", "out")): state == 0}


# ------------------------------------------------------------------ primitives
def _box(x0, x1, y0, y1, z0, z1):
    return end._box((min(x0, x1), min(y0, y1), z0), (max(x0, x1), max(y0, y1), z1))


def _side(s, a, b):
    return (s*a, s*b) if s > 0 else (s*b, s*a)


def _frustum(r0, r1, z0, z1, x, y, sections=64):
    mesh = manifold3d.Manifold.cylinder(z1 - z0, r0, r1, sections).to_mesh()
    solid = trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=True)
    solid.apply_translation((x, y, z0))
    return solid


def _y_cylinder(radius, y0, y1, x, z, sections=48):
    mesh = trimesh.creation.cylinder(radius=radius, height=abs(y1 - y0), sections=sections)
    mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi/2, (1, 0, 0)))
    mesh.apply_translation((x, (y0 + y1)/2, z))
    return mesh


def _xz_prism(points, y0, y1):
    """A polygon in the x-z plane extruded across y0..y1."""
    section = manifold3d.CrossSection([np.asarray(points, float).tolist()], manifold3d.FillRule.EvenOdd)
    mesh = section.extrude(abs(y1 - y0)).to_mesh()
    solid = trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=True)
    # Section (x, z) extruded along +y from min(y0, y1).
    # Swapping two axes mirrors the solid: reverse the faces to keep them outward.
    return trimesh.Trimesh(np.column_stack([solid.vertices[:, 0], solid.vertices[:, 2] + min(y0, y1), solid.vertices[:, 1]]),
                           solid.faces[:, ::-1], process=True)


def _circle(cx, cz, r, n=48, start=0., stop=2*math.pi):
    return [(cx + r*math.cos(a), cz + r*math.sin(a)) for a in np.linspace(start, stop, n, endpoint=False)]


def _hull_xz(points):
    hull = manifold3d.CrossSection.hull_points(np.asarray(points, float).tolist())
    return np.vstack([np.asarray(polygon) for polygon in hull.to_polygons()])


def _rot_y(theta, origin):
    """Rotate about the y axis through `origin` (x, z), raising +x for theta > 0."""
    x0, z0 = origin
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, 0, -s, x0 - c*x0 + s*z0], [0, 1, 0, 0], [s, 0, c, z0 - s*x0 - c*z0], [0, 0, 0, 1]])


def _rot_z(theta, origin):
    x0, y0 = origin
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, -s, 0, x0 - c*x0 + s*y0], [s, c, 0, y0 - s*x0 - c*y0], [0, 0, 1, 0], [0, 0, 0, 1]])


def _moved(mesh, matrix):
    return mesh.copy().apply_transform(matrix)


# ------------------------------------------------------------------ shared parts
def _shared(p):
    keys = {"connector_version": p["connector_version"], "fit_adjustment": p["fit_adjustment"],
            "body_width": end.PROFILE["bodyWidth"], "base_thickness": end.PROFILE["baseThickness"],
            "rail_gauge": end.PROFILE["railGauge"], "rail_interface_width": end.PROFILE["railInterfaceWidth"],
            "rail_height": end.PROFILE["railHeight"]}
    if "lite" in p:
        keys["lite"] = 1
    return keys


@lru_cache(maxsize=32)
def _landing_cached(run: float, outer_start: bool, adjustment: float, lite: bool, connector: int):
    p = {"connector_version": connector, "fit_adjustment": adjustment, **({"lite": 1} if lite else {})}
    return composite.track_mesh(composite.straight(_shared(p), run, ends=1 if outer_start else 2))


def landing(p, x0: float, run: float, outer_start: bool, z: float = 0.):
    """A plain composite straight `run` long from x0; its brick connector faces outward."""
    mesh = _landing_cached(float(run), outer_start, float(p["fit_adjustment"]), "lite" in p, int(p["connector_version"])).copy()
    mesh.apply_translation((x0, 0., z))
    return mesh


def deck(x0, x1, low=0., half=HALF):
    """Moving deck: a solid slab to tie-stud height with the shared rail section on top."""
    slab = _box(x0, x1, -half, half, low, SLAB)
    rails = ta._rails(np.array([[x0, 0., 0.], [x1, 0., 0.]]), 3.2)
    return ta._union([slab, rails])


def seat_post(E, d, cone=True):
    """Seat posts on a landing whose inner end is at x = E, the deck lying towards d (+1/-1).
    A hinged leaf is located along the track by its hinge: its posts carry no cone."""
    adds, cuts = [], []
    for s in (1, -1):
        vc = s*(P0 + P1)/2
        adds += [_box(E - d*ARM, E + d*.01, *_side(s, HALF - .5, P1), 0., SEAT),
                 _box(E, E + d*POST_REACH, *_side(s, P0, P1), 0., SEAT)]
        if cone:
            adds.append(_frustum(CONE_R, CONE_TIP, SEAT - .01, SEAT + CONE_H, E + d*CONE_U, vc))
        cuts.append(end._cylinder(MAG_R, SEAT - MAG_D, SEAT + .1, E + d*MAG_U, vc))
    return adds, cuts


def saddle(E, d, low=0., guided=True):
    """Deck saddles over the seat posts of a landing ending at x = E. `guided`: an inner wall and a cone hole
    locate the deck; a trunnion leaf, located by its axles, rests on a roof bridged from its side instead."""
    adds, cuts = [], []
    # The saddle starts 1 mm further in than the rail gap: a rising hinged leaf's toe swings out a little at first.
    u0, u1 = E + d*(GAP + 1.), E + d*(GAP + SADDLE)
    roof = SEAT + ROOF
    slope = (CONE_R - CONE_TIP)/CONE_H
    for s in (1, -1):
        vc = s*(P0 + P1)/2
        adds += [_box(u0, u1, *_side(s, P1 + CLEAR, P1 + CLEAR + WALL), low, roof),
                 _box(u0, u1, *_side(s, HALF - .5, P1 + CLEAR + WALL), SEAT, roof)]
        cuts.append(end._cylinder(MAG_R, roof - MAG_D, roof + .1, E + d*MAG_U, vc))
        if guided:
            top = SEAT + CONE_H + CONE_CLEAR
            adds.append(_box(u0, u1, *_side(s, HALF - .5, P0 - CLEAR), low, roof))
            cuts += [_frustum(CONE_R + CONE_CLEAR, CONE_R + CONE_CLEAR - slope*(top - SEAT + .01), SEAT - .01, top, E + d*CONE_U, vc),
                     end._cylinder(.8, SEAT, roof + .1, E + d*CONE_U, vc)]
    return adds, cuts


def _part(base, adds=(), cuts=()):
    return ta._difference(ta._union([base, *adds]), list(cuts))


# ------------------------------------------------------------------ geometry per family
class Geometry:
    """Fixed parts, the moving part and its motion for one configuration."""

    def __init__(self, family: str, p: dict):
        self.family, self.p = family, p
        self.span = float(p["span"])
        self.L = length(family, p)
        self.E_in, self.E_out = LANDING, self.L - LANDING
        self.hardware: list[dict] = []
        self.notes: list[str] = []
        self.side_on: set[str] = set()
        self.fixed: list[tuple[str, trimesh.Trimesh]] = []
        self.moving: list[tuple[str, trimesh.Trimesh]] = []
        getattr(self, "_" + family.removeprefix("bridge_").removeprefix("train_"))()

    # -- poses of the moving parts: (state label, matrix) for each aligned position, and the travel samples
    def aligned(self) -> list[tuple[str, np.ndarray, float]]:
        """(state, moving-part pose, landing level z) where the deck's rails meet landing rails."""
        if self.family == "train_elevator":
            return [(STATES[self.family][k], np.eye(4) @ trimesh.transformations.translation_matrix((0, 0, z)), z)
                    for k, z in enumerate(levels(self.family, self.p))]
        return [(STATES[self.family][0], np.eye(4), 0.)]

    def travel(self, steps: int = 12) -> list[tuple[float, np.ndarray]]:
        f = self.family
        if f == "bridge_lift_out":
            return [(t, trimesh.transformations.translation_matrix((0, 0, t))) for t in np.linspace(0, 40, steps)]
        if f == "bridge_drop_leaf":
            return [(math.degrees(t), _rot_y(t, (self.hinge_x, HINGE_Z))) for t in np.linspace(0, self.leaf_up, steps)]
        if f == "bridge_bascule":
            return [(math.degrees(t), _rot_y(t, (self.hinge_x, TRUNNION_Z))) for t in np.linspace(0, BASCULE_UP, steps)]
        if f == "bridge_swing":
            return [(math.degrees(t), _rot_z(t, (self.L/2, 0.))) for t in np.linspace(0, math.pi/2, steps)]
        top = self.p["lift"] if f == "bridge_lift" else max(levels(f, self.p))
        return [(t, trimesh.transformations.translation_matrix((0, 0, t))) for t in np.linspace(0, float(top), steps)]

    # -- families
    def _landings(self, extra_in=((), ()), extra_out=((), ()), z=0., suffix=""):
        p = self.p
        a = _part(landing(p, 0., LANDING, True, z), *extra_in)
        b = _part(landing(p, self.E_out, LANDING, False, z), *extra_out)
        self.fixed += [(f"landing-in{suffix}", a), (f"landing-out{suffix}", b)]

    def _lift_out(self):
        self._landings(seat_post(self.E_in, 1), seat_post(self.E_out, -1))
        adds, cuts = saddle(self.E_in, 1)
        adds2, cuts2 = saddle(self.E_out, -1)
        body = deck(self.E_in + GAP, self.E_out - GAP)
        self.moving.append(("mechanism-deck", _part(body, adds + adds2, cuts + cuts2)))
        self.hardware.append(hw.row(hw.MAGNET, 8, hw.MAGNETS))
        self.notes += ["Glue a magnet into each seat post and each saddle roof, alternating poles so each pair attracts; "
                       "check the polarity on the bench first.",
                       "Lift the section straight up to remove it; lower it with the saddles over the posts: the cones centre it.",
                       "Clip each landing to the track on its side and to the baseplate; keep the two landings "
                       f"{self.span - 2*GAP:.1f} mm apart rail end to rail end (lay the section in to check)."]

    def _hinge_parts(self):
        """Drop-leaf hinge at the in landing: landing knuckles + stop block; leaf knuckles + web + tooth."""
        E = self.E_in
        ax, az = E + GAP/2, HINGE_Z
        D0 = E + GAP
        self.hinge_x = ax
        # The leaf leans back past vertical: its centre of mass (half the span out, ~9 mm under the hinge) crosses over.
        lean = math.atan2(9., (self.span - 2*GAP)/2) + math.radians(4)
        self.leaf_up = math.pi/2 + lean
        fixed_adds, fixed_cuts, leaf_adds, leaf_cuts = [], [], [], []
        stop_top = az - (TOOTH_HALF*math.cos(lean) + TOOTH_TOP*math.sin(lean))
        self.stop_top = stop_top
        for s in (1, -1):
            k0, k1 = _side(s, *KNUCKLE_PLANE)
            l0, l1 = _side(s, *LEAF_PLANE)
            # Landing knuckle (outer plane) and stop block joining it to the landing body.
            knuckle = _hull_xz([(E - 14, 0), (ax + KNUCKLE_R, 0), (ax + KNUCKLE_R, az), (E - 14, az), *_circle(ax, az, KNUCKLE_R)])
            fixed_adds += [_xz_prism(knuckle, k0, k1),
                           _box(E - 14, ax - 5.6, *_side(s, HALF - .5, KNUCKLE_PLANE[0] + .2), 0., stop_top)]
            fixed_cuts.append(_y_cylinder(PILOT_R, k0 - .1, k1 + .1, ax, az))
            # Leaf knuckle: filled to the bed under the hinge, tooth standing up from the hinge.
            plate = _hull_xz([(ax - KNUCKLE_R, 0), (D0 + 16, 0), (D0 + 16, az), (ax - KNUCKLE_R, az), *_circle(ax, az, KNUCKLE_R)])
            tooth = [(ax - TOOTH_HALF, az), (ax + TOOTH_HALF, az), (ax + TOOTH_HALF, az + TOOTH_TOP), (ax - TOOTH_HALF, az + TOOTH_TOP)]
            leaf_adds += [_xz_prism(plate, l0, l1), _xz_prism(tooth, l0, l1),
                          _box(D0, D0 + 16, *_side(s, HALF - .5, LEAF_PLANE[0] + .2), 0., SLAB)]
            leaf_cuts.append(_y_cylinder(PIN_R, l0 - .1, l1 + .1, ax, az))
        return (fixed_adds, fixed_cuts), (leaf_adds, leaf_cuts)

    def _hinged(self, ax, az, hinge, leaf, post):
        """A leaf hinged at (ax, az) over the in landing. Rising, its toe first swings out by up to
        (toe depth)^2/(2 x leaf length) -- past the rail gap on short leaves or high trunnions -- so the leaf's free end
        and the out landing's end are concentric arcs about the hinge, the rail tops meeting across the usual gap."""
        toe = math.hypot(self.E_out - GAP - ax, az - TOP)
        self.toe_radius = toe
        hoop = lambda radius: _y_cylinder(radius, -60., 60., ax, az, 1440)
        outer = ta._difference(landing(self.p, self.E_out - 4., LANDING + 4., False), [hoop(toe + GAP)])
        self.fixed += [("landing-in", _part(landing(self.p, 0., LANDING, True), *hinge)), ("landing-out", _part(outer, *post))]
        self.moving.append(("mechanism-leaf", trimesh.boolean.intersection([leaf, hoop(toe)], engine="manifold")))

    def _drop_leaf(self):
        (fa, fc), (la, lc) = self._hinge_parts()
        sa, sc = saddle(self.E_out, -1)
        leaf = _part(deck(self.E_in + GAP, self.E_out - GAP), la + sa, lc + sc)
        self._hinged(self.hinge_x, HINGE_Z, (fa, fc), leaf, seat_post(self.E_out, -1))
        self.hardware += [hw.m3_screw(8, 2),
                          hw.row(hw.MAGNET, 4, hw.MAGNETS)]
        self.notes += ["Line the leaf's knuckles up inside the landing's knuckles and drive an M3 x 8 screw through each "
                       "outer knuckle into its pilot; the leaf turns on the screw shanks.",
                       "Glue a magnet into each seat post and saddle roof (pairs attracting).",
                       f"Raise the leaf past vertical ({math.degrees(self.leaf_up):.0f}°): it leans back on its stop blocks and stays up."]

    def _bascule(self):
        E = self.E_in
        ax, az = E + GAP/2, TRUNNION_Z
        D0 = E + GAP
        self.hinge_x = ax
        fixed_adds, fixed_cuts, leaf_adds, leaf_cuts, weights = [], [], [], [], []
        box_l, box_h = CW_BOX
        cw_points = [(ax - CW_LENGTH, az - box_h), (ax - CW_LENGTH + box_l, az - box_h), (ax - CW_LENGTH + box_l, az - 5),
                     (ax, az - TRUNNION_R), *_circle(ax, az, TRUNNION_R, 32, -math.pi/2, math.pi/2), (ax, az + TRUNNION_R),
                     (ax - CW_LENGTH + box_l, az + 5), (ax - CW_LENGTH + box_l, az + box_h), (ax - CW_LENGTH, az + box_h)]
        # Up stop: rising, the box's underside turns to face +x and sweeps forward; at BASCULE_UP it meets a post
        # whose face lies along it (everything the counterweight passes earlier lies behind that face).
        box = np.array([(ax - CW_LENGTH, az - box_h), (ax - CW_LENGTH + box_l, az - box_h)], float)
        (lx, lz), (hx, hz) = (_rot_y(BASCULE_UP, (ax, az))[[0, 2]][:, [0, 2, 3]] @ np.c_[box, np.ones(2)].T).T
        foot = lx - (hx - lx)*lz/(hz - lz)
        stop = [(foot, 0.), (lx + 10., 0.), (lx + 10., hz), (hx, hz)]
        for s in (1, -1):
            a0, a1 = _side(s, *ARM_PLANE)
            c0, c1 = _side(s, *CW_PLANE)
            t0, t1 = _side(s, *TOWER_PLANE)
            arm = _hull_xz([(D0, 0), (D0 + 28, 0), (D0 + 28, 10), (D0, 10), *_circle(ax, az, TRUNNION_R)])
            leaf_adds += [_xz_prism(arm, a0, a1), _box(D0, D0 + 28, *_side(s, HALF - .5, ARM_PLANE[0] + .2), 0., SLAB)]
            leaf_cuts.append(drives.cross_axle(self._axle_frame(s, a0, a1), abs(a1 - a0) + .2))
            tower = [(ax - 12, 0), (ax + 8, 0), (ax + 8, az + 4), (ax + 4, az + TRUNNION_R + 3), (ax - 8, az + TRUNNION_R + 3),
                     (ax - 12, az + 4)]
            fixed_adds += [_xz_prism(tower, t0, t1),
                           _box(ax - 40, ax - 12.01, *_side(s, HALF - .5, TOWER_PLANE[1]), 0., 3.),
                           _box(ax - 12.5, ax - 6., *_side(s, HALF - .5, TOWER_PLANE[0] + .2), 0., 3.),
                           _xz_prism(stop, *_side(s, CW_PLANE[0], TOWER_PLANE[0] + .2))]
            fixed_cuts.append(_y_cylinder(drives.AXLE_BEARING/2, t0 - .1, t1 + .1, ax, az))
            cw = _xz_prism(cw_points, c0, c1)
            cw_cut = [drives.cross_axle(self._axle_frame(s, c0, c1), abs(c1 - c0) + .2),
                      # Weight pocket opening outwards (upwards as printed on its side): M8 nuts or steel shot.
                      _box(ax - CW_LENGTH + 2, ax - CW_LENGTH + box_l - 2, *_side(s, CW_PLANE[0] + 1.2, CW_PLANE[1] + .1),
                           az - box_h + 2, az + box_h - 2)]
            weights.append((f"mechanism-counterweight-{'left' if s > 0 else 'right'}", _part(cw, (), cw_cut)))
        fixed = (fixed_adds, fixed_cuts)
        drive_value = int(self.p["drive"])
        if drive_value:
            frame = np.array([[0., 1, 0, ax], [-1, 0, 0, TOWER_PLANE[1] - .05], [0, 0, 1, az], [0, 0, 0, 1]])
            drive = drives.bluetooth_mount(frame, "L") if drive_value == 1 else drives.infrared_mount(frame)
            web = _box(ax - 2*drives.AXLE_PITCH - 4.4, ax + 2*drives.AXLE_PITCH + 4.4,
                       TOWER_PLANE[1] - .05, TOWER_PLANE[1] + drives.BEAM - .05, 0., az - drives.AXLE_PITCH - 4.4 + .1)
            fixed = (fixed_adds + drive.additions + [web], fixed_cuts + drive.cuts)
            self.hardware += drive.hardware
            self.notes += drive.notes
            self.drive_keepout = drive.keepout
            self.drive_frame, self.drive_motor = frame, "L" if drive_value == 1 else "IR_L"
        sa, sc = saddle(self.E_out, -1, guided=False)
        leaf = _part(deck(D0, self.E_out - GAP), leaf_adds + sa, leaf_cuts + sc)
        self._hinged(ax, az, fixed, leaf, seat_post(self.E_out, -1, cone=False))
        self.moving += weights
        self.side_on |= {name for name, _ in weights}
        self.hardware += [hw.row(hw.AXLE_3, 2, hw.BRICK),
                          hw.row(hw.MAGNET, 4, hw.MAGNETS),
                          hw.row(hw.COUNTERWEIGHT, 1, hw.BEARINGS)]
        self.notes += ["Hold each counterweight arm against the outside of the leaf arm and push a cross axle 3 through "
                       "the tower, counterweight and leaf arm (the cross holes key them together).",
                       "Fill both counterweight pockets until the raised leaf only just falls back closed: the leaf then rests "
                       "on its seat magnets and the counterweights rest on their stops when raised to 80°."]

    def _axle_frame(self, s, y0, y1):
        """Cross-axle cut frame: origin at the plane's inner face, +x outward along y."""
        inner = min(abs(y0), abs(y1))*s - .1*s
        return np.array([[0., -s, 0, self.hinge_x], [s, 0, 0, inner], [0, 0, 1, TRUNNION_Z], [0, 0, 0, 1]])

    def _swing(self):
        p, L = self.p, self.L
        cx = L/2
        radius = self.span/2 - SWING_GAP          # deck end arc, centre line
        cut = radius + SWING_GAP
        self.swing_radius = radius
        reach = HALF + 7.  # landing reaches into the arc past the girders
        extra = cut - math.sqrt(cut*cut - reach*reach) + 1.
        seam = cx + SEAM_OFFSET
        corner = math.sqrt(radius*radius - GIRDER[1]**2)
        self.stop_x = (cx - corner + 7., cx + corner - 7.)
        neck, mouth, depth = DOVETAIL
        width = GIRDER[1] + STOP_DEPTH
        floors, stops = [], []
        for index, (x0, x1, sx, s) in enumerate(((LANDING - 4., seam, self.stop_x[0], 1), (seam, L - LANDING + 4., self.stop_x[1], -1))):
            floor = _box(x0, x1, -GIRDER[1] - .5, GIRDER[1] + .5, 0., FLOOR)
            block = _box(sx - STOP_HALF, sx + STOP_HALF, *_side(s, GIRDER[1], width), 0., STOP_TOP)
            pad = _box(sx - STOP_HALF, sx + STOP_HALF, *_side(s, 0., width), 0., FLOOR)
            magnet = _y_cylinder(MAG_R, s*GIRDER[1] - .01*s, s*(GIRDER[1] + MAG_D), sx, STOP_MAG_Z)
            floors.append((floor, block, pad, magnet))
        keys = []
        for y in (-22., 22.):
            keys.append([(seam - .01, y - neck/2), (seam + depth, y - mouth/2), (seam + depth, y + mouth/2), (seam - .01, y + neck/2)])
        key = lambda grow: [ta._polygon(np.array(k) + np.array([[0, -grow], [grow, -grow], [grow, grow], [0, grow]]), -.1 if grow else 0.,
                                        FLOOR + (.1 if grow else 0.)) for k in keys]
        # The deck rides on a shoulder round the pin and on two end pads, all at its underside height.
        pivot = ta._union([end._cylinder(PIVOT_R, 0., PIVOT_TOP, cx, 0.), end._cylinder(PIVOT_PAD, 0., SWING_LOW, cx, 0.)])
        pads = [_box(x - 6., x + 6., -16., 16., 0., SWING_LOW) for x in (cx - radius + 10., cx + radius - 10.)]
        arc = end._cylinder(cut, FLOOR, 20., cx, 0.)
        a = landing(p, 0., LANDING + extra, True)
        b = landing(p, L - LANDING - extra, LANDING + extra, False)
        f0, f1 = floors
        # The arc trims only the landing track; floor, stops and pivot stand inside it.
        a = ta._difference(ta._union([ta._difference(a, [arc]), f0[0], f0[1], f0[2], pivot, pads[0], *key(0.)]), [f0[3]])
        b = ta._difference(ta._union([ta._difference(b, [arc]), f1[0], f1[1], f1[2], pads[1]]), [f1[3], *key(.15)])
        self.fixed += [("landing-in", a), ("landing-out", b)]
        slab = _box(cx - radius - 1, cx + radius + 1, -GIRDER[1], GIRDER[1], SWING_LOW, SLAB)
        girders = [_box(cx - radius - 1, cx + radius + 1, *_side(s, *GIRDER), SWING_LOW, TOP) for s in (1, -1)]
        rails = ta._rails(np.array([[cx - radius - 1, 0., 0.], [cx + radius + 1, 0., 0.]]), 3.2)
        body = trimesh.boolean.intersection([ta._union([slab, *girders, rails]), end._cylinder(radius, 0., 20., cx, 0.)],
                                            engine="manifold")
        cuts = [end._cylinder(PIVOT_R + PIVOT_CLEAR, SWING_LOW - .1, SLAB + .1, cx, 0.)]
        for sx, s in ((self.stop_x[0], 1), (self.stop_x[1], -1)):
            cuts.append(_y_cylinder(MAG_R, s*GIRDER[1] + .01*s, s*(GIRDER[1] - MAG_D), sx, STOP_MAG_Z))
        self.moving.append(("mechanism-deck", ta._difference(body, cuts)))
        self.hardware.append(hw.row(hw.MAGNET, 4, hw.MAGNETS))
        self.notes += ["Slide the two floor halves together (dovetails down from above) and clip both landings to the track.",
                       "Glue a magnet into each stop block and into the girder face that meets it (pairs attracting).",
                       "Drop the deck over the pivot pin. Swing it anticlockwise (seen from above) to open, clockwise to close: "
                       "it stops against the blocks with the rails lined up."]

    def _vertical(self, lift_levels, landing_levels):
        """Four posts at the deck corners; collars pin landings, shoes and index pins hold the deck."""
        p = self.p
        xs = (self.E_in + POST_HALF + .3, self.E_out - POST_HALF - .3)
        self.post_x = xs
        screw = int(p["drive"]) == 1
        beam_z = max(lift_levels) + SCREW_HEADROOM
        top = beam_z + SOCKET if screw else max(lift_levels) + TOP + 4.
        landing_adds = {z: ([], [], [], []) for z in landing_levels}
        deck_adds, deck_cuts = [], []
        posts = []
        for xi, (xp, d) in enumerate(((xs[0], 1), (xs[1], -1))):
            for s in (1, -1):
                v0, v1 = _side(s, *POST)
                post = _box(xp - POST_HALF, xp + POST_HALF, v0, v1, 0., top)
                holes = [_y_cylinder(PIN_R, v0 - .1, v1 + .1, xp - d*2.5, z + PIN_Z) for z in landing_levels]
                holes += [_y_cylinder(PIN_R, v0 - .1, v1 + .1, xp + d*2.5, z + PIN_Z) for z in lift_levels]
                posts.append((xp, s, ta._difference(post, holes)))
                # Collar on every landing at this end: end wall into the landing body, walls either side of the post.
                inner = _side(s, HALF + .4, POST[0] - CLEAR)
                outer = _side(s, POST[1] + CLEAR, POST[1] + CLEAR + SHOE_OUT)
                for z in landing_levels:
                    adds = landing_adds[z][0 if d > 0 else 2]
                    cuts = landing_adds[z][1 if d > 0 else 3]
                    near, far = xp - d*(POST_HALF + SHOE_BACK + CLEAR), xp - d*.15
                    adds += [_box(near, xp - d*(POST_HALF + CLEAR), *_side(s, HALF - .5, POST[1] + CLEAR + SHOE_OUT), z, z + TOP),
                             _box(near, far, *inner, z, z + TOP), _box(near, far, *outer, z, z + TOP)]
                    cuts += [_y_cylinder(PILOT_R, inner[0] - .1, inner[1] + .1, xp - d*2.5, z + PIN_Z),
                             _y_cylinder(PIN_R, outer[0] - .1, outer[1] + .1, xp - d*2.5, z + PIN_Z)]
                # Shoe on the deck: walls either side of the post and a back wall past it.
                near, far = xp + d*.15, xp + d*(POST_HALF + CLEAR + SHOE_BACK)
                inner = _side(s, HALF - .5, POST[0] - CLEAR)
                deck_adds += [_box(near, far, *inner, 0., TOP), _box(near, far, *outer, 0., TOP),
                              _box(xp + d*(POST_HALF + CLEAR), far, *_side(s, HALF - .5, POST[1] + CLEAR + SHOE_OUT), 0., TOP)]
                deck_cuts += [_y_cylinder(PILOT_R, inner[0] - .1, inner[1] + .1, xp + d*2.5, PIN_Z),
                              _y_cylinder(PIN_R, outer[0] - .1, outer[1] + .1, xp + d*2.5, PIN_Z)]
        for index, z in enumerate(landing_levels):
            a_add, a_cut, b_add, b_cut = landing_adds[z]
            self._landings((a_add, a_cut), (b_add, b_cut), z, "" if index == 0 else f"-level-{index+1}")
        body = deck(self.E_in + GAP, self.E_out - GAP)
        if screw:
            boss_adds, boss_cuts = self._screw(xs, beam_z, max(lift_levels))
            deck_adds, deck_cuts = deck_adds + boss_adds, deck_cuts + boss_cuts
        self.moving.append(("mechanism-deck", _part(body, deck_adds, deck_cuts)))
        names = {(0, 1): "in-left", (0, -1): "in-right", (1, 1): "out-left", (1, -1): "out-right"}
        for xp, s, mesh in posts:
            key = names[(0 if xp < self.L/2 else 1, s)]
            for index, segment in enumerate(self._segments(mesh, xp, s, top)):
                name = f"mechanism-post-{key}" + (f"-{index+1}" if top > SEGMENT else "")
                self.fixed.append((name, segment))
                self.side_on.add(name)
        pins = 4*len(lift_levels)
        self.hardware += [hw.m3_screw(20, 4*len(landing_levels)),
                          hw.row("3 x 20 mm steel rod or M3 x 20 mm screw (index pin)", pins, hw.FASTENERS)]
        if top > SEGMENT:
            self.hardware.append(hw.m3_screw(12, 4*(len(self._cuts(top)))))

    def _screw(self, xs, beam_z, highest):
        """Lead-screw drive: beam over the left posts' tops with the rod's bearing, a crank on the rod, and the
        deck's nut boss (returned as deck additions and cuts)."""
        cx, cy, (half, height) = self.L/2, SCREW_Y, BOSS
        hexagon = lambda z0, z1: ta._polygon([(cx + NUT_AF/math.sqrt(3)*math.cos(a), cy + NUT_AF/math.sqrt(3)*math.sin(a))
                                              for a in np.arange(6)*math.pi/3], z0, z1)
        far = cy + 9.
        boss = [_box(cx - half, cx + half, HALF - .5, far, 0., SLAB),
                _box(cx - half, cx + half, HALF + .4, far, 0., height)]
        boss_cuts = [end._cylinder(ROD_R, -.1, height + .1, cx, cy), hexagon(height - NUT_H, height + .1)]
        beam = _box(xs[0] - POST_HALF - 3., xs[1] + POST_HALF + 3., POST[0] - .5, cy + 15., beam_z, beam_z + BEAM_H)
        sockets = [_box(x - POST_HALF - .2, x + POST_HALF + .2, POST[0] - .2, POST[1] + .2, beam_z - .1, beam_z + SOCKET)
                   for x in xs]
        bearing = [end._cylinder(BEARING[0], beam_z + BEAM_H - BEARING[1], beam_z + BEAM_H + .1, cx, cy),
                   end._cylinder(ROD_R, beam_z - .1, beam_z + BEAM_H + .1, cx, cy)]
        self.fixed.append(("mechanism-screw-beam", _part(beam, (), sockets + bearing)))
        hub, reach, knob, handle = CRANK
        z0 = beam_z + BEAM_H + 8.
        crank = ta._union([end._cylinder(hub, z0, z0 + 10., cx, cy), _box(cx, cx + reach, cy - 4., cy + 4., z0, z0 + 6.),
                           end._cylinder(knob, z0, z0 + handle, cx + reach, cy)])
        self.fixed.append(("mechanism-crank", _part(crank, (), [hexagon(z0 - .1, z0 + 10.1)])))
        self.screw = {"x": cx, "y": cy, "beam_z": beam_z, "crank_z": z0, "highest": highest}
        rod = math.ceil((z0 + 20.)/10.)*10.
        self.hardware += [hw.row(f"M8 threaded rod {rod:.0f} mm", 1, hw.BEARINGS),
                          hw.row(hw.M8_NUT, 4, hw.FASTENERS),
                          hw.row(hw.BEARING_608, 1, hw.BEARINGS)]
        self.notes += ["Press the 608 bearing into the beam, push the beam's sockets down over the left posts' tops, and "
                       "run the M8 rod down through the bearing and the deck boss's nut (nut in its hex pocket, the deck "
                       "resting on it).",
                       "Lock two nuts on the rod on top of the bearing (the deck hangs from them), then the crank's nut "
                       "on top: one turn of the crank moves the deck 1.25 mm. Pin the deck at a level's index holes."]
        return boss, boss_cuts

    def _cuts(self, top):
        count = math.ceil(top/SEGMENT)
        step = top/count
        return [step*k for k in range(1, count)]

    def _segments(self, mesh, xp, s, top):
        """Split a post at even heights with a pinned tenon (lower) into a through mortise (upper)."""
        cuts = self._cuts(top)
        if not cuts:
            return [mesh]
        v0, v1 = _side(s, *POST)
        pieces = []
        bounds = [0., *cuts, top]
        for k in range(len(bounds) - 1):
            low, high = bounds[k], bounds[k + 1]
            piece = trimesh.boolean.intersection([mesh, _box(xp - 10, xp + 10, v0 - 1, v1 + 1, low, high)], engine="manifold")
            adds, subs = [], []
            if k < len(bounds) - 2:
                adds.append(_box(xp - TENON[0], xp + TENON[0], v0, v1, high - .01, high + TENON[1]))
                subs.append(_y_cylinder(PILOT_R, v0 - .1, v1 + .1, xp, high + TENON[1]/2))
            if k > 0:
                subs += [_box(xp - TENON[0] - .2, xp + TENON[0] + .2, v0 - .1, v1 + .1, low - .1, low + TENON[1] + .2),
                         _y_cylinder(PIN_R, v0 - .1, v1 + .1, xp, low + TENON[1]/2)]
            pieces.append(_part(piece, adds, subs))
        return pieces

    def _lift(self):
        self._vertical([0., float(self.p["lift"])], [0.])
        self.notes += ["Stand the four posts in the landing collars and pin each with an M3 x 20 screw through the collar.",
                       "Lower the deck between the posts, shoes around them, and pin it at the bottom holes.",
                       "To raise it: pull the four deck pins, lift the deck to the upper holes and pin it there."]

    def _elevator(self):
        heights = levels(self.family, self.p)
        self._vertical(heights, heights)
        self.notes += ["Pin the ground landings to the posts first, then each upper landing at its level; support the "
                       "track beyond every upper landing on risers or a shelf at the same height.",
                       "Move the car by hand between levels and pin it with the four index pins at the level's holes; "
                       "the car's rails then line up with that level's landings."]


@lru_cache(maxsize=16)
def geometry(family: str, shape: tuple, adjustment: float, lite: bool, connector: int) -> Geometry:
    p = {**dict(shape), "fit_adjustment": adjustment, "connector_version": connector, **({"lite": 1} if lite else {})}
    return Geometry(family, p)


def _shape(family, p):
    return tuple((key, float(p[key])) for key in SHAPES[family])


def geometry_of(family: str, p: dict) -> Geometry:
    validate(family, p)
    return geometry(family, _shape(family, p), float(p["fit_adjustment"]), "lite" in p, int(p["connector_version"]))


def _rows(family, p):
    g = geometry_of(family, p)
    return g.fixed + g.moving


# ------------------------------------------------------------------ service interface
def components(family: str, p: dict) -> list[dict]:
    validate(family, p)
    code = FAMILIES.index(family)
    logical = {key: value for key, value in p.items() if key != "state"}
    return [{"role": role, "parameters": {**logical, "shape_code": code, "component_index": index}}
            for index, (role, _) in enumerate(_rows(family, p))]


def _family_of(p) -> str:
    code = p.get("shape_code")
    if not _number(code) or code != int(code) or not 0 <= code < len(FAMILIES):
        raise ValueError("invalid shape_code")
    return FAMILIES[int(code)]


def component_keys(p: dict) -> set[str]:
    return set(CONNECTOR | set(SHAPES[_family_of(p)]) | {"shape_code", "component_index"})


def _logical(p):
    return {**{key: value for key, value in p.items() if key not in ("shape_code", "component_index")}, "state": 0}


def validate_component(p: dict) -> None:
    family = _family_of(p)
    if set(p) - {"lite"} != component_keys(p):
        raise ValueError("unexpected moving bridge component parameters")
    validate(family, _logical(p))
    index = p["component_index"]
    if not _number(index) or index != int(index) or not 0 <= index < len(_rows(family, _logical(p))):
        raise ValueError("component_index outside assembly")


def component_ports(p: dict) -> list[dict]:
    return ports(_family_of(p), _logical(p))


def side_on(p: dict) -> bool:
    """Print this component on its side (posts and counterweights: their holes then stand vertical)."""
    family = _family_of(p)
    g = geometry_of(family, _logical(p))
    role, _ = _rows(family, _logical(p))[int(p["component_index"])]
    return role in g.side_on


def check_mesh(role: str, mesh: trimesh.Trimesh, sideways: bool = False) -> trimesh.Trimesh:
    if not mesh.is_watertight or len(mesh.split(only_watertight=False)) != 1:
        raise ValueError(f"{role} is not a connected watertight component")
    extents = mesh.extents[[0, 2]] if sideways else mesh.extents[:2]
    if np.any(extents > BED + .001):
        raise ValueError(f"{role} exceeds the 166 mm usable mini bed")
    manifold = manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))
    cleaned = manifold.simplify(1e-5).to_mesh()
    result = trimesh.Trimesh(cleaned.vert_properties[:, :3], cleaned.tri_verts, process=True)
    if not result.is_volume or len(result.split(only_watertight=False)) != 1:
        raise ValueError(f"{role} lost connected volume during seam retriangulation")
    return result


def build_component(p: dict) -> cq.Shape:
    validate_component(p)
    family = _family_of(p)
    role, mesh = _rows(family, _logical(p))[int(p["component_index"])]
    return end._solid(check_mesh(role, mesh, side_on(p)))


def hardware(family: str, p: dict) -> list[dict]:
    return hw.with_glue(geometry_of(family, p).hardware)


def assembly_notes(family: str, p: dict) -> list[str]:
    g = geometry_of(family, p)
    return [*g.notes, "Decks, leaves, posts and counterweights print in the detailed style even on a Fast layout: their guides need its tolerances."]


# ------------------------------------------------------------------ probes
def _overlap(a, b):
    if np.any(a.bounds[0] > b.bounds[1]) or np.any(b.bounds[0] > a.bounds[1]):
        return 0.
    return abs(trimesh.boolean.intersection([a, b], engine="manifold").volume)


def _rail_heads(mesh, x, z_level):
    """(y, z) of the two rail-head tops of `mesh` in the section at x."""
    section = mesh.section(plane_origin=(x, 0, 0), plane_normal=(1, 0, 0))
    if section is None:
        return None
    points = np.asarray(section.vertices)
    heads = []
    for side in (-1, 1):
        near = points[(np.abs(points[:, 1] - side*RAIL) < 1.6) & (points[:, 2] > z_level + TOP - 1.)]
        if not len(near):
            return None
        top = near[:, 2].max()
        band = near[near[:, 2] > top - .05]
        heads.append(((band[:, 1].min() + band[:, 1].max())/2, float(top)))
    return heads


def _play(family) -> dict:
    """Worst-case rail-end misalignment the guides allow beyond the nominal mesh positions (mm)."""
    if family in ("bridge_lift_out", "bridge_drop_leaf", "bridge_bascule"):
        return {"lateral": CLEAR, "vertical": 0., "along": CONE_CLEAR}
    if family == "bridge_swing":
        return {"lateral": PIVOT_CLEAR, "vertical": FLOOR - FLOOR, "along": PIVOT_CLEAR}
    return {"lateral": CLEAR, "vertical": PIN_R - 1.5, "along": CLEAR}


def probe_alignment(family: str, p: dict) -> list[dict]:
    """Rail ends meet within 0.3 mm and 0.5 degree at every aligned state (measured + allowed play)."""
    g = geometry_of(family, p)
    deck_role, moving = g.moving[0]
    play = _play(family)
    rows = []
    for state, pose, z in g.aligned():
        placed = _moved(moving, pose)
        suffix = "" if z == 0 else f"-level-{levels(family, p).index(z)+1}"
        fixed = dict(g.fixed)
        for end_name, landing_name, x_landing, x_deck in (
                ("in", f"landing-in{suffix}", g.E_in - 1., g.E_in + 2.5),
                ("out", f"landing-out{suffix}", g.E_out + 1., g.E_out - 2.5)):
            if family == "bridge_swing":
                # Arc ends: sample both sides just clear of the gap.
                cut = g.swing_radius + SWING_GAP
                reach = math.sqrt(cut*cut - RAIL*RAIL)
                sign = -1 if end_name == "in" else 1
                x_landing, x_deck = g.L/2 + sign*(reach + 1.), g.L/2 + sign*(reach - SWING_GAP - 1.5)
            a = _rail_heads(fixed[landing_name], x_landing, z)
            b = _rail_heads(placed, x_deck, z)
            if a is None or b is None:
                raise ValueError(f"{family} {state}: no rail section at the {end_name} end")
            lateral = max(abs(a[i][0] - b[i][0]) for i in range(2))
            vertical = max(abs(a[i][1] - b[i][1]) for i in range(2))
            # Cross level of the rail heads (deck vs landing) and plan angle from the two ends' offsets.
            cross = abs((a[1][1] - a[0][1]) - (b[1][1] - b[0][1]))/(2*RAIL)
            rows.append({"state": state, "end": end_name, "lateralMm": round(lateral, 3), "verticalMm": round(vertical, 3),
                         "crossLevelDeg": round(math.degrees(math.atan(cross)), 3),
                         "worstLateralMm": round(lateral + play["lateral"], 3),
                         "worstVerticalMm": round(vertical + play["vertical"], 3)})
        deck_len = g.E_out - g.E_in - 2*GAP
        angle = math.degrees(math.atan2(2*play["lateral"], deck_len))
        for row in rows[-2:]:
            row["worstAngleDeg"] = round(angle, 3)
            if row["worstLateralMm"] > .3 + 1e-9 or row["worstVerticalMm"] > .3 + 1e-9 or angle > .5:
                raise ValueError(f"{family} {row['state']} {row['end']}: rail ends misaligned {row}")
    return rows


def probe_motion(family: str, p: dict, steps: int = 31) -> dict:
    """The moving parts, swept through their whole travel, never touch a fixed part."""
    g = geometry_of(family, p)
    worst = 0.
    for value, pose in g.travel(steps):
        for name, moving in g.moving:
            placed = _moved(moving, pose)
            for fixed_name, fixed in g.fixed:
                volume = _overlap(placed, fixed)
                if volume > .01:
                    raise ValueError(f"{name} hits {fixed_name} at {value:.2f}: {volume:.4f} mm^3")
                worst = max(worst, volume)
    first, last = g.travel(steps)[0][0], g.travel(steps)[-1][0]
    return {"samples": steps, "travel": [round(first, 2), round(last, 2)], "maxOverlapMm3": worst}


def _blocked(moving, fixed, matrix):
    return sum(_overlap(_moved(moving, matrix), part) for _, part in fixed)


def probe_retention(family: str, p: dict) -> list[dict]:
    """What stops the closed deck in each direction (an overlap > 0.01 mm^3 after a 1 mm / 1 degree push)."""
    g = geometry_of(family, p)
    _, moving = g.moving[0]
    report = []
    pushes = {"+x": (1, 0, 0), "-x": (-1, 0, 0), "+y": (0, 1, 0), "-y": (0, -1, 0)}
    state, pose, _ = g.aligned()[0]
    rest = _moved(moving, pose)
    for label, vector in pushes.items():
        report.append({"state": state, "push": label, "blockedMm3": round(float(_blocked(rest, g.fixed, trimesh.transformations.translation_matrix(vector))), 3)})
    if family == "bridge_swing":
        report.append({"state": state, "push": "close past stop (-1°)",
                       "blockedMm3": round(float(_blocked(rest, g.fixed, _rot_z(math.radians(-1), (g.L/2, 0.)))), 3)})
    if family == "bridge_drop_leaf":
        up = _moved(moving, _rot_y(g.leaf_up + math.radians(1), (g.hinge_x, HINGE_Z)))
        report.append({"state": "up", "push": "past the stop (+1°)", "blockedMm3": round(float(_blocked(up, g.fixed, np.eye(4))), 3)})
    if family == "bridge_bascule":
        weights = [mesh for name, mesh in g.moving if "counterweight" in name]
        pose_up = _rot_y(BASCULE_UP + math.radians(1), (g.hinge_x, TRUNNION_Z))
        report.append({"state": "up", "push": "past the stop (+1°)",
                       "blockedMm3": round(float(sum(_blocked(_moved(w, pose_up), g.fixed, np.eye(4)) for w in weights)), 3)})
    for row in report:
        row["held"] = bool(row["blockedMm3"] > .01)
    if not all(row["held"] for row in report if row["push"] in ("+y", "-y")):
        raise ValueError(f"{family}: the closed deck can slide sideways: {report}")
    return report


def envelopes(family: str, p: dict) -> list[list[tuple[float, float]]]:
    """Plan polygons the moving parts stay inside through their travel (TS moving-bridges.ts envelopes())."""
    g = geometry_of(family, p)
    L, D0 = g.L, LANDING + GAP
    rect = lambda x0, x1, y0, y1: [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    saddle_width = P1 + CLEAR + WALL + .5
    if family == "bridge_swing":
        reach = math.hypot(g.swing_radius, GIRDER[1]) + .5
        return [[(L/2 + reach*math.cos(a), reach*math.sin(a)) for a in np.linspace(0, 2*math.pi, 48, endpoint=False)]]
    if family == "bridge_lift_out":
        return [rect(D0, L - D0, -saddle_width, saddle_width)]
    if family == "bridge_drop_leaf":
        leaf = g.span - 2*GAP
        x0 = g.hinge_x + leaf*math.cos(g.leaf_up) + (HINGE_Z - TOP)*math.sin(g.leaf_up) - .5
        # Rising, the far end's underside first swings out past its closed position.
        return [rect(x0, g.hinge_x + math.hypot(L - D0 - g.hinge_x, HINGE_Z) + .5, -saddle_width, saddle_width)]
    if family == "bridge_bascule":
        ax = g.hinge_x
        return [rect(ax - TRUNNION_R - .5, ax + math.hypot(L - D0 - ax, TRUNNION_Z) + .5, -saddle_width, saddle_width),
                rect(ax - 28., ax + 10., CW_PLANE[0] - .5, CW_PLANE[1] + .5),
                rect(ax - 28., ax + 10., -CW_PLANE[1] - .5, -CW_PLANE[0] + .5)]
    width = POST[1] + CLEAR + SHOE_OUT + .5
    polygons = [rect(D0, L - D0, -width, width)]
    if int(p["drive"]) == 1:
        polygons.append(rect(L/2 - BOSS[0] - .5, L/2 + BOSS[0] + .5, HALF - 1., SCREW_Y + 9.5))
    return polygons


def probe_envelopes(family: str, p: dict) -> dict:
    g = geometry_of(family, p)
    sections = [manifold3d.CrossSection([np.asarray(polygon).tolist()], manifold3d.FillRule.EvenOdd)
                for polygon in envelopes(family, p)]
    union = sections[0]
    for section in sections[1:]:
        union = union + section
    outside = 0.
    for _, pose in g.travel(9):
        for _, moving in g.moving:
            placed = _moved(moving, pose)
            # The part's shadow on the table (not its convex hull: the envelopes follow its outline).
            plan = manifold3d.Manifold(manifold3d.Mesh(np.float32(placed.vertices), np.uint32(placed.faces))).project()
            outside = max(outside, (plan - union).area())
    if outside > .5:
        raise ValueError(f"{family}: moving parts leave the published envelope by {outside:.2f} mm^2")
    return {"polygons": len(sections), "outsideAreaMm2": round(outside, 3)}


def probe_motor(family: str, p: dict, steps: int = 9) -> dict:
    """Motor bascule (Bluetooth 88013 or infrared 88003): the motor on its plate outside the left tower clear of
    every printed part (the leaf and counterweights posed through their travel), its pin holes and bearing open, its
    output on the trunnion axis (it turns the trunnion axle directly, no gears)."""
    g = geometry_of(family, p)
    if family != "bridge_bascule" or int(p["drive"]) not in (1, 2):
        raise ValueError("the motor probe covers the motor bascule (drive 1 or 2)")
    printed = list(g.fixed) + [(f"{name} at {value:.0f}°", _moved(mesh, pose))
                               for value, pose in g.travel(steps) for name, mesh in g.moving]
    report = drives.probe_mount(g.drive_frame, g.drive_motor, dict(g.fixed)["landing-in"], printed)
    axle, axis = g.drive_frame[:3, 3], g.drive_frame[:3, 0]
    report["output"] = {"trunnionOffsetMm": round(float(math.hypot(axle[0] - g.hinge_x, axle[2] - TRUNNION_Z)), 4),
                        "alongTrunnion": bool(abs(abs(float(axis[1])) - 1.) < 1e-9)}
    return report


def probes(family: str, p: dict) -> dict:
    report = {"alignment": probe_alignment(family, p), "motion": probe_motion(family, p),
              "retention": probe_retention(family, p), "envelopes": probe_envelopes(family, p)}
    if family == "bridge_bascule" and int(p["drive"]) in (1, 2):
        report["motor"] = probe_motor(family, p)
    return report
