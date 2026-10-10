"""Rack (cog) railway: rack teeth between the rails of ``composite_track`` and the cog-drive bogie (family ``cog_bogie``).

Rack (composite options, see ``composite.validate``):
- ``rack`` 1 adds a rack bar on the centreline: 8 mm wide (|y| <= 4) from the tie tops (3.15) up to the tooth roots,
  port face to port face less 0.2 mm, bridging the tie gaps (16.2 mm bridges). The full ties' and end half ties'
  y = +/-4 stud columns go (the bar covers them); the +/-12 and +/-28 studs stay.
- Teeth: the 3743 gear-rack pitch, 10 teeth per 32 mm (3743, "toothed bar M=1, Z=10"; Rebrickable, cailliau.org),
  i.e. 3.2 mm, with module 3.2/pi and 20 degree straight flanks, 6 mm wide (|y| <= 3). Tooth tips stand 0.4 mm below
  the rail top: every brick train already clears the rail top between its wheels (trains cross the rails that run
  across the track inside a turnout), and the wheel flanges run 12 mm outside the bar.
- Spacing: ``rack_pitch`` is the 3D tooth spacing along the track (fit sets length / round(length / 3.2) per piece, so
  every piece starts and ends half a tooth from its ports and the spacing stays continuous across track joints);
  ``rack_phase`` is the 3D distance from this part's start to its first tooth centre (bed-split parts carry the
  parent's phase). Teeth stand perpendicular to the pitched track, their pitch line a fixed distance below the
  rail-top line (the cog bogie rides the rail tops).
- Entry taper: ``rack_in`` / ``rack_out`` (mm) is how much of a 48 mm entry taper remains at this part's start / end
  (0 = none): over the taper the teeth rise from 30 % to full height so the cog finds the mesh gently.

Cog bogie (``cog_bogie``, ``part`` 0 frame, 1 cog): a printed bogie for a brick train on two cross axles with four
55423 train wheels (17 mm tread; l-gauge.org/wiki/index.php/Wheels) at 40 mm wheelbase and a third axle in the
middle carrying a printed 17-tooth cog of the rack's pitch. The cog axle sits at the rack's pitch line + the cog's pitch
radius, so a bogie riding the rail tops meshes the rack at the standard 0.25 module root clearance. The cog hangs
2.4 mm below the rail tops (above every tie stud), so a cog train runs on plain track and rack, but not through turnouts
or crossings, whose rails cross the track centre (Test drive refuses that route). The cog axle sticks out of the +y
cheek for the drive: a universal joint (61903) to a Bluetooth motor in the loco body. A 2x4 stud land on the
deck takes a 2x2 turntable (3403c01) as the pivot. Both parts print without supports (frame upright on its cheek
feet, cog teeth-down).
"""
from __future__ import annotations

from functools import lru_cache
import math

import cadquery as cq
import manifold3d
import numpy as np
import trimesh

from . import composite
from . import drives
from . import hardware as hw
from . import brick_end as end_

# ------------------------------------------------------------------ rack
PITCH = 3.2
PITCH_RANGE = (3.0, 3.4)
MODULE = PITCH / math.pi
PRESSURE = math.radians(20)
ADDENDUM, DEDENDUM = MODULE, 1.25 * MODULE
RAIL_TOP = end_.RAIL_TOP
BASE = end_.PROFILE["baseThickness"]
TIP_Z = RAIL_TOP - .4
PITCH_Z = TIP_Z - ADDENDUM
ROOT_Z = PITCH_Z - DEDENDUM
TOOTH_HALF = 3.
BAR_HALF = 4.
BAR_FLOOR = BASE - .05
END_GAP = .2
TAPER = 48.
TAPER_MIN = .3
MAX_GRADE = .20
STUD_TOP = BASE + end_.PROFILE["brickAttachment"]["studHeight"]
OPTIONS = ("rack", "rack_pitch", "rack_phase", "rack_in", "rack_out")

# ------------------------------------------------------------------ cog bogie
FAMILY = "cog_bogie"
PARAMETERS = frozenset({"part"})
TEETH = 17
PITCH_RADIUS = TEETH * PITCH / (2 * math.pi)
TIP_RADIUS = PITCH_RADIUS + ADDENDUM
ROOT_RADIUS = PITCH_RADIUS - DEDENDUM
BACKLASH = .08                     # per flank, printed clearance
WHEEL_TREAD = 17.                  # 55423 (l-gauge.org): 17.0 tread, 24.0 flange, 5.0 deep
WHEEL_FLANGE = 24.
WHEEL_AXLE_Z = RAIL_TOP + WHEEL_TREAD / 2
COG_AXLE_Z = PITCH_Z + PITCH_RADIUS
WHEEL_X = 20.
COG_WIDTH = 4.8                    # teeth |y| <= 2.4
HUB = (5.8, 3.)                    # radius, length on the +y side
CHEEK = (5.6, 11.2)                # |y| band
CHEEK_LOW = 6.5
FRAME_X = 27.
DECK = (COG_AXLE_Z + TIP_RADIUS + 1., 3.2)   # underside, thickness
BOSS = 4.5
FLANGE_CORRIDOR = 16.6             # inner edge of the wheel flange corridor (turnout.FACE - FLANGE)
STUDS = [(x, y) for x in (-12., -4., 4., 12.) for y in (-4., 4.)]


def arc3d(z, length: float, stations) -> np.ndarray:
    """3D distance along a profile z(s) (plan station s) at each of ``stations`` (Simpson, 0.5 mm steps)."""
    count = max(2, int(math.ceil(length / .5)))
    grid = np.linspace(0, length, count + 1)
    slope = np.gradient(z(grid), grid)
    speed = np.sqrt(1 + slope * slope)
    cumulative = np.concatenate([[0.], np.cumsum((speed[1:] + speed[:-1]) / 2 * np.diff(grid))])
    return np.interp(np.asarray(stations, float), grid, cumulative)


def validate_options(p: dict, total: float, spec_cant: tuple[float, float], options: dict) -> dict:
    """Parsed rack options of a composite request (``rack`` 0 = none)."""
    rack = composite._integer(p, "rack", 0, 1)
    values = {key: float(p.get(key, 0)) for key in OPTIONS[1:]}
    if not rack:
        if any(key in p for key in OPTIONS[1:]):
            raise ValueError("rack_* options need rack = 1")
        return {"rack": 0, **values}
    if not PITCH_RANGE[0] <= values["rack_pitch"] <= PITCH_RANGE[1]:
        raise ValueError(f"rack_pitch must be {PITCH_RANGE[0]:g} to {PITCH_RANGE[1]:g} mm")
    if not 0 <= values["rack_phase"] < values["rack_pitch"]:
        raise ValueError("rack_phase must be from 0 to below rack_pitch")
    for key in ("rack_in", "rack_out"):
        if not 0 <= values[key] <= TAPER:
            raise ValueError(f"{key} must be 0 to {TAPER:g} mm")
    if any(spec_cant):
        raise ValueError("rack track cannot be canted")
    if options.get("street") or options.get("marker"):
        raise ValueError("rack track cannot carry a street surface or a colour marker (both use the centre)")
    return {"rack": 1, **values}


def taper(distance: float, length: float, rack_in: float, rack_out: float) -> float:
    """Tooth height factor at 3D ``distance`` along a part of 3D ``length``."""
    factor = 1.
    if rack_in > 0:
        factor = min(factor, (distance - (rack_in - TAPER)) / TAPER)
    if rack_out > 0:
        factor = min(factor, (length - distance - (rack_out - TAPER)) / TAPER)
    return min(1., max(TAPER_MIN, factor))


def tooth_section(cos_pitch: float, factor: float, thin: float = 0.):
    """A rack tooth's side profile (x along the track, z perpendicular to it), for a frame on the path datum."""
    pitch_line = RAIL_TOP * cos_pitch - (RAIL_TOP - PITCH_Z)
    root, tip = pitch_line - DEDENDUM - .05, pitch_line - DEDENDUM + factor * (ADDENDUM + DEDENDUM)
    half = lambda z: PITCH / 4 - thin + (pitch_line - z) * math.tan(PRESSURE)
    return [(-half(root), root), (half(root), root), (half(tip), tip), (-half(tip), tip)]


def tooth_stations(spec, rack: dict) -> list[tuple[float, float, float]]:
    """(plan station, 3D distance, height factor) of every tooth centre on the part."""
    length3 = float(arc3d(spec.z, spec.length, [spec.length])[0])
    grid = np.linspace(0, spec.length, max(2, int(math.ceil(spec.length / .25))) + 1)
    distance = arc3d(spec.z, spec.length, grid)
    rows, d = [], rack["rack_phase"]
    while d <= length3 + 1e-9:
        station = float(np.interp(d, distance, grid))
        rows.append((station, d, taper(d, length3, rack["rack_in"], rack["rack_out"])))
        d += rack["rack_pitch"]
    return rows


def rack_meshes(builder) -> list:
    """Bar and teeth of a composite Builder whose spec has rack options."""
    spec, rack = builder.spec, builder.spec.rack_options
    length = builder.length
    lo, hi = END_GAP, length - END_GAP

    def bar(floor_of):
        def section(s, lift):
            floor = floor_of(lift)
            return [(-BAR_HALF, floor), (BAR_HALF, floor), (BAR_HALF, ROOT_Z + .05), (-BAR_HALF, ROOT_Z + .05)]
        return section

    parts = []
    if spec.lite:
        inner = builder._inner()
        parts.append(builder.rings(bar(lambda lift: BAR_FLOOR), lo, inner[0] + .5))
        parts.append(builder.rings(bar(lambda lift: -lift), inner[0], inner[1]))
        parts.append(builder.rings(bar(lambda lift: BAR_FLOOR), inner[1] - .5, hi))
    else:
        parts.append(builder.rings(bar(lambda lift: BAR_FLOOR), lo, hi))
    teeth = []
    for station, _, factor in tooth_stations(spec, rack):
        frame = builder.route.frame(min(max(station, 0.), length))
        cos_pitch = float(np.hypot(frame[0, 0], frame[1, 0]))
        tooth = composite.side_prism(tooth_section(cos_pitch, factor), -TOOTH_HALF, TOOTH_HALF)
        tooth.apply_transform(frame)
        teeth.append(tooth)
    if teeth:
        low = min(t.bounds[0, 2] for t in teeth) - 1
        high = max(t.bounds[1, 2] for t in teeth) + 1
        parts.append(trimesh.boolean.intersection([composite._union(teeth), builder.mask(lo, hi, low, high)],
                                                  engine="manifold"))
    return parts


# ------------------------------------------------------------------ cog bogie geometry
def _involute(base: float, radius: float) -> float:
    return math.sqrt(max(radius * radius / (base * base) - 1, 0.)) - math.acos(min(1., base / radius))


def cog_outline(thin: float = BACKLASH, steps: int = 12) -> np.ndarray:
    """Plan outline (x, y) of the 17-tooth cog, involute flanks, `thin` mm off each flank at the pitch circle."""
    base = PITCH_RADIUS * math.cos(PRESSURE)
    half_angle = (math.pi / TEETH / 2) - thin / PITCH_RADIUS + _involute(base, PITCH_RADIUS)
    start = max(base, ROOT_RADIUS)
    radii = np.linspace(start, TIP_RADIUS, steps)
    points = []
    for k in range(TEETH):
        centre = 2 * math.pi * k / TEETH
        flank = [(r, half_angle - _involute(base, r)) for r in radii]
        right = [(r, centre - a) for r, a in flank]
        left = [(r, centre + a) for r, a in reversed(flank)]
        root_from = centre - half_angle - (2 * math.pi / TEETH - 2 * half_angle) / 2
        points.append((ROOT_RADIUS, root_from))
        if start > ROOT_RADIUS:
            points.append((ROOT_RADIUS, centre - half_angle))
        points.extend(right)
        tip = np.linspace(right[-1][1], left[0][1], 4)[1:-1]
        points.extend((TIP_RADIUS, a) for a in tip)
        points.extend(left)
        if start > ROOT_RADIUS:
            points.append((ROOT_RADIUS, centre + half_angle))
    return np.array([(r * math.cos(a), r * math.sin(a)) for r, a in points])


def _mesh(manifold: manifold3d.Manifold) -> trimesh.Trimesh:
    return composite._to_trimesh(manifold)


def _y_cylinder(radius: float, x: float, z: float, y0: float, y1: float, sections: int = 64) -> manifold3d.Manifold:
    return manifold3d.Manifold.cylinder(y1 - y0, radius, radius, sections).rotate((-90, 0, 0)).translate((x, y0, z))


def _box(x0, y0, z0, x1, y1, z1) -> manifold3d.Manifold:
    return manifold3d.Manifold.cube((x1 - x0, y1 - y0, z1 - z0)).translate((x0, y0, z0))


def _cross_axle_y(x: float, z: float, y0: float, y1: float) -> manifold3d.Manifold:
    a, w = drives.AXLE_CROSS / 2, drives.AXLE_ARM / 2
    return (_box(x - a, y0, z - w, x + a, y1, z + w) + _box(x - w, y0, z - a, x + w, y1, z + a))


@lru_cache(maxsize=4)
def cog_manifold(thin: float = BACKLASH) -> manifold3d.Manifold:
    """The cog in bogie coordinates: axis along y at (0, COG_AXLE_Z), teeth |y| <= 2.4, hub on +y."""
    teeth = manifold3d.CrossSection([cog_outline(thin)]).extrude(COG_WIDTH)          # z 0..4.8 (printed teeth-down)
    hub = manifold3d.Manifold.cylinder(COG_WIDTH + HUB[1], HUB[0], HUB[0], 64)
    a, w = drives.AXLE_CROSS / 2, drives.AXLE_ARM / 2
    cross = (_box(-a, -w, -1, a, w, 20) + _box(-w, -a, -1, w, a, 20))
    printed = (teeth + hub) - cross
    # print frame (axis z, teeth at z 0..4.8) -> bogie frame (axis y, teeth y -2.4..2.4)
    return printed.rotate((-90, 0, 0)).translate((0, -COG_WIDTH / 2, COG_AXLE_Z))


def cog_print_mesh() -> trimesh.Trimesh:
    """The cog as printed: teeth on the bed, hub up."""
    return _mesh(cog_manifold().translate((0, COG_WIDTH / 2, -COG_AXLE_Z)).rotate((90, 0, 0)))


@lru_cache(maxsize=1)
def frame_manifold() -> manifold3d.Manifold:
    """The bogie frame in bogie coordinates (z = rail datum, x along the track); prints upright on its cheek feet."""
    deck_low, deck_thick = DECK
    body = _box(-FRAME_X, -CHEEK[1], deck_low, FRAME_X, CHEEK[1], deck_low + deck_thick)
    for side in (-1, 1):
        y0, y1 = sorted((side * CHEEK[0], side * CHEEK[1]))
        body += _box(-FRAME_X, y0, CHEEK_LOW, FRAME_X, y1, deck_low + .1)
    # -y boss keeps the cog centred (its hub bears on the +y cheek): its underside is a 45-degree chamfer that stays
    # above the rack tips (|y| <= 3) and prints without support.
    rise = CHEEK[0] - COG_WIDTH / 2 - .1
    body += _yz_prism([(-CHEEK[0] - .1, CHEEK_LOW + .5), (-COG_WIDTH / 2 - .2, CHEEK_LOW + .5 + rise),
                       (-COG_WIDTH / 2 - .2, deck_low + .1), (-CHEEK[0] - .1, deck_low + .1)], -BOSS, BOSS)
    for x, y in STUDS:
        body += manifold3d.Manifold.cylinder(end_.PROFILE["brickAttachment"]["studHeight"],
                                             end_.PROFILE["brickAttachment"]["studDiameter"] / 2,
                                             end_.PROFILE["brickAttachment"]["studDiameter"] / 2, 48).translate((x, y, deck_low + deck_thick))
    for x in (-WHEEL_X, WHEEL_X):
        body -= _y_cylinder(drives.AXLE_BEARING / 2, x, WHEEL_AXLE_Z, -CHEEK[1] - 1, CHEEK[1] + 1)
    body -= _y_cylinder(drives.AXLE_BEARING / 2, 0., COG_AXLE_Z, -CHEEK[1] - 1, CHEEK[1] + 1)
    return body


def _yz_prism(points, x0: float, x1: float) -> manifold3d.Manifold:
    """A (y, z) polygon extruded along x from x0 to x1."""
    section = np.asarray(points, float)
    area = np.sum(section[:, 0] * np.roll(section[:, 1], -1) - np.roll(section[:, 0], -1) * section[:, 1])
    if area < 0:
        section = section[::-1]
    prism = manifold3d.CrossSection([section]).extrude(x1 - x0)      # (y, z) in xy, thickness along +z
    # map (X=y, Y=z, Z=x) -> (x, y, z)
    matrix = np.array([[0, 0, 1, x0], [1, 0, 0, 0], [0, 1, 0, 0]], float)
    return prism.transform(matrix)


def frame_print_mesh() -> trimesh.Trimesh:
    return _mesh(frame_manifold().translate((0, 0, -CHEEK_LOW)))


def validate(p: dict) -> None:
    if set(p) != PARAMETERS:
        raise ValueError(f"{FAMILY} requires exactly {sorted(PARAMETERS)}")
    if p["part"] not in (0, 1):
        raise ValueError("part must be 0 (frame) or 1 (cog)")


def mesh(p: dict) -> trimesh.Trimesh:
    validate(p)
    return frame_print_mesh() if p["part"] == 0 else cog_print_mesh()


def build(p: dict) -> cq.Shape:
    part = mesh(p)
    if not part.is_watertight or part.body_count != 1:
        raise ValueError("cog bogie part must be one watertight solid")
    return end_._solid(part)


HARDWARE = [
    hw.row("Train wheel with cross-axle hole (55423)", 4, hw.BRICK),
    hw.row(hw.AXLE_6, 2, hw.BRICK),
    hw.row(hw.AXLE_TO_SUIT, 1, hw.BRICK),
    hw.row(hw.HALF_BUSH, 4, hw.BRICK),
    hw.row("Universal joint (61903)", 1, hw.BRICK),
    hw.row("Turntable 2 x 2 (3403c01)", 1, hw.BRICK),
    hw.row(hw.BT_L_MOTOR, 1, hw.BRICK),
]
NOTES = [
    "Push a cross axle through the middle bearing and the printed cog (hub towards the cog-axle exit side), then through "
    "the other cheek; it sticks out on the hub side for the universal joint.",
    "Put a wheel axle through each end bearing with a half bush against each cheek and a 55423 wheel outside it; set the "
    "wheels so their flanges run just inside both rails.",
    "Press a 2x2 turntable on the deck studs and build the loco body on it; drive the cog axle from a Bluetooth L "
    "motor (an M motor 88008 also fits) through the universal joint; its hub rides in the loco body. Mark the car "
    "'Cog drive' in Setup.",
    "The cog hangs below the rail tops: run a cog train on plain track and rack only, never through a turnout or crossing.",
]


# ------------------------------------------------------------------ probes
def _rack_section_2d(phase: float, count: int = 9) -> manifold3d.CrossSection:
    """Level rack teeth (x, z) around x = 0, the first tooth at ``phase``."""
    polys = []
    for k in range(-count, count + 1):
        x = phase + k * PITCH
        polys.append(manifold3d.CrossSection([np.array([(px + x, pz) for px, pz in tooth_section(1., 1.)])]))
    bar = manifold3d.CrossSection([np.array([(-40, BAR_FLOOR), (40, BAR_FLOOR), (40, ROOT_Z + .05), (-40, ROOT_Z + .05)])])
    out = bar
    for poly in polys:
        out = out + poly
    return out


def _cog_section_2d(angle: float, centre: tuple[float, float], thin: float = BACKLASH) -> manifold3d.CrossSection:
    outline = cog_outline(thin)
    c, s = math.cos(angle), math.sin(angle)
    points = np.column_stack([centre[0] + c * outline[:, 0] - s * outline[:, 1], centre[1] + s * outline[:, 0] + c * outline[:, 1]])
    return manifold3d.CrossSection([points])


def probe_mesh(steps: int = 41, thin: float = BACKLASH) -> dict:
    """Roll the cog one tooth along a level rack: interference area (mm^2), and the smallest backlash found
    by growing the cog until it touches (mm)."""
    worst, touch = 0., math.inf
    for i in range(steps):
        travel = PITCH * i / (steps - 1)
        # A tooth space faces straight down over the rack tooth at x = 0; rolling +x turns the cog clockwise.
        angle = -math.pi / 2 + math.pi / TEETH - travel / PITCH_RADIUS
        cog = _cog_section_2d(angle, (travel, COG_AXLE_Z), thin)
        rack = _rack_section_2d(0.)
        overlap = (cog ^ rack).area()
        worst = max(worst, overlap)
        for grow in np.arange(0., .3, .01):
            if (cog.offset(grow, manifold3d.JoinType.Round) ^ rack).area() > 1e-6:
                touch = min(touch, grow)
                break
    return {"interference_mm2": worst, "flank_clearance_mm": touch,
            "tip_clearance_mm": (COG_AXLE_Z - TIP_RADIUS) - (ROOT_Z),
            "rack_tip_to_cog_root_mm": (COG_AXLE_Z - ROOT_RADIUS) - TIP_Z}


def probe_vertical_curve(radius: float, sag: bool) -> dict:
    """Cog depth change on a vertical curve: the bogie rides the two wheel contacts 40 mm apart; the rack pitch line
    follows the rail-top curve at a fixed offset. Positive = deeper mesh than on the level."""
    sagitta = WHEEL_X ** 2 / (2 * radius)
    # sag: the rail top at the bogie centre lies `sagitta` below the chord through the wheel contacts -> rack further away
    change = -sagitta if sag else sagitta
    return {"radius_mm": radius, "curve": "sag" if sag else "crest", "depth_change_mm": change,
            "tip_clearance_mm": (COG_AXLE_Z - TIP_RADIUS) - ROOT_Z - change,
            "working_depth_mm": 2 * MODULE + change}


def probe_clearances() -> dict:
    """Running clearances of the rack and the cog bogie."""
    return {
        "rack_tip_below_rail_top_mm": RAIL_TOP - TIP_Z,
        "rack_to_flange_corridor_mm": FLANGE_CORRIDOR - BAR_HALF,
        "cog_tip_above_stud_tops_mm": (COG_AXLE_Z - TIP_RADIUS) - STUD_TOP,
        "cog_tip_below_rail_top_mm": RAIL_TOP - (COG_AXLE_Z - TIP_RADIUS),
        "cheek_above_stud_tops_mm": CHEEK_LOW - STUD_TOP,
        "cheek_to_rack_bar_mm": CHEEK[0] - BAR_HALF,
        "cheek_to_flange_corridor_mm": FLANGE_CORRIDOR - CHEEK[1],
        "cog_axle_below_wheel_axle_mm": WHEEL_AXLE_Z - COG_AXLE_Z,
    }


def probe_bogie_on_rack(rack_mesh: trimesh.Trimesh, tooth_x: float, pitch: float = PITCH, steps: int = 9) -> dict:
    """Frame + cog rolled one tooth over a level printed rack part from the tooth centre at ``tooth_x``, the cog
    turning with its travel: worst interference volume (mm^3) of the frame and of the cog with the printed rack."""
    rack = manifold3d.Manifold(manifold3d.Mesh(np.float32(rack_mesh.vertices), np.uint32(rack_mesh.faces)))
    worst_frame = worst_cog = 0.
    for i in range(steps):
        travel = pitch * i / (steps - 1)
        x = tooth_x + travel
        worst_frame = max(worst_frame, (frame_manifold().translate((x, 0, 0)) ^ rack).volume())
        # About +y a turn of b lowers the x-z angle of every tooth by b; a tooth space faces down over a rack tooth.
        turn = math.degrees(math.pi / 2 + math.pi / TEETH + travel / PITCH_RADIUS)
        cog = cog_manifold().translate((0, 0, -COG_AXLE_Z)).rotate((0, turn, 0)).translate((x, 0, COG_AXLE_Z))
        worst_cog = max(worst_cog, (cog ^ rack).volume())
    return {"frame_mm3": worst_frame, "cog_mm3": worst_cog}


def probes() -> dict:
    return {"clearances": probe_clearances(), "mesh": probe_mesh(),
            "vertical": [probe_vertical_curve(r, sag) for r in (1024., 1280.) for sag in (True, False)]}
