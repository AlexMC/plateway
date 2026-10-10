"""9V metal-rail inserts and the LED light channel: ``composite_track`` options.

``metal`` (omitted = 0):
- 1 nickel-silver code 250 rail (6.35 mm tall, bought by the metre; Llagas Creek,
  Sunset Valley, Accucraft or PECO IL-9). Between the two connector laps the printed
  rail is removed down to the deck; the metal rail stands on the deck (3.2 mm), so its
  head is at 9.55 mm, 0.05 below the printed laps. Two low walls locate its foot
  (``metal_base`` wide, 0.15 mm clearance each side); it is bonded with CA glue, as
  Big Ben Bricks bond theirs. The stringer's upper channel band stays solid under it.
  The accepted connector laps stay printed: track power crosses each joint through
  adhesive copper foil wrapped over each lap blade's top and inner face, tucked under
  the metal rail end, so the blades touch metal to metal as official 9V rails do.
- 2 copper tape: the printed rail heads (laps included) are recessed 0.1 mm for 1/8"
  (3.2 mm) adhesive copper foil tape laid over the head and lapped round its gauge
  corner, the Brothers Brick retrofit of plastic track.
Conductive filament is not offered: 30 ohm-cm (Proto-pasta) is ~75 kohm per metre of rail.

``led`` (omitted = 0): 1 an 8 mm (2835) or 2 a 10 mm (5050/WS2812B) LED strip runs
under the deck centreline in a channel port to port (2.3 mm deep, the strip's width
plus 0.6 mm), leaving 0.9 mm of deck over it; the tie gaps are open above it, so
printed in clear filament the track glows. The strip's leads pass the end walls.
The two centre baseplate stud rows meet the strip: lay LED track on tiles or a flat
table, not on bare studs under its centre.
"""

from __future__ import annotations

import manifold3d
import numpy as np
import trimesh

from . import composite as c
from . import hardware as hw
from . import brick_end as end_

METAL_RAIL, COPPER_TAPE = 1, 2
CODE_250 = 6.35
FOOT = (.8, .15, 1.2)                       # foot thickness, side clearance, wall width
BASE_RANGE = (4., 6.5)
DEFAULT_BASE = 5.
# The full-width rail starts here at each port; the half-width lap blade lies outside.
LAP = 4.2
TAPE_DEPTH = .1
LED_STRIPS = {1: 8., 2: 10.}
LED_SKIN, LED_CLEARANCE = .9, .3


def validate(spec) -> None:
    if spec.metal == METAL_RAIL and not BASE_RANGE[0] <= spec.metal_base <= BASE_RANGE[1]:
        raise ValueError(f"metal_base must be {BASE_RANGE[0]:g} to {BASE_RANGE[1]:g} mm")
    if spec.metal and spec.street:
        raise ValueError("street track buries its rails; metal rails need open track")
    if spec.metal == METAL_RAIL and spec.length < 2 * LAP + 8:
        raise ValueError("metal rail needs at least 16.4 mm between the connector laps")


def _end_prism(builder, section, low: float, high: float, frame) -> trimesh.Trimesh:
    """A (y, z) section extruded along a connector's port frame from x = low to high."""
    body = manifold3d.CrossSection([np.asarray(section, float)], manifold3d.FillRule.NonZero).extrude(high - low)
    prism = c._to_trimesh(body.transform(np.array([[0, 0, 1, low], [1, 0, 0, 0], [0, 1, 0, 0]], float)))
    prism.apply_transform(frame)
    return prism


def _sweep(builder, section_of, low: float, high: float, *, body: bool = False) -> trimesh.Trimesh:
    """Sweep a datum-relative (y, z) section between two stations: OCC along the wire on
    level track (trimmed by normal planes), wedge rings otherwise. The wire and rings start at a
    connector's rigid contact face, so a range reaching into a connector end (or from a port,
    past it over the protruding lap blades) adds a prism in that port's frame."""
    run, route = builder.length, builder.route
    if builder.spec.level:
        swept = builder._occ(section_of(0., 0.))
        bounds = swept.bounds
        if low > 0 or high < run:
            swept = trimesh.boolean.intersection(
                [swept, builder.mask(max(low, 0.), min(high, run), bounds[0, 2] - 1, bounds[1, 2] + 1)], engine="manifold")
    else:
        swept = builder.rings(section_of, max(low, c.DEPTH if route.connectors[0] else 0.),
                              min(high, run - c.DEPTH if route.connectors[1] else run), body=body)
    parts = [swept]
    reach = c.DEPTH + .5
    if route.connectors[0] and low < reach:
        parts.append(_end_prism(builder, section_of(0., 0.), -4. if low <= 0 else low, reach, route.start))
    if route.connectors[1] and high > run - reach:
        mirrored = [(-y, z) for y, z in section_of(run, 0.)]
        parts.append(_end_prism(builder, mirrored, -4. if high >= run else run - high, reach,
                                route.end @ np.diag([-1, -1, 1, 1])))
    return c._union(parts)


def _rails(builder, inner: float, outer: float, low: float, high: float):
    """Per rail: (lateral, section_of) for the band inner..outer about it, z low..high above the deck."""
    def section(lateral):
        def of(s, lift):
            rise = c._rise(builder.spec.cant(s))(lateral)
            return [(lateral + inner, c.BASE + low + rise), (lateral + outer, c.BASE + low + rise),
                    (lateral + outer, c.BASE + high + rise), (lateral + inner, c.BASE + high + rise)]
        return of
    return [section(lateral) for lateral in (c.RAIL, -c.RAIL)]


def cutters(builder) -> list[trimesh.Trimesh]:
    spec, run = builder.spec, builder.length
    cuts = []
    if spec.metal == METAL_RAIL:
        half = max(-min(y for y, _ in c.PROFILE["railSection"]), spec.metal_base / 2) + .05
        cuts += [_sweep(builder, of, LAP, run - LAP) for of in _rails(builder, -half, half, 0., end_.RAIL_TOP)]
    elif spec.metal == COPPER_TAPE:
        head = c.PROFILE["railInterfaceWidth"] / 2 + .05
        top = end_.RAIL_TOP - c.BASE
        cuts += [_sweep(builder, of, 0., run, body=True) for of in _rails(builder, -head, head, top - TAPE_DEPTH, top + 1)]
    if spec.led:
        half = LED_STRIPS[spec.led] / 2 + LED_CLEARANCE

        def channel(s, lift):
            ceiling = c.BASE - LED_SKIN + c._rise(spec.cant(s))(0.)
            return [(-half, -lift - 1), (half, -lift - 1), (half, ceiling), (-half, ceiling)]
        cuts.append(_sweep(builder, channel, 0., run))
    return cuts


def additions(builder) -> list[trimesh.Trimesh]:
    spec = builder.spec
    if spec.metal != METAL_RAIL:
        return []
    thickness, clearance, wall = FOOT
    gap = spec.metal_base / 2 + clearance
    walls = []
    for low, high in ((gap, gap + wall), (-gap - wall, -gap)):
        walls += [_sweep(builder, of, LAP, builder.length - LAP) for of in _rails(builder, low, high, -.05, thickness)]
    return walls


def apply(builder, mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    cuts, adds = cutters(builder), additions(builder)
    if cuts:
        mesh = trimesh.boolean.difference([mesh, *cuts], engine="manifold")
    if adds:
        mesh = trimesh.boolean.union([mesh, *adds], engine="manifold")
    return mesh


def hardware(p: dict) -> list[dict]:
    """Purchased parts for one composite part with these options (assembly hardware rows)."""
    count = int(p["segments"])
    run = sum(p[f"s{i}_len"] for i in range(count))
    # Signed turn (radians): the left rail runs RAIL * turn shorter than the centreline, the right one longer.
    turn = sum((p[f"s{i}_k0"] + p[f"s{i}_k1"]) / 2 * p[f"s{i}_len"] for i in range(count))
    rows = []
    if p.get("metal") == METAL_RAIL:
        left, right = (run - 2 * LAP - c.RAIL * turn, run - 2 * LAP + c.RAIL * turn)
        rows += [hw.row(f"Nickel-silver code 250 rail, {left:.1f} mm (left) and {right:.1f} mm (right), "
                        f"{p.get('metal_base', DEFAULT_BASE):g} mm foot", 1, hw.MATERIALS),
                 hw.row("Adhesive copper foil, 5 x 15 mm (one per lap blade)", 4, hw.MATERIALS),
                 hw.row(hw.GLUE, 1, hw.MATERIALS)]
    elif p.get("metal") == COPPER_TAPE:
        rows.append(hw.row(f"Copper foil tape 1/8 in (3.2 mm), conductive adhesive, {run + 8:.0f} mm", 2, hw.MATERIALS))
    if p.get("led"):
        rows.append(hw.row(f"{LED_STRIPS[int(p['led'])]:g} mm wide 5 V LED strip, {run:.0f} mm", 1, hw.ELECTRONICS))
    return rows


def assembly_notes(p: dict) -> list[str]:
    notes = []
    if p.get("metal") == METAL_RAIL:
        notes += ["Cut both rails to length (left and right differ on curves) and pre-bend curved ones to the "
                  "piece's radius; deburr the ends.",
                  "Seat each rail between its foot walls, butted against the printed lap blades, and wick thin CA "
                  "glue under the foot every 30 mm.",
                  "Wrap a copper foil strip over each lap blade's top and inner face and tuck its tail under the "
                  "metal rail end: the blades of joined pieces touch foil to foil and carry 9V across the joint.",
                  "Check every joint with a meter: under 0.5 ohm rail to rail across it."]
    elif p.get("metal") == COPPER_TAPE:
        notes += ["Lay copper foil tape along each printed rail head in its 0.1 mm recess, over the lap blades "
                  "too, folding 0.5 mm round the gauge corner; burnish it flat.",
                  "Check every joint with a meter: under 0.5 ohm rail to rail across it."]
    if p.get("led"):
        notes += [f"Press the {LED_STRIPS[int(p['led'])]:g} mm LED strip into the channel under the deck, LEDs up; "
                  "pass its leads out under an end wall and join pieces' strips with clip connectors.",
                  "Lay LED track on tiles or a flat table: the strip sits where the two centre stud rows would clutch."]
    return notes


# Brick train wheel flanges reach no lower than the guard/flangeway floor (composite.FLANGE_FLOOR, 6.4 mm).
CODE_250_HEAD = 2.79                        # PECO IL-9 head width; Llagas Creek 2.8


def _inside(body: manifold3d.Manifold, points) -> list[bool]:
    from matplotlib.path import Path
    result = []
    for x, y, z in points:
        inside = 0
        for polygon in body.slice(z).to_polygons():
            inside ^= int(Path(np.asarray(polygon)).contains_point((x, y)))
        result.append(bool(inside))
    return result


def probes(p: dict) -> dict:
    """Measured on the built mesh at the middle full tie (and the start lap): where the metal rail seats, how its
    foot walls clear the foot and the wheel flanges, the step and gauge change against the printed laps, the tape
    recess and the LED channel's skin. Distances in mm; `ok` checks each against its running limit."""
    spec = c.validate(p)
    mesh = c.track_mesh(p)
    body = manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))
    route = c.Route(spec)
    ties = c._ties(spec)
    middle = min(ties[1:-1] or ties, key=lambda tie: abs((tie[0] + tie[1]) / 2 - spec.length / 2))
    frame = route.frame((middle[0] + middle[1]) / 2)

    def at(y, z, station_frame=frame):
        point = station_frame @ np.array([0., y, z, 1.])
        return (point[0], point[1], point[2] + spec.z0)

    def top(y, below=12., station_frame=frame):
        """Highest solid height at lateral y under `below`, 0.02 mm steps."""
        zs = np.arange(below, -.01, -.02)
        hits = _inside(body, [at(y, z, station_frame) for z in zs])
        return float(zs[hits.index(True)]) if True in hits else None

    rows = {}
    if spec.metal == METAL_RAIL:
        thickness, clearance, wall = FOOT
        seat = top(c.RAIL, 4.5)
        ys = np.arange(c.RAIL, c.RAIL + 6, .02)
        walls = _inside(body, [at(y, c.BASE + .4) for y in ys])
        free = float(ys[walls.index(True)] - c.RAIL) if True in walls else None
        wall_top = top(c.RAIL + spec.metal_base / 2 + clearance + wall / 2, 6.)
        lap = top(c.RAIL + .6, 12., route.start)
        rows.update(seat=seat, head=seat + CODE_250, lap_head=lap, step=lap - (seat + CODE_250),
                    foot_clearance=free - spec.metal_base / 2, wall_top=wall_top, flange_clearance=c.FLANGE_FLOOR - wall_top,
                    gauge_narrowing=CODE_250_HEAD - c.PROFILE["railInterfaceWidth"])
        rows["ok"] = (abs(rows["step"]) <= .1 and .05 <= rows["foot_clearance"] <= .3 and rows["flange_clearance"] >= 1.
                      and rows["gauge_narrowing"] <= .5)
    elif spec.metal == COPPER_TAPE:
        head = top(c.RAIL)
        rows.update(head=head, recess=end_.RAIL_TOP - head, lap_head=top(c.RAIL + .6, 12., route.start))
        rows["ok"] = abs(rows["recess"] - TAPE_DEPTH) <= .03
    if spec.led:
        ys = np.arange(0, 8, .02)
        open_ = _inside(body, [at(y, c.BASE - LED_SKIN - .1) for y in ys])
        half = float(ys[open_.index(True)]) if True in open_ else None
        zs = np.arange(0, c.BASE + .2, .02)
        column = _inside(body, [at(0., z) for z in zs])
        ceiling = float(zs[column.index(True)]) if True in column else None
        rows.update(led_half_width=half, led_ceiling=ceiling, led_skin=c.BASE - ceiling)
        rows["ok"] = rows.get("ok", True) and half >= LED_STRIPS[spec.led] / 2 and rows["led_skin"] >= .8
    return rows
