"""Moving tables: turntable, transfer table and sector plate (Wave 4, C4); millimetres.

Each table is a fixed body (pit or well, stub tracks with brick connector ends) and a moving deck that lines up
with one stub pair (turntable, transfer table) or one far stub (sector plate) at a time. The numbers mirror
src/domain/pieces/families/tables.ts, which places the same ports and deck positions.

Heights (rail top 9.6 like all track): the fixed floor is 0-3.0 under the deck's travel; rims and stubs are
standard 3.2 mm track base. The deck (flat underside, so it prints rails up without support) slides on the floor:
a 2.6 mm plate under its rails, girders outside the rails to 6.4 and a centre spine to 6.6, all below the wheel
flange corridors; its rails meet the stub rails at the same height across a 1 mm gap. Detents: a 6 x 3 mm magnet
in each deck end over a flush magnet in the floor at every position; two 3 mm steel dowel pins through the deck
into the floor lock it lined up. Turntables and sector plates turn on a printed pivot pin with a screwed cap;
transfer-table decks are kept square by two floor ribs running in channels under the deck.

Every part is split into bed-sized pieces along keyed seams: the kerf follows dovetail bumps, so neighbours
lock in plan, and seams stay off magnets, pins, ribs and connector ends. Pieces print flat, rotated on the
bed (print_yaw) to fit. Magnet strength, sliding friction and pin fit are physical trial gates.
"""
from __future__ import annotations

from functools import lru_cache
import math
from pathlib import Path

import cadquery as cq
import manifold3d as mf
import numpy as np
import trimesh

from . import brick_end as end
from . import hardware as hw
from . import track_assembly as ta

try:  # Bought drives (Automation's module); the turntable's motor option needs it.
    from . import drives
except ImportError:  # pragma: no cover - drives.py ships with the same wave
    drives = None

# ------------------------------------------------------------------ constants (tables.ts TABLE mirrors these)
HALF = end.PROFILE["bodyWidth"] / 2          # 31.9
RAIL = end.PROFILE["railGauge"] / 2          # 20
HEAD = end.PROFILE["railInterfaceWidth"] / 2 # 1.2
BASE = end.PROFILE["baseThickness"]          # 3.2
TOP = end.RAIL_TOP                           # 9.6
GAP = 1.0            # deck rail end to stub rail end
WALL = 8.0           # rim / well wall band
STUB_MIN = 24.0      # shortest turntable stub, pit wall to port
CLEAR = .4           # deck sweep clearance in plan
RAIL_CLEAR = 5.0     # clear space between neighbouring stall rail heads at the pit edge
LANE = 128.0         # transfer-table lanes, 16 studs
LANE_STUB = 24.0
SECTOR_STUB = 24.0
SECTOR_KINK = math.radians(5.625)   # official flex-track joint limit at the sector plate's pivot
FLOOR = 3.0          # the deck slides on it
BLOCK_TOP = 5.6      # deck end blocks, below the flange corridors (6.4)
GIRDER_TOP = 6.4
SPINE_TOP = 6.6
SPINE = 8.0          # spine half width
GIRDER = (24.0, HALF)
RIB = (30.0, 4.0, 1.4)   # transfer-table guide ribs: inward from each deck end, width, height above the floor
MAGNET = (6.2, 3.1)  # 6 x 3 mm magnet pocket (diameter, depth)
MAGNET_IN = 8.0      # magnet centre inward from the deck end
PIN_IN = 20.0        # lock pin inward from the deck end
PIN_HOLE = 3.1       # for 3 mm steel dowel pins (ream 3.1)
PIVOT = 8.0          # printed pivot pin
BORE = 8.3
PIVOT_TOP = 6.8
DRIVEN_PIVOT_TOP = 6.0   # the driven cap sits on the bridge, above a shorter hollow pin
PILOT = 2.6          # M3 self-tapping pilot
KERF = .2            # seam gap: 0.1 mm each side
PLAN = 158.0         # every printed piece fits this square (A1 mini usable 166 mm)
BED = 166.0
CONTACT_ZONE = 16.0  # seams stay this far inside a connector port
SOURCE_DEPENDENCIES = [Path(ta.__file__), Path(end.__file__)]

FAMILIES = ("turntable", "transfer_table", "sector_plate")
COMPONENT_FAMILY = "table_component"
CONNECTOR = frozenset({"connector_version", "fit_adjustment"})
SHAPES = {"turntable": ("bridge", "index", "left", "right", "drive"),
          "transfer_table": ("deck", "lanes", "hand"),
          "sector_plate": ("deck", "tracks")}


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _ceil8(mm: float) -> float:
    return math.ceil(mm / 8 - 1e-9) * 8


# ------------------------------------------------------------------ shapes (mirror tables.ts)

def turntable_shape(p: dict) -> dict:
    bridge, index = float(p["bridge"]), float(p["index"])
    positions = round(360 / index)
    axes = positions // 2
    left, right = int(p["left"]), int(p["right"])
    half, theta = bridge / 2, math.radians(index)
    wall = half + GAP
    crowded = left + right > 0
    port = _ceil8(max(wall + STUB_MIN, (HALF + .5) / math.tan(theta / 2) if crowded else 0))
    ports = [("in", math.pi), ("out", 0.)] + [(f"l{j}", j*theta) for j in range(1, left + 1)] + \
            [(f"r{j}", -j*theta) for j in range(1, right + 1)]

    def at(k):
        return next((ident for ident, angle in ports
                     if abs(math.atan2(math.sin(angle - k*theta), math.cos(angle - k*theta))) < 1e-6), None)
    axis_rows = []
    for k in range(axes):
        a, b = at(k), at(k + axes)
        if a or b:
            axis_rows.append({"k": k, "a": a, "b": b})
    return {"bridge": bridge, "index": index, "theta": theta, "positions": positions, "axes": axes, "left": left,
            "right": right, "half": half, "wall": wall, "port": port, "centre": (port, 0.), "ports": ports,
            "axis_rows": axis_rows, "drive": int(p["drive"])}


def transfer_shape(p: dict) -> dict:
    deck, lanes, hand = float(p["deck"]), int(p["lanes"]), (-1. if p["hand"] < 0 else 1.)
    well = deck + 2*GAP
    return {"deck": deck, "lanes": lanes, "hand": hand, "well": well, "length": well + 2*LANE_STUB,
            "ys": [hand*i*LANE for i in range(lanes)], "x0": LANE_STUB + GAP}


def sector_shape(p: dict) -> dict:
    deck, tracks = float(p["deck"]), int(p["tracks"])
    step = (2 if tracks == 2 else 1) * SECTOR_KINK
    angles = [(i - (tracks - 1) / 2) * step for i in range(tracks)]
    reach = _ceil8(max(deck + GAP + STUB_MIN, (HALF + .5) / math.sin(step / 2)))
    return {"deck": deck, "tracks": tracks, "step": step, "angles": angles, "reach": reach,
            "pivot": (SECTOR_STUB, 0.), "out": tracks // 2,
            # The deck body starts this far past the pivot, so its corners clear the fixed rails as it turns.
            "trim": (RAIL + 3)*math.sin(max(abs(a) for a in angles)) + CLEAR}


def _shape(family: str, p: dict) -> dict:
    return {"turntable": turntable_shape, "transfer_table": transfer_shape, "sector_plate": sector_shape}[family](p)


def validate(family: str, p: dict) -> None:
    if family not in FAMILIES:
        raise ValueError("unknown table family")
    required = CONNECTOR | {"switch_state"} | set(SHAPES[family])
    if set(p) != required:
        raise ValueError(f"{family} requires exactly {sorted(required)}")
    if any(not _number(value) for value in p.values()):
        raise ValueError("table parameters must be finite numbers")
    end.validate(p)
    if family == "turntable":
        if p["bridge"] not in (256, 384, 512) or p["index"] not in (22.5, 15, 11.25):
            raise ValueError("turntable bridge must be 256/384/512 mm and stall spacing 22.5/15/11.25°")
        axes = round(180 / p["index"])
        if any(p[key] != int(p[key]) or not 0 <= p[key] <= axes - 1 for key in ("left", "right")):
            raise ValueError(f"at {p['index']}° a side holds 0..{axes - 1} stalls")
        if p["drive"] not in (0, 1, 2):
            raise ValueError("drive must be 0 (by hand), 1 (Bluetooth) or 2 (infrared)")
        s = turntable_shape(p)
        if s["left"] + s["right"] and s["wall"]*math.sin(s["theta"]) - 2*RAIL - 2*HEAD < RAIL_CLEAR:
            raise ValueError("neighbouring stall rails touch at the pit edge; use a longer bridge")
        states = len(s["axis_rows"])
    elif family == "transfer_table":
        if p["deck"] not in (256, 384) or p["lanes"] != int(p["lanes"]) or not 2 <= p["lanes"] <= 6 or p["hand"] not in (-1, 1):
            raise ValueError("transfer table: deck 256/384 mm, 2..6 lanes, hand ±1")
        states = int(p["lanes"])
    else:
        if p["deck"] not in (384, 512, 640) or p["tracks"] not in (2, 3):
            raise ValueError("sector plate: deck 384/512/640 mm, 2 or 3 tracks")
        states = int(p["tracks"])
    if p["switch_state"] != int(p["switch_state"]) or not 0 <= p["switch_state"] < states:
        raise ValueError(f"switch_state must be 0..{states - 1}")


def _port(ident, x, y, heading):
    return {"id": ident, "position": [float(x), float(y), 0.], "heading": float(heading), "pitch": 0.,
            "rail_gauge": 2*RAIL, "rail_interface_width": 2*HEAD}


def _routes(family: str, p: dict) -> list[dict]:
    """Every deck position as the TS paths give it: id, from, to, state index, and the far end when it is free."""
    s = _shape(family, p)
    if family == "turntable":
        cx, cy = s["centre"]
        angle = dict(s["ports"])
        rows = []
        for state, axis in enumerate(s["axis_rows"]):
            start = axis["b"] or axis["a"]
            to = axis["a"] if axis["b"] else None
            free = math.atan2(math.sin(angle[start] + math.pi), math.cos(angle[start] + math.pi))
            rows.append({"id": f"bridge-{axis['k']}", "from": start, "to": to or f"free-{axis['k']}", "state": state,
                         "free": None if to else (cx + s["half"]*math.cos(free), cy + s["half"]*math.sin(free), free)})
        return rows
    if family == "transfer_table":
        name = lambda base, i: base if i == 0 else f"{base}{i + 1}"
        return [{"id": f"lane-{i + 1}", "from": name("in", i), "to": name("out", i), "state": i, "free": None}
                for i in range(s["lanes"])]
    return [{"id": f"track-{i + 1}", "from": "in", "to": "out" if i == s["out"] else f"out{i + 1}", "state": i, "free": None}
            for i in range(s["tracks"])]


def _port_list(family: str, p: dict) -> list[dict]:
    s = _shape(family, p)
    if family == "turntable":
        cx, cy = s["centre"]
        rows = [_port(ident, cx + s["port"]*math.cos(a), cy + s["port"]*math.sin(a), a) for ident, a in s["ports"]]
        rows += [_port(route["to"], *route["free"]) for route in _routes(family, p) if route["free"]]
        return rows
    if family == "transfer_table":
        rows = []
        for i, y in enumerate(s["ys"]):
            rows += [_port("in" if i == 0 else f"in{i + 1}", 0, y, math.pi),
                     _port("out" if i == 0 else f"out{i + 1}", s["length"], y, 0.)]
        return rows
    px, py = s["pivot"]
    rows = [_port("in", 0, 0, math.pi)]
    for i, a in enumerate(s["angles"]):
        rows.append(_port("out" if i == s["out"] else f"out{i + 1}", px + s["reach"]*math.cos(a), py + s["reach"]*math.sin(a), a))
    return rows


def ports(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return _port_list(family, p)


def route_pairs(family: str, p: dict) -> dict[frozenset, bool]:
    validate(family, p)
    state = int(p["switch_state"])
    return {frozenset((route["from"], route["to"])): route["state"] == state for route in _routes(family, p)}


# ------------------------------------------------------------------ plan and solid helpers

def _cs(points) -> mf.CrossSection:
    return mf.CrossSection([np.asarray(points, float).tolist()], mf.FillRule.EvenOdd)


def _union_cs(sections) -> mf.CrossSection:
    result = mf.CrossSection()
    for section in sections:
        result += section
    return result


def _disc(centre, radius, n=256) -> mf.CrossSection:
    return mf.CrossSection.circle(radius, n).translate(tuple(centre))


def _rect(x0, y0, x1, y1) -> mf.CrossSection:
    return _cs([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])


def _quad(origin, heading, u0, u1, v0, v1) -> mf.CrossSection:
    c, s = math.cos(heading), math.sin(heading)
    return _cs([(origin[0] + c*u - s*v, origin[1] + s*u + c*v) for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))])


def _prism(section: mf.CrossSection, low: float, high: float) -> mf.Manifold:
    if section.is_empty():
        return mf.Manifold()
    return section.extrude(high - low).translate((0, 0, low))


def _layers(*layers) -> mf.Manifold:
    """Stacked slabs (low, high, plan). Bodies are built in layers so no two solids ever share a side face: exactly
    coincident walls survive a boolean as a pinched seam that CAD export rejects."""
    return _sum([_prism(plan, low, high) for low, high, plan in layers])


def _fixed_layers(floor, base) -> mf.Manifold:
    """A fixed body from its floor (0-3.0) and full-height base (0-3.2) plans."""
    # The floor reaches 0.1 mm under the walls, which stand back 0.05 mm from the rail ends.
    return _layers((0., FLOOR, floor.offset(.1, mf.JoinType.Miter) + base), (FLOOR, BASE, base))


def _man(mesh: trimesh.Trimesh) -> mf.Manifold:
    return mf.Manifold(mf.Mesh(np.asarray(mesh.vertices, np.float32), np.asarray(mesh.faces, np.uint32)))


def _tri(solid: mf.Manifold) -> trimesh.Trimesh:
    mesh = solid.to_mesh()
    return trimesh.Trimesh(np.asarray(mesh.vert_properties)[:, :3], np.asarray(mesh.tri_verts), process=False)


def _cylinder(centre, radius, low, high, n=96) -> mf.Manifold:
    return _prism(_disc(centre, radius, n), low, high)


def _rails(start, heading, length) -> mf.Manifold:
    """Both rails of a straight from `start` along `heading` (the shared versioned profile)."""
    path = np.array([[start[0], start[1], heading],
                     [start[0] + length*math.cos(heading), start[1] + length*math.sin(heading), heading]])
    # Rail feet sink 0.1 mm into the deck or stub base so they fuse with it.
    return _man(ta._rails(path, bottom=BASE - .1))


def _sum(solids) -> mf.Manifold:
    solids = [solid for solid in solids if not solid.is_empty()]
    return mf.Manifold.batch_boolean(solids, mf.OpType.Add) if solids else mf.Manifold()


def _connector_ends(body: mf.Manifold, port_rows: list[dict], adjustment: float) -> mf.Manifold:
    """Production brick ends at every real port, exactly as crossing_any seats them."""
    masks, contacts, cuts, additions = [], [], [], []
    for port in port_rows:
        frame = end._frame((port["position"][0], port["position"][1], 0), port["heading"] + math.pi, 0)
        mask = end._box((-8, -34, -1), (5.8, 34, 12))
        mask.apply_transform(frame)
        masks.append(_man(mask))
        contact = end._production_end(adjustment, opposite=not port["id"].startswith("in"))
        contact.apply_transform(frame)
        contacts.append(_man(contact))
        c, a = ta._end_attachments(port)
        cuts += [_man(m) for m in c]
        additions += [_man(m) for m in a]
    body = body - _sum(masks)
    body = _sum([body, *contacts]) - _sum(cuts)
    return _sum([body, *additions])


def _bump(point, along, normal, neck=5., head=8., depth=4.) -> list:
    """Kerf polyline through one dovetail key: crosses the seam line at `point`, the key head on the `normal` side."""
    p, t, n = np.asarray(point, float), np.asarray(along, float), np.asarray(normal, float)
    return [p - t*neck/2, p - t*head/2 + n*depth, p + t*head/2 + n*depth, p + t*neck/2]


def _kerf(polyline) -> mf.CrossSection:
    """A 0.2 mm cut along a polyline (segments plus round joints)."""
    pts = [np.asarray(point, float) for point in polyline]
    parts = []
    for a, b in zip(pts, pts[1:]):
        d = b - a
        length = float(np.hypot(*d))
        if length < 1e-9:
            continue
        parts.append(_quad(a, math.atan2(d[1], d[0]), 0, length, -KERF/2, KERF/2))
    parts += [_disc(point, KERF/2, 16) for point in pts]
    return _union_cs(parts)


def _seam_line(a, b, bumps) -> list:
    """Straight seam a→b with dovetail bumps at fractions `bumps` (sign = side of the key head)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    t = (b - a) / np.linalg.norm(b - a)
    n = np.array([-t[1], t[0]])
    points = [a]
    for fraction, side in sorted(bumps):
        points += _bump(a + (b - a)*fraction, t, n*side)
    return points + [b]


def _seam_arc(centre, radius, a0, a1, bumps, step=math.radians(1.)) -> list:
    """Circular seam from angle a0 to a1 with bumps at the given angles (sign: +1 key outward)."""
    c = np.asarray(centre, float)
    count = max(2, int(abs(a1 - a0) / step) + 1)
    points = []
    marks = sorted(bumps)
    angles = list(np.linspace(a0, a1, count))
    for i, angle in enumerate(angles):
        while marks and (marks[0][0] <= angle if a1 > a0 else marks[0][0] >= angle):
            at, side = marks.pop(0)
            u = np.array([math.cos(at), math.sin(at)])
            t = np.array([-u[1], u[0]]) * (1 if a1 > a0 else -1)
            points += _bump(c + radius*u, t, u*side)
        points.append(c + radius*np.array([math.cos(angle), math.sin(angle)]))
    return points


def _clean(solid: mf.Manifold) -> mf.Manifold:
    """Drop the zero-area slivers boolean seams leave (they would read back as empty bodies)."""
    solid = solid.simplify(1e-4)
    return mf.Manifold.compose([body for body in solid.decompose() if body.volume() > 1e-3])


def _split(solid: mf.Manifold, seams: list) -> list[trimesh.Trimesh]:
    """Cut along keyed seams; pieces sorted by position. Slivers under 50 mm³ are dropped."""
    if seams:
        solid = solid - _prism(_union_cs([_kerf(seam) for seam in seams]), -1, 20)
    pieces = [piece for piece in solid.decompose() if piece.volume() > 50]
    meshes = [_tri(_clean(piece)) for piece in pieces]
    return sorted(meshes, key=lambda m: (round(float(m.centroid[0]), 0), round(float(m.centroid[1]), 0)))


def best_yaw(mesh: trimesh.Trimesh) -> float:
    """Rotation about z giving the smallest plan box that fits the bed (0 when it already fits square-on)."""
    xy = np.asarray(mesh.convex_hull.vertices)[:, :2]
    best = None
    for degrees in np.arange(0, 90, .5):
        a = math.radians(float(degrees))
        r = xy @ np.array([[math.cos(a), math.sin(a)], [-math.sin(a), math.cos(a)]])
        size = r.max(axis=0) - r.min(axis=0)
        key = (max(size), size[0]*size[1])
        if best is None or key < best[0]:
            best = (key, a)
        if degrees == 0 and max(size) <= PLAN:
            return 0.
    return best[1]


def plan_size(mesh: trimesh.Trimesh, yaw: float) -> tuple[float, float]:
    xy = np.asarray(mesh.vertices)[:, :2]
    r = xy @ np.array([[math.cos(yaw), math.sin(yaw)], [-math.sin(yaw), math.cos(yaw)]])
    size = r.max(axis=0) - r.min(axis=0)
    return float(size[0]), float(size[1])


# ------------------------------------------------------------------ the moving deck (deck frame: +x along the deck)

def _deck(length: float, start: float, *, arc_centre=None, pivot=False, near_end=True, near_trim=0., channels=(),
          drive_pegs=False) -> mf.Manifold:
    """A deck from x=`start` to `start+length`, centred on y=0, its flat underside on the floor, with a magnet and a
    lock-pin hole at its far end (and near end when `near_end`).

    `arc_centre`: deck-frame point whose circles trim each end (turntable / sector arcs); `pivot`: a hub and bore at
    it; `near_trim`: the body and rails start this far in from `start` (sector plate: clear of the fixed rails as it
    turns); `channels`: x positions of transfer-table rib channels across the underside."""
    x0, x1 = start, start + length
    b0 = x0 + near_trim
    full = _rect(b0, -HALF, x1, HALF)
    if arc_centre is not None:
        c = np.asarray(arc_centre, float)
        full = full ^ _disc(c, x1 - c[0], 512)
        if near_end and x0 < c[0]:
            full = full ^ _disc(c, c[0] - x0, 512)
    girders = _union_cs([_rect(b0, GIRDER[0], x1, GIRDER[1]), _rect(b0, -GIRDER[1], x1, -GIRDER[0])]) ^ full
    spine = _rect(b0, -SPINE, x1, SPINE) ^ full
    hub = _disc(arc_centre, BORE/2 + 4.5, 128) if pivot else mf.CrossSection()
    # The body stops 0.05 mm short of the rail ends, so rail end faces never coincide with a body wall.
    inset = lambda plan: plan.offset(-.05, mf.JoinType.Miter)
    body = _layers((FLOOR, BLOCK_TOP, inset(full) + hub), (BLOCK_TOP, GIRDER_TOP, inset(girders + spine) + hub),
                   (GIRDER_TOP, SPINE_TOP, inset(spine) + hub))
    rails = _rails((b0 - 5, 0), 0., x1 - b0 + 10)
    body = _sum([body, rails ^ _prism(full ^ _rect(b0 + .05, -40, x1 + 1, 40), 0, 20)])
    cuts = [_prism(_rect(x - RIB[1]/2 - .2, -40, x + RIB[1]/2 + .2, 40), FLOOR - 1, FLOOR + RIB[2] + .2) for x in channels]
    for mx, px, here in ((x0 + MAGNET_IN, x0 + PIN_IN, near_end), (x1 - MAGNET_IN, x1 - PIN_IN, True)):
        if here:
            cuts += [_cylinder((mx, 0), MAGNET[0]/2, FLOOR - .01, FLOOR + MAGNET[1]),
                     _cylinder((px, 0), PIN_HOLE/2, 0, 20, 48)]
    if pivot:
        cuts.append(_cylinder(arc_centre, BORE/2, 0, 20))
        if drive_pegs:
            cuts += [_cylinder((arc_centre[0] + dx, 0), 1.6, SPINE_TOP - 3, 20, 32) for dx in (-10, 10)]
    return body - _sum(cuts)


def _deck_seams(start: float, length: float, avoid: tuple = ()) -> list:
    """Cross seams splitting the deck into ceil(L/150) keyed pieces; a seam is moved off the pivot hub."""
    count = math.ceil(length / 150)
    seams = []
    for k in range(1, count):
        x = start + length*k/count
        for centre in avoid:
            if abs(x - centre) < 14:
                x = centre + 14
        bumps = [(.5 + y/(2*HALF + 20), 1) for y in (0.,)] + [(.5 + y/(2*HALF + 20), -1) for y in (-12.5, 12.5)]
        seams.append(_seam_line((x, -HALF - 10), (x, HALF + 10), bumps))
    return seams


# ------------------------------------------------------------------ turntable

def _place(solid: mf.Manifold, origin, heading: float) -> mf.Manifold:
    return solid.rotate((0, 0, math.degrees(heading))).translate((origin[0], origin[1], 0))


# Motor drives sit DRIVE_Z under the pit. The mount's axle (frame +x) passes the worm-to-24T centre distance beside the
# vertical axle, square to it, with the worm centred WORM_AT in front of the plate.
DRIVE_Z, WORM_AT = -40., 16.
MOTOR_OF_DRIVE = {1: "L", 2: "IR_L"}


def drive_frame(centre) -> np.ndarray:
    return end._frame((centre[0] - WORM_AT, centre[1] - drives.WORM_CENTRES, DRIVE_Z), 0, 0)


@lru_cache(maxsize=8)
def _turntable(key: tuple, adjustment: float) -> list[tuple[str, trimesh.Trimesh, float]]:
    p = dict(key)
    s = turntable_shape(p)
    c, H, Rw, Rp = s["centre"], s["half"], s["wall"], s["port"]
    rows = _port_list("turntable", p)
    real = [row for row in rows if not row["id"].startswith("free-")]
    every = [k*s["theta"] for k in range(s["positions"])]
    stubs = [_quad(c, angle, Rw, Rp, -HALF, HALF) for _, angle in s["ports"]]
    pit = _disc(c, Rw, 512)
    # The base wall stands 0.05 mm inside the stub rail ends (no coincident faces).
    base = _union_cs([_disc(c, Rw + WALL), *stubs]) - _disc(c, Rw - .05, 512)
    solids = [_fixed_layers(pit, base), _cylinder(c, PIVOT/2, FLOOR - .01, DRIVEN_PIVOT_TOP if s["drive"] else PIVOT_TOP)]
    rails = [_rails((c[0] + (Rw - 3)*math.cos(a), c[1] + (Rw - 3)*math.sin(a)), a, Rp - Rw + 3) for _, a in s["ports"]]
    body = _sum(solids + [_sum(rails) - _cylinder(c, Rw, -1, 20, 512)])
    holes = [_cylinder((c[0] + (H - MAGNET_IN)*math.cos(a), c[1] + (H - MAGNET_IN)*math.sin(a)), MAGNET[0]/2, -1, FLOOR + 1) for a in every]
    holes += [_cylinder((c[0] + (H - PIN_IN)*math.cos(a), c[1] + (H - PIN_IN)*math.sin(a)), PIN_HOLE/2, -1, 6, 48) for a in every]
    holes.append(_cylinder(c, (5.0 if s["drive"] else PILOT)/2, -1 if s["drive"] else PIVOT_TOP - 6, 20, 48))
    body = _connector_ends(body - _sum(holes), real, adjustment)
    # Seams: a centre disc, rings outward (off the pins, magnets and connector ends), sectors between positions.
    outer = max(Rw + WALL, math.hypot(Rp, HALF)) + 1
    radii, r = [], 70.
    forbidden = [(H - PIN_IN - 3, Rw + WALL + 2), (Rp - CONTACT_ZONE, Rp + 1)]
    while outer - r > 130:
        nxt = r + 95
        for low, high in forbidden:
            if low < nxt < high:
                nxt = low if low - r > 40 else high
        radii.append(nxt)
        r = nxt
    radii = [70.] + [value for value in radii if value < outer - 20]
    seams = []
    rings = list(zip(radii, radii[1:] + [outer]))
    for r1, r2 in rings:
        # The widest sector (whole positions per piece, dividing the circle) whose box fits the plan square.
        reach = r2 if r2 < outer - 1e-6 else outer
        m = max(m for m in range(1, s["positions"] + 1) if s["positions"] % m == 0 and m*s["theta"] <= math.pi and
                2*reach*math.sin(m*s["theta"]/2) <= PLAN - 6 and reach - r1*math.cos(m*s["theta"]/2) <= PLAN - 6)
        for j in range(0, s["positions"], m):
            phi = (j + .5)*s["theta"]
            u, t = np.array([math.cos(phi), math.sin(phi)]), np.array([-math.sin(phi), math.cos(phi)])
            a, b = np.asarray(c) + r1*u, np.asarray(c) + (reach + 2 if r2 >= outer else r2)*u
            # Key heads point away from the nearest stub, so they stay clear of its rail feet.
            near = min((ident for ident in s["ports"]), key=lambda port: abs(math.atan2(math.sin(port[1] - phi), math.cos(port[1] - phi))))
            side = -1 if math.sin(near[1] - phi) > 0 else 1
            length = float(np.linalg.norm(b - a))
            bumps = []
            mid = (r1 + min(r2, Rw - 2)) / 2
            if r1 < Rw - 2 and min(r2, Rw) - r1 > 20 and not (H - PIN_IN - 6 < mid < H + 1):
                bumps.append(((mid - r1)/length, side))
            if r1 < Rw + WALL/2 < r2:
                bumps.append(((Rw + WALL/2 - r1)/length, side))
            seams.append(_seam_line(a, b, bumps))
        if r1 > 0:
            marks = [((j + m/2 + .5)*s["theta"] - .5*s["theta"], 1) for j in range(0, s["positions"], m)]
            seams.append(_seam_arc(c, r1, -.5*s["theta"] + 1e-4, 2*math.pi - .5*s["theta"] - 1e-4, marks))
    pieces = _split(body, seams)
    parts = [(f"pit-{i + 1:02d}", mesh, best_yaw(mesh)) for i, mesh in enumerate(pieces)]
    # The bridge, turned to the selected axis.
    state = int(p["switch_state"])
    axis = s["axis_rows"][state]["k"]*s["theta"]
    bridge = _deck(2*H, -H, arc_centre=(0., 0.), pivot=True, drive_pegs=bool(s["drive"]))
    for i, piece in enumerate(_split(bridge, _deck_seams(-H, 2*H, avoid=(0.,)))):
        placed = _tri(_place(_man(piece), c, axis))
        parts.append((f"bridge-{i + 1:02d}", placed, best_yaw(placed)))
    # Pivot cap: a washer under an M3 screw, or (motor) a driven bar on the cross axle.
    if s["drive"]:
        if drives is None:
            raise ValueError("the motor turntable needs cad/models/drives.py")
        cap = _prism(_rect(-14, -4.5, 14, 4.5), 0, 2.4) + _sum([_cylinder((dx, 0), 1.45, -2.6, .01, 32) for dx in (-10, 10)])
        up = trimesh.transformations.translation_matrix((0, 0, -1)) @ trimesh.transformations.rotation_matrix(-math.pi/2, (0, 1, 0))
        cap = cap - _man(drives.cross_axle(up, 6))
    else:
        cap = _cylinder((0, 0), 7, 0, 1.2) - _cylinder((0, 0), 1.7, -1, 3, 32)
    parts.append(("pivot-cap", _tri(cap.translate((c[0], c[1], PIVOT_TOP if not s["drive"] else SPINE_TOP))), 0.))
    if s["drive"] and drives:
        if s["drive"] == 1:
            mount = drives.bluetooth_mount(drive_frame(c), motor="L")
        else:
            mount = drives.infrared_mount(drive_frame(c))
        plate = _sum([_man(m) for m in mount.additions]) - _sum([_man(m) for m in mount.cuts])
        mesh = _tri(plate)
        parts.append(("drive-mount", mesh, best_yaw(mesh)))
    return parts


# ------------------------------------------------------------------ transfer table

@lru_cache(maxsize=8)
def _transfer(key: tuple, adjustment: float) -> list[tuple[str, trimesh.Trimesh, float]]:
    p = dict(key)
    s = transfer_shape(p)
    rows = _port_list("transfer_table", p)
    ys, x0, deck, length = s["ys"], s["x0"], s["deck"], s["length"]
    y0, y1 = min(ys) - HALF - CLEAR, max(ys) + HALF + CLEAR
    well = _rect(LANE_STUB, y0, LANE_STUB + s["well"], y1)
    outline = _rect(0, y0 - WALL, length, y1 + WALL)
    ribs = [x0 + RIB[0], x0 + deck - RIB[0]]
    wall_plan = outline - _rect(LANE_STUB - .05, y0, LANE_STUB + s["well"] + .05, y1)
    rails = [_rails((-1, y), 0., LANE_STUB + 1) for y in ys] + [_rails((length - LANE_STUB, y), 0., LANE_STUB + 1) for y in ys]
    body = _sum([_fixed_layers(well, wall_plan), *[_prism(_rect(x - RIB[1]/2, y0, x + RIB[1]/2, y1), FLOOR - .01, FLOOR + RIB[2]) for x in ribs], _sum(rails) ^ _prism(outline - well, -1, 20)])
    holes = []
    for y in ys:
        holes += [_cylinder((x0 + MAGNET_IN, y), MAGNET[0]/2, -1, FLOOR + 1), _cylinder((x0 + deck - MAGNET_IN, y), MAGNET[0]/2, -1, FLOOR + 1),
                  _cylinder((x0 + PIN_IN, y), PIN_HOLE/2, -1, 6, 48), _cylinder((x0 + deck - PIN_IN, y), PIN_HOLE/2, -1, 6, 48)]
    body = _connector_ends(body - _sum(holes), rows, adjustment)
    # Seams: columns across the well off the strips and pins; rows midway between lanes.
    columns = math.ceil(length / 150)
    xs = []
    for k in range(1, columns):
        x = length*k/columns
        x = min(max(x, x0 + PIN_IN + 6), x0 + deck - PIN_IN - 6)
        xs.append(x)
    lane_mid = sorted((ys[i] + ys[i + 1]) / 2 for i in range(len(ys) - 1))
    row_cuts = [y for y in lane_mid]
    edges_y = [y0 - WALL - 2] + row_cuts + [y1 + WALL + 2]
    edges_x = [-2.] + xs + [length + 2]
    seams = []
    for x in xs:
        for ya, yb in zip(edges_y, edges_y[1:]):
            seams.append(_seam_line((x, ya), (x, yb), [(.5, 1)]))
    for y in row_cuts:
        for xa, xb in zip(edges_x, edges_x[1:]):
            # A row seam crossing the strips or the stub ends keys inside the floor only.
            seams.append(_seam_line((xa, y), (xb, y), [(.5, 1)] if xb - xa > 40 else []))
    pieces = _split(body, seams)
    parts = [(f"well-{i + 1:02d}", mesh, best_yaw(mesh)) for i, mesh in enumerate(pieces)]
    lane = ys[int(p["switch_state"])]
    deck_solid = _deck(deck, x0, channels=ribs)
    for i, piece in enumerate(_split(deck_solid, _deck_seams(x0, deck))):
        placed = _tri(_man(piece).translate((0, lane, 0)))
        parts.append((f"deck-{i + 1:02d}", placed, best_yaw(placed)))
    return parts


# ------------------------------------------------------------------ sector plate

def _sector_sweep(s: dict) -> mf.CrossSection:
    """Plan swept by the deck through its whole travel, plus the sweep clearance."""
    px, py = s["pivot"]
    amax = max(abs(a) for a in s["angles"])
    # The deck's far end is an arc about the pivot (its corners never pass the far stubs' rail ends).
    rect = (_rect(s["trim"], -HALF, s["deck"], HALF) ^ _disc((0, 0), s["deck"], 512)) + _disc((0, 0), BORE/2 + 4.5, 64)
    sweep = _union_cs([rect.rotate(math.degrees(a)) for a in np.linspace(-amax, amax, 46)])
    # Simplified: the union of rotated rectangles leaves runs of tiny, nearly collinear edges.
    return sweep.offset(CLEAR, mf.JoinType.Round, circular_segments=96).simplify(.02).translate((px, py))


@lru_cache(maxsize=8)
def _sector(key: tuple, adjustment: float) -> list[tuple[str, trimesh.Trimesh, float]]:
    p = dict(key)
    s = sector_shape(p)
    rows = _port_list("sector_plate", p)
    P, D, R = s["pivot"], s["deck"], s["reach"]
    sweep = _sector_sweep(s)
    stubs = [_quad(P, a, D + GAP - 2, R, -HALF, HALF) for a in s["angles"]]
    outline = _union_cs([sweep.offset(WALL, mf.JoinType.Round, circular_segments=96).simplify(.02), _rect(0, -HALF, P[0] + 1, HALF), *stubs])
    base = (outline - sweep.offset(.05, mf.JoinType.Round, circular_segments=96))
    solids = [_fixed_layers(sweep, base), _cylinder(P, PIVOT/2, FLOOR - .01, PIVOT_TOP)]
    rails = [_rails((-1, 0), 0., P[0] - .6 + 1)]
    rails += [_sum([_rails((P[0] + (D - 3)*math.cos(a), P[1] + (D - 3)*math.sin(a)), a, R - D + 3)]) - _cylinder(P, D + GAP, -1, 20, 512)
              for a in s["angles"]]
    body = _sum(solids + [_sum(rails) - _prism(sweep, -1, 20)])
    holes = []
    for a in s["angles"]:
        holes += [_cylinder((P[0] + (D - MAGNET_IN)*math.cos(a), P[1] + (D - MAGNET_IN)*math.sin(a)), MAGNET[0]/2, -1, FLOOR + 1),
                  _cylinder((P[0] + (D - PIN_IN)*math.cos(a), P[1] + (D - PIN_IN)*math.sin(a)), PIN_HOLE/2, -1, 6, 48)]
    holes.append(_cylinder(P, PILOT/2, PIVOT_TOP - 6, 20, 48))
    body = _connector_ends(body - _sum(holes), rows, adjustment)
    # Seams: arcs about the pivot (off the magnets, pins and connector ends), radial seams between tracks far out.
    forbidden = [(D - PIN_IN - 4, D + GAP + WALL + 2), (R - CONTACT_ZONE, R + 2)]
    arcs, r = [], -10.
    while R + 4 - r > 140:
        nxt = r + 130
        for low, high in forbidden:
            if low < nxt < high:
                nxt = low if low - r > 40 else high
        arcs.append(nxt)
        r = nxt
    splits = [(s["angles"][i] + s["angles"][i + 1]) / 2 for i in range(len(s["angles"]) - 1)]
    seams = []
    for radius in arcs:
        # The floor is widest (in angle) near the pivot: span the whole body at this radius.
        span = max(abs(a) for a in s["angles"]) + math.atan2(HALF + WALL + 8, radius)
        marks = [((lo + hi)/2, 1) for lo, hi in zip([-span] + splits, splits + [span])] if radius > 200 else [(0., 1)]
        seams.append(_seam_arc(P, radius, -span - .02, span + .02, marks))
    wide_from = next((radius for radius in arcs if radius > 200), None)
    if wide_from is not None:
        for phi in splits:
            u = np.array([math.cos(phi), math.sin(phi)])
            seams.append(_seam_line(np.asarray(P) + wide_from*u, np.asarray(P) + (R + 4)*u, []))
    pieces = _split(body, seams)
    parts = [(f"base-{i + 1:02d}", mesh, best_yaw(mesh)) for i, mesh in enumerate(pieces)]
    angle = s["angles"][int(p["switch_state"])]
    deck = _deck(D, 0., arc_centre=(0., 0.), pivot=True, near_end=False, near_trim=s["trim"])
    for i, piece in enumerate(_split(deck, _deck_seams(0., D, avoid=(0.,)))):
        placed = _tri(_place(_man(piece), P, angle))
        parts.append((f"deck-{i + 1:02d}", placed, best_yaw(placed)))
    cap = _cylinder((0, 0), 7, 0, 1.2) - _cylinder((0, 0), 1.7, -1, 3, 32)
    parts.append(("pivot-cap", _tri(cap.translate((P[0], P[1], PIVOT_TOP))), 0.))
    return parts


# ------------------------------------------------------------------ service interface

def _key(family: str, p: dict) -> tuple:
    return tuple(sorted((k, float(v)) for k, v in p.items() if k in set(SHAPES[family]) | {"switch_state"}))


def parts(family: str, p: dict) -> list[tuple[str, trimesh.Trimesh, float]]:
    """(role, mesh in the piece frame, print yaw) of every printed part, deck set to the selected state."""
    validate(family, p)
    build = {"turntable": _turntable, "transfer_table": _transfer, "sector_plate": _sector}[family]
    return build(_key(family, p), float(p["fit_adjustment"]))


def components(family: str, p: dict) -> list[dict]:
    validate(family, p)
    code = FAMILIES.index(family)
    return [{"role": role, "parameters": {**p, "shape_code": code, "component_index": index}}
            for index, (role, _, _) in enumerate(parts(family, p))]


def _family_of(p) -> str:
    code = p.get("shape_code")
    if not _number(code) or code != int(code) or not 0 <= code < len(FAMILIES):
        raise ValueError("invalid shape_code")
    return FAMILIES[int(code)]


def component_keys(p: dict) -> set[str]:
    return set(CONNECTOR | set(SHAPES[_family_of(p)]) | {"switch_state", "shape_code", "component_index"})


def _logical(p):
    return {key: value for key, value in p.items() if key not in ("shape_code", "component_index")}


def validate_component(p: dict) -> None:
    family = _family_of(p)
    if set(p) != component_keys(p):
        raise ValueError("unexpected table component parameters")
    validate(family, _logical(p))
    index = p["component_index"]
    if not _number(index) or index != int(index) or not 0 <= index < len(parts(family, _logical(p))):
        raise ValueError("component_index outside assembly")


def component_ports(p: dict) -> list[dict]:
    family = _family_of(p)
    return [row for row in _port_list(family, _logical(p)) if not row["id"].startswith("free-")]


def print_yaw(p: dict) -> float:
    validate_component(p)
    return parts(_family_of(p), _logical(p))[int(p["component_index"])][2]


def check_mesh(role: str, mesh: trimesh.Trimesh, yaw: float) -> trimesh.Trimesh:
    if not mesh.is_watertight or len(_man(mesh).decompose()) != 1:
        raise ValueError(f"{role} is not a connected watertight component")
    if max(plan_size(mesh, yaw)) > BED + .001:
        raise ValueError(f"{role} exceeds the 166 mm usable mini bed")
    cleaned = _man(mesh).simplify(1e-5)
    result = _tri(cleaned)
    if not result.is_volume or len(cleaned.decompose()) != 1:
        raise ValueError(f"{role} lost connected volume during seam retriangulation")
    return result


def build_component(p: dict) -> cq.Shape:
    validate_component(p)
    role, mesh, yaw = parts(_family_of(p), _logical(p))[int(p["component_index"])]
    return end._solid(check_mesh(role, mesh, yaw))


def hardware(family: str, p: dict) -> list[dict]:
    validate(family, p)
    if family == "turntable":
        s = turntable_shape(p)
        rows = [hw.row(hw.MAGNET, s["positions"] + 2, hw.MAGNETS),
                hw.row(hw.DOWEL_3X12, 2, hw.FASTENERS)]
        if s["drive"]:
            rows += [hw.row(hw.BT_L_MOTOR if s["drive"] == 1 else hw.IR_L_MOTOR, 1, hw.BRICK),
                     hw.row(hw.WORM_GEAR, 1, hw.BRICK),
                     hw.row(hw.GEAR_24, 1, hw.BRICK),
                     hw.row(hw.AXLE_12, 2, hw.BRICK),
                     hw.row(hw.FRICTION_PIN, 4, hw.BRICK)]
        else:
            rows.append(hw.m3_screw(8, 1))
        return rows + [hw.row(hw.GLUE, 1, hw.MATERIALS), hw.row(hw.GRAPHITE, 1, hw.MATERIALS)]
    if family == "transfer_table":
        lanes = int(p["lanes"])
        return [hw.row(hw.MAGNET, 2*lanes + 2, hw.MAGNETS),
                hw.row(hw.DOWEL_3X12, 2, hw.FASTENERS),
                hw.row(hw.GLUE, 1, hw.MATERIALS), hw.row(hw.GRAPHITE, 1, hw.MATERIALS)]
    tracks = int(p["tracks"])
    return [hw.row(hw.MAGNET, tracks + 1, hw.MAGNETS),
            hw.row(hw.DOWEL_3X12, 1, hw.FASTENERS),
            hw.m3_screw(8, 1),
            hw.row(hw.GLUE, 1, hw.MATERIALS), hw.row(hw.GRAPHITE, 1, hw.MATERIALS)]


def assembly_notes(family: str, p: dict) -> list[str]:
    validate(family, p)
    notes = ["Lay the keyed base pieces on a flat table and lower the matching dovetails together; then the deck pieces.",
             "Glue a 6 x 3 mm magnet into every round pocket in the floor (flush with its top) and one in each deck end, "
             "all with the same pole up in the floor and the opposite pole down in the deck, so each deck end is pulled "
             "over the floor magnet beneath it.",
             "Ream the 3.1 mm pin holes with a drill. To lock the deck lined up, drop a 3 mm steel dowel pin through each "
             "deck end hole into the floor hole beneath; lift them out before moving it.",
             "Rub graphite on the floor and the deck's underside; the deck slides on the floor."]
    if family == "turntable":
        s = turntable_shape(p)
        notes.insert(1, "Lower the bridge over the pivot pin, rails up.")
        if s["drive"] == 1:
            notes += ["Bluetooth motor: push a cross axle 12 down through the pivot pin and the table, fit the driven cap "
                      "(its pegs into the bridge), and drive the axle from below with the L motor pinned to the printed "
                      "motor mount by the four holes left, right, above and below its bearing: a worm 4716 on the motor "
                      "axle, centred two modules in front of the plate, meshes a 24-tooth gear 3648 on the vertical axle. "
                      "Fix the mount under the table square to the vertical axle, the motor axle passing 16 mm (two "
                      "modules) beside it.",
                      "Stop the motor with the bridge over a stall; the magnets pull it into line, then the pins lock it."]
        elif s["drive"] == 2:
            notes += ["Infrared motor: push a cross axle 12 down through the pivot pin and the table, fit the driven cap "
                      "(its pegs into the bridge), and drive the axle from below with the infrared L motor (88003) "
                      "pinned to the printed motor mount by the four holes left, right, above and below its bearing: a "
                      "worm 4716 on the motor axle, centred two modules in front of the plate, meshes a 24-tooth gear 3648 "
                      "on the vertical axle. Fix the mount under the table square to the vertical axle, the motor axle "
                      "passing 16 mm (two modules) beside it.",
                      "Run the motor from an IR receiver beside it; its lead leaves the motor's back face, "
                      "away from the gears.",
                      "Stop the motor with the bridge over a stall; the magnets pull it into line, then the pins lock it."]
        else:
            notes.append("Fit the pivot cap over the pin with the M3 x 8 screw; the bridge keeps 0.2 mm of lift.")
    elif family == "sector_plate":
        notes.insert(1, "Lower the deck over the pivot pin and fit the pivot cap with the M3 x 8 screw.")
        notes.append("The deck turns 5.625° each way at its pivot, the limit of a brick flex-track joint: drive across slowly.")
    else:
        notes.insert(1, "Lower the deck into the well with the two floor ribs in the channels under it.")
    return notes


# ------------------------------------------------------------------ probes

def _deck_role(role: str) -> bool:
    return role.startswith(("bridge-", "deck-"))


def _assembled(family: str, p: dict, state: int):
    rows = parts(family, {**p, "switch_state": state})
    fixed = _sum([_man(mesh) for role, mesh, _ in rows if not _deck_role(role) and role not in ("pivot-cap", "drive-mount")])
    deck = _sum([_man(mesh) for role, mesh, _ in rows if _deck_role(role)])
    return fixed, deck


def _rail_heads(solid: mf.Manifold, origin, heading, window) -> dict:
    """Rail head centre lines near a joint, per side: the head's lateral centre sampled every 0.25 mm between stations
    window[0]..window[1] along `heading` from `origin` (section at z 9.0), fitted to a line; and its first/last station."""
    section = solid.slice(9.0)
    out = {}
    for side in (-1, 1):
        stations, laterals = [], []
        for u in np.arange(window[0], window[1], .25):
            part = section ^ _quad(origin, heading, u, u + .1, side*RAIL - 2.5, side*RAIL + 2.5)
            if part.is_empty() or part.area() < .05:
                continue
            pts = np.vstack([np.asarray(poly) for poly in part.to_polygons() if len(poly)])
            lateral = -(pts[:, 0] - origin[0])*math.sin(heading) + (pts[:, 1] - origin[1])*math.cos(heading)
            stations.append(u + .05)
            laterals.append((lateral.min() + lateral.max()) / 2)
        if len(stations) < 3:
            continue
        slope, intercept = np.polyfit(stations, laterals, 1)
        out[side] = {"lateral": float(intercept), "slope": float(slope), "from": min(stations) - .05, "to": max(stations) + .05}
    return out


def _joints(family: str, p: dict, state: int) -> list[tuple]:
    """(label, origin, heading) of every rail joint between the deck and a stub in `state`; heading points onto the stub."""
    if family == "turntable":
        s = turntable_shape(p)
        axis = s["axis_rows"][state]
        angle = dict(s["ports"])
        out = []
        for ident in (axis["a"], axis["b"]):
            if ident:
                a = angle[ident]
                out.append((ident, (s["centre"][0] + s["wall"]*math.cos(a) - GAP/2*math.cos(a),
                                    s["centre"][1] + s["wall"]*math.sin(a) - GAP/2*math.sin(a)), a))
        return out
    if family == "transfer_table":
        s = transfer_shape(p)
        y = s["ys"][state]
        return [("in", (LANE_STUB + GAP/2, y), math.pi), ("out", (LANE_STUB + s["deck"] + 1.5*GAP, y), 0.)]
    s = sector_shape(p)
    a = s["angles"][state]
    P = s["pivot"]
    return [("far", (P[0] + (s["deck"] + GAP/2)*math.cos(a), P[1] + (s["deck"] + GAP/2)*math.sin(a)), a)]


def probe_alignment(family: str, p: dict) -> list[dict]:
    """Rail ends at every deck position, measured on the built meshes: lateral offset (mm), angle (°) and gap (mm)
    between each deck rail head and the stub rail head it meets, plus the worst case with the pin and pivot play."""
    validate(family, p)
    states = len(_routes(family, p))
    rows = []
    for state in range(states):
        fixed, deck = _assembled(family, p, state)
        for label, origin, heading in _joints(family, p, state):
            stub = _rail_heads(fixed, origin, heading, (-4., 14.))
            moving = _rail_heads(deck, origin, heading, (-14., 4.))
            for side in (-1, 1):
                a, b = stub.get(side), moving.get(side)
                if not a or not b:
                    rows.append({"state": state, "joint": label, "side": side, "missing": True})
                    continue
                rows.append({"state": state, "joint": label, "side": side,
                             "lateral": abs(a["lateral"] - b["lateral"]),
                             "angle": abs(math.degrees(math.atan(a["slope"]) - math.atan(b["slope"]))),
                             "gap": a["from"] - b["to"]})
    return rows


def probe_play(family: str, p: dict) -> dict:
    """Worst lateral rail-end error from clearances: dowel pins (3.0 in 3.1 holes in deck and floor, 0.1 total
    radial) lock both ends; ribs in channels hold the transfer deck along its lanes; the pivot only matters without pins."""
    validate(family, p)
    pin = (PIN_HOLE - 3.0)  # 0.05 radial in each of two holes
    if family == "turntable":
        H = turntable_shape(p)["half"]
        lateral = pin + pin*H/(H - PIN_IN)
        return {"lateral": lateral, "angle": math.degrees(2*pin/(2*(H - PIN_IN))), "limit": .3}
    if family == "transfer_table":
        return {"lateral": pin, "angle": math.degrees(math.atan(2*.2/transfer_shape(p)["deck"])), "along": .2, "limit": .3}
    s = sector_shape(p)
    D = s["deck"]
    pivot = (BORE - PIVOT) / 2
    # The far end is held by one pin; the pivot clearance turns the deck about it.
    lateral = pin + pivot*PIN_IN/(D - PIN_IN)
    return {"lateral": lateral, "angle": math.degrees((pin + pivot)/(D - PIN_IN)), "limit": .3}


def probe_motion(family: str, p: dict, steps: int = 24) -> dict:
    """The deck never touches the fixed body anywhere along its travel (between every pair of positions)."""
    validate(family, p)
    rows = parts(family, {**p, "switch_state": 0})
    fixed = _sum([_man(mesh) for role, mesh, _ in rows if not _deck_role(role) and role not in ("pivot-cap", "drive-mount")])
    deck0 = _sum([_man(mesh) for role, mesh, _ in rows if _deck_role(role)])
    worst = 0.
    if family == "turntable":
        s = turntable_shape(p)
        c = s["centre"]
        base = s["axis_rows"][0]["k"]*s["theta"]
        for k in range(steps*2 + 1):
            angle = math.pi*k/steps
            moved = deck0.translate((-c[0], -c[1], 0)).rotate((0, 0, math.degrees(angle - base))).translate((c[0], c[1], 0))
            worst = max(worst, (moved ^ fixed).volume())
    elif family == "transfer_table":
        s = transfer_shape(p)
        for k in range(steps + 1):
            moved = deck0.translate((0, (s["ys"][-1] - s["ys"][0])*k/steps, 0))
            worst = max(worst, (moved ^ fixed).volume())
    else:
        s = sector_shape(p)
        P = s["pivot"]
        a0, a1 = s["angles"][0], s["angles"][-1]
        for k in range(steps + 1):
            angle = a0 + (a1 - a0)*k/steps
            moved = deck0.translate((-P[0], -P[1], 0)).rotate((0, 0, math.degrees(angle - a0))).translate((P[0], P[1], 0))
            worst = max(worst, (moved ^ fixed).volume())
    return {"steps": steps, "worst_overlap_mm3": worst}


def envelope(family: str, p: dict) -> np.ndarray:
    """The TS envelope polygon (piece frame) for this table."""
    if family == "turntable":
        s = turntable_shape(p)
        # A 48-gon circumscribing the bridge's sweep circle.
        r = (s["half"] + CLEAR) / math.cos(math.pi/48)
        return np.array([(s["centre"][0] + r*math.cos(2*math.pi*i/48), r*math.sin(2*math.pi*i/48)) for i in range(48)])
    if family == "transfer_table":
        s = transfer_shape(p)
        y0, y1 = min(s["ys"]) - HALF - CLEAR, max(s["ys"]) + HALF + CLEAR
        return np.array([(s["x0"], y0), (s["x0"] + s["deck"], y0), (s["x0"] + s["deck"], y1), (s["x0"], y1)])
    s = sector_shape(p)
    D, P = s["deck"], s["pivot"]
    spread = max(s["angles"]) + math.atan2(HALF, D)
    far = math.hypot(D, HALF) + CLEAR
    back = BORE/2 + 4.5 + CLEAR
    return np.array([(P[0] - back, -HALF - CLEAR)] + [(P[0] + far*math.cos(a), far*math.sin(a))
                    for a in np.linspace(-spread, spread, 13)] + [(P[0] - back, HALF + CLEAR)])


def probe_envelopes(family: str, p: dict) -> dict:
    """Every deck position lies inside the editor's envelope polygon."""
    validate(family, p)
    poly = _cs(envelope(family, p)).offset(.01, mf.JoinType.Miter)
    outside = 0.
    for state in range(len(_routes(family, p))):
        rows = parts(family, {**p, "switch_state": state})
        for role, mesh, _ in rows:
            if _deck_role(role):
                plan = _man(mesh).project()
                outside = max(outside, (plan - poly).area())
    return {"outside_mm2": outside}


def probe_retention(family: str, p: dict) -> dict:
    """What keeps the deck in place: pivot engagement and cap lift, rib engagement, magnet gap."""
    validate(family, p)
    row = {"magnet_gap": 0., "pin_engagement_floor": FLOOR}
    if family in ("turntable", "sector_plate"):
        row.update({"pivot_engagement": min(PIVOT_TOP, SPINE_TOP) - FLOOR, "cap_lift": PIVOT_TOP - SPINE_TOP, "pivot_radial_clearance": (BORE - PIVOT)/2})
    else:
        row.update({"rib_engagement": RIB[2], "rib_clearance": .2})
    return row


def probe_beds(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return [{"role": role, "size": plan_size(mesh, yaw), "yaw": math.degrees(yaw), "watertight": bool(mesh.is_watertight),
             "bodies": len(mesh.split(only_watertight=False))} for role, mesh, yaw in parts(family, p)]


def probe_drive(family: str, p: dict, turns: int = 8) -> dict:
    """Motor turntable drive (Bluetooth 88013 or infrared 88003): the motor in its printed mount clear of
    every printed part (the bridge turned through a full circle), and the worm on the motor axle meshing the 24-tooth
    gear on the vertical axle -- crossed square, WORM_CENTRES apart, each tip clear of the other's root -- with neither
    gear touching a printed part or the motor."""
    validate(family, p)
    if family != "turntable" or int(p["drive"]) not in MOTOR_OF_DRIVE:
        raise ValueError("the drive probe covers the motor turntable (drive 1 or 2)")
    motor = MOTOR_OF_DRIVE[int(p["drive"])]
    c = turntable_shape(p)["centre"]
    frame = drive_frame(c)
    rows = parts(family, p)
    mount = next(mesh for role, mesh, _ in rows if role == "drive-mount")
    printed = [(role, mesh) for role, mesh, _ in rows]
    spin = [trimesh.transformations.rotation_matrix(2*math.pi*k/turns, (0, 0, 1), (c[0], c[1], 0)) for k in range(1, turns)]
    printed += [(f"{role} turned {360*k/turns:.0f}°", mesh.copy().apply_transform(matrix))
                for k, matrix in enumerate(spin, 1) for role, mesh, _ in rows if _deck_role(role)]
    report = drives.probe_mount(frame, motor, mount, printed)
    axle, axis = frame[:3, 3], frame[:3, 0]
    normal = np.cross(axis, (0., 0., 1.))
    centres = abs(float(np.dot(np.asarray((c[0], c[1], DRIVE_Z)) - axle, normal)))/float(np.linalg.norm(normal))
    gear = trimesh.creation.cylinder(radius=drives.GEAR_24_TIP_R, height=drives.GEAR_24_WIDTH, sections=96)
    gear.apply_translation((c[0], c[1], DRIVE_Z))
    worm = trimesh.creation.cylinder(radius=drives.WORM_TIP_R, height=drives.WORM_LENGTH, sections=48)
    worm.apply_transform(frame @ trimesh.transformations.translation_matrix((WORM_AT, 0., 0.)) @
                         trimesh.transformations.rotation_matrix(math.pi/2, (0, 1, 0)))
    solids = [drives.motor_body(frame, motor), drives.motor_case(frame, motor)]
    report["mesh"] = {"wormToGearCentresMm": round(centres, 3), "crossingDeg": round(math.degrees(math.acos(abs(axis[2]))), 3),
                      "gearTipToWormRootMm": round(centres - drives.GEAR_24_TIP_R - drives.WORM_ROOT_R, 3),
                      "wormTipToGearRootMm": round(centres - drives.WORM_TIP_R - drives.GEAR_24_ROOT_R, 3),
                      "gearsInPrintedMm3": round(max(drives.overlap_mm3(g, mesh) for g in (gear, worm) for _, mesh in printed), 4),
                      "gearsInMotorMm3": round(max(drives.overlap_mm3(g, solid) for g in (gear, worm) for solid in solids), 4)}
    return report


def probes(family: str, p: dict) -> dict:
    report = {"alignment": probe_alignment(family, p), "play": probe_play(family, p), "motion": probe_motion(family, p),
              "envelopes": probe_envelopes(family, p), "retention": probe_retention(family, p), "beds": probe_beds(family, p)}
    if family == "turntable" and int(p["drive"]) in MOTOR_OF_DRIVE:
        report["drive"] = probe_drive(family, p)
    return report
