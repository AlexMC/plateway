"""Rotary dumper (Wave 5, experimental); millimetres, piece frame.

A straight assembly from port ``in`` (x = 0) to ``out`` (x = L = 2 x 48 + span). Two fixed 48 mm landings
(composite straights, brick connector outside, plain cut inside) carry the stands. Between them a cradle (barrel)
``span`` long less a 0.6 mm rail gap at each end turns up to 150 degrees about a fixed axis along the track to
empty a wagon, and back (matches src/domain/pieces/families/rotary-dumper.ts).

Why the axis sits at z = 72 (not at the wagon's centre of mass, ~45): the track runs at table level, so the cradle has
no pit to turn in. Every cradle point stays inside the end rings' 70 mm radius, whose bottom clears the table by 2 mm;
the rails' undersides then just fit inside that circle (their foot is trimmed to it). The wagon's 27 mm offset below
the axis is what the gear and crank (or motor) lift.

Cradle cross-section (y-z, upright): the shared rail heads at the landing rails' positions, a deck between them at
5.6 mm (0.8 under the wheel flanges' 6.4), sills outside the rails to 9.1, two 6 mm side walls whose inner faces stand
1.5 mm off a 6-wide (48 mm) wagon, and two 4 mm ledges 1 mm over an 80 mm tall wagon's rim that overlap it by 5 mm a
side. That cage is the loading gauge (LG): a train of 6-wide, at most 80 mm tall stock runs through upright; the
wagon cannot leave it at any angle; its load pours out through the 38 mm slot between the ledges.

End rings: 10.8 mm discs (radius 70) with the LG cut through; each rolls in a 7.6 mm groove (radius 68.5) on two 608
bearings (on M8 bolts in the stands, 45 degrees either side of the bottom), which also locate the cradle along x.
The in ring carries a 6 mm module-1 ring gear (138 teeth on the arc that meets the pinion); a 16-tooth gear on a
cross axle beside the ring turns it, from a printed crank (drive 0), a Bluetooth L motor (drive 1,
drives.bluetooth_mount) or an infrared L motor on the same plate (drive 2, drives.infrared_mount).
Indexing: a lug on the out ring's outer face lands on a stop block on the out stand at upright (0 degrees) and on a
second block at 150 degrees; a 6 x 3 mm magnet pair holds each position.

Printing: the cradle (in ring, gear and body) and the out ring print standing on their in-facing end (``end_on``):
every wall, rail and ring is then an upright prism; the out ring keys onto the body's pegs and two M3 screws.

Probes: rail alignment upright, running clearance (6-wide train + wheel flange corridors through the whole piece),
motion 0..150 degrees against every fixed part and the bought bearings and pinion, retention (stops, axial play, and
the wagon caged at every angle), plan envelopes and outlines (the domain's numbers).
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
from . import moving_bridge as mb
from . import track_assembly as ta

# ------------------------------------------------------------------ constants
HALF = end.PROFILE["bodyWidth"]/2            # 31.9
RAIL = end.PROFILE["railGauge"]/2            # 20
TOP = end.RAIL_TOP                           # 9.6
LANDING, GAP = mb.LANDING, mb.GAP            # 48, 0.6
D0 = LANDING + GAP                           # 48.6: cradle in face
BED, BED_Z = 166., 170.                      # usable A1 mini bed and height
# Barrel.
AXIS_Z = 72.
R_MAX = 70.                                  # end-ring radius: everything on the cradle stays inside it
GROOVE_R = 68.5                              # bearing track
RING_T, LIP = 10.8, 1.6                      # ring thickness, groove lips (groove 7.6 wide)
TRAVEL = 150.                                # degrees
# Loading gauge (cradle frame, upright).
FACE = RAIL - end.PROFILE["railInterfaceWidth"]/2      # 18.8: rail guiding face
HEAD_OUT = RAIL + end.PROFILE["railInterfaceWidth"]/2  # 21.2
DECK_TOP = 5.6                               # between the rails: 0.8 under the flanges (6.4)
SILL_TOP = 9.1                               # outside the rails: 0.5 under the treads
LG_HALF = 25.5                               # wall inner face
WAGON_HALF, WAGON_TOP = 24., TOP + 80.       # design wagon: 6-wide, 80 mm over the rails
LG_TOP = WAGON_TOP + 1.                      # ledge underside
WALL_OUT, LEDGE_IN, LEDGE_T = 31.5, 19., 4.
# Ring gear (in ring, inboard) and 16T pinion.
MODULE, TEETH, PINION_TEETH = 1., 138, 16
GEAR_T = 6.
PRESSURE = math.radians(20.)
PINION_TIP_R, PINION_ROOT_R = 8.66, 6.81    # 16T 94925 (LDraw): tooth tips 21.64 LDU, roots 17.03 LDU
BACKLASH = .1
PINION_AT = 200.                             # degrees: pinion beside the left of the barrel
CENTRES = MODULE*(TEETH + PINION_TEETH)/2 + BACKLASH
GEAR_ARC = (PINION_AT - TRAVEL - 5., PINION_AT + 5.)   # cradle angles that ever meet the pinion
# Bearings: 608 (8 x 22 x 7) rolling in the groove.
BEARING_R, BEARING_W = 11., 7.
BEARING_C = GROOVE_R + BEARING_R             # 79.5 from the axis
ROLLERS = (-135., -45.)
BOLT_R, SPACER_R, SPACER = 4.2, 5.8, 2.3
# Stands.
CHEEK = 6.
AXLE_BOSS = 6.5
BRACKET = (66., 71.)                         # pinion axle's inner bearing (x)
FOOT = 3.2
MOTOR_GAP = 3.                              # motor plate front face to the in cheek
# Indexing (out ring outer face / out stand).
STOP_R = (59., 67.)
LUG = (12., 18.5)                            # degrees, upright; protrudes LUG_X past the ring face
LUG_X = 4.
UPRIGHT_BLOCK, TIPPED_BLOCK = (4., 12.), (168.5, 176.5)
MAG_R, MAG_D, MAG_AT = 3.15, 3.2, 63.
RING_MAGNETS = (8., 22.5)                    # upright detent, tipped detent (ring angles)
POST = (61., 69., 80.)                       # stop posts: |y| band and height
# Keyed joint body / out ring.
PEGS = [(s*28.5, z) for s in (1, -1) for z in (30., 70.)]
SCREWS = [(s*28.5, 50.) for s in (1, -1)]
PEG_R, PEG_HOLE, PEG_L = 1.9, 2.1, 5.
PILOT_R, CLEAR_R = 1.25, 1.6
# Crank (drive 0).
CRANK_X, CRANK_REACH, KNOB_R = (26., 30.), 28., 4.

FAMILIES = ("rotary_dumper",)
COMPONENT_FAMILY = "rotary_dumper_component"
STATES = ("upright", "tipped")
SHAPES = ("span", "drive")
SPAN = (128, 160)
CONNECTOR = frozenset({"connector_version", "fit_adjustment"})
LOGICAL = frozenset({"state"})
SOURCE_DEPENDENCIES = [Path(composite.__file__), Path(ta.__file__), Path(drives.__file__), Path(fast.__file__),
                       Path(end.__file__), Path(mb.__file__)]


# ------------------------------------------------------------------ validation
def validate(family: str, p: dict) -> None:
    if family not in FAMILIES:
        raise ValueError("unsupported rotary dumper family")
    expected = CONNECTOR | LOGICAL | set(SHAPES)
    if set(p) - {"lite"} != expected:
        raise ValueError(f"{family} requires exactly {sorted(expected)}")
    if not all(mb._number(p[key]) for key in expected):
        raise ValueError("rotary dumper parameters must be finite numbers")
    end.validate(p)
    if "lite" in p:
        fast.validate(p)
    span = p["span"]
    if span != int(span) or span % 8 or not SPAN[0] <= span <= SPAN[1]:
        raise ValueError(f"span must be a multiple of 8 from {SPAN[0]} to {SPAN[1]} mm")
    mb._integer(p, "drive", 0, 2)
    mb._integer(p, "state", 0, len(STATES) - 1)


def length(family: str, p: dict) -> float:
    return 2*LANDING + float(p["span"])


def ports(family: str, p: dict) -> list[dict]:
    validate(family, p)
    total = length(family, p)
    return [{"id": ident, "position": [x, 0., 0.], "heading": heading, "pitch": 0.,
             "rail_gauge": 2*RAIL, "rail_interface_width": end.PROFILE["railInterfaceWidth"]}
            for ident, x, heading in (("in", 0., math.pi), ("out", total, 0.))]


def route_pairs(family: str, p: dict) -> dict[frozenset, bool]:
    validate(family, p)
    return {frozenset(("in", "out")): int(p["state"]) == 0}


# ------------------------------------------------------------------ 2D / 3D primitives (manifold)
CS, MF = manifold3d.CrossSection, manifold3d.Manifold


def _rect(y0, y1, z0, z1) -> CS:
    return CS.square((y1 - y0, z1 - z0)).translate((y0, z0))


def _disc(r, y=0., z=AXIS_Z, n=360) -> CS:
    return CS.circle(r, n).translate((y, z))


def _polar(r, degrees):
    a = math.radians(degrees)
    return r*math.cos(a), AXIS_Z + r*math.sin(a)


def _sector(r0, r1, a0, a1, n=24) -> CS:
    angles = np.linspace(a0, a1, n)
    points = [_polar(r1, a) for a in angles] + [_polar(r0, a) for a in angles[::-1]]
    return CS([points])


def _hull(sections) -> CS:
    return CS.batch_hull(list(sections))


def _x_prism(section: CS, x0, x1) -> MF:
    """A y-z section extruded along x from x0 to x1."""
    return MF.extrude(section, x1 - x0).transform(np.array([[0., 0, 1, x0], [1, 0, 0, 0], [0, 1, 0, 0]]))


def _x_cylinder(r, x0, x1, y, z, n=48) -> MF:
    return _x_prism(_disc(r, y, z, n), x0, x1)


def _manifold(mesh: trimesh.Trimesh) -> MF:
    return MF(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))


def _trimesh(solid: MF) -> trimesh.Trimesh:
    # Collapse sub-micron edges first (as moving_bridge.check_mesh does): an exported STL would merge them anyway.
    mesh = solid.simplify(1e-5).to_mesh()
    # Manifold splits a vertex where faces from different inputs meet; its merge vectors join them again.
    index = np.arange(len(mesh.vert_properties))
    index[np.asarray(mesh.merge_from_vert, dtype=int)] = np.asarray(mesh.merge_to_vert, dtype=int)
    faces = index[np.asarray(mesh.tri_verts)]
    return trimesh.Trimesh(mesh.vert_properties[:, :3], faces, process=True)


def _union(solids) -> MF:
    return MF.batch_boolean(list(solids), manifold3d.OpType.Add)


def _rot_x(degrees) -> np.ndarray:
    """Cradle pose: turned `degrees` about the barrel axis, +y rising (4x4)."""
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    return np.array([[1., 0, 0, 0], [0, c, -s, AXIS_Z*s], [0, s, c, AXIS_Z - AXIS_Z*c], [0, 0, 0, 1]])


def _posed(solid: MF, matrix) -> MF:
    return solid.transform(np.asarray(matrix)[:3])


# ------------------------------------------------------------------ cradle sections
def loading_gauge() -> CS:
    """Space kept clear for the train (upright): flange corridors, treads, a 6-wide body to the ledges."""
    return _union_cs([_rect(-FACE, FACE, DECK_TOP, LG_TOP), _rect(-LG_HALF, -HEAD_OUT, SILL_TOP, LG_TOP),
                      _rect(HEAD_OUT, LG_HALF, SILL_TOP, LG_TOP), _rect(-LG_HALF, LG_HALF, TOP, LG_TOP)])


def _union_cs(sections) -> CS:
    return CS.batch_boolean(list(sections), manifold3d.OpType.Add)


def body_frame() -> CS:
    """Deck, rails, sills, walls and ledges before the loading gauge is cut: the walls' band inside the ring circle."""
    return _disc(R_MAX) ^ _rect(-WALL_OUT, WALL_OUT, -1., LG_TOP + LEDGE_T)


def load_slot() -> CS:
    """The open slot between the ledges the load pours out of."""
    return _rect(-LEDGE_IN, LEDGE_IN, LG_TOP - .1, LG_TOP + LEDGE_T + 1.)


def _involute(a):
    return math.tan(a) - a


def gear_outline() -> CS:
    """Ring gear: module-1 involute teeth (20 degrees) on GEAR_ARC, a plain rim elsewhere."""
    pitch = MODULE*TEETH/2
    # Tips and rim 0.05 inside the ring: the ring's polygon chords then always enclose them (no sliver steps).
    base, tip, root = pitch*math.cos(PRESSURE), pitch + MODULE - .05, pitch - 1.25*MODULE
    half_pitch = math.pi/(2*TEETH) - BACKLASH/(2*pitch) + _involute(PRESSURE)
    teeth = []
    for k in range(TEETH):
        centre = 360.*k/TEETH
        if not GEAR_ARC[0] <= centre <= GEAR_ARC[1]:
            continue
        flank = []
        for r in np.linspace(root - .3, tip, 10):
            rr = max(r, base)
            half = half_pitch - _involute(math.acos(base/rr))
            flank.append((r, half))
        c = math.radians(centre)
        right = [(r*math.cos(c - h), AXIS_Z + r*math.sin(c - h)) for r, h in flank]
        left = [(r*math.cos(c + h), AXIS_Z + r*math.sin(c + h)) for r, h in flank[::-1]]
        teeth.append(CS([right + left]))
    rim = _sector(root - .5, R_MAX - .05, GEAR_ARC[1] + 1., GEAR_ARC[0] + 359., 240)
    return _union_cs([_disc(root), rim, *teeth])


def _groove(x0) -> MF:
    return _x_prism(_disc(R_MAX + 1.) - _disc(GROOVE_R), x0 + LIP, x0 + RING_T - LIP)


# ------------------------------------------------------------------ geometry
class Geometry:
    def __init__(self, p: dict):
        self.p = p
        self.span = float(p["span"])
        self.L = 2*LANDING + self.span
        self.drive = int(p["drive"])
        L = self.L
        self.XJ = L - D0 - RING_T                     # body / out ring joint
        self.hardware: list[dict] = []
        self.notes: list[str] = []
        self.pinion = _polar(CENTRES, PINION_AT)
        fixed_in, fixed_out = self._stand_in(), self._stand_out()
        self.fixed: list[tuple[str, MF]] = [
            ("landing-in", _union([_manifold(mb.landing(p, 0., LANDING, True)), *fixed_in[0]]) - _union(fixed_in[1])),
            ("landing-out", _union([_manifold(mb.landing(p, L - LANDING, LANDING, False)), *fixed_out[0]]) - _union(fixed_out[1]))]
        if self.drive == 0:
            self.fixed.append(("mechanism-crank", self._crank()))
        self.moving: list[tuple[str, MF]] = [("mechanism-cradle", self._cradle()), ("mechanism-ring-out", self._ring_out())]
        self.ghosts = self._ghosts()
        self.end_on = {"mechanism-cradle", "mechanism-ring-out", "mechanism-crank"}
        self._hardware_and_notes()

    # -- cradle
    def _cradle(self) -> MF:
        x0, xg, xj = D0, D0 + RING_T, self.XJ
        ring = _x_prism(_disc(R_MAX), x0, xg)
        gear = _x_prism(gear_outline(), xg, xg + GEAR_T)
        body = _x_prism(body_frame(), xg + GEAR_T, xj)
        pegs = [_x_cylinder(PEG_R, xj - .01, xj + PEG_L - .3, y, z, 24) for y, z in PEGS]
        pilots = [_x_cylinder(PILOT_R, xj - 12., xj + .1, y, z, 24) for y, z in SCREWS]
        cuts = [_x_prism(loading_gauge(), x0 - 1., xj + 1.), _x_prism(load_slot(), xg + GEAR_T, xj + 1.), _groove(x0), *pilots]
        return _union([ring, gear, body, *pegs]) - _union(cuts)

    def _ring_out(self) -> MF:
        xj, x1 = self.XJ, self.L - D0
        ring = _x_prism(_disc(R_MAX) - loading_gauge(), xj, x1)
        lug = _x_prism(_sector(*STOP_R, *LUG), x1 - .5, x1 + LUG_X)
        holes = [_x_cylinder(PEG_HOLE, xj - .1, xj + PEG_L + .2, y, z, 24) for y, z in PEGS]
        holes += [_x_cylinder(CLEAR_R, xj - .1, x1 + .1, y, z, 24) for y, z in SCREWS]
        holes += [_x_cylinder(MAG_R, x1 - MAG_D, x1 + .1, *_polar(MAG_AT, a), 32) for a in RING_MAGNETS]
        return _union([ring, lug]) - _union([_groove(xj), *holes])

    # -- stands: (additions, cuts) unioned into each landing
    def _roller_boss(self, angle, x_cheek, toward):
        """Cheek boss for a bearing bolt; the spacer reaches `toward` (+1/-1) to the bearing's inner race."""
        y, z = _polar(BEARING_C, angle)
        lo, hi = x_cheek
        spacer = (hi, hi + SPACER) if toward > 0 else (lo - SPACER, lo)
        add = _x_cylinder(SPACER_R, *spacer, y, z)
        cut = _x_cylinder(BOLT_R, lo - SPACER - .1, hi + SPACER + .1, y, z)
        return add, cut

    def _tower(self, angle, x_cheek, foot_far, extra=()):
        y, z = _polar(BEARING_C, angle)
        s = 1. if y > 0 else -1.
        near = abs(y) - 8.
        section = _hull([_disc(8., y, z, 64), _rect(*sorted((s*near, foot_far)), 0., 1.)])
        section = _union_cs([section, _rect(*sorted((s*(HALF - .5), s*(near + 1.))), 0., FOOT), *extra])
        return _x_prism(section, *x_cheek)

    def _stand_in(self):
        x_cheek = (LANDING - CHEEK, LANDING)
        adds, cuts = [], []
        py, pz = self.pinion
        axle_boss = _disc(AXLE_BOSS, py, pz, 64)
        left_extra = [_hull([axle_boss, _disc(8., *_polar(BEARING_C, ROLLERS[0]), 64)]), _rect(-80., -48., 0., 1.)]
        adds += [self._tower(ROLLERS[1], x_cheek, 66.), self._tower(ROLLERS[0], x_cheek, -80., left_extra)]
        for angle in ROLLERS:
            add, cut = self._roller_boss(angle, x_cheek, +1)
            adds.append(add)
            cuts.append(cut)
        # Pinion axle: the cheek's bearing and an inner bracket past the gear plane, on a foot along x.
        bracket = _union_cs([_disc(6., py, pz, 64), _rect(py - 6., -68., 0., pz)])
        adds += [_x_prism(bracket, *BRACKET), _x_prism(_rect(-80., -68., 0., 4.), x_cheek[0], BRACKET[1])]
        # A hair over the motor plate's own bearing cut, so the two never leave coincident facets.
        cuts.append(_x_cylinder(drives.AXLE_BEARING/2 + .03, x_cheek[0] - MOTOR_GAP - 10., BRACKET[1] + .1, py, pz, 32))
        if self.drive:
            # The plate stands MOTOR_GAP off the cheek (its pin holes stay clear of the cheek), on a block joining both.
            frame = np.array([[1., 0, 0, x_cheek[0] - MOTOR_GAP], [0, 1, 0, py], [0, 0, 1, pz], [0, 0, 0, 1]])
            drive = drives.bluetooth_mount(frame, "L") if self.drive == 1 else drives.infrared_mount(frame)
            plate = drive.additions[0].bounds
            adds += [_manifold(m) for m in drive.additions]
            adds.append(_x_prism(_rect(plate[0, 1] + .2, plate[1, 1] - .2, 0., plate[0, 2] + 1.), plate[0, 0] + .2, x_cheek[0] + .5))
            cuts += [_manifold(m) for m in drive.cuts]
            self.motor = drive
            self.motor_frame = frame
        return adds, cuts

    def _stand_out(self):
        L = self.L
        x_cheek = (L - LANDING, L - LANDING + CHEEK)
        adds, cuts = [], []
        y0, y1, top = POST
        for angle, block, s in ((ROLLERS[1], UPRIGHT_BLOCK, 1.), (ROLLERS[0], TIPPED_BLOCK, -1.)):
            extra = [_rect(*sorted((s*y0, s*y1)), 0., top), _sector(*STOP_R, *block)]
            adds.append(self._tower(angle, x_cheek, s*y1, extra))
            add, cut = self._roller_boss(angle, x_cheek, -1)
            adds.append(add)
            cuts.append(cut)
            cuts.append(_x_cylinder(MAG_R, x_cheek[0] - .1, x_cheek[0] + MAG_D, *_polar(MAG_AT, sum(block)/2), 32))
        return adds, cuts

    def _crank(self) -> MF:
        py, pz = self.pinion
        x0, x1 = CRANK_X
        arm = _hull([_disc(AXLE_BOSS, py, pz, 64), _disc(KNOB_R + 1.5, py, pz + CRANK_REACH, 64)])
        hub = _x_cylinder(AXLE_BOSS, x0, LANDING - CHEEK - .3, py, pz, 64)
        knob = _x_cylinder(KNOB_R, x1 - .01, x1 + 10., py, pz + CRANK_REACH, 48)
        frame = np.array([[1., 0, 0, x0], [0, 1, 0, py], [0, 0, 1, pz], [0, 0, 0, 1]])
        axle = _manifold(drives.cross_axle(frame, LANDING - CHEEK - x0 + .2))
        return _union([_x_prism(arm, x0, x1), hub, knob]) - axle

    def _ghosts(self) -> list[tuple[str, MF]]:
        """Bought parts the cradle runs against: four 608 bearings and the pinion's root circle."""
        rows = []
        for ring_x in (D0, self.XJ):
            centre = ring_x + RING_T/2
            for angle in ROLLERS:
                rows.append((f"608 bearing {angle:.0f}° at x {centre:.1f}",
                             _x_cylinder(BEARING_R - .05, centre - BEARING_W/2, centre + BEARING_W/2, *_polar(BEARING_C, angle), 96)))
        root = MODULE*PINION_TEETH/2 - 1.25*MODULE
        xg = D0 + RING_T
        rows.append(("16T pinion root", _x_cylinder(root, xg + 1., xg + GEAR_T - 1., *self.pinion, 64)))
        return rows

    def _hardware_and_notes(self):
        self.hardware += [hw.row(hw.BEARING_608, 4, hw.BEARINGS),
                          hw.row("M8 x 30 mm bolt with M8 nyloc nut and washer", 4, hw.BEARINGS),
                          hw.row(hw.GEAR_16, 1, hw.BRICK),
                          hw.row(hw.AXLE_6, 1, hw.BRICK),
                          hw.row(hw.HALF_BUSH, 2, hw.BRICK),
                          hw.row(hw.MAGNET, 4, hw.MAGNETS),
                          hw.m3_screw(16, 2),
                          hw.row(hw.GLUE, 1, hw.MATERIALS)]
        if self.drive:
            self.hardware += [row for row in self.motor.hardware if row["name"] != hw.AXLE_TO_SUIT]
            self.notes += self.motor.notes
        self.notes += [
            "Press the out ring onto the cradle's four pegs and drive the two M3 x 16 screws through it into the walls.",
            "Bolt a 608 bearing to each stand cheek (bolt head outside, washer, bearing on the spacer, nyloc nut) and set "
            "the cradle's two ring grooves down on the four bearings.",
            "Glue a magnet into each stop block and each out-ring pocket, pairs attracting (check on the bench first).",
            "Slide the cross axle through the in stand's bearing hole, the 16-tooth gear (a half bush either side, meshing "
            "the ring gear) and the inner bracket; fit the " + ("crank on its outer end." if self.drive == 0 else
                                                                 "motor's output onto its outer end."),
            "Run one uncoupled 6-wide wagon (at most 80 mm tall, shorter than the cradle) fully in, then turn the cradle "
            "until its lug meets the far stop (150°); brush the load out from under the tipped cradle, then turn it back "
            "onto the upright stop: the magnets hold it with the rails lined up.",
            "The dumped load lands on the table under the cradle, which clears it by only 2 mm upright: empty it before "
            "tipping back."]


@lru_cache(maxsize=8)
def geometry(span: float, drive: int, adjustment: float, lite: bool, connector: int) -> Geometry:
    p = {"span": span, "drive": drive, "fit_adjustment": adjustment, "connector_version": connector,
         **({"lite": 1} if lite else {})}
    return Geometry(p)


def geometry_of(family: str, p: dict) -> Geometry:
    validate(family, p)
    return geometry(float(p["span"]), int(p["drive"]), float(p["fit_adjustment"]), "lite" in p, int(p["connector_version"]))


def _rows(p):
    g = geometry_of(FAMILIES[0], p)
    return g.fixed + g.moving


# ------------------------------------------------------------------ service interface
def components(family: str, p: dict) -> list[dict]:
    validate(family, p)
    logical = {key: value for key, value in p.items() if key != "state"}
    return [{"role": role, "parameters": {**logical, "component_index": index}} for index, (role, _) in enumerate(_rows(p))]


def component_keys(p: dict) -> set[str]:
    return set(CONNECTOR | set(SHAPES) | {"component_index"})


def _logical(p):
    return {**{key: value for key, value in p.items() if key != "component_index"}, "state": 0}


def validate_component(p: dict) -> None:
    if set(p) - {"lite"} != component_keys(p):
        raise ValueError("unexpected rotary dumper component parameters")
    validate(FAMILIES[0], _logical(p))
    index = p["component_index"]
    if not mb._number(index) or index != int(index) or not 0 <= index < len(_rows(_logical(p))):
        raise ValueError("component_index outside assembly")


def component_ports(p: dict) -> list[dict]:
    return ports(FAMILIES[0], _logical(p))


def _role(p) -> str:
    return _rows(_logical(p))[int(p["component_index"])][0]


def end_on(p: dict) -> bool:
    """Rings, the cradle and the crank print standing on their in-facing end: rings flat, walls and rails upright."""
    return _role(p) in geometry_of(FAMILIES[0], _logical(p)).end_on


def check_mesh(role: str, mesh: trimesh.Trimesh, standing: bool) -> trimesh.Trimesh:
    if not mesh.is_watertight or len(mesh.split(only_watertight=False)) != 1:
        raise ValueError(f"{role} is not a connected watertight component")
    footprint, height = (mesh.extents[[1, 2]], mesh.extents[0]) if standing else (mesh.extents[:2], mesh.extents[2])
    if np.any(footprint > BED + .001) or height > BED_Z:
        raise ValueError(f"{role} exceeds the A1 mini build volume")
    return mesh


def build_component(p: dict) -> cq.Shape:
    validate_component(p)
    role, solid = _rows(_logical(p))[int(p["component_index"])]
    return end._solid(check_mesh(role, _trimesh(solid), end_on(p)))


def hardware(family: str, p: dict) -> list[dict]:
    return list(geometry_of(family, p).hardware)


def assembly_notes(family: str, p: dict) -> list[str]:
    return [*geometry_of(family, p).notes,
            "The cradle, out ring and crank print in the detailed style even on a Fast layout: the rings, gear and "
            "stops need its tolerances."]


# ------------------------------------------------------------------ probes
def _overlap(a: MF, b: MF) -> float:
    return (a ^ b).volume()


def _cradle(g) -> MF:
    return _union([solid for _, solid in g.moving])


def probe_alignment(family: str, p: dict) -> list[dict]:
    """Upright, the cradle's rail heads meet both landings' within 0.3 mm (measured + bearing/stop play)."""
    g = geometry_of(family, p)
    # Only the rail zone: the rings stand far above the rail heads at the same lateral offsets.
    rails = _x_prism(_rect(-LG_HALF, LG_HALF, -1., TOP + .3), -1., g.L + 1.)
    cradle = _trimesh(_cradle(g) ^ rails)
    fixed = {role: _trimesh(solid ^ rails) for role, solid in g.fixed if role.startswith("landing")}
    play = {"lateral": .1, "vertical": .1}
    rows = []
    for end_name, landing_name, x_landing, x_deck in (("in", "landing-in", LANDING - 1., D0 + 2.),
                                                       ("out", "landing-out", g.L - LANDING + 1., g.L - D0 - 2.)):
        a, b = mb._rail_heads(fixed[landing_name], x_landing, 0.), mb._rail_heads(cradle, x_deck, 0.)
        if a is None or b is None:
            raise ValueError(f"no rail section at the {end_name} end")
        lateral = max(abs(a[i][0] - b[i][0]) for i in range(2))
        vertical = max(abs(a[i][1] - b[i][1]) for i in range(2))
        row = {"state": STATES[0], "end": end_name, "lateralMm": round(lateral, 3), "verticalMm": round(vertical, 3),
               "gapMm": GAP, "worstLateralMm": round(lateral + play["lateral"], 3),
               "worstVerticalMm": round(vertical + play["vertical"], 3)}
        if row["worstLateralMm"] > .3 or row["worstVerticalMm"] > .3:
            raise ValueError(f"rail ends misaligned {row}")
        rows.append(row)
    return rows


def train_envelope(L: float) -> list[tuple[str, MF]]:
    """A 6-wide train running through: its body (rail top + 1 .. 80 mm) and both wheel-flange corridors
    (track_assembly's 2.2 x 3.2 mm; the first 6 mm inside each port are the connector's source contacts, as elsewhere)."""
    body = _x_prism(_rect(-WAGON_HALF, WAGON_HALF, TOP + 1., WAGON_TOP), -10., L + 10.)
    low, high = TOP - ta.FLANGE_DEPTH, TOP + .1
    corridors = [_x_prism(_rect(*sorted((s*(FACE - ta.FLANGE_CLEARANCE), s*FACE)), low, high), 6., L - 6.)
                 for s in (1, -1)]
    return [("body", body), ("flange corridors", _union(corridors))]


def probe_running(family: str, p: dict) -> dict:
    """Upright, a 6-wide train passes: no part in its envelope; the narrowest gap to it."""
    g = geometry_of(family, p)
    rows = {}
    for name, envelope in train_envelope(g.L):
        hit, gap = 0., math.inf
        for role, solid in g.fixed + g.moving:
            hit = max(hit, _overlap(envelope, solid))
            gap = min(gap, envelope.min_gap(solid, 5.))
        rows[name] = {"overlapMm3": round(hit, 4), "minGapMm": round(gap, 3)}
    if any(row["overlapMm3"] > .01 for row in rows.values()):
        raise ValueError(f"running clearance violated: {rows}")
    return {**rows, "gauge": "6-wide (48 mm), 80 mm over the rails", "sideClearanceMm": LG_HALF - WAGON_HALF,
            "topClearanceMm": LG_TOP - WAGON_TOP, "deckUnderFlangeMm": round(TOP - ta.FLANGE_DEPTH - DECK_TOP, 2)}


def travel(steps: int = 31) -> list[float]:
    return list(np.linspace(0., TRAVEL, steps))


def probe_motion(family: str, p: dict, steps: int = 31) -> dict:
    """The cradle turned 0..150 degrees never touches a fixed part, a bearing or the pinion, and stays above the table."""
    g = geometry_of(family, p)
    cradle = _cradle(g)
    others = g.fixed + g.ghosts
    worst, lowest = 0., math.inf
    for angle in travel(steps):
        placed = _posed(cradle, _rot_x(angle))
        lowest = min(lowest, placed.bounding_box()[2])
        for role, solid in others:
            volume = _overlap(placed, solid)
            if volume > .01:
                raise ValueError(f"cradle hits {role} at {angle:.1f}°: {volume:.4f} mm^3")
            worst = max(worst, volume)
    if lowest < 1.:
        raise ValueError(f"cradle comes within {lowest:.2f} mm of the table")
    return {"samples": steps, "travel": [0., TRAVEL], "maxOverlapMm3": round(worst, 5), "lowestMm": round(lowest, 3)}


def wagon(g) -> MF:
    """The design wagon in the cradle: 48 x 80 mm body on its wheels, 1 mm in from each cradle end."""
    return _x_prism(_rect(-WAGON_HALF, WAGON_HALF, TOP + 1., WAGON_TOP), D0 + 1., g.L - D0 - 1.)


def _free_travel(moving: MF, cage: MF, direction, limit=6.) -> float:
    """How far `moving` slides along `direction` (cradle frame) before it meets `cage` (bisection, 0.05 mm)."""
    lo, hi = 0., limit
    d = np.asarray(direction, float)/np.linalg.norm(direction)
    if _overlap(moving.translate(tuple(d*hi)), cage) <= .01:
        return math.inf
    while hi - lo > .05:
        mid = (lo + hi)/2
        if _overlap(moving.translate(tuple(d*mid)), cage) > .01:
            hi = mid
        else:
            lo = mid
    return hi


def probe_retention(family: str, p: dict) -> dict:
    """Stops hold both end positions, the bearings hold the cradle along x, and the wagon is caged at every angle."""
    g = geometry_of(family, p)
    cradle = _cradle(g)
    fixed = _union([solid for _, solid in g.fixed])
    bearings = _union([solid for name, solid in g.ghosts if name.startswith("608")])
    pushes = [{"state": "upright", "push": "back past the stop (-1°)",
               "blockedMm3": _overlap(_posed(cradle, _rot_x(-1.)), fixed)},
              {"state": "tipped", "push": "past the stop (+1°)",
               "blockedMm3": _overlap(_posed(cradle, _rot_x(TRAVEL + 1.)), fixed)}]
    for label, dx in (("+x", 1.), ("-x", -1.)):
        pushes.append({"state": "any", "push": label, "blockedMm3": _overlap(cradle.translate((dx, 0., 0.)), bearings)})
    for row in pushes:
        row["blockedMm3"] = round(float(row["blockedMm3"]), 3)
        row["held"] = row["blockedMm3"] > .01
    if not all(row["held"] for row in pushes):
        raise ValueError(f"cradle not retained: {pushes}")
    load = wagon(g)
    angles = []
    for angle in np.linspace(0., TRAVEL, 16):
        a = math.radians(angle)
        gravity = (0., -math.sin(a), -math.cos(a))      # world down, in the cradle's frame
        angles.append({"angleDeg": round(float(angle), 1), "fallsMm": round(_free_travel(load, cradle, gravity), 2)})
    caged = []
    for k in range(12):
        a = 2*math.pi*k/12
        caged.append(_free_travel(load, cradle, (0., math.cos(a), math.sin(a))))
    worst = max(row["fallsMm"] for row in angles)
    if worst > 2. or max(caged) == math.inf:
        raise ValueError(f"wagon not retained: {angles}, caged {caged}")
    return {"stops": pushes, "wagon": angles, "worstFallMm": worst, "cagedEveryDirectionWithinMm": round(max(caged), 2)}


def envelopes(family: str, p: dict) -> list[list[tuple[float, float]]]:
    """Plan polygons the moving parts stay inside (TS rotary-dumper.ts envelopes())."""
    g = geometry_of(family, p)
    rect = lambda x0, x1, y0, y1: [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    polygons = [rect(D0 - .5, g.L - D0 + LUG_X + .5, -R_MAX - .5, R_MAX + .5)]
    if g.drive == 0:
        py = g.pinion[0]
        reach = CRANK_REACH + KNOB_R + 1.5 + .5
        polygons.append(rect(CRANK_X[0] - .5, LANDING - CHEEK, py - reach, py + reach))
    return polygons


def outline(family: str, p: dict) -> list[list[tuple[float, float]]]:
    """Plan polygons of the fixed stands (TS outline()), besides the two landing bodies."""
    g = geometry_of(family, p)
    L, py = g.L, g.pinion[0]
    rect = lambda x0, x1, y0, y1: [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    x_in, x_out = (LANDING - CHEEK, LANDING + SPACER), (L - LANDING - SPACER, L - LANDING + CHEEK)
    polygons = [rect(*x_in, HALF - .5, 66.), rect(*x_in, -80., -HALF + .5), rect(x_in[0], BRACKET[1], -80., py + 6.),
                rect(*x_out, HALF - .5, POST[1]), rect(*x_out, -POST[1], -HALF + .5)]
    if g.drive:
        keepout = np.asarray(g.motor.keepout.bounds()).reshape(2, 2)
        # The plate's support block runs 0.5 mm into the cheek.
        polygons.append(rect(keepout[0, 0], LANDING - CHEEK + .5, keepout[0, 1], keepout[1, 1]))
    return polygons


def _plan(polygons) -> CS:
    return _union_cs([CS([np.asarray(polygon).tolist()]) for polygon in polygons])


def probe_envelopes(family: str, p: dict) -> dict:
    g = geometry_of(family, p)
    union = _plan(envelopes(family, p))
    outside = 0.
    for angle in travel(11):
        placed = _posed(_cradle(g), _rot_x(angle))
        outside = max(outside, (placed.project() - union).area())
    if g.drive == 0:
        crank = dict(g.fixed)["mechanism-crank"]
        py, pz = g.pinion
        for k in range(12):
            turned = crank.translate((0., -py, -pz)).rotate((30.*k, 0., 0.)).translate((0., py, pz))
            outside = max(outside, (turned.project() - union).area())
    # Landing bodies, with the connector tongues that reach 3.7 mm into the neighbouring piece.
    bodies = [[(-4., -HALF), (LANDING, -HALF), (LANDING, HALF), (-4., HALF)],
              [(g.L - LANDING, -HALF), (g.L + 4., -HALF), (g.L + 4., HALF), (g.L - LANDING, HALF)]]
    fixed_plan = _plan(bodies + outline(family, p))
    stray = max((solid.project() - fixed_plan).area() for role, solid in g.fixed if role.startswith("landing"))
    if outside > .5 or stray > .5:
        raise ValueError(f"parts leave the published plan: moving {outside:.2f} mm^2, fixed {stray:.2f} mm^2")
    return {"polygons": len(envelopes(family, p)), "outsideAreaMm2": round(outside, 3), "fixedOutsideOutlineMm2": round(stray, 3)}


def probe_motor(family: str, p: dict, steps: int = 11) -> dict:
    """Motor dumper (Bluetooth 88013 or infrared 88003): the motor on its plate beside the in stand clear of
    every printed part (the cradle posed through its travel) and the bought bearings and pinion, its pin holes and
    bearing open, its output on the pinion axle, and the 16T pinion meshing the module-1 ring gear at its pitch centres
    plus backlash, each tip clear of the other's root."""
    g = geometry_of(family, p)
    if g.drive not in (1, 2):
        raise ValueError("the motor probe covers the motor dumper (drive 1 or 2)")
    cradle = _cradle(g)
    printed = [(role, _trimesh(solid)) for role, solid in g.fixed + g.ghosts]
    printed += [(f"cradle at {angle:.0f}°", _trimesh(_posed(cradle, _rot_x(angle)))) for angle in travel(steps)]
    report = drives.probe_mount(g.motor_frame, "L" if g.drive == 1 else "IR_L", _trimesh(dict(g.fixed)["landing-in"]), printed)
    axle, axis = np.asarray(g.motor.output["axle"]), np.asarray(g.motor.output["axis"])
    py, pz = g.pinion
    centres = float(math.hypot(py, pz - AXIS_Z))
    pitch = MODULE*TEETH/2
    ring_tip, ring_root = pitch + MODULE - .05, pitch - 1.25*MODULE      # gear_outline()
    report["output"] = {"pinionAxleOffsetMm": round(float(math.hypot(axle[1] - py, axle[2] - pz)), 4),
                        "alongPinionAxle": bool(abs(float(axis[0]) - 1.) < 1e-9)}
    report["mesh"] = {"module": MODULE, "ringTeeth": TEETH, "pinionTeeth": PINION_TEETH,
                      "pitchCentresMm": MODULE*(TEETH + PINION_TEETH)/2, "centresMm": round(centres, 4), "backlashMm": BACKLASH,
                      "pinionTipToRingRootMm": round(centres - PINION_TIP_R - ring_root, 3),
                      "ringTipToPinionRootMm": round(centres - ring_tip - PINION_ROOT_R, 3)}
    return report


def probes(family: str, p: dict) -> dict:
    report = {"alignment": probe_alignment(family, p), "running": probe_running(family, p),
              "motion": probe_motion(family, p), "retention": probe_retention(family, p),
              "envelopes": probe_envelopes(family, p)}
    if int(p["drive"]) in (1, 2):
        report["motor"] = probe_motor(family, p)
    return report
