"""Funicular (Experimental): one brick-built car hauled up a steep straight by a string winch; millimetres.

Layout. A purchased straight plank (12 mm thick, at least 70 mm wide) lies at the grade on two printed wedge
feet: the bottom foot stands on the table and its lip catches the plank's lower end, the top foot stands on a
level support the notes give the height of. Both seats are inclined at atan(grade), so the print sets the
angle. On the plank, in its own (slope) frame u along it, y across, w up from its top face, lie:
- the bottom buffer (u 0..64): buffer.py's 64 mm stop, turned so its connector faces up the slope;
- ``length``/128 track pieces (128 mm composite straights with brick connectors at both ends), each with a
  cable-guide saddle fused onto its middle tie between the rails;
- the top station (u 64+length ..): the same 64 mm stop facing down the slope, a 3 mm slot through its block
  on the centreline for the string, and a deck behind it carrying the winch: a printed drum on a
  cross axle between a bearing cheek and the Bluetooth motor's pin plate (drives.bluetooth_mount); ``side``
  puts the motor on the right (1) or the left (-1) of in → out, ``motor`` picks L 88013 (0) or M 88008 (1).
A printed hitch on the car's up-slope coupler carries the string's eye 8.6 mm above the track underside, on the
centreline; the string runs straight from the eye, through the station slot, onto the drum's underside.

Running clearances (probes): saddles stand 5.2 mm above the track underside inside |y| <= 5 (wheel flanges
reach down to ~6.1 mm only at |y| 16.6..20 [INFERENCE: 55423/2878 wheels, tread radius ~8.5, flange ~12]); the
taut string never touches them (they only catch a slack one); the hitch passes 0.8 mm over the connector's centre
key (6.2 mm, the highest point of a track within |y| <= 8) and 1.8 mm over the saddles; the motor
stands behind the top buffer face, where no train reaches.

Path (editor): ``in`` is the track underside at the bottom buffer's low end, (0, 0, Z_IN); ``out`` the same at
the top buffer's high end. Both are stops (cable path). Unverified physical numbers are marked [INFERENCE].
"""
from __future__ import annotations

from functools import lru_cache
import math
from pathlib import Path

import cadquery as cq
import manifold3d
import numpy as np
import trimesh

from . import buffer
from . import composite
from . import drives
from . import hardware as hw
from . import brick_end as end
from . import lite as fast
from . import track_assembly as ta

FAMILIES = ("funicular",)
COMPONENT_FAMILY = "funicular_component"
CONNECTOR = frozenset({"connector_version", "fit_adjustment"})
LOGICAL = frozenset({"length", "grade", "motor", "side"})
MOTORS = ("L", "M")
SOURCE_DEPENDENCIES = [Path(composite.__file__), Path(buffer.__file__), Path(drives.__file__), Path(ta.__file__),
                       Path(fast.__file__), Path(end.__file__)]

# ------------------------------------------------------------------ numbers (funicular.ts FUNICULAR mirrors them)
SEGMENT = 128.                    # one track piece
LENGTHS = (256., 1024.)           # hauled track between the buffers (multiples of SEGMENT)
GRADES = (20, 60)                 # percent
BUFFER_RUN = 64.                  # buffer.py stop, connector to back
FACE = buffer.face(BUFFER_RUN)    # 44: stop face from the connector
STATION = 112.                    # top station part, connector to its back end
PLANK_T, PLANK_W = 12., 70.       # purchased plank thickness / minimum width
FOOT_MIN, SEAT, LIP, LIP_H, FOOT_HALF = 4., 48., 4., 6., 35.   # wedge feet
HALF = end.PROFILE["bodyWidth"]/2                 # 31.9
BASE = end.PROFILE["baseThickness"]               # 3.2: tie tops
RAIL = end.PROFILE["railGauge"]/2                 # 20
CORRIDOR = RAIL - end.PROFILE["railInterfaceWidth"]/2 - ta.FLANGE_CLEARANCE   # 16.6: flange corridor inner edge
FLANGE_LOW = end.RAIL_TOP - 3.5                   # 6.1: wheel flange tip [INFERENCE]
GUIDE_LIMIT = 5.5                                 # brief: guides stay at or below this inside |y| <= 15
# Cable-guide saddle on each track's middle tie (u 62.6..65.4 = the fast deck's brace; clear of the detailed studs).
SADDLE_U, SADDLE_HALF, SADDLE_TOP = (62.6, 65.4), 5., 5.2
GROOVE_W, GROOVE_D = 2.4, 1.
# Winch (top station frame: u from its connector, w from the plank top).
DRUM_U, AXLE_W = 89., 29.         # axle above the M motor's 48 mm box (half 24) plus the 4 mm deck and 1 mm
DECK = 4.
CORE_R, FLANGE_R, FLANGE_T = 8., 14., 2.
DRUM_HALF = 9.                    # y -9..9; 0.5 mm to the plate face and to the cheek
CONE = 6.                         # top flange (print side) is a 45° cone from the core: no overhang
PLATE_FACE = DRUM_HALF + .5       # motor plate front face at y = -9.5
CHEEK = (DRUM_HALF + .5, DRUM_HALF + 5., 8.)   # y0, y1, half-length along u
SLOT_HALF, SLOT_LOW, SLOT_U = 1.5, 4., 40.
ANCHOR_R = .75                    # string anchor hole through the bottom flange
SCREWS = ((72., 25.), (106., 25.))   # station deck screw holes (u, y)
SCREW_R = 1.9                     # 3.5 mm wood screw clearance
# Hitch (hitch frame: u from its back face on the car's coupler, w from the track underside).
COUPLER = buffer.COUPLER          # 25.6: magnet coupler centre above the track underside
EYE_W, EYE_R = 8.6, .7
HITCH = {"leg": 6., "body": 16., "half": 8., "low": 7., "neck": 18., "top": 32.}
MAGNET_R, MAGNET_D = 3.15, 3.2
STUD_R, STUD_H = end.PROFILE["brickAttachment"]["studDiameter"]/2, end.PROFILE["brickAttachment"]["studHeight"]
STRING_D = .5                     # braided line [INFERENCE: 0.3..0.5 mm PE braid]
BED = 166.


# ------------------------------------------------------------------ validation and frames
def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate(family: str, p: dict) -> None:
    if family not in FAMILIES:
        raise ValueError("unknown funicular family")
    required = CONNECTOR | LOGICAL
    if set(p) - {"lite"} != required:
        raise ValueError(f"{family} requires exactly {sorted(required)}")
    if any(not _number(value) for value in p.values()):
        raise ValueError("funicular parameters must be finite numbers")
    if "lite" in p:
        fast.validate(p)
    end.validate(p)
    length = p["length"]
    if length % SEGMENT or not LENGTHS[0] <= length <= LENGTHS[1]:
        raise ValueError("length must be a multiple of 128 mm from 256 to 1024")
    if p["grade"] != int(p["grade"]) or not GRADES[0] <= p["grade"] <= GRADES[1]:
        raise ValueError("grade must be a whole percent from 20 to 60")
    if p["motor"] not in (0, 1):
        raise ValueError("motor must be 0 (L 88013) or 1 (M 88008)")
    if p["side"] not in (-1, 1):
        raise ValueError("side must be 1 (motor on the right of in → out) or -1 (left)")


def theta(grade: float) -> float:
    return math.atan(grade/100.)


def z_in(grade: float) -> float:
    """Track underside height at the bottom buffer's low end (the `in` port)."""
    return FOOT_MIN + PLANK_T*math.cos(theta(grade))


def rail_run(length: float) -> float:
    """Path length along the slope: both buffers and the hauled track."""
    return 2*BUFFER_RUN + length


def plank_length(length: float) -> float:
    return BUFFER_RUN + length + STATION


def slope_point(grade: float, u: float, w: float = 0.) -> tuple[float, float]:
    """Piece-frame (x, z) of slope-frame (u, w): u along the plank top from its lower end, w normal to it."""
    t = theta(grade)
    return u*math.cos(t) - w*math.sin(t), z_in(grade) + u*math.sin(t) + w*math.cos(t)


def slope_matrix(grade: float, u: float, w: float = 0., reverse: bool = False) -> np.ndarray:
    """Slope-frame object (local origin at slope (u, w)) → piece frame; `reverse` turns it 180° about its normal."""
    t, (x, z) = theta(grade), slope_point(grade, u, w)
    c, s = math.cos(t), math.sin(t)
    m = np.array([[c, 0., -s, x], [0., 1., 0., 0.], [s, 0., c, z], [0., 0., 0., 1.]])
    return m @ np.diag([-1., -1., 1., 1.]) if reverse else m


def support_height(p: dict) -> float:
    """Height of the level surface the top foot stands on."""
    return (plank_length(p["length"]) - SEAT)*math.sin(theta(p["grade"]))


def ports(family: str, p: dict) -> list[dict]:
    validate(family, p)
    # Outward pitch, as the editor's portsFromPaths: the in port faces down the slope, the out port up it.
    x, z, t = *slope_point(p["grade"], rail_run(p["length"])), theta(p["grade"])
    return [{"id": ident, "position": position, "heading": heading, "pitch": pitch,
             "rail_gauge": 2*RAIL, "rail_interface_width": end.PROFILE["railInterfaceWidth"]}
            for ident, position, heading, pitch in (("in", [0., 0., z_in(p["grade"])], math.pi, -t), ("out", [x, 0., z], 0., t))]


def route_pairs(family: str, p: dict) -> dict[frozenset, bool]:
    validate(family, p)
    return {frozenset(("in", "out")): True}


# ------------------------------------------------------------------ primitives
def _box(x0, x1, y0, y1, z0, z1):
    return end._box((min(x0, x1), min(y0, y1), min(z0, z1)), (max(x0, x1), max(y0, y1), max(z0, z1)))


def _xz_prism(points, y0, y1):
    """A polygon in the x-z plane extruded across y0..y1."""
    section = manifold3d.CrossSection([np.asarray(points, float).tolist()], manifold3d.FillRule.EvenOdd)
    mesh = section.extrude(y1 - y0).to_mesh()
    v = mesh.vert_properties[:, :3]
    # (x, z, y) → (x, y, z) swaps two axes: reverse the faces to keep them outward.
    return trimesh.Trimesh(np.column_stack([v[:, 0], v[:, 2] + y0, v[:, 1]]), mesh.tri_verts[:, ::-1], process=True)


def _cylinder(radius, axis, centre, low, high, sections=64):
    """A cylinder along `axis` ('x', 'y' or 'z') from low to high, centred on the other two coordinates."""
    mesh = trimesh.creation.cylinder(radius=radius, height=high - low, sections=sections)
    rotate = {"x": trimesh.transformations.rotation_matrix(math.pi/2, (0, 1, 0)),
              "y": trimesh.transformations.rotation_matrix(math.pi/2, (1, 0, 0)), "z": np.eye(4)}[axis]
    mesh.apply_transform(rotate)
    mid = (low + high)/2
    a, b = centre
    mesh.apply_translation({"x": (mid, a, b), "y": (a, mid, b), "z": (a, b, mid)}[axis])
    return mesh


def _shared(connector: int, adjustment: float, lite: bool) -> dict:
    keys = {"connector_version": connector, "fit_adjustment": adjustment, "body_width": end.PROFILE["bodyWidth"],
            "base_thickness": BASE, "rail_gauge": 2*RAIL, "rail_interface_width": end.PROFILE["railInterfaceWidth"],
            "rail_height": end.PROFILE["railHeight"]}
    return {**keys, "lite": 1} if lite else keys


def _check(role: str, mesh: trimesh.Trimesh) -> trimesh.Trimesh:
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


# ------------------------------------------------------------------ parts (each in its print frame, underside z = 0)
def saddle() -> trimesh.Trimesh:
    """Cable guide on a track's middle tie: a block with a V-groove on the centreline (string seat 4.2)."""
    u0, u1 = SADDLE_U
    block = _box(u0, u1, -SADDLE_HALF, SADDLE_HALF, BASE - .1, SADDLE_TOP)
    groove = [(-GROOVE_W/2, SADDLE_TOP + .1), (GROOVE_W/2, SADDLE_TOP + .1), (0., SADDLE_TOP - GROOVE_D)]
    section = manifold3d.CrossSection([groove], manifold3d.FillRule.EvenOdd).extrude(u1 - u0 + .2).to_mesh()
    v = section.vert_properties[:, :3]
    # (y, z, x) → (x, y, z) is a cyclic permutation: orientation kept.
    cut = trimesh.Trimesh(np.column_stack([v[:, 2] + u0 - .1, v[:, 0], v[:, 1]]), section.tri_verts, process=True)
    return ta._difference(block, [cut])


@lru_cache(maxsize=8)
def track_piece(connector: int, adjustment: float, lite: bool) -> trimesh.Trimesh:
    plain = composite.track_mesh(composite.straight(_shared(connector, adjustment, lite), SEGMENT, ends=3))
    return ta._union([plain, saddle()])


@lru_cache(maxsize=8)
def bottom_buffer(connector: int, adjustment: float, lite: bool) -> trimesh.Trimesh:
    return composite.track_mesh(composite.straight(_shared(connector, adjustment, lite), BUFFER_RUN, ends=1), buffer.Builder)


def motor_frame(side: int = 1) -> np.ndarray:
    """drives.bluetooth_mount frame in the station: axle along y towards the drum, plate face at y = -side*PLATE_FACE
    (side 1: motor on the right of in → out, -1: on the left); right-handed for both sides."""
    s = float(side)
    return np.array([[0., -s, 0., DRUM_U], [s, 0., 0., -s*PLATE_FACE], [0., 0., 1., AXLE_W], [0., 0., 0., 1.]])


def motor_drive(motor: int, side: int = 1) -> drives.Drive:
    return drives.bluetooth_mount(motor_frame(side), MOTORS[motor])


def motor_box(motor: int, side: int = 1) -> trimesh.Trimesh:
    """The motor's keep-out box behind the plate (drives.MOTORS), station frame."""
    length, width, height = drives.MOTORS[MOTORS[motor]]["box"]
    y1 = -PLATE_FACE - drives.BEAM
    return _box(DRUM_U - width/2, DRUM_U + width/2, side*(y1 - length), side*y1, AXLE_W - height/2, AXLE_W + height/2)


@lru_cache(maxsize=16)
def top_station(connector: int, adjustment: float, lite: bool, motor: int, side: int = 1) -> trimesh.Trimesh:
    stop = bottom_buffer(connector, adjustment, lite)
    deck = _box(BUFFER_RUN - .1, STATION, -HALF, HALF, 0., DECK)
    plate_low = AXLE_W - (drives.AXLE_PITCH + 4.4)
    plate_half = 2*drives.AXLE_PITCH + 4.4
    pedestal = _box(DRUM_U - plate_half, DRUM_U + plate_half, -side*(PLATE_FACE + drives.BEAM), -side*PLATE_FACE,
                    DECK - .1, plate_low + .1)
    y0, y1, half = CHEEK
    y0, y1 = sorted((side*y0, side*y1))
    cheek = _xz_prism([(DRUM_U - half, DECK - .1), (DRUM_U + half, DECK - .1), (DRUM_U + half, AXLE_W),
                       *[(DRUM_U + half*math.cos(a), AXLE_W + half*math.sin(a)) for a in np.linspace(0, math.pi, 25)[1:-1]],
                       (DRUM_U - half, AXLE_W)], y0, y1)
    body = drives.apply(ta._union([stop, deck, pedestal, cheek]), motor_drive(motor, side))
    cuts = [_box(SLOT_U, BUFFER_RUN + .05, -SLOT_HALF, SLOT_HALF, SLOT_LOW, buffer.BEAM[1] + 1.),
            _cylinder(drives.AXLE_BEARING/2, "y", (DRUM_U, AXLE_W), y0 - .1, y1 + .1)]
    cuts += [_cylinder(SCREW_R, "z", (u, side*y), -.1, DECK + .1, 32) for u, y in SCREWS]
    return ta._difference(body, cuts)


def _foot_section(grade: float, top: bool, length: float):
    """Foot side profile (x, z) with its base at z = 0, and its x offset in the piece frame."""
    t = theta(grade)
    if top:
        u0 = plank_length(length) - SEAT
        base = (u0)*math.sin(t)
        (xa, za), (xb, zb) = slope_point(grade, u0, -PLANK_T), slope_point(grade, u0 + SEAT, -PLANK_T)
        return [(xa, 0.), (xb, 0.), (xb, zb - base), (xa, za - base)], base
    (xa, za), (xb, zb) = slope_point(grade, 0., -PLANK_T), slope_point(grade, SEAT, -PLANK_T)
    (xi, zi), (xo, zo) = slope_point(grade, 0., -PLANK_T + LIP_H), slope_point(grade, -LIP, -PLANK_T + LIP_H)
    return [(xo, 0.), (xb, 0.), (xb, zb), (xa, za), (xi, zi), (xo, zo)], 0.


@lru_cache(maxsize=32)
def foot(grade: float, top: bool, length: float) -> trimesh.Trimesh:
    """Wedge foot in the piece frame, base lowered to z = 0: two vertical screw holes counterbored from below."""
    section, _ = _foot_section(grade, top, length)
    body = _xz_prism(section, -FOOT_HALF, FOOT_HALF)
    seat0 = (plank_length(length) - SEAT) if top else 0.
    cuts = []
    for y in (-20., 20.):
        u = seat0 + .55*SEAT
        x, _ = slope_point(grade, u, -PLANK_T)
        # Seat height above the base at that x (the seat is a plane through section[2], section[3]).
        (xa, za), (xb, zb) = section[3], section[2]
        height = za + (zb - za)*(x - xa)/(xb - xa)
        cuts += [_cylinder(2., "z", (x, y), -.1, height + .1, 32), _cylinder(4., "z", (x, y), -.1, max(.6, height - 5.), 48)]
    return ta._difference(body, cuts)


@lru_cache(maxsize=1)
def drum() -> trimesh.Trimesh:
    """Winding drum, axis along z (print frame): bottom flange 0..2, core to 8, a 45° cone and the top flange to 18."""
    w = 2*DRUM_HALF
    profile = [(0., 0.), (FLANGE_R, 0.), (FLANGE_R, FLANGE_T), (CORE_R, FLANGE_T), (CORE_R, w - FLANGE_T - CONE),
               (FLANGE_R, w - FLANGE_T), (FLANGE_R, w), (0., w)]
    section = manifold3d.CrossSection([profile], manifold3d.FillRule.EvenOdd)
    mesh = manifold3d.Manifold.revolve(section, 96).to_mesh()
    body = trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=True)
    axle = drives.cross_axle(np.array([[0., 1., 0., 0.], [0., 0., 1., 0.], [1., 0., 0., -.1], [0., 0., 0., 1.]]), w + .3)
    anchor = _cylinder(ANCHOR_R, "z", (CORE_R + 1.5, 0.), -.1, FLANGE_T + .1, 24)
    return ta._difference(body, [axle, anchor])


def drum_matrix(side: int = 1) -> np.ndarray:
    """Drum print frame → station frame: print z runs along side*y from the plate (its cone faces the cheek)."""
    s = float(side)
    return np.array([[1., 0., 0., DRUM_U], [0., 0., s, -s*DRUM_HALF], [0., -s, 0., AXLE_W], [0., 0., 0., 1.]])


@lru_cache(maxsize=1)
def hitch() -> trimesh.Trimesh:
    """Car hitch (print frame = hitch frame lowered by its leg bottom): 2x2 studs on top, magnet pocket at
    coupler height on the car face, the string eye in the leg on the centreline."""
    h = HITCH
    profile = [(0., h["low"]), (h["leg"], h["low"]), (h["leg"], h["neck"]), (h["body"], h["neck"] + h["body"] - h["leg"]),
               (h["body"], h["top"]), (0., h["top"])]
    body = _xz_prism(profile, -h["half"], h["half"])
    studs = [_cylinder(STUD_R, "z", (u, y), h["top"] - .1, h["top"] + STUD_H, 48) for u in (4., 12.) for y in (-4., 4.)]
    cuts = [_cylinder(MAGNET_R, "x", (0., COUPLER), -.1, MAGNET_D, 48),
            _cylinder(EYE_R, "x", (0., EYE_W), -.1, h["leg"] + .1, 24)]
    mesh = ta._difference(ta._union([body, *studs]), cuts)
    mesh.apply_translation((0., 0., -h["low"]))
    return mesh


# ------------------------------------------------------------------ components
def _segments(p) -> int:
    return int(p["length"]//SEGMENT)


def roles(p: dict) -> list[str]:
    return [*(f"track-{k + 1}" for k in range(_segments(p))), "buffer-bottom", "station-top", "foot-bottom", "foot-top",
            "mechanism-drum", "mechanism-hitch"]


def _key(p):
    return int(p["connector_version"]), float(p["fit_adjustment"]), fast.enabled(p)


def part_mesh(p: dict, role: str) -> trimesh.Trimesh:
    key = _key(p)
    if role.startswith("track-"):
        return track_piece(*key)
    if role == "buffer-bottom":
        return bottom_buffer(*key)
    if role == "station-top":
        return top_station(*key, int(p["motor"]), int(p["side"]))
    if role.startswith("foot-"):
        return foot(float(p["grade"]), role == "foot-top", float(p["length"]))
    if role == "mechanism-drum":
        return drum()
    if role == "mechanism-hitch":
        return hitch()
    raise ValueError(f"unknown funicular part {role}")


def placement(p: dict, role: str) -> np.ndarray:
    """Print frame → piece frame (the hitch is placed with the car at the top stop)."""
    grade, length = p["grade"], p["length"]
    if role.startswith("track-"):
        return slope_matrix(grade, BUFFER_RUN + (int(role.split("-")[1]) - 1)*SEGMENT)
    if role == "buffer-bottom":
        return slope_matrix(grade, BUFFER_RUN, reverse=True)
    if role == "station-top":
        return slope_matrix(grade, BUFFER_RUN + length)
    if role.startswith("foot-"):
        _, base = _foot_section(grade, role == "foot-top", length)
        return trimesh.transformations.translation_matrix((0., 0., base))
    if role == "mechanism-drum":
        return slope_matrix(grade, BUFFER_RUN + length) @ drum_matrix(int(p["side"]))
    if role == "mechanism-hitch":
        return slope_matrix(grade, BUFFER_RUN + length + FACE - buffer.LIP - HITCH["body"], HITCH["low"])
    raise ValueError(f"unknown funicular part {role}")


def components(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return [{"role": role, "parameters": {**p, "component_index": index}} for index, role in enumerate(roles(p))]


def component_keys(p: dict) -> set[str]:
    return set(CONNECTOR | LOGICAL | {"component_index"})


def _logical(p):
    return {key: value for key, value in p.items() if key != "component_index"}


def validate_component(p: dict) -> None:
    if set(p) - {"lite"} != component_keys(p):
        raise ValueError("unexpected funicular component parameters")
    validate(FAMILIES[0], _logical(p))
    index = p["component_index"]
    if not _number(index) or index != int(index) or not 0 <= index < len(roles(p)):
        raise ValueError("component_index outside assembly")


def _role(p) -> str:
    return roles(p)[int(p["component_index"])]


def component_ports(p: dict) -> list[dict]:
    """Shared brick connector faces of a component in its print frame (plates paints their tongues' supports)."""
    role = _role(p)
    rows = []
    if role.startswith("track-") or role in ("buffer-bottom", "station-top"):
        rows.append({"id": "start", "position": [0., 0., 0.], "heading": math.pi})
    if role.startswith("track-"):
        rows.append({"id": "end", "position": [SEGMENT, 0., 0.], "heading": 0.})
    return rows


def build_component(p: dict) -> cq.Shape:
    validate_component(p)
    role = _role(p)
    return end._solid(_check(role, part_mesh(p, role)))


# ------------------------------------------------------------------ hardware and notes
def string_length(p: dict) -> float:
    """String to buy: drum to the eye with the car at the bottom stop, plus wraps and a knot margin."""
    return math.ceil((BUFFER_RUN + p["length"] + DRUM_U - (BUFFER_RUN - FACE) + 3*2*math.pi*CORE_R + 300.)/100.)*100.


def hardware(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return [*motor_drive(int(p["motor"]), int(p["side"])).hardware,
            hw.row(f"Braided fishing line 0.3-0.5 mm, {string_length(p):.0f} mm", 1, hw.MATERIALS),
            hw.row(f"Straight wooden plank {PLANK_W:.0f} mm or wider x {PLANK_T:.0f} mm, cut to "
                   f"{plank_length(p['length']):.0f} mm", 1, hw.MATERIALS),
            hw.wood_screw("3.5 x 16", 6),
            hw.row(hw.MOUNTING_TAPE, 1, hw.MATERIALS),
            hw.row(hw.MAGNET, 1, hw.MAGNETS)]


def assembly_notes(family: str, p: dict) -> list[str]:
    validate(family, p)
    grade, length = p["grade"], p["length"]
    motor = drives.MOTORS[MOTORS[int(p["motor"])]]["name"]
    return [f"Cut the plank to {plank_length(length):.0f} mm with square ends. Screw the bottom foot under its lower end "
            "(the plank's end against the foot's lip) and the top foot under its upper end, flush with it.",
            f"Stand the bottom foot on the table and the top foot on a level support {support_height(p):.0f} mm high "
            f"(a shelf, a box or stacked bricks); shim it until both seats lie flat under the plank: the plank is then "
            f"at {grade:.0f} % ({math.degrees(theta(grade)):.1f}°).",
            f"Lay the track on the plank from the bottom: the bottom buffer (its block at the plank's lower end), "
            f"{_segments(p)} tracks joined end to end, then the top station; tape each one down and screw the station's "
            "deck to the plank through its two holes.",
            *motor_drive(int(p["motor"]), int(p["side"])).notes,
            f"Push a cross axle (5 studs) from the {motor}'s output through the plate's bearing, the drum and "
            "the cheek's bearing; the drum's large cone faces the cheek. [INFERENCE: axle length]",
            "Knot one end of the line through the drum's anchor hole, wind three turns, run it down through the slot in "
            "the station's buffer block and over the cable guides, and tie it to the hitch's eye.",
            "Press the hitch's magnet into its pocket so that it attracts the car's up-slope magnet coupler, or bridge "
            "the hitch's studs to the car with a brick plate (stronger: use it above 35 % or for heavy cars).",
            "Wind the car up and let it down on the hub's motor control; stop it before the buffers (the buffers are a "
            "safety stop). Keep the line taut: a slack line drops into the guides' grooves, never under the wheels.",
            "Experimental: the drum torque, magnet hold and line wear are physical trials. [INFERENCE]"]


# ------------------------------------------------------------------ probes
def _overlap(a, b) -> float:
    if np.any(a.bounds[0] > b.bounds[1]) or np.any(b.bounds[0] > a.bounds[1]):
        return 0.
    return float(abs(trimesh.boolean.intersection([a, b], engine="manifold").volume))


def _placed(p, role):
    return part_mesh(p, role).copy().apply_transform(placement(p, role))


def probe_parts(p: dict) -> list[dict]:
    """Every printed part: one watertight solid within the 166 mm usable mini bed."""
    report = []
    for role in roles(p):
        checked = _check(role, part_mesh(p, role))
        report.append({"role": role, "volumeMm3": round(float(checked.volume), 1),
                       "sizeMm": [round(float(v), 1) for v in checked.extents]})
    return report


def _drum_tangent(u_eye: float, w_eye: float, station_u: float) -> tuple[float, float]:
    """Point where the line from the eye meets the drum core's underside (lower tangent), slope frame."""
    cu, cw, r = station_u + DRUM_U, AXLE_W, CORE_R + STRING_D/2
    dx, dz = cu - u_eye, cw - w_eye
    d = math.hypot(dx, dz)
    angle = math.atan2(dz, dx) - math.asin(r/d)
    run = math.sqrt(d*d - r*r)
    return u_eye + run*math.cos(angle), w_eye + run*math.sin(angle)


def probe_string(p: dict, samples: int = 41) -> dict:
    """The taut line from the hitch eye to the drum, for every car position: clear of the saddles, inside the slot."""
    length = p["length"]
    station_u = BUFFER_RUN + length
    top_eye = station_u + FACE - buffer.LIP - HITCH["body"] + HITCH["leg"]
    saddles = [BUFFER_RUN + k*SEGMENT + sum(SADDLE_U)/2 for k in range(_segments(p))]
    slot = (station_u + SLOT_U, station_u + BUFFER_RUN)
    over, low, high = math.inf, math.inf, -math.inf
    for u_eye in np.linspace(BUFFER_RUN - FACE, top_eye, samples):
        tu, tw = _drum_tangent(u_eye, EYE_W, station_u)
        line = lambda u: EYE_W + (tw - EYE_W)*(u - u_eye)/(tu - u_eye)
        for s in saddles:
            if s > u_eye:
                over = min(over, line(s) - STRING_D/2 - SADDLE_TOP)
        for u in slot:
            if u > u_eye:
                low, high = min(low, line(u) - STRING_D/2), max(high, line(u) + STRING_D/2)
    slot_top = buffer.BEAM[1] + 1.
    return {"carPositions": samples, "lineOverSaddlesMm": round(over, 2),
            "lineInSlotMm": [round(low, 2), round(high, 2)], "slotMm": [SLOT_LOW, slot_top],
            "slotSideClearanceMm": round(SLOT_HALF - STRING_D/2, 2),
            "insideSlot": bool(low >= SLOT_LOW and high <= slot_top)}


def probe_running(p: dict) -> dict:
    """Saddles and the hitch against the wheels' reach, the tie studs and the car-side limits: the saddle adds nothing
    in a flange corridor or above the guide limit, and the hitch (moved over a whole track) touches nothing."""
    key = _key(p)
    piece = track_piece(*key)
    plain = composite.track_mesh(composite.straight(_shared(*key), SEGMENT, ends=3))
    added = ta._difference(piece, [plain])
    corridors = [_box(-5., SEGMENT + 5., s*CORRIDOR, s*(RAIL - end.PROFILE["railInterfaceWidth"]/2), FLANGE_LOW, end.RAIL_TOP + 20.)
                 for s in (-1, 1)]
    above = _box(-5., SEGMENT + 5., -15., 15., GUIDE_LIMIT, end.RAIL_TOP + 40.)
    hitch_mesh = hitch().copy()
    hitch_mesh.apply_translation((0., 0., HITCH["low"]))
    worst_hitch = max(_overlap(hitch_mesh.copy().apply_translation((u, 0., 0.)), piece)
                      for u in np.arange(-HITCH["body"], SEGMENT + 2., 2.))
    v = piece.vertices
    under = float(v[np.abs(v[:, 1]) <= HITCH["half"] + .01][:, 2].max())
    return {"saddleTopMm": round(float(added.bounds[1, 2]), 2), "guideLimitMm": GUIDE_LIMIT,
            "saddleHalfWidthMm": round(float(np.abs(added.bounds[:, 1]).max()), 2), "flangeCorridorMm": round(CORRIDOR, 2),
            "saddleInCorridorsMm3": round(sum(_overlap(added, box) for box in corridors), 4),
            "saddleAboveLimitMm3": round(_overlap(added, above), 4),
            "hitchBottomMm": HITCH["low"], "trackTopUnderHitchMm": round(under, 2),
            "hitchOverTrackMm": round(HITCH["low"] - under, 2), "hitchOverSaddleMm": round(HITCH["low"] - SADDLE_TOP, 2),
            "hitchHalfWidthMm": HITCH["half"], "hitchTrackOverlapMm3": round(worst_hitch, 4)}


def probe_drum(p: dict) -> dict:
    """Drum capacity for the line, and its fit between the motor plate and the cheek."""
    width = 2*DRUM_HALF - 2*FLANGE_T - CONE      # cylindrical winding width
    turns = math.floor(width/STRING_D)
    layers = math.floor((FLANGE_R - 1. - CORE_R)/STRING_D)
    capacity = sum(turns*2*math.pi*(CORE_R + STRING_D*(k + .5)) for k in range(layers))
    first = turns*2*math.pi*(CORE_R + STRING_D/2)
    needed = BUFFER_RUN + p["length"] + DRUM_U - (BUFFER_RUN - FACE) + 3*2*math.pi*CORE_R
    station = top_station(*_key(p), int(p["motor"]), int(p["side"]))
    placed = drum().copy().apply_transform(drum_matrix(int(p["side"])))
    span = placed.bounds[:, 1]
    axis = (placed.bounds[0] + placed.bounds[1])/2
    return {"neededMm": round(needed), "firstLayerMm": round(first), "capacityMm": round(capacity),
            "drumStationOverlapMm3": round(_overlap(placed, station), 4),
            "drumSpanYMm": [round(float(v), 2) for v in span],
            "drumAxisOffsetMm": round(float(math.hypot(axis[0] - DRUM_U, axis[2] - AXLE_W)), 3),
            "axialPlayMm": round(PLATE_FACE - DRUM_HALF, 2), "flangeOverDeckMm": round(AXLE_W - FLANGE_R - DECK, 2)}


def probe_motor(p: dict) -> dict:
    """The motor's keep-out box against the station and the space a train can reach (up to the buffer face)."""
    motor, side = int(p["motor"]), int(p["side"])
    box = motor_box(motor, side)
    station = top_station(*_key(p), motor, side)
    reach_u = FACE - buffer.LIP                  # coupler face at the beam: nothing of the train passes it
    return {"motor": MOTORS[motor], "boxStationOverlapMm3": round(_overlap(box, station), 4),
            "boxClearOfTrainMm": round(float(box.bounds[0, 0]) - reach_u, 2),
            "boxAbovePlankMm": round(float(box.bounds[0, 2]), 2),
            "keepoutPlanMm": [[round(float(v), 1) for v in row] for row in box.bounds[:, :2]]}


def probe_plank(p: dict) -> dict:
    """The plank seats on both feet (no overlap, < 0.05 mm gap) and carries every track part."""
    grade, length = p["grade"], p["length"]
    plank = _box(0., plank_length(length), -PLANK_W/2, PLANK_W/2, -PLANK_T, 0.)
    plank.apply_transform(slope_matrix(grade, 0.))
    rows = {}
    for role in ("foot-bottom", "foot-top"):
        placed = _placed(p, role)
        touch = _overlap(placed, plank.copy().apply_translation((0., 0., -.05)))
        rows[role] = {"overlapMm3": round(_overlap(placed, plank), 4), "seatedMm3": round(touch, 1)}
    parts = [_placed(p, role) for role in roles(p) if not role.startswith(("foot-", "mechanism-hitch"))]
    worst = max(_overlap(part, plank) for part in parts)
    return {"feet": rows, "partsOnPlankOverlapMm3": round(worst, 4), "supportHeightMm": round(support_height(p), 1),
            "plankLengthMm": plank_length(length)}


def probes(family: str, p: dict) -> dict:
    validate(family, p)
    return {"parts": probe_parts(p), "string": probe_string(p), "running": probe_running(p), "drum": probe_drum(p),
            "motor": probe_motor(p), "plank": probe_plank(p)}
