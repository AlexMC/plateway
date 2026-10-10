"""Bought drives for printed mechanisms: SG90 micro-servo cradles and Bluetooth / infrared (IR) motor mounts;
millimetres.

A drive is placed by a 4x4 frame (piece frame, +z up in the world). Every builder returns a Drive:
`additions` (printed solids to union into the carrying part), `cuts` (to subtract from it after the union),
`keepout` (plan polygon, piece frame, of everything the drive and its moving output occupy), `hardware` rows,
assembly `notes` and its `output` (where the mechanism takes the motion from).

SG90 cradle: the servo lies on its side, output shaft along frame +x, case towards frame -y; the frame origin is
on the mounting surface under the shaft, in the plane of the horn's inner face. With the horn pointing up (+z),
its pin at `output["pin"]` moves along frame +y by `pin_radius` * angle.

Bluetooth mount: a one-module pin plate (7.8 mm) in the frame's y-z plane, behind the origin (x <= 0), with
pin holes on the 8 mm grid around a round bearing for the motor's cross axle on the frame x axis. Any Bluetooth
motor face (88013 L, 88008 M) carries pin holes on that grid, so it fixes with friction pins. The L motor 88013
is LDraw's 22169 (Electric Control+ L Motor; body u9479c01, axle bush 40940; 1 LDU = 0.4 mm): a 64 x 24 x 31.2 mm
case whose output, a cross-axle bush flush with the front face, sits in the middle of that face with a pin hole one
module left, right, above and below it; its lead leaves the back end.

Infrared mount: the same plate carrying an infrared L motor (88003). Its geometry is LDraw's 99499
(library.ldraw.org: case 10089c01 = front 10090 + back 10089, axle hub 10095): a 56 x 24 x 31.6 mm case (7 x 3 x 4
modules) whose output, a female cross axle 8 mm deep flush with the front face, sits in the middle of that face, with
the same four face pin holes (all parallel to the output); the flat lead leaves the back face on the output axis.

Outlines follow the published part sizes (SG90 datasheet, BrickLink stud sizes, LDraw); physical fit is a trial gate.
"""
from __future__ import annotations

from dataclasses import dataclass
import math

import manifold3d
import numpy as np
import trimesh

from . import brick_end as end
from . import hardware as hw
from . import track_assembly as ta

CLEARANCE = .3
WALL = 2.
FLOOR = 1.2
# SG90: case length (ear axis), width, height (bottom to top face); ears; shaft; horn.
SG90_CASE = (22.8, 12.2, 22.7)
SG90_EAR_SPAN, SG90_EAR_THICK, SG90_EAR_LOW = 32.3, 2.5, 15.9
SG90_EAR_HOLE = 2.4        # ear screw from the ear's outer end
SG90_SHAFT_INSET = 5.9     # shaft axis from the nearer case end
SG90_HORN_PLANE = 4.6      # horn's inner face above the case top face
SG90_HORN_REACH = 17.      # single-arm horn tip radius
SG90_SHAFT_Z = FLOOR + SG90_CASE[1]/2
SG90_HEIGHT = FLOOR + SG90_CASE[1]*.75    # cradle walls: the servo drops in from above
PILOT_M2 = .8
# Axle-and-pin system: 8 mm grid, pin hole 4.8 (+ print clearance), counterbore 6.2 x 0.8, beam 7.8 thick, cross axle 4.8/1.8.
AXLE_PITCH, PIN_HOLE, AXLE_BORE, BEAM = 8., 4.85, 6.2, 7.8
AXLE_BEARING = 4.95
AXLE_CROSS, AXLE_ARM = 4.8 + .15, 1.8 + .15
# Keep-out boxes behind the plate (length along the axle, width, height), from catalogue stud sizes plus margin.
MOTORS = {"L": {"name": hw.BT_L_MOTOR, "box": (66., 40., 44.)},
          "M": {"name": hw.BT_M_MOTOR, "box": (50., 48., 48.)}}
# LDraw cases along the output axis, across (frame y), up (frame z): Bluetooth L 88013 (22169, 160 x 60 x 78 LDU) and
# infrared L 88003 (99499, 140 x 60 x 79 LDU). Both front faces carry pin holes (frame y, z) about the output
# -- LDraw pegholes at (+-20, 0) and (0, +-20) LDU.
CASES = {"L": (64., 24., 31.2), "IR_L": (56., 24., 31.6)}
FACE_HOLES = ((-8., 0.), (8., 0.), (0., -8.), (0., 8.))
IR_L_OUTPUT_DEPTH = 8.
# Infrared motor keep-out: the case 1 mm clear all round, and room behind its back face for the lead to bend away
# (LDraw draws the lead straight out along the axis; how tight it bends is a physical trial). The 88013's box
# (MOTORS["L"]) holds its LDraw case with 2 mm behind it and 8 / 6.4 mm either side.
IR_L_LEAD = 10.
IR_L_BOX = (CASES["IR_L"][0] + IR_L_LEAD, CASES["IR_L"][1] + 2., CASES["IR_L"][2] + 2.)
# Worm 4716 and 24-tooth gear 3648 (LDraw radii): worm thread root and tip, gear root, pitch and tip, gear width.
# Crossed at right angles two modules apart, each tip clears the other's root.
WORM_ROOT_R, WORM_TIP_R, WORM_LENGTH = 2.8, 5.08, 16.
GEAR_24_ROOT_R, GEAR_24_PITCH_R, GEAR_24_TIP_R, GEAR_24_WIDTH = 10.8, 12., 12.96, 7.7
WORM_CENTRES = 2*AXLE_PITCH


@dataclass(frozen=True)
class Drive:
    additions: list
    cuts: list
    keepout: manifold3d.CrossSection
    hardware: list
    notes: list
    output: dict


def _placed(meshes, frame):
    return [mesh.copy().apply_transform(frame) for mesh in meshes]


def _point(frame, local):
    return tuple(float(v) for v in (np.asarray(frame) @ np.r_[local, 1.])[:3])


def _direction(frame, local):
    return tuple(float(v) for v in np.asarray(frame)[:3, :3] @ np.asarray(local, float))


def _x_cylinder(radius, x0, x1, y, z, sections=48):
    mesh = trimesh.creation.cylinder(radius=radius, height=x1 - x0, sections=sections)
    mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi/2, (0, 1, 0)))
    mesh.apply_translation(((x0 + x1)/2, y, z))
    return mesh


def plan_hull(meshes) -> manifold3d.CrossSection:
    """Convex plan outline (piece frame) of world-placed meshes."""
    points = np.vstack([mesh.vertices[:, :2] for mesh in meshes])
    return manifold3d.CrossSection.hull_points(points.tolist())


def sg90_case(frame, grow: float = 0.) -> list:
    """The servo's case and ears (no shaft or horn), grown by `grow`, placed by `frame`."""
    length, width, height = SG90_CASE
    back = -SG90_HORN_PLANE - height
    y0, y1 = SG90_SHAFT_INSET - length, SG90_SHAFT_INSET
    centre = (y0 + y1)/2
    case = end._box((back - grow, y0 - grow, FLOOR - grow), (-SG90_HORN_PLANE + grow, y1 + grow, FLOOR + width + grow))
    ears = end._box((back + SG90_EAR_LOW - grow, centre - SG90_EAR_SPAN/2 - grow, FLOOR - grow),
                    (back + SG90_EAR_LOW + SG90_EAR_THICK + grow, centre + SG90_EAR_SPAN/2 + grow, FLOOR + width + grow))
    return _placed([case, ears], frame)


def sg90_horn_sweep(frame, pin_radius: float, angle: float) -> trimesh.Trimesh:
    """Solid the horn sweeps through +-`angle` (radians) from upright: a disc sector in front of the case."""
    reach = max(SG90_HORN_REACH, pin_radius + 3.)
    angles = np.linspace(-angle - .35, angle + .35, 25)
    outline = [(0., 0.)] + [(reach*math.sin(a), reach*math.cos(a)) for a in angles]
    hub = manifold3d.CrossSection.circle(5.5, 48)
    section = manifold3d.CrossSection([outline], manifold3d.FillRule.EvenOdd) + hub
    mesh = section.extrude(2.4).to_mesh()
    solid = trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=True)
    # Section (y, z about the shaft) extruded along x from the horn's inner face.
    solid.vertices = np.column_stack([solid.vertices[:, 2], solid.vertices[:, 0], solid.vertices[:, 1] + SG90_SHAFT_Z])
    solid.fix_normals()
    return solid.apply_transform(frame)


def sg90_cradle(frame, *, pin_radius: float = 10., angle: float = math.radians(20)) -> Drive:
    """A cradle for an SG90 on its side; see the module notes for the frame."""
    length, width, height = SG90_CASE
    back = -SG90_HORN_PLANE - height
    y0, y1 = SG90_SHAFT_INSET - length, SG90_SHAFT_INSET
    centre = (y0 + y1)/2
    block = end._box((back - WALL, centre - SG90_EAR_SPAN/2 - WALL, 0), (-SG90_HORN_PLANE, centre + SG90_EAR_SPAN/2 + WALL, SG90_HEIGHT))
    seat = back + SG90_EAR_LOW
    pocket = [end._box((back - CLEARANCE, y0 - CLEARANCE, FLOOR), (-SG90_HORN_PLANE + 1, y1 + CLEARANCE, 40)),
              end._box((seat - CLEARANCE, centre - SG90_EAR_SPAN/2 - CLEARANCE, FLOOR),
                       (seat + SG90_EAR_THICK + CLEARANCE, centre + SG90_EAR_SPAN/2 + CLEARANCE, 40)),
              # The cable leaves through the back wall.
              end._box((back - WALL - 1, centre - 3.5, FLOOR + 2), (back + .1, centre + 3.5, 40))]
    pilots = [_x_cylinder(PILOT_M2, seat - 7, seat + .1, centre + side*(SG90_EAR_SPAN/2 - SG90_EAR_HOLE), FLOOR + width/2)
              for side in (-1, 1)]
    additions = _placed([block], frame)
    cuts = _placed(pocket + pilots, frame)
    sweep = sg90_horn_sweep(frame, pin_radius, angle)
    keepout = plan_hull(additions + sg90_case(frame) + [sweep])
    output = {"shaft": _point(frame, (0., 0., SG90_SHAFT_Z)), "axis": _direction(frame, (1., 0., 0.)),
              "pin": _point(frame, (1.2, 0., SG90_SHAFT_Z + pin_radius)), "travel": _direction(frame, (0., 1., 0.)),
              "pin_radius": pin_radius, "throw_per_degree": pin_radius*math.pi/180, "max_angle_deg": math.degrees(angle)}
    return Drive(additions, cuts, keepout,
                 [hw.row(hw.SERVO, 1, hw.ELECTRONICS)],
                 ["Centre the SG90 (90°) and fit its single-arm horn pointing straight up.",
                  "Lay the servo on its side in the cradle, ears in their slots and cable out through the back wall, "
                  "and fix both ears with the servo's own M2 screws."], output)


def sg90_pin_travel(pin_radius: float, angle: float) -> tuple[float, float]:
    """(along frame y, along frame z) displacement of the horn pin at `angle` radians from upright."""
    return pin_radius*math.sin(angle), pin_radius*(math.cos(angle) - 1)


def sg90_angle_for(throw: float, pin_radius: float) -> float:
    """Horn angle (radians) that moves the pin `throw` mm along frame y from upright."""
    if abs(throw) > pin_radius:
        raise ValueError("throw exceeds the horn radius")
    return math.asin(throw/pin_radius)


def pin_holes(frame, holes, x0: float, x1: float) -> list:
    """Pin holes along frame x at (y, z) points, counterbored on both faces."""
    cuts = []
    for y, z in holes:
        cuts += [_x_cylinder(PIN_HOLE/2, x0 - .1, x1 + .1, y, z),
                 _x_cylinder(AXLE_BORE/2, x0 - .1, x0 + .8, y, z), _x_cylinder(AXLE_BORE/2, x1 - .8, x1 + .1, y, z)]
    return _placed(cuts, frame)


def _pin_plate(frame, columns: int, rows: int):
    """The mounts' pin plate (frame coordinates), its pin-hole grid (y, z), its placed cuts (pin holes and the
    axle bearing) and the motion output at the origin."""
    half_y, half_z = columns*AXLE_PITCH + 4.4, rows*AXLE_PITCH + 4.4
    plate = end._box((-BEAM, -half_y, -half_z), (0., half_y, half_z))
    grid = [(i*AXLE_PITCH, j*AXLE_PITCH) for i in range(-columns, columns + 1) for j in range(-rows, rows + 1) if (i, j) != (0, 0)]
    cuts = pin_holes(frame, grid, -BEAM, 0.) + _placed([_x_cylinder(AXLE_BEARING/2, -BEAM - .1, .1, 0., 0.)], frame)
    output = {"axle": _point(frame, (0., 0., 0.)), "axis": _direction(frame, (1., 0., 0.)),
              "plate_low": _point(frame, (0., 0., -half_z)), "pitch": AXLE_PITCH}
    return plate, grid, cuts, output


def motor_body(frame, motor: str) -> trimesh.Trimesh:
    """The motor's keep-out box behind the plate (MOTORS, or IR_L_BOX for "IR_L"), placed by `frame`."""
    length, width, height = IR_L_BOX if motor == "IR_L" else MOTORS[motor]["box"]
    body = end._box((-BEAM - length, -width/2, -height/2), (-BEAM, width/2, height/2))
    return _placed([body], frame)[0]


def motor_case(frame, motor: str) -> trimesh.Trimesh:
    """A motor's bare LDraw case (CASES), its front face on the plate's back face, placed by `frame`."""
    length, width, height = CASES[motor]
    case = end._box((-BEAM - length, -width/2, -height/2), (-BEAM, width/2, height/2))
    return _placed([case], frame)[0]


def bluetooth_mount(frame, motor: str = "L", *, columns: int = 2, rows: int = 1) -> Drive:
    """A pin plate for a Bluetooth motor driving a cross axle along frame +x from the origin."""
    if motor not in MOTORS:
        raise ValueError(f"motor must be one of {sorted(MOTORS)}")
    plate, _, cuts, output = _pin_plate(frame, columns, rows)
    additions = _placed([plate], frame)
    keepout = plan_hull(additions + [motor_body(frame, motor)])
    return Drive(additions, cuts, keepout,
                 [hw.row(MOTORS[motor]["name"], 1, hw.BRICK),
                  hw.row(hw.FRICTION_PIN, 4, hw.BRICK),
                  hw.row(hw.AXLE_TO_SUIT, 1, hw.BRICK)],
                 [f"Pin the {MOTORS[motor]['name']} to the printed plate with four friction pins, "
                  "its output on the bearing hole, and push the cross axle through the bearing into the drive.",
                  "It runs from a Bluetooth hub (see the layout's shopping list); keep the motor's cable clear of moving parts."],
                 output)


def infrared_mount(frame, *, columns: int = 2, rows: int = 1) -> Drive:
    """The Bluetooth mount's plate for an infrared L motor (88003) driving a cross axle along frame +x from the
    origin: the motor's four front-face pin holes take friction pins in the plate's grid."""
    plate, grid, cuts, output = _pin_plate(frame, columns, rows)
    if not set(FACE_HOLES) <= set(grid):
        raise ValueError("the plate's pin holes miss the infrared L motor's face holes")
    additions = _placed([plate], frame)
    keepout = plan_hull(additions + [motor_body(frame, "IR_L")])
    output = {**output, "pins": [_point(frame, (-BEAM/2, y, z)) for y, z in FACE_HOLES]}
    return Drive(additions, cuts, keepout,
                 [hw.row(hw.IR_L_MOTOR, 1, hw.BRICK),
                  hw.row(hw.FRICTION_PIN, 4, hw.BRICK),
                  hw.row(hw.AXLE_TO_SUIT, 1, hw.BRICK)],
                 [f"Pin the {hw.IR_L_MOTOR} to the printed plate with four friction pins in the "
                  "holes one module left, right, above and below the bearing (the four on the motor's front face), its "
                  "output on the bearing hole, and push the cross axle through the bearing into the drive.",
                  "It runs from an IR receiver beside it (see the layout's shopping list); the motor's "
                  "lead leaves its back face: route it to the receiver clear of moving parts."],
                 output)


def overlap_mm3(a: trimesh.Trimesh, b: trimesh.Trimesh) -> float:
    if np.any(a.bounds[0] > b.bounds[1]) or np.any(b.bounds[0] > a.bounds[1]):
        return 0.
    common = trimesh.boolean.intersection([a, b], engine="manifold")
    return abs(float(common.volume)) if len(common.faces) else 0.


def probe_mount(frame, motor: str, mount: trimesh.Trimesh, printed: list[tuple[str, trimesh.Trimesh]],
                *, columns: int = 2, rows: int = 1) -> dict:
    """Motor-in-mount evidence for a plate placed by `frame` in the printed part `mount`: the pin holes the motor face
    uses and the axle bearing hold no material, and the motor's keep-out box (and, for an LDraw-sourced motor in
    CASES, its bare case) meets no printed part in `printed` (role, mesh; moving parts posed by the caller)."""
    _, grid, _, _ = _pin_plate(frame, columns, rows)
    pins = list(FACE_HOLES) if motor in CASES else grid
    bores = _placed([_x_cylinder(PIN_HOLE/2 - .05, -BEAM, 0., y, z, 32) for y, z in pins] +
                    [_x_cylinder(AXLE_BEARING/2 - .05, -BEAM, 0., 0., 0., 32)], frame)
    body = motor_body(frame, motor)
    solids = [("keepout", body)] + ([("case", motor_case(frame, motor))] if motor in CASES else [])
    worst = {name: max(((overlap_mm3(solid, mesh), role) for role, mesh in printed), default=(0., None))
             for name, solid in solids}
    report = {"motor": hw.IR_L_MOTOR if motor == "IR_L" else MOTORS[motor]["name"],
              "pinsOnPlateGrid": set(pins) <= set(grid),
              "pinHoleMaterialMm3": round(max(overlap_mm3(bore, mount) for bore in bores[:-1]), 4),
              "bearingMaterialMm3": round(overlap_mm3(bores[-1], mount), 4),
              **{f"{name}OverlapMm3": round(volume, 4) for name, (volume, _) in worst.items()},
              **{f"{name}WorstRole": role for name, (volume, role) in worst.items() if round(volume, 4) > 0}}
    if motor in CASES:
        report["caseMm"] = list(CASES[motor])
    return report


def cross_axle(frame, length: float) -> trimesh.Trimesh:
    """Cut for a cross axle along frame +x from the origin (print clearance included)."""
    arms = [end._box((-.1, -AXLE_CROSS/2, -AXLE_ARM/2), (length, AXLE_CROSS/2, AXLE_ARM/2)),
            end._box((-.1, -AXLE_ARM/2, -AXLE_CROSS/2), (length, AXLE_ARM/2, AXLE_CROSS/2))]
    return ta._union(_placed(arms, frame))


def apply(part: trimesh.Trimesh, drive: Drive) -> trimesh.Trimesh:
    """Union a drive's additions into a part and cut its pockets and holes."""
    return ta._difference(ta._union([part, *drive.additions]), drive.cuts)
