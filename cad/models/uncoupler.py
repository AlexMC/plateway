"""Uncoupler track: a 128 mm (16-stud) straight whose flap rises between the rails to part a train; millimetres.

Operating principle: stop the train with the coupling to be parted just past the flap, raise the flap (it stands
up between the loco's rear bogie and the first wagon's leading bogie) and drive the loco on. The wagon's leading
bogie runs into the raised flap and stays behind while the loco pulls its magnetic coupling apart. Whether a given
coupler and bogie are caught (and parted, not derailed) is a physical trial gate.

The base is the point-blade framework's plain straight (turnout.py with one route and no switches): rigid source
contacts at both ports, the shared rail profile, hollow stringers and the 128 mm tie/clutch layout. Between the
rails, the middle tie's centre and the tie gap after it become the flap's well. The flap is a 4.4 mm slab that
lies flush (0.2..4.6 mm, below the 4.8 mm tie-stud tops) when lowered and stands 19.55 mm tall (about 10 mm above
the 9.6 mm rail top) when raised, across the gauge centre and clear of both flange corridors. It turns 90° on a
printed D-shaft along y: the rocker's shaft runs under the near rail through solid stringers in the tie gap
(a closed bearing on both sides, so the flap cannot lift out) and keys the flap; the rocker's arm stands outside
the track, beyond any train's body (|y| > 32.4), where the drive works it:
- drive 0 (magnet/manual): a 6x3 mm magnet in the arm meets one of two magnets in the base block, coaxial at
  the lowered and the raised position; a bayonet cheek holds the arm in except at mid-throw, where it was inserted;
- drive 1 (servo): an SG90 lying on its side (drives.sg90_cradle) in the 64 mm gap to a parallel track at 128 mm
  centres; a printed link with 1.75 mm filament pins joins its horn to the arm (horn within about ±20°).
The raised flap leans on a stop bar, so a train running in → out pushes it onto the bar; the other way the
detent or the servo holds it. The mechanism zone has a solid underside: seat the piece on a flat surface.
Fast print keeps the mechanism and swaps the base for turnout.py's fast deck.
"""
from __future__ import annotations

from functools import lru_cache
import math
from pathlib import Path

import cadquery as cq
import manifold3d
import numpy as np
import trimesh

from . import drives
from . import hardware as hw
from . import brick_end as end
from . import lite as fast
from . import track_assembly as ta
from . import turnout as T

FAMILIES = ("uncoupler_track",)
COMPONENT_FAMILY = "uncoupler_component"
CONNECTOR = frozenset({"connector_version", "fit_adjustment"})
LOGICAL = frozenset({"drive", "switch_state"})
STATES = ("lowered", "raised")
DRIVES = ("magnet", "servo")
SOURCE_DEPENDENCIES = [Path(T.__file__), Path(drives.__file__), *T.SOURCE_DEPENDENCIES]

# ------------------------------------------------------------------ geometry
LENGTH = 128.
RAIL, HEAD, TOP, BASE = T.RAIL, T.HEAD, T.TOP, T.BASE
INNER = RAIL - end.PROFILE["baseStringerWidth"]/2       # 16.1: stringer inner face
OUTER = RAIL + end.PROFILE["baseStringerWidth"]/2       # 23.9: stringer outer face
STUD_TOP = end.PROFILE["brickAttachment"]["studBaseZ"] + end.PROFILE["brickAttachment"]["studHeight"]   # 4.8
CORRIDOR = T.FACE - T.FLANGE                            # 16.6: inner edge of a flange corridor
CLEAR = .4
TIE = end.tie_intervals(LENGTH)[2]                      # (56.1, 71.9): the middle tie
GAP = (TIE[1], end.tie_intervals(LENGTH)[3][0])         # (71.9, 88.1): the tie gap carrying the hinge
AXIS_X, AXIS_Z = (GAP[0] + GAP[1])/2, 2.4               # hinge axis along y
FLAP_LOW, FLAP_TOP = .2, 4.6                            # lowered slab; its hinge end is round about the axis
FLAP_REACH = 17.15                                      # axis to tip: raised top 19.55
FLAP_HALF = INNER - CLEAR                               # 15.7
WELL = (62.45, 82.5)                                    # well between the stringers (x)
SHAFT_R, FLAT = 1.4, 1.5                                # D-shaft: flat at z=1.5 when lowered (printing face)
SOCKET_R, SOCKET_FLAT = 1.5, 1.4
BORE_R = 1.55
SHAFT_END = INNER + 1.2                                 # tip in the far stringer
HUB_R = AXIS_Z - FLAP_LOW                               # 2.2
STOP_BAR = (WELL[1], GAP[1] + .2)                       # raised flap leans on it, 0.3 mm off
STOP_TOP = 4.6
GAP_FILL = (GAP[0] + CLEAR, GAP[1] - CLEAR)             # solid stringers and bearing block in the tie gap
BEARING_Y = -32.4                                       # bearing block outer face; trains reach |y| <= 32
TRAIN_HALF = 32.                                        # 8-wide brick body: |y| <= 32 above the rail top
SLAB = 1.2                                              # drive floor
PIN_HOLE, PIN_FREE = .9, 1.0                            # 1.75 filament: snug in the arm, free in the link

# drive 0: magnet detents (6 x 3 mm discs, axes along y)
MAGNET_R, MAGNET_T = 3., 3.
POCKET_R, POCKET_DEPTH = 3.1, 3.1
DETENT_RADIUS = 6.
DETENT_LOWERED = math.radians(135)                      # arm angle in the x-z plane (from +x towards +z)
MAGNET_BLOCK = (70.4, 89.6, -36., BEARING_Y, 11.)       # x0, x1, y0, y1, top
MAGNET_ARM = (-40.5, -36.4)                             # rocker arm y span (inner face carries the magnet)
MAGNET_BOSS = 4.
CHEEK = (-43.3, -40.9, 66., 94., 12.5)                  # bayonet cheek y0, y1, x0, x1, top
WINDOW_GROW = .6

# drive 1: SG90 four-bar (horn pin radius 10, link 22, arm 4)
SERVO_ARM = (-35.8, -32.8)
LINK = (-39.2, -36.2)
HORN_FACE = -42.                                        # horn inner face (drives frame origin plane)
SERVO_X = 97.                                           # servo shaft x
CRANK_R, CRANK_LOWERED = 4., math.radians(165)
LINK_LENGTH, LINK_BOSS = 22., 2.2
HORN_PIN = 10.
HORN_LIMIT = math.radians(25)

# Plan polygons (piece frame) the moving parts and the drive stay inside; uncoupler.ts mirrors them.
ENVELOPES = {"flap": [(WELL[0] - .05, -OUTER), (WELL[1] + .1, -OUTER), (WELL[1] + .1, SHAFT_END + .4), (WELL[0] - .05, SHAFT_END + .4)],
             "magnet": [(64., -45.), (96., -45.), (96., -OUTER), (64., -OUTER)],
             "servo": [(70., -74.), (124., -74.), (124., -OUTER), (70., -OUTER)]}

PORTS = (T.Port("in", 0., 0., math.pi), T.Port("out", LENGTH, 0., 0.))
SPEC = T.Spec(PORTS, (T.Route("main", "in", "out", ((0., 0., 0.), (LENGTH, 0., 0.))),), (),
              (T.State("lowered", ()), T.State("raised", ())), seams=())


# ------------------------------------------------------------------ helpers
def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _circle(x, z, r, n=64):
    return manifold3d.CrossSection.circle(r, n).translate((x, z))


def _rect(x0, z0, x1, z1):
    return T._section([(x0, z0), (x1, z0), (x1, z1), (x0, z1)])


def _hull(*sections):
    return manifold3d.CrossSection.hull_points(np.vstack([T._vertices(s) for s in sections]).tolist())


def _xz(section, y0, y1) -> trimesh.Trimesh:
    """A section in the (x, z) plane extruded along y from y0 to y1."""
    solid = section.extrude(y1 - y0).transform([[1, 0, 0, 0], [0, 0, -1, y1], [0, 1, 0, 0]])
    mesh = solid.to_mesh()
    return trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=False)


def _y_cylinder(x, z, r, y0, y1):
    return _xz(_circle(x, z, r), y0, y1)


def _rotation(theta) -> np.ndarray:
    """Raise by `theta` (radians) about the hinge axis: the flap tip goes from -x up to +z."""
    return trimesh.transformations.rotation_matrix(theta, (0, 1, 0), point=(AXIS_X, 0, AXIS_Z))


def _rotated(section, theta):
    """A section in the x-z plane turned with the rocker (its x-z angle decreases by theta)."""
    c, s = math.cos(theta), math.sin(theta)
    return section.translate((-AXIS_X, -AXIS_Z)).transform([[c, s, 0], [-s, c, 0]]).translate((AXIS_X, AXIS_Z))


def _polar(radius, angle):
    return AXIS_X + radius*math.cos(angle), AXIS_Z + radius*math.sin(angle)


def _overlap(a, b):
    return T._overlap(a, b)


def _moved(mesh, offset):
    out = mesh.copy()
    out.apply_translation(offset)
    return out


def _posed(mesh, theta):
    return mesh.copy().apply_transform(_rotation(theta))


def _prism_plan(points, low, high):
    return T._prism(T._section(points), low, high)


# ------------------------------------------------------------------ servo four-bar
def servo_frame() -> np.ndarray:
    """drives.sg90_cradle frame: shaft along piece +y (towards the track), horn pin moving along piece -x."""
    return np.array([[0., -1., 0., SERVO_X], [1., 0., 0., HORN_FACE], [0., 0., 1., 0.], [0., 0., 0., 1.]])


def crank_pin(theta):
    return np.array(_polar(CRANK_R, CRANK_LOWERED - theta))


def horn_pin(alpha):
    return np.array((SERVO_X - HORN_PIN*math.sin(alpha), drives.SG90_SHAFT_Z + HORN_PIN*math.cos(alpha)))


def horn_angle(theta) -> float:
    """Horn angle (radians from upright, + moves the pin to -x) holding the flap at `theta`."""
    p, shaft = crank_pin(theta), np.array((SERVO_X, drives.SG90_SHAFT_Z))
    d = float(np.linalg.norm(p - shaft))
    if not abs(HORN_PIN - LINK_LENGTH) < d < HORN_PIN + LINK_LENGTH:
        raise ValueError("servo link cannot reach the crank pin")
    a = (HORN_PIN**2 - LINK_LENGTH**2 + d*d)/(2*d)
    h = math.sqrt(HORN_PIN**2 - a*a)
    base = shaft + a*(p - shaft)/d
    normal = np.array((-(p - shaft)[1], (p - shaft)[0]))/d
    pins = [base + h*normal, base - h*normal]
    pin = max(pins, key=lambda q: q[1])         # the horn points up
    return math.atan2(SERVO_X - pin[0], pin[1] - drives.SG90_SHAFT_Z)


# ------------------------------------------------------------------ moving parts (lowered pose = print pose)
def _flap_section():
    profile = _rect(AXIS_X - FLAP_REACH, FLAP_LOW, AXIS_X, FLAP_TOP) + _circle(AXIS_X, AXIS_Z, HUB_R)
    socket = _circle(AXIS_X, AXIS_Z, SOCKET_R) ^ _rect(AXIS_X - 3, SOCKET_FLAT, AXIS_X + 3, AXIS_Z + 3)
    return profile - socket


@lru_cache(maxsize=1)
def flap_mesh() -> trimesh.Trimesh:
    return _xz(_flap_section(), -FLAP_HALF, FLAP_HALF)


def _shaft_section():
    return _circle(AXIS_X, AXIS_Z, SHAFT_R) ^ _rect(AXIS_X - 3, FLAT, AXIS_X + 3, AXIS_Z + 3)


def _arm_section(drive):
    if drive == 0:
        boss = _circle(*_polar(DETENT_RADIUS, DETENT_LOWERED), MAGNET_BOSS)
    else:
        boss = _circle(*crank_pin(0.), LINK_BOSS)
    floor = _rect(min(T._vertices(boss)[:, 0]), FLAT, AXIS_X, FLAT + .01)
    return _hull(_circle(AXIS_X, AXIS_Z, HUB_R), boss, floor) ^ _rect(AXIS_X - 30, FLAT, AXIS_X + 30, 40)


def _arm_span(drive):
    return MAGNET_ARM if drive == 0 else SERVO_ARM


@lru_cache(maxsize=2)
def rocker_mesh(drive: int) -> trimesh.Trimesh:
    y0, y1 = _arm_span(drive)
    arm = _xz(_arm_section(drive), y0, y1)
    shaft = _xz(_shaft_section(), y1 - .5, SHAFT_END)
    rocker = ta._union([arm, shaft])
    if drive == 0:
        x, z = _polar(DETENT_RADIUS, DETENT_LOWERED)
        return ta._difference(rocker, [_y_cylinder(x, z, POCKET_R, y1 - POCKET_DEPTH, y1 + .1)])
    x, z = crank_pin(0.)
    return ta._difference(rocker, [_y_cylinder(x, z, PIN_HOLE, y0 - .1, y1 + .1)])


def _link_section(theta):
    p, h = crank_pin(theta), horn_pin(horn_angle(theta))
    body = _hull(_circle(*p, LINK_BOSS), _circle(*h, LINK_BOSS))
    return body - _circle(*p, PIN_FREE, 32) - _circle(*h, PIN_FREE, 32)


@lru_cache(maxsize=1)
def link_mesh() -> trimesh.Trimesh:
    return _xz(_link_section(0.), *LINK)


def link_at(theta) -> trimesh.Trimesh:
    return _xz(_link_section(theta), *LINK)


# ------------------------------------------------------------------ fixed base
def _cradle():
    return drives.sg90_cradle(servo_frame(), pin_radius=HORN_PIN, angle=HORN_LIMIT)


def _sweep(section_at, steps=46):
    swept = T._union_cs([section_at(t) for t in np.linspace(0., math.pi/2, steps)])
    return swept.offset(CLEAR, manifold3d.JoinType.Round)


def _magnet_centres():
    """Base magnet centres (x, z): the arm magnet's lowered and raised positions."""
    return [_polar(DETENT_RADIUS, DETENT_LOWERED), _polar(DETENT_RADIUS, DETENT_LOWERED - math.pi/2)]


def _cheek_window():
    arm = _rotated(_arm_section(0), math.pi/4) + _circle(AXIS_X, AXIS_Z, HUB_R)
    return arm.offset(WINDOW_GROW, manifold3d.JoinType.Round)


@lru_cache(maxsize=8)
def base_mesh(drive: int, adjustment: float, lite: bool = False) -> trimesh.Trimesh:
    plain = T._fixed_mesh(SPEC, adjustment, lite)
    cuts = [end._box((WELL[0], -INNER, -1), (WELL[1], INNER, 30)),
            # under the kept half of the middle tie: its studs stay, its clutch bay is refilled
            end._box((TIE[0] - .01, -INNER, -1), (WELL[0] + .01, INNER, BASE))]
    body = ta._difference(plain, cuts)
    additions = [end._box((TIE[0], -INNER - .05, 0), (WELL[0], INNER + .05, BASE + .05)),
                 end._box((STOP_BAR[0], -INNER - .05, 0), (STOP_BAR[1], INNER + .05, STOP_TOP))]
    additions += [end._box((GAP_FILL[0], low, 0), (GAP_FILL[1], high, BASE))
                  for low, high in ((INNER - .05, OUTER), (-OUTER, -INNER + .05))]
    additions.append(end._box((GAP_FILL[0], BEARING_Y, 0), (GAP_FILL[1], -OUTER + .05, STUD_TOP)))
    arm_y0, arm_y1 = _arm_span(drive)
    if drive == 0:
        x0, x1, y0, y1, top = MAGNET_BLOCK
        cy0, cy1, cx0, cx1, ctop = CHEEK
        additions += [end._box((x0, y0, 0), (x1, y1 + .05, top)),
                      end._box((cx0, cy0, 0), (cx1, y0 + .05, SLAB))]
        cheek = _rect(cx0, 0, cx1, ctop) - _cheek_window()
        additions += [_xz(part, cy0, cy1) for part in T._parts(cheek)]
    else:
        cradle = _cradle()
        width = max(mesh.bounds[1, 0] for mesh in cradle.additions)
        additions.append(end._box((GAP_FILL[0], HORN_FACE - drives.SG90_HORN_PLANE - .05, 0), (width, BEARING_Y + .05, SLAB)))
    body = ta._union([body, *additions])
    if drive == 1:
        body = drives.apply(body, cradle)
    clearance = [_y_cylinder(AXIS_X, AXIS_Z, BORE_R, arm_y1 - .5, SHAFT_END + .3),
                 _xz(_sweep(lambda t: _rotated(_arm_section(drive), t)), arm_y0 - CLEAR + .05, arm_y1 + CLEAR - .05)]
    if drive == 0:
        clearance += [_y_cylinder(x, z, POCKET_R, MAGNET_BLOCK[2] - .1, MAGNET_BLOCK[2] + POCKET_DEPTH)
                      for x, z in _magnet_centres()]
    else:
        clearance.append(_xz(_sweep(_link_section), LINK[0] - CLEAR + .05, LINK[1] + CLEAR - .05))
    return ta._difference(body, clearance)


# ------------------------------------------------------------------ components
@lru_cache(maxsize=8)
def component_meshes(drive: int, adjustment: float, lite: bool = False) -> list:
    rows = [("base", base_mesh(drive, adjustment, lite)), ("mechanism-flap", flap_mesh()),
            ("mechanism-rocker", rocker_mesh(drive))]
    if drive == 1:
        rows.append(("mechanism-link", link_mesh()))
    return rows


def moving_parts(drive: int, theta: float) -> list[tuple[str, trimesh.Trimesh]]:
    """Every moving part with the flap raised by `theta` (0 lowered, pi/2 raised)."""
    rows = [("flap", _posed(flap_mesh(), theta)), ("rocker", _posed(rocker_mesh(drive), theta))]
    if drive == 1:
        rows.append(("link", link_at(theta)))
    return rows


def assembly_mesh(drive: int, state: int, adjustment: float, lite: bool = False) -> trimesh.Trimesh:
    theta = state*math.pi/2
    return ta._union([base_mesh(drive, adjustment, lite), *[mesh for _, mesh in moving_parts(drive, theta)]])


# ------------------------------------------------------------------ registry interface
def validate(family: str, p: dict) -> None:
    if family not in FAMILIES:
        raise ValueError("unknown uncoupler family")
    required = CONNECTOR | LOGICAL
    if set(p) - {"lite"} != required:
        raise ValueError(f"{family} requires exactly {sorted(required)}")
    if any(not _number(value) for value in p.values()):
        raise ValueError("uncoupler parameters must be finite numbers")
    fast.validate(p)
    end.validate(p)
    if p["drive"] not in (0, 1):
        raise ValueError("drive must be 0 (magnet/manual) or 1 (servo)")
    if p["switch_state"] not in (0, 1):
        raise ValueError("switch_state must be 0 (lowered) or 1 (raised)")


def ports(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return T.port_rows(SPEC)


def route_pairs(family: str, p: dict) -> dict[frozenset, bool]:
    """The only route runs while the flap is lowered."""
    validate(family, p)
    return {frozenset(("in", "out")): int(p["switch_state"]) == 0}


def _meshes(p):
    return component_meshes(int(p["drive"]), float(p["fit_adjustment"]), fast.enabled(p))


def components(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return [{"role": role, "parameters": {**p, "component_index": index}} for index, (role, _) in enumerate(_meshes(p))]


def component_keys(p: dict) -> set[str]:
    return set(CONNECTOR | LOGICAL | {"component_index"})


def _logical(p):
    return {key: value for key, value in p.items() if key != "component_index"}


def validate_component(p: dict) -> None:
    if set(p) - {"lite"} != component_keys(p):
        raise ValueError("unexpected uncoupler component parameters")
    validate(FAMILIES[0], _logical(p))
    index = p["component_index"]
    if not _number(index) or index != int(index) or index < 0:
        raise ValueError("invalid component_index")
    if index >= len(_meshes(p)):
        raise ValueError("component_index outside assembly")


def component_ports(p: dict) -> list[dict]:
    return ports(FAMILIES[0], _logical(p))


def side_on(p: dict) -> bool:
    """The link prints on its side (it is authored standing in the x-z plane)."""
    return int(p["drive"]) == 1 and int(p["component_index"]) == 3


def build_component(p: dict) -> cq.Shape:
    validate_component(p)
    role, mesh = _meshes(p)[int(p["component_index"])]
    return end._solid(T.check_mesh(role, mesh))


FILAMENT_PIN = "1.75 mm filament offcut, cut into two 7 mm pins"


def hardware(family: str, p: dict) -> list[dict]:
    validate(family, p)
    if int(p["drive"]) == 0:
        return [hw.row(hw.MAGNET, 3, hw.MAGNETS), hw.row(hw.GLUE, 1, hw.MATERIALS)]
    return [*_cradle().hardware, hw.row(FILAMENT_PIN, 1, hw.MATERIALS)]


def assembly_notes(family: str, p: dict) -> list[str]:
    validate(family, p)
    notes = ["Seat the uncoupler on a flat surface: the flap well and the drive have a solid underside "
             "(the end ties still clutch onto a baseplate's studs).",
             "Keep the flap well, the shaft bores and the drive floor free of support material."]
    if int(p["drive"]) == 0:
        notes += ["Press a 6 x 3 mm magnet into each of the two pockets in the base block, the same face outwards, "
                  "and one into the rocker arm's pocket so that it attracts both; a drop of glue holds each.",
                  "Lay the flap in its well half raised (45°). Hold the rocker arm pointing straight up and slide its "
                  "shaft through the cheek window, the base block and the near stringer into the flap's D-socket "
                  "until its tip enters the far stringer.",
                  "Swing the arm down to lowered: the cheek now holds it in and the magnets hold it flush. "
                  "To uncouple, swing the arm over to the other magnet: the flap stands up."]
    else:
        notes += ["Drill the single-arm horn's 10 mm hole to 1.8 mm for the filament pin before fitting the horn "
                  "(the centred servo is 1500 µs)."] + _cradle().notes + [
            "Lay the flap in its well (lowered) and slide the rocker's shaft through the base block and the near "
            "stringer into the flap's D-socket until its tip enters the far stringer; the arm then points away "
            "from the servo.",
            "Join the arm to the link with one 7 mm filament pin (snug in the arm), and the link to the horn with the "
            f"other. Lowered is the horn {math.degrees(horn_angle(0.)):.0f}° from upright towards the in end, raised "
            f"{-math.degrees(horn_angle(math.pi/2)):.0f}° towards the out end.",
            "Trim the endpoints in the servo controller's software: lowered where the flap just rests flush, raised where it stands "
            "upright just clear of the stop bar; never hold the servo against a stop (it buzzes and wears the shaft)."]
    notes += ["Operation: stop with the coupling to be parted just past the flap, raise the flap and drive the loco "
              "on; the first wagon's leading bogie meets the flap and stays behind. Lower the flap before any train "
              "crosses. Trains running in → out push the flap onto its stop bar; the other way the "
              + ("magnets hold" if int(p["drive"]) == 0 else "servo holds") + " it.",
              "Coupler and bogie catch are a physical trial: try each wagon slowly before relying on it."]
    return notes


# ------------------------------------------------------------------ probes
def _thetas(steps):
    return np.linspace(0., math.pi/2, steps)


def probe_parts(drive: int, adjustment: float = 0., lite: bool = False) -> list[dict]:
    """Each printed part is one watertight solid within the 166 mm mini bed."""
    report = []
    for role, mesh in component_meshes(drive, adjustment, lite):
        checked = T.check_mesh(role, mesh)
        report.append({"role": role, "volumeMm3": float(checked.volume), "planMm": [float(v) for v in checked.extents[:2]]})
    return report


def probe_motion(drive: int, adjustment: float = 0., lite: bool = False, steps: int = 13) -> dict:
    """The flap, rocker (and link) sweep their whole travel without touching the base or each other."""
    base = base_mesh(drive, adjustment, lite)
    worst = 0.
    for theta in _thetas(steps):
        parts = moving_parts(drive, theta)
        for _, mesh in parts:
            worst = max(worst, _overlap(base, mesh))
        for i in range(len(parts)):
            for j in range(i + 1, len(parts)):
                worst = max(worst, _overlap(parts[i][1], parts[j][1]))
    if worst > .01:
        raise ValueError(f"moving parts interfere: {worst:.6f} mm^3")
    return {"poses": steps, "maximumInterferenceMm3": worst}


def probe_flush(drive: int, adjustment: float = 0., lite: bool = False) -> dict:
    """Lowered: nothing inside the gauge stands above the tie-stud tops; raised: the flap stands 8+ mm above the rails."""
    lowered = assembly_mesh(drive, 0, adjustment, lite)
    gauge = end._box((6., -CORRIDOR + .01, STUD_TOP + .01), (LENGTH - 6., CORRIDOR - .01, 60))
    above = _overlap(lowered, gauge)
    flap = flap_mesh()
    raised = _posed(flap, math.pi/2)
    height = float(raised.bounds[1, 2]) - TOP
    if above > .01:
        raise ValueError(f"lowered: {above:.6f} mm^3 above the stud tops inside the gauge")
    if flap.bounds[1, 2] > STUD_TOP or height < 8.:
        raise ValueError("flap is not flush when lowered or not 8 mm above the rails when raised")
    return {"loweredTopMm": float(flap.bounds[1, 2]), "aboveStudTopsMm3": above, "raisedTopMm": float(raised.bounds[1, 2]),
            "raisedAboveRailTopMm": height, "raisedSpanYMm": [float(raised.bounds[0, 1]), float(raised.bounds[1, 1])]}


def probe_running_clearances(drive: int, state: int, adjustment: float = 0., lite: bool = False) -> dict:
    """turnout.probe_running_clearances on the assembled uncoupler: flange corridors clear, running heads whole."""
    assembly = assembly_mesh(drive, state, adjustment, lite)
    path = T.route_path(SPEC, "main")
    flange = 0.
    for cutter in ta._flangeways([ta._station_path(path, 6., LENGTH - 6.)]):
        flange = max(flange, _overlap(assembly, cutter))
    gap_max = 0.
    for lateral in (-RAIL, RAIL):
        gap = 0.
        for x in np.arange(6., LENGTH - 6., .5):
            probe = end._box((x - .1, lateral - HEAD, TOP - .25), (x + .1, lateral + HEAD, TOP - .05))
            gap = 0. if _overlap(assembly, probe) > .002 else gap + .5
            gap_max = max(gap_max, gap)
    if flange > .01:
        raise ValueError(f"{STATES[state]}: wheel-flange corridor obstructed: {flange:.6f} mm^3")
    if gap_max > 4.:
        raise ValueError(f"{STATES[state]}: unsupported running-head gap {gap_max:.3f} mm")
    return {"state": STATES[state], "flangeObstructionMm3": flange, "maximumUnsupportedSpanMm": gap_max,
            "samplePitchMm": .5, "physicalWheelAcceptance": "not_checked"}


def probe_retention(drive: int, adjustment: float = 0., lite: bool = False) -> list[dict]:
    """The flap cannot lift off its shaft, the shaft cannot lift out of its bores, and the rocker is held along y."""
    base = base_mesh(drive, adjustment, lite)
    report = []

    def blocked(name, mesh, other, offset):
        volume = _overlap(_moved(mesh, offset), other)
        if volume < .5:
            raise ValueError(f"retention missing: {name} ({volume:.6f} mm^3)")
        report.append({"check": name, "blockedVolumeMm3": volume})

    for state in (0, 1):
        theta = state*math.pi/2
        flap, rocker = _posed(flap_mesh(), theta), _posed(rocker_mesh(drive), theta)
        label = STATES[state]
        blocked(f"{label}: flap lifted 1 mm off the shaft", flap, rocker, (0, 0, 1.))
        blocked(f"{label}: shaft lifted 1 mm in its bores", rocker, base, (0, 0, 1.))
        blocked(f"{label}: rocker pushed 1 mm in", rocker, base, (0, 1., 0))
        if drive == 0:
            blocked(f"{label}: rocker pulled 1 mm out (cheek)", rocker, base, (0, -1., 0))
        else:
            link = link_at(theta)
            blocked(f"{label}: rocker pulled 1 mm out (link)", rocker, link, (0, -1., 0))
            horn = drives.sg90_horn_sweep(servo_frame(), HORN_PIN, HORN_LIMIT)
            blocked(f"{label}: link pulled 1 mm out (horn)", link, horn, (0, -1., 0))
    return report


def probe_detents(adjustment: float = 0., lite: bool = False) -> list[dict]:
    """Magnet pockets: the arm's is coaxial (within 0.5 mm) with a base pocket in each state, and every pocket is open."""
    base, rocker = base_mesh(0, adjustment, lite), rocker_mesh(0)
    arm_y = MAGNET_ARM[1]
    arm_magnet = _y_cylinder(*_polar(DETENT_RADIUS, DETENT_LOWERED), MAGNET_R, arm_y - MAGNET_T - .05, arm_y - .05)
    base_magnets = [_y_cylinder(x, z, MAGNET_R, MAGNET_BLOCK[2] + .05, MAGNET_BLOCK[2] + .05 + MAGNET_T)
                    for x, z in _magnet_centres()]
    if _overlap(rocker, arm_magnet) > .01 or any(_overlap(base, magnet) > .01 for magnet in base_magnets):
        raise ValueError("a magnet pocket does not take its 6 x 3 mm magnet")
    report = []
    for state in (0, 1):
        moved = _posed(arm_magnet, state*math.pi/2)
        centre = np.array([(moved.bounds[0, 0] + moved.bounds[1, 0])/2, (moved.bounds[0, 2] + moved.bounds[1, 2])/2])
        target = base_magnets[state]
        goal = np.array([(target.bounds[0, 0] + target.bounds[1, 0])/2, (target.bounds[0, 2] + target.bounds[1, 2])/2])
        offset = float(np.linalg.norm(centre - goal))
        gap = float(target.bounds[0, 1] - moved.bounds[1, 1])
        if offset > .5:
            raise ValueError(f"{STATES[state]}: magnets {offset:.3f} mm off axis")
        report.append({"state": STATES[state], "axisOffsetMm": offset, "faceGapMm": gap})
    return report


def _train_envelope():
    """Train space: an 8-wide body from the rail top up, and the wheel-flange corridors (|y| <= 32 / 16.6..18.8)."""
    body = end._box((-10, -TRAIN_HALF, TOP), (LENGTH + 10, TRAIN_HALF, 120))
    path = T.route_path(SPEC, "main")
    return [body, *ta._flangeways([ta._station_path(path, 6., LENGTH - 6.)])]


def probe_servo(adjustment: float = 0., lite: bool = False, steps: int = 13) -> dict:
    """Both states within ±25° of horn travel, monotonic, and the horn, link and arm clear of base and trains."""
    angles = [math.degrees(horn_angle(t)) for t in _thetas(steps)]
    if not (all(b < a for a, b in zip(angles, angles[1:])) or all(b > a for a, b in zip(angles, angles[1:]))):
        raise ValueError("servo linkage is not monotonic over the travel")
    if max(abs(angles[0]), abs(angles[-1])) > math.degrees(HORN_LIMIT):
        raise ValueError("servo needs more than ±25° of horn travel")
    base = base_mesh(1, adjustment, lite)
    frame = servo_frame()
    case = drives.sg90_case(frame)
    train = _train_envelope()
    transmission, worst, outside = 180., 0., 0.
    for theta, alpha in zip(_thetas(steps), angles):
        p, h = crank_pin(theta), horn_pin(math.radians(alpha))
        arm = p - np.array((AXIS_X, AXIS_Z))
        link = h - p
        transmission = min(transmission, math.degrees(math.acos(abs(arm @ link)/np.linalg.norm(arm)/np.linalg.norm(link))))
        horn = _xz(_hull(_circle(SERVO_X, drives.SG90_SHAFT_Z, 3.5), _circle(*h, 2.)), HORN_FACE, HORN_FACE + 2.4)
        moving = [mesh for role, mesh in moving_parts(1, theta) if role != "flap"] + [horn]
        for mesh in moving:
            worst = max(worst, _overlap(base, mesh), *[_overlap(mesh, item) for item in case])
            outside = max(outside, *[_overlap(mesh, item) for item in train])
    if worst > .01 or outside > .01:
        raise ValueError(f"servo linkage interferes: base/case {worst:.6f}, train {outside:.6f} mm^3")
    fit = _overlap(base, ta._union(drives.sg90_case(frame, -.05)))
    if fit > .01:
        raise ValueError(f"SG90 does not drop into its cradle: {fit:.6f} mm^3")
    return {"hornLoweredDeg": angles[0], "hornRaisedDeg": angles[-1], "hornLimitDeg": math.degrees(HORN_LIMIT),
            "minimumTransmissionDeg": transmission, "maximumInterferenceMm3": worst, "trainEnvelopeMm3": outside,
            "caseInCradleMm3": fit}


def probe_envelopes(drive: int, adjustment: float = 0., lite: bool = False, steps: int = 7) -> dict:
    """Moving parts at every pose, and the drive outside the deck, stay inside the published plan envelopes."""
    polygons = [ENVELOPES["flap"], ENVELOPES[DRIVES[drive]]]
    region = ta._union([_prism_plan(points, -5, 80) for points in polygons])
    worst = 0.
    for theta in _thetas(steps):
        for _, mesh in moving_parts(drive, theta):
            worst = max(worst, abs(ta._difference(mesh, [region]).volume))
    base = base_mesh(drive, adjustment, lite)
    deck = end._box((-10, -T.HALF, -5), (LENGTH + 10, T.HALF, 80))
    fixed = abs(ta._difference(base, [region, deck]).volume)
    if drive == 1:
        if (_cradle().keepout - T._section(ENVELOPES["servo"])).area() > 1e-6:
            raise ValueError("servo keepout leaves the drive envelope")
    if max(worst, fixed) > .01:
        raise ValueError(f"mechanism leaves its envelopes: moving {worst:.6f}, fixed {fixed:.6f} mm^3")
    return {"regions": len(polygons), "movingOutsideMm3": worst, "fixedOutsideMm3": fixed}


def probe_source_contacts(drive: int, adjustment: float = 0., lite: bool = False) -> list[dict]:
    """The accepted connector interface at both ports equals a plain 128 mm straight's (turnout.probe_source_contacts)."""
    assembly = ta._union([mesh for _, mesh in component_meshes(drive, adjustment, lite)])
    lay = T.layout(SPEC)
    columns = end.PROFILE["brickAttachment"]["studLateralOffsets"]
    report = []
    for port in SPEC.ports:
        local = assembly.copy()
        local.apply_transform(np.linalg.inv(T._inward_frame(port)))
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


def probes(family: str, p: dict) -> dict:
    """Every probe on one configuration (tests and evidence)."""
    validate(family, p)
    drive, adjustment, lite = int(p["drive"]), float(p["fit_adjustment"]), fast.enabled(p)
    report = {"parts": probe_parts(drive, adjustment, lite), "motion": probe_motion(drive, adjustment, lite),
              "flush": probe_flush(drive, adjustment, lite),
              "running": [probe_running_clearances(drive, state, adjustment, lite) for state in (0, 1)],
              "retention": probe_retention(drive, adjustment, lite),
              "envelopes": probe_envelopes(drive, adjustment, lite),
              "contacts": probe_source_contacts(drive, adjustment, lite)}
    report["detents" if drive == 0 else "servo"] = probe_detents(adjustment, lite) if drive == 0 else probe_servo(adjustment, lite)
    return report


def envelopes(family: str, p: dict) -> list[list[tuple[float, float]]]:
    """Piece-frame plan polygons of the flap's sweep and the drive (uncoupler.ts draws the same numbers)."""
    validate(family, p)
    return [ENVELOPES["flap"], ENVELOPES[DRIVES[int(p["drive"])]]]
